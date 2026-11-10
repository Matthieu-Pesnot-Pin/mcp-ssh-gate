import { createHash, randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import ssh2, { type Client, type ClientChannel } from "ssh2";
import { GateError } from "./errors.js";

const CONNECT_TIMEOUT_MS = 15_000;
const READY_MARKER = /__SSHGATE_READY_(\d+)_(.*)__\n/;
const END_MARKER_PREFIX = "__SSHGATE_END_";

export interface ShellTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /** Empreinte attendue de la clé d'hôte ; null au premier test de connexion. */
  expectedFingerprint: string | null;
}

export interface CommandResult {
  exitCode: number;
  cwd: string;
}

/** Empreinte au format d'OpenSSH : `SHA256:<base64 sans remplissage>`. */
export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/**
 * Script écrit dans le shell pour une commande. Le groupe `{ }` s'exécute dans
 * le shell courant (un `cd` ou un `export` persiste), l'entrée vient de
 * /dev/null (une commande qui attend une saisie reçoit une fin de fichier) et
 * stderr est fusionné dans stdout. Le marqueur final porte le code de retour et
 * le répertoire courant.
 */
export function wrapCommand(command: string, token: string): string {
  return `{\n${command}\n} </dev/null 2>&1\n__sg_rc=$?\nprintf '\\n${END_MARKER_PREFIX}%s_%s_%s__\\n' '${token}' "$__sg_rc" "$PWD"\n`;
}

/**
 * Découpe le flux du shell : transmet la sortie au fil de l'eau et détecte le
 * marqueur de fin de la commande. La fin du tampon qui pourrait être un début
 * de marqueur est retenue jusqu'au fragment suivant.
 */
export class CommandOutputParser {
  private buffer = "";
  private readonly marker: string;

  constructor(token: string, private readonly onOutput: (text: string) => void) {
    this.marker = `\n${END_MARKER_PREFIX}${token}_`;
  }

  /** Ajoute un fragment ; renvoie le résultat quand le marqueur complet est arrivé. */
  push(chunk: string): CommandResult | null {
    this.buffer += chunk;
    const at = this.buffer.indexOf(this.marker);

    if (at === -1) {
      const keep = Math.min(this.buffer.length, this.marker.length - 1);
      this.emit(this.buffer.length - keep);
      return null;
    }

    this.emit(at);
    const lineEnd = this.buffer.indexOf("\n", this.marker.length);
    if (lineEnd === -1) return null;

    const line = this.buffer.slice(this.marker.length, lineEnd);
    this.buffer = this.buffer.slice(lineEnd + 1);
    const match = /^(\d+)_(.*)__$/.exec(line);
    if (!match) throw new GateError(`Unreadable end marker from the shell: "${line}".`);
    return { exitCode: Number(match[1]), cwd: match[2] };
  }

  private emit(length: number): void {
    if (length <= 0) return;
    this.onOutput(this.buffer.slice(0, length));
    this.buffer = this.buffer.slice(length);
  }
}

function connectionErrorMessage(err: any, target: ShellTarget): string {
  if (err?.level === "client-authentication") {
    return `Authentification refusée pour ${target.username}@${target.host} : la clé publique n'est pas dans ~/.ssh/authorized_keys de cet utilisateur.`;
  }
  if (err?.level === "client-timeout") return `Le serveur ${target.host}:${target.port} n'a pas répondu dans les ${CONNECT_TIMEOUT_MS / 1000} s.`;
  return `Connexion SSH impossible à ${target.host}:${target.port} : ${err?.message ?? err}`;
}

interface RunningCommand {
  parser: CommandOutputParser;
  resolve: (result: CommandResult) => void;
  reject: (err: Error) => void;
}

/**
 * Connexion SSH et shell bash persistant, sans terminal : les commandes
 * s'enchaînent dans le même shell, une à la fois.
 */
/**
 * Ouvre une connexion SSH authentifiée. Avec une empreinte attendue, une clé
 * d'hôte différente la fait échouer ; l'empreinte vue est renvoyée.
 */
export function connectSsh(target: ShellTarget): Promise<{ client: Client; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let seenFingerprint: string | null = null;
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(new GateError(message));
    };

    client.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve({ client, fingerprint: seenFingerprint! });
    });

    client.on("error", (err: any) => {
      if (target.expectedFingerprint && seenFingerprint && seenFingerprint !== target.expectedFingerprint) {
        return fail(
          `La clé d'hôte de ${target.host} a changé (${seenFingerprint}, attendue ${target.expectedFingerprint}). Connexion refusée : vérifie le serveur, puis modifie-le dans l'interface pour enregistrer la nouvelle empreinte.`
        );
      }
      fail(connectionErrorMessage(err, target));
    });

    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 30_000,
      hostVerifier: (key: Buffer) => {
        seenFingerprint = fingerprintOf(key);
        return target.expectedFingerprint === null || seenFingerprint === target.expectedFingerprint;
      },
    });
  });
}

export class ShellSession {
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private current: RunningCommand | null = null;
  private closedReason: string | null = null;

  private constructor(
    private readonly client: Client,
    private readonly channel: ClientChannel,
    readonly shellPid: number,
    public cwd: string,
    readonly fingerprint: string,
    private readonly onClose: (reason: string) => void
  ) {
    channel.on("data", (chunk: Buffer) => this.receive(this.stdoutDecoder.write(chunk)));
    channel.stderr.on("data", (chunk: Buffer) => this.receive(this.stderrDecoder.write(chunk)));
    channel.on("close", () => this.handleClose("Le shell s'est fermé."));
    client.on("error", (err) => this.handleClose(`Connexion SSH perdue : ${err.message}`));
    client.on("close", () => this.handleClose("Connexion SSH fermée."));
  }

  /**
   * Ouvre la connexion et le shell. Avec une empreinte attendue, une clé d'hôte
   * différente fait échouer la connexion ; sans, l'empreinte vue est renvoyée.
   */
  static async open(target: ShellTarget, onClose: (reason: string) => void): Promise<ShellSession> {
    const { client, fingerprint } = await connectSsh(target);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        client.end();
        reject(new GateError(message));
      };
      client.on("error", (err) => fail(`Connexion SSH perdue : ${err.message}`));

      client.exec("bash -l", (err, channel) => {
        if (err) return fail(`Impossible d'ouvrir un shell sur ${target.host} : ${err.message}`);

        const decoder = new StringDecoder("utf8");
        let buffer = "";
        const timer = setTimeout(
          () => fail(`Le shell de ${target.host} n'a pas répondu dans les ${CONNECT_TIMEOUT_MS / 1000} s : bash est-il installé ?`),
          CONNECT_TIMEOUT_MS
        );

        const onData = (chunk: Buffer) => {
          buffer += decoder.write(chunk);
          const match = READY_MARKER.exec(buffer);
          if (!match || settled) return;
          clearTimeout(timer);
          channel.off("data", onData);
          settled = true;
          resolve(new ShellSession(client, channel, Number(match[1]), match[2], fingerprint, onClose));
        };

        channel.on("data", onData);
        channel.on("close", () => {
          clearTimeout(timer);
          fail(`Le shell de ${target.host} s'est fermé au démarrage.`);
        });
        channel.write(`printf '__SSHGATE_READY_%s_%s__\\n' "$$" "$PWD"\n`);
      });
    });
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  /** Exécute une commande dans le shell ; `onOutput` reçoit la sortie au fil de l'eau. */
  run(command: string, onOutput: (text: string) => void): Promise<CommandResult> {
    if (this.closedReason) return Promise.reject(new GateError(this.closedReason));
    if (this.current) return Promise.reject(new GateError("Une commande est déjà en cours dans ce shell."));

    const token = randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      this.current = { parser: new CommandOutputParser(token, onOutput), resolve, reject };
      this.channel.write(wrapCommand(command, token));
    });
  }

  /** Vérifie la syntaxe avec `bash -n`, sans rien exécuter ; renvoie le message d'erreur, ou null. */
  checkSyntax(command: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.client.exec("bash -n", (err, channel) => {
        if (err) return reject(new GateError(`Vérification de syntaxe impossible : ${err.message}`));
        let output = "";
        channel.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        channel.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        channel.on("close", (code: number | null) => resolve(code === 0 ? null : output.trim() || `bash -n a renvoyé le code ${code}.`));
        channel.end(`${command}\n`);
      });
    });
  }

  /**
   * Envoie SIGINT aux processus lancés par le shell, comme un Ctrl+C. Échoue
   * quand aucun processus n'a reçu le signal : une boucle exécutée par le shell
   * lui-même n'a pas de processus fils à interrompre.
   */
  interrupt(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.exec(`pkill -INT -P ${this.shellPid}`, (err, channel) => {
        if (err) return reject(new GateError(`Interruption impossible : ${err.message}`));
        let output = "";
        channel.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        channel.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
        channel.on("close", (code: number | null) => {
          if (code === 0) return resolve();
          if (code === 1) return reject(new GateError("Aucun processus à interrompre : la commande s'exécute dans le shell lui-même. Ferme le shell pour l'arrêter."));
          reject(new GateError(`Interruption impossible : pkill a renvoyé le code ${code}${output.trim() ? ` (${output.trim()})` : ""}.`));
        });
      });
    });
  }

  close(): void {
    this.handleClose("Déconnecté.");
  }

  private receive(text: string): void {
    const current = this.current;
    if (!current || !text) return;
    let result: CommandResult | null;
    try {
      result = current.parser.push(text);
    } catch (err: any) {
      this.current = null;
      current.reject(err);
      return;
    }
    if (!result) return;
    this.current = null;
    this.cwd = result.cwd;
    current.resolve(result);
  }

  private handleClose(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    const current = this.current;
    this.current = null;
    current?.reject(new GateError(reason));
    this.client.end();
    this.onClose(reason);
  }
}
