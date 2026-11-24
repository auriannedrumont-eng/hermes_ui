#!/usr/bin/env python3
"""Preuve de VERBATIM pour la chirurgie Sidebar (vague 5, 2026-11-25).

Chaque plage de lignes déplacée depuis l'original (HEAD) doit apparaître
À L'IDENTIQUE (octet par octet, indentation conservée ou dédentée de n
espaces exactement) dans le fichier réécrit. Échoue à la première divergence.
"""
import subprocess
import sys
from pathlib import Path

FIC = "src/components/chat/sidebar.tsx"

head = subprocess.run(
    ["git", "show", f"HEAD:{FIC}"], capture_output=True, text=True, check=True
).stdout.splitlines(keepends=True)
nouveau = Path(FIC).read_text(encoding="utf-8")
NOUVEAU = "".join(nouveau.splitlines(keepends=True))

def slice_head(debut: int, fin: int) -> str:
    return "".join(head[debut - 1 : fin])

def dedent(text: str, n: int) -> str:
    out = []
    for l in text.splitlines(keepends=True):
        out.append(l[n:] if l.startswith(" " * n) else l)
    return "".join(out)

# (nom, debut, fin, dédent) — mêmes bornes que extract_sidebar_leaves.py
PLAGES = [
    ("imports-types-props-const", 10, 113, 0),
    ("signature-etats-effets-sensors", 115, 219, 0),
    ("effet-recherche-bySort-convsByProject-unprojected", 221, 273, 0),
    ("searchGroups", 280, 297, 0),
    ("commentaire-arbre-filtre", 299, 302, 0),
    ("corps-computeSearchTree", 305, 332, 2),
    ("dateGroups-pinned-shared", 335, 362, 0),
    ("actions-dossiers-memos-subControls", 364, 440, 0),
    ("handleDragStart", 442, 453, 0),
    ("handleDragEnd-tete", 455, 469, 0),
    ("commentaire-reordonnancement", 471, 474, 0),
    ("reorderSegment", 483, 491, 6),
    ("roots-childrenOrder-flat", 492, 511, 6),
    ("itemProps", 516, 526, 0),
    ("return-racine-marque-recherche-dnd-nav", 528, 571, 0),
    ("branche-recherche", 573, 689, 0),
    ("branche-dossiers", 691, 826, 0),
    ("branche-sans-dossier", 832, 877, 0),
    ("nav-close-dragoverlay-commentaire-carte", 879, 899, 0),
    ("carte-statut", 900, 967, 0),
    ("dialogues", 969, 1017, 0),
    ("pied-parent", 1018, 1020, 0),
    ("foldAccents", 275, 278, 2),
]

echecs = 0
for nom, debut, fin, retrait in PLAGES:
    bloc = slice_head(debut, fin)
    if retrait:
        bloc = dedent(bloc, retrait)
    if bloc not in NOUVEAU:
        print(f"ÉCHEC : plage {nom} ({debut}-{fin}) absente ou altérée")
        echecs += 1
    else:
        print(f"  OK  {nom} ({debut}-{fin}, {fin - debut + 1} l.)")

total = sum(f - d + 1 for _, d, f, _ in PLAGES)
if echecs:
    print(f"{echecs} plage(s) en échec")
    sys.exit(1)
print(f"PREUVE OK — {len(PLAGES)} plages ({total} lignes) identiques octet par octet au HEAD")
