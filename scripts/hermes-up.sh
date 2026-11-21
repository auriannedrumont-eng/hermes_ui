#!/usr/bin/env bash
# Pile Hermes Web complète — un seul commandement (pont de dépannage F-31).
#
# Démarre dans l'ordre :
#   1. le navigateur de pilotage headless sur le port 9222 (profil dédié
#      db/webchat-profile — le même que sur la machine de l'utilisatrice),
#   2. le service hermes-chat (socket.io 3003 + HTTP fichiers/diagnostics 3004),
#   3. l'interface Next.js (3000, derrière Caddy :81).
#
# Le pont de dépannage devient lisible de l'extérieur :
#   curl http://127.0.0.1:3004/diagnostics   (journal tournant + état du navigateur)
# et l'interface expose le même rapport via ?debug=1 → « Copier le diagnostic ».
#
# Tous les logs vivent dans logs/ du dépôt — jamais dans la racine.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
CHROME="$(ls "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)"

echo "— arrêt des restants (stall-server, service, next, navigateur de pilotage)"
pkill -f "stall-server.ts" 2>/dev/null || true
pkill -f "remote-debugging-port=9222" 2>/dev/null || true
# (audit 2026-11-21) les motifs génériques « bun index.ts » / « next dev »
# abattaient le service d'un AUTRE projet sur la même machine : on ne tue
# que les processus dont le répertoire de travail est sous CE projet.
for pid in $(pgrep -f "bun index.ts" 2>/dev/null); do
  cwd="$(readlink -f /proc/$pid/cwd 2>/dev/null || true)"
  case "$cwd" in "$ROOT"|"$ROOT"/*) kill "$pid" 2>/dev/null || true ;; esac
done
for pid in $(pgrep -f "next dev" 2>/dev/null); do
  cwd="$(readlink -f /proc/$pid/cwd 2>/dev/null || true)"
  case "$cwd" in "$ROOT"|"$ROOT"/*) kill "$pid" 2>/dev/null || true ;; esac
done
sleep 1

if [ -n "$CHROME" ]; then
  "$CHROME" --headless=new --remote-debugging-port=9222 \
    --user-data-dir="$ROOT/db/webchat-profile" \
    --no-first-run --no-default-browser-check \
    --disable-features=Translate \
    >"$LOGS/pilot-chrome.log" 2>&1 &
  echo "— navigateur de pilotage headless sur 9222 ($CHROME)"
else
  echo "— aucun Chromium Playwright trouvé : le webchat échouera honnêtement (trace lisible)"
fi

cd "$ROOT/mini-services/hermes-chat"
HERMES_PILOT_BROWSER="${CHROME:-}" nohup bun index.ts >"$LOGS/hermes-chat.log" 2>&1 &
echo "— service hermes-chat : 3003 (socket) + 3004 (fichiers + diagnostics)"

cd "$ROOT"
nohup bunx next dev -p 3000 >"$LOGS/next.log" 2>&1 &
# (audit 2026-11-21) ce script ne démarre PAS Caddy — l'ancien echo laissait
# croire que :81 était servi.
echo "— interface Next : 3000 (passerelle Caddy :81 NON démarrée par ce script — lancez desktop/hermes-ui.sh pour la pile complète)"

# ── Santé ─────────────────────────────────────────────────────────────────
# (audit 2026-11-21) -f : sans lui, curl renvoyait 0 même sur HTTP 500 —
# « ✓ service répondu » même KO.
ok() { curl -sf --max-time 2 -o /dev/null "$1"; }
for i in $(seq 1 30); do ok "http://127.0.0.1:3004/diagnostics" && break; sleep 1; done
if ok "http://127.0.0.1:3004/diagnostics"; then
  echo "✓ service répondu sur 3004"
else
  echo "✗ service KO — voir logs/hermes-chat.log"
fi
for i in $(seq 1 45); do ok "http://127.0.0.1:3000/" && break; sleep 1; done
if ok "http://127.0.0.1:3000/"; then
  echo "✓ interface répondu sur 3000 (première compilation pouvant prendre ~30 s au premier chargement)"
else
  echo "✗ interface KO — voir logs/next.log"
fi
echo "— pont : curl -s http://127.0.0.1:3004/diagnostics | head -40"
