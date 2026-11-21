# Audit — Page « Paramètres » (hermes_ui)

**Date** : 21 novembre 2026 · **Dépôt** : `auriannedrumont-eng/hermes_ui` @ `e51adcb`
**Périmètre** : le volet Paramètres au complet — `src/components/settings/` (18 fichiers, ≈ 7 000 lignes), les hooks d'état associés (`use-providers`, `use-pricing`, `use-memory`, `use-profiles`, `use-system-prompts`, `use-chat-settings`), `src/lib/settings.ts`, et le comportement à l'exécution.

**Méthode** :
1. lecture intégrale du code des 11 sections + transversal, chaque suspicion vérifiée dans son contexte d'usage (côté client **et** côté service `mini-services/hermes-chat`) ;
2. exécution réelle : `bun dev` sur `localhost:3000`, parcours des 11 sections au navigateur (desktop 1280 px **et mobile 375 px**), service mini-chat hors ligne — ce qui a permis d'observer les états dégradés réels ;
3. `tsc --noEmit` passe, aucune erreur JS en console pendant la navigation.

---

## 1. Synthèse

Le volet Paramètres est **architecturalement sain** : registre typé unique avec validation à la lecture et à l'écriture, navigation à 11 sections fluide, accessibilité globalement au-dessus de la moyenne (aria-labels, focus visible, navigation clavier Radix), secrets API jamais exposés, anti double-clic correct sur la plupart des boutons lents. Aucune erreur JavaScript en console, aucun défaut bloquant à l'affichage.

En revanche, la **fiabilité des écritures est inégale et c'est le vrai point faible du volet** : trois familles de défauts se retrouvent dans presque toutes les sections —

- **Écritures possibles avant chargement** → écrasement silencieux de données réelles par des valeurs par défaut (profils, tarifs, chats web) ;
- **Émissions socket sans chien de garde** (pas de timeout sur les acks) → boutons figés « en cours » pour toujours, états de chargement infinis, échecs jamais signalés ;
- **Actions destructives en un clic** sans confirmation (fournisseur + ses clés, clé, extension, preset, profil) alors que le dépôt possède `ConfirmDestructiveDialog` et l'utilise déjà ailleurs.

S'y ajoute un **défaut responsive majeur** : à 375 px, les lignes de réglage s'écrasent (description réduite à un mot par ligne) et le bouton ✕ chevauche le rail horizontal.

| Sévérité | Nombre | Exemples phares |
|---|---|---|
| Bloquant | 1 | Liste de profils écrasée par écriture prématurée |
| Majeur | 18 | Tarifs écrasés au chargement · debounce annulé → saisies perdues · « enregistré » mensonger · boutons figés sans timeout · suppressions sans confirmation · mobile cassé |
| Mineur | 32 | « Off » en anglais · textes codés en dur · classes Tailwind mortes · aria manquants · formats d'affichage |

---

## 2. Les 10 défauts à corriger en premier

1. **Profils — écrasement de toute la liste (bloquant)** — `profiles-section.tsx:47-53,64` : créer/dupliquer/supprimer fait un read-modify-write de `hermes.profiles` depuis l'instantané client, avec ack vide `() => {}`. Si la création part avant que le `settings:get` initial ait répondu (liste locale encore `[]`), la liste serveur est remplacée par un profil unique : **perte de tous les profils**, sans erreur. Aggravé par `parseProfiles` qui rend `[]` sur JSON corrompu, et par l'état vide « Aucun profil » affiché avant le chargement qui invite précisément à cette action.
2. **Chats web — la config réelle peut être écrasée par les défauts** — `webchat-section.tsx:54-97,163-169` : si la socket est down à l'ouverture, `Promise.all` ne résout jamais, les champs affichent les valeurs par défaut comme si c'étaient la config réelle ; au premier « Enregistrer », `saveAll` réécrit les 5 clés, dont celles jamais chargées. **Constaté en direct : « Chargement des fiches… » reste affiché à l'infini** sans timeout ni message d'erreur.
3. **Modèles — race d'écrasement des tarifs** — `models-section.tsx:93` + `use-pricing.ts:11` : le hook expose `{}` tant que le premier `settings:get` n'a pas répondu ; ajouter ou supprimer un tarif pendant ce fenêtrage écrit une map ne contenant que la nouvelle entrée — **tous les tarifs existants disparaissent définitivement**, sans erreur ni toast.
4. **Boutons async figés pour toujours (transversal)** — `use-providers.ts:109-117` : le `emit` ne résout que sur ack, sans timeout ni rejet. Socket coupée = `addingKey`, `testing`, `busy`, `savingBase` bloqués à vie, spinner figé, aucune récupération hors remontage. **Constaté en direct dans Système : le bouton reste sur « Vérification… » indéfiniment** (alors que `storage-section.tsx:189-199` a précisément ajouté un chien de garde 8 s pour la même classe de problème — le motif existe, il n'a pas été généralisé).
5. **Modes de chat — saisies perdues en silence** — `modes-section.tsx:628-633` : le debounce de sauvegarde des consignes est **annulé (clearTimeout) au démontage au lieu d'être flushé** : changer de section ou fermer le volet dans les 300 ms suivant une frappe détruit l'édition. Et `modes-section.tsx:625,895` : les échecs de `saveServerPrompts`/`saveVoiceChars` sont ignorés (`void`, booléen de retour non testé) — l'UI affiche la valeur éditée comme enregistrée, perdue au rechargement. Le correctif équivalent existe dans Modèles (toast « Tarifs non enregistrés »), jamais porté ici.
6. **Suppressions destructives sans confirmation (5 endroits)** — fournisseur **et toutes ses clés** en un clic (`providers-section.tsx:177-178`), clé (`:168-169`), extension (`extensions-section.tsx:114-115`), preset (`hermes-section.tsx:415-424`), profil (`profiles-section.tsx:80-83`) — alors que `src/components/shared/confirm-destructive-dialog.tsx` (« toute action qui détruit du contenu passe par ce dialogue ») est utilisé dans 6 autres composants du dépôt (mémoire, conversations, projets).
7. **Prompt de conversation — faux « enregistré » + perte de brouillon** — `system-prompt-panel.tsx:130-133` : `dirty` est réinitialisé sans attendre le résultat de la sauvegarde (fire-and-forget, résolutions `null`/ack muets sans toast) → le badge « Non enregistré » disparaît alors que rien n'a été persisté. `:66-68` : le corps est remonté à chaque ouverture → un brouillon non enregistré est **détruit à la fermeture du volet** sans garde ; `:68` : un broadcast `system-prompt:changed` pendant l'édition remonte le composant et écrase la saisie en cours.
8. **Mobile (≤ ~430 px) — lignes de réglage illisibles** — `SettingRow` (rapatrié dans chaque section) : le texte en `flex-1 min-w-0` peut se comprimer indéfiniment au profit du contrôle. À 375 px, « Modèle de conversation » s'affiche en colonne d'un mot par ligne pendant que le Select garde ~250 px (constaté sur Interface, Modèles, Modes). Deuxième collision : le ✕ du Sheet (`sheet.tsx:75`, `absolute top-4 right-4`) se superpose au dernier libellé du rail devenu horizontal (`max-[1100px]:flex-row`).
9. **Doublons acceptés** — la même clé API peut être ajoutée deux fois sous deux étiquettes (`store-settings.ts:380`, INSERT sans vérification → fausse le choix `least_used`/`fill_first`) ; coller deux fois le même dépôt/serveur MCP crée deux extensions indépendantes (`handlers/providers-extensions.ts:431,455`, aucune déduplication sur `source` ; les fournisseurs, eux, sont bien dédupliqués).
10. **Hermes / mémoire — erreurs réseau entièrement avalées** — `use-memory.ts:62-73` : le champ `error` de l'ack n'est jamais lu, aucun toast ; en échec l'utilisateur croit avoir enregistré. `:44-60` : la confirmation du service est jetée si `state` est encore `null` → l'interrupteur retombe visuellement alors que le service a bien enregistré. Contraste avec `use-system-prompts.ts` qui toast toutes ses erreurs.

---

## 3. Défauts par section

### 3.1 Interface
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | **« Ordre des projets » mensonger** : le réglage trie en réalité les conversations *à l'intérieur* de chaque projet (`sidebar.tsx:222,255` ; le registre `settings.ts:292` le dit explicitement). L'utilisateur croit réordonner les dossiers ; effet jamais produit. La description omet en outre la troisième option « Création ». | `interface-section.tsx:142-143` |
| 2 | Mineur | **« Dossiers repliés » grisée sans explication** : `dim={projects.length === 0}` passe la ligne en `opacity-55` dès qu'il n'y a aucun projet — ressemble à un contrôle cassé, seul le survol l'explique (constaté visuellement). Le « on » calculé est fragile : vrai seulement si TOUS les projets sont repliés ; décocher efface d'un coup le repliage individuel sans confirmation ; créer un projet fait basculer l'interrupteur sans action de l'utilisateur. | `interface-section.tsx:52,168,172-178` |
| 3 | Mineur | Bornes de la taille de police (12-34) codées en dur, absentes du registre ; `writeClientSetting` en échec (quota, navigation privée) abandonne **avant** le `dispatchEvent` → clic mort, contrôle qui ne bouge pas, aucune erreur (`settings.ts:416-419`). | `interface-section.tsx:129-130`, `settings.ts:416-419` |
| 4 | Mineur | Import `InfoTip` mort. | `interface-section.tsx:13` |

### 3.2 Modèles
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | Race d'écrasement des tarifs au chargement (cf. §2.3). | `models-section.tsx:93,223-227` + `use-pricing.ts:11` |
| 2 | Mineur | État vide mensonger : « Aucun tarif déclaré » indistinguable de « pas encore chargé » (le hook n'expose pas de drapeau). | `models-section.tsx:208,236-239` |
| 3 | Mineur | **« Off » en anglais** dans une UI francisée (seule valeur non traduite des EFFORT_LABELS) — constaté visuellement dans le segmenté Effort. | `models-section.tsx:31` |
| 4 | Mineur | Effort : si la valeur stockée n'existe pas dans l'échelle du modèle choisi, **aucune pilule active** alors qu'un effort effectif est appliqué par le hook. | `models-section.tsx:57-58` |
| 5 | Mineur | Tarif en doublon remplacé silencieusement (aucun marquage « déjà tarifié » dans le Select) ; suppression sans confirmation ni undo ; `toLocaleString("fr-FR")` perd les petites valeurs (0,0005 affiché « 0,001 » voire « 0 ») au lieu de `formatUsd` qui gère 4 décimales ; fenêtre de contexte arrondie (`Math.round(cw/1e6)`) → 1,5 M affiché « 2M ». | `models-section.tsx:91-97,217,104` |
| 6 | Mineur | `EFFORT_LABELS` dupliqué avec `settings-panel.tsx:86-94` (risque de divergence) ; import `InfoTip` mort ; à vérifier : id persisté absent du catalogue live rend un déclencheur Radix vide. | `models-section.tsx:30-38,21,120` |

### 3.3 Modes de chat
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | Debounce **annulé** au démontage au lieu d'être flushé → dernières frappes perdues (cf. §2.5). | `modes-section.tsx:628-633` |
| 2 | Majeur | Échecs de sauvegarde serveur avalés (`void saveServerPrompts`, `void saveVoiceChars`, `resetPrompt` sans test) — l'anti-pattern corrigé dans Modèles n'a pas été porté ici. | `modes-section.tsx:625,660,895` |
| 3 | Majeur | **13 textareas `disabled={!ready}` sans retour** : service muet + reconnexion infinie (`socket.ts:25`) = zones mortes sans spinner, sans « chargement… », sans erreur ; le prop `connected` du panneau n'est pas passé à la section. Même famille pour le stepper voix (défaut 2000 affiché en attendant, écriture optimiste non confirmée). | `modes-section.tsx:414,74-90,122-136,521-536` |
| 4 | Mineur | Valeur serveur non alignée sur le pas : 2200 stocké → « 2200/8000 » puis un clic « − » saute à 1500 (−700). | `modes-section.tsx:230-231,122-136` |
| 5 | Mineur | JSON corrompu de `hermes.modes.models` accepté : toute valeur non-string non-null est castée puis affichée brute dans une pastille. | `modes-section.tsx:555` |
| 6 | Mineur | Référentiels dupliqués avec `lib/modes.ts` et déjà divergents (`voicesFor` : rôles différents ; `MODE_PROMPT_META` vs `PROMPT_META`) ; bornes codées en dur dans les textes (« 10 max », « 500 à 8000 »…) alors que le Stepper reçoit `min`/`max` des constantes. | `modes-section.tsx:685-707,469-483,878,951,1019` |
| 7 | Mineur | Desktop : le Select « Modèle du mode » tronque le libellé (« Chat — La conversatio… ») — constaté visuellement. | rendu, section Modes |

### 3.4 Fournisseurs & Clés de services
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | Suppression fournisseur **+ toutes ses clés** en un clic sans confirmation (cf. §2.6). | `providers-section.tsx:168-178,251-260` |
| 2 | Majeur | Émissions sans timeout → `addingKey`/`testing`/`savingBase` figés à vie (cf. §2.4). | `use-providers.ts:109-117` |
| 3 | Majeur | Doublons de clés possibles (cf. §2.9). | `store-settings.ts:380` |
| 4 | Mineur | **État vide affiché pendant le chargement** : « Aucun fournisseur configuré pour l'instant » apparaît immédiatement avant la réponse service (constaté en direct avec le service arrêté — indistinguable d'une vraie config vide). | `providers-section.tsx:642-646` |
| 5 | Mineur | Pastille de statut trompeuse : `[ok, exhausted]` affiche rouge « à réparer » alors qu'une clé fonctionnelle existe (teste `exhausted` avant `some(ok)`). | `use-providers.ts:309-311` |
| 6 | Mineur | Broadcast `providers:changed` réinitialise `keyEndpoint`/`advEndpoint` pendant la saisie → champ effacé sans avertissement. | `providers-section.tsx:107-112` |
| 7 | Mineur | Adresse invalide ignorée en silence à l'ajout d'un fournisseur connu (non-https rejeté côté service sans erreur, l'utilisateur croit définir son adresse) ; pendant le chargement du catalogue, option « Chargement… » jamais sélectionnable, aucune erreur si le catalogue n'arrive pas. | `providers-section.tsx:496-516,539-556` + `handlers/providers-extensions.ts:140-152` |
| 8 | Mineur | Variante `kind="service"` incohérente : le champ unifié accepte une URL GitHub → installe une *extension* qui n'apparaît pas dans cette section (toast ne dit pas où elle est allée) ; pas de bouton fermer (contrairement à la variante llm). | `providers-section.tsx:651-666` + `add-anything.tsx:40-44` |
| 9 | Mineur | Divulgations « Réglages avancés » et AddLine sans `aria-expanded` (le motif existe dans `extensions-section.tsx:148`) ; champ secret sans `autoComplete="new-password"`. | `providers-section.tsx:372-383,317,329-339,649` |

Points positifs vérifiés : secrets jamais exposés (`masked` uniquement, purgé de l'état après succès), anti double-clic correct sur test/ajout/check/update, toutes les erreurs de réponse produisent un toast destructif.

### 3.5 Chats web
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | Chargement silencieux → `saveAll` peut écraser la config réelle par les défauts ; **« Chargement des fiches… » infini constaté en direct** sans timeout ni erreur. | `webchat-section.tsx:54-60,90-97,163-169` |
| 2 | Mineur | `saveAll` : 5 sauvegardes séquentielles, chacune pose son flash « Enregistré… » ; en échec partiel, le vert et l'erreur s'affichent **en même temps**, sans dire quelle clé a échoué ; pas d'état pending sur le bouton. | `webchat-section.tsx:163-169,388-398` |
| 3 | Mineur | Bornes numériques non imposées à la saisie (port 80, timeout 999999 partent tels quels ; validation service limitée à `n > 0`). | `webchat-section.tsx:308-347` + `webchat/engine.ts:49-52` |

### 3.6 Outils & extensions
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | Extensions en doublon possibles (même source installée deux fois, cf. §2.9). | `handlers/providers-extensions.ts:431,455` |
| 2 | Majeur | `installAnything` sans chien de garde → `busy` figé « Recherche… » à vie ; ack sans argument lèverait un TypeError silencieux. | `add-anything.tsx:32-35` + `use-providers.ts:109-117` |
| 3 | Mineur | **Constaté visuellement** : chevauchement de la description « Recherche web » avec le lien « Gérer les clés » (le texte « …bascule " Web " de la barre de saisie » passe sous le lien) ; statuts « Analyse d'images : selon le modèle » et « Voix : présente » affichés **service hors ligne**, alors que l'en-tête du fichier revendique « statuts RÉELS uniquement ». | `outils-extensions-section.tsx:88-98` + rendu |
| 4 | Mineur | Toggle d'extension sans garde busy (double-bascule = deux événements contradictoires) ; commits d'une extension supprimée laissés orphelins dans `commitsByExt` ; Switch à libellé figé « Activer {nom} » qu'il soit on ou off. | `extensions-section.tsx:50-60,179` + `outils-extensions-section.tsx:68-76` |

### 3.7 Hermes
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | Suppression d'un preset sans confirmation (cf. §2.6) ; double-clic possible sur Créer/Enregistrer/« Enregistrer comme preset » (aucun état pending) → presets identiques en double. | `hermes-section.tsx:415-424,260-275` |
| 2 | Mineur | Éditeur de preset : aucun compteur/`maxLength` sur le contenu (contrairement aux instructions et au prompt de conversation), pas d'`autoFocus` sur le nom (Profils l'a). | `hermes-section.tsx:184-189,368-373` |
| 3 | Mineur | Prompt de conversation : « Retirer » sans toast d'erreur → l'UI affiche « Aucun prompt actif » alors que le prompt serveur subsiste et réapparaît à la réouverture ; preset actif identifié par **titre** (homonymes = mauvaise surbrillance, renommage = surbrillance perdue) ; `MAX_PROMPT_CHARS = 12 000` codé en dur côté client vs `customMaxChars` venu du service ; état mort (`draft`, `dirty`, `creating`… déclarés dans `SystemPromptPanel`, jamais utilisés). | `system-prompt-panel.tsx:17,44-49,68,136-146,148-151,241,306-311` |

Points positifs vérifiés : le pattern « brouillon null = suit le service » corrige l'ancien effacement involontaire ; la mémoire a une vraie garde destructive (`ConfirmDestructiveDialog`) ; les compteurs bloquent la sauvegarde en dépassement au lieu de tronquer.

### 3.8 Profils
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | **Bloquant** | Écrasement de toute la liste par read-modify-write non gardé (cf. §2.1). | `profiles-section.tsx:47-53,64` + `use-profiles.ts:28-33,43-53` |
| 2 | Majeur | Suppression d'un profil sans confirmation (cf. §2.6) ; double-clic sur « Créer » → last-write-wins, le premier profil est perdu. | `profiles-section.tsx:55-68,80-83` |
| 3 | Mineur | Bandeau `flash` sans `role="status"`/`aria-live` ; `duplicate` sans retour (contrairement à create/apply) ; pas d'unicité de nom ; état vide affiché pendant le chargement (invite l'action du défaut 1). | `profiles-section.tsx:118-123,70-78,183-187` |

### 3.9 Système
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | `updateNow()` sans chien de garde → **bouton « Vérification… » figé pour toujours** (constaté en direct, service arrêté) ; le chien de garde 8 s équivalent existe dans Stockage mais pas ici. | `system-section.tsx:188-206` |
| 2 | Mineur | `updateAvailable` repassant à `null` ne fait jamais sortir la carte de « disponible » (synchro à sens unique). | `system-section.tsx:130-137` |
| 3 | Mineur | « Terminé à HH:MM » pris sur la **dernière** ligne du journal alors que le parseur tolère des lignes après le verdict ; repli sur `new Date()` recalculé à chaque rendu → heure qui dérive. | `system-section.tsx:172-174,347` + `fil-live.tsx:49-56` |
| 4 | Mineur | Classe Tailwind corrompue copiée en deux exemplaires : `max-[560px]:stretch` (utilitaire inexistant), `max-[560px]:*:` (variante inachevée), retour à la ligne dans la chaîne — l'intention responsive < 560 px est probablement perdue. | `system-section.tsx:375-376` + `agent-motor-card.tsx:331-332` |
| 5 | Mineur | Carte moteur (`agent-motor-card`) : étape « installé sur un autre poste » en **impasse** — deux champs sans état ni handlers, « Rien ne change avant que vous validiez » mais aucun bouton de validation (branchement `gateway:set` non fait, admis en commentaire) ; modal de rollback maison sans piège de focus (Tab atteint la page dessous, `aria-modal="true"` mensonger) alors que le dialog Radix du dépôt existe ; erreurs en `window.alert` (incohérent avec les toasts) ; « vérifiée aujourd'hui à {checkedAt} » quel que soit l'âge réel ; « Historique · 12 étapes » mais `slice(0, 8)` sans « voir plus » ; « il y a 600 s » jamais formaté en minutes ; « Revérifier » sans retour ni pending ; copier-presse-papier en échec silencieux ; faux liens `<a href="#">` ; état/journal non rechargés à la reconnexion. | `agent-motor-card.tsx:33-36,92-131,184-218,192-209,231-239,252-256,300,304-325,331-332,486-489,538-581,622-675` |

### 3.10 Stockage
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | Undo 7 s : le toast vit 8,8 s — « Annuler » reste cliquable ~1,8 s **après** l'expiration côté service (échec annoncé « Fenêtre d'annulation expirée ») ; le champ `expireAt` est calculé mais jamais lu ; tout échec de `storage:undo` affiche le même message. | `storage-section.tsx:174-177,295-300` + `chat-protocol.ts:550` |
| 2 | Majeur | **Violation ARIA** : bouton « Nettoyer » imbriqué dans un en-tête `role="button"` (descendant interactif interdit dans ce rôle). | `storage-section.tsx:555-604` |
| 3 | Majeur | `cleanProject` : `setBusy(g.id)` jamais relâché sans ack → « Nettoyage… » figé ; `cleanProject`/`deleteVersion`/`undo` ne vérifient pas `mountedRef` (setState post-démontage) ; `deleteVersion` sans verrou → double-clic = erreur « Échec de la suppression » pour une ligne déjà supprimée. | `storage-section.tsx:308-346` |
| 4 | Mineur | `parseDate` faux sur le format documenté par son propre commentaire : teste la chaîne originale au lieu de la normalisée → `"2026-11-20 12:34:56"` donne `Invalid Date` → toutes les dates deviennent aujourd'hui (latent : le service écrit actuellement en ISO « T »). | `storage-section.tsx:42-46` + `store-artifacts.ts:88` |
| 5 | Mineur | Race du chien de garde : si la requête A traîne > 8 s et que B réussit entre-temps, le timer de A explose quand même → écran d'erreur affiché malgré des données fraîches. | `storage-section.tsx:189-199` |
| 6 | Mineur | Perte de focus en fin de filtrage : le bouton « effacer les filtres » passe comme cible de focus mais se démonte juste après → focus perdu au `<body>`. | `storage-section.tsx:271-276,501` |
| 7 | Mineur | Prop `initialProject` jamais fournie, lien profond `?projet=` jamais lu (branche inatteignable) ; « 7 secondes » / « 8 s » codés en dur dans 4 textes alors que `STORAGE_UNDO_MS` existe. | `storage-section.tsx:145,152,317,359,404,193` |

Point positif vérifié en direct : avec le service arrêté, la section affiche après 8 s un état d'erreur **honnête** (« Impossible de charger le stockage — Le service n'a pas répondu (8 s) ») avec bouton « Réessayer » — c'est le modèle à généraliser aux autres sections.

### 3.11 Transversal
| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | `emit` socket sans timeout nulle part (`use-providers`, hooks mémoire/prompts/profils, sections système) — famille complète des états pending infinis (cf. §2.4). | `use-providers.ts:109-117`, `socket.ts:25` |
| 2 | Mineur | **Mobile 375 px** : lignes de réglage écrasées (texte en colonne d'un mot par ligne) + ✕ du Sheet chevauchant le rail horizontal (cf. §2.8) — constaté visuellement sur Interface, Modèles, Modes. | `SettingRow` (chaque section), `sheet.tsx:75`, `settings-panel.tsx:338` |
| 3 | Mineur | Code mort dans `settings-panel.tsx` : `SettingRow` (jamais rendu, chaque section a sa copie), `EFFORT_LABELS`, imports morts (`useTheme`, `getSocket`, `Select`, `Slider`, `Segmented`, `Switch`, `readClientSetting`). | `settings-panel.tsx:22-73,171-200` |
| 4 | Mineur | Rail : le commentaire d'en-tête dit « 9 sections » puis « 10 (F-30) » — il en compte désormais 11 (Stockage) ; la doc d'en-tête v4/v2.6/v2.7 s'est empilée sans nettoyage. | `settings-panel.tsx:1-18,95-114` |

---

## 4. Ce qui a été constaté à l'exécution (service mini-chat arrêté)

| Constat | Section | Verdict |
|---|---|---|
| « Chargement des fiches… » à l'infini, aucun timeout ni erreur | Chats web | Défaut (§2.2) |
| Bouton figé sur « Vérification… » avec pastille orange « Vérification… » | Système | Défaut (§2.4) |
| « Aucun fournisseur/service configuré pour l'instant » affiché immédiatement | Fournisseurs, Clés | Défaut (trompeur : indistinguable d'une vraie config vide) |
| « Aucun profil — réglez le chat… » affiché immédiatement | Profils | Défaut (invite l'action qui peut écraser la liste) |
| Ligne « Dossiers repliés » grisée sans explication (0 projet) | Interface | Défaut cosmétique |
| Erreur honnête après 8 s + « Réessayer » | Stockage | **Bon comportement** à généraliser |
| Statuts « présente » / « selon le modèle » affichés hors ligne | Outils & extensions | Défaut (contradiction avec l'en-tête « statuts réels ») |
| Aucune erreur JS en console pendant toute la navigation | — | Bon |

---

## 5. Points forts à préserver

- **Registre `src/lib/settings.ts`** : typage, validation enum/number lecture+écriture, migration des clés legacy, bus d'application immédiate — la colonne vertébrale du volet est solide.
- **Secrets API** : jamais renvoyés au client (`masked`), purgés de l'état après succès, jamais loggés.
- **Accessibilité de base** : aria-labels sur les contrôles, focus visible (`focus-visible:outline-hermes`) sur le rail, Segmented monté sur Radix Tabs (navigation clavier native), dialog destructif Radix pour la mémoire.
- **Anti double-clic** correct sur les parcours les plus lents (test de clé, ajout de clé, installation).
- **Chien de garde + état d'erreur de Stockage** (8 s) et **ack + toast de Modèles** : les deux bons motifs existent déjà dans le dépôt — la correction consiste surtout à les généraliser.

## 6. Plan de correction suggéré

1. **Lot « écritures prématurées »** (profils, tarifs, chats web) : drapeau « chargé » exposé par chaque hook, écritures interdites avant ack du `settings:get`, ack vérifié + toast sinon. Corrige les 3 risques de perte de données (§2.1, §2.2, §2.3).
2. **Lot « chien de garde emit »** : envelopper `socket.emit` dans un helper avec timeout (8 s, même valeur que Stockage) qui libère le pending et affiche un toast — corrige en un point les boutons figés de Fournisseurs, Outils, Système, Modes, Hermes, Profils, mémoire.
3. **Lot « confirmations destructives »** : passer les 5 suppressions (fournisseur, clé, extension, preset, profil) par `ConfirmDestructiveDialog` + déduplication clé/extension à l'ajout.
4. **Lot « Modes »** : flusher le debounce au démontage, toasts sur les échecs de sauvegarde, état « chargement… » visible sur les textareas, passer `connected` à la section.
5. **Lot responsive** : `SettingRow` — passer le contrôle en `flex-basis` minimal ou forcer le wrap sous un seuil ; réserver un padding droit au rail mobile sous le ✕.
6. **Lot polish** : « Off » → « Désactivé », `formatUsd` pour les tarifs, fenêtre de contexte en décimal, nettoyage du code mort (SettingRow, imports, états de system-prompt-panel), classes Tailwind corrompues, `parseDate`, textes « 7 secondes/8 s » branchés sur les constantes.

---

*Audit réalisé par lecture intégrale du code et par exécution locale ; chaque défaut est référencé `fichier:ligne` et a été vérifié dans son contexte d'usage. Les mentions « à vérifier » ont été retirées ou résolues ; les deux points restés incertains (comportement Radix sur id absent du catalogue ; codes d'erreur exacts de `storage:undo`) sont signalés comme tels dans le texte.*
