import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFinalStatus, type CommandStatus, type GateRequest, type RequestSource, type RequestStatus } from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, writeJsonAtomic } from "./files.js";
import { RequestStore, readRequestFile } from "./request-store.js";

/** Durée maximale d'un Monitor côté hôte. */
export const MONITOR_TIMEOUT_MS = 1_800_000;

const SCAN_INTERVAL_MS = 1_000;
const WATCHER_BEAT_MS = 5_000;
const WATCHER_STALE_MS = 15_000;
const HANDOFF_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const BACKOFF_MAX_MS = 30_000;

/** Identifiant d'une session d'agent, c'est-à-dire d'un processus MCP. */
export function newSessionId(): string {
  return `ses_${randomBytes(8).toString("hex")}`;
}

// --- Événements à annoncer -----------------------------------------------------------

/** Ce qu'il faut d'une demande terminée pour l'annoncer ; la sortie des commandes n'est pas gardée. */
export interface FinishedRequest {
  kind: "finished";
  id: string;
  serverId: string;
  source: RequestSource;
  status: RequestStatus;
  /** Instant à annoncer : fin de la demande de l'agent, ou envoi par l'utilisateur. */
  eventMs: number;
  note: string | null;
  error: string | null;
  commands: { status: CommandStatus; exitCode: number | null }[];
}

/** Question de l'utilisateur sur une instruction, pas encore répondue. */
export interface QuestionAsked {
  kind: "question";
  /** Demande qui contient la commande. */
  id: string;
  serverId: string;
  questionId: string;
  commandIndex: number;
  commandCount: number;
  statement: string;
  /** Instant où la question a été posée. */
  eventMs: number;
}

export type GateEvent = FinishedRequest | QuestionAsked;

interface CachedEntry {
  mtimeMs: number;
  /** Événements de la demande destinés à la session. */
  events: GateEvent[];
}

/**
 * Lit les événements à annoncer à une session : ses demandes une fois terminées, les
 * commandes que l'utilisateur a envoyées aux agents, et les questions de l'utilisateur
 * sur les commandes de la session ou sur les siennes. Le curseur est l'instant, en
 * millisecondes, du dernier événement déjà annoncé. Seuls les fichiers modifiés depuis
 * la lecture précédente sont relus.
 */
export class RequestEventScanner {
  private readonly cache = new Map<string, CachedEntry>();

  constructor(
    private readonly requests: RequestStore,
    private readonly session: string
  ) {}

  /** Événements à annoncer après `cursor`, dans l'ordre chronologique. */
  since(cursor: number): GateEvent[] {
    const found: GateEvent[] = [];
    for (const { file, mtimeMs } of this.requests.files()) {
      let entry = this.cache.get(file);
      if (!entry || entry.mtimeMs !== mtimeMs) {
        try {
          entry = { mtimeMs, events: this.toEvents(readRequestFile(file)) };
        } catch {
          continue;
        }
        this.cache.set(file, entry);
      }
      for (const event of entry.events) if (event.eventMs > cursor) found.push(event);
    }
    return found.sort((a, b) => a.eventMs - b.eventMs);
  }

  private toEvents(request: GateRequest): GateEvent[] {
    const events: GateEvent[] = [];
    const finished = this.toFinished(request);
    if (finished) events.push(finished);
    const concerned = request.source === "user" || request.sessionId === this.session;
    if (!concerned) return events;
    for (const question of request.questions) {
      if (question.answer !== null) continue;
      events.push({
        kind: "question",
        id: request.id,
        serverId: request.serverId,
        questionId: question.id,
        commandIndex: question.commandIndex,
        commandCount: request.commands.length,
        statement: question.statement,
        eventMs: Date.parse(question.askedAt),
      });
    }
    return events;
  }

  private toFinished(request: GateRequest): FinishedRequest | null {
    if (!isFinalStatus(request.status) || request.status === "cancelled" || !request.finishedAt) return null;
    const eventAt = request.source === "agent" ? (request.sessionId === this.session ? request.finishedAt : null) : request.sharedAt;
    if (!eventAt) return null;
    return {
      kind: "finished",
      id: request.id,
      serverId: request.serverId,
      source: request.source,
      status: request.status,
      eventMs: Date.parse(eventAt),
      note: request.note,
      error: request.error,
      commands: request.commands.map((c) => ({ status: c.status, exitCode: c.exitCode })),
    };
  }
}

/** Curseur après annonce des événements donnés. */
export function advanceCursor(cursor: number, announced: GateEvent[]): number {
  return announced.reduce((max, request) => Math.max(max, request.eventMs), cursor);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Ligne de notification : une seule ligne, lisible telle quelle par l'agent. */
export function formatEvent(event: GateEvent): string {
  return event.kind === "question" ? formatQuestion(event) : formatFinished(event);
}

function formatQuestion(event: QuestionAsked): string {
  return (
    `[ssh-gate] ${event.serverId} — the user asks you to explain part of command ${event.commandIndex + 1}/${event.commandCount} of request ${event.id}: ` +
    `${oneLine(event.statement, 1000)} — answer with answer_question, request_id ${event.id}, question_id ${event.questionId}`
  );
}

function formatFinished(request: FinishedRequest): string {
  const total = request.commands.length;
  const stoppedAt = request.commands.findIndex((c) => c.status === "failed" || c.status === "interrupted");
  let outcome: string;
  switch (request.status) {
    case "completed":
      outcome = `completed: ${total}/${total} command(s) succeeded`;
      break;
    case "failed": {
      const exitCode = stoppedAt === -1 ? null : request.commands[stoppedAt].exitCode;
      outcome =
        stoppedAt === -1
          ? `failed before running: ${oneLine(request.error ?? "unknown error", 120)}`
          : `failed at command ${stoppedAt + 1}/${total}${exitCode === null ? "" : ` (exit ${exitCode})`}`;
      break;
    }
    case "interrupted":
      outcome = `interrupted by the user${stoppedAt === -1 ? "" : ` at command ${stoppedAt + 1}/${total}`}`;
      break;
    case "refused":
      outcome = `refused by the user${request.note ? `: ${oneLine(request.note, 120)}` : ""}`;
      break;
    default:
      outcome = request.status;
  }
  const note = request.note && request.status !== "refused" ? " — the user left a note" : "";
  const subject = request.source === "user" ? `the user shared ${total} command(s) they ran themselves (request ${request.id}), ${outcome}` : `request ${request.id} ${outcome}`;
  return `[ssh-gate] ${request.serverId} — ${subject}${note} — read it with get_result, request_id ${request.id}`;
}

// --- Veilleur local ----------------------------------------------------------------
//
// En local, le veilleur est lancé par l'outil Monitor de l'hôte, dans le shell de la
// session : il n'hérite pas du bloc `env` du MCP. Le relais lui indique le dossier de
// données et garde le curseur, pour qu'un veilleur relancé reprenne là où le précédent
// s'est arrêté. Il ne contient aucun secret.

interface Handoff {
  session: string;
  dataDir: string;
  cursor: number;
  written_at: string;
}

function handoffDir(): string {
  return path.join(os.homedir(), ".mcp-ssh-gate", "watch");
}

function handoffPath(session: string): string {
  return path.join(handoffDir(), `${createHash("sha256").update(session).digest("hex").slice(0, 32)}.json`);
}

const written = new Set<string>();

function readHandoff(session: string): Handoff | null {
  try {
    const handoff = readJson<Handoff>(handoffPath(session));
    return handoff.session === session ? handoff : null;
  } catch {
    return null;
  }
}

function saveHandoff(handoff: Omit<Handoff, "written_at">): void {
  writeJsonAtomic(handoffPath(handoff.session), { ...handoff, written_at: new Date().toISOString() } satisfies Handoff);
}

/** Dépose le relais de la session ; un relais existant garde son curseur. */
export function writeHandoff(session: string, dataDir: string): void {
  written.add(session);
  const existing = readHandoff(session);
  saveHandoff({ session, dataDir, cursor: existing?.cursor ?? Date.now() });
  pruneStaleHandoffs();
}

/** Retire les relais écrits par ce processus. Synchrone : appelable sur `exit`. */
export function removeOwnHandoffs(): void {
  for (const session of written) fs.rmSync(handoffPath(session), { force: true });
  written.clear();
}

function pruneStaleHandoffs(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(handoffDir());
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(handoffDir(), entry);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > HANDOFF_STALE_MS) fs.rmSync(file, { force: true });
    } catch {
      // Un relais déjà supprimé ne doit pas faire échouer l'écriture.
    }
  }
}

function watcherBeatPath(dataDir: string, session: string): string {
  return path.join(dataDir, "watchers", `${session}.json`);
}

/** Date depuis laquelle un veilleur local vivant surveille cette session, ou null. */
export function liveWatcherSince(dataDir: string, session: string): string | null {
  try {
    const beat = readJson<{ since: string; updatedAt: number }>(watcherBeatPath(dataDir, session));
    return Date.now() - beat.updatedAt < WATCHER_STALE_MS ? beat.since : null;
  } catch {
    return null;
  }
}

/**
 * Mode veilleur local (`--watch <session>`). Une ligne sur stdout par événement
 * de la session : l'outil Monitor de l'hôte réveille l'agent à chaque ligne. Le journal
 * et les erreurs partent sur stderr. Une erreur de lecture se traduit par un réessai,
 * jamais par une sortie.
 */
export async function runWatchMode(session: string | null): Promise<void> {
  if (!session) throw new GateError("--watch needs a session id: `mcp-ssh-gate --watch <session>`. Call enable_notifications to get the exact command.");
  const handoff = readHandoff(session);
  if (!handoff) {
    throw new GateError(`No notification handoff for session ${session}: call enable_notifications in that MCP session first.`);
  }

  const scanner = new RequestEventScanner(new RequestStore(handoff.dataDir), session);
  const since = new Date().toISOString();
  let cursor = handoff.cursor;
  let lastBeat = 0;
  let backoff = SCAN_INTERVAL_MS;
  process.stderr.write(`[ssh-gate] watching session ${session} in ${handoff.dataDir}\n`);

  for (;;) {
    try {
      if (Date.now() - lastBeat >= WATCHER_BEAT_MS) {
        writeJsonAtomic(watcherBeatPath(handoff.dataDir, session), { since, updatedAt: Date.now() });
        lastBeat = Date.now();
      }
      const events = scanner.since(cursor);
      if (events.length > 0) {
        for (const event of events) process.stdout.write(`${formatEvent(event)}\n`);
        cursor = advanceCursor(cursor, events);
        saveHandoff({ session, dataDir: handoff.dataDir, cursor });
      }
      backoff = SCAN_INTERVAL_MS;
      await sleep(SCAN_INTERVAL_MS);
    } catch (err: any) {
      process.stderr.write(`[ssh-gate] scan failed, retrying in ${Math.round(backoff / 1000)} s: ${err?.message ?? err}\n`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
