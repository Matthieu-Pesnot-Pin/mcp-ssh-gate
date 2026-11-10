#!/usr/bin/env node
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GuiLauncher, createLogger, setupLogging } from "@imenam/mcp-gui-interface";

import { APP_VERSION } from "./version.js";
import { assertGuiConfigured, findProjectRoot, loadConfig, type GateConfig } from "./core/config.js";
import { liveGuiUrl } from "./core/heartbeat.js";
import { RequestStore } from "./core/request-store.js";
import { ServerStore } from "./core/server-store.js";
import { generateVaultKey } from "./core/vault.js";
import { TOOL_DEFINITIONS, callTool, type ToolContext } from "./tools/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

if (argv.includes("--generate-vault-key")) {
  console.log(generateVaultKey());
  process.exit(0);
}

if (argv.includes("--claude-setup-mcp")) {
  const { runSetupMcp, parseGuiExposure } = await import("./cli/setup-mcp.js");
  const parsed = parseGuiExposure(argv);
  if ("error" in parsed) {
    console.error(`Erreur : ${parsed.error}`);
    process.exit(1);
  }
  process.exit(runSetupMcp({ cwd: process.cwd(), force: argv.includes("--force"), exposure: parsed.exposure }));
}

const rootDir = findProjectRoot(__dirname);
const packageEnvPath = path.join(rootDir, ".env");
if (fs.existsSync(packageEnvPath)) dotenv.config({ path: packageEnvPath, override: true, quiet: true });

let config: GateConfig;
try {
  config = loadConfig();
  assertGuiConfigured();
} catch (err: any) {
  process.stderr.write(`[mcp-ssh-gate] ${err.message}\n`);
  process.exit(1);
}

setupLogging({ processLabel: "mcp-ssh-gate", logDir: config.logDir });
const logger = createLogger("mcp-ssh-gate");

const servers = new ServerStore(config.dataDir, config.vaultKey);
const requests = new RequestStore(config.dataDir);

try {
  servers.verifyVault();
} catch (err: any) {
  logger.error(err.message);
  process.stderr.write(`[mcp-ssh-gate] ${err.message}\n`);
  process.exit(1);
}

// --- Worker de l'interface ---------------------------------------------------

type GuiStatus = "starting" | "ready" | "already_running" | "stopped";
let guiStatus: GuiStatus = "stopped";
let ownGuiUrl: string | null = null;
let guiStartWaiter: (() => void) | null = null;

function handleIpcMessage(msg: any) {
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "READY":
      guiStatus = "ready";
      ownGuiUrl = msg.data?.url ?? ownGuiUrl;
      logger.info(`GUI ready at ${ownGuiUrl}`);
      guiStartWaiter?.();
      return;
    case "ALREADY_RUNNING":
      guiStatus = "already_running";
      guiStartWaiter?.();
      return;
    default:
      logger.debug(`Unhandled IPC message type: ${msg.type}`);
  }
}

const guiLauncher = new GuiLauncher({
  guiPath: path.join(__dirname, "gui-worker.js"),
  env: { ...process.env } as Record<string, string>,
  maxRestarts: 0,
  onMessage: handleIpcMessage,
});

function startGuiWorker() {
  guiStatus = "starting";
  const child = guiLauncher.start();
  child.on("exit", () => {
    if (guiLauncher.getProcess() === child && guiStatus !== "already_running") guiStatus = "stopped";
  });
}

/**
 * Un seul worker sert l'interface et exécute les commandes pour toutes les
 * sessions d'agent. Il en démarre un quand aucun n'a donné signe de vie.
 */
function ensureGui() {
  if (guiStatus === "starting") return;
  if (guiStatus === "ready" && guiLauncher.getProcess()?.connected) return;
  if (liveGuiUrl(config.dataDir)) return;
  logger.info("No live GUI worker — starting one.");
  startGuiWorker();
}

function guiUrl(): string | null {
  return liveGuiUrl(config.dataDir) ?? ownGuiUrl;
}

async function reconnectGui(): Promise<CallToolResult> {
  ensureGui();
  if (guiStatus === "starting") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      guiStartWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    guiStartWaiter = null;
  }
  const url = guiUrl();
  if (!url) {
    return { content: [{ type: "text", text: "Error: the GUI did not start. Check the logs in " + config.logDir }], isError: true };
  }
  return { content: [{ type: "text", text: `GUI running at ${url}` }] };
}

// --- Serveur MCP ---------------------------------------------------------------

const toolContext: ToolContext = { servers, requests, ensureGui, guiUrl, reconnectGui };

const server = new Server({ name: "mcp-ssh-gate", version: APP_VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  return callTool(toolContext, request.params.name, request.params.arguments, extra.signal);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`MCP server running on stdio (data dir: ${config.dataDir})`);
  ensureGui();
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  logger.error(err.stack || "No stack trace");
  guiLauncher.getProcess()?.kill("SIGTERM");
  process.exit(1);
});
