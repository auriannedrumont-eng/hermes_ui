# AUDIT — features à raccorder à la maquette Système v3

**Date :** 21/11/2026 · **Commit audité :** `8263a36` (v0.4.1)
**Objet :** vérifier tout le code que la future section Système v3 (`design/maquette-systeme-v3.html`, validée) devra brancher — avant d'écrire la moindre ligne d'implémentation.
**Méthode :** lecture directe des 4 couches (client, handlers, service, lanceurs) + vérifications automatiques. Aucune modification du code.

> **ADDENDUM — 21/11/2026, v0.4.2 : les constats A et B sont CORRIGÉS** (décision de l'utilisatrice : « corrige » — consigné FORK.md §9, `package.json` → 0.4.2). État après correction :
>
> | Constat | Correction | Fichier(s) |
> | --- | --- | --- |
> | **A-1** verdict fragile | `majVerdict` / `logVerdict` cherchent la dernière ligne **à marqueur** (plus la dernière ligne tout court) ; contrat documenté dans les DEUX lanceurs (« n'écrire aucune ligne informative après le marqueur final » — vérifié : les remarques « lanceur mis à jour » passent déjà avant le verdict) | `system-section.tsx`, `agent-motor-card.tsx`, `hermes-ui.ps1`, `hermes-ui.sh` |
> | **B-2** journal écrasé sans garde | `system:update-request` répond `alreadyRunning:true` sans reposer le drapeau ni réécrire `maj.log` quand une demande est en vol ; le client suit le journal existant | `handlers/settings-system.ts`, `system-section.tsx` |
> | **B-4** types dupliqués | `AgentRelease`, `MotorControl`, `MotorOp`, `MotorState`, `MotorJournalEntry` déplacés dans `shared/chat-protocol.ts` (référentiel unique §60) ; `agent-motor.ts` ré-exporte (alias `JournalEntry` conservé, `AgentReleaseInfo` → `AgentRelease`) ; la carte cliente importe via `@/lib/chat-types` | `shared/chat-protocol.ts`, `agent-motor.ts`, `agent-motor-card.tsx` |
> | **B-5** journal moteur non plafonné | `motorLogRead` plafonne à 64 Ko (queue), même garde que le relais interface | `agent-motor.ts` |
> | **B-6** « MAJ OK » sans re-vérification | au verdict `MAJ OK`, le front relance `system:update-check` silencieux — carte et badge orange retombent sur « À jour », révision du filet rafraîchie | `system-section.tsx` |
> | **C/4.2** toast connect_error | **INVALIDÉ** : aucun toast `connect_error` n'existe dans `src/` (grep 0 occurrence) — le constat hérité d'AUDIT-CONSOLIDE était obsolète ; rien à corriger, l'implémentation v3 n'a pas de doublon à craindre de ce côté | — |
> | **A-2** âge du journal | **SANS OBJET** : `mtimeMs` est déjà diffusé dans chaque snapshot et utilisé au montage (reprise F5 < 10 min) ; l'implémentation v3 n'aura qu'à le réutiliser pour « il y a N s » — aucun changement de contrat nécessaire | `system-section.tsx` (existant) |
>
> **QA v0.4.2 :** tsc front 0 erreur · tsc service 0 erreur · eslint (5 fichiers modifiés) 0/0 · `test-agent-motor-flow.ts` **34/34** · nouveau `scripts/qa-corrections-v3.ts` **9/9** contre le vrai service (forme du fil `agent:motor-state` intacte après déplacement des types ; double demande → `alreadyRunning` + journal conservé ; verdict robuste sur 3 scénarios de journal). Aucun événement socket ajouté ni modifié (`alreadyRunning` = champ de réponse additionnel, compat ascendante).
> Les §1-7 ci-dessous décrivent l'état AUDITÉ (avant correction) — conservés pour la traçabilité.

---

## 0. Verdict global

**Le socle est sain et complet : la maquette v3 est implémentable sans toucher au service ni aux lanceurs.** Les 5 scénarios de la maquette (calme, dispo, maj en cours, silence 30 s, problème) trouvent tous leurs données dans les contrats socket existants. Trois familles de constats :

- **A (bloquant pour la maquette)** — 2 constats à traiter PENDANT l'implémentation, car la maquette promet un comportement que le code actuel ne délivre pas tout à fait.
- **B (fragilités du socle)** — 5 constats à connaître : sans correction, ils dégraderont l'expérience v3 dans des cas précis. Correction conseillée mais découplable.
- **C (dettes voisines)** — héritées d'AUDIT-CONSOLIDE.md, sans impact direct sur la v3.

Vérifications automatiques du jour : `tsc --noEmit` front **0 erreur**, `tsc` service **0 erreur**, `eslint` sur les 4 fichiers clés **0 erreur**, `test-agent-motor-flow.ts` **34/34 passées**.

---

## 1. Cartographie de ce qui existe (périmètre du raccordement)

### 1.1 Chaîne « mise à jour de l'application » (carte 1 de la maquette)

```
[client]                          [service 3003]                    [lanceur]
system-section.tsx                 handlers/settings-system.ts       desktop/hermes-ui.ps1 / .sh
  system:update-check   ──────▶      readInstalledRevision()           boucle Supervise (15 s)
  system:update-request ─────▶       (drapeau posé +                 Test-Path maj-demandee.flag
  system:update-log     ─────▶        journal démarré)                    │
  ◀─────── system:update-log:changed  relais 2 s (maj.log)  ◀────── Write-MajLog (MAJ OK/ERREUR)
  ◀─────── system:update-state        hello.update (démarrage + 6 h)
```

| Élément | Emplacement | État |
| --- | --- | --- |
| État partagé maj interface | `handlers/settings-system.ts:103-153` (`UpdateState`, `refreshUpdateState`, watchdog 6 h) | ✅ sain |
| Sonde GitHub sans quota | idem `:62-96` — info/refs en premier, API en repli (constat bac à sable : 60 req/h) | ✅ sain, bien pensé |
| Dépôt du drapeau + journal initial | idem `:294-314` — écrit `[HH:MM:SS] Demande déposée… attente du lanceur (≤ 15 s)` | ✅ sain |
| Relais live du journal | `index.ts:488-512` — sondage 2 s, signature `mtimeMs:len`, plafond 64 Ko, diffusion `system:update-log:changed` | ✅ sain (un seul intervalle, fuite §60 corrigée) |
| `hello.update` | `index.ts:618-651` + fusion côté client `use-hermes-chat.ts:448-456` | ✅ sain |
| Toast « une fois par session » | `use-hermes-chat.ts:458-471` (garde `updateToastShownRef`) | ✅ sain |
| Pickup lanceur | `hermes-ui.ps1:950-979` / `hermes-ui.sh:305-322` — cycle 15 s, `MAJ DEBUT`, arrêt propre, relance | ✅ sain |
| Étapes racontées | `hermes-ui.ps1:380-485` + `792-811` + `1143-1155` (17 messages `Write-MajLog`) / `.sh:388-474` (12 messages) | ✅ sain — voir §3.1 pour le mapping |
| Verdict client | `system-section.tsx:40-52` (`majVerdict` : dernière ligne non vide contient `MAJ OK`/`MAJ ERREUR`) | ⚠️ voir A-1 |

### 1.2 Chaîne « moteur Hermes » (carte 2 de la maquette)

| Élément | Emplacement | État |
| --- | --- | --- |
| Cœur métier | `agent-motor.ts` (649 l.) — `hermesVersion` (cache 60 s), `fetchLatestRelease` (cache 15 min), `refreshMotorStatus`, `runSensesCheck`, `startAgentUpdate` (`hermes update --backup`), `startAgentRollback` (procédure officielle 3 étapes), watchdog 6 h | ✅ sain, testé |
| Handlers | `handlers/agent-motor.ts` (83 l.) — 6 événements, état `> 15 min` → re-sonde | ✅ sain |
| Journal moteur | `agent-motor.ts:127-147` — `db/agent-motor.log`, marqueurs `MOTEUR MAJ OK/ERREUR`, `RETOUR OK/ERREUR/EFFECTUÉ`, `CONTRÔLE OK` | ✅ sain |
| Carnet de bord | `fork.agent.journal` (100 entrées max, JSON en réglage) | ✅ sain |
| Filet version précédente | `fork.agent.previousVersion` — retenu à la maj, **consommé** au retour (`setSetting(AGENT_PREVIOUS_KEY, "")`) | ✅ sain |
| Dérive hors interface | `refreshMotorStatus:342-357` — version changée sans l'interface → carnet + filet recalés | ✅ sain (subtilité bien gérée) |
| Registre | `src/lib/settings.ts:327-338` — `fork.agent.update.autoCheck` (server, Système) déclaré | ✅ conforme R5 |
| Types du fil | miroir à la main dans `agent-motor-card.tsx:35-69` (le service ne peut pas être importé : `node:child_process`) | ✅ choix assumé, voir B-4 |

### 1.3 Chaîne d'affichage côté client

`page.tsx:548-568` → `SettingsPanel` (props `updateAvailable`, `appRevision`, `connected`, `onNavigateStorage`) → `SystemSection` → `AgentMotorCard`. Socket singleton `lib/socket.ts` (reconnexion infinie, `tryAllTransports`, jeton de service). Une seule source de vérité par donnée, aucun doublon de sonde. ✅

---

## 2. Constats A — à traiter PENDANT l'implémentation v3

### A-1. Le verdict « MAJ ERREUR » n'est pas fiable à 100 % (contrat implicite fragile)

`majVerdict` (`system-section.tsx:40`) lit **la dernière ligne non vide** du journal. Or le lanceur écrit parfois le verdict **avant** d'autres lignes :

- `hermes-ui.ps1:978` : `Do-Start` échoue → `MAJ ERREUR` écrit en catch — OK.
- Mais `hermes-ui.ps1:811` : « ATTENTION - build de production echoue — l'interface demarrera en mode developpement » est suivi de toute la séquence de démarrage normal puis **`MAJ OK` à `:1155`** — cohérent (le build dégradé aboutit quand même à une pile qui tourne).
- Cas réel de verdict décalé : `MAJ ERREUR` (ligne 978) **puis** le `finally` de Supervise continue d'écrire « arret des services... » après. Vérifié : l'ordre d'écriture est `MAJ DEBUT → … étapes → MAJ ERREUR/OK`, le verdict est bien terminal dans les deux lanceurs. **Le contrat tient** — mais il n'est garanti nulle part : c'est une convention tacite entre trois fichiers, dont deux hors du repo de l'interface (les lanceurs).

**Portée v3 :** le « fil raconté » de la maquette repose entièrement sur ce parsing. Recommandation : lors de l'implémentation, écrire dans le front un `parseMajJournal()` unique (mapping ligne → étape humaine, voir §3.1), tolérant : verdict = **dernière ligne contenant un marqueur**, pas dernière ligne tout court ; + commentaire dans les DEUX lanceurs pointant le contrat (`# les marqueurs MAJ OK / MAJ ERREUR sont lus par l'interface — ne pas écrire après`).

### A-2. Le scénario « silence 30 s » de la maquette promet un état que le client ne sait pas encore calculer proprement

La maquette affiche « Aucune nouvelle depuis 31 secondes ». Le client actuel a :
- `majLastChangeRef` + timer 45 s (`system-section.tsx:180-189`) — le mécanisme existe ;
- mais le relais service diffuse **tout le fichier** à chaque changement de signature : le client ne reçoit pas d'horodatage fiable par ligne autre que le `[HH:MM:SS]` en préfixe de chaque ligne du journal.

**Deux sous-constats :**
1. Le préfixe horodaté vient des lanceurs (`Write-MajLog` ps1 `:106-109`, `maj_log` sh `:74`) et du service (`settings-system.ts:303`) — **format homogène `[HH:MM:SS] `** ✅. Le « il y a N s » de la maquette peut donc être dérivé du préfixe de la dernière ligne : implémentable côté client sans toucher au service. ✅
2. **Piège d'horloge** : l'horodatage est celui de la machine du lanceur ; le « il y a N s » sera calculé sur l'horloge du navigateur. Même machine en usage desktop (portable/fixe) → écart négligeable ; mais si l'interface est ouverte depuis un autre poste (cas « autre poste » du repli), l'écart d'horloge peut fausser l'âge. Recommandation : calculer l'âge sur `mtimeMs` fourni par `majLogRead()` (déjà dans le snapshot, horloge du service) plutôt que sur le préfixe texte. Aucun changement de contrat nécessaire — `mtimeMs` est déjà diffusé.

---

## 3. Adéquation maquette v3 ↔ données réelles (le mapping complet)

### 3.1 Carte « L'application » — chaque ligne du fil a une source

| Affichage maquette | Source réelle | Disponible ? |
| --- | --- | --- |
| Pastille « À jour / Disponible / Erreur » | `updateState.available / error` (hello.update + system:update-state) | ✅ direct |
| « Dernière vérification : aujourd'hui à 09:12 » | `updateState.checkedAt` (ISO → heure locale) | ✅ direct |
| « La version d'avant reste en réserve » | ⚠️ **N'EXISTE PAS pour l'interface** — voir B-1 | ❌ à assumer |
| Aperçu « Ce qui change dans cette version » | ⚠️ **N'EXISTE PAS pour l'interface** — le service ne compare que des SHA ; pas de release notes côté hermes_ui | ❌ à assumer |
| Jalons Demande envoyée → Téléchargement → Installation → Vérification | à dériver du journal par mots-clés | ✅ mapping ci-dessous |
| « il y a N s » vivant | préfixe `[HH:MM:SS]` des lignes ou `mtimeMs` du snapshot | ✅ (voir A-2) |
| Garde-fou 30 s | `majLastChangeRef` (existant, seuil 45 s à réaccorder) | ✅ mécanisme existant |

**Mapping lignes lanceur → jalons v3** (les 17 messages ps1 + 12 sh se rangent en 4 jalons) :

| Jalon v3 | Lignes lanceur (ps1 / sh) |
| --- | --- |
| 1. Demande envoyée | `Demande déposée… (≤ 15 s)` (service) → `MAJ DEBUT` → `arret des services…` |
| 2. Téléchargement | `consultation de GitHub…` → `fusion directe impossible — sauvegarde…` → `version GitHub appliquée…` → `mise à jour appliquée : N fichier(s)` |
| 3. Installation | `code de l'interface modifie — reconstruction lancee (1 a 3 minutes)…` → `construction de l'interface…` → `construction terminee` / `reconstruction terminée` → `relance des services…` |
| 4. Vérification | `MAJ OK - pile relancee…` (+ le client confirme par re-check `system:update-check` après rechargement) |
| Erreur | `MAJ ERREUR - …` / `ATTENTION - …` (afficher en rouge, avec la fin de la phrase comme motif) |

Cas particuliers à traduire honnêtement dans le fil : `deja a jour — aucune nouvelle version` (maj demandée mais someone a mis à jour entre-temps → verdict « rien à faire, tout est déjà à jour »), `GitHub injoignable` (→ verdict erreur avec motif réseau), `remarque - le lanceur lui-meme a ete mis a jour…` (→ ligne d'information dédiée après MAJ OK : « une dernière chose : relancez Hermes-Web une fois »).

### 3.2 Carte « Hermes » — chaque ligne du fil a une source

| Affichage maquette | Source réelle | Disponible ? |
| --- | --- | --- |
| Pastille (à jour / dispo / en cours / ne répond plus) | `motorState.op / release / lastControl + journal` (logique existante `agent-motor-card.tsx:176-211`, à reprendre telle quelle) | ✅ |
| « Version 4.2.1, vérifiée à 09:12 » | `motorState.installed / checkedAt` | ✅ |
| « La version d'avant (4.2.0) reste en réserve : revenir en arrière » | `motorState.previousVersion` | ✅ direct |
| « Ce qui change dans Hermes 4.3.0 » | `release.notes` (markdown brut, 4 Ko max) + `touchesInterface` | ✅ — l'aperçu 3 lignes = les 3 premières entrées des notes ; le marqueur ⚠ = `touchesInterface` |
| « vous avez la 4.2.1 » | `motorState.installed` | ✅ |
| Bouton « Revenir à la version d'avant » | `agent:rollback-request` + confirmation (la fenêtre 3 promesses existante `agent-motor-card.tsx:659-710` est bonne, à conserver) | ✅ |
| « Revérifier » | `agent:check-request` | ✅ |
| Repli « Historique · N étapes » | `agent:journal` (`JournalWire[]`) | ✅ — mapping type : version→« noté », maj→« mise à jour », controle→« contrôle », retour→« retour » |
| Lien « préparer un message prêt à copier » | `messageATransmettre` (existant `agent-motor-card.tsx:237-255`) | ✅ |
| Jalons maj moteur | `agent:update-log:changed` + marqueurs `MOTEUR MAJ OK` / `CONTRÔLE OK` | ✅ |

### 3.3 Ce que la maquette montre mais que le code ne fournit pas (décisions à prendre)

1. **Aperçu des changements de l'application** : hermes_ui n'a pas de releases GitHub alimentées (le service compare des SHA de commits, pas des tags). Options : (a) virer l'aperçu de la carte application (recommandé : un bouton + le fil suffisent — cohérent avec « moins de clics ») ; (b) demander un `git log --oneline installed..available` au service (nouvel événement, léger). **Décision à valider avant implémentation.**
2. **« La version d'avant reste en réserve » pour l'application** : le lanceur ne garde pas de pointeur de retour (aucun `rollback` interface — vérifié : 0 occurrence). La maquette l'affiche au scénario calme. Options : (a) ne l'afficher que pour Hermes, pas pour l'application (honnête) ; (b) l'écrire côté service à chaque vérification (`installed` devient « version d'avant » quand ça change — mais sans mécanisme de retour exécutable, c'est une demi-promesse). **Recommandation : (a)** — et le « filet » actuel (git checkout manuel documenté) peut rester un lien discret du fil.
3. **Timings du déroulé maquette** : accélérés ×4 pour la démo. Les durées réelles à annoncer dans le fil : pickup ≤ 15 s, fetch GitHub variable, reconstruction 1-3 min **si** `src/` ou configs touchées (déjà correctement prédit par `Test-FilesChanged` ps1:478-487). Le texte v3 « 1 à 2 minutes » doit devenir « 1 à 2 minutes, davantage si reconstruction (annoncée dans le fil) ».

---

## 4. Constats B — fragilités du socle (à corriger, découplable de la v3)

### B-1. Aucun retour arrière de l'interface, mais l'UI v0.4.1 en parle comme d'une procédure
`system-section.tsx:437-462` documente un `git checkout` manuel — honnête mais c'est exactement le genre de texte machine que la v3 supprime. L'implémentation v3 doit trancher §3.3-2. Le lanceur, lui, **sauvegarde** les fichiers locaux divergents avant alignement (`hermes-ui.ps1:400-467`, dossier `desktop/runtime/maj-sauvegarde-<date>` + LISEZMOI.txt) : fait réel, méconnu, à mentionner dans le fil v3 (« vos modifications locales sont mises de côté, pas perdues ») plutôt que le git checkout.

### B-2. `system:update-request` : le journal est écrasé sans condition
`settings-system.ts:302-305` réécrit `maj.log` à chaque demande. Si deux clients cliquent « Mettre à jour » (ou double-clic), la deuxième demande repart d'une page blanche et le drapeau est re-posé alors que le lanceur est peut-être déjà en train de traiter la première (fenêtre de 15 s). Conséquence v3 : fil réinitialisé au milieu du déroulé. Correctif léger au moment de l'implémentation : ignorer la pose si `updateState` est « en cours » — mais **l'état « en cours » n'existe pas côté service** (il ne sait pas si le lanceur a ramassé le drapeau). D'où le constat suivant.

### B-3. Le service ne connaît pas l'état d'avancement de l'application
L'état partagé `UpdateState` ne distingue pas « maj en cours » : le client le déduit du journal (présence + pas de verdict). C'est suffisant (mécanisme v0.2.1 éprouvé) MAIS la reprise après F5 repose sur un test d'âge (`system-section.tsx:193-207`, journal < 10 min et sans verdict). Le relais 2 s + `mtimeMs` rendent ça robuste en pratique. **Pas de changement requis pour la v3** ; noter juste que le badge orange du rail (`updateAvailable`) reste « disponible » pendant toute la maj (le service ne re-vérifie qu'après relance — la nouvelle révision devient `installed` et le badge s'éteint naturellement). Acceptable ; le fil de la carte, lui, montre la vérité.

### B-4. Duplication des types du fil (miroir à la main)
`agent-motor-card.tsx:35-69` recopie `MotorState/MotorControl/JournalWire/AgentRelease` du service. Le fichier `mini-services/hermes-chat/shared/chat-protocol.ts` existe précisément pour ça (`UpdateCheckResult` y vit déjà et est réexporté par `src/lib/chat-types.ts:20`) — mais `agent-motor.ts` importe `node:child_process`, donc non importable tel quel par le client. Correctif propre (Lot hygiène, pas bloquant) : déplacer les interfaces du fil dans `shared/chat-protocol.ts` et les importer des deux côtés.

### B-5. Journal moteur plafonné côté application, pas côté fichier
`motorLogRead` lit tout le fichier (`agent-motor.ts:127-134`) sans plafond — contrairement au journal interface (64 Ko, `index.ts:497`). Un `agent-motor.log` qui grossit (chaque maj y accumule) finira par alourdir chaque diffusion `agent:update-log:changed`. Correctif une ligne au moment du v3 : même plafond 64 Ko sur la queue.

### B-6. Petit mensonge d'affichage : « MAJ OK » ≠ interface vérifiée
Après « MAJ OK - pile relancee », la v0.4.1 demande à l'utilisateur de recharger. La maquette v3 fait mieux (bouton « Recharger la page » = `location.reload()`), mais la vérification post-rechargement n'existe pas : personne ne re-déclenche `system:update-check` après le retour du service. À câbler dans l'implémentation v3 : au `connect` de la socket pendant/après une maj (le hook `onConnect → majFetch` existe déjà `system-section.tsx:175`), ajouter un `system:update-check` silencieux — le badge s'éteint et le fil passe « À jour, vérifié à HH:MM » sans action.

---

## 5. Constats C — dettes voisines héritées (hors périmètre v3, pour mémoire)

Relevés dans `docs/AUDIT-CONSOLIDE.md`, non re-vérifiés ligne à ligne aujourd'hui mais toujours dans le code au commit audité :

- **L1-1 CORS/jeton** : partiellement corrigé depuis (le lanceur génère `service-token.env`, `Ensure-ServiceToken` ps1:985+ ; la socket cliente envoie `auth.token`, `lib/socket.ts:29`) — le statut exact du reste (Caddy figé) reste celui du Lot 1 de la roadmap.
- **M-8 `emitWithAck` sans timeout** : pattern présent dans les handlers agent-motor (acks en callback manuel — pas concerné) mais le risque générique demeure ailleurs.
- **4.2 toast `connect_error`** : la reconnexion infinie de `lib/socket.ts` peut toast-er en boucle sur un service down — pendant une maj interface, la socket coupe **par design** : l'implémentation v3 doit vérifier ce que fait ce toast pendant la fenêtre de redémarrage (sinon doublon avec le message « reconnexion en cours » du fil). **À vérifier au moment du câblage — c'est le seul point C qui touche directement la v3.**

---

## 6. Ce qui a été exécuté aujourd'hui (preuves)

| Vérification | Résultat |
| --- | --- |
| `tsc --noEmit` (front, racine) | 0 erreur |
| `tsc --noEmit` (service) | 0 erreur |
| `eslint` sur system-section, agent-motor-card, settings-panel, use-hermes-chat | 0 erreur, 0 warning |
| `bun run scripts/test-agent-motor-flow.ts` | **34/34** (version, contrôle, maj, filet, problème, retour, carnet, refus sans précédente) |
| Lecture intégrale : les 2 composants Système, settings-panel, les 2 handlers, agent-motor.ts, index.ts (extraits), context.ts (extraits), les 2 lanceurs (extraits ciblés), use-hermes-chat (extraits), page.tsx (extraits), socket.ts, settings.ts (registre), chat-protocol.ts (types) | fait |

---

## 7. Feuille de route d'implémentation proposée (pour la prochaine session)

1. **Décisions à faire valider** (§3.3) : aperçu changements application (recommandé : non), « version d'avant » application (recommandé : non, Hermes seulement), texte des durées.
2. **Nouveau composant** `system-section.tsx` v3 (R1 : réécriture du fichier, pas de patch) + `bits.tsx` conservé (pastilles). `agent-motor-card.tsx` absorbé dans la nouvelle grammaire.
3. **Pendant l'implémentation** : `parseMajJournal()` unique (A-1), âge des lignes sur `mtimeMs` (A-2), re-check silencieux au `connect` post-maj (B-6), garde anti double-demande (B-2, minime : désactiver le bouton dès la première demande, état local).
4. **Découplable ensuite** : types partagés dans `chat-protocol.ts` (B-4), plafond journal moteur (B-5), audit du toast `connect_error` pendant maj (C/4.2).
5. **QA** : rejouer `test-agent-motor-flow.ts` (doit rester 34/34 — le service ne bouge pas), parcourir les 5 scénarios maquette contre la vraie pile (`qa-v040-motor.ts` comme trame), tsc + eslint.

---

*Rapport d'audit — aucune ligne de code modifiée. Conventions R6/R7 respectées : français, décision à consigner au FORK.md §9 lors de l'implémentation.*
