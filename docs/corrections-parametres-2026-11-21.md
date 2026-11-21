# Corrections appliquées — Page « Paramètres » (hermes_ui)

**Date** : 21 novembre 2026 · **Dépôt** : `/home/z/my-project/hermes_ui` @ `e51adcb` (modifications NON commitées, sur la branche `main`)
**Objet** : correction des défauts du rapport [audit-page-parametres-hermes-ui.md](audit-page-parametres-hermes-ui.md) (bloquant, majeurs et mineurs à correction sûre).

**Chiffres** : 26 fichiers modifiés + 1 nouveau fichier (`src/lib/emit-ack.ts`) + 1 script QA (`scripts/test-dedup-service.ts`) — ~1 600 insertions / 723 suppressions.
**Vérifications** : `tsc --noEmit` OK · ESLint OK (0 erreur) · `scripts/test-modes-flow.ts` 72 OK / 0 échec · `scripts/test-agent-motor-flow.ts` 34 OK / 0 échec · `scripts/test-fil-live.ts` 59 OK / 0 échec · déduplication service validée à l'exécution (`TOUS OK`) · smoke test navigateur avec service coupé : toutes les bannières d'état dégradé affichées, aucune erreur console.

---

## 1. Nouveau socle partagé

| Fichier | Contenu |
|---|---|
| `src/lib/emit-ack.ts` (nouveau) | `emitAck<T>(event, payload, timeoutMs = 8 000)` : émission socket avec chien de garde — résout `null` si le service n'acquitte pas (socket coupée, callback jamais appelé) ; un ack vide est normalisé en `null` (supprime les TypeError sur `res.error`). **Un seul point remplace tous les « boutons figés pour toujours ».** |

Convention : les setters d'état synchrones dans les effets passent par `queueMicrotask` (règle `react-hooks/set-state-in-effect`, motif déjà utilisé par le dépôt).

## 2. Défauts corrigés, par section

### Bloquant
- **Profils — écrasement de la liste** : `use-profiles` expose `loaded`/`error` (lecture avec chien de garde) ; `profiles-section` interdit créer/dupliquer/supprimer tant que la liste serveur n'a pas été lue ; `persist` vérifie l'ack (`settings:set` → `{ok}`/`{error}`) et toast tout échec ; bandeau « service injoignable » avec écritures bloquées ; états « Chargement… » distincts de « Aucun profil » ; suppression via `ConfirmDestructiveDialog` ; « Dupliquer » a un retour ; bandeau flash en `role="status"`.

### Majeurs — écritures prématurées (perte de données)
- **Modèles — tarifs** : `usePricingState` (`loaded`/`error`) ; ajouter/retirer un tarif impossible avant chargement ; `savePricing` async avec ack **et** chien de garde (toast « Tarifs non enregistrés ») ; état « Chargement des tarifs… » distinct de « Aucun tarif déclaré » ; bannière d'erreur bloquante si le service est muet.
- **Chats web — écrasement de la config réelle** : lecture avec chien de garde par clé (`null` ack ≠ « clé absente ») ; `settingsLoaded`/`loadError` ; `saveAll` refuse d'écrire tant que la lecture n'est pas complète ; un seul flash final avec **nombre de clés échouées** ; bouton « Enregistrer » en état pending ; bannière d'alerte ; `webchat:open`/`webchat:close` avec chien de garde (plus de bouton « Ouverture… » figé).

### Majeurs — chien de garde généralisé (boutons figés)
- `use-providers.emit` → `emitAck` : **toutes** les actions fournisseurs/extensions gèrent `null` (toast « Le service n'a pas répondu (8 s) ») — providers-section (9 handlers), extensions-section (5), add-anything (busy libéré + TypeError vide réglé).
- **Système** : `prodeMajCheck` et `updateNow` ont leur chien de garde 8 s — le bouton « Vérification… » figé pour toujours (constaté visuellement avant correction) affiche maintenant « Vérification impossible » + motif + Réessayer.
- **Stockage** : chien de garde sur `deleteVersion` et `cleanProject` (« Nettoyage… » ne reste plus figé) ; `mountedRef` vérifié sur undo/delete/clean.
- **Mémoire** (`use-memory`) : chien de garde + champ `error` des acks **lu et toasté** (avant : entièrement avalé) ; les confirmations du service sont fusionnées même si `state` est encore `null` (l'interrupteur ne retombe plus visuellement) ; switches verrouillés pendant l'aller-retour.
- **Hermes / prompts** (`use-system-prompts`) : chien de garde sur les 6 actions ; plus **aucun** échec silencieux (ack inattendu, service muet, sans conversation → toasts) ; `deletePreset`/`createPreset`/`updatePreset` informent toujours.
- **Modes** : `getServerPrompts`/`saveServerPrompts`/`getServerVoiceChars`/`saveServerVoiceChars` via `emitAck` ; échecs de sauvegarde toastés (le correctif « Lot 5 » de Modèles enfin porté ici) ; **debounce FLUSHÉ au démontage** (changer de section ou fermer le volet dans les 300 ms ne perd plus la dernière frappe) ; bannière « service injoignable » avec bouton **Réessayer** quand les consignes ne se chargent pas ; prop `connected` passée par le panneau racine.

### Majeurs — suppressions destructives & doublons
- Les **5 suppressions** passent par `ConfirmDestructiveDialog` : fournisseur (+ ses clés, avec compteur dans le message), clé, extension, preset, profil (mémoire l'avait déjà).
- **Déduplication côté service** (`providers-extensions.ts`) : la même clé sur un même fournisseur est refusée (« Cette clé existe déjà sur ce fournisseur… ») ; le même dépôt/serveur MCP est refusé (« Ce dépôt est déjà importé. » / « Ce serveur est déjà ajouté. ») — **validé à l'exécution** par `scripts/test-dedup-service.ts` (TOUS OK, gardé comme QA ciblée, convention `scripts/test-*.ts`).
- Double-clic verrouillé : PresetEditor (créer/enregistrer), `saveAsPreset`, toggle d'extension, toggles mémoire, « Revérifier », « Mettre Hermes à jour », `deleteVersion`.

### Majeurs — saisies et retours mensongers
- **Prompt système** (`system-prompt-panel`) : `onSave` retourne un booléen **attendu** — le badge « Non enregistré » ne disparaît que si le service a accepté ; « Retirer » attend l'ack et ne vide l'UI que sur succès (plus de divergence locale/serveur) ; la clé de remontée ne contient plus `updatedAt` (un broadcast pendant l'édition ne détruit plus le brouillon) ; état mort du composant externe supprimé ; câblage `page.tsx` mis à jour.
- **Interface** : « Ordre des projets » → **« Ordre des conversations »** avec description honnête (trie les conversations à l'intérieur d'un projet) ; ligne « Dossiers repliés » : `opacity-55` supprimée (état jamais prévu par la maquette, échec de contraste 2,3:1) et description qui dit pourquoi elle est inactive quand il n'y a pas de projet ; `writeClientSetting` retourne `false` en échec et l'InterfacePane toast « stockage indisponible » (plus de clic mort).

### Mineurs corrigés
| Défaut | Correction |
|---|---|
| « Off » en anglais (Modèles) | « Désactivé » |
| Tarifs `toLocaleString` perdait 0,0005 | `formatTarif` (4 décimales, `< 0,0001`, même logique que `formatUsd`) |
| Fenêtre 1,5 M affichée « 2M » | décimale FR (`1,5M`) |
| Stepper voix : 2200 → saut de 700 | lecture réalignée sur le pas (`VOICE_CHARS_STEP = 500`, nouvelle constante dans `lib/modes`) |
| JSON corrompu `hermes.modes.models` affiché brut | filtré (string ou null uniquement) |
| maxLabel « 10 max / 5 max / 3 max / 8000 » codés en dur | interpolés depuis les constantes |
| `parseDate` faux (dates → aujourd'hui) | test sur la chaîne normalisée |
| Undo cliquable 1,8 s après expiration | toast **7,0 s** exacts, bouton désactivé à `expireAt` (champ enfin lu), message d'expiration réservé au VRAI échec d'expiration |
| Violation ARIA (bouton dans `role="button"`) | en-tête Stockage : vrai `<button>` de déroulé + « Nettoyer » en frère |
| Course du chien de garde inventaire | compteur de requêtes (`reqSeqRef`) |
| Focus perdu en fin de filtrage | focus rendu au champ de recherche (persistent) |
| Textes « 7 secondes » / « 8 s » codés en dur | interpolés depuis `STORAGE_UNDO_MS` / `STORAGE_WATCHDOG_MS` |
| `window.alert` (carte moteur) | toasts |
| « Revérifier » sans retour | pending « Vérification… » + toast de résultat |
| Copier-presse-papier silencieux | toast « Copie impossible » + consigne |
| « vérifiée aujourd'hui à… » faux | libellé daté honnêtement (aujourd'hui / le JJ/MM) |
| « il y a 600 s » | « il y a N min » |
| Historique « N étapes » tronqué à 8 | note « Les 8 plus récentes affichées sur N » |
| Modal rollback sans piège de focus | `ConfirmDestructiveDialog` Radix (focus piégé, Escape, focus rendu) ; effet Escape maison retiré |
| Faux liens `<a href="#">` | vrais `<Button variant="link">` |
| Pastille fournisseur [ok, exhausted] rouge | `ok` testé avant `exhausted` |
| État vide fournisseurs/extensions affiché pendant le chargement | `providersLoaded` → « Chargement… » |
| Endpoint écrasé pendant la saisie (broadcast) | champs préservés si modifiés |
| Champ secret sans `autoComplete` | `autoComplete="new-password"` |
| Divulgations sans `aria-expanded` | ajouté (AddLine partagé + Réglages avancés webchat/providers) |
| Toggle extension / commits orphelins / libellé « Activer » figé | garde busy + purge `commitsByExt` + `aria-label` dynamique |
| Statuts « selon le modèle » en vert | tone `off` (neutre) |
| Statuts morts / imports morts (`settings-panel`, interface, models) | supprimés (SettingRow dupliqué, EFFORT_LABELS dupliqué, useTheme, getSocket, Select, Slider, Segmented, Switch, InfoTip, X, `useToast` non utilisé) |
| Commentaire rail « 9/10 sections » | à jour (11 entrées) |
| Classes Tailwind corrompues (`max-[560px]:stretch`, `:*:`) ×2 fichiers | réparées (intention responsive rétablie) |
| Mobile : lignes écrasées | `SettingRow` : texte `min-w-[200px]` → le contrôle passe à la ligne au lieu d'écraser le texte |
| Mobile : ✕ sur le rail horizontal | rail `max-[1100px]:pr-12` (zone réservée sous le ✕) |
| « Vérification… » figé (Système) | chien de garde → état d'erreur honnête (vérifié en direct) |
| Sections montées pendant la coupure : « Chargement… » éternel sans requête émise | erreur immédiate au montage si socket déconnectée et rien chargé (use-profiles, use-pricing) — la reconnexion relance `load()` |
| `majEtat` collé à « disponible » | synchro bidirectionnelle (retour à « à jour » si `updateAvailable` devient null, hors opération en cours) |
| « Terminé à » qui dérivait (`new Date()` par rendu) | figé sur l'heure du verdict, repli `majVerifieLabel` |
| « aujourd'hui à HH:MM » affirmé | vrai jour affiché si ≠ aujourd'hui (Système + carte moteur) |

## 3. Non corrigé (documenté, hors périmètre sûr)

- **Étape guidée « autre poste »** (carte moteur) : impasse assumée par le repo (« branchement `gateway:set` reste à faire », FORK.md §9) — compléter la fonctionnalité serait une décision produit, pas une correction de défaut.
- **Déduplication de référentiels** (`voicesFor`, `PROMPT_META` dupliqués entre modes-section et lib/modes) : refactor à risque, reporté.
- **Preset actif identifié par titre** : nécessite un id côté contrat (`ConversationPrompt`), touche le service.
- **Lien profond Stockage `?projet=`** : prop `initialProject` toujours non fournie (fonctionnalité à câbler, pas à supprimer).
- **Bornes numériques serveur** des réglages webchat (port 80, timeout 999999 passent côté service).
- **`majEtat`** : le downgrade ne s'applique que si aucune opération n'est en cours (choix conservateur).

## 4. Notes d'intégration

- **Rien n'est commité** : les modifications sont dans le working tree (branche `main`). L'entrée du journal FORK.md §9 (convention du dépôt pour toute décision structurante) et le commit restent à faire par vos soins — le script `scripts/test-dedup-service.ts` (QA ciblée de la dédup, à lancer avec le mini-service sur :3003) est prêt à être cité dans l'entrée.
- Les deux audits (fiabilité et design) restent la référence ; les corrections design dédiées (padding haut 26 px, token `--hermes-soft`, boutons primaires clair < 4,5:1, pistes de switch < 3:1, sémantique d'état orange/gris) sont listées dans [audit-design-page-parametres-hermes-ui.md](audit-design-page-parametres-hermes-ui.md) §7 et **ne sont pas** dans ce lot — seuls les chevauchements (ligne dim, mobile, classes corrompues) ont été traités ici.
