import type { Client } from "ssh2";
import { DEDICATED_KEY_FILE, keyLine } from "../../shared/install.js";
import type { KeyFileStatus, KeyStepStatus, RotationResponse, ServerView } from "../../shared/model.js";
import { AuthRefusedError, GateError } from "./errors.js";
import type { Executor } from "./executor.js";
import { generateKeyPair, type ServerStore, type StoredServer } from "./server-store.js";
import { connectSsh, execScript, type ShellTarget } from "./ssh-session.js";
import type { TerminalManager } from "./terminals.js";

const KEY_FILE = `"$HOME/${DEDICATED_KEY_FILE}"`;
const ADDRESS = /^[0-9a-f.:]+$/i;

interface Inspection {
  /** Ligne du fichier dédié qui porte la clé, ou null. */
  line: string | null;
  inAuthorizedKeys: boolean;
  /** Adresse de SSH Gate vue par le serveur (`$SSH_CLIENT`). */
  clientAddress: string | null;
}

/** Type et corps de la clé, sans le commentaire : ce qui identifie la clé dans un fichier. */
function keyIdentity(publicKey: string): string {
  return publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
}

function allowedFromOf(line: string): string | null {
  const options = line.split(/\s+/)[0];
  return /(?:^|,)from="([^"]*)"/.exec(options)?.[1] ?? null;
}

function requireKey(server: StoredServer): string {
  if (!server.publicKey) throw new GateError(`La clé de ${server.name} a été révoquée : installe une nouvelle clé.`);
  return server.publicKey;
}

async function inspect(client: Client, publicKey: string): Promise<Inspection> {
  const identity = keyIdentity(publicKey);
  const script = [
    `F=${KEY_FILE}`,
    `A="$HOME/.ssh/authorized_keys"`,
    `line=""`,
    `[ -f "$F" ] && line=$(grep -F '${identity}' "$F" | head -n 1)`,
    `auth=0`,
    `[ -f "$A" ] && grep -qF '${identity}' "$A" && auth=1`,
    `set -- $SSH_CLIENT`,
    `printf 'client=%s\\nauthorized=%s\\nline=%s\\n' "$1" "$auth" "$line"`,
    ``,
  ].join("\n");
  const { code, output } = await execScript(client, script);
  if (code !== 0) throw new GateError(`Lecture des fichiers de clés impossible : ${output.trim() || `code ${code}`}`);
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(output)?.[1].trim() ?? "";
  return { line: field("line") || null, inAuthorizedKeys: field("authorized") === "1", clientAddress: field("client") || null };
}

/** Remplace le contenu du fichier dédié, par un fichier temporaire renommé : jamais de fichier à moitié écrit. */
async function writeKeys(client: Client, lines: string[]): Promise<void> {
  const script = [
    `umask 077`,
    `mkdir -p "$HOME/.ssh/authorized_keys.d"`,
    `cat > ${KEY_FILE}.tmp <<'SSHGATE_KEYS'`,
    ...lines,
    `SSHGATE_KEYS`,
    `mv -f ${KEY_FILE}.tmp ${KEY_FILE}`,
    ``,
  ].join("\n");
  const { code, output } = await execScript(client, script);
  if (code !== 0) throw new GateError(`Écriture de ~/${DEDICATED_KEY_FILE} impossible : ${output.trim() || `code ${code}`}`);
}

async function probe(target: ShellTarget): Promise<void> {
  const { client } = await connectSsh(target);
  client.end();
}

/**
 * Clé de SSH Gate sur les serveurs. Seul le fichier dédié
 * ~/.ssh/authorized_keys.d/ssh-gate est écrit ; ~/.ssh/authorized_keys est
 * seulement lu. Chaque modification qui pourrait couper l'accès est vérifiée
 * par une seconde connexion, la première restant ouverte pour revenir en arrière.
 */
export class KeyService {
  constructor(
    private readonly servers: ServerStore,
    private readonly executor: Executor,
    private readonly terminals: TerminalManager,
    private readonly log: (message: string) => void
  ) {}

  /** Relève la place de la clé et limite sa ligne à l'adresse de SSH Gate vue par le serveur. */
  async restrictToGate(serverId: string): Promise<KeyFileStatus> {
    const server = this.servers.get(serverId);
    const publicKey = requireKey(server);
    const target = this.target(server);
    const { client } = await connectSsh(target);
    try {
      const found = await inspect(client, publicKey);
      const status = (allowedFrom: string | null, restrictError: string | null): KeyFileStatus => {
        this.servers.setAllowedFrom(server.id, allowedFrom);
        return { inDedicatedFile: !!found.line, inAuthorizedKeys: found.inAuthorizedKeys, allowedFrom, restrictError };
      };
      if (!found.line) return status(null, null);

      const current = allowedFromOf(found.line);
      const address = found.clientAddress && ADDRESS.test(found.clientAddress) ? found.clientAddress : null;
      if (!address) return status(current, "Le serveur n'indique pas l'adresse de SSH Gate (SSH_CLIENT vide) : la limite d'adresse n'est pas posée.");

      const wanted = keyLine(publicKey, address);
      if (found.line === wanted) return status(address, null);

      await writeKeys(client, [wanted]);
      try {
        await probe(target);
      } catch (err: any) {
        await writeKeys(client, [found.line]);
        return status(current, `La limite à ${address} a été refusée par le serveur, la ligne d'origine est remise : ${err.message}`);
      }
      this.log(`Key of ${server.id} restricted to ${address}`);
      return status(address, null);
    } finally {
      client.end();
    }
  }

  /**
   * Remplace la clé en quatre étapes : générer, ajouter la nouvelle à côté de
   * l'actuelle, l'essayer sur une seconde connexion, puis ne garder qu'elle.
   * Un échec avant la fin remet le fichier dans son état d'origine.
   */
  async rotate(serverId: string): Promise<RotationResponse> {
    const server = this.servers.get(serverId);
    this.executor.assertIdle(server.id);
    const publicKey = requireKey(server);
    if (!server.hostKeyFingerprint) throw new GateError("Teste la connexion à ce serveur avant de renouveler sa clé.");

    const steps: KeyStepStatus[] = ["skipped", "skipped", "skipped", "skipped"];
    const result = (error: string | null): RotationResponse => ({ server: this.executor.view(this.servers.get(server.id)), steps, error });
    const target = this.target(server);
    const { client } = await connectSsh(target);
    try {
      const found = await inspect(client, publicKey);
      if (!found.line) throw new GateError(`La clé actuelle n'est pas dans ~/${DEDICATED_KEY_FILE} : colle d'abord la commande d'installation sur le serveur.`);
      if (found.inAuthorizedKeys) {
        throw new GateError("La clé actuelle figure aussi dans ~/.ssh/authorized_keys : elle resterait valable après le renouvellement. Retire cette ligne toi-même, puis recommence.");
      }
      const allowedFrom = allowedFromOf(found.line);

      const fresh = generateKeyPair(server.id);
      const freshLine = keyLine(fresh.public, allowedFrom);
      steps[0] = "done";

      try {
        await writeKeys(client, [found.line, freshLine]);
        steps[1] = "done";
      } catch (err: any) {
        steps[1] = "failed";
        return result(err.message);
      }

      try {
        await probe({ ...target, privateKey: fresh.private });
        steps[2] = "done";
      } catch (err: any) {
        steps[2] = "failed";
        try {
          await writeKeys(client, [found.line]);
        } catch (restoreErr: any) {
          return result(`${err.message} La ligne ajoutée n'a pas pu être retirée : ${restoreErr.message}`);
        }
        return result(err.message);
      }

      this.servers.replaceKey(server.id, fresh, allowedFrom);
      this.executor.disconnect(server.id);
      this.log(`Key of ${server.id} rotated`);

      try {
        await writeKeys(client, [freshLine]);
        steps[3] = "done";
      } catch (err: any) {
        steps[3] = "failed";
        return result(`La nouvelle clé est en service, mais l'ancienne est encore dans le fichier dédié : ${err.message}`);
      }
      return result(null);
    } finally {
      client.end();
    }
  }

  /**
   * Vide le fichier dédié, vérifie que le serveur refuse désormais la clé, puis
   * l'oublie. Si le serveur l'accepte encore, elle figure ailleurs : rien n'est effacé.
   */
  async revoke(serverId: string): Promise<ServerView> {
    const server = this.servers.get(serverId);
    this.executor.assertIdle(server.id);
    const publicKey = requireKey(server);
    const target = this.target(server);

    let client: Client;
    try {
      ({ client } = await connectSsh(target));
    } catch (err: any) {
      throw new GateError(`SSH Gate n'a pas pu se connecter pour vider son fichier : ${err.message}`);
    }
    try {
      const found = await inspect(client, publicKey);
      if (found.line) {
        const { code, output } = await execScript(client, `: > ${KEY_FILE}\n`);
        if (code !== 0) throw new GateError(`Impossible de vider ~/${DEDICATED_KEY_FILE} : ${output.trim() || `code ${code}`}`);
      }
    } finally {
      client.end();
    }

    try {
      await probe(target);
    } catch (err) {
      if (err instanceof AuthRefusedError) {
        this.log(`Key of ${server.id} revoked`);
        return this.forget(server.id);
      }
      throw new GateError(`Le fichier dédié est vidé, mais la vérification n'a pas abouti : ${(err as Error).message}`);
    }
    throw new GateError(
      "Le serveur accepte toujours la clé : elle figure ailleurs, sans doute dans ~/.ssh/authorized_keys. Retire-la toi-même, puis efface la clé ici."
    );
  }

  /** Efface la clé sans toucher au serveur et ferme les connexions de SSH Gate. */
  forget(serverId: string): ServerView {
    const server = this.servers.get(serverId);
    this.executor.assertIdle(server.id);
    this.terminals.closeForServer(server.id);
    this.executor.disconnect(server.id);
    return this.executor.view(this.servers.clearKey(server.id));
  }

  /** Génère une nouvelle paire pour un serveur dont la clé a été révoquée. */
  installNewKey(serverId: string): ServerView {
    const server = this.servers.get(serverId);
    if (server.publicKey) throw new GateError(`${server.name} a déjà une clé : renouvelle-la plutôt.`);
    return this.executor.view(this.servers.replaceKey(server.id, generateKeyPair(server.id), null));
  }

  private target(server: StoredServer): ShellTarget {
    return {
      host: server.host,
      port: server.port,
      username: server.username,
      privateKey: this.servers.privateKey(server.id),
      expectedFingerprint: server.hostKeyFingerprint,
    };
  }
}
