import fs from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import { MAX_NOTES_LENGTH, type NotesAuthor, type ServerPublic } from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";
import { decryptSecret, encryptSecret } from "./vault.js";

export interface StoredServer extends ServerPublic {
  /** Clé privée OpenSSH chiffrée avec VAULT_KEY ; null quand la clé a été révoquée. */
  privateKeyEncrypted: string | null;
}

interface ServersFile {
  servers: StoredServer[];
}

export interface ServerInput {
  name: string;
  host: string;
  port: number;
  username: string;
}

const USERNAME_PATTERN = /^[a-z_][a-z0-9_.-]*\$?$/i;
const HOST_PATTERN = /^[a-z0-9.:\-\[\]]+$/i;

/** Contrôle et normalise les champs saisis pour un serveur. */
export function validateServerInput(input: ServerInput): ServerInput {
  const name = String(input.name ?? "").trim();
  const host = String(input.host ?? "").trim();
  const username = String(input.username ?? "").trim();
  const port = Number(input.port);

  if (!name) throw new GateError("Le nom du serveur est obligatoire.");
  if (name.length > 60) throw new GateError("Le nom du serveur dépasse 60 caractères.");
  if (!host) throw new GateError("L'hôte est obligatoire.");
  if (!HOST_PATTERN.test(host)) throw new GateError(`Hôte invalide : « ${host} ».`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GateError("Le port doit être un entier entre 1 et 65535.");
  if (!username) throw new GateError("L'utilisateur est obligatoire.");
  if (!USERNAME_PATTERN.test(username)) throw new GateError(`Utilisateur invalide : « ${username} ».`);

  return { name, host, port, username };
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "serveur";
}

export interface KeyPair {
  public: string;
  private: string;
}

/** Nouvelle paire ed25519, commentée au nom du serveur. */
export function generateKeyPair(serverId: string): KeyPair {
  const keys = ssh2.utils.generateKeyPairSync("ed25519", { comment: `mcp-ssh-gate@${serverId}` });
  return { public: keys.public, private: keys.private };
}

export function toPublic(server: StoredServer): ServerPublic {
  const { privateKeyEncrypted: _privateKey, ...rest } = server;
  return rest;
}

/**
 * Serveurs SSH : `<DATA_DIR>/servers.json`. La paire de clés est générée à la
 * création ; seule la clé publique est lisible, la clé privée est chiffrée.
 */
export class ServerStore {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(dataDir: string, private readonly vaultKey: Buffer) {
    this.file = path.join(dataDir, "servers.json");
    this.lockFile = `${this.file}.lock`;
  }

  list(): StoredServer[] {
    if (!fs.existsSync(this.file)) return [];
    return readJson<ServersFile>(this.file).servers.map((server) => ({
      ...server,
      notes: server.notes ?? "",
      notesUpdatedAt: server.notesUpdatedAt ?? null,
      notesUpdatedBy: server.notesUpdatedBy ?? null,
      keyCreatedAt: server.keyCreatedAt ?? (server.publicKey ? server.createdAt : null),
      allowedFrom: server.allowedFrom ?? null,
    }));
  }

  /** Retrouve un serveur par identifiant ou par nom (sans tenir compte de la casse). */
  get(idOrName: string): StoredServer {
    const wanted = String(idOrName ?? "").trim().toLowerCase();
    const servers = this.list();
    const found = servers.find((s) => s.id === wanted) ?? servers.find((s) => s.name.toLowerCase() === wanted);
    if (found) return found;
    const known = servers.map((s) => s.id).join(", ") || "none";
    throw new GateError(`Unknown server "${idOrName}". Known servers: ${known}.`);
  }

  create(input: ServerInput): StoredServer {
    const fields = validateServerInput(input);
    return this.mutate((servers) => {
      const base = slugify(fields.name);
      let id = base;
      for (let n = 2; servers.some((s) => s.id === id); n++) id = `${base}-${n}`;

      const keys = generateKeyPair(id);
      const createdAt = new Date().toISOString();
      const server: StoredServer = {
        id,
        ...fields,
        publicKey: keys.public,
        keyCreatedAt: createdAt,
        allowedFrom: null,
        hostKeyFingerprint: null,
        createdAt,
        notes: "",
        notesUpdatedAt: null,
        notesUpdatedBy: null,
        privateKeyEncrypted: encryptSecret(keys.private, this.vaultKey),
      };
      servers.push(server);
      return server;
    });
  }

  /** Modifie les champs saisis. Un changement d'hôte ou de port oublie l'empreinte : c'est une autre machine. */
  update(id: string, input: ServerInput): StoredServer {
    const fields = validateServerInput(input);
    return this.mutate((servers) => {
      const server = servers.find((s) => s.id === id);
      if (!server) throw new GateError(`Unknown server "${id}".`);
      if (server.host !== fields.host || server.port !== fields.port) server.hostKeyFingerprint = null;
      Object.assign(server, fields);
      return server;
    });
  }

  setFingerprint(id: string, fingerprint: string): StoredServer {
    return this.mutate((servers) => {
      const server = servers.find((s) => s.id === id);
      if (!server) throw new GateError(`Unknown server "${id}".`);
      server.hostKeyFingerprint = fingerprint;
      return server;
    });
  }

  /** Remplace la paire de clés ; la limite d'adresse suit la ligne écrite sur le serveur. */
  replaceKey(id: string, keys: KeyPair, allowedFrom: string | null): StoredServer {
    return this.mutate((servers) => {
      const server = this.find(servers, id);
      server.publicKey = keys.public;
      server.privateKeyEncrypted = encryptSecret(keys.private, this.vaultKey);
      server.keyCreatedAt = new Date().toISOString();
      server.allowedFrom = allowedFrom;
      return server;
    });
  }

  /** Efface la paire de clés : le serveur reste enregistré, sans accès. */
  clearKey(id: string): StoredServer {
    return this.mutate((servers) => {
      const server = this.find(servers, id);
      server.publicKey = null;
      server.privateKeyEncrypted = null;
      server.keyCreatedAt = null;
      server.allowedFrom = null;
      return server;
    });
  }

  setAllowedFrom(id: string, allowedFrom: string | null): StoredServer {
    return this.mutate((servers) => {
      const server = this.find(servers, id);
      server.allowedFrom = allowedFrom;
      return server;
    });
  }

  /**
   * Remplace les notes. Avec `expectedUpdatedAt`, l'écriture est refusée si les
   * notes ont changé depuis cette date : une saisie ne doit pas écraser une
   * mise à jour faite entre-temps par l'agent ou par un autre onglet.
   */
  setNotes(id: string, text: string, by: NotesAuthor, expectedUpdatedAt?: string | null): StoredServer {
    const notes = String(text ?? "").replace(/\r\n/g, "\n").trim();
    if (notes.length > MAX_NOTES_LENGTH) {
      throw new GateError(`Notes are limited to ${MAX_NOTES_LENGTH} characters (${notes.length} given).`);
    }
    return this.mutate((servers) => {
      const server = servers.find((s) => s.id === id);
      if (!server) throw new GateError(`Unknown server "${id}".`);
      if (expectedUpdatedAt !== undefined && (server.notesUpdatedAt ?? null) !== expectedUpdatedAt) {
        const author = server.notesUpdatedBy === "agent" ? "l'agent" : "un autre onglet";
        throw new GateError(`Les notes ont été modifiées par ${author} pendant ta saisie. Copie ton texte, annule, puis reprends à partir de la nouvelle version.`);
      }
      server.notes = notes;
      server.notesUpdatedAt = new Date().toISOString();
      server.notesUpdatedBy = by;
      return server;
    });
  }

  delete(id: string): void {
    this.mutate((servers) => {
      const index = servers.findIndex((s) => s.id === id);
      if (index === -1) throw new GateError(`Unknown server "${id}".`);
      servers.splice(index, 1);
    });
  }

  privateKey(id: string): string {
    const server = this.get(id);
    if (!server.privateKeyEncrypted) {
      throw new GateError(`La clé de ${server.name} a été révoquée : installe une nouvelle clé depuis l'interface.`);
    }
    return decryptSecret(server.privateKeyEncrypted, this.vaultKey);
  }

  /** Vérifie que VAULT_KEY déchiffre toutes les clés enregistrées. */
  verifyVault(): void {
    for (const server of this.list()) {
      if (!server.privateKeyEncrypted) continue;
      try {
        decryptSecret(server.privateKeyEncrypted, this.vaultKey);
      } catch {
        throw new GateError(
          `VAULT_KEY does not decrypt the private key of server "${server.name}": it is not the key that was set when that server was added.`
        );
      }
    }
  }

  private find(servers: StoredServer[], id: string): StoredServer {
    const server = servers.find((s) => s.id === id);
    if (!server) throw new GateError(`Unknown server "${id}".`);
    return server;
  }

  private mutate<T>(fn: (servers: StoredServer[]) => T): T {
    return withFileLock(this.lockFile, "servers.json", () => {
      const servers = this.list();
      const result = fn(servers);
      writeJsonAtomic(this.file, { servers } satisfies ServersFile, 0o600);
      return result;
    });
  }
}
