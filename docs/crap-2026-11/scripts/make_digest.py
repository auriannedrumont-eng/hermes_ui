"""Digest de lecture : en-tête du fichier + signature + premiers corps de chaque hotspot."""
import json
from pathlib import Path

OUT = Path("docs/crap-2026-11")
hotspots = json.loads((OUT / "hotspots.json").read_text(encoding="utf-8"))
ROOT = Path.cwd()

parts = []
for i, h in enumerate(hotspots, 1):
    f = ROOT / h["file"]
    lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
    header = " | ".join(l.strip() for l in lines[:6] if l.strip().startswith(("//", "*", "/*")))[:180]
    body = "\n".join(lines[h["start"] - 1 : h["start"] + 17])
    parts.append(
        f"### {i:2d}. {h['name']}  CC={h['cc']}  ({h['lines']} lignes, {h['file']}:{h['start']}-{h['end']})\n"
        f"    entête fichier: {header}\n"
        f"```ts\n{body}\n```"
    )

digest = "\n\n".join(parts)
(OUT / "digest-hotspots.txt").write_text(digest, encoding="utf-8")
print(f"digest: {len(parts)} hotspots, {digest.count(chr(10))} lignes")
