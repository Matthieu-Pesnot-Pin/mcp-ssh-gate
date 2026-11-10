import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MAX_COMMANDS_PER_REQUEST, isFinalStatus } from "../../shared/model.js";
import { GateError } from "../core/errors.js";
import type { RequestStore } from "../core/request-store.js";
import type { ServerStore, StoredServer } from "../core/server-store.js";
import { formatRequest } from "./format.js";

export interface ToolContext {
  servers: ServerStore;
  requests: RequestStore;
  /** Démarre le worker de l'interface si aucun n'est vivant. */
  ensureGui: () => void;
  /** URL de l'interface servie par le worker vivant. */
  guiUrl: () => string | null;
  reconnectGui: () => Promise<CallToolResult>;
}

const RESULT_OUTPUT_PER_COMMAND = 20_000;
const HISTORY_OUTPUT_PER_COMMAND = 2_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1800;
const POLL_MS = 1000;
const GUI_CHECK_EVERY_MS = 10_000;

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_servers",
    description:
      "List the SSH servers configured in the GUI, with their user, host and whether their connection has been tested. Commands can only be submitted to a tested server.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "submit_commands",
    description:
      `Submit shell commands to run on a server. Nothing runs until the user approves them in the web GUI: they can edit or remove a command, add a note, or refuse the whole request. ` +
      `Approved commands run in order in a persistent bash shell (cd and export carry over between commands and between requests), without a terminal: stdin is /dev/null and stderr is merged into stdout, so interactive prompts get end-of-file and sudo must not ask for a password. ` +
      `Execution stops at the first command that exits non-zero. Returns a request_id: call wait_for_result with it. ` +
      `Give 1 to ${MAX_COMMANDS_PER_REQUEST} commands and explain what you want to achieve: the user reads the explanation before approving.`,
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server id or name, as returned by list_servers." },
        commands: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_COMMANDS_PER_REQUEST,
          description: "Commands to run in order. One entry per command; a single entry may span several lines.",
        },
        explanation: { type: "string", description: "Why these commands are needed and what they do, shown to the user above the commands." },
      },
      required: ["server", "commands", "explanation"],
    },
  },
  {
    name: "wait_for_result",
    description:
      `Wait until the user has decided on a request and its commands have finished, then return the outcome: refusal and its reason, or each command with its exit code and output, and the user's note. ` +
      `Returns earlier with the current status when timeout_seconds elapses; call it again to keep waiting.`,
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Id returned by submit_commands." },
        timeout_seconds: {
          type: "number",
          description: `How long to wait, in seconds (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`,
        },
      },
      required: ["request_id"],
    },
  },
  {
    name: "cancel_request",
    description: "Withdraw a request that the user has not approved yet. A request that is already running can only be interrupted by the user.",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string", description: "Id returned by submit_commands." } },
      required: ["request_id"],
    },
  },
  {
    name: "get_history",
    description:
      "Read the latest requests on a server, newest last: commands submitted by agents and commands the user typed in the GUI, with their status, exit code and the end of their output.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server id or name." },
        limit: { type: "number", description: "Number of requests to return (default 10, max 50)." },
      },
      required: ["server"],
    },
  },
  {
    name: "reconnect_gui",
    description: "Start the web GUI again if it is not running, and return its URL.",
    inputSchema: { type: "object", properties: {} },
  },
];

const SubmitArgs = z.object({
  server: z.string().min(1),
  commands: z.array(z.string()).min(1).max(MAX_COMMANDS_PER_REQUEST),
  explanation: z.string().trim().min(1, "explanation must not be empty"),
});
const WaitArgs = z.object({
  request_id: z.string().min(1),
  timeout_seconds: z.number().positive().max(MAX_WAIT_SECONDS).optional(),
});
const RequestArgs = z.object({ request_id: z.string().min(1) });
const HistoryArgs = z.object({
  server: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
});

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    throw new GateError(`Invalid arguments: ${result.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

function serverOrNull(ctx: ToolContext, id: string): StoredServer | null {
  try {
    return ctx.servers.get(id);
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function listServers(ctx: ToolContext): CallToolResult {
  const servers = ctx.servers.list();
  if (servers.length === 0) {
    const url = ctx.guiUrl();
    return text(`No server is configured yet. Ask the user to add one in the GUI${url ? ` (${url})` : ""}.`);
  }
  const lines = servers.map(
    (s) => `- ${s.id} — "${s.name}" — ${s.username}@${s.host}:${s.port} — ${s.hostKeyFingerprint ? "ready" : "connection not tested yet: commands cannot be submitted"}`
  );
  return text(lines.join("\n"));
}

function submitCommands(ctx: ToolContext, args: unknown): CallToolResult {
  const { server: serverRef, commands, explanation } = parse(SubmitArgs, args);
  const server = ctx.servers.get(serverRef);
  if (!server.hostKeyFingerprint) {
    throw new GateError(`The connection to "${server.id}" has never been tested. Ask the user to run "Tester la connexion" for this server in the GUI first.`);
  }
  const request = ctx.requests.create({ serverId: server.id, source: "agent", explanation, commands });
  ctx.ensureGui();
  const url = ctx.guiUrl();
  return text(
    `Request ${request.id} submitted to ${server.id} with ${request.commands.length} command(s). It is waiting for the user's approval${url ? ` in the GUI: ${url}` : " in the GUI"}.\n` +
      `Call wait_for_result with request_id "${request.id}".`
  );
}

async function waitForResult(ctx: ToolContext, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const { request_id, timeout_seconds } = parse(WaitArgs, args);
  const deadline = Date.now() + (timeout_seconds ?? DEFAULT_WAIT_SECONDS) * 1000;
  let nextGuiCheck = 0;

  for (;;) {
    const request = ctx.requests.get(request_id);
    if (isFinalStatus(request.status)) {
      return text(formatRequest(request, serverOrNull(ctx, request.serverId), RESULT_OUTPUT_PER_COMMAND));
    }
    if (Date.now() >= nextGuiCheck) {
      ctx.ensureGui();
      nextGuiCheck = Date.now() + GUI_CHECK_EVERY_MS;
    }
    if (Date.now() >= deadline || signal?.aborted) {
      const state = request.status === "pending" ? "still waiting for the user's approval" : "still running";
      return text(`Request ${request.id} is ${state}. Call wait_for_result again to keep waiting.`);
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
  }
}

function cancelRequest(ctx: ToolContext, args: unknown): CallToolResult {
  const { request_id } = parse(RequestArgs, args);
  const request = ctx.requests.update(request_id, (draft) => {
    if (draft.status !== "pending") {
      throw new GateError(`Request ${draft.id} cannot be cancelled: it is ${draft.status}.`);
    }
    draft.status = "cancelled";
    draft.finishedAt = new Date().toISOString();
    for (const command of draft.commands) command.status = "skipped";
  });
  return text(`Request ${request.id} cancelled.`);
}

function getHistory(ctx: ToolContext, args: unknown): CallToolResult {
  const { server: serverRef, limit } = parse(HistoryArgs, args);
  const server = ctx.servers.get(serverRef);
  const requests = ctx.requests.listForServer(server.id, limit ?? 10);
  if (requests.length === 0) return text(`No request on ${server.id} yet.`);
  return text(requests.map((request) => formatRequest(request, server, HISTORY_OUTPUT_PER_COMMAND)).join("\n\n---\n\n"));
}

export async function callTool(ctx: ToolContext, name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  try {
    switch (name) {
      case "list_servers":
        return listServers(ctx);
      case "submit_commands":
        return submitCommands(ctx, args);
      case "wait_for_result":
        return await waitForResult(ctx, args, signal);
      case "cancel_request":
        return cancelRequest(ctx, args);
      case "get_history":
        return getHistory(ctx, args);
      case "reconnect_gui":
        return await ctx.reconnectGui();
      default:
        throw new GateError(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}
