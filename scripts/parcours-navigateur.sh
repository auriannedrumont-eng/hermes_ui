#!/bin/bash
# Parcours complet fournisseurs/cles dans le navigateur - version robuste
# Chaque commande navigateur bornee a 15 s, sortie journalisee en direct.
cd /home/z/my-project
LOG=/tmp/parcours.log
: > $LOG
exec > >(tee -a $LOG) 2>&1

# NB : agent-browser n a pas d option --timeout globale.
# Les refs (@eNN) changent a chaque page : les reperer par snapshot -i -c
# avant chaque action, comme fait en session (cf. FORK.md (26)).
AB="agent-browser"

echo "════ 1. pile ════"
pkill -f "standalone/server.js" 2>/dev/null
pkill -f "bun --hot" 2>/dev/null
sleep 1
TOK=$(cat /tmp/hermes-tok.txt)
(cd mini-services/hermes-chat && HERMES_SERVICE_TOKEN=$TOK setsid nohup bun run dev > /tmp/hermes-chat.log 2>&1 < /dev/null &)
(PORT=3000 HOSTNAME=0.0.0.0 setsid nohup bun .next/standalone/server.js > /tmp/hermes-ui.log 2>&1 < /dev/null &)
UI=""; CHAT=""
for i in $(seq 1 30); do
  UI=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:3000/ 2>/dev/null)
  CHAT=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:3003/?EIO=4&transport=polling" 2>/dev/null)
  [ "$UI" = "200" ] && [ "$CHAT" = "200" ] && break
  sleep 1
done
echo "UI=$UI CHAT=$CHAT (essai $i)"
[ "$UI" != "200" ] && { echo "ECHEC UI"; exit 1; }
[ "$CHAT" != "200" ] && { echo "ECHEC CHAT"; exit 1; }

echo "════ 2. accueil ════"
$AB open http://localhost:81/
sleep 8
$AB screenshot /tmp/p1-accueil.png
$AB snapshot -c 2>&1 | grep -iE "paramètres|démo|moteur|hors ligne" | head -4

echo "════ 3. parametres ════"
$AB find label "Ouvrir les paramètres" click && echo "[OK] panneau ouvert"
sleep 1.5
$AB find role button click --name "Fournisseurs" && echo "[OK] section fournisseurs"
sleep 1.5
$AB screenshot /tmp/p2-fournisseurs.png

echo "════ 4. ajout z.ai ════"
$AB find role button click --name "Ajouter un fournisseur" && echo "[OK] bloc ajout ouvert"
sleep 1
$AB find label "Nom ou adresse du fournisseur" fill "z.ai" && echo "[OK] nom rempli"
$AB press Enter
sleep 2
$AB screenshot /tmp/p3-zai.png
$AB snapshot -c 2>&1 | grep -iE "z.ai|clé|ajouter" | head -6

echo "════ 5. ajout cle JWT factice ════"
$AB find role button click --name "Ajouter une clé" && echo "[OK] bloc cle ouvert"
sleep 1
$AB find label "Étiquette de la clé" fill "Test navigateur" && echo "[OK] etiquette"
$AB find label "Valeur de la clé" fill "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdXJpYW5uZS1icm93c2VyIn0.c2lnbmF0dXJlLWZhdXNlZQ" && echo "[OK] cle remplie"
$AB press Enter
sleep 2
$AB screenshot /tmp/p4-cle.png

echo "════ 6. test de la cle (reseau reel) ════"
$AB find role button click --name "Tester" && echo "[OK] test lance"
sleep 10
$AB screenshot /tmp/p5-resultat.png
echo "--- texte visible apres test ---"
$AB snapshot -c 2>&1 | grep -iE "test navigateur|refus|modèles|connect|erreur|injoignable|coding|non test" | head -8

echo "════ 7. statut sidebar ════"
$AB press Escape
sleep 2
$AB screenshot /tmp/p6-statut.png
$AB snapshot -c 2>&1 | grep -iE "démo|moteur|clés actives|gateway|hors ligne" | head -4

echo "════ 8. journal service ════"
tail -6 /tmp/hermes-chat.log
echo "════ TERMINE ════"
