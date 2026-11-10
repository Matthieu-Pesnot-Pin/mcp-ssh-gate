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
  /** Explication de l'agent ; vide pour une commande saisie à la main. */
  explanation: string;
  createdAt: string;
  status: RequestStatus;
  /** Note de l'utilisateur : jointe au résultat, ou motif du refus. */
  note: string | null;
  decidedAt: string | null;
  finishedAt: string | null;
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
  publicKey: string;
  /** Empreinte SHA256 de la clé d'hôte, enregistrée au premier test de connexion. */
  hostKeyFingerprint: string | null;
  createdAt: string;
}

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

export interface TestConnectionResponse {
  server: ServerView;
  fingerprint: string;
  cwd: string;
}

export const MAX_COMMANDS_PER_REQUEST = 20;
