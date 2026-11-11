import { randomBytes } from "node:crypto";

const TICKET_TTL_MS = 30_000;

interface Ticket {
  terminalId: string;
  expiresAt: number;
}

/**
 * Tickets d'ouverture des WebSockets de terminal. Un navigateur n'envoie pas
 * `Sec-Fetch-Site` sur une poignée de main WebSocket, et l'`Origin` d'une page
 * relayée par un proxy porte un domaine que le worker ne connaît pas : la page
 * obtient donc un ticket par une requête POST de l'API, protégée contre les
 * autres sites, et le présente à l'ouverture. Un ticket sert une fois, pour un
 * terminal, pendant 30 secondes.
 */
export class TerminalTickets {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(terminalId: string): string {
    this.prune();
    const ticket = randomBytes(24).toString("hex");
    this.tickets.set(ticket, { terminalId, expiresAt: this.now() + TICKET_TTL_MS });
    return ticket;
  }

  /** Consomme le ticket ; vrai s'il était valable pour ce terminal. */
  redeem(ticket: string | null, terminalId: string): boolean {
    if (!ticket) return false;
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return !!entry && entry.terminalId === terminalId && entry.expiresAt > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(ticket);
    }
  }
}
