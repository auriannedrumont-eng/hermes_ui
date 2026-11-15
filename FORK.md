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
| **Gateway** | `HERMES_GATEWAY_URL` défini et joignable | Tours envoyés à l'agent Hermes réel (protocole `api_turn_v1`) |
| **Démo** (défaut) | Aucune URL, ou gateway injoignable | Réponses du LLM intégré (`z-ai-web-dev-sdk`, serveur seul), persona Hermes |

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
- `.env` (racine) : `DATABASE_URL` (stockage local du fork) ; `HERMES_GATEWAY_URL` et
  `HERMES_GATEWAY_TOKEN` (optionnels, connexion à l'agent amont).
- Scripts de test manuels dans `scripts/` : `test-artifact-flow.ts`, `test-render-pipeline.ts`,
  `diag-service.ts`, `test-hermes-chat-service.ts`.

## 3. Carte du territoire

| Fichier / dossier | Rôle | Propriété |
| --- | --- | --- |
| `mini-services/hermes-chat/index.ts` | Serveur socket.io (3003), tours de chat, événements | Fork (édition sensible) |
| `mini-services/hermes-chat/hermes-connector.ts` | Protocole `api_turn_v1` vers la gateway Hermes | **Couplage amont** — ajuster ici si Nous Research fait évoluer le protocole |
| `mini-services/hermes-chat/models.ts` | Catalogue des modèles Hermes | Couplage amont (léger) |
| `mini-services/hermes-chat/demo-engine.ts` | LLM démo z-ai, persona Hermes | Fork |
| `mini-services/hermes-chat/store.ts` | Persistance `bun:sqlite` : conversations, messages, artefacts, fork de conversations, recherche | Fork (édition sensible) |
| `mini-services/hermes-chat/artifacts.ts` + `render.ts` | Pipeline artefacts + rendu chrome-headless-shell (PNG plein page, PDF vectoriel) | Fork |
| `mini-services/hermes-chat/shares.ts` | Partage public lecture seule (F-13) : snapshot figé, token opaque, vues | Fork |
| `mini-services/hermes-chat/asr.ts`, `uploads.ts` | Dictée vocale (ffmpeg), pièces jointes | Fork |
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
   observation (deltas, raisonnement, événements d'outils), repli automatique en mode démo ;
2. le protocole documenté dans `gateway/session_api_turn.py` du repo
   [hermes-agent](https://github.com/NousResearch/hermes-agent) ;
3. le catalogue `models.ts`.

**Tout le reste appartient au fork** : stockage, artefacts, projets, UI, PWA, exports,
notifications, ASR, uploads. Si l'amont évolue (renommage d'événements, nouvelle poignée de
main), seul le connecteur est à ajuster ; le mode démo permet de continuer à développer et
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

### 7.9 Fait — Feedback intégré (F-24)

Livré le 2026-11-13 (onzième session, point 4 de l'ordre recommandé). Un retour
👍/👎 + commentaire libre sur chaque réponse assistant — **local : jamais envoyé
au modèle** (le protocole gateway n'est pas modifié ; un chantier moteur futur
pourra l'exploiter côté agent).

- **Serveur** : migration additive `messages.feedback_rating` / `feedback_comment`
  (R2), transportées par `getMessages`/`getMessage` ; `setMessageFeedback`
  (assistant seule, commentaire tronqué à 2 000 caractères, `rating: null` =
  efface le retour complet) ; événement `feedback:set` + broadcast
  `feedback:changed`. Assumé : un fork repart sans retours (nouvelle branche =
  nouveaux retours, `appendMessage` ne transporte pas les colonnes feedback).
- **Client** : `FeedbackControl` dans `message-bubble.tsx` (rangée d'actions
  assistant : boutons 👍/👎 — re-clic sur le même = efface — popover commentaire
  avec « Effacer le retour », commentaire existant visible en italique) ;
  `onSetFeedback` câblé `message-list` → `page` ; action `setMessageFeedback`
  du hook (mise à jour optimiste, ack, retour arrière à l'état antérieur si
  refus) ; bus `feedback:changed` pour les autres clients.
- QA : `scripts/test-feedback-flow.ts` — **15/15 verts** : pose, inversion,
  commentaire (ajout/remplacement/troncature à 2 000), garde-fous (message
  utilisateur refusé, introuvable, commentaire sans vote), retrait complet,
  persistance au rechargement, isolation entre conversations.
  `bunx tsc --noEmit` : 0 erreur `src/` ; eslint sans nouvelle erreur (une
  préexistante dans `message-bubble.tsx`, antérieure au chantier).

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
