/**
 * Ce que `--migrate-to-manager` sait de SSH Gate : ses variables et la copie de
 * son dossier de stockage (cf. `manager-bundle.ts`).
 *
 * La copie reprend les serveurs et leurs clés chiffrées (`servers.json`), les
 * réglages (`settings.json`), la liste blanche (`whitelist.json`), l'historique
 * des demandes (`requests/`), les sessions (`sessions/`) et les identités
 * d'agent (`agents/`). Chaque fichier est copié sous le verrou que ses écrivains
 * prennent, donc cohérent même serveur lancé. Elle écarte les journaux
 * (`logs/`), le battement de l'interface (`gui.json`), ceux des veilleurs
 * (`watchers/`), les verrous et les fichiers temporaires.
 *
 * Les clés privées restent chiffrées par `VAULT_KEY`, exportée avec elles.
 */
import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../core/files.js";
import { APP_VERSION } from "../version.js";
import { runManagerExport, type ManagerExportSpec } from "./manager-bundle.js";

const COPIED_FILES = ["servers.json", "settings.json", "whitelist.json"];
const COPIED_DIRECTORIES = ["requests", "sessions", "agents"];

function copyLocked(source: string, target: string): void {
  withFileLock(`${source}.lock`, path.basename(source), () => {
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  });
}

/** Copie les fichiers `.json` de `source` et de ses sous-dossiers. */
function copyJsonTree(source: string, target: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyJsonTree(from, to);
    else if (entry.isFile() && entry.name.endsWith(".json")) copyLocked(from, to);
  }
}

async function copyData(source: string, target: string): Promise<void> {
  for (const name of COPIED_FILES) {
    if (fs.existsSync(path.join(source, name))) copyLocked(path.join(source, name), path.join(target, name));
  }
  for (const name of COPIED_DIRECTORIES) {
    const dir = path.join(source, name);
    if (!fs.existsSync(dir)) continue;
    fs.mkdirSync(path.join(target, name), { recursive: true });
    copyJsonTree(dir, path.join(target, name));
  }
}

const spec: ManagerExportSpec = {
  packageName: "@imenam/mcp-ssh-gate",
  packageVersion: APP_VERSION,
  secretKeys: ["VAULT_KEY"],
  copyData,
};

export function runMigrateToManager(argv: string[], cwd: string): Promise<number> {
  return runManagerExport(argv, cwd, spec);
}
