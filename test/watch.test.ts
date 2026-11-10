import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { GateRequest } from "../shared/model.js";
import { RequestStore } from "../src/core/request-store.js";
import { ServerStore } from "../src/core/server-store.js";
import { generateVaultKey, parseVaultKey } from "../src/core/vault.js";
import { FinishedRequestScanner, formatEvent, liveWatcherSince, writeHandoff } from "../src/core/watch.js";
import { callTool, type ToolContext } from "../src/tools/tools.js";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

function finish(store: RequestStore, id: string, update: (draft: GateRequest) => void = () => {}): void {
  store.update(id, (draft) => {
    draft.status = "completed";
    draft.finishedAt = new Date().toISOString();
    for (const command of draft.commands) {
      command.status = "succeeded";
      command.exitCode = 0;
    }
    update(draft);
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function withHome<T>(home: string, fn: () => T): T {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    process.env.HOME = previous.HOME;
    process.env.USERPROFILE = previous.USERPROFILE;
  }
}

function startWatcher(home: string, session: string): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, [entry, "--watch", session], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout!.on("data", (chunk) => (stdout += chunk.toString("utf8")));
  return { child, output: () => stdout };
}

test("the local watcher announces each finished request of its session once, and resumes after a restart", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-watch-"));
  withHome(home, () => writeHandoff("ses_mine", dataDir));

  const store = new RequestStore(dataDir);
  const mine = store.create({ serverId: "web", source: "agent", sessionId: "ses_mine", explanation: "x", commands: ["ls", "pwd"] });
  const other = store.create({ serverId: "web", source: "agent", sessionId: "ses_other", explanation: "y", commands: ["id"] });

  const first = startWatcher(home, "ses_mine");
  t.after(() => first.child.kill());
  await waitFor(() => liveWatcherSince(dataDir, "ses_mine") !== null, "the watcher heartbeat");
  finish(store, other.id);
  finish(store, mine.id);
  await waitFor(() => first.output().includes(mine.id), "the first notification");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(first.output().trim().split("\n"), [
    `[ssh-gate] web — request ${mine.id} completed: 2/2 command(s) succeeded — read it with wait_for_result, request_id ${mine.id}`,
  ]);
  first.child.kill();

  const late = store.create({ serverId: "web", source: "agent", sessionId: "ses_mine", explanation: "z", commands: ["uptime"] });
  finish(store, late.id);

  const second = startWatcher(home, "ses_mine");
  t.after(() => second.child.kill());
  await waitFor(() => second.output().includes(late.id), "the notification of the request finished between watchers");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(second.output().trim().split("\n").length, 1);
});

test("behind the gateway: enable_notifications returns a watch specification and the wait tool returns events", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-gw-"));
  const requests = new RequestStore(dataDir);
  const ctx: ToolContext = {
    servers: new ServerStore(dataDir, parseVaultKey(generateVaultKey())),
    requests,
    ensureGui: () => {},
    guiUrl: () => null,
    reconnectGui: async () => ({ content: [] }),
    sessionId: "ses_gw",
    dataDir,
    watchCommand: "",
    finished: new FinishedRequestScanner(requests, "ses_gw"),
  };

  const enabled = await callTool(ctx, "enable_notifications", { _gateway_watch: { version: 1 } });
  const spec = enabled._meta?.["gateway/watch"] as { tool: string; arguments: object; cursor: string; description: string };
  assert.equal(spec.tool, "wait_for_notifications");
  assert.deepEqual(spec.arguments, {});
  assert.match(spec.cursor, /^\d+$/);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const mine = requests.create({ serverId: "db", source: "agent", sessionId: "ses_gw", explanation: "", commands: ["a", "b"] });
  const typed = requests.create({ serverId: "db", source: "user", sessionId: null, explanation: "", commands: ["c"] });
  finish(requests, typed.id);
  finish(requests, mine.id, (draft) => {
    draft.status = "failed";
    draft.commands[1].status = "failed";
    draft.commands[1].exitCode = 2;
  });

  const first = await callTool(ctx, "wait_for_notifications", { cursor: spec.cursor, timeout_seconds: 5 });
  const events = first._meta?.["gateway/events"] as { cursor: string; lines: string[] };
  assert.deepEqual(events.lines, [
    `[ssh-gate] db — request ${mine.id} failed at command 2/2 (exit 2) — read it with wait_for_result, request_id ${mine.id}`,
  ]);
  assert.ok(Number(events.cursor) > Number(spec.cursor));

  const second = await callTool(ctx, "wait_for_notifications", { cursor: events.cursor, timeout_seconds: 1 });
  assert.deepEqual((second._meta?.["gateway/events"] as { lines: string[] }).lines, []);
});

test("event lines describe refusals", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-event-"));
  const store = new RequestStore(dataDir);
  const request = store.create({ serverId: "db", source: "agent", sessionId: "s", explanation: "", commands: ["rm x"] });
  store.update(request.id, (d) => {
    d.status = "refused";
    d.note = "pas en prod\naujourd'hui";
    d.finishedAt = new Date().toISOString();
  });
  const [refused] = new FinishedRequestScanner(store, "s").since(0);
  assert.match(formatEvent(refused), /request \S+ refused by the user: pas en prod aujourd'hui —/);
});
