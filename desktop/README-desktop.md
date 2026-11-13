# Hermes Web — Raccourci bureau

Un double-clic démarre toute la pile (mini-service chat, interface Next.js,
passerelle Caddy) puis ouvre le navigateur. La fermeture propre est garantie
à chaque chemin de sortie.

## Installation

```bash
cd hermes_ui/desktop
./install.sh            # installe « Hermes Web » + « Hermes Web — Arrêter »
./install.sh --remove   # retire les raccourcis
```

Les entrées sont copiées dans `~/.local/share/applications` (menu) et sur le
Bureau s'il existe. Les chemins sont absolus : si vous déplacez le dossier
`hermes_ui`, relancez `./install.sh`.

## Utilisation

| Raccourci / commande | Effet |
|---|---|
| **Hermes Web** (double-clic) | démarre la pile, ouvre le navigateur, puis **surveille** |
| **Hermes Web — Arrêter** | arrêt propre : données sauvegardées (checkpoint SQLite) |
| `desktop/hermes-ui.sh status` | état + derniers logs |
| `desktop/hermes-ui.sh restart` | arrêt propre puis redémarrage |

Une petite fenêtre de terminal reste ouverte tant qu'Hermes tourne : **la
fermer (ou Ctrl-C) arrête tout proprement**. C'est voulu — c'est le seul
signal fiable pour « je ferme l'application » ; fermer seulement l'onglet du
navigateur laisse la pile disponible (retour instantané, zéro rechargement).

## Ce qui se passe à l'ouverture

1. Vérification des dépendances (`bun`, `node`, `node_modules`, caddy si
   nécessaire) → message d'erreur explicite sinon, rien n'est démarré à moitié.
2. Détection d'une pile **déjà lancée** : le second double-clic n'installe
   RIEN, il ouvre simplement le navigateur.
3. Nettoyage d'un **verrou périmé** (session précédente plantée) avant de
   repartir proprement.
4. Choix des ports : passerelle `81` (sinon `8081/8181/18081`), interface
   `3000` (sinon `3001/3002/3005`) — si un port est pris par un autre
   programme, le suivant est essayé automatiquement. Les ports `3003/3004`
   sont imposés par le client : s'ils sont occupés sans servir Hermes,
   le lanceur **refuse** de démarrer et explique quoi faire.
5. Démarrage dans l'ordre : mini-service → interface → passerelle, chacun
   attendu sur son endpoint HTTP avant de continuer. Composant déjà sain
   (démarré ailleurs) → adopté, pas dupliqué.
6. Ouverture du navigateur **après** vérification que l'URL répond (jamais
   de page « connexion impossible »). Sans navigateur détecté, l'URL
   s'affiche dans le terminal.

Interface en **build production** si `.next/standalone` existe (faites
`npm run build` une fois pour y passer), sinon en mode développement.

## Ce qui se passe à la fermeture

- Ordre garanti : passerelle → interface → **mini-service en dernier**
  (son handler SIGTERM fait le checkpoint WAL — correctif F-09 : la base
  est intégralement écrite dans le fichier SQLite principal).
- Signaux couverts : Ctrl-C (INT), fermeture de la fenêtre (HUP), arrêt
  système / `pkill` (TERM). Filet de sécurité : SIGKILL après 8 s pour un
  processus qui refuserait de sortir, puis nettoyage du verrou.
- **Sélectivité** : seuls les processus réellement lancés par ce lanceur
  sont arrêtés (PID vérifié + ligne de commande contrôlée avant chaque
  signal — jamais de kill au hasard si l'OS a réutilisé un PID). Un
  composant adopté (déjà actif avant le lancement) reste en vie.
- Composant qui **plante en cours de session** : relancé automatiquement
  (3 tentatives), puis arrêt général propre si ça persiste.

## Dépannage

| Symptôme | Où regarder |
|---|---|
| « n'a pas démarré » | `desktop/logs/launcher.log` (cause en clair) |
| Interface blanche / erreur | `desktop/logs/interface.log` |
| Chat ne répond pas | `desktop/logs/mini-service.log` |
| Page inaccessible | `desktop/logs/passerelle.log` + `hermes-ui.sh status` |
| Ports 3003/3004 occupés | `ss -tlnp | grep -E '3003|3004'` puis libérez-les |

Tout l'état de session vit dans `desktop/runtime/` (verrou, PIDs, Caddyfile
généré) et les journaux dans `desktop/logs/` — ces deux dossiers sont
ignorés par git.
