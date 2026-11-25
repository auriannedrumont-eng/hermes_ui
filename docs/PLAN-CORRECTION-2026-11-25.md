# Plan de correction de l'intégration hermes_ui / hermes-agent

**Référentiel** : rapport d'analyse du 25 novembre 2026 (neuf constats)
**Skill de mesure** : unclebob/crapper — CRAP = CC² × (1 − couverture)³ + CC
**Périmètre** : `mini-services/hermes-chat`, lanceurs `desktop/`, banc QA
**Barre du dépôt** : aucune fonction de production au-dessus de CC 100
**Date** : 25 novembre 2026

**État d'avancement (25/11, soir)** : C1 à C4 livrés (journal §9-17), **C5, C6 et C7 livrés** (journal §9-18) — le plan est intégralement exécuté. Mesures finales crapper : runGatewayTurn **78 → 5** (budget ≤ 25), handle 17 ≤ 20, dispatch 12 ≤ 12, mintGatewayAttach 8 ≤ 12 ; QA canonique 30/30 (fausse gateway v2 parlant le contrat réel), suite 34/34, Vitest 144/144.

---

## 1. Synthèse du plan

Ce plan transforme les neuf constats du rapport d'analyse en **sept chantiers de correction**, ordonnés en trois phases et bornés par des critères de sortie mesurables. Le fil directeur : rendre réel le contrat que la documentation du fork promet déjà — « lancer l'agent suffit, l'interface se branche seule » — puis faire vivre contre l'agent réel ce qui aujourd'hui n'existe que contre des simulateurs périmés.

Deux chantiers (C1, C2) débloquent le scénario nominal en une journée ; trois chantiers (C3, C4, C5) réparent les fonctions périphériques cassées (pièces jointes, tours longs, socket par tour) ; deux chantiers (C6, C7) rétablissent la confiance (réglages honnêtes, QA fidèle au protocole réel).

La skill **crapper** est chargée et utilisée de bout en bout : elle a produit la base de référence du périmètre (chapitre 4), fixe un budget de complexité par fonction modifiée et par nouveau module, et s'intègre aux critères de sortie de chaque chantier comme au contrôle final (commandes en annexe B). La barre du dépôt — aucune fonction de production au-dessus de CC 100 — reste le plafond dur ; le chantier C5 impose en outre de ramener `runGatewayTurn` (CC 77) sous 25 en le découpant.

**Effort total estimé** : environ sept jours de travail, dont deux à trois pour C5. Chaque chantier respecte les conventions du dépôt (FORK.md §5) : éditions minimales sur les fichiers sensibles, nouvelles fonctionnalités dans de nouveaux fichiers, suite QA existante repassée à chaque clôture, entrée de journal §9 consignée. Aucun chantier ne modifie le moteur amont : tout se joue côté interface.

---

## 2. Diagnostic de départ (rappel)

Le rapport d'analyse a établi que le moteur démarre correctement (la commande de lancement est la commande officielle), mais que l'interface ne parvient ni à le joindre en configuration par défaut, ni à exploiter certaines fonctions une fois branchée.

| N° | Constat | Gravité | Chantier |
|----|---------|---------|----------|
| 1 | Port 9120 fermé par défaut : sans bloc `webapp`, écoute sur port éphémère | Critique | C1, C2 |
| 2 | URL d'attachement renvoyée par le moteur, ignorée par le connecteur | Critique | C2 |
| 3 | Pièces jointes refusées : images uniquement, répertoire de staging imposé | Majeure | C3 |
| 4 | Timeout de tour à 180 s coupant les tours longs de l'agent | Majeure | C4 |
| 5 | Socket refermée après chaque tour ; sessions récoltées après 20 s | Majeure | C5 |
| 6 | Prompt système, mémoire, effort, température non transmis au moteur | Moyenne | C6 |
| 7 | Sonde REST `/v1/capabilities` sur l'écouteur 9120, contrat vivant sur 8642 | Moyenne | C2 (note) |
| 8 | QA sur une fausse gateway parlant l'ancien protocole `api_turn_v1` | Majeure | C7 |
| 9 | FORK.md / DEMARRAGE.md décrivent encore `api_turn_v1` | Mineure | C7 |

Deux points encadrent le plan. D'abord, ce qui fonctionne déjà — la commande de lancement, le protocole JSON-RPC `session.create` / `prompt.submit`, les noms d'événements, la mémoire de conversation par identifiant déterministe — n'est **pas** à refaire : les chantiers corrigent la découverte et la périphérie, pas le cœur. Ensuite, le mode « pool de clés » qui masque la panne reste utile en repli : aucun chantier ne le supprime, mais C6 rend visible la différence entre « le modèle a répondu » et « l'agent a travaillé ».

---

## 3. Objectifs, principes et critères de succès

### 3.1 Objectifs mesurables

- **O1** : branchement automatique sans aucune configuration manuelle, y compris quand le moteur écoute sur un port éphémère.
- **O2** : un tour avec image jointe aboutit contre l'agent réel (PNG accepté, réponse rendue).
- **O3** : un tour d'agent de dix minutes n'est plus coupé par l'interface.
- **O4** : trois messages espacés d'une minute gardent la session moteur chaude (aucun `ws_orphan_reap` dans le journal amont entre les tours).
- **O5** : la suite QA du dépôt s'exécute contre un simulateur parlant le protocole canonique, et les budgets CRAP du chapitre 4 sont tenus.

### 3.2 Principes exécutifs

Le plan épouse les règles du dépôt plutôt que de les contourner. R1 du FORK.md : les nouvelles unités vivent dans de **nouveaux fichiers**, et les éditions sur `hermes-connector.ts` — fichier déclaré sensible — restent minimales jusqu'à C5. La QA suit la culture existante : repasser `tsc` ×3 et ESLint, les scripts `test-*-flow.ts`, le harnais des lanceurs et Vitest à chaque clôture, puis consigner une entrée datée au journal §9. Enfin, principe de vérité : quand un réglage ne peut pas être transmis au moteur, l'interface le dit au lieu de l'accepter en silence — c'est le cœur de C6.

### 3.3 Critères de succès globaux

| Objectif | Mesure de succès | Où ça se vérifie |
|----------|------------------|------------------|
| O1 Branchement | Certification du lanceur réussie sans config manuelle ; hello « mode gateway » sans ressaisie | Journal du lanceur + hello rediffusé |
| O2 Images | Tour avec PNG : réponse complète ; PDF → message clair, tour annulé proprement | QA E2E + agent réel |
| O3 Tours longs | Tour simulé de 10 minutes mené à terme ; timeout remplacé par une garde d'inactivité de 240 s | Simulateur à latence réglable |
| O4 Session chaude | Aucun reap entre deux messages espacés ; reconnexion < 2 s après coupure | Journal amont + sonde de reconnexion |
| O5 Qualité | `crapper --threshold 100` exit 0 ; budgets tenus ; QA canonique verte | CI + annexe B |

---

## 4. Mesure de référence CRAP et budgets

Mesure produite avec la skill crapper sur `mini-services/hermes-chat/` en `--no-coverage` (la couverture n'est pas instrumentée sur le service ; la complexité seule est la métrique disponible). Le périmètre compte 38 fonctions au-dessus de CC 20 ; la plus complexe du couplage agent reste `runGatewayTurn` (CC 77), suivie de `parseModelOptions` (CC 66) et `runAssistantTurn` (CC 84, côté orchestration).

*(figure budgets CRAP : voir docs/crap-2026-11/ — CC mesuré vs budget exigé, mesure crapper du 25/11)*

### Tableau 3 : budgets des fonctions modifiées

| Fonction | Fichier | CC aujourd'hui | Budget | Chantier |
|----------|---------|---------------|--------|----------|
| `runGatewayTurn` | hermes-connector.ts | **77** | **≤ 25** | C5 |
| `parseModelOptions` | hermes-connector.ts | **66** | ≤ 40 | C5 (option) |
| `runAssistantTurn` | turn-runner.ts | **84** | ≤ 84 (plafond) | C6 |
| `mintGatewayTicket` | hermes-connector.ts | 10 | ≤ 12 | C2 |
| `startAgentGatewayIfDown` | agent-starter.ts | 22 | ≤ 22 (plafond) | C1 |
| `hasRestContract` | hermes-connector.ts | 9 | ≤ 9 (plafond) | C2 (note) |

### Tableau 4 : budgets des nouvelles unités (convention R1 : nouveaux fichiers)

| Nouvelle unité | Module prévu | Budget CC | Chantier |
|----------------|--------------|-----------|----------|
| `connect()` — cycle de vie, ticket, reconnexion | gateway-channel.ts | **≤ 20** | C5 |
| `rpc()` — framing JSON-RPC, registre des rejets | gateway-wire.ts | **≤ 12** | C5 |
| `dispatchTurnEvents()` — événements → callbacks | gateway-events.ts | **≤ 20** | C5 |
| `buildAttachments()` — images vers `image.attach_bytes` | gateway-attachments.ts | **≤ 8** | C3 |
| `inactivityGuard()` — remplace le timeout de durée | hermes-connector.ts | **≤ 10** | C4 |
| handlers du simulateur canonique | scripts/fake-gateway-v2.ts | **≤ 20** | C7 |

> Mesures crapper du 25 novembre 2026 sur les dépôts au HEAD. Les scripts PowerShell et Bash des lanceurs ne sont pas mesurés par crapper (langages non supportés) : C1 est vérifié par le harnais des lanceurs.

---

## 5. Les sept chantiers

### 5.1 C1 — Provisionnement du bloc webapp (P0)

- **Constat visé** : n°1 — port 9120 fermé par défaut
- **Fichiers** : `desktop/hermes-ui.ps1`, `desktop/hermes-ui.sh`
- **Effort** : ~1 heure

Le lanceur Windows écrit déjà le bloc `model:` du `data/config.yaml` de la maison (fonction `Ensure-AgentCles`). C1 y ajoute, dans la même passe idempotente, le bloc que le moteur attend pour ouvrir son écouteur stable : `webapp: {enabled: true}`. L'écriture réutilise le mécanisme existant UTF-8 sans BOM et la garde de non-régression : si une ligne `webapp:` existe déjà, on n'y touche pas ; une variable `HERMES_DISABLE_WEBAPP=1` laisse l'installation spéciale vivre sa vie.

| Critère de sortie | Valeur exigée | Vérification |
|---|---|---|
| Bloc webapp écrit | Présent dans config.yaml après 1er lancement, idempotent au 2e | Harnais des lanceurs |
| Port 9120 ouvert | Certification `agent-certifie.ok` au 1er lancement propre | Journal du lanceur |
| Non-régression | tsc ×3, ESLint, suite QA au vert | CI du dépôt |

### 5.2 C2 — Consommer l'URL d'attachement du moteur (P0)

- **Constat visé** : n°2 (et note sur n°7)
- **Fichiers** : `mini-services/hermes-chat/hermes-connector.ts`
- **Effort** : ~3 heures

Le moteur répond déjà à « où es-tu ? » : `gateway attach --json` renvoie `url`, `protocols` et `ticket`, l'URL étant l'origine réelle de l'écouteur, port compris. Le connecteur jette cette moitié de la réponse. Le changement tient en trois temps :

1. `mintGatewayTicket()` → `mintGatewayAttach()` retournant `{ ticket, url }` (tolérant si `url` absente sur un moteur ancien).
2. Résolution de l'URL cible : **interface > `HERMES_GATEWAY_URL` > URL d'attachement > défaut 9120** — appliquée au `probe()` et au tour quand l'URL active est encore le défaut.
3. `toHttpBase()` suit automatiquement (il dérive de `gatewayUrl`), donc la liste des modèles et la sonde REST parlent à la bonne origine sans code supplémentaire.

La garde S-02 est préservée : une URL d'attachement est une origine locale du même moteur ; le jeton saisi manuellement, lui, n'est jamais retransmis vers une URL différente.

| Critère de sortie | Valeur exigée | Vérification |
|---|---|---|
| URL consommée | Dial sur l'URL renvoyée par `attach` ; 9120 n'est plus qu'un repli | Test unitaire du parse |
| Branchement port éphémère | Simulateur sur port aléatoire : branchement via l'URL | QA E2E |
| Tolérance moteur ancien | `attach` sans `url` → repli 9120 sans erreur | Cas de test dédié |
| Budget CRAP | `mintGatewayAttach` ≤ 12 | crapper |

### 5.3 C3 — Pièces jointes conformes au contrat du moteur (P1)

- **Constat visé** : n°3 — attachments refusés (`invalid_params`)
- **Fichiers** : `hermes-connector.ts` + nouveau `gateway-attachments.ts`
- **Effort** : ~4 heures

Le moteur n'accepte en `prompt.submit` que des images (png, jpeg, gif, webp) dont le fichier est déjà dans le cache de staging du profil. Le connecteur envoie des chemins dans `db/` de l'interface avec un mime quelconque : tout tour avec pièce jointe est refusé.

C3 introduit `buildAttachments()` : pour chaque pièce image, lecture des octets côté service, appel RPC `image.attach_bytes` (params `content_base64`, `filename`, `ext`) sur la session tout juste créée, récupération du chemin stagé, puis inclusion de `{path, mime}` dans `prompt.submit`. L'ordre devient : `session.create` → `image.attach_bytes` × N → `prompt.submit`. Pour une pièce non image, le tour ne part pas : message explicite à l'utilisateur au lieu du refus illisible.

| Critère de sortie | Valeur exigée | Vérification |
|---|---|---|
| Image acceptée | Tour avec PNG réel : réponse complète | QA E2E + agent réel |
| Non-image honnête | PDF → message clair, tour non soumis | Cas de test dédié |
| Budget CRAP | `buildAttachments` ≤ 8 | crapper |

### 5.4 C4 — Durée des tours et battement de cœur (P1)

- **Constat visé** : n°4 — timeout 180 s contre les tours longs
- **Fichiers** : `hermes-connector.ts`
- **Effort** : ~2 heures

`TURN_TIMEOUT_MS = 180_000` ferme la WebSocket et échoue le tour au bout de trois minutes, alors que l'agent peut travailler bien plus longtemps. C4 remplace ce plafond de **durée** par une **garde d'inactivité** : le tour vit tant qu'un événement quelconque arrive ; 240 secondes de silence consécutives déclenchent la clôture avec cause lisible. L'abort utilisateur reste immédiat, le partiel reçu reste rendu, la fermeture sans fin annoncée reste une erreur.

En parallèle, le connecteur émet `gateway.ping` toutes les 15 secondes pendant le tour : la connexion morte se détecte en quinze secondes, et le marqueur de liveness côté moteur reste frais.

| Critère de sortie | Valeur exigée | Vérification |
|---|---|---|
| Tour long | Tour simulé de 10 minutes mené à terme | Simulateur à latence réglable |
| Garde d'inactivité | Silence de 240 s → clôture avec cause | Cas de test dédié |
| Battement de cœur | `gateway.ping` toutes les 15 s | Journal du simulateur |
| Budget CRAP | `inactivityGuard` ≤ 10 | crapper |

### 5.5 C5 — Socket persistante et découpage de runGatewayTurn (P1)

- **Constat visé** : n°5 — socket par tour, récolte à 20 s, CC 77
- **Fichiers** : nouveau `gateway-channel.ts` + `gateway-wire.ts` + `gateway-events.ts` ; `hermes-connector.ts` allégé
- **Effort** : 2-3 jours

L'architecture actuelle — une WebSocket par tour, refermée dans `finish()` — affronte le contrat amont : à la déconnexion, le moteur détache la session et programme la récolte de l'orphelin après 20 s de grâce. C5 introduit `gateway-channel.ts` : une WebSocket unique par service, maintenue ouverte entre les tours, reconnexion à backoff (1 s, 2 s, 4 s… plafond 30 s), re-mint du ticket à chaque reconnexion.

Les tours deviennent des locataires du canal ; le framing JSON-RPC part dans `gateway-wire.ts`, le montage d'événements dans `gateway-events.ts`, et `runGatewayTurn` garde l'orchestration seule (CC ≤ 25).

Garde de concurrence : les modes multi-voix (débat) doivent éclater leurs identités (`ui-<conv>-a` / `-b`) pour occuper des sessions distinctes.

| Critère de sortie | Valeur exigée |
|---|---|
| Session chaude | 3 messages espacés de 60 s : aucun reap amont |
| Reconnexion | Coupure en plein tour → reconnexion < 2 s |
| Budget CRAP | `runGatewayTurn` ≤ 25 ; nouvelles unités ≤ 20 |

### 5.6 C6 — Honnêteté des réglages côté agent (P2)

- **Constat visé** : n°6 — réglages non transmis
- **Effort** : ~2 heures

En mode agent, le connecteur n'envoie que le contrat fermé. C6 transmet ce qui est transmissible : `model_override` s'enrichit de `{model, provider, reasoning}` (l'effort part dans `reasoning`). Pour le reste (prompt de conversation, mémoire, température) : badge « sans effet sur l'agent — voir la configuration du profil » en mode agent.

### 5.7 C7 — QA canonique et documentation à jour (P2)

- **Constat visé** : n°8-9 — QA sur protocole fantôme, doc périmée
- **Effort** : ~4 heures

Remplacement des simulateurs `api_turn_v1` par `fake-gateway-v2.ts` fidèle au contrat canonique (tickets, JSON-RPC, événements réels, récolte d'orphelin). Documentation remise au diapason : les mentions `api_turn_v1` de FORK.md et DEMARRAGE.md décrivent le protocole canonique.

---

## 6. Séquencement et jalons

| Phase | Jours | Chantiers | Jalon de sortie |
|-------|-------|-----------|-----------------|
| Phase 0 — Déblocage | J1 | C1 puis C2 | **J1** : branchement automatique sans config manuelle |
| Phase 1 — Fonctions | J2-J4 | C7 (noyau), C3, C4 | **J2** : tour avec image ; **J3** : tour de 10 min tenu |
| Phase 2 — Structure | J5-J8 | C5, C6, finitions C7 | **J4** : session chaude ; budgets CRAP tenus |

Si le temps doit être compressé : C6 est reportable sans risque ; C4 peut se livrer en version minimale ; C1 et C2 ne sont pas compressibles. À l'inverse, C5 ne doit jamais être improvisé en dernière heure.

---

## 7. Risques transverses et mitigations

| Risque | Nature | Mitigation |
|--------|--------|------------|
| Régression du mode pool | C2-C5 touchent l'aiguillage | Suites QA repassées à chaque chantier |
| Ticket et URL volatils | Ticket one-use ; port changeant | Re-mint à chaque reconnexion ; re-résolution par attach |
| Débat parallèle refusé | Soumissions concurrentes (busy) | Sessions par voix `ui-<conv>-a/-b` |
| Divergence moteur | `attach` sans url sur moteur ancien | Dégradation douce : repli 9120 |
| Fuite de credential | Tickets/jetons dans les traces | Interdiction de journaliser le ticket ; S-02 inchangée |

---

## 8. Vérification finale et workflow crapper

La skill crapper entre dans le rituel de clôture de chaque chantier puis dans le contrôle final. La clôture globale exige : critères des sept chantiers vérifiés ; `crapper --threshold 100` en exit 0 ; budgets des tableaux 3-4 tenus ; QA complète du dépôt au vert ; et une passe réelle sur l'agent consignée au journal §9.

---

## Annexe A — Spécifications d'édition précises

### A.1 C2 — retour structuré du ticket (`hermes-connector.ts:85-114`)

```ts
// AVANT : seul le ticket est extrait, parsed.url est jeté
const parsed = JSON.parse(out.stdout) as { ticket?: string; protocols?: string[] };
const ticket = parsed.ticket ?? parsed.protocols?.find(...)?.slice(...);
if (ticket) return ticket;

// APRÈS : ticket + URL d'attachement (tolérant aux moteurs anciens)
const parsed = JSON.parse(out.stdout) as { ticket?: string; url?: string; protocols?: string[] };
const ticket = parsed.ticket ?? parsed.protocols?.find(...)?.slice(...);
if (ticket) return { ticket, url: typeof parsed.url === "string" ? parsed.url : null };
```

### A.2 C2 — résolution de l'URL cible (`hermes-connector.ts:325-366`)

```ts
// APRÈS : avant chaque dial (probe et tour), si l'URL active est le DÉFAUT,
// l'URL d'attachement remplace le 9120 en dur.
const attach = await mintGatewayAttach();
if (attach?.url && this.gatewayUrl === DEFAULT_GATEWAY_URL) {
  this.gatewayUrl = attach.url;   // toHttpBase() suit automatiquement
}
```

### A.3 C3 — dépôt d'image avant soumission

```ts
// Ordre : session.create -> image.attach_bytes x N -> prompt.submit
const staged = await rpc("image.attach_bytes", {
  content_base64: bytes.toString("base64"), filename: a.name, ext: extOf(a.mime),
});
// puis attachments.push({ path: staged.path, mime: a.mime })
```

### A.4 C4 — garde d'inactivité à la place du plafond de durée (ligne 673)

```ts
// AVANT : plafond de durée, quel que soit l'activité de l'agent
const timer = setTimeout(() => finish(new Error("Timeout du tour gateway")), TURN_TIMEOUT_MS);

// APRÈS : inactivité (tout événement reçu réarme) + battement de cœur
const guard = inactivityGuard(240_000, () => finish(new Error(
  "Aucune activité de l'agent depuis 4 minutes")));
```

### A.5 C1 — bloc webapp dans `Ensure-AgentCles` (`desktop/hermes-ui.ps1`)

```powershell
# Idempotent, même mécanisme UTF-8 sans BOM que le bloc model:
if (-not $env:HERMES_DISABLE_WEBAPP -and -not ($cfgTxt -match "(?m)^webapp:")) {
  $cfgTxt += "`nwebapp:`n  enabled: true`n"
}
```

---

## Annexe B — Commandes crapper du plan

```bash
# 1. Base de référence du périmètre
crapper --no-coverage mini-services/hermes-chat/

# 2. Mesure ciblée à la clôture d'un chantier (ex. C5)
crapper --no-coverage mini-services/hermes-chat/hermes-connector.ts \
  mini-services/hermes-chat/gateway-channel.ts

# 3. Gardien de CI : barre du dépôt (exit 2 si une fonction dépasse 100)
crapper --threshold 100 --no-coverage mini-services/hermes-chat/

# 4. Sonde rapide pendant le développement (filtrage par fragment)
crapper combat gateway- --no-coverage

# 5. Changements du jour uniquement
crapper --changed --no-coverage
```

Lecture : en `--no-coverage`, la colonne CC est la métrique de pilotage — c'est elle que les budgets bornent. Un dépassement à la clôture exige une entrée de journal §9 qui le justifie.
