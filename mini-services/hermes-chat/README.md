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
- **Versioning (F-26)** : réémettre le même nom de fichier crée **v2 sur la même carte**
  (sélecteur de version dans le panneau, diff ligne à ligne pour le code) ; chaque
  ré-émission au contenu identique de la version courante ne crée PAS de version ;
  le **badge v{n} de la carte** ouvre le **journal des versions** (popover) : épingler
  (étoile, jamais purgée), étiqueter (double-clic inline), restaurer (bouton unique,
  crée v(n+1) — jamais d'écrasement, marqueur ↩ + libellé auto « Restauration de vN »),
  télécharger n'importe quelle version ; quota 50 versions/fichier (purge FIFO des
  plus anciennes non épinglées, 10 épingles max) ; une seule version par tour et par
  fichier. Composant unique : `src/components/chat/version-popover.tsx`.
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
| `artifact:restore` | `{conversationId, key, version}` | `{artifact}` — crée v(n+1) d'après vN (libellé auto « Restauration de vN », marqueur ↩ ; le HTML repart par le rendu) ; purge du quota appliquée |
| `artifact:label` | `{artifactId, label}` | `{artifact}` — étiquette ≤ 80 car. (vide = efface) |
| `artifact:pin` | `{artifactId, pinned}` | `{artifact}` ou `{error}` — épinglage (10 max/fichier, jamais purgées) |

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
fichiers dérivés sur disque dans `db/artifacts/<id>.{png,pdf}`. Le journal des
versions (F-26) y ajoute trois colonnes additives : `label` (étiquette
humaine), `pinned` (épinglage), `restored_from` (↩ version d'origine d'une
restauration). La suppression d'une conversation purge lignes et fichiers ;
le fork duplique les artefacts (avec étiquettes et épingles) en ré-ancrant
les messages.

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
| `conversation:compact` | `{conversationId}` | **v2.4 : ack unique À LA FIN** `{ok: true, compact, done: true}` (échec `{ok: false, error}`) + broadcast `conversation:compacted`. NB socket.io : un emit-ack n'accepte qu'UN ack — le second appel (même id) est ignoré par le client. |
| `system:renderCache` | — | `{count, bytes}` (place des profils de rendu Chrome, v2.4) |
| `system:clearRenderCache` | — | `{count, bytes, removed, kept}` — purge (faite aussi à chaque démarrage) |

Les réglages serveur suivent le découpage `hermes.*` / `fork.*` documenté
dans le `FORK.md` du repo (registre source de vérité : `src/lib/settings.ts`).

## Fournisseurs & clés + Extensions (Paramètres v2.2)

Tables SQLite additives (`store.ts`) : `providers` (LLM et services d'API,
`kind` = `llm | service`, `strategy` = `fill_first | round_robin | least_used`),
`provider_keys` (le **secret ne quitte jamais le service** : seules les vues
masquées `masked` partent au navigateur, `status` = `untested | ok | error |
exhausted`), `extensions` (dépôts GitHub importés `repo` et serveurs `mcp` ;
`enabled` vs `applied` — un toggle ne devient effectif qu'au redémarrage du
service, le pied du volet compte les écarts).

- **« Tester » une clé = appel minimal réel** exécuté par le service
  (`providers.ts`) : liste des modèles du fournisseur (z.ai, OpenRouter,
  Anthropic, Mistral, OpenAI, DeepSeek, Groq, xAI…), requête minimale pour
  les services (Tavily, Exa, FAL.ai) ; 401/403 → « clé refusée »,
  429 → « limite atteinte » (clé marquée épuisée), `/models` Bearer pour
  toute adresse personnalisée.
- **Imports GitHub réels** : `extensions:add` résout le dépôt via l'API
  GitHub (nom, description, branche par défaut, tête, derniers commits,
  dernier tag) avec **repli automatique sur le protocole git**
  (`git ls-remote`) quand l'API est au quota — sans description ni commits
  dans ce cas. Jeton optionnel : `GITHUB_TOKEN` dans le `.env` du service
  (quota ×80).
- `pickActiveKey()` (stratégies de porte-clés) est prêt pour le moteur ;
  en mode démo les tours du LLM intégré ne consomment pas les pools.

### Événements socket fournisseurs & extensions

Client → serveur :

| Événement | Charge utile | Réponse (ack) |
| --- | --- | --- |
| `providers:list` | — | `{providers: ProviderView[]}` (avec clés masquées) |
| `providers:catalog` | — | `{catalog: ProviderCatalogEntry[]}` — sélecteur d'ajout (v2.5) ; z.ai y figure DEUX fois (API standard / GLM Coding Plan, portefeuilles étanches) |
| `providers:add` | `{name, kind, baseUrl?}` | `{provider}` — nom connu (z.ai, z.ai Coding Plan, opencode, Tavily…) ou adresse https ; `baseUrl` avec chemin = base complète, origine seule = hôte du canon, identique au défaut = ignoré |
| `providers:remove` | `{id}` | `{ok}` (supprime ses clés) |
| `providers:set-strategy` | `{id, strategy}` | `{provider}` |
| `providers:set-base` | `{id, baseUrl}` | `{provider}` — endpoint éditable (v2.5) ; chaîne vide = retour à l'adresse canonique ; https requis (http localhost admis) |
| `providers:add-key` | `{providerId, label, secret}` | `{key: ProviderKeyView}` (masquée) |
| `providers:remove-key` | `{keyId}` | `{ok}` |
| `providers:test-key` | `{keyId}` | `{ok, key, provider?}` — test réseau réel ; z.ai : essaie l'AUTRE portefeuille si la clé est refusée et **bascule le fournisseur** (`provider.baseUrl` mis à jour, v2.5) |
| `extensions:list` | — | `{extensions: ExtensionView[]}` |
| `extensions:add` | `{kind: repo\|mcp, source, channel?}` | `{extension, commits?}` — résolution GitHub réelle |
| `extensions:toggle` | `{id, enabled}` | `{extension}` (effet au redémarrage) |
| `extensions:remove` | `{id}` | `{ok}` |
| `extensions:pin` | `{id, pinned}` | `{extension}` (figée : plus de vérifications) |
| `extensions:check` | `{id}` | `{ok, extension, commits?, changed?, skipped?}` |
| `extensions:update` | `{id}` | `{extension, commits?}` (suit la tête distante) |

Serveur → client : `providers:changed {providers}` et `extensions:changed
{extensions}` (listes complètes, diffusées à tous les clients après chaque
mutation). Script de test E2E : `scripts/test-providers-flow.ts`.

## Prompt système & instructions personnalisées (F-11 / F-19)

Le prompt **s'ajoute** aux instructions de base d'Hermes — il ne les remplace
jamais. Deux étages : le prompt d'une conversation (sheet « prompt », bouton
de l'en-tête) et les instructions personnalisées globales (section Hermes du
volet Paramètres). Presets réutilisables dans la bibliothèque (5 semés à la
première ouverture).

Composition du tour : en mode démo, les instructions envoyées au LLM empilent
base + instructions globales + prompt de conversation ; en mode gateway, le
prompt de conversation part dans `api_turn_v1.settings.system_prompt`
(ignoré sans dommage si non supporté — la gateway garde ses instructions de
base). `hello.systemPromptChars` expose la taille réelle base + globales
(jauge honnête du composer).

Schéma SQL : table `system_prompts` (scope `conversation` = prompt actif,
une ligne max par conversation ; scope `preset` = bibliothèque, colonne
`conversation_id` NULL) ; instructions globales dans `settings` sous la clé
`hermes.instructions.custom`. Garde-fous : 12 000 caractères par prompt,
4 000 pour les instructions globales.

### Événements socket prompt système

Client → serveur :

| Événement | Charge utile | Réponse (ack) |
| --- | --- | --- |
| `system-prompt:get` | `{conversationId}` | `{prompt: ConversationPromptView \| null}` |
| `system-prompt:set` | `{conversationId, content, presetTitle?}` | `{prompt}` — effet au prochain tour |
| `system-prompt:clear` | `{conversationId}` | `{ok, prompt: null}` |
| `system-prompts:list` | — | `{presets: SystemPromptPresetView[]}` |
| `system-prompts:create` | `{title, content}` | `{preset}` |
| `system-prompts:update` | `{id, title, content}` | `{preset}` |
| `system-prompts:delete` | `{id}` | `{ok}` (les prompts actifs ne bougent pas) |
| `custom-instructions:get` | — | `{value, maxChars}` |
| `custom-instructions:set` | `{value}` | `{ok, value}` — appliqué à toutes les conversations |

Serveur → client : `system-prompt:changed {conversationId, prompt}`,
`system-prompts:changed {presets}` et `custom-instructions:changed {value}`
(diffusés à tous les clients après chaque mutation). Script de test E2E :
`scripts/test-system-prompt-flow.ts` (24 contrôles, dont la vérification
comportementale — le LLM démo suit le prompt).

## Partage public lecture seule (F-13)

Chaque conversation peut être **partagée par lien public en lecture seule** :
`/shared/<token>` côté interface (accessible sans session, jamais indexée).
Le lien sert un **snapshot figé** — la conversation peut continuer sans
changer le lien ; le créateur peut le **révoquer** à tout moment (le
destinataire voit alors « lien révoqué ») ; supprimer la conversation passe
ses liens en 410 Gone. Un seul lien actif par conversation : en recréer un
révoque l'ancien.

- `GET /share/<token>/data.json` — vue publique (titre, messages allégés,
  noms de pièces jointes ; **aucun id interne**, CORS `*`, cache 5 min).
- `GET /share/<token>/image.png` — le fil rendu en document autonome sobre
  puis capturé **plein page par chrome-headless-shell** (même pipeline que
  les artefacts HTML). 503 si le navigateur headless est indisponible.

Schéma SQL : table additive `shares` (token opaque 24 caractères base62,
index sur `conversation_id`) ; le snapshot JSON vit dans la ligne, la
conversation source n'est jamais modifiée.

### Événements socket partage

Client → serveur :

| Événement | Charge utile | Réponse (ack) |
| --- | --- | --- |
| `share:get` | `{conversationId}` | `{share: ShareView \| null}` |
| `share:create` | `{conversationId}` | `{share}` — snapshot figé, token frais ; révoque l'ancien lien actif |
| `share:revoke` | `{conversationId}` | `{ok}` (lien actif → 410 Gone) |

Serveur → client : `share:changed {conversationId, share}` (broadcast après
chaque création/révocation). Script de test E2E :
`scripts/test-share-flow.ts` (24 contrôles : 404/410, remplacement,
isolation, PNG Chrome).

## Mode expert (F-22) — température, plafond de jetons, graine

Réglages par tour transmis par `chat:send` / `chat:regenerate` /
`message:edit` (charge `temperature` / `maxTokens` / `seed`, assainis par
`sanitizeExpertSettings` : température clampée **[0, 1]** — le fournisseur
rejette au-delà, erreur 1210 ; plafond [1, 8192] ; graine entière 32 bits ;
`null` / non-numériques ignorés). En mode démo ils sont injectés au LLM
pour de réel (`temperature`, `max_tokens`, `seed`) ; en mode gateway ils
partent dans `api_turn_v1.settings` (clés à valider — convention « ignoré
sans dommage »). Script de test E2E : `scripts/test-expert-flow.ts`
(14 contrôles, dont la troncation comportementale `maxTokens=3`).

## Mémoire utilisateur (F-18)

Mémoire **consultable, éditable, effaçable** : notes persistantes injectées
dans les instructions du tour tant que la mémoire est active. Clés du
registre `settings` : `hermes.memory.enabled` ("1"/"0", absente = active),
`hermes.memory.autoLearn` ("1"/"0"), `hermes.memory.notes` (≤ 12 000 car.).
En mode démo, la section « Mémoire de l'utilisateur » est composée par le
service (entre la base et les instructions personnalisées) ; en mode
gateway, `memory_notes` + `memory_auto_learn` partent dans
`api_turn_v1.settings` (clés à valider contre la gateway). Le `hello`
expose `memoryChars` (taille réelle, 0 si mémoire coupée).

| Événement | Charge utile | Réponse (ack) |
| --- | --- | --- |
| `memory:get` | — | `{enabled, autoLearn, notes, maxChars}` |
| `memory:set-enabled` | `{enabled}` | `{ok, enabled}` |
| `memory:set-auto` | `{autoLearn}` | `{ok, autoLearn}` |
| `memory:set-notes` | `{value}` | `{ok, value}` ou `{error}` (> 12 000 refusé) |

Serveur → client : `memory:changed {notes?|enabled?|autoLearn?}` (broadcast,
charge partielle). Script de test E2E : `scripts/test-memory-flow.ts`
(17 contrôles, dont la vérification comportementale — la démo cite la
mémoire).

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
| `stream:done` | `{conversationId, messageId, conversation?, message?, stopped?}` — `stopped: true` si interrompu par `chat:stop` (partiel conservé, marqué `message.stopped`) |
| `stream:error` | `{conversationId, messageId?, conversation?, message?, error}` — `message` = partiel persisté s'il existe (affiché dans le fil + « Réessayer ») |

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
`ALTER TABLE … ADD COLUMN`, jamais destructrices ; colonnes additives de
`messages` : `attachments`, `stopped`). Les fichiers dérivés
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
