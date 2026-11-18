import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MAX_ANSWER_LENGTH, MAX_COMMANDS_PER_REQUEST, MAX_SESSION_NAME_LENGTH, isFinalStatus, type AgentSession } from "../../shared/model.js";
import { GateError } from "../core/errors.js";
import type { RequestStore } from "../core/request-store.js";
import type { ServerStore, StoredServer } from "../core/server-store.js";
import type { SessionStore } from "../core/session-store.js";
import { MONITOR_TIMEOUT_MS, WATCHER_BEAT_MS, advanceCursor, formatEvent, liveWatcherSince, sleep, writeHandoff, writeWatcherBeat, type RequestEventScanner } from "../core/watch.js";
import { formatRequest } from "./format.js";

export interface ToolContext {
  servers: ServerStore;
  requests: RequestStore;
  sessions: SessionStore;
  /** Démarre le worker de l'interface si aucun n'est vivant. */
  ensureGui: () => void;
  /** URL de l'interface servie par le worker vivant. */
  guiUrl: () => string | null;
  reconnectGui: () => Promise<CallToolResult>;
  dataDir: string;
  /** Commande que l'outil Monitor de l'hôte lance pour surveiller les sessions d'un agent. */
  watchCommand: (agentId: string) => string;
  /** Événements des sessions d'un agent, lus par l'outil d'attente du veilleur du gateway. */
  events: (agentId: string) => RequestEventScanner;
}

export const WATCH_ARG = "_gateway_watch";
const WATCH_META = "gateway/watch";
const EVENTS_META = "gateway/events";
const DEFAULT_NOTIFICATION_WAIT_SECONDS = 50;
const MAX_NOTIFICATION_WAIT_SECONDS = 300;

const RESULT_OUTPUT_PER_COMMAND = 20_000;
const HISTORY_OUTPUT_PER_COMMAND = 2_000;
const POLL_MS = 1000;

const SESSION_ID_PROPERTY = { type: "string", description: "Id of your session, as returned by the submit_commands call that opened it." };
const AGENT_ID_PROPERTY = { type: "string", description: "Your agent id, returned by the submit_commands call that opened your first session." };

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "close_session",
    description:
      "Close a session you opened when its task is done: its shell is closed and its pending requests are withdrawn. A session with a running request cannot be closed. The session_id can no longer be used afterwards; your watcher keeps covering your other sessions.",
    inputSchema: {
      type: "object",
      properties: { session_id: SESSION_ID_PROPERTY },
      required: ["session_id"],
    },
  },
  {
    name: "enable_notifications",
    description:
      "Get notified of what happens in all your sessions, including the ones you open later with the same agent_id: a request you submitted is finished (all its commands ran, or the user refused or interrupted it), the user sends you a command they ran themselves in one of your sessions, the user asks you to explain a command, or the user closes one of your sessions. " +
      "Returns immediately and hands you the exact Monitor call to make right after: arming that watcher is what delivers the notifications. " +
      "Call it once per conversation, right after the submit_commands call that opened your first session — never once per session; the host stops the watcher after 30 minutes at most, re-arm it with the same Monitor call each time it expires. Works locally and behind mcp-http-gateway.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROPERTY,
        [WATCH_ARG]: {
          type: "object",
          description: "Filled in by the mcp-http-gateway relay, never by the agent: the relay will run the watcher and needs a watch specification instead of a local command",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "wait_for_notifications",
    description:
      "Reserved for the notification watcher that the mcp-http-gateway relay runs on the agent's machine: do not call it yourself. " +
      "To be notified, call enable_notifications; to read the outcome of a request, call get_result. " +
      "Blocks until an event of one of the agent's sessions happens after the cursor (a request finished, a command shared by the user, a question from the user, a session closed by the user), or until the timeout, and returns one line per event with the next cursor.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROPERTY,
        cursor: { type: "string", pattern: "^[0-9]+$", description: "Cursor returned by the previous call. Omit to wait for requests finished from now on." },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: MAX_NOTIFICATION_WAIT_SECONDS,
          description: `Maximum wait in seconds (default ${DEFAULT_NOTIFICATION_WAIT_SECONDS}).`,
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "list_servers",
    description:
      "List the SSH servers configured in the GUI, with their user, host, whether their connection has been tested, the agent sessions open on them, and their notes: the context gathered on each server (where the sites live, how apps are managed, rules to follow). " +
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
      `Submit shell commands to run in one of your sessions on a server. Read the server notes from list_servers first. ` +
      `To run in a new session, omit session_id and give server and session_name: the session is opened with this request and its session_id is returned. ` +
      `Pass that session_id to every later submit_commands of the same task: each session has its own persistent bash shell, and only you are notified of what happens in it. Close it with close_session when its task is done. ` +
      `Your sessions are tied to your agent id, so a single notification watcher covers all of them: when you open your first session, omit agent_id — a new agent id is created and returned, then call enable_notifications with it once. ` +
      `Pass that same agent_id whenever you open another session in this conversation: its events reach the watcher you already armed. ` +
      `Nothing runs until the user approves the commands in the web GUI: they can edit or remove a command, add a note, or refuse the whole request. ` +
      `Exception: when the user enabled a whitelist on that server and it covers every part of every command (each part between &&, ||, ;, | or &), the request runs right away without waiting. ` +
      `Variables, $( ), redirections to files, bash -c, xargs and the like are never covered: keep commands plain when you can. ` +
      `Approved commands run in order in the persistent bash shell of your session (cd and export carry over between commands and between your requests, never to other sessions), without a terminal: stdin is /dev/null and stderr is merged into stdout, so interactive prompts get end-of-file and sudo must not ask for a password. ` +
      `Execution stops at the first command that exits non-zero. Returns a request_id. Call enable_notifications first and keep working: you are notified when the request is finished, then read the outcome with get_result. ` +
      `Give 1 to ${MAX_COMMANDS_PER_REQUEST} commands and explain what you want to achieve: the user reads the explanation before approving.`,
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Id of an open session of yours, as returned when it was opened. Omit it to open a new session, with server and session_name." },
        server: { type: "string", description: "Server id or name, as returned by list_servers. Only to open a new session, without session_id." },
        session_name: {
          type: "string",
          maxLength: MAX_SESSION_NAME_LENGTH,
          description: `Only to open a new session, without session_id: short label of what you are doing, shown to the user (at most ${MAX_SESSION_NAME_LENGTH} characters), e.g. "deploy shop".`,
        },
        agent_id: {
          type: "string",
          description: "Only to open a new session, without session_id: your agent id, returned when you opened your first session. Omit it only when opening the first session of this conversation.",
        },
        commands: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_COMMANDS_PER_REQUEST,
          description: "Commands to run in order. One entry per command; a single entry may span several lines.",
        },
        explanation: { type: "string", description: "Why these commands are needed and what they do, shown to the user above the commands." },
      },
      required: ["commands", "explanation"],
    },
  },
  {
    name: "get_result",
    description:
      `Return the outcome of a finished request right away: refusal and its reason, or each command with its exit code and output, and the user's note. ` +
      `For a request that is not finished yet, return its current status without waiting. ` +
      `Always enable notifications (enable_notifications, then the Monitor call it returns) before relying on this tool: the watcher is what tells you a request is finished and when to call get_result. Never call it in a loop to wait.`,
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Id returned by submit_commands or given in the notification." },
      },
      required: ["request_id"],
    },
  },
  {
    name: "answer_question",
    description:
      "Answer a question the user asked in the GUI about a command: the notification gives the request_id, the question_id and the statement to explain. " +
      "Explain in the user's language what the statement does, in a few short sentences: what each part does, in which order, and what the user will see. " +
      "Point out anything risky or surprising: destructive effects, errors hidden by 2>/dev/null or a pipe, operator precedence. Plain text without Markdown; line breaks are kept. " +
      "The answer is shown under the statement in the GUI.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Request id given in the notification." },
        question_id: { type: "string", description: "Question id given in the notification." },
        answer: { type: "string", description: `The explanation, at most ${MAX_ANSWER_LENGTH} characters.` },
      },
      required: ["request_id", "question_id", "answer"],
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

const SessionArgs = z.object({ session_id: z.string().min(1) });
const SubmitArgs = z.object({
  session_id: z.string().min(1).optional(),
  server: z.string().min(1).optional(),
  session_name: z.string().optional(),
  agent_id: z.string().min(1).optional(),
  commands: z.array(z.string()).min(1).max(MAX_COMMANDS_PER_REQUEST),
  explanation: z.string().trim().min(1, "explanation must not be empty"),
});
const RequestArgs = z.object({ request_id: z.string().min(1) });
const AnswerArgs = z.object({
  request_id: z.string().min(1),
  question_id: z.string().min(1),
  answer: z.string().trim().min(1, "answer must not be empty").max(MAX_ANSWER_LENGTH),
});
const NotesArgs = z.object({
  server: z.string().min(1),
  notes: z.string(),
  mode: z.enum(["append", "replace"]).optional(),
});
const EnableArgs = z.object({ agent_id: z.string().min(1), [WATCH_ARG]: z.looseObject({ version: z.number() }).optional() });
const NotificationWaitArgs = z.object({
  agent_id: z.string().min(1),
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
    const state = !s.publicKey
      ? "key revoked by the user: commands cannot be submitted"
      : s.hostKeyFingerprint
        ? "ready"
        : "connection not tested yet: commands cannot be submitted";
    const head = `- ${s.id} — "${s.name}" — ${s.username}@${s.host}:${s.port} — ${state}`;
    const open = ctx.sessions.listOpen(s.id);
    const sessions = open.length
      ? `  Open agent sessions: ${open.map((session) => `${session.id} "${session.name}" (opened ${session.openedAt})`).join(", ")}`
      : "  Open agent sessions: none";
    if (!s.notes) return `${head}\n${sessions}\n  Notes: none yet. Record what you learn about this server with update_server_notes.`;
    const author = s.notesUpdatedBy === "user" ? "the user" : "an agent";
    const indented = s.notes.split("\n").map((line) => `    ${line}`).join("\n");
    return `${head}\n${sessions}\n  Notes (last updated by ${author} on ${s.notesUpdatedAt}):\n${indented}`;
  });
  return text(blocks.join("\n\n"));
}

function assertUsable(server: StoredServer): void {
  if (!server.publicKey) {
    throw new GateError(`The user revoked the key of "${server.id}": SSH Gate has no access to it until they install a new key in the GUI.`);
  }
  if (!server.hostKeyFingerprint) {
    throw new GateError(`The connection to "${server.id}" has never been tested. Ask the user to run "Tester la connexion" for this server in the GUI first.`);
  }
}

function closeSession(ctx: ToolContext, args: unknown): CallToolResult {
  const { session_id } = parse(SessionArgs, args);
  const session = ctx.sessions.close(session_id, "agent", ctx.requests);
  return text(`Session ${session.id} closed. Your watcher keeps running for your other sessions.`);
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

type ResolvedSession =
  | { session: AgentSession; server: StoredServer; opened: false }
  | { session: AgentSession; server: StoredServer; opened: true; newAgent: boolean };

/** Session de la demande : celle de `session_id`, ou une nouvelle ouverte sur `server` sous `session_name`. */
function resolveSession(ctx: ToolContext, input: z.infer<typeof SubmitArgs>): ResolvedSession {
  if (input.session_id !== undefined) {
    if (input.server !== undefined || input.session_name !== undefined || input.agent_id !== undefined) {
      throw new GateError("Give either session_id, to run in an open session, or server and session_name, to open a new one — not both.");
    }
    const session = ctx.sessions.getOpen(input.session_id);
    const server = ctx.servers.get(session.serverId);
    assertUsable(server);
    return { session, server, opened: false };
  }
  if (input.server === undefined || input.session_name === undefined) {
    throw new GateError("Give session_id to run in an open session, or server and session_name to open a new one.");
  }
  const server = ctx.servers.get(input.server);
  assertUsable(server);
  const agent = input.agent_id === undefined ? null : ctx.sessions.getAgent(input.agent_id);
  const session = ctx.sessions.open(server.id, input.session_name, agent?.id ?? ctx.sessions.createAgent().id);
  return { session, server, opened: true, newAgent: agent === null };
}

function submitCommands(ctx: ToolContext, args: unknown): CallToolResult {
  const input = parse(SubmitArgs, args);
  const resolved = resolveSession(ctx, input);
  const { session, server } = resolved;
  const request = ctx.requests.create({ serverId: server.id, source: "agent", sessionId: session.id, explanation: input.explanation, commands: input.commands });
  ctx.ensureGui();
  const url = ctx.guiUrl();
  const lines = [
    `Request ${request.id} submitted to session ${session.id} on ${server.id} with ${request.commands.length} command(s). It runs once the user approves it${url ? ` in the GUI (${url})` : " in the GUI"}, or right away if their whitelist covers it.`,
  ];
  if (resolved.opened) {
    lines.push(
      `Session ${session.id} was opened on ${server.id} as "${session.name}". Pass session_id ${session.id} to your next submit_commands in it: its shell is your own, cd and export carry over between your requests and never leak to other sessions. Close it with close_session when its task is done.`
    );
  }
  if (resolved.opened && resolved.newAgent) {
    lines.push(
      `Your agent id is ${session.agentId}. Call enable_notifications now with agent_id ${session.agentId}: that single watcher covers all your sessions and tells you when this request is finished; then read the outcome with get_result.`,
      `Pass agent_id ${session.agentId} whenever you open another session in this conversation, so its events reach the same watcher; omitting it creates another agent id that no watcher of yours follows.`
    );
  } else {
    if (resolved.opened) {
      lines.push(`It is tied to your agent id ${session.agentId}: the watcher you armed with enable_notifications already covers it, do not arm another one.`);
    }
    lines.push(
      `Keep working: your notification watcher tells you when it is finished, then read the outcome with get_result. ` +
        `If you have not called enable_notifications with your agent_id ${session.agentId} in this conversation, do it now.`
    );
  }
  return text(lines.join("\n"));
}

/**
 * Derrière mcp-http-gateway, le relais remplit `_gateway_watch` : il fera tourner le
 * veilleur sur la machine de l'agent et a besoin d'une spécification de veille. Sinon,
 * la réponse donne la commande du veilleur local.
 */
function enableNotifications(ctx: ToolContext, args: unknown): CallToolResult {
  const input = parse(EnableArgs, args);
  const agent = ctx.sessions.getAgent(input.agent_id);
  const description = `ssh-gate agent ${agent.id}`;
  if (input[WATCH_ARG]) {
    return {
      content: [{ type: "text", text: "Watch specification for the mcp-http-gateway relay." }],
      _meta: {
        [WATCH_META]: {
          tool: "wait_for_notifications",
          arguments: { agent_id: agent.id },
          cursor: String(Date.now()),
          description,
        },
      },
    };
  }

  writeHandoff(agent.id, ctx.dataDir);
  const command = ctx.watchCommand(agent.id);
  const since = liveWatcherSince(ctx.dataDir, agent.id);
  if (since) {
    return text(
      [
        `Notifications are already live for agent ${agent.id} (watcher armed since ${since}): it covers all your sessions, including new ones.`,
        "Nothing to do: do not arm a second watcher, you would get every notification twice.",
        "Only if the host just told you your watcher expired or stopped, re-arm it with the same Monitor call:",
        `command \`${command}\`, timeout_ms ${MONITOR_TIMEOUT_MS}.`,
      ].join("\n")
    );
  }
  return text(
    [
      `Notifications enabled for agent ${agent.id}.`,
      "",
      "Last step — call the Monitor tool now, with exactly these arguments:",
      `  command:     ${command}`,
      `  description: ${description}`,
      `  timeout_ms:  ${MONITOR_TIMEOUT_MS}`,
      "",
      "Until that watcher is armed, nothing will reach you. Once it is, keep working: it covers every session tied to",
      `agent ${agent.id}, including the ones you open later with that agent_id — never arm one watcher per session.`,
      "Each line names the server and the session. A request announces itself when its commands have all run, or when",
      "the user refused or interrupted it; read the outcome with get_result.",
      "When the user asks you to explain a command from the GUI, a line gives the statement, the request_id and the",
      "question_id: answer it with answer_question. If the user closes one of your sessions, a line says so.",
      "",
      "The host stops every monitor after 30 minutes at most. Each time it tells you this watcher expired, call",
      "Monitor again right away with the same arguments — do not call enable_notifications again. An event that",
      "happened while no watcher was running is announced as soon as the watcher is back.",
    ].join("\n")
  );
}

function getResult(ctx: ToolContext, args: unknown): CallToolResult {
  const { request_id } = parse(RequestArgs, args);
  const request = ctx.requests.get(request_id);
  if (isFinalStatus(request.status)) {
    return text(formatRequest(request, serverOrNull(ctx, request.serverId), RESULT_OUTPUT_PER_COMMAND));
  }
  if (request.status === "pending") ctx.ensureGui();
  const state = request.status === "pending" ? "still waiting for the user's approval" : "still running";
  return text(`Request ${request.id} is ${state}. Keep working: your notification watcher tells you when it is finished.`);
}

/** Dernier battement écrit par l'outil d'attente, par agent : début de la veille et instant du battement. */
const gatewayBeats = new Map<string, { since: string; at: number }>();

/** Battement du veilleur du gateway, au plus un tous les WATCHER_BEAT_MS. */
function beatGatewayWatcher(ctx: ToolContext, agent: string): void {
  const last = gatewayBeats.get(agent);
  if (last && Date.now() - last.at < WATCHER_BEAT_MS) return;
  const since = last?.since ?? new Date().toISOString();
  writeWatcherBeat(ctx.dataDir, agent, since);
  gatewayBeats.set(agent, { since, at: Date.now() });
}

/** Outil d'attente du veilleur du gateway : une ligne par événement après le curseur. */
async function waitForNotifications(ctx: ToolContext, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const { agent_id, cursor: rawCursor, timeout_seconds } = parse(NotificationWaitArgs, args);
  const agent = ctx.sessions.getAgent(agent_id).id;
  const scanner = ctx.events(agent);
  let cursor = rawCursor === undefined ? Date.now() : Number(rawCursor);
  const deadline = Date.now() + (timeout_seconds ?? DEFAULT_NOTIFICATION_WAIT_SECONDS) * 1000;

  for (;;) {
    beatGatewayWatcher(ctx, agent);
    const events = scanner.since(cursor);
    if (events.length > 0 || Date.now() >= deadline || signal?.aborted) {
      cursor = advanceCursor(cursor, events);
      const lines = events.map(formatEvent);
      return {
        content: [{ type: "text", text: JSON.stringify({ received: lines.length, cursor: String(cursor), lines }) }],
        _meta: { [EVENTS_META]: { cursor: String(cursor), lines } },
      };
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
  }
}

function answerQuestion(ctx: ToolContext, args: unknown): CallToolResult {
  const { request_id, question_id, answer } = parse(AnswerArgs, args);
  ctx.requests.update(request_id, (draft) => {
    const question = draft.questions.find((q) => q.id === question_id);
    if (!question) throw new GateError(`Question ${question_id} does not exist on request ${request_id}: the user may have withdrawn it.`);
    if (question.answer !== null) throw new GateError(`Question ${question_id} has already been answered.`);
    question.answer = answer;
    question.answeredAt = new Date().toISOString();
  });
  return text(`Answer saved: the user sees it under the statement in the GUI.`);
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
      case "close_session":
        return closeSession(ctx, args);
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
      case "get_result":
        return getResult(ctx, args);
      case "answer_question":
        return answerQuestion(ctx, args);
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
