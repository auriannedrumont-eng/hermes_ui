# ETAT.md — Synthèse de l'état du projet (2026-11-22)

> Une page, à jour. Sources : `docs/ROADMAP_FRONT.md` (F-xx), `docs/ROADMAP-LOTS.md`
> (chantiers), `docs/AUDIT-CONSOLIDE.md` (constats), FORK.md §9 (journal). Remplace
> la lecture des trois documents pour démarrer une session ; les ouvrir seulement
> si le détail d'un point est nécessaire.

## Fonctionnalités livrées (F-xx)

| Domaine | État |
| --- | --- |
| Chat cœur | Streaming + Stop propre, régénération, erreurs persistantes (F-01/F-04) ✓ · Markdown + shiki (F-02) ✓ · Actions message (F-03) ✓ · Historique, recherche, épingle (F-05) ✓ · Composer v2 avec jauge de contexte (F-06) ✓ · Uploads + dictée/TTS (F-07/F-16) ✓ · Sélecteur de modèles cmdk (F-08) ✓ · Slash commands (F-10) ✓ · Raccourcis clavier (F-23) ✓ |
| Artefacts | Panneau split view multi-rendus (F-15) ✓ · Cartes inline + versioning + diff ✓ · Journal de versions restaurable (F-26) ✓ · Onglet dédié `/view` bac à sable CSP (F-28) ✓ · Terminal du tour dans le panneau (F-29) ✓ |
| Organisation | Sidebar : Archives, masquage, densité (F-61) ✓ · Archives — archivage des dossiers (F-60) ✓ · Dossiers imbriqués + liaison disque (F-59) ✓ · Projets/dossiers (F-20) ✓ · Édition avec branchement (F-14) ✓ · Partage public lecture seule + export image (F-13) ✓ |
| Paramètres | Volet 860 px à rail, 10 sections réelles — phase 3 / v2.4 livrée (F-25) ✓ : Interface, Modèles, Fournisseurs (porte-clés multi-clés, test réel), Clés de services, Extensions (imports GitHub), Outils, Skills, Modes, Hermes (mémoire F-18 + instructions F-19 + prompts F-11), Profils, Système |
| Modèles & coûts | Comparaison 2 modèles (F-17) ✓ · Compteur tokens/coût (F-21) ✓ · Mode expert (F-22) ✓ |
| Modes (F-30/F-30b) | 7 modes livrés : chat · plan · code · comparer · débat · conseil · auto — orchestrateur, consignes éditables, « qui travaille », modèle ou **chat IA web** par voix (F-27 : pilotage navigateur z.ai / AI Studio / gemini-app) ✓ |
| Retiré | Feedback 👍/👎 (F-24) — retiré le 2026-11-16 à la demande de l'utilisatrice |

## Chantiers récents (FORK.md §9, novembre)

- **Sidebar : Archives, masquage, densité F-61 (11-22)** : section renommée **« Archives »** (fichier `sidebar-archives.tsx`, réglage `fork.archives.collapsed` avec legacy key) ; **icône d'en-tête qui masque/réaffiche la sidebar bureau** (`PanelLeftClose`/`PanelLeftOpen`, réglage `fork.sidebar.hidden` — la sidebar mobile n'est pas concernée) ; **indentations resserrées** (zone enfants d'un dossier 46→30 px, sous-dossier 26→20 px — plus de largeur utile, règle verticale conservée). QA : tsc ×3, eslint 0, build OK, suite 29/29, `qa-projects-dom.ts` 32/32 (3 vérifications masquage), E2E 40/54 (baseline préexistante), captures `sidebar-archives.jpg`, `page-densite.jpg`, `page-sans-sidebar.jpg`.
- **Archives — archivage des dossiers F-60 (11-22)** : « Archiver le dossier » dans les menus (racines et sous-dossiers) — sort le dossier de la liste active **sans rien effacer** (conversations intactes, sous-arbre propagé : archiver range tout le contenu, désarchiver le ramène entier) ; section repliée en bas de sidebar, compteur visible, sous-dossiers préfixés « Parent › », Désarchiver + Supprimer avec garde ; broadcast `projects:updated` (liste complète) ; recherche et arbre actif excluent les archivés. QA : `test-projects-archive-flow.ts` 19/19, tsc ×3, eslint, suite 29/29, build OK, E2E 40/54 (14 échecs préexistants).
- **Dossiers imbriqués + liaison disque F-59 (11-22)** : la sidebar passe à l'arbre — « Mes dossiers » / « Sans dossier » avec actions sur les titres, sous-dossiers à un niveau (menu « Nouveau dossier », règle verticale, compteur direct, actif sans bordure), fil d'Ariane dans l'en-tête, recherche étendue aux noms (arbre filtré tout déplié), 📁↓ lie un vrai dossier du disque (endpoint HOME borné, rien n'est lu ni déplacé), suppression conservatrice avec promotion des sous-dossiers. Maquette v6 validée puis implémentée (ré-application après recyclage du bac à sable — règle de fin de chantier ajoutée FORK.md §10). QA : tsc ×3, eslint, suite 29/29, build OK, E2E 39/53 (échecs préexistants vérifiés par baseline), `qa-projects-dom.ts` 22/22, captures `download/qa-f59/`.

- **Refonte shadcn 75 % (11-21)** : 30 fichiers migrés vers les primitives — `<button>`→`Button` (variantes mappées au style d'origine, rendu identique), `<input>`→`Input`, `<textarea>`→`Textarea` (nouvelle primitive), `<label>`→`Label` (nouvelle) ; `Segmented` remonté sur `Tabs` Radix et `InfoTip` sur `Tooltip` Radix (APIs inchangées, tap mobile/Échap/singleton conservés) ; custom assumé préservé (composer, bulles, dnd-kit, Pastille, marque terracotta AA). Frontière primitive ↔ custom documentée FORK.md §61. QA : tsc 0, eslint 0, build OK, zéro attribut perdu aux diffs.
- **Système restructuré v0.4.1 (11-21)** : section Système en **deux groupes nommés** (« L'interface » / « Le moteur »), carte « Mise à jour de l'interface », **fusion des cartes « Agent » + « Moteur » en une carte Moteur Hermes unique** (liaison + version + maj + repli autre poste), suppression de la ligne « Version de Hermes » (elle montrait la version du mini-service), filet de sécurité interface (retour manuel documenté), textes « Agent Hermes » → « Moteur Hermes » partout (sidebar, volet). Maquette `design/maquette-systeme-v2.html` validée puis implémentée. QA : tsc 0, eslint 0, E2E moteur 34/34, navigateur sur pile réelle (captures `download/v0.4.1-systeme-*.png`).
- **Moteur Hermes v0.4.0 (11-20)** : surcouche complète du cycle de vie du moteur — version (`hermes --version`) + dernière release GitHub avec **changelog et marqueur « touche l'interface »**, mise à jour par la **commande officielle** `hermes update --backup` (journal en direct), **contrôle automatique** après maj (liaison gateway + modèles + version, aucun tour lancé), **filet de sécurité** : version précédente retenue + **retour arrière assisté** (procédure officielle : arrêt gateway → checkout du tag → re-sondage 2 min, confirmation en 3 promesses) et **carnet de bord** (chaque étape datée, message à transmettre copiable). Événements `agent:*`, réglage serveur `fork.agent.update.autoCheck`. QA : test E2E 34/34 + parcours navigateur complet sur pile réelle stubbée (24 vérifications, captures `download/v0.4.0-*.png`).
- **Perf (11-19)** : shiki + cache LRU, coalescence des deltas 200 ms, mémoïsation du fil, auto-scroll rAF, `content-visibility`, Web Locks — CPU divisé pendant les tours.
- **Reconnexion (11-19)** : resynchronisation automatique de la conversation active + `tryAllTransports` — plus de bannière bloquée après une coupure.
- **Build cassé (11-19)** : `tools/` (cache bun du lanceur) exclu du type-check — le fallback dev permanent est réparé.
- **Revue de code (11-19)** : 0 bloquant / 12 majeurs / 30 moyens / ~80 mineurs ; lots 1-2 corrigés (9 constats).
- **Modes F-30/F-30b, versions F-26, webchat F-27, re-attache des tours en vol** (11-15 → 11-17) : livrés et QA verts.

## Reste à faire (docs/ROADMAP-LOTS.md, ordre 1 → 4 → 2 → 3 → 5 → 6)

| Lot | Contenu | Effort |
| --- | --- | --- |
| **1 — Critique** | CORS loopback + jeton lanceur, Caddy figé, fuite streams fantômes (`llm-pool`), garde abort orchestrateur, race `conversations:open` | ~1-2 j |
| **4 — CI** | Scripts `test`/`qa:dom`, GitHub Actions typecheck+lint, tests de régression du Lot 1 | ~1 j |
| **2 — Intégrité SQLite** | Purge artefacts orphelins, échappement `LIKE`, transactions, `JSON.parse` protégé, watchdog webchat | ~2-3 j |
| **3 — État frontend** | `ModePicker` écrase `debateParallel`/`model`, brouillons figés, flux streams (dédoublonnage, ack stop) | ~2 j |
| **5 — UI / a11y** | Échap sous dialog Radix, `KeyboardSensor` dnd, ARIA, typo aux 7 crans | ~2 j |
| **6 — Hygiène** | ~25 dépendances mortes, chemins en dur, docs alignées, FTS5, découpage `index.ts` | ~1-2 j |

**Revue 11-19 — constats encore ouverts** : M-3 (brouillon du compositeur au refus),
M-4 (liens pièces jointes 401), M-5 (barrière markdown page publique), M-8
(`emitWithAck` sans timeout), M-10 (type expert), 4.2 (toast `connect_error`),
4.8 (garde `res.artifact`).

**Rythme recommandé** : alternance un lot de correctifs / une fonctionnalité ; le
Lot 1 passe avant toute nouvelle fonctionnalité, le Lot 4 avant tout refactoring.

## Dettes et pièges connus (FORK.md §8)

- `.env` et bases SQLite committés dans le repo : pratique solo, à revoir avant ouverture publique.
- Pas de tests frontend automatisés ; scripts de test manuels dans `scripts/`.
- Piège socket.io : un emit-ack n'accepte qu'UN ack — ne jamais « acker deux fois ».
- Piège QA : le z-ai du bac à sable renvoie parfois 429 — espacer les scripts à tours réels.
- Pièges artefacts : jamais d'artefact plein format dans le flux ; rendu asynchrone jamais bloquant.
