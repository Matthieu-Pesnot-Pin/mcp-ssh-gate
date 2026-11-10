import fs from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import type { ServerPublic } from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";
import { decryptSecret, encryptSecret } from "./vault.js";

export interface StoredServer extends ServerPublic {
  /** Clé privée OpenSSH chiffrée avec VAULT_KEY. */
  privateKeyEncrypted: string;
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
    return readJson<ServersFile>(this.file).servers;
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

      const keys = ssh2.utils.generateKeyPairSync("ed25519", { comment: `mcp-ssh-gate@${id}` });
      const server: StoredServer = {
        id,
        ...fields,
        publicKey: keys.public,
        hostKeyFingerprint: null,
        createdAt: new Date().toISOString(),
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

  delete(id: string): void {
    this.mutate((servers) => {
      const index = servers.findIndex((s) => s.id === id);
      if (index === -1) throw new GateError(`Unknown server "${id}".`);
      servers.splice(index, 1);
    });
  }

  privateKey(id: string): string {
    return decryptSecret(this.get(id).privateKeyEncrypted, this.vaultKey);
  }

  /** Vérifie que VAULT_KEY déchiffre toutes les clés enregistrées. */
  verifyVault(): void {
    for (const server of this.list()) {
      try {
        decryptSecret(server.privateKeyEncrypted, this.vaultKey);
      } catch {
        throw new GateError(
          `VAULT_KEY does not decrypt the private key of server "${server.name}": it is not the key that was set when that server was added.`
        );
      }
    }
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
