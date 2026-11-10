import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decryptSecret, encryptSecret, generateVaultKey, parseVaultKey } from "../src/core/vault.js";
import { CommandOutputParser } from "../src/core/ssh-session.js";
import { RequestStore } from "../src/core/request-store.js";
import { ServerStore } from "../src/core/server-store.js";
import { formatRequest } from "../src/tools/format.js";
import { runSetupMcp } from "../src/cli/setup-mcp.js";
import { callTool } from "../src/tools/tools.js";
import { FinishedRequestScanner } from "../src/core/watch.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-test-"));
}

test("vault round-trips a secret and rejects another key", () => {
  const key = parseVaultKey(generateVaultKey());
  const payload = encryptSecret("private key", key);
  assert.equal(decryptSecret(payload, key), "private key");
  assert.throws(() => decryptSecret(payload, parseVaultKey(generateVaultKey())), /does not decrypt/);
});

test("vault refuses a missing or malformed VAULT_KEY", () => {
  assert.throws(() => parseVaultKey(undefined), /VAULT_KEY is not set/);
  assert.throws(() => parseVaultKey("abc"), /not a valid key/);
});

test("output parser streams output and reads exit code and cwd across chunks", () => {
  let output = "";
  const parser = new CommandOutputParser("tok", (text) => (output += text));
  const stream = "line 1\nline 2\n\n__SSHGATE_END_tok_3_/var/www__\n";
  let result = null;
  for (const char of stream) result = parser.push(char) ?? result;
  assert.deepEqual(result, { exitCode: 3, cwd: "/var/www" });
  assert.equal(output, "line 1\nline 2\n");
});

test("server store keeps the private key encrypted and verifies the vault", () => {
  const dir = tempDir();
  const key = parseVaultKey(generateVaultKey());
  const store = new ServerStore(dir, key);
  const server = store.create({ name: "Prod Web", host: "10.0.0.12", port: 22, username: "deploy" });

  assert.equal(server.id, "prod-web");
  assert.match(server.publicKey, /^ssh-ed25519 /);
  assert.ok(!fs.readFileSync(path.join(dir, "servers.json"), "utf8").includes("OPENSSH PRIVATE KEY"));
  assert.match(store.privateKey("prod-web"), /OPENSSH PRIVATE KEY/);
  assert.equal(store.get("PROD WEB").id, "prod-web");

  store.setFingerprint("prod-web", "SHA256:abc");
  assert.equal(store.update("prod-web", { name: "Prod Web", host: "10.0.0.13", port: 22, username: "deploy" }).hostKeyFingerprint, null);

  assert.throws(() => new ServerStore(dir, parseVaultKey(generateVaultKey())).verifyVault(), /does not decrypt the private key of server "Prod Web"/);
});

test("server notes: the agent appends or replaces, a stale user edit is refused", async () => {
  const dir = tempDir();
  const servers = new ServerStore(dir, parseVaultKey(generateVaultKey()));
  const requests = new RequestStore(dir);
  servers.create({ name: "web", host: "10.0.0.1", port: 22, username: "deploy" });
  const ctx = { servers, requests, ensureGui: () => {}, guiUrl: () => null, reconnectGui: async () => ({ content: [] }), sessionId: "ses_test", dataDir: dir, watchCommand: "", finished: new FinishedRequestScanner(requests, "ses_test") };
  const read = async (name: string, args: unknown = {}) => ((await callTool(ctx, name, args)).content[0] as { text: string }).text;

  assert.match(await read("list_servers"), /Notes: none yet/);
  await read("update_server_notes", { server: "web", notes: "Sites in /var/www" });
  await read("update_server_notes", { server: "web", notes: "Apps run with PM2" });
  assert.equal(servers.get("web").notes, "Sites in /var/www\nApps run with PM2");
  assert.equal(servers.get("web").notesUpdatedBy, "agent");
  assert.match(await read("list_servers"), /last updated by an agent[\s\S]*Sites in \/var\/www\n {4}Apps run with PM2/);

  const seen = servers.get("web").notesUpdatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await read("update_server_notes", { server: "web", notes: "Only this", mode: "replace" });
  assert.throws(() => servers.setNotes("web", "user text", "user", seen), /modifiées par l'agent/);
  assert.equal(servers.setNotes("web", "user text", "user", servers.get("web").notesUpdatedAt).notes, "user text");
});

test("request store lists the latest requests of a server in creation order", () => {
  const store = new RequestStore(tempDir());
  const first = store.create({ serverId: "a", source: "agent", sessionId: null, explanation: "x", commands: ["ls"] });
  const second = store.create({ serverId: "a", source: "agent", sessionId: null, explanation: "y", commands: ["pwd", "whoami"] });
  store.create({ serverId: "b", source: "agent", sessionId: null, explanation: "z", commands: ["id"] });

  assert.deepEqual(store.listForServer("a").map((r) => r.id), [first.id, second.id]);
  assert.deepEqual(store.listForServer("a", 1).map((r) => r.id), [second.id]);
  assert.equal(store.listOpen().length, 3);
  assert.throws(() => store.create({ serverId: "a", source: "agent", sessionId: null, explanation: "", commands: ["  "] }), /Command 1 is empty/);
  assert.throws(() => store.get("nope"), /Invalid request id/);
});

test("formatted result shows edits, refusal reason and skipped commands", () => {
  const store = new RequestStore(tempDir());
  const request = store.create({ serverId: "a", source: "agent", sessionId: null, explanation: "check nginx", commands: ["nginx -t", "systemctl reload nginx"] });
  const done = store.update(request.id, (draft) => {
    draft.status = "failed";
    draft.note = "careful";
    draft.commands[0] = { ...draft.commands[0], command: "nginx -t -c /etc/nginx/nginx.conf", original: "nginx -t", status: "failed", exitCode: 1, output: "bad config\n" };
    draft.commands[1].status = "skipped";
  });
  const text = formatRequest(done, null, 1000);
  assert.match(text, /failed\./);
  assert.match(text, /Note from the user: careful/);
  assert.match(text, /You proposed: \$ nginx -t/);
  assert.match(text, /Exit code 1/);
  assert.match(text, /2\. \$ systemctl reload nginx\n {3}Not run\./);
});

test("setup keeps an existing VAULT_KEY when forced", () => {
  const dir = tempDir();
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(runSetupMcp({ cwd: dir, force: false, exposure: { appPort: 4100 } }), 0);
    const first = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers["ssh-gate"].env;
    assert.equal(first.APP_PORT, "4100");
    parseVaultKey(first.VAULT_KEY);

    assert.equal(runSetupMcp({ cwd: dir, force: true, exposure: {} }), 0);
    const second = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers["ssh-gate"].env;
    assert.equal(second.VAULT_KEY, first.VAULT_KEY);
  } finally {
    console.log = log;
  }
});
