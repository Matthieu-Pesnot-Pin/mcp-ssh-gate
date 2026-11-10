import fs from "node:fs";
import path from "node:path";
import { GateError } from "./errors.js";

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Sérialise un cycle lire-modifier-écrire entre processus : `wx` échoue si le
 * verrou existe déjà. Un verrou plus vieux que LOCK_STALE_MS est cassé.
 * Non réentrant.
 */
export function withFileLock<T>(lockPath: string, subject: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;

  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new GateError(`${subject} is being written by another process and did not free up in ${LOCK_TIMEOUT_MS} ms. Try again in a moment.`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Verrou déjà cassé pour obsolescence par un autre processus.
    }
  }
}

/** Écrit un JSON par renommage atomique : un lecteur voit l'ancien contenu ou le nouveau, jamais un fichier tronqué. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
