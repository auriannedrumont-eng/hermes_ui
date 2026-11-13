# Hermes Web — Raccourcis bureau (Windows et Linux)

Un double-clic démarre toute la pile (mini-service chat, interface Next.js,
passerelle Caddy) puis ouvre le navigateur. La fermeture propre est garantie
à chaque chemin de sortie. **Aucune ligne de commande à taper.**

---

## Windows (installation en 2 double-clics)

1. **`Installer-Hermes.bat`** (double-clic) → crée les raccourcis
   **« Hermes Web »** et **« Hermes Web — Arret »** sur le **Bureau** et dans
   le **menu Démarrer**, avec l'icône de l'application. Il vérifie aussi les
   dépendances et affiche quoi installer le cas échéant :
   - `winget install Oven-sh.Bun`
   - `winget install OpenJS.NodeJS`
   - `winget install CaddyServer.Caddy`
   - dans le dossier du projet : `npm install` puis `bun install` dans
     `mini-services\hermes-chat` (une seule fois)
2. **« Hermes Web »** sur le Bureau (double-clic) → la pile démarre, le
   navigateur s'ouvre.

**Retrait des raccourcis** : `Installer-Hermes.bat --remove`.

### Fermeture — tous les cas couverts

| Comment tu fermes | Ce qui se passe |
|---|---|
| Ctrl-C dans la fenêtre du lanceur | arrêt ordonné : passerelle → interface → mini-service |
| Fermeture de la fenêtre du lanceur | **Job Object noyau** (`KILL_ON_JOB_CLOSE`) : Windows tue l'arbre entier, zéro orphelin garanti par le noyau |
| Déconnexion / arrêt du PC / taskkill | idem — le Job Object suit le lanceur dans tous les cas |
| Fermer l'onglet du navigateur seulement | la pile reste disponible (retour instantané) |
| « Hermes Web — Arret » | arrêt ordonné explicite |

Sur arrêt brutal, la base est quand même sûre : SQLite est en mode WAL,
**récupéré automatiquement au démarrage suivant** — aucune donnée perdue.

### Ouverture — tous les cas couverts

- Dépendance manquante → message explicite (avec commande winget), rien n'est
  démarré à moitié.
- Double-clic alors qu'Hermes tourne déjà → simplement une nouvelle fenêtre
  navigateur, aucune pile dupliquée.
- Session précédente plantée (verrou périmé) → nettoyage puis démarrage.
- Demi-pile (service vivant, interface morte…) → composants sains adoptés,
  manquants démarrés ; l'arrêt ne touche que ce qu'Hermes a lancé.
- Ports 81/3000 occupés par autre chose → repli automatique (8081/8181…,
  3001/3002…). Ports 3003/3004 (codés dans le client) occupés sans servir
  Hermes → refus explicite avec la commande de diagnostic.
- Composant qui plante en cours de session → relance automatique (3 essais),
  puis arrêt général propre si ça persiste.
- Aucun processus hors du projet n'est jamais tué : chaque cible est validée
  par le chemin du projet dans sa ligne de commande.

---

## Linux

```bash
cd hermes_ui/desktop
./install.sh            # « Hermes Web » + « Hermes Web — Arrêter » (menu + bureau)
./install.sh --remove   # retrait
```

Mêmes garanties que Windows ; l'arrêt par fermeture de fenêtre passe par
SIGHUP, l'arrêt ordonné du mini-service déclenche en plus son checkpoint
WAL (correctif F-09).

---

## Dépannage

| Symptôme | Où regarder |
|---|---|
| « n'a pas démarré » | `desktop\logs\launcher.log` (cause en clair) |
| Page blanche / erreur | `desktop\logs\interface-err.log` |
| Chat ne répond pas | `desktop\logs\mini-service-err.log` |
| Page inaccessible | `desktop\logs\passerelle-err.log` |
| État de la pile | double-clic `Hermes-Web.bat` affiche l'état si déjà lancé ; Linux : `hermes-ui.sh status` |
| Ports 3003/3004 occupés | `netstat -ano | findstr "3003 3004"` (Windows) / `ss -tlnp` (Linux) puis libérez-les |

Interface en **build production** si `.next\standalone` existe (faites
`npm run build` une fois pour y passer), sinon mode développement.

L'état de session vit dans `desktop\runtime\` (verrou, PIDs, Caddyfile
généré) et les journaux dans `desktop\logs\` — ignorés par git.
