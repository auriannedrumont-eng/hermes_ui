#!/bin/bash
# Diagnostic socket via le proxy QA.
set -u
cd /home/z/my-project/hermes_ui
DB=/tmp/hermes-qa-view-ui.sqlite

HERMES_CHAT_DB=$DB nohup bun mini-services/hermes-chat/index.ts > /tmp/qa-service.log 2>&1 &
PID_SERVICE=$!
QA_PROXY_PORT=8181 nohup bun scripts/qa-proxy.ts > /tmp/qa-proxy.log 2>&1 &
PID_PROXY=$!
NODE_ENV=production PORT=3000 nohup bun .next/standalone/server.js > /tmp/qa-next.log 2>&1 &
PID_NEXT=$!
trap 'kill $PID_SERVICE $PID_PROXY $PID_NEXT 2>/dev/null' EXIT

for i in $(seq 1 60); do
  s=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8181/socket.io/?EIO=4&transport=polling&XTransformPort=3003" 2>/dev/null)
  n=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  [ "$n" = "200" ] && [ "$s" = "200" ] && break
  sleep 0.5
done
echo "pile OK"

bun -e '
import { io } from "socket.io-client";
const s = io("/?XTransformPort=3003", { transports: ["websocket"], path: "/", timeout: 4000 });
s.on("connect", () => { console.log("WS via proxy : CONNECTÉ", s.id); process.exit(0); });
s.on("connect_error", (e) => { console.log("WS via proxy : ERREUR", e.message); process.exit(1); });
setTimeout(() => { console.log("WS via proxy : timeout"); process.exit(1); }, 5000);
'
echo "---"
agent-browser open http://localhost:3000/ > /dev/null 2>&1
agent-browser wait 2000 > /dev/null 2>&1
agent-browser console 2>&1 | tail -15
agent-browser errors 2>&1 | tail -8
