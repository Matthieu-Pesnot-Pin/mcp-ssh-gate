import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalPortUse } from "../../shared/model.js";
import { GateError } from "./errors.js";

const run = promisify(execFile);
const SCAN_TIMEOUT_MS = 5_000;

/** Port TCP en écoute, avec le PID et le nom du programme quand le système les donne. */
export interface Listener {
  address: string;
  port: number;
  pid: number | null;
  process: string | null;
}

/**
 * Adresse d'écoute qui occupe le port pour `localhost` : boucle locale (127.0.0.0/8, ::1)
 * ou toutes les interfaces. Une écoute sur une seule adresse du réseau ne gêne pas un tunnel.
 */
export function blocksLoopback(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  return bare === "*" || bare === "0.0.0.0" || bare === "::" || bare === "::1" || bare.startsWith("127.") || bare.startsWith("::ffff:127.");
}

function splitAddress(value: string): { address: string; port: number } | null {
  const at = value.lastIndexOf(":");
  if (at <= 0) return null;
  const port = Number(value.slice(at + 1));
  return Number.isInteger(port) && port > 0 ? { address: value.slice(0, at), port } : null;
}

/** Lignes de `netstat -ano` : une écoute TCP a pour adresse distante `0.0.0.0:0` ou `[::]:0`, quelle que soit la langue du système. */
export function parseNetstat(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0] !== "TCP" || (fields[2] !== "0.0.0.0:0" && fields[2] !== "[::]:0")) continue;
    const local = splitAddress(fields[1]);
    if (local) listeners.push({ ...local, pid: Number(fields[4]), process: null });
  }
  return listeners;
}

/** Lignes `<pid>,<nom>` écrites par le script PowerShell de `windowsProcessNames`. */
export function parseProcessList(output: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+),(.+)$/.exec(line.trim());
    if (match) names.set(Number(match[1]), match[2]);
  }
  return names;
}

/** Lignes de `ss -Hltnp` : `LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=812,fd=6))`. */
export function parseSs(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const local = splitAddress(fields[3]);
    if (!local) continue;
    const owner = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    listeners.push({ ...local, pid: owner ? Number(owner[2]) : null, process: owner ? owner[1] : null });
  }
  return listeners;
}

/** Sortie de `lsof -F pcn` : une ligne `p<pid>`, puis `c<commande>`, puis une ligne `n<adresse>` par socket. */
export function parseLsof(output: string): Listener[] {
  const listeners: Listener[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of output.split("\n")) {
    const value = line.slice(1).trim();
    if (line.startsWith("p")) {
      pid = Number(value);
      command = null;
    } else if (line.startsWith("c")) {
      command = value;
    } else if (line.startsWith("n")) {
      const local = splitAddress(value);
      if (local) listeners.push({ ...local, pid, process: command });
    }
  }
  return listeners;
}

async function output(command: string, args: string[], acceptedCodes: number[] = [0]): Promise<string> {
  try {
    const { stdout } = await run(command, args, { timeout: SCAN_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err: any) {
    if (typeof err?.code === "number" && acceptedCodes.includes(err.code)) return String(err.stdout ?? "");
    throw new GateError(`Relevé des ports locaux impossible (${command}) : ${err?.message ?? err}`);
  }
}

/** Noms des programmes Windows par PID, gardés tant que le PID écoute encore un port. */
const windowsNames = new Map<number, string | null>();

/** Complète `windowsNames` en un seul appel PowerShell pour les PID encore inconnus. */
async function windowsProcessNames(pids: number[]): Promise<Map<number, string | null>> {
  const unknown = [...new Set(pids)].filter((pid) => !windowsNames.has(pid));
  if (unknown.length > 0) {
    const script = `Get-Process -Id ${unknown.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id),$($_.ProcessName)" }; exit 0`;
    const found = parseProcessList(await output("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]));
    for (const pid of unknown) windowsNames.set(pid, found.get(pid) ?? null);
  }
  for (const pid of [...windowsNames.keys()]) if (!pids.includes(pid)) windowsNames.delete(pid);
  return windowsNames;
}

/** Ports TCP en écoute sur cette machine : `netstat` et PowerShell sous Windows, `lsof` sous macOS, `ss` ailleurs. */
export async function scanListeners(): Promise<Listener[]> {
  if (process.platform === "win32") {
    const listeners = parseNetstat(await output("netstat", ["-ano"]));
    const names = await windowsProcessNames(listeners.filter((l) => blocksLoopback(l.address)).map((l) => l.pid!));
    return listeners.map((listener) => ({ ...listener, process: names.get(listener.pid!) ?? null }));
  }
  // lsof sort avec le code 1 quand aucun port n'est en écoute.
  if (process.platform === "darwin") return parseLsof(await output("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], [0, 1]));
  return parseSs(await output("ss", ["-Hltnp"]));
}

/** Un port par entrée, trié, en gardant le premier nom de programme connu. */
export function portUses(listeners: Listener[], excluded: ReadonlySet<number>): LocalPortUse[] {
  const byPort = new Map<number, LocalPortUse>();
  for (const listener of listeners) {
    if (!blocksLoopback(listener.address) || excluded.has(listener.port)) continue;
    const known = byPort.get(listener.port);
    if (!known) byPort.set(listener.port, { port: listener.port, process: listener.process });
    else if (!known.process && listener.process) known.process = listener.process;
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}
