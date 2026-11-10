import fs from "node:fs";
import path from "node:path";
import { generateVaultKey } from "../core/vault.js";

const SERVER_NAME = "ssh-gate";
const PACKAGE_NAME = "@imenam/mcp-ssh-gate";

/** Slashes POSIX : pas de backslashes échappés dans le JSON, et Node les accepte sous Windows. */
function toPosixPath(dir: string): string {
  return dir.replace(/\\/g, "/");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export interface GuiExposure {
  proxyUrl?: string;
  appPort?: number;
}

function buildServerEntry(codeRoot: string, exposure: GuiExposure, vaultKey: string) {
  const folder = path.basename(codeRoot) || "ssh-gate";
  const proxyUrl = exposure.appPort !== undefined ? "" : exposure.proxyUrl ?? "http://localhost:";
  return {
    command: "npx",
    args: ["-y", PACKAGE_NAME],
    env: {
      PROXY_URL: proxyUrl,
      APP_PORT: exposure.appPort !== undefined ? String(exposure.appPort) : "",
      APP_GROUP: capitalize(folder),
      APP_NAME: "SSH Gate",
      APP_PATH: "/ssh-gate",
      DATA_DIR: toPosixPath(path.join(codeRoot, ".ssh-gate-data")),
      VAULT_KEY: vaultKey,
      MCP_LOG_DIR: "",
    },
  };
}

const GENERATED_VARS = [
  ["PROXY_URL", "URL du proxy pour exposer l'interface (compléter le port)"],
  ["APP_PORT", "port local si aucun proxy — l'interface est servie sur http://localhost:<port>"],
  ["APP_GROUP", "groupe d'affichage dans le dashboard du proxy"],
  ["APP_NAME", "nom affiché de l'interface dans le dashboard du proxy"],
  ["APP_PATH", "chemin de montage de l'interface derrière le proxy"],
  ["DATA_DIR", "serveurs, clés chiffrées et historique des commandes (pré-rempli)"],
  ["VAULT_KEY", "clé de chiffrement des clés SSH (générée) — à conserver, la perdre rend les clés illisibles"],
  ["MCP_LOG_DIR", "répertoire des logs (défaut : <DATA_DIR>/logs)"],
];

function readFlag(argv: string[], name: string): string | undefined {
  const prefixes = [`--${name}=`, `--${name.replace(/_/g, "-")}=`];
  for (const arg of argv) {
    const prefix = prefixes.find((p) => arg.startsWith(p));
    if (prefix) return arg.slice(prefix.length).trim();
  }
  return undefined;
}

/** Traduit `--proxy_url=` / `--app_port=` en mode d'exposition de l'interface ; les deux ensemble sont refusés. */
export function parseGuiExposure(argv: string[]): { exposure: GuiExposure } | { error: string } {
  const rawProxyUrl = readFlag(argv, "proxy_url");
  const rawAppPort = readFlag(argv, "app_port");

  if (rawProxyUrl !== undefined && rawAppPort !== undefined) {
    return { error: "--proxy_url et --app_port sont exclusifs : l'interface passe par le proxy, ou écoute sur un port local." };
  }

  if (rawProxyUrl !== undefined) {
    if (rawProxyUrl === "") return { error: "--proxy_url attend une URL, ex : --proxy_url=http://localhost:3000" };
    let parsed: URL;
    try {
      parsed = new URL(rawProxyUrl);
    } catch {
      return { error: `--proxy_url invalide : "${rawProxyUrl}" n'est pas une URL absolue (ex : http://localhost:3000).` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `--proxy_url invalide : protocole "${parsed.protocol}" non supporté (http ou https attendu).` };
    }
    return { exposure: { proxyUrl: rawProxyUrl.replace(/\/+$/, "") } };
  }

  if (rawAppPort !== undefined) {
    const port = Number(rawAppPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `--app_port invalide : "${rawAppPort}" n'est pas un entier entre 1 et 65535.` };
    }
    return { exposure: { appPort: port } };
  }

  return { exposure: {} };
}

export interface SetupMcpOptions {
  cwd: string;
  force: boolean;
  exposure?: GuiExposure;
}

/**
 * Écrit l'entrée du serveur dans le .mcp.json du dossier courant. Une
 * VAULT_KEY déjà présente est conservée : la remplacer rendrait illisibles les
 * clés des serveurs enregistrés.
 */
export function runSetupMcp({ cwd, force, exposure = {} }: SetupMcpOptions): number {
  const target = path.join(cwd, ".mcp.json");

  let config: any = {};
  const exists = fs.existsSync(target);

  if (exists) {
    const raw = fs.readFileSync(target, "utf-8").trim();
    if (raw !== "") {
      try {
        config = JSON.parse(raw);
      } catch (err: any) {
        console.error(`Erreur : ${target} contient du JSON invalide (${err.message}).`);
        console.error("Corrigez le fichier ou supprimez-le, puis relancez la commande.");
        return 1;
      }
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      console.error(`Erreur : ${target} ne contient pas un objet JSON.`);
      return 1;
    }
  }

  if (typeof config.mcpServers !== "object" || config.mcpServers === null || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  const previous = config.mcpServers[SERVER_NAME];
  if (previous && !force) {
    console.error(`Le serveur "${SERVER_NAME}" est déjà configuré dans ${target}.`);
    console.error("Relancez avec --force pour écraser cette entrée (les autres serveurs et la VAULT_KEY sont préservés).");
    return 1;
  }

  const previousKey = typeof previous?.env?.VAULT_KEY === "string" && previous.env.VAULT_KEY.trim() ? previous.env.VAULT_KEY.trim() : null;
  config.mcpServers[SERVER_NAME] = buildServerEntry(cwd, exposure, previousKey ?? generateVaultKey());

  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const action = previous ? "remplacée" : exists ? "ajoutée" : "créée";
  console.log(`Configuration ${SERVER_NAME} ${action} dans ${target}`);
  console.log(previousKey ? "VAULT_KEY existante conservée." : "Nouvelle VAULT_KEY générée.");
  console.log("");

  if (exposure.appPort !== undefined) {
    console.log(`Interface en accès direct : http://localhost:${exposure.appPort} (sans proxy).`);
  } else if (exposure.proxyUrl !== undefined) {
    console.log(`Interface exposée via le proxy ${exposure.proxyUrl}.`);
  }

  console.log('Variables du champ "env" :');
  for (const [name, description] of GENERATED_VARS) {
    console.log(`  ${name.padEnd(14)} ${description}`);
  }
  console.log("");
  console.log("PROXY_URL ou APP_PORT doit être renseigné : sans interface, aucune commande ne peut être validée.");
  console.log("PROXY_URL et APP_PORT s'excluent : PROXY_URL prime si les deux sont renseignés.");

  return 0;
}
