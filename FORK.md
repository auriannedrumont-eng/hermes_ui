# FORK.md — Guide du fork et passation

> **Document de référence.** Toute session (humaine ou LLM) qui travaille sur ce repo doit
> lire ce fichier **en premier**, respecter les conventions du §5, et compléter le journal
> des décisions (§9) après chaque choix structurant. Doc secondaire :
> `mini-services/hermes-chat/README.md` (détail des artefacts et du protocole gateway).

## 1. Ce qu'est ce repo

Interface web de chat pour l'agent **Hermes** (Nous Research). C'est un **fork** maintenu par
`auriannedrumont-eng` : la base de code provient du projet initial, et le fork y ajoute ses
propres fonctionnalités (artefacts, projets, futurs paramètres) sans casser la compatibilité
amont.

Deux modes de fonctionnement, basculés automatiquement :

| Mode | Condition | Comportement |
| --- | --- | --- |
| **Gateway** | URL configurée et joignable (Paramètres → Système, ou `HERMES_GATEWAY_URL`) | Tours envoyés à l'agent Hermes réel (protocole `api_turn_v1`) |
| **Local** (défaut) | Gateway non joignable | Réponses RÉELLES du moteur local — pool de clés fournisseurs uniquement (le LLM intégré du SDK a été retiré au §40 ; le SDK ne sert plus qu'à l'ASR). Erreur claire « Agent Hermes non détecté… » sans moteur — sans exécution d'outils |

Principe directeur de l'UI : **la conversation reste le chef d'orchestre** — un artefact est un
objet de première classe, on ne quitte jamais le chat pour le consulter.

## 2. Démarrage rapide

```bash
# Frontend Next.js (port 3000)
bun install
bun dev

# Mini-service socket.io (port 3003) — indispensable au chat
cd mini-services/hermes-chat
bun install
bun run dev        # bun --hot index.ts

# Caddy (facultatif) : reverse proxy port 81 -> localhost:3000 (cf. Caddyfile)
```

- Rendu des artefacts HTML : pipeline `chrome-headless-shell` (CDP sur WebSocket), voir
  `render.ts` et le README du mini-service pour l'installation et le diagnostic.
- `.env` (racine) : `HERMES_SERVICE_TOKEN` (jeton du mini-service — le lanceur
  le génère), `HERMES_GATEWAY_URL` et `HERMES_GATEWAY_TOKEN` (optionnels,
  connexion à l'agent amont). Voir `.env.example`. (`DATABASE_URL`/Prisma ont
  été retirés du repo — cf. §8 ; la persistance est `bun:sqlite` dans `store.ts`.)
- Scripts de test manuels dans `scripts/` : `test-artifact-flow.ts`, `test-render-pipeline.ts`,
  `diag-service.ts`, `test-hermes-chat-service.ts`.

## 3. Carte du territoire

| Fichier / dossier | Rôle | Propriété |
| --- | --- | --- |
| `mini-services/hermes-chat/index.ts` | Serveur socket.io (3003), tours de chat, événements | Fork (édition sensible) |
| `mini-services/hermes-chat/hermes-connector.ts` | Protocole `api_turn_v1` vers la gateway Hermes | **Couplage amont** — ajuster ici si Nous Research fait évoluer le protocole |
| `mini-services/hermes-chat/models.ts` | Catalogue des modèles Hermes | Couplage amont (léger) |
| `mini-services/hermes-chat/local-engine.ts` | Moteur local (LLM intégré z-ai, streaming SSE) | Fork |
| `mini-services/hermes-chat/store.ts` | Persistance `bun:sqlite` : conversations, messages, artefacts, fork de conversations, recherche | Fork (édition sensible) |
| `mini-services/hermes-chat/artifacts.ts` + `render.ts` | Pipeline artefacts + rendu chrome-headless-shell (PNG plein page, PDF vectoriel) | Fork |
| `mini-services/hermes-chat/shares.ts` | Partage public lecture seule (F-13) : snapshot figé, token opaque, vues | Fork |
| `mini-services/hermes-chat/asr.ts`, `uploads.ts` | Dictée vocale (ffmpeg), pièces jointes | Fork |
| `mini-services/hermes-chat/webchat/` | Fournisseur « Chats IA web » (F-27) : fiches de sélecteurs en données, verrou mono-pilote, garde de chemin, client CDP minimal, pilotes z.ai / AI Studio / gemini-app, moteur (spawn + JSON §4) | Fork (spec `upload/pilotage-chats-ia-web.md`) |
| `src/hooks/use-hermes-chat.ts` | Orchestrateur frontend (conversations, streaming, artefacts, panneau) | Fork (édition sensible) |
| `src/lib/chat-types.ts` | Types du protocole client/service (dont artefacts) | Fork (partagé) |
| `src/lib/tokens.ts` | Estimation de contexte du Composer v2 (heuristique car/jetons, fenêtre par modèle, seuils) | Fork |
| `src/components/chat/` | UI du chat, dont `composer.tsx` (Composer v2), `context-gauge.tsx` (jauge + popover de contexte), `artifact-card.tsx` (cartes inline), `artifact-panel.tsx` (split view) | Fork |
| `src/components/settings/` | Volet Paramètres v4 : `settings-panel.tsx` (volet 860 px à rail), `providers-section.tsx`, `extensions-section.tsx`, `hermes-section.tsx` (F-11/F-19/F-18), `memory-card.tsx` (mémoire utilisateur), `system-prompt-panel.tsx` (prompt de conversation), `bits.tsx` (pastilles), `info-tip.tsx` (tooltips « ? ») | Fork |
| `src/components/shared/shared-conversation-view.tsx` + `src/app/shared/[token]/page.tsx` | Page publique de partage (F-13) : lecture seule, `noindex`, export image | Fork |
| `design/` | Maquettes HTML autonomes de référence, validées avant implémentation (ex. `maquette-composer.html`, chantier Composer v2) | Fork (design) |
| `docs/ROADMAP_FRONT.md` | Suivi des fonctionnalités de chat (F-xx : statuts, preuves, ordre de suite) | Fork (doc de suivi) |
| `src/lib/socket.ts`, `export.ts`, `notify.ts`, `prompt-library.ts` | Client socket.io, exports MD/JSON/PDF, notifications, bibliothèque de prompts | Fork |
| `db/` | SQLite + fichiers générés (`artifacts/`) et uploadés (`uploads/`) | Fork (runtime) |
| `prisma/` + scripts `db:*` du package.json racine | **Boilerplate résiduel non utilisé** (la vraie persistance est `bun:sqlite` dans `store.ts`) | À ignorer |

## 4. La frontière Hermes ↔ fork

Le couplage avec l'amont (Nous Research) est **volontairement mince**. Il se réduit à :

1. `hermes-connector.ts` : admission de tour (`{"text": ..., "api_turn_v1": {history, settings}}`),
   observation (deltas, raisonnement, événements d'outils), repli automatique sur le moteur local ;
2. le protocole documenté dans `gateway/session_api_turn.py` du repo
   [hermes-agent](https://github.com/NousResearch/hermes-agent) ;
3. le catalogue `models.ts`.

**Tout le reste appartient au fork** : stockage, artefacts, projets, UI, PWA, exports,
notifications, ASR, uploads. Si l'amont évolue (renommage d'événements, nouvelle poignée de
main), seul le connecteur est à ajuster ; le moteur local permet de continuer à développer et
tester sans gateway.

## 5. Conventions de développement

- **R1 — Fichiers.** Toute nouvelle fonctionnalité vit dans de nouveaux fichiers/dossiers
  dédiés (`src/components/projects/`, `src/components/settings/`, `src/lib/settings.ts`, …).
  Les fichiers existants ne reçoivent que des éditions minimales et chirurgicales.
- **R2 — Migrations SQLite.** Additives uniquement : `CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE … ADD COLUMN`. Jamais de `DROP`, jamais de renommage destructeur. Suivre le
  pattern de versioning interne de `store.ts`.
- **R3 — Namespacing.** Événements socket préfixés par domaine (`conversations:*`,
  `projects:*`, `artifacts:*`, `settings:*`). Clés de réglages `<ns>.<clef>` (§6).
  `localStorage` préfixé `hermes-ui:`.
- **R4 — Fichiers sensibles** (éditions minimales, priorité aux nouveaux fichiers) :
  `index.ts` et `store.ts` du mini-service, `hermes-connector.ts`, `src/app/page.tsx`,
  `use-hermes-chat.ts`, `message-bubble.tsx`, `sidebar.tsx`.
- **R5 — Paramètres.** Toute fonctionnalité déclare ses réglages dans le registre
  `src/lib/settings.ts` **dès sa création** (§6). Interdiction de `localStorage` ad hoc
  dispersé dans les composants.
- **R6 — Journal des décisions.** Toute décision structurante est consignée au §9, datée.
- **R7 — Langue.** Échanges, documentation et libellés UI en français ; identifiants de code
  (variables, fonctions, events) en anglais.
- **R8 — Dépendances.** Vérifier `package.json` avant d'ajouter quoi que ce soit :
  `@dnd-kit/*` (drag & drop) et `react-resizable-panels` (panneaux fluides) sont déjà là.

## 6. Paramètres — design validé, page différée

**Décision (2026-11-12)** : les réglages seront séparés en deux espaces de noms, pour
distinguer ce qui relève de l'agent Hermes de ce qui provient du fork. La page de paramètres
n'existe pas encore — le socle est posé **dès maintenant** pour ne jamais avoir à refactorer.

### Deux registres

| Namespace | Contenu | Exemples |
| --- | --- | --- |
| `hermes` | Réglages de l'agent amont | `hermes.gateway.url`, `hermes.gateway.token`, `hermes.model`, `hermes.models.favorites`, `hermes.reasoning.effort`, `hermes.permissions.mode`, `hermes.expert.temperature`, `hermes.expert.maxTokens`, `hermes.expert.seed` (F-22, `null` = défaut du fournisseur), `hermes.compare.models` (F-17, JSON `[idA, idB]` — paire de comparaison mémorisée) |
| `fork` | Tout ce que le fork ajoute | `fork.ui.sidebar.width`, `fork.artifacts.panel.autoOpen`, `fork.projects.sort`, `fork.context.gauge` |

### Schéma (fichier unique source de vérité : `src/lib/settings.ts`, à créer)

```ts
interface SettingDef {
  key: string;          // "fork.ui.sidebar.width" (préfixe = namespace)
  type: "string" | "number" | "boolean" | "enum";
  default: unknown;
  label: string;        // libellé FR pour la future page
  description?: string;
  scope: "client" | "server";
  category: string;     // regroupement dans la page (ex. "Panneau", "Sidebar")
  options?: string[];   // pour type "enum"
  requiresRestart?: boolean;
}
// HERMES_SETTINGS: SettingDef[]  —  FORK_SETTINGS: SettingDef[]
```

- **Scope client** → `localStorage`, clé `hermes-ui:<ns>:<clef>`.
- **Scope serveur** → table SQLite `settings (key TEXT PRIMARY KEY, value TEXT, updated_at)`,
  migration additive (à créer lors du chantier projets, en même temps que la table `projects`).

### Inventaire au 2026-11-14 (v2.4)

- Client (`hermes-ui:`) : `hermes.model`, `hermes.models.favorites` (JSON d'ids),
  `hermes.reasoning.effort` (valeur brute du fournisseur, chantier « Composer v2 »),
  `hermes.permissions.mode` (ask | auto — reset sur `ask` à chaque session),
  `hermes.tools.web` (F-09/F-12 — recherche web du tour, ajouté le 2026-11-14 ; **au
  registre le 2026-11-14 (v2.4) — correctif de persistance**, cf. §9 (21)),
  `hermes.compare.models` (F-17 — paire [a, b] ; **au registre le 2026-11-14 (v2.4),
  même correctif**),
  `hermes.compaction.auto` + `hermes.compaction.threshold` (v2.4 — résumé
  automatique, seuil 50–95 %),
  `hermes.profiles.applied` (v2.4 — marqueur du dernier profil appliqué, interne),
  `hermes.expert.{temperature,maxTokens,seed}` (F-22, déjà inventoriés),
  `fork.ui.sidebar.width`, `fork.projects.sort`, `fork.projects.collapsed`,
  `fork.context.gauge` (affichage de la jauge de contexte), `fork.ui.showReasoning`.
- Serveur : table `settings` du mini-service (`settings:get/set`), dont les résumés de
  compaction `compact:<conversationId>` (chantier « Composer v2 »), les instructions
  personnalisées `hermes.instructions.custom` (F-19), la mémoire `hermes.memory.*`
  (F-18), les tarifs des modèles `hermes.pricing` (F-21 — JSON `{id: {input, output}}` en $/M jetons) et **la liste des profils `hermes.profiles` (v2.4 — JSON de
  `ChatProfile[]`, cf. `src/lib/profiles.ts`)** ;
  `.env` → `HERMES_GATEWAY_URL`/`HERMES_GATEWAY_TOKEN` (namespace `hermes`).
  NB (v2.4) : `DATABASE_URL` et le schéma Prisma ont été RETIRÉS du repo (§8) — la
  persistance réelle est `bun:sqlite` (`store.ts`) depuis l'origine.

### Règles d'or

1. Une fonctionnalité nouvelle = ses réglages déclarés dans le registre au même moment.
2. La future page de paramètres se contentera de rendre les deux registres en deux sections
   (« Agent Hermes » / « Cette interface ») — aucune logique métier dans la page.
3. Si l'amont livre un jour son propre système de réglages, aucun collision : les clés du
   fork sont préfixées `fork.`.

## 7. Feuille de route

### 7.1 Fait — artefacts (étapes 1 à 5 de la vision validée)

- Socle : table `artifacts` versionnée (`conversation_id, key, version, kind, name, language,
  mime, content, size, status, status_label, error`), routes de téléchargement
  (`/artifacts/:id/download`, `/artifacts/:id/raw`), fichiers dérivés dans `db/artifacts/`.
- Cartes inline : états génération (code qui streame) → rendu → prêt (vignette), erreur
  (Réessayer) ; le bloc de code disparaît du flux.
- Panneau split view ≈ 45 %, **ouverture automatique à la naissance d'un artefact** ;
  rendus par type : code (coloration, numéros, wrap), Markdown, CSV (tableau), JSON,
  SVG/image (zoom), PDF (visionneuse), HTML (aperçu PNG plein page + export PDF vectoriel,
  badge « Rendu Chrome »).
- Pipeline `chrome-headless-shell` : client CDP minimal, navigateur singleton, rendus
  sérialisés, asynchrones et jamais bloquants (la source apparaît d'abord, la vignette ensuite).
- Versioning : même nom de fichier → **v2 sur la même carte**, sélecteur de version, diff
  ligne à ligne pour le code.

### 7.2 Fait — UI projets (rangements des conversations par projet)

Décision validée : pure couche stockage/présentation au-dessus du moteur, aucune refonte.
Plan d'implémentation :

1. **Migration additive** (dans `store.ts`) :
   `CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT, updated_at TEXT)` ;
   `ALTER TABLE conversations ADD COLUMN project_id TEXT` (nullable) ;
   index sur `conversations.project_id` ;
   **et** la table `settings` du §6 (même migration, socle des paramètres).
2. **Événements socket** : `projects:list`, `projects:create`, `projects:rename`,
   `projects:delete` (les conversations retombent dans « Sans projet »),
   `projects:reorder`, `conversations:move`.
3. **UI sidebar** : groupes repliables par projet + section « Sans projet », drag & drop
   (`@dnd-kit` déjà installé), réordonnancement, création/renommage inline.
4. **Largeur de sidebar fluide** (décision déjà prise, à livrer dans ce chantier) avec
   `react-resizable-panels` déjà installé, largeur persistée via le registre
   (`fork.ui.sidebar.width`).
5. Réglages déclarés dès le départ : `fork.projects.sort`, `fork.projects.collapsed`,
   `fork.ui.sidebar.width`.
6. Ne pas toucher : moteur de tours, streaming, connecteur, fork de conversations, recherche
   plein-texte (extension par projet = optionnel, plus tard).

### 7.3 Fait — Composer v2 (composer redessiné autour du contexte)

Livré le 2026-11-13 d'après la maquette validée `design/maquette-composer.html`
(scènes A-E : repos, picker de modèles, popover de contexte, bouclier de permissions,
alerte de fenêtre pleine). **La maquette fait foi** pour la physionomie et les valeurs
affichées (k + %, seuils ambre 50 % / rouge 80 %).

- `src/lib/tokens.ts` : estimation sans tokenizer (latin ≈ 3,5 car/jeton, CJK ≈ 1 car/jeton,
  repli garanti dès que la gateway remonte l'usage réel) ; fenêtre par modèle
  (`contextWindow` du catalogue, défaut 128k via `contextWindowOf`).
- `src/components/chat/context-gauge.tsx` : anneau SVG dans le footer du composer +
  popover de décomposition — un poste par ligne (instructions système, mémoire projet
  AGENTS.md, historique, pièces jointes, skills, outils MCP, brouillon), part de fenêtre
  en % + poids en k, la somme rejoint l'anneau, ligne absente si le poste est vide.
- Actions « Compacter » / « Nouvelle session » au bas du popover (dialog de confirmation,
  jamais de troncature silencieuse) ; la compaction produit un résumé LLM stocké côté
  service (`compact:<conversationId>`) qui remplace l'historique résumé au tour suivant.
- `model-picker.tsx` réécrit en cmdk (recherche, favoris), contrôleur d'effort de
  raisonnement (`hermes.reasoning.effort`, « off » coupe le thinking côté démo-engine),
  bouclier de permissions ask | auto (`hermes.permissions.mode`, reset sur « ask »
  à chaque session), section repliable « Mode expert » (F-22 : température 0–1,
  plafond de jetons, graine — `hermes.expert.*`).
- Réglage `fork.context.gauge` (affichage de la jauge), déclaré dans le registre (§6).

### 7.4 En chantier — page de paramètres

**Décisions validées le 2026-11-13 (v1)** : **Sheet overlay 460px** glissant depuis la droite (le chat
reste visible — la conversation reste le chef d'orchestre), contenu = **les deux registres
seuls** (§6), **application immédiate** via un CustomEvent `hermes-ui:settings-changed` émis par
`writeClientSetting()` + badge « au rechargement » là où le consommateur lit au montage (seul
`fork.projects.sort` en v1), **entrée unique** = engrenage dans la carte de statut de la sidebar
(palette et raccourci clavier refusés volontairement en v1).

**Retour utilisatrice + décisions v2 (2026-11-13, deuxième session)** — « globalement le design
me convient » + demandes intégrées :

- **Tooltips « ? »** : les `description` du registre quittent la ligne (trop d'informations
  visibles) et deviennent le contenu du « ? » — bouton focusable, survol/focus clavier,
  tap = popover sur mobile, 2-3 phrases max. La ligne visible = libellé + contrôle.
- **Carte de statut promue barre de santé** : ses trois états existent déjà dans le code
  (`Hors ligne` / `Gateway Hermes connectée` / `Mode démo`) ; une fois la gateway branchée, la
  ligne `HERMES_GATEWAY_URL` cède la place à version du moteur · fournisseur · clé active
  (cliquable → fournisseurs). Elle garde son double rôle : porte des paramètres + signal
  honnête « réponses simulées » en démo.
- **Drill-down « Paramètres moteur »** : la porte (pointillés hermes) vit en bas du sheet, les
  registres restent la page d'accueil — 460px inchangé, pas d'onglets. Huit catégories :
  Fournisseurs & clés, Connecteurs, Outils, Skills, MCP, Profils, Fichiers .md, Système &
  mises à jour. Le contenu de cet étage est **piloté par un schéma découvert**
  (`settings:schema`) : le moteur déclare sa surface éditable, la page rend ce qu'il déclare ;
  en mode démo le mini-service simule la surface complète.
- **Fournisseurs & clés (porte-clés)** : plusieurs clés par fournisseur, l'ordre = priorité ;
  « Tester » = appel minimal (liste des modèles) **réel dès le mode démo** (exécuté par le
  mini-service) ; 429/quota → clé marquée *épuisée*, bascule sur la suivante sans couper le
  tour (réactivation manuelle v1, cooldown automatique plus tard). Tables additives
  `providers` / `provider_keys`, événements `providers:*`. **Clés jamais en localStorage,
  jamais renvoyées en clair au navigateur** (masquage type `sk-••••3f7a`, champ à écriture
  seule) ; chiffrement au repos noté pour plus tard. La catégorie inclut les **services
  d'API** hébergés (Tavily, Exa) : rien à importer, mêmes porte-clés / test / relai — leurs
  clés vivent dans les mêmes tables.
- **Connecteurs = les projets GitHub importés** (redéfinition validée, 3ᵉ session) : outils,
  skills, serveurs MCP clonés côté moteur — chaque import suit une source (`owner/projet`),
  un canal (branche ou tag) et un commit exact. Cycle des mises à jour : **Vérifier** (diff
  local ↔ distant), **Mettre à jour** (rapatrie et relance le composant), **Épingler** (fige
  le commit, saute les vérifications), retour à la version précédente en un clic. Effet
  selon le type : outil = prochain tour, skill = rechargement, MCP = redémarrage averti.
  Tavily et Exa **ne sont pas des connecteurs** (services hébergés à clé → services d'API,
  ci-dessus) ; la grille d'outils affiche la dépendance (« via Tavily » = service, « via
  dev-browser » = connecteur importé) et ne s'allume pas si ce qui la sert manque.
  `chrome-headless-shell` / `ffmpeg` = dépendances de **l'interface** (Système · fork).
- **Modes d'application** : `apply: "live" | "next-turn" | "reload" | "restart"` remplace
  `requiresRestart` — seuls *reload* et *restart* portent un badge (les deux premiers sont
  silencieux). Outils = prochain tour, fichiers .md = prochain tour, skills = rechargement,
  MCP / mise à jour moteur = redémarrage (sessions averties, jamais de coupure silencieuse).
  Champ `control` étendu (`keypool`, `list`, `file`, `action`…) + `secret?: boolean`.
- **Profils** : presets du fork en v1 (modèle + effort + permissions, écrits via le bus
  client — effet immédiat, zéro dépendance moteur) ; réconciliation avec d'éventuels profils
  amont plus tard.
- **Mises à jour** : connecteurs = vérifier / mettre à jour / épingler depuis GitHub (effet
  selon le type, ci-dessus) ; moteur = amont (vérification/action seulement si la gateway
  l'expose, sinon « non exposé ») ; interface = recette git §10, pas d'auto-update.

Maquette de validation : **`design/maquette-parametres.html` v2** (scènes A-K : entrée &
carte promue, registre hermes, registre fork + porte moteur, drill-down, fournisseurs &
clés + services d'API, connecteurs (imports GitHub & mises à jour), outils & skills, MCP &
.md, profils & système, bus v2 + états du « ? », mobile ; spec deux étages + taxonomie +
fichiers + phasage en fin de planche) — **en attente de validation avant implémentation**.
Phasage : v2.1 = 8 réglages client (plan v1 inchangé, tooltips inclus) · v2.2 = fournisseurs
+ services d'API (porte-clés, test, relai) + connecteurs (imports GitHub : vérifier, mettre
à jour, épingler — scope serveur réel, fonctionnel en démo) · v2.3 = découverte gateway
(outils, skills, MCP, .md) · v2.4 = système & mises à jour.

**Retour utilisatrice + décisions v3 (2026-11-13, quatrième session)** — sections séparées,
maquette interactive :

- **Sections à part entière** : Skills, Outils, MCP, Mémoire, Profils et Système ne sont
  plus fusionnés (v2 regroupait Outils+Skills, MCP+.md, Profils+Système). L'étage moteur
  compte **10 catégories** : Modèle & raisonnement (nouveau — défauts moteur), 
  Fournisseurs & clés, Connecteurs, Outils, Skills, Serveurs MCP, Mémoire (nouveau),
  Fichiers .md, Profils, Système.
- **Détails réduits** : les explications vivent uniquement dans les tooltips « ? », aucune
  note inline ; deux signaux discrets en pied de sheet — « Mode démo » (tooltip : rôle
  post-gateway) et compteur « N en attente » (modifications moteur pas encore appliquées).
- **Éditabilité** : chaque skill et chaque fichier .md s'ouvre en **éditeur dans le sheet**
  (SOUL.md, AGENTS.md, AGENTS.override.md, CLAUDE.md ; MEMORY.md et USER.md côté Mémoire)
  — Enregistrer → badge d'effet (prochain tour / rechargement).
- **Outils — modèle ou service associé** : sélecteur directement sur la ligne de l'outil
  (web → Tavily/Exa/DuckDuckGo ; navigateur → connecteurs importés dev-browser/scrapling ;
  image_gen → FAL.ai/OpenAI/xAI ; vidéo → xAI/FAL ; vision → modèle vision). Outil coupé =
  sélecteur désactivé.
- **Éditeur de profils** : nom, **modèle par défaut**, effort, permissions et
  **sélection de skills** (puces cochables) ; Appliquer / Dupliquer.
- **Paramètres activables supplémentaires, ancrés dans la doc amont hermes-agent**
  (`github.com/NousResearch/hermes-agent` + `hermes-agent.nousresearch.com/docs`,
  consultés le 2026-11-13) : toolsets réels (browser, web, image_gen, video_gen, vision,
  tts, x_search, terminal, file, code_execution, memory, skills, session_search, cronjob,
  delegation, computer_use…) ; **pools d'identifiants natifs du moteur** (stratégies
  `fill_first`/`round_robin`/`least_used`/`random`, 429 → un essai puis relai, cooldown
  1 h, 401 → refresh OAuth, `fallback_model` en bout de chaîne) — notre porte-clés
  s'appuie dessus plutôt que de le réinventer ; mémoire (`memory_enabled`,
  `user_profile_enabled`, `write_approval`, limites en caractères) ; fichiers de contexte
  (priorité `.hermes.md` → `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md`, `SOUL.md`
  toujours chargé) ; exécution (backend terminal local/docker/ssh, timeout commande,
  sandbox réseau isolé) ; mises à jour (`pre_update_backup` : snapshot rapide / complète /
  off).
- **Maquette v3 = application interactive** : `design/maquette-parametres-v3.html`
  (16 vues cliquables, 460px, données représentatives — la page **est** le produit, plus
  une planche à scènes ; la v2 reste archivée pour référence). Captures de contrôle :
  `download/maquette-parametres-v3/`.

**Livré — phase 1 « étage client » (2026-11-13, cinquième session)** : sheet overlay 460 px
(Radix Dialog composé maison : coins arrondis à gauche, plein écran sous 640 px), entrée
unique = engrenage de la carte de statut. Vue d'accueil = section « Cette interface »
(7 lignes client des deux registres — `hermes.models.favorites` reste interne) : select de
modèle (catalogue vivant du service), segment d'effort (échelle portée par le modèle), segment
de permissions, slider de largeur, select de tri, interrupteur « Dossiers de projet repliés »
(dérivé de `fork.projects.collapsed` : tout replier / tout déplier), interrupteur de jauge.
Descriptions du registre → tooltips « ? » focusables (survol, focus clavier, tap mobile,
un seul ouvert, flèche d'ancrage). **Application immédiate généralisée** :
`writeClientSetting()` émet le CustomEvent `hermes-ui:settings-changed`, consommé par la page
(largeur sidebar), la sidebar (tri + repliage), le composer (jauge) et le hook de chat
(modèle / effort / permissions) — plus aucun réglage client ne demande de rechargement, le
badge « au rechargement » prévu en v1 pour `fork.projects.sort` devient inutile (tri live).
Porte « Paramètres moteur » : les 10 sections v3 listées avec badge « à venir » (structure
posée pour v2.2+, aucune donnée simulée) ; pied de sheet = pastille « Mode démo » (tooltip :
rôle post-gateway) + compteur « N en attente » (prop `pendingEngineCount`, masqué à 0, prêt
pour v2.2). Fix au passage : la largeur de sidebar était écrasée au montage (le `onResize`
initial de react-resizable-panels précédait la restauration) — garde-fou `sidebarRestoredRef`
dans `page.tsx`. QA par captures : `download/parametres-phase1/` (thèmes clair/sombre,
mobile 390 px, tour de chat démo bout en bout).

**Maquette v4 (2026-11-13, sixième session — commit `4c6269d`, en attente de validation)** :
remplacement proposé du sheet 460 px par un **volet gauche ~860 px** ancré (plein écran
< 1100 px) à navigation par rail (plus de forage) ; **pastilles** comme seule langue d'état
(vert silencieux, orange action, rouge cassé) ; descriptions simples sous les libellés,
tooltips réduits aux exemples ; sections réorganisées — Modèles (modèle d'arrière-plan,
effort dynamique selon l'API), Fournisseurs (LLM seuls, multi-clés) **séparés** des clés
de services, Extensions (ex-Connecteurs + serveurs MCP fusionnés, activer/désactiver),
Outils (détail dépliable, création/modification), Skills (recherche, sources, contrôle
qualité en langage clair), Hermes (fusion mémoire + fichiers .md + compaction + comportement).
Fichier : `design/maquette-parametres-v4.html`. **Rien de la v4 n'est implémenté** —
l'implémentée reste la phase 1 ci-dessus. (Entrée journalisée a posteriori : le commit
n'avait pas été consigné au §9.)

**Livré — phase 2 « volet v4 + Fournisseurs & clés + Extensions » (2026-11-13, huitième
session)** : le chantier v2.2 a été mené **sur la maquette v4** (dernière direction de
design, sections Fournisseurs / Clés de services / Extensions = organisation v4) à la
demande « continue » de l'utilisatrice — la validation formelle de la maquette reste à
donner a posteriori, les ajustements éventuels se feront sur l'implémenté.

- **Volet v4** : `src/components/settings/settings-panel.tsx` remplace le sheet 460 px
  (supprimé) — volet gauche 860 px ancré (plein écran < 1100 px), rail des 10 sections,
  pastilles uniques d'état, pied « mode démo + N en attente », point ambre sur
  Extensions quand une mise à jour est détectée. Sections livrées : **Interface**
  (registres client — dont nouveau `fork.ui.showReasoning`, appliqué en direct aux bulles
  via le bus — et **Thème** Système/Clair/Sombre via next-thèmes), **Modèles** (catalogue
  vivant + effort porté par le modèle ; arrière-plan et secours annoncés v2.3),
  **Fournisseurs**, **Clés de services**, **Extensions**. Outils, Skills, Hermes,
  Profils, Système = structure cible listée sans données simulées (v2.3+).
- **Serveur — porte-clés** (`mini-services/hermes-chat/providers.ts` + tables additives
  `providers` / `provider_keys`) : plusieurs clés par fournisseur (ordre = priorité),
  stratégie `fill_first` / `round_robin` / `least_used` (`pickActiveKey` prêt pour le
  moteur, non consommé en démo), « **Tester** » = appel minimal **réel** exécuté par le
  service (liste des modèles : z.ai, OpenRouter, Anthropic, Mistral, OpenAI, DeepSeek,
  Groq, xAI ; requête minimale : Tavily, Exa, FAL.ai ; `/models` Bearer pour les adresses
  personnalisées) ; 401/403 → « clé refusée », 429 → « limite atteinte ». **Clés jamais
  en localStorage ni renvoyées en clair** — vues masquées `sk-••••7f3a` seulement.
- **Serveur — extensions** (table `extensions`) : imports GitHub **réels** (nom,
  description, branche, commit exact, dernier tag, derniers commits) avec **repli
  protocole git** (`git ls-remote`) quand l'API GitHub est au quota ; jeton optionnel
  `GITHUB_TOKEN` dans le `.env` du service ; **Vérifier** (diff local ↔ distant),
  **Mettre à jour** (suit la tête — le rapatriement/relance effectifs relèvent du
  moteur, post-gateway), **Épingler** (fige, saute les vérifications), activer/désactiver
  (colonne `applied` : effet au redémarrage du service, compteur « N en attente » du pied).
- **Hook** `src/hooks/use-providers.ts` (état + actions, broadcasts `providers:changed` /
  `extensions:changed`) ; miroir des types dans les deux `types.ts` / `chat-types.ts`.
- QA : `scripts/test-providers-flow.ts` (29 contrôles E2E verts — y compris test de clé
  réel → 401, import GitHub via repli git) ; captures `download/qa-parametres-v2/`
  (14 vues : sections, ajout fournisseur/clé, test réel, import, dépliage, désactivation
  + « 1 en attente », Modèles, à venir, thème clair, mobile 390 px). `bunx tsc
  --noEmit` : 0 erreur dans `src/` ; eslint propre sur les nouveaux fichiers.

### 7.5 Fait — Chat UX : arrêt propre et erreurs persistantes (F-01/F-04)

Livré le 2026-11-13 (suivi détaillé dans `docs/ROADMAP_FRONT.md`). Deux écarts corrigés :
le message interrompu s'affichait comme une réponse complète, et une erreur réelle effaçait
la bulle au bout de 2,5 s (partiel persisté invisible jusqu'au rechargement, sans réessai).

- **Un arrêt n'est plus une erreur** : `chat:stop` clôt le tour par `stream:done`
  (`stopped: true`) — le connecteur revient avec le partiel dans les deux modes ;
  `ChatMessage.stopped` est **persisté** (migration additive `messages.stopped`) et rendu
  par la bulle (« Réponse interrompue — “Régénérer” pour la compléter ») ; arrêt avant le
  premier jeton = aucun message persisté (pas de bulle vide).
- **Erreurs persistantes** : `stream:error` embarque le partiel persisté (`message`) et
  la conversation ; le client affiche le partiel dans le fil immédiatement + une rangée
  `role="alert"` avec **Réessayer / Masquer** (le réessai régénère depuis le dernier
  message utilisateur) — plus d'effacement automatique.
- **Machine à états** : `turnState` (`idle | streaming | stopped | error`) exposé par le
  hook `use-hermes-chat.ts`, aux côtés de `turnError` / `retryAfterError` /
  `dismissTurnError`.
- Docs : protocole du README mini-service mis à jour ; nouveau `docs/ROADMAP_FRONT.md`.

### 7.6 Fait — Prompt système & instructions personnalisées (F-11 / F-19)

Livré le 2026-11-13 (neuvième session, point 2 de l'ordre recommandé — le prompt
**s'ajoute** aux instructions de base d'Hermes, jamais en remplacement).

- **Serveur** : nouveau `mini-services/hermes-chat/prompts.ts` (composition,
  validation, seeds) ; migration additive `system_prompts` (scope `conversation`
  — une ligne max par conversation ; scope `preset` — bibliothèque, 5 presets
  semés à la première ouverture) ; instructions globales (F-19) dans la table
  `settings` sous `hermes.instructions.custom` (max 4 000 caractères, prompt de
  conversation max 12 000). Événements : `system-prompt:get/set/clear`,
  `system-prompts:list/create/update/delete`, `custom-instructions:get/set` ;
  broadcasts `system-prompt:changed`, `system-prompts:changed`,
  `custom-instructions:changed`.
- **Composition du tour** : en démo, `composeDemoSystemPrompt()` empile base +
  instructions personnalisées + prompt de conversation (sections absentes omises) ;
  en gateway, le prompt de conversation part seul dans `api_turn_v1.settings.system_prompt`
  (la gateway garde ses instructions de base — ignoré sans dommage si non supporté).
  `hello.systemPromptChars` suit la base + F-19 (jauge honnête).
- **Client** : hook `src/hooks/use-system-prompts.ts` ; `SystemPromptPanel`
  (`src/components/settings/system-prompt-panel.tsx`, sheet 460 px — bouton
  « prompt » de l'en-tête + pastille quand un prompt est actif, presets
  applicables, « Enregistrer dans la bibliothèque… », Retirer) ; section
  **Hermes** du volet v4 livrée (`hermes-section.tsx` : instructions globales
  + bibliothèque éditable + **mémoire F-18** — fichiers .md restent
  « à venir ») ;
  `use-hermes-chat.ts` expose `promptInfo` (chargé au changement de
  conversation, suivi par bus) et la jauge gagne le poste « Prompt de
  conversation ».
- QA : `scripts/test-system-prompt-flow.ts` — **24/24 verts**, dont la vérification
  comportementale réelle (le LLM démo répond « B » au prompt « réponds toujours
  par la lettre B »), l'isolation entre conversations, les garde-fous de
  longueur et le retour à l'état par défaut. `bunx tsc --noEmit` : 0 erreur
  dans `src/` ; eslint propre sur les fichiers du chantier.

### 7.7 Fait — Partage public lecture seule (F-13)

Livré le 2026-11-13 (dixième session, point 3 de l'ordre recommandé). Le lien
est un **snapshot figé** de la conversation (titre + messages allégés) : elle
peut continuer sans changer le lien ; révoquer coupe l'accès sans toucher la
source ; supprimer la conversation passe les liens en 410 Gone.

- **Serveur** : `mini-services/hermes-chat/shares.ts` (token opaque 24 car.
  base62, snapshot JSON, vues wire) + migration additive `shares` (index sur
  `conversation_id`) ; événements `share:get/create/revoke` + broadcast
  `share:changed` ; HTTP (3004) : `GET /share/<token>/data.json` (CORS `*`,
  sans id interne) et `GET /share/<token>/image.png` — fil rendu en document
  autonome sobre par le pipeline chrome-headless-shell (plein page).
- **Client** : page publique `/shared/[token]` (`noindex`, Markdown réutilisé,
  états révoqué/introuvable/erreur, export image) ; menu « Partager » de
  l'en-tête (création + copie automatique du lien, ouverture de la vue
  publique, révocation) ; état + bus + toasts dans `page.tsx`.
- QA : `scripts/test-share-flow.ts` — **24/24 verts** : vues sans snapshot,
  404/410, remplacement du lien (ancien → 410), isolation entre
  conversations, conversation vide refusée, révocation, suppression → 410
  persistant, PNG Chrome valide (signature binaire, ~35 Ko). Page publique
  servie (200) et snapshot chargé côté client vérifiés en dev ;
  `bunx tsc --noEmit` : 0 erreur `src/` ; eslint propre.

### 7.8 Plus tard

- **Browsing agent** (étape 6 de la vision artefacts) : chip de statut discrète près du champ
  de saisie (favicon + titre), résultats en citations cliquables repliables
  « Pages consultées (n) », jamais de panneau dédié. Branché sur dev-browser (connecteur
  importé, scène F — ses mises à jour s'y gèrent).

### 7.9 Feedback intégré (F-24) — RETIRÉ le 2026-11-16

Livré le 2026-11-13 (onzième session), **retiré le 2026-11-16** à la demande
de l'utilisatrice (« retire features bonnes et mauvaises réponses ») pendant
l'épuration des rangées d'actions (journal (36) : actions en icônes seules).
La fonctionnalité n'existait que côté fork — jamais envoyée au modèle, elle
part sans impacter le protocole gateway.

- **Client** : `FeedbackControl` (pouces 👍/👎 + popover commentaire) supprimé
  de `message-bubble.tsx`, prop `onSetFeedback` décâblée de la bulle, de la
  liste (`MessageList` + `ComparePair`) et de `page.tsx`, action
  `setMessageFeedback` et abonnement `feedback:changed` retirés du hook,
  champs `feedbackRating`/`feedbackComment` retirés de `chat-types.ts`.
- **Serveur** : handler `feedback:set` + broadcast `feedback:changed`
  supprimés du service, `setMessageFeedback` et mappings
  `feedback_rating`/`feedback_comment` retirés du store, migration douce et
  section F-24 du README du service supprimées ; `FeedbackChangedPayload`
  retiré des types. Les colonnes SQLite additives restent en place
  (historique dormant, aucun effet).
- Test `scripts/test-feedback-flow.ts` supprimé avec la fonctionnalité.

### 7.10 Fait — Mémoire utilisateur (F-18)

Livré le 2026-11-13 (douzième session). Mémoire **consultable, éditable,
effaçable** : notes persistantes réutilisées à chaque conversation. La
composition reste le fait du service (le client n'assemble rien) ; le
fallback additif des clés fait qu'une mise à jour ne coupe jamais la mémoire.

- **Serveur** : clés `hermes.memory.{enabled, autoLearn, notes}` (table
  `settings`, aucun schéma dédié) ; événements
  `memory:get/set-enabled/set-auto/set-notes` + broadcast `memory:changed` ;
  `composeDemoSystemPrompt` gagne la section « Mémoire de l'utilisateur »
  (entre la base et les instructions personnalisées) ; jauge
  `systemPromptSize` et `hello.memoryChars` honnêtes ; en mode gateway,
  `memory_notes` + `memory_auto_learn` partent dans `api_turn_v1.settings`
  (clés à valider contre la gateway — même convention que Composer v2,
  ignorées sans dommage si non supportées).
- **Client** : `MemoryCard` de la section Hermes du volet v4 (interrupteur
  activer/désactiver, apprentissage automatique « nécessite le moteur réel »,
  éditeur 12 000 car. avec compteur, effacement) ; hook `use-memory`
  (chargement, bus, actions) ; câblage `page` → `settings-panel` →
  `hermes-section`. L'état reste honnête en toute circonstance.
- QA : `scripts/test-memory-flow.ts` — **17/17 verts** (re-passé une seconde
  fois) : état par défaut propre, garde-fou 12 000, broadcasts des trois
  actions, vérification comportementale (la démo cite la mémoire), coupe
  propre à la désactivation, réactivation, effacement complet.
  `bunx tsc --noEmit` : 0 erreur `src/` ; eslint propre.
- NB : MEMORY.md / USER.md du moteur ne sont PAS touchés — les notes vivent
  dans l'UI du fork ; une fois la gateway branchée, l'apprentissage
  automatique pourra écrire dans les fichiers du moteur côté agent.

### 7.11 Fait — Mode expert complet (F-22)

Livré le 2026-11-13 (douzième session, suite). F-22 était « Partiel »
(effort livré) — la température, le plafond de jetons et la graine
complètent le chantier, avec des bornes **vérifiées empiriquement** contre
le moteur démo :

- **Sondages SDK (consignés §9-13)** : `temperature`/`max_tokens`/`seed`
  sont acceptés ; la plage réelle de température est **[0, 1]** (erreur
  fournisseur 1210 au-delà — l'échelle OpenAI [0, 2] ne s'applique pas) ;
  `max_tokens=1` est accepté et tronque à un unique jeton (plancher = 1,
  pas 16 : un plancher à 16 laissait passer des phrases courtes entières,
  détecté en QA comportementale).
- **Assainissement côté service** (`sanitizeExpertSettings` dans
  `prompts.ts`) : température clampée [0,1], plafond [1,8192], graine
  entière 32 bits ; `null`/chaîne non numérique/`NaN` ignorés — piège
  `Number(null) === 0` corrigé (un champ vide n'active plus la valeur 0).
  Branché sur `chat:send`, `chat:regenerate`, `message:edit`.
- **Injection réelle** au LLM démo (`demo-engine.ts` : `temperature`,
  `max_tokens`, `seed` passés à `chat.completions.create`) + transmission
  gateway dans `api_turn_v1.settings` (convention « ignoré sans dommage »).
- **Client** : section repliable « Mode expert » dans le popover du
  sélecteur (`model-picker.tsx` : compteur « N actifs », curseur
  température 0–1, champs plafond/graine, vides = défaut fournisseur) ;
  registre `hermes.expert.*` (3 clés §6) ; état + refs + persistance dans
  `use-hermes-chat` ; payloads `send`/`regenerate`/`edit` ; passage
  `page` → `composer` → `ModelPicker`.
- QA : `scripts/test-expert-flow.ts` **14/14 verts** — 9 contrôles
  d'assainissement + comportemental réel (`maxTokens=3` → « Le renard » ~3
  jetons vs la phrase entière sans plafond) + tours réussis sur valeurs hors
  bornes (clampées) et non-numériques (ignorées). Reprises anti-429
  espacées de 8 s (le fournisseur démo limite les requêtes rapprochées).
  `bunx tsc --noEmit` : 0 erreur `src/` et service ; eslint propre.

### 7.12 Fait — Versionnage fichiers depuis le chat (F-26)

Décision validée (2026-11-15, conception en trois passes : modèle, zones
d'ombre, UI) : **chaque fichier de travail garde un journal de versions
automatique**, l'humain ne fait que nommer et restaurer.

**Fusion, pas empilement.** La table `artifacts` était déjà un journal
immuable (une ligne par version, contenu inclus, hors de portée de git et
du lanceur). F-26 lui ajoute la couche humaine au lieu de créer un double
stockage (`db/versions/` écarté — redondant) : colonnes additives
`artifacts.label` (étiquette), `artifacts.pinned` (épinglage),
`artifacts.restored_from` (marqueur ↩). Les versions préexistantes (v2/v3
des artefacts) deviennent des entrées du journal sans migration de données.

**Règles implémentées** (module de politique `mini-services/hermes-chat/versions.ts`) :
- déclenchement automatique : naissance d'artefact ou contenu changé ; une
  ré-émission au contenu identique de la version courante `ready` ne crée
  PAS de version (une version en erreur peut être refaite) ; une seule
  version par tour et par fichier (garantie par l'ArtifactTracker) ;
- restauration : crée v(n+1) qui copie le contenu de vN — jamais
  d'écrasement, l'historique reste linéaire ; libellé auto
  « Restauration de vN » + marqueur ↩ ; le HTML restauré repart par le
  pipeline de rendu, les autres kinds sont prêts immédiatement ;
- quota : 50 versions/fichier, purge FIFO des plus anciennes non épinglées
  (jamais la courante), 10 épingles max/fichier ; fichiers dérivés (PNG/PDF)
  des versions purgées supprimés ; appliqué en fin de tour, y compris
  interrompu, et après restauration ;
- fork de conversation : étiquette, épinglage et marqueur suivent les
  versions copiées ; suppression d'une conversation : journal purgé.

**UI — un seul point d'entrée** (`src/components/chat/version-popover.tsx`,
composant unique réutilisable tel quel quand l'espace projet existera) :
le badge `v{n}` de la carte (présent dès v2, mono atténué) ouvre un popover
ancré : une ligne = étoile (épinglée, jamais purgée) / ↩ / vN / date
relative / étiquette en italique — rien de plus ; double-clic = édition
inline de l'étiquette (Entrée valide, vide efface, ≤ 80 car.) ; clic =
sélection → bouton unique « Restaurer vN » (désactivé sur la version
courante) + « Télécharger » (la version sélectionnée) ; confirmation par
toast « v(n+1) créée d'après vN », sans dialogue ni annuler. Pas de ligne
dans le flux du chat, pas de commande au composer, pas de bouton
« sauvegarder » (l'étiquetage a posteriori remplace). Le sélecteur et le
diff du panneau artefact restent inchangés (le panneau suit la version
restaurée).

**Événements socket** : `artifact:restore {conversationId, key, version}` →
`{artifact}` (+ rendu HTML si besoin), `artifact:label {artifactId, label}`
→ `{artifact}`, `artifact:pin {artifactId, pinned}` → `{artifact | error}` ;
diffusion `artifact:updated` après chaque mutation (le hook et les autres
onglets suivent). `artifact:versions` existant sert le journal complet.

QA : `scripts/test-versions-flow.ts` **21/21 verts** (partie A : politique
sur base isolée — dédoublonnage, purge, plafond d'épingles, restauration ;
partie B : cycle socket réel — étiqueter, épingler, restaurer, ack +
broadcast, purge à la suppression) ; QA navigateur de bout en bout (badge →
journal → étiquette inline → étoile → restauration → toast → badge v4 → ↩
« Restauration de v1 »), captures `download/qa-f26/`. `bunx tsc --noEmit` :
aucune erreur nouvelle (les 5 erreurs préexistantes « API Bun vues par le
tsc racine » inchangées) ; eslint : seul l'alerte préexistante
`providers-section.tsx` demeure.

### 7.13 Fait — Artefacts : onglet dédié + terminal du tour (F-28 / F-29)

Demandes (2026-11-16) : « pour apercu des artefacts, je veux une icone pour
ouvrir l'artefact dans un nouvel onglet » ; « dans le panneau des artefact,
j'aimerais un encart en bas avec le terminal dont se sert le llm » ; cadre
habituel « ui épurée, intuitive, moins de clics possibles, pas de
redondances ».

**F-28 — Ouvrir dans un nouvel onglet.** Le gain clé est côté service : route
`GET /artifacts/<id>/view` qui sert le HTML RENDU (`text/html`) derrière un
bac à sable CSP `sandbox allow-scripts allow-forms allow-popups
allow-modals` — origine opaque, ni cookies ni stockage ni jetons de
l'application accessibles, ce qui lève proprement l'interdit « jamais servi
comme text/html » posé à la revue 2026-11-13 (la règle reste vraie pour
`/raw` et `/download`, inchangés ; SVG/autre tombent sur le comportement
`raw`). Champ `viewUrl` du payload wire (html uniquement) + types miroir.
Côté client : `openArtifactInTab()` (viewUrl sinon rawUrl). Deux icônes
`ExternalLink` « Ouvrir dans un nouvel onglet » : sur la carte (le bouton
qui DUPLIQUAIT le clic carte en rouvrant le panneau devient l'action
nouvelle — un de moins, zéro redondance) et dans l'actions du panneau /
visionneuse mobile (désactivée tant que pas `ready`).

**F-29 — Encart terminal en bas du panneau.** L'activité outil du tour qui
porte l'artefact affiché : stream vivant d'abord (`streams[messageId]`),
événements persistés du message ensuite (`message.toolEvents`). Nouveau
composant unique `artifact-terminal.tsx` : barre fine repliée (icône
`Terminal` + « Terminal » + point pulsant si vivant ou « N étapes »), console
sombre collée en bas (heure, statut ✓/✗/spinner, nom, détail), défilement
collé au bas, s'OUVRE SEULE quand le tour vit (repli manuel respecté, rien
ne bouge à la fin du tour), et **absente s'il n'y a rien à montrer** — pas
d'encart mort sous un artefact sans outils. Résolu par le pattern « état
dérivé pendant le rendu » (la règle eslint `set-state-in-effect` interdit
l'effet dédié). Posé entre le corps et la ligne méta du panneau bureau ET de
la visionneuse mobile, clé = messageId (reset par tour). La page fournit
`resolveTurnTools(messageId)` aux deux.

QA : `scripts/probe-artifact-view.ts` **16/16 verts** (service réel sur
ports dédiés + base jetable : viewUrl wire, view html → text/html + CSP
sandbox + contenu exact, raw inchangé, view svg → image + CSP dur, view
code → texte, 404) ; QA navigateur sur la pile complète via
`scripts/qa-proxy.ts` (remplace Caddy : XTransformPort → port local,
WebSockets en tunnel TCP — tourne sous node, le `upgrade` de Bun ne pipe
pas) : carte → panneau → clic « Ouvrir dans un nouvel onglet » → l'onglet
affiche la page RENDUE (`/view`), encart terminal déplié avec les 4 lignes
horodatées ; captures `download/qa-f28/`. `bunx tsc --noEmit` 0 erreur ;
`bun run build` vert ; eslint propre sur les fichiers touchés.

### 7.14 Fait — Modes du compositeur (F-30)

Maquettes validées par l'utilisatrice avant implémentation (convention
`design/`) : `maquette-modes.html` (sélecteur, « qui travaille », déroulés)
et `maquette-parametres-modes.html` (section Paramètres, 13 consignes).
Sept modes : **chat · plan · code · comparer · débat · conseil · auto** —
« Comparer » (F-17) devient un mode du sélecteur, l'ancienne bascule quitte
la zone de message, plus de règle d'exclusion spéciale : un seul mode actif
à la fois. La pastille de mode est le premier contrôle du pied du composer :
un seul endroit décide du traitement du prochain message.

**Côté service — le service fait foi.** Nouveau `modes.ts` : référentiel
(`resolveMode` : valeur inconnue → chat, au chargement comme à l'envoi),
bornes affichées et revalidées (débat 3–10 tours, conseil 2–5 membres, auto
0–3 reprises), voix des modes multi-acteurs, les 13 consignes par défaut
(`chat/plan/code.main`, `debate.conseiller/juge`, `council.membre/president`,
`auto.debat/plan/code/test/reprise`, `compare.main`) avec interpolation des
mots-clés `{angle} {tours} {membres} {reprises}` AU TOUR — jamais enregistrés
remplacés. Les surcharges vivent dans la table settings (clé
`hermes.modes.prompts`, JSON `{mode:{voix:texte}}`) et sont relues à chaque
envoi : une édition s'applique au prochain message de toutes les
conversations, sans redémarrage. Persistance additive (R2, migration douce) :
`conversations.mode` + `mode_rounds` + `mode_config` (JSON voix → modèles +
membres/reprises/autoDebate, par conversation), `messages.mode_tag` +
`mode_flow` ; le fork hérite du mode. Socket : `conversations:setMode`
(résolu + borné côté service, ack `{ok, conversation}`) + diffusion
`conversations:mode` (toutes les fenêtres suivent) ; `conversations:create`
accepte `mode`/`modeConfig`. `runAssistantTurn` RELIT le mode à chaque envoi :
`compare` → re-split en deux variantes a/b avec les modèles des voix A/B
(mécanisme F-17 inchangé, l'écran n'envoie plus de paire) ; `debate`,
`council`, `auto` → orchestrateur ; `plan`/`code`/`chat` → consigne ajoutée
au systemPrompt recomposé (local ET gateway), `plan_mode:true` tenté au
premier tour en gateway (refus non bloquant — la consigne reste la garantie).

**Orchestrateur** (`orchestrator.ts`, nouveau) — une seule réponse conservée
(verdict / fusion / bilan), le déroulé vit dans la conversation : débat
séquentiel (les conseillers se répondent tour après tour, contredisent sur
des faits, le juge streame le verdict), conseil (membres EN PARALLÈLE, sans
se voir, lecture seule — règle du mode rappelée à chaque membre, avis
anonymisés A/B/C…, le président streame la fusion), auto (débat facultatif →
plan → code → test ; échec prouvé = réponse débutant par ÉCHEC/FAIL → reprise
qui corrige LA cause racine puis re-test, jusqu'au quota ; le bilan = code +
preuve). Chaque voix porte le modèle choisi dans « qui travaille »
(`mode_config.voices`), sans choix = modèle de la conversation. Déroulé
poussé en direct (`mode:flow`, rows : label/détail/extrait/modèle/statut)
puis persisté avec la réponse (`mode_flow` + `mode_tag`) — visible au
rechargement. Un échec de voix est honnête (ligne « échec », la fusion
continue avec les avis reçus). `runVoiceTurn` est injecté : la QA orchestre
sans LLM.

**Côté client.** `src/lib/modes.ts` (miroir d'affichage : libellés simples,
voix, bornes, defaults des voix) + registre R5
(`hermes.modes.defaultMode/debateRounds/councilMembers/autoRetries/autoDebate/
showFlow/showModels/voices` — défauts des NOUVELLES conversations, chaque
conversation garde le sien). `mode-picker.tsx` (nouveau) : pastille allumée
hors chat (« Débat · 3 tours », « Conseil · 3 membres », « Auto · 2
reprises », « Comparer · 2 modèles »), popover à 7 modes, bornes en steppers
arrêtés à la saisie, panneau « qui travaille » (une voix par acteur, son
modèle ou « Modèle de la conversation ») ; le choix avant la première
conversation est appliqué à la création. Composer : pastille en tête du
groupe de gauche, bascule Comparer retirée. `message-bubble` rend le
déroulé + l'étiquette (« ★ Verdict · Débat — 3 tours ») au-dessus de la
réponse conservée ; chip « Comparer » au-dessus des paires en mode compare ;
réglages `hermes.modes.showFlow/showModels` respectés. Paramètres : rail à
10 sections, nouvelle section « Modes de chat » (`modes-section.tsx`) —
une carte par mode dans l'ordre du sélecteur (séparation visuelle forte,
libellés directs sans jargon), steppers des défauts, voix et modèles, et
les 13 consignes éditables (compteur /4 000 arrêté à la saisie,
Réinitialiser un par un visible si modifié, chips de mots-clés) —
enregistrées côté service au fil de la frappe.

QA : `scripts/test-modes-flow.ts` **70/70 verts** — A. unitaires sans LLM
(`resolveMode` inconnu → chat, bornes clampées jamais refusées,
interpolation + valeur inconnue intacte, 13 consignes, surcharge >
4 000 rejetée à la résolution, voix par mode, orchestrateur sur FAUX moteur :
débat 3×3 + verdict avec tours qui se répondent et consigne `{angle}/{tours}`
remplacée, conseil parallèle (temps < 2 tours séquentiels) + avis anonymisés
+ règle lecture seule, auto 1 débat + 1 plan + 1 code + 3 tests + 2 reprises
avec `{reprises}` restant, bilan = code + preuve, `testFailed`, store :
persistance mode/config/déroulé, fork hérite, mode inconnu en base → chat) ;
B. service réel (ports dédiés + base jetable) : `conversations:create` avec
mode (inconnu → chat, bornes appliquées), `conversations:setMode` (ack +
bornes + diffusion `conversations:mode`), consigne serveur enregistrée avec
mots-clés non interpolés. QA navigateur sur la pile complète (Next :3000 +
service :3003 + `qa-proxy.ts` :8181) : popover 7 modes, sélection Conseil →
pastille « Conseil · N membres » + panneau « qui travaille », tour conseil
RÉEL via `fake-gateway.ts` → déroulé en direct (Membre A terminé, Membre B
échec honnête, Président fusion), réponse unique « ★ Fusion · Conseil —
2 membres », persistance au rechargement, section Paramètres « Modes de
chat » complète (édition + Réinitialiser vérifiés en base), mobile 390 px.
`bunx tsc --noEmit` 0 erreur ; `bun run build` vert ; eslint : aucune
remontée nouvelle (les 2 `set-state-in-effect` préexistantes demeurent).

### 7.15 Fait — Un modèle de chat web IA pour chaque mode (F-30b)

Demande de l'utilisatrice : « pour chaque mode, je veux pouvoir assigner un
modèle de chat web IA ». Chaque mode peut donc tourner sur un chat IA web
(`webchat:<site>` — z.ai, Google AI Studio ; un site non vérifié reste
absent des listes, jamais proposé pour échouer après) :

- **Modes à voix** (Comparer, Débat, Conseil, Auto) : chaque voix peut être
  un chat web — la liste de choix (« qui travaille » du composer ET les voix
  de la page Paramètres) porte deux groupes lisibles : les modèles du moteur,
  puis « Chats IA web — pilotage navigateur » avec une ligne honnête (Hermes
  ouvre le site dans son navigateur de pilotage, la réponse arrive d'un bloc,
  les tours s'enchaînent l'un après l'autre — la file du pilote sérialise les
  voix webchat, un seul navigateur).
- **Modes sans voix** (Chat, Plan, Code) : une ligne « Modèle du mode » dans
  le pied du sélecteur et une ligne Paramètres par carte — l'assignment du
  mode remplace le modèle de la conversation quand le mode est actif
  (`mode_config.model`, normalisé côté service, id invalide → null). Les
  défauts des nouvelles conversations vivent dans le registre client
  `hermes.modes.models` (le défaut rejoint la conversation au changement de
  mode, mêmes règles que les voix).

**Côté service.** `orchestratorDeps.runVoiceTurn` route un id webchat vers
`runWebchatTurn` (capture silencieuse, statuts du pilote affichés, consigne
de la voix prépendée au message — un site web n'a pas de systemPrompt ; les
fichiers du mode build sont réinjectés en blocs nommés, helper
`webchatFileBlocks` partagé avec le tour webchat principal). `runAssistantTurn`
applique le modèle du mode (`turnModelId`) aux tours non orchestrés hors
variantes. Deux corrections au passage : la consigne commune `compare.main`
était morte depuis F-30 (les variantes sautaient la section de mode — elle
part maintenant sur chaque colonne) ; la consigne du mode (plan/code/chat)
était perdue sur un tour webchat (elle est prépendée au prompt). Chip du
déroulé : un chat web est affiché par son site (« z.ai », « Google AI
Studio ») via `shortModel`.

**Côté client.** Composant partagé `model-choice-list.tsx` (groupes moteur /
chats web, option « Modèle de la conversation », libellé officiel si connu) —
utilisé par `mode-picker.tsx` (listes de voix + ligne « Modèle du mode ») et
`modes-section.tsx` (`VoiceRow` + `ModeModelRow`). `ModeConfig.model` miroir
client + `mergedModeModel` (le choix de la conversation gagne, même null).
Textes simples partout : « Ce que Plan utilise par défaut — modèle du moteur
ou chat IA web ; sans choix, celui de la conversation. »

QA : `scripts/test-modes-flow.ts` **82/82 verts** (nouveaux checks : normalisation
de `config.model` — chat web conservé, trim, invalide → null ; `modeModel` ;
`shortModel` webchat → site ; débat avec une voix webchat transmise telle
quelle au moteur + chip « Google AI Studio » dans le déroulé ; service réel :
`setMode` persiste le modèle du mode via `config.model`). `tsc --noEmit` 0
erreur (client), eslint sans remontée ; contrôle type du service : aucune
erreur nouvelle (les `import.meta.dir`/`bun:sqlite` préexistants tiennent aux
types Bun absents du bac à sable, pas au code).

## 8. Dettes techniques et pièges

- ~~`prisma/schema.prisma` et les scripts `db:*`~~ **retirés le 2026-11-14 (v2.4)** :
  plus de fichier ni de dépendance Prisma dans le repo (le client `src/lib/db.ts`, la
  génération du client dans le lanceur Windows et les mentions des README sont partis
  avec) — la persistance réelle est `bun:sqlite` (`store.ts`) depuis l'origine.
- `.env`, bases SQLite et fichiers uploadés sont **committés dans le repo** : pratique en
  solo, à revoir avant toute ouverture publique.
- Pas de tests frontend automatisés ; seuls des scripts de test manuels (`scripts/`).
- Pas de remote git configuré dans l'environnement de travail (voir §10).
- Pièges UI hérités de la vision artefacts : jamais d'artefact plein format dans le flux ;
  rendu asynchrone jamais bloquant (source d'abord, vignette ensuite) ; vignette PDF =
  première page seulement.
- **Piège socket.io (v2.4)** : un emit-ack n'accepte qu'UN ack — le client appelle le
  callback puis le retire ; un second `cb(...)` (même id) est silencieusement ignoré.
  Ne jamais « acker deux fois » (voir le contrat `conversation:compact`, §9 (21)).
- Piège QA : le z-ai du bac à sable renvoie parfois 429/pend — espacer les scripts à
  tours SDK réels et les repasser (transitoire, cf. §9 (20)).

## 9. Journal des décisions

| Date | Décision |
| --- | --- |
| 2026-11-12 (sessions précédentes) | Vision artefacts validée : split view ≈ 45 % repliable, cartes inline compactes à 3 états, versioning v2+, panneau multi-rendus, pipeline chrome-headless-shell, browsing discret. |
| 2026-11-12 (sessions précédentes) | **Modif 1** : le panneau artefact s'ouvre **automatiquement** à la naissance d'un artefact (écart assumé avec la vision d'origine qui préconisait le contraire). Implémenté. |
| 2026-11-12 (sessions précédentes) | **Modif 2** : sidebar à **largeur fluide** (redimensionnable). Demandé, pas encore implémenté — à livrer avec le chantier projets. |
| 2026-11-12 (sessions précédentes) | Artefacts étapes 1-5 implémentées et testées (socle SQLite + API, cartes, panneau, pipeline de rendu, versioning + diff). |
| 2026-11-12 | Rangement des conversations **par projet** validé : pure couche storage/présentation, le moteur de sessions est agnostique. |
| 2026-11-12 | Stratégie anti-écrasement validée face aux mises à jour Hermes : couplage limité au connecteur, nouveaux fichiers pour le fork, migrations additives — rien ne s'écrase automatiquement. |
| 2026-11-12 | **Séparation des paramètres** `hermes.*` / `fork.*` validée (design à deux registres, §6). Page de paramètres différée ; le socle (registre + table `settings`) est posé avec le chantier projets. |
| 2026-11-12 | Priorité des chantiers : **UI projets d'abord**, page paramètres ensuite, browsing en dernier. |
| 2026-11-12 | **UI projets livrée** (plan §7.2 complet) : migration additive (`projects`, `conversations.project_id` + index, table `settings`), événements `projects:list/create/rename/delete/reorder` + `conversations:move`, sidebar groupée repliable avec drag & drop `@dnd-kit`, **sidebar à largeur fluide** via `react-resizable-panels` (Modif 2 honorée), réglages `fork.ui.sidebar.width`, `fork.projects.sort`, `fork.projects.collapsed` déclarés dans le registre. Scripts de test : `scripts/test-projects-flow.ts`, `scripts/seed-projects-demo.ts`. |
| 2026-11-12 | **Préparation publication GitHub** : retrait du suivi git de toutes les données locales et personnelles (`.env`, `db/`, `tool-results/`, `upload/`, `download/`, `.zscripts/` — fichiers conservés sur disque, ignorés via `.gitignore`) ; audit sécurité de tout l'historique (aucun token ni secret). Remote `origin` configuré ; branche `publish` = commit unique propre pour GitHub, `main` conserve l'historique de travail complet (voir §10). |
| 2026-11-12 | `README.md` racine ajouté (page d'accueil du repo GitHub). Troisième voie de publication : **archive zip** des fichiers seuls (`download/push/hermes_ui-a-televerser.zip`), pour téléversement manuel via l'interface web GitHub — sans historique git, choix de l'utilisatrice. |
| 2026-11-13 | **Composer v2 livré** (cf. §7.3) d'après la maquette validée, versionnée au passage dans `design/maquette-composer.html`. 5 erreurs TypeScript introduites par le chantier corrigées avant publication (props `onUploadFile`/`onTranscribe` du composer, `TurnRequest` `string \| null`, `@ts-expect-error` obsolète du démo-engine) ; `bunx tsc --noEmit` ne remonte plus que les 10 erreurs préexistantes hors périmètre (API Bun vues par le tsc racine, outillage du bac à sable). Artefacts de publication régénérés : `publish` passe à 2 commits propres (base + Composer v2), bundle et zip à jour. |
| 2026-11-13 | **Repo GitHub passé en privé** et publication depuis le bac à sable : `publish` (2 commits propres) poussé sur `main` distant via PAT fine-grained fourni dans le chat — utilisé en helper d'identification **jetable** (jamais écrit dans `.git/config`, `~/.git-credentials` ni aucun fichier ; bac à sable audité après coup). Le PAT étant à expiration illimitée, le régénérer reste conseillé en cas de doute. |
| 2026-11-13 | **Chantier paramètres démarré** : forme = Sheet overlay 460px depuis la droite (chat visible derrière), contenu = les deux registres seuls (§6), application = immédiate via CustomEvent `hermes-ui:settings-changed` émis par `writeClientSetting()` + badge « au rechargement » (seul `fork.projects.sort`, lu au montage par la sidebar), entrée unique = engrenage de la carte de statut de la sidebar (palette/raccourci refusés en v1). Maquette `design/maquette-parametres.html` produite (scènes A-E + spec des clés/fichiers) — en attente de validation avant implémentation. |
| 2026-11-13 (2) | **Paramètres v2 — retour utilisatrice intégré** (design globalement validé, puis : tooltips, moins d'infos visibles, carte de statut post-gateway, paramètres moteur complets) : descriptions du registre → tooltips « ? » focusables (tap = popover mobile) ; carte de statut promue barre de santé (3 états, ligne version/fournisseur/clé active une fois la gateway branchée) ; **drill-down « Paramètres moteur »** en bas du sheet (460px inchangé) — 8 catégories dont **Fournisseurs & clés** (porte-clés multi-clés, ordre = priorité, test réel dès la démo, relai sur 429/quota, tables additives `providers`/`provider_keys`, clés jamais en clair côté client) et **Connecteurs** (services à clé : Tavily, Exa — héritent du porte-clés ; daemons locaux : dev-browser, Scrapling — statut/version/ping ; distincts des fournisseurs et des outils) ; `apply` live/next-turn/reload/restart remplace `requiresRestart` (badges seulement pour reload/restart) ; étage moteur piloté par schéma découvert `settings:schema`, simulé en démo. Maquette v2 produite (scènes A-K + spec deux étages + taxonomie + phasage v2.1→v2.4) — en attente de validation. |
| 2026-11-13 (3) | **Connecteurs redéfinis** (retour utilisatrice) : un connecteur = un **projet GitHub importé** (outil, skill, serveur MCP) — source, canal (branche/tag) et commit exact suivis ; cycle **Vérifier / Mettre à jour / Épingler** + retour arrière (l'historique local garde la version précédente) ; effet selon le type (outil = prochain tour, skill = rechargement, MCP = redémarrage averti). **Tavily et Exa quittent les connecteurs** : services hébergés à clé → **services d'API** au sein de Fournisseurs & clés (porte-clés, test et relai partagés). Maquette v2 corrigée en conséquence : scène E élargie (services d'API avec porte-clés), scène F = gestionnaire d'imports GitHub (formulaire d'import, « Tout vérifier », changelog de commits, épinglage, échec de vérif), grille d'outils / MCP / spec revues ; table additive `connectors` + événements `connectors:check` / `connectors:update`. |
| 2026-11-13 (4) | **Paramètres v3 — sections séparées + maquette interactive** (retour utilisatrice : sections à part entière pour skills/tools/mcp/mémoire/profil/système, moins de détails, skills et .md éditables, modèle ou service associé par outil, profils avec skills + modèle par défaut, chercher d'autres paramètres activables) : étage moteur à **10 catégories** (ajout Modèle & raisonnement ; Mémoire séparée) ; **éditeurs in-sheet** pour skills et fichiers .md (SOUL/AGENTS/AGENTS.override/CLAUDE + MEMORY/USER) ; sélecteur **modèle/service associé** sur les lignes d'outils ; éditeur de profils avec **sélection de skills** et modèle par défaut ; paramètres activables **ancrés dans la doc amont hermes-agent** (toolsets réels, credential pools natifs — stratégies et cooldowns, réglages mémoire, priorité des fichiers de contexte, `pre_update_backup`, backends terminal) ; pied de sheet = « Mode démo » + compteur « N en attente ». Maquette **interactive** `design/maquette-parametres-v3.html` (16 vues cliquables, QA par captures) remplace la planche v2 comme référence de validation — v2 archivée. |
| 2026-11-13 (5) | **Paramètres phase 1 livrée (étage client)** d'après la maquette v3 : sheet 460 px (Radix Dialog maison), engrenage dans la carte de statut, section « Cette interface » (7 lignes des deux registres, favoris internes cachés), tooltips « ? » (focusables, tap mobile, un seul ouvert, flèche), contrôles par type de réglage ; **application immédiate généralisée** via le bus `hermes-ui:settings-changed` émis par `writeClientSetting()` (page → largeur sidebar, sidebar → tri + repliage, composer → jauge, hook → modèle/effort/permissions) — badge « au rechargement » abandonné, tout est live ; interrupteur « Dossiers de projet repliés » dérivé du registre (tout replier / tout déplier) ; porte moteur = 10 sections « à venir » (structure v2.2+, aucune donnée simulée) ; pied « Mode démo » + compteur « N en attente » (prop `pendingEngineCount`, masqué à 0). Fix : course au montage de la largeur sidebar (le `onResize` initial de la lib écrasait la valeur persistée) neutralisée par `sidebarRestoredRef`. `bunx tsc --noEmit` : 0 erreur dans `src/`. |
| 2026-11-13 (6) | **Paramètres v4 — maquette** (sixième session, consignée a posteriori) : proposition de remplacement du sheet 460 px par un **volet gauche ~860 px** ancré, navigation par rail (plus de forage), **pastilles** comme unique langue d'état (vert/orange/rouge), descriptions simples sous les libellés (tooltips = exemples), sections réorganisées — Modèles (modèle d'arrière-plan, effort dynamique), Fournisseurs LLM **séparés** des clés de services, Extensions (ex-Connecteurs + MCP fusionnés, activer/désactiver), Outils (détail dépliable, création), Skills (recherche + contrôle qualité en langage clair), Hermes (mémoire + .md + compaction + comportement). `design/maquette-parametres-v4.html` committé (`4c6269d`) — **en attente de validation, rien d'implémenté**. |
| 2026-11-13 (7) | **Chat UX F-01/F-04 livré — arrêt propre + erreurs persistantes** : `stream:done` porte `stopped: true` quand `chat:stop` clôt le tour (un arrêt n'est plus traité comme une erreur) ; `ChatMessage.stopped` persisté (migration additive `messages.stopped`, transportée par append/gets/fork) et affiché (« Réponse interrompue ») ; arrêt avant le premier jeton = pas de bulle vide ; `stream:error` embarque le partiel persisté + la conversation — le client l'affiche immédiatement dans le fil avec rangée persistante **Réessayer / Masquer** (plus d'effacement automatique à 2,5 s) ; machine à états `turnState` (idle/streaming/stopped/error) + `turnError`/`retryAfterError`/`dismissTurnError` exposés par le hook. Scripts de test : `scripts/test-stop-error-flow.ts` (scénarios 1-3 en service normal, scénario 4 avec `scripts/fake-zai-error.preload.ts` — preload qui fait échouer le LLM après 2 deltas ; NB : il cible la copie du SDK du mini-service, pas celle de la racine). QA par captures : `download/qa-f01-f04/` (erreur persistante, masquée, arrêt propre, pastille, régénération). Docs : `docs/ROADMAP_FRONT.md` (nouveau — suivi F-xx réconcilié avec le code), README mini-service (payloads stream:*), §7.5 ajouté. `bunx tsc --noEmit` : 9 erreurs préexistantes hors périmètre, 0 dans `src/`. |
| 2026-11-13 (8) | **Paramètres phase 2 livrée — volet v4 + Fournisseurs & clés + Extensions (v2.2)** : menée sur la maquette v4 à la demande « continue » de l'utilisatrice (validation formelle a posteriori, ajustements sur l'implémenté). Volet gauche 860 px à rail (10 sections, pastilles, plein écran < 1100 px) remplace le sheet 460 px ; Interface gagne le **Thème** (next-themes) et **Afficher le raisonnement** (`fork.ui.showReasoning`, appliqué en direct aux bulles) ; serveur : tables additives `providers`/`provider_keys`/`extensions` (colonne `applied` = effet au redémarrage, compteur « N en attente »), « Tester » = **appel réel** exécuté par le service (401 → « clé refusée », 429 → épuisée), secrets **jamais** renvoyés au navigateur (masquage `sk-••••7f3a`), imports GitHub **réels** avec **repli `git ls-remote`** quand l'API est au quota (jeton `GITHUB_TOKEN` optionnel), Vérifier / Mettre à jour / Épingler ; stratégies de porte-clés prêtes pour le moteur (`pickActiveKey`, non consommées en démo — assumé). Suppression du « commit » SQLite réservé (colonne quotée). QA : `scripts/test-providers-flow.ts` 29/29 (test clé réel → 401, import GitHub réel), 14 captures `download/qa-parametres-v2/` contrôlées par script + VLM. `bunx tsc --noEmit` : 0 erreur `src/` ; eslint propre. |
| 2026-11-13 (9) | **F-11 + F-19 livrés — Prompt système & instructions personnalisées** (neuvième session, point 2 de l'ordre recommandé) : le prompt **s'ajoute** aux instructions de base, jamais les remplace. Table additive `system_prompts` (scope `conversation` / `preset`, 5 presets semés), instructions globales dans `settings` (`hermes.instructions.custom`, max 4 000 car.) ; événements `system-prompt:*` / `system-prompts:*` / `custom-instructions:*` avec broadcasts ; composition côté service (démo : base + F-19 + F-11 ; gateway : `system_prompt` seul dans `api_turn_v1.settings`), `hello.systemPromptChars` honnête ; hook `use-system-prompts`, `SystemPromptPanel` (sheet 460 px, bouton « prompt » + pastille d'en-tête), section **Hermes** du volet v4 livrée (instructions globales + bibliothèque éditable — mémoire et .md restent à venir), poste « Prompt de conversation » dans la jauge. QA : `scripts/test-system-prompt-flow.ts` **24/24**, dont vérification comportementale réelle (LLM démo répond « B »), isolation entre conversations, garde-fous de longueur. `bunx tsc --noEmit` : 0 erreur `src/` ; eslint propre. |
| 2026-11-13 (10) | **F-13 livré — Partage public lecture seule + export image** (dixième session, point 3 de l'ordre recommandé) : le lien est un **snapshot figé** (la conversation peut continuer sans changer le lien ; révocation → 410 Gone sans toucher la source ; suppression de la conversation → liens 410 persistant). Table additive `shares` (token opaque 24 car. base62, un lien actif max par conversation — recréer révoque l'ancien) ; événements `share:get/create/revoke` + broadcast `share:changed` ; HTTP (3004) : `data.json` public sans id interne (CORS `*`) et `image.png` plein page via le pipeline chrome-headless-shell. Client : page publique `/shared/[token]` (`noindex`, Markdown réutilisé, états révoqué/introuvable) + menu « Partager » de l'en-tête (créer/copier, ouvrir la vue, révoquer). QA : `scripts/test-share-flow.ts` **24/24** (404/410, remplacement, isolation, PNG Chrome valide ~35 Ko) ; page servie et snapshot chargé vérifiés en dev ; `bunx tsc --noEmit` : 0 erreur `src/` ; eslint propre. |
| 2026-11-13 (11) | **F-24 livré — Feedback intégré 👍/👎 + commentaire** (onzième session, point 4 de l'ordre recommandé) : retour **local, jamais envoyé au modèle** (protocole gateway inchangé). Migration additive `messages.feedback_rating`/`feedback_comment` + `setMessageFeedback` (assistant seule, troncature 2 000, `null` = efface) ; événement `feedback:set` + broadcast `feedback:changed` ; client `FeedbackControl` dans la rangée d'actions (re-clic = efface, popover commentaire, pastille italique), câblage list→page, action optimiste du hook avec retour arrière si refus. Assumé : fork repart sans retours. QA : `scripts/test-feedback-flow.ts` **15/15** (pose, inversion, troncature, garde-fous, retrait, persistance au rechargement, isolation) ; `bunx tsc --noEmit` : 0 erreur `src/` ; eslint sans nouvelle erreur. |
| 2026-11-13 (13) | **F-22 complété — Mode expert : température, plafond de jetons, graine** (douzième session, suite) : bornes tirées de sondages SDK réels — température **[0,1]** (le fournisseur rejette au-delà, erreur 1210 ; l'échelle [0,2] d'OpenAI ne s'applique pas), `max_tokens=1` accepté et tronquant réellement (plancher 1, pas 16 — un plancher à 16 laissait passer des phrases courtes entières, détecté en QA). `sanitizeExpertSettings` (prompts.ts) : clamps [0,1]/[1,8192]/entier 32 bits, `null`/non-numériques ignorés (piège `Number(null)===0` corrigé) ; branché sur `chat:send`/`chat:regenerate`/`message:edit` ; injecté au LLM démo pour de vrai + `api_turn_v1.settings` en gateway. Client : section repliable « Mode expert » du popover sélecteur (curseur 0–1, compteur actifs), registre `hermes.expert.*`, payloads du hook. QA `scripts/test-expert-flow.ts` **14/14** (assainissement 9, comportemental troncation, tolérance 429 anti-rate-limit) ; tsc 0 / eslint propre. |
| 2026-11-17 | **Ré-attache des tours en vol — « quitter puis revenir »** (session du 2026-11-17) : signalée par l'utilisatrice — quitter une conversation pendant une génération puis y revenir montrait un tour mort. Diagnostic : le client efface son état de stream au changement (`setStreamsRecord({})`), `stream:start` ne se reproduit pas, les deltas sans entrée étaient jetés, et le message assistant n'est persisté qu'à la clôture — le tour vivait côté service mais plus nulle part côté écran. Fix : le service tient un **registre des tours en vol** (`liveTurns`, simple + variantes a/b, contenu/reasoning accumulés, statut, événements outil) alimenté par `liveSync` à chaque delta/statut/outil, purgé avant tout événement terminal (try/catch/finally, garde d'identité) ; `conversations:open` renvoie ces tours (`live`) et **réaligne la position d'émission** sur le contenu snapshot — les deltas suivants raccordent le client sans trou ni queue dupliquée. Client : l'ack re-sème `streamsRecord` derrière la garde de course (aucune entrée fantôme, l'ack tardif d'une autre conversation ne sème rien). QA : `scripts/test-reattach-stream.ts` **18/18** (service réel + faux fournisseur lent : préfixe exact, reconstitution `re-semé + deltas = final`, snapshot sans la réponse, registre purgé après clôture, conversation calme sans entrée) ; garde de source ajoutée dans `test-source-guards.ts` (re-semis derrière la garde activeIdRef) ; suite complète **23/23**, tsc 0 erreur, eslint propre. |
 **F-18 livré — Mémoire utilisateur** (douzième session ; l'ordre recommandé était épuisé côté démo, premier P2 non bloqué) : mémoire **consultable, éditable, effaçable**. Clés `hermes.memory.{enabled,autoLearn,notes}` (table `settings`, fallback additif : absentes = actives) ; événements `memory:*` + broadcast ; `composeDemoSystemPrompt` gagne la section « Mémoire de l'utilisateur », jauge `systemPromptSize` et `hello.memoryChars` honnêtes ; en gateway `memory_notes`/`memory_auto_learn` dans `api_turn_v1.settings` (clés à valider, convention Composer v2). Client : `MemoryCard` de la section Hermes (interrupteur, apprentissage automatique honnête, éditeur 12 000 car., effacement) + hook `use-memory`. NB : MEMORY.md/USER.md du moteur non touchés — l'apprentissage réel viendra avec la gateway. QA : `scripts/test-memory-flow.ts` **17/17** re-passé (garde-fou 12 000, broadcasts, comportemental : la démo cite la mémoire, désactivation coupe l'injection) ; `bunx tsc --noEmit` : 0 erreur `src/` ; eslint propre. |

## 10. Synchronisation git et passation

- Repo GitHub de référence : `https://github.com/auriannedrumont-eng/hermes_ui`
  (**privé**). Les commits propres y ont été publiés le 2026-11-13
  (`git push origin publish:main`) ; le distant suit désormais notre lignée.
- Remote `origin` configuré dans l'environnement de travail, **sans credentials** :
  un push depuis le bac à sable nécessite un PAT fine-grained GitHub (droits
  *Contents : Read & write* sur le seul repo `hermes_ui`, expiration courte), fourni
  au moment du push, ou passe par le bundle (`download/push/`).
- Deux branches locales :
  - `main` : historique de travail complet (commits de session, messages techniques) ;
  - `publish` : **commits propres, un par chantier livré** (base : artefacts + UI projets ;
    puis Composer v2), signés `auriannedrumont-eng
    <355807939+auriannedrumont-eng@users.noreply.github.com>`, arbre identique à `main`
    sans les données locales — c'est celle qu'on pousse vers GitHub
    (`git push origin publish:main` ; le `--force` n'est plus nécessaire depuis la
    publication du 2026-11-13 — le distant suit notre lignée, les push suivants
    sont des fast-forward).
- Le repo GitHub ne contient volontairement **aucune donnée locale** : bases SQLite
  (`db/`), uploads de conversation, artefacts dérivés, dumps d'outils
  (`tool-results/`), livrables (`download/`), matériaux de session (`upload/`) et
  outillage du bac à sable (`.zscripts/`) sont ignorés par `.gitignore`.
  Audit sécurité de tout l'historique effectué le 2026-11-12, ré-audit du chantier
  Composer v2 le 2026-11-13 : aucun token ni secret.
- Recette de republication après une session de travail :
  1) committer sur `main` ;
  2) ajouter un commit propre sur `publish` : `git switch publish &&
     git restore --source=main --staged --worktree -- . && git add -A &&
     git -c user.name="auriannedrumont-eng" -c user.email="355807939+auriannedrumont-eng@users.noreply.github.com" \
       commit -m "<résumé du chantier>" && git switch main` ;
  3) pousser : `git push origin publish:main`.
- Les livrables par archive restent possibles (`scripts/package-livrables.sh`).
- **Téléversement manuel (sans git)** : `download/push/hermes_ui-a-televerser.zip`
  contient les fichiers seuls de `publish` (sans historique). Convient à un upload
  via l'interface web GitHub (limite : 100 fichiers par glisser-déposer — uploader
  dossier par dossier, `src/` = 81 fichiers passe seul). Le repo obtenu n'a alors
  qu'un commit d'upload, sans message descriptif ni auteur configuré.
- **Checklist de passation à un nouveau LLM** : 1) lire ce `FORK.md` en entier ;
  2) lire `mini-services/hermes-chat/README.md` ; 3) `git log` + `git status` pour voir
  l'état réel ; 4) vérifier ce qui reste à faire (§7) ; 5) respecter les conventions (§5) ;
  6) consigner toute nouvelle décision au §9.
| 2026-11-13 (14) | **Fixes layout d'après captures utilisatrice** : (a) volet Paramètres `flex-col` → `min-[1100px]:flex-row` (rail 208 px et contenu sont frères — le rail se rendait en bloc empilé 208×455, titre à y≈455, mesuré) ; (b) app tenant sur la hauteur de son contenu (`ResizablePanelGroup` : style inline `height:100%` de la lib écrase `h-dvh`, parent sans hauteur) → wrapper racine `div.h-app-full` + utilitaires globals.css `h-app-full`/`min-h-app-full` (`100vh` puis `100dvh` sous `@supports`, repli navigateurs sans dvh), appliqués au volet, au panneau prompt système et à la vue partagée. QA mesurée (`scripts/qa-layout.ts`, Chromium 1280×1080 + 900×800) + VLM (`download/qa-layout-fixes/`) ; tsc 0 / eslint propre. Non-bug : 70B (défaut service) vs 405B (sélection persistée). Poste Windows : `git pull` puis effacer `.next/` pour reconstruction au prochain double-clic. |
| 2026-11-13 (15) | **F-17 livré — Comparaison de modèles** : un message utilisateur → deux tours parallèles (variantes `a`/`b`), réponses côte à côte (grille 2 colonnes ≥ 768 px, empilées en dessous, badges A/B + modèle, régénération par côté via `chat:regenerate {variant}` ou les deux via `{compare:[a,b]}`). Protocole : `compare?: string[]` sur `chat:send`/`chat:regenerate`/`message:edit` (exactement 2 ids distincts, refus propre sinon), événements `stream:*` portant `variant` (ignoré quand absent — rétro-compatible), chaque modèle ne voit que SES réponses dans l'historique (dialogue bilatéral honnête). Persistance additive : colonne `messages.variant` (`ALTER TABLE`, transportée par append/get/fork). Clés de tour : `conv`, `conv:a`, `conv:b` (`isRunning`/`abortRunning` — `chat:stop` coupe tout, gardes anti-tour couvrent les trois clés). Client : `StreamingState` devient une map par messageId (`streams`, `streaming` = première entrée — tous les gardes existants inchangés), `buildRows` groupe les variantes en paires (`ComparePair` de `message-list.tsx`), toggle « Comparer » + pickers A/B compacts dans le composer (`slotLabel`/`bare` du `ModelPicker`), paire mémorisée `hermes.compare.models` (§6). QA : `scripts/test-compare-flow.ts` **33/33** (refus d'ids invalides, tour complet 1 user + 2 assistant tagués, régén d'un seul côté — l'autre intact, gardes en vol, stop des deux côtés puis tour simple accepté, fork avec variantes, édition relançant les deux) ; visuelle `scripts/qa-compare-visual.ts` via Caddy (2 colonnes 354 px, réponses distinctes, VLM sans anomalie — captures `download/qa-f17-compare/`) ; tsc 0 erreur `src/` ; eslint propre. NB QA : le socket passe par `/?XTransformPort=3003` → Caddy obligatoire (comme en prod), sinon l'app reste « Hors ligne » (constaté : captures de layout antérieures prises hors ligne — sans incidence sur les correctifs CSS). |
| 2026-11-14 (17) | **v2.3 livré — le moteur démo consomme les clés fournisseurs** (`llm-pool.ts`, demande de l'utilisatrice : « les modèles n'apparaissent pas dans le sélecteur » après ajout d'une clé z.ai testée) : en mode démo, les tours partent sur l'API du fournisseur à clé active (OpenAI-compatible : z.ai, OpenRouter, Mistral, OpenAI, DeepSeek, Groq, Ollama keyless, adresses personnalisées + adaptateur Anthropic messages-API) ; `models:list` devient **vivante** (GET /models, filtrage non-chat, `source: "providers"` — le sélecteur groupe par fournisseur, la sélection s'aligne sur `defaultModel`) ; `pickActiveKey` + `markKeyUsed` enfin consommés, 401/429 → clé déclassée puis retente, usage capturé passivement, retente vision automatique (400 image → modèle vision de la liste), compaction via le même pool ; erreur fournisseur **sans repli SDK silencieux** (l'utilisatrice croirait parler au modèle sélectionné) ; erreur SDK « .z-ai-config » rendue pédagogique (orienter vers le volet) ; broadcast `models:changed` sur toute mutation du porte-clés ; message persisté « modèle · fournisseur ». Choix assumé : un modelId hors listes vivantes (ex-id du catalogue Hermes) part sur le premier modèle du premier fournisseur actif — le message persiste le modèle RÉELLEMENT utilisé. `http` strictement local admis (même règle que le test de clé). QA `scripts/test-pool-flow.ts` **24/24** (listes vivantes, filtrage, 401 déclassé + erreur claire, tour streamé, stop en plein vol partiel, retente vision, repli catalogue/SDK sans fournisseur). NB dette tsc : le `bunx tsc` racine compile scripts/examples (24 erreurs préexistantes, inchangées) — le critère reste « 0 erreur `src/` » (§5). |
| 2026-11-14 (18) | **F-21 livré — jetons & coût par message** : usage réel persisté quand l'API le renvoie (colonnes additives `messages.usage_input/output/cost`, transportées append/get/fork + partiel d'erreur) ; **tarifs déclarés par l'utilisatrice** (`hermes.pricing`, §6) — jamais pré-remplis, le fournisseur fait foi ; carte repliable sous chaque réponse : jetons réels sinon estimation ~, coût facturé (OpenRouter) > estimé selon tarifs > « tarifs non renseignés » (jamais deviné) ; bloc « Tarifs des modèles » du volet (saisie $ entrée/sortie par modèle, retrait, broadcast `settings:changed`), hook `use-pricing` (un seul abonnement socket partagé), lib pure `src/lib/pricing.ts`. Libellé matché par id nu (« glm-4.6 · z.ai » → `glm-4.6`). QA `scripts/test-cost-flow.ts` **21/21** (usage transporté+persisté, aller-retour hermes.pricing + broadcast, parsing des libellés, coûts, formats $, JSON tolérant). |
| 2026-11-14 (19) | **F-09/F-12 livrés — recherche web + citations** (démo via les clés de services, sans attendre la gateway) : toggle « Web » du composer (actionnable si une clé Tavily/Exa existe — sinon infobulle qui oriente ; « Image » et « Agent » verrouillés « nécessite la gateway ») ; le service lance la recherche avant le tour (événement outil « Recherche web » running → done/error), injecte les résultats numérotés en fin de prompt système du tour démo avec consigne de citation [n], persiste les sources (`messages.sources`) ; **best effort** — un échec n'annule jamais le tour, l'événement l'affiche honnêtement ; en gateway : événement explicatif, aucune injection (l'agent Hermes gère son browsing). Comparaison = brute : webSearch ignoré en compare (même philosophie que le picker `bare`). `providers:add` accepte une **adresse explicite** (`baseUrl` — surcharge https/http-local de l'adresse canonique d'un fournisseur connu). Sources cliquables sous la réponse (rangée `Sources :`, titre+extrait au survol). QA `scripts/test-web-flow.ts` **14/14** (surcharge d'adresse, running→done, injection prouvée par la réponse, sources persistées + réouverture, toggle éteint = rien, sans clé = erreur claire et tour sauf). |
| 2026-11-13 (16) | **F-14 livré — Navigation entre versions** : régénérer ne supprime plus — colonnes additives `messages.version_group/index/active` (retro-complétion à la 1re régénération, migration `ALTER TABLE` douce), `getMessages` renvoie le chemin actif enrichi de `versions {group,index,count}`, `supersedeTrailingAssistant` (traverse l'autre variante F-17, stoppe au user) remplace la suppression dans `chat:regenerate` (3 chemins), `message:setVersion` + broadcast `messages:refreshed`, `messages:superseded` aux autres sessions, promotion de la dernière version restante à la suppression d'une version active, fork = instantané du chemin actif. Client : sélecteur ‹ n/m › permanent dans `MessageBubble` (aussi dans les cellules de comparaison), hook `setMessageVersion`, garde défensive `regenerate` (événement React passé en 1er arg par un `onClick` direct — seul `"a"/"b"` compte, correctif double hook+page). Choix documenté : l'édition d'un message utilisateur reste fork explicite (« Branche ») — pas d'arbre de branches implicite. QA : `scripts/test-version-flow.ts` **21/21** ; visuelle ‹ 2/2 › → ‹ 1/2 › confirmée (captures `download/qa-f14-versions/`) ; tsc 0 / eslint propre. |
| 2026-11-14 (20) | **Livraison de la session** : repassage QA complet — providers, pool 24/24, coût 21/21, web 14/14, compare 33/33 (correctif : le script écoutait `messages:removed`, dette laissée par F-14 → `messages:superseded`), version 21/21, stop/error — tous verts ; QA DOM v2.3 12/12 (captures `download/qa-v23/`). NB : le rate-limit 429 du bac à sable z.ai fait échouer temporairement les scripts à tours SDK réels — les espacer. La branche `publish` avait été **perdue au recyclage du bac à sable** (le clone n'a que `main`) : recréée depuis `origin/main` + commit propre signé (recette §10 respectée) ; artefacts régénérés dans `download/push/` (archive zip de téléversement, `git format-patch`, bundle). Le push reste à faire : sans PAT (fourni au moment du push uniquement, jetable — cf. §10) ou téléversement du zip via l'interface web GitHub par l'utilisatrice. Poste Windows : `git pull` (une fois poussé) puis effacer `.next/`. |
| 2026-11-14 (21) | **v2.4 livrée — « le volet devient réel »** (suite de « lance ce chantier et tous les autres ») : les 10 sections du rail sont réelles. Outils (statuts réels : Web suit les clés de services, voix/vision livrées ; le reste verrouillé « gateway », jamais simulé), Skills (état vide honnête + liens croisés), Profils (création depuis les réglages courants, application par le bus `hermes-ui:settings-changed` — effet immédiat sans dépendance moteur, duplication, suppression ; liste côté service `hermes.profiles`, lib `src/lib/profiles.ts` + hook `use-profiles`), Système (sondes réelles dans `hello` : `appRevision` = révision git du déploiement, `chromeHeadless` ; événements `system:renderCache`/`system:clearRenderCache` sur les profils de rendu Chrome, purgés aussi au démarrage), Hermes « Conversations longues » (résumé automatique avant le tour, seuil 50–95 %, fenêtre suivie/estimée — décision pure `src/lib/compaction.ts`, exécution `conversation:compact` existant). **Contrat `conversation:compact` changé** : UN SEUL ack À LA FIN avec le compact (`{ok:true, compact, done:true}` ; échec `{ok:false, error}`) — l'ack « started » a été retiré après un piège socket.io démontré par QA : un emit-ack n'accepte qu'un ack, le second appel (même id) est ignoré par le client ; la compaction automatique (v2.4) repose sur cet ack final, `sendMessage` attend la fin avant d'émettre `chat:send` (best effort, timeout 60 s → le tour part quand même + toast honnête). **Correctif de persistance du registre** : `hermes.tools.web` (F-09) et `hermes.compare.models` (F-17) étaient écrits par `writeClientSetting`, qui ignore silencieusement les clés hors registre — la persistance documentée ne fonctionnait pas ; les deux clés sont au registre désormais (plus `hermes.profiles.applied`, interne). F-16 complétée : lecture continue pendant le stream (`useContinuousSpeech` — phrases complètes au fil de l'eau, courtes ignorées, blocs de code « bloc de code », plafond 4 000 car., coupure = silence). §8 : boilerplate Prisma retiré du repo (schéma, `db:*`, `@prisma/client`, `src/lib/db.ts`, génération dans le lanceur Windows, mentions README). QA : `test-autocompact.ts` (unitaire), `test-profiles-flow.ts`, **`qa-v24-dom.ts` 40/40** (volet + profils + F-16 + chemin COMPLET de la compaction automatique prouvé au faux fournisseur : synthèse AVANT le tour, résumé en tête d'historique, message porté, toast v2.4, broadcast à un 3e client) ; repassé : providers 29/29, pool 24/24, coût 21/21, web 14/14, compare 33/33, version 21/21, stop/error, mémoire, prompt système, feedback, expert, partage, intégration — tous verts (échecs initiaux share/expert/intégration = 429 z.ai transitoire, repassés espacés). NB QA DOM : Caddy sur :81 requiert root dans ce bac à sable → variant `/tmp/Caddyfile-8181` sur :8181 (le 81 du Caddyfile du repo reste la référence en production) ; les captures QA vivent dans `download/` du bac à sable, pas dans le repo. Poste Windows : `git pull` (une fois poussé) puis effacer `.next/`. |
| 2026-11-14 (22) | **Lanceur : mise à jour automatique au démarrage** (demande de l'utilisatrice : « modifier le lanceur .bat pour qu'il fasse les mises à jour auto des derniers push » — la logique vit dans `desktop/hermes-ui.ps1`, le `.bat` reste une enveloppe) : `Update-FromGit` appelé par `Ensure-PortableSetup` en étape 3bis (après résolution des outils, avant dépendances/build) — `git fetch` silencieux, comparaison à l'amont (`rev-parse @{u}`), `merge --ff-only` (aucun fichier local modifié n'est jamais écrasé ; divergence → version locale conservée et signalée dans la fenêtre). `GIT_TERMINAL_PROMPT=0` (jamais de blocage console), connexion via Git Credential Manager (fenêtre GitHub au premier lancement seulement, retenue ensuite par Windows). Après mise à jour : `npm install`/`bun install` relancés seulement si les manifestes ont changé ; `.next/` supprimé et `tools\build-echoue.flag` effacé seulement si le code de l'interface a changé (`src/`, `public/`, configs racine) — un push de documentation seule ne reconstruit rien. Garde-fous non bloquants : git absent, dossier non cloné (install zip), origin non http(s), fetch en échec, pas d'amont → message Log + démarrage avec la version présente ; pile déjà lancée → pas de mise à jour (early return existant de `Do-Start`). Conventions du fichier respectées (UTF-8 BOM vérifié par octets, français sans accents, équilibre délimiteurs contrôlé par script — pwsh indisponible dans le bac à sable, relecture ligne à ligne). README-desktop : étape 3 dédiée + renumérotation + ligne « Mise à jour non appliquée » au dépannage ; commentaires d'en-tête du `.ps1` et du `Hermes-Web.bat` racine mis à jour (CRLF et ASCII préservés par édition octets). Poste Windows après ce commit : plus besoin de `git pull` ni d'effacer `.next/` manuellement — le double-clic du lanceur fait tout (premier lancement : la fenêtre de connexion GitHub peut apparaître, une seule fois). |
| 2026-11-14 (23) | **Lanceur v2 — auto-réparation du premier retour terrain** (journal de l'utilisatrice : « nouvelle version disponible mais non appliquée » + build EBUSY `rmdir .next\standalone`) : (a) **nettoyage du verrou périmé déplacé AVANT `Ensure-PortableSetup`** dans `Do-Start` (l'ordre ancien installait/mettait à jour/buildait pendant qu'un ancien serveur de la session plantée tenait `.next` verrouillé → EBUSY ; ordre nouveau : Stop-Tree GW→UI→CHAT + `Wait-Gone` ×3 puis update/build), (b) **fusion impossible → sauvegarde puis alignement** dans `Update-FromGit` (cause réelle constatée : différences locales héritées des livraisons par zip/patchs — la ff-only refusait pour toujours) : liste de sauvegarde = `status --porcelain` (TrimEnd uniquement : l'espace de tête « XY␣chemin » fait partie du format, un Trim complet décale le chemin — bug attrapé par simulation Python avant livraison) ∪ `diff --name-status HEAD..upstream` filtré M/D (couvre les commits locaux dont les fichiers disparaîtraient), copie fichier par fichier (feuille vs conteneur `-Recurse`) dans `desktop\runtime\maj-sauvegarde-<ts>\` + LISEZMOI.txt, puis `reset --hard <upstream>` ; échec de sauvegarde → on ne touche à rien (ancien comportement conservé), (c) **`build-echoue.flag` versionné** : le marqueur mémorise la révision git qui a échoué (`Get-RepoRevision`) ; même révision → saut (pas de boucle), révision différente ou marqueur ancien sans révision → nouvelle tentative bornée (le marqueur se réécrit avec la révision au nouvel échec), git absent → comportement ancien. Données (`db/`, `tools/`, clés) prouvées hors périmètre : ignorées par git, survivent au reset (vérifié par simulation). QA : `scripts/test-lanceur-autorepair.py` — cas A (fichier parasite d'extraction zip), B (fichier suivi modifié), C (commits locaux divergents « git am » d'une ancienne livraison) : listes de sauvegarde exactes, reset OK, fichiers récupérés corrects ; flag ×4 scénarios ; intégrité .ps1 (BOM UTF-8, délimiteurs équilibrés, conventions sans accents). README-desktop : étapes 3/5 et dépannage mis à jour. **Poste utilisatrice — déblocage unique** (son lanceur actuel ne peut pas encore s'auto-réparer) : fermer Hermes, puis dans le dossier `git fetch origin` + `git reset --hard origin/main`, double-clic → nettoyage, « à jour », build retenté (marqueur ancien sans révision), mode production ; les mises à jour suivantes seront 100 % automatiques. |
| 2026-11-14 (24) | **Fournisseur opencode + carte de statut honnête** (retour utilisatrice : « je n'arrive pas à installer le fournisseur opencode » et confusion sur « Hermes 4 70B (démo) · Définissez HERMES_GATEWAY_URL »). (a) **opencode au catalogue** `KNOWN_PROVIDERS` (providers.ts), placé AVANT l'entrée OpenAI — l'adresse officielle `https://opencode.ai/inference/openai/v1` contient « openai » : sans cet ordre, l'adresse collée était reconnue comme OpenAI (et le nom seul « opencode » était refusé : « Fournisseur non reconnu ») — kind llm, `defaultBaseUrl` = `https://opencode.ai/inference/openai/v1` (surface OpenAI-compatible : POST {base}/chat/completions et GET {base}/models vérifiés en direct, 86 modèles), test de clé = GET `https://opencode.ai/inference/v1/models` Bearer (documenté, public). (b) `KNOWN_LLM_BASES["opencode"]` dans llm-pool.ts → les tours partent sur la Console opencode via le pool ; `parseModelList` lit désormais aussi `m.name` (opencode expose `name`, pas `display_name` — libellés lisibles « Big Pickle » au lieu d'ids bruts). (c) **Carte de statut honnête** (la confusion « démo ») : `helloPayload` expose `engineProviders` (nouveau contrat `LlmPoolApi.activeProviderNames()` — fournisseurs à clé active ou keyless), rediffusé à chaque changement du porte-clés (`broadcastProviders` → `io.emit("hello")`) ; côté client : `ServerHello.engineProviders` + écoute `socket.on("hello")` (use-hermes-chat, mise à jour sans rechargement) + props `Sidebar`/`SettingsPanel`. Affichage : gateway inchangée ; moteur intégré avec clés actives → titre « Moteur intégré · vos clés répondent », ligne « Clés actives : … », pastille émeraude (sidebar + pied du volet) ; rien de branché → message actionnable « Ajoutez une clé dans Paramètres → Fournisseurs & clés, ou définissez HERMES_GATEWAY_URL… » (l'ancienne ligne s'affichait y compris en mode gateway). Texte du volet : opencode cité dans l'aide d'ajout. QA : `scripts/test-providers-opencode.ts` — faux opencode localhost (models + SSE), 21 contrôles verts : reconnaissance nom/URL (sans confusion OpenAI, OpenAI non régressé), ajout par adresse collée + baseUrl explicite conservée, doublon refusé, clé → hello `engineProviders`, liste vivante (libellés, non-chat écarté), tour complet streamé chez le fournisseur (Bearer transmis, requête OpenAI-compatible, message « big-pickle · opencode », hello après tour). Non-régression : `test-integration-fixes.ts` 0 échec ; `tsc --noEmit` propre sur src/. NB livraison : la chaîne ne devient visible sur le poste utilisatrice qu'une fois le commit poussé ET la mise à jour auto réparée par (23). |
| 2026-11-15 (25) | **Clés z.ai « GLM Coding Plan » (retour utilisatrice : « j'ai testé une clé zai et une opencode, les deux ont été testées ailleurs mais aucune ne fonctionne »)** — sa clé z.ai est un jeton d'ABONNEMENT (JWT « eyJ… », celle qu'on colle dans Claude Code/opencode/Cline), pas une clé API : les deux familles n'ouvrent pas les mêmes portes (docs.z.ai/devpack — Tool Integration, vérifié en direct). Une clé Coding Plan sur la surface standard `api.z.ai/api/paas/v4` → 401 « token expired or incorrect » ; sa surface à elle est `api.z.ai/api/coding/paas/v4` (OpenAI-compatible). Piège supplémentaire vérifié : la surface Anthropic de z.ai renvoie certaines erreurs d'auth dans un CORPS HTTP 200 (`{"code":401,"success":false}`) — un 200 n'est donc pas une preuve de réussite. (a) **providers.ts** : `looksLikeZaiJwt()` (JWT eyJ oui ; clé API xxx.xxxx, sk-…, texte non) ; `testProviderKey` route une clé Coding Plan vers `…/api/coding/paas/v4/models` (une clé API reste sur paas/v4) ; l'ORIGINE d'une adresse explicite remplace celle du test connu (le test interroge ce que le moteur utilisera : proxy, auto-hébergé, faux serveur QA — le chemin connu est conservé) ; reniflage du corps 200-avec-erreur (success:false ou code≠0 sans liste data/models → « clé refusée ») ; libellé « N modèles (Coding Plan) ». (b) **llm-pool.ts** : `routeZaiCoding(endpoint, secret)` réécrit l'endpoint pour la clé CHOISIE (paas/v4 canon → coding ; origine explicite conservée, chemin codé en dur) — appliqué aux listes de modèles, aux tours (runTurn) et à la compaction (summarize) ; repli documenté si la surface coding n'expose pas /models : liste citée par la doc du plan (glm-5.3, glm-5.3-flash, glm-5.2, glm-4.6, glm-4.5) après échec de la liste vivante, jamais bloquant. (c) Aide du volet : « z.ai (clé API ou abonnement GLM Coding Plan) ». (d) **README-desktop : § Mise à jour manuelle** — l'install ZIP d'Aurianne tourne avec le lanceur v1 qui renonce dès qu'une mise à jour est disponible (problème œuf/poule : le correctif (23) ne peut pas lui arriver par la mise à jour auto) ; procédure unique : clone propre à côté (jeton en ligne de commande puis `remote set-url` pour l'effacer), copie de `db\` (conversations+clés+pièces jointes, tout ce qui lui appartient) et `tools\` (outils portables), premier démarrage complet puis tout redevient automatique. Choix du clone propre plutôt que du reset en place (variante (23)) : un reset manuel laisse un `.next` périmé que `Ensure-Build` servirait tel quel (le build ne se déclenche que si `.next` manque ou via la logique d'update du lanceur) — le clone garantit un build de la version récupérée. QA : `scripts/test-providers-zai-coding.ts` — faux z.ai localhost à DOUBLE surface (paas refuse les JWT 401 comme le vrai, coding les accepte), 22 contrôles verts : détection JWT (4), ajout + adresse conservée (3), test de clé → « 3 modèles (Coding Plan) » passé sur la surface coding SANS toucher la standard (5), liste vivante coding (5), tour complet : Bearer JWT transmis à coding, paas JAMAIS appelé, message « glm-5.3 · z.ai » (8), repli documenté après invalidation (3). Non-régression : opencode 21/21, `test-integration-fixes.ts` 0 échec, tsc sans erreur sur les fichiers touchés. Endpoints vérifiés en direct : coding/paas/v4 existe (401 auth, pas 404), paas/v4 401 sans clé, anthropic/v1/models piège 200 confirmé, opencode /inference/v1/models public 200 + 401 faux Bearer. |
| 2026-11-15 (26) | **QA navigateur de bout en bout sur la pile complète** (demande de l'utilisatrice : « mettre l'interface en ligne pour que tu testes ») : le bac à sable EST l'environnement d'origine du projet (socket `/?XTransformPort=3003`, Caddyfile :81) — repo déplacé à la racine du projet (git du template écarté en `.git-template-bak/`, exclu via `.git/info/exclude`), pile démarrée en production fidèle au lanceur (`bun .next/standalone/server.js` :3000 + mini-service :3003/3004, jeton partagé via `.env.local` `NEXT_PUBLIC_SERVICE_TOKEN` inliné au build), navigation agent-browser via :81. Vérifié de mes yeux dans le navigateur : accueil (carte « Mode démo · LLM intégré »), Paramètres → Fournisseurs, ajout z.ai + clé JWT factice → test réel → « clé refusée » (routage coding confirmé en journal : « liste coding indisponible — repli documenté (glm-5.3…) »), ajout opencode (reconnu, adresse canonique affichée) + clé factice → « clé refusée ». **Conclusion : la version actuelle du code fonctionne** ; les échecs répétés de l'utilisatrice viennent de son installation restée à l'ancienne version (opencode inconnu du catalogue + clé Coding Plan testée sur paas/v4 → refusée). Limites du bac à sable constatées : processus utilisateur fauchés par intervalles (setsid n'immunise pas tout — les serveurs ont néanmoins tenu 8+ min, le navigateur aussi) ; pas d'URL preview publique retrouvée depuis l'intérieur (hostname conteneur → 410 « Recycled », preview-* → 404, ports du pilote muets) → test public remplacé par : (a) vérification visuelle du texte d'aide du volet (mention « Coding Plan »/« opencode » = nouvelle version), (b) offre de tester ses clés réelles ici même via le même parcours, (c) commande PowerShell UNE ligne auto-détectant son dossier (Get-ChildItem F:\CH -Filter Hermes-Web.bat), clone propre, copie db/tools, réécriture d'origin sans jeton. Scripts session : `scripts/parcours-navigateur.sh` (gabarit ; NB : agent-browser sans option --timeout globale, « + Ajouter un fournisseur » se cible par rôle/nom, refs à repriser par snapshot avant chaque action). Capture de preuve : `download/capture-test-fournisseurs.png`. |
| 2026-11-15 (27) | **Test de clé honnête jusqu'au solde — les deux clés réelles de l'utilisatrice testées en direct** (elle les fournit enfin ; son intuition « les modèles opencode gratuits ne fonctionnent qu'avec leur harnais » est EXACTE). Verdict direct : clé z.ai (format standard `xxx.yyyy`, pas un JWT) → `/models` 200 avec 12 modèles (glm-4.5 → glm-5.3-flashx-legal) MAIS `/chat/completions` 429 code 1113 « Insufficient balance or no resource package » = compte SANS crédit ; clé opencode → `/models` 200 MAIS chat 429 `FreeUsageLimitError` « Free models work in OpenCode; subscribe to OpenCode Go » = quota gratuit épuisé. **Les deux clés sont VALIDES — ce sont les comptes qui sont vides, pas l'interface qui refusait.** Le bouton « Tester » mentait par omission : la liste `/models` réussit même sur un compte à sec, et le 429 affichait « limite atteinte » sans lire le corps. Correctifs : (a) **providers.ts** : `explainQuotaError()` EXPORTÉ et partagé (kind balance/free_limit/rate + long/short, corps réels observés) ; `testProviderKey` lit le corps des 429 ; **sonde de génération** `probeGeneration()` — z.ai (standard + surface coding, modèle flash de la liste, 1 jeton) et opencode (modèle free/pickle, 1 jeton, surface `/inference/openai/v1/chat/completions`) → libellés « N modèle(s) — compte actif » / « clé valide — solde insuffisant, rechargez le compte » / « clé valide — quota gratuit épuisé (abonnement requis) » ; repli sur le verdict de la liste si imprévu (404/500/réseau) ; les AUTRES fournisseurs ne sont jamais sondés (aucune dépense possible ; OpenRouter teste `/api/v1/key` car son `/models` est public) ; pluriel français `frModels()` (« 1 modèle »). (b) **llm-pool.ts** : la copie locale `rateLimitWhy` est remplacée par l'import d'`explainQuotaError` (comportement du tour inchangé, « limite atteinte » sur corps vide). (c) Aide du volet : « OpenRouter (avec des modèles gratuits « :free ») » — 14 modèles `:free` vérifiés en direct = la voie réellement gratuite recommandée à l'utilisatrice. Ce commit pousse AUSSI le travail 429 de la veille resté local (révision 706257f, message accidentel) : traduction des raisons 429 dans les tours + conventions d'adresse du moteur (origine seule pour un fournisseur CONNU, chemin complet conservé pour un fournisseur personnalisé — vLLM/LM Studio servent /v1). QA réalignées sur le comportement VOULU : `test-429-reasons.ts` (le bouton Tester pressé PENDANT le 429 doit dire « épuisée » avec le libellé précis — le faux z.ai reconnaît la sonde 1-jeton et lui répond en JSON), `test-providers-opencode.ts` (faux serveur au layout du VRAI opencode : `/inference/v1/models` + `/inference/openai/v1/{models,chat/completions}`), `test-providers-flow.ts` (adresse personnalisée conserve `/v1`). Nouvelle QA **`test-providers-quota.ts` 12/12** (z.ai sans crédit/actif/Coding Plan, opencode épuisé/actif, 429-sur-liste traduit, OpenRouter non sondé, piège du 200-porteur-d'erreur, repli réseau, 401, familles explainQuotaError). Repassés verts : 429 (scénarios A–E + S), opencode 21/21, zai-coding 22/22, providers-flow, tsc sans erreur sur les fichiers touchés. NB pour l'utilisatrice : ses deux clés ne pourront pas parler tant que le compte z.ai n'est pas rechargé / l'abonnement OpenCode Go pris — d'où la recommandation OpenRouter `:free` (compte gratuit, clé en 2 min, pris en charge nativement). |
| 2026-11-15 (28) | **Un seul onglet — relancer le lanceur n'empile plus les onglets** (demande de l'utilisatrice : « que le lanceur détecte si un onglet Hermes est déjà ouvert et qu'il ferme ou relance sur ce même onglet »). Un lanceur .bat/PowerShell n'a AUCUN droit sur les onglets d'un navigateur (isolation système ; aucune API Windows fiable pour « rafraîchir l'onglet X ») — la voie robuste est la coordination DANS la page, déclenchée par le lanceur qui rouvre l'adresse. Nouveau `src/components/single-tab-guard.tsx`, monté dans le layout racine à côté de PwaRegister : battement de cœur localStorage `hermes.single.tab` (2 s, péremption 7 s), identité par onglet en sessionStorage (survit au rechargement) ; un nouvel onglet qui trouve un principal vivant (1) lui demande de se rafraîchir — BroadcastChannel `hermes.single.tab` + repli événement `storage` sur la clé `hermes.dup.signal` (l'événement ne se déclenche que chez les AUTRES onglets, exactement ce qu'il faut) — l'onglet EXISTANT recharge la toute dernière version (conversations en base, rien ne se perd), (2) affiche un bandeau discret et tente window.close() ; si le navigateur refuse une page ouverte par le système (protection normale), le bandeau dit de la fermer à la main ; bouton « Garder cette page ouverte » (l'onglet reste utilisable et prend le relais si l'autre disparaît), (3) le principal qui se ferme écrit un battement MORT (pagehide) → relais immédiat, sans attendre 7 s. Dédoublonnage des rechargements (2,5 s, sessionStorage) contre StrictMode et doubles signaux ; fenêtres PWA (display-mode standalone) volontairement exemptées ; stockage indisponible (navigation privée) → la garde se tait (comportement inchangé). Instrumentation QA minimale `window.__hermesTabRole`/`__hermesReloadCount`. README-desktop : comportement « pile déjà lancée » réécrit + § Un seul onglet (caveat première fois : l'ancien onglet resté à l'ancienne version ne comprend pas le signal — le fermer une fois à la main, ensuite tout est automatique). QA `scripts/test-single-tab.ts` **8/8** (Playwright, deux onglets du MÊME contexte) : principal + battement, doublon détecté, bandeau, onglet existant rechargé (compteur) et resté principal, battement jamais volé, note « à la main » si fermeture refusée, relais après disparition de l'ancien, battement détenu par le relais. Piège de bac à sable : le sandbox relance `bun .next/standalone/server.js` au boot — il squattait :3000 et servait l'ANCIEN build (garde absente, rôle jamais posé) ; tuer le squatteur avant de servir un dev (diag `scripts/diag-single-tab.ts`). tsc : 0 erreur `src/` ; eslint propre sur les fichiers touchés. Ce push emporte AUSSI les deux révisions restées locales (706257f travail 429, 9ec4b50 test honnête — journal (27)). |
| 2026-11-15 (29) | **Portabilité totale + sobriété processeur** (demande de l'utilisatrice avant sa réinstallation fraîche : « t'assurer que hermes-web est en mode portable » et « hermes-web fait énormément chauffer mon processeur »). **Portabilité** — le socle existait (outils dans `tools\`, db/chemins relatifs à `import.meta.dir`, Job Object, pas de registre) mais trois fuites refermées dans `desktop/hermes-ui.ps1` : (a) les outils du PATH SYSTÈME étaient préférés à la copie portable → le dossier ne devenait jamais autonome ; désormais `Resolve-Tool()` : copie `tools\` d'abord, TÉLÉCHARGEMENT sinon — même si le système possède l'outil (le dossier déplacé reste complet), copie système en dernier recours si le réseau manque (`Install-ZipTool` passe de `Die` à `throw`, attrapé) ; `Install-ExeTool` télécharge en `.part` puis renomme (un téléchargement interrompu ne laisse jamais un exe incomplet pris pour bon) ; (b) caches npm/bun redirigés DANS le dossier (`$env:npm_config_cache` → `tools\npm-cache`, `$env:BUN_INSTALL_CACHE_DIR` → `tools\bun-cache` — vérifié : plus RIEN dans `~/.npm`) ; (c) télémétrie Next.js coupée (`NEXT_TELEMETRY_DISABLED=1`). Bonus hygiène : rotation de `desktop\logs\launcher.log` (>512 Ko → 2000 dernières lignes) ; commentaire d'en-tête obsolète (« client Prisma ») corrigé. **Processeur** — diagnostic : la pile en production consomme ~0,1-1 % au repos (mesuré), la chaleur vient donc du repli `next dev` (build échoué → dev PERPÉTUEL, l'ancien marqueur ne retentait jamais) et de la surveillance 5 s : (1) `build-echoue.flag` à 2 lignes (révision + timestamp) — même version retentée après 24 h (jamais en boucle), + cadre jaune explicite dans la fenêtre quand l'interface démarre en mode développement (cause, conséquence ventilateur, comment forcer) ; (2) surveillance 15 s au lieu de 5 s, vérification d'adoption PID (WMI coûteuse) allégée à 1 cycle sur 4 ; (3) Job Object passe la pile en **priorité BELOW_NORMAL** (`LimitFlags 0x2000 -bor 0x40`, `PriorityClass 0x4000`) — Hermes cède le processeur aux autres logiciels dès qu'ils en ont besoin ; le build (`Invoke-Live`) reste hors job donc à priorité normale. **QA** : parseur PowerShell réel (pwsh 7.4 téléchargé au bac à sable) — 0 erreur de syntaxe ; `scripts/qa-lanceur.ps1` **13/13** (scénarios marqueur : ancien format/vide/1 h/25 h/révision différente/timestamp absent + réécriture-lecture 2 lignes + Resolve-Tool : portable présent/téléchargement coupé→système + constantes Job Object) ; build de production refait de zéro (OK) ; pile complète 200/200 ; **test de déplacement réel** : copie de la pile vers un autre chemin → mini-service relancé de là ouvre `…/portable-test/db/hermes-chat.sqlite` (preuve par readlink /proc/PID/fd), conversations/messages intacts, UI 200 ; redirection du cache npm prouvée (cache peuplé dans la cible, `~/.npm` non touché — dates vérifiées). Conventions .ps1 respectées (UTF-8 BOM, LF, sans accents, équilibre identique à HEAD). README-desktop : ordre de résolution des outils réécrit, étapes build/surveillance mises à jour, nouvelles sections « Déplacer le dossier (mode portable) » et « Chaleur du processeur » + ligne de dépannage dédiée. NB affichage : la séquence `[m` est mangée par la couche de rendu des sorties bash (fausse « corruption » `[math]`→`ath]` — le fichier est sain, prouvé par od/python). Verdict clés (journal (27)) rappelé à l'utilisatrice : ses deux clés sont VALIDES, ce sont les comptes qui sont sans crédit — recommandation OpenRouter `:free`. |
| 2026-11-15 (30) | **Sélecteur de fournisseurs + double portefeuille z.ai réglé + endpoint éditable** (trois demandes de l'utilisatrice, dont le « fin du mystère » : sa clé `0deb…` est une clé CODING PLAN au format standard — matrice croisée fournie : 429 « solde insuffisant » sur `paas/v4`, 200 OK sur `coding/paas/v4` ; la clé `3480…` créée en section « API Keys » refuse les deux surfaces, solde au jeton vide — deux porte-monnaies étanches, seule la section de CRÉATION de la clé décide). Le routage v2.4 par FORMAT (`looksLikeZaiJwt`) était donc insuffisant : des clés Coding Plan existent au format `xxxxxxxx.yyyyyyyy`. **(1) Sélecteur d'ajout** : fin du champ texte libre — `providers:catalog` (nouvel événement) sert le catalogue (14 entrées, libellés courts + taglines), l'UI (`providers-section.tsx`, `AddProviderPanel`) rend un `<select>` groupé « Fournisseurs connus / Autre — adresse personnalisée » ; le catalogue compte **z.ai DEUX fois** : « z.ai — API standard (paiement au jeton) » et « z.ai — GLM Coding Plan (abonnement) » (entrée `z.ai Coding Plan` insérée EN TÊTE du catalogue — les deux regex reconnaissent « z.ai », l'ordre tranche), avec note explicative des deux portefeuilles et de la bascule automatique. **(2) Détection par le TEST** : `testProviderKey` z.ai réécrit en `testZaiSurface(base)` — surface attendue d'abord (preset Coding Plan, adresse coding explicite, ou JWT → coding direct sans aller-retour), et si la clé y est refusée (401/403/429, réseau OK) l'AUTRE portefeuille est essayé ; succès → `migrateBaseUrl` → `index.ts` **bascule le fournisseur** (`store.setProviderBaseUrl`, nouveau) et le callback du test rend le `provider` mis à jour → toast « Endpoint basculé automatiquement » côté UI, pastille courte « N modèles (Coding Plan) — compte actif ». Les surfaces dérivées de la MÊME origine que le test (proxy respecté, la clé ne fuit jamais vers api.z.ai) ; JWT en échec sur coding n'insiste pas sur la standard (documenté). `llm-pool.ts` suit : `KNOWN_LLM_BASES["z.ai Coding Plan"]`, repli documenté coding reconnu par la base routée (preset, bascule OU JWT — plus seulement le format), coupe du raisonnement GLM « off » étendue aux deux libellés. **(3) Endpoint éditable** (demande : « lorsque j'ajoute ma clé, je veux tout de même avoir le détail éditable du endpoint ») : champ visible à TROIS endroits — panneau d'ajout (pré-rempli par preset), formulaire d'ajout de clé (enregistré AVANT la clé, le test partira sur la bonne adresse), réglages avancés de la carte (+ bouton réinitialiser) ; la carte affiche l'endpoint EFFECTIF (adresse enregistrée ou défaut du catalogue). Sémantique unifiée `applyExplicitBase()` (providers.ts, partagée avec llm-pool) : identique au défaut → canon (stocké null, surfaces de TEST propres préservées — opencode liste sur `/inference/v1`, tours sur `/inference/openai/v1`, d'où le champ `testBase`) ; origine seule → hôte du canon (proxy) ; **avec chemin → base COMPLÈTE utilisée telle quelle** (changement de contrat v2.5 : l'adresse éditée est honorée verbatim — `providers:set-base` (nouvel événement) applique la même sécurité https/localhost). QA : **`scripts/test-providers-wallets.ts` 47/47** (faux z.ai port 3321 reproduisant la matrice réelle — standard n'accepte que la clé API avec solde, coding que la clé Coding Plan, 429 1113 ailleurs) : unitaire (résolution, capabilities, applyExplicitBase), test direct (bascule proposée / échec honnête sans solde), catalogue, garde canon, preset Coding Plan de bout en bout (liste + tour, jamais la standard), **cas réel de l'utilisatrice** (clé Coding Plan format standard ajoutée côté « z.ai » → 429 standard puis 200 coding, bascule PERSISTÉE, liste + tour via la coding, `paas:chat=0`), bascule inverse, deux portefeuilles à sec (aucune bascule), set-base chemin complet + reset + refus http réseau, ajout direct à adresse modifiée. Repassés verts : zai-coding **22/22** (JWT sans aller-retour préservé), opencode **25/25** (scénario réécrit : origine seule = proxy + NOUVELLE section [V] chemin complet verbatim, faux serveur étendu à `/v1/*`), providers-flow OK, quota **12/12** ([6] mis à jour : les DEUX portefeuilles sont maintenant essayés, standard puis coding), 429-reasons OK. Build production OK ; QA navigateur réelle (pile complète :81) : sélecteur à 12 options avec les deux z.ai, endpoint pré-rempli et suivi du preset, ajout fournisseur + clé + endpoint éditable + toast de confirmation, carte affichant l'endpoint effectif. tsc : 0 erreur sur les fichiers touchés (les `import.meta.dir`/`bun:sqlite` restants sont préexistants, spécifiques Bun). README mini-service : tableau socket enrichi (catalog, set-base, sémantique baseUrl, bascule du test). NB utilisatrice : sa clé `0deb…` fonctionnera désormais telle quelle — preset « z.ai Coding Plan », ou preset « z.ai » + bouton Tester (bascule automatique). |
| 2026-11-15 (31) | **F-26 livré — Versionnage fichiers depuis le chat** (conception validée en trois passes par l'utilisatrice : modèle « snapshots, pas git », zones d'ombre — identité, bruit, quota, restauration — puis UI « épurée, intuitive, pas de redondances » ; feu vert « go »). **Décision structurante : fusion avec le journal artefacts, pas de store parallèle** — la table `artifacts` était déjà un journal immuable une-ligne-par-version ; créer `db/versions/` aurait dupliqué le contenu (contradiction avec « pas de redondances »). Couche humaine ajoutée en migration additive (`artifacts.label/pinned/restored_from`, R2) ; les v2/v3 préexistantes deviennent des entrées du journal sans migration de données. Politique isolée dans `versions.ts` (nouveau, R1) : ré-émission identique de la version courante → pas de version (erreur refaisable) ; une version par tour et par fichier (ArtifactTracker) ; restauration = v(n+1) copiée, libellé auto « Restauration de vN », marqueur ↩, HTML re-rendu ; quota 50/fichier purge FIFO non épinglées (jamais la courante), 10 épingles max ; purge en fin de tour (même interrompu) et après restauration ; fork transporte étiquette/épingles/↩ ; suppression de conversation purge le journal. Événements `artifact:restore/label/pin` + diffusions `artifact:updated`. UI : `version-popover.tsx` (nouveau, composant UNIQUE — badge `v{n}` de la carte dès v2 = seule porte) : étoile, ↩, date relative, étiquette italique ; double-clic = édition inline (≤ 80 car.) ; clic = sélection → « Restaurer vN » (désactivé sur la courante) + « Télécharger » ; toast sans dialogue. Écartés conformément au design : ligne dans le flux, /versionner, bouton sauvegarder, choix d'origine, comparaison/export zip. QA : `test-versions-flow.ts` **21/21** (A politique base isolée + B cycle socket réel), QA navigateur de bout en bout sur la pile :81 (badge → journal → étiquette → étoile → restauration → toast → badge v4 + ↩), captures `download/qa-f26/`. tsc/eslint : aucun nouveau signal (5 erreurs Bun préexistantes, 1 alerte lint préexistante). Docs : §7.12, README mini-service, ROADMAP F-26. |
| 2026-11-15 (32) | **Chantiers UI livrés — exécution des plans d'action des trois audits** (session audit externe : passe 1 grille utilisatrice, passe 2 grille de fabrication en 8 critères, passe 3 vérité runtime ; livrables audit dans `download/` du bac à sable). **Vague 0 (conformité gratuite)** : les 7 boutons primaires `text-white`/`bg-hermes` (FAIL sombre 2,62:1, passe 3 P3.1) migrent sur la recette `primary` (`bg-hermes-strong text-hermes-foreground hover:bg-hermes-strong/90`) ; liseré de focus clavier global `*:focus-visible` 2px hermes offset 2 dans `globals.css` (P8 — le focus était parfois inexistant sur les contrôles faits main) ; garde `prefers-reduced-motion` sur les 3 animations maison (P5) ; chip `HERMES_GATEWAY_URL` insécable + **chiffre 8 px de la jauge supprimé** (P2.1/P2.2 — l'info reste dans title + aria-label + couleur de l'anneau + popover) ; damier d'artefacts `hsl(oklch())` → `repeating-conic-gradient(var(--muted)…)` nu (C8.4) ; `var(--amber, #d97706)` fantôme → token `--warning` (C8.3). **Vague 1 (échelles déclarées)** : `globals.css` documente la grammaire — texte 7 crans (11/12.5/14/15/17/19/26), rayons sm8/md10/lg12/xl14/2xl22 (xl recalé +2px, 2xl défini +10px), hauteurs de contrôle h-8/h-9/h-10 (+ micro-steps standard h-6/h-7 pour chips et champs courts), opacité désactivée unique 40, gaps 4/6/8/12, durées 150/200/300 ms, strokeWidth 2/2.5, z-index documenté ; **568 remplacements mécaniques** par script (`scripts/snap-scales.mjs`, chaque règle vérifiée par compte) — texte aux 7 crans (9.5/10/10.5/11.5→11, 12/13→12.5, 13.5/14.5→14, 15.5→15, 21/26→19, 30→26), rayons en tokens (7/8→sm, 9/10/11→md, 12/13→lg, 14→xl, 26→2xl), hauteurs h-[26]→h-6, h-[28]→h-7, h-[30/31/32]→h-8, h-[34]→h-9, gaps 5→1/6→1.5/7→2, opacité désactivée 30/45/50/60→40 (×51 unique), popover jumeau 354→352, strokeWidth 1.8/2.2/2.4/2.6→2 ; **tokens d'état AA calculés par script** (`scripts/contrast.mjs`, oklch→sRGB→WCAG, 16 couples tous ≥ 4,5:1) : `--warning` 4,85/8,10, `--success` 5,00/9,26, `--warning-foreground` ; palette brute migrée : amber→warning, emerald→success, red→destructive (95 remplacements ; **exceptions documentées** : surface diff GitHub-dark fixe `#161b22` d'`artifact-panel` et carte TINT d'`artifact-card` — les tokens suivent le thème de l'app, pas ces surfaces) ; **`--hermes-strong`** (oklch 0.55 ≈ #ba480d en clair, rejoint la marque en sombre — AA 5,05:1 avec hermes-foreground) et **`--hermes-text`** pour les **78 libellés d'accent** (`text-hermes`→`text-hermes-text`, AA 5,20:1) — la marque `--hermes` ne bouge pas (P3.1bis option b) ; variant `primary` dans `Button` (+ `cursor-pointer` et `disabled:opacity-40` dans la base cva) ; Scrollbar Firefox (`scrollbar-width/color`) ; popovers jumeaux 352/354 → 352 px ; debounces 300/350 → constantes partagées `src/lib/constants.ts` (`SEARCH_DEBOUNCE_MS`, `DRAFT_SAVE_DEBOUNCE_MS`) ; PWA/méta unifiés (`themeColor`/`theme_color` #da5e25 dérivé du token, `background_color` #151312 — fin du flash au lancement). **Vague 2 (grammaire)** : **Switch Radix unique** re-thémé terracotta (`data-[state=checked]:bg-hermes-strong`, pouce hermes-foreground en sombre) ; les 2 interrupteurs maison (`hermes-section`, `memory-card`) et la checkbox brute `accent-[var(--hermes)]` remplacés par le Switch ; **le faux switch imbriqué des Extensions est démonté** — en-tête restructuré façon ConversationItem (zone d'ouverture dédiée, Switch hors du bouton, fin du `role="switch"` fait main et de la double annonce) ; **`ConfirmDestructiveDialog` partagé** (`src/components/shared/confirm-destructive-dialog.tsx`, bouton confirmé en destructive) sur les **5 destructions sans garde** : conversation, message ×2, mémoire, lien public — + projet (le `window.confirm` natif est supprimé, le dialogue prend la copie exacte du message) ; **révélation des actions unifiée** : recette `hover:opacity-100 focus-within:opacity-100 group-hover/msg:opacity-100` + **`max-md:opacity-100`** (visible au touch) sur les 2 rangées, **`group/msg` ajouté aux cellules `ComparePair`** (actions redécouvrables en comparaison A/B) ; **une seule entrée « prompt »** : le bouton d'en-tête est retiré, la pastille ✦ près du titre devient l'entrée unique (tiera quand actif, invite en pointillés sinon, aria-labels distincts) ; **hygiène** : `tailwind.config.ts` supprimé (triple mort : jamais chargé, globs faux, `hsl()` obsolète), `ui/sonner.tsx` + dépendance `sonner` retirés (zéro import), **boutons morts images/agent du composer retirés** (doctrine « UI épurée », la section Outils annonce), bascule Web : `disabled` → **`aria-disabled`** (reste focusable) + info-bulle Radix (un `title=` seul n'atteignait ni le clavier ni le touch — C4) ; **garde-fous du build** (P1) : `next.config.ts` `ignoreBuildErrors:false` + `reactStrictMode:true`, le tsconfig Next exclut l'outillage bun (`scripts/`, `mini-services/`, `examples/` — erreurs préexistantes hors périmètre app) ; au passage **réparation d'une ligne cassée** dans `sidebar.tsx` (`const [messageHits` — erreur de syntaxe présente au commit `19b6d4c`, le dépôt ne compilait plus). **QA** : `bun run build` **vert avec type-check strict** (routes `/`, `/api`, `/shared/[token]`, `/_not-found`) ; anti-régression grep — échelle texte exacte aux 7 crans (12.5×184, 11×155, 14×21, 19×11, 15×11, 17×2, 26×1), rayons arbitraires zéro hors micro-exceptions documentées (chart/tooltip/checkbox 2-4 px), `disabled:opacity-40` unique ×51, `window.confirm` zéro, `text-white` sur hermes zéro, strokeWidth 2×48/2.5×9 (+ Ring 4.5), palette brute zéro hors exceptions, `text-hermes` nu zéro ; contrastes calculés tous AA. |
| 2026-11-15 (33) | **Maquette v5 des Paramètres — échelles contraintes** (chantier n°1 du « reste à faire » des audits — passe 3 P9 : les maquettes étaient la cause racine de la poussière, 11 tailles de texte / 11 rayons / 11 gaps transplantés fidèlement dans le code ; tant que la maquette les portait, le prochain écran dessiné les ré-importait). `design/maquette-parametres-v5.html` créé depuis la v4 par transformation mécanique scriptée (173 remplacements, chaque règle vérifiée par compte grep) : **texte** aux 7 crans déclarés (9.5/10.5/11.5 → 11, 12/13 → 12.5, 13.5 → 14 ; 15/19 inchangés — 5 crans utilisés à l'écran, aucun texte < 11 px) ; **rayons en tokens** `--r-sm 8 / --r-md 10 / --r-lg 12 / --r-xl 14 / --r-full` déclarés dans le `:root` de la maquette (7/8→sm, 9/10→md, 11/12→lg, 14/16→xl, 99/999→full ; micro-rayon 4 px des barres de légende gardé, exception documentée) ; **hauteurs de contrôle** 30→32, 34→32 (tuiles) / 36 (bulles fantômes), 40 inchangé ; **gaps** 1→2 (micro-gap documenté, comme gap-0.5 du code), 7/9/10→8 ; **durées** .18→.15 (contrôles), .24/.25→.2 (scène) ; **stroke** 2.2→2 (2/2.5 restants) ; **opacité désactivée unifiée à 40** (switch .45, bouton .5, extensions off .55 → .4). Tokens AA des chantiers portés dans la maquette : `--hermes-strong` pour les boutons primaires « Ajouter » et le switch coché (AA 5,05:1), `--hermes-text` pour tous les libellés d'accent (volet actif, segmenté, valeur de slider « 19 % », liens « + Ajouter une clé », hovers de boutons — AA 5,03:1), `--warning/--destructive/--success` en remplacement d'amber/red/green (pastilles « à tester », « limite atteinte », points d'état) — la marque `--hermes` ne bouge pas (bordures, focus, logos, pouce de slider, icônes de check 3:1) ; token mort `--destructive-soft` (déjà inutilisé en v4) supprimé. **Focus clavier** : la règle globale `*:focus-visible` 2px hermes offset 2 remplace les 3 règles locales (rn inset, switch, seg) — une seule façon de faire, champs texte par la bordure terracotta comme les inputs du code. **Géométrie du switch alignée sur le code** (32×18, pouce 16, course 14 — fin du 38×22 de la maquette). En-tête de la maquette : bloc changelog v4→v5 complet (échelles, mappings, exceptions, hors-périmètre). **QA navigateur réel** (agent-browser, 1440×900) : 5 volets capturés et inspectés (Interface, Fournisseurs, Extensions, Profils, Système) ; mesures runtime — switch 32×18, bouton primaire et volet actif calculés oklch(0.55 0.16 42), focus Tab `2px solid` terracotta offset 2, textes calculés strictement aux 5 crans (13.33/16 px présents uniquement sur des éléments sans texte, défaut UA) ; greps anti-régression v5 : 0 valeur hors échelle. La maquette redevient dessinable sans ré-importer la poussière. |
| 2026-11-15 (34) | **Chantiers restants des audits livrés** (§5 du rapport des chantiers, items 2-6 ; item 1 = maquette v5, journal (33)). **C1.4 — un seul tooltip** : l'InfoTip (composant « ? » du repo, jamais câblé) devient l'idiome unique des explications — 5 `title=` informatifs du volet Paramètres traités (3 → InfoTip : pied du rail « moteur intégré »/« mode démo » et pilule « N en attente » ; 2 supprimés car redondants du texte visible ou déjà dans le volet Extensions : dot de mise à jour, « gateway connectée ») ; les autres `title=` sont des libellés d'action (hover d'un bouton aria-labelisé) et restent. **C1.5 — un seul idiome de fenêtre** : les deux panneaux Radix réécrits à la main (Paramètres 860 px, prompt 460 px) migrent sur `ui/sheet.tsx` (`SheetContent side=left/right`, overlay/animation/close standard du repo, largeurs et arrondis 22 px conservés via classes, durées 300 ms) — les closes maison disparaissent (le `sr-only Close` du Sheet passe en français), la prop `onClose` morte est retirée, `DialogPrimitive` n'est plus importé nulle part. **C1.3 — le segmenté en un exemplaire** : composant partagé `src/components/shared/segmented.tsx` — radiogroup accessible complet (tabindex roving : une seule tabulation, flèches ←↑↓→ qui sélectionnent en naviguant avec rebouclage, pilule active en `hermes-text` AA) ; adopté par les réglages (Thème, Ordre des projets… — le `Segment` local est supprimé) et le model-picker (Effort de raisonnement — plus de `p-[3px]`/`px-[9px]` hors échelle : `p-0.5`/`px-2` comme le composant). **C2.3 — sliders bruts éliminés** : température du picker et seuil du résumé passent sur `ui/slider.tsx` (fin des `input[type=range] accent-[var(--hermes)]`). **C8.6 — inventaire `ui/` tranché** : 29 composants jamais importés supprimés (accordion → toggle-group + label/separator/toggle qui ne les servaient qu'eux — re-câblables en une commande shadcn au besoin) ; `ui/` passe de 47 à **18 composants, tous utilisés** (toast confirmé vivant via `hooks/use-toast.ts`). **QA** : `tsc` 0 erreur après chaque chantier, `bun run build` vert (13-14 s, type-check strict) ; QA navigateur réelle sur le standalone (port 3113) : volet Paramètres ouvert en Sheet avec un seul close, switch Radix 32×18 terracotta, slider Radix avec valeur en `hermes-text`, segmenté Thème mesuré — tabindex `[-1,-1,0]` sur la pilule active, flèche → déplace le focus Sombre→Système **et** coche (comportement radio exact) ; 0 erreur console. |
| 2026-11-16 (35) | **Model picker épuré + favoris actionnables** (demande de l'utilisatrice : « je veux que tu épures le model picker » / « il me faut pouvoir déterminer des modèles favoris »). **Favoris — fin du panneau mort** : la clé `hermes.models.favorites` était LUE par le picker (section Favoris) mais AUCUNE UI ne l'écrivait — le commentaire « gérés depuis les paramètres » décrivait un volet qui n'en liste aucune ligne. Nouvelle étoile par ligne (`model-picker.tsx`, bouton h-7 rond-sm, révélée au survol/sélection clavier/focus, pleine `warning` en permanence si favorite — même langage visuel que la section) : clic → bascule + écriture du registre (`writeClientSetting`), l'entrée quitte son groupe et rejoint la section Favoris en live ; aria-label distinct « Ajouter/Retirer » + `aria-pressed` ; sync multi-pickers par le bus `hermes-ui:settings-changed` (une étoile posée dans le picker A du mode comparaison apparaît dans B) + relecture à chaque ouverture. **Isolation cmdk** : clic, Entrée et Espace sur l'étoile font `stopPropagation` — sans cela cmdk sélectionnait le modèle EN MÊME TEMPS que la bascule (vérifié en QA : le déclencheur reste « Hermes 4 70B » pendant que l'étoile bascule 14B). **Épuration** : l'en-tête « Choisir un modèle » est supprimé (la recherche dit déjà quoi faire — placeholder raccourci « Rechercher un modèle… », aria-label enrichi « par nom, id ou fournisseur ») ; ligne mono dédoublonnée — le fournisseur n'est plus répété sous chaque ligne quand il porte le titre de section (mode groupé gateway/clés), il complète l'id en mode plat (catalogue/démo) ; pied compact « N modèles · M fournisseurs » + InfoTip (les trois explications de source y vivent au lieu d'un paragraphe) ; note « Envoyé dans api_turn_v1.settings… » de l'effort → InfoTip du libellé ; note « Champs vides = valeurs par défaut… » du mode expert → InfoTip du titre ; les mots « déplier/replier » tombent — le chevron (déplacé DEVANT le titre, sens disclosure) + `aria-expanded` portent l'état ; l'InfoTip passe hors du bouton de titre (jamais de bouton dans un bouton). **InfoTip promu composant partagé** : `settings/info-tip.tsx` → `shared/info-tip.tsx` (le picker du chat ne doit pas dépendre du volet Paramètres — l'idiome tooltip unique C1.4 s'étend au composer), import du `settings-panel` suivi. **QA** : `tsc` 0 erreur, eslint propre, `bun run build` vert (rebuild propre après un ChunkLoadError de résidus de build) ; QA navigateur réelle sur la pile complète (app :3000 + mini-service :3003 en moteur démo + routeur proxy QA `scripts/` hors repo — Caddy binaire bloqué par le sandbox) : étoile posée → section Favoris live + localStorage `["hermes-4-14b"]`, déclencheur inchangé, Tab→étoile puis Entrée bascule sans sélectionner (groupe Favoris retiré, favoris `[]`), persistance après fermeture/réouverture, sync A/B, InfoTip pied/effort/expert ouverts et Escape referme le tip SANS fermer le popover (capture dédiée), panneau expert déplié (chevron ^, slider température, plus de paragraphe), 0 erreur console. |
| 2026-11-16 (36) | **Actions en icônes seules + fin du feedback 👍/👎 (F-24)** (demande de l'utilisatrice : « retire les noms à côté des icônes (pareil dans le model picker) » / « retire features bonnes et mauvaises réponses », capture de la rangée d'actions à l'appui). **Icônes seules — un seul idiome pour tous les boutons d'action** : `ActionButton` de la bulle ne rend plus le libellé (`hidden sm:inline` tombé) — boutons carrés 28 px, le libellé vit dans `title` + `aria-label` (info-bulle native au survol, nom pour les lecteurs d'écran) ; même traitement dans la barre du composer (« Comparer » → `Columns2` seul, « Web » → `Globe` seul, aria-label ajoutés) et le **déclencheur du model picker** devient icône seule « ✦ ▾ » (ou pastille A/B en comparaison) — le modèle choisi reste lisible dans le `title`/`aria-label` et dans le popover ; la variante non-compact du picker (code mort, jamais utilisée) est supprimée avec la prop `compact`. **F-24 retiré de part en part** : client — `FeedbackControl` (pouces + popover commentaire) supprimé de `message-bubble.tsx` (imports ThumbsUp/ThumbsDown/MessageSquareText/Popover suivent), prop `onSetFeedback` décâblée de la bulle / `MessageList` / `ComparePair` / `page.tsx`, action `setMessageFeedback` + abonnement `feedback:changed` retirés du hook, champs `feedbackRating`/`feedbackComment` retirés de `chat-types.ts` ; service — handler `feedback:set` + broadcast `feedback:changed` supprimés, `setMessageFeedback` + mappings `feedback_rating`/`feedback_comment` retirés du store, migration douce et section du README supprimées, `FeedbackChangedPayload` tombé des types ; colonnes SQLite additives laissées en place (historique dormant, aucun effet) ; test `scripts/test-feedback-flow.ts` supprimé ; §7.9 consigne le retrait, ROADMAP F-24 → « Retiré ». **QA** : `bunx tsc --noEmit` 0 erreur (front + service, un `onOpenArtifact/onRetryArtifact` rendu à l'interface en passant), eslint propre sur les 7 fichiers touchés, `bun run build` vert ; pile complète en navigateur réel (app :3000 + mini-service :3003 + proxy QA :8181, 1440×900) — rangée d'actions révélée : icônes seules sans un mot, 0 « Bonne réponse » / « Réponse à améliorer » / « Commenter ce feedback » dans le DOM, composer en icônes seules `[⧉] [✦ ▾] [🌐]`, picker ouvert : étoile 14B posée → section Favoris live, `hermes-ui:hermes.models.favorites` = `["hermes-4-14b"]` (clé déclarée au registre), favori **survit au rechargement complet** de la page, mode comparaison : déclencheurs « A ▾ » / « B ▾ » icônes seules avec modèles corrects en aria-label, 0 erreur bloquante. |
| 2026-11-16 (37) | **Dossier portable réellement complet — les dépendances sous-processus du mini-service assurées dans tools\** (demande : « chrome-headless-shell introuvable sur cette machine — quelles autres dépendances ne sont pas encore installées dans le dossier portable ? »). **Diagnostic** : le lanceur n'assurait que Node/Bun/Caddy dans `tools\` ; le service appelle en plus, en sous-processus, **chrome-headless-shell** (render.ts — vignettes d'artefacts, PDF, images des partages), **ffmpeg** (asr.ts — conversion des dictées en WAV 16 kHz mono), **zip** (index.ts — export d'artefacts) et **git** (providers.ts — repli protocole de l'import de dépôt, déjà dégradé proprement vers l'API GitHub) ; et `CHROME_CANDIDATES` n'alignait que des chemins Linux épinglés (`~/.cache/ms-playwright/chromium_headless_shell-1200/…linux64/…`, `/usr/bin/…`) — sous Windows, le binaire était introuvable même correctement installé, d'où la pastille « introuvable » de Paramètres → Système et l'erreur du pipeline de rendu. **Correctifs** : (a) **render.ts** — résolution multiplateforme et robuste aux révisions : `CHROME_HEADLESS_PATH` d'abord, puis scan des caches Playwright (`$PLAYWRIGHT_BROWSERS_PATH`, `%LOCALAPPDATA%\ms-playwright`, `~/.cache/ms-playwright`) toutes révisions `chromium_headless_shell-*` (tri révision la plus récente d'abord, sous-dossiers win64/linux64/mac-arm64/mac), puis binaires système ; (b) **hermes-ui.ps1** — chrome-headless-shell (zip Chrome for Testing 143.0.7499.4, URL vérifiée HTTP 200) et ffmpeg (zip essentials gyan.dev, redirection vérifiée) assurés dans `tools\` comme les autres outils (idempotents, replis cache Playwright / PATH système), `CHROME_HEADLESS_PATH` réglé, ffmpeg en tête de PATH de session, dégradations annoncées en clair (« ATTENTION … le reste de l'application fonctionne ») au lieu d'un Die bloquant ; (c) **index.ts** — export ZIP : repli automatique sur bsdtar (`tar.exe` intégré à Windows 10+, `-a` déduit le format zip de l'extension) quand `zip.exe` manque ; (d) **README-desktop.md** — outils listés au 1er double-clic + 3 lignes de dépannage. **QA** : service démarré avec les correctifs (mode démo, ports 3003/3004, SIGTERM propre) ; test-artifact-flow.ts SUCCÈS de bout en bout contre le service réel (rendu Chrome vignette + PDF, HTTP 200) ; test-render-pipeline.ts OK (PNG 92 828 + PDF 57 621 octets, binaire retrouvé par le scan sans le chemin épinglé) ; bunx tsc --noEmit front 0 erreur ; bundle du service 0 erreur de parse/import ; export ZIP de contrôle valide (Linux) ; ps1 relu (convention sans accents conservée — pas de PowerShell ici pour un test réel). |
| 2026-11-16 (38) | **Légendes sans nom de modèle + déclencheur du picker au nom du modèle en cours** (demande : « retire le nom des modeles des legendes des messages chats » / « dans modele picker, remplace icone par le nom du modele en cours »). (a) **message-bubble.tsx** — le span mono de queue de rangée d'actions qui affichait `message.model` en clair est supprimé : la légende ne contient plus que les actions icônes seules et la ligne jetons/coût (F-21) ; le champ `message.model` reste utilisé pour la tarification (UsageRow), seul l'affichage tombe. (b) **model-picker.tsx** — le déclencheur quitte l'icône ✦ pour le NOM du modèle en cours (`current.label`, tronqué à 160 px) ; en comparaison, la pastille A/B est conservée et suivie du nom du slot (tronqué à 120 px) — le title/aria-label complets restent ; import Sparkles tombé, commentaires d'en-tête réalignés. **QA** : bunx tsc --noEmit 0 erreur, eslint propre sur les 2 fichiers ; pile réelle (Next :3000 + mini-service :3003 + caddy :8181 sur le Caddyfile du repo, 1440×900) : déclencheur « Hermes 4 70B ▾ » (capture), picker ouvert depuis le nom (recherche, favoris, effort intacts), conversation réelle : légende = « ≈ 86 jetons (estimation) » seule, sonde DOM span.font-mono à contenu modèle = 0 sur toute la page, 0 erreur console. |
| 2026-11-16 (40) | **Fin du mode démo — branchement automatique de l'agent Hermes** (l'utilisateur : « vire moi ce mode démo ! et branche hermes ! » ; plus aucune saisie d'URL demandée). **Mini-service (hermes-chat)** : le LLM intégré du SDK (local-engine) qui simulait les réponses est supprimé — le fichier ne garde que le socle partagé (types de tour, analyseurs SSE, prompt de base) consommé par le pool ; le connecteur fait de la gateway le **chemin unique du chat** : URL **automatique par défaut** `ws://127.0.0.1:9120/api/ws` (lancer `gateway/run_api.py` suffit — rien à saisir), re-sonde silencieuse throttlée (10 s) à chaque tour donc un agent démarré après le service se branche seul, sans repli silencieux en cas d'échec gateway, clés fournisseurs actives comme seul moteur de secours (vrais modèles), et erreur claire « Agent Hermes non détecté … » quand ni l'un ni l'autre — la dépendance `z-ai-web-dev-sdk` est conservée pour l'ASR (dictée, transcription des pièces jointes audio), seul usage légitime restant. **UI** : sidebar « Moteur local · LLM intégré » devient « Agent Hermes non détecté » avec la marche à suivre, Paramètres → Système passe l'URL en **facultative** (placeholder « auto », débranchement = retour au défaut automatique), états du résumé/pied de Paramètres et tooltip du bouclier d'autorisations alignés (le bouclier reste logiquement verrouillé sans agent : sans agent, aucune action à autoriser). **Scripts de sonde** (mini-service `scripts/`) : `fake-gateway.ts` (gateway d'essai), `probe-no-demo.ts` (tour sans agent → erreur claire attendue), `probe-auto-connect.ts` (branchement automatique de bout en bout). **QA** : `tsc --noEmit` OK racine + mini-service ; boot honnête (mode local, agent non détecté) ; sonde sans agent → `stream:error` avec le message attendu, aucune réponse simulée ; fausse gateway lancée APRÈS le service → log « agent Hermes détecté → mode gateway » au tour suivant et contenu streamé reçu (enveloppe `api_turn_v1` validée). **Note** : le texte « appuyez sur entrée … » demandé à retirer n'existe plus dans le code (probable copie locale périmée — le lanceur met à jour au démarrage). |
| 2026-11-16 (39) | **Lanceur portable : fin du blocage sur le téléchargement de ffmpeg** (retour au premier démarrage : « ça bloque sur le téléchargement de ffmpeg » — chrome-headless-shell était passé en 6 s, ffmpeg restait suspendu des minutes sans un mot). **Cause** : source unique gyan.dev (serveur lent/injoignable sur certains réseaux) + `Invoke-WebRequest` sans garde-fou — aucun timeout, aucun abandon sur serveur muet, aucun affichage pendant que `$ProgressPreference` est silencié : la fenêtre paraît figée. **Correctifs (desktop/hermes-ui.ps1)** : (a) **Invoke-Download** préfère `curl.exe` (livré avec Windows 10/11) : `--retry 2`, connect-timeout 20 s, abandon si débit < 10 Ko/s pendant 30 s (serveur muet), `--ssl-no-revoke` quand le curl est un build Schannel (revocation qui échoue derrière certains proxys d'entreprise), progression en direct (« ... 30 Mo ») — repli `Invoke-WebRequest` conservé ; (b) **Install-ZipTool** : téléchargement en `.part` puis renommage (un arrêt ne laisse plus d'archive partielle exploitable par erreur), **deux sources pour ffmpeg** (miroir GitHub BtbN `ffmpeg-master-latest-win64-gpl` ~190 Mo d'abord, gyan.dev essentials ~110 Mo en repli), et **réutilisation d'une archive déjà déposée** dans `tools\<outil>.zip` — validée par extraction + présence de l'exe avant adoption, remplacée sinon : contourne aussi un réseau qui coupe (déposer l'archive à la main puis relancer) ; (c) **Install-ExeTool** multi-sources avec le même `.part` ; (d) **mise à jour GitHub déplacée AVANT l'installation des outils** (étape 0 de `Ensure-PortableSetup`) : les URLs de téléchargement du code le plus récent s'appliquent dès le lancement suivant, plus besoin d'attendre la fin des installs pour rattraper un correctif de lanceur ; (e) README-desktop : ligne de dépannage « téléchargement de ffmpeg qui bloque » (deux sources, progression, dépôt manuel `tools\ffmpeg.zip`). **QA** : URLs vérifiées HTTP 200 ce jour — BtbN → asset 201 948 478 octets, gyan.dev → `ffmpeg-9.0.2-essentials_build.zip` 114 768 076 octets ; équilibre `{}`/`()`/`[]` hors chaînes/commentaires vérifié par script sur les 2 .ps1 (checker écrit pour l'occasion, here-strings `@'` inclus) ; ps1 relu — convention sans accents conservée ; pas de PowerShell dans le sandbox pour un test réel (même limite qu'au chantier 37), le déroulé réel reste à confirmer au prochain double-clic. |
| 2026-11-16 (40) | **Bouclier des autorisations expliqué au survol + hint « Entrée pour envoyer » retiré** (demande : « dans model picker, pourquoi je ne peux pas changer le mode de permission » / « retire aussi appuyez sur entree.. »). **Réponse à la question** : le mode de permission (ask/auto, `hermes.permissions.mode`) n'a d'effet qu'avec une gateway — en mode démo l'agent n'exécute aucun outil ; le bouclier du composer (même barre que le model picker) était `disabled` hors gateway, sans explication visible au clic (un `title` sur bouton désactivé, souvent inaccessible au pointeur) : c'est la cause du « je ne peux pas changer ». **Correctif (composer.tsx)** : le bouclier adopte l'idiome du bouton « Recherche web » voisin — plus d'attribut `disabled`, `aria-disabled={mode !== "gateway"}` (sémantique gardée pour les lecteurs d'écran), clic gardé no-op hors gateway (le dialogue d'armement « Autoriser toutes les actions ? » reste réservé à la gateway), `title` remplacé par un Tooltip Radix (TooltipProvider delayDuration 300, idiome de la rangée) qui explique l'état dans les trois cas : démo (« sans objet en mode démo — l'agent démo n'exécute aucun outil. Actives avec une gateway »), gateway+ask (annonce l'action : « cliquer pour autoriser tout (terminal, fichiers, web) »), gateway+auto (« cliquer pour revenir à la confirmation avant chaque action ») — l'action du clic est désormais annoncée au survol, pas seulement l'état. (b) Le hint « Entrée pour envoyer » (paragraphe `hidden lg:flex` de la barre du composer) est retiré avec son icône `CornerDownLeft` (import suivi) : Entrée est le raccourci universel des champs de chat, la ligne n'apportait rien. **QA** : tsc 0 erreur, eslint propre, `bun run build` vert ; pile réelle (mini-service :3003 en démo + standalone :3117 + Caddy QA :8181, 1440×900) : « Entrée pour envoyer » absent du DOM, bouclier aria-disabled=true SANS attribut disabled (survolable), tooltip réel au survol = texte démo complet (capture), clic en démo → aucun dialogue, déclencheur du picker intact, 0 erreur console. |
| 2026-11-16 (41) | **Fin du mode démo — moteur local + branchement réel de la gateway depuis l'UI** (demandes : « vire moi ce mode démo ! et branche hermes ! », « pourquoi je ne peux pas changer le mode de permission », « retire aussi "appuyez sur entree.." »). **Le mot démo disparaît de tout le repo** : le moteur intégré était déjà un LLM réel (pool de clés fournisseurs puis SDK) — seul l'étiquetage « démo » mentait. (a) **Renommage** : `demo-engine.ts` → `local-engine.ts` (git mv), `DemoEngine` → `LocalEngine`, `DEMO_BASE_PROMPT` → `LOCAL_BASE_PROMPT`, `composeDemoSystemPrompt` → `composeLocalSystemPrompt`, `GatewayMode = "gateway" | "local"` (miroir `src/lib/chat-types.ts` inclus) — plus aucune chaîne « démo » dans le service ni l'UI ; le persona ne se présente plus comme une démonstration ; preset semé « Démo Hermes » → « Vitrine d'artefacts » ; suffixes `(démo)` des modèles tombés (strips morts retirés dans `pricing.ts` / `use-hermes-chat.ts`). (b) **Branchement de la gateway depuis l'UI** (c'était la réponse à « les paramètres de connexion à quoi ») : Paramètres → Système gagne le bloc « Connexion à l'agent Hermes » — URL + jeton facultatif, sonde WebSocket en direct (connecté / non branchée), persistance `hermes.gateway.url` / `hermes.gateway.token` dans `settings` (survit aux redémarrages, l'URL saisie PRIME sur `HERMES_GATEWAY_URL`, valeur vide = débranchement) ; événements socket `gateway:get` / `gateway:set` (ack `{ok, mode, url, tokenSet}`, broadcast `hello` + `models:changed` — le statut de la sidebar et les modèles suivent en direct) ; connecteur : `gatewayUrl`/`gatewayToken` deviennent des champs mutables (`setGateway()`), variables d'env en repli ; `hello` expose `gatewayTokenSet` (booléen, jamais la valeur). (c) **Bouclier des autorisations** : la cause du verrouillage était `mode !== "gateway"` — le moteur local n'exécute aucune action, le mode n'aurait rien gouverné ; le texte « démo » du tooltip trois-états du chantier (40) est réécrit sans jargon (« le moteur local n'exécute aucune action — actives quand la gateway Hermes est branchée (Paramètres → Système) ») : dès la gateway branchée, le changement redevient possible. (d) **Composer** : la ligne d'aide « Commandes · Entrée pour insérer, Échap pour ignorer » du popover slash est retirée — second hint « Entrée » du composer, complémentaire du retrait du hint « Entrée pour envoyer » au chantier (40) ; gating recherche web sur `"local"` ; libellés sidebar/pied de paramètres : « Moteur local · LLM intégré », « Moteur local · vos clés répondent » ; le lien d'aide du bas de sidebar pointe vers Paramètres → Système. (e) **README mini-service** : table des modes réécrite (Gateway/Local), branchement documenté UI d'abord + env en repli, nouveaux événements socket. **QA** : bunx tsc --noEmit 0 erreur (racine + mini-service) ; build Next.js complet OK ; service réel démarré — test-render-pipeline.ts et test-artifact-flow.ts SUCCÈS ; nouveau scripts/test-gateway-flow.ts 13/13 (hello honnête, refus d'URL invalide sans changement d'état, ws:// injoignable enregistré avec mode local, débranchement, normalisation http→ws) ; aucune occurrence « démo » restante dans src/ + mini-service (rg). |
| 2026-11-16 (42) | **F-27 livré — Piloter des chats IA web depuis l'interface (fournisseur `webchat`)** (demande : « je veux que tu implementes ça [spec `upload/pilotage-chats-ia-web.md`]. puis integrer en front dans le model picker et creer son parametre dans la page de parametre »). Les chats IA publics (z.ai, Google AI Studio, gemini.google.com) deviennent un FOURNISSEUR DE MODÈLES À PART, identifiant stable `webchat` (ids `webchat:<site>:<mode>`), indépendant de la gateway et des clés : le tour part sur un vrai navigateur piloté par CDP, pas sur une API (les sites refusent les requêtes fabriquées). (a) **Module `mini-services/hermes-chat/webchat/`** : `fiches.ts` (sélecteurs en DONNÉES, trois fiches conformes à la spec §3 — `verifie` fait foi : gemini-app est INDISPONIBLE, jamais cassé), `lock.ts` (verrou mono-pilote fichier+pid, reprise d'un processus mort, titre nommé dans l'erreur du perdant), `paths.ts` (garde de chemin : basename seul + realpath, un `../` est refusé et rapporté, jamais écrit), `cdp.ts` (client CDP minimal sur `ws`, idiome render.ts : /json, /json/close, Runtime.evaluate, Input.insertText, clics réels filtrés sur éléments VISIBLES — piège du doublon 0×0), `browser.ts` (profil DÉDIÉ --user-data-dir, kills vérifiés par la chaîne du profil — le navigateur personnel n'est jamais visé, veilleur détaché), `watchdog.ts` (fermeture après N min d'inactivité), `flows.ts` (z.ai : accueil = nouvelle tâche, jamais « New Chat », vidage du compositeur vérifié ≤12 essais, états du DOM « Thinking... »/« All files in task », crochet fetch /api/v1/storage/ + ancre neutralisée, octets en base64 ; AI Studio : discussion NEUVE about:blank→accueil→0 tour sinon reload ignoreCache, bandeau de consentement, palette de modèle PAR LE SETTER NATIF + Event('input'), envoi vérifié (textarea vidé + 30 car. réapparus ≤10 essais), bouton Stop = état en cours, extraction par clone (bruit retiré, blocs de code sortis par textContent du `<pre>` puis réinjectés en triples backticks) ; gemini-app : échec explicite tant que verifie=false), `driver.ts` (CLI sous-processus, contrat §4 : UNE ligne JSON stdout `{ok, site, mode, url, text?, files?:[{name,bytes}], elapsed_s, error}`, code 0/1, échec franc au plafond 240 s — jamais de succès tronqué), `engine.ts` (options de modèles + limitations dites dans l'interface, file sérielle — la comparaison A/B ne dispute pas le verrou, spawn + lecture du JSON, garde de chemin re-vérifiée côté service, sondes pour le volet). (b) **Service** : `models:list` fusionne le groupe « Chats IA web » (toujours proposé — ne dépend ni gateway ni clés) ; `runAssistantTurn` branche `webchat:*` AVANT le connector (statuts « Pilotage de … » réels via stream:status, événement outil par site, AUCUN streaming factice ; mode build : fichiers réinjectés en blocs `file="…"` → pipeline d'artefacts existant = cartes versionnées sans ligne nouvelle) ; événements `webchat:status/open/close` (ouvrir le navigateur pour SE CONNECTER UNE FOIS À LA MAIN — le code ne saisit ni ne stocke jamais d'identifiant). (c) **Front** : model picker — groupe fournisseur « Chats IA web » forcé, entrée indisponible = pastille + clic no-op (idiome aria-disabled), effort/mode expert remplacés par la note « ce que ce modèle ne sait pas faire » (§6 : réponse en un bloc 20 s-4 min, aucun outil, aucune mémoire entre tours, aucun accès au dépôt) ; section **Chats web** du volet Paramètres (`webchat-section.tsx`, 11 sections) : fiches + statut réel du navigateur de pilotage (port CDP sondé, binaire trouvé, dossier de sortie), boutons Ouvrir/Fermer + ouverture par site, réglages `fork.webchat.{port,timeoutS,idleMin,outDir,browserPath}` (settings:get/set). (d) QA : `scripts/test-webchat-flow.ts` **34/34** (unitaires hors service : fiches/ids, verrou + reprise d'un mort, garde de chemin `../` refusé et jamais écrit, filtre de processus, contrat JSON + code de sortie du pilote ; flux service : models:list, réglages roundtrip, webchat:status, tour gemini-app → stream:error explicite sans outil simulé) ; `bunx tsc --noEmit` 0 erreur, eslint propre, `next build` OK. **Reste à prouver sur machine réelle** (impossible dans le bac à sable, besoin d'un navigateur connecté) : critères §7.1/§7.2 de la spec — preuve de bout en bout z.ai et AI Studio avec une session connectée, et échec propre session déconnectée ; la procédure : Paramètres → Chats web → « Ouvrir le navigateur », se connecter aux sites, puis envoyer un tour avec « z.ai — Réponse ». |
| 2026-11-16 (43) | **Fix : verrou mono-pilote sur profil frais + sélecteur de modèle AI Studio** (captures : « La génération a échoué — verrou mono-pilote tenu par un autre pilote (pid -1, site ???, démarré ?) », puis « carte du sélecteur de modèle AI Studio introuvable » après connexion Google). (a) **Verrou** : l'écriture de `hermes-pilot.lock` avait lieu AVANT la création du dossier profil (seul `ensureBrowser` le crée) → ENOENT déguisé en faux titulaire `{pid:-1, site:"?"}` ; `DriverLock.acquire` crée désormais le dossier parent, distingue une vraie erreur disque (erreur nommée, jamais de faux titulaire) d'une course EEXIST (relue jusqu'à 3 tentatives), `driver.ts` attrape le jet → échec JSON franc ; `engine.writePromptTemp` crée `db/` avant son écriture ; QA +2 (profil frais). (b) **AI Studio** : `button.model-selector-card` absent du DOM réel → fiche gagne `carte_candidates` (6 sélecteurs essayés dans l'ordre, attente d'état 20 s), échec avec DIAGNOSTIC (boutons visibles du DOM réel : cls/label/text) pour corriger la fiche en données ; slug `gemini-4-argon` (placeholder jamais relevé) → `modele: null` = modèle courant conservé (mode prévu par la spec §3), procédure de relevé notée dans la fiche ; QA +2. **QA** : bun scripts/test-webchat-flow.ts 32/32 unitaires ; bunx tsc --noEmit 0 erreur. |
| 2026-11-16 (44) | **Mise à jour sans rien fermer — bouton dans Paramètres → Système** (demande : « pour faire la mise à jour de l'interface je dois fermer mon onglet hermes, fermer la boîte cmd qui fait tourner le serveur, puis lancer le lanceur .bat à chaque fois — que proposes-tu ? »). (a) **Service** : événement socket `system:update-request` — dépose le drapeau `desktop/runtime/maj-demandee.flag` (ack `{ok}`), jamais de redémarrage lancé par le service lui-même : l'orchestrateur reste le lanceur. (b) **Lanceur Windows** (`hermes-ui.ps1`) : la boucle de surveillance (cycle 15 s) ramasse le drapeau → arrêt propre (finally + Stop-All) → `Do-Start -MajDepuisInterface` qui refait `Ensure-PortableSetup` → `Update-FromGit` (fusion GitHub, reconstruction sélective seulement si src/public/config a changé) et relance SANS rouvrir le navigateur ; drapeau resté posé nettoyé à chaque démarrage. (c) **Lanceur Linux** (`hermes-ui.sh`) : même drapeau dans `supervise` ; `do_start` gagne `update_from_git` compact (fetch + ff-only, version locale conservée si écart ; reconstruction production si `^(src|public)/` ou config touchée — c'est la première mise à jour git du lanceur Linux) + variable `SANS_NAVIGATEUR` pour la relance. (d) **Front** (`system-section.tsx`) : carte « Mise à jour de l'interface » — bouton « Mettre à jour » puis état honnête (demande déposée / erreur), consigne F5. (e) **README desktop** : section « Mettre à jour sans rien fermer ». L'onglet utilisateur ne se ferme jamais : F5 suffit une fois la pile revenue. **QA** : bash -n 0 erreur ; bunx tsc --noEmit 0 erreur ; build Next.js complet OK ; QA webchat SUCCÈS (l'événement n'est PAS testé en auto — il provoquerait un vrai redémarrage de la pile de test). |
| 2026-11-16 (45) | **Model picker épuré — « trop de meta »** (demande : « il y a trop de meta dans le model picker, je t'ai toujours demandé de faire simple épuré intuitif, sans redondances. sépare également les modèles Web Chat des autres »). La capture montrait le même pavé « Pilote un vrai navigateur : réponse en un bloc… » répété sur CHAQUE ligne webchat (tronqué, illisible, redondant), une ligne id mono sous chaque modèle (`webchat:zai:answer`…), le compteur « 16 modèles · 2 fournisseurs » + InfoTip au pied, et le bloc du bas qui répétait ENCORE les mêmes limites : la même information apparaissait jusqu'à trois fois à l'écran. (a) **model-picker.tsx** : ligne id mono supprimée partout (la recherche continue de couvrir id+fournisseur) ; compteur du pied supprimé — remplacé par un seul mot HORS cas dégradé (source `catalogue` seule : « Catalogue statique — ajoutez une clé… »), rien dans les cas normaux ; étiquette « Échelle : X » de la ligne d'effort tombée (l'échelle est visible dans les segments, l'InfoTip garde le détail) ; bloc webchat du bas resserré (le label de droite « Chats IA web » répétait la section, le paragraphe tient en deux lignes). (b) **Séparation Web Chat** : les modèles `webchat:*` sortent des groupes fournisseurs — section dédiée en FIN de liste, titre à l'icône globe, filet de séparation (`border-t`) : jamais mêlés aux modèles du moteur ; le regroupement par fournisseur des autres modèles s'étend au cas « ≥ 2 fournisseurs coexistants » (l'info fournisseur reste lisible dans les titres puisque la ligne id est tombée). (c) **engine.ts** : la constante LIMITATIONS et son `description:` supprimés des options webchat — la redondance était servie par les données ; les limites restent dites UNE fois (bloc « Pilotage navigateur » du picker, spec pilotage §6). **QA** : bunx tsc --noEmit 0 erreur ; bun scripts/test-webchat-flow.ts SUCCÈS (30 unitaires OK, volet service sauté hors pile — aucun test ne dépend de la description retirée). |
| 2026-11-16 (46) | **Mise à jour : flux visible en direct — « ça serait bien d'avoir une sorte de stream »** (retour : « j'ai l'impression que la mise à jour de l'interface n'a pas fonctionné »). Diagnostic : le chantier (44) déposait un drapeau et l'interface restait aveugle ensuite — ET le lanceur qui tourne exécute la version chargée à son démarrage : si le processus date d'avant le correctif, le drapeau n'est jamais ramassé et RIEN ne se passe, sans un mot. (a) **Journal du lanceur** (`desktop/runtime/maj.log` — .ps1 et .sh) : `Write-MajLog`/`maj_log` (actifs seulement quand une demande interface est en cours — les démarrages ordinaires ne polluent pas) raconte chaque étape horodatée : MAJ DEBUT, arrêt des services, consultation de GitHub, déjà à jour / appliquée N fichiers / sauvegarde+alignement / GitHub injoignable, reconstruction, relance, et marqueurs terminaux **« MAJ OK - pile relancee… »** / **« MAJ ERREUR - … »** (Die y passe aussi — port épuisé, échec d'installation). (b) **Mini-service** : `system:update-request` démarre le journal (ligne d'attente horodatée, page blanche à chaque demande) ; nouveau handler `system:update-log` (lecture, plafond 64 Ko) + relais en direct `system:update-log:changed` (sondage 2 s, diffusion seulement sur changement — le lanceur écrit le fichier, jamais le service). (c) **Interface** (`system-section.tsx`) : la carte gagne une **console live** (mono, défilement collé en bas) — verdict « Mise à jour terminée » en vert avec bouton **« Recharger la page »** (plus de F5 à deviner), « Échec » en rouge avec renvoi au lanceur, « reconnexion en cours » pendant la coupure (le lanceur arrête ce service pour le relancer — reprise sur socket connect), et après 45 s sans étape nouvelle le message franc « le lanceur ne réagit pas — il date probablement d'avant cette fonction, relancez le .bat une fois puis redemandez » ; reprise au montage (un F5 pendant la mise à jour ne perd pas la console). (d) **README desktop** : section mise à jour réécrite autour de la console. **QA** : `scripts/probe-maj-stream.ts` **7/7 sur service réel** (ack+drapeau+journal démarré, relecture, relais d'une étape en <2 s, verdict MAJ OK) ; bunx tsc --noEmit 0 erreur ; bash -n OK ; équilibre {} () [] du .ps1 vérifié hors chaînes/commentaires (pas de PowerShell au sandbox, même limite qu'aux chantiers 37/39) ; QA webchat SUCCÈS ; eslint — la seule remontée (`react-hooks/set-state-in-effect`, sonde renderCache) existe déjà au commit précédent. **À confirmer chez vous** : bouton « Mettre à jour » avec la fenêtre du lanceur ouverte — le déroulé doit s'afficher ligne à ligne jusqu'à « Mise à jour terminée » ; et si le lanceur est muet, le message d'incompatibilité apparaît au bout de 45 s. |
| 2026-11-16 (47) | **Paramètres v2.6 — passe d'épuration + ajout unifié « nom ou adresse »** (demandes : « refais une passe » ; « que l'ajout de tools ou de services, mcp, skills, soit moins chiant : soit taper un nom, soit donner une url et le moteur va chercher et installer tout seul le service. si besoin d'une clé api, je l'ajoute une fois le service installé et visible dans la page de parametre » ; « retire des listes les services que je n'aurais pas encore installé moi même (à part les fournisseurs de modeles ia) »). (a) **Rail à 9 sections** : Outils + Extensions + Skills fusionnées en « Outils & extensions » (`outils-extensions-section.tsx` nouveau ; `tools-section.tsx` et `skills-section.tsx` supprimés ; `extensions-section.tsx` réduit à la carte `ExtensionRow` exportée) — plus de navigation entre trois vues qui parlaient des mêmes choses. (b) **Ajout unifié** : événement socket `registry:install` (service) — une entrée libre est résolue dans l'ordre : dépôt GitHub (URL / owner/repo / git@) → extension `repo` résolue réellement (fetchRepoSnapshot) ; adresse https OU commande de lancement (npx/uvx/bunx/node/python/docker) → serveur MCP ; nom connu du catalogue → fournisseur créé avec le kind du catalogue (service → fiche « Clés de services », llm → « Fournisseurs »), doublon = message qui renvoie à la fiche existante ; le reste = erreur explicite. La clé API n'est jamais demandée à l'installation — elle s'ajoute sur la fiche. Côté client : `installAnything` (use-providers) + composant `AddAnything` (champ unique + hint court, toasts qui disent où la fiche est apparue), posé en tête de la section fusionnée (toujours visible, zéro clic) ET dans « Clés de services » (le catalogue déroulant Tavily/Exa/FAL/xAI de l'ancien panneau d'ajout service disparaît — c'était la liste de services non installés) ; « Fournisseurs » garde son sélecteur (catalogue de modèles IA exempté par la demande). (c) **Listes épurées de ce qui n'existe pas** : les 6 lignes d'outils verrouillés « gateway » (navigateur, X, images, vidéo, terminal, fichiers) sortent de la liste — ne restent que les trois outils réellement livrés ; blocs « à venir » retirés (Hermes : fichiers .md moteur / comportement moteur ; Modèles : note modèle d'arrière-plan), lignes Skills réduites à un état vide honnête d'une ligne. (d) **Dédoublonnage et langue** : statut moteur affiché en pied de volet SEULEMENT (le double du rail tombe, la version du service reste) ; libellés « Endpoint » → « Adresse » partout dans l'UI (toasts inclus) ; Chats web : descriptions de fiches courtes (« Prêt » / « Pas encore prêt »), réglages des pilotes repliés derrière « Réglages avancés » (idiome ProviderCard), paragraphe CDP/--user-data-dir remplacé par une ligne de réassurance ; Profils : note « bus de réglages » tombée (le flash le dit déjà) ; Modèles : descriptions et états vides raccourcis. **QA** : `bunx tsc --noEmit` 0 erreur, `bun run build` vert ; `scripts/probe-registry-install.ts` **8/8 sur service réel** (tavily→service, openrouter→llm, doublon→« déjà configuré », octocat/Hello-World→repo résolu (branche+tête), https→MCP, npx→MCP, inconnu→erreur, nettoyage base vérifié) ; pile complète au navigateur (Next :3000 + service :3003 + Caddy :81 — le socket passe par le proxy XTransformPort, sans Caddy la page reste muette) : rail 9 sections, champ unifié rendu, install « tavily » depuis « Clés de services » → carte « Tavily · 0 clé » apparue en direct puis retirée (base propre), captures des sections refondues. |
| 2026-11-16 (48) | **Artefacts : ouvrir dans un onglet + terminal du tour** (demandes : « pour apercu des artefacts, je veux une icone pour ouvrir l'artefact dans un nouvel onglet » ; « dans le panneau des artefact, j'aimerais un encart en bas avec le terminal dont se sert le llm » ; cadre « ui épurée, intuitive, moins de clics possibles, pas de redondances »). **Décision structurante : le HTML s'ouvre rendu derrière un bac à sable CSP** — route `GET /artifacts/<id>/view` (`text/html` + `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals`, origine opaque : ni cookies ni stockage ni jetons accessibles) plutôt que d'ouvrir la vignette PNG : c'est le seul choix qui donne un vrai artefact exploitable dans l'onglet sans toucher aux garde-fous XSS existants (`/raw` et `/download` restent texte brut — la règle « jamais servi comme text/html » vaut désormais pour les origines app, pas pour une origine opaque). Champ `viewUrl` (html seul) dans le payload wire + types miroir ; `openArtifactInTab()` (viewUrl sinon rawUrl). Deux icônes `ExternalLink` : la carte (l'ancien bouton « Ouvrir » qui rouvrait le panneau — doublon du clic carte — devient l'action nouvelle) et l'en-tête panneau/visionneuse mobile (désactivée hors `ready`). **Terminal du tour** (`artifact-terminal.tsx`, composant unique panneau + visionneuse) : l'activité outil du message qui porte l'artefact — stream vivant d'abord (`streams[messageId]`), événements persistés ensuite (`message.toolEvents`) ; barre fine repliée (point pulsant si vivant, « N étapes » sinon), console sombre heure/statut/nom/détail collée en bas, s'ouvre seule quand le tour vit (repli manuel respecté, rien ne bouge à la clôture), **absente sans données** — pas d'encart mort ; clé = messageId (reset par tour) ; `resolveTurnTools` fourni par la page ; ouverture auto portée par le pattern « état dérivé pendant le rendu » (la règle `set-state-in-effect` interdit l'effet — idiome déjà utilisé par le panneau). QA : `scripts/probe-artifact-view.ts` **16/16** (service réel ports dédiés + base jetable) ; pile complète navigateur via `scripts/qa-proxy.ts` (nouveau, remplace Caddy en sandbox — XTransformPort + tunnel TCP des WebSockets ; **tourne sous node** : l'`upgrade` node:http de Bun ne pipe pas) + `qa-seed-view.ts` : carte → panneau → onglet rendu → terminal déplié (4 lignes horodatées) ; captures `download/qa-f28/` ; tsc 0 erreur, build vert, eslint propre. |
| 2026-11-17 (49) | **F-30 livré — Modes du compositeur** (maquettes validées par l'utilisatrice avant implémentation, convention `design/` : `maquette-modes.html` + `maquette-parametres-modes.html` ; demandes cumulées : explications simples, zéro badge, Comparer avant Débat, sections Paramètres bien séparées, textes user friendly « pas langage machine »). **Sept modes : chat · plan · code · comparer · débat · conseil · auto** — Comparer (F-17) devient le 4ᵉ mode du sélecteur, la bascule quitte le composer, plus d'exclusion spéciale : un seul mode actif à la fois ; la pastille est le premier contrôle du pied, elle seule décide du traitement du prochain message. **Service fait foi** : nouveau `mini-services/hermes-chat/modes.ts` (résolution `inconnu → chat`, bornes 3–10 tours / 2–5 membres / 0–3 reprises clampées à la saisie ET revalidées, 13 consignes par défaut + surcharges en table settings `hermes.modes.prompts` relues À CHAQUE ENVOI, mots-clés `{angle} {tours} {membres} {reprises}` interpolés au tour jamais en base) ; store : colonnes additives `conversations.mode/mode_rounds/mode_config` + `messages.mode_tag/mode_flow`, fork hérite du mode ; socket `conversations:setMode` (résolu + borné + ack) + diffusion `conversations:mode`, `conversations:create` accepte le mode ; `runAssistantTurn` relit le mode à chaque envoi — compare → re-split variantes a/b via les voix (l'écran n'envoie plus de paire), débat/conseil/auto → orchestrateur, plan/code/chat → consigne dans le systemPrompt recomposé (local ET gateway) + `plan_mode:true` tenté au premier tour (refus non bloquant). **Orchestrateur** (`orchestrator.ts`, `runVoiceTurn` injecté pour la QA) : débat séquentiel qui se répond + juge streamé, conseil parallèle lecture seule avis anonymisés A/B/C + président streamé, auto débat facultatif → plan → code → test avec reprises sur échec prouvé (tête ÉCHEC/FAIL) — une seule réponse conservée, le déroulé (`mode:flow` en direct puis `mode_flow` persisté) vit dans la conversation au-dessus de la réponse, modèles par voix (`mode_config.voices`) sinon modèle de la conversation, échec de voix honnête sans casser la fusion. **Client** : `src/lib/modes.ts` miroir d'affichage, registre R5 `hermes.modes.*` (défauts des nouvelles conversations), `mode-picker.tsx` (pastille allumée hors chat + popover 7 modes + steppers + « qui travaille »), composer épuré (bascule Comparer retirée), `mode-flow.tsx` (encart déroulé + étiquette ★), bubble/liste rendent déroulé persisté au rechargement, chip « Comparer » sur les paires, Paramètres rail 10 sections + `modes-section.tsx` (une carte par mode, 13 éditeurs de consignes compteur/Réinitialiser/chips, voix et modèles) — textes simples partout, zéro badge, zéro jargon. **QA** : `scripts/test-modes-flow.ts` **70/70** (unitaires sans LLM sur faux moteur : ordre des tours, parallélisme, anonymisation, reprises, interpolation, bornes, store, fork ; service réel ports dédiés : création avec mode, setMode + diffusion, consigne serveur) ; navigateur pile complète (qa-proxy :8181 + `fake-gateway.ts` :9120) : popover, tour conseil réel avec déroulé vivant et « ★ Fusion · Conseil — 2 membres », section Paramètres vérifiée en base (édition + réinitialisation), mobile 390 px ; tsc 0 erreur, build vert, eslint sans remontée nouvelle ; conversations QA nettoyées de la base de dev. |
| 2026-11-17 (50) | **F-30b — Un modèle de chat web IA pour chaque mode** (demande : « pour chaque mode, je veux pouvoir assigner un modèle de chat web IA »). **Modes à voix** (Comparer, Débat, Conseil, Auto) : chaque voix peut être un chat web (`webchat:<site>:<mode>`) — les listes de choix (« qui travaille » du composer + voix Paramètres, via le nouveau composant partagé `model-choice-list.tsx`) portent les modèles du moteur puis le groupe « Chats IA web — pilotage navigateur » avec la ligne honnête (réponse d'un bloc, tours l'un après l'autre — la file du pilote sérialise, un seul navigateur) ; un site non vérifié reste absent des listes. **Modes sans voix** (Chat, Plan, Code) : ligne « Modèle du mode » dans le pied du sélecteur + ligne Paramètres par carte — l'assignment remplace le modèle de la conversation quand le mode est actif (`mode_config.model` normalisé côté service, id invalide → null ; défauts des nouvelles conversations au registre client `hermes.modes.models`, rejoints au changement de mode comme les voix). **Service** : `orchestratorDeps.runVoiceTurn` route un id webchat vers `runWebchatTurn` (consigne de la voix prépendée au message — pas de systemPrompt chez un site web ; fichiers build réinjectés via le helper partagé `webchatFileBlocks`) ; `runAssistantTurn` applique `turnModelId` aux tours non orchestrés hors variantes ; chip du déroulé = site (« z.ai ») via `shortModel`. **Deux corrections au passage** : la consigne commune `compare.main` était morte depuis F-30 (variantes = section de mode sautée — elle part maintenant sur chaque colonne) ; la consigne du mode était perdue sur un tour webchat (prépendée au prompt). **QA** : `scripts/test-modes-flow.ts` **82/82 verts** (normalisation `config.model`, `modeModel`, `shortModel` webchat, débat avec voix webchat transmise telle quelle + chip « Google AI Studio », service réel : setMode persiste le modèle du mode) ; tsc 0 erreur, eslint sans remontée nouvelle. |
| 2026-11-17 (51) | **Fusion webchat — une entrée par site, la forme de la réponse est observée** (demande : « fusion, le moteur doit déterminer tout seul selon la demande »). Les deux entrées « z.ai — Réponse » / « z.ai — Fichiers » (F-27) deviennent UNE entrée par site (ids `webchat:<site>` ; l'ancien `webchat:<site>:<mode>` reste accepté en lecture et est normalisé à l'écriture comme à la lecture — aucun réglage ni conversation à migrer). (a) **flows.ts** : le flux z.ai n'a plus de mode — la boucle d'attente observe les DEUX fins (carte « All files in task » sans « Thinking... » → fichiers ; texte stable 3 relevés sans carte annoncée → texte ; des artefacts annoncés suspendent la sortie texte) puis rapatrie ce que le site a produit (crochet fetch + clics de téléchargement, ou lecture du texte). (b) **driver.ts** : `--mode` supprimé (contrat `{ok, site, url, text?, files?, refused?, elapsed_s, error}`), branche sur le résultat OBSERVÉ ; `--out` requis dès que des fichiers apparaissent ; l'onglet du site reste ouvert dans tous les cas. (c) **engine.ts** : une option par site dans `models:list` (libellé = site, z.ai / Google AI Studio / gemini-app indisponible), statuts sans mention de mode, `--out` toujours passé. (d) **Service** : `normalizeModeConfig` (modes.ts) et `parseModeConfigWire` (store.ts) ramènent les ids historiques au format fusionné — voix, modèle du mode, defaults client couverts. (e) **Front** : captions mises à jour (listes de choix + bloc « Pilotage navigateur » : « texte ou fichiers, selon la demande ») ; registre client `hermes.modes.models` / `hermes.modes.voices` normalisés à la lecture (mode-picker, modes-section). (f) **QA** : `test-webchat-flow.ts` au nouveau contrat (ids fusion + historique, pilote sans `--mode`, `models:list` 3 entrées dont l'indisponible, tour gemini-app → stream:error) — SUCCÈS ; `test-modes-flow.ts` **84/84** (historique → fusionné, shortModel des deux formats, setMode persiste `webchat:zai`) ; tsc 0 erreur, eslint propre. Instances redémarrées (3003 + 3013) pour charger le code fusionné. Reste à prouver sur machine réelle : un tour z.ai en texte ET un tour z.ai avec fichiers via l'entrée unique. |
| 2026-11-17 (52) | **Débat : plus de blocage muet sur la première voix** (demande : « j'ai lancé un mode débat et l'opération reste bloquée sur le sceptique »). Reproduction service réel puis diagnostic : **deux causes combinées**. (1) **Aucun timeout sur les tours streaming du pool** — la gateway a son 180 s, le webchat son délai global de pilote, la compaction 120 s, mais `streamOpenAiTurn`/`streamAnthropicTurn` ne passaient que le signal d'annulation utilisateur au fetch : une connexion fournisseur qui s'enraye (aucune réponse, ou octets qui cessent) bloquait la voix indéfiniment, sans erreur ni fin — le déroulé restait « en cours » sur le sceptique, première voix du débat. (2) **Échecs de voix invisibles** — débat et auto n'avaient pas le try/catch du conseil : une voix qui mourait (fournisseur muet, gateway hors ligne, site webchat refusé) laissait sa ligne « running » et remontait une erreur brute sans contexte. **Corrections** : (a) `llm-pool.ts` — **garde d'inactivité** (`stallGuard`, 120 s) : minuteur repartant à chaque octet reçu (une réponse longue mais vivante reste licite), déclenchement = annulation du fetch avec un motif parlant (« plus aucun octet reçu depuis 120 s — tour abandonné »), nettoyage dans tous les cas ; l'arrêt utilisateur continue de rendre le partiel tel quel ; (b) `orchestrator.ts` — `runVoiceWithRow` : sur échec, la ligne du tour passe en « error » avec le motif et l'erreur remonte contextualisée (« Voix « Sceptique » (tour 1) : … ») ; arrêt utilisateur = ligne « interrompu », erreur laissée telle quelle (le service clôt en « stopped ») ; appliqué aux conseillers et au verdict du débat, au président du conseil, aux étapes/test/reprises d'auto ; la boucle des tours du débat ne relance plus un tour après un arrêt ; (c) **outillage de preuve** : `mini-services/hermes-chat/scripts/stall-server.ts` (fournisseur muet : `/models` répond, `/chat/completions` jamais) et `scripts/preuve-debat.ts` (débat complet contre le service réel, vérifie ligne en « error » + `stream:error` contextualisé). **QA** : tsc 0 erreur, eslint propre, `test-modes-flow.ts` **84/84**, `test-webchat-flow.ts` succès ; **preuve live** : avant correctif le tour ne finissait jamais (watchdog 170 s sans événement), après correctif la ligne passe en « error » et le `stream:error` contextualisé arrive à 120 s pile. |
| 2026-11-17 (53) | **Pont de dépannage F-31 — le rapport d'incident intégré à l'interface** (demande : « est-ce que tu peux construire un pont entre toi et l'interface pour dépannage ? » ; le correctif (52) ne suffit pas seul : si le SERVICE est arrêté, la page n'apprend jamais rien). **Constat d'abord** : sur déconnexion socket, `onDisconnect` du client effaçait les flux EN SILENCE — le déroulé restait « en cours » sans fin ni erreur, exactement la capture d'écran ; et côté sandbox, `stall-server.ts` (9299) tournait encore depuis la preuve (52) pendant que la pile (3000/3003) était morte. **Côté service** : nouveau `trace.ts` — journal tournant EN MÉMOIRE (400 événements, `trace(cat, msg)` : boot · socket · turn · orch · webchat · error, jamais de contenu de message ni de clé, commit git capté au lancement) branché sur la session socket (connect/disconnect), le cycle des tours (démarré mode/modèle, orchestré terminé tag, échec), le cycle des voix (`runVoiceWithRow` : démarre → terminée N s/N car. ou échec après N s avec motif) et le pilote webchat (`runWebchatTurn` : lancé port/plafond/navigateur, terminé ok=N s ou abandonné motif) ; **GET /diagnostics** sur le 3004 (même jeton que le reste — Bearer ou ?token=) renvoie `{service:{commit,bootAt,uptimeS,ports}, webchat:{port,browserUp,pid pilote,timeoutS,profileDir}, trace:[…], traceMeta}` — la première question de tout dépannage (« mon instance tourne-t-elle sur le code corrigé ? ») a enfin une réponse lisible. **Côté interface** : (a) `onDisconnect` ne disparait plus en silence — si un tour était en vol, erreur honnête persistante (« Connexion au service perdue pendant le tour… réessayez après reconnexion ») ; (b) vigie de silence : tout événement socket (`socket.onAny`) remet le filtre d'activité — sans RIEN pendant 60 s pendant un tour, notice ambre non destructive (« gardes côté service : 120 s pool, ~240 s pilote webchat — ou service mort ») ; (c) `debug-bridge.tsx` : panneau `?debug=1` (drapeau mémorisé localStorage, « Fermer » le retire) — état de la socket (pastille verte/rouge), journal client des derniers événements résumés une-ligne (delta N car., statuts, déroulé N lignes, ERREUR — jamais le contenu), bouton **« Copier le diagnostic »** qui assemble `[CLIENT]` (URL, UA, socket, événements) + `[SERVICE]` (GET /diagnostics) et le met au presse-papiers pour le coller à l'agent ; monté dans `page.tsx`. **Outillage** : `scripts/hermes-up.sh` (pile complète en une commande : navigateur de pilotage headless Playwright sur 9222, service 3003/3004, Next 3000 — logs dans `logs/`) et `mini-services/hermes-chat/scripts/preuve-pont.ts` (débat 1 tour voix = webchat:zai, plafond ramené à 30 s puis restauré 240). **QA** : tsc 0 erreur, eslint propre, `test-modes-flow.ts` **84/84**, `test-webchat-flow.ts` succès ; **preuve live du pont** : débat webchat → « Tour 1 · Sceptique » en ERROR à 40 s (« aucun texte produit par z.ai — session expirée ? refus du site ? » — sandbox sans session z.ai, échec HONNÊTE attendu), `stream:error` contextualisé, et GET /diagnostics raconte toute l'histoire : commit `baf792a`, navigateur UP=true port 9222, pilote lancé → terminé ok=false 40 s → voix en échec → tour en échec. |
| 2026-11-17 (54) | **Le pont de dépannage lisait sur le mauvais port — le vrai diagnostic de l'utilisatrice** (rapport collé : `[SERVICE] (service a répondu HTTP 400)` pendant que le client montrait socket verte + tour démarré ; captures : Tour 1 · Sceptique passé de « en cours » à « terminé », Pragmatique « en cours » — le débat VIVAIT, lent, rien de mort). **Cause** : `debug-bridge.tsx` appelait `serviceUrl("/diagnostics", SERVICE_PORT)` = **3003**, le service socket.io — qui répond HTTP 400 « Bad Request » à toute requête qui n'est pas une poignée de main socket.io ; `/diagnostics` vit sur le **3004** (fichiers + diagnostics). Preuve en direct : `curl :3003/diagnostics` → 400, `curl :3004/diagnostics` → 200 JSON complet, et via la gateway `curl :81/diagnostics?XTransformPort=3004` → 200 (le chemin exact de la machine Windows). (Le jeton n'était PAS en cause : la section 3004 accepte Bearer **ou** `?token=`, et `serviceUrl` met déjà le jeton en query.) **Correctifs** : (a) `debug-bridge.tsx` — fetch sur `FILES_PORT`, avec le pourquoi en commentaire ; (b) la notice de silence (`use-hermes-chat.ts`) pointe désormais vers l'**icône clé à molette** de l'en-tête (F-31bis, commit `185135d` : bouton Wrench + tooltip « Dépannage — si ça bloque, cliquez puis Copier le diagnostic », ouverture par l'événement `hermes:debug-open` écouté par le pont) et garde `?debug=1` en secours ; (c) lecture du rapport : la section SERVICE montre maintenant commit, uptime, navigateur de pilotage et journal tournant — la même vie que côté service. **QA** : tsc 0 erreur, eslint propre ; 3003→400 / 3004→200 / :81→200 re-vérifiés après correctif. Reste à confirmer chez l'utilisatrice : relancer `Hermes-Web.bat` puis refaire « Copier le diagnostic » — la section SERVICE doit contenir la trace. |
| 2026-11-17 (55) | **Le rapport dit ENFIN « lent ou mort » pendant le tour — premiers diagnostics complets de l'utilisatrice** (rapport collé : CLIENT et SERVICE visibles pour la première fois — le correctif (54) est confirmé chez elle : commit `37d68a8` en service, trace lisible ; capture du débat : Sceptique démarré 01:57:39, aucun événement 136 s plus tard au moment de la copie). **Lecture honnête du rapport** : la garde 120 s n'avait PAS tiré → des octets arrivaient encore (réponse lente mais vivante) — mais la trace ne le PROUVAIT pas : entre « bave lentement » et « silence total », aucun indice tant que la garde ne tranche pas. **Constatations annexes** : (a) `browserUp: false` + enregistrement pilote périmé (pid 23:10, session précédente) est l'état NORMAL au boot — `ensureBrowser` (webchat/browser.ts) relance le navigateur de pilotage EN DEMANDE au premier tour webchat, rien à réparer côté bat ; (b) `authenticated: false` sur sa machine (mode dev sans jeton — l'interface et le service tournant tous deux en local derrière Caddy, acceptable ; le rapport reste colle-partageable). **F-31ter — suivi live des tours LLM** : `llm-pool.ts` — registre `activeStreamEntries` (Set) alimenté par `stallGuard` dès le lancement du tour (provider, model, startedAt, lastByteAt, bytes) ; `reset(bytes)` comptabilise les octets bruts reçus (`value.byteLength` aux deux boucles reader, openai + anthropic) ; `done()` (en `finally` des deux streamers) purge l'entrée — aucune fuite même sur abandon/garde ; `HERMES_TURN_STALL_MS` (surcharge env, plancher 5 s) pour les preuves. `/diagnostics` expose `pool: { streams: [{provider, model, startedAgoS, lastByteAgeS, bytes}] }` — `lastByteAgeS` grand = muet (la garde va tirer), petit = vivant-lent ; section vide = rien en vol. **Outillage** : `scripts/preuve-pool-streams.ts` (faux fournisseur 2 morceaux SSE puis silence TOTAL, service jetable 3343/3344, garde 8 s) — **preuve live** : en vol `{provider z.ai, model glm-goutte, startedAgoS 2, lastByteAgeS 1, bytes 99}` ✓ puis `stream:error « z.ai : plus aucun octet reçu depuis 8 s — tour abandonné (garde d'inactivité) »` + registre vidé ✓. **QA** : tsc 0 erreur, eslint propre. Reste à l'utilisatrice : relancer le bat, refaire un tour qui semble coincé, « Copier le diagnostic » — la section `pool.streams` dira laquelle des deux hypothèses de la notice ambre est la bonne. |
| 2026-11-17 (56) | **Débat : 61 minutes chrono — l'option « voix du tour en parallèle » et une notice qui dit la vérité** (rapport final de l'utilisatrice, SANS mise à jour : débat 3 tours terminé proprement — les 10 voix séquentielles + verdict tracées une par une ; « c'est terriblement lent »). **Chronométrie (scripts/chronometrie-debat.py)** : total **61 min 07** (Sceptique 209/439/574 s, Pragmatique 442/306/302 s, Innovateur 370/456/486 s, Verdict 83 s), 72 471 caractères, débit moyen **19,8 car/s** ; tours de plus en plus longs (17→20→22,7 min) car chaque voix lit tous les arguments précédents ; la même voix met 2,7× plus de temps au T3 qu'au T1. **Révélation : le Verdict tourne à 70,1 car/s** — même modèle, même réglages (`ctx.settings` partagés, `reasoningEffort` jamais posé) : le fournisseur SAIT débité vite, la lenteur des voix vient du séquentiel + du contexte qui grossit, pas d'un bug ni d'une garde. **(1) Option `debateParallel`** (défaut : désactivée — l'enchaîné reste la règle) : `modes.ts` (+ `normalizeModeConfig`, miroir client `src/lib/modes.ts`), `orchestrator.ts` — branche parallèle de `runDebate` (motif du conseil) : `Promise.all` sur les 3 voix du tour, chacune ne voit que les tours PRÉCÉDENTS (les voix de son tour répondent en même temps — visibles au suivant), lignes du déroulé posées « en attente » puis allumées, transcription dans l'ordre canonique des voix (pas l'ordre d'arrivée) ; **tolérance aux échecs partiels** (une voix morte ne tue plus le débat — changement honnête vs l'enchaîné qui est tout-ou-rien), relance franche si LES TROIS échouent ; `mode-picker.tsx` — interrupteur « Voix du tour en parallèle (plus rapide) » sous le compteur de tours. Gain attendu chez l'utilisatrice : ~61 min → **~20 min** (3×, le verdict restant seul). **(2) Notice de silence honnête** : le hook suit la voix en vol via `mode:flow` (`runningVoiceRef`, remise à zéro à la fin du tour) — à 60 s de silence, l'écran dit « Tour 1 · Sceptique travaille depuis 110 s — réponse lente mais en vol » au lieu de crier au service mort ; l'ancienne formulation reste quand AUCUNE voix n'est en vol. **QA** : tsc 0 erreur, eslint propre, `test-modes-flow.ts` **84/84** (volet service réel compris), **preuve live** `scripts/preuve-debat-parallele.ts` (service jetable 3345/3346, faux fournisseur journalisant les fenêtres de requêtes) : les 3 voix du tour démarrent à la MÊME ms côté fournisseur (chevauchement réseau OUI), déroulé à 3 lignes « running » simultanées avec le bon détail, verdict reçu — **PREUVE RÉUSSIE ✓**. Reste chez l'utilisatrice : relancer le bat, activer l'option dans la config du débat (ou passer les voix sur glm-4.5-air). |
| 2026-11-17 (57) | **Les 61 minutes deviennent le défaut rapide — plus d'interrupteur à chercher** (consigne de l'utilisatrice : « oublie le prompt, gère les 61 minutes » ; l'option (56) existait mais restait à activer à la main). **(1) Parallèle par DÉFAUT** : `orchestrator.ts` — `ctx.config?.debateParallel !== false` (le débat enchaîné devient le choix explicite, interrupteur inversé dans `mode-picker.tsx` avec libellé « par défaut, rapide ») ; une conversation créée AVANT l'option — comme la conversation du débat de 61 min — passe en parallèle sans toucher à sa config. **(2) Plafond de longueur des voix** : la note de chaque voix impose désormais « 2000 caractères maximum, droit au but, sans préambule ni répétition » — dans les DEUX branches (parallèle et enchaîné) : les interventions sortaient à 4 300-9 200 caractères, c'est ce qui gonflait chaque tour (temps d'écriture × contexte des voix suivantes). Gain attendu sur SON débat de référence : ~61 min → ~20-25 min par le parallèle, ~10-15 min en comptant le plafond (estimation, jamais une promesse — le débit fournisseur reste maître). **QA** : tsc 0 erreur, eslint propre, `test-modes-flow.ts` **84/84** (volet service réel compris), preuve `preuve-debat-parallele.ts` recalée sur le DÉFAUT (conversations:create SANS le champ) : 3 voix démarrées à la même ms (2.554/2.555/2.555), chevauchement réseau OUI, 3 lignes « running » simultanées, verdict reçu — **PREUVE RÉUSSIE ✓**. |
| 2026-11-17 (58) | **Le plafond de longueur devient un réglage de la page Paramètres** (question de l'utilisatrice : « la consigne des 2000 caractères est inscrite où ? possible de la modifier en page paramètre ? » — elle était en dur dans les deux notes de `runDebate`). **Réglage CÔTÉ SERVICE** `hermes.modes.voiceChars` (table settings) — choisi plutôt qu'un champ par conversation : la valeur est relue À CHAQUE TOUR par `resolveVoiceChars` (modes.ts, bornée 500-8000, défaut 2000, valeur invalide = défaut, même grammaire que `readPromptOverrides`) — effet immédiat, même en plein débat, conversations existantes comprises, sans redémarrage. **Chaîne complète** : `modes-section.tsx` — carte Débat, nouveau Row « Longueur des interventions » (Stepper à pas 500 — prop `step` ajoutée au Stepper local, bornes ramenées au multiple ; tip explicite : le juge n'est pas borné, au-delà de 4000 les tours redeviennent longs) → `settings:get/set` → `orchestrator.ts` — `OrchestratorContext.voiceChars` fourni par index.ts (`resolveVoiceChars(store)` au montage du contexte) et interpolé dans les notes des deux branches ; **/diagnostics** expose `service.voiceChars` (le rapport montre la valeur réellement active). **QA** : tsc 0 erreur, eslint propre, `test-modes-flow.ts` **84/84** (service réel compris), preuve `preuve-debat-parallele.ts` étendue (preuve C) : `settings:set voiceChars=1200` accepté, les 3 voix partent à la même ms, ET le faux fournisseur lit « **1200 caractères maximum** » dans le corps de la requête — la chaîne Paramètres → settings → résolveur → orchestrateur → prompt fournisseur est prouvée de bout en bout. **PREUVE RÉUSSIE ✓** |
