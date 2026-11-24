"""Extrait les 45 fonctions de production CC>=30 avec spans et statistiques de décisions.

Utilise le parseur tree-sitter de crapper lui-même (venv crapper).
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, "/home/z/my-project/crapper/src")
from crapper.languages.typescript import functions_in_source  # noqa: E402

ROOT = Path("/home/z/my-project/repos/hermes_ui")
OUT = Path("/home/z/my-project/download/hermes_ui_crap")

# ns → chemin : le namespace de crapper = chemin relatif sans "src/", points au lieu de /
def ns_to_path(ns: str):
    base = ns.replace(".", "/")
    for prefix in ("src/", ""):
        for ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
            cand = ROOT / (prefix + base + ext)
            if cand.is_file():
                return cand
    return None

# fichiers candidats : tout le code production (hors scripts/, .next/,
# node_modules — les chunks de build de Next polluaient l'extraction du
# 2026-11-25 : _parse/constructor/decl de bundles node_modules en CC 30-82)
files = [
    p for p in ROOT.rglob("*")
    if p.is_file() and p.suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
    and "node_modules" not in p.parts and "target" not in p.parts
    and ".next" not in p.parts
    and not p.name.endswith(".d.ts")
    and not p.match("scripts/*")
]

DECISIONS = {
    "if": re.compile(r"\bif\s*\("),
    "else if": re.compile(r"\belse\s+if\b"),
    "for/while": re.compile(r"\b(for|while)\s*\("),
    "catch": re.compile(r"\bcatch\b"),
    "ternaire": re.compile(r"\?[^.?:\n]"),
    "&&": re.compile(r"&&"),
    "||": re.compile(r"\|\|"),
    "??": re.compile(r"\?\?"),
    "?.": re.compile(r"\?\."),
    "case": re.compile(r"\bcase\b"),
}

hotspots = []
for f in sorted(files):
    src = f.read_text(encoding="utf-8", errors="replace")
    try:
        funcs = functions_in_source(src, str(f), str(ROOT))
    except Exception as exc:  # noqa: BLE001
        print(f"parse {f}: {exc}", file=sys.stderr)
        continue
    lines = src.splitlines()
    for fn in funcs:
        if fn.complexity >= 30:
            span = "\n".join(lines[fn.start_line - 1 : fn.end_line])
            counts = {k: len(rx.findall(span)) for k, rx in DECISIONS.items()}
            hotspots.append({
                "name": fn.name,
                "ns": fn.namespace,
                "cc": fn.complexity,
                "start": fn.start_line,
                "end": fn.end_line,
                "lines": fn.end_line - fn.start_line + 1,
                "file": str(f.relative_to(ROOT)),
                "decisions": counts,
            })

hotspots.sort(key=lambda h: -h["cc"])
print(f"hotspots CC>=30 (production) : {len(hotspots)}")

# répartition backend / frontend
back = [h for h in hotspots if h["ns"].startswith("mini-services")]
front = [h for h in hotspots if not h["ns"].startswith("mini-services")]
print(f"backend mini-services : {len(back)}   frontend/src : {len(front)}")

(OUT / "hotspots.json").write_text(json.dumps(hotspots, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"écrit {OUT / 'hotspots.json'}")
for h in hotspots:
    d = h["decisions"]
    top3 = ", ".join(f"{k}:{v}" for k, v in sorted(d.items(), key=lambda x: -x[1])[:4])
    print(f"  CC={h['cc']:4d} {h['lines']:5d}l  {h['name']}  [{h['file']}:{h['start']}]  {top3}")
