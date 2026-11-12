#!/bin/bash
# Génère le patch git (diff original -> version artefacts) et l'archive livrable
set -e
ORIG=/tmp/orig/hermes_ui
NEW=/home/z/my-project
OUT=/home/z/my-project/download

mkdir -p "$OUT"

# 1. Patch unifié : fichiers modifiés/ajoutés (runtime exclu)
cd "$ORIG"
git apply --check /dev/null 2>/dev/null || true
{
  echo "Patch Hermes Web — fonctionnalité Artefacts (split view, chrome-headless-shell, versioning)"
  echo "Base : https://github.com/auriannedrumont-eng/hermes_ui (commit 23826d7)"
  echo "Généré le $(date '+%d %B %Y')"
  echo ""
  echo "Fichiers modifiés :"
  for f in mini-services/hermes-chat/index.ts mini-services/hermes-chat/store.ts mini-services/hermes-chat/types.ts mini-services/hermes-chat/demo-engine.ts mini-services/hermes-chat/README.md src/app/page.tsx src/hooks/use-hermes-chat.ts src/lib/chat-types.ts src/components/chat/message-bubble.tsx src/components/chat/message-list.tsx; do
    echo "  M $f"
  done
  echo "Fichiers ajoutés :"
  for f in mini-services/hermes-chat/artifacts.ts mini-services/hermes-chat/render.ts src/lib/artifact-utils.ts src/components/chat/artifact-card.tsx src/components/chat/artifact-panel.tsx; do
    echo "  A $f"
  done
  echo "=============================================================="
  echo ""
  # Diff des fichiers modifiés et ajoutés (nouveaux fichiers via /dev/null)
  for f in mini-services/hermes-chat/index.ts mini-services/hermes-chat/store.ts mini-services/hermes-chat/types.ts mini-services/hermes-chat/demo-engine.ts mini-services/hermes-chat/README.md mini-services/hermes-chat/artifacts.ts mini-services/hermes-chat/render.ts src/app/page.tsx src/hooks/use-hermes-chat.ts src/lib/chat-types.ts src/lib/artifact-utils.ts src/components/chat/artifact-card.tsx src/components/chat/artifact-panel.tsx src/components/chat/message-bubble.tsx src/components/chat/message-list.tsx; do
    if [ -f "$ORIG/$f" ]; then
      diff -u --label "a/$f" --label "b/$f" "$ORIG/$f" "$NEW/$f" || true
    else
      diff -u --label "/dev/null" --label "b/$f" /dev/null "$NEW/$f" || true
    fi
  done
} > "$OUT/hermes-ui-artefacts.patch"

wc -l "$OUT/hermes-ui-artefacts.patch"

# 2. Archive du projet complet (sans runtime : node_modules, .next, logs, base)
cd "$NEW"
tar -czf "$OUT/hermes-ui-avec-artefacts.tar.gz" \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.git' \
  --exclude='.zscripts/*.log' \
  --exclude='.zscripts/dev.pid' \
  --exclude='dev.log' \
  --exclude='db/*.sqlite-shm' \
  --exclude='db/*.sqlite-wal' \
  --exclude='db/artifacts' \
  --exclude='db/uploads' \
  --exclude='.ref-hermes_ui' \
  Caddyfile components.json eslint.config.mjs next.config.ts package.json postcss.config.mjs tailwind.config.ts tsconfig.json bun.lock \
  prisma public src mini-services scripts examples tests upload/benchmark-extracted db/download-readme 2>/dev/null \
  || tar -czf "$OUT/hermes-ui-avec-artefacts.tar.gz" \
  --exclude='node_modules' --exclude='.next' --exclude='.git' \
  Caddyfile components.json eslint.config.mjs next.config.ts package.json postcss.config.mjs tailwind.config.ts tsconfig.json bun.lock \
  prisma public src mini-services scripts examples tests

ls -lh "$OUT" | tail -4
echo "OK"
