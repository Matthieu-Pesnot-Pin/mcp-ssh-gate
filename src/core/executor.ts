import { randomBytes } from "node:crypto";
import { MAX_STATEMENT_LENGTH, isFinalStatus, type GateRequest, type RequestStatus, type ServerView } from "../../shared/model.js";
import { GateError } from "./errors.js";
import type { RequestStore } from "./request-store.js";
import { toPublic, type ServerInput, type ServerStore, type StoredServer } from "./server-store.js";
import { ShellSession } from "./ssh-session.js";

/** Sortie conservée par commande ; au-delà, le début est écarté. */
export const MAX_STORED_OUTPUT = 512 * 1024;
const PERSIST_INTERVAL_MS = 400;

interface RunningEntry {
  requestId: string;
  interruptRequested: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function cleanNote(note: unknown): string | null {
  const text = typeof note === "string" ? note.trim() : "";
  return text ? text : null;
}

function skipRemaining(draft: GateRequest, from: number): void {
  for (let i = from; i < draft.commands.length; i++) {
    if (draft.commands[i].status === "pending") draft.commands[i].status = "skipped";
  }
}

/**
 * Exécution des demandes validées. Une session SSH par serveur, ouverte à la
 * première exécution, et une seule demande en cours par serveur.
 */
export class Executor {
  private readonly sessions = new Map<string, ShellSession>();
  private readonly running = new Map<string, RunningEntry>();

  constructor(
    private readonly servers: ServerStore,
    private readonly requests: RequestStore,
    private readonly log: (message: string) => void
  ) {}

  /** Marque en échec les demandes restées « en cours » après l'arrêt du worker. */
  recoverAbandoned(): void {
    for (const request of this.requests.listOpen()) {
      if (request.status !== "running") continue;
      this.requests.update(request.id, (draft) => {
        for (const command of draft.commands) {
          if (command.status === "running") {
            command.status = "interrupted";
            command.endedAt = now();
          }
        }
        skipRemaining(draft, 0);
        draft.status = "failed";
        draft.error = "L'interface s'est arrêtée pendant l'exécution : le résultat des commandes en cours est inconnu.";
        draft.finishedAt = now();
      });
    }
  }

  views(): ServerView[] {
    const open = this.requests.listOpen();
    return this.servers.list().map((server) => this.view(server, open));
  }

  view(server: StoredServer, open: GateRequest[] = this.requests.listOpen()): ServerView {
    const session = this.sessions.get(server.id);
    return {
      ...toPublic(server),
      session: session && !session.closed ? "connected" : "closed",
      cwd: session && !session.closed ? session.cwd : null,
      pendingCount: open.filter((r) => r.serverId === server.id && r.status === "pending").length,
      busy: this.running.has(server.id),
    };
  }

  addServer(input: ServerInput): ServerView {
    return this.view(this.servers.create(input));
  }

  updateServer(id: string, input: ServerInput): ServerView {
    const before = this.servers.get(id);
    const after = this.servers.update(before.id, input);
    if (before.host !== after.host || before.port !== after.port || before.username !== after.username) this.disconnect(after.id);
    return this.view(after);
  }

  deleteServer(id: string): void {
    const server = this.servers.get(id);
    if (this.running.has(server.id)) throw new GateError("Une exécution est en cours sur ce serveur : attends sa fin ou interromps-la.");
    this.disconnect(server.id);
    this.servers.delete(server.id);
    this.requests.deleteServer(server.id);
  }

  /** Ouvre une nouvelle session ; enregistre l'empreinte de l'hôte au premier test. */
  async testConnection(id: string): Promise<{ server: ServerView; fingerprint: string; cwd: string }> {
    const server = this.servers.get(id);
    if (this.running.has(server.id)) throw new GateError("Une exécution est en cours sur ce serveur.");
    this.disconnect(server.id);
    const session = await this.openSession(server);
    if (!server.hostKeyFingerprint) this.servers.setFingerprint(server.id, session.fingerprint);
    return { server: this.view(this.servers.get(server.id)), fingerprint: session.fingerprint, cwd: session.cwd };
  }

  disconnect(serverId: string): void {
    const session = this.sessions.get(serverId);
    this.sessions.delete(serverId);
    session?.close();
  }

  approve(requestId: string, note: unknown): GateRequest {
    const request = this.requests.get(requestId);
    this.assertIdle(request.serverId);
    const updated = this.requests.update(requestId, (draft) => {
      if (draft.status !== "pending") throw new GateError(`Cette demande n'est plus en attente (${draft.status}).`);
      draft.status = "running";
      draft.note = cleanNote(note);
      draft.decidedAt = now();
    });
    this.start(updated);
    return updated;
  }

  refuse(requestId: string, note: unknown): GateRequest {
    return this.requests.update(requestId, (draft) => {
      if (draft.status !== "pending") throw new GateError(`Cette demande n'est plus en attente (${draft.status}).`);
      draft.status = "refused";
      draft.note = cleanNote(note);
      draft.decidedAt = now();
      draft.finishedAt = draft.decidedAt;
      skipRemaining(draft, 0);
    });
  }

  editCommand(requestId: string, index: number, command: unknown): GateRequest {
    const text = typeof command === "string" ? command.trim() : "";
    if (!text) throw new GateError("La commande ne peut pas être vide.");
    return this.requests.update(requestId, (draft) => {
      if (draft.status !== "pending") throw new GateError(`Cette demande n'est plus en attente (${draft.status}).`);
      const entry = draft.commands[index];
      if (!entry) throw new GateError(`Commande ${index + 1} introuvable.`);
      const proposed = entry.original ?? entry.command;
      entry.command = text;
      entry.original = text === proposed ? null : proposed;
      draft.questions = draft.questions.filter((question) => question.commandIndex !== index);
    });
  }

  removeCommand(requestId: string, index: number): GateRequest {
    return this.requests.update(requestId, (draft) => {
      if (draft.status !== "pending") throw new GateError(`Cette demande n'est plus en attente (${draft.status}).`);
      if (!draft.commands[index]) throw new GateError(`Commande ${index + 1} introuvable.`);
      if (draft.commands.length === 1) throw new GateError("Une demande garde au moins une commande : refuse-la plutôt.");
      draft.commands.splice(index, 1);
      draft.questions = draft.questions
        .filter((question) => question.commandIndex !== index)
        .map((question) => (question.commandIndex > index ? { ...question, commandIndex: question.commandIndex - 1 } : question));
    });
  }

  /** Demande à l'agent d'expliquer une instruction d'une commande. */
  askQuestion(requestId: string, commandIndex: unknown, statement: unknown): GateRequest {
    const index = Number(commandIndex);
    const text = typeof statement === "string" ? statement.trim() : "";
    if (!text) throw new GateError("L'instruction à expliquer est vide.");
    if (text.length > MAX_STATEMENT_LENGTH) throw new GateError(`L'instruction dépasse ${MAX_STATEMENT_LENGTH} caractères.`);
    return this.requests.update(requestId, (draft) => {
      const entry = Number.isInteger(index) ? draft.commands[index] : undefined;
      if (!entry) throw new GateError(`Commande ${index + 1} introuvable.`);
      if (!entry.command.includes(text)) throw new GateError("Cette instruction ne fait pas partie de la commande.");
      if (draft.questions.some((question) => question.commandIndex === index && question.statement === text)) {
        throw new GateError("Une explication a déjà été demandée pour cette instruction.");
      }
      draft.questions.push({ id: `q_${randomBytes(4).toString("hex")}`, commandIndex: index, statement: text, askedAt: now(), answer: null, answeredAt: null });
    });
  }

  /** Retire une question à laquelle l'agent n'a pas encore répondu. */
  cancelQuestion(requestId: string, questionId: string): GateRequest {
    return this.requests.update(requestId, (draft) => {
      const question = draft.questions.find((q) => q.id === questionId);
      if (!question) throw new GateError("Cette question n'existe plus.");
      if (question.answer !== null) throw new GateError("L'agent a déjà répondu à cette question.");
      draft.questions = draft.questions.filter((q) => q.id !== questionId);
    });
  }

  /** Commande saisie par l'utilisateur : exécutée aussitôt, sans validation. */
  runManual(serverId: string, command: unknown): GateRequest {
    const server = this.servers.get(serverId);
    this.assertIdle(server.id);
    const created = this.requests.create({ serverId: server.id, source: "user", sessionId: null, explanation: "", commands: [String(command ?? "")] });
    const updated = this.requests.update(created.id, (draft) => {
      draft.status = "running";
      draft.decidedAt = now();
    });
    this.start(updated);
    return updated;
  }

  /** Envoie aux agents une commande saisie par l'utilisateur et terminée. */
  share(requestId: string): GateRequest {
    return this.requests.update(requestId, (draft) => {
      if (draft.source !== "user") throw new GateError("Seules tes propres commandes s'envoient à l'agent.");
      if (!isFinalStatus(draft.status)) throw new GateError("La commande n'est pas encore terminée.");
      if (draft.sharedAt) throw new GateError("Cette commande a déjà été envoyée à l'agent.");
      draft.sharedAt = now();
    });
  }

  async interrupt(requestId: string): Promise<void> {
    const request = this.requests.get(requestId);
    const entry = this.running.get(request.serverId);
    if (!entry || entry.requestId !== request.id) throw new GateError("Cette demande n'est pas en cours d'exécution.");
    const session = this.sessions.get(request.serverId);
    if (!session || session.closed) throw new GateError("Le shell de ce serveur est fermé.");
    entry.interruptRequested = true;
    try {
      await session.interrupt();
    } catch (err) {
      entry.interruptRequested = false;
      throw err;
    }
  }

  assertIdle(serverId: string): void {
    if (this.running.has(serverId)) throw new GateError("Une exécution est déjà en cours sur ce serveur.");
  }

  private async openSession(server: StoredServer): Promise<ShellSession> {
    const session: ShellSession = await ShellSession.open(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        privateKey: this.servers.privateKey(server.id),
        expectedFingerprint: server.hostKeyFingerprint,
      },
      (reason) => {
        if (this.sessions.get(server.id) === session) this.sessions.delete(server.id);
        this.log(`Session ${server.id} closed: ${reason}`);
      }
    );
    this.sessions.set(server.id, session);
    return session;
  }

  private async sessionFor(serverId: string): Promise<ShellSession> {
    const existing = this.sessions.get(serverId);
    if (existing && !existing.closed) return existing;
    const server = this.servers.get(serverId);
    if (!server.hostKeyFingerprint) {
      throw new GateError("La connexion à ce serveur n'a jamais été testée : lance « Tester la connexion » dans l'interface.");
    }
    return this.openSession(server);
  }

  private start(request: GateRequest): void {
    const entry: RunningEntry = { requestId: request.id, interruptRequested: false };
    this.running.set(request.serverId, entry);
    this.execute(request, entry)
      .catch((err: any) => this.log(`Execution of ${request.id} failed: ${err?.stack ?? err}`))
      .finally(() => {
        if (this.running.get(request.serverId) === entry) this.running.delete(request.serverId);
      });
  }

  private finish(requestId: string, status: RequestStatus, error: string | null, from: number): void {
    this.requests.update(requestId, (draft) => {
      skipRemaining(draft, from);
      draft.status = status;
      draft.error = error;
      draft.finishedAt = now();
    });
  }

  private async execute(request: GateRequest, entry: RunningEntry): Promise<void> {
    let session: ShellSession;
    try {
      session = await this.sessionFor(request.serverId);
    } catch (err: any) {
      this.finish(request.id, "failed", err.message, 0);
      return;
    }

    const total = this.requests.get(request.id).commands.length;
    for (let index = 0; index < total; index++) {
      if (entry.interruptRequested) {
        this.finish(request.id, "interrupted", null, index);
        return;
      }

      const command = this.requests.get(request.id).commands[index].command;
      const stopped = await this.runOne(request.id, index, command, session, entry);
      if (stopped) {
        this.finish(request.id, stopped.status, stopped.error, index + 1);
        return;
      }
    }
    this.finish(request.id, "completed", null, total);
  }

  /** Exécute une commande ; renvoie de quoi clore la demande si l'exécution doit s'arrêter là. */
  private async runOne(
    requestId: string,
    index: number,
    command: string,
    session: ShellSession,
    entry: RunningEntry
  ): Promise<{ status: RequestStatus; error: string | null } | null> {
    let syntaxError: string | null;
    try {
      syntaxError = await session.checkSyntax(command);
    } catch (err: any) {
      this.requests.update(requestId, (draft) => {
        draft.commands[index].status = "failed";
        draft.commands[index].endedAt = now();
      });
      return { status: "failed", error: err.message };
    }

    if (syntaxError) {
      this.requests.update(requestId, (draft) => {
        const target = draft.commands[index];
        target.status = "failed";
        target.output = `Erreur de syntaxe, commande non exécutée :\n${syntaxError}`;
        target.startedAt = now();
        target.endedAt = target.startedAt;
      });
      return { status: "failed", error: null };
    }

    this.requests.update(requestId, (draft) => {
      draft.commands[index].status = "running";
      draft.commands[index].startedAt = now();
    });

    let output = "";
    let truncated = false;
    let dirty = false;
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      this.requests.update(requestId, (draft) => {
        draft.commands[index].output = output;
        draft.commands[index].outputTruncated = truncated;
      });
    };
    const timer = setInterval(flush, PERSIST_INTERVAL_MS);

    try {
      const result = await session.run(command, (text) => {
        output += text;
        if (output.length > MAX_STORED_OUTPUT) {
          output = output.slice(-MAX_STORED_OUTPUT);
          truncated = true;
        }
        dirty = true;
      });
      clearInterval(timer);

      const status = entry.interruptRequested ? "interrupted" : result.exitCode === 0 ? "succeeded" : "failed";
      this.requests.update(requestId, (draft) => {
        const target = draft.commands[index];
        target.output = output;
        target.outputTruncated = truncated;
        target.exitCode = result.exitCode;
        target.status = status;
        target.endedAt = now();
        draft.cwd = result.cwd;
      });
      if (status === "succeeded") return null;
      return { status: status === "interrupted" ? "interrupted" : "failed", error: null };
    } catch (err: any) {
      clearInterval(timer);
      this.requests.update(requestId, (draft) => {
        const target = draft.commands[index];
        target.output = output;
        target.outputTruncated = truncated;
        target.status = entry.interruptRequested ? "interrupted" : "failed";
        target.endedAt = now();
      });
      return { status: entry.interruptRequested ? "interrupted" : "failed", error: err.message };
    }
  }
}
