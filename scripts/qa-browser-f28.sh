#!/bin/bash
# QA navigateur « vue onglet + terminal » (F-28/F-29) — tout-en-un : la pile
# (service + proxy XTransformPort + Next) vit le temps du script uniquement.
set -u
cd /home/z/my-project/hermes_ui

DB=/tmp/hermes-qa-view-ui.sqlite
SHOTS=/home/z/my-project/download/qa-f28
mkdir -p "$SHOTS"

HERMES_CHAT_DB=$DB nohup bun mini-services/hermes-chat/index.ts > /tmp/qa-service.log 2>&1 &
PID_SERVICE=$!
QA_PROXY_PORT=8181 nohup node scripts/qa-proxy.ts > /tmp/qa-proxy.log 2>&1 &
PID_PROXY=$!
NODE_ENV=production PORT=3000 nohup bun .next/standalone/server.js > /tmp/qa-next.log 2>&1 &
PID_NEXT=$!
cleanup() { kill $PID_SERVICE $PID_PROXY $PID_NEXT 2>/dev/null; agent-browser close >/dev/null 2>&1; wait 2>/dev/null; }
trap cleanup EXIT

ok=0
for i in $(seq 1 80); do
  n=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  s=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8181/socket.io/?EIO=4&transport=polling&XTransformPort=3003" 2>/dev/null)
  if [ "$n" = "200" ] && [ "$s" = "200" ]; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" != "1" ]; then echo "ECHEC pile: next=$n socket=$s"; exit 1; fi
echo "== pile OK =="

agent-browser set viewport 1440 900
agent-browser open http://localhost:8181/
agent-browser wait --load networkidle
agent-browser wait 1500

# ── 1. Ouvrir la conversation seedée ────────────────────────────────────────
agent-browser find text "QA vue onglet + terminal" click
agent-browser wait --load networkidle
agent-browser wait 1500
echo "== état connecté + carte =="
agent-browser get count "[class*='group/art']" || true
agent-browser snapshot -i -c | rg -i "page-qa|artefact|onglet|Terminal" | head -12
agent-browser screenshot "$SHOTS/01-conversation-carte.png"

# ── 2. Ouvrir le panneau (clic carte) ──────────────────────────────────────
agent-browser find text "page-qa.html" click
agent-browser wait 1200
agent-browser snapshot -i -c > /tmp/qa-snap-panel.txt
echo "== panneau : boutons =="
rg -i "onglet|télécharger|copier|fermer|Terminal" /tmp/qa-snap-panel.txt | head -10
agent-browser screenshot "$SHOTS/02-panneau.png"

# ── 3. Icône « Ouvrir dans un nouvel onglet » de l'en-tête du panneau ──────
REF=$(rg -o 'button "Ouvrir dans un nouvel onglet" \[ref=(e[0-9]+)\]' /tmp/qa-snap-panel.txt | head -1 | rg -o 'e[0-9]+')
echo "== ref bouton onglet : $REF =="
if [ -n "${REF:-}" ]; then
  agent-browser click "@$REF"
  agent-browser wait 1500
  agent-browser tab list
  agent-browser screenshot "$SHOTS/03-onglet-ouvert.png"
  agent-browser tab close
fi

# ── 4. Encart terminal : déplier et vérifier les lignes ────────────────────
REF_T=$(rg -o 'button "Terminal[^"]*".*?ref=(e[0-9]+)' /tmp/qa-snap-panel.txt | head -1 | rg -o 'e[0-9]+$')
echo "== ref terminal : $REF_T =="
if [ -n "${REF_T:-}" ]; then
  agent-browser click "@$REF_T"
  agent-browser wait 600
  agent-browser screenshot "$SHOTS/04-terminal-deplie.png"
  echo "== lignes du terminal =="
  agent-browser snapshot -c | rg -i "mkdir|pip|Recherche web|dossier prêt" | head -8
fi

echo "== fin QA navigateur =="
