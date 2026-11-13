# ROADMAP FRONT — Fonctionnalités de chat (F-xx)

> **Document de suivi des fonctionnalités**, réconcilié avec le code le 2026-11-13 après
> audit complet du repo (chaque statut s'appuie sur des fichiers cités, pas sur des souvenirs
> de session). Il complète `FORK.md` (qui reste **le** document de référence : conventions §5,
> registres §6, journal des décisions §9) en donnant la vue « fonctionnalités produit » du chat.
> **Règle :** mettre à jour ce tableau à chaque livraison de chantier, et consigner la décision
> au §9 de `FORK.md` (R6).

## Stack (réponses aux questions ouvertes de la passation précédente)

| Question | Réponse constatée dans le code |
| --- | --- |
| Framework | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · shadcn/ui (Radix) |
| Runtime | `bun` (front port 3000 + mini-service port 3003) |
| Transport du chat | **socket.io** (pas SSE, pas fetch/ReadableStream) — client singleton `src/lib/socket.ts`, protocole dans `mini-services/hermes-chat/index.ts`, miroir des types `src/lib/chat-types.ts` ↔ `mini-services/hermes-chat/types.ts` |
| Gestion d'état | React hooks : tout le chat vit dans `src/hooks/use-hermes-chat.ts` (orchestrateur unique, consommé par `page.tsx`). `zustand` est installé mais non utilisé pour le chat |
| Markdown | `react-markdown` + `remark-gfm` + `react-syntax-highlighter` (Prism) dans `src/components/chat/markdown-content.tsx` |
| Persistance | `bun:sqlite` côté mini-service (`store.ts`) — **pas** Prisma (boilerplate résiduel, cf. FORK.md §8) |
| Modes | Gateway Hermes réelle (`api_turn_v1`) ou **démo** (LLM intégré `z-ai-web-dev-sdk`) |

## Statuts

`À faire` · `Partiel` · `Terminé` · `Bloqué` — IDs stables `F-xx`, ne pas renuméroter.

### P0 — MVP

| ID | Feature | Critères d'acceptation | Statut | Preuve / écart |
|----|---------|------------------------|--------|----------------|
| F-01 | **Streaming + Stop** | Token par token ; Stop fonctionnel ; régénération après arrêt ; états `idle/streaming/stopped/error` | **Terminé** | `stream:delta` (coalescence 16 ms), Stop dans composer + palette + Échap ; **complété le 2026-11-13** : `stopped` persisté (`messages.stopped`), `turnState` exposé par le hook |
| F-02 | **Rendu markdown** | Blocs code colorés + copier ; tableaux, listes | **Terminé** | `markdown-content.tsx` : `CodeBlock` avec bouton Copier, GFM (tables, listes, liens, citations) |
| F-03 | **Actions message** | Copier, régénérer, éditer | **Terminé** | `message-bubble.tsx` : Copier (user+assistant), Régénérer (dernière réponse), Modifier (user, tronque + relance), Supprimer, Brancher |
| F-04 | **Gestion erreurs** | Message d'erreur clair + bouton « Réessayer » | **Terminé** | **Livré le 2026-11-13** : rangée d'erreur persistante dans le fil (cause + Réessayer/Masquer), partiel d'erreur affiché immédiatement |
| F-05 | **Historique conversations** | Renommer, auto-titre, supprimer, épingler ; recherche titre+contenu ; groupes par date | **Terminé** | `sidebar.tsx` (recherche, épinglées, Aujourd'hui/Hier/Plus ancien), `titleFrom()` à la 1re question, projets + drag & drop `@dnd-kit` |
| F-06 | **Composer** | Entrée=envoi, Maj+Entrée ; brouillon persistant ; auto-resize ; compteur de contexte | **Terminé** | Composer v2 (FORK.md §7.3) : brouillons `hermes.draft.<id>`, jauge + popover de décomposition, compaction, permissions |
| F-07 | **Upload fichiers** | Drag & drop, collage, prévisualisation, suppression | **Terminé** | `onDrop`/`onPaste` du composer, `attachments.tsx`, `uploads.ts` (15 Mo, ASR auto des audios) |
| F-08 | **Sélecteur de modèle** | Dans le composer ; mémorisé | **Terminé** | `model-picker.tsx` (cmdk, favoris) ; mémorisation **globale** (`hermes.model`), pas par conversation — assumé |
| F-09 | **Toggles capacités** | Recherche web / agent / images — 1 clic depuis le composer | À faire | Dépend des toolsets du moteur (post-gateway) ; en démo, rien à brancher |

### P1 — Vite après

| ID | Feature | Critères | Statut | Preuve / écart |
|----|---------|----------|--------|----------------|
| F-10 | **Slash commands** | `/traduire`, `/résumer` + templates | **Terminé** | `prompt-library.ts` + suggestions `/` du composer (Tab/Entrée pour appliquer) |
| F-11 | **Prompt système / conversation** | Panneau, presets | À faire | Prévu section « Hermes » des paramètres v4 (fichiers .md éditables) |
| F-12 | **Citations web** | Sources cliquables | À faire | Dépend du browsing agent (FORK.md §7.5, « plus tard ») |
| F-13 | **Partage / export** | Lien public ; export MD/PDF/image | Partiel | Export **MD/JSON/PDF** livré (`export.ts`, palette + header). Manquent : lien public lecture seule, export image |
| F-14 | **Édition avec branchement** | Éditer crée une branche ; navigation versions | Partiel | « Brancher » duplique la conversation depuis un message (fork). L'édition modifie en place (tronque + régénère) — pas de navigation entre versions dans la même conversation |
| F-15 | **Panneau artefacts** | HTML/graphiques en panneau latéral | **Terminé** | `artifact-panel.tsx` : split view ≈ 45 %, rendus code/MD/CSV/JSON/SVG/PDF/HTML (pipeline Chrome), versioning + diff |

### P2 — Différenciateurs

| ID | Feature | Critères | Statut | Preuve / écart |
|----|---------|----------|--------|----------------|
| F-16 | **Voix** | Dictée STT + lecture TTS | **Terminé** (cœur) | Dictée `use-dictation.ts` + `asr.ts` ; TTS « Écouter » par message (`useSpeech`). Reste optionnel : lecture en continu pendant le stream |
| F-17 | **Comparaison modèles** | 2 modèles côte à côte | À faire | — |
| F-18 | **Mémoire utilisateur** | Consultable, éditable, effaçable | À faire | Prévu section « Hermes » des paramètres v4 (MEMORY.md / USER.md éditables) |
| F-19 | **Instructions personnalisées** | Globales | À faire | Fusionner avec F-11 lors du chantier |
| F-20 | **Projets/dossiers** | Contexte par groupe | **Terminé** | UI projets (FORK.md §7.2) — rangement seul ; le contexte persistant par projet viendra des fichiers .md moteur |

### P3 — Plus tard

| ID | Feature | Critères | Statut | Preuve / écart |
|----|---------|----------|--------|----------------|
| F-21 | **Compteur tokens/coût** | Par message, repliable | Partiel | Jauge de contexte + popover par poste (`tokens.ts`, heuristique car/jetons). Manque : coût par message |
| F-22 | **Mode expert** | Température, max tokens, seed | Partiel | Effort de raisonnement par modèle livré. Manquent : température, max tokens, seed |
| F-23 | **Raccourcis clavier** | Nouveau chat, recherche, focus composer | **Terminé** | Cmd/Ctrl+K palette (nouveau chat, stop, régénérer, épingler, exports, modèles, recherche), Cmd/Ctrl+Maj+O nouveau chat, Échap = stop / fermer panneau |
| F-24 | **Feedback intégré** | 👍/👎 + commentaire | À faire | — |

### Divers

| ID | Feature | Statut | Preuve |
|----|---------|--------|--------|
| F-25 | **Page Paramètres** | **Terminé (phase 1)** — maquette v4 en attente de validation | Sheet 460 px livré + poussé (commits `004b388`, puis maquette `4c6269d`). Phasage v2.2+ : voir FORK.md §7.4 |

## Chantier du 2026-11-13 — F-01/F-04 « arrêt propre + erreurs persistantes »

Avant ce chantier, le socle streaming/stop/régénération existait déjà mais avec deux écarts UX :
le message interrompu s'affichait comme complet, et une erreur réelle effaçait la bulle au
bout de 2,5 s (le partiel persisté n'apparaissait qu'après rechargement, sans « Réessayer »).

Modifications (toutes chirurgicales, cf. journal FORK.md §9) :

- **Protocole** : `ChatMessage.stopped?: boolean` (miroir des deux `types.ts`) ; `stream:done`
  porte `stopped: true` ; `stream:error` embarque `message` (partiel persisté) + `conversation`.
- **Service** (`index.ts`) : un arrêt (`chat:stop`) clôt par `stream:done` — jamais par
  `stream:error` (le connecteur revient avec le partiel dans les deux modes) ; arrêt avant le
  premier jeton = aucun message persisté ; erreur réelle = partiel persisté puis transmis.
- **Store** : migration additive `ALTER TABLE messages ADD COLUMN stopped INTEGER` ;
  `appendMessage`/`getMessage`/`getMessages`/fork le transportent.
- **Hook** (`use-hermes-chat.ts`) : `turnError` persistant (effacé au nouveau tour, à la
  réussite, au changement de conversation — plus de timeout) ; `turnState` dérivé
  (`idle | streaming | stopped | error`) ; `retryAfterError` (régénère) ; `dismissTurnError`.
- **UI** : pastille « Réponse interrompue » sous le partiel (`message-bubble.tsx`) ; rangée
  d'erreur `role="alert"` avec Réessayer/Masquer en bas de fil (`message-list.tsx`) ; câblage
  `page.tsx`.

## Ordre de démarrage recommandé (suite)

1. **Valider la maquette paramètres v4** (`design/maquette-parametres-v4.html`) → chantier
   v2.2 (Fournisseurs & clés + Extensions) — c'est le chantier actif de l'utilisatrice.
2. **F-11 + F-19** (prompt système / instructions personnalisées) — se greffe sur la section
   « Hermes » des paramètres et les fichiers .md moteur.
3. **F-13** (lien public lecture seule) — l'export local est déjà couvert.
4. **F-24** (feedback 👍/👎) — léger, autonome.
5. **F-09 / F-12** (toggles capacités, citations) — bloqués sur les toolsets du moteur ;
   à revoir une fois la gateway branchée.

## Notes de passation

- Les statuts ci-dessus ont été vérifiés **dans le code** le 2026-11-13 (audit complet :
  hook, service, store, composer, sidebar, bulles, palette, sheet paramètres). En cas de
  doute, `git log --oneline` + les fichiers cités font foi.
- Convention de nommage git : commits propres « un par chantier » sur `publish`, poussés vers
  `main` distant (recette complète dans FORK.md §10).
