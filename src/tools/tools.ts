import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MAX_COMMANDS_PER_REQUEST, isFinalStatus } from "../../shared/model.js";
import { GateError } from "../core/errors.js";
import type { RequestStore } from "../core/request-store.js";
import type { ServerStore, StoredServer } from "../core/server-store.js";
import { MONITOR_TIMEOUT_MS, advanceCursor, formatEvent, liveWatcherSince, sleep, writeHandoff, type FinishedRequestScanner } from "../core/watch.js";
import { formatRequest } from "./format.js";

export interface ToolContext {
  servers: ServerStore;
  requests: RequestStore;
  /** Démarre le worker de l'interface si aucun n'est vivant. */
  ensureGui: () => void;
  /** URL de l'interface servie par le worker vivant. */
  guiUrl: () => string | null;
  reconnectGui: () => Promise<CallToolResult>;
  /** Session d'agent de ce processus MCP, enregistrée sur les demandes qu'il soumet. */
  sessionId: string;
  dataDir: string;
  /** Commande que l'outil Monitor de l'hôte lance pour surveiller cette session. */
  watchCommand: string;
  /** Demandes terminées de cette session, lues par l'outil d'attente du veilleur du gateway. */
  finished: FinishedRequestScanner;
}

export const WATCH_ARG = "_gateway_watch";
const WATCH_META = "gateway/watch";
const EVENTS_META = "gateway/events";
const DEFAULT_NOTIFICATION_WAIT_SECONDS = 50;
const MAX_NOTIFICATION_WAIT_SECONDS = 300;

const RESULT_OUTPUT_PER_COMMAND = 20_000;
const HISTORY_OUTPUT_PER_COMMAND = 2_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 1800;
const POLL_MS = 1000;
const GUI_CHECK_EVERY_MS = 10_000;

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "enable_notifications",
    description:
      "Get notified when a request you submitted is finished (all its commands ran, or the user refused or interrupted it), and when the user sends you a command they ran themselves, without blocking on wait_for_result. " +
      "Returns immediately and hands you the exact Monitor call to make right after: arming that watcher is what delivers the notifications. " +
      "Call it once at the start of the session; the host stops the watcher after 30 minutes at most, re-arm it with the same Monitor call each time it expires. Works locally and behind mcp-http-gateway.",
    inputSchema: {
      type: "object",
      properties: {
        [WATCH_ARG]: {
          type: "object",
          description: "Filled in by the mcp-http-gateway relay, never by the agent: the relay will run the watcher and needs a watch specification instead of a local command",
        },
      },
    },
  },
  {
    name: "wait_for_notifications",
    description:
      "Reserved for the notification watcher that the mcp-http-gateway relay runs on the agent's machine: do not call it yourself. " +
      "To be notified, call enable_notifications; to read the outcome of a request, call wait_for_result. " +
      "Blocks until a request submitted by this session is finished after the cursor, or until the timeout, and returns one line per finished request with the next cursor.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", pattern: "^[0-9]+$", description: "Cursor returned by the previous call. Omit to wait for requests finished from now on." },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_NOTIFICATION_WAIT_SECONDS,
          description: `Maximum wait in seconds (default ${DEFAULT_NOTIFICATION_WAIT_SECONDS}).`,
        },
      },
    },
  },
  {
    name: "list_servers",
    description:
      "List the SSH servers configured in the GUI, with their user, host, whether their connection has been tested, and their notes: the context gathered on each server (where the sites live, how apps are managed, rules to follow). " +
      "Read them before submitting commands. Commands can only be submitted to a tested server.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_server_notes",
    description:
      `Record context about a server so that later sessions do not have to rediscover it: where the websites live, how the apps are run (PM2, systemd, Docker…), config locations, rules the user gave. ` +
      `Keep notes short and factual, one fact per line. mode "append" (default) adds lines at the end; mode "replace" rewrites the whole text: start from the current notes returned by list_servers and keep every line the user wrote. ` +
      `The user sees and can edit the notes in the GUI.`,
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server id or name." },
        notes: { type: "string", description: "Lines to add, or the full new text with mode \"replace\"." },
        mode: { type: "string", enum: ["append", "replace"], description: "\"append\" (default) or \"replace\"." },
      },
      required: ["server", "notes"],
    },
  },
  {
    name: "submit_commands",
    description:
      `Submit shell commands to run on a server. Read the server notes from list_servers first. Nothing runs until the user approves them in the web GUI: they can edit or remove a command, add a note, or refuse the whole request. ` +
      `Approved commands run in order in a persistent bash shell (cd and export carry over between commands and between requests), without a terminal: stdin is /dev/null and stderr is merged into stdout, so interactive prompts get end-of-file and sudo must not ask for a password. ` +
      `Execution stops at the first command that exits non-zero. Returns a request_id: call wait_for_result with it, or, with notifications enabled, keep working and read the result when you are notified. ` +
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
const NotesArgs = z.object({
  server: z.string().min(1),
  notes: z.string(),
  mode: z.enum(["append", "replace"]).optional(),
});
const EnableArgs = z.object({ [WATCH_ARG]: z.looseObject({ version: z.number() }).optional() });
const NotificationWaitArgs = z.object({
  cursor: z.string().regex(/^[0-9]+$/).optional(),
  timeout_seconds: z.number().int().min(1).max(MAX_NOTIFICATION_WAIT_SECONDS).optional(),
});
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

function listServers(ctx: ToolContext): CallToolResult {
  const servers = ctx.servers.list();
  if (servers.length === 0) {
    const url = ctx.guiUrl();
    return text(`No server is configured yet. Ask the user to add one in the GUI${url ? ` (${url})` : ""}.`);
  }
  const blocks = servers.map((s) => {
    const head = `- ${s.id} — "${s.name}" — ${s.username}@${s.host}:${s.port} — ${s.hostKeyFingerprint ? "ready" : "connection not tested yet: commands cannot be submitted"}`;
    if (!s.notes) return `${head}\n  Notes: none yet. Record what you learn about this server with update_server_notes.`;
    const author = s.notesUpdatedBy === "user" ? "the user" : "an agent";
    const indented = s.notes.split("\n").map((line) => `    ${line}`).join("\n");
    return `${head}\n  Notes (last updated by ${author} on ${s.notesUpdatedAt}):\n${indented}`;
  });
  return text(blocks.join("\n\n"));
}

function updateServerNotes(ctx: ToolContext, args: unknown): CallToolResult {
  const { server: serverRef, notes, mode } = parse(NotesArgs, args);
  const server = ctx.servers.get(serverRef);
  const addition = notes.trim();
  if (!addition && mode !== "replace") throw new GateError("notes must not be empty.");
  const next = mode === "replace" || !server.notes ? addition : `${server.notes}\n${addition}`;
  const saved = ctx.servers.setNotes(server.id, next, "agent");
  return text(`Notes of ${saved.id} saved (${saved.notes.length} characters). The user sees them in the GUI.`);
}

function submitCommands(ctx: ToolContext, args: unknown): CallToolResult {
  const { server: serverRef, commands, explanation } = parse(SubmitArgs, args);
  const server = ctx.servers.get(serverRef);
  if (!server.hostKeyFingerprint) {
    throw new GateError(`The connection to "${server.id}" has never been tested. Ask the user to run "Tester la connexion" for this server in the GUI first.`);
  }
  const request = ctx.requests.create({ serverId: server.id, source: "agent", sessionId: ctx.sessionId, explanation, commands });
  ctx.ensureGui();
  const url = ctx.guiUrl();
  const next =
    `If your notification watcher is armed, keep working: you will be notified when it is finished. ` +
    `Otherwise call wait_for_result with request_id "${request.id}".`;
  return text(
    `Request ${request.id} submitted to ${server.id} with ${request.commands.length} command(s). It is waiting for the user's approval${url ? ` in the GUI: ${url}` : " in the GUI"}.\n${next}`
  );
}

/**
 * Derrière mcp-http-gateway, le relais remplit `_gateway_watch` : il fera tourner le
 * veilleur sur la machine de l'agent et a besoin d'une spécification de veille. Sinon,
 * la réponse donne la commande du veilleur local.
 */
function enableNotifications(ctx: ToolContext, args: unknown): CallToolResult {
  const input = parse(EnableArgs, args);
  if (input[WATCH_ARG]) {
    return {
      content: [{ type: "text", text: "Watch specification for the mcp-http-gateway relay." }],
      _meta: {
        [WATCH_META]: {
          tool: "wait_for_notifications",
          arguments: {},
          cursor: String(Date.now()),
          description: "Finished ssh-gate requests",
        },
      },
    };
  }

  writeHandoff(ctx.sessionId, ctx.dataDir);
  const since = liveWatcherSince(ctx.dataDir, ctx.sessionId);
  if (since) {
    return text(
      [
        `Notifications are already live for this session (watcher armed since ${since}).`,
        "Nothing to do: do not arm a second watcher, you would get every notification twice.",
        "Only if the host just told you your watcher expired or stopped, re-arm it with the same Monitor call:",
        `command \`${ctx.watchCommand}\`, timeout_ms ${MONITOR_TIMEOUT_MS}.`,
      ].join("\n")
    );
  }
  return text(
    [
      "Notifications enabled for this session.",
      "",
      "Last step — call the Monitor tool now, with exactly these arguments:",
      `  command:     ${ctx.watchCommand}`,
      "  description: Finished ssh-gate requests",
      `  timeout_ms:  ${MONITOR_TIMEOUT_MS}`,
      "",
      "Until that watcher is armed, nothing will reach you. Once it is, keep working: each request you submitted",
      "announces itself when its commands have all run, or when the user refused or interrupted it — one line per",
      "request. Read the outcome with wait_for_result, which then returns immediately.",
      "",
      "The host stops every monitor after 30 minutes at most. Each time it tells you this watcher expired, call",
      "Monitor again right away with the same arguments — do not call enable_notifications again. A request that",
      "finished while no watcher was running is announced as soon as the watcher is back.",
    ].join("\n")
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

/** Outil d'attente du veilleur du gateway : une ligne par demande terminée après le curseur. */
async function waitForNotifications(ctx: ToolContext, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const { cursor: rawCursor, timeout_seconds } = parse(NotificationWaitArgs, args);
  let cursor = rawCursor === undefined ? Date.now() : Number(rawCursor);
  const deadline = Date.now() + (timeout_seconds ?? DEFAULT_NOTIFICATION_WAIT_SECONDS) * 1000;

  for (;;) {
    const finished = ctx.finished.since(cursor);
    if (finished.length > 0 || Date.now() >= deadline || signal?.aborted) {
      cursor = advanceCursor(cursor, finished);
      const lines = finished.map(formatEvent);
      return {
        content: [{ type: "text", text: JSON.stringify({ received: lines.length, cursor: String(cursor), lines }) }],
        _meta: { [EVENTS_META]: { cursor: String(cursor), lines } },
      };
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
      case "enable_notifications":
        return enableNotifications(ctx, args);
      case "wait_for_notifications":
        return await waitForNotifications(ctx, args, signal);
      case "list_servers":
        return listServers(ctx);
      case "update_server_notes":
        return updateServerNotes(ctx, args);
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
