import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { GUI_LISTEN_HOST, ProxyClient, createLogger, honoGuiGuard, setupLogging } from "@imenam/mcp-gui-interface";

import type { RequestsResponse, StateResponse } from "../shared/model.js";
import { APP_VERSION } from "./version.js";
import { findProjectRoot, loadConfig } from "./core/config.js";
import { GateError } from "./core/errors.js";
import { Executor } from "./core/executor.js";
import { HEARTBEAT_INTERVAL_MS, writeHeartbeat } from "./core/heartbeat.js";
import { RequestStore } from "./core/request-store.js";
import { ServerStore, type ServerInput } from "./core/server-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = findProjectRoot(__dirname);
const staticRoot = path.resolve(rootDir, "gui/dist");
const configuredAppPath = process.env.APP_PATH || "/ssh-gate";
let effectiveAppPath = configuredAppPath;

const config = loadConfig();
setupLogging({ processLabel: "mcp-ssh-gate:GUI", logDir: config.logDir });
const logger = createLogger("mcp-ssh-gate:GUI");

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  logger.error(err.stack || "No stack trace");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
  process.exit(1);
});

const servers = new ServerStore(config.dataDir, config.vaultKey);
const requests = new RequestStore(config.dataDir);
const executor = new Executor(servers, requests, (message) => logger.info(message));

// Le worker s'arrête avec le processus MCP qui l'a lancé : canal IPC fermé, ou PID parent disparu.
const parentPid = process.ppid;
const parentCheck = setInterval(() => {
  let parentAlive = process.connected;
  if (parentAlive) {
    try {
      process.kill(parentPid, 0);
    } catch {
      parentAlive = false;
    }
  }
  if (!parentAlive) {
    logger.info("MCP master is gone. Exiting.");
    clearInterval(parentCheck);
    process.exit(0);
  }
}, 2000);

function safeSend(message: Record<string, unknown>): void {
  if (!process.send || !process.connected) return;
  try {
    process.send({ ...message, timestamp: new Date().toISOString() });
  } catch (err: any) {
    logger.error(`[IPC] Failed to send message: ${err.message}`);
  }
}

process.on("message", (msg: any) => {
  if (msg?.type === "GET_HEALTH") {
    safeSend({ type: "HEALTH_RESPONSE", correlationId: msg.correlationId, data: { status: "ok", uptime: process.uptime() } });
  }
});
process.on("disconnect", () => {
  logger.warn("IPC disconnected from MCP master. Exiting.");
  process.exit(0);
});

// --- API -----------------------------------------------------------------------

const app = new Hono();
app.use("*", honoGuiGuard());

async function readBody(c: Context): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    throw new GateError("Corps de requête JSON invalide.");
  }
}

function handle(fn: (c: Context) => unknown | Promise<unknown>) {
  return async (c: Context) => {
    try {
      return c.json((await fn(c)) as object);
    } catch (err: any) {
      if (err instanceof GateError) return c.json({ error: err.message }, 400);
      logger.error(`${c.req.method} ${c.req.path}: ${err?.stack ?? err}`);
      return c.json({ error: err?.message ?? String(err) }, 500);
    }
  };
}

function serverInput(body: any): ServerInput {
  return { name: body?.name, host: body?.host, port: Number(body?.port), username: body?.username };
}

function commandIndex(c: Context): number {
  const index = Number(c.req.param("index"));
  if (!Number.isInteger(index) || index < 0) throw new GateError("Index de commande invalide.");
  return index;
}

app.get(
  "/api/state",
  handle((): StateResponse => ({ version: APP_VERSION, servers: executor.views() }))
);

app.get(
  "/api/servers/:id/requests",
  handle((c): RequestsResponse => {
    const server = servers.get(c.req.param("id")!);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return { requests: requests.listForServer(server.id, limit) };
  })
);

app.post("/api/servers", handle(async (c) => executor.addServer(serverInput(await readBody(c)))));
app.put("/api/servers/:id", handle(async (c) => executor.updateServer(c.req.param("id")!, serverInput(await readBody(c)))));
app.delete(
  "/api/servers/:id",
  handle((c) => {
    executor.deleteServer(c.req.param("id")!);
    return { deleted: true };
  })
);
app.post("/api/servers/:id/test", handle((c) => executor.testConnection(c.req.param("id")!)));
app.post(
  "/api/servers/:id/disconnect",
  handle((c) => {
    const server = servers.get(c.req.param("id")!);
    executor.disconnect(server.id);
    return executor.view(servers.get(server.id));
  })
);
app.put(
  "/api/servers/:id/notes",
  handle(async (c) => {
    const body = await readBody(c);
    const server = servers.get(c.req.param("id")!);
    const expected = body?.expectedUpdatedAt === undefined ? null : body.expectedUpdatedAt;
    return executor.view(servers.setNotes(server.id, body?.notes, "user", expected));
  })
);
app.post("/api/servers/:id/manual", handle(async (c) => executor.runManual(c.req.param("id")!, (await readBody(c))?.command)));

app.put("/api/requests/:id/commands/:index", handle(async (c) => executor.editCommand(c.req.param("id")!, commandIndex(c), (await readBody(c))?.command)));
app.delete("/api/requests/:id/commands/:index", handle((c) => executor.removeCommand(c.req.param("id")!, commandIndex(c))));
app.post("/api/requests/:id/approve", handle(async (c) => executor.approve(c.req.param("id")!, (await readBody(c))?.note)));
app.post("/api/requests/:id/refuse", handle(async (c) => executor.refuse(c.req.param("id")!, (await readBody(c))?.note)));
app.post(
  "/api/requests/:id/interrupt",
  handle(async (c) => {
    await executor.interrupt(c.req.param("id")!);
    return { interrupted: true };
  })
);

app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), staticRoot) }));

function baseHref(appPath: string): string {
  const normalized = appPath.startsWith("/") ? appPath : `/${appPath}`;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

let standalone = false;

app.get("/*", (c, next) => {
  if (c.req.path.startsWith("/api") || c.req.path.startsWith("/assets")) return next();
  const indexPath = path.join(staticRoot, "index.html");
  if (!fs.existsSync(indexPath)) return c.text(`GUI build not found at ${staticRoot}`, 404);
  const href = standalone || c.req.query("__direct") === "1" ? "/" : baseHref(effectiveAppPath);
  return c.html(fs.readFileSync(indexPath, "utf8").replace("<head>", `<head>\n    <base href="${href}" />`));
});

// --- Démarrage -----------------------------------------------------------------

function listen(port: number, publicUrl: string) {
  const instance = serve({ fetch: app.fetch, port, hostname: GUI_LISTEN_HOST }, (info) => {
    logger.info(`GUI listening on port ${info.port}`);
    executor.recoverAbandoned();
    writeHeartbeat(config.dataDir, publicUrl);
    setInterval(() => writeHeartbeat(config.dataDir, publicUrl), HEARTBEAT_INTERVAL_MS);
    safeSend({ type: "READY", data: { port: info.port, url: publicUrl } });
  });

  instance.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      logger.info(`Port ${port} already in use — another GUI worker is running.`);
      safeSend({ type: "ALREADY_RUNNING", data: { url: publicUrl } });
      process.exit(0);
    }
    logger.error(`Server error: ${err.message}`);
    process.exit(1);
  });
}

async function start() {
  const proxyUrl = process.env.PROXY_URL?.trim();

  if (!proxyUrl) {
    const port = Number(process.env.APP_PORT?.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      logger.error(`APP_PORT is invalid (${process.env.APP_PORT}): expected an integer between 1 and 65535.`);
      process.exit(1);
    }
    standalone = true;
    listen(port, `http://localhost:${port}`);
    return;
  }

  const proxyClient = new ProxyClient(proxyUrl);
  const result = await proxyClient.register({
    path: configuredAppPath,
    name: process.env.APP_NAME || "SSH Gate",
    group: process.env.APP_GROUP,
  });

  if (result.error === "HTTP 409") {
    logger.info("Another GUI worker is already registered with the proxy.");
    safeSend({ type: "ALREADY_RUNNING", data: { url: `${proxyUrl}${configuredAppPath}` } });
    process.exit(0);
  }
  if (!result.success) {
    logger.error(`Proxy registration failed: ${result.error}`);
    process.exit(1);
  }

  effectiveAppPath = result.path ?? configuredAppPath;
  const publicUrl = result.url || `${proxyUrl}${effectiveAppPath}`;
  const cleanup = async () => {
    await proxyClient.unregister();
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  listen(result.port!, publicUrl);
}

start().catch((err: any) => {
  logger.error(`Failed to start the GUI worker: ${err.message}`);
  process.exit(1);
});
