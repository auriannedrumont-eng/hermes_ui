#!/bin/bash
# Génère les livrables d'une session de travail (cf. FORK.md §10) :
#   1. les patchs git (git format-patch) depuis un point de départ ;
#   2. un bundle git (historique complet de main) ;
#   3. l'archive zip des fichiers seuls de la branche publish (téléversement
#      GitHub sans git — « Add file » → « Upload files »).
# Usage :
#   bash scripts/package-livrables.sh [base]     # base = commit de départ des patchs
#   OUT=… bash scripts/package-livrables.sh base # répertoire de sortie personnalisé
# Sans argument, seuls le bundle et le zip sont produits (pas de patchs).
set -e
cd "$(dirname "$0")/.."

BASE_REF="${1:-}"
OUT="${OUT:-download/livrables}"
mkdir -p "$OUT"

if [ -n "$BASE_REF" ]; then
  echo "— patchs git ($BASE_REF..main) —"
  git format-patch -o "$OUT" "$BASE_REF..main"
fi

echo "— bundle (historique complet de main) —"
git bundle create "$OUT/hermes_ui-main.bundle" main 2>/dev/null

echo "— zip des fichiers seuls (branche publish) —"
git archive --format=zip -o "$OUT/hermes_ui-a-televerser.zip" publish

echo
ls -lh "$OUT" | tail -6
echo "OK — livrables dans $OUT"
