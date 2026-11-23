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
# CONTRAT (audit v3, A-1) : l'interface lit le verdict comme la DERNIÈRE
# ligne du journal qui porte un marqueur « MAJ OK » / « MAJ ERREUR ».
# N'écrire AUCUNE ligne informative APRÈS le marqueur final — si une
# remarque doit suivre (ex. lanceur lui-même mis à jour), elle passe
# AVANT le verdict.
MAJ_LOG="$RUNTIME_DIR/maj.log"
MAJ_ENCOURS=0
# Drapeau « arrêt propre des tours en vol » (loi jamais bloqué, 2026-11-22) :
# déposé par le lanceur AVANT chaque arrêt du mini-service (arrêt général,
# mise à jour, Ctrl-C). Le service le lit (500 ms), clôt chaque tour en vol
# (partiel persisté + événement terminal par écran), supprime le drapeau —
# le lanceur attend au plus 8 s puis arrête. Les écrans clients reçoivent
# leur fin de tour au lieu d'un mort dans l'œuf.
DRAIN_FLAG="$RUNTIME_DIR/arret-propre.flag"
mkdir -p "$RUNTIME_DIR" "$LOG_DIR" 2>/dev/null || true

# ── Manifeste de santé (§10 refonte (68), loi « une seule vérité ») ──────
# Un seul état écrit par le lanceur à chaque phase — prérequis ✓/✗, état de
# l'agent, maillons — lu par le mini-service (/diagnostics) et affiché à
# l'écran Système. Plus jamais deux histoires différentes entre la fenêtre
# du lanceur et l'interface. Convention ok : 0 = vrai, 1 = faux.
SANTE_FILE="$RUNTIME_DIR/sante.json"
SANTE_PREREQUIS=""
SANTE_AGENT_ETAT="inconnu"
SANTE_AGENT_CAUSE=""
SANTE_MAILLONS_SERVICE="en attente"
SANTE_MAILLONS_INTERFACE="en attente"
SANTE_MAILLONS_PASSERELLE="en attente"
SANTE_MAILLONS_AGENT="en attente"

write_sante() { # [pret] [cause] — jamais bloquant
  local pret="${1:-en cours}" cause="${2:-}"
  local commit
  commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '')"
  printf '{"horodatage":"%s","commit":"%s","pret":"%s","cause":"%s","prerequis":[%s],"agent":{"etat":"%s","cause":"%s"},"maillons":{"service":"%s","interface":"%s","passerelle":"%s","agent":"%s"}}\n' \
    "$(date +%Y-%m-%dT%H:%M:%S%z)" "$commit" "$pret" "$cause" \
    "$SANTE_PREREQUIS" "$SANTE_AGENT_ETAT" "$SANTE_AGENT_CAUSE" \
    "$SANTE_MAILLONS_SERVICE" "$SANTE_MAILLONS_INTERFACE" \
    "$SANTE_MAILLONS_PASSERELLE" "$SANTE_MAILLONS_AGENT" \
    > "$SANTE_FILE" 2>/dev/null || true
}
add_sante_prerequis() { # nom ok(0/1) [note] — affiche ✓/✗ ET enregistre
  local nom="$1" ok="$2" note="${3:-}" mark json_ok aff
  if [ "$ok" = "0" ]; then mark="✓"; json_ok="true"; else mark="✗"; json_ok="false"; fi
  aff="$nom"
  [ -n "$note" ] && aff="$nom — $note"
  log "  $mark $aff"
  # Échappement JSON minimal : ni guillemets ni antislashs dans les champs.
  nom="$(printf '%s' "$nom" | tr -d '"\\')"
  note="$(printf '%s' "$note" | tr -d '"\\')"
  [ -n "$SANTE_PREREQUIS" ] && SANTE_PREREQUIS="$SANTE_PREREQUIS,"
  SANTE_PREREQUIS="$SANTE_PREREQUIS$(printf '{"nom":"%s","ok":%s,"note":"%s"}' "$nom" "$json_ok" "$note")"
}
set_sante_agent() { # etat [cause]
  SANTE_AGENT_ETAT="$1"; SANTE_AGENT_CAUSE="${2:-}"; write_sante "en cours"
}
set_sante_maillon() { # nom etat
  case "$1" in
    service)   SANTE_MAILLONS_SERVICE="$2" ;;
    interface) SANTE_MAILLONS_INTERFACE="$2" ;;
    passerelle) SANTE_MAILLONS_PASSERELLE="$2" ;;
    agent)     SANTE_MAILLONS_AGENT="$2" ;;
  esac
  write_sante "en cours"
}
# ── BLOC PORTABLE (loi 8, chantier 5) — extrait tel quel par les épreuves ──
# Phase 0 — prérequis parlants (§10 refonte (68)). Bloquants (arrêt propre
# avec remède) : bun, caddy, droits d'écriture, disque. Non bloquants mais
# DITS clairement : Git (mises à jour + clone désactivés si absent),
# Python/pip (provisionnement de l'agent — si absents, l'interface tournera
# sur vos clés et le manifeste le dira).
# Loi 8 (plan v2, chantier 5) : le dossier sait se suffire — même sur Unix,
# un poste sans VRAI python3 n'est pas un cul-de-sac. Le lanceur télécharge
# alors un python portable (construction autonome du projet python-build-
# standalone) DANS le dossier de l'interface : ni PATH ni rien d'autre ne
# sont touchés. Sur Unix, un python3 système réel passe d'abord (c'est
# l'équivalent Unix d'une installation saine) ; le portable n'est téléchargé
# que si aucun python réel n'existe — ou est muet/faux. Les messages passent
# par stderr (écran + journal) : la fonction REND le chemin sur stdout,
# capturé par $(...) chez les appelants.
log_stderr() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LAUNCHER_LOG" >&2; }
ensure_portable_python() {
  local portdir="$RUNTIME_DIR/python-portable"
  local portpy="$portdir/python/bin/python3"
  if [ ! -x "$portpy" ]; then portpy="$portdir/bin/python3"; fi
  if [ -x "$portpy" ]; then
    if "$portpy" --version >/dev/null 2>&1; then printf '%s' "$portpy"; return 0; fi
    # Cas 31 : présent mais illisible — rien de menteur n'est gardé.
    log_stderr "• le Python portable du dossier est illisible — nettoyage puis retéléchargement."
    rm -rf "$portdir" 2>/dev/null || true
  fi
  if [ -f "$RUNTIME_DIR/portable-python.flag" ] && [ "$(( $(date +%s) - $(date -r "$RUNTIME_DIR/portable-python.flag" +%s 2>/dev/null || echo 0) ))" -lt 3600 ]; then
    log_stderr "• Python portable : la dernière tentative d'installation a échoué — nouvelle tentative au plus tôt dans 1 h (repli ce démarrage : python système)."
    return 1
  fi
  touch "$RUNTIME_DIR/portable-python.flag" 2>/dev/null || true
  # 3.14 : la version que l'agent EXIGE — ses dépendances sûres (pydantic
  # sans le core qui segfaulte, httpx/requests avec les correctifs CVE)
  # sont réservées à python >= 3.14 par le projet amont.
  local url="${HERMES_PYTHON_URL:-https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.14.10+20261110-x86_64-unknown-linux-gnu-install_only.tar.gz}"
  local tarball="$RUNTIME_DIR/python-portable.tar.gz"
  log_stderr "• installation du Python portable de l'application (construction autonome officielle, dans le dossier — rien d'autre n'est touché)…"
  if ! curl -fsSL -m 300 -o "$tarball" "$url" 2>/dev/null || [ ! -s "$tarball" ]; then
    log_stderr "  ATTENTION : téléchargement impossible — l'interface tourne sur vos clés ce démarrage ; nouvelle tentative au prochain démarrage."
    rm -f "$tarball" 2>/dev/null || true
    return 1
  fi
  mkdir -p "$portdir" 2>/dev/null || true
  if ! tar xzf "$tarball" -C "$portdir" 2>/dev/null; then
    log_stderr "  ATTENTION : archive illisible — rien de menteur n'est gardé ; nouvelle tentative au prochain démarrage."
    rm -rf "$portdir" "$tarball" 2>/dev/null || true
    return 1
  fi
  rm -f "$tarball" 2>/dev/null || true
  portpy="$portdir/python/bin/python3"
  if [ ! -x "$portpy" ]; then portpy="$portdir/bin/python3"; fi
  if [ ! -x "$portpy" ] || ! "$portpy" --version >/dev/null 2>&1; then
    log_stderr "  ATTENTION : python portable reçu illisible — rien de menteur n'est gardé ; nouvelle tentative au prochain démarrage."
    rm -rf "$portdir" 2>/dev/null || true
    return 1
  fi
  log_stderr "  Python portable prêt ($("$portpy" --version 2>/dev/null || echo '')) — il vit dans le dossier de l'interface."
  printf '%s' "$portpy"
  return 0
}
# === FIN-BLOC-PORTABLE ===

phase_prerequis() {
  log "── Phase 0 : prérequis ─────────────────────────────────"
  if command -v git >/dev/null 2>&1; then
    add_sante_prerequis "Git" 0
  else
    add_sante_prerequis "Git" 1 "mises à jour GitHub et installation de l'agent désactivées ce démarrage"
  fi
  local pycmd="" pyver="" pipok=1 portpy=""
  if command -v python3 >/dev/null 2>&1; then pycmd="python3"
  elif command -v python >/dev/null 2>&1; then pycmd="python"; fi
  if [ -n "$pycmd" ]; then pyver="$("$pycmd" --version 2>&1 || echo '')"; fi
  # Le faux raccourci du Microsoft Store répond AUSSI à « python » : sa
  # phrase « Python was not found » prouve qu'il n'y a AUCUN vrai python
  # derrière (cas réel du 23/11 — la cause exacte affichée en Système).
  case "$pyver" in *"was not found"*) pycmd=""; pyver="" ;; esac
  if [ -n "$pycmd" ]; then
    add_sante_prerequis "Python" 0 "$pyver"
    if "$pycmd" -m pip --version >/dev/null 2>&1; then pipok=0; fi
  else
    # Loi 8 (plan v2, chantier 5) : aucun vrai python → le lanceur possèdera
    # le sien (Python portable téléchargé DANS le dossier, une fois, borné).
    portpy="$(ensure_portable_python 2>/dev/null || echo '')"
    if [ -n "$portpy" ]; then
      add_sante_prerequis "Python (portable, dans le dossier)" 0 "$("$portpy" --version 2>/dev/null || echo '') — aucune dépendance au python du poste"
      pycmd="$portpy"
      if "$pycmd" -m pip --version >/dev/null 2>&1; then pipok=0; fi
    else
      add_sante_prerequis "Python" 1 "aucun python utilisable ce démarrage — l'agent ne s'installera pas ; l'interface restera sur vos clés. Remède : réseau (le Python portable s'installera tout seul au prochain démarrage), ou python.org avec « Add python.exe to PATH », ou désactivez les faux raccourcis (Paramètres > Applications > Alias d'exécution d'applications)"
    fi
  fi
  if [ "$pipok" = "0" ]; then
    add_sante_prerequis "pip (module python)" 0
  else
    add_sante_prerequis "pip (module python)" 1 "installation des dépendances de l'agent impossible"
  fi
  if command -v bun >/dev/null 2>&1; then
    add_sante_prerequis "Runtime de l'interface (bun)" 0
  else
    add_sante_prerequis "Runtime de l'interface (bun)" 1 ""
    write_sante "echec" "runtime de l'interface introuvable (bun) — vérifiez votre réseau ou réinstallez"
    die "runtime de l'interface introuvable (bun) — vérifiez votre réseau ou réinstallez."
  fi
  if command -v caddy >/dev/null 2>&1; then
    add_sante_prerequis "Passerelle (caddy)" 0
  else
    add_sante_prerequis "Passerelle (caddy)" 1 ""
    write_sante "echec" "caddy introuvable — réinstallez ou vérifiez le réseau"
    die "caddy introuvable — réinstallez-le ou vérifiez le réseau."
  fi
  if touch "$ROOT/.hermes-ecriture-test" 2>/dev/null; then
    rm -f "$ROOT/.hermes-ecriture-test"
    add_sante_prerequis "Droits d'écriture sur le dossier" 0
  else
    add_sante_prerequis "Droits d'écriture sur le dossier" 1 "vérifiez la lecture seule / OneDrive / antivirus"
    write_sante "echec" "écriture impossible dans le dossier de l'application"
    die "écriture impossible dans le dossier de l'application — vérifiez qu'il n'est pas en lecture seule (antivirus, OneDrive, droits)."
  fi
  local free_kb
  free_kb="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -n "$free_kb" ] && [ "$free_kb" -ge 524288 ]; then
    add_sante_prerequis "Espace disque" 0 "$(( free_kb / 1048576 )) Go libres"
  else
    add_sante_prerequis "Espace disque" 1 "${free_kb:-inconnu} Ko libres — un build a besoin de marge ; libérez de la place"
    write_sante "echec" "espace disque insuffisant sur le disque du dossier"
    die "espace disque insuffisant — libérez de la place puis relancez."
  fi
  # État de l'agent : lu sur le disque (maison + marqueurs) ; la vérité du
  # LIVE (branché / en allumage) reste celle de l'interface et du service.
  if [ ! -e "$ROOT/hermes-agent/.git" ] && [ ! -f "$ROOT/hermes-agent/gateway/run_api.py" ]; then
    if [ -n "$pycmd" ]; then
      set_sante_agent "non installé" "l'installation se fera au prochain démarrage (réseau requis une fois)"
    else
      set_sante_agent "non installé" "python absent — installez Python puis relancez"
    fi
  elif [ -f "$RUNTIME_DIR/agent-certifie.ok" ]; then
    set_sante_agent "certifié" ""
  elif [ -f "$RUNTIME_DIR/agent-deps.ok" ]; then
    set_sante_agent "installé (dépendances réussies, pas encore certifié)" ""
  else
    if [ -n "$pycmd" ]; then
      set_sante_agent "installé sans dépendances complètes" "les dépendances seront retentées au prochain démarrage (au plus tôt dans 1 h)"
    else
      set_sante_agent "installé sans dépendances complètes" "python absent — installez Python puis relancez"
    fi
  fi
  write_sante "en cours"
}

LAUNCHER_LOG="$LOG_DIR/launcher.log"
UI_LOG="$LOG_DIR/interface.log"
CHAT_LOG="$LOG_DIR/mini-service.log"
GW_LOG="$LOG_DIR/passerelle.log"

# Ports fixes imposés par le client (constantes SERVICE_PORT/FILES_PORT)
CHAT_PORT=3003
FILES_PORT=3004
# Ordre de préférence pour les ports mobiles. (audit 2026-11-21) Sous
# Linux, les ports < 1024 sont PRIVILÉGIÉS : un caddy non root ne peut pas
# les binder (permission denied) et pick_port ne teste que l'occupation —
# le premier lancement échouait donc chez un utilisateur standard au lieu
# de basculer sur 8081. On ne propose 81 qu'à root.
GW_PORTS=(81 8081 8181 18081)
if [ "$(id -u)" -ne 0 ]; then
  GW_PORTS=(8081 8181 18081)
fi
UI_PORTS=(3000 3001 3002 3005)

MAX_RESTARTS=3
URL_DISPLAY=""

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LAUNCHER_LOG"; }
# Journal de mise à jour : actif seulement après une demande venue de
# l'interface (MAJ_ENCOURS posé au ramassage du drapeau) — les démarrages
# ordinaires ne polluent pas le journal.
maj_log() { [ "$MAJ_ENCOURS" = "1" ] || return 0; printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >> "$MAJ_LOG" 2>/dev/null || true; }
die() { maj_log "MAJ ERREUR - $*"; log "ERREUR : $*"; write_sante "echec" "$*"; echo "Hermes Web n'a pas démarré : $*" >&2; exit 1; }

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

# ── BLOC NODE-PORTABLE (loi 8, chantier 6) — extrait tel quel par les épreuves ──
# Node construit l'interface (npm run build). Sur Unix il existe presque
# partout ; s'il est absent, le lanceur possèdera le sien (distribution
# officielle nodejs.org, tarball autonome, DANS le dossier — rien d'autre
# n'est touché). Messages par stderr ; le chemin est rendu sur stdout.
log_node() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LAUNCHER_LOG" >&2; }
ensure_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local portdir="$RUNTIME_DIR/node-portable"
  local portnode="$portdir/bin/node"
  if [ -x "$portnode" ] && "$portnode" --version >/dev/null 2>&1; then printf '%s' "$portnode"; return 0; fi
  if [ -f "$RUNTIME_DIR/portable-node.flag" ] && [ "$(( $(date +%s) - $(date -r "$RUNTIME_DIR/portable-node.flag" +%s 2>/dev/null || echo 0) ))" -lt 3600 ]; then
    log_node "• Node portable : la dernière tentative d'installation a échoué — nouvelle tentative au plus tôt dans 1 h."
    return 1
  fi
  touch "$RUNTIME_DIR/portable-node.flag" 2>/dev/null || true
  local narch
  case "$(uname -m)" in
    aarch64|arm64) narch="linux-arm64" ;;
    *) narch="linux-x64" ;;
  esac
  local url="${HERMES_NODE_URL:-https://nodejs.org/dist/v22.20.0/node-v22.20.0-$narch.tar.xz}"
  local tarball="$RUNTIME_DIR/node-portable.tar.xz"
  log_node "• installation du Node portable de l'application (source officielle nodejs.org, dans le dossier — rien d'autre n'est touché)…"
  if ! curl -fsSL -m 300 -o "$tarball" "$url" 2>/dev/null || [ ! -s "$tarball" ]; then
    log_node "  ATTENTION : téléchargement impossible — installez Node.js ou vérifiez le réseau ; nouvelle tentative au prochain démarrage."
    rm -f "$tarball" 2>/dev/null || true
    return 1
  fi
  mkdir -p "$portdir" 2>/dev/null || true
  if ! tar xJf "$tarball" -C "$portdir" --strip-components=1 2>/dev/null; then
    log_node "  ATTENTION : archive illisible — rien de menteur n'est gardé ; nouvelle tentative au prochain démarrage."
    rm -rf "$portdir" "$tarball" 2>/dev/null || true
    return 1
  fi
  rm -f "$tarball" 2>/dev/null || true
  if [ ! -x "$portnode" ]; then
    # Layout inattendu (préfixe non retiré) : on cherche le binaire réel.
    portnode="$(find "$portdir" -type f -name node -path '*/bin/node' 2>/dev/null | head -1)"
  fi
  if [ -z "$portnode" ] || [ ! -x "$portnode" ] || ! "$portnode" --version >/dev/null 2>&1; then
    log_node "  ATTENTION : Node portable reçu illisible — rien de menteur n'est gardé ; nouvelle tentative au prochain démarrage."
    rm -rf "$portdir" 2>/dev/null || true
    return 1
  fi
  log_node "  Node portable prêt ($("$portnode" --version 2>/dev/null || echo '')) — il vit dans le dossier de l'interface."
  printf '%s' "$portnode"
  return 0
}
# === FIN-BLOC-NODE-PORTABLE ===

# ── Dépendances ──────────────────────────────────────────────────────────
check_deps() {
  command -v bun >/dev/null 2>&1 || die "« bun » est introuvable (https://bun.sh)."
  # Loi 8 (chantier 6) : node du dossier d'abord (posé par le lanceur si
  # absent), système sinon — et le PATH en profite pour npm.
  local portnode
  portnode="$(ensure_node 2>/dev/null || echo '')"
  if [ -n "$portnode" ]; then
    log "• Node du dossier en service ($("$portnode" --version 2>/dev/null || echo '')) — le système n'a plus rien à dire."
    export PATH="$(dirname "$portnode"):$PATH"
  elif ! command -v node >/dev/null 2>&1; then
    die "« node » est introuvable et le Node portable n'a pas pu s'installer — installez Node.js ou vérifiez le réseau, puis relancez."
  fi
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

# §9 (63)/(67) — copie fraîche de l'agent dans le dossier de l'application.
# L'interface installe SA copie de l'agent officiel (NousResearch/hermes-agent,
# surcharge HERMES_AGENT_REPO_URL) dans <racine>/hermes-agent — le dossier que
# le service consulte EN PREMIER. Les installations existantes (dossier frère
# « hermes », ~/.hermes) ne sont JAMAIS lues, déplacées ni modifiées : elles
# vivent leur vie — et depuis (65) elles ne sont même plus un filet : la
# maison est l'UNIQUE emplacement que le service connaît ; si le clone échoue,
# l'interface reste sans agent (état honnête) jusqu'à une installation
# réussie au prochain démarrage.
# Dépendances python (67) : tentées tant que le marqueur agent-deps.ok
# n'existe pas — au plus une fois par heure (flag daté). Avant (67) elles
# n'étaient tentées qu'au moment du clone : un échec silencieux laissait
# l'agent mort pour toujours (« Hermes éteint · vos clés répondent »).
# Idempotent ; clone borné 10 min, dépendances 5 min ; jamais bloquant.
install_agent_fresh() {
  local maison="$ROOT/hermes-agent" flag="$RUNTIME_DIR/agent-install.flag" url
  local depsok="$RUNTIME_DIR/agent-deps.ok" depsflag="$RUNTIME_DIR/agent-deps.flag"
  # Le code de l'agent a-t-il changé depuis les dernières dépendances ?
  # (mise à jour → dépendances et certification refaites, sans attendre la
  # limite d'1 h — ce n'est pas une ré-essai, c'est du neuf.) Vérifié AVANT
  # toute sortie anticipée : c'est exactement ce que (69) avait raté — la
  # vérification vivait APRÈS le « déjà fait, on sort » et ne tournait jamais.
  local househead="" headavant="" agentchange=0
  if [ -e "$maison/.git" ] || [ -f "$maison/gateway/run_api.py" ]; then
    househead="$(git -C "$maison" rev-parse HEAD 2>/dev/null || echo '')"
    if [ -n "$househead" ] && [ -f "$RUNTIME_DIR/agent-deps-head.txt" ]; then
      headavant="$(cat "$RUNTIME_DIR/agent-deps-head.txt" 2>/dev/null || echo '')"
    fi
    if [ -n "$househead" ] && [ -n "$headavant" ] && [ "$househead" != "$headavant" ]; then
      agentchange=1
    fi
  fi
  if [ -e "$maison/.git" ] || [ -f "$maison/gateway/run_api.py" ]; then
    # maison valide : rien SAUF si le code a changé (mise à jour) ou si les
    # dépendances n'ont jamais réussi
    if [ -f "$depsok" ] && [ "$agentchange" = "0" ]; then return 0; fi
    if [ "$agentchange" = "1" ]; then
      log "• le code de l'agent a changé (mise à jour) — dépendances et certification refaites pour la nouvelle version."
      rm -f "$depsok" "$RUNTIME_DIR/agent-certifie.ok" "$depsflag" "$RUNTIME_DIR/agent-certif.flag" 2>/dev/null || true
    fi
  else
    # Installation fraîche : la base des dépendances repart de zéro.
    rm -f "$RUNTIME_DIR/agent-deps-head.txt" 2>/dev/null || true
    if [ -f "$flag" ] && [ "$(( $(date +%s) - $(date -r "$flag" +%s 2>/dev/null || echo 0) ))" -lt 3600 ]; then
      log "• pas d'agent dans le dossier de l'application — installation réessayée au plus tôt dans 1 h (d'ici là, l'interface tourne sans agent)."
      return 0
    fi
    touch "$flag" 2>/dev/null || true
    if [ -d "$maison" ]; then
      log "• hermes-agent existe sans installation valide (clone avorté ?) — nettoyage puis installation fraîche."
      rm -rf "$maison" 2>/dev/null || { log "  ATTENTION : nettoyage impossible — pas d'agent installé ; l'installation retentera au prochain démarrage."; return 0; }
    fi
    url="${HERMES_AGENT_REPO_URL:-https://github.com/NousResearch/hermes-agent}"
    log "• installation d'une copie fraîche de l'agent Hermes dans le dossier de l'application (hermes-agent, source : $url)…"
    if command -v timeout >/dev/null 2>&1; then
      timeout 600 git clone "$url" "$maison" >>"$LAUNCHER_LOG" 2>&1
    else
      git clone "$url" "$maison" >>"$LAUNCHER_LOG" 2>&1
    fi
    if [ -f "$maison/gateway/run_api.py" ]; then
      log "  copie fraîche installée — c'est elle que l'interface allume ; vos installations existantes restent intactes."
      # La copie fraîche a un HEAD : c'est lui la base des dépendances.
      househead="$(git -C "$maison" rev-parse HEAD 2>/dev/null || echo '')"
    else
      log "  ATTENTION : clone échoué — pas d'agent installé : l'installation retentera au prochain démarrage."
      rm -rf "$maison" 2>/dev/null || true
      return 0
    fi
  fi
  # ── Environnement python DÉDIÉ (refonte (69) D1) + dépendances + certification (D2) ──
  # Le python système sert aussi à vos autres installations Hermes : leurs
  # dépendances se marchent dessus (la panne du 23/11). La maison a donc SON
  # python (.venv créé une fois), SES dépendances, et doit PROUVER qu'elle
  # s'allume : allumage d'essai borné (90 s) avec sonde réelle du 9120.
  if [ ! -f "$maison/requirements.txt" ]; then
    [ -f "$depsok" ] || touch "$depsok" 2>/dev/null || true
    return 0
  fi
  local pycmd="" pyver="" venvpy="" depsrecent=0
  if command -v python3 >/dev/null 2>&1; then pycmd="python3"
  elif command -v python >/dev/null 2>&1; then pycmd="python"; fi
  if [ -n "$pycmd" ]; then
    # Le faux raccourci du Microsoft Store répond AUSSI à « python » (cas
    # réel du 23/11) : sa phrase « was not found » disqualifie le candidat.
    pyver="$("$pycmd" --version 2>&1 || echo '')"
    case "$pyver" in *"was not found"*) pycmd="" ;; esac
  fi
  # Loi 8 (plan v2, chantier 5) : aucun vrai python sur le poste → le lanceur
  # possède le sien : le Python portable téléchargé DANS le dossier.
  if [ -z "$pycmd" ]; then pycmd="$(ensure_portable_python 2>/dev/null || echo '')"; fi
  if [ -z "$pycmd" ]; then
    log "• ATTENTION : aucun VRAI python, ni dans le dossier (portable) ni sur ce poste — l'agent ne peut pas démarrer ce tour. Remède : réseau (le Python portable s'installera tout seul au prochain démarrage), ou python.org avec « Add python.exe to PATH » ; si un vrai Python existe déjà, désactivez les alias (Paramètres > Applications > Alias d'exécution d'applications)."
    return 0
  fi
  if [ -f "$depsflag" ] && [ "$(( $(date +%s) - $(date -r "$depsflag" +%s 2>/dev/null || echo 0) ))" -lt 3600 ]; then
    depsrecent=1
  fi
  venvpy="$maison/.venv/bin/python"
  # Le marqueur « venv » sans venv réel ne ment pas deux fois : on repart.
  if [ -f "$depsok" ] && grep -q venv "$depsok" 2>/dev/null && [ ! -x "$venvpy" ]; then
    rm -f "$depsok" 2>/dev/null || true
  fi
  if [ ! -x "$venvpy" ] && [ "$depsrecent" = "0" ]; then
    touch "$depsflag" 2>/dev/null || true
    log "• création de l'environnement python dédié de l'agent (.venv — isolé du python système)…"
    if command -v timeout >/dev/null 2>&1; then
      timeout 120 "$pycmd" -m venv "$maison/.venv" >>"$LAUNCHER_LOG" 2>&1
    else
      "$pycmd" -m venv "$maison/.venv" >>"$LAUNCHER_LOG" 2>&1
    fi && [ -x "$venvpy" ] \
      && log "  environnement dédié prêt — vos autres installations python ne sont pas touchées." \
      || log "  ATTENTION : création de l'environnement dédié impossible (module venv absent ? python3-venv à installer ?) — repli sur le python système."
    [ -x "$venvpy" ] && venvpy="$maison/.venv/bin/python" || venvpy=""
  elif [ ! -x "$venvpy" ]; then
    venvpy=""
  fi
  # Dépendances : dans l'environnement dédié s'il existe, sinon système
  # (repli dit clairement). Marquées « réussies » uniquement sur code 0.
  if [ ! -f "$depsok" ] && [ "$depsrecent" = "0" ]; then
    touch "$depsflag" 2>/dev/null || true
    local piprc=1
    if [ -n "$venvpy" ]; then
      log "• installation des dépendances python de l'agent (environnement dédié, 5 min max)…"
      if command -v timeout >/dev/null 2>&1; then
        timeout 300 "$venvpy" -m pip install -r "$maison/requirements.txt" >>"$LAUNCHER_LOG" 2>&1 && piprc=0
      else
        "$venvpy" -m pip install -r "$maison/requirements.txt" >>"$LAUNCHER_LOG" 2>&1 && piprc=0
      fi
    else
      log "• installation des dépendances python de l'agent (python système — repli, 5 min max)…"
      if command -v timeout >/dev/null 2>&1; then
        if timeout 300 pip3 install -r "$maison/requirements.txt" >>"$LAUNCHER_LOG" 2>&1 \
           || timeout 300 python3 -m pip install -r "$maison/requirements.txt" >>"$LAUNCHER_LOG" 2>&1; then
          piprc=0
        fi
      else
        if pip3 install -r "$maison/requirements.txt" >>"$LAUNCHER_LOG" 2>&1 \
           || python3 -m pip install -r "$maison/requirements.txt" >>"$LAUNCHER_LOG" 2>&1; then
          piprc=0
        fi
      fi
    fi
    if [ "$piprc" = "0" ]; then
      if [ -n "$venvpy" ]; then printf 'venv' > "$depsok" 2>/dev/null || touch "$depsok"
      else printf 'systeme' > "$depsok" 2>/dev/null || touch "$depsok"; fi
      log "  dépendances installées — l'agent peut démarrer."
      # Le HEAD actuel devient la base des dépendances (réussies).
      [ -n "$househead" ] && printf '%s' "$househead" > "$RUNTIME_DIR/agent-deps-head.txt" 2>/dev/null || true
    else
      log "  ATTENTION : dépendances incomplètes — nouvelle tentative au prochain démarrage (au plus tôt dans 1 h)."
      return 0
    fi
  elif [ ! -f "$depsok" ]; then
    log "• dépendances de l'agent : tentative récente — prochaine tentative au plus tôt dans 1 h."
    return 0
  fi
  # ── CERTIFICATION (refonte (69) D2) : la gateway doit PROUVER qu'elle
  # répond — allumage d'essai borné (90 s), sonde réelle du 9120. Port déjà
  # occupé (votre agent en marche ?) → reporté : on ne certifie jamais sur
  # le processus de quelqu'un d'autre.
  local certok="$RUNTIME_DIR/agent-certifie.ok" certflag="$RUNTIME_DIR/agent-certif.flag"
  [ -f "$certok" ] && return 0
  if port_open 9120; then
    log "• certification de l'agent reportée : le port 9120 est déjà occupé (votre Hermes est-il déjà en marche ?) — l'interface l'adoptera tant qu'il vit."
    return 0
  fi
  if [ -f "$certflag" ] && [ "$(( $(date +%s) - $(date -r "$certflag" +%s 2>/dev/null || echo 0) ))" -lt 3600 ]; then
    log "• certification de l'agent : tentative récente — prochaine tentative au plus tôt dans 1 h."
    return 0
  fi
  local certpy="$pycmd" certlog="$ROOT/db/agent-certification.log"
  [ -n "$venvpy" ] && certpy="$venvpy"
  touch "$certflag" 2>/dev/null || true
  mkdir -p "$ROOT/db" 2>/dev/null || true
  log "• certification de l'agent : allumage d'essai (90 s max)…"
  ( cd "$maison" && exec "$certpy" gateway/run_api.py >>"$certlog" 2>&1 ) &
  local trial=$! certup=0 i
  for i in $(seq 1 45); do
    sleep 2
    kill -0 "$trial" 2>/dev/null || break
    if port_open 9120; then certup=1; break; fi
  done
  if [ "$certup" = "1" ]; then
    log "  agent CERTIFIÉ : la gateway a répondu à l'essai — elle saura s'allumer toute seule."
    touch "$certok" 2>/dev/null || true
  else
    log "  ATTENTION : l'essai n'a pas répondu — $(tail -n 5 "$certlog" 2>/dev/null | grep -m 1 . || echo 'aucune sortie lue'). Nouvelle tentative au prochain démarrage (au plus tôt dans 1 h) ; détail : $certlog"
  fi
  # L'essai s'arrête TOUJOURS (notre pid, jamais celui de quelqu'un d'autre).
  kill "$trial" 2>/dev/null || true
  sleep 1
  kill -9 "$trial" 2>/dev/null || true
  return 0
}

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
  sed -e "s|^http://127\.0\.0\.1:81 {|http://127.0.0.1:$port {|" -e "s#localhost:3000#localhost:$(state_get UI_PORT)#" \
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
# Loi jamais bloqué (2026-11-22) : demande au mini-service de clore ses
# tours en vol AVANT l'arrêt — drapeau déposé, le service l'accuse en 500 ms
# (partiels persistés, événement terminal par écran), le lanceur attend
# au plus 8 s. Sans accusé (service déjà muet), on arrête sans attendre plus.
request_chat_drain() {
  [ -n "$(state_get CHAT_PID)" ] || return 0
  [ -f "$DRAIN_FLAG" ] || : > "$DRAIN_FLAG" 2>/dev/null || return 0
  log "• clôture des tours en vol avant l'arrêt (arret-propre.flag)…"
  local i
  for i in 1 2 3 4 5 6 7 8; do
    [ -f "$DRAIN_FLAG" ] || { log "• tours clôturés (le service a accusé)."; return 0; }
    sleep 1
  done
  log "• pas d'accusé en 8 s (service déjà muet ?) — arrêt forcé."
}
do_stop() {
  log "Arrêt demandé…"
  request_chat_drain
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
# Jeton de service (Lot 1, audit L1-1) : généré UNE FOIS puis persisté dans
# desktop/runtime/service-token.env — injecté au mini-service
# (HERMES_SERVICE_TOKEN) et à l'interface (NEXT_PUBLIC_SERVICE_TOKEN, lu par
# Next au build/dev). Sans lui, le service reste protégé par les gardes
# d'origine boucle locale, mais le lanceur ferme la porte à toute page tierce.
SERVICE_TOKEN_FILE="$RUNTIME_DIR/service-token.env"
ensure_service_token() {
  SERVICE_TOKEN="$(grep '^HERMES_SERVICE_TOKEN=' "$SERVICE_TOKEN_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)"
  if [ -z "$SERVICE_TOKEN" ]; then
    SERVICE_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    printf 'HERMES_SERVICE_TOKEN=%s\n' "$SERVICE_TOKEN" > "$SERVICE_TOKEN_FILE"
    log "• jeton de service généré et persisté ($SERVICE_TOKEN_FILE)"
  fi
  export HERMES_SERVICE_TOKEN="$SERVICE_TOKEN"
  export NEXT_PUBLIC_SERVICE_TOKEN="$SERVICE_TOKEN"
  # L'interface embarque le jeton à la BUILD (NEXT_PUBLIC_* inliné) : si le
  # build existant a été fait avec un autre jeton (ou avant ce mécanisme),
  # il doit être reconstruit — sinon l'interface présenterait un jeton refusé.
  if [ -f "$ROOT/.next/standalone/server.js" ]; then
    local built
    built="$(head -1 "$ROOT/.next/service-token" 2>/dev/null || true)"
    if [ "$built" != "$SERVICE_TOKEN" ]; then
      log "• jeton de service changé depuis le dernier build — reconstruction de l'interface…"
      rm -rf "$ROOT/.next"
    fi
  fi
}

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
  ensure_service_token
  check_deps
  # Phase 0 (refonte (68)) : prérequis vérifiés et AFFICHÉS (✓/✗) + écrits
  # dans le manifeste — avant le moindre démarrage de composant.
  phase_prerequis

  # Drapeau resté posé (demande faite sans lanceur vivant) : le démarrage fait
  # de toute façon la mise à jour GitHub — le retirer évite une relance
  # supplémentaire dès le premier cycle de surveillance.
  rm -f "$MAJ_FLAG" 2>/dev/null

  # Mise à jour GitHub (même idiome que le lanceur Windows : fusion rapide
  # ff-only ; en cas d'écart local, version locale conservée sans toucher).
  # (audit 2026-11-21) apres initialisé : sous set -u, un git fetch qui
  # échoue (réseau coupé) laissait apres non définie et la comparaison
  # avala fin « unbound variable » — arrêt brutal, ni marqueur MAJ ni
  # relance de la pile.
  local avant="" apres=""
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
              && { log "  reconstruction terminée."; maj_log "reconstruction terminée"; echo "$SERVICE_TOKEN" > "$ROOT/.next/service-token"; } \
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

  # Installation de l'agent dans le dossier de l'application (§9 (63),
  # décision : « pas de déplacement de mon hermes actuel — l'interface
  # installe une copie fraîche dans son dossier ») : clone officiel dans
  # hermes-agent/, zéro contact avec les installations existantes.
  install_agent_fresh

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
  set_sante_maillon service "répondu"
  start_ui
  set_sante_maillon interface "répondu"
  start_gateway
  set_sante_maillon passerelle "répondu"
  # Chemin COMPLET (refonte (69)) : la vraie liaison que la page utilise —
  # la poignée de main temps réel à travers la passerelle (XTransformPort).
  # Le « OK passerelle » à l'ancienne ne prouvait que la PAGE, pas cette
  # liaison : c'est elle qui disait « Hors ligne » à l'écran (23/11).
  via="$(http_code "http://127.0.0.1:$gw/?EIO=4&transport=polling&XTransformPort=3003" 6)"
  if [ "$via" = "200" ]; then
    set_sante_maillon passerelle "répondue — page ET liaison temps réelle vérifiées"
    log "  OK liaison temps réelle à travers la passerelle vérifiée"
  else
    set_sante_maillon passerelle "page OK mais liaison temps réelle muette (code $via)"
    log "  ATTENTION : liaison temps réelle muette à travers la passerelle (code $via) — l'onglet dirait « Hors ligne »"
  fi
  # Agent : sonde réelle du port 9120 — la vérité du live, écrite telle
  # quelle (branché sur notre agent, sur le vôtre déjà en marche, ou muet).
  if port_open 9120; then set_sante_maillon agent "répond (9120)"; else set_sante_maillon agent "ne répond pas (9120)"; fi
  write_sante "pret"
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
