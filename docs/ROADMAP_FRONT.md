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
| F-09 | **Toggles capacités** | Recherche web / agent / images — 1 clic depuis le composer | **Partiel** | Livré le 2026-11-14 : toggle « Web » (recherche Tavily/Exa via le porte-clés, résultats injectés + citations) ; « Image » et « Agent » verrouillés « nécessite la gateway » (moteur réel) — à débloquer au branchement |

### P1 — Vite après

| ID | Feature | Critères | Statut | Preuve / écart |
|----|---------|----------|--------|----------------|
| F-10 | **Slash commands** | `/traduire`, `/résumer` + templates | **Terminé** | `prompt-library.ts` + suggestions `/` du composer (Tab/Entrée pour appliquer) |
| F-11 | **Prompt système / conversation** | Panneau, presets | **Terminé** | Livré le 2026-11-13 : panneau d'édition par conversation (sheet 460 px, bouton « prompt » de l'en-tête), bibliothèque de presets éditables (section Hermes du volet, 5 seeds), table additive `system_prompts`, événements `system-prompt:*` / `system-prompts:*`, effet au prochain tour (composé base + F-19 + F-11 côté service, `system_prompt` dans `api_turn_v1.settings` en gateway), jauge de contexte + pastille d'en-tête |
| F-12 | **Citations web** | Sources cliquables | **Terminé (démo)** | Livré le 2026-11-14 : résultats numérotés [n] injectés dans le contexte du tour avec consigne de citation, rangée « Sources : » cliquable sous la réponse, persistance `messages.sources` ; en gateway, le browsing est géré par l'agent Hermes lui-même |
| F-13 | **Partage / export** | Lien public ; export MD/PDF/image | **Terminé** | Livré le 2026-11-13 : lien public lecture seule `/shared/<token>` (snapshot **figé** à la création, table additive `shares`, token opaque 24 car., un seul lien actif par conversation), menu « Partager » de l'en-tête (copie, ouverture de la vue publique, révocation → 410 Gone), export **image PNG plein page du fil** (pipeline chrome-headless-shell), `data.json` public sans id interne, page `noindex`. Export local MD/JSON/PDF livré précédemment (`export.ts`). |
| F-14 | **Édition avec branchement** | Éditer crée une branche ; navigation versions | **Terminé** (volet versions) | Livré le 2026-11-13 : régénérer ne supprime plus — chaque réponse a des versions conservées, navigation ‹ n/m › dans le fil (version affichée = version envoyée au modèle), par côté en comparaison ; suppression d'une version = promotion de la précédente. Choix documenté : l'édition d'un message utilisateur reste « fork explicite » (bouton Branche) plutôt qu'un arbre de branches implicites. |
| F-15 | **Panneau artefacts** | HTML/graphiques en panneau latéral | **Terminé** | `artifact-panel.tsx` : split view ≈ 45 %, rendus code/MD/CSV/JSON/SVG/PDF/HTML (pipeline Chrome), versioning + diff |

### P2 — Différenciateurs

| ID | Feature | Critères | Statut | Preuve / écart |
|----|---------|----------|--------|----------------|
| F-16 | **Voix** | Dictée STT + lecture TTS | **Terminé** | Dictée `use-dictation.ts` + `asr.ts` ; TTS « Écouter » par message (`useSpeech`). **Lecture continue pendant le stream livrée le 2026-11-14 (v2.4)** : bouton « Lire en continu » dans la bulle vivante (`useContinuousSpeech` — phrases complètes au fil de l'eau, file speechSynthesis, coupure = silence). |
| F-17 | **Comparaison modèles** | 2 modèles côte à côte | **Terminé** | Livré le 2026-11-13 : variantes `a`/`b` en base (`messages.variant`), protocole `compare` sur send/regenerate/edit + `variant` dans les `stream:*`, chaque modèle ne voit que ses réponses ; colonnes A/B côte à côte (empilées < 768 px) avec régénération par côté ; toggle « Comparer » + pickers A/B du composer ; paire mémorisée `hermes.compare.models`. QA 33/33 + visuelle. |
| F-18 | **Mémoire utilisateur** | Consultable, éditable, effaçable | **Terminé** | Livré le 2026-11-13 : carte « Mémoire » de la section Hermes du volet (toggle activer/désactiver, apprentissage automatique, éditeur 12 000 car., effacement) ; clés `hermes.memory.{enabled,autoLearn,notes}` (table `settings`, fallback actif), événements `memory:*` + broadcast ; composition des instructions du tour par le service (démo : section « Mémoire de l'utilisateur » ; gateway : `memory_notes`/`memory_auto_learn` dans `api_turn_v1.settings`, clés à valider) ; `hello.memoryChars` honnête. |
| F-19 | **Instructions personnalisées** | Globales | **Terminé** | Livré le 2026-11-13 avec F-11 (même chantier) : instructions globales persistées côté service (`hermes.instructions.custom`, table `settings`), éditeur dans la section Hermes du volet, appliquées à toutes les conversations, transmises dans `api_turn_v1.settings` en gateway |
| F-20 | **Projets/dossiers** | Contexte par groupe | **Terminé** | UI projets (FORK.md §7.2) — rangement seul ; le contexte persistant par projet viendra des fichiers .md moteur |

### P3 — Plus tard

| ID | Feature | Critères | Statut | Preuve / écart |
|----|---------|----------|--------|----------------|
| F-21 | **Compteur tokens/coût** | Par message, repliable | **Terminé** | Livré le 2026-11-14 : usage réel persisté quand l'API le renvoie (`messages.usage_input/output/cost`), tarifs déclarés par l'utilisatrice (`hermes.pricing`, jamais pré-remplis — le fournisseur fait foi), carte repliable par bulle — coût facturé (OpenRouter) > estimé selon tarifs > « tarifs non renseignés » ; estimation ~ en repli sans usage réel. Jauge de contexte + popover par poste (`tokens.ts`) inchangés. |
| F-22 | **Mode expert** | Température, max tokens, seed | **Terminé** | Livré le 2026-11-13 (douzième session, suite) : section repliable « Mode expert » dans le popover du sélecteur (température curseur **0–1** — le moteur démo rejette au-delà, erreur 1210 vérifiée ; plafond 1–8192 ; graine 32 bits) ; registre `hermes.expert.*` + payloads `chat:send`/`regenerate`/`edit` ; `sanitizeExpertSettings` côté service (clamps, non-numériques ignorés) ; injectés au LLM démo **pour de vrai** (`maxTokens=3` → « Le renard », troncation vérifiée) et transmis dans `api_turn_v1.settings` en gateway. QA `test-expert-flow.ts` 14/14. |
| F-23 | **Raccourcis clavier** | Nouveau chat, recherche, focus composer | **Terminé** | Cmd/Ctrl+K palette (nouveau chat, stop, régénérer, épingler, exports, modèles, recherche), Cmd/Ctrl+Maj+O nouveau chat, Échap = stop / fermer panneau |
| F-24 | **Feedback intégré** | 👍/👎 + commentaire | **Retiré** | Livré le 2026-11-13 (boutons 👍/👎 + popover commentaire, événement `feedback:set` + broadcast `feedback:changed`). **Retiré le 2026-11-16** à la demande de l'utilisatrice (« retire features bonnes et mauvaises réponses ») pendant l'épuration des rangées d'actions en icônes seules — journal (36) ; §7.9 consigne le retrait. |

### Divers

| ID | Feature | Statut | Preuve |
|----|---------|--------|--------|
| F-25 | **Page Paramètres** | **Terminé (phase 3 — v2.4 : les 10 sections du rail sont réelles)** | Volet 860 px à rail (maquette v4, `settings-panel.tsx`). Phases : 1 = sheet 460 px (`004b388`) ; 2 = volet + Fournisseurs & clés + Extensions (test réseau réel) + Hermes (presets, instructions, mémoire) + Modèles (tarifs) ; **3 = v2.4 : Outils (statuts réels, « gateway » jamais simulé), Skills (état vide honnête + liens croisés), Profils (création/application/duplication, liste côté service), Système (révision git, chrome-headless, cache des rendus, purge), Hermes « Conversations longues » (résumé automatique + seuil)**. Navigation interne du volet par liens croisés. |
| F-26 | **Versionnage fichiers** | Journal de versions par fichier, restaurable | **Terminé** | Livré le 2026-11-15 (FORK.md §7.12) : le badge `v{n}` de la carte ouvre le **journal des versions** (`version-popover.tsx`, composant unique) — étoile (épinglée, jamais purgée), ↩ (née d'une restauration), étiquette inline (double-clic), restauration = v(n+1) copiée (jamais d'écrasement, toast sans dialogue), téléchargement par version ; automatique (naissance/changement, ré-émission identique ignorée, une version par tour), quota 50/fichier FIFO non épinglées + 10 épingles max (colonnes additives `artifacts.label/pinned/restored_from`, événements `artifact:restore/label/pin`). QA `test-versions-flow.ts` 21/21 + navigateur (captures `download/qa-f26/`). |
| F-27 | **Chats IA web (fournisseur `webchat`)** | Piloter z.ai / AI Studio / gemini.google.com dans un vrai navigateur | **Terminé (code) — preuve E2E à faire sur machine connectée** | Livré le 2026-11-16 (FORK.md §7 (42), spec `upload/pilotage-chats-ia-web.md`) : sélecteurs en DONNÉES (3 fiches, `verifie` fait foi — gemini-app indisponible, pastille + clic no-op), verrou mono-pilote (reprise d'un mort), garde de chemin (`../` refusé, jamais écrit), client CDP minimal, pilotes sous-processus (contrat : 1 ligne JSON stdout, échec franc au plafond), veilleur d'inactivité ; model picker : groupe « Chats IA web » à part, effort/expert remplacés par les limitations (§6) ; section Paramètres « Chats web » (statut réel, ouvrir le navigateur pour se connecter une fois à la main, réglages `fork.webchat.*`). QA `test-webchat-flow.ts` 34/34 ; tsc/eslint/build OK. Reste : critères §7.1/§7.2 sur sessions réelles. |

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

## Chantier du 2026-11-14 — v2.3 « le moteur démo consomme les clés fournisseurs »

Réponse à la demande de l'utilisatrice : après ajout d'une clé z.ai (testée positive),
les modèles n'apparaissaient pas dans le sélecteur et l'envoi échouait
(« .z-ai-config ») — le moteur démo parlait au SDK du bac à sable, ignorait
le porte-clés. Désormais, en mode démo, les tours partent sur l'API du
fournisseur à clé active et le sélecteur devient vivant.

- **Service** (`llm-pool.ts` nouveau) : `pickActiveKey`/`markKeyUsed` enfin
  consommés ; OpenAI-compatible (z.ai, OpenRouter, Mistral, OpenAI, DeepSeek,
  Groq, Ollama keyless, personnalisés) + adaptateur Anthropic ; 401/429 → clé
  déclassée puis retente ; usage capturé passivement ; retente vision
  automatique ; compaction via le pool ; erreur SDK « .z-ai-config » rendue
  pédagogique. Connecteur : `attachPool`/`invalidateModels`, `TurnOutcome
  {engine, provider, usage}` ; broadcast `models:changed` sur toute mutation
  du porte-clés ; message persisté « modèle · fournisseur ».
- **Client** : `models:list` source `"providers"` (groupes par fournisseur,
  pied honnête), alignement de la sélection sur `defaultModel`, hook
  `models:changed`, `modelIdFromLabel` tolère le suffixe fournisseur.
- **QA** `scripts/test-pool-flow.ts` **24/24** via faux serveur local
  (listes vivantes, filtrage non-chat, clé refusée → déclassement + erreur
  claire sans repli silencieux, tour streamé, stop en plein vol, retente
  vision, repli catalogue/SDK sans fournisseur).

## Chantier du 2026-11-14 — F-21 « jetons & coût par message »

- **Service** : colonnes additives `messages.usage_input/output/cost`
  transportées (append/get/fork + partiel d'erreur), miroir `ChatMessage.usage`.
- **Client** : `src/lib/pricing.ts` (libellés « id · fournisseur », coûts,
  formats $), hook `use-pricing` (abonnement socket unique partagé), carte
  repliable sous chaque réponse, bloc « Tarifs des modèles » du volet
  (`hermes.pricing` — jamais pré-remplis, le fournisseur fait foi).
- **QA** `scripts/test-cost-flow.ts` **21/21**.

## Chantier du 2026-11-14 — F-09/F-12 « recherche web + citations »

- **Service** (`web-search.ts` nouveau) : recherche via la première clé
  Tavily/Exa, événement outil « Recherche web » running → done/error,
  injection en fin de prompt système du tour démo (consigne [n]),
  `messages.sources` persistées ; best effort (échec ≠ tour échoué) ; en
  gateway : événement explicatif, aucune injection. `providers:add` accepte
  une adresse explicite (`baseUrl`).
- **Client** : toggle « Web » du composer (selon disponibilité d'une clé ;
  Image/Agent verrouillés « nécessite la gateway »), état `hermes.tools.web`,
  `SourcesRow` cliquable.
- **QA** `scripts/test-web-flow.ts` **14/14**.

## Chantier du 2026-11-14 (v2.4) — « le volet devient réel : sections moteur, profils, résumé automatique »

Réponse à « lance ce chantier et tous les autres » : la feuille de route ne laissait plus que
la « découverte moteur » (point 8 de l'ordre recommandé) et l'option F-16. Tout est livré
en statuts RÉELS — la partie moteur dépendante de la gateway reste verrouillée
« gateway », jamais simulée.

- **Volet (10/10 sections)** : Outils (statuts réels — Web suit les clés de services, voix et
  vision livrées, le reste « gateway »), Skills (état vide honnête + liens croisés vers les
  presets et les imports), Profils (création depuis les réglages courants, application par le
  bus `hermes-ui:settings-changed`, duplication, suppression ; liste côté service sous
  `hermes.profiles`, `src/lib/profiles.ts` + `use-profiles`), Système (révision git du déploiement,
  binaire chrome-headless, place des profils de rendu + purge `system:renderCache`/
  `system:clearRenderCache`, moteur verrouillé « gateway »).
- **Hermes — Conversations longues** : résumé automatique avant le tour (décision pure
  `src/lib/compaction.ts` — même mesure que la jauge : base + brouillon contre la fenêtre),
  seuil 50–95 %, fenêtre suivie/estimée ; exécution par l'événement `conversation:compact`
  existant, puis envoi du tour. Best effort (échec/timeout 60 s → le tour part quand même).
- **Contrat `conversation:compact` (v2.4)** : UN SEUL ack, À LA FIN, avec le compact
  (`{ok:true, compact, done:true}`) — l'ack « started » intermédiaire a été retiré :
  socket.io n'accepte qu'un ack par requête (le second appel, même id, est ignoré par le
  client — piège QA documenté). Échec : `{ok:false, error}`.
- **Correctif de persistance du registre** : `hermes.tools.web` (F-09) et `hermes.compare.models`
  (F-17) étaient écrits via `writeClientSetting`, qui ignore silencieusement les clés hors
  registre — la persistance documentée ne fonctionnait pas (réglages perdus au rechargement).
  Les deux clés sont maintenant au registre (aucune ligne d'interface ne les liste).
- **F-16 lecture continue** : `useContinuousSpeech` dans la bulle vivante — phrases complètes
  au fil de l'eau (file speechSynthesis), courtes ignorées, blocs de code lus « bloc de code »,
  plafond 4 000 caractères, coupure = silence immédiat.
- **§8 — retrait du boilerplate Prisma** : `prisma/`, `db:*`, `@prisma/client`, génération du
  client dans le lanceur Windows et mentions des README supprimés (la persistance réelle est
  `bun:sqlite`, `store.ts` — inchangée).
- **QA** : `test-autocompact.ts` (unitaire, bornes/frontières), `test-profiles-flow.ts` (lib +
  service + sondes hello), `qa-v24-dom.ts` **40/40** (volet, profils, F-16, et chemin COMPLET de
  la compaction automatique prouvé par le journal d'un faux fournisseur : synthèse avant le
  tour, résumé en tête d'historique, message porté, toast v2.4, broadcast à un 3e client).
  Repassé : providers 29/29, pool 24/24, coût 21/21, web 14/14, compare 33/33, version 21/21,
  stop/error, mémoire, prompt système, feedback, expert, partage, intégration — tous verts
  (les échecs initiaux share/expert/intégration étaient le rate-limit 429 z.ai transitoire,
  §9 (20) — repassés avec espacement).

## Chantier du 2026-11-15 — F-26 « Versionnage fichiers depuis le chat »

Conception validée par l'utilisatrice en trois passes (modèle, zones d'ombre, UI), puis
« go ». Le besoin : **remonter à une version antérieure d'un fichier de travail** — pas
de git par projet, un journal de versions automatique suffit et reste 100 % portable.

Décision structurante : **fusion avec le journal artefacts** plutôt qu'un store parallèle
(`db/versions/` écarté). La table `artifacts` était déjà immuable une-ligne-par-version :
F-26 y ajoute la couche humaine (`label`, `pinned`, `restored_from` — migration additive)
et le composant unique `version-popover.tsx` (badge de la carte = seule porte).

Règles : ré-émission identique de la version courante → pas de version ; une seule
version par tour ; restauration = v(n+1) copiée avec libellé auto et marqueur ↩ ; quota
50/fichier, purge FIFO des non épinglées, 10 épingles max ; fork et suppression suivent
le journal. Le panneau artefact (sélecteur, diff) reste inchangé.

QA : `scripts/test-versions-flow.ts` 21/21 ; navigateur de bout en bout sur :81
(badge → journal → étiquette inline → étoile → restauration → toast « v4 créée d'après
v1 » → badge v4 + ↩ « Restauration de v1 »), captures `download/qa-f26/`.

## Ordre de démarrage recommandé (suite)

1. ~~Valider le volet v4 implémenté~~ **premiers retours intégrés le 2026-11-14**
   (fixes layout ci-dessus) ; re-validation visuelle sur le poste de l'utilisatrice
   après `git pull` + effacement de `.next/`.
2. ~~F-11 + F-19~~ **livrés le 2026-11-13** (ci-dessus).
3. ~~F-13~~ **livré le 2026-11-13** (ci-dessus).
4. ~~F-24~~ **livré le 2026-11-13** (ci-dessus).
5. ~~F-18~~ **livré le 2026-11-13** (ci-dessus).
6. ~~**F-09 / F-12**~~ **livrés le 2026-11-14** en démo via les clés de services
   (recherche web + citations) ; « Image » et « Agent » attendent la gateway.
7. ~~**F-21** (coût par message)~~ **livré le 2026-11-14** ;
   ~~**F-17** (comparaison modèles)~~ et ~~**F-14** (navigation versions)~~
   **livrés le 2026-11-13** (ci-dessus).
8. ~~**v2.3 découverte moteur** (Outils, Skills, Hermes .md, Profils, Système)~~
   **livré le 2026-11-14 en v2.4** (ci-dessus) : tout ce qui peut être réel l'est ;
   restent « gateway » par conception — fichiers .md moteur, comportement (initiatives,
   tâches planifiées), génération d'images/vidéo, navigateur, exécution de code.
   ~~la lecture continue pendant le stream (F-16)~~ **livrée le 2026-11-14 (v2.4)**.
9. ~~**F-26** (versionnage fichiers)~~ **livré le 2026-11-15** (ci-dessus).

## Notes de passation

- Les statuts ci-dessus ont été vérifiés **dans le code** le 2026-11-13 (audit complet :
  hook, service, store, composer, sidebar, bulles, palette, sheet paramètres). En cas de
  doute, `git log --oneline` + les fichiers cités font foi.
- Convention de nommage git : commits propres « un par chantier » sur `publish`, poussés vers
  `main` distant (recette complète dans FORK.md §10).
| F-28 | **Artefact dans un nouvel onglet** | Icône « ouvrir dans un nouvel onglet » sur la carte et le panneau | **Terminé** | Livré le 2026-11-16 (FORK.md §7.13) : route `GET /artifacts/<id>/view` — HTML servi RENDU (`text/html`) derrière un CSP `sandbox` (origine opaque, garde-fous XSS de `/raw` et `/download` intacts) ; `viewUrl` dans le payload wire (html seul) ; `openArtifactInTab()` ; icône `ExternalLink` sur la carte (l'ancien bouton qui doublait le clic carte devient l'action nouvelle) + en-tête panneau/visionneuse (désactivée hors `ready`). QA `probe-artifact-view.ts` 16/16 + navigateur (`qa-proxy.ts`, captures `download/qa-f28/`). |
| F-29 | **Terminal du tour dans le panneau artefacts** | Encart repliable en bas : l'activité outil du tour qui porte l'artefact | **Terminé** | Livré le 2026-11-16 (FORK.md §7.13) : `artifact-terminal.tsx` (composant unique panneau bureau + visionneuse mobile) — stream vivant d'abord (`streams[messageId]`), message persisté ensuite (`toolEvents`) ; barre fine (point pulsant si vivant, « N étapes » sinon), console sombre heure/statut/nom/détail collée au bas ; s'ouvre seule quand le tour vit (repli manuel respecté), **absente sans données** ; clé = messageId ; `resolveTurnTools` fourni par la page ; ouverture auto via « état dérivé pendant le rendu » (règle `set-state-in-effect`). QA navigateur (déplié : lignes horodatées, statuts). |
| F-30 | **Modes du compositeur** | 7 modes dans le sélecteur (chat · plan · code · comparer · débat · conseil · auto), « qui travaille », déroulé dans la conversation, section Paramètres | **Terminé** | Livré le 2026-11-17 (FORK.md §7.14) : maquettes validées avant implémentation (`maquette-modes.html`, `maquette-parametres-modes.html`) ; Comparer devient un mode (bascule retirée, mécanisme F-17 conservé) ; le service fait foi (`conversations:setMode`, mode relu à chaque envoi, valeur inconnue → chat) ; orchestrateur débat/conseil/auto — une seule réponse conservée (verdict / fusion / bilan), déroulé vivant puis persisté ; 13 consignes éditables dans Paramètres (surcharges `hermes.modes.prompts` côté service, effet au prochain message) ; défauts au registre (`hermes.modes.*`). QA `scripts/test-modes-flow.ts` 70/70 (unitaires faux moteur + service réel) + navigateur (tour conseil réel via fake-gateway, déroulé vivant, Paramètres vérifiés en base). |
| F-30b | **Un modèle de chat web IA pour chaque mode** | Chaque voix (Comparer/Débat/Conseil/Auto) et chaque mode simple (Chat/Plan/Code) peut tourner sur un chat IA web (z.ai, AI Studio) | **Terminé** | Livré le 2026-11-17 (FORK.md §7.15) : listes de modèles à deux groupes (moteur + « Chats IA web — pilotage navigateur », composant partagé `model-choice-list.tsx`) dans « qui travaille » et Paramètres ; ligne « Modèle du mode » pour chat/plan/code (`mode_config.model` normalisé côté service, défauts au registre `hermes.modes.models`) ; l'orchestrateur route les voix webchat vers le pilote (`runWebchatTurn`, consigne prépendée au message, chip du déroulé = site) ; corrections au passage : consigne `compare.main` morte depuis F-30 (part désormais sur chaque colonne) et consigne de mode perdue sur un tour webchat. QA `scripts/test-modes-flow.ts` 82/82. |

| F-59 | **Dossiers imbriqués + liaison disque** | Sous-dossiers à un niveau dans la sidebar (maquette v6 validée) : menu « Nouveau dossier » en tête, dépliage avec règle verticale, compteur direct, actif sans bordure, fil d’Ariane « dossier › sous-dossier › conversation », recherche dans les noms de dossiers, 📁↓ lie un dossier du disque (HOME borné, rien n’est lu) | **Terminé** | Livré le 2026-11-22 (FORK.md §9, entrée 2026-11-22 — ré-application après perte du bac à sable) : protocole `Project.parentId/diskPath` d’abord, migrations additives `parent_id`+index+`disk_path`, suppression en transaction avec **promotion des sous-dossiers** (jamais de cascade), `projects:delete` diffuse la liste complète, positions globales conservées (drag entre frères, liste plate reconstruite depuis l’arbre) ; nouveaux fichiers `src/lib/project-tree.ts`, `sidebar-section-header.tsx`, `project-subgroup.tsx`, `attach-disk-dialog.tsx` + endpoint `GET /disk/list` (jeton, realpath, borne HOME). QA : `test-project-tree.ts` 16/16 autonome (attrape un vrai bug de tri), `test-projects-nested-flow.ts` 24/24 E2E, `qa-projects-dom.ts` 22/22 Playwright (première QA DOM de la sidebar), captures `download/qa-f59/` ; tsc ×3, eslint, suite autonome 29/29, build OK, `--e2e` 39/53 avec échecs préexistants vérifiés par baseline. |

| F-60 | **Bibliothèque — archivage des dossiers** | « Archiver le dossier » dans les menus : sort le dossier (et son sous-arbre) de la liste active SANS rien effacer ; section « Bibliothèque » repliée en bas de sidebar (compteur, sous-dossiers préfixés « Parent › », Désarchiver, Supprimer avec garde) ; conversations archivées intactes et hors recherche | **Terminé** | Livré le 2026-11-22 (FORK.md §9, entrée 2026-11-22 (2)) : migration douce `projects.archived` (R2), `setProjectArchived` propagé au sous-arbre, handler `projects:setArchived` + broadcast `projects:updated` (liste complète, un seul événement) ; `sidebar-bibliotheque.tsx` (R1) repliée par défaut (`fork.bibliotheque.collapsed`, R5) ; arbre actif et recherche excluent les archivés. QA : `test-projects-archive-flow.ts` 19/19 E2E, `qa-projects-dom.ts` 29/29, tsc ×3, eslint, suite 29/29, build OK, E2E 40/54 (baseline préexistante vérifiée) ; capture `download/qa-f59/sidebar-bibliotheque.jpg`. |

| F-61 | **Sidebar : Archives, masquage, densité** | Renommage Bibliothèque → Archives (réglage avec legacyKeys) · icône d’en-tête qui masque/réaffiche la sidebar bureau (`fork.sidebar.hidden`) · indentations resserrées (46→30, 26→20 px) | **Terminé** | Livré le 2026-11-22 (FORK.md §9, entrée 2026-11-22 (3)) ; QA DOM 32/32, suite 29/29, E2E 40/54 (baseline), captures mises à jour. |
