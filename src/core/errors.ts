/** Erreur attendue, dont le message est destiné tel quel à l'agent ou à l'interface. */
export class GateError extends Error {
  override name = "GateError";
}

/** Connexion SSH refusée à l'authentification : le serveur n'accepte pas la clé. */
export class AuthRefusedError extends GateError {
  override name = "AuthRefusedError";
}
