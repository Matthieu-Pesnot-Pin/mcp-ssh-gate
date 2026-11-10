import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Client, ClientChannel } from "ssh2";
import type { TerminalServerMessage, TerminalView } from "../../shared/model.js";
import { GateError } from "./errors.js";
import type { ServerStore } from "./server-store.js";
import { connectSsh } from "./ssh-session.js";

/** Fin de la sortie gardée pour être rejouée à la reconnexion d'un navigateur. */
const SCROLLBACK_CHARS = 200_000;
const MAX_TERMINALS = 20;

type Listener = (message: TerminalServerMessage) => void;

interface Terminal {
  view: TerminalView;
  client: Client;
  channel: ClientChannel;
  scrollback: string;
  listeners: Set<Listener>;
}

function clampSize(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

/**
 * Terminaux interactifs : un shell avec pseudo-terminal par onglet, sur une
 * connexion SSH qui lui est propre, distincte du shell des demandes de l'agent.
 * La session survit à la fermeture de la page ; elle se termine quand
 * l'utilisateur la ferme ou que le shell distant s'arrête.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    private readonly servers: ServerStore,
    private readonly log: (message: string) => void
  ) {}

  list(): TerminalView[] {
    return [...this.terminals.values()].map((terminal) => ({ ...terminal.view }));
  }

  async open(serverId: string, cols: unknown, rows: unknown): Promise<TerminalView> {
    const server = this.servers.get(serverId);
    if (!server.hostKeyFingerprint) throw new GateError("Teste la connexion à ce serveur avant d'ouvrir un terminal.");
    if (this.terminals.size >= MAX_TERMINALS) throw new GateError(`Pas plus de ${MAX_TERMINALS} terminaux ouverts à la fois.`);

    const size = { cols: clampSize(cols, 20, 500, 80), rows: clampSize(rows, 5, 200, 24) };
    const { client } = await connectSsh({
      host: server.host,
      port: server.port,
      username: server.username,
      privateKey: this.servers.privateKey(server.id),
      expectedFingerprint: server.hostKeyFingerprint,
    });

    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: "xterm-256color", cols: size.cols, rows: size.rows }, (err, stream) => {
        if (err) {
          client.end();
          reject(new GateError(`Impossible d'ouvrir un terminal sur ${server.host} : ${err.message}`));
        } else {
          resolve(stream);
        }
      });
    });

    const view: TerminalView = {
      id: `term_${randomBytes(6).toString("hex")}`,
      serverId: server.id,
      serverName: server.name,
      number: this.nextNumber(server.id),
      openedAt: new Date().toISOString(),
      cols: size.cols,
      rows: size.rows,
      status: "open",
      closedReason: null,
    };
    const terminal: Terminal = { view, client, channel, scrollback: "", listeners: new Set() };
    this.terminals.set(view.id, terminal);
    this.log(`Terminal ${view.id} opened on ${server.id}`);

    const stdout = new StringDecoder("utf8");
    const stderr = new StringDecoder("utf8");
    channel.on("data", (chunk: Buffer) => this.output(terminal, stdout.write(chunk)));
    channel.stderr.on("data", (chunk: Buffer) => this.output(terminal, stderr.write(chunk)));
    channel.on("close", () => this.markClosed(terminal, "Le shell s'est terminé."));
    client.on("error", (err) => this.markClosed(terminal, `Connexion SSH perdue : ${err.message}`));
    client.on("close", () => this.markClosed(terminal, "Connexion SSH fermée."));

    return { ...view };
  }

  /** Abonne un navigateur : il reçoit d'abord la sortie gardée, puis le flux. */
  attach(id: string, listener: Listener): () => void {
    const terminal = this.get(id);
    if (terminal.scrollback) listener({ type: "output", data: terminal.scrollback });
    if (terminal.view.status === "closed") {
      listener({ type: "closed", reason: terminal.view.closedReason ?? "" });
      return () => {};
    }
    terminal.listeners.add(listener);
    return () => terminal.listeners.delete(listener);
  }

  write(id: string, data: unknown): void {
    const terminal = this.get(id);
    if (terminal.view.status === "open" && typeof data === "string") terminal.channel.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    const terminal = this.get(id);
    if (terminal.view.status !== "open") return;
    terminal.view.cols = clampSize(cols, 20, 500, terminal.view.cols);
    terminal.view.rows = clampSize(rows, 5, 200, terminal.view.rows);
    terminal.channel.setWindow(terminal.view.rows, terminal.view.cols, 0, 0);
  }

  /** Ferme la session et retire le terminal. */
  close(id: string): void {
    const terminal = this.get(id);
    this.terminals.delete(id);
    this.markClosed(terminal, "Session fermée.");
    terminal.listeners.clear();
    this.log(`Terminal ${id} closed`);
  }

  closeForServer(serverId: string): void {
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.view.serverId === serverId) this.close(terminal.view.id);
    }
  }

  private get(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new GateError("Ce terminal n'existe plus.");
    return terminal;
  }

  private nextNumber(serverId: string): number {
    const used = new Set([...this.terminals.values()].filter((t) => t.view.serverId === serverId).map((t) => t.view.number));
    let number = 1;
    while (used.has(number)) number++;
    return number;
  }

  private output(terminal: Terminal, data: string): void {
    if (!data) return;
    terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_CHARS);
    for (const listener of terminal.listeners) listener({ type: "output", data });
  }

  private markClosed(terminal: Terminal, reason: string): void {
    if (terminal.view.status === "closed") return;
    terminal.view.status = "closed";
    terminal.view.closedReason = reason;
    terminal.channel.end();
    terminal.client.end();
    for (const listener of terminal.listeners) listener({ type: "closed", reason });
  }
}
