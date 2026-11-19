# FEUILLE DE ROUTE hermes_ui — chantiers par lot (2026-11-17)

Base : `docs/AUDIT-CONSOLIDE.md` (4 audits croisés, constats vérifiés au commit `4eab0cf`).
Chaque lot = objectif, tâches chiffrées, jalon de validation. Aucun lot ne touche au code sans son jalon.
Synthèse vivante : `docs/ETAT.md` (une page). Doc d'entrée : `DEMARRAGE.md`.

Ordre : **1 → 4 → 2 → 3 → 5 → 6** (sécurité d'abord, CI avant les refactorings, hygiène en dernier).

---

## LOT 1 — Critique : crash, sécurité, perte de réglages  (~1-2 j)

Objectif : plus aucun crash d'usage courant, service local non exposé, Stop honnête.

| # | Tâche | Fichier | Effort |
|---|------|---------|--------|
| 1.1 | Importer `resolve` (crash webchat fichiers) | `webchat/engine.ts:8` | 1 ligne |
| 1.2 | Déclarer `hermes.modes.models` au registre | `src/lib/settings.ts` | 5 lignes |
| 1.3 | CORS loopback sans jeton + `Origin` check + jeton généré par le lanceur | `index.ts:795,829`, `desktop/hermes-ui.ps1` | 0,5 j |
| 1.4 | Caddy : `reverse_proxy 127.0.0.1:3003` en dur, supprimer `XTransformPort` | `Caddyfile:7` | 1 ligne (+ `desktop/hermes-ui.sh` sed à ajuster) |
| 1.5 | `guard.done()` sur `!res.ok` (fuite streams fantômes) | `llm-pool.ts:544-575,660-690` | 10 lignes |
| 1.6 | Garde abort avant Verdict/Président/étapes Auto + abort câblé gateway | `orchestrator.ts`, `hermes-connector.ts` | 0,5 j |
| 1.7 | Garde `activeIdRef` sur ack `conversations:open` + filtrage `stream:*` par conversation | `use-hermes-chat.ts:1020`, handlers stream | 0,5 j |

Jalon : un site piloté qui rend des fichiers ne fait plus planter le tour ; sans jeton, une page web tierce ne se connecte plus ; Stop arrête un débat en <1 s ; navigation A→B→C rapide n'affiche jamais le fil de B ; `/diagnostics` ne montre plus de flux « en vol » éternels après un 401.

---

## LOT 4 (juste après le 1) — Socle de vérification  (~1 j)

Objectif : ne plus corriger deux fois la même chose.

- 4.1 Scripts npm `test`/`qa:dom` + déclaration Playwright + runner qui enchaîne les `scripts/test-*.ts`.
- 4.2 CI GitHub Actions minimale : typecheck + lint (+ tests unitaires hors service).
- 4.3 Réparer/retirer `tests/*.sh` (`.zscripts` absent).
- 4.4 Tests de régression des correctifs du Lot 1 : race open, abort orchestrateur, fantômes pool, clé registre.
- 4.5 Test du débat parallèle avec 1 voix en échec sur 3 (cas exact que 1.5 aggrave).

Jalon : la CI tourne sur push et échoue si un bug du Lot 1 réapparaît.

---

## LOT 2 — Intégrité SQLite & fichiers  (~2-3 j)

- 2.1 Purge artefacts (lignes + PNG/PDF) à la suppression/édition de message.
- 2.2 Fork : filtrer les artefacts hors branche + copier `.png/.pdf` vers le nouvel id.
- 2.3 Fix échappement `LIKE` (`store.ts:1564`).
- 2.4 Garde `isRunning` sur `conversations:delete`.
- 2.5 Transactions sur `setMessageVersion`/`reorderProjects`/`createShare`/`forkConversation`.
- 2.6 `JSON.parse` protégé sur colonnes persistées.
- 2.7 Watchdog PID-file + tmp unique nettoyé (`webchat/browser.ts:197`, `engine.ts:249`).
- 2.8 Listeners `error`/`close` WebSocket CDP + rejet des `pending`.
- 2.9 `spawnSync` → async + cache TTL + `--` séparateur git.

Jalon : suppression/édition/fork ne laissent plus rien d'orphelin (vérifié par test) ; un crash fournisseur ne laisse aucune trace dans `/diagnostics` après 1 min ; aucune commande synchrone dans le chemin des extensions.

---

## LOT 3 — Bugs d'état frontend  (~2 j)

- 3.1 `ModePicker` : inclure `debateParallel` + `model` dans le `useMemo`.
- 3.2 Brouillons `HermesSection`/`MemoryCard` : matérialiser sur `onChange` uniquement.
- 3.3 `SystemPromptPanel` : reset `openedAtRef` + key par conversation.
- 3.4 Versionnage Comparer : transmettre `groups.a/b` au split.
- 3.5 Flux streams : `onStreamError` ne vide pas tout, `stream:done` dédoublonne, erreur reconnect non « définitive », `chat:stop` avec ack, dédup `conversations:create`, `ChatPromptInfo` unique.

Jalon : test de navigation rapide + reconnexion + régénération Comparer passent sans état incohérent.

---

## LOT 5 — UI, accessibilité, design system  (~2 j)

- 5.1 Échap ignoré quand un overlay Radix est ouvert.
- 5.2 `KeyboardSensor` dnd-kit sur la sidebar.
- 5.3 ARIA : reprendre le modèle `shared/segmented.tsx` (mode-picker, artifact-panel, providers-section) ou retirer les rôles.
- 5.4 Composer 16 px mobile (anti-zoom iOS).
- 5.5 Menu slash : plus d'espace injecté.
- 5.6 `savePricing` : ack + toast.
- 5.7 `InfoTip` : `aria-describedby` + labels distincts.
- 5.8 Échelle typo/couleurs alignée sur `globals.css` (composants F-28→F-31).
- 5.9 `sourceCache` : pas de cache d'erreur + borne.
- 5.10 Icône dupliquée `Layers` + référence maquette à jour + retrait `hermes.compare.models`.

Jalon : audit axe-core du volet Paramètres et du fil sans erreur bloquante ; navigation clavier complète de la sidebar.

---

## LOT 6 — Hygiène, docs, performance  (~1-2 j, par petits paquets)

- 6.1 Retrait des ~25 dépendances mortes (`npm ls` + build de contrôle après chaque paquet).
- 6.2 Chemins `/home/z/my-project` → résolus relativement (`import.meta.dir`).
- 6.3 README/FORK.md alignés sur l'état réel ; `.env.example` ; licence + description GitHub.
- 6.4 Perf : FTS5 pour la recherche (après 2.3), `listConversations`, N+1 `attachArtifactCards`, `readFileSync` HTTP.
- 6.5 Lanceur Windows : cibles `install-helper.ps1` + garde anti-kill après `Update-FromGit`.
- 6.6 Découpage progressif d'`index.ts`/`store.ts` (dernier, sans urgence).

Jalon : installation fraîche documentée qui marche du premier coup ; `node_modules` réduit ; recherche instantanée sur un historique de 1 000 messages.

---

## Rythme recommandé

Usage local mono-utilisateur : **alternance** — un lot de correctifs, puis une fonctionnalité, etc. Le Lot 1 passe avant toute nouvelle fonctionnalité ; le Lot 4 avant tout refactoring (Lots 2-3).
