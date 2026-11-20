"""Contrôle des pages rendues : ratio d'encre (détection pages vides / couverture sombre)
+ répartition du texte par page (pdftotext)."""
import subprocess
from PIL import Image

import glob

pages = sorted(glob.glob("/tmp/render/page-*.jpg"))
print("Page | dimensions | encre (non-blanc)")
for pg in pages:
    im = Image.open(pg).convert("L")
    h = im.histogram()
    ratio = 1 - h[255] / sum(h)
    flag = ""
    if ratio < 0.005:
        flag = "  <-- QUASI VIDE"
    if ratio > 0.6:
        flag = "  <-- fond sombre (couverture attendue)"
    print(f"{pg.split('/')[-1]} | {im.size} | {ratio:.3f}{flag}")

print()
print("=== Premières lignes de chaque page (pdftotext) ===")
n = len(pages)
for i in range(1, n + 1):
    txt = subprocess.run(
        ["pdftotext", "-f", str(i), "-l", str(i), "-layout",
         "/home/z/my-project/download/hermes-specification-systeme-stockage.pdf", "-"],
        capture_output=True, text=True).stdout
    lines = [l.strip() for l in txt.splitlines() if l.strip()][:3]
    print(f"— page {i:02d} : " + " ⟂ ".join(lines))
