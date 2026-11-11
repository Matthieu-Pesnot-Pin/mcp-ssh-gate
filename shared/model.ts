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
  /** Session d'agent qui a soumis la demande ; null pour une commande saisie à la main. */
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
}

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

export interface ServerView extends ServerPublic {
  session: SessionState;
  cwd: string | null;
  pendingCount: number;
  busy: boolean;
}

export interface StateResponse {
  version: string;
  servers: ServerView[];
}

export interface RequestsResponse {
  requests: GateRequest[];
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
