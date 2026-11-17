/** Auteur d'une demande : l'agent via les outils MCP, ou l'utilisateur via la saisie manuelle. */
export type RequestSource = "agent" | "user";

export type RequestStatus = "pending" | "running" | "completed" | "failed" | "interrupted" | "refused" | "cancelled";

export type CommandStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted" | "skipped";

/** Statuts après lesquels une demande ne change plus. */
export const FINAL_STATUSES: readonly RequestStatus[] = ["completed", "failed", "interrupted", "refused", "cancelled"];

export function isFinalStatus(status: RequestStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

export interface CommandRun {
  /** Commande exécutée, ou à exécuter. */
  command: string;
  /** Commande proposée par l'agent quand l'utilisateur l'a modifiée, sinon null. */
  original: string | null;
  status: CommandStatus;
  exitCode: number | null;
  /** Sortie standard et d'erreur, fusionnées. */
  output: string;
  /** Vrai quand le début de la sortie a été écarté pour rester sous la limite de stockage. */
  outputTruncated: boolean;
  startedAt: string | null;
  endedAt: string | null;
}

export interface GateRequest {
  id: string;
  serverId: string;
  source: RequestSource;
  /** Session d'agent de la demande ; null pour la session « Vous » du serveur. */
  sessionId: string | null;
  /** Explication de l'agent ; vide pour une commande saisie à la main. */
  explanation: string;
  createdAt: string;
  status: RequestStatus;
  /** Note de l'utilisateur : jointe au résultat, ou motif du refus. */
  note: string | null;
  decidedAt: string | null;
  finishedAt: string | null;
  /** Instant où l'utilisateur a envoyé sa commande aux agents ; null tant qu'il ne l'a pas fait. */
  sharedAt: string | null;
  /** Erreur qui a arrêté l'exécution hors du code de retour d'une commande (connexion perdue…). */
  error: string | null;
  /** Répertoire courant du shell à la fin de l'exécution. */
  cwd: string | null;
  commands: CommandRun[];
  /** Questions de l'utilisateur sur des instructions de ces commandes. */
  questions: CommandQuestion[];
  /** Approbation par la liste blanche, à la place de l'utilisateur ; null pour une demande validée à la main. */
  autoApproval: AutoApproval | null;
}

export interface AutoApproval {
  at: string;
  /** Règles qui ont couvert les parties des commandes, sous la forme « commune · cd » ou « prod-web · npm ». */
  rules: string[];
}

/**
 * Demande d'explication posée depuis l'interface sur une instruction (partie d'une
 * commande délimitée par ;). Un agent y répond avec l'outil answer_question.
 */
export interface CommandQuestion {
  id: string;
  /** Index de la commande dans la demande. */
  commandIndex: number;
  /** Instruction concernée, telle qu'elle est écrite dans la commande, sans le ; final. */
  statement: string;
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
}

export const MAX_STATEMENT_LENGTH = 4_000;
export const MAX_ANSWER_LENGTH = 6_000;

export interface ServerPublic {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** Clé publique OpenSSH ; null quand la clé a été révoquée. */
  publicKey: string | null;
  /** Création de la paire de clés actuelle ; null quand la clé a été révoquée. */
  keyCreatedAt: string | null;
  /** Adresse à laquelle la ligne de la clé est limitée (`from=`) sur le serveur, relevée au dernier test. */
  allowedFrom: string | null;
  /** Empreinte SHA256 de la clé d'hôte, enregistrée au premier test de connexion. */
  hostKeyFingerprint: string | null;
  createdAt: string;
  /** Contexte du serveur en texte libre, lu par l'agent avant d'intervenir. */
  notes: string;
  notesUpdatedAt: string | null;
  notesUpdatedBy: NotesAuthor | null;
}

export type NotesAuthor = "agent" | "user";

export const MAX_NOTES_LENGTH = 20_000;

export type SessionState = "connected" | "closed";

export type SessionCloser = "agent" | "user";

/**
 * Session ouverte par un agent sur un serveur : elle a son propre shell, et seul
 * l'agent qui l'a ouverte est notifié de ce qui s'y passe.
 */
export interface AgentSession {
  id: string;
  serverId: string;
  /** Agent qui a ouvert la session : son veilleur reçoit les événements de toutes ses sessions. */
  agentId: string;
  /** Libellé choisi par l'agent, affiché dans l'interface. */
  name: string;
  openedAt: string;
  closedAt: string | null;
  closedBy: SessionCloser | null;
}

export const MAX_SESSION_NAME_LENGTH = 40;

/** Identité d'un agent, propre à sa conversation : elle rattache ses sessions à un seul veilleur. */
export interface AgentIdentity {
  id: string;
  createdAt: string;
}

/** Session d'un serveur telle que l'interface l'affiche ; `id` vaut null pour la session « Vous ». */
export interface SessionView {
  id: string | null;
  serverId: string;
  name: string;
  /** Ouverture par l'agent ; null pour la session « Vous ». */
  openedAt: string | null;
  shell: SessionState;
  cwd: string | null;
  pendingCount: number;
  busy: boolean;
}

export interface ServerView extends ServerPublic {
  /** La session « Vous » d'abord, puis les sessions d'agent ouvertes, des plus anciennes aux plus récentes. */
  sessions: SessionView[];
  pendingCount: number;
  /** Vrai quand une demande s'exécute dans l'une des sessions du serveur. */
  busy: boolean;
}

/** Palettes de coloration syntaxique des commandes ; "aucune" affiche les commandes sans couleur. */
export const HIGHLIGHT_PALETTES = ["sobre", "contrastee", "vive", "minimale", "aucune"] as const;

export type HighlightPalette = (typeof HIGHLIGHT_PALETTES)[number];

export const DEFAULT_HIGHLIGHT_PALETTE: HighlightPalette = "sobre";

/**
 * Affichage des commandes longues quand elles sont montrées en entier : "brut" les laisse
 * telles qu'écrites, "auto" passe à la ligne avant chaque && et ||, après chaque ; et \.
 */
export const LINE_BREAK_MODES = ["brut", "auto"] as const;

export type LineBreakMode = (typeof LINE_BREAK_MODES)[number];

export const DEFAULT_LINE_BREAK_MODE: LineBreakMode = "auto";

/** Réglages de l'interface, communs à tous les navigateurs. */
export interface GuiSettings {
  palette: HighlightPalette;
  lineBreaks: LineBreakMode;
}

export interface StateResponse {
  version: string;
  servers: ServerView[];
  settings: GuiSettings;
}

export interface RequestsResponse {
  requests: GateRequest[];
  /** Lecture par la liste blanche des demandes en attente, par identifiant ; absente quand la liste blanche du serveur est désactivée. */
  evaluations: Record<string, RequestEvaluation>;
}

/**
 * Liste blanche d'un serveur : "off" laisse tout à valider, "observe" annote les demandes
 * sans rien approuver, "active" exécute sans attendre les demandes entièrement couvertes.
 */
export const WHITELIST_MODES = ["off", "observe", "active"] as const;

export type WhitelistMode = (typeof WHITELIST_MODES)[number];

/** Règle d'une commande, dans la liste commune ou dans celle d'un serveur. */
export interface WhitelistRule {
  id: string;
  /** Nom de la commande, sans chemin : `systemctl`. */
  command: string;
  /** Vrai : tous les arguments sont acceptés ; faux : seules les formes listées. */
  anyUse: boolean;
  /** Arguments acceptés après la commande, mot à mot ; `*` accepte n'importe quelle suite d'arguments. */
  forms: string[];
  /** Mots ou options refusés même dans une forme acceptée ; un `*` final accepte tout suffixe : `--vacuum-*`. */
  deny: string[];
  /** La commande est acceptée précédée de sudo. */
  sudo: boolean;
}

export type WhitelistRuleInput = Omit<WhitelistRule, "id">;

export interface WhitelistServerView {
  serverId: string;
  mode: WhitelistMode;
  rules: WhitelistRule[];
}

export interface WhitelistResponse {
  common: WhitelistRule[];
  /** Un élément par serveur configuré, dans l'ordre de la barre latérale. */
  servers: WhitelistServerView[];
}

/** "covered" : une règle couvre la partie ; "uncovered" : aucune ne la couvre ; "excluded" : aucune règle ne peut la couvrir. */
export type SegmentVerdict = "covered" | "uncovered" | "excluded";

/** Partie d'une commande délimitée par un séparateur (&&, ||, ;, |, |&, &, saut de ligne). */
export interface SegmentEvaluation {
  /** Texte de la partie, tel qu'il est écrit dans la commande. */
  text: string;
  /** Séparateur qui précède la partie ; null pour la première. */
  separator: string | null;
  verdict: SegmentVerdict;
  /** Règle qui couvre la partie, sous la forme « commune · cd » ; null si elle n'est pas couverte. */
  rule: string | null;
  /** Raison pour laquelle la partie n'est pas couverte ; null si elle l'est. */
  reason: string | null;
  /** Nom de la commande, sans sudo ni chemin, quand une règle peut la couvrir. */
  command: string | null;
  /** Arguments de la commande, pour pré-remplir une forme. */
  args: string | null;
  sudo: boolean;
}

export interface CommandEvaluation {
  segments: SegmentEvaluation[];
  covered: boolean;
}

export interface RequestEvaluation {
  mode: WhitelistMode;
  /** Vrai quand chaque partie de chaque commande est couverte. */
  covered: boolean;
  commands: CommandEvaluation[];
}

export interface WhitelistTestResponse {
  evaluation: CommandEvaluation;
}

/** Place de la clé de SSH Gate sur le serveur, relevée par la connexion de test. */
export interface KeyFileStatus {
  /** La clé figure dans le fichier dédié ~/.ssh/authorized_keys.d/ssh-gate. */
  inDedicatedFile: boolean;
  /** La clé figure aussi dans ~/.ssh/authorized_keys, que SSH Gate ne modifie jamais. */
  inAuthorizedKeys: boolean;
  /** Adresse de la limite `from=` en place ; null sans limite. */
  allowedFrom: string | null;
  /** Raison pour laquelle la limite d'adresse n'a pas pu être posée. */
  restrictError: string | null;
}

export interface TestConnectionResponse {
  server: ServerView;
  fingerprint: string;
  cwd: string;
  keyFile: KeyFileStatus;
}

export type KeyStepStatus = "done" | "failed" | "skipped";

/** Déroulé d'un renouvellement : générer, ajouter, tester, retirer l'ancienne clé. */
export interface RotationResponse {
  server: ServerView;
  steps: KeyStepStatus[];
  error: string | null;
}

/** Vrai quand le serveur a une clé et une empreinte d'hôte enregistrée. */
export function isReady(server: ServerPublic): boolean {
  return !!server.publicKey && !!server.hostKeyFingerprint;
}

export type TerminalStatus = "open" | "closed";

/** Terminal interactif ouvert par l'utilisateur ; l'agent n'y a pas accès. */
export interface TerminalView {
  id: string;
  serverId: string;
  serverName: string;
  /** Rang parmi les terminaux ouverts sur le même serveur, à partir de 1. */
  number: number;
  openedAt: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  closedReason: string | null;
}

export interface TerminalsResponse {
  terminals: TerminalView[];
}

/** Messages du worker vers le navigateur, sur la WebSocket d'un terminal. */
export type TerminalServerMessage = { type: "output"; data: string } | { type: "closed"; reason: string };

/** Messages du navigateur vers le worker. */
export type TerminalClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

export const MAX_COMMANDS_PER_REQUEST = 20;
