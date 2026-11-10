import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ssh2, { type Connection } from "ssh2";

const { Server, utils } = ssh2;

import type { GateRequest } from "../shared/model.js";
import { Executor } from "../src/core/executor.js";
import { RequestStore } from "../src/core/request-store.js";
import { ServerStore } from "../src/core/server-store.js";
import { generateVaultKey, parseVaultKey } from "../src/core/vault.js";

/**
 * Faux serveur SSH : accepte la clé publique du serveur enregistré et exécute
 * chaque `exec` dans un bash local.
 */
function startFakeSshServer(authorizedKey: string): Promise<{ port: number; close: () => void }> {
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
      resolve({ port: (sshServer.address() as any).port, close: () => sshServer.close() });
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

  const broken = requests.create({ serverId: "local", source: "agent", explanation: "syntax", commands: ["echo 'unclosed", "echo after"] });
  executor.approve(broken.id, null);
  const brokenDone = await waitFinal(requests, broken.id);
  assert.equal(brokenDone.status, "failed");
  assert.match(brokenDone.commands[0].output, /Erreur de syntaxe/);
  assert.equal(brokenDone.commands[1].status, "skipped");

  const refused = requests.create({ serverId: "local", source: "agent", explanation: "no", commands: ["rm -rf /tmp/x"] });
  assert.equal(executor.refuse(refused.id, "pas maintenant").status, "refused");
  assert.throws(() => executor.approve(refused.id, null), /plus en attente/);
});
