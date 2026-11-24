#!/usr/bin/env python3
"""Preuve de VERBATIM pour la chirurgie sous-registres de
providers-extensions.ts (vague 7 backend, 2026-11-25).

Chaque plage de lignes déplacée ou conservée depuis l'original (HEAD) doit
apparaître À L'IDENTIQUE (octet par octet) dans le fichier réécrit. Seule
exception assumée (hors plages) : la note d'en-tête (lignes 16-19), mise à
jour pour décrire la nouvelle structure, les doc-comments des sous-registres
et les corps de wrappers. Échoue à la première divergence.
"""
import subprocess
import sys
from pathlib import Path

FIC = "mini-services/hermes-chat/handlers/providers-extensions.ts"

head = subprocess.run(
    ["git", "show", f"HEAD:{FIC}"], capture_output=True, text=True, check=True
).stdout.splitlines(keepends=True)
nouveau = Path(FIC).read_text(encoding="utf-8")
NOUVEAU = "".join(nouveau.splitlines(keepends=True))

def slice_head(debut: int, fin: int) -> str:
    return "".join(head[debut - 1 : fin])

# (nom, debut, fin) — mêmes bornes que extract_sous_registres_providers_extensions.py
PLAGES = [
    ("en-tete-imports", 1, 15, 0),
    ("registres-intacts (session-catalog + attachments-audio)", 20, 109, 0),
    ("catalog (providers:list + providers:catalog)", 114, 123, 0),
    ("mutations (add / remove / set-strategy / set-base)", 125, 274, 0),
    ("keys (add-key / remove-key / test-key)", 277, 377, 0),
    ("find-extension-by-source + doc", 381, 397, 0),
    ("gestion-list (extensions:list)", 400, 402, 0),
    ("import (extensions:add + registry:install)", 405, 573, 0),
    ("gestion-lifecycle (toggle / remove / pin)", 576, 624, 0),
    ("repo (check / update)", 628, 706, 0),
    ("dispatcher", 709, 715, 0),
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
deplacees = 10 + 150 + 101 + 3 + 169 + 49 + 79
if echecs:
    print(f"{echecs} plage(s) en échec")
    sys.exit(1)
print(f"PREUVE OK — {len(PLAGES)} plages ({total} lignes) identiques octet par octet au HEAD, dont {deplacees} déplacées en sous-registres")
