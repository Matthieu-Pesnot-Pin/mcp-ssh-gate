# @imenam/mcp-ssh-gate

Un agent propose des commandes à exécuter sur un serveur de production ; tu les lis, les modifies ou les refuses dans une interface web, et seules celles que tu valides partent sur le serveur, en SSH. Le résultat revient à l'agent sans copier-coller.

L'agent ne détient aucun accès au serveur. La paire de clés SSH est générée par le MCP à l'ajout d'un serveur ; tu poses la clé publique sur le serveur dans un fichier qui lui est propre, la clé privée reste chiffrée dans le MCP et n'est jamais affichée.

```
Agent ──submit_commands──▶  session (son propre shell, ouverte au premier envoi)  ──▶  file d'attente  ──▶  Interface : tu valides, modifies ou refuses
  ▲                                                        │
  └── notification + get_result ◀── sortie, code de retour ◀── SSH ─┘  (shell bash persistant de la session)
```

Chaque agent travaille dans **ses sessions** : un shell à lui par serveur, et des notifications limitées à ce qui s'y passe, même quand plusieurs agents partagent le même SSH Gate. Un seul veilleur par agent couvre toutes ses sessions.

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

Ajoute le MCP à une gateway avec ces variables, et coche **secret** pour `VAULT_KEY` : le manager la stocke chiffrée avec sa clé maître et la réinjecte au lancement. `DATA_DIR` n'y figure pas : le manager le renseigne automatiquement, avec un dossier propre à ce MCP.

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
| `DATA_DIR` | — | **Requis.** Serveurs, clés chiffrées et historique des commandes. Créé s'il n'existe pas. Le MCP Gateway Manager le renseigne automatiquement. |
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
- **Révoquer la clé** : SSH Gate vide son fichier, vérifie que le serveur refuse désormais la clé, ferme les shells de ses sessions et ses terminaux, puis efface la paire. Le serveur reste dans la liste ; « Installer une clé » en génère une nouvelle. Si le serveur ne répond pas, l'interface donne la commande à lancer soi-même (`: > ~/.ssh/authorized_keys.d/ssh-gate`) puis efface la clé.

## Les outils

| Outil | Rôle |
|---|---|
| `list_servers` | Serveurs configurés, si leur connexion a été testée, les sessions d'agent ouvertes et leurs notes. |
| `update_server_notes` | Complète (`append`, par défaut) ou réécrit (`replace`) les notes d'un serveur. |
| `close_session` | Ferme une session : son shell est fermé et ses demandes en attente sont retirées. Refusé tant qu'une demande de la session s'exécute. Son journal reste consultable dans l'interface pendant 36 h. |
| `submit_commands` | Soumet 1 à 20 commandes avec une explication, dans la session donnée par `session_id`. Sans `session_id`, ouvre d'abord une session sur le serveur `server`, sous le nom court `session_name` que tu vois dans l'interface (40 caractères au plus), et renvoie son `session_id` (`sh_…`) avec la demande. L'ouverture d'une session exige l'`agent_id` (`ag_…`) donné par `enable_notifications` : la session est rattachée au veilleur de l'agent. Rien ne s'exécute avant ta validation, sauf si la [liste blanche](#liste-blanche) du serveur, en mode Active, couvre toutes les commandes. Renvoie un `request_id`. |
| `get_result` | Renvoie aussitôt le résultat d'une demande terminée : le refus et son motif, ou chaque commande avec son code de retour et sa sortie, et ta note. Pour une demande pas encore terminée, renvoie son état, sans attendre. S'utilise toujours avec les notifications activées : c'est la notification qui dit quand l'appeler. |
| `enable_notifications` | Premier appel de la conversation. Sans `agent_id`, crée l'identifiant de l'agent (`ag_…`) et le renvoie ; avec, réutilise celui-là. Active les notifications de toutes les sessions de l'agent (fin de demande, commande que tu lui envoies, demande d'explication, fermeture d'une session par toi) et donne l'appel Monitor exact à lancer, en local comme derrière mcp-http-gateway. |
| `answer_question` | Répond à une demande d'explication posée depuis l'interface sur une instruction ; la réponse s'affiche sous l'instruction. |
| `wait_for_notifications` | Réservé au veilleur du gateway, qui l'appelle en boucle ; l'agent ne l'appelle pas. |
| `cancel_request` | Retire une demande pas encore validée. |
| `get_history` | Dernières demandes d'un serveur, y compris les commandes que tu as tapées toi-même. |
| `reconnect_gui` | Relance l'interface si elle ne tourne plus, et donne son URL. |

## Notifications

L'agent ne bloque jamais sur une demande : il continue à travailler et est prévenu quand une demande qu'il a soumise est terminée — toutes ses commandes ont tourné, ou tu l'as refusée ou interrompue.

Les notifications sont celles d'**un agent** : chaque agent ne reçoit que ce qui se passe dans ses sessions, quel que soit le nombre d'agents branchés sur le même SSH Gate.

L'agent commence la conversation par `enable_notifications`, sans argument : l'outil crée l'identifiant de l'agent (`ag_…`) et le renvoie avec l'appel Monitor à lancer. Les `instructions` du serveur MCP, lues par l'agent dès la connexion, le lui demandent. L'agent lance ce Monitor, puis passe l'`agent_id` à chaque `submit_commands` qui ouvre une session (sans lui, l'ouverture est refusée) : la session est rattachée à son identité, et le veilleur déjà armé l'annonce sans rien relancer. Ce veilleur tourne sur la machine de l'agent et écrit une ligne par événement, qui nomme le serveur et la session ; chaque ligne réveille l'agent, même inactif :

```
[ssh-gate] pxp-dev · session sh_7f3a91c2 — request 0mwavl7lb-419091 completed: 4/4 command(s) succeeded — read it with get_result, request_id 0mwavl7lb-419091
```

L'agent lit ensuite le résultat avec `get_result`.

**En local**, `enable_notifications` dépose un relais dans `~/.mcp-ssh-gate/watch/` (le dossier de données et le point de reprise, aucun secret) et renvoie la commande `mcp-ssh-gate --watch <agent_id>`. Ce veilleur lit directement les demandes dans `DATA_DIR` et n'annonce que celles des sessions de **son** agent, y compris celles ouvertes après son lancement ; la fermeture d'une session ne l'arrête pas.

**Derrière mcp-http-gateway**, la veille suit la [convention du gateway](https://www.npmjs.com/package/@imenam/mcp-http-gateway), comme mcp-telegram :

1. `enable_notifications` déclare la propriété réservée `_gateway_watch`. Le relais la remplit, et l'outil répond par une spécification de veille (`_meta["gateway/watch"]`) qui désigne l'outil d'attente `wait_for_notifications`, ses arguments (`agent_id`), le point de reprise, et un `message` qui donne son identifiant à l'agent.
2. Le relais dépose le fichier de veille sur la machine de l'agent et lui rend l'appel Monitor `npx -y @imenam/mcp-http-gateway --watch <fichier>`, suivi de ce message.
3. Ce veilleur appelle en boucle `wait_for_notifications` à travers le gateway. Chaque appel attend au plus 50 s une demande terminée, et renvoie les lignes et le nouveau point de reprise dans `_meta["gateway/events"]`.

`wait_for_notifications` est réservé au veilleur : l'agent ne l'appelle pas. Derrière un gateway, un seul processus SSH Gate sert tous les agents de ce gateway ; c'est l'`agent_id` passé à chaque appel qui désigne les sessions à suivre. Le relais remplace la réponse d'`enable_notifications` par ses propres consignes et n'y ajoute que le `message` de la spécification : il faut une version de mcp-http-gateway qui le prend en charge pour que l'agent reçoive son identifiant.

Dans les deux modes, un point de reprise évite les doublons. L'hôte arrête un Monitor au bout de 30 minutes ; une demande terminée pendant que le veilleur était arrêté est annoncée dès qu'il est relancé. Les demandes que l'agent a retirées ne sont pas annoncées. Une commande que tu tapes toi-même dans la session d'un agent ne l'est que si tu cliques sur **Envoyer à l'agent** sous son résultat : elle est alors annoncée à cet agent seul. Une commande tapée dans ta session « Vous » n'est annoncée à personne.

```
[ssh-gate] pxp-dev · session sh_7f3a91c2 — the user shared 1 command(s) they ran themselves in this session (request 0mwb2k1qa-7f03c2), completed: 1/1 command(s) succeeded — read it with get_result, request_id 0mwb2k1qa-7f03c2
```

Une **demande d'explication** posée depuis l'interface est annoncée à l'agent de la session de la commande. L'agent répond avec `answer_question` ; tant qu'il n'a pas répondu, tu peux retirer la question. Les commandes de ta session « Vous » n'ont pas de bouton **Expliquer** : aucun agent n'y répondrait. Dans une session fermée, la question part au veilleur de l'agent qui l'avait ouverte ; le bouton est grisé quand aucun veilleur de cet agent ne tourne.

Quand tu fermes une session depuis l'interface, son agent en est prévenu ; son veilleur continue de suivre ses autres sessions :

```
[ssh-gate] pxp-dev · session sh_7f3a91c2 — the user closed your session "deploy shop": its shell is gone and its pending requests were withdrawn. Open a new session with submit_commands (server, session_name and your agent_id) if you still need to run commands on pxp-dev.
```

```
[ssh-gate] pxp-dev · session sh_7f3a91c2 — the user asks you to explain part of command 1/2 of request 0mwb2k1qa-7f03c2: df -h / — answer with answer_question, request_id 0mwb2k1qa-7f03c2, question_id q_3fa2b1c0
```

## Notes du serveur

Chaque serveur porte des notes en texte libre : dossier des sites, gestion des applis (PM2, systemd…), emplacement des configurations, règles à respecter. L'agent les reçoit avec `list_servers` avant d'intervenir et les complète avec `update_server_notes` quand il découvre quelque chose d'utile ; tu les lis et les modifies dans le volet que le bouton **Notes du serveur** ouvre, dans le bandeau du serveur. Elles sont communes à toutes ses sessions.

Les notes sont limitées à 20 000 caractères. Une modification faite dans l'interface est refusée si l'agent a changé les notes pendant la saisie, pour ne pas écraser sa mise à jour.

## Exécution

- Les commandes validées s'exécutent **dans l'ordre**, dans le shell `bash -l` **persistant** de leur session : un `cd` ou un `export` reste actif pour les commandes et les demandes suivantes de la session, jamais dans les autres. Chaque serveur a ta session « Vous » et une session par agent qui en a ouvert une ; le shell d'une session s'ouvre à sa première commande.
- Une seule demande s'exécute à la fois par session ; deux sessions d'un même serveur peuvent tourner en parallèle.
- **Pas de terminal** : l'entrée standard est `/dev/null` (une commande qui attend une saisie reçoit une fin de fichier), stderr est fusionné dans stdout. `sudo` doit être configuré sans mot de passe pour l'utilisateur SSH.
- Chaque commande est d'abord vérifiée avec `bash -n` : une erreur de syntaxe l'arrête sans rien exécuter.
- Le lot **s'arrête à la première commande** dont le code de retour n'est pas 0 ; les suivantes sont marquées « non exécutée ».
- **Interrompre (Ctrl+C)** envoie `SIGINT` aux processus lancés par le shell (`pkill -INT -P`, à installer sur le serveur s'il manque). Une boucle exécutée par le shell lui-même n'a pas de processus à interrompre : il faut fermer le shell.
- Chaque commande garde au plus 512 Ko de sortie (la fin) ; l'agent en reçoit les 20 000 derniers caractères.

## Liste blanche

Une demande de l'agent dont **chaque partie de chaque commande** est couverte par la liste blanche s'exécute sans attendre ta validation. Elle se règle dans l'interface, entrée **Liste blanche** de la barre latérale (`#liste-blanche` pour la liste commune, `#liste-blanche/<serveur>` pour celle d'un serveur), et s'enregistre dans `DATA_DIR/whitelist.json`.

- **Deux niveaux** : une liste **commune** à tous les serveurs, et une liste propre à chaque serveur. Une partie est couverte si l'une des deux la couvre ; un mot « toujours refusé » de l'une vaut pour les deux.
- **Trois modes par serveur** : *Désactivée* (par défaut : tout reste à valider), *Observation* (rien ne part seul, mais chaque demande indique si elle aurait été approuvée, pour roder les règles) et *Active*.
- **Une règle par commande et par liste** :
  - *Toute utilisation*, ou *Seulement ces formes* : les arguments acceptés après la commande, mot à mot. `*` accepte n'importe quelle suite d'arguments à cet endroit (`status *`). Les options d'une forme peuvent apparaître dans n'importe quel ordre et `-rf` est lu comme `-r -f` ; sans `*`, aucune option en plus n'est acceptée.
  - *Toujours refuser* : mots ou options refusés même dans une forme acceptée (`--force`, `--output*` : un `*` final accepte tout suffixe). Un argument avec joker (`*.log`) n'est alors jamais couvert, puisqu'il pourrait devenir une option refusée.
  - *Autoriser avec sudo* : sans cette case, la même commande précédée de `sudo` n'est pas couverte.
- **Découpage** : la commande est lue par [sh-syntax](https://www.npmjs.com/package/sh-syntax), le parseur bash de mvdan/sh (celui de shfmt), puis découpée sur `&&`, `||`, `;`, `|`, `|&`, `&` et les sauts de ligne, contenu de `( … )` et `{ … }` compris. Avant comparaison, `sudo` est retiré (seules ses options `-n` et `-u` sont lues), un chemin des dossiers système (`/usr/bin/grep`) est ramené au nom et les guillemets sont retirés.
- **Jamais couvert**, quelle que soit la liste : variables (`$X`, `X=1 cmd`), substitutions (`$( )`, `` ` ` ``, `<( )`), redirections vers un fichier ou depuis un fichier (seuls `2>&1`, `>&2` et `> /dev/null` passent), documents intégrés (`<<`, `<<<`), `if`/`for`/`while`/`case`, fonctions, `export` et les autres commandes qui modifient le shell, les interpréteurs (`bash -c`, `sh`, `eval`, `source`, `exec`), les commandes qui en lancent d'autres (`xargs`, `env`, `nohup`, `timeout`, `watch`, `find -exec`…), un programme hors des dossiers système (`./script`) et toute commande illisible. Ces commandes ne peuvent pas non plus recevoir de règle.
- **Ordre** : seule la plus ancienne demande en attente de chaque session est examinée ; une demande couverte n'en dépasse jamais une autre restée à valider.
- **Exécution protégée** : une demande approuvée par la liste blanche s'exécute avec `\command` devant chaque commande simple, ce qui ignore les alias et les fonctions définis dans le shell de la session.
- **Dans la demande en attente**, le découpage montre chaque partie avec la règle qui la couvre ou la raison du refus ; **Autoriser…** ouvre la règle de la commande, pré-remplie avec la forme demandée, dans la liste du serveur ou la liste commune. La demande est réévaluée à l'enregistrement. Dans le journal, une demande approuvée par la liste blanche porte la puce « Auto · liste blanche ». L'agent est prévenu dans le résultat (`get_result`).
- **Tester une commande**, en bas de la page, montre son découpage et son verdict avec la liste de l'onglet affiché.

## L'interface

- **Barre latérale** : les serveurs, et sous chacun ses terminaux puis ses sessions — « Vous », puis celles des agents, sous le nom qu'ils leur ont donné. Une session porte une pastille par demande en attente, ou une roue pendant une exécution. Seul le chevron, à gauche de la ligne, replie ou déplie les sessions d'un serveur ; replié, le serveur montre le total de ses demandes en attente. Un clic sur le reste de la ligne ouvre la session qui a une demande en attente ; sans demande en attente, le dernier onglet consulté dans ce serveur (une session ou ses terminaux, retenu par le navigateur), ou à défaut la session d'agent ouverte le plus récemment, puis « Vous ». Sous les sessions ouvertes, l'en-tête **Fermées** replie ou déplie les sessions d'agent fermées depuis moins de 36 h, les plus récentes d'abord, chacune avec le temps écoulé depuis sa fermeture. Le bord droit de la barre se glisse pour l'élargir ou la rétrécir, et un double-clic lui rend sa largeur par défaut ; la largeur est gardée dans un cookie du navigateur. L'adresse de la page désigne la session : `#/<serveur>` pour « Vous », `#/<serveur>/<session_id>` pour une session d'agent.
- **Bandeau du serveur**, en haut : son nom, son hôte, le bouton **Notes du serveur** et le menu du serveur (clé, modification, fermeture des shells, suppression). Il reste le même quelle que soit la session choisie.
- **En-tête de la session**, sous le bandeau : son nom, « Agent » ou « Ta session », le dossier courant de son shell (ou « shell fermé »), et pour une session d'agent le bouton **Fermer la session**. Fermer une session qui a des demandes en attente demande confirmation, car elles sont retirées ; une session dont une commande s'exécute ne se ferme pas. Une session fermée porte la puce « Fermée », le dernier dossier connu de son shell, qui l'a fermée et le délai avant son effacement.
- **Journal** de la session : l'explication de l'agent au-dessus de chaque demande (exécutée, refusée ou retirée), puis chaque commande exécutée, son auteur (Agent ou Toi), son heure, son code de retour ; un clic déplie sa sortie et affiche la commande en entier, sur plusieurs lignes si besoin. Il reste consultable dans une session fermée, avec le bouton **Expliquer**.
- **Demande en attente** : l'explication de l'agent, les commandes numérotées. Au survol d'une ligne, le crayon la modifie (Entrée pour valider, Échap pour annuler) et la croix la retire. La note pour l'agent est jointe au résultat, ou sert de motif au refus.
- **Exécution en cours** : l'explication de l'agent, l'avancement commande par commande et la sortie en direct.
- **Notes du serveur** : un volet à droite de la session, ouvert et fermé par le bouton du bandeau ; il reste ouvert quand tu passes d'une session à l'autre du même serveur.
- **Saisie manuelle** en bas d'écran : une commande tapée là s'exécute aussitôt dans le shell de la session affichée, et l'agent la voit dans l'historique. La saisie reprend le focus à la fin de l'exécution. Dans la session d'un agent, le bouton **Envoyer à l'agent**, sous le résultat, notifie cet agent de la commande. Une session fermée est en lecture seule : la saisie laisse place au bandeau « Lecture seule ».
- **Expliquer une instruction** : dans la demande en attente et le journal déplié, en mode *Sauts de ligne automatiques*, chaque instruction (partie de commande délimitée par `;`) affiche au survol un bouton **Expliquer** (toujours visible sur téléphone). La question part à l'agent par les notifications ; sa réponse s'affiche sous l'instruction, et la croix la masque. En mode *Brutes*, il n'y a pas de bouton : les explications déjà reçues suivent la commande.
- **Coloration des commandes** dans la demande en attente, l'exécution et le journal : nom de commande, options, chaînes, variables, opérateurs, et en rouge les commandes sensibles (`sudo`, `rm`, `dd`, `chmod`, `kill`, `shutdown`…). Le champ de modification reste sans couleur.
- **Réglages** (engrenage en bas de la barre latérale), appliqués immédiatement et valables pour tous les navigateurs ; ils sont enregistrés dans `DATA_DIR/settings.json` :
  - **Coloration des commandes** : Sobre (par défaut), Contrastée, Vive, Minimale ou Aucune.
  - **Commandes longues**, dans la demande en attente et le journal déplié : *Sauts de ligne automatiques* (par défaut) passe à la ligne avant chaque `&&` et `||` (décalés sous la commande qu'ils prolongent), après chaque `;` (suivi d'un léger espace vertical qui sépare les instructions indépendantes) et après un `\` de continuation ; un opérateur entre guillemets ou un `\;` ne coupe pas la ligne. *Brutes* affiche la commande telle qu'écrite.

L'interface se met à jour par rafraîchissement périodique.

## Terminaux

L'entrée **Terminaux** de la barre latérale ouvre de vrais terminaux interactifs sur tes serveurs, un par onglet, plusieurs par serveur si besoin : `vim`, `htop`, `sudo` avec mot de passe et les couleurs fonctionnent. **Nouveau terminal** propose les serveurs dont la connexion a été testée.

Chaque serveur a aussi sa ligne **Terminaux**, au-dessus de « Vous » : elle n'affiche que les terminaux de ce serveur, et **Nouveau terminal** y ouvre directement un terminal sur lui.

- Chaque terminal a sa propre connexion SSH, avec la clé et l'empreinte du serveur, distincte du shell des demandes de l'agent.
- La session reste ouverte si tu fermes la page : en revenant, la fin de la sortie est réaffichée. Elle se termine avec **Fermer la session**, la croix de l'onglet, ou quand le shell distant s'arrête. Un arrêt du worker ferme tous les terminaux.
- **L'agent n'y a pas accès** : rien de ce qui s'y passe n'apparaît dans le journal ni dans les notifications.
- Le flux passe par une WebSocket (`/api/terminals/<id>/stream`), dont l'adresse est relative au chemin de la page. Le gateway manager la relaie vers le worker (le proxy local de proxy-setup ne relaie pas les WebSockets). Pour l'ouvrir, la page obtient d'abord un ticket à usage unique, valable 30 secondes, par `POST /api/terminals/<id>/ticket` : une page d'un autre site ne peut pas l'obtenir, et la poignée de main ne dépend pas de l'origine, que le worker ne connaît pas derrière un proxy.

## Architecture

- Chaque agent branché en local lance son processus MCP ; derrière un gateway, un seul processus sert tous les agents. **Un seul worker** sert l'interface et exécute les commandes pour tous. Il écrit un battement dans `DATA_DIR/gui.json` ; un processus MCP qui ne le voit plus en démarre un autre.
- Les sessions d'agent sont des fichiers JSON dans `DATA_DIR/sessions/<session_id>.json` : serveur, agent, nom, ouverture, et fermeture (date, et qui l'a fermée). Les identités d'agent sont dans `DATA_DIR/agents/<agent_id>.json`. L'identifiant de session est enregistré sur les demandes, et celui de l'agent sur les sessions : c'est ce qui permet au veilleur de n'annoncer que les demandes des sessions de son agent. Le veilleur, local ou derrière un gateway, signale sa présence dans `DATA_DIR/watchers/`. Une session fermée depuis plus de 36 h est effacée avec les demandes de son journal : le worker de l'interface fait ce ménage à son démarrage puis toutes les 10 minutes.
- La liste blanche est dans `DATA_DIR/whitelist.json` ; le worker examine chaque seconde les demandes en attente des serveurs en mode Active.
- Les demandes sont des fichiers JSON dans `DATA_DIR/requests/<serveur>/`, écrits par renommage atomique et modifiés sous verrou de fichier.
- Les shells vivent dans le worker, un par session. Quand un agent ferme sa session, le worker ferme son shell au rafraîchissement suivant de l'interface. Si le worker s'arrête pendant une exécution, la demande est marquée en échec au démarrage suivant : le résultat des commandes en cours est inconnu.

## Développement

```bash
npm install
npm run build   # serveur et interface
npm test        # dont un test de bout en bout contre un faux serveur SSH qui exécute bash
```

## Publication

Chaque push sur `master`, merge de pull request compris, publie une nouvelle version sur npm (`.github/workflows/publish.yml`) : `npm ci`, build, tests, puis `npm version patch`, `npm publish`, et enfin le push sur `master` du commit et du tag de version. La publication passe par le trusted publishing de npm (OIDC, sans token), avec attestation de provenance. Un échec du build ou des tests arrête le workflow avant la montée de version ; un échec de `npm publish` l'arrête avant le push, si bien que relancer le run reprend la même version.

Sur npmjs.com, le paquet déclare ce workflow comme publieur de confiance (Settings → Trusted publishing → GitHub Actions : `Matthieu-Pesnot-Pin`, `mcp-ssh-gate`, `publish.yml`, avec `npm publish` dans les actions autorisées). Le commit de version est poussé avec `GITHUB_TOKEN` : si `master` est protégée, la règle doit autoriser GitHub Actions à y pousser.
