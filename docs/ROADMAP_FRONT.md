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
| F-11 | **Prompt système / conversation** | Panneau, presets | **Terminé** | Livré le 2026-11-13 : panneau d'édition par conversation (sheet 460 px, bouton « prompt » de l'en-tête), bibliothèque de presets éditables (section Hermes du volet, 5 seeds), table additive `system_prompts`, événements `system-prompt:*` / `system-prompts:*`, effet au prochain tour (composé base + F-19 + F-11 côté service, `system_prompt` dans `api_turn_v1.settings` en gateway), jauge de contexte + pastille d'en-tête |
| F-12 | **Citations web** | Sources cliquables | À faire | Dépend du browsing agent (FORK.md §7.5, « plus tard ») |
| F-13 | **Partage / export** | Lien public ; export MD/PDF/image | **Terminé** | Livré le 2026-11-13 : lien public lecture seule `/shared/<token>` (snapshot **figé** à la création, table additive `shares`, token opaque 24 car., un seul lien actif par conversation), menu « Partager » de l'en-tête (copie, ouverture de la vue publique, révocation → 410 Gone), export **image PNG plein page du fil** (pipeline chrome-headless-shell), `data.json` public sans id interne, page `noindex`. Export local MD/JSON/PDF livré précédemment (`export.ts`). |
| F-14 | **Édition avec branchement** | Éditer crée une branche ; navigation versions | **Terminé** (volet versions) | Livré le 2026-11-13 : régénérer ne supprime plus — chaque réponse a des versions conservées, navigation ‹ n/m › dans le fil (version affichée = version envoyée au modèle), par côté en comparaison ; suppression d'une version = promotion de la précédente. Choix documenté : l'édition d'un message utilisateur reste « fork explicite » (bouton Branche) plutôt qu'un arbre de branches implicites. |
| F-15 | **Panneau artefacts** | HTML/graphiques en panneau latéral | **Terminé** | `artifact-panel.tsx` : split view ≈ 45 %, rendus code/MD/CSV/JSON/SVG/PDF/HTML (pipeline Chrome), versioning + diff |

### P2 — Différenciateurs

| ID | Feature | Critères | Statut | Preuve / écart |
|----|---------|----------|--------|----------------|
| F-16 | **Voix** | Dictée STT + lecture TTS | **Terminé** (cœur) | Dictée `use-dictation.ts` + `asr.ts` ; TTS « Écouter » par message (`useSpeech`). Reste optionnel : lecture en continu pendant le stream |
| F-17 | **Comparaison modèles** | 2 modèles côte à côte | **Terminé** | Livré le 2026-11-13 : variantes `a`/`b` en base (`messages.variant`), protocole `compare` sur send/regenerate/edit + `variant` dans les `stream:*`, chaque modèle ne voit que ses réponses ; colonnes A/B côte à côte (empilées < 768 px) avec régénération par côté ; toggle « Comparer » + pickers A/B du composer ; paire mémorisée `hermes.compare.models`. QA 33/33 + visuelle. |
| F-18 | **Mémoire utilisateur** | Consultable, éditable, effaçable | **Terminé** | Livré le 2026-11-13 : carte « Mémoire » de la section Hermes du volet (toggle activer/désactiver, apprentissage automatique, éditeur 12 000 car., effacement) ; clés `hermes.memory.{enabled,autoLearn,notes}` (table `settings`, fallback actif), événements `memory:*` + broadcast ; composition des instructions du tour par le service (démo : section « Mémoire de l'utilisateur » ; gateway : `memory_notes`/`memory_auto_learn` dans `api_turn_v1.settings`, clés à valider) ; `hello.memoryChars` honnête. |
| F-19 | **Instructions personnalisées** | Globales | **Terminé** | Livré le 2026-11-13 avec F-11 (même chantier) : instructions globales persistées côté service (`hermes.instructions.custom`, table `settings`), éditeur dans la section Hermes du volet, appliquées à toutes les conversations, transmises dans `api_turn_v1.settings` en gateway |
| F-20 | **Projets/dossiers** | Contexte par groupe | **Terminé** | UI projets (FORK.md §7.2) — rangement seul ; le contexte persistant par projet viendra des fichiers .md moteur |

### P3 — Plus tard

| ID | Feature | Critères | Statut | Preuve / écart |
|----|---------|----------|--------|----------------|
| F-21 | **Compteur tokens/coût** | Par message, repliable | Partiel | Jauge de contexte + popover par poste (`tokens.ts`, heuristique car/jetons). Manque : coût par message |
| F-22 | **Mode expert** | Température, max tokens, seed | **Terminé** | Livré le 2026-11-13 (douzième session, suite) : section repliable « Mode expert » dans le popover du sélecteur (température curseur **0–1** — le moteur démo rejette au-delà, erreur 1210 vérifiée ; plafond 1–8192 ; graine 32 bits) ; registre `hermes.expert.*` + payloads `chat:send`/`regenerate`/`edit` ; `sanitizeExpertSettings` côté service (clamps, non-numériques ignorés) ; injectés au LLM démo **pour de vrai** (`maxTokens=3` → « Le renard », troncation vérifiée) et transmis dans `api_turn_v1.settings` en gateway. QA `test-expert-flow.ts` 14/14. |
| F-23 | **Raccourcis clavier** | Nouveau chat, recherche, focus composer | **Terminé** | Cmd/Ctrl+K palette (nouveau chat, stop, régénérer, épingler, exports, modèles, recherche), Cmd/Ctrl+Maj+O nouveau chat, Échap = stop / fermer panneau |
| F-24 | **Feedback intégré** | 👍/👎 + commentaire | **Terminé** | Livré le 2026-11-13 : boutons 👍/👎 + popover commentaire sur chaque réponse assistant (`message-bubble.tsx`, re-clic = efface, commentaire ≤ 2 000 car.) ; colonnes additives `messages.feedback_rating`/`feedback_comment`, événement `feedback:set` + broadcast `feedback:changed`, mise à jour optimiste côté hook. **Local : jamais envoyé au modèle** (consigné §7.9). Non-transporté au fork (une branche repart sans retours) — assumé. |

### Divers

| ID | Feature | Statut | Preuve |
|----|---------|--------|--------|
| F-25 | **Page Paramètres** | **Terminé (phase 2 — volet v4 + Fournisseurs & clés + Extensions)** | Volet 860 px à rail (maquette v4 implémentée, `settings-panel.tsx`), Fournisseurs LLM et Clés de services (porte-clés multi-clés, **test réseau réel**, stratégies), Extensions (imports GitHub réels — repli `git ls-remote`, Vérifier/Mettre à jour/Épingler), Thème + Afficher le raisonnement en Interface. Phases : 1 = sheet 460 px (`004b388`) ; 2 = ce chantier. Suit : v2.3 découverte moteur (Outils, Skills, Hermes, Profils, Système) |

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

## Chantier du 2026-11-13 (huitième session) — Paramètres v2.2 « volet v4 + Fournisseurs & clés + Extensions »

Mené à la demande « continue » sur la **maquette v4** (dernière direction de design) ;
la validation formelle de l'utilisatrice reste à donner a posteriori, les ajustements
se feront sur l'implémenté (décision consignée FORK.md §9-8).

- **Volet gauche 860 px à rail** (10 sections, pastilles, plein écran < 1100 px) remplace
  le sheet 460 px de la phase 1 (`settings-sheet.tsx` supprimé).
- **Fournisseurs** (LLM) et **Clés de services** (Tavily, Exa, FAL.ai, xAI…) : porte-clés
  multi-clés — ordre = priorité, stratégie (Première disponible / Tournante / La moins
  utilisée), « Tester » = appel réseau **réel** exécuté par le mini-service
  (401 → « clé refusée », 429 → « limite atteinte ») ; secrets jamais renvoyés au
  navigateur (vues masquées `sk-••••7f3a` uniquement).
- **Extensions** : imports GitHub réels (branche, commit exact, dernier tag, derniers
  commits) avec repli protocole git quand l'API GitHub est au quota ; Vérifier /
  Mettre à jour / Épingler / activer-désactiver (colonne `applied` → « N en attente »
  au pied du volet, effet au redémarrage).
- **Interface** gagne Thème (Système/Clair/Sombre, next-themes) et Afficher le
  raisonnement (`fork.ui.showReasoning`, appliqué en direct aux bulles) ; **Modèles**
  = catalogue vivant + effort ; Outils/Skills/Hermes/Profils/Système = structure cible
  sans données simulées (v2.3+).
- QA : `scripts/test-providers-flow.ts` (29/29, dont test de clé réel → 401 et import
  GitHub réel) ; 14 captures `download/qa-parametres-v2/` (contrôle pixel + VLM) ;
  `bunx tsc --noEmit` 0 erreur `src/` ; eslint propre.

## Chantier du 2026-11-13 (neuvième session) — F-11 + F-19 « Prompt système & instructions personnalisées »

Conforme à l'ordre de démarrage recommandé (point 2 : F-11 + F-19 — la validation
du volet v4 restant à l'utilisatrice, point 1). Le prompt **s'ajoute** aux
instructions de base d'Hermes, il ne les remplace jamais.

- **Serveur** (`prompts.ts` nouveau + `store.ts`/`index.ts`/`demo-engine.ts`/`hermes-connector.ts` chirurgicaux) :
  table additive `system_prompts` (scope `conversation` = prompt actif, une ligne
  max par conversation ; scope `preset` = bibliothèque) ; instructions globales
  dans `settings` sous `hermes.instructions.custom` (max 4 000 car., prompt max
  12 000) ; événements `system-prompt:get/set/clear` + `system-prompts:list/create/update/delete`
  + `custom-instructions:get/set` ; broadcasts `system-prompt:changed`,
  `system-prompts:changed`, `custom-instructions:changed` ; 5 presets semés à
  la première ouverture.
- **Composition des instructions du tour** : en démo, `composeDemoSystemPrompt`
  empile base + instructions personnalisées + prompt de conversation (ordres
  stables, sections absentes omises) ; en gateway, le prompt de conversation
  part seul dans `api_turn_v1.settings.system_prompt` (la gateway garde ses
  instructions de base). `hello.systemPromptChars` compte la base + F-19 (jauge
  honnête), le poste « Prompt de conversation » s'ajoute à la jauge par conversation.
- **Client** : hook `use-system-prompts.ts` (état + actions + bus) ;
  `SystemPromptPanel` (sheet 460 px — bouton « prompt » de l'en-tête + pastille
  quand un prompt est actif) ; section **Hermes** du volet v4 livrée
  (instructions globales + bibliothèque de presets éditables, mémoire/fichiers
  .md restent « à venir ») ; `use-hermes-chat.ts` expose `promptInfo` (chargé
  au changement de conversation, suivi par bus, poids dans la jauge de contexte).
- QA : `scripts/test-system-prompt-flow.ts` **24/24** — dont vérification
  comportementale réelle (le LLM démo répond « B » au prompt « réponds toujours
  par la lettre B »), isolation entre conversations, garde-fous de longueur,
  remise à zéro des instructions. `bunx tsc --noEmit` : 0 erreur `src/` ;
  eslint propre sur les fichiers du chantier.

## Chantier du 2026-11-13 (dixième session) — F-13 « Partage public lecture seule + export image »

Point 3 de l'ordre recommandé. Le lien est un **snapshot figé** : la conversation
peut continuer sans changer le lien ; la révocation coupe l'accès (410 Gone)
sans toucher la source.

- **Serveur** : nouveau `mini-services/hermes-chat/shares.ts` (token opaque 24 car.
  base62, snapshot, vues) + migration additive `shares` dans `store.ts`
  (une ligne active max par conversation — un nouveau lien révoque l'ancien) ;
  événements `share:get/create/revoke` + broadcast `share:changed` ;
  suppression d'une conversation → ses liens passent 410. HTTP (3004) :
  `GET /share/<token>/data.json` (CORS `*`, cache 5 min, aucune donnée interne)
  et `GET /share/<token>/image.png` — document autonome sobre du fil rendu par
  le **pipeline chrome-headless-shell** existant (plein page).
- **Client** : page publique `/shared/[token]` (lecture seule, `noindex`,
  Markdown réutilisé pour les réponses, état « lien révoqué / introuvable »,
  bouton d'export image) ; menu « Partager » de l'en-tête (créer + copier le
  lien, ouvrir la vue publique, révoquer — avec détail du snapshot) ;
  câblage `page.tsx` (état, bus, toasts).
- QA : `scripts/test-share-flow.ts` **24/24** — vues sans snapshot, 404/410,
  ancien lien → 410 au remplacement, isolation entre conversations,
  conversation vide refusée, révocation, suppression → 410 persistant,
  **PNG Chrome valide (signature + 35 Ko)**. Page publique servie (200) et
  snapshot chargé côté client vérifiés en dev ; `bunx tsc --noEmit` 0 erreur
  `src/` ; eslint propre.

## Chantier du 2026-11-13 (onzième session) — F-24 « Feedback intégré »

Point 4 de l'ordre recommandé. Un retour 👍/👎 + commentaire sur chaque
réponse assistant — **local, jamais envoyé au modèle** (le protocole gateway
n'est pas modifié ; un futur chantier pourra l'exploiter côté moteur).

- **Serveur** : migration additive `messages.feedback_rating` / `feedback_comment`
  (R2), transportées par `getMessages`/`getMessage` ; `setMessageFeedback`
  (assistant seule, commentaire tronqué à 2 000, `null` = effacé) ;
  événement `feedback:set` + broadcast `feedback:changed`. Repli assumé :
  un fork repart sans retours (nouvelle branche = nouveaux retours).
- **Client** : `FeedbackControl` dans `message-bubble.tsx` (boutons 👍/👎 de la
  rangée d'actions, re-clic sur le même = efface, popover commentaire avec
  « Effacer le retour », pastille du commentaire visible en italique) ;
  `onSetFeedback` câblé `message-list` → `page` ; action `setMessageFeedback`
  du hook (optimiste, ack, retour arrière à l'état antérieur si refus) ;
  bus `feedback:changed` (multi-clients).
- QA : `scripts/test-feedback-flow.ts` **15/15** — pose, inversion,
  commentaire (ajout/remplacement/troncature), garde-fous (message
  utilisateur refusé, introuvable, commentaire sans vote), retrait complet,
  persistance au rechargement, isolation. `bunx tsc --noEmit` : 0 erreur
  `src/` ; eslint sans nouvelle erreur (une préexistante ligne 350 de
  `message-bubble.tsx`, antérieure au chantier).

## Chantier du 2026-11-13 (douzième session) — F-18 « Mémoire utilisateur »

Premier chantier P2 restant non bloqué (l'ordre recommandé est épuisé côté
démo : F-09/F-12 attendent la gateway). La mémoire est **consultable,
éditable, effaçable** — et injectée dans les instructions du tour par le
service, jamais assemblée côté client.

- **Serveur** : clés `hermes.memory.{enabled, autoLearn, notes}` dans la
  table `settings` (fallback additif : absentes = mémoire active) ;
  événements `memory:get/set-enabled/set-auto/set-notes` + broadcast
  `memory:changed` ; `composeDemoSystemPrompt` gagne la section « Mémoire
  de l'utilisateur » (entre base et instructions personnalisées) ;
  `systemPromptSize`/`hello.memoryChars` honnêtes ; en gateway, `memory_notes`
  + `memory_auto_learn` partent dans `api_turn_v1.settings` (clés à valider
  contre la gateway, convention Composer v2 : ignorées sans dommage).
- **Client** : `MemoryCard` (section Hermes du volet — interrupteur
  activer/désactiver, apprentissage automatique honnête « nécessite le moteur
  réel », éditeur 12 000 car. avec compteur, effacement avec confirmation du
  retour à vide) ; hook `use-memory` (chargement, bus, actions) ; câblage
  `page` → `settings-panel` → `hermes-section`.
- QA : `scripts/test-memory-flow.ts` **17/17 verts** (état par défaut propre,
  garde-fou 12 000, broadcasts des trois actions, **vérification
  comportementale** : la démo cite la mémoire ; désactivation coupe
  l'injection, réactivation la rétablit ; effacement complet). Re-passé une
  seconde fois. `bunx tsc --noEmit` : 0 erreur `src/` ; eslint propre.

## Chantier du 2026-11-13 (douzième session, suite) — F-22 « Mode expert »

F-22 était « Partiel » (effort livré) : la température, le plafond de jetons
et la graine manquaient. Livré en fin de douzième session. Décisions clefs
tirées de sondages SDK réels (consignées FORK.md §9-13) :

- **Bornes vérifiées empiriquement** : le moteur démo accepte
  `temperature`/`max_tokens`/`seed` mais rejette la température au-delà de 1
  (erreur fournisseur 1210) — le curseur vit donc sur **[0, 1]**, pas
  l'échelle OpenAI [0, 2]. `max_tokens=1` est accepté et tronque à un unique
  jeton (le plancher est donc 1, pas 16 : un plancher à 16 laissait passer
  des phrases courtes entières — détecté en QA).
- **Assainissement côté service** (`sanitizeExpertSettings`, prompts.ts) :
  température clampée [0,1], plafond [1,8192], graine entière 32 bits ;
  `null`/chaîdes non numériques/`NaN` ignorés (Number(null) vaut 0 — piège
  corrigé : un champ vide du client n'active plus la valeur 0). Branché sur
  les trois points d'entrée : `chat:send`, `chat:regenerate`, `message:edit`.
- **Injection réelle au LLM démo** (moteur `demo-engine.ts`) + transmission
  gateway dans `api_turn_v1.settings` (convention « ignoré sans dommage »).
- **Client** : section repliable « Mode expert » dans le popover du
  sélecteur (compteur « N actifs », curseur température, champs plafond /
  graine, champs vides = valeurs par défaut du fournisseur) ; registre
  `hermes.expert.*` (3 clés, §6) ; état + refs + persistance dans
  `use-hermes-chat` (payloads `send`/`regenerate`/`edit`) ; passage
  `page` → `composer` → `ModelPicker`.
- QA : `scripts/test-expert-flow.ts` **14/14 verts** — 9 contrôles
  d'assainissement + comportemental réel (`maxTokens=3` → « Le renard »,
  la réponse tronquée fait ~3 jetons ; le tour sans plafond rend la phrase
  entière) + tours réussis sur valeurs hors bornes (clampées) et
  non-numériques (ignorées). Reprises anti-429 espacées de 8 s.
  `bunx tsc --noEmit` : 0 erreur `src/` et service ; eslint propre.

## Chantier du 2026-11-14 — Fixes layout d'après les captures de l'utilisatrice (validation volet v4)

Les captures du poste Windows (accueil + volet Paramètres ouvert) révélaient deux bugs
de layout, reproduits et mesurés en local (Chromium 1280×1080, `scripts/qa-layout.ts`) :

1. **Volet Paramètres : rail empilé au-dessus du contenu** — le conteneur du volet était
   `flex flex-col` alors que rail (208 px) et colonne de contenu sont frères : le rail se
   rendait en bloc 208×455 en haut-gauche et le titre « Interface » partait à y≈455
   (mesuré), × isolé en hauteur. Fix : `min-[1100px]:flex-row` (le rail redevient une
   bande horizontale sous 1100 px, inchangé).
2. **App tenant sur la hauteur de son contenu** (composer non ancré, ~448 px vides sous
   le fil, sidebar stoppée net) — `ResizablePanelGroup` reçoit de la lib un style inline
   `height:100%` qui écrase `h-dvh`, et son parent n'avait pas de hauteur. Fix : wrapper
   racine `div.h-app-full` (nouvel utilitaire globals.css : `100vh` puis `100dvh` sous
   `@supports` — sert aussi de repli pour les navigateurs sans `dvh`), appliqué aussi au
   volet Paramètres, au panneau prompt système et à la vue partagée (`min-h-app-full`).

Non-bug constaté : « Hermes 4 70B (démo) » (carte de statut = défaut du service,
`DEFAULT_MODEL_ID`) vs « Hermes 4 405B » (sélecteur = sélection persistée de
l'utilisatrice) — deux vérités distinctes, aucune correction.

QA : re-mesures après correctifs (wrapper 1280×1080 ✓, rail 0→208 pleine hauteur ✓,
contenu x=208/y=0 ✓, × à y=16 ✓, composer y≈932 ✓) + captures VLM
`download/qa-layout-fixes/` (1280×1080 et 900×800) ; `bunx tsc --noEmit` 0 erreur
`src/` ; eslint propre. NB poste Windows : après `git pull`, effacer `.next/` pour que
le lanceur reconstruise le build de production au prochain double-clic.

## Chantier du 2026-11-13 (treizième session) — F-17 « Comparaison de modèles »

Le dernier gros chantier UI de la roadmap. Un message → deux modèles → deux réponses
côte à côte ; chaque modèle poursuit le fil comme un dialogue bilatéral (il ne voit
jamais les réponses de l'autre variante).

- **Service** : `compare?: string[]` sur `chat:send`/`chat:regenerate`/`message:edit`
  (exactement deux ids distincts, refus propre sinon) ; colonne additive
  `messages.variant` (`a`/`b`, transportée append/gets/fork) ; événements `stream:*`
  portant `variant` (ignoré quand absent — clients antérieurs compatibles) ; tours sous
  les clés `conv`/`conv:a`/`conv:b` (`isRunning`/`abortRunning`, `chat:stop` coupe tout,
  gardes anti-tour couvrant les trois clés) ; régénération d'un seul côté
  (`deleteTrailingAssistant(conv, variant)`).
- **Client** : `streams` en map par messageId (`streaming` = première entrée, gardes
  inchangés) ; `buildRows`/`ComparePair` (grille 2 colonnes ≥ 768 px, badges A/B +
  modèle, bouton régénérer par côté, placeholder « Réponse en attente ») ; toggle
  « Comparer » + pickers A/B compacts (`slotLabel`/`bare`) dans le composer ; paire
  mémorisée `hermes.compare.models` (§6) ; édition d'un message utilisateur relance
  les deux côtés.
- **QA** : `scripts/test-compare-flow.ts` **33/33** (payloads invalides refusés ; tour
  complet : 1 user + 2 assistant tagués à modèles distincts ; régén côté a seul — b
  intact au même id ; gardes pendant le vol ; stop des deux côtés puis tour simple
  accepté sans variante ; fork transportant les variantes ; édition relançant les
  deux). Visuelle : `scripts/qa-compare-visual.ts` via Caddy (app connectée) —
  2 colonnes de 354 px, réponses réelles distinctes, contrôle VLM sans anomalie
  (captures `download/qa-f17-compare/`). `bunx tsc --noEmit` 0 erreur `src/` ;
  eslint propre.
- **Piège QA documenté** : le socket client passe par `/?XTransformPort=3003` → il faut
  Caddy (port 81) pour une app connectée ; sur :3000 direct, l'app reste « Hors ligne ».

## Chantier du 2026-11-13 (quatorzième session) — F-14 « Navigation entre versions »

Régénérer détruisait l'ancienne réponse. Désormais chaque régénération crée une
**nouvelle version conservée** ; le fil affiche la version active avec un
sélecteur ‹ index/count ›, et la version choisie est celle envoyée au modèle
au tour suivant. Fonctionne par côté de comparaison (F-17) : régénérer A ne
touche ni les versions de B ni sa réponse affichée.

- **Service** : colonnes additives `messages.version_group/index/active`
  (retro-complétion à la première régénération) ; `getMessages` ne renvoie que
  les versions actives, enrichies de la meta `versions {group,index,count}` ;
  `supersedeTrailingAssistant` remplace la suppression (traverse l'autre
  variante, s'arrête au message utilisateur) ; `message:setVersion` bascule la
  version active et rediffuse le fil (`messages:refreshed`) ; `messages:superseded`
  signale les remplacements ; suppression d'une version active → promotion de la
  plus récente restante ; fork = instantané du chemin actif (sans meta versions).
- **Client** : sélecteur ‹ n/m › toujours visible dans la bulle (bornes
  désactivées pendant un tour) ; hook `setMessageVersion` + listeners
  `messages:superseded`/`messages:refreshed` (multi-sessions) ; garde défensive
  dans `regenerate` (un `onClick` direct transmet l'événement React en premier
  argument — seul `"a"`/`"b"` compte).
- **QA** : `scripts/test-version-flow.ts` **21/21** (supersession vs suppression,
  meta n/m, bascule + hors bornes, versions par côté de comparaison avec
  traversée de l'autre variante, promotion après suppression, gardes) ; visuelle
  `scripts/qa-versions-visual.ts` (‹ 2/2 › après régénération → ‹ 1/2 › au clic,
  VLM sans anomalie — captures `download/qa-f14-versions/`) ; tsc 0 erreur
  `src/` ; eslint propre (au passage : init paresseuse du réglage
  « afficher le raisonnement » dans `message-bubble`, `set-state-in-effect`).

## Ordre de démarrage recommandé (suite)

1. ~~Valider le volet v4 implémenté~~ **premiers retours intégrés le 2026-11-14**
   (fixes layout ci-dessus) ; re-validation visuelle sur le poste de l'utilisatrice
   après `git pull` + effacement de `.next/`.
2. ~~F-11 + F-19~~ **livrés le 2026-11-13** (ci-dessus).
3. ~~F-13~~ **livré le 2026-11-13** (ci-dessus).
4. ~~F-24~~ **livré le 2026-11-13** (ci-dessus).
5. ~~F-18~~ **livré le 2026-11-13** (ci-dessus).
6. **F-09 / F-12** (toggles capacités, citations) — bloqués sur les toolsets du moteur ;
   à revoir une fois la gateway branchée (les clés de services sont désormais gérées
   dans le volet Paramètres).
7. **F-21** (coût par message) reste le seul « Partiel » améliorable ;
   ~~**F-17** (comparaison modèles)~~ et ~~**F-14** (navigation versions)~~
   **livrés le 2026-11-13** (ci-dessus).

## Notes de passation

- Les statuts ci-dessus ont été vérifiés **dans le code** le 2026-11-13 (audit complet :
  hook, service, store, composer, sidebar, bulles, palette, sheet paramètres). En cas de
  doute, `git log --oneline` + les fichiers cités font foi.
- Convention de nommage git : commits propres « un par chantier » sur `publish`, poussés vers
  `main` distant (recette complète dans FORK.md §10).
