# Hermes Web — Une seule icône, installation portable (Windows et Linux)

**Windows : un seul fichier à la racine du dossier `hermes` —
`Hermes-Web.bat`.** Double-clic dessus et c'est tout.

- **1er double-clic** : installe automatiquement tout ce qui manque **à
  l'intérieur du dossier hermes** (sous-dossier `tools\`) — Node.js v22 LTS,
  Bun, Caddy, puis les dépendances npm/bun, le client Prisma et le build de
  production de l'interface. Aucune ligne de commande, aucun droit
  administrateur, **rien n'est écrit hors du dossier**. Comptez quelques
  minutes (téléchargements + installations) avec la progression affichée
  dans la fenêtre.
- **Double-clics suivants** : démarrage quasi instantané de la pile
  (mini-service chat, interface Next.js, passerelle Caddy) puis ouverture
  du navigateur.
- **Fermer la fenêtre du lanceur (ou Ctrl-C)** : arrêt propre de toute la
  pile.

Le dossier `hermes` est **autonome et mobile** : copiez-le où vous voulez,
y compris sur un disque externe ou une clé USB — tout vit dedans. Vous
pouvez le renommer, le déplacer, il fonctionnera.

> Note : le fichier `.bat` porte l'icône générique de Windows (limite du
> format). Si vous préférez le logo Hermes, faites un clic droit sur
> `Hermes-Web.bat` → *Envoyer vers → Bureau (créer un raccourci)* ;
> l'icône `desktop\hermes.ico` peut lui être appliquée (clic droit sur le
> raccourci → Propriétés → Changer d'icône). Rien d'obligatoire.

> Si Windows affiche « Windows a protégé votre ordinateur » au premier
> lancement (fichier téléchargé depuis Internet) : *Informations
> complémentaires → Exécuter quand même*.

## Ce que l'icône unique fait, dans l'ordre

1. Si Hermes tourne déjà → ouvre simplement une nouvelle fenêtre navigateur
   (aucune pile dupliquée).
2. Outils manquants → téléchargés et installés dans `tools\` (ordre de
   préférence : déjà sur le PATH système, sinon déjà dans `tools\`, sinon
   téléchargement). Node v22.20.0 (LTS) et Bun en zip officiels, Caddy en
   exe officiel.
3. `node_modules` manquants → `npm install` (interface) et `bun install`
   (mini-service), sortie en direct dans la fenêtre.
4. Client Prisma généré, puis **build de production** de l'interface
   (`next build` + copies `static`/`public`, une seule fois). Si le build
   échoue : bascule en mode développement et pose un marqueur
   `tools\build-echoue.flag` (effacez-le pour retenter).
5. Démarrage de la pile : mini-service → interface → passerelle, navigateur
   ouvert sur `http://127.0.0.1:81/` (ou 8081/8181… si le port est pris).
6. Surveillance : un composant qui plante est relancé (3 essais), puis
   arrêt général propre si ça persiste.

### Fermeture — tous les cas couverts

| Comment tu fermes | Ce qui se passe |
|---|---|
| Ctrl-C dans la fenêtre du lanceur | arrêt ordonné : passerelle → interface → mini-service |
| Fermeture de la fenêtre du lanceur | **Job Object noyau** (`KILL_ON_JOB_CLOSE`) : Windows tue l'arbre entier, zéro orphelin garanti par le noyau |
| Déconnexion / arrêt du PC / taskkill | idem — le Job Object suit le lanceur dans tous les cas |
| Fermer l'onglet du navigateur seulement | la pile reste disponible (retour instantané) |

Sur arrêt brutal, la base est quand même sûre : SQLite est en mode WAL,
**récupéré automatiquement au démarrage suivant** — aucune donnée perdue.

### Autres cas couverts à l'ouverture

- Session précédente plantée (verrou périmé) → nettoyage puis démarrage.
- Demi-pile (service vivant, interface morte…) → composants sains adoptés,
  manquants démarrés ; l'arrêt ne touche que ce qu'Hermes a lancé.
- Ports 81/3000 occupés par autre chose → repli automatique (8081/8181…,
  3001/3002…). Ports 3003/3004 (codés dans le client) occupés sans servir
  Hermes → refus explicite avec la commande de diagnostic.
- Téléchargement interrompu → relancez, tout est idempotent.
- Aucun processus hors du projet n'est jamais tué : chaque cible est validée
  par le chemin du projet dans sa ligne de commande.

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
| Build en échec | messages dans la fenêtre au 1er lancement ; `tools\build-echoue.flag` |
| Page blanche / erreur | `desktop\logs\interface-err.log` |
| Chat ne répond pas | `desktop\logs\mini-service-err.log` |
| Page inaccessible | `desktop\logs\passerelle-err.log` |
| Ports 3003/3004 occupés | `netstat -ano \| findstr "3003 3004"` (Windows) / `ss -tlnp` (Linux) puis libérez-les |
| Repartir de zéro | effacez `tools\` (outils), `node_modules\`, `.next\` — tout se réinstalle |

L'état de session vit dans `desktop\runtime\` (verrou, PIDs, Caddyfile
généré), les journaux dans `desktop\logs\`, les outils portables dans
`tools\` — les trois ignorés par git.
