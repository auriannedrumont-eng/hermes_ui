#!/usr/bin/env python3
"""Chantier CRAP vague 7 UI, 2026-11-24 — StorageSection (CC 105) → 5 feuilles VERBATIM.

Coupes ANCRÉES (chaque borne est vérifiée par son contenu avant écriture),
corps déplacés VERBATIM : aucune ligne de JSX ni de handler modifiée — les
closures deviennent des props typées du même nom. La structure DOM (mêmes
nœuds, même ordre) et l'API publique de StorageSection sont inchangées.

Feuilles (dans le même fichier, appelées dans l'ordre du rendu) :
  StorageCompteurs     — le bandeau des compteurs globaux (§4.1) ;
  StorageBarreFiltres  — la barre recherche / tri / filtres par type (§4.1) ;
  StorageBandeau       — le bandeau de résultats du filtrage (§2.2, C4) ;
  StorageGroupe        — un groupe projet : déroulé dérivé, en-tête
                         (compteurs + « Nettoyer » en place), lignes triées,
                         projet vidé (§2.2, §4.2) ;
  StorageToasts        — les bandeaux d'annulation « Annuler » 7 s (§4.5).

Tout l'état reste dans l'orchestrateur (StorageSection) : inventaire, filtres,
verrou busy, freedTotal, toasts, demandes d'inventaire et mutations socket.
La ref inputRef reste à l'orchestrateur et descend en props (convention
RefObject du repo, cf. composer.tsx).
"""
import sys
from pathlib import Path

FIC = Path("src/components/settings/storage-section.tsx")

lignes = FIC.read_text(encoding="utf-8").splitlines(keepends=True)
ORIGINAL = "".join(lignes)

def morceau(debut: int, fin: int) -> list[str]:
    """Extrait les lignes [debut, fin] (1-indexé inclusif)."""
    return lignes[debut - 1 : fin]

def ancre(num: int, attendu: str) -> None:
    reel = lignes[num - 1].rstrip("\n")
    if reel != attendu:
        print(f"ANCRE L{num} ROMPUE :\n  attendu : {attendu!r}\n  réel    : {reel!r}")
        sys.exit(1)

# ── 0. Ancres : chaque borne est vérifiée AVANT toute écriture ──────────
ancre(1, '"use client";')
ancre(15, 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";')
ancre(133, "// ── Composants ────────────────────────────────────────────────────────────")
ancre(162, 'export function StorageSection({ initialProject }: { initialProject?: string | null }) {')
ancre(163, '  const [entries, setEntries] = useState<StorageEntry[] | null>(null);')
ancre(195, "  /** Ajoute un toast d'annulation (durée = fenêtre + marge d'affichage). */")
ancre(211, "  /**")
ancre(244, "  /** Réessayer (écran d'erreur) : rechargement complet avec squelette. */")
ancre(253, "  useEffect(() => {")
ancre(264, "  // ── Déballage des filtres (§4.2 : les trois déclencheurs confondus) ────")
ancre(288, "  // ── Compteurs globaux (en-tête de page — §4.1) ─────────────────────────")
ancre(302, "  /** Fin de filtrage : retour au repli + focus au déclencheur (§4.4). */")
ancre(310, "  // ── Opérations destructrices (§4.5) ─────────────────────────────────────")
ancre(314, "  const undo = useCallback(")
ancre(351, "  const deleteVersion = (e: StorageEntry) => {")
ancre(404, "  const cleanProject = (g: ProjectGroup) => {")
ancre(457, "  // ── Rendu ────────────────────────────────────────────────────────────────")
ancre(458, "  return (")
ancre(459, '    <section aria-label="Stockage des documents générés" className="mx-auto w-full max-w-[880px]">')
ancre(466, "")
ancre(467, "      {/* Compteurs globaux (§4.1 — pas de « Tout nettoyer » global : le")
ancre(469, '      <div className="mt-4 rounded-xl border border-border px-4 py-3">')
ancre(492, "      </div>")
ancre(494, "      {/* Explorateur (liste intégrale : aucune pagination — §2.3) */}")
ancre(495, '      <div className="mt-3 overflow-hidden rounded-xl border border-border">')
ancre(496, "        {/* Barre recherche / tri / filtres (§4.1) */}")
ancre(497, '        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 pt-2.5">')
ancre(561, "        </div>")
ancre(563, "        {/* Bandeau de résultats (§2.2 : affiché pendant TOUT le filtrage —")
ancre(565, "        {filtrageActif && !loading && !error ? (")
ancre(595, "        ) : null}")
ancre(597, "        {/* Corps : squelette (§4.3), erreur avec Réessayer, ou groupes */}")
ancre(598, "        <div>")
ancre(599, "          {loading ? (")
ancre(605, "          ) : error ? (")
ancre(620, "          ) : (")
ancre(621, "            <div>")
ancre(622, "              {groupes.map((g) => {")
ancre(627, "                const res = filtrageActif ? resultatsDe(g) : null;")
ancre(632, "                const visibles = filtrageActif ? res! : g.entries;")
ancre(633, "                return (")
ancre(634, "                  <section")
ancre(758, "                  </section>")
ancre(759, "                );")
ancre(760, "              })}")
ancre(761, "              {/* Inventaire vide (aucun document du tout) */}")
ancre(767, "              ) : null}")
ancre(768, "            </div>")
ancre(769, "          )}")
ancre(770, "        </div>")
ancre(771, "      </div>")
ancre(773, "      {/* Bandeaux d'annulation (§4.5 — toasts « Annuler » 7 s) */}")
ancre(774, '      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">')
ancre(804, "      </div>")
ancre(805, "    </section>")
ancre(806, "  );")
ancre(807, "}")

# ── 1. Morceaux VERBATIM (bornes ancrées) ────────────────────────────────
COMPTEURS = morceau(467, 492)   # bandeau des compteurs globaux
BARRE    = morceau(496, 561)   # barre recherche / tri / filtres
BANDEAU  = morceau(563, 595)   # bandeau de résultats
GROUPE   = morceau(623, 759)   # dérivation du déroulé + section d'un groupe
TOASTS   = morceau(773, 804)   # bandeaux d'annulation

# ── 2. Glue : note de découpage, interfaces props, feuilles ─────────────
NOTE_DECOUPE = """// ── Découpage en feuilles (chantier CRAP vague 7 UI, 2026-11-24) ────────
// Le composant StorageSection (CC 105 au crapper) est démonté : cinq
// feuilles appelées dans l'ordre du rendu, corps déplacés VERBATIM (aucune
// ligne de JSX ni de handler modifiée — les closures deviennent des props
// typées du même nom), par chirurgie ancrée (ce script, versionné) :
//   StorageCompteurs     — le bandeau des compteurs globaux (§4.1) ;
//   StorageBarreFiltres  — la barre recherche / tri / filtres par type (§4.1) ;
//   StorageBandeau       — le bandeau de résultats du filtrage (§2.2, C4) ;
//   StorageGroupe        — un groupe projet : déroulé dérivé, en-tête
//                          (compteurs + « Nettoyer » en place), lignes
//                          triées, projet vidé (§2.2, §4.2) ;
//   StorageToasts        — les bandeaux d'annulation « Annuler » 7 s (§4.5).
// Tout l'état reste dans l'orchestrateur (StorageSection) : inventaire,
// filtres, verrou busy, freedTotal, toasts, demandes d'inventaire et
// mutations socket. La ref inputRef reste à l'orchestrateur et descend en
// props (convention RefObject du repo, cf. composer.tsx). Structure DOM
// inchangée (mêmes nœuds dans le même ordre) ; props publiques de
// StorageSection inchangées. Les feuilles à plusieurs enfants racine (un
// commentaire JSX compte comme un enfant) sont enveloppées dans un
// fragment — aucun nœud DOM ajouté.

"""

COMPTEURS_DOC = """/** Feuille 1 — le bandeau des compteurs globaux (§4.1). Corps déplacé
 *  VERBATIM de l'orchestrateur (chantier CRAP vague 7 UI, 2026-11-24). */
interface StorageCompteursProps {
  loading: boolean;
  error: string | null;
  totaux: { docs: number; bytes: number; cleanable: number };
  freedTotal: { n: number; bytes: number };
}

function StorageCompteurs({ loading, error, totaux, freedTotal }: StorageCompteursProps) {
  return (
    <>
"""
COMPTEURS_FIN = """    </>
  );
}

"""

BARRE_DOC = """/** Feuille 2 — la barre recherche / tri / filtres par type (§4.1). Corps
 *  déplacé VERBATIM de l'orchestrateur (chantier CRAP vague 7 UI,
 *  2026-11-24) ; la ref du champ de recherche reste au parent et descend
 *  en props (convention RefObject du repo). */
interface StorageBarreFiltresProps {
  inputRef: RefObject<HTMLInputElement | null>;
  recherche: string;
  setRecherche: Dispatch<SetStateAction<string>>;
  tri: SortKey;
  setTri: Dispatch<SetStateAction<SortKey>>;
  types: string[];
  type: string;
  setType: Dispatch<SetStateAction<string>>;
  setProjetOuvert: Dispatch<SetStateAction<string | null>>;
}

function StorageBarreFiltres({
  inputRef,
  recherche,
  setRecherche,
  tri,
  setTri,
  types,
  type,
  setType,
  setProjetOuvert,
}: StorageBarreFiltresProps) {
  return (
    <>
"""
BARRE_FIN = """    </>
  );
}

"""

BANDEAU_DOC = """/** Feuille 3 — le bandeau de résultats du filtrage (§2.2 : affiché pendant
 *  TOUT le filtrage, compteurs et bouton d'effacement identiques au cas
 *  vide, C4). Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP
 *  vague 7 UI, 2026-11-24) ; finFiltrage reste calculée au parent. */
interface StorageBandeauProps {
  filtrageActif: boolean;
  loading: boolean;
  error: string | null;
  entries: StorageEntry[] | null;
  qNorm: string;
  type: string;
  finFiltrage: (focus: HTMLElement | null) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

function StorageBandeau({
  filtrageActif,
  loading,
  error,
  entries,
  qNorm,
  type,
  finFiltrage,
  inputRef,
}: StorageBandeauProps) {
  return (
    <>
"""
BANDEAU_FIN = """    </>
  );
}

"""

GROUPE_DOC = """/** Feuille 4 — un groupe projet : dérivation du déroulé (§4.2 — jamais
 *  stocké), en-tête (compteurs + « Nettoyer » en place, replié §2.2),
 *  lignes triées, projet vidé. Corps déplacé VERBATIM de l'orchestrateur
 *  (chantier CRAP vague 7 UI, 2026-11-24) ; les callbacks de mutation
 *  (deleteVersion, cleanProject) et le verrou busy restent au parent et
 *  descendent en props. La clé de liste est posée sur l'appel. */
interface StorageGroupeProps {
  g: ProjectGroup;
  filtrageActif: boolean;
  projetOuvert: string | null;
  setProjetOuvert: Dispatch<SetStateAction<string | null>>;
  resultatsDe: (g: ProjectGroup) => StorageEntry[];
  tri: SortKey;
  maxByDoc: Map<string, number>;
  busy: string | null;
  deleteVersion: (e: StorageEntry) => void;
  cleanProject: (g: ProjectGroup) => void;
}

function StorageGroupe({
  g,
  filtrageActif,
  projetOuvert,
  setProjetOuvert,
  resultatsDe,
  tri,
  maxByDoc,
  busy,
  deleteVersion,
  cleanProject,
}: StorageGroupeProps) {
"""
GROUPE_FIN = """}

"""

TOASTS_DOC = """/** Feuille 5 — les bandeaux d'annulation (§4.5 — toasts « Annuler » 7 s).
 *  Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP vague 7 UI,
 *  2026-11-24) ; le tableau des toasts et undo restent à l'orchestrateur. */
interface StorageToastsProps {
  toasts: Array<{
    key: number;
    title: string;
    description: string;
    tone: "ok" | "err" | "warn";
    undo?: { token: string; bytes: number; n: number };
    expireAt: number;
  }>;
  undo: (token: string, bytes: number, n: number) => void;
}

function StorageToasts({ toasts, undo }: StorageToastsProps) {
  return (
    <>
"""
TOASTS_FIN = """    </>
  );
}

"""

# ── 3. Appels des feuilles dans l'orchestrateur (ordre du rendu) ─────────
APPEL_COMPTEURS = """      <StorageCompteurs
        loading={loading}
        error={error}
        totaux={totaux}
        freedTotal={freedTotal}
      />

"""

APPEL_BARRE = """        <StorageBarreFiltres
          inputRef={inputRef}
          recherche={recherche}
          setRecherche={setRecherche}
          tri={tri}
          setTri={setTri}
          types={types}
          type={type}
          setType={setType}
          setProjetOuvert={setProjetOuvert}
        />

"""

APPEL_BANDEAU = """        <StorageBandeau
          filtrageActif={filtrageActif}
          loading={loading}
          error={error}
          entries={entries}
          qNorm={qNorm}
          type={type}
          finFiltrage={finFiltrage}
          inputRef={inputRef}
        />

"""

MAP_GLUE = """              {groupes.map((g) => (
                <StorageGroupe
                  key={g.id ?? "__hors"}
                  g={g}
                  filtrageActif={filtrageActif}
                  projetOuvert={projetOuvert}
                  setProjetOuvert={setProjetOuvert}
                  resultatsDe={resultatsDe}
                  tri={tri}
                  maxByDoc={maxByDoc}
                  busy={busy}
                  deleteVersion={deleteVersion}
                  cleanProject={cleanProject}
                />
              ))}
"""

APPEL_TOASTS = """      <StorageToasts toasts={toasts} undo={undo} />

"""

# ── 4. Assemblage ────────────────────────────────────────────────────────
# En-tête (1-161) verbatim ; l'import react reçoit les types de props
# (Dispatch / SetStateAction / RefObject) — mêmes conventions que
# composer.tsx (vague 6).
teten = "".join(morceau(1, 161))
teten = teten.replace(
    'import { useCallback, useEffect, useMemo, useRef, useState } from "react";',
    'import {\n'
    '  useCallback,\n'
    '  useEffect,\n'
    '  useMemo,\n'
    '  useRef,\n'
    '  useState,\n'
    '  type Dispatch,\n'
    '  type RefObject,\n'
    '  type SetStateAction,\n'
    '} from "react";',
)

# Corps du parent : signature → état → callbacks → rendu réduit aux appels.
PARENT = (
    "".join(morceau(162, 466))   # signature + état + effets + memos + mutations
    + APPEL_COMPTEURS
    + "".join(morceau(494, 495))  # commentaire explorateur + conteneur
    + APPEL_BARRE
    + APPEL_BANDEAU
    + "".join(morceau(597, 621))  # commentaire corps + div + ternaire squelette/erreur
    + MAP_GLUE                    # la carte des groupes → StorageGroupe (clé sur l'appel)
    + "".join(morceau(761, 770))  # inventaire vide + fermetures
    + "".join(morceau(771, 772))  # fermeture explorateur + ligne vide
    + APPEL_TOASTS
    + "".join(morceau(805, 807))  # fermeture section + ); + }
)

NOUVEAU = (
    teten
    + NOTE_DECOUPE
    + COMPTEURS_DOC + "".join(COMPTEURS) + COMPTEURS_FIN
    + BARRE_DOC + "".join(BARRE) + BARRE_FIN
    + BANDEAU_DOC + "".join(BANDEAU) + BANDEAU_FIN
    + GROUPE_DOC + "".join(GROUPE) + GROUPE_FIN
    + TOASTS_DOC + "".join(TOASTS) + TOASTS_FIN
    + PARENT
)

# ── 5. Vérifications AVANT écriture ──────────────────────────────────────
if "type Dispatch," not in teten or "type RefObject," not in teten or "type SetStateAction," not in teten:
    print("ÉCHEC : patch import react non appliqué")
    sys.exit(1)

GARDES = (
    "Stockage des documents générés",                  # aria-label de la page
    "Rechercher un fichier…",                          # placeholder (feuille Barre)
    "Aucun fichier ne correspond",                     # bandeau vide (feuille Bandeau)
    "effacer les filtres",                             # bouton du bandeau
    "Réessayer",                                       # écran d'erreur
    "Nettoyage…",                                      # bouton en vol (feuille Groupe)
    "Aucune version — ce projet a été entièrement nettoyé.",  # projet vidé
    "Fenêtre d'annulation expirée",                    # undo expiré (feuille Toasts)
    "Annuler",                                         # bouton undo (seule occurrence du mot)
    "Le service n'a pas répondu",                      # chiens de garde
    "Hors projet",                                     # groupe id null
    "Tous",                                            # chip de type
    "Tri : taille",                                    # select de tri
)
for g in GARDES:
    if g not in NOUVEAU:
        print(f"ÉCHEC : chaîne de garde absente du fichier assemblé : {g!r}")
        sys.exit(1)

COMPTEURS_OK = (
    ("export function StorageSection", 1),
    ("function KindBadge", 1),
    ("function VersionTag", 1),
    ("function StorageCompteurs", 1),
    ("function StorageBarreFiltres", 1),
    ("function StorageBandeau", 1),
    ("function StorageGroupe", 1),
    ("function StorageToasts", 1),
    ("<StorageCompteurs", 1),
    ("<StorageBarreFiltres", 1),
    ("<StorageBandeau", 1),
    ("<StorageGroupe", 1),
    ("<StorageToasts", 1),
    ("getSocket().emit", 4),
    ("getSocket().on", 1),
    ("getSocket().off", 1),
    ("<section", 2),
)
for nom, attendu in COMPTEURS_OK:
    reel = NOUVEAU.count(nom)
    if reel != attendu:
        print(f"ÉCHEC : compteur {nom!r} : attendu {attendu}, réel {reel}")
        sys.exit(1)

# Chaque morceau déplacé doit apparaître dans l'assemblage — à
# l'indentation d'origine (aucun dédent ici : feuilles JSX contiguës).
for nom, chunk in (
    ("COMPTEURS", COMPTEURS), ("BARRE", BARRE), ("BANDEAU", BANDEAU),
    ("GROUPE", GROUPE), ("TOASTS", TOASTS),
):
    if "".join(chunk) not in NOUVEAU:
        print(f"ÉCHEC : morceau {nom} non retrouvé à l'identique dans l'assemblage")
        sys.exit(1)

# Le corps de l'orchestrateur (état + effets + mutations) est intact : les
# plages conservées doivent figurer mot pour mot.
for nom, debut, fin in (
    ("PARENT-LOGIQUE", 162, 466),
    ("PARENT-EXPLORATEUR", 494, 495),
    ("PARENT-CORPS", 597, 621),
    ("PARENT-VIDE", 761, 772),
    ("PARENT-PIED", 805, 807),
):
    if "".join(morceau(debut, fin)) not in NOUVEAU:
        print(f"ÉCHEC : plage parente {nom} ({debut}-{fin}) altérée dans l'assemblage")
        sys.exit(1)

FIC.write_text(NOUVEAU, encoding="utf-8")
print(f"OK — {FIC} réécrit : {len(lignes)} lignes → {len(NOUVEAU.splitlines())} lignes")
print("Feuilles : StorageCompteurs (%d l.), StorageBarreFiltres (%d l.), StorageBandeau (%d l.), StorageGroupe (%d l.), StorageToasts (%d l.)" % (
    len(COMPTEURS), len(BARRE), len(BANDEAU), len(GROUPE), len(TOASTS)))
deplacees = sum(len(c) for c in (COMPTEURS, BARRE, BANDEAU, GROUPE, TOASTS))
print(f"Lignes déplacées VERBATIM : {deplacees}")
