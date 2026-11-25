# DEMARRAGE.md — Doc d'entrée pour toute session (humaine ou LLM)

> **Lisez ce fichier en premier.** Il remplace la lecture intégrale de `FORK.md`
> en ouverture de session. Le `FORK.md` complet reste la référence (conventions
> détaillées §5, registre des réglages §6, journal des décisions §9) : ne l'ouvrez
> que si la tâche l'exige. État du projet : `docs/ETAT.md`. Détail des artefacts et
> du protocole gateway : `mini-services/hermes-chat/README.md`.

## Ce qu'est ce repo

Interface web de chat pour l'agent **Hermes** (Nous Research) — **fork** maintenu par
`auriannedrumont-eng` : artefacts versionnés, projets, paramètres, modes multi-voix,
sans casser la compatibilité amont. Principe directeur : **la conversation reste le
chef d'orchestre** (un artefact s'ouvre dans le chat, jamais l'inverse).

Deux modes, basculés automatiquement : **Gateway** (URL joignable → tours envoyés à
l'agent Hermes réel, protocole canonique `hermes-gateway-v1`) ou **Local** (pool de clés fournisseurs ;
sans moteur ni clé, erreur claire — le mode Démo simulé a été retiré).

## Démarrage

```bash
bun install && bun dev                    # Frontend Next.js — port 3000
cd mini-services/hermes-chat && bun install && bun run dev   # Service socket.io — port 3003
```

Rendu des artefacts HTML : pipeline `chrome-headless-shell` (voir README du
mini-service). `HERMES_SERVICE_TOKEN` : écrit par les lanceurs dans
`desktop/runtime/service-token.env` et exporté vers le service (pas de
`.env` racine — en lancement manuel, exportez la variable vous-même).
`HERMES_GATEWAY_URL` / `HERMES_GATEWAY_TOKEN` : optionnels, dans
l'environnement.

## Carte du territoire (fichiers clés)

| Zone | Fichiers | Rôle |
| --- | --- | --- |
| **Service** `mini-services/hermes-chat/` | `index.ts` (serveur socket.io 3003, ~2900 l.), `store*.ts` (SQLite `bun:sqlite` : conversations, messages, artefacts, projets, parts), `hermes-connector.ts` (protocole gateway — seul couplage amont), `llm-pool.ts` + `providers.ts` (clés, pool, extensions GitHub), `orchestrator.ts` + `modes.ts` (débat/conseil/auto/comparer), `prompts.ts` (prompt système, mémoire, mode expert), `render.ts` (rendu Chrome), `http-server.ts` (port 3004 : parts publiques, vues artefacts) | Le **service fait foi** : résolution des modes, bornes, sanitisation |
| **Frontend** `src/` | `hooks/use-hermes-chat.ts` (orchestrateur frontend, ~1500 l.), `app/page.tsx`, `components/chat/` (composer, bulles, panneau artefacts), `components/settings/` (volet 860 px à rail, 10 sections), `lib/settings.ts` (**registre** des réglages), `lib/modes.ts` (miroir d'affichage) | UI Next.js 16 + Tailwind + shadcn |
| `design/` | Maquettes HTML validées avant implémentation — `maquette-parametres-v5.html` **fait foi** pour les Paramètres | Rendu lourd : ne pas donner à lire à un LLM |
| `scripts/` | ~90 scripts de test/QA manuels (`test-*-flow.ts`) | À ne lire que si la tâche le demande |
| `desktop/` | Lanceur Windows (`hermes-ui.ps1`) | Hors périmètre sauf demande |
| **`llm-review/`** | Bundles de code prêts à envoyer à un LLM pour review (`bundle_chat.txt`, `bundle_settings.txt`, `bundle_full.txt`, `review_prompt.md`) | **Mis à jour à chaque push sur `main`** : l'agent LLM régénère le bundle pour refléter le `src/` du dernier commit |

## Conventions (résumé de FORK.md §5 — la version longue y fait foi)

- **R1** : nouvelles fonctionnalités = nouveaux fichiers ; éditions minimales sur l'existant.
- **R2** : migrations SQLite **additives uniquement** (jamais de `DROP`, jamais de renommage).
- **R3** : événements socket préfixés (`conversations:*`, `artifacts:*`…) ; clés `<ns>.<clef>` ; `localStorage` préfixé `hermes-ui:`.
- **R4** : fichiers sensibles (éditions minimales) : `index.ts`, `store.ts`, `hermes-connector.ts`, `page.tsx`, `use-hermes-chat.ts`, `message-bubble.tsx`, `sidebar.tsx`.
- **R5** : toute fonctionnalité déclare ses réglages dans le registre `src/lib/settings.ts` dès sa création. Deux namespaces : `hermes.*` (amont) / `fork.*` (fork).
- **R6** : toute décision structurante est consignée dans FORK.md §9, datée.
- **R7** : français pour les échanges, la doc et l'UI ; identifiants de code en anglais.
- **R8** : vérifier `package.json` avant d'ajouter une dépendance (`@dnd-kit`, `react-resizable-panels` déjà là).

## Règles de contexte (agents LLM)

1. **Ne jamais tout lire.** Ouvrir uniquement les fichiers de la tâche, après `grep`/recherche. Les dossiers `scripts/`, `design/`, `desktop/`, `bun.lock`, `db/` sortent du contexte par défaut.
2. **Journal §9 de FORK.md** : lire seulement les entrées récentes (les 10 dernières) sauf besoin précis.
3. **Une session fraîche par lot de travail** ; compacter/résumer entre deux lots plutôt qu'empiler.
4. Ne pas recoller de sortie de terminal ou de log complet dans le chat — extrait + chemin de fichier.

## Passation (FORK.md §10, résumé)

Repo GitHub privé `auriannedrumont-eng/hermes_ui`. Branche `main` = historique de
travail ; branche `publish` = commits propres (un par chantier), c'est elle qu'on
pousse (`git push origin publish:main`, fast-forward). Push depuis le bac à sable =
PAT fine-grained fourni au moment du push, ou bundle. Aucune donnée locale (bases,
uploads, livrables) n'est versionnée (`.gitignore`).
