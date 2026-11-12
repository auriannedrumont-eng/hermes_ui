# Hermes Chat Service

Mini-service socket.io (port **3003**) qui alimente l'interface web **Hermes Web** : gestion des conversations, tours de chat en streaming, **artefacts** (fichiers générés, versionnés, rendus par chrome-headless-shell), **projets** (rangement des conversations), réglages serveur, persistance SQLite et connexion à l'agent Hermes.

## Démarrage

```bash
cd mini-services/hermes-chat
bun install
bun run dev   # bun --hot index.ts → http://localhost:3003
```

## Deux modes de fonctionnement

| Mode | Condition | Comportement |
| --- | --- | --- |
| **Gateway** | `HERMES_GATEWAY_URL` défini et joignable | Les tours sont envoyés à l'agent Hermes réel (protocole `api_turn_v1`), avec événements d'outils et raisonnement |
| **Démo** (défaut) | Aucune URL configurée ou gateway injoignable | Réponses générées par le LLM intégré (`z-ai-web-dev-sdk`, serveur uniquement) avec un persona Hermes |

L'interface affiche le mode actif dans la sidebar (« Mode démo · LLM intégré » ou « Gateway Hermes connectée »).

## Brancher une gateway Hermes réelle

```bash
# URL du listener WebSocket de la gateway Hermes (cf. gateway/run_api.py — endpoint /api/ws)
HERMES_GATEWAY_URL=ws://127.0.0.1:9120/api/ws
# Facultatif : jeton / ticket de session si la gateway en exige un
HERMES_GATEWAY_TOKEN=...
```

Le connecteur (`hermes-connector.ts`) implémente le protocole de tour documenté dans
`gateway/session_api_turn.py` du repo [hermes-agent](https://github.com/NousResearch/hermes-agent) :

1. **Admission** — envoi de l'enveloppe `{"text": ..., "api_turn_v1": {"history": [...], "settings": {...}}}`
2. **Observation** — écoute des deltas de stream, du raisonnement, des événements d'outils et de la fin de tour
3. **Repli** — si la gateway est injoignable ou expire, bascule automatique en mode démo avec un message de statut

> Note : la poignée de main exacte (ticket de session) dépend de votre version de la gateway.
> Ajustez `toWsUrl()` et les en-têtes d'authentification dans `hermes-connector.ts` si nécessaire.
> La cartographie des événements est volontairement tolérante (`stream_delta`, `delta`, `text`, `event/type`, …).

## Artefacts — les fichiers générés, objets de première classe

Quand l'agent émet un bloc de code annoté avec un nom de fichier
(```html file="rapport-ventes.html"` … ```) — ou un bloc HTML/SVG volumineux
(≥ 400 caractères, auto-détecté) — le service en fait un **artefact** :

- **Carte compacte** dans le message : états *génération* (squelette + code qui
  streame dans la carte) → *rendu* → *prêt* (vignette + actions), ou *erreur*
  (bouton Réessayer). Le bloc disparaît du flux de conversation.
- **Versioning** : réémettre le même nom de fichier crée **v2 sur la même carte**
  (sélecteur de version dans le panneau, diff ligne à ligne pour le code).
- **Panneau dédié** (split view ≈ 45 %, ouverture automatique à la naissance) :
  HTML → aperçu = **PNG plein page rendu par chrome-headless-shell** + export
  **PDF vectoriel** (texte sélectionnable) ; code (coloration, numéros, wrap),
  Markdown, CSV (tableau), JSON, SVG/image (zoom), PDF (visionneuse).
- Le badge **« Rendu Chrome »** garantit que l'aperçu = le fichier téléchargé.

Pipeline de rendu (`render.ts`) : client CDP minimal sur `ws` (aucune
dépendance puppeteer), navigateur singleton, rends sérialisés, profil
`--user-data-dir` unique par incarnation (un chrome orphelin ne verrouille
jamais le suivant). Binaire résolu depuis `CHROME_HEADLESS_PATH` ou le cache
Playwright. Validé par le benchmark `upload/benchmark-extracted/benchmark-rendu`.

### Événements socket artefacts

Client → serveur :

| Événement | Charge utile | Réponse (ack) |
| --- | --- | --- |
| `artifacts:list` | `{conversationId}` | `{artifacts: Artifact[]}` (toutes versions, métadonnées sans contenu) |
| `artifact:versions` | `{conversationId, key}` | `{versions: Artifact[]}` |
| `artifact:retry` | `{conversationId, artifactId}` | `{ok}` — relance le rendu Chrome d'un HTML en erreur |

Serveur → client :

| Événement | Charge utile |
| --- | --- |
| `artifact:created` | `{conversationId, messageId, artifact}` — naissance (statut `generating` ou `rendering`) |
| `artifact:delta` | `{conversationId, messageId, key, delta}` — source qui streame dans la carte |
| `artifact:updated` | `{conversationId, artifact}` — transitions d'état, vignette, PDF, nouvelles versions |

Les messages assistant embarquent `artifacts: Artifact[]` (cartes ancrées,
dernière version de chaque clé ; `anchorMessageId` désigne le message où vit
la carte). Un artefact régénéré reste ancré sur la carte d'origine.

### HTTP (port 3004)

| Route | Rôle |
| --- | --- |
| `GET /artifacts/<id>/raw` | source brute (texte ; SVG servi en `image/svg+xml` derrière un CSP `default-src 'none'`) |
| `GET /artifacts/<id>/download` | téléchargement de la source (attachment) |
| `GET /artifacts/<id>/thumb` | vignette PNG (rendu plein page pour le HTML) |
| `GET /artifacts/<id>/pdf` | export PDF vectoriel (HTML) |
| `GET /artifacts/zip?ids=a,b,c` | archive « tout télécharger » (source + PDF) |

Le HTML généré n'est **jamais** servi comme `text/html` (zéro XSS dans l'UI) :
l'aperçu est une image rendue côté serveur.

### Schéma SQL

Table `artifacts` : une ligne par version — `(conversation_id, key, version)`
unique ; `content` (source), `status` (`generating`/`rendering`/`ready`/`error`),
fichiers dérivés sur disque dans `db/artifacts/<id>.{png,pdf}`. La suppression
d'une conversation purge lignes et fichiers ; le fork duplique les artefacts
en ré-ancrant les messages.

## Projets — ranger les conversations

Les conversations peuvent être rangées dans des **projets** (groupes repliables
de la sidebar). C'est une pure couche de rangement : le moteur de tours, le
streaming, le fork et la recherche fonctionnent à l'identique.

- Un fork **hérite du projet** de sa conversation d'origine.
- Supprimer un projet **conserve** les conversations (elles retombent dans
  « Sans projet »).
- `conversations:create` accepte un `projectId` optionnel (l'ancien appel
  sans payload reste supporté).

### Événements socket projets & réglages

Client → serveur :

| Événement | Charge utile | Réponse (ack) |
| --- | --- | --- |
| `projects:list` | — | `{projects: Project[]}` (triés par `position`) |
| `projects:create` | `{name}` | `{project}` (broadcast `projects:created`) |
| `projects:rename` | `{id, name}` | `{project}` (broadcast `projects:renamed`) |
| `projects:delete` | `{id}` | `{ok, id}` (broadcast `projects:deleted`) |
| `projects:reorder` | `{ids}` | `{projects}` (broadcast `projects:reordered`) |
| `conversations:move` | `{id, projectId}` | `{conversation}` (broadcast `conversations:moved`) |
| `settings:get` | `{key?}` | `{value}` ou `{settings: [...]}` si sans clé |
| `settings:set` | `{key, value}` | `{ok, key, value}` (broadcast `settings:changed`) |

Les réglages serveur suivent le découpage `hermes.*` / `fork.*` documenté
dans le `FORK.md` du repo (registre source de vérité : `src/lib/settings.ts`).

## Protocole socket.io

Client → serveur :

| Événement | Charge utile | Réponse (ack) |
| --- | --- | --- |
| `hello` | — | `{app, version, mode, model, gatewayUrl}` |
| `conversations:list` | — | `{conversations}` (inclut `projectId`) |
| `conversations:create` | `{projectId?}` (optionnel) | `{conversation}` |
| `conversations:rename` | `{id, title}` | `{conversation}` |
| `conversations:delete` | `{id}` | `{ok, id}` |
| `conversations:open` | `{id}` | `{conversationId, messages}` |
| `conversations:pin` | `{id, pinned}` | `{conversation}` (broadcast `conversations:pinned`) |
| `conversations:fork` | `{conversationId, fromMessageId?}` | `{conversation}` (broadcast `conversations:created`) |
| `conversations:search` | `{query}` | `{results: SearchHit[]}` (recherche plein-texte) |
| `chat:send` | `{conversationId, content, model?, attachments?}` | (stream, voir ci-dessous) |
| `chat:stop` | `{conversationId}` | — |
| `chat:regenerate` | `{conversationId, model?}` | `{ok}` (relance depuis le dernier message utilisateur) |
| `message:edit` | `{conversationId, messageId, content, model?}` | `{ok, message, removedIds}` (tronque et relance) |
| `message:delete` | `{conversationId, messageId}` | `{ok, messageId}` (broadcast `message:deleted`) |
| `models:list` | — | `{models, defaultModel, source}` |
| `attachments:upload` | `{name, mime, dataBase64}` | `{attachment}` (transcription ASR auto si audio) |
| `audio:transcribe` | `{dataBase64, mime?}` | `{text}` (dictée vocale) |

Serveur → client (pendant un tour) :

| Événement | Charge utile |
| --- | --- |
| `stream:start` | `{conversationId, messageId, model}` |
| `stream:delta` | `{conversationId, messageId, delta}` |
| `stream:reasoning` | `{conversationId, messageId, delta}` |
| `stream:status` | `{conversationId, messageId, status}` |
| `stream:tool` | `{conversationId, messageId, event: {name, status, detail, at}}` |
| `stream:done` | `{conversationId, messageId, conversation, message}` |
| `stream:error` | `{conversationId, messageId, error}` |

Serveur → client (autres) :

| Événement | Charge utile |
| --- | --- |
| `message:appended` | `{conversationId, message}` (message utilisateur persisté) |
| `message:deleted` | `{conversationId, messageId}` |
| `messages:removed` | `{conversationId, messageIds}` (régénération) |
| `message:updated` | `{conversationId, message, removedIds}` (édition) |
| `conversations:created` | `{conversation}` (fork, nouvelle conversation) |
| `conversations:pinned` | `{conversation}` |
| `conversations:deleted` | `{id}` |
| `conversations:moved` | `{conversation}` (changement de projet) |
| `projects:created` / `projects:renamed` / `projects:deleted` / `projects:reordered` | cycle de vie des projets |
| `settings:changed` | `{key, value}` |

## Transcription audio (ASR)

Les pièces jointes audio sont **transcrites automatiquement** à l'upload
(champ `transcript` de la pièce jointe, affiché dans la bulle) et la dictée
vocale de l'interface passe par l'événement `audio:transcribe`. L'API ASR
n'accepte que WAV/WebM : les autres formats (mp3, m4a, ogg, flac…) sont
convertis en WAV 16 kHz mono via `ffmpeg` si disponible (sinon échec doux).

## Persistance

Base SQLite dans `../../db/hermes-chat.sqlite` (tables `conversations`, `messages`,
`artifacts`, `projects`, `settings`), créée automatiquement au premier
démarrage — les migrations sont **additives** (`CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE … ADD COLUMN`, jamais destructrices). Les fichiers dérivés
des artefacts (PNG / PDF) vivent dans `../../db/artifacts/`. Supprimez la base
pour repartir de zéro.

## Structure

- `index.ts` — serveur socket.io + gestion des tours (envoi, régénération, édition) + HTTP artefacts
- `store.ts` — persistance SQLite (bun:sqlite) : conversations, messages, **artefacts versionnés**, **projets**, réglages, épinglage, fork, recherche
- `artifacts.ts` — extraction des blocs fichier du contenu de l'agent (annotés ou auto-détectés), suivi de streaming, payloads wire
- `render.ts` — pipeline chrome-headless-shell (client CDP minimal) : PNG plein page + PDF vectoriel
- `hermes-connector.ts` — résolution du mode (gateway / démo) + protocole Hermes
- `demo-engine.ts` — LLM intégré avec streaming SSE (z-ai-web-dev-sdk, serveur uniquement)
- `asr.ts` — transcription audio (ASR + conversion ffmpeg)
- `uploads.ts` — pièces jointes multimédia (disque, service HTTP, nettoyage)
- `types.ts` — types partagés (miroir : `src/lib/chat-types.ts` côté frontend)
