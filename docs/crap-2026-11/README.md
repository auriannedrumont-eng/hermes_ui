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
| `couverture-reelle.txt` | Phase 2 + phase 3 — rapport de couverture réelle (Vitest 5.1 + @vitest/coverage-v8) et journal des trois vagues de refactoring, cibles suivantes incluses. |
| `suite-tests.log` | Preuves de validation brutes : tsc ×3, eslint, suite autonome 33/33, gardes de source, Vitest 67/67, contre-vérification après recyclage du bac à sable. |
| `refactoring.patch` | Phase 3 — patch unifié `git diff HEAD` des vagues 1+2+3 (4235 lignes, 19 fichiers). Vérifié `git apply --check` sur HEAD propre. |
| `table-crap.txt` | Snapshot crapper complet après vague 3 (fonction, namespace, CC, couverture, CRAP). |
| `rapport-crap-complet.txt` | Sortie brute de `crapper --use-existing-coverage` après vague 3. |
| `crap.edn` | Métriques au format EDN pour uml-viewer. |
| `hotspots.json` | Les 56 fonctions de production CC ≥ 30 après vague 3, avec spans et décompte des décisions (if/ternaire/&&/…). |
| `digest-hotspots.txt` | Digest de lecture des hotspots : en-tête de fichier, signature, corps (le Top 15 = entrées 1-15). |
| `lcov-mini-service.info` | LCOV Vitest du mini-service (models 100 %, modes 98 %, prompts 97 %, fiches 95 %, parseModelOptions 100 %). |

## Refactoring — bilan des trois vagues (corps VERBATIM)

| Fonction initiale | CC avant | CC après | Unités extraites |
| --- | --- | --- | --- |
| useHermesChat | 287 | 166 | use-chat-socket-events (81), use-conversations (42) |
| registerConversationsHandlers | 261 | 1 | 5 sous-registres (13-77) |
| registerProvidersExtensionsHandlers | 239 | 1 | 4 sous-registres (6-114) |
| createLlmPool | 218 | 69 | llm-streams.ts : streamAnthropicTurn 57, streamOpenAiTurn 47, buildUserPayload 10, stallGuardFor 4, readErrorBody 11 ; createPoolCatalog 35 |
| buildMessages | 186 | 1 | 5 builders domaine (18-73), fusion par spread |
| registerSettingsSystemHandlers | 157 | 1 | 7 sous-registres thématiques (8-50) |

Bilan : 29 unités cohérentes de CC 4 à 114, plus 4 orchestrateurs CC 1 — chacune
testable unitairement (sous-registres au socket factice, builders via Store
jetable, tours de stream purs). Prochaines cibles (classement après vague 3) :
AgentMotorCard 179 · useHermesChat 166 · runAssistantTurn 147 · Sidebar 138 ·
registerProvidersHandlers 114 · Composer 110.

## Scripts de mesure et de chirurgie (`scripts/`)

- Mesure : `analyze_crap.py` (table + artefacts), `analyze_crap_edn.py`
  (analyse autoritative depuis crap.edn), `extract_hotspots.py` (hotspots.json
  via le parseur tree-sitter de crapper), `make_digest.py` (digest).
- Chirurgie par coupes ancrées (corps déplacés VERBATIM, bornes vérifiées) :
  `split_conversations.py` (vague 1), `extract_socket_events.py` +
  `inventory_effect{,2,3}.py` (vague 1 — inventaire des variables libres du
  grand useEffect), `refactor_llm_pool.py` (vague 2), `extract_conversations_hook.py`
  et `split_store_messages.py` (vague 3).

## Reproduire la mesure

```bash
pip install -e <clone de github.com/unclebob/crapper>
cd mini-services/hermes-chat && bunx vitest run --coverage   # lcov Vitest
cp ../../target/coverage/typescript/mini-services__hermes-chat/lcov.info \
   ../../target/coverage/typescript/lcov.info                # lcov fusionné
cd ../.. && crapper --use-existing-coverage                  # table + crap.edn
```

Deux exécutions successives post-vague 3 ont produit des rapports
**identiques octet par octet** (cf. `suite-tests.log`, contre-vérification).
