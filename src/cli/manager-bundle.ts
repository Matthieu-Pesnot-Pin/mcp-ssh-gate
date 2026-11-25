/**
 * `--migrate-to-manager` : archive d'import d'un MCP pour MCP Gateway Manager
 * (format `mcp-gateway-manager/mcp-import`, version 1).
 *
 * Lancée dans le dossier d'un projet, la commande lit son `.mcp.json`, retient
 * l'entrée qui lance ce paquet (`--name` quand il y en a plusieurs) et écrit
 * `<nom>.mcp-import.zip` dans le dossier courant :
 *
 *  - `manifest.json` : nom, commande, arguments et variables d'environnement du
 *    MCP, secrets en clair et signalés comme tels ;
 *  - `data/` : copie cohérente du dossier de stockage, quand le MCP en a un.
 *
 * Les variables que le hub fixe lui-même (dossier de stockage, route,
 * enregistrement de l'interface graphique) et celles propres à la machine ne
 * sont pas reprises. Ce fichier est identique dans chaque MCP ; ce qui est
 * propre au MCP passe par {@link ManagerExportSpec}.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yazl from "yazl";

export const MANAGER_EXPORT_FLAG = "--migrate-to-manager";

const FORMAT = "mcp-gateway-manager/mcp-import";
const FORMAT_VERSION = 1;

/** Variables fixées par le hub, ou propres à la machine d'origine. */
const HUB_MANAGED_KEYS = [
  "DATA_DIR",
  "MCP_SERVER_ROUTE",
  "EXPOSE_AT_AGENT_STARTUP",
  "PROXY_URL",
  "APP_GROUP",
  "APP_NAME",
  "APP_PATH",
  "APP_PATH_PREFIX",
  "APP_PORT",
  "PROXY_APP_NAME",
  "PROXY_APP_PATH",
  "GUI_PATH",
  "MCP_LOG_DIR",
];

/** Noms de variables traités comme secrets en plus de ceux que déclare le MCP. */
const SECRET_PATTERN = /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIALS)/i;

export interface ManagerExportSpec {
  /** Nom du paquet npm, tel qu'il apparaît dans les arguments de `.mcp.json`. */
  packageName: string;
  packageVersion: string;
  /** Anciens noms du paquet : reconnus dans `.mcp.json` et remplacés par le nom actuel. */
  legacyPackageNames?: string[];
  /** Anciens noms de la variable du dossier de stockage, en plus de `DATA_DIR`. */
  legacyStorageKeys?: string[];
  /** Variables renommées depuis : ancien nom → nom actuel. */
  renamedKeys?: Record<string, string>;
  /** Variables non reprises : propres à la machine, ou plus lues. */
  droppedKeys?: string[];
  /** Variables secrètes, sous leur nom actuel. */
  secretKeys?: string[];
  /**
   * Copie cohérente du dossier de stockage `dataDir` dans `target` (qui existe
   * et est vide), y compris pendant que le MCP tourne. Absente : le MCP n'a pas
   * de données.
   */
  copyData?: (dataDir: string, target: string) => Promise<void>;
}

interface McpJsonEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

class ExportError extends Error {}

function readOption(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === name) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ExportError(`${name} attend une valeur.`);
      return value;
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

/** Nom de paquet que désigne `token` (`nom` ou `nom@version`), parmi `names`. */
function packageOf(token: unknown, names: string[]): string | undefined {
  if (typeof token !== "string") return undefined;
  return names.find((name) => token === name || token.startsWith(`${name}@`));
}

function packageNames(spec: ManagerExportSpec): string[] {
  return [spec.packageName, ...(spec.legacyPackageNames ?? [])];
}

function launchesPackage(entry: McpJsonEntry, spec: ManagerExportSpec): boolean {
  const tokens = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  return tokens.some((token) => packageOf(token, packageNames(spec)) !== undefined);
}

/** Remplace un ancien nom du paquet par le nom actuel, en gardant la version demandée. */
function currentPackageToken(token: string, spec: ManagerExportSpec): string {
  const name = packageOf(token, spec.legacyPackageNames ?? []);
  return name === undefined ? token : `${spec.packageName}${token.slice(name.length)}`;
}

function readMcpJson(cwd: string): Record<string, McpJsonEntry> {
  const file = path.join(cwd, ".mcp.json");
  if (!fs.existsSync(file)) throw new ExportError(`Aucun .mcp.json dans ${cwd}. Lancez la commande dans le dossier du projet.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ExportError(`${file} n'est pas un JSON valide : ${(err as Error).message}`);
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new ExportError(`${file} ne contient pas de bloc « mcpServers ».`);
  }
  return servers as Record<string, McpJsonEntry>;
}

function selectEntry(
  servers: Record<string, McpJsonEntry>,
  spec: ManagerExportSpec,
  requested: string | undefined,
): [string, McpJsonEntry] {
  const matching = Object.entries(servers).filter(([, entry]) => launchesPackage(entry, spec));
  if (matching.length === 0) {
    throw new ExportError(`Aucune entrée de .mcp.json ne lance ${spec.packageName}.`);
  }
  if (requested !== undefined) {
    const found = matching.find(([name]) => name === requested);
    if (!found) {
      throw new ExportError(
        `Aucune entrée « ${requested} » ne lance ${spec.packageName}. Entrées disponibles : ${matching.map(([name]) => name).join(", ")}.`,
      );
    }
    return found;
  }
  if (matching.length > 1) {
    throw new ExportError(
      `${spec.packageName} est déclaré ${matching.length} fois dans .mcp.json (${matching.map(([name]) => name).join(", ")}). Précisez laquelle exporter avec --name <nom>.`,
    );
  }
  return matching[0]!;
}

function readEnv(name: string, entry: McpJsonEntry): Record<string, string> {
  if (entry.env === undefined) return {};
  if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) {
    throw new ExportError(`Le bloc « env » de « ${name} » n'est pas un objet.`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
    if (typeof value !== "string") throw new ExportError(`« ${name} » : la variable ${key} n'est pas une chaîne.`);
    env[key] = value;
  }
  return env;
}

/** Dossier de stockage déclaré : `DATA_DIR`, ou l'un de ses anciens noms. */
function resolveStorage(env: Record<string, string>, spec: ManagerExportSpec, cwd: string, name: string): string {
  const keys = ["DATA_DIR", ...(spec.legacyStorageKeys ?? [])];
  const key = keys.find((candidate) => env[candidate]?.trim());
  if (!key) throw new ExportError(`« ${name} » ne déclare aucun dossier de stockage (${keys.join(", ")}).`);
  const dir = path.resolve(cwd, env[key]!.trim());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new ExportError(`Le dossier de stockage de « ${name} » (${key} = ${dir}) n'existe pas.`);
  }
  return dir;
}

function buildEnv(env: Record<string, string>, spec: ManagerExportSpec) {
  const dropped = new Set([...HUB_MANAGED_KEYS, ...(spec.legacyStorageKeys ?? []), ...(spec.droppedKeys ?? [])]);
  const secrets = new Set(spec.secretKeys ?? []);
  const renamed = spec.renamedKeys ?? {};
  const out = new Map<string, string>();

  for (const [rawKey, value] of Object.entries(env)) {
    const key = renamed[rawKey] ?? rawKey;
    if (dropped.has(rawKey) || dropped.has(key) || value.trim() === "") continue;
    // Le nom actuel l'emporte sur l'ancien quand les deux sont présents.
    if (out.has(key) && key !== rawKey) continue;
    out.set(key, value);
  }
  return [...out].map(([key, value]) => ({ key, value, secret: secrets.has(key) || SECRET_PATTERN.test(key) }));
}

function listFiles(root: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function writeZip(file: string, manifest: object, dataDir: string | null): Promise<number> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), "manifest.json");
  let count = 0;
  if (dataDir) {
    zip.addEmptyDirectory("data/");
    for (const relative of listFiles(dataDir)) {
      zip.addFile(path.join(dataDir, ...relative.split("/")), `data/${relative}`);
      count += 1;
    }
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(file, { mode: 0o600, flags: "wx" });
    output.on("close", () => resolve());
    output.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(output);
  });
  return count;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${(bytes / 1024 ** 2).toFixed(1).replace(".", ",")} Mo`;
}

/**
 * Exécute `--migrate-to-manager` dans `cwd` et renvoie le code de sortie.
 * Options : `--name <nom>`, l'entrée de `.mcp.json` à exporter.
 */
export async function runManagerExport(argv: string[], cwd: string, spec: ManagerExportSpec): Promise<number> {
  let staging: string | null = null;
  let output: string | null = null;
  try {
    const requested = readOption(argv, "--name");
    const [name, entry] = selectEntry(readMcpJson(cwd), spec, requested);
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      throw new ExportError(`« ${name} » n'a pas de commande.`);
    }
    const rawArgs: unknown[] = Array.isArray(entry.args) ? entry.args : [];
    if (rawArgs.some((arg) => typeof arg !== "string")) throw new ExportError(`« ${name} » : un argument n'est pas une chaîne.`);
    const command = currentPackageToken(entry.command, spec);
    const args = (rawArgs as string[]).map((arg) => currentPackageToken(arg, spec));
    const env = readEnv(name, entry);

    output = path.join(cwd, `${name}.mcp-import.zip`);
    if (fs.existsSync(output)) {
      throw new ExportError(`${output} existe déjà. Supprimez-le avant de relancer l'export.`);
    }

    let dataDir: string | null = null;
    if (spec.copyData) {
      const storage = resolveStorage(env, spec, cwd, name);
      staging = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-import-"));
      dataDir = path.join(staging, "data");
      fs.mkdirSync(dataDir);
      await spec.copyData(storage, dataDir);
    }

    const manifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      package: { name: spec.packageName, version: spec.packageVersion },
      mcp: { name, command, args, env: buildEnv(env, spec) },
      data: dataDir !== null,
    };
    const count = await writeZip(output, manifest, dataDir);

    const secrets = manifest.mcp.env.filter((envVar) => envVar.secret).map((envVar) => envVar.key);
    console.log(`Archive écrite : ${output} (${formatSize(fs.statSync(output).size)}).`);
    console.log(dataDir ? `Données : ${count} fichier(s).` : "Ce MCP n'a pas de données : seule sa configuration est exportée.");
    if (secrets.length > 0) {
      console.log(`Elle contient en clair : ${secrets.join(", ")}.`);
    }
    console.log(
      "Importez-la dans le hub (onglet MCP de la gateway, « Importer un MCP »), puis supprimez-la : elle contient la configuration complète du MCP.",
    );
    return 0;
  } catch (err) {
    if (output && !(err instanceof ExportError) && fs.existsSync(output)) fs.rmSync(output, { force: true });
    console.error(`Erreur : ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Copie récursive de `source` vers `target`, sans ce que `skip` écarte (chemin
 * relatif en `/`). Les liens symboliques ne sont pas suivis.
 */
export function copyTree(source: string, target: string, skip: (relative: string, isDirectory: boolean) => boolean = () => false): void {
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || skip(child, entry.isDirectory())) continue;
      const from = path.join(source, ...child.split("/"));
      const to = path.join(target, ...child.split("/"));
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(child);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  };
  walk("");
}
