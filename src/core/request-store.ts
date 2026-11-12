import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { MAX_COMMANDS_PER_REQUEST, type GateRequest, type RequestSource } from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";

export interface NewRequest {
  serverId: string;
  source: RequestSource;
  sessionId: string | null;
  explanation: string;
  commands: string[];
}

const ID_PATTERN = /^[0-9a-z]{9}-[0-9a-f]{6}$/;

let lastStamp = 0;

/**
 * Identifiant triable par date de création : horodatage base 36 sur 9
 * caractères, puis 6 caractères aléatoires. L'horodatage croît strictement
 * dans un processus : deux demandes créées dans la même milliseconde gardent
 * leur ordre.
 */
function newId(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return `${lastStamp.toString(36).padStart(9, "0")}-${randomBytes(3).toString("hex")}`;
}

function normalizeCommands(commands: string[]): string[] {
  if (!Array.isArray(commands) || commands.length === 0) throw new GateError("At least one command is required.");
  if (commands.length > MAX_COMMANDS_PER_REQUEST) {
    throw new GateError(`A request holds at most ${MAX_COMMANDS_PER_REQUEST} commands; split the work into several requests.`);
  }
  return commands.map((raw, index) => {
    const command = String(raw ?? "").trim();
    if (!command) throw new GateError(`Command ${index + 1} is empty.`);
    return command;
  });
}

/** Lit un fichier de demande ; une demande enregistrée avant les questions n'en a aucune. */
export function readRequestFile(file: string): GateRequest {
  const request = readJson<GateRequest>(file);
  return { ...request, questions: request.questions ?? [] };
}

/**
 * Demandes d'exécution : un fichier JSON par demande dans
 * `<DATA_DIR>/requests/<serveur>/`. Les processus MCP créent les demandes,
 * le worker de l'interface les fait avancer.
 */
export class RequestStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "requests");
    fs.mkdirSync(this.root, { recursive: true });
  }

  create(input: NewRequest): GateRequest {
    const commands = normalizeCommands(input.commands);
    const request: GateRequest = {
      id: newId(),
      serverId: input.serverId,
      source: input.source,
      sessionId: input.sessionId,
      explanation: String(input.explanation ?? "").trim(),
      createdAt: new Date().toISOString(),
      status: "pending",
      note: null,
      decidedAt: null,
      finishedAt: null,
      sharedAt: null,
      error: null,
      cwd: null,
      questions: [],
      commands: commands.map((command) => ({
        command,
        original: null,
        status: "pending",
        exitCode: null,
        output: "",
        outputTruncated: false,
        startedAt: null,
        endedAt: null,
      })),
    };
    writeJsonAtomic(this.fileOf(request.serverId, request.id), request);
    return request;
  }

  get(id: string): GateRequest {
    return readRequestFile(this.locate(id));
  }

  /** Demandes d'un serveur, les plus anciennes d'abord ; `limit` garde les plus récentes. */
  listForServer(serverId: string, limit?: number): GateRequest[] {
    const dir = path.join(this.root, serverId);
    if (!fs.existsSync(dir)) return [];
    let names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (limit !== undefined) names = names.slice(-limit);
    return names.map((name) => readRequestFile(path.join(dir, name)));
  }

  /** Demandes non terminées de tous les serveurs. */
  listOpen(): GateRequest[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root)
      .flatMap((serverId) => this.listForServer(serverId))
      .filter((request) => request.status === "pending" || request.status === "running");
  }

  update(id: string, fn: (draft: GateRequest) => void): GateRequest {
    const file = this.locate(id);
    return withFileLock(`${file}.lock`, `Request ${id}`, () => {
      const draft = readRequestFile(file);
      fn(draft);
      writeJsonAtomic(file, draft);
      return draft;
    });
  }

  /** Fichiers de demande de tous les serveurs, avec leur date de modification. */
  files(): { file: string; mtimeMs: number }[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).flatMap((serverId) => {
      const dir = path.join(this.root, serverId);
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
      } catch {
        return [];
      }
      return names.flatMap((name) => {
        const file = path.join(dir, name);
        try {
          return [{ file, mtimeMs: fs.statSync(file).mtimeMs }];
        } catch {
          return [];
        }
      });
    });
  }

  deleteServer(serverId: string): void {
    fs.rmSync(path.join(this.root, serverId), { recursive: true, force: true });
  }

  private fileOf(serverId: string, id: string): string {
    return path.join(this.root, serverId, `${id}.json`);
  }

  private locate(id: string): string {
    const value = String(id ?? "").trim();
    if (!ID_PATTERN.test(value)) throw new GateError(`Invalid request id "${id}".`);
    for (const serverId of fs.readdirSync(this.root)) {
      const file = this.fileOf(serverId, value);
      if (fs.existsSync(file)) return file;
    }
    throw new GateError(`Unknown request "${id}".`);
  }
}
