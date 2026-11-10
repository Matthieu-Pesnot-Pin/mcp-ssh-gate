import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ssh2, { type Connection } from "ssh2";

const { Server, utils } = ssh2;

import type { GateRequest } from "../shared/model.js";
import type { TerminalServerMessage } from "../shared/model.js";
import { Executor } from "../src/core/executor.js";
import { TerminalManager } from "../src/core/terminals.js";
import { RequestStore } from "../src/core/request-store.js";
import { ServerStore } from "../src/core/server-store.js";
import { generateVaultKey, parseVaultKey } from "../src/core/vault.js";

interface FakeSsh {
  port: number;
  close: () => void;
  /** Tailles de terminal demandées : à l'ouverture, puis à chaque redimensionnement. */
  windows: { cols: number; rows: number }[];
}

/**
 * Faux serveur SSH : accepte la clé publique du serveur enregistré, exécute
 * chaque `exec` dans un bash local et sert un `shell` par un bash qui lit son
 * entrée standard.
 */
function startFakeSshServer(authorizedKey: string): Promise<FakeSsh> {
  const windows: { cols: number; rows: number }[] = [];
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const allowed = utils.parseKey(authorizedKey);
  if (allowed instanceof Error) throw allowed;

  const sshServer = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "publickey" && ctx.key.data.equals(allowed.getPublicSSH())) return ctx.accept();
      ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty, _reject, info) => {
          windows.push({ cols: info.cols, rows: info.rows });
          acceptPty();
        });
        session.on("window-change", (acceptChange, _reject, info) => {
          windows.push({ cols: info.cols, rows: info.rows });
          acceptChange?.();
        });
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          const child = spawn("bash", ["-s"], { stdio: "pipe" });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on("close", (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
          stream.on("close", () => child.kill());
        });
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const child = spawn("bash", ["-c", info.command], { stdio: "pipe" });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on("close", (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
          stream.on("close", () => child.kill());
        });
      });
    });
    client.on("error", () => {});
  });

  return new Promise((resolve) => {
    sshServer.listen(0, "127.0.0.1", () => {
      resolve({ port: (sshServer.address() as any).port, close: () => sshServer.close(), windows });
    });
  });
}

async function waitFinal(requests: RequestStore, id: string): Promise<GateRequest> {
  for (let i = 0; i < 200; i++) {
    const request = requests.get(id);
    if (!["pending", "running"].includes(request.status)) return request;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Request ${id} did not finish`);
}

test("approved commands run in a persistent shell and stop at the first failure", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-exec-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-work-"));
  const servers = new ServerStore(dataDir, parseVaultKey(generateVaultKey()));
  const requests = new RequestStore(dataDir);
  const executor = new Executor(servers, requests, () => {});

  const placeholder = servers.create({ name: "local", host: "127.0.0.1", port: 22, username: "tester" });
  const fake = await startFakeSshServer(placeholder.publicKey);
  t.after(() => {
    executor.disconnect("local");
    fake.close();
  });
  servers.update("local", { name: "local", host: "127.0.0.1", port: fake.port, username: "tester" });

  const tested = await executor.testConnection("local");
  assert.match(tested.fingerprint, /^SHA256:/);
  assert.equal(servers.get("local").hostKeyFingerprint, tested.fingerprint);

  const workPath = workDir.replace(/\\/g, "/");
  const batch = requests.create({
    serverId: "local",
    source: "agent",
    sessionId: null,
    explanation: "test",
    commands: [`cd '${workPath}'`, "export GREETING=hello", "echo \"$GREETING from $(basename \"$PWD\")\"; echo oops >&2", "read -r line; echo \"read status $?\"", "false", "echo never"],
  });
  executor.editCommand(batch.id, 4, "exit_code_test() { return 7; }; exit_code_test");
  executor.approve(batch.id, "go ahead");

  const done = await waitFinal(requests, batch.id);
  assert.equal(done.status, "failed");
  assert.equal(done.note, "go ahead");
  assert.deepEqual(
    done.commands.map((c) => c.status),
    ["succeeded", "succeeded", "succeeded", "succeeded", "failed", "skipped"]
  );
  assert.equal(done.commands[2].output, `hello from ${path.basename(workDir)}\noops\n`);
  assert.equal(done.commands[3].output, "read status 1\n");
  assert.equal(done.commands[4].exitCode, 7);
  assert.equal(done.commands[4].original, "false");

  const manual = executor.runManual("local", "echo $GREETING again");
  const manualDone = await waitFinal(requests, manual.id);
  assert.equal(manualDone.status, "completed");
  assert.equal(manualDone.commands[0].output, "hello again\n");

  const broken = requests.create({ serverId: "local", source: "agent", sessionId: null, explanation: "syntax", commands: ["echo 'unclosed", "echo after"] });
  executor.approve(broken.id, null);
  const brokenDone = await waitFinal(requests, broken.id);
  assert.equal(brokenDone.status, "failed");
  assert.match(brokenDone.commands[0].output, /Erreur de syntaxe/);
  assert.equal(brokenDone.commands[1].status, "skipped");

  const refused = requests.create({ serverId: "local", source: "agent", sessionId: null, explanation: "no", commands: ["rm -rf /tmp/x"] });
  assert.equal(executor.refuse(refused.id, "pas maintenant").status, "refused");
  assert.throws(() => executor.approve(refused.id, null), /plus en attente/);
});

test("an interactive terminal streams the shell, replays its output and follows resizes", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-term-"));
  const servers = new ServerStore(dataDir, parseVaultKey(generateVaultKey()));
  const terminals = new TerminalManager(servers, () => {});

  const placeholder = servers.create({ name: "local", host: "127.0.0.1", port: 22, username: "tester" });
  const fake = await startFakeSshServer(placeholder.publicKey);
  t.after(() => fake.close());
  servers.update("local", { name: "local", host: "127.0.0.1", port: fake.port, username: "tester" });

  await assert.rejects(terminals.open("local", 80, 24), /Teste la connexion/);
  const executor = new Executor(servers, new RequestStore(dataDir), () => {});
  await executor.testConnection("local");
  executor.disconnect("local");

  const opened = await terminals.open("local", 100, 30);
  t.after(() => terminals.closeForServer("local"));
  assert.equal(opened.number, 1);
  assert.deepEqual(fake.windows[0], { cols: 100, rows: 30 });
  assert.equal((await terminals.open("local", 80, 24)).number, 2);

  const received: TerminalServerMessage[] = [];
  const detach = terminals.attach(opened.id, (message) => received.push(message));
  terminals.write(opened.id, "echo hello-$((1+2))\n");
  const output = () => received.map((m) => (m.type === "output" ? m.data : "")).join("");
  for (let i = 0; i < 100 && !output().includes("hello-3"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(output(), /hello-3/);
  detach();

  const replayed: TerminalServerMessage[] = [];
  terminals.attach(opened.id, (message) => replayed.push(message))();
  assert.match(replayed[0].type === "output" ? replayed[0].data : "", /hello-3/);

  terminals.resize(opened.id, 120, 40);
  for (let i = 0; i < 100 && fake.windows.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fake.windows.at(-1), { cols: 120, rows: 40 });

  const closedEvents: TerminalServerMessage[] = [];
  terminals.attach(opened.id, (message) => closedEvents.push(message));
  terminals.write(opened.id, "exit\n");
  for (let i = 0; i < 100 && !closedEvents.some((m) => m.type === "closed"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(closedEvents.some((m) => m.type === "closed"));
  assert.equal(terminals.list().find((term) => term.id === opened.id)?.status, "closed");

  terminals.close(opened.id);
  assert.equal(terminals.list().length, 1);
  assert.throws(() => terminals.attach(opened.id, () => {}), /n'existe plus/);
});
