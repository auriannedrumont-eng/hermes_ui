#!/bin/bash
# QA ciblée : dépliage de l'encart terminal du panneau (refs fraîches, portée console).
set -u
cd /home/z/my-project/hermes_ui
DB=/tmp/hermes-qa-view-ui.sqlite
SHOTS=/home/z/my-project/download/qa-f28

HERMES_CHAT_DB=$DB nohup bun mini-services/hermes-chat/index.ts > /tmp/qa-service.log 2>&1 &
PID_SERVICE=$!
QA_PROXY_PORT=8181 nohup node scripts/qa-proxy.ts > /tmp/qa-proxy.log 2>&1 &
PID_PROXY=$!
NODE_ENV=production PORT=3000 nohup bun .next/standalone/server.js > /tmp/qa-next.log 2>&1 &
PID_NEXT=$!
cleanup() { kill $PID_SERVICE $PID_PROXY $PID_NEXT 2>/dev/null; agent-browser close >/dev/null 2>&1; wait 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 80); do
  n=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8181/ 2>/dev/null)
  s=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8181/socket.io/?EIO=4&transport=polling&XTransformPort=3003" 2>/dev/null)
  [ "$n" = "200" ] && [ "$s" = "200" ] && break
  sleep 0.5
done
echo "== pile OK =="

agent-browser set viewport 1440 900
agent-browser open http://localhost:8181/
agent-browser wait --load networkidle
agent-browser wait 1200
agent-browser find text "QA vue onglet + terminal" click
agent-browser wait 1200
agent-browser find text "page-qa.html" click
agent-browser wait 1000

# Déplier l'encart terminal (ref fraîche)
agent-browser snapshot -i -c > /tmp/qa-snap-t.txt
REF_T=$(rg -o 'button "Terminal[^"]*".*?ref=(e[0-9]+)' /tmp/qa-snap-t.txt | head -1 | rg -o 'e[0-9]+$')
echo "== ref terminal : $REF_T =="
agent-browser click "@$REF_T"
agent-browser wait 600
agent-browser screenshot "$SHOTS/04-terminal-deplie.png"
echo "== console (portée max-h-44) =="
agent-browser snapshot -c -s '[class*="max-h-44"]' | head -20
echo "== état expanded =="
agent-browser snapshot -i -c | rg 'Terminal.*ref=' | head -2
echo "== fin =="
