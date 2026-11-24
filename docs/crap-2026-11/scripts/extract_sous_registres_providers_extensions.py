#!/usr/bin/env python3
"""Vague 7 (suite backend), 2026-11-25 — providers-extensions.ts : les deux
registres monolithiques démontés en sous-registres thématiques (motif des
vagues 1-3, même discipline que les feuilles UI : coupes ANCRÉES, corps
déplacés VERBATIM, seules les accolades d'encadrement changent).

registerProvidersHandlers (CC 96, 9 socket.on) → 3 sous-registres :
  registerProvidersCatalogHandlers   — providers:list + providers:catalog ;
  registerProvidersMutationsHandlers — providers:add / remove / set-strategy
                                       / set-base ;
  registerProvidersKeysHandlers      — providers:add-key / remove-key /
                                       providers:test-key.

registerExtensionsHandlers (CC 94, 8 socket.on) → 3 sous-registres :
  registerExtensionsGestionHandlers  — extensions:list / toggle / remove /
                                       extensions:pin ;
  registerExtensionsImportHandlers   — extensions:add + registry:install
                                       (l'ajout unifié v2.6) ;
  registerExtensionsRepoHandlers     — extensions:check + extensions:update
                                       (diff et suivi via l'API GitHub).

Les wrappers gardent leurs noms (l'appel du dispatcher et l'ordre d'origine
sont inchangés) ; chaque sous-registre est appelé dans l'ordre d'origine du
fichier (par sa première ligne). Aucune ligne de corps de handler modifiée.
"""
import sys
from pathlib import Path

FIC = Path("mini-services/hermes-chat/handlers/providers-extensions.ts")

lignes = FIC.read_text(encoding="utf-8").splitlines(keepends=True)

def morceau(debut: int, fin: int) -> list[str]:
    """Extrait les lignes [debut, fin] (1-indexé inclusif)."""
    return lignes[debut - 1 : fin]

def ancre(num: int, attendu: str) -> None:
    reel = lignes[num - 1].rstrip("\n")
    if reel != attendu:
        print(f"ANCRE L{num} ROMPUE :\n  attendu : {attendu!r}\n  réel    : {reel!r}")
        sys.exit(1)

# ── 0. Ancres : chaque borne est vérifiée AVANT toute écriture ──────────
ancre(1, '// Handlers « providers-extensions » — extraits d\'index.ts (découpage 2026-11, FORK.md §10).')
ancre(16, "// registerProvidersExtensionsHandlers ne pose plus 21 socket.on() dans un")
ancre(17, "// seul corps : quatre sous-registres thématiques, appelés dans l'ordre")
ancre(18, "// d'origine du fichier. Corps des handlers VERBATIM — seules les accolades")
ancre(19, "// d'encadrement changent.")
ancre(21, "function registerSessionCatalogHandlers(socket: Socket) {")
ancre(49, "function registerAttachmentsAudioHandlers(socket: Socket) {")
ancre(110, "function registerProvidersHandlers(socket: Socket) {")
ancre(112, "// ── Fournisseurs & clés (Paramètres v2.2) ──────────────────────────")
ancre(114, 'socket.on("providers:list", (cb?: (data: unknown) => void) => {')
ancre(121, 'socket.on("providers:catalog", (cb?: (data: unknown) => void) => {')
ancre(123, "});")
ancre(125, "socket.on(")
ancre(198, ");")
ancre(201, 'socket.on("providers:remove", (payload: { id?: string }, cb?: (data: unknown) => void) => {')
ancre(212, "socket.on(")
ancre(233, ");")
ancre(240, "socket.on(")
ancre(274, ");")
ancre(277, "socket.on(")
ancre(319, 'socket.on("providers:remove-key", (payload: { keyId?: string }, cb?: (data: unknown) => void) => {')
ancre(332, "socket.on(")
ancre(377, ");")
ancre(380, "}")
ancre(382, "// ── Extensions : dépôts importés + serveurs MCP ───────────────────")
ancre(388, "function findExtensionBySource(")
ancre(396, "}")
ancre(398, "function registerExtensionsHandlers(socket: Socket) {")
ancre(400, 'socket.on("extensions:list", (cb?: (data: unknown) => void) => {')
ancre(402, "});")
ancre(405, "socket.on(")
ancre(464, ");")
ancre(476, "socket.on(")
ancre(573, ");")
ancre(576, "socket.on(")
ancre(594, ");")
ancre(597, 'socket.on("extensions:remove", (payload: { id?: string }, cb?: (data: unknown) => void) => {')
ancre(608, "socket.on(")
ancre(624, ");")
ancre(628, "socket.on(")
ancre(665, ");")
ancre(670, "socket.on(")
ancre(706, ");")
ancre(708, "}")
ancre(710, "export function registerProvidersExtensionsHandlers(socket: Socket) {")
ancre(714, "  registerExtensionsHandlers(socket);")
ancre(715, "}")

# ── 1. Morceaux VERBATIM (bornes ancrées, plages contiguës) ──────────────
PCAT = morceau(114, 123)    # providers:list + commentaire catalogue + providers:catalog
PMUT = morceau(125, 274)    # providers:add / remove / set-strategy / set-base
PKEY = morceau(277, 377)    # providers:add-key / remove-key / providers:test-key
ELST = morceau(400, 402)    # extensions:list
EIMP = morceau(405, 573)    # extensions:add + commentaire v2.6 + registry:install
ELIF = morceau(576, 624)    # extensions:toggle / remove / extensions:pin
EREPO = morceau(628, 706)   # extensions:check + extensions:update

# ── 2. Glue : note d'en-tête mise à jour, wrappers, sous-registres ───────
NOTE = """// registerProvidersExtensionsHandlers ne pose plus 21 socket.on() dans un
// seul corps : quatre registres thématiques, appelés dans l'ordre d'origine
// du fichier. Corps des handlers VERBATIM — seules les accolades
// d'encadrement changent. Vague 7 (2026-11-25) : Providers et Extensions,
// eux-mêmes, sont démontés en trois sous-registres thématiques chacun
// (lecture / mutations / clés · gestion / import / dépôts) par chirurgie
// ancrée versionnée (extract_sous_registres_providers_extensions.py) — les
// wrappers gardent leurs noms et l'ordre d'origine, chaque sous-registre
// porte les handlers dans leur ordre d'origine.

"""

WRAP_PROVIDERS = """function registerProvidersHandlers(socket: Socket) {

// ── Fournisseurs & clés (Paramètres v2.2) ──────────────────────────

  registerProvidersCatalogHandlers(socket);
  registerProvidersMutationsHandlers(socket);
  registerProvidersKeysHandlers(socket);

}

"""

CAT_DOC = """/** Sous-registre — lecture : liste et catalogue des fournisseurs
 *  (sélecteur d'ajout v2.5). Corps déplacés VERBATIM (vague 7, 2026-11-25). */
function registerProvidersCatalogHandlers(socket: Socket) {

"""
CAT_FIN = """
}

"""

MUT_DOC = """/** Sous-registre — mutations : ajout, retrait, stratégie, adresse
 *  (endpoint éditable v2.5, validations providers-validate.ts). Corps
 *  déplacés VERBATIM (vague 7, 2026-11-25). */
function registerProvidersMutationsHandlers(socket: Socket) {

"""
MUT_FIN = """
}

"""

KEY_DOC = """/** Sous-registre — clés : ajout (déduplication lot audit), retrait,
 *  test réel réseau avec migration d'endpoint v2.5. Corps déplacés
 *  VERBATIM (vague 7, 2026-11-25). */
function registerProvidersKeysHandlers(socket: Socket) {

"""
KEY_FIN = """
}

"""

WRAP_EXTENSIONS = """function registerExtensionsHandlers(socket: Socket) {

  registerExtensionsGestionHandlers(socket);
  registerExtensionsImportHandlers(socket);
  registerExtensionsRepoHandlers(socket);

}

"""

GES_DOC = """/** Sous-registre — gestion de la liste : lecture, activation, épingle,
 *  retrait. Corps déplacés VERBATIM (vague 7, 2026-11-25) ; l'ordre
 *  d'origine des handlers est conservé (list 400, toggle 576, remove 597,
 *  pin 608). */
function registerExtensionsGestionHandlers(socket: Socket) {

"""
GES_FIN = """
}

"""

IMP_DOC = """/** Sous-registre — import : extensions:add (dépôt GitHub résolu réellement)
 *  et registry:install (l'ajout unifié v2.6 : dépôt / https / commande /
 *  nom connu). Corps déplacés VERBATIM (vague 7, 2026-11-25). */
function registerExtensionsImportHandlers(socket: Socket) {

"""
IMP_FIN = """
}

"""

REPO_DOC = """/** Sous-registre — dépôts : « Vérifier » (diff réel local ↔ distant) et
 *  « Mettre à jour » (suivi du commit distant). Corps déplacés VERBATIM
 *  (vague 7, 2026-11-25). */
function registerExtensionsRepoHandlers(socket: Socket) {

"""
REPO_FIN = """
}

"""

# ── 3. Assemblage ────────────────────────────────────────────────────────
NOUVEAU = (
    "".join(morceau(1, 15))       # en-tête fichier + imports (verbatim)
    + NOTE                         # note d'en-tête mise à jour (glue)
    + "".join(morceau(20, 109))    # registres session-catalog + attachments-audio (verbatim)
    + WRAP_PROVIDERS               # wrapper Providers : 3 sous-registres
    + CAT_DOC + "".join(PCAT) + CAT_FIN
    + MUT_DOC + "".join(PMUT) + MUT_FIN
    + KEY_DOC + "".join(PKEY) + KEY_FIN
    + "".join(morceau(381, 397))   # commentaire extensions + findExtensionBySource (verbatim)
    + WRAP_EXTENSIONS              # wrapper Extensions : 3 sous-registres
    + GES_DOC + "".join(ELST) + "\n\n" + "".join(ELIF) + GES_FIN
    + IMP_DOC + "".join(EIMP) + IMP_FIN
    + REPO_DOC + "".join(EREPO) + REPO_FIN
    + "".join(morceau(709, 715))   # dispatcher (verbatim, ordre d'origine inchangé)
)

# ── 4. Vérifications AVANT écriture ──────────────────────────────────────
GARDES = (
    "Fournisseur introuvable",
    "Clé introuvable",
    "kind invalide — « llm » ou « service » attendu",
    "Cette clé existe déjà sur ce fournisseur — ajoutez un autre secret.",
    "Ce dépôt est déjà importé.",
    "Ce serveur est déjà ajouté.",
    "Introuvable — tapez un nom connu (tavily, exa…) ou collez une adresse GitHub / https.",
    "id requis",
    "Rien à vérifier pour ce type d'extension",
    "[hermes-chat] clé ajoutée pour",
    "[hermes-chat] extension importée",
    "[hermes-chat] registry: dépôt installé",
    "Contenu manquant",
)
for g in GARDES:
    if g not in NOUVEAU:
        print(f"ÉCHEC : chaîne de garde absente du fichier assemblé : {g!r}")
        sys.exit(1)

COMPTEURS_OK = (
    ("socket.on(", 23),  # 21 handlers + 2 mentions dans les commentaires d'en-tête
    ('"providers:list"', 1),
    ('"providers:catalog"', 1),
    ('"providers:add"', 1),
    ('"providers:remove"', 1),
    ('"providers:set-strategy"', 1),
    ('"providers:set-base"', 1),
    ('"providers:add-key"', 1),
    ('"providers:remove-key"', 1),
    ('"providers:test-key"', 1),
    ('"extensions:list"', 1),
    ('"extensions:add"', 1),
    ('"registry:install"', 1),
    ('"extensions:toggle"', 1),
    ('"extensions:remove"', 1),
    ('"extensions:pin"', 1),
    ('"extensions:check"', 1),
    ('"extensions:update"', 1),
    ('"hello"', 1),
    ('"attachments:upload"', 1),
    ('"audio:transcribe"', 1),
    ("function registerSessionCatalogHandlers", 1),
    ("function registerAttachmentsAudioHandlers", 1),
    ("function registerProvidersHandlers", 1),
    ("function registerProvidersCatalogHandlers", 1),
    ("function registerProvidersMutationsHandlers", 1),
    ("function registerProvidersKeysHandlers", 1),
    ("function registerExtensionsHandlers", 1),
    ("function registerExtensionsGestionHandlers", 1),
    ("function registerExtensionsImportHandlers", 1),
    ("function registerExtensionsRepoHandlers", 1),
    ("function findExtensionBySource", 1),
    ("export function registerProvidersExtensionsHandlers", 1),
    ("registerProvidersCatalogHandlers(socket);", 1),
    ("registerProvidersMutationsHandlers(socket);", 1),
    ("registerProvidersKeysHandlers(socket);", 1),
    ("registerExtensionsGestionHandlers(socket);", 1),
    ("registerExtensionsImportHandlers(socket);", 1),
    ("registerExtensionsRepoHandlers(socket);", 1),
    ("findExtensionBySource(ctx.store", 4),
)
for nom, attendu in COMPTEURS_OK:
    reel = NOUVEAU.count(nom)
    if reel != attendu:
        print(f"ÉCHEC : compteur {nom!r} : attendu {attendu}, réel {reel}")
        sys.exit(1)

# Chaque plage déplacée doit apparaître dans l'assemblage à l'identique.
for nom, chunk in (
    ("PCAT", PCAT), ("PMUT", PMUT), ("PKEY", PKEY), ("ELST", ELST),
    ("EIMP", EIMP), ("ELIF", ELIF), ("EREPO", EREPO),
):
    if "".join(chunk) not in NOUVEAU:
        print(f"ÉCHEC : plage {nom} non retrouvée à l'identique dans l'assemblage")
        sys.exit(1)

# Les plages conservées doivent figurer mot pour mot.
for nom, debut, fin in (
    ("EN-TETE-IMPORTS", 1, 15),
    ("REGISTRES-INTACTS", 20, 109),
    ("FIND-EXTENSION", 381, 397),
    ("DISPATCHER", 709, 715),
):
    if "".join(morceau(debut, fin)) not in NOUVEAU:
        print(f"ÉCHEC : plage conservée {nom} ({debut}-{fin}) altérée dans l'assemblage")
        sys.exit(1)

FIC.write_text(NOUVEAU, encoding="utf-8")
print(f"OK — {FIC} réécrit : {len(lignes)} lignes → {len(NOUVEAU.splitlines())} lignes")
print("Sous-registres : Catalog %d l. · Mutations %d l. · Keys %d l. · Gestion %d+%d l. · Import %d l. · Repo %d l." % (
    len(PCAT), len(PMUT), len(PKEY), len(ELST), len(ELIF), len(EIMP), len(EREPO)))
deplacees = sum(len(c) for c in (PCAT, PMUT, PKEY, ELST, EIMP, ELIF, EREPO))
print(f"Lignes déplacées VERBATIM : {deplacees}")
