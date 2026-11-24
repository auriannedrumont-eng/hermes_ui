# Audit CRAP 2026-11 — crapper (unclebob) sur hermes_ui

Chantier mené le 2026-11-25 en trois phases, puis refactoring en trois vagues.
Formule : `CRAP = CC² × (1 − couverture)³ + CC`. Seuils Uncle Bob : ≤ 5 risque
faible · 5-30 à surveiller · > 30 complexe et sous-testé.

Contrainte centrale : la suite autonome du repo tourne sous **bun (JavaScriptCore)**,
invisible pour c8 (V8) — vérifié empiriquement (`NODE_V8_COVERAGE` ne produit rien
sous bun). La couverture TypeScript était donc non mesurable (0 %) ; les tests
Vitest ajoutés au mini-service en sont la **première couverture mesurable**.

## Contenu

| Fichier | Rôle |
| --- | --- |
| `audit-cc30.txt` | Phase 1 — audit des 44 fonctions de production CC ≥ 30 (1052 fonctions analysées), familles A-E. |
| `couverture-reelle.txt` | Phase 2 + vagues 1 à 4 — rapport de couverture réelle (Vitest 5.1 + @vitest/coverage-v8) et journal des vagues de refactoring, cibles suivantes incluses. |
| `suite-tests.log` | Preuves de validation brutes : tsc ×3, eslint, suite autonome 33/33, gardes de source, Vitest 144/144 (vague 4), contre-vérification de l'anomalie D-02 sous bun:sqlite natif. |
| `refactoring.patch` | Vagues 1+2+3+4 — patch unifié `git diff HEAD` (nouveaux fichiers inclus via `git add -N`). Vérifié `git apply --check` sur HEAD propre. |
| `table-crap.txt` | Snapshot crapper complet après vague 4 (fonction, namespace, CC, couverture, CRAP). |
| `rapport-crap-complet.txt` | Sortie brute de `crapper --use-existing-coverage` après vague 4. |
| `crap.edn` | Métriques au format EDN pour uml-viewer. |
| `hotspots.json` | Les 56 fonctions de production CC ≥ 30 après vague 4, avec spans et décompte des décisions (if/ternaire/&&/…). |
| `digest-hotspots.txt` | Digest de lecture des hotspots : en-tête de fichier, signature, corps (le Top 15 = entrées 1-15). |
| `lcov-mini-service.info` | LCOV Vitest du mini-service (store-messages 81,8-100 %, providers-validate 100 %, parseRepoInput 100 %, models 100 %, modes 98 %, prompts 97 %, fiches 95 %, parseModelOptions 100 %). |

## Refactoring — bilan des quatre vagues (corps VERBATIM)

| Fonction initiale | CC avant | CC après | Unités extraites |
| --- | --- | --- | --- |
| useHermesChat | 287 | 86 | use-chat-socket-events (81), use-conversations (42), use-turn-actions (70), use-attachments-wiring (12) — vagues 3+4 |
| registerConversationsHandlers | 261 | 1 | 5 sous-registres (13-77) |
| registerProvidersExtensionsHandlers | 239 | 1 | 4 sous-registres (6-114) |
| createLlmPool | 218 | 69 | llm-streams.ts : streamAnthropicTurn 57, streamOpenAiTurn 47, buildUserPayload 10, stallGuardFor 4, readErrorBody 11 ; createPoolCatalog 35 |
| buildMessages | 186 | 1 | 5 builders domaine (18-73), fusion par spread |
| registerSettingsSystemHandlers | 157 | 1 | 7 sous-registres thématiques (8-50) |
| runAssistantTurn | 147 | 84 | 7 étapes module-level (3-24) — vague 4 |
| registerProvidersHandlers | 114 | 96 | validations d'URL/clés → providers-validate.ts (8 helpers purs testés) — vague 4 |
| registerArtifactsSharesHandlers | 59 | 1 | 3 sous-registres (14-28) — vague 4 |
| registerExtensionsHandlers | 95 | 94 | validations → providers-validate.ts — vague 4 |
| buildMessageVersionsMethods | 73 | 73 | COUVERTURE réelle 90,9 % via Store jetable (CRAP 5402 → 77) — vague 4 |
| buildConversationMethods | 40 | 40 | COUVERTURE réelle 98,5 % (CRAP 1640 → 40) — vague 4 |

Bilan : 29 unités cohérentes de CC 4 à 114 (vagues 1-3), plus 4 orchestrateurs
CC 1 ; la vague 4 ajoute le Store jetable (couverture RÉELLE des builders,
crap 5402 → 77 sur la machine F-14), un 4e registre démontlé (artifacts-shares
59 → 1), les validations d'URL/clés réunies en un module pur testé
(providers-validate.ts, 100 %), le hook géant sous la barre des 100 (86) et
le tour assistant décomposé en étapes (147 → 84). Vitest : 67 → 144 tests.

Anomalie latente constatée en vague 4 (verrouillée par test, NON corrigée) :
la purge D-02 des versions inactives ne purge jamais (appelée APRÈS les DELETE
— cf. couverture-reelle.txt §7.A). Correctif proposé : relever les groupes
AVANT suppression (chantier séparé, hors discipline verbatim).

Prochaines cibles (classement après vague 4) : AgentMotorCard 179 · Sidebar 138
· Composer 110 · StorageSection 105 · SystemSection 102 ·
registerProvidersHandlers 96 · registerExtensionsHandlers 94 — l'UI est un
autre chantier (React Compiler, tests de composants, conventions QA DOM du repo).

## Scripts de mesure et de chirurgie (`scripts/`)

- Mesure : `analyze_crap.py` (table + artefacts), `analyze_crap_edn.py`
  (analyse autoritative depuis crap.edn), `extract_hotspots.py` (hotspots.json
  via le parseur tree-sitter de crapper), `make_digest.py` (digest).
- Chirurgie par coupes ancrées (corps déplacés VERBATIM, bornes vérifiées) :
  `split_conversations.py` (vague 1), `extract_socket_events.py` +
  `inventory_effect{,2,3}.py` (vague 1 — inventaire des variables libres du
  grand useEffect), `refactor_llm_pool.py` (vague 2), `extract_conversations_hook.py`
  et `split_store_messages.py` (vague 3), `store_jetables.py`,
  `split_artifacts_shares.py`, `providers_valide.py`, `extract_turn_actions.py`
  et `split_turn_stages.py` (vague 4).

## Reproduire la mesure

```bash
pip install -e <clone de github.com/unclebob/crapper>
cd mini-services/hermes-chat && bunx vitest run --coverage   # lcov Vitest
cp ../../target/coverage/typescript/mini-services__hermes-chat/lcov.info \
   ../../target/coverage/typescript/lcov.info                # lcov fusionné
cd ../.. && crapper --use-existing-coverage                  # table + crap.edn
```

Depuis la vague 4 : absolutiser les chemins SF du lcov fusionné avant crapper
(une ligne de sed, comme pour l'ambiguïté modes.ts) :

```bash
sed 's|^SF:|SF:/chemin/absolu/vers/hermes_ui/mini-services/hermes-chat/|' \
    target/coverage/typescript/mini-services__hermes-chat/lcov.info \
    > target/coverage/typescript/lcov.info
```

Le « Store jetable » (vague 4) fait tourner les builders du store sous Vitest :
sous Node, db-driver.ts bascule sur node:sqlite (le MÊME moteur SQLite) avec
une base :memory: — sous Bun, bun:sqlite natif reste utilisé par le service.

Deux exécutions successives post-vague 3 ont produit des rapports
**identiques octet par octet** (cf. `suite-tests.log`, contre-vérification).
