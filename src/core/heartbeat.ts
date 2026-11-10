import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./files.js";

/** Au-delà de ce délai sans battement, le worker de l'interface est réputé arrêté. */
const STALE_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 2_000;

interface Heartbeat {
  pid: number;
  url: string;
  updatedAt: number;
}

function fileOf(dataDir: string): string {
  return path.join(dataDir, "gui.json");
}

/** Écrit le battement du worker : son URL publique et l'heure courante. */
export function writeHeartbeat(dataDir: string, url: string): void {
  writeJsonAtomic(fileOf(dataDir), { pid: process.pid, url, updatedAt: Date.now() } satisfies Heartbeat);
}

/** URL du worker vivant qui sert l'interface, ou null s'il n'y en a pas. */
export function liveGuiUrl(dataDir: string): string | null {
  const file = fileOf(dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    const beat = readJson<Heartbeat>(file);
    return Date.now() - beat.updatedAt < STALE_MS ? beat.url : null;
  } catch {
    return null;
  }
}
