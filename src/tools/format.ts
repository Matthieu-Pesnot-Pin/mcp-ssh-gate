import type { CommandRun, GateRequest, RequestStatus } from "../../shared/model.js";
import type { StoredServer } from "../core/server-store.js";

const STATUS_TEXT: Record<RequestStatus, string> = {
  pending: "waiting for the user's approval",
  running: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted by the user",
  refused: "refused by the user",
  cancelled: "cancelled by you",
};

/** Garde la fin d'une sortie : les erreurs sont en général dans les dernières lignes. */
function tail(text: string, max: number): { text: string; omitted: number } {
  if (text.length <= max) return { text, omitted: 0 };
  return { text: text.slice(-max), omitted: text.length - max };
}

function duration(command: CommandRun): string {
  if (!command.startedAt || !command.endedAt) return "";
  const seconds = (Date.parse(command.endedAt) - Date.parse(command.startedAt)) / 1000;
  return ` · ${seconds.toFixed(1)} s`;
}

function formatCommand(command: CommandRun, index: number, maxOutput: number): string {
  const lines = [`${index + 1}. $ ${command.command}`];
  if (command.original !== null) lines.push(`   Edited by the user. You proposed: $ ${command.original}`);

  switch (command.status) {
    case "skipped":
      lines.push("   Not run.");
      return lines.join("\n");
    case "pending":
      lines.push("   Waiting.");
      return lines.join("\n");
    case "running":
      lines.push("   Running…");
      break;
    case "interrupted":
      lines.push(`   Interrupted by the user (Ctrl+C)${command.exitCode === null ? "" : `, exit code ${command.exitCode}`}${duration(command)}`);
      break;
    default:
      lines.push(`   ${command.exitCode === null ? "No exit code" : `Exit code ${command.exitCode}`}${duration(command)}`);
  }

  const output = tail(command.output, maxOutput);
  if (output.omitted > 0 || command.outputTruncated) lines.push(`   [The beginning of the output was omitted; the full stored output is in the GUI.]`);
  lines.push(output.text.trim() ? "```\n" + output.text.replace(/\s+$/, "") + "\n```" : "   (no output)");
  return lines.join("\n");
}

/** Demande lisible par l'agent : statut, note de l'utilisateur, commandes avec leur sortie. */
export function formatRequest(request: GateRequest, server: StoredServer | null, maxOutput: number): string {
  const target = server ? `${server.id} (${server.username}@${server.host})` : request.serverId;
  const author = request.source === "user" ? " — typed by the user" : "";
  const lines = [`Request ${request.id} on ${target}${author}: ${STATUS_TEXT[request.status]}.`];

  if (request.explanation) lines.push(`Your explanation: ${request.explanation}`);
  if (request.note) lines.push(`${request.status === "refused" ? "Reason given by the user" : "Note from the user"}: ${request.note}`);
  else if (request.status === "refused") lines.push("The user gave no reason.");
  if (request.error) lines.push(`Execution stopped: ${request.error}`);

  lines.push("");
  request.commands.forEach((command, index) => lines.push(formatCommand(command, index, maxOutput)));

  if (request.cwd) lines.push("", `Shell working directory afterwards: ${request.cwd}`);
  return lines.join("\n");
}
