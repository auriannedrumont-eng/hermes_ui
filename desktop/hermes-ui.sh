#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Hermes Web — lanceur bureau
# Démarre la pile complète (mini-service chat, interface Next, passerelle
# Caddy), ouvre le navigateur, puis surveille les composants.
#
# Usage :
#   hermes-ui.sh start     démarre la pile et ouvre le navigateur (défaut)
#   hermes-ui.sh stop      arrêt propre de tout ce que CE lanceur a démarré
#   hermes-ui.sh status    état de la pile + derniers logs
#   hermes-ui.sh restart   stop puis start
#
# Cas couverts (ouverture) :
#   • dépendance manquante (bun / caddy / node_modules) → message clair
#   • pile déjà lancée (PID actif) → on ouvre juste le navigateur
#   • verrou périmé (plantage précédent) → nettoyage et démarrage normal
#   • demi-pile (service vivant, interface morte…) → adoption des sains,
#     démarrage des manquants, arrêt sélectif à la fermeture
#   • port occupé par un tiers : passerelle (81) et interface (3000)
#     basculent automatiquement sur un port libre ; 3003/3004 sont fixes
#     (codés dans le client) → erreur explicite si indisponibles
#   • pas de navigateur détecté → l'URL est affichée
#
# Cas couverts (fermeture) :
#   • Ctrl-C / fermeture du terminal (SIGHUP) / SIGTERM → arrêt propre :
#     interface et passerelle d'abord, mini-service EN DERNIER (SIGTERM →
#     checkpoint WAL, cf. correctif F-09 du service), puis SIGKILL de secours
#   • arrêt par ARBRE de processus (les enfants comme next-server suivent)
#   • composant qui plante en cours de route → redémarré (3 essais max),
#     puis arrêt général propre si ça persiste
#   • on ne tue JAMAIS un processus hors de ce projet : chaque cible est
#     validée (marqueur de commande OU répertoire de travail sous le projet)
#     avant tout signal — un PID réutilisé par l'OS ne suffit pas
# ─────────────────────────────────────────────────────────────────────────
set -u

# ── Racine du projet : le répertoire parent de celui du script ─────────
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
LOG_DIR="$SCRIPT_DIR/logs"
STATE_FILE="$RUNTIME_DIR/state.env"
# Drapeau « mise à jour demandée depuis l'interface » : posé par le
# mini-service (system:update-request), ramassé par la boucle de surveillance
# (cycle suivant) — arrêt propre, mise à jour GitHub, relance. L'onglet
# Hermes reste ouvert : l'utilisateur le rafraîchit (F5) quand c'est terminé.
MAJ_FLAG="$RUNTIME_DIR/maj-demandee.flag"
# Journal live de la mise à jour : le lanceur y raconte chaque étape
# (marqueurs terminaux « MAJ OK » / « MAJ ERREUR »), le mini-service le relit
# et le diffuse à l'interface (Paramètres → Système — console en direct).
MAJ_LOG="$RUNTIME_DIR/maj.log"
MAJ_ENCOURS=0
mkdir -p "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || true

LAUNCHER_LOG="$LOG_DIR/launcher.log"
UI_LOG="$LOG_DIR/interface.log"
CHAT_LOG="$LOG_DIR/mini-service.log"
GW_LOG="$LOG_DIR/passerelle.log"

# Ports fixes imposés par le client (constantes SERVICE_PORT/FILES_PORT)
CHAT_PORT=3003
FILES_PORT=3004
# Ordre de préférence pour les ports mobiles
GW_PORTS=(81 8081 8181 18081)
UI_PORTS=(3000 3001 3002 3005)

MAX_RESTARTS=3
URL_DISPLAY=""

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LAUNCHER_LOG"; }
# Journal de mise à jour : actif seulement après une demande venue de
# l'interface (MAJ_ENCOURS posé au ramassage du drapeau) — les démarrages
# ordinaires ne polluent pas le journal.
maj_log() { [ "$MAJ_ENCOURS" = "1" ] || return 0; printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$MAJ_LOG" 2>/dev/null || true; }
die() { maj_log "MAJ ERREUR - $*"; log "ERREUR : $*"; echo "Hermes Web n'a pas démarré : $*" >&2; exit 1; }

# ── Aides ────────────────────────────────────────────────────────────────
port_open() { # port → 0 si occupé
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1
}
http_code() { # url [timeout_s] → code HTTP ou 000
  curl -s -o /dev/null -m "${2:-4}" -w '%{http_code}' "$1" 2>/dev/null || echo 000
}
pid_alive() { [ -n "${1:-}" ] && [ "$1" -gt 1 ] 2>/dev/null && kill -0 "$1" 2>/dev/null; }

# Un processus nous appartient-il ? (cmdline évoquant le projet, ou cwd
# dans le projet) — c'est la garde anti « kill d'un processus innocent ».
our_process() { # pid
  local pid="$1" cmd cwd
  [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
  case "$cwd" in "$ROOT"|"$ROOT"/*) return 0 ;; esac
  case "$cmd" in *"hermes-chat"*|*"hermes_ui"*|*"$ROOT"*) return 0 ;; esac
  return 1
}
# Descendants d'un pid (profondeur quelconque)
descendants() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    printf '%s\n' "$child"
    descendants "$child"
  done
}
# Arrête l'arbre complet d'un composant : le PID enregistré + tous les
# processus du système qui portent le marqueur ET vivent dans le projet.
stop_tree() { # var_état marqueur signal
  local var="$1" marker="$2" sig="$3"
  local targets="" p pid
  pid="$(state_get "$var")"
  pid_alive "$pid" && our_process "$pid" && targets="$pid"
  for p in $(pgrep -f "$marker" 2>/dev/null); do
    our_process "$p" && targets="$targets $p"
  done
  local all="$targets" t
  for t in $targets; do all="$all $(descendants "$t")"; done
  all="$(printf '%s\n' $all | sort -u | tr '\n' ' ')"
  [ -n "$(echo $all | tr -d ' ')" ] || { log "  (rien à arrêter pour $marker)"; return 0; }
  log "  signal $sig → $marker [$all]"
  # feuille → racine : les enfants d'abord pour éviter les ré-spawn
  for p in $(printf '%s\n' $all | tac); do kill -"$sig" "$p" 2>/dev/null; done
}
wait_tree_gone() { # var_état marqueur [timeout_s]
  local var="$1" marker="$2" t="${3:-10}" i p rest
  for ((i = 0; i < t; i++)); do
    rest=""
    for p in $(pgrep -f "$marker" 2>/dev/null); do
      our_process "$p" && rest="$rest$p "
    done
    local lp; lp="$(state_get "$var")"
    pid_alive "$lp" && our_process "$lp" && rest="${rest}$lp "
    [ -z "$(echo $rest | tr -d ' ')" ] && return 0
    sleep 1
  done
  log "  $marker récalcitrant → SIGKILL [$rest]"
  for p in $rest; do kill -9 "$p" 2>/dev/null; done
  sleep 1
}
wait_http() { # url attendu tentative_s label
  local url="$1" want="$2" tries="${3:-40}" label="$4" i code
  for ((i = 1; i <= tries; i++)); do
    code="$(http_code "$url" 3)"
    if [ "$code" = "$want" ]; then log "  ✓ $label prêt (HTTP $code)"; return 0; fi
    sleep 1
  done
  log "  ✗ $label : HTTP $code après ${tries}s (attendu $want)"
  return 1
}

# ── État persistant (PID/ports/ownership) ───────────────────────────────
state_set() { # clé valeur
  sed -i "/^$1=/d" "$STATE_FILE" 2>/dev/null; echo "$1=$2" >> "$STATE_FILE"
}
state_get() { grep "^$1=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }

# ── Dépendances ──────────────────────────────────────────────────────────
check_deps() {
  command -v bun >/dev/null 2>&1 || die "« bun » est introuvable (https://bun.sh)."
  command -v node >/dev/null 2>&1 || die "« node » est introuvable."
  [ -f "$ROOT/mini-services/hermes-chat/index.ts" ] || die "projet introuvable autour de $ROOT"
  [ -d "$ROOT/node_modules" ] || die "node_modules absent — lancez « npm install » dans $ROOT"
  [ -d "$ROOT/mini-services/hermes-chat/node_modules" ] || \
    die "dépendances du mini-service absentes — lancez « bun install » dans $ROOT/mini-services/hermes-chat"
}

pick_port() { # liste… → port libre (vide si aucun)
  local p
  for p in "$@"; do port_open "$p" || { echo "$p"; return; }; done
  echo ""
}

chat_healthy() {
  [ "$(http_code "http://127.0.0.1:$CHAT_PORT/socket.io/?EIO=4&transport=polling" 3)" = "200" ]
}
ui_healthy() { [ "$(http_code "http://127.0.0.1:$(state_get UI_PORT)/" 6)" = "200" ]; }
gw_healthy() { [ "$(http_code "http://127.0.0.1:$(state_get GW_PORT)/" 4)" = "200" ]; }

# ── Démarrage des composants ─────────────────────────────────────────────
# exec : le PID enregistré EST le processus (cmdline exploitable, pas un
# sous-shell wrapper). nohup + </dev/null : survit à la fermeture du terminal.
start_chat() {
  if chat_healthy; then log "• mini-service déjà actif sur :$CHAT_PORT (adopté)"; state_set CHAT_OWNED 0; return 0; fi
  if port_open "$CHAT_PORT" || port_open "$FILES_PORT"; then
    die "les ports $CHAT_PORT/$FILES_PORT sont occupés par un autre programme alors que le service Hermes n'y répond pas. Libérez-les (ss -tlnp | grep -E '3003|3004')."
  fi
  log "• démarrage du mini-service (ports $CHAT_PORT/$FILES_PORT)…"
  ( cd "$ROOT/mini-services/hermes-chat" && exec nohup bun index.ts >>"$CHAT_LOG" 2>&1 </dev/null ) &
  state_set CHAT_PID "$!"
  state_set CHAT_OWNED 1
  wait_http "http://127.0.0.1:$CHAT_PORT/socket.io/?EIO=4&transport=polling" 200 40 "mini-service" \
    || die "le mini-service ne répond pas — consultez $CHAT_LOG"
}

start_ui() {
  local port; port="$(state_get UI_PORT)"
  if [ "$(http_code "http://127.0.0.1:$port/" 4)" = "200" ]; then
    log "• interface déjà active sur :$port (adoptée)"; state_set UI_OWNED 0; return 0
  fi
  if port_open "$port"; then die "le port $port est occupé sans servir l'interface — libérez-le."; fi
  if [ -f "$ROOT/.next/standalone/server.js" ]; then
    log "• démarrage de l'interface (build production) sur :$port…"
    ( cd "$ROOT" && PORT="$port" HOSTNAME=127.0.0.1 exec nohup bun .next/standalone/server.js >>"$UI_LOG" 2>&1 </dev/null ) &
    state_set UI_MODE "production"
  else
    log "• démarrage de l'interface (mode développement) sur :$port…"
    log "  (pour le mode production : npm run build une fois, puis relancez)"
    ( cd "$ROOT" && exec nohup ./node_modules/.bin/next dev -p "$port" >>"$UI_LOG" 2>&1 </dev/null ) &
    state_set UI_MODE "développement"
  fi
  state_set UI_PID "$!"
  state_set UI_OWNED 1
  # le premier build dev peut être long : 120 s de marge
  wait_http "http://127.0.0.1:$port/" 200 120 "interface ($(state_get UI_MODE))" \
    || die "l'interface ne répond pas — consultez $UI_LOG"
}

start_gateway() {
  local port; port="$(state_get GW_PORT)"
  local url="http://127.0.0.1:$port/"
  # Sert-elle déjà notre interface ? (passerelle existante, p.ex. système)
  if [ "$(http_code "$url" 4)" = "200" ]; then
    log "• passerelle déjà active sur :$port (adoptée)"; state_set GW_OWNED 0; return 0
  fi
  command -v caddy >/dev/null 2>&1 || die "« caddy » est introuvable et le port $port est libre — installez caddy (https://caddyserver.com) ou libérez une passerelle existante."
  if port_open "$port"; then die "le port $port est occupé sans servir l'interface — libérez-le."; fi
  # Caddyfile généré avec les ports choisis à l'exécution
  local cf="$RUNTIME_DIR/Caddyfile"
  sed -e "s/^:81 {/:$port {/" -e "s#localhost:3000#localhost:$(state_get UI_PORT)#" \
    "$ROOT/Caddyfile" > "$cf"
  log "• démarrage de la passerelle Caddy sur :$port (→ interface :$(state_get UI_PORT))…"
  ( cd "$ROOT" && exec nohup caddy run --config "$cf" --adapter caddyfile >>"$GW_LOG" 2>&1 </dev/null ) &
  state_set GW_PID "$!"
  state_set GW_OWNED 1
  wait_http "$url" 200 20 "passerelle" || die "la passerelle ne répond pas — consultez $GW_LOG"
}

open_browser() {
  local url="$1" opener=""
  for c in xdg-open gio gnome-open kde-open wslview; do
    command -v "$c" >/dev/null 2>&1 && { opener="$c"; break; }
  done
  if [ -n "${BROWSER:-}" ] && command -v "${BROWSER%% *}" >/dev/null 2>&1; then
    nohup "$BROWSER" "$url" >/dev/null 2>&1 &
  elif [ -n "$opener" ]; then
    nohup "$opener" "$url" >/dev/null 2>&1 &
  else
    URL_DISPLAY="$url"
  fi
  log "• navigateur : $url"
}

# ── ARRÊT PROPRE ─────────────────────────────────────────────────────────
do_stop() {
  log "Arrêt demandé…"
  # 1. Ce qui reçoit le trafic d'abord : passerelle puis interface
  stop_tree GW_PID  "caddy run" TERM
  stop_tree UI_PID  "next dev|standalone/server\.js|next-server" TERM
  # 2. Battement : laisse les réponses en vol se terminer
  sleep 1
  # 3. Le mini-service EN DERNIER : son handler SIGTERM fait le
  #    checkpoint WAL (données intégrées au fichier SQLite principal)
  stop_tree CHAT_PID "bun index\.ts|hermes-chat/index" TERM
  wait_tree_gone CHAT_PID "bun index\.ts|hermes-chat/index" 10
  wait_tree_gone UI_PID  "next dev|standalone/server\.js|next-server" 10
  wait_tree_gone GW_PID  "caddy run" 10
  rm -f "$STATE_FILE" "$RUNTIME_DIR"/*.pid 2>/dev/null
  # Composants adoptés (OWNED=0) : volontairement NON arrêtés — ils
  # n'ont pas été démarrés par ce lanceur.
  log "Arrêt terminé."
}

# ── SURVEILLANCE ─────────────────────────────────────────────────────────
# Santé = l'endpoint répond. Un PID disparu avec un service qui répond →
# simple ré-adoption (pas une grève). Une grève = service inaccessible.
supervise_one() { # nom fn_healthy fn_start var_owned ref_compteur
  local name="$1" healthy="$2" start="$3" owned_var="$4"
  local -n count_ref="$5"
  [ "$(state_get "$owned_var")" = "1" ] || return 0
  if "$healthy"; then
    local pvar="${owned_var%_OWNED}_PID"
    if ! pid_alive "$(state_get "$pvar")"; then
      log "• $name répond mais son PID a changé → ré-adopté (pas de grève)"
      state_set "$owned_var" 0
    fi
    return 0
  fi
  if [ "$((count_ref + 1))" -gt "$MAX_RESTARTS" ]; then
    log "⚠ $name : trop de redémarrages — arrêt propre de tout."
    do_stop; exit 1
  fi
  count_ref=$((count_ref + 1))
  log "⚠ $name inaccessible → redémarrage ($count_ref/$MAX_RESTARTS)"
  "$start"
}

supervise() {
  local n_gw=0 n_ui=0 n_chat=0 maj_demandee=0
  log "Surveillance active (Ctrl-C ou fermeture de cette fenêtre = arrêt propre)."
  trap 'log "Signal reçu — arrêt propre."; do_stop; exit 0' INT TERM HUP
  while :; do
    sleep 5
    # Mise à jour demandée depuis l'interface (Paramètres → Système) :
    # arrêt propre, mise à jour GitHub + reconstruction si nécessaire, relance.
    if [ -f "$MAJ_FLAG" ]; then
      rm -f "$MAJ_FLAG" 2>/dev/null
      maj_demandee=1
      MAJ_ENCOURS=1
      maj_log "MAJ DEBUT - demande ramassée par le lanceur"
      log "• mise à jour demandée depuis l'interface — arrêt, mise à jour GitHub, relance (1 à 2 minutes)."
      break
    fi
    supervise_one "passerelle"   gw_healthy   start_gateway GW_OWNED   n_gw
    supervise_one "interface"    ui_healthy   start_ui      UI_OWNED   n_ui
    supervise_one "mini-service" chat_healthy start_chat    CHAT_OWNED n_chat
  done
  if [ "$maj_demandee" = "1" ]; then
    log "Arrêt pour mise à jour (demandée depuis l'interface) — données sauvegardées."
    do_stop
    maj_log "services arrêtés — mise à jour GitHub puis relance…"
    sleep 1
    SANS_NAVIGATEUR=1
    do_start || maj_log "MAJ ERREUR - échec de la relance (détail : $LAUNCHER_LOG)"
  fi
}

# ── COMMANDES ────────────────────────────────────────────────────────────
do_status() {
  echo "── Hermes Web ─────────────────────────────────────"
  if [ ! -f "$STATE_FILE" ]; then
    echo "  état      : arrêté (aucune pile enregistrée)"
  else
    echo "  adresse   : http://127.0.0.1:$(state_get GW_PORT)/"
    echo "  interface : port $(state_get UI_PORT) ($(state_get UI_MODE)), mini-service : $CHAT_PORT/$FILES_PORT"
    local pid
    for spec in "GW_PID:caddy run:GW_OWNED:passerelle" "UI_PID:next dev|server.js:UI_OWNED:interface" "CHAT_PID:index.ts:CHAT_OWNED:mini-service"; do
      IFS=: read -r var marker owned name <<<"$spec"
      pid="$(state_get "$var")"
      if pid_alive "$pid" && our_process "$pid"; then echo "  $name : actif (pid $pid, à nous)"
      elif [ "$(state_get "$owned")" = "0" ]; then echo "  $name : actif (externe/adopté)"
      else echo "  $name : ARRÊTÉ"; fi
    done
  fi
  echo "── derniers logs ($LAUNCHER_LOG) ──────────────────"
  tail -n 8 "$LAUNCHER_LOG" 2>/dev/null || echo "  (vide)"
}

do_start() {
  check_deps

  # Drapeau resté posé (demande faite sans lanceur vivant) : le démarrage fait
  # de toute façon la mise à jour GitHub — le retirer évite une relance
  # supplémentaire dès le premier cycle de surveillance.
  rm -f "$MAJ_FLAG" 2>/dev/null

  # Mise à jour GitHub (même idiome que le lanceur Windows : fusion rapide
  # ff-only ; en cas d'écart local, version locale conservée sans toucher).
  local avant apres
  avant="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
  maj_log "consultation de GitHub…"
  if [ -n "$avant" ] && git -C "$ROOT" fetch --quiet origin 2>/dev/null; then
    apres="$(git -C "$ROOT" rev-parse '@{u}' 2>/dev/null)"
    if [ -n "$apres" ] && [ "$apres" != "$avant" ]; then
      if git -C "$ROOT" merge --ff-only "$apres" >/dev/null 2>&1; then
        log "• mise à jour appliquée : $(git -C "$ROOT" diff --name-only "$avant" "$apres" 2>/dev/null | grep -c . || echo '?') fichier(s) récupéré(s)"
        maj_log "mise à jour appliquée : $(git -C "$ROOT" diff --name-only "$avant" "$apres" 2>/dev/null | grep -c . || echo '?') fichier(s) récupéré(s)"
        # Code de l'interface modifié → reconstruction du build production.
        if git -C "$ROOT" diff --name-only "$avant" "$apres" 2>/dev/null | grep -qE '^(src|public)/|^(package|next\.config|postcss\.config|tailwind\.config|tsconfig)'; then
          if [ -f "$ROOT/.next/standalone/server.js" ]; then
            log "  code de l'interface modifié : reconstruction du build production…"
            maj_log "code de l'interface modifié — reconstruction (1 à 3 minutes)…"
            rm -rf "$ROOT/.next"
            ( cd "$ROOT" && npm run build >>"$LOG_DIR/build.log" 2>&1 ) \
              && { log "  reconstruction terminée."; maj_log "reconstruction terminée"; } \
              || { log "  ATTENTION : reconstruction échouée — mode développement au démarrage (voir logs/build.log)."; maj_log "ATTENTION - reconstruction échouée — mode développement au démarrage"; }
          fi
        fi
      else
        log "• ATTENTION : nouvelle version disponible mais non appliquée (fichiers locaux modifiés) — version locale conservée."
        maj_log "ATTENTION - nouvelle version disponible mais non appliquée — version locale conservée"
      fi
    else
      maj_log "déjà à jour — aucune nouvelle version sur GitHub"
    fi
  else
    maj_log "GitHub injoignable — version locale conservée"
  fi

  # Pile déjà lancée par un lanceur précédent encore vivant ? — SAUF si le
  # lanceur en mémoire est périmé : le script sur disque a été modifié APRÈS
  # son démarrage (mise à jour GitHub appliquée pendant qu'il tournait). Une
  # relance doit alors le REMPLACER, pas seulement ouvrir le navigateur —
  # sinon la mise à jour suivante reste muette (le vieux lanceur ne connaît
  # pas le journal live).
  local pid debut scriptmt
  pid="$(state_get LAUNCHER_PID)"
  if pid_alive "$pid" && our_process "$pid" && grep -aq "hermes-ui" "/proc/$pid/cmdline" 2>/dev/null; then
    # Début du processus (epoch) : /proc/PID (ctime = démarrage) — Linux
    # uniquement ; sans cette donnée, comportement simple conservé.
    debut="$(stat -c %Y "/proc/$pid" 2>/dev/null || true)"
    scriptmt="$(stat -c %Y "$0" 2>/dev/null || true)"
    if [ -n "$debut" ] && [ -n "$scriptmt" ] && [ $((scriptmt - debut)) -gt 5 ]; then
      log "REPRISE EN MAIN : un lanceur périmé tourne encore (pid $pid, son script est plus récent sur disque) — arrêt de l'ancien lanceur et de sa pile, puis redémarrage avec le code à jour."
      kill "$pid" 2>/dev/null || true
      sleep 2
      if pid_alive "$pid"; then kill -9 "$pid" 2>/dev/null || true; sleep 1; fi
    else
      log "Pile déjà démarrée (lanceur pid $pid) — ouverture du navigateur uniquement."
      open_browser "http://127.0.0.1:$(state_get GW_PORT)/"
      echo "Hermes Web est déjà lancé : http://127.0.0.1:$(state_get GW_PORT)/"
      echo "  Rien à relancer. (Pour REMPLACER le lanceur : fermez sa fenêtre puis relancez ce fichier.)"
      sleep 8
      return 0
    fi
  fi
  # Verrou périmé (plantage sauvage précédent) : nettoie les restes éventuels
  if [ -f "$STATE_FILE" ]; then
    log "Verrou d'une session précédente trouvé — nettoyage des restes éventuels."
    stop_tree UI_PID  "next dev|standalone/server\.js|next-server" TERM
    stop_tree CHAT_PID "bun index\.ts|hermes-chat/index" TERM
    stop_tree GW_PID  "caddy run" TERM
    sleep 1
    rm -f "$STATE_FILE" "$RUNTIME_DIR"/*.pid 2>/dev/null
  fi

  # Choix des ports mobiles AVANT le moindre démarrage (tout ou rien)
  local gw ui
  gw="$(pick_port "${GW_PORTS[@]}")"; [ -n "$gw" ] || die "aucun port libre pour la passerelle (essayés : ${GW_PORTS[*]})."
  ui="$(pick_port "${UI_PORTS[@]}")"; [ -n "$ui" ] || die "aucun port libre pour l'interface (essayés : ${UI_PORTS[*]})."
  state_set GW_PORT "$gw"; state_set UI_PORT "$ui"
  state_set LAUNCHER_PID "$$"
  log "════ Démarrage Hermes Web (passerelle :$gw, interface :$ui) ════"

  maj_log "relance des services…"
  start_chat
  start_ui
  start_gateway
  if [ "${SANS_NAVIGATEUR:-0}" = "1" ]; then
    # Le lanceur lui-même fait-il partie de ce qui vient d'être reçu ? Dans
    # ce cas il continue de tourner en mémoire avec l'ancien code : la
    # prochaine mise à jour serait muette tant qu'on ne le relance pas.
    if [ -n "$avant" ] && [ -n "$apres" ] && git -C "$ROOT" diff --name-only "$avant" "$apres" 2>/dev/null | grep -q '^desktop/hermes-ui\.sh'; then
      maj_log "remarque - le lanceur lui-même a été mis à jour : fermez sa fenêtre puis relancez Hermes-Web.sh (une seule fois) pour que les PROCHAINES mises à jour s'affichent en direct."
      log "• le lanceur lui-même a été mis à jour — fermez sa fenêtre puis relancez Hermes-Web.sh (une seule fois)."
    fi
    maj_log "MAJ OK - pile relancée, rafraîchissez l'onglet Hermes (F5) pour charger la nouvelle version."
    log "• pile relancée après mise à jour — rafraîchissez votre onglet Hermes (F5) pour charger la nouvelle version."
  else
    open_browser "http://127.0.0.1:$gw/"
  fi

  echo ""
  echo "  ┌────────────────────────────────────────────────┐"
  echo "  │  Hermes Web est prêt : http://127.0.0.1:$gw/"
  if [ -n "$URL_DISPLAY" ]; then
    echo "  │  Aucun navigateur détecté — ouvrez l'URL       │"
    echo "  │  ci-dessus manuellement.                       │"
  fi
  echo "  │  Fermez cette fenêtre (ou Ctrl-C) pour tout    │"
  echo "  │  arrêter PROPREMENT (données sauvegardées).    │"
  echo "  └────────────────────────────────────────────────┘"

  supervise
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  status)  do_status ;;
  restart) do_stop; sleep 1; do_start ;;
  *) echo "Usage : $0 {start|stop|status|restart}"; exit 2 ;;
esac
