#!/usr/bin/env python3
"""Chantier CRAP vague 7 UI, 2026-11-24 — SystemSection (CC 102) → 2 feuilles VERBATIM.

Coupes ANCRÉES (chaque borne est vérifiée par son contenu avant écriture),
corps déplacés VERBATIM : aucune ligne de JSX ni de handler modifiée — les
closures deviennent des props typées du même nom. La structure DOM (mêmes
nœuds, même ordre) et l'API publique de SystemSection sont inchangées.

Feuilles (dans le même fichier, appelées dans l'ordre du rendu) :
  SystemEnteteApp — l'en-tête de la carte application : ton et libellé de la
                    pastille dérivés (appTone/appLabel), phrase d'état,
                    actions (Recharger / Mettre à jour / Réessayer /
                    Vérifier maintenant / Vérification…) ;
  SystemFilApp    — le fil live de la carte application (LE cœur de la v3) :
                    jalons, phrases horodatées qui respirent, reconnexion,
                    garde-fou « aucune nouvelle depuis 30 s ».

Tout l'état reste dans l'orchestrateur (SystemSection) : sonde unique
prodeMajCheck, journal MAJ (appliqueJournal, majFetch), updateNow, effets de
relais / garde-fou / reprise, fil dérivé et ses âges. Les callbacks
(updateNow, prodeMajCheck, ageLigne) descendent en props.
"""
import sys
from pathlib import Path

FIC = Path("src/components/settings/system-section.tsx")

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
ancre(39, 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";')
ancre(56, "interface SystemSectionProps {")
ancre(84, 'const JALONS = ["Demande envoyée", "Téléchargement", "Installation", "Vérification"];')
ancre(86, "export function SystemSection({")
ancre(92, "}: SystemSectionProps) {")
ancre(94, '  const [majEtat, setMajEtat] = useState<"inconnu" | "ajour" | "disponible" | "erreur">("inconnu");')
ancre(101, "  const majVerifieLabel = useMemo(() => {")
ancre(119, "  const prodeMajCheck = useCallback((silencieux = false) => {")
ancre(149, "  useEffect(() => {")
ancre(219, "  const updateNow = () => {")
ancre(250, '  const majDoneRef = useRef<null | "ok" | "erreur">(null);')
ancre(288, "  useEffect(() => {")
ancre(302, "  useEffect(() => {")
ancre(316, "  const tick = useTick(majActif);")
ancre(329, "  const ageLigne = (l: FilLigne): string | null => {")
ancre(335, "  const ageJournal = majLogAt > 0 ? Math.max(1, Math.round((tick - majLogAt) / 1000)) : null;")
ancre(336, "")
ancre(337, "  // ── La pastille de la carte application ─────────────────────")
ancre(338, '  const appTone: "ok" | "warn" | "err" | "off" | "busy" =')
ancre(350, "  const appLabel =")
ancre(361, '              : "Vérification…";')
ancre(362, "")
ancre(363, "  return (")
ancre(364, '    <section aria-label="Système" className="mx-auto w-full max-w-[880px]">')
ancre(371, '      <div className="space-y-3">')
ancre(372, "        {/* ══ CARTE 1 — L'APPLICATION ════════════════════════════════════ */}")
ancre(373, "        <section")
ancre(376, "        >")
ancre(377, '          <div className="flex flex-wrap items-start justify-between gap-x-3.5 gap-y-2 max-[560px]:flex-col max-[560px]:items-stretch">')
ancre(411, "            </div>")
ancre(413, "            {/* Lot audit : classe Tailwind corrompue réparée —")
ancre(417, '            <div className="flex flex-none flex-wrap items-center gap-2 max-[560px]:min-w-[130px] max-[560px]:flex-1 max-[560px]:text-center">')
ancre(465, "            </div>")
ancre(466, "          </div>")
ancre(468, "          {/* Le fil live — LE cœur de la v3 : jalons + phrases horodatées")
ancre(469, '              qui respirent + garde-fou « aucune nouvelle depuis 30 s ». */}')
ancre(470, "          {majActif || majDone !== null ? (")
ancre(543, "          ) : null}")
ancre(544, "")
ancre(545, "          {updateError ? (")
ancre(549, "          ) : null}")
ancre(550, "        </section>")
ancre(552, "        {/* ══ CARTE 2 — HERMES (le moteur) ═══════════════════════════════")
ancre(554, "        <AgentMotorCard connected={connected} onNavigateStorage={onNavigateStorage} onConnectGateway={onConnectGateway} />")
ancre(561, "  );")
ancre(562, "}")

# ── 1. Morceaux VERBATIM (bornes ancrées) ────────────────────────────────
PASTILLE = morceau(337, 361)   # commentaire + appTone + appLabel
ENTETE   = morceau(377, 466)   # rangée d'en-tête de la carte application
FIL      = morceau(470, 543)   # le fil live (ternaire complet)

# ── 2. Glue : note de découpage, interfaces props, feuilles ─────────────
NOTE_DECOUPE = """// ── Découpage en feuilles (chantier CRAP vague 7 UI, 2026-11-24) ────────
// Le composant SystemSection (CC 102 au crapper) est démonté : deux
// feuilles appelées dans l'ordre du rendu, corps déplacés VERBATIM (aucune
// ligne de JSX ni de handler modifiée — les closures deviennent des props
// typées du même nom), par chirurgie ancrée (ce script, versionné) :
//   SystemEnteteApp — l'en-tête de la carte application : ton et libellé de
//                     la pastille dérivés (appTone/appLabel), phrase d'état,
//                     actions (Recharger / Mettre à jour / Réessayer /
//                     Vérifier maintenant / Vérification…) ;
//   SystemFilApp    — le fil live de la carte application (LE cœur de la
//                     v3) : jalons, phrases horodatées qui respirent,
//                     reconnexion, garde-fou « aucune nouvelle depuis
//                     30 s ».
// Tout l'état reste dans l'orchestrateur (SystemSection) : sonde unique
// prodeMajCheck, journal MAJ (appliqueJournal, majFetch), updateNow, effets
// de relais / garde-fou / reprise, fil dérivé et ses âges. Les callbacks
// (updateNow, prodeMajCheck, ageLigne) descendent en props. Structure DOM
// inchangée (mêmes nœuds dans le même ordre) ; props publiques de
// SystemSection inchangées. SystemFilApp (enfant racine = un ternaire JSX)
// est enveloppée dans un fragment — aucun nœud DOM ajouté.

"""

ENTETE_DOC = """/** Feuille 1 — l'en-tête de la carte application : ton et libellé de la
 *  pastille dérivés de l'état MAJ (appTone/appLabel, §maquette v3), phrase
 *  d'état, actions. Corps déplacé VERBATIM de l'orchestrateur (chantier
 *  CRAP vague 7 UI, 2026-11-24) ; la sonde prodeMajCheck et updateNow
 *  restent au parent et descendent en props. */
interface SystemEnteteAppProps {
  majDone: null | "ok" | "erreur";
  majActif: boolean;
  majEtat: "inconnu" | "ajour" | "disponible" | "erreur";
  majMotif: string | null;
  majVerifieLabel: string | null;
  majFinA: string | null;
  updating: boolean;
  updateNow: () => void;
  prodeMajCheck: (silencieux?: boolean) => void;
}

function SystemEnteteApp({
  majDone,
  majActif,
  majEtat,
  majMotif,
  majVerifieLabel,
  majFinA,
  updating,
  updateNow,
  prodeMajCheck,
}: SystemEnteteAppProps) {
"""
ENTETE_FIN = """
}

"""

FIL_DOC = """/** Feuille 2 — le fil live de la carte application (LE cœur de la v3) :
 *  jalons, phrases horodatées qui respirent, reconnexion, garde-fou
 *  « aucune nouvelle depuis 30 s ». Corps déplacé VERBATIM de
 *  l'orchestrateur (chantier CRAP vague 7 UI, 2026-11-24) ; le fil dérivé
 *  (parseFil), jalonCourant et les âges restent calculés au parent. */
interface SystemFilAppProps {
  majActif: boolean;
  majDone: null | "ok" | "erreur";
  majEtat: "inconnu" | "ajour" | "disponible" | "erreur";
  fil: FilLigne[];
  jalonCourant: number;
  majReconnect: boolean;
  majStale: boolean;
  majAttendGitHub: boolean;
  ageJournal: number | null;
  ageLigne: (l: FilLigne) => string | null;
}

function SystemFilApp({
  majActif,
  majDone,
  majEtat,
  fil,
  jalonCourant,
  majReconnect,
  majStale,
  majAttendGitHub,
  ageJournal,
  ageLigne,
}: SystemFilAppProps) {
  return (
    <>
"""
FIL_FIN = """    </>
  );
}

"""

# ── 3. Appels des feuilles dans l'orchestrateur (ordre du rendu) ─────────
APPEL_ENTETE = """          <SystemEnteteApp
            majDone={majDone}
            majActif={majActif}
            majEtat={majEtat}
            majMotif={majMotif}
            majVerifieLabel={majVerifieLabel}
            majFinA={majFinA}
            updating={updating}
            updateNow={updateNow}
            prodeMajCheck={prodeMajCheck}
          />

"""

APPEL_FIL = """          <SystemFilApp
            majActif={majActif}
            majDone={majDone}
            majEtat={majEtat}
            fil={fil}
            jalonCourant={jalonCourant}
            majReconnect={majReconnect}
            majStale={majStale}
            majAttendGitHub={majAttendGitHub}
            ageJournal={ageJournal}
            ageLigne={ageLigne}
          />

"""

# ── 4. Assemblage ────────────────────────────────────────────────────────
# En-tête (1-85) verbatim — aucun import à patcher (aucun type de props
# react nouveau : callbacks simples et valeurs).
# Corps d'une feuille EnteteApp : dérivation pastille VERBATIM puis return
# sur la rangée d'en-tête VERBATIM (enfant racine unique).
ENTETE_CORPS = (
    "".join(PASTILLE)
    + "  return (\n"
    + "".join(ENTETE)
    + "  );"
)

NOUVEAU = (
    "".join(morceau(1, 85))
    + NOTE_DECOUPE
    + ENTETE_DOC + ENTETE_CORPS + ENTETE_FIN
    + FIL_DOC + "".join(FIL) + FIL_FIN
    + "".join(morceau(86, 336))    # signature + état + sonde + effets + memos + âges
    + "".join(morceau(363, 376))   # return + section + h1/p + carte 1 ouverte
    + APPEL_ENTETE
    + "".join(morceau(468, 469))   # commentaire du fil live
    + APPEL_FIL
    + "".join(morceau(544, 562))   # updateError + carte 2 + fermetures
)

# ── 5. Vérifications AVANT écriture ──────────────────────────────────────
GARDES = (
    "Deux programmes travaillent pour vous",           # p d'introduction
    "L&apos;application <Pastille",                    # titre carte 1 (feuille EnteteApp)
    "Recharger la page",                               # bouton (feuille EnteteApp)
    "Mettre à jour",                                   # bouton
    "Réessayer",                                       # bouton
    "Vérifier maintenant",                             # bouton
    "Vérification…",                                   # bouton + libellé pastille
    "Demande envoyée",                                 # JALONS (feuille FilApp)
    "La connexion coupe et revient",                   # reconnexion (feuille FilApp)
    "Aucune nouvelle depuis",                          # garde-fou (feuille FilApp)
    "votre part.",                                     # fin du garde-fou (coupée par un saut de ligne)
    "essentiel en direct",                             # pied du fil
    "AgentMotorCard connected",                        # carte 2 (inchangée)
    "Mise à jour installée",                           # libellé pastille (dérivation déplacée)
    "Mise à jour en cours…",                           # libellé pastille
)
for g in GARDES:
    if g not in NOUVEAU:
        print(f"ÉCHEC : chaîne de garde absente du fichier assemblé : {g!r}")
        sys.exit(1)

COMPTEURS_OK = (
    ("export function SystemSection", 1),
    ("function SystemEnteteApp", 1),
    ("function SystemFilApp", 1),
    ("<SystemEnteteApp", 1),
    ("<SystemFilApp", 1),
    ("<AgentMotorCard", 1),
    ("<SanteCard", 1),
    ("getSocket().emit", 4),
    ("socket.on(", 3),
    ("socket.off(", 3),
    ("useTick(majActif)", 1),
    ("<section", 2),
    ("const appTone", 1),
    ("const appLabel", 1),
)
for nom, attendu in COMPTEURS_OK:
    reel = NOUVEAU.count(nom)
    if reel != attendu:
        print(f"ÉCHEC : compteur {nom!r} : attendu {attendu}, réel {reel}")
        sys.exit(1)

# Chaque morceau déplacé doit apparaître dans l'assemblage — à
# l'indentation d'origine (aucun dédent ici : feuilles JSX contiguës).
for nom, chunk in (("PASTILLE", PASTILLE), ("ENTETE", ENTETE), ("FIL", FIL)):
    if "".join(chunk) not in NOUVEAU:
        print(f"ÉCHEC : morceau {nom} non retrouvé à l'identique dans l'assemblage")
        sys.exit(1)

# Le corps de l'orchestrateur (état + sonde + effets + memos) est intact.
for nom, debut, fin in (
    ("EN-TETE-FICHIER", 1, 85),
    ("PARENT-LOGIQUE", 86, 336),
    ("PARENT-RENDU-OUVERTURE", 363, 376),
    ("PARENT-FIL-COMMENTAIRE", 468, 469),
    ("PARENT-PIED", 544, 562),
):
    if "".join(morceau(debut, fin)) not in NOUVEAU:
        print(f"ÉCHEC : plage parente {nom} ({debut}-{fin}) altérée dans l'assemblage")
        sys.exit(1)

FIC.write_text(NOUVEAU, encoding="utf-8")
print(f"OK — {FIC} réécrit : {len(lignes)} lignes → {len(NOUVEAU.splitlines())} lignes")
print("Feuilles : SystemEnteteApp (pastille %d l. + en-tête %d l.), SystemFilApp (%d l.)" % (
    len(PASTILLE), len(ENTETE), len(FIL)))
deplacees = len(PASTILLE) + len(ENTETE) + len(FIL)
print(f"Lignes déplacées VERBATIM : {deplacees}")
