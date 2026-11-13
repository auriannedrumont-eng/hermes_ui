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
| `mini-services/hermes-chat/asr.ts`, `uploads.ts` | Dictée vocale (ffmpeg), pièces jointes | Fork |
| `src/hooks/use-hermes-chat.ts` | Orchestrateur frontend (conversations, streaming, artefacts, panneau) | Fork (édition sensible) |
| `src/lib/chat-types.ts` | Types du protocole client/service (dont artefacts) | Fork (partagé) |
| `src/lib/tokens.ts` | Estimation de contexte du Composer v2 (heuristique car/jetons, fenêtre par modèle, seuils) | Fork |
| `src/components/chat/` | UI du chat, dont `composer.tsx` (Composer v2), `context-gauge.tsx` (jauge + popover de contexte), `artifact-card.tsx` (cartes inline), `artifact-panel.tsx` (split view) | Fork |
| `src/components/settings/` | Sheet Paramètres : `settings-sheet.tsx` (étage client — phase 1 livrée, porte moteur structure v3), `info-tip.tsx` (tooltips « ? ») | Fork |
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
| `hermes` | Réglages de l'agent amont | `hermes.gateway.url`, `hermes.gateway.token`, `hermes.model`, `hermes.models.favorites`, `hermes.reasoning.effort`, `hermes.permissions.mode` |
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

### Inventaire au 2026-11-13

- Client (`hermes-ui:`) : `hermes.model`, `hermes.models.favorites` (JSON d'ids),
  `hermes.reasoning.effort` (valeur brute du fournisseur, chantier « Composer v2 »),
  `hermes.permissions.mode` (ask | auto — reset sur `ask` à chaque session),
  `fork.ui.sidebar.width`, `fork.projects.sort`, `fork.projects.collapsed`,
  `fork.context.gauge` (affichage de la jauge de contexte).
- Serveur : table `settings` du mini-service (`settings:get/set`), dont les résumés de
  compaction `compact:<conversationId>` (chantier « Composer v2 ») ; `.env` →
  `HERMES_GATEWAY_URL`/`HERMES_GATEWAY_TOKEN` (namespace `hermes`),
  `DATABASE_URL` (infrastructure fork, reste en `.env`).

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
  à chaque session).
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

### 7.6 Plus tard

- **Browsing agent** (étape 6 de la vision artefacts) : chip de statut discrète près du champ
  de saisie (favicon + titre), résultats en citations cliquables repliables
  « Pages consultées (n) », jamais de panneau dédié. Branché sur dev-browser (connecteur
  importé, scène F — ses mises à jour s'y gèrent).

## 8. Dettes techniques et pièges

- `prisma/schema.prisma` et les scripts `db:*` de la racine sont **résiduels et inutilisés**
  par le chat — ne pas s'en servir, la persistance réelle est `bun:sqlite` (`store.ts`).
- `.env`, bases SQLite et fichiers uploadés sont **committés dans le repo** : pratique en
  solo, à revoir avant toute ouverture publique.
- Pas de tests frontend automatisés ; seuls des scripts de test manuels (`scripts/`).
- Pas de remote git configuré dans l'environnement de travail (voir §10).
- Pièges UI hérités de la vision artefacts : jamais d'artefact plein format dans le flux ;
  rendu asynchrone jamais bloquant (source d'abord, vignette ensuite) ; vignette PDF =
  première page seulement.

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
