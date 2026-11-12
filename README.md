# @imenam/mcp-ssh-gate

Un agent propose des commandes à exécuter sur un serveur de production ; tu les lis, les modifies ou les refuses dans une interface web, et seules celles que tu valides partent sur le serveur, en SSH. Le résultat revient à l'agent sans copier-coller.

L'agent ne détient aucun accès au serveur. La paire de clés SSH est générée par le MCP à l'ajout d'un serveur ; tu poses la clé publique sur le serveur dans un fichier qui lui est propre, la clé privée reste chiffrée dans le MCP et n'est jamais affichée.

```
Agent ──submit_commands──▶  file d'attente  ──▶  Interface : tu valides, modifies ou refuses
  ▲                                                        │
  └──── wait_for_result ◀── sortie, code de retour ◀── SSH ─┘  (shell bash persistant)
```

---

## Installation

```bash
npm install -g @imenam/mcp-ssh-gate
```

Ou directement via `npx`, sans installation.

### Déclaration dans un projet

```bash
npx -y @imenam/mcp-ssh-gate --claude-setup-mcp
```

Crée ou complète le `.mcp.json` du dossier courant avec une entrée `ssh-gate` et une `VAULT_KEY` générée. Relancé avec `--force`, il remplace l'entrée en **conservant** la `VAULT_KEY` existante.

```bash
# Interface derrière le proxy central
npx -y @imenam/mcp-ssh-gate --claude-setup-mcp --proxy_url=http://localhost:3000

# Interface en accès direct, sans proxy : http://localhost:4600
npx -y @imenam/mcp-ssh-gate --claude-setup-mcp --app_port=4600
```

Les deux flags sont exclusifs : la commande échoue si les deux sont passés.

Exemple d'entrée générée :

```json
{
  "mcpServers": {
    "ssh-gate": {
      "command": "npx",
      "args": ["-y", "@imenam/mcp-ssh-gate"],
      "env": {
        "PROXY_URL": "http://localhost:3000",
        "APP_PORT": "",
        "APP_GROUP": "Mon-projet",
        "APP_NAME": "SSH Gate",
        "APP_PATH": "/ssh-gate",
        "DATA_DIR": "C:/dev/mon-projet/.ssh-gate-data",
        "VAULT_KEY": "<32 octets en base64, générés par la commande>",
        "MCP_LOG_DIR": ""
      }
    }
  }
}
```

Une `VAULT_KEY` se génère aussi à part :

```bash
npx -y @imenam/mcp-ssh-gate --generate-vault-key
```

### Dans le gateway manager

Ajoute le MCP à une gateway avec ces variables, et coche **secret** pour `VAULT_KEY` : le manager la stocke chiffrée avec sa clé maître et la réinjecte au lancement.

```json
{
  "mcpServers": {
    "ssh-gate": {
      "command": "npx",
      "args": ["-y", "@imenam/mcp-ssh-gate"],
      "env": {
        "PROXY_URL": "http://localhost:3000",
        "APP_GROUP": "SSH Gate",
        "APP_PATH": "/ssh-gate",
        "DATA_DIR": "/srv/ssh-gate",
        "VAULT_KEY": { "secret": true, "value": "<clé générée par --generate-vault-key>" }
      }
    }
  }
}
```

### Dans mcp-http-gateway

Le MCP se déclare dans un gateway ([mcp-http-gateway](https://www.npmjs.com/package/@imenam/mcp-http-gateway)) comme tout autre MCP, dans `config/mcp-servers.json` :

```json
{
  "mcpServers": {
    "ssh-gate": {
      "command": "npx",
      "args": ["-y", "@imenam/mcp-ssh-gate"],
      "env": {
        "MCP_SERVER_ROUTE": "/ssh-gate",
        "PROXY_URL": "http://localhost:3000",
        "APP_PATH": "/ssh-gate",
        "DATA_DIR": "/srv/ssh-gate",
        "VAULT_KEY": "<clé générée par --generate-vault-key>"
      }
    }
  }
}
```

Les connexions SSH partent de la machine du gateway : c'est elle qui doit joindre les serveurs. Les notifications fonctionnent à travers le gateway (voir [Notifications](#notifications)).

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `DATA_DIR` | — | **Requis.** Serveurs, clés chiffrées et historique des commandes. Créé s'il n'existe pas. |
| `VAULT_KEY` | — | **Requis.** 32 octets en base64. Chiffre les clés privées SSH (AES-256-GCM). La perdre ou la changer rend les clés existantes illisibles : le MCP refuse alors de démarrer. |
| `PROXY_URL` | — | URL du proxy qui expose l'interface. |
| `APP_PORT` | — | Port local de l'interface quand il n'y a pas de proxy. `PROXY_URL` ou `APP_PORT` est **requis** : sans interface, rien ne peut être validé. `PROXY_URL` prime si les deux sont renseignés. |
| `APP_GROUP` | — | Groupe d'affichage dans le dashboard du proxy. |
| `APP_NAME` | `SSH Gate` | Nom affiché dans le dashboard du proxy. |
| `APP_PATH` | `/ssh-gate` | Chemin de montage derrière le proxy. |
| `MCP_LOG_DIR` | `<DATA_DIR>/logs` | Répertoire des logs. |

Un réglage requis absent ou invalide arrête le lancement avec un message qui dit quoi corriger.

---

## Ajouter un serveur

1. **Ajouter un serveur** dans l'interface : nom, hôte, port, utilisateur.
2. Le MCP génère une paire `ed25519`. La clé privée est chiffrée avec `VAULT_KEY` dans `DATA_DIR/servers.json`.
3. Colle la **commande d'installation** affichée dans une session ouverte sur le serveur, en tant que cet utilisateur. Sur une seule ligne, elle :
   - écrit la clé dans un fichier propre à SSH Gate, `~/.ssh/authorized_keys.d/ssh-gate`, précédée de `restrict,pty` (pas de redirection de ports, d'agent ni de X11 ; pseudo-terminal autorisé pour les terminaux) ;
   - ajoute avec sudo `/etc/ssh/sshd_config.d/10-ssh-gate.conf`, qui fait lire ce fichier à sshd **en plus** de `~/.ssh/authorized_keys` ;
   - vérifie la configuration (`sshd -t`, puis `sshd -T` pour s'assurer que le fichier dédié est pris en compte) avant de recharger sshd. Sinon, le réglage ajouté est retiré et sshd n'est pas rechargé.

   `~/.ssh/authorized_keys` n'est jamais modifié : tes propres clés n'en dépendent pas. Le système doit lire `/etc/ssh/sshd_config.d/` (cas par défaut sur Debian et Ubuntu).
4. **Tester la connexion** : l'empreinte de la clé d'hôte est enregistrée. Si elle change plus tard, la connexion est refusée. Changer l'hôte ou le port du serveur efface l'empreinte : il faut tester à nouveau. Le test limite aussi la ligne de la clé à l'adresse de SSH Gate vue par le serveur (`from="…"`) ; la nouvelle ligne est vérifiée par une seconde connexion, et remise dans son état d'origine si le serveur la refuse. Si l'adresse de SSH Gate change, seul son accès est coupé : recolle la commande d'installation.

Tant que la connexion n'a pas été testée, l'agent ne peut pas soumettre de commandes à ce serveur.

### Renouveler ou révoquer la clé

Depuis le menu « … » du serveur. Seul le fichier dédié est écrit, par un fichier temporaire renommé.

- **Renouveler la clé** : SSH Gate génère une nouvelle paire, l'ajoute à côté de l'actuelle, l'essaie sur une seconde connexion, puis ne garde qu'elle. Un échec avant la dernière étape retire la ligne ajoutée : la clé actuelle continue de fonctionner. Refusé si la clé figure aussi dans `~/.ssh/authorized_keys`, où elle resterait valable.
- **Révoquer la clé** : SSH Gate vide son fichier, vérifie que le serveur refuse désormais la clé, ferme son shell et ses terminaux, puis efface la paire. Le serveur reste dans la liste ; « Installer une clé » en génère une nouvelle. Si le serveur ne répond pas, l'interface donne la commande à lancer soi-même (`: > ~/.ssh/authorized_keys.d/ssh-gate`) puis efface la clé.

## Les outils

| Outil | Rôle |
|---|---|
| `list_servers` | Serveurs configurés, si leur connexion a été testée, et leurs notes. |
| `update_server_notes` | Complète (`append`, par défaut) ou réécrit (`replace`) les notes d'un serveur. |
| `submit_commands` | Soumet 1 à 20 commandes avec une explication. Rien ne s'exécute avant ta validation. Renvoie un `request_id`. |
| `wait_for_result` | Attend ta décision et la fin de l'exécution, puis renvoie le refus et son motif, ou chaque commande avec son code de retour et sa sortie, et ta note. Rend la main au bout de `timeout_seconds` (300 par défaut, 1800 au plus) : il suffit de le rappeler. |
| `enable_notifications` | Active les notifications de fin de demande et donne l'appel Monitor exact à lancer, en local comme derrière mcp-http-gateway. |
| `wait_for_notifications` | Réservé au veilleur du gateway, qui l'appelle en boucle ; l'agent ne l'appelle pas. |
| `cancel_request` | Retire une demande pas encore validée. |
| `get_history` | Dernières demandes d'un serveur, y compris les commandes que tu as tapées toi-même. |
| `reconnect_gui` | Relance l'interface si elle ne tourne plus, et donne son URL. |

## Notifications

Plutôt que d'attendre avec `wait_for_result`, l'agent peut continuer à travailler et être prévenu quand une demande qu'il a soumise est terminée : toutes ses commandes ont tourné, ou tu l'as refusée ou interrompue.

L'agent appelle `enable_notifications` une fois, puis lance l'appel Monitor que l'outil lui renvoie. Le veilleur ainsi armé tourne sur la machine de l'agent et écrit une ligne par demande terminée, ce qui réveille l'agent, même inactif :

```
[ssh-gate] pxp-dev — request 0mwavl7lb-419091 completed: 4/4 command(s) succeeded — read it with wait_for_result, request_id 0mwavl7lb-419091
```

L'agent lit ensuite le résultat avec `wait_for_result`, qui répond aussitôt.

**En local**, `enable_notifications` dépose un relais dans `~/.mcp-ssh-gate/watch/` (le dossier de données et le point de reprise, aucun secret) et renvoie la commande `mcp-ssh-gate --watch <session>`. Ce veilleur lit directement les demandes dans `DATA_DIR` et n'annonce que celles de **sa** session.

**Derrière mcp-http-gateway**, la veille suit la [convention du gateway](https://www.npmjs.com/package/@imenam/mcp-http-gateway), comme mcp-telegram :

1. `enable_notifications` déclare la propriété réservée `_gateway_watch`. Le relais la remplit, et l'outil répond par une spécification de veille (`_meta["gateway/watch"]`) qui désigne l'outil d'attente `wait_for_notifications` et le point de reprise.
2. Le relais dépose le fichier de veille sur la machine de l'agent et lui rend l'appel Monitor `npx -y @imenam/mcp-http-gateway --watch <fichier>`.
3. Ce veilleur appelle en boucle `wait_for_notifications` à travers le gateway. Chaque appel attend au plus 50 s une demande terminée, et renvoie les lignes et le nouveau point de reprise dans `_meta["gateway/events"]`.

`wait_for_notifications` est réservé au veilleur : l'agent ne l'appelle pas. Derrière un gateway, un seul processus SSH Gate sert tous les agents de ce gateway : le veilleur de chacun annonce les demandes soumises par tous.

Dans les deux modes, un point de reprise évite les doublons. L'hôte arrête un Monitor au bout de 30 minutes ; une demande terminée pendant que le veilleur était arrêté est annoncée dès qu'il est relancé. Les demandes que l'agent a retirées ne sont pas annoncées. Une commande que tu tapes toi-même ne l'est que si tu cliques sur **Envoyer à l'agent** sous son résultat : elle est alors annoncée à tous les agents qui ont activé les notifications.

```
[ssh-gate] pxp-dev — the user shared 1 command(s) they ran themselves (request 0mwb2k1qa-7f03c2), completed: 1/1 command(s) succeeded — read it with wait_for_result, request_id 0mwb2k1qa-7f03c2
```

## Notes du serveur

Chaque serveur porte des notes en texte libre : dossier des sites, gestion des applis (PM2, systemd…), emplacement des configurations, règles à respecter. L'agent les reçoit avec `list_servers` avant d'intervenir et les complète avec `update_server_notes` quand il découvre quelque chose d'utile ; tu les lis et les modifies dans l'onglet **Notes** du serveur.

Les notes sont limitées à 20 000 caractères. Une modification faite dans l'interface est refusée si l'agent a changé les notes pendant la saisie, pour ne pas écraser sa mise à jour.

## Exécution

- Les commandes validées s'exécutent **dans l'ordre**, dans un shell `bash -l` **persistant** par serveur : un `cd` ou un `export` reste actif pour les commandes et les demandes suivantes.
- **Pas de terminal** : l'entrée standard est `/dev/null` (une commande qui attend une saisie reçoit une fin de fichier), stderr est fusionné dans stdout. `sudo` doit être configuré sans mot de passe pour l'utilisateur SSH.
- Chaque commande est d'abord vérifiée avec `bash -n` : une erreur de syntaxe l'arrête sans rien exécuter.
- Le lot **s'arrête à la première commande** dont le code de retour n'est pas 0 ; les suivantes sont marquées « non exécutée ».
- **Interrompre (Ctrl+C)** envoie `SIGINT` aux processus lancés par le shell (`pkill -INT -P`, à installer sur le serveur s'il manque). Une boucle exécutée par le shell lui-même n'a pas de processus à interrompre : il faut fermer le shell.
- Chaque commande garde au plus 512 Ko de sortie (la fin) ; l'agent en reçoit les 20 000 derniers caractères.

## L'interface

- **Barre latérale** : les serveurs, l'état de leur shell, une pastille par demande en attente.
- **Journal** : chaque commande exécutée, son auteur (Agent ou Toi), son heure, son code de retour ; un clic déplie sa sortie.
- **Demande en attente** : l'explication de l'agent, les commandes numérotées. Au survol d'une ligne, le crayon la modifie (Entrée pour valider, Échap pour annuler) et la croix la retire. La note pour l'agent est jointe au résultat, ou sert de motif au refus.
- **Exécution en cours** : l'avancement commande par commande et la sortie en direct.
- **Onglets Session / Notes** dans l'en-tête du serveur ; la pastille de demande en attente reste visible sur « Session ».
- **Saisie manuelle** en bas d'écran : une commande tapée là s'exécute aussitôt dans le même shell, et l'agent la voit dans l'historique. La saisie reprend le focus à la fin de l'exécution. Le bouton **Envoyer à l'agent**, sous le résultat, le notifie de cette commande.
- **Coloration des commandes** dans la demande en attente, l'exécution et le journal : nom de commande, options, chaînes, variables, opérateurs, et en rouge les commandes sensibles (`sudo`, `rm`, `dd`, `chmod`, `kill`, `shutdown`…). Le champ de modification reste sans couleur.
- **Réglages** (engrenage en bas de la barre latérale) : choix de la palette de coloration — Sobre (par défaut), Contrastée, Vive, Minimale ou Aucune. Le choix s'applique immédiatement et vaut pour tous les navigateurs ; il est enregistré dans `DATA_DIR/settings.json`.

L'interface se met à jour par rafraîchissement périodique.

## Terminaux

L'entrée **Terminaux** de la barre latérale ouvre de vrais terminaux interactifs sur tes serveurs, un par onglet, plusieurs par serveur si besoin : `vim`, `htop`, `sudo` avec mot de passe et les couleurs fonctionnent. **Nouveau terminal** propose les serveurs dont la connexion a été testée.

- Chaque terminal a sa propre connexion SSH, avec la clé et l'empreinte du serveur, distincte du shell des demandes de l'agent.
- La session reste ouverte si tu fermes la page : en revenant, la fin de la sortie est réaffichée. Elle se termine avec **Fermer la session**, la croix de l'onglet, ou quand le shell distant s'arrête. Un arrêt du worker ferme tous les terminaux.
- **L'agent n'y a pas accès** : rien de ce qui s'y passe n'apparaît dans le journal ni dans les notifications.
- Le flux passe par une WebSocket (`/api/terminals/<id>/stream`), dont l'adresse est relative au chemin de la page. Le gateway manager la relaie vers le worker (le proxy local de proxy-setup ne relaie pas les WebSockets). Pour l'ouvrir, la page obtient d'abord un ticket à usage unique, valable 30 secondes, par `POST /api/terminals/<id>/ticket` : une page d'un autre site ne peut pas l'obtenir, et la poignée de main ne dépend pas de l'origine, que le worker ne connaît pas derrière un proxy.

## Architecture

- Chaque session d'agent lance son processus MCP ; **un seul worker** sert l'interface et exécute les commandes pour toutes. Il écrit un battement dans `DATA_DIR/gui.json` ; un processus MCP qui ne le voit plus en démarre un autre.
- Chaque processus MCP reçoit un identifiant de session, enregistré sur les demandes qu'il soumet : c'est ce qui permet au veilleur de n'annoncer que les demandes de sa session. Le veilleur local signale sa présence dans `DATA_DIR/watchers/`.
- Les demandes sont des fichiers JSON dans `DATA_DIR/requests/<serveur>/`, écrits par renommage atomique et modifiés sous verrou de fichier.
- Les sessions SSH vivent dans le worker. S'il s'arrête pendant une exécution, la demande est marquée en échec au démarrage suivant : le résultat des commandes en cours est inconnu.

## Développement

```bash
npm install
npm run build   # serveur et interface
npm test        # dont un test de bout en bout contre un faux serveur SSH qui exécute bash
```

## Publication

Chaque push sur `master`, merge de pull request compris, publie une nouvelle version sur npm (`.github/workflows/publish.yml`) : `npm ci`, build, tests, puis `npm version patch`, `npm publish`, et enfin le push sur `master` du commit et du tag de version. La publication passe par le trusted publishing de npm (OIDC, sans token), avec attestation de provenance. Un échec du build ou des tests arrête le workflow avant la montée de version ; un échec de `npm publish` l'arrête avant le push, si bien que relancer le run reprend la même version.

Sur npmjs.com, le paquet déclare ce workflow comme publieur de confiance (Settings → Trusted publishing → GitHub Actions : `Matthieu-Pesnot-Pin`, `mcp-ssh-gate`, `publish.yml`, avec `npm publish` dans les actions autorisées). Le commit de version est poussé avec `GITHUB_TOKEN` : si `master` est protégée, la règle doit autoriser GitHub Actions à y pousser.
