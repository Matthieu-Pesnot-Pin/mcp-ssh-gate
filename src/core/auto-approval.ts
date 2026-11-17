import type { AutoApproval, GateRequest } from "../../shared/model.js";
import type { Executor } from "./executor.js";
import type { RequestStore } from "./request-store.js";
import type { ServerStore } from "./server-store.js";
import { evaluateRequest, rulesUsed, type WhitelistStore } from "./whitelist.js";

/**
 * Exécute sans attendre l'utilisateur les demandes que la liste blanche couvre. Seule la
 * plus ancienne demande en attente de chaque session est examinée : les demandes d'une
 * session gardent leur ordre.
 */
export class AutoApprover {
  constructor(
    private readonly servers: ServerStore,
    private readonly requests: RequestStore,
    private readonly whitelist: WhitelistStore,
    private readonly executor: Executor,
    private readonly log: (message: string) => void
  ) {}

  /** Décision sur une demande, relue avec la liste blanche du moment. */
  private decide(draft: GateRequest): AutoApproval | null {
    const file = this.whitelist.read();
    if (this.whitelist.modeOf(draft.serverId, file) !== "active") return null;
    const evaluation = evaluateRequest(draft, this.whitelist.applied(this.servers.get(draft.serverId), file), "active");
    return evaluation.covered ? { at: new Date().toISOString(), rules: rulesUsed(evaluation) } : null;
  }

  run(): void {
    const file = this.whitelist.read();
    if (!Object.values(file.servers).some((entry) => entry.mode === "active")) return;
    const examined = new Set<string>();
    for (const request of this.requests.listOpen()) {
      if (request.status !== "pending") continue;
      const session = `${request.serverId}:${request.sessionId ?? ""}`;
      if (examined.has(session)) continue;
      examined.add(session);
      if (request.source !== "agent" || this.executor.isSessionBusy(request)) continue;
      try {
        if (!this.decide(request)) continue;
        const approved = this.executor.approveByWhitelist(request.id, (draft) => this.decide(draft));
        if (approved) this.log(`Request ${request.id} approved by the whitelist of ${request.serverId}.`);
      } catch (err: any) {
        this.log(`Whitelist check of ${request.id} failed: ${err?.message ?? err}`);
      }
    }
  }
}
