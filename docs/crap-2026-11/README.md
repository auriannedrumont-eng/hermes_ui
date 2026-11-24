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
| `couverture-reelle.txt` | Phase 2 + vagues 1 à 4 + séances UI du 25/11 (vagues 5 à 7) — rapport de couverture réelle (Vitest 5.1 + @vitest/coverage-v8) et journal des vagues de refactoring, cibles suivantes incluses. |
| `suite-tests.log` | Preuves de validation brutes de la dernière séance (fichier LOCAL — `*.log` gitignore, non commité comme les précédents) : tsc ×3, eslint, suite autonome 33/33, gardes de source, Vitest 144/144, QA DOM dédiée Composer 25/25, preuve VERBATIM du découpage Composer (12 plages, 728 lignes), classement crapper après la vague 6. |
| `refactoring.patch` | Vagues 1+2+3+4 + séances UI (vagues 5 à 7) — patch unifié `git diff HEAD` (nouveaux fichiers inclus via `git add -N`). Vérifié `git apply --check` sur HEAD propre. |
| `table-crap.txt` | Snapshot crapper complet après la vague 6 UI du 25/11 (fonction, namespace, CC, couverture, CRAP). |
| `rapport-crap-complet.txt` | Sortie brute de `crapper --use-existing-coverage` après la vague 6 UI du 25/11. |
| `crap.edn` | Métriques au format EDN pour uml-viewer. |
| `hotspots.json` | Les 60 fonctions de production CC ≥ 30 après la vague 6 UI du 25/11 (chunks .next/ exclus de l'extraction), avec spans et décompte des décisions (if/ternaire/&&/…). |
| `digest-hotspots.txt` | Digest de lecture des hotspots : en-tête de fichier, signature, corps (le Top 15 = entrées 1-15). |
| `lcov-mini-service.info` | LCOV Vitest du mini-service (store-messages 81,8-100 %, providers-validate 100 %, parseRepoInput 100 %, models 100 %, modes 98 %, prompts 97 %, fiches 95 %, parseModelOptions 100 %). |

## Refactoring — bilan des quatre vagues + séances UI (corps VERBATIM)

| Fonction initiale | CC avant | CC après | Unités extraites |
| --- | --- | --- | --- |
| useHermesChat | 287 | 86 | use-chat-socket-events (81), use-conversations (42), use-turn-actions (70), use-attachments-wiring (12) — vagues 3+4 |
| registerConversationsHandlers | 261 | 1 | 5 sous-registres (13-77) |
| registerProvidersExtensionsHandlers | 239 | 1 | 4 sous-registres (6-114) |
| createLlmPool | 218 | 69 | llm-streams.ts : streamAnthropicTurn 57, streamOpenAiTurn 47, buildUserPayload 10, stallGuardFor 4, readErrorBody 11 ; createPoolCatalog 35 |
| buildMessages | 186 | 1 | 5 builders domaine (18-73), fusion par spread |
| registerSettingsSystemHandlers | 157 | 1 | 7 sous-registres thématiques (8-50) |
| AgentMotorCard | 179 | 52 | 3 sous-cartes feuilles VERBATIM : AgentMotorEnTete 43, AgentMotorBlocs 57, AgentMotorReplis 30 — séance UI 25/11 (QA DOM dédiée 41/41) |
| Sidebar | 138 | 74 | 5 feuilles VERBATIM (Recherche 8, Dossiers 8, Historique 2, Statut 13, Dialogues 15) + 2 algorithmes de module purs (computeSearchTree 11, reorderProjectsFlat 15) — vague 5 UI 25/11, 23 plages prouvées au HEAD |
| Composer | 110 | 45 | 7 feuilles VERBATIM (Recouvrement 2, Slash 2, Puces 2, Saisie 38, Barre 23, Alertes 3, Pied 2) — vague 6 UI 25/11, 12 plages (728 lignes) prouvées au HEAD, QA DOM dédiée 25/25 |
| runAssistantTurn | 147 | 84 | 7 étapes module-level (3-24) — vague 4 |
| registerProvidersHandlers | 114 | 96 | validations d'URL/clés → providers-validate.ts (8 helpers purs testés) — vague 4 |
| registerArtifactsSharesHandlers | 59 | 1 | 3 sous-registres (14-28) — vague 4 |
| registerExtensionsHandlers | 95 | 94 | validations → providers-validate.ts — vague 4 |
| buildMessageVersionsMethods | 73 | 73 | COUVERTURE réelle 91,8 % via Store jetable (CRAP 5402 → 75,9) — vague 4 + D-02 |
| buildConversationMethods | 40 | 40 | COUVERTURE réelle 98,5 % (CRAP 1640 → 40) — vague 4 |

Bilan : 29 unités cohérentes de CC 4 à 114 (vagues 1-3), plus 4 orchestrateurs
CC 1 ; la vague 4 ajoute le Store jetable (couverture RÉELLE des builders,
crap 5402 → 77 sur la machine F-14), un 4e registre démontlé (artifacts-shares
59 → 1), les validations d'URL/clés réunies en un module pur testé
(providers-validate.ts, 100 %), le hook géant sous la barre des 100 (86) et
le tour assistant décomposé en étapes (147 → 84). Vitest : 67 → 144 tests.
Les séances UI du 25/11 démontent les trois pires composants du front en
feuilles VERBATIM : AgentMotorCard 179 → 52, Sidebar 138 → 74 et
Composer 110 → 45 — plus aucune fonction UI au-dessus de la barre des 100.

Anomalie D-02 constatée en vague 4, **CORRIGÉE dans la séance UI du 25/11** :
la purge des versions inactives est passée AVANT les DELETE dans
deleteTrailingAssistant et editUserMessageAndTruncate — les version_group des
lignes tronquées sont relevés tant qu'ils existent ; les deux verrous de
comportement sont retournés (tests « D-02 corrigé »), couverture du builder
F-14 portée à 91,8 % (CRAP 75,9).

Séance UI du 25/11 (§8 de couverture-reelle.txt) : AgentMotorCard 179 → 52 en
3 sous-cartes feuilles VERBATIM (AgentMotorEnTete 43 · AgentMotorBlocs 57 ·
AgentMotorReplis 30), QA DOM dédiée scripts/qa-motor-card-v3-dom.ts **41/41**
(pile complète auto-portée via Caddy :81 — moteur stubbé, release fausse,
gateway 9120 pilotée) ; découverte de harnais consignée : Next dev accepte la
montée websocket /socket.io/ sans la relayer — les QA passent par Caddy, le
vrai chemin de production.

Vague 5 UI (2) du 25/11 (§9 de couverture-reelle.txt) : **Sidebar 138 → 74**
(CRAP 19 182 → 6 494) — 5 feuilles VERBATIM (SidebarRecherche 8 ·
SidebarDossiers 8 · SidebarHistorique 2 · SidebarStatut 13 · SidebarDialogues
15) + 2 algorithmes de module purs (computeSearchTree 11 ·
reorderProjectsFlat 15) ; 976 lignes déplacées prouvées identiques octet par
octet au HEAD (preuve_sidebar_verbatim.py), structure DOM et props publiques
inchangées, tout l'état reste à l'orchestrateur.

Vague 6 UI (3) du 25/11 (§10 de couverture-reelle.txt) : **Composer 110 → 45**
(CRAP 12 210 → 2 070, −83 %) — 7 feuilles VERBATIM (ComposerRecouvrement 2 ·
ComposerSlash 2 · ComposerPuces 2 · ComposerSaisie 38 · ComposerBarre 23 ·
ComposerAlertes 3 · ComposerPied 2) ; 345 lignes JSX déplacées, 12 plages
(728 lignes : morceaux + parent) prouvées identiques octet par octet au HEAD
(preuve_composer_verbatim.py), structure DOM et props publiques inchangées,
tout l'état reste à l'orchestrateur, refs textarea/file-input descendues en
props (convention RefObject du repo) ; QA DOM dédiée
scripts/qa-composer-dom.ts **25/25** (harnais auto-porté : service base
jetable + front dev + passerelle :81 du sandbox — structure, comportements
slash/envoi/dépôt, mobile 375 px).

Vague 7 UI (2026-11-25) : **StorageSection 105 → 54** en 5 feuilles
(Compteurs 4 · BarreFiltres 9 · Bandeau 9 · Groupe 28 · Toasts 7) et
**SystemSection 102 → 55** en 2 feuilles (EnteteApp 26 · FilApp 23) —
`extract_storage_leaves.py` / `preuve_storage_verbatim.py` (13 plages,
801 lignes) et `extract_system_leaves.py` / `preuve_system_verbatim.py`
(8 plages, 560 lignes) ; QA DOM dédiées `scripts/qa-storage-dom.ts` **21/21**
et `scripts/qa-system-dom.ts` **16/16** (harnais auto-porté, sonde réelle
« Vérification… » observée) ; `qa-motor-card-v3-dom.ts` TOUT VERT (41).
**Plus aucune fonction de production au-dessus de CC 100.**

Suite backend de la vague 7 (même séance) : `extract_sous_registres_providers_extensions.py`
+ `preuve_sous_registres_verbatim.py` (11 plages, 690 lignes) —
registerProvidersHandlers **96 → 1** (Catalog 3 · Mutations 57 · Keys 38) et
registerExtensionsHandlers **94 → 1** (Gestion 21 · Import 45 · Repo 30) ;
hotspots 60 → 62, le top global retombe à useHermesChat 86.

Prochaines cibles (classement après la vague 7 complète) : plus aucune
fonction de production au-dessus de CC 100 ; la file reste à la demande
(HermesWebPage 82 · WebchatSection 75 côté UI, registres 77/77 côté service) —
le chantier CRAP atteint son objectif posé à l'ouverture.

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
  et `split_turn_stages.py` (vague 4), `extract_agent_motor_leaves.py`
  (séance UI 25/11 — AgentMotorCard en 3 feuilles, JSX déplacé VERBATIM),
  `extract_sidebar_leaves.py` + `preuve_sidebar_verbatim.py` (vague 5 UI —
  Sidebar en 5 feuilles + 2 algorithmes purs, 23 plages prouvées au HEAD),
  `extract_composer_leaves.py` + `preuve_composer_verbatim.py` (vague 6 UI —
  Composer en 7 feuilles, 12 plages prouvées au HEAD),
  `extract_storage_leaves.py` + `preuve_storage_verbatim.py` (vague 7 UI —
  StorageSection en 5 feuilles, 13 plages / 801 lignes prouvées au HEAD),
  `extract_system_leaves.py` + `preuve_system_verbatim.py` (vague 7 UI —
  SystemSection en 2 feuilles, 8 plages / 560 lignes prouvées au HEAD).
- QA DOM de la carte moteur : `scripts/qa-motor-card-v3-dom.ts` (à la racine
  du repo, harnais auto-porté : Caddy :81 + front dev + service stubbé —
  scénario complet de la carte v3, 41 vérifications).
- QA DOM du Composer : `scripts/qa-composer-dom.ts` (à la racine du repo,
  harnais auto-porté : service base jetable + front dev + passerelle :81 du
  sandbox, journaux du service et du front en fichiers — 25 vérifications :
  structure des 7 feuilles, comportements slash/envoi/dépôt, mobile 375 px).
- QA DOM du Stockage : `scripts/qa-storage-dom.ts` (vague 7 UI — 21
  vérifications : compteurs, barre de filtres, bandeau de résultats,
  inventaire vide, effacement des filtres, mobile 375 px).
- QA DOM du Système : `scripts/qa-system-dom.ts` (vague 7 UI — 16
  vérifications : pastille d'état, chaîne de boutons, sonde « Vérifier
  maintenant » réelle, fil live absent au repos, carte Hermes, mobile).

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
