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
| `src/components/chat/` | UI du chat, dont `artifact-card.tsx` (cartes inline) et `artifact-panel.tsx` (split view) | Fork |
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
| `hermes` | Réglages de l'agent amont | `hermes.gateway.url`, `hermes.gateway.token`, `hermes.model` |
| `fork` | Tout ce que le fork ajoute | `fork.ui.sidebar.width`, `fork.artifacts.panel.autoOpen`, `fork.projects.sort` |

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

### Inventaire au 2026-11-12

- Client : **aucun réglage persisté** (terrain vierge — tout nouveau réglage passe par le registre).
- Serveur : `.env` → `HERMES_GATEWAY_URL`/`HERMES_GATEWAY_TOKEN` (namespace `hermes`),
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

### 7.2 Prochain chantier — UI projets (rangements des conversations par projet)

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

### 7.3 Plus tard

- **Browsing agent** (étape 6 de la vision artefacts) : chip de statut discrète près du champ
  de saisie (favicon + titre), résultats en citations cliquables repliables
  « Pages consultées (n) », jamais de panneau dédié. Branché sur le daemon dev-browser.
- **Page de paramètres** : rendu des deux registres (§6), sections « Agent Hermes » /
  « Cette interface ».

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

## 10. Synchronisation git et passation

- Repo GitHub de référence : `https://github.com/auriannedrumont-eng/hermes_ui`.
- Remote `origin` configuré dans l'environnement de travail, **sans credentials** :
  un push depuis le bac à sable nécessite un PAT fine-grained GitHub (droits
  *Contents : Read & write* sur le seul repo `hermes_ui`, expiration courte), fourni
  au moment du push, ou passe par le bundle (`download/push/`).
- Deux branches locales :
  - `main` : historique de travail complet (commits de session, messages techniques) ;
  - `publish` : **commit unique propre**, signé `auriannedrumont-eng
    <355807939+auriannedrumont-eng@users.noreply.github.com>`, arbre identique à `main`
    sans les données locales — c'est celle qu'on pousse vers GitHub
    (`git push origin publish:main`, en `--force` tant que le point de départ distant
    est l'ancien commit d'import sans ancêtre commun).
- Le repo GitHub ne contient volontairement **aucune donnée locale** : bases SQLite
  (`db/`), uploads de conversation, artefacts dérivés, dumps d'outils
  (`tool-results/`), livrables (`download/`), matériaux de session (`upload/`) et
  outillage du bac à sable (`.zscripts/`) sont ignorés par `.gitignore`.
  Audit sécurité de tout l'historique effectué le 2026-11-12 : aucun token ni secret.
- Recette de republication après une session de travail :
  1) committer sur `main` ;
  2) recréer `publish` : `git checkout --orphan publish && git add -A &&
     git commit -m "<résumé>" && git checkout main` ;
  3) pousser : `git push origin publish:main`.
- Les livrables par archive restent possibles (`scripts/package-livrables.sh`).
- **Téléversement manuel (sans git)** : `download/push/hermes_ui-a-televerser.zip`
  contient les fichiers seuls de `publish` (sans historique). Convient à un upload
  via l'interface web GitHub (limite : 100 fichiers par glisser-déposer — uploader
  dossier par dossier, `src/` = 79 fichiers passe seul). Le repo obtenu n'a alors
  qu'un commit d'upload, sans message descriptif ni auteur configuré.
- **Checklist de passation à un nouveau LLM** : 1) lire ce `FORK.md` en entier ;
  2) lire `mini-services/hermes-chat/README.md` ; 3) `git log` + `git status` pour voir
  l'état réel ; 4) vérifier ce qui reste à faire (§7) ; 5) respecter les conventions (§5) ;
  6) consigner toute nouvelle décision au §9.
