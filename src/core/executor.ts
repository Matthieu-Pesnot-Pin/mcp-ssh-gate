import { randomBytes } from "node:crypto";
import { MAX_STATEMENT_LENGTH, isFinalStatus, type GateRequest, type RequestStatus, type ServerView, type SessionView } from "../../shared/model.js";
import { GateError } from "./errors.js";
import type { RequestStore } from "./request-store.js";
import { toPublic, type ServerInput, type ServerStore, type StoredServer } from "./server-store.js";
import type { SessionStore } from "./session-store.js";
import { ShellSession } from "./ssh-session.js";

/** Sortie conservée par commande ; au-delà, le début est écarté. */
export const MAX_STORED_OUTPUT = 512 * 1024;
const PERSIST_INTERVAL_MS = 400;

interface RunningEntry {
  requestId: string;
  serverId: string;
  interruptRequested: boolean;
}

interface ShellEntry {
  serverId: string;
  shell: ShellSession;
}

/** Clé du shell d'une session : l'identifiant de la session d'agent, ou celui de la session « Vous » du serveur. */
function shellKey(serverId: string, sessionId: string | null): string {
  return sessionId ?? `user:${serverId}`;
}

function keyOf(request: GateRequest): string {
  return shellKey(request.serverId, request.sessionId);
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
 * Exécution des demandes validées. Chaque session a son shell, ouvert à la
 * première exécution : la session « Vous » de chaque serveur, et chaque session
 * d'agent. Une seule demande en cours par session.
 */
export class Executor {
  private readonly shells = new Map<string, ShellEntry>();
  private readonly running = new Map<string, RunningEntry>();

  constructor(
    private readonly servers: ServerStore,
    private readonly requests: RequestStore,
    private readonly sessions: SessionStore,
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
    this.closeShellsOfClosedSessions();
    const open = this.requests.listOpen();
    return this.servers.list().map((server) => this.view(server, open));
  }

  view(server: StoredServer, open: GateRequest[] = this.requests.listOpen()): ServerView {
    const agentSessions = this.sessions.listOpen(server.id);
    const sessions = [
      this.sessionView(server.id, null, "Vous", null, open),
      ...agentSessions.map((session) => this.sessionView(server.id, session.id, session.name, session.openedAt, open)),
    ];
    return {
      ...toPublic(server),
      sessions,
      pendingCount: sessions.reduce((sum, session) => sum + session.pendingCount, 0),
      busy: sessions.some((session) => session.busy),
    };
  }

  private sessionView(serverId: string, sessionId: string | null, name: string, openedAt: string | null, open: GateRequest[]): SessionView {
    const key = shellKey(serverId, sessionId);
    const shell = this.liveShell(key);
    return {
      id: sessionId,
      serverId,
      name,
      openedAt,
      shell: shell ? "connected" : "closed",
      cwd: shell ? shell.cwd : null,
      pendingCount: open.filter((r) => r.serverId === serverId && r.sessionId === sessionId && r.status === "pending").length,
      busy: this.running.has(key),
    };
  }

  private liveShell(key: string): ShellSession | null {
    const entry = this.shells.get(key);
    return entry && !entry.shell.closed ? entry.shell : null;
  }

  /** Ferme le shell des sessions qu'un agent a fermées depuis son processus MCP. */
  private closeShellsOfClosedSessions(): void {
    const open = new Set(this.sessions.listOpen().map((session) => session.id));
    for (const key of [...this.shells.keys()]) {
      if (key.startsWith("user:") || open.has(key) || this.running.has(key)) continue;
      this.closeShell(key);
    }
  }

  private closeShell(key: string): void {
    const entry = this.shells.get(key);
    this.shells.delete(key);
    entry?.shell.close();
  }

  /** Ferme une session d'agent depuis l'interface. */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (this.running.has(session.id)) {
      throw new GateError("Une commande s'exécute dans cette session : attends sa fin ou interromps-la avant de fermer la session.");
    }
    this.sessions.close(session.id, "user", this.requests);
    this.closeShell(session.id);
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
    if (this.isServerBusy(server.id)) throw new GateError("Une exécution est en cours sur ce serveur : attends sa fin ou interromps-la.");
    this.disconnect(server.id);
    this.servers.delete(server.id);
    this.requests.deleteServer(server.id);
    this.sessions.deleteServer(server.id);
  }

  /** Ouvre le shell de la session « Vous » ; enregistre l'empreinte de l'hôte au premier test. */
  async testConnection(id: string): Promise<{ server: ServerView; fingerprint: string; cwd: string }> {
    const server = this.servers.get(id);
    this.assertIdle(server.id);
    this.disconnect(server.id);
    const shell = await this.openShell(server, shellKey(server.id, null));
    if (!server.hostKeyFingerprint) this.servers.setFingerprint(server.id, shell.fingerprint);
    return { server: this.view(this.servers.get(server.id)), fingerprint: shell.fingerprint, cwd: shell.cwd };
  }

  /** Ferme les shells de toutes les sessions du serveur. */
  disconnect(serverId: string): void {
    for (const [key, entry] of [...this.shells]) {
      if (entry.serverId === serverId) this.closeShell(key);
    }
  }

  approve(requestId: string, note: unknown): GateRequest {
    const request = this.requests.get(requestId);
    this.assertSessionIdle(keyOf(request));
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
      if (draft.sessionId === null) throw new GateError("Cette commande a été tapée dans ta session : aucun agent ne peut l'expliquer.");
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

  /** Commande saisie par l'utilisateur dans une session : exécutée aussitôt, sans validation. */
  runManual(serverId: string, sessionId: string | null, command: unknown): GateRequest {
    const server = this.servers.get(serverId);
    if (sessionId !== null) {
      const session = this.sessions.getOpen(sessionId);
      if (session.serverId !== server.id) throw new GateError(`La session ${session.id} n'appartient pas à ${server.name}.`);
    }
    this.assertSessionIdle(shellKey(server.id, sessionId));
    const created = this.requests.create({ serverId: server.id, source: "user", sessionId, explanation: "", commands: [String(command ?? "")] });
    const updated = this.requests.update(created.id, (draft) => {
      draft.status = "running";
      draft.decidedAt = now();
    });
    this.start(updated);
    return updated;
  }

  /** Envoie à l'agent de la session une commande que l'utilisateur y a tapée et qui est terminée. */
  share(requestId: string): GateRequest {
    return this.requests.update(requestId, (draft) => {
      if (draft.source !== "user") throw new GateError("Seules tes propres commandes s'envoient à l'agent.");
      if (draft.sessionId === null) throw new GateError("Cette commande a été tapée dans ta session : aucun agent ne la reçoit.");
      if (!isFinalStatus(draft.status)) throw new GateError("La commande n'est pas encore terminée.");
      if (draft.sharedAt) throw new GateError("Cette commande a déjà été envoyée à l'agent.");
      draft.sharedAt = now();
    });
  }

  async interrupt(requestId: string): Promise<void> {
    const request = this.requests.get(requestId);
    const key = keyOf(request);
    const entry = this.running.get(key);
    if (!entry || entry.requestId !== request.id) throw new GateError("Cette demande n'est pas en cours d'exécution.");
    const shell = this.liveShell(key);
    if (!shell) throw new GateError("Le shell de cette session est fermé.");
    entry.interruptRequested = true;
    try {
      await shell.interrupt();
    } catch (err) {
      entry.interruptRequested = false;
      throw err;
    }
  }

  /** Refuse l'opération quand une demande s'exécute dans l'une des sessions du serveur. */
  assertIdle(serverId: string): void {
    if (this.isServerBusy(serverId)) throw new GateError("Une exécution est en cours sur ce serveur : attends sa fin ou interromps-la.");
  }

  private isServerBusy(serverId: string): boolean {
    return [...this.running.values()].some((entry) => entry.serverId === serverId);
  }

  private assertSessionIdle(key: string): void {
    if (this.running.has(key)) throw new GateError("Une exécution est déjà en cours dans cette session.");
  }

  private async openShell(server: StoredServer, key: string): Promise<ShellSession> {
    const shell: ShellSession = await ShellSession.open(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        privateKey: this.servers.privateKey(server.id),
        expectedFingerprint: server.hostKeyFingerprint,
      },
      (reason) => {
        if (this.shells.get(key)?.shell === shell) this.shells.delete(key);
        this.log(`Shell ${key} on ${server.id} closed: ${reason}`);
      }
    );
    this.shells.set(key, { serverId: server.id, shell });
    return shell;
  }

  private async shellFor(request: GateRequest): Promise<ShellSession> {
    const key = keyOf(request);
    const existing = this.liveShell(key);
    if (existing) return existing;
    const server = this.servers.get(request.serverId);
    if (!server.hostKeyFingerprint) {
      throw new GateError("La connexion à ce serveur n'a jamais été testée : lance « Tester la connexion » dans l'interface.");
    }
    if (request.sessionId !== null) this.sessions.getOpen(request.sessionId);
    return this.openShell(server, key);
  }

  private start(request: GateRequest): void {
    const key = keyOf(request);
    const entry: RunningEntry = { requestId: request.id, serverId: request.serverId, interruptRequested: false };
    this.running.set(key, entry);
    this.execute(request, entry)
      .catch((err: any) => this.log(`Execution of ${request.id} failed: ${err?.stack ?? err}`))
      .finally(() => {
        if (this.running.get(key) === entry) this.running.delete(key);
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
      session = await this.shellFor(request);
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
