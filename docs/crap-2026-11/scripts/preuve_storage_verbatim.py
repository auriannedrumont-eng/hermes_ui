#!/usr/bin/env python3
"""Preuve de VERBATIM pour la chirurgie StorageSection (vague 7 UI, 2026-11-24).

Chaque plage de lignes déplacée ou conservée depuis l'original (HEAD) doit
apparaître À L'IDENTIQUE (octet par octet) dans le fichier réécrit. Seules
exceptions assumées (hors plages) : l'import react (types Dispatch /
RefObject / SetStateAction), la note de découpage, les interfaces props des
feuilles et les appels. Échoue à la première divergence.
"""
import subprocess
import sys
from pathlib import Path

FIC = "src/components/settings/storage-section.tsx"

head = subprocess.run(
    ["git", "show", f"HEAD:{FIC}"], capture_output=True, text=True, check=True
).stdout.splitlines(keepends=True)
nouveau = Path(FIC).read_text(encoding="utf-8")
NOUVEAU = "".join(nouveau.splitlines(keepends=True))

def slice_head(debut: int, fin: int) -> str:
    return "".join(head[debut - 1 : fin])

# (nom, debut, fin) — mêmes bornes que extract_storage_leaves.py
PLAGES = [
    ("en-tete-commentaires", 1, 14, 0),
    ("imports-hors-react-patche", 16, 161, 0),
    ("orchestrateur : signature-etat-effets-memos-mutations", 162, 466, 0),
    ("compteurs", 467, 492, 0),
    ("explorateur-commentaire-conteneur", 494, 495, 0),
    ("barre", 496, 561, 0),
    ("bandeau", 563, 595, 0),
    ("corps-parent (squelette/erreur/ouvre-groupes)", 597, 621, 0),
    ("groupe (dérivation + section)", 623, 759, 0),
    ("inventaire-vide", 761, 770, 0),
    ("explorateur-fermeture", 771, 772, 0),
    ("toasts", 773, 804, 0),
    ("pied (fermetures)", 805, 807, 0),
]

IMPORT_ATTENDU = (
    'import {\n'
    '  useCallback,\n'
    '  useEffect,\n'
    '  useMemo,\n'
    '  useRef,\n'
    '  useState,\n'
    '  type Dispatch,\n'
    '  type RefObject,\n'
    '  type SetStateAction,\n'
    '} from "react";\n'
)

echecs = 0
if IMPORT_ATTENDU not in NOUVEAU:
    print("ÉCHEC : l'import react patché (Dispatch/RefObject/SetStateAction) est absent")
    echecs += 1
else:
    print("  OK  import react patché (seule ligne de l'en-tête modifiée)")
if 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";' in NOUVEAU:
    print("ÉCHEC : l'ancien import react one-line subsiste")
    echecs += 1

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
deplacees = 26 + 66 + 33 + 137 + 32
if echecs:
    print(f"{echecs} plage(s) en échec")
    sys.exit(1)
print(f"PREUVE OK — {len(PLAGES)} plages ({total} lignes) identiques octet par octet au HEAD, dont {deplacees} déplacées en feuilles")
