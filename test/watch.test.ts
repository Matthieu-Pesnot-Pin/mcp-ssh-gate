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
import { SessionStore } from "../src/core/session-store.js";
import { generateVaultKey, parseVaultKey } from "../src/core/vault.js";
import { RequestEventScanner, formatEvent, liveWatcherSince, writeHandoff } from "../src/core/watch.js";
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

function startWatcher(home: string, agent: string): { child: ChildProcess; output: () => string; exited: () => boolean } {
  const child = spawn(process.execPath, [entry, "--watch", agent], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let exited = false;
  child.stdout!.on("data", (chunk) => (stdout += chunk.toString("utf8")));
  child.on("exit", () => (exited = true));
  return { child, output: () => stdout, exited: () => exited };
}

function toolContext(dataDir: string): ToolContext {
  const requests = new RequestStore(dataDir);
  const sessions = new SessionStore(dataDir);
  return {
    servers: new ServerStore(dataDir, parseVaultKey(generateVaultKey())),
    requests,
    sessions,
    ensureGui: () => {},
    guiUrl: () => null,
    reconnectGui: async () => ({ content: [] }),
    dataDir,
    watchCommand: (id) => `watch ${id}`,
    events: (id) => new RequestEventScanner(requests, sessions, id),
  };
}

const lines = (output: string) => output.trim().split("\n");

test("one local watcher per agent announces the events of all its sessions, even those opened after it started, resumes after a restart and outlives a closed session", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-watch-"));
  const sessions = new SessionStore(dataDir);
  const agent = sessions.createAgent();
  const stranger = sessions.createAgent();
  const deploy = sessions.open("web", "deploy", agent.id);
  const foreign = sessions.open("web", "logs", stranger.id);
  withHome(home, () => writeHandoff(agent.id, dataDir));

  const store = new RequestStore(dataDir);
  const mine = store.create({ serverId: "web", source: "agent", sessionId: deploy.id, explanation: "x", commands: ["ls", "pwd"] });
  const other = store.create({ serverId: "web", source: "agent", sessionId: foreign.id, explanation: "y", commands: ["id"] });

  const first = startWatcher(home, agent.id);
  t.after(() => first.child.kill());
  await waitFor(() => liveWatcherSince(dataDir, agent.id) !== null, "the watcher heartbeat");
  finish(store, other.id);
  finish(store, mine.id);
  const migration = sessions.open("db", "migration", agent.id);
  const later = store.create({ serverId: "db", source: "agent", sessionId: migration.id, explanation: "z", commands: ["psql -c 'select 1'"] });
  finish(store, later.id);
  await waitFor(() => first.output().includes(later.id), "the notification of the session opened later");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(lines(first.output()), [
    `[ssh-gate] web · session ${deploy.id} — request ${mine.id} completed: 2/2 command(s) succeeded — read it with get_result, request_id ${mine.id}`,
    `[ssh-gate] db · session ${migration.id} — request ${later.id} completed: 1/1 command(s) succeeded — read it with get_result, request_id ${later.id}`,
  ]);
  first.child.kill();

  const late = store.create({ serverId: "web", source: "agent", sessionId: deploy.id, explanation: "z", commands: ["uptime"] });
  finish(store, late.id);

  const second = startWatcher(home, agent.id);
  t.after(() => second.child.kill());
  await waitFor(() => second.output().includes(late.id), "the notification of the request finished between watchers");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(lines(second.output()).length, 1);

  sessions.close(deploy.id, "user", store);
  await waitFor(() => lines(second.output()).length === 2, "the closing notification");
  assert.match(lines(second.output())[1], new RegExp(`^\\[ssh-gate\\] web · session ${deploy.id} — the user closed your session "deploy"`));

  const after = store.create({ serverId: "db", source: "agent", sessionId: migration.id, explanation: "w", commands: ["true"] });
  finish(store, after.id);
  await waitFor(() => second.output().includes(after.id), "a notification after the close");
  assert.equal(second.exited(), false);
});

test("behind the gateway: enable_notifications returns a watch specification for the agent and the wait tool returns the events of all its sessions", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-gw-"));
  const ctx = toolContext(dataDir);
  const { requests } = ctx;
  const agent = ctx.sessions.createAgent();
  const db = ctx.sessions.open("db", "migration", agent.id);
  const web = ctx.sessions.open("web", "deploy", agent.id);

  const refused = await callTool(ctx, "enable_notifications", { _gateway_watch: { version: 1 } });
  assert.equal(refused.isError, true);

  const enabled = await callTool(ctx, "enable_notifications", { agent_id: agent.id, _gateway_watch: { version: 1 } });
  const spec = enabled._meta?.["gateway/watch"] as { tool: string; arguments: object; cursor: string; description: string };
  assert.equal(spec.tool, "wait_for_notifications");
  assert.deepEqual(spec.arguments, { agent_id: agent.id });
  assert.match(spec.cursor, /^\d+$/);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const mine = requests.create({ serverId: "db", source: "agent", sessionId: db.id, explanation: "", commands: ["a", "b"] });
  const typed = requests.create({ serverId: "db", source: "user", sessionId: null, explanation: "", commands: ["c"] });
  finish(requests, typed.id, (draft) => {
    draft.sharedAt = new Date().toISOString();
  });
  finish(requests, mine.id, (draft) => {
    draft.status = "failed";
    draft.commands[1].status = "failed";
    draft.commands[1].exitCode = 2;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const deploy = requests.create({ serverId: "web", source: "agent", sessionId: web.id, explanation: "", commands: ["d"] });
  finish(requests, deploy.id);

  const first = await callTool(ctx, "wait_for_notifications", { agent_id: agent.id, cursor: spec.cursor, timeout_seconds: 5 });
  const events = first._meta?.["gateway/events"] as { cursor: string; lines: string[] };
  assert.deepEqual(events.lines, [
    `[ssh-gate] db · session ${db.id} — request ${mine.id} failed at command 2/2 (exit 2) — read it with get_result, request_id ${mine.id}`,
    `[ssh-gate] web · session ${web.id} — request ${deploy.id} completed: 1/1 command(s) succeeded — read it with get_result, request_id ${deploy.id}`,
  ]);
  assert.ok(Number(events.cursor) > Number(spec.cursor));

  const second = await callTool(ctx, "wait_for_notifications", { agent_id: agent.id, cursor: events.cursor, timeout_seconds: 1 });
  assert.deepEqual((second._meta?.["gateway/events"] as { lines: string[] }).lines, []);
});

test("a command the user typed in an agent session reaches that agent alone, once shared", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-share-"));
  const store = new RequestStore(dataDir);
  const sessions = new SessionStore(dataDir);
  const agent = sessions.createAgent();
  const stranger = sessions.createAgent();
  const own = sessions.open("web", "disk", agent.id);
  sessions.open("web", "logs", stranger.id);
  const typed = store.create({ serverId: "web", source: "user", sessionId: own.id, explanation: "", commands: ["df -h"] });
  finish(store, typed.id);
  const scanner = new RequestEventScanner(store, sessions, agent.id);
  assert.deepEqual(scanner.since(0), []);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const cursor = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.update(typed.id, (draft) => {
    draft.sharedAt = new Date().toISOString();
  });
  const [shared] = scanner.since(cursor);
  assert.equal(
    formatEvent(shared),
    `[ssh-gate] web · session ${own.id} — the user shared 1 command(s) they ran themselves in this session (request ${typed.id}), completed: 1/1 command(s) succeeded — read it with get_result, request_id ${typed.id}`
  );
  assert.deepEqual(new RequestEventScanner(store, sessions, stranger.id).since(cursor), []);
  assert.deepEqual(scanner.since(shared.eventMs), []);
});

test("event lines describe refusals", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-event-"));
  const store = new RequestStore(dataDir);
  const sessions = new SessionStore(dataDir);
  const agent = sessions.createAgent();
  const session = sessions.open("db", "cleanup", agent.id);
  const request = store.create({ serverId: "db", source: "agent", sessionId: session.id, explanation: "", commands: ["rm x"] });
  store.update(request.id, (d) => {
    d.status = "refused";
    d.note = "pas en prod\naujourd'hui";
    d.finishedAt = new Date().toISOString();
  });
  const [refused] = new RequestEventScanner(store, sessions, agent.id).since(0);
  assert.match(formatEvent(refused), /request \S+ refused by the user: pas en prod aujourd'hui —/);
});

test("sessions: the first open_session creates the agent id, later ones reuse it, and close_session withdraws pending requests silently", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-sessions-"));
  const ctx = toolContext(dataDir);
  ctx.servers.create({ name: "web", host: "10.0.0.1", port: 22, username: "deploy" });
  ctx.servers.create({ name: "db", host: "10.0.0.2", port: 22, username: "deploy" });
  const read = async (name: string, args: unknown) => ((await callTool(ctx, name, args)).content[0] as { text: string }).text;

  assert.match(await read("open_session", { server: "web", name: "deploy" }), /has never been tested/);
  ctx.servers.setFingerprint("web", "SHA256:abc");
  ctx.servers.setFingerprint("db", "SHA256:def");
  const opened = await read("open_session", { server: "web", name: "  deploy   shop " });
  const id = /Session (sh_[0-9a-f]{8}) opened on web as "deploy shop"/.exec(opened)?.[1];
  const agentId = /Your agent id is (ag_[0-9a-f]{8})\./.exec(opened)?.[1];
  assert.ok(id && agentId, opened);
  assert.match(await read("list_servers", {}), new RegExp(`Open agent sessions: ${id} "deploy shop"`));

  assert.match(await read("open_session", { server: "db", name: "x", agent_id: "ag_00000000" }), /Unknown agent id/);
  const second = await read("open_session", { server: "db", name: "migration", agent_id: agentId });
  assert.match(second, new RegExp(`tied to your agent id ${agentId}: the watcher you armed`));
  const secondId = /Session (sh_[0-9a-f]{8})/.exec(second)![1];
  assert.deepEqual(ctx.sessions.listForAgent(agentId!).map((s) => s.id).sort(), [id, secondId].sort());

  assert.match(await read("enable_notifications", {}), /agent_id/);
  assert.match(await read("enable_notifications", { agent_id: agentId }), new RegExp(`Notifications enabled for agent ${agentId}[\\s\\S]*command:     watch ${agentId}`));

  assert.match(await read("submit_commands", { session_id: "sh_00000000", commands: ["ls"], explanation: "x" }), /Unknown session/);
  assert.match(await read("submit_commands", { session_id: id, commands: ["ls"], explanation: "list" }), /submitted to session sh_[0-9a-f]{8} on web/);
  const [pending] = ctx.requests.listOpen();
  assert.equal(pending.sessionId, id);

  ctx.requests.update(pending.id, (draft) => {
    draft.status = "running";
  });
  assert.match(await read("close_session", { session_id: id }), /is running/);
  ctx.requests.update(pending.id, (draft) => {
    draft.status = "pending";
  });

  assert.match(await read("close_session", { session_id: id }), /closed\. Your watcher keeps running for your other sessions/);
  assert.equal(ctx.requests.get(pending.id).status, "cancelled");
  assert.deepEqual(ctx.events(agentId!).since(0), []);
  assert.match(await read("submit_commands", { session_id: id, commands: ["ls"], explanation: "again" }), /was closed by an agent/);
  assert.match(await read("list_servers", {}), new RegExp(`Open agent sessions: ${secondId} "migration"`));
});

test("questions: announced to the agent of the request, answered once with answer_question, then silent", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-question-"));
  const ctx = toolContext(dataDir);
  const { requests } = ctx;
  const agent = ctx.sessions.createAgent();
  const stranger = ctx.sessions.createAgent();
  const session = ctx.sessions.open("web", "disk", agent.id);
  ctx.sessions.open("web", "logs", stranger.id);
  const request = requests.create({ serverId: "web", source: "agent", sessionId: session.id, explanation: "", commands: ["hostname; df -h /"] });
  requests.update(request.id, (draft) => {
    draft.questions.push({ id: "q_1", commandIndex: 0, statement: "df -h /", askedAt: new Date().toISOString(), answer: null, answeredAt: null });
  });

  const [asked] = ctx.events(agent.id).since(0);
  assert.equal(
    formatEvent(asked),
    `[ssh-gate] web · session ${session.id} — the user asks you to explain part of command 1/1 of request ${request.id}: df -h / — answer with answer_question, request_id ${request.id}, question_id q_1`
  );
  assert.deepEqual(ctx.events(stranger.id).since(0), []);

  const answered = await callTool(ctx, "answer_question", { request_id: request.id, question_id: "q_1", answer: "Affiche l'espace disque de la racine." });
  assert.equal(answered.isError, undefined);
  assert.equal(requests.get(request.id).questions[0].answer, "Affiche l'espace disque de la racine.");
  assert.deepEqual(ctx.events(agent.id).since(0), []);

  const again = await callTool(ctx, "answer_question", { request_id: request.id, question_id: "q_1", answer: "Encore." });
  assert.equal(again.isError, true);
  assert.match((again.content[0] as { text: string }).text, /already been answered/);
});

test("a request saved before questions existed reads with an empty question list", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-legacy-"));
  const store = new RequestStore(dataDir);
  const request = store.create({ serverId: "web", source: "user", sessionId: null, explanation: "", commands: ["uptime"] });
  const file = path.join(dataDir, "requests", "web", `${request.id}.json`);
  const { questions: _questions, ...legacy } = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.deepEqual(store.get(request.id).questions, []);
});
