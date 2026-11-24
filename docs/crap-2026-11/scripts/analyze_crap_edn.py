"""Analyse autoritative du rapport CRAP de hermes_ui, à partir de .metrics/crap.edn."""
import json
import re
from collections import Counter
from pathlib import Path

EDN = Path("/home/z/my-project/repos/hermes_ui/.metrics/crap.edn")
OUT = Path("/home/z/my-project/download/hermes_ui_crap")
OUT.mkdir(parents=True, exist_ok=True)

entry_re = re.compile(
    r'\{:name "([^"]+)", :namespace "([^"]+)", :complexity (\d+), '
    r':coverage (nil|[\d.]+), :crap (nil|[\d.]+)\}'
)
rows = []
for name, ns, cc, cov, crap in entry_re.findall(EDN.read_text(encoding="utf-8")):
    rows.append({
        "name": name,
        "ns": ns,
        "cc": int(cc),
        "cov": None if cov == "nil" else float(cov),
        "crap": None if crap == "nil" else float(crap),
    })

print(f"entrées analysées : {len(rows)}")

def zone(ns: str) -> str:
    if ns.startswith("mini-services"):
        return "mini-services/hermes-chat (backend socket.io)"
    if ns.startswith("scripts"):
        return "scripts/ (harnais de tests, compté comme source)"
    first = ns.split(".")[0]
    if first in {"hooks", "components", "app", "lib", "shared"}:
        return "src/ (frontend Next.js)"
    if ns.startswith("examples"):
        return "examples/"
    return "racine/public (sw.js…)"

py_ns = {"scripts.make-pwa-icons", "scripts.split-turn-runner", "scripts.split-handlers"}
n_py = sum(1 for r in rows if r["ns"] in py_ns)
print(f"langages : typescript={len(rows) - n_py}, python={n_py}")

print("\nrépartition par zone :")
for z, c in Counter(zone(r["ns"]) for r in rows).most_common():
    print(f"  {c:5d}  {z}")

def band(crap):
    if crap <= 5:
        return "1-5  (risque faible)"
    if crap <= 30:
        return "5-30 (à surveiller)"
    return ">30  (complexe et sous-testé)"

print("\ndistribution CRAP :")
for b, c in Counter(band(r["crap"]) for r in rows).most_common():
    print(f"  {c:5d}  ({100 * c / len(rows):4.1f} %)  {b}")

cov_pos = [r for r in rows if (r["cov"] or 0) > 0]
print(f"\nentrées avec couverture > 0 : {len(cov_pos)}")

def top(subset, n=20, titre=""):
    print(f"\n{titre} :")
    for r in sorted(subset, key=lambda x: -x["crap"])[:n]:
        print(f"  CC={r['cc']:4d}  crap={r['crap']:>10.1f}  {r['name']}  [{r['ns']}]")

top(rows, titre="TOP 20 pires CRAP (repo entier)")
prod = [r for r in rows if not r["ns"].startswith("scripts")]
top(prod, titre=f"TOP 20 pires CRAP (code production seulement, n={len(prod)})")

hot = [r for r in prod if r["cc"] >= 30]
print(f"\nfonctions de production avec CC >= 30 : {len(hot)}")
print("\nfichiers production avec le plus de fonctions CC>=30 :")
for ns, c in Counter(r["ns"] for r in hot).most_common(10):
    print(f"  {c:3d}  {ns}")

# taille des pires fonctions en lignes (approx via fichiers source)
src = Path("/home/z/my-project/repos/hermes_ui")
def ns_to_file(ns):
    p = ns.replace(".", "/")
    for ext in (".ts", ".tsx", ".js", ".py"):
        for cand in (src / (p + ext), src / (p.replace("/hermes-chat/", "/hermes-chat/"))):
            if cand.is_file():
                return cand
    return None

big = [r for r in sorted(rows, key=lambda x: -x["cc"])[:5]]
print("\nles 5 fonctions les plus complexes (CC) avec taille du fichier :")
for r in big:
    p = ns_to_file(r["ns"])
    n = sum(1 for _ in p.open(encoding="utf-8", errors="replace")) if p else "?"
    print(f"  CC={r['cc']:4d}  {r['name']}  [{r['ns']}]  fichier={n} lignes")

# ── artefacts ──────────────────────────────────────────────────────────────
(OUT / "crap.edn").write_text(EDN.read_text(encoding="utf-8"), encoding="utf-8")
raw = Path("/tmp/crapper-stdout.txt").read_text(encoding="utf-8")
m = re.search(r"CRAP Report\n=+\n.*", raw, re.S)
(OUT / "table-crap.txt").write_text(
    "CRAP Report (crapper — unclebob) — hermes_ui\n"
    "Formule : CRAP = CC² × (1 − couverture)³ + CC\n"
    "Couverture TypeScript : 0 % enregistrée — la suite de tests tourne sous bun\n"
    "(JavaScriptCore), invisible pour c8 (instrumentation V8). Les scores CRAP\n"
    "reflètent donc CC² + CC ; la colonne CC reste le classement de complexité fiable.\n"
    + "=" * 100 + "\n" + m.group(0),
    encoding="utf-8",
)
Path("/home/z/my-project/download/hermes_ui_crap/suite-tests.log").write_text(raw, encoding="utf-8")
print(f"\nartefacts écrits dans {OUT}")
