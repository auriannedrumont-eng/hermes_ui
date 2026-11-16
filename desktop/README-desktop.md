# Hermes Web — Une seule icône, installation portable (Windows et Linux)

**Windows : un seul fichier à la racine du dossier `hermes` —
`Hermes-Web.bat`.** Double-clic dessus et c'est tout.

- **1er double-clic** : installe automatiquement tout ce qui manque **à
  l'intérieur du dossier hermes** (sous-dossier `tools\`) — Node.js v22 LTS,
  Bun, Caddy, chrome-headless-shell (rendu PNG/PDF des artefacts et partages)
  et ffmpeg (transcription vocale), puis les dépendances npm/bun et le build de
  production de l'interface. Aucune ligne de commande, aucun droit
  administrateur, **rien n'est écrit hors du dossier**. Comptez quelques
  minutes (téléchargements + installations) avec la progression affichée
  dans la fenêtre.
- **Double-clics suivants** : vérification silencieuse des mises à jour
  GitHub (dossier cloné en git : nouveaux commits récupérés par fusion
  rapide, jamais bloquante), démarrage quasi instantané de la pile
  (mini-service chat, interface Next.js, passerelle Caddy) puis ouverture
  du navigateur.
- **Fermer la fenêtre du lanceur (ou Ctrl-C)** : arrêt propre de toute la
  pile.

Le dossier `hermes` est **autonome et mobile** : copiez-le où vous voulez,
y compris sur un disque externe ou une clé USB — tout vit dedans :
outils (Node, Bun, Caddy), dépendances, build, base de données,
pièces jointes… et même les **caches npm/bun** (redirigés vers `tools\`,
rien ne s'écrit dans votre profil Windows). Vous pouvez le renommer, le
déplacer, le mettre sur une autre machine sans Node préinstallé : il
fonctionnera. La télémétrie de Next.js est désactivée.

> Note : le fichier `.bat` porte l'icône générique de Windows (limite du
> format). Si vous préférez le logo Hermes, faites un clic droit sur
> `Hermes-Web.bat` → *Envoyer vers → Bureau (créer un raccourci)* ;
> l'icône `desktop\hermes.ico` peut lui être appliquée (clic droit sur le
> raccourci → Propriétés → Changer d'icône). Rien d'obligatoire.

> Si Windows affiche « Windows a protégé votre ordinateur » au premier
> lancement (fichier téléchargé depuis Internet) : *Informations
> complémentaires → Exécuter quand même*.

## Ce que l'icône unique fait, dans l'ordre

1. Si Hermes tourne déjà → le navigateur rouvre sur l’onglet existant :
   celui-ci est actualisé (il charge la toute dernière version) et le
   nouvel onglet se referme de lui-même — plus d’onglets qui s’empilent
   (détail ci-dessous, « Un seul onglet »).
2. Outils → d'abord la **copie portable de `tools\`** si elle existe (le
   dossier se suffit à lui-même) ; sinon **téléchargement dans `tools\`**
   — même si l'outil est déjà installé sur le système, pour que le dossier
   déplacé reste complet ; en cas d'échec du téléchargement, la copie du
   système est utilisée à défaut. Node v22.20.0 (LTS) et Bun en zip
   officiels, Caddy en exe officiel, chrome-headless-shell en zip Chrome
   for Testing (la variable `CHROME_HEADLESS_PATH` est réglée par le lanceur)
   et ffmpeg en zip « essentials ».
3. **Mise à jour automatique** (si le dossier est un clone git) : les
   derniers commits poussés sur GitHub sont récupérés et appliqués par
   fusion rapide. Si le dossier contient des différences locales (anciens
   fichiers modifiés, restes d'une extraction zip), elles sont **mises de
   côté en sécurité** (`desktop\runtime\maj-sauvegarde-…\`) puis la
   version GitHub est appliquée — vos données (conversations, réglages,
   clés) vivent ailleurs et ne sont jamais touchées. La
   première fois, une fenêtre GitHub peut demander de se connecter (c'est
   le gestionnaire d'identifiants de git ; il retient ensuite).
   Dépendances et build sont refaits **seulement si nécessaire** — un push
   de documentation seule ne déclenche aucune reconstruction. Sans réseau
   ou sans git : Hermes démarre quand même avec la version présente.
4. `node_modules` manquants **ou dépendances modifiées par la mise à
   jour** → `npm install` (interface) et `bun install` (mini-service),
   sortie en direct dans la fenêtre.
5. **Build de production** de l'interface
   (`next build` + copies `static`/`public`, une seule fois — refait
   automatiquement après une mise à jour qui touche le code). Si le build
   échoue : bascule en mode développement avec un **avertissement jaune
   visible dans la fenêtre** et pose un marqueur `tools\build-echoue.flag`
   **qui mémorise la version et l'heure de la tentative** — une nouvelle
   version (mise à jour) retente le build, et une même version est
   **retentée au bout de 24 h** (jamais en boucle) ; effacez le fichier
   pour forcer immédiatement.
6. Démarrage de la pile : mini-service → interface → passerelle, navigateur
   ouvert sur `http://127.0.0.1:81/` (ou 8081/8181… si le port est pris).
7. Surveillance : un composant qui plante est relancé (3 essais), puis
   arrêt général propre si ça persiste. Vérifications **toutes les 15 s**,
   volontairement légères (voir « Chaleur du processeur » ci-dessous).
8. Toute la pile tourne en **priorité basse** (Job Object) : dès qu'un
   autre logiciel demande du processeur, Hermes lui cède la place.

### Mettre à jour sans rien fermer (bouton dans l'interface)

Paramètres → Système → **« Mettre à jour »** : la demande est déposée au
lanceur (drapeau `desktop\runtime\maj-demandee.flag`), ramassée au cycle de
surveillance suivant (15 s) — arrêt propre, mise à jour GitHub,
reconstruction **seulement si le code a changé**, relance. L'onglet Hermes
reste ouvert : quand l'interface redevient joignable (30 s à 2 min),
**rafraîchissez-le (F5)** pour charger la nouvelle version — aucun nouvel
onglet de navigateur n'est ouvert. Sans lanceur actif (pile lancée à la main),
la mise à jour s'appliquera au prochain lancement de l'icône.

### Fermeture — tous les cas couverts

| Comment tu fermes | Ce qui se passe |
|---|---|
| Ctrl-C dans la fenêtre du lanceur | arrêt ordonné : passerelle → interface → mini-service |
| Fermeture de la fenêtre du lanceur | **Job Object noyau** (`KILL_ON_JOB_CLOSE`) : Windows tue l'arbre entier, zéro orphelin garanti par le noyau |
| Déconnexion / arrêt du PC / taskkill | idem — le Job Object suit le lanceur dans tous les cas |
| Fermer l'onglet du navigateur seulement | la pile reste disponible (retour instantané) |

Sur arrêt brutal, la base est quand même sûre : SQLite est en mode WAL,
**récupéré automatiquement au démarrage suivant** — aucune donnée perdue.

### Un seul onglet

Relancer l’icône pendant qu’Hermes est déjà ouvert n’empile plus les
onglets : la page détecte sa jumelle, l’onglet EXISTANT se rafraîchit (il
récupère la toute dernière version ; les conversations vivent dans la
base, rien ne se perd) et le nouvel onglet affiche un bandeau discret puis
tente de se fermer tout seul. Si le navigateur refuse de fermer une page
ouverte par le système (protection normale), le bandeau indique de la
fermer à la main ; le bouton « Garder cette page ouverte » la laisse
utilisable — elle prendra automatiquement le relais si l’autre onglet
disparaît.

La toute première fois, l’ancien onglet peut être resté à l’ancienne
version (sans la détection) : il ne comprendra pas le signal — fermez-le
une fois à la main ; ensuite, tout est automatique. Les fenêtres
installées en application (PWA, mode autonome) sont volontairement hors du
dispositif : elles se comportent comme des applications, pas comme des
onglets.

### Autres cas couverts à l'ouverture

- Session précédente plantée (verrou périmé) → nettoyage des restes
  **avant** la mise à jour et le build (un ancien serveur encore vivant
  verrouillerait le dossier du build), puis démarrage.
- Demi-pile (service vivant, interface morte…) → composants sains adoptés,
  manquants démarrés ; l'arrêt ne touche que ce qu'Hermes a lancé.
- Ports 81/3000 occupés par autre chose → repli automatique (8081/8181…,
  3001/3002…). Ports 3003/3004 (codés dans le client) occupés sans servir
  Hermes → refus explicite avec la commande de diagnostic.
- Téléchargement interrompu → relancez, tout est idempotent.
- Aucun processus hors du projet n'est jamais tué : chaque cible est validée
  par le chemin du projet dans sa ligne de commande.

### Déplacer le dossier (mode portable)

Le dossier n'a besoin de **rien d'extérieur** pour fonctionner : ni Node,
ni Bun, ni Caddy installés sur la machine, ni clé de registre, ni fichier
dans votre profil. Pour le déplacer :

1. Fermez la fenêtre du lanceur (arrêt propre de la pile).
2. Déplacez/renommez/copiez le dossier où vous voulez — disque externe,
   clé USB, autre machine.
3. Double-cliquez sur `Hermes-Web.bat` : tout redémarre, y compris votre
   base (conversations, clés, pièces jointes) qui a suivi le dossier.

Seule la mise à jour automatique demande git (jamais bloquant : sans git,
Hermes démarre avec la version présente). Le premier démarrage sur une
machine **sans réseau** ne peut pas télécharger les outils manquants :
ils voyagent dans `tools\` — si le dossier vient d'une machine où ils ont
déjà été installés, tout fonctionne hors ligne.

### Chaleur du processeur

Hermes est conçu pour rester discret :

- L'interface tourne en **build de production** : au repos, la pile
  entière consomme moins de 1 % de processeur.
- La **surveillance** interne fait de simples vérifications toutes les
  15 s (une requête HTTP par composant, vérification d'appartenance
  allégée une fois par minute).
- La pile est en **priorité basse** : vos autres logiciels passent
  toujours en premier.
- Le journal du lanceur est **roté** (2000 dernières lignes) : pas de
  fichier qui grossit indéfiniment.

**Si le processeur chauffe quand même** : la fenêtre du lanceur affiche
un grand cadre jaune « interface en mode DEVELOPPEMENT » ? C'est la
cause — le mode développement (utilisé seulement si le build de
production a échoué) sollicite fortement la machine. Le build sera
retenté automatiquement dans les 24 h ; pour forcer tout de suite :
fermez la fenêtre, effacez `tools\build-echoue.flag`, relancez. Si le
problème persiste, regardez `desktop\logs\launcher.log`.

---

## Variantes (facultatives)

- `desktop\Installer-Hermes.bat` : si vous préférez en plus des raccourcis
  classiques « Hermes Web » / « Hermes Web — Arret » sur le **Bureau** et au
  **menu Démarrer** (icône incluse). `--remove` les retire.
- `desktop\hermes-ui.ps1 stop | status | restart` : arrêt, état, redémarrage
  (via `Hermes-Web.bat` c'est `start`).

## Linux

```bash
cd hermes/desktop
./install.sh            # « Hermes Web » + « Hermes Web — Arrêter » (menu + bureau)
./install.sh --remove   # retrait
```

Mêmes garanties que Windows pour la surveillance et l'arrêt (SIGHUP + SIGTERM,
checkpoint WAL du mini-service). L'installation automatique portable des
outils est spécifique à la version Windows ; sous Linux, installez Bun, Node
et Caddy via votre gestionnaire de paquets.

## Dépannage

| Symptôme | Où regarder |
|---|---|
| « n'a pas démarré » | `desktop\logs\launcher.log` (cause en clair) |
| Téléchargement qui échoue | relancez (idempotent) ; vérifiez la connexion / le proxy |
| Téléchargement de ffmpeg qui bloque ou échoue | le lanceur essaie deux sources dans l'ordre (miroir GitHub ~190 Mo, puis gyan.dev ~110 Mo), abandonne un serveur muet et affiche la progression ; à défaut, déposez vous-même une archive ZIP de ffmpeg Windows dans `tools\ffmpeg.zip` avant de relancer (elle sera extraite puis supprimée) |
| Build en échec | messages dans la fenêtre au 1er lancement ; `tools\build-echoue.flag` (une nouvelle version retente d'elle-même, une même version est retentée après 24 h) |
| Pastille « Rendu (chrome-headless) : introuvable » dans Paramètres → Système ; vignettes/PDF/partages en échec | chrome-headless-shell se télécharge dans `tools\` au démarrage (idempotent — relancez) ; sans réseau au premier démarrage, il viendra d'un dossier déjà installé (cache Playwright) ou manquera |
| Dictée (transcription) en échec sur un format non WAV/WebM | ffmpeg est téléchargé dans `tools\` au démarrage ; les formats WAV/WebM passent sans lui |
| Export ZIP d'artefacts en échec | Windows 10+ : via tar intégré automatiquement (repli de secours) ; Linux/macOS : installez `zip` du système |
| Mise à jour non appliquée | `desktop\logs\launcher.log` (cause en clair) ; les différences locales sont sauvegardées dans `desktop\runtime\maj-sauvegarde-…\` puis la version GitHub est appliquée. Vos données (conversations, clés) ne sont jamais touchées |
| Page blanche / erreur | `desktop\logs\interface-err.log` |
| Chat ne répond pas | `desktop\logs\mini-service-err.log` |
| Page inaccessible | `desktop\logs\passerelle-err.log` |
| Processeur chaud / ventilateur | voir « Chaleur du processeur » ci-dessus ; un cadre jaune « mode DEVELOPPEMENT » dans la fenêtre = build de production à retenter (effacez `tools\build-echoue.flag`) |
| Ports 3003/3004 occupés | `netstat -ano \| findstr "3003 3004"` (Windows) / `ss -tlnp` (Linux) puis libérez-les |
| Repartir de zéro | effacez `tools\` (outils), `node_modules\`, `.next\` — tout se réinstalle |

## Mise à jour manuelle (défaut d'origine : installation par ZIP)

Le mécanisme « sauvegarde + alignement » ci-dessus n'existe que depuis le
lanceur v2. Une installation née d'un **ZIP GitHub** avec un lanceur v1 ne
peut PAS se mettre à jour toute seule : son ancienne logique renonce dès que
l'historique local diverge — le correctif ne peut donc pas lui arriver par
la mise à jour automatique (problème de l'œuf et de la poule). Un seul
remède, UNE fois : transformer le dossier en vrai clone git.

Dans PowerShell (menu Démarrer → « PowerShell »), fenêtre Hermes fermée :

```powershell
$pat   = 'votre-jeton-github'
$ancien= 'F:\CH\hermes_ui-main\hermes_ui-main'
$neuf  = 'F:\CH\hermes_ui'
git clone https://x-access-token:$pat@github.com/auriannedrumont-eng/hermes_ui.git $neuf
git -C $neuf remote set-url origin https://github.com/auriannedrumont-eng/hermes_ui.git
Copy-Item "$ancien\db"    "$neuf\db"    -Recurse -ErrorAction SilentlyContinue
Copy-Item "$ancien\tools" "$neuf\tools" -Recurse -ErrorAction SilentlyContinue
```

Puis double-cliquez sur `Hermes-Web.bat` dans le NOUVEAU dossier (`$neuf`) :
premier démarrage complet (dépendances + build, une dizaine de minutes),
ensuite les mises à jour repartent toutes seules. Ce qui est conservé de
l'ancien dossier : `db\` (conversations, clés, pièces jointes — tout ce qui
vous appartient) et `tools\` (outils portables, pour ne pas les retélécharger).
L'ancien dossier reste en place, intact : il peut être supprimé quand le
nouveau vous convient. Les connexions GitHub suivantes passent par le
gestionnaire d'identifiants de git (une fenêtre de connexion la première
fois, plus ensuite).

L'état de session vit dans `desktop\runtime\` (verrou, PIDs, Caddyfile
généré), les journaux dans `desktop\logs\`, les outils portables dans
`tools\` — les trois ignorés par git.
