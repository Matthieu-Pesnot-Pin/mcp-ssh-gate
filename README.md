# @imenam/mcp-ssh-gate

Un agent propose des commandes à exécuter sur un serveur de production ; tu les lis, les modifies ou les refuses dans une interface web, et seules celles que tu valides partent sur le serveur, en SSH. Le résultat revient à l'agent sans copier-coller.

L'agent ne détient aucun accès au serveur. La paire de clés SSH est générée par le MCP à l'ajout d'un serveur ; tu poses la clé publique sur le serveur, la clé privée reste chiffrée dans le MCP et n'est jamais affichée.

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

### Derrière le gateway manager

Déclare le MCP comme les autres, et ajoute `VAULT_KEY` en cochant **secret** : le manager la stocke chiffrée avec sa clé maître et la réinjecte au lancement. Une clé se génère avec :

```bash
npx -y @imenam/mcp-ssh-gate --generate-vault-key
```

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
3. Copie la clé publique affichée dans `~/.ssh/authorized_keys` de l'utilisateur, sur le serveur (une commande prête à coller est proposée).
4. **Tester la connexion** : l'empreinte de la clé d'hôte est enregistrée. Si elle change plus tard, la connexion est refusée. Changer l'hôte ou le port du serveur efface l'empreinte : il faut tester à nouveau.

Tant que la connexion n'a pas été testée, l'agent ne peut pas soumettre de commandes à ce serveur.

## Les outils

| Outil | Rôle |
|---|---|
| `list_servers` | Serveurs configurés, si leur connexion a été testée, et leurs notes. |
| `update_server_notes` | Complète (`append`, par défaut) ou réécrit (`replace`) les notes d'un serveur. |
| `submit_commands` | Soumet 1 à 20 commandes avec une explication. Rien ne s'exécute avant ta validation. Renvoie un `request_id`. |
| `wait_for_result` | Attend ta décision et la fin de l'exécution, puis renvoie le refus et son motif, ou chaque commande avec son code de retour et sa sortie, et ta note. Rend la main au bout de `timeout_seconds` (300 par défaut, 1800 au plus) : il suffit de le rappeler. |
| `cancel_request` | Retire une demande pas encore validée. |
| `get_history` | Dernières demandes d'un serveur, y compris les commandes que tu as tapées toi-même. |
| `reconnect_gui` | Relance l'interface si elle ne tourne plus, et donne son URL. |

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
- **Saisie manuelle** en bas d'écran : une commande tapée là s'exécute aussitôt dans le même shell, et l'agent la voit dans l'historique.

L'interface se met à jour par rafraîchissement périodique.

## Architecture

- Chaque session d'agent lance son processus MCP ; **un seul worker** sert l'interface et exécute les commandes pour toutes. Il écrit un battement dans `DATA_DIR/gui.json` ; un processus MCP qui ne le voit plus en démarre un autre.
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
