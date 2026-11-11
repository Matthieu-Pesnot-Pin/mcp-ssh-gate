/** Fichier de clés propre à SSH Gate, relatif au dossier personnel de l'utilisateur distant. */
export const DEDICATED_KEY_FILE = ".ssh/authorized_keys.d/ssh-gate";

/** Réglage sshd qui ajoute le fichier dédié à ~/.ssh/authorized_keys. */
export const SSHD_DROP_IN = "/etc/ssh/sshd_config.d/10-ssh-gate.conf";

const SSHD_SETTING = `AuthorizedKeysFile .ssh/authorized_keys ${DEDICATED_KEY_FILE}`;

/** Commande qui vide le fichier dédié : SSH Gate perd son accès, les autres clés restent. */
export const REVOKE_COMMAND = `: > ~/${DEDICATED_KEY_FILE}`;

/**
 * Ligne du fichier dédié : `restrict` coupe redirections, agent et X11 ;
 * `pty` rend le pseudo-terminal des terminaux interactifs ; `from` limite la
 * clé à l'adresse de SSH Gate.
 */
export function keyLine(publicKey: string, allowedFrom: string | null = null): string {
  return `restrict,pty${allowedFrom ? `,from="${allowedFrom}"` : ""} ${publicKey.trim()}`;
}

/**
 * Commande d'installation, sur une ligne : écrit la clé dans le fichier dédié,
 * fait lire ce fichier à sshd en plus de ~/.ssh/authorized_keys, et ne recharge
 * sshd que si la configuration est valide et prend bien le fichier dédié en
 * compte ; sinon le réglage ajouté est retiré. Le service s'appelle `ssh` sur
 * Debian et Ubuntu, `sshd` ailleurs ; `try-reload-or-restart` ne fait rien quand
 * il est arrêté, cas de l'activation par socket où sshd lit sa configuration au
 * démarrage.
 */
export function installCommand(publicKey: string): string {
  const dir = "~/.ssh/authorized_keys.d";
  const file = `~/${DEDICATED_KEY_FILE}`;
  return [
    `mkdir -p ${dir}`,
    `chmod 700 ~/.ssh ${dir}`,
    `printf '%s\\n' '${keyLine(publicKey)}' > ${file}`,
    `chmod 600 ${file}`,
    `printf '%s\\n' '${SSHD_SETTING}' | sudo tee ${SSHD_DROP_IN} > /dev/null`,
    `if sudo sshd -t && sudo sshd -T -C user=$(id -un),host=localhost,addr=127.0.0.1 | grep -q 'authorized_keys.d/ssh-gate'; ` +
      `then unit=sshd; [ "$(systemctl show -p LoadState --value ssh.service)" = loaded ] && unit=ssh; ` +
      `sudo systemctl try-reload-or-restart "$unit.service" && echo 'SSH Gate : installation terminée'; ` +
      `else sudo rm -f ${SSHD_DROP_IN}; echo 'SSH Gate : sshd ne prend pas le fichier dédié en compte, réglage retiré'; fi`,
  ].join(" && ");
}
