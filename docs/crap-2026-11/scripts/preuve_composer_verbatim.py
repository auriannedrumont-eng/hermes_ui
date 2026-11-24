#!/usr/bin/env python3
"""Preuve de VERBATIM pour la chirurgie Composer (vague 6 UI, 2026-11-25).

Chaque plage de lignes déplacée ou conservée depuis l'original (HEAD) doit
apparaître À L'IDENTIQUE (octet par octet) dans le fichier réécrit. Seules
exceptions assumées (hors plages) : l'import react (types Dispatch /
RefObject / SetStateAction), l'import tokens (type ContextUsage), la note de
découpage, les interfaces props des feuilles et les appels. Échoue à la
première divergence.
"""
import subprocess
import sys
from pathlib import Path

FIC = "src/components/chat/composer.tsx"

head = subprocess.run(
    ["git", "show", f"HEAD:{FIC}"], capture_output=True, text=True, check=True
).stdout.splitlines(keepends=True)
nouveau = Path(FIC).read_text(encoding="utf-8")
NOUVEAU = "".join(nouveau.splitlines(keepends=True))

def slice_head(debut: int, fin: int) -> str:
    return "".join(head[debut - 1 : fin])

# (nom, debut, fin) — mêmes bornes que extract_composer_leaves.py
PLAGES = [
    ("imports-1 (hors import react et type ContextUsage patchés)", 7, 48, 0),
    ("imports-2 (après type ContextUsage ajouté)", 49, 112, 0),
    ("orchestrateur : signature-etats-effets-slash-canSend-contextUsage-submit", 113, 351, 0),
    ("return-div-exterieur-conteneur-drag", 352, 380, 0),
    ("recouvrement", 381, 388, 0),
    ("slash", 390, 393, 0),
    ("puces", 395, 411, 0),
    ("saisie", 413, 549, 0),
    ("barre", 551, 678, 0),
    ("alertes", 681, 722, 0),
    ("pied", 723, 731, 0),
    ("tail-div-fermeture-secondsLabel", 732, 740, 0),
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
if echecs:
    print(f"{echecs} plage(s) en échec")
    sys.exit(1)
print(f"PREUVE OK — {len(PLAGES)} plages ({total} lignes) identiques octet par octet au HEAD")
