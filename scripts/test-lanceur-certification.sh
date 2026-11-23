#!/usr/bin/env bash
# Épreuve comportementale du lanceur Unix (refonte (69) D1+D2) : la chaîne
# complète venv dédié → dépendances → certification avec sonde RÉELLE du
# port 9120 — le succès ET l'échec parlant. Le « python système » est
# simulé (la sonde de port, elle, est la vraie /dev/tcp).
set -u
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
# Aucun reste d'un run précédent ne doit occuper le 9120 (les auditeurs de
# nos essais et le processus étranger du cas C partagent la même signature).
pkill -f "bind..127\.0\.0\.1.,9120" 2>/dev/null || true
sleep 1
# Le VRAI python (résolu AVANT de falsifier le PATH) : l'auditeur de port
# de l'essai et le processe étranger du cas C en ont besoin.
REAL_PY3="$(command -v python3)"
DIR="$(cd "$(dirname "$0")" && pwd)"
sed -n '/── BLOC PORTABLE/,/=== FIN-BLOC-PORTABLE ===/p;/^install_agent_fresh() {/,/^}/p' "$DIR/../desktop/hermes-ui.sh" > "$T/f.sh"
mkdir -p "$T/runtime" "$T/root/db" "$T/root/hermes-agent/.git" "$T/root/hermes-agent/gateway"
echo "fake-requirements" > "$T/root/hermes-agent/requirements.txt"
echo "# stub" > "$T/root/hermes-agent/gateway/run_api.py"

# FAUX python système : crée un venv dont le python obéit à TRIAL_MODE.
cat > "$T/python3" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  cat > "$3/bin/python" <<'PYEOF'
#!/usr/bin/env bash
# ((78)) le venv imite le runtime OFFICIEL : `python -m hermes_cli.main
# gateway run` (cf. desktop/hermes-ui.sh, start_agent_runtime + certification).
if [ "$1" = "-m" ] && [ "$2" = "hermes_cli.main" ]; then
  if [ "${TRIAL_MODE:-listen}" = "die" ]; then
    echo "ModuleNotFoundError: No module named 'fastapi'" >&2
    exit 1
  fi
  exec "${REAL_PY3:-python3}" -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',9120)); s.listen(1); time.sleep(300)"
fi
# ((83)) pip simulé : TRIAL_PIP=1 → échec parlant — le lanceur doit montrer le détail
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  if [ "${TRIAL_PIP:-0}" = "1" ]; then
    echo "ERROR: Could not find a version that satisfies the requirement ruamel.yaml==9.9.9"
    echo "DETAIL-PIP-ECHEC-FACTICE"
    exit 1
  fi
  exit 0
fi
# ((83)) la preuve par import est contrôlée : TRIAL_PROOF=1 → échec
if [ "$1" = "-c" ] && [ "$2" = "import ruamel.yaml" ]; then
  [ "${TRIAL_PROOF:-0}" = "1" ] && exit 1
  exit 0
fi
# ((80)) la génération des dépendances (-c tomllib) passe au VRAI python
if [ "$1" = "-c" ]; then exec "${REAL_PY3:-python3}" "$@"; fi
if [ "$1" = "-m" ]; then exit 0; fi
if [ "${TRIAL_MODE:-listen}" = "die" ]; then
  echo "ModuleNotFoundError: No module named 'fastapi'" >&2
  exit 1
fi
exec "${REAL_PY3:-python3}" -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',9120)); s.listen(1); time.sleep(300)"
PYEOF
  chmod +x "$3/bin/python"
  exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  if [ "${TRIAL_PIP:-0}" = "1" ]; then
    echo "ERROR: Could not find a version that satisfies the requirement ruamel.yaml==9.9.9"
    echo "DETAIL-PIP-ECHEC-FACTICE"
    exit 1
  fi
  exit 0
fi
# ((83)) la preuve par import est contrôlée : TRIAL_PROOF=1 → échec
if [ "$1" = "-c" ] && [ "$2" = "import ruamel.yaml" ]; then
  [ "${TRIAL_PROOF:-0}" = "1" ] && exit 1
  exit 0
fi
# ((80)) la génération des dépendances (-c tomllib) passe au VRAI python
if [ "$1" = "-c" ]; then exec "${REAL_PY3:-python3}" "$@"; fi
exit 0
EOF
chmod +x "$T/python3"
export ROOT="$T/root" RUNTIME_DIR="$T/runtime" LAUNCHER_LOG="$T/launcher.log" REAL_PY3="$REAL_PY3" PATH="$T:$PATH"

# Sonde de port du haut-niveau (les preuves l'utilisent — la même que le lanceur).
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }

HARNESS='log(){ echo "LOG: $*"; }; port_open(){ (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }; die(){ echo "DIE: $*" >&2; exit 1; }; source "$0/f.sh"; install_agent_fresh'

echo "── CAS A : venv → deps → certification RÉUSSIE (sonde réelle 9120) ──"
TRIAL_MODE=listen bash -c "$HARNESS" "$T"
[ -f "$T/runtime/agent-deps.ok" ] && echo "PREUVE : agent-deps.ok = $(cat "$T/runtime/agent-deps.ok")"
if [ -f "$T/runtime/agent-certifie.ok" ]; then echo "PREUVE : agent-certifie.ok présent"; else echo "ECHEC : marqueur de certification absent"; exit 1; fi
sleep 1
if port_open 9120; then echo "ECHEC : l'essai tourne encore — il devait être arrêté"; exit 1; else echo "PREUVE : l'essai est bien arrêté (9120 libre)"; fi

echo "── CAS B : gateway muette → cause parlante, PAS de marqueur ──"
rm -f "$T/runtime/agent-deps.ok" "$T/runtime/agent-certifie.ok" "$T/runtime/agent-certif.flag"
TRIAL_MODE=die bash -c "$HARNESS" "$T" | grep -E "ATTENTION|ModuleNotFound" | head -2
if [ -f "$T/runtime/agent-certifie.ok" ]; then echo "ECHEC : marqueur écrit malgré l'essai muet"; exit 1; fi
echo "PREUVE : certification refusée honnêtement, cause lue dans le journal"

echo "── CAS C : port 9120 déjà occupé (votre agent en marche) → reporté ──"
rm -f "$T/runtime/agent-certifie.ok" "$T/runtime/agent-certif.flag"
"$REAL_PY3" -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',9120)); s.listen(1); time.sleep(60)" &
FOREIGN=$!
sleep 1
TRIAL_MODE=listen bash -c "$HARNESS" "$T" | grep "reportée" | head -1
if [ -f "$T/runtime/agent-certifie.ok" ]; then echo "ECHEC : certification sur le processus de quelqu'un d'autre"; kill -9 $FOREIGN 2>/dev/null; exit 1; fi
kill -9 $FOREIGN 2>/dev/null
echo "PREUVE : port occupé → jamais certifié sur un processus étranger"

echo "── CAS D : faux python du Microsoft Store → ✗ honnête + remède exact ──"
# L'alias Windows répond à « python » mais n'installe rien (cas réel 23/11).
TD="$(mktemp -d)"
sed -n '/^SANTE_FILE=/,/^LAUNCHER_LOG=/p' "$DIR/../desktop/hermes-ui.sh" | sed '$d' > "$TD/sante.sh"
cat > "$TD/python3" <<'EOF'
#!/usr/bin/env bash
echo "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases." >&2
exit 9009
EOF
chmod +x "$TD/python3"
# ((83)) Le poste « sans python » a AUSSI l'alias « python » (les deux
# raccourcis du magasin) — sinon un vrai python d'un venv système traînant
# serait accepté et le cas ne simulerait plus rien.
cp "$TD/python3" "$TD/python"
mkdir -p "$TD/runtime" "$TD/root"
ROOT="$TD/root" RUNTIME_DIR="$TD/runtime" SANTE_FILE="$TD/runtime/sante.json" PATH="$TD:$PATH" \
  HERMES_PYTHON_URL="file:///inexistant-hermes-portable.tar.gz" \
  bash -c 'log(){ echo "$*"; }; write_sante(){ :; }; set_sante_agent(){ :; }; source "$0/sante.sh"; phase_prerequis' "$TD" > "$TD/out.txt" 2>&1
if grep -q "✗ Python" "$TD/out.txt" && grep -q "Alias d'exécution d'applications" "$TD/out.txt"; then
  echo "PREUVE : le faux python est démasqué (✗ + remède exact affiché)"
else
  echo "ECHEC : le faux python n'est pas démasqué — sortie :"; cat "$TD/out.txt"; rm -rf "$TD"; exit 1
fi
# Et le provisionnement refuse de tenter quoi que ce soit avec ce faux python ;
# le portable est tenté (loi 8) mais le réseau simulé refuse → honnête échec.
# ((83)) État propre pour la 2e partie : les CAS A-C laissent agent-deps.ok,
# et l'idempotence ((63)/(80)) de la fonction sortirait EN SILENCE avant
# d'atteindre le provisionnement — le cas D part de « deps jamais réussies ».
rm -f "$T/runtime/agent-deps.ok" "$T/runtime/agent-deps.flag" "$T/runtime/agent-certifie.ok" "$T/runtime/agent-certif.flag" "$T/runtime/agent-deps-head.txt"
export ROOT="$T/root" RUNTIME_DIR="$T/runtime" LAUNCHER_LOG="$T/launcher.log" REAL_PY3="$REAL_PY3"
PATH="$TD:$PATH" HERMES_PYTHON_URL="file:///inexistant-hermes-portable.tar.gz" TRIAL_MODE=listen bash -c "$HARNESS" "$T" 2>&1 | grep -q "aucun VRAI python" \
  && echo "PREUVE : le provisionnement refuse le faux python et donne le remède" \
  || { echo "ECHEC : provisionnement trompé par le faux python"; rm -rf "$TD"; exit 1; }
rm -rf "$TD"

echo "── CAS E : le code de l'agent change (mise à jour) → dépendances et certification refaites ──"
git -C "$T/root/hermes-agent" init -q >/dev/null 2>&1
git -C "$T/root/hermes-agent" add -A >/dev/null 2>&1
git -C "$T/root/hermes-agent" -c user.email=t@t -c user.name=t commit -qm init >/dev/null 2>&1
rm -f "$T/runtime/agent-deps.ok" "$T/runtime/agent-certifie.ok" "$T/runtime/agent-certif.flag" "$T/runtime/agent-deps-head.txt" "$T/runtime/agent-deps.flag"
TRIAL_MODE=listen bash -c "$HARNESS" "$T" >/dev/null 2>&1
[ -f "$T/runtime/agent-certifie.ok" ] || { echo "ECHEC : première installation non certifiée"; exit 1; }
# La « mise à jour » : nouveau commit → nouveau HEAD
echo "# maj" > "$T/root/hermes-agent/CHANGE.txt"
git -C "$T/root/hermes-agent" add CHANGE.txt >/dev/null 2>&1
git -C "$T/root/hermes-agent" -c user.email=t@t -c user.name=t commit -qm maj >/dev/null 2>&1
TRIAL_MODE=listen bash -c "$HARNESS" "$T" 2>&1 | grep -q "le code de l'agent a changé" \
  && echo "PREUVE : mise à jour détectée → dépendances et certification refaites" \
  || { echo "ECHEC : le changement de version est passé inaperçu"; exit 1; }

echo "── CAS F : aucun python du tout → le lanceur installe le Python PORTABLE dans le dossier (loi 8) ──"
# Le « poste » : un faux python du magasin (comme le vrai Windows sans python).
# Le réseau simulé sert un tarball de python portable (URL surchargeable).
TF="$(mktemp -d)"
TFD="$(mktemp -d)"
mkdir -p "$TF/runtime" "$TF/root/db" "$TF/root/hermes-agent/gateway" "$TF/portable-src/python/bin"
echo "fake-requirements" > "$TF/root/hermes-agent/requirements.txt"
echo "# stub" > "$TF/root/hermes-agent/gateway/run_api.py"
cp "$T/python3" "$TF/portable-src/python/bin/python3"
tar czf "$TF/portable.tar.gz" -C "$TF/portable-src" python
cat > "$TFD/python3" <<'EOF'
#!/usr/bin/env bash
echo "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases." >&2
exit 9009
EOF
chmod +x "$TFD/python3"
export ROOT="$TF/root" RUNTIME_DIR="$TF/runtime" LAUNCHER_LOG="$TF/launcher.log" REAL_PY3="$REAL_PY3"
PATH="$TFD:$PATH" HERMES_PYTHON_URL="file://$TF/portable.tar.gz" TRIAL_MODE=listen bash -c "$HARNESS" "$T" 2>&1 | grep -q "CERTIFIÉ" \
  && echo "PREUVE : le lanceur a posé son propre python dans le dossier et l'agent est certifié avec lui" \
  || { echo "ECHEC : le portable n'a pas pris le relais"; rm -rf "$TF" "$TFD"; exit 1; }
[ -x "$TF/runtime/python-portable/python/bin/python3" ] \
  && echo "PREUVE : le Python portable vit dans le dossier de l'interface (runtime/python-portable)" \
  || { echo "ECHEC : pas de portable dans le dossier"; rm -rf "$TF" "$TFD"; exit 1; }
[ "$(cat "$TF/runtime/agent-deps.ok" 2>/dev/null)" = "venv" ] \
  && echo "PREUVE : dépendances posées via le portable (environnement dédié créé par lui)" \
  || { echo "ECHEC : dépendances non marquées"; rm -rf "$TF" "$TFD"; exit 1; }
rm -rf "$TF" "$TFD"

echo "── CAS G : node absent → le lanceur installe le Node PORTABLE dans le dossier (loi 8) ──"
TG="$(mktemp -d)"
mkdir -p "$TG/runtime" "$TG/node-src/node-v22.20.0-linux-x64/bin" "$TG/fakebin"
printf '#!/usr/bin/env bash\necho "v22.20.0"\nexit 0\n' > "$TG/node-src/node-v22.20.0-linux-x64/bin/node"
chmod +x "$TG/node-src/node-v22.20.0-linux-x64/bin/node"
tar cJf "$TG/node.tar.xz" -C "$TG/node-src" node-v22.20.0-linux-x64/bin
# Un « poste » sans node : un PATH minimal (bash, tar, curl, tee… mais PAS node).
# xz est requis par tar pour décompresser le .tar.xz — présent sur tout Unix.
for t in bash sh tar chmod date tee uname curl mkdir rm grep head cat xz; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$TG/fakebin/$t"
done
sed -n '/── BLOC NODE-PORTABLE/,/=== FIN-BLOC-NODE-PORTABLE ===/p' "$DIR/../desktop/hermes-ui.sh" > "$TG/n.sh"
RUNTIME_DIR="$TG/runtime" LAUNCHER_LOG="$TG/l.log" HERMES_NODE_URL="file://$TG/node.tar.xz" \
  PATH="$TG/fakebin" bash -c 'source "$0/n.sh"; r="$(ensure_node)"; if [ -x "$r" ]; then "$r" --version | grep -q v22 && echo "PREUVE : Node portable installé dans le dossier et utilisable"; else echo "ECHEC : pas de node portable"; exit 1; fi' "$TG" \
  || { echo "ECHEC : CAS G"; rm -rf "$TG"; exit 1; }
[ -x "$TG/runtime/node-portable/bin/node" ] \
  && echo "PREUVE : le Node portable vit dans le dossier de l'interface (runtime/node-portable)" \
  || { echo "ECHEC : pas de portable dans le dossier"; rm -rf "$TG"; exit 1; }
rm -rf "$TG"

echo "── CAS H : deps extraites du pyproject du dépôt ((80) — jamais une liste en dur) ──"
# Le dépôt amont n'a PAS de requirements.txt : ses vraies dépendances
# vivent dans pyproject.toml ([project].dependencies avec marqueurs).
# Le lanceur doit les extraire (tomllib) dans runtime/ et les installer.
TH="$(mktemp -d)"
mkdir -p "$TH/runtime" "$TH/root/db" "$TH/root/hermes-agent/gateway" "$TH/root/hermes-agent/.venv/bin"
echo "# stub" > "$TH/root/hermes-agent/gateway/run_api.py"
cat > "$TH/root/hermes-agent/pyproject.toml" <<'EOF'
[project]
name = "fake-agent"
version = "0.0.0"
dependencies = [
  "depa==1.0.0; python_version >= '3.14'",
  "depb==2.0.0",
]
EOF
# venv fake (comme le CAS A) : -c passe au vrai python (tomllib), -m pip → OK.
cat > "$TH/root/hermes-agent/.venv/bin/python" <<'EOF'
#!/usr/bin/env bash
# ((83)) la preuve par import est contrôlée : TRIAL_PROOF=1 → échec
if [ "$1" = "-c" ] && [ "$2" = "import ruamel.yaml" ]; then
  [ "${TRIAL_PROOF:-0}" = "1" ] && exit 1
  exit 0
fi
if [ "$1" = "-c" ]; then exec "${REAL_PY3:-python3}" "$@"; fi
if [ "$1" = "-m" ] && [ "$2" = "hermes_cli.main" ]; then
  exec "${REAL_PY3:-python3}" -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',9120)); s.listen(1); time.sleep(300)"
fi
if [ "$1" = "-m" ]; then exit 0; fi
exec "${REAL_PY3:-python3}" -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',9120)); s.listen(1); time.sleep(300)"
EOF
chmod +x "$TH/root/hermes-agent/.venv/bin/python"
cp "$T/python3" "$TH/python3"
export ROOT="$TH/root" RUNTIME_DIR="$TH/runtime" LAUNCHER_LOG="$TH/launcher.log" PATH="$TH:$PATH"
# $0 reste "$T" : c'est là que vit f.sh ; les chemins réels passent par les variables.
TRIAL_MODE=listen bash -c "$HARNESS" "$T" >/dev/null 2>&1
if grep -q "depa==1.0.0" "$TH/runtime/agent-requirements.txt" 2>/dev/null \
   && grep -q "depb==2.0.0" "$TH/runtime/agent-requirements.txt" 2>/dev/null; then
  echo "PREUVE : requirements générés depuis le pyproject du dépôt, marqueurs conservés"
else
  echo "ECHEC : la génération depuis pyproject.toml n'a pas produit runtime/agent-requirements.txt"
  echo "── launcher.log (fin) :"; tail -5 "$TH/launcher.log" 2>/dev/null; rm -rf "$TH"; exit 1
fi
[ -f "$TH/runtime/agent-deps.ok" ] \
  && echo "PREUVE : dépendances extraites installées (agent-deps.ok = $(cat "$TH/runtime/agent-deps.ok"))" \
  || { echo "ECHEC : deps non marquées après génération"; rm -rf "$TH"; exit 1; }
rm -rf "$TH"

echo "── CAS I : échec pip → détail affiché, AUCUN verrou, la relance retente ((83)) ──"
# Cas réel du 23/11 : deux relances rapprochées, toujours 'ruamel' —
# l'ancien verrou « au plus tôt dans 1 h » sautait chaque nouvelle
# tentative, et le détail de l'échec pip était jeté.
# ((83)) Rétablir les exports (le CAS H les a écrasés vers son $TH supprimé).
export ROOT="$T/root" RUNTIME_DIR="$T/runtime" LAUNCHER_LOG="$T/launcher.log" REAL_PY3="$REAL_PY3" PATH="$T:$PATH"
rm -f "$T/runtime/agent-deps.ok" "$T/runtime/agent-certifie.ok" "$T/runtime/agent-certif.flag" "$T/runtime/agent-deps.flag" "$T/runtime/agent-deps-head.txt"
TRIAL_PIP=1 TRIAL_MODE=listen bash -c "$HARNESS" "$T" | grep -q "DETAIL-PIP-ECHEC-FACTICE" \
  && echo "PREUVE : le détail de l'échec pip est affiché à l'écran" \
  || { echo "ECHEC : l'échec pip est muet (détail jeté)"; exit 1; }
[ -f "$T/runtime/agent-deps.flag" ] \
  && { echo "ECHEC : verrou présent après échec — la relance serait sautée"; exit 1; } \
  || echo "PREUVE : aucun verrou après échec"
TRIAL_MODE=listen bash -c "$HARNESS" "$T" >/dev/null 2>&1
[ -f "$T/runtime/agent-deps.ok" ] \
  && echo "PREUVE : la relance immédiate a retenté et réussi (deps.ok écrit)" \
  || { echo "ECHEC : la relance n'a pas retenté (verrou fantôme ?)"; exit 1; }
sleep 1
pkill -f "bind..127\.0\.0\.1.,9120" 2>/dev/null || true

echo "── CAS J : pip dit ok mais l'import échoue → PAS de marqueur ((83)) ──"
rm -f "$T/runtime/agent-deps.ok" "$T/runtime/agent-certifie.ok" "$T/runtime/agent-certif.flag" "$T/runtime/agent-deps.flag" "$T/runtime/agent-deps-head.txt"
TRIAL_PROOF=1 TRIAL_MODE=listen bash -c "$HARNESS" "$T" | grep -q "l'import de ruamel.yaml échoue" \
  && echo "PREUVE : la preuve par import est exigée et parlante" \
  || { echo "ECHEC : la preuve par import n'est pas exigée"; exit 1; }
[ -f "$T/runtime/agent-deps.ok" ] \
  && { echo "ECHEC : deps.ok écrit sans preuve d'import"; exit 1; } \
  || echo "PREUVE : aucun marqueur sans la preuve"
sleep 1
pkill -f "bind..127\.0\.0\.1.,9120" 2>/dev/null || true

echo ""
echo "Épreuve lanceur refonte (69+70+(71)+72+(80)+(83)) : succès"
