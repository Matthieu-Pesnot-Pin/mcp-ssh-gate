import { BinCmdOperator, RedirOperator, parse, type Command, type Redirect, type Stmt, type Word } from "sh-syntax/sync";

/** Mot d'une commande après retrait des guillemets ; `dynamic` quand le shell le transforme encore (joker, accolades). */
export interface ShellWord {
  value: string;
  dynamic: boolean;
}

/** Partie d'une commande, entre deux séparateurs. */
export interface ShellSegment {
  /** Texte de la partie, tel qu'il est écrit dans la commande. */
  text: string;
  /** Séparateur qui précède la partie ; null pour la première. */
  separator: string | null;
  /** Mots de la commande simple ; vide quand la partie est exclue. */
  words: ShellWord[];
  /** Raison pour laquelle aucune règle ne peut couvrir la partie ; null pour une commande simple lisible. */
  exclusion: string | null;
  /** Position, en octets UTF-8 dans la source, du premier mot de la commande simple. */
  nameOffset: number | null;
}

export interface SplitResult {
  segments: ShellSegment[];
  /** Erreur de lecture : la commande n'a pas pu être analysée. */
  error: string | null;
}

/** Commande simple prête à comparer aux règles. */
export interface NormalizedCommand {
  name: string;
  args: ShellWord[];
  sudo: boolean;
}

const SEPARATORS: Record<number, string> = {
  [BinCmdOperator.AndStmt]: "&&",
  [BinCmdOperator.OrStmt]: "||",
  [BinCmdOperator.Pipe]: "|",
  [BinCmdOperator.PipeAll]: "|&",
};

const NULL_TARGET_REDIRECTS: number[] = [
  RedirOperator.RdrOut,
  RedirOperator.AppOut,
  RedirOperator.RdrAll,
  RedirOperator.AppAll,
  RedirOperator.ClbOut,
  RedirOperator.AppClob,
  RedirOperator.RdrAllClob,
  RedirOperator.AppAllClob,
];

const COMMAND_EXCLUSIONS: Record<string, string> = {
  IfClause: "structure de contrôle (if)",
  WhileClause: "boucle (while, until)",
  ForClause: "boucle (for)",
  RepeatClause: "boucle (repeat)",
  CaseClause: "structure de contrôle (case)",
  TryClause: "structure de contrôle (try)",
  FuncDecl: "définition de fonction",
  ArithmCmd: "calcul (( … ))",
  LetClause: "calcul (let)",
  TestClause: "test [[ … ]]",
  DeclClause: "déclaration de variable (export, local, declare…)",
  TimeClause: "lance une autre commande (time)",
  CoprocClause: "processus parallèle (coproc)",
  TestDecl: "déclaration de test (bats)",
};

const RUNS_CODE = "exécute un code arbitraire";
const RUNS_COMMAND = "lance une autre commande, invisible pour le découpage";
const SHELL_STATE = "modifie l'état du shell de la session";

/** Commandes qu'aucune règle ne peut couvrir, avec la raison affichée. */
export const ALWAYS_MANUAL: Readonly<Record<string, string>> = {
  ...Object.fromEntries(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh", "busybox", "eval", "source", ".", "exec"].map((name) => [name, RUNS_CODE])),
  ...Object.fromEntries(
    [
      "xargs", "env", "nohup", "timeout", "watch", "nice", "ionice", "stdbuf", "setsid", "sudo", "su", "doas", "runuser", "chroot",
      "command", "builtin", "time", "parallel", "flock", "unbuffer", "script", "strace", "ltrace", "systemd-run", "taskset", "chrt",
    ].map((name) => [name, RUNS_COMMAND])
  ),
  ...Object.fromEntries(
    ["alias", "unalias", "export", "unset", "set", "shopt", "trap", "declare", "typeset", "local", "readonly", "enable", "hash", "function", "umask", "ulimit"].map(
      (name) => [name, SHELL_STATE]
    )
  ),
};

const SYSTEM_DIRS = new Set(["/bin", "/usr/bin", "/sbin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin"]);

const FIND_EXEC_OPTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

class Exclusion extends Error {}

function exclude(reason: string): never {
  throw new Exclusion(reason);
}

/** Mot hors guillemets : retire les barres obliques inverses et repère les caractères que le shell développe encore. */
function unquoted(raw: string): ShellWord {
  let value = "";
  let dynamic = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "\\") {
      const next = raw[i + 1];
      if (next === undefined) value += char;
      else if (next !== "\n") value += next;
      i++;
      continue;
    }
    if (char === "*" || char === "?" || char === "[" || char === "{") dynamic = true;
    value += char;
  }
  return { value, dynamic };
}

/** Texte littéral entre guillemets doubles : seules les barres obliques devant $ ` " \ et le saut de ligne tombent. */
function doubleQuoted(raw: string): string {
  return raw.replace(/\\([$`"\\\n])/g, (_, char: string) => (char === "\n" ? "" : char));
}

function wordOf(word: Word): ShellWord {
  let value = "";
  let dynamic = false;
  for (const part of word.parts) {
    switch (part.type) {
      case "Lit": {
        const lit = unquoted(part.value);
        value += lit.value;
        dynamic ||= lit.dynamic;
        break;
      }
      case "SglQuoted":
        if (part.dollar) exclude("chaîne $'…'");
        value += part.value;
        break;
      case "DblQuoted":
        if (part.dollar) exclude('chaîne $"…"');
        for (const inner of part.parts) {
          if (inner.type !== "Lit") exclude(expansionReason(inner.type));
          value += doubleQuoted(inner.value);
        }
        break;
      case "ExtGlob":
      case "BraceExp":
        value += "*";
        dynamic = true;
        break;
      default:
        exclude(expansionReason(part.type));
    }
  }
  return { value, dynamic };
}

function expansionReason(type: string): string {
  switch (type) {
    case "ParamExp":
      return "variable ($…), connue seulement à l'exécution";
    case "CmdSubst":
      return "substitution de commande $( … ), connue seulement à l'exécution";
    case "ArithmExp":
      return "calcul $(( … )), connu seulement à l'exécution";
    case "ProcSubst":
      return "substitution de processus <( … )";
    default:
      return `développement ${type} non pris en charge`;
  }
}

/** Valeur d'un mot entièrement littéral, ou null. */
function literal(word: Word | null): string | null {
  if (!word) return null;
  try {
    const parsed = wordOf(word);
    return parsed.dynamic ? null : parsed.value;
  } catch {
    return null;
  }
}

/** Raison pour laquelle une redirection empêche la couverture ; null pour 2>&1, >&2 et les écritures dans /dev/null. */
function redirectProblem(redirect: Redirect): string | null {
  if (redirect.n && redirect.n.value !== "1" && redirect.n.value !== "2") return "redirection d'un descripteur autre que 1 ou 2";
  const target = literal(redirect.word);
  if (redirect.op === RedirOperator.DplOut) return target === "1" || target === "2" ? null : "redirection vers un autre descripteur";
  if (NULL_TARGET_REDIRECTS.includes(redirect.op)) return target === "/dev/null" ? null : "écriture dans un fichier (> fichier)";
  if (redirect.op === RedirOperator.Hdoc || redirect.op === RedirOperator.DashHdoc) return "document intégré (<<)";
  if (redirect.op === RedirOperator.WordHdoc) return "chaîne intégrée (<<<)";
  if (redirect.op === RedirOperator.RdrIn) return "lecture depuis un fichier (< fichier)";
  return "redirection non prise en charge";
}

class Splitter {
  readonly segments: ShellSegment[] = [];
  private separator: string | null = null;

  constructor(private readonly bytes: Buffer) {}

  private slice(start: number, end: number): string {
    return this.bytes.subarray(start, end).toString("utf8").trim();
  }

  /** Texte d'une instruction sans son terminateur (; ou &). */
  private stmtText(stmt: Stmt): string {
    const end = Math.max(stmt.cmd?.end ?? stmt.start, ...stmt.redirs.map((r) => r.end));
    return this.slice(stmt.start, end);
  }

  private push(segment: Omit<ShellSegment, "separator">): void {
    this.segments.push({ ...segment, separator: this.separator });
    this.separator = null;
  }

  private excluded(stmt: Stmt, reason: string): void {
    this.push({ text: this.stmtText(stmt), words: [], exclusion: reason, nameOffset: null });
  }

  list(stmts: Stmt[]): void {
    stmts.forEach((stmt, index) => {
      if (index > 0) {
        const previous = stmts[index - 1];
        this.separator = previous.background ? "&" : previous.semicolon.line > 0 ? ";" : "↵";
      }
      this.stmt(stmt);
    });
  }

  private stmt(stmt: Stmt | null): void {
    if (!stmt) return;
    if (stmt.coprocess) return this.excluded(stmt, "processus parallèle (coproc)");
    if (stmt.disown) return this.excluded(stmt, "processus détaché (&!)");
    const redirection = stmt.redirs.map(redirectProblem).find((problem) => problem !== null);
    if (redirection) return this.excluded(stmt, redirection);
    const cmd: Command | null = stmt.cmd;
    if (!cmd) return stmt.redirs.length ? this.excluded(stmt, "redirection sans commande") : undefined;

    switch (cmd.type) {
      case "BinaryCmd":
        this.stmt(cmd.x);
        this.separator = SEPARATORS[cmd.op] ?? "?";
        this.stmt(cmd.y);
        return;
      case "Subshell":
      case "Block":
        this.list(cmd.stmts);
        return;
      case "CallExpr": {
        if (cmd.assigns.length > 0) return this.excluded(stmt, "variable en tête (NOM=valeur commande)");
        try {
          const words = cmd.args.map(wordOf);
          this.push({ text: this.stmtText(stmt), words, exclusion: null, nameOffset: cmd.args[0].start });
        } catch (err) {
          if (!(err instanceof Exclusion)) throw err;
          this.excluded(stmt, err.message);
        }
        return;
      }
      default:
        this.excluded(stmt, COMMAND_EXCLUSIONS[cmd.type] ?? `construction ${cmd.type} non prise en charge`);
    }
  }
}

/** Découpe une commande bash en parties, avec la lecture de bash (mvdan/sh, via sh-syntax). */
export function splitCommand(source: string): SplitResult {
  const bytes = Buffer.from(source, "utf8");
  let file;
  try {
    file = parse(source);
  } catch (err: any) {
    return { segments: [], error: String(err?.message ?? err) };
  }
  const splitter = new Splitter(bytes);
  splitter.list(file.stmts);
  return { segments: splitter.segments, error: null };
}

/** Raison pour laquelle une règle ne peut pas porter sur cette commande ; null si elle le peut. */
export function ruleCommandProblem(name: string): string | null {
  if (ALWAYS_MANUAL[name]) return `${name} ${ALWAYS_MANUAL[name]} : elle reste toujours soumise à ton accord.`;
  return null;
}

/**
 * Commande simple ramenée à ce que les règles comparent : sudo retiré (seules ses options
 * -n et -u sont lues), chemin d'un dossier système ramené au nom. Renvoie la raison quand
 * aucune règle ne peut la couvrir.
 */
export function normalizeSegment(words: ShellWord[]): NormalizedCommand | { exclusion: string } {
  let index = 0;
  let sudo = false;
  if (!words[0].dynamic && words[0].value === "sudo") {
    sudo = true;
    index = 1;
    while (index < words.length && words[index].value.startsWith("-")) {
      const option = words[index];
      if (option.dynamic) return { exclusion: "option de sudo calculée" };
      if (option.value === "-n") index += 1;
      else if (option.value === "-u" && words[index + 1] && !words[index + 1].dynamic) index += 2;
      else return { exclusion: `option de sudo non prise en charge : ${option.value}` };
    }
    if (index >= words.length) return { exclusion: "sudo sans commande" };
  }

  const head = words[index];
  if (head.dynamic) return { exclusion: "nom de commande calculé par le shell" };
  let name = head.value;
  if (name.includes("/")) {
    const dir = name.slice(0, name.lastIndexOf("/")) || "/";
    if (!SYSTEM_DIRS.has(dir)) return { exclusion: `programme hors des dossiers système : ${name}` };
    name = name.slice(name.lastIndexOf("/") + 1);
  }
  if (!name) return { exclusion: "nom de commande vide" };
  if (ALWAYS_MANUAL[name]) return { exclusion: `${name} : ${ALWAYS_MANUAL[name]}` };

  const args = words.slice(index + 1);
  if (name === "find" && args.some((arg) => FIND_EXEC_OPTIONS.has(arg.value))) return { exclusion: `find ${args.find((arg) => FIND_EXEC_OPTIONS.has(arg.value))!.value} : ${RUNS_COMMAND}` };
  return { name, args, sudo };
}

/**
 * Commande à exécuter après approbation par la liste blanche : chaque commande simple est
 * précédée de `\command`, qui ignore les alias et les fonctions définis dans le shell de
 * la session.
 */
export function protectCommand(source: string): string {
  const { segments, error } = splitCommand(source);
  if (error) throw new Error(`Lecture impossible : ${error}`);
  const offsets = segments.map((segment) => {
    if (segment.nameOffset === null) throw new Error(`Partie non couverte : ${segment.text}`);
    return segment.nameOffset;
  });
  let bytes = Buffer.from(source, "utf8");
  for (const offset of [...offsets].sort((a, b) => b - a)) {
    bytes = Buffer.concat([bytes.subarray(0, offset), Buffer.from("\\command ", "utf8"), bytes.subarray(offset)]);
  }
  return bytes.toString("utf8");
}
