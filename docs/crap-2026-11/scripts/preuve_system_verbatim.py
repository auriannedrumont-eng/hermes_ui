#!/usr/bin/env python3
"""Preuve de VERBATIM pour la chirurgie SystemSection (vague 7 UI, 2026-11-24).

Chaque plage de lignes déplacée ou conservée depuis l'original (HEAD) doit
apparaître À L'IDENTIQUE (octet par octet) dans le fichier réécrit. Seules
exceptions assumées (hors plages) : la note de découpage, les interfaces
props des feuilles et les appels. Échoue à la première divergence.
"""
import subprocess
import sys
from pathlib import Path

FIC = "src/components/settings/system-section.tsx"

head = subprocess.run(
    ["git", "show", f"HEAD:{FIC}"], capture_output=True, text=True, check=True
).stdout.splitlines(keepends=True)
nouveau = Path(FIC).read_text(encoding="utf-8")
NOUVEAU = "".join(nouveau.splitlines(keepends=True))

def slice_head(debut: int, fin: int) -> str:
    return "".join(head[debut - 1 : fin])

# (nom, debut, fin) — mêmes bornes que extract_system_leaves.py
PLAGES = [
    ("en-tete-fichier (commentaire, imports, props, JALONS)", 1, 85, 0),
    ("orchestrateur : signature-etat-sonde-effets-memos-ages", 86, 336, 0),
    ("pastille (appTone/appLabel)", 337, 361, 0),
    ("rendu-ouverture (return, section, h1/p, carte 1)", 363, 376, 0),
    ("entete (rangée d'en-tête carte application)", 377, 466, 0),
    ("fil-commentaire", 468, 469, 0),
    ("fil (fil live complet)", 470, 543, 0),
    ("pied (updateError, carte 2, fermetures)", 544, 562, 0),
]

echecs = 0
for nom, debut, fin, retrait in PLAGES:
    bloc = slice_head(debut, fin)
    if retrait:
        bloc = "".join(l[retrait:] if l.startswith(" " * retrait) else l
                       for l in bloc.splitlines(keepends=True))
    if bloc not in NOUVEAU:
        print(f"ÉCHEC : plage {nom} ({debut}-{fin}) absente ou altérée")
        echecs += 1
    else:
        print(f"  OK  {nom} ({debut}-{fin}, {fin - debut + 1} l.)")

total = sum(f - d + 1 for _, d, f, _ in PLAGES)
deplacees = 25 + 90 + 74
if echecs:
    print(f"{echecs} plage(s) en échec")
    sys.exit(1)
print(f"PREUVE OK — {len(PLAGES)} plages ({total} lignes) identiques octet par octet au HEAD, dont {deplacees} déplacées en feuilles")
