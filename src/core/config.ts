import fs from "node:fs";
import path from "node:path";
import { GateError } from "./errors.js";
import { parseVaultKey } from "./vault.js";

export interface GateConfig {
  dataDir: string;
  vaultKey: Buffer;
  logDir: string;
}

/** Racine du paquet : premier dossier contenant un package.json en remontant depuis `startDir`. */
export function findProjectRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return startDir;
}

/**
 * Lit la configuration dans l'environnement. DATA_DIR et VAULT_KEY sont
 * obligatoires ; un DATA_DIR qui n'existe pas encore est créé.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
  const rawDataDir = env.DATA_DIR?.trim();
  if (!rawDataDir) {
    throw new GateError("DATA_DIR is not set. It is the folder where the servers and the command history are stored.");
  }
  const dataDir = path.resolve(rawDataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  const vaultKey = parseVaultKey(env.VAULT_KEY);
  const configuredLogDir = env.MCP_LOG_DIR?.trim();
  const logDir = configuredLogDir ? path.resolve(configuredLogDir) : path.join(dataDir, "logs");

  return { dataDir, vaultKey, logDir };
}

/** L'interface est indispensable : sans elle, aucune commande ne peut être validée. */
export function assertGuiConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PROXY_URL?.trim() || env.APP_PORT?.trim()) return;
  throw new GateError(
    "Neither PROXY_URL nor APP_PORT is set. The web GUI is where commands are approved: set PROXY_URL to expose it through the proxy, or APP_PORT to serve it on http://localhost:<port>."
  );
}
