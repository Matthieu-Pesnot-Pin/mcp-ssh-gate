import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import {
  MAX_TUNNEL_NAME_LENGTH,
  type TunnelDefinition,
  type TunnelInput,
  type TunnelsResponse,
  type TunnelStatus,
  type TunnelView,
} from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";
import { blocksLoopback, portUses, scanListeners, type Listener } from "./local-ports.js";
import type { ServerStore } from "./server-store.js";
import { connectSsh } from "./ssh-session.js";

/** Adresse d'écoute des tunnels : seule cette machine peut les joindre. */
export const TUNNEL_LISTEN_HOST = "127.0.0.1";

const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;

interface TunnelsFile {
  tunnels: TunnelDefinition[];
}

/** Tunnel démarré, en cours d'ouverture ou en échec ; un tunnel arrêté n'en a pas. */
interface Runtime {
  status: Exclude<TunnelStatus, "stopped">;
  error: string | null;
  portTaken: boolean;
  startedAt: string | null;
  client: Client | null;
  listener: net.Server | null;
  sockets: Set<net.Socket>;
}

class PortTakenError extends GateError {}

function port(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new GateError(`${label} invalide : un entier entre 1 et 65535.`);
  return number;
}

function owner(listener: Listener | undefined): string {
  return listener?.process ? `par ${listener.process}` : "par une autre application";
}

/** Ouvre un canal direct-tcpip vers l'adresse distante, depuis le port de la connexion locale. */
function forwardOut(client: Client, sourcePort: number, host: string, remotePort: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut(TUNNEL_LISTEN_HOST, sourcePort, host, remotePort, (err, channel) => (err ? reject(err) : resolve(channel)));
  });
}

function listen(localPort: number, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once("error", (err: any) => {
      reject(err?.code === "EADDRINUSE" ? new PortTakenError("Port local pris par une autre application.") : err);
    });
    server.listen({ port: localPort, host: TUNNEL_LISTEN_HOST, exclusive: true }, () => resolve(server));
  });
}

/**
 * Tunnels SSH : chaque tunnel écoute un port de 127.0.0.1 et relaie ses connexions,
 * par une connexion SSH qui lui est propre, vers une adresse vue depuis le serveur.
 * Les définitions sont gardées dans `<DATA_DIR>/tunnels.json` ; l'état démarré ne
 * l'est pas, si bien qu'un tunnel est toujours arrêté au lancement de SSH Gate.
 */
export class TunnelManager {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    dataDir: string,
    private readonly servers: ServerStore,
    private readonly log: (message: string) => void
  ) {
    this.file = path.join(dataDir, "tunnels.json");
    this.lockFile = `${this.file}.lock`;
  }

  list(): TunnelView[] {
    return this.read().map((tunnel) => this.view(tunnel));
  }

  /** Tunnels, et ports de cette machine occupés par autre chose qu'un tunnel actif. */
  async response(): Promise<TunnelsResponse> {
    const tunnels = this.list();
    const active = new Set(tunnels.filter((t) => t.status === "active").map((t) => t.localPort));
    return { tunnels, localPorts: portUses(await scanListeners(), active) };
  }

  /** Enregistre le tunnel et le démarre. */
  async create(input: TunnelInput): Promise<TunnelView> {
    const fields = this.validate(input, null);
    await this.assertPortFree(fields.localPort);
    const tunnel: TunnelDefinition = { id: `tun_${randomBytes(6).toString("hex")}`, ...fields, createdAt: new Date().toISOString() };
    this.mutate((tunnels) => [...tunnels, tunnel]);
    this.log(`Tunnel ${tunnel.id} created on ${tunnel.serverId}: ${tunnel.localPort} -> ${tunnel.remoteHost}:${tunnel.remotePort}`);
    return this.start(tunnel.id);
  }

  /** Modifie le tunnel ; un tunnel démarré, ou en échec, est rouvert avec ses nouveaux réglages. */
  async update(id: string, input: TunnelInput): Promise<TunnelView> {
    const current = this.definition(id);
    const fields = this.validate(input, id);
    if (fields.localPort !== current.localPort) await this.assertPortFree(fields.localPort);
    const wasOn = this.runtimes.has(id);
    this.stop(id);
    this.mutate((tunnels) => tunnels.map((tunnel) => (tunnel.id === id ? { ...tunnel, ...fields } : tunnel)));
    this.log(`Tunnel ${id} updated`);
    return wasOn ? this.start(id) : this.view(this.definition(id));
  }

  delete(id: string): void {
    this.definition(id);
    this.stop(id);
    this.mutate((tunnels) => tunnels.filter((tunnel) => tunnel.id !== id));
    this.log(`Tunnel ${id} deleted`);
  }

  deleteForServer(serverId: string): void {
    for (const tunnel of this.read()) if (tunnel.serverId === serverId) this.stop(tunnel.id);
    this.mutate((tunnels) => tunnels.filter((tunnel) => tunnel.serverId !== serverId));
  }

  stopForServer(serverId: string): void {
    for (const tunnel of this.read()) if (tunnel.serverId === serverId) this.stop(tunnel.id);
  }

  /**
   * Ouvre la connexion SSH, vérifie que le serveur accepte de joindre l'adresse
   * distante, puis écoute le port local. Un échec laisse le tunnel en erreur, avec sa raison.
   */
  async start(id: string): Promise<TunnelView> {
    const tunnel = this.definition(id);
    const existing = this.runtimes.get(id);
    if (existing && existing.status !== "error") return this.view(tunnel);

    const runtime: Runtime = { status: "starting", error: null, portTaken: false, startedAt: null, client: null, listener: null, sockets: new Set() };
    this.runtimes.set(id, runtime);
    const current = () => this.runtimes.get(id) === runtime;

    try {
      const server = this.servers.get(tunnel.serverId);
      if (!server.publicKey) throw new GateError(`La clé de ${server.name} a été révoquée : installe une nouvelle clé.`);
      if (!server.hostKeyFingerprint) throw new GateError(`Teste la connexion à ${server.name} avant d'ouvrir un tunnel.`);

      const taken = (await scanListeners()).find((l) => l.port === tunnel.localPort && blocksLoopback(l.address));
      if (taken) throw new PortTakenError(`Port local pris ${owner(taken)}.`);

      const { client } = await connectSsh({
        host: server.host,
        port: server.port,
        username: server.username,
        privateKey: this.servers.privateKey(server.id),
        expectedFingerprint: server.hostKeyFingerprint,
      });
      runtime.client = client;
      if (!current()) return this.release(runtime, tunnel);

      try {
        (await forwardOut(client, 0, tunnel.remoteHost, tunnel.remotePort)).close();
      } catch (err: any) {
        throw new GateError(this.channelError(err, tunnel, server.name));
      }

      runtime.listener = await listen(tunnel.localPort, (socket) => this.relay(runtime, tunnel, socket));
      if (!current()) return this.release(runtime, tunnel);

      const lost = (reason: string) => {
        if (current() && runtime.status === "active") this.fail(runtime, reason, false);
      };
      client.on("error", (err) => lost(`Connexion SSH perdue : ${err.message}`));
      client.on("close", () => lost("Connexion SSH fermée par le serveur."));
      runtime.status = "active";
      runtime.startedAt = new Date().toISOString();
      this.log(`Tunnel ${id} active on ${TUNNEL_LISTEN_HOST}:${tunnel.localPort}`);
    } catch (err: any) {
      if (current()) this.fail(runtime, err?.message ?? String(err), err instanceof PortTakenError);
      else this.release(runtime, tunnel);
    }
    return this.view(tunnel);
  }

  /** Arrête le tunnel : le port local est libéré et les connexions en cours coupées. */
  stop(id: string): TunnelView {
    const tunnel = this.definition(id);
    const runtime = this.runtimes.get(id);
    if (runtime) {
      this.runtimes.delete(id);
      this.release(runtime, tunnel);
      this.log(`Tunnel ${id} stopped`);
    }
    return this.view(tunnel);
  }

  private relay(runtime: Runtime, tunnel: TunnelDefinition, socket: net.Socket): void {
    socket.on("error", () => socket.destroy());
    if (runtime.status !== "active" || !runtime.client) {
      socket.destroy();
      return;
    }
    runtime.sockets.add(socket);
    socket.on("close", () => runtime.sockets.delete(socket));
    forwardOut(runtime.client, socket.remotePort ?? 0, tunnel.remoteHost, tunnel.remotePort).then(
      (channel) => {
        channel.on("error", () => socket.destroy());
        channel.on("close", () => socket.destroy());
        socket.on("close", () => channel.close());
        socket.pipe(channel).pipe(socket);
      },
      (err: Error) => {
        this.log(`Tunnel ${tunnel.id}: channel to ${tunnel.remoteHost}:${tunnel.remotePort} refused: ${err.message}`);
        socket.destroy();
      }
    );
  }

  /** Raison d'un refus d'ouverture de canal (RFC 4254, §5.1) : 1 interdit par le serveur, 2 connexion impossible. */
  private channelError(err: Error & { reason?: unknown }, tunnel: TunnelDefinition, serverName: string): string {
    const target = `${tunnel.remoteHost}:${tunnel.remotePort}`;
    if (err.reason === 1) {
      return `${serverName} refuse la redirection de ports à la clé de SSH Gate. Teste à nouveau la connexion au serveur pour mettre à jour la ligne de la clé ; si l'erreur persiste, vérifie AllowTcpForwarding dans la configuration de sshd.`;
    }
    if (err.reason === 2) return `Rien ne répond sur ${target} depuis ${serverName}.`;
    return `${serverName} n'a pas pu joindre ${target} : ${err.message}`;
  }

  private fail(runtime: Runtime, reason: string, portTaken: boolean): void {
    this.closeResources(runtime);
    runtime.status = "error";
    runtime.error = reason;
    runtime.portTaken = portTaken;
    runtime.startedAt = null;
  }

  private release(runtime: Runtime, tunnel: TunnelDefinition): TunnelView {
    this.closeResources(runtime);
    return this.view(tunnel);
  }

  private closeResources(runtime: Runtime): void {
    runtime.listener?.close();
    for (const socket of runtime.sockets) socket.destroy();
    runtime.sockets.clear();
    runtime.client?.end();
    runtime.listener = null;
    runtime.client = null;
  }

  private async assertPortFree(localPort: number): Promise<void> {
    const taken = (await scanListeners()).find((l) => l.port === localPort && blocksLoopback(l.address));
    if (taken) throw new GateError(`Le port local ${localPort} est déjà pris ${owner(taken)}.`);
  }

  private validate(input: TunnelInput, selfId: string | null): Omit<TunnelDefinition, "id" | "createdAt"> {
    const server = this.servers.get(String(input?.serverId ?? ""));
    const name = String(input?.name ?? "").trim();
    if (name.length > MAX_TUNNEL_NAME_LENGTH) throw new GateError(`Le nom du tunnel dépasse ${MAX_TUNNEL_NAME_LENGTH} caractères.`);
    const remoteHost = String(input?.remoteHost ?? "")
      .trim()
      .replace(/^\[(.*)\]$/, "$1");
    if (!remoteHost) throw new GateError("Indique l'hôte à joindre depuis le serveur, par exemple localhost.");
    if (!HOST_PATTERN.test(remoteHost)) throw new GateError(`Hôte distant invalide : « ${remoteHost} ».`);
    const localPort = port(input?.localPort, "Port local");
    const remotePort = port(input?.remotePort, "Port distant");

    const clash = this.read().find((tunnel) => tunnel.localPort === localPort && tunnel.id !== selfId);
    if (clash) {
      const label = clash.name || `${clash.remoteHost}:${clash.remotePort}`;
      const clashServer = this.servers.list().find((s) => s.id === clash.serverId);
      throw new GateError(`Le port local ${localPort} est déjà attribué au tunnel ${label}${clashServer ? ` de ${clashServer.name}` : ""}.`);
    }
    return { serverId: server.id, name, localPort, remoteHost, remotePort };
  }

  private view(tunnel: TunnelDefinition): TunnelView {
    const runtime = this.runtimes.get(tunnel.id);
    return {
      ...tunnel,
      status: runtime?.status ?? "stopped",
      error: runtime?.error ?? null,
      portTaken: runtime?.portTaken ?? false,
      startedAt: runtime?.startedAt ?? null,
    };
  }

  private definition(id: string): TunnelDefinition {
    const tunnel = this.read().find((t) => t.id === id);
    if (!tunnel) throw new GateError("Ce tunnel n'existe plus.");
    return tunnel;
  }

  private read(): TunnelDefinition[] {
    return fs.existsSync(this.file) ? readJson<TunnelsFile>(this.file).tunnels : [];
  }

  private mutate(change: (tunnels: TunnelDefinition[]) => TunnelDefinition[]): void {
    withFileLock(this.lockFile, "tunnels.json", () => writeJsonAtomic(this.file, { tunnels: change(this.read()) } satisfies TunnelsFile));
  }
}
