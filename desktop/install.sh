#!/usr/bin/env bash
# Installe (ou retire) les raccourcis bureau d'Hermes Web.
#
#   ./install.sh            → installe les entrées dans le menu d'applications
#                             et sur le Bureau (si présent)
#   ./install.sh --remove   → retire tout ce qui a été installé
#
# Les entrées pointent en ABSOLU vers ce projet : déplacer le dossier
# hermes_ui après installation casse les chemins → relancez install.sh.
set -u
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(dirname "$HERE")"
APPS_DIR="${HOME}/.local/share/applications"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Bureau")"
INSTALLED=()

entries=(Hermes-Web Hermes-Web-Stop)

do_install() {
  for name in "${entries[@]}"; do
    src="$HERE/$name.desktop.in"
    [ -f "$src" ] || { echo "✗ modèle manquant : $src"; exit 1; }
    dst="$APPS_DIR/$name.desktop"
    mkdir -p "$APPS_DIR"
    sed "s#__ROOT__#$ROOT#g" "$src" > "$dst"
    chmod +x "$dst" 2>/dev/null || true
    INSTALLED+=("$dst")
    if [ -d "$DESKTOP_DIR" ]; then
      cp "$dst" "$DESKTOP_DIR/$name.desktop"
      chmod +x "$DESKTOP_DIR/$name.desktop" 2>/dev/null || true
      INSTALLED+=("$DESKTOP_DIR/$name.desktop")
    fi
  done
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" 2>/dev/null
  echo "✓ Raccourcis installés :"
  printf '   %s\n' "${INSTALLED[@]}"
  echo
  echo "  « Hermes Web »       : démarre la pile et ouvre le navigateur."
  echo "  « Hermes Web — Arrêter » : arrêt propre (base sauvegardée)."
  echo "  En ligne de commande : $HERE/hermes-ui.sh {start|stop|status|restart}"
}

do_remove() {
  rm -f "$APPS_DIR"/Hermes-Web.desktop "$APPS_DIR"/Hermes-Web-Stop.desktop
  rm -f "$DESKTOP_DIR"/Hermes-Web.desktop "$DESKTOP_DIR"/Hermes-Web-Stop.desktop
  echo "✓ Raccourcis retirés."
}

case "${1:-install}" in
  --remove|remove) do_remove ;;
  *) do_install ;;
esac
