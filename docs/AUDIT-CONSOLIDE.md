# AUDIT hermes_ui — consolidation multi-auditeurs (2026-11-17)

Quatre sources indépendantes, chaque constat recoupé contre le code au commit **`4eab0cf`** :
1. **Audit initial** (lecture directe du code, ~44 000 lignes) — sécurité, robustesse backend, flux frontend, UI/UX.
2. **Relecture Argon tour 1** (Gemini 4, AI Studio) — critique de l'audit et de la feuille de route.
3. **Relecture Argon tour 2** — analyse du delta des 5 derniers commits (mode Débat parallèle).
4. **Audit Argon complet sur ZIP** — fichier par fichier, 24 constats (C-01→U-05).

Verdict de cohérence : les 4 sources convergent sur les mêmes zones (auth/CORS, llm-pool, orchestrator, registre des réglages, SQLite). **3 constats d'Argon-ZIP sont invalidés par vérification au code** (voir §Invalidés) ; les autres sont retenus, avec les corrections de détail que la vérification a apportées.

---

## LOT 1 — Critique : crashs, pertes de données, sécurité (faire d'abord)

### L1-1. CORS `*` + pas de jeton = service ouvert à toute page web [ÉLEVÉ — confirmé par 3 audits]
- `mini-services/hermes-chat/index.ts:795` : `cors: { origin: "*" }` quand `HERMES_SERVICE_TOKEN` absent.
- `desktop/hermes-ui.ps1` : ne définit jamais le jeton (0 occurrence).
- Scénario : toute page web ouverte dans le navigateur de l'utilisateur se connecte au service local, lit les conversations, déclenche des tours sur ses clés, pilote le navigateur webchat.
- Correctif : (a) restreindre `origin` aux origines loopback quand pas de jeton + vérifier l'en-tête `Origin` dans `io.use` et sur le port 3004 ; (b) le lanceur `desktop/hermes-ui.ps1` génère/persiste un jeton dans `desktop/runtime/`.
- Recoupement Argon t1 : le correctif « Caddy loopback seul » est INCOMPLET — le service 3003/3004 écoute aussi toutes les interfaces (`index.ts:3652`). Caddyfile `:81` + `?XTransformPort=` reste à figer en `reverse_proxy 127.0.0.1:3003` en dur.

### L1-2. `resolve` non importé dans `webchat/engine.ts` [CRITIQUE crash — vérifié exact]
- `webchat/engine.ts:8` : `import { join } from "node:path"` — seul `join`.
- `webchat/engine.ts:313` : `if (!safe || resolve(safe) !== resolve(path) ...)` → `ReferenceError` dès qu'un site piloté produit des fichiers.
- Correctif : `import { join, resolve } from "node:path";` — 1 ligne.

### L1-3. `hermes.modes.models` absent du registre → réglage jamais persisté [ÉLEVÉ — vérifié exact]
- Lu en `mode-picker.tsx:163` via `readClientSetting` ; **0 occurrence** dans `HERMES_SETTINGS` (`src/lib/settings.ts`).
- `writeClientSetting` ignore silencieusement les clés hors `REGISTRY` (`settings.ts:373-374`) → choisir un modèle par mode (Chat/Plan/Code) n'a aucun effet.
- Correctif : déclarer la clé (`type: "string"`, `default: "{}"`, `scope: "client"`).

### L1-4. Fuite `activeStreamEntries` + timer 120 s sur erreur HTTP [ÉLEVÉ — confirmé par 3 audits, cause racine précisée]
- `llm-pool.ts:544-575` (OpenAI) et `:660-690` (Anthropic) : le `catch` du `fetch` appelle bien `guard.done()`, mais le bloc `if (!res.ok) throw new PoolAuthError(...)` (lignes 565+, 679+) est APRÈS le `guard.reset()` et HORS du try — l'entrée reste à vie dans `activeStreamEntries`, le timer fuit, `/diagnostics` montre des flux fantômes éternels.
- À noter : le `guard.reset()` manquant signalé par Argon en `streamAnthropicTurn` n'existe PAS tel quel — les deux flux ont `guard.reset()` après fetch (lignes 558, 674). La fuite vient uniquement du `!res.ok` hors try.
- Correctif : englober `!res.ok`/`!res.body` dans le `try { ... } finally { guard.done(); }`.
- Recoupement Argon t2 : en mode Débat parallèle ×3 voix, un seul 401/429 crée 3 fantômes d'un coup — corriger AVANT de compter sur le parallèle par défaut.

### L1-5. Race `conversations:open` : fil d'une autre conversation affiché [ÉLEVÉ — confirmé, correctif élargi sur insistance d'Argon t1]
- `src/hooks/use-hermes-chat.ts:1020-1034` : l'ack compare à la closure (`id`), pas à `activeIdRef.current`. Navigation A→B→C rapide = fil de B sous C.
- Correctif COMPLET (pas « 1 ligne ») : `if (id !== activeIdRef.current) return;` en tête de callback — ce qui englobe du même coup `setLoadingHistory(false)` (sinon le spinner de C coupe prématurément). Et filtrer aussi les `stream:*` par conversation (rooms socket.io ou garde `activeIdRef` sur chaque handler), sinon les deltas de A écrasent l'état de B.

### L1-6. Stop inopérant en mode gateway + orchestrateurs qui continuent [ÉLEVÉ — fusion de 2 audits]
- `hermes-connector.ts:299-437` : aucun `signal.addEventListener("abort")` ; le tour court jusqu'au timeout 180 s ; `ws.on("close")` → `finish()` résout en « succès » avec contenu tronqué.
- `orchestrator.ts` : le Verdict du juge (après la boucle `runDebate`) et le Président (`runCouncil`) partent même si `ctx.signal.aborted` (vérifié : aucun garde avant l'appel verdict) ; `runAuto` ne vérifie l'abort qu'à la ligne 586 (boucle de reprises).
- Correctif : garde `if (ctx.signal.aborted)` avant Verdict/Président/chaque étape Auto + câbler l'abort à la fermeture de la WebSocket gateway.

---

## LOT 2 — Intégrité des données (SQLite, artefacts, fichiers)

### L2-1. Artefacts orphelins après suppression/édition de message [MOYEN — retenu, non re-vérifié ligne à ligne]
- `store.ts` (`deleteMessage`, `editUserMessageAndTruncate`, `deleteTrailingAssistant`) : les lignes `artifacts` et les fichiers `db/artifacts/<id>.{png,pdf}` ne sont jamais supprimés → PNG/PDF s'accumulent ; une v2 supprimée reste ancrée sur la carte de la v1.
- Correctif : purge `artifacts` par `message_id` supprimé + `deleteArtifactFiles`.

### L2-2. Fork de conversation : artefacts du futur copiés + vignettes perdues [MOYEN — retenu]
- `store.ts` (`copyArtifactsToFork`) : copie TOUTES les lignes même pour un fork depuis un message intermédiaire ; les `.png/.pdf` ne suivent pas le nouvel `id`.
- Correctif : filtrer sur `messageIdMap.has(r.message_id)` + copier les fichiers dérivés.

### L2-3. Échappement `LIKE` cassé dans `searchMessages` [MOYEN — vérifié exact]
- `store.ts:1564` : `q.replace(/[%,_]/g, (c) => `\${c}`)` — dans ce template le `\$` produit le littéral `${c}` ; la virgule est dans la regex par erreur ; `\` non échappé malgré `ESCAPE '\'` (ligne 1569).
- Scénario : rechercher `100%`, `a_b` ou une virgule renvoie des résultats faux ou casse la requête.
- Correctif : `q.replace(/[%_\\]/g, (c) => "\\" + c)`.

### L2-4. Suppression de conversation pendant un tour [MOYEN — confirmé audit initial]
- `index.ts:1327-1344` : seul handler de mutation sans garde `isRunning` → données orphelines recréées par le catch tardif.

### L2-5. Transactions absentes sur les écritures multi-étapes [MOYEN — confirmé 2 audits]
- `store.ts` : `setMessageVersion`, `reorderProjects`, `createShare`, `forkConversation` → encapsuler dans `this.db.transaction(...)`.

### L2-6. `JSON.parse` non protégé sur colonnes persistées [MOYEN — confirmé audit initial]
- `store.ts:1242-1258` (`tool_events`, `attachments`, `sources`) : une ligne malformée rend la conversation impossible à ouvrir.

### L2-7. Watchdog webchat multiplié + fichier tmp statique [FAIBLE-MOYEN — vérifiés exacts]
- `webchat/browser.ts:197` : `launchWatchdog` spawne un veilleur détaché par appel sans vérifier un PID existant (vies jusqu'à 2 h).
- `webchat/engine.ts:249` : prompt écrit dans `webchat-prompt.tmp` fixe, jamais supprimé.
- Correctifs : PID-file + `pidAlive` ; nom unique + suppression en `finally`.

### L2-8. WebSocket CDP sans listener `error` après connexion [MOYEN — vérifié]
- `render.ts:258`, `webchat/cdp.ts:96` : `ws.once("error")` uniquement pendant le handshake ; un crash de Chrome après ouverture peut tuer le processus ; les `pending` attendent 20 s au lieu d'être rejetés.
- Correctif : `this.ws.on("error", ...)` + rejet des `pending` au `close`.

### L2-9. `spawnSync` dans le chemin extensions/zip [MOYEN — confirmé 3 audits]
- `providers.ts:935` (`git ls-remote`, timeout 12 s) + `index.ts:634,641` (zip/tar) : event loop gelé jusqu'à 12 s par appel, ×3 en débat parallèle.
- Correctif (Argon t2, retenu) : async + cache TTL du snapshot + `["ls-remote", "--", url]` en durcissement (l'URL est construite depuis `ref.owner/ref.repo` internes — pas d'injection démontrée aujourd'hui, mais le séparateur est gratuit).

---

## LOT 3 — Bugs d'état frontend

### L3-1. `ModePicker` écrase `debateParallel` et `model` [MOYEN — vérifié exact]
- `mode-picker.tsx:186-228` : le `useMemo` de `current` retourne rounds/members/retries/autoDebate/voices mais PAS `debateParallel` ni `model`. Le toggle affiche donc toujours « parallèle ON », et tout `patch()`/`setVoiceModel()` efface ces deux clés de la config.
- Correctif : inclure les deux champs dans le `useMemo`.

### L3-2. Brouillons `HermesSection`/`MemoryCard` figés à vide [MOYEN — retenu avec nuance]
- `hermes-section.tsx:228-234` : `if (draft === null) setDraft(customInstructions ?? "")` — si l'effet court avant la réponse socket, `draft` passe de `null` à `""` et ne suit plus jamais la valeur serveur. Le risque d'écrasement involontaire à la sauvegarde est réel.
- Correctif : ne matérialiser `draft` QUE sur `onChange` (lazy), pas par effet ; remettre `null` après sauvegarde. Même pattern à `memory-card.tsx`.

### L3-3. `SystemPromptPanel` : prompt de la conversation précédente [MOYEN — retenu]
- Le `openedAtRef` n'est pas remis à 0 à la fermeture → la `key` ne change qu'une fois par vie de l'app ; ouvrir A, fermer, ouvrir B = on édite le prompt de A.
- Correctif : reset à la fermeture + `key` incluant `prompt?.conversationId`/`updatedAt` ; `setPrompt(null)` quand `!activeConversationId`.

### L3-4. Versionnage F-14 perdu en régénération Comparer [MOYEN — retenu, non re-vérifié]
- `index.ts:1285-1293` + `chat:regenerate` : les groupes `groups.a`/`groups.b` ne sont pas transmis au split → le sélecteur `‹ 1/2 ›` n'apparaît jamais.

### L3-5. Flux streams frontend (audit initial, toujours valables)
- `onStreamError` vide TOUS les streams (`return {}`, use-hermes-chat.ts:654-660) ; `stream:done` sans dédoublonnage (:613-615) ; déconnexion brève = erreur « définitive » fausse (:487-505) ; `chat:stop` sans ack (:1213) ; double `conversations:create` (:1134) ; `ChatPromptInfo` dupliquée (:56-68).

---

## LOT 4 — Socle de vérification (CI) — à faire AVANT les lots 2-3 d'après Argon t1+t2

- Aucun `.github/workflows`, aucun runner, Playwright importé par les scripts QA mais non déclaré, `tests/*.sh` pointent vers `.zscripts` absent.
- À poser : runner (`test`/`test:unit`/`qa:dom`), déclaration des dépendances des scripts, CI minimale (typecheck + lint), puis tests de régression sur : race `conversations:open`, arrêt orchestrateurs, débat parallèle avec 1 voix en échec (le cas exact que L1-4 aggrave).
- Position dans l'ordre : après le Lot 1 (sécurité chirurgicale à faible risque de régression), avant les refactorings des Lots 2-3. (Argument d'Argon t1 : ne pas refactorer un hook de 1 777 lignes sans filet.)

---

## LOT 5 — UI, accessibilité, design system

- Échap global arrête une génération même sous dialog Radix (`page.tsx:275-312`).
- Réordonnancement projets inaccessible clavier (seul `PointerSensor`, `sidebar.tsx:556`).
- Rôles ARIA mensongers : listbox sans navigation (`mode-picker`), tablist sans panneaux (`artifact-panel`), radiogroup sans roving tabindex (`providers-section`) — le modèle correct existe : `shared/segmented.tsx`.
- Composer 15 px → zoom iOS (`composer.tsx:549`).
- Menu slash injecte un espace à la fermeture (`composer.tsx:523`).
- `savePricing` sans ack ni toast (`settings-panel.tsx:355`).
- `InfoTip` sans `aria-describedby`, labels identiques partout.
- Échelle typo : composants F-28→F-31 hors des 7 crans de `globals.css` (`text-[8.5px]`…`text-[13.5px]`), couleurs hors tokens (`bg-emerald-500`).
- Icône dupliquée `Layers` (Modes de chat / Fournisseurs) ; référence maquette v4 périmée dans `settings-panel.tsx:2`.
- `sourceCache` met en cache les erreurs à vie (`artifact-panel.tsx`) + sans borne.
- Réglage mort `hermes.compare.models` (settings.ts:170-177).

---

## LOT 6 — Hygiène, docs, performance

- ~25 dépendances jamais importées dans `src/` (`zustand`, `next-auth`, `recharts`, `next-intl`, `z-ai-web-dev-sdk`, @radix-ui/* orphelins…) — vérifié : 0 import dans `src/`.
- Chemins `/home/z/my-project` codés en dur dans ~10 scripts de test.
- Docs désalignées : README (mode Démo « par défaut », sheet 460 px), FORK.md (DATABASE_URL, prisma, z-ai-web-dev-sdk retirés).
- `.env.example` absent (ajout Argon-URL) ; pas de licence ni description GitHub.
- Recherche : index B-tree inutilisable pour `LIKE '%q%'` (scan complet) — FTS5 après le fix L2-3 ; `listConversations` O(n·m) ; N+1 dans `attachArtifactCards` ; `readFileSync` sur chemins HTTP.
- Lanceur Windows : `install-helper.ps1` cible `desktop\Hermes-Web.bat` inexistant (le `.bat` est à la racine) ; risque de kill de la pile au double-clic après `Update-FromGit` (LastWriteTime du script vs CreationDate du processus).
- Découpage progressif d'`index.ts` (3 714 lignes) et `store.ts` (1 843) — dernière priorité.

---

## INVALIDÉS (constats d'Argon-ZIP contredits par le code)

- **« `guard.reset()` oublié dans `streamAnthropicTurn` »** — faux : présent ligne 674, comme côté OpenAI (558). La fuite vient du `!res.ok` hors try (couvert par L1-4).
- **« `setTimeout` de 120 s armé par stallGuard »** — approximatif : le timer est un garde d'inactivité réarmé par `reset()`, pas un timer brut qui fuit par nature ; seule l'entrée orpheline (L1-4) fait persister le diagnostic.
- **C-03 partiellement** — le pattern est bien présent mais le commentaire du code (« suit la valeur du service ») montre une intention de lazy-follow ; le bug est le `setDraft` dans l'effet, retenu en L3-2 avec le correctif « matérialiser sur onChange uniquement ».

## Ordre recommandé

Lot 1 → Lot 4 (CI) → Lot 2 → Lot 3 → Lot 5 → Lot 6.
Rythme de développement (arbitrage du tour 2, adapté à un usage local mono-utilisateur) : **alternance** 1 correctif / 1 fonctionnalité plutôt que gel total — mais le Lot 1 passe avant toute nouvelle fonctionnalité.
