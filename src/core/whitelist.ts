import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  WHITELIST_MODES,
  type CommandEvaluation,
  type GateRequest,
  type RequestEvaluation,
  type SegmentEvaluation,
  type WhitelistMode,
  type WhitelistResponse,
  type WhitelistRule,
  type WhitelistRuleInput,
} from "../../shared/model.js";
import { normalizeSegment, ruleCommandProblem, splitCommand, type ShellWord } from "./command-parser.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";

interface ServerWhitelist {
  mode: WhitelistMode;
  rules: WhitelistRule[];
}

export interface WhitelistFile {
  common: WhitelistRule[];
  servers: Record<string, ServerWhitelist>;
}

/** Règles applicables à un serveur : la liste commune et la sienne. */
export interface AppliedRules {
  common: WhitelistRule[];
  server: WhitelistRule[];
  serverName: string;
}

const COMMAND_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;
const MAX_RULE_ITEMS = 50;
const MAX_ITEM_LENGTH = 200;
const COMMON_LABEL = "commune";

function emptyServer(): ServerWhitelist {
  return { mode: "off", rules: [] };
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function cleanList(values: unknown, label: string, normalize: (value: string) => string): string[] {
  if (!Array.isArray(values)) throw new GateError(`${label} : liste attendue.`);
  const cleaned = [...new Set(values.map((value) => normalize(String(value ?? ""))).filter(Boolean))];
  if (cleaned.length > MAX_RULE_ITEMS) throw new GateError(`${label} : ${MAX_RULE_ITEMS} éléments au plus.`);
  const tooLong = cleaned.find((value) => value.length > MAX_ITEM_LENGTH);
  if (tooLong) throw new GateError(`${label} : « ${tooLong.slice(0, 40)}… » dépasse ${MAX_ITEM_LENGTH} caractères.`);
  return cleaned;
}

/** Contrôle et normalise une règle saisie dans l'interface. */
export function validateRuleInput(input: Partial<WhitelistRuleInput> | null | undefined): WhitelistRuleInput {
  const command = String(input?.command ?? "").trim();
  if (!command) throw new GateError("Le nom de la commande est obligatoire.");
  if (!COMMAND_PATTERN.test(command)) throw new GateError(`« ${command} » n'est pas un nom de commande : un seul mot, sans chemin ni espace.`);
  const problem = ruleCommandProblem(command);
  if (problem) throw new GateError(problem);

  const anyUse = input?.anyUse === true;
  const forms = anyUse ? [] : cleanList(input?.forms ?? [], "Formes", (form) => words(form).join(" "));
  if (!anyUse && forms.length === 0) throw new GateError("Ajoute au moins une forme, ou choisis « Toute utilisation ».");
  const deny = cleanList(input?.deny ?? [], "Toujours refuser", (value) => value.trim());
  const spaced = deny.find((value) => /\s/.test(value));
  if (spaced) throw new GateError(`Toujours refuser : « ${spaced} » contient un espace ; une entrée par mot ou option.`);
  return { command, anyUse, forms, deny, sudo: input?.sudo === true };
}

function parseMode(value: unknown): WhitelistMode {
  if (!WHITELIST_MODES.includes(value as WhitelistMode)) {
    throw new GateError(`Mode de liste blanche inconnu : « ${String(value)} ». Valeurs possibles : ${WHITELIST_MODES.join(", ")}.`);
  }
  return value as WhitelistMode;
}

/**
 * Liste blanche : `<DATA_DIR>/whitelist.json`. Une liste commune à tous les serveurs,
 * et pour chaque serveur un mode et ses propres règles. Une règle par commande et par liste.
 */
export class WhitelistStore {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "whitelist.json");
    this.lockFile = `${this.file}.lock`;
  }

  read(): WhitelistFile {
    if (!fs.existsSync(this.file)) return { common: [], servers: {} };
    const stored = readJson<WhitelistFile>(this.file);
    for (const [serverId, entry] of Object.entries(stored.servers ?? {})) {
      if (!WHITELIST_MODES.includes(entry.mode)) throw new GateError(`whitelist.json : mode inconnu pour ${serverId} : « ${String(entry.mode)} ».`);
    }
    return { common: stored.common ?? [], servers: stored.servers ?? {} };
  }

  view(servers: { id: string }[]): WhitelistResponse {
    const file = this.read();
    return {
      common: file.common,
      servers: servers.map((server) => ({ serverId: server.id, ...(file.servers[server.id] ?? emptyServer()) })),
    };
  }

  modeOf(serverId: string, file: WhitelistFile = this.read()): WhitelistMode {
    return file.servers[serverId]?.mode ?? "off";
  }

  applied(server: { id: string; name: string }, file: WhitelistFile = this.read()): AppliedRules {
    return { common: file.common, server: file.servers[server.id]?.rules ?? [], serverName: server.name };
  }

  setMode(serverId: string, mode: unknown): void {
    const value = parseMode(mode);
    this.write((file) => {
      file.servers[serverId] = { ...(file.servers[serverId] ?? emptyServer()), mode: value };
    });
  }

  /** Ajoute une règle à la liste commune (scope null) ou à celle d'un serveur. */
  addRule(scope: string | null, input: Partial<WhitelistRuleInput>): WhitelistRule {
    const rule: WhitelistRule = { id: `r_${randomBytes(4).toString("hex")}`, ...validateRuleInput(input) };
    this.write((file) => {
      const list = this.listOf(file, scope);
      this.assertUnique(list, rule, scope);
      list.push(rule);
    });
    return rule;
  }

  /** Remplace une règle ; un changement de liste la déplace. */
  updateRule(id: string, scope: string | null, input: Partial<WhitelistRuleInput>): WhitelistRule {
    const rule: WhitelistRule = { id, ...validateRuleInput(input) };
    this.write((file) => {
      this.remove(file, id);
      const list = this.listOf(file, scope);
      this.assertUnique(list, rule, scope);
      list.push(rule);
    });
    return rule;
  }

  deleteRule(id: string): void {
    this.write((file) => this.remove(file, id));
  }

  deleteServer(serverId: string): void {
    if (!fs.existsSync(this.file)) return;
    this.write((file) => {
      delete file.servers[serverId];
    });
  }

  private listOf(file: WhitelistFile, scope: string | null): WhitelistRule[] {
    if (scope === null) return file.common;
    file.servers[scope] ??= emptyServer();
    return file.servers[scope].rules;
  }

  private assertUnique(list: WhitelistRule[], rule: WhitelistRule, scope: string | null): void {
    if (list.some((other) => other.command === rule.command && other.id !== rule.id)) {
      throw new GateError(`Une règle existe déjà pour ${rule.command} dans ${scope === null ? "la liste commune" : `la liste de ${scope}`} : modifie-la.`);
    }
  }

  private remove(file: WhitelistFile, id: string): void {
    const lists = [file.common, ...Object.values(file.servers).map((entry) => entry.rules)];
    const list = lists.find((candidate) => candidate.some((rule) => rule.id === id));
    if (!list) throw new GateError("Cette règle n'existe plus.");
    list.splice(
      list.findIndex((rule) => rule.id === id),
      1
    );
  }

  private write(fn: (file: WhitelistFile) => void): void {
    withFileLock(this.lockFile, "whitelist.json", () => {
      const file = this.read();
      fn(file);
      writeJsonAtomic(this.file, file);
    });
  }
}

// --- Comparaison aux règles -----------------------------------------------------------

interface Token {
  value: string;
  dynamic: boolean;
}

/** Options courtes groupées lues une à une : -rf devient -r -f. */
function expand(word: ShellWord): Token[] {
  if (!word.dynamic && /^-[A-Za-z]{2,}$/.test(word.value)) return [...word.value.slice(1)].map((letter) => ({ value: `-${letter}`, dynamic: false }));
  return [{ value: word.value, dynamic: word.dynamic }];
}

/** Sépare options et autres arguments ; après `--`, tout est argument. */
function partition(tokens: Token[]): { options: Set<string>; positionals: Token[] } {
  const options = new Set<string>();
  const positionals: Token[] = [];
  let endOfOptions = false;
  for (const token of tokens) {
    if (!endOfOptions && !token.dynamic && token.value.startsWith("-") && token.value !== "-") {
      options.add(token.value);
      if (token.value === "--") endOfOptions = true;
    } else {
      positionals.push(token);
    }
  }
  return { options, positionals };
}

/** `*` accepte zéro ou plusieurs arguments ; un argument développé par le shell n'est accepté que par `*`. */
function sequenceMatches(pattern: string[], items: Token[]): boolean {
  if (pattern.length === 0) return items.length === 0;
  const [head, ...rest] = pattern;
  if (head === "*") {
    for (let skip = 0; skip <= items.length; skip++) if (sequenceMatches(rest, items.slice(skip))) return true;
    return false;
  }
  return items.length > 0 && !items[0].dynamic && items[0].value === head && sequenceMatches(rest, items.slice(1));
}

/**
 * Une forme accepte les arguments quand ses options y figurent toutes, dans n'importe quel
 * ordre, et que les autres arguments suivent les siens mot à mot. Sans `*`, aucune option
 * en plus n'est acceptée.
 */
export function formMatches(form: string, args: ShellWord[]): boolean {
  const formTokens = words(form).flatMap((value) => expand({ value, dynamic: false }));
  const wildcard = formTokens.some((token) => token.value === "*");
  const expected = partition(formTokens);
  const actual = partition(args.flatMap(expand));
  for (const option of expected.options) if (!actual.options.has(option)) return false;
  if (!wildcard) for (const option of actual.options) if (!expected.options.has(option)) return false;
  return sequenceMatches(
    expected.positionals.map((token) => token.value),
    actual.positionals
  );
}

/** Formes sous lesquelles un mot est comparé aux refus : tel quel, avant `=`, lettre par lettre. */
function denyCandidates(word: ShellWord): string[] {
  const candidates = [word.value];
  if (word.value.startsWith("--") && word.value.includes("=")) candidates.push(word.value.slice(0, word.value.indexOf("=")));
  candidates.push(...expand(word).map((token) => token.value));
  return candidates;
}

function denies(pattern: string, value: string): boolean {
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

function labelOf(scope: string, command: string): string {
  return `${scope} · ${command}`;
}

function summarizeForms(rules: WhitelistRule[]): string {
  const forms = [...new Set(rules.flatMap((rule) => rule.forms))];
  const shown = forms.slice(0, 4).join(", ");
  return forms.length > 4 ? `${shown}…` : shown;
}

function evaluateSegment(name: string, args: ShellWord[], sudo: boolean, rules: AppliedRules): Pick<SegmentEvaluation, "verdict" | "rule" | "reason"> {
  const candidates = [
    ...rules.common.filter((rule) => rule.command === name).map((rule) => ({ rule, scope: COMMON_LABEL })),
    ...rules.server.filter((rule) => rule.command === name).map((rule) => ({ rule, scope: rules.serverName })),
  ];
  if (candidates.length === 0) return { verdict: "uncovered", rule: null, reason: `Aucune règle pour ${name}` };

  const deny = candidates.flatMap(({ rule }) => rule.deny);
  if (deny.length > 0) {
    const wildcard = args.find((arg) => arg.dynamic);
    if (wildcard) return { verdict: "uncovered", rule: null, reason: `${wildcard.value} : joker non vérifiable contre les refus de ${name}` };
    for (const arg of args) {
      const pattern = deny.find((denied) => denyCandidates(arg).some((candidate) => denies(denied, candidate)));
      if (pattern) return { verdict: "uncovered", rule: null, reason: `${arg.value} est toujours refusé pour ${name}` };
    }
  }

  const shapes = candidates.filter(({ rule }) => rule.anyUse || rule.forms.some((form) => formMatches(form, args)));
  const allowed = shapes.find(({ rule }) => !sudo || rule.sudo);
  if (allowed) return { verdict: "covered", rule: labelOf(allowed.scope, name), reason: null };
  if (shapes.length > 0) return { verdict: "uncovered", rule: null, reason: `${name} n'est pas autorisé avec sudo` };
  return { verdict: "uncovered", rule: null, reason: `${name} : seulement ${summarizeForms(candidates.map(({ rule }) => rule))}` };
}

/** Découpe une commande et compare chacune de ses parties aux règles du serveur. */
export function evaluateCommand(source: string, rules: AppliedRules): CommandEvaluation {
  const { segments, error } = splitCommand(source);
  if (error) {
    const segment: SegmentEvaluation = { text: source.trim(), separator: null, verdict: "excluded", rule: null, reason: `Lecture impossible : ${error}`, command: null, args: null, sudo: false };
    return { segments: [segment], covered: false };
  }
  const evaluated = segments.map((segment): SegmentEvaluation => {
    const base = { text: segment.text, separator: segment.separator };
    if (segment.exclusion) return { ...base, verdict: "excluded", rule: null, reason: segment.exclusion, command: null, args: null, sudo: false };
    const normalized = normalizeSegment(segment.words);
    if ("exclusion" in normalized) return { ...base, verdict: "excluded", rule: null, reason: normalized.exclusion, command: null, args: null, sudo: false };
    return {
      ...base,
      ...evaluateSegment(normalized.name, normalized.args, normalized.sudo, rules),
      command: normalized.name,
      args: normalized.args.map((arg) => arg.value).join(" "),
      sudo: normalized.sudo,
    };
  });
  return { segments: evaluated, covered: evaluated.length > 0 && evaluated.every((segment) => segment.verdict === "covered") };
}

export function evaluateRequest(request: GateRequest, rules: AppliedRules, mode: WhitelistMode): RequestEvaluation {
  const commands = request.commands.map((command) => evaluateCommand(command.command, rules));
  return { mode, covered: commands.every((command) => command.covered), commands };
}

/** Règles citées dans une évaluation entièrement couverte, sans doublon. */
export function rulesUsed(evaluation: RequestEvaluation): string[] {
  return [...new Set(evaluation.commands.flatMap((command) => command.segments.map((segment) => segment.rule!).filter(Boolean)))];
}
