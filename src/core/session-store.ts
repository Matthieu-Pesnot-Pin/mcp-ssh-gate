import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MAX_SESSION_NAME_LENGTH, type AgentSession, type SessionCloser } from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";
import type { RequestStore } from "./request-store.js";

const ID_PATTERN = /^sh_[0-9a-f]{8}$/;

/**
 * Sessions d'agent : un fichier JSON par session dans `<DATA_DIR>/sessions/`.
 * Les processus MCP les ouvrent et les ferment, le worker de l'interface leur
 * associe un shell.
 */
export class SessionStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "sessions");
    fs.mkdirSync(this.root, { recursive: true });
  }

  open(serverId: string, name: string): AgentSession {
    const label = String(name ?? "").replace(/\s+/g, " ").trim();
    if (!label) throw new GateError("The session name must not be empty.");
    if (label.length > MAX_SESSION_NAME_LENGTH) throw new GateError(`The session name is limited to ${MAX_SESSION_NAME_LENGTH} characters.`);
    const session: AgentSession = {
      id: `sh_${randomBytes(4).toString("hex")}`,
      serverId,
      name: label,
      openedAt: new Date().toISOString(),
      closedAt: null,
      closedBy: null,
    };
    writeJsonAtomic(this.fileOf(session.id), session);
    return session;
  }

  get(id: string): AgentSession {
    const value = String(id ?? "").trim();
    if (!ID_PATTERN.test(value)) throw new GateError(`Invalid session id "${id}".`);
    const file = this.fileOf(value);
    if (!fs.existsSync(file)) throw new GateError(`Unknown session "${id}".`);
    return readJson<AgentSession>(file);
  }

  /** Session encore ouverte ; une session fermée est refusée avec la raison de sa fermeture. */
  getOpen(id: string): AgentSession {
    const session = this.get(id);
    if (session.closedAt) {
      const by = session.closedBy === "user" ? "the user" : "an agent";
      throw new GateError(`Session ${session.id} was closed by ${by} on ${session.closedAt}. Open a new one with open_session.`);
    }
    return session;
  }

  /** Sessions ouvertes, des plus anciennes aux plus récentes ; avec `serverId`, celles de ce serveur. */
  listOpen(serverId?: string): AgentSession[] {
    return this.all()
      .filter((session) => !session.closedAt && (serverId === undefined || session.serverId === serverId))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  /**
   * Ferme une session : ses demandes en attente sont retirées, et une demande en
   * cours d'exécution empêche la fermeture.
   */
  close(id: string, by: SessionCloser, requests: RequestStore): AgentSession {
    const session = this.getOpen(id);
    const open = requests.listOpen().filter((request) => request.sessionId === session.id);
    if (open.some((request) => request.status === "running")) {
      throw new GateError(
        by === "user"
          ? "Une commande s'exécute dans cette session : attends sa fin ou interromps-la avant de fermer la session."
          : `A request of session ${session.id} is running: wait for it to finish before closing the session.`
      );
    }
    for (const request of open) {
      requests.update(request.id, (draft) => {
        if (draft.status !== "pending") return;
        draft.status = "cancelled";
        draft.finishedAt = new Date().toISOString();
        for (const command of draft.commands) command.status = "skipped";
      });
    }
    const file = this.fileOf(session.id);
    return withFileLock(`${file}.lock`, `Session ${session.id}`, () => {
      const draft = readJson<AgentSession>(file);
      if (draft.closedAt) return draft;
      draft.closedAt = new Date().toISOString();
      draft.closedBy = by;
      writeJsonAtomic(file, draft);
      return draft;
    });
  }

  deleteServer(serverId: string): void {
    for (const session of this.all()) {
      if (session.serverId === serverId) fs.rmSync(this.fileOf(session.id), { force: true });
    }
  }

  private all(): AgentSession[] {
    return fs
      .readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          return [readJson<AgentSession>(path.join(this.root, name))];
        } catch {
          return [];
        }
      });
  }

  private fileOf(id: string): string {
    return path.join(this.root, `${id}.json`);
  }
}
