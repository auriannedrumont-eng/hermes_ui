"""Analyse du rapport CRAP produit par crapper sur hermes_ui."""
import re
from collections import Counter
from pathlib import Path

RAW = Path("/tmp/crapper-stdout.txt")
OUT = Path("docs/crap-2026-11")
OUT.mkdir(parents=True, exist_ok=True)

text = RAW.read_text(encoding="utf-8")

# ── extraire la table ──────────────────────────────────────────────────────
m = re.search(r"CRAP Report\n=+\n(.*)$", text, re.S)
table = m.group(1) if m else ""
hdr = re.search(r"Function\s+Namespace\s+CC\s+Cov%\s+CRAP\n-+\n", table)
rows = []
pattern = re.compile(r"^(.*?)\s{2,}(\S.*?)\s{2,}(\d+)\s+(\d+\.\d)%\s+(\d+\.\d)\s*$")
body = table[hdr.end():] if hdr else table
for line in body.splitlines():
    line = line.rstrip()
    if not line or line.startswith("Languages:") or line.startswith("Wrote"):
        continue
    mm = pattern.match(line)
    if mm:
        rows.append({
            "name": mm.group(1).strip(),
            "ns": mm.group(2).strip(),
            "cc": int(mm.group(3)),
            "cov": float(mm.group(4)),
            "crap": float(mm.group(5)),
        })

print(f"entrées analysées : {len(rows)}")

def zone(ns: str) -> str:
    if ns.startswith("mini-services"):
        return "mini-services (backend socket.io)"
    if ns.startswith("scripts"):
        return "scripts/ (harnais de tests, compté comme source)"
    if ns.split(".")[0] in {"hooks", "components", "app", "lib", "shared"}:
        return "src/ (frontend Next.js)"
    if ns.startswith("examples"):
        return "examples/"
    return "racine/public"

py_names = {"scripts.make-pwa-icons", "scripts.split-turn-runner", "scripts.split-handlers"}
n_py = sum(1 for r in rows if r["ns"] in py_names)
n_ts = len(rows) - n_py
print(f"langages : typescript={n_ts}, python={n_py}")

zones = Counter(zone(r["ns"]) for r in rows)
print("\nrépartition par zone :")
for z, c in zones.most_common():
    print(f"  {c:5d}  {z}")

bands = {
    "1-5   (risque faible)": 0,
    "5-30  (à surveiller)": 0,
    ">30   (complexe et sous-testé)": 0,
}
for r in rows:
    if r["crap"] <= 5:
        bands["1-5   (risque faible)"] += 1
    elif r["crap"] <= 30:
        bands["5-30  (à surveiller)"] += 1
    else:
        bands[">30   (complexe et sous-testé)"] += 1
print("\ndistribution CRAP :")
for b, c in bands.items():
    print(f"  {c:5d}  ({100 * c / len(rows):4.1f} %)  {b}")

cov_nonzero = [r for r in rows if r["cov"] > 0]
print(f"\nentrées avec couverture > 0 : {len(cov_nonzero)}")

print("\nTOP 20 pires CRAP (repo entier) :")
for r in sorted(rows, key=lambda x: -x["crap"])[:20]:
    print(f"  CC={r['cc']:4d}  crap={r['crap']:>10.1f}  {r['name']}  [{r['ns']}]")

prod = [r for r in rows if not r["ns"].startswith("scripts")]
print(f"\nTOP 20 pires CRAP (code production seulement, n={len(prod)}) :")
for r in sorted(prod, key=lambda x: -x["crap"])[:20]:
    print(f"  CC={r['cc']:4d}  crap={r['crap']:>10.1f}  {r['name']}  [{r['ns']}]")

hot = [r for r in prod if r["cc"] >= 30]
print(f"\nfonctions de production avec CC >= 30 : {len(hot)}")
per_file = Counter(r["ns"] for r in hot)
print("\nfichiers production avec le plus de fonctions CC>=30 :")
for ns, c in per_file.most_common(10):
    print(f"  {c:3d}  {ns}")

# ── artefacts ──────────────────────────────────────────────────────────────
(OUT / "rapport-crap-complet.txt").write_text(text, encoding="utf-8")
edn = Path(".metrics/crap.edn")
if edn.is_file():
    (OUT / "crap.edn").write_text(edn.read_text(encoding="utf-8"), encoding="utf-8")
(OUT / "table-crap.txt").write_text(
    "CRAP Report (crapper — unclebob) — hermes_ui\n"
    "CRAP = CC^2 x (1 - couverture)^3 + CC   |   couverture : Vitest sur mini-services/hermes-chat (Store jetable), 0% ailleurs\n"
    + "=" * 100 + "\n" + table,
    encoding="utf-8",
)
print(f"\nartefacts écrits dans {OUT}")
