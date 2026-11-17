import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WhitelistRule } from "../shared/model.js";
import { normalizeSegment, protectCommand, splitCommand } from "../src/core/command-parser.js";
import { WhitelistStore, evaluateCommand, formMatches, validateRuleInput, type AppliedRules } from "../src/core/whitelist.js";

function rule(command: string, fields: Partial<WhitelistRule> = {}): WhitelistRule {
  return { id: `r_${command}`, command, anyUse: false, forms: [], deny: [], sudo: false, ...fields };
}

const RULES: AppliedRules = {
  serverName: "prod-web",
  common: [
    rule("cd", { anyUse: true }),
    rule("ls", { anyUse: true }),
    rule("grep", { anyUse: true }),
    rule("wc", { anyUse: true }),
    rule("tail", { anyUse: true }),
    rule("git", { forms: ["status", "log *", "diff *"], deny: ["--output*", "-c"] }),
  ],
  server: [
    rule("npm", { forms: ["run build", "ci"] }),
    rule("systemctl", { forms: ["status *", "restart shop"], sudo: true }),
    rule("journalctl", { anyUse: true, deny: ["--vacuum-*", "--rotate"] }),
    rule("rm", { forms: ["-rf dist/"] }),
  ],
};

function verdicts(command: string): string[] {
  return evaluateCommand(command, RULES).segments.map((segment) => `${segment.verdict}:${segment.text}`);
}

function covered(command: string): boolean {
  return evaluateCommand(command, RULES).covered;
}

test("splitter cuts a command on every separator and keeps their order", () => {
  const { segments, error } = splitCommand("ls *.* && grep hello app.log | wc -l ; df -h || echo vide & uptime\nwhoami |& cat");
  assert.equal(error, null);
  assert.deepEqual(
    segments.map((s) => [s.separator, s.text]),
    [
      [null, "ls *.*"],
      ["&&", "grep hello app.log"],
      ["|", "wc -l"],
      [";", "df -h"],
      ["||", "echo vide"],
      ["&", "uptime"],
      ["↵", "whoami"],
      ["|&", "cat"],
    ]
  );
});

test("splitter reads quotes and backslashes like bash", () => {
  const [segment] = splitCommand(`grep -e 'a b' "c\\"d" e\\ f "$"x`).segments;
  assert.equal(segment.exclusion, null);
  assert.deepEqual(
    segment.words.map((w) => w.value),
    ["grep", "-e", "a b", 'c"d', "e f", "$x"]
  );
  const [escaped] = splitCommand("ls \\*.log").segments;
  assert.deepEqual(escaped.words[1], { value: "*.log", dynamic: false });
  const [glob] = splitCommand("ls *.log {a,b}").segments;
  assert.equal(glob.words[1].dynamic, true);
  assert.equal(glob.words[2].dynamic, true);
});

test("splitter keeps the text of non-ASCII commands intact", () => {
  const { segments } = splitCommand("grep 'é' fichier && echo ça");
  assert.deepEqual(
    segments.map((s) => s.text),
    ["grep 'é' fichier", "echo ça"]
  );
});

test("subshells and groups are split like the rest", () => {
  assert.deepEqual(verdicts("(cd /var/log && ls) ; { grep x y; }"), ["covered:cd /var/log", "covered:ls", "covered:grep x y"]);
});

test("whole commands are covered only when every part is", () => {
  assert.equal(covered("cd ~/apps/shop && git status && git log -5 --oneline"), true);
  assert.deepEqual(verdicts("cd ~/apps/shop && rm -rf dist/ && npm run build && sudo systemctl restart shop"), [
    "covered:cd ~/apps/shop",
    "covered:rm -rf dist/",
    "covered:npm run build",
    "covered:sudo systemctl restart shop",
  ]);
  assert.deepEqual(verdicts("npm run build && npm publish"), ["covered:npm run build", "uncovered:npm publish"]);
  assert.equal(covered("uptime"), false);
});

test("forms match word by word, options in any order, * for any arguments", () => {
  const args = (text: string) => text.split(" ").filter(Boolean).map((value) => ({ value, dynamic: false }));
  assert.equal(formMatches("run build", args("run build")), true);
  assert.equal(formMatches("run build", args("run build --force")), false);
  assert.equal(formMatches("run build", args("run")), false);
  assert.equal(formMatches("status *", args("status")), true);
  assert.equal(formMatches("status *", args("status shop --no-pager")), true);
  assert.equal(formMatches("-rf dist/", args("-fr dist/")), true);
  assert.equal(formMatches("-rf dist/", args("-r -f dist/")), true);
  assert.equal(formMatches("-rf dist/", args("-rf /")), false);
  assert.equal(formMatches("-rf dist/", args("-rf dist/ /")), false);
  assert.equal(formMatches("log *", [{ value: "log", dynamic: false }, { value: "*", dynamic: true }]), true);
  assert.equal(formMatches("restart shop", [{ value: "restart", dynamic: false }, { value: "s*", dynamic: true }]), false);
});

test("denied words and options are refused even inside an allowed form", () => {
  assert.equal(covered("git log --output=/etc/passwd"), false);
  assert.equal(covered("git -c core.pager=sh log"), false);
  assert.equal(covered("journalctl -u nginx"), true);
  assert.equal(covered("journalctl --vacuum-time=1d"), false);
  assert.equal(covered("journalctl --rotate"), false);
  assert.equal(covered("journalctl -u nginx*"), false, "a wildcard could expand into a denied option");
});

test("sudo needs a rule that allows it, and only -n and -u are read", () => {
  assert.equal(covered("sudo systemctl status nginx"), true);
  assert.equal(covered("sudo -n -u root systemctl status nginx"), true);
  assert.equal(covered("sudo npm ci"), false);
  assert.match(evaluateCommand("sudo npm ci", RULES).segments[0].reason!, /sudo/);
  assert.equal(evaluateCommand("sudo -E systemctl status", RULES).segments[0].verdict, "excluded");
  assert.equal(evaluateCommand("sudo sudo ls", RULES).segments[0].verdict, "excluded");
  assert.equal(evaluateCommand("sudo", RULES).segments[0].verdict, "excluded");
});

test("command paths: system folders are read as the bare name, others are excluded", () => {
  assert.equal(covered("/usr/bin/grep x y"), true);
  assert.equal(covered("/bin/ls"), true);
  assert.equal(evaluateCommand("./ls", RULES).segments[0].verdict, "excluded");
  assert.equal(evaluateCommand("~/bin/ls", RULES).segments[0].verdict, "excluded");
  assert.equal(evaluateCommand("/tmp/ls", RULES).segments[0].verdict, "excluded");
});

test("constructs no rule can cover are excluded", () => {
  const excluded = [
    "ls $(id)",
    "ls `id`",
    "ls $HOME",
    'ls "$HOME"',
    "grep x <(ls)",
    "ls > out.txt",
    "ls >> out.txt",
    "ls 2> err.txt",
    "ls &> out.txt",
    "cat < /dev/tcp/example.com/80",
    "cat <<EOF\nhi\nEOF",
    "cat <<< hi",
    "ls 3>&1",
    "FOO=1 ls",
    "PATH=/tmp ls",
    "export PATH=/tmp",
    "f() { ls; }",
    "if true; then ls; fi",
    "for f in a; do ls; done",
    "while true; do ls; done",
    "[[ -f x ]]",
    "(( 1 + 1 ))",
    "bash -c 'ls'",
    "sh -c ls",
    "eval ls",
    "source ./x",
    ". ./x",
    "exec ls",
    "xargs rm",
    "env ls",
    "nohup ls",
    "timeout 5 ls",
    "watch ls",
    "command ls",
    "builtin cd",
    "alias ls=rm",
    "find . -exec rm {} ;",
    "find . -execdir rm {} +",
    "time ls",
    "coproc ls",
    "ls $'\\x41'",
    "*",
    "l$x",
  ];
  for (const command of excluded) {
    const evaluation = evaluateCommand(command, RULES);
    assert.equal(evaluation.covered, false, command);
    assert.ok(
      evaluation.segments.some((segment) => segment.verdict === "excluded"),
      `${command} → ${JSON.stringify(evaluation.segments)}`
    );
  }
});

test("harmless redirections stay coverable", () => {
  assert.equal(covered("ls 2>&1"), true);
  assert.equal(covered("ls >/dev/null 2>&1"), true);
  assert.equal(covered("ls 2>/dev/null"), true);
  assert.equal(covered("ls >&2"), true);
  assert.equal(covered("ls &>/dev/null"), true);
});

test("an unreadable command is excluded as a whole", () => {
  const evaluation = evaluateCommand("echo 'unterminated", RULES);
  assert.equal(evaluation.covered, false);
  assert.equal(evaluation.segments[0].verdict, "excluded");
  assert.match(evaluation.segments[0].reason!, /Lecture impossible/);
});

test("evaluation names the rule that covers each part", () => {
  const [cd, npm] = evaluateCommand("cd /srv && npm ci", RULES).segments;
  assert.equal(cd.rule, "commune · cd");
  assert.equal(npm.rule, "prod-web · npm");
  assert.equal(npm.args, "ci");
});

test("protectCommand prefixes every simple command with \\command", () => {
  assert.equal(protectCommand("cd /srv && sudo systemctl restart shop | cat"), "\\command cd /srv && \\command sudo systemctl restart shop | \\command cat");
  assert.equal(protectCommand("echo é ; ! ls"), "\\command echo é ; ! \\command ls");
  assert.throws(() => protectCommand("ls > out"), /non couverte/);
});

test("normalizeSegment refuses a computed command name", () => {
  const result = normalizeSegment([{ value: "l*", dynamic: true }]);
  assert.ok("exclusion" in result);
});

test("rule validation", () => {
  assert.deepEqual(validateRuleInput({ command: "npm", forms: ["run  build", "run build", " ci "], deny: ["--force"] }), {
    command: "npm",
    anyUse: false,
    forms: ["run build", "ci"],
    deny: ["--force"],
    sudo: false,
  });
  assert.deepEqual(validateRuleInput({ command: "ls", anyUse: true, forms: ["x"] }).forms, []);
  assert.throws(() => validateRuleInput({ command: "npm" }), /au moins une forme/);
  assert.throws(() => validateRuleInput({ command: "bash", anyUse: true }), /toujours soumise/);
  assert.throws(() => validateRuleInput({ command: "/usr/bin/ls", anyUse: true }), /sans chemin/);
  assert.throws(() => validateRuleInput({ command: "ls", anyUse: true, deny: ["-a -b"] }), /espace/);
});

test("whitelist store keeps one rule per command and list, and moves rules between lists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-gate-whitelist-"));
  const store = new WhitelistStore(dir);
  const common = store.addRule(null, { command: "ls", anyUse: true });
  assert.throws(() => store.addRule(null, { command: "ls", anyUse: true }), /existe déjà/);
  store.addRule("prod-web", { command: "ls", anyUse: true });
  assert.equal(store.modeOf("prod-web"), "off");
  store.setMode("prod-web", "observe");
  assert.equal(store.modeOf("prod-web"), "observe");
  assert.throws(() => store.setMode("prod-web", "on"), /inconnu/);

  const moved = store.updateRule(common.id, "staging", { command: "ls", anyUse: false, forms: ["-la"] });
  const view = store.view([{ id: "prod-web" }, { id: "staging" }, { id: "db-01" }]);
  assert.deepEqual(view.common, []);
  assert.deepEqual(view.servers.find((s) => s.serverId === "staging")!.rules, [moved]);
  assert.deepEqual(view.servers.find((s) => s.serverId === "db-01"), { serverId: "db-01", mode: "off", rules: [] });

  store.deleteRule(moved.id);
  assert.throws(() => store.deleteRule(moved.id), /n'existe plus/);
  store.deleteServer("prod-web");
  assert.equal(store.read().servers["prod-web"], undefined);
});
