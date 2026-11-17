import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MAX_SESSION_NAME_LENGTH, type AgentIdentity, type AgentSession, type SessionCloser } from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";
import type { RequestStore } from "./request-store.js";

const ID_PATTERN = /^sh_[0-9a-f]{8}$/;
const AGENT_ID_PATTERN = /^ag_[0-9a-f]{8}$/;

/**
 * Sessions d'agent : un fichier JSON par session dans `<DATA_DIR>/sessions/`, et un par
 * identité d'agent dans `<DATA_DIR>/agents/`. Les processus MCP les ouvrent et les
 * ferment, le worker de l'interface associe un shell à chaque session.
 */
export class SessionStore {
  private readonly root: string;
  private readonly agentsRoot: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "sessions");
    this.agentsRoot = path.join(dataDir, "agents");
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.agentsRoot, { recursive: true });
  }

  createAgent(): AgentIdentity {
    const agent: AgentIdentity = { id: `ag_${randomBytes(4).toString("hex")}`, createdAt: new Date().toISOString() };
    writeJsonAtomic(path.join(this.agentsRoot, `${agent.id}.json`), agent);
    return agent;
  }

  getAgent(id: string): AgentIdentity {
    const value = String(id ?? "").trim();
    if (!AGENT_ID_PATTERN.test(value)) throw new GateError(`Invalid agent id "${id}".`);
    const file = path.join(this.agentsRoot, `${value}.json`);
    if (!fs.existsSync(file)) throw new GateError(`Unknown agent id "${id}": use the agent_id returned by your first open_session.`);
    return readJson<AgentIdentity>(file);
  }

  open(serverId: string, name: string, agentId: string): AgentSession {
    const label = String(name ?? "").replace(/\s+/g, " ").trim();
    if (!label) throw new GateError("The session name must not be empty.");
    if (label.length > MAX_SESSION_NAME_LENGTH) throw new GateError(`The session name is limited to ${MAX_SESSION_NAME_LENGTH} characters.`);
    const session: AgentSession = {
      id: `sh_${randomBytes(4).toString("hex")}`,
      serverId,
      agentId: this.getAgent(agentId).id,
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

  /** Sessions ouvertes par un agent, fermées comprises. */
  listForAgent(agentId: string): AgentSession[] {
    return this.all().filter((session) => session.agentId === agentId);
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
