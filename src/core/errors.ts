/** Erreur attendue, dont le message est destiné tel quel à l'agent ou à l'interface. */
export class GateError extends Error {
  override name = "GateError";
}
