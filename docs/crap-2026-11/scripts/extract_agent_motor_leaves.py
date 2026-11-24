#!/usr/bin/env python3
"""Chantier UI 2026-11-25 — AgentMotorCard (CC 179) → 3 sous-cartes feuilles.

Coupes ANCRÉES (chaque borne est vérifiée par son contenu avant écriture),
corps déplacés VERBATIM : aucune ligne de JSX ni de handler modifiée — les
closures deviennent des props typées du même nom. La structure DOM (mêmes
nœuds, même ordre) et l'API publique de AgentMotorCard sont inchangées.

Feuilles (dans le même fichier, appelées dans l'ordre du rendu) :
  AgentMotorEnTete  — pastille, le fil, la cause connue, boutons d'action ;
  AgentMotorBlocs   — notes de version, scénario problème, fil live ;
  AgentMotorReplis  — « autre poste », historique, lien documents générés.

États purement locaux d'un bloc (replis notes/diagnostic, copie, champs
« autre poste ») descendent dans leur feuille ; le reste reste orchestrateur.
"""
import sys
from pathlib import Path

FIC = Path("src/components/settings/agent-motor-card.tsx")

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
ancre(38, 'import { useCallback, useEffect, useMemo, useState } from "react";')
ancre(56, "import type {")
ancre(83, "export function AgentMotorCard({ connected = true, onNavigateStorage, onConnectGateway }: AgentMotorCardProps) {")
ancre(106, "  const appliqueLog = useCallback((snap: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {")
ancre(112, "  useEffect(() => {")
ancre(153, "  const op = state?.op ?? null;")
ancre(187, "  // ── Pastille (liaison coupée > opération > problème > dispo > état) ──")
ancre(213, '                : "Hermes non détecté";')
ancre(215, "  /** Revue P1-P7 (B4) : émission via emitAck — omet le payload quand il")
ancre(280, "  /** Message à transmettre (copier-coller) si le contrôle échoue. */")
ancre(307, "  // ── Fil de l'opération en cours ─────────────────────────────────────")
ancre(341, '        <div className="flex flex-wrap items-start justify-between gap-x-3.5 gap-y-2 max-[560px]:flex-col max-[560px]:items-stretch">')
ancre(459, "        </div>")
ancre(461, "        {/* Aperçu des changements (état disponible) : 3 lignes + repli +")
ancre(615, "        ) : null}")
ancre(617, "        {/* Le repli « autre poste » : lien discret, étape guidée (v3 —")
ancre(801, "        ) : null}")
ancre(809, "      <ConfirmDestructiveDialog")
ancre(830, "  );")

# ── 1. Morceaux VERBATIM (bornes ancrées) ────────────────────────────────
TON_ETAT = morceau(187, 213)      # pastille + libellé d'état (dérivations)
EN_TETE = morceau(341, 459)       # le <div> d'en-tête complet
BLOCS = morceau(461, 615)         # notes de version + problème + fil live
REPLIS = morceau(617, 801)        # autre poste + historique + documents
MESSAGE = morceau(280, 290)       # messageATransmettre
COPIER = morceau(291, 305)        # copierMessage
FIL = morceau(307, 324)           # verdict/fil/jalonCourant/tick/ageLigne
NOTES = morceau(326, 332)         # notesToutes/Apercu/Reste
APPLI = morceau(104, 151)         # appliqueLog + useEffect socket
DERIVE = morceau(153, 185)        # op…control + verifieLabel + stateConnu + majRecente + pbDetecte
ACTIONS = morceau(215, 278)       # demander + requestUpdate/Rollback/Check
SECTION = morceau(336, 340)       # commentaire carte + <section …>
DIALOGUE = morceau(804, 828)      # commentaire + ConfirmDestructiveDialog

# ── 2. Glue : note de découpage, interfaces de props, corps des feuilles ─
NOTE_DECOUPE = """// ── Découpage en sous-cartes feuilles (chantier UI 2026-11-25) ─────────
// La carte (CC 179 au crapper) est démontée en trois feuilles appelées
// dans l'ordre du rendu, corps déplacés VERBATIM (aucune ligne de JSX ni
// de handler modifiée — les closures deviennent des props typées du même
// nom), par chirurgie ancrée (ce script, versionné) :
//   AgentMotorEnTete  — pastille, le fil (une phrase par état), la cause
//                       connue et les boutons d'action (toujours rendus) ;
//   AgentMotorBlocs   — les blocs d'état conditionnels : notes de version,
//                       scénario « problème », fil live de l'opération ;
//   AgentMotorReplis  — les replis et le pied de carte : « autre poste »,
//                       historique, lien documents générés.
// L'état de la carte reste dans l'orchestrateur (AgentMotorCard), sauf les
// états purement locaux d'un bloc (replis notes/diagnostic, copie, champs
// « autre poste ») qui descendent dans leur feuille — même durée de vie
// (les feuilles sont montées en continu). Structure DOM inchangée (mêmes
// nœuds dans le même ordre) ; props publiques de la carte inchangées.
"""

ENTETE_GLUE = """/** Feuille 1 — l'en-tête de la carte : pastille, le fil (une phrase par
 *  état), la cause connue et les boutons d'action. Corps déplacé VERBATIM
 *  de l'orchestrateur (chantier UI 2026-11-25) ; la pastille et le libellé
 *  d'état sont dérivés des mêmes entrées, devenues des props. */
interface AgentMotorEnTeteProps {
  connected: boolean;
  op: MotorOp;
  installed: string | null;
  release: AgentRelease | null;
  previous: string | null;
  verifieLabel: string | null;
  stateConnu: boolean;
  pbDetecte: boolean;
  state: MotorState | null;
  checking: boolean;
  requesting: boolean;
  requestUpdate: () => void;
  requestCheck: () => void;
  setConfirmOpen: Dispatch<SetStateAction<boolean>>;
  setAdvOpen: Dispatch<SetStateAction<boolean>>;
}

function AgentMotorEnTete({
  connected,
  op,
  installed,
  release,
  previous,
  verifieLabel,
  stateConnu,
  pbDetecte,
  state,
  checking,
  requesting,
  requestUpdate,
  requestCheck,
  setConfirmOpen,
  setAdvOpen,
}: AgentMotorEnTeteProps) {
"""

BLOCS_GLUE = """/** Feuille 2 — les blocs d'état conditionnels : aperçu des changements de
 *  la release, scénario « problème » avec message prêt à copier, fil live
 *  de l'opération (jalons + déroulé + verdict frais). Corps déplacés
 *  VERBATIM de l'orchestrateur (chantier UI 2026-11-25) ; les états
 *  purement locaux de ces blocs (replis notes/diagnostic, copie) descendent
 *  ici — même durée de vie (la feuille est montée en continu). */
interface AgentMotorBlocsProps {
  release: AgentRelease | null;
  op: MotorOp;
  pbDetecte: boolean;
  previous: string | null;
  control: MotorControl | null;
  log: string | null;
}

function AgentMotorBlocs({
  release,
  op,
  pbDetecte,
  previous,
  control,
  log,
}: AgentMotorBlocsProps) {
  const { toast } = useToast();
  const [notesOpen, setNotesOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [copied, setCopied] = useState(false);
"""

REPLIS_GLUE = """/** Feuille 3 — les replis et le pied de carte : étape guidée « autre poste »
 *  (formulaire relié à gateway:set), historique (ex carnet de bord) et lien
 *  documents générés. Corps déplacés VERBATIM de l'orchestrateur (chantier
 *  UI 2026-11-25) ; les champs contrôlés du formulaire descendent ici. */
interface AgentMotorReplisProps {
  op: MotorOp;
  pbDetecte: boolean;
  state: MotorState | null;
  journal: JournalWire[];
  installed: string | null;
  onNavigateStorage?: () => void;
  advOpen: boolean;
  setAdvOpen: Dispatch<SetStateAction<boolean>>;
  onConnectGateway?: (
    url: string,
    token?: string
  ) => Promise<{ ok: boolean; error?: string }>;
}

function AgentMotorReplis({
  op,
  pbDetecte,
  state,
  journal,
  installed,
  onNavigateStorage,
  advOpen,
  setAdvOpen,
  onConnectGateway,
}: AgentMotorReplisProps) {
  const { toast } = useToast();
  // Revue 95 : champs contrôlés du repli « autre poste » (advOpen reste à
  // l'orchestrateur — le lien du fil de l'en-tête l'ouvre aussi).
  const [advUrl, setAdvUrl] = useState("");
  const [advToken, setAdvToken] = useState("");
  const [advBusy, setAdvBusy] = useState(false);
"""

ETATS_PARENT = """  const { toast } = useToast();
  // État de la carte : la source unique reste dans l'orchestrateur ; les
  // états purement locaux d'un bloc (replis notes/diagnostic, copie, champs
  // « autre poste ») vivent dans leur feuille (EnTete/Blocs/Replis).
  const [state, setState] = useState<MotorState | null>(null);
  const [journal, setJournal] = useState<JournalWire[]>([]);
  const [log, setLog] = useState<string | null>(null);
  const [logAt, setLogAt] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  // Lot audit 2026-11-21 : états pending + chien de garde des demandes
  // (avant : « Revérifier » sans aucun retour, erreurs en window.alert).
  const [checking, setChecking] = useState(false);
  const [requesting, setRequesting] = useState(false);
"""

RETOUR_PARENT = """  return (
    <>
""" + "".join(SECTION) + """
        <AgentMotorEnTete
          connected={connected}
          op={op}
          installed={installed}
          release={release}
          previous={previous}
          verifieLabel={verifieLabel}
          stateConnu={stateConnu}
          pbDetecte={pbDetecte}
          state={state}
          checking={checking}
          requesting={requesting}
          requestUpdate={requestUpdate}
          requestCheck={requestCheck}
          setConfirmOpen={setConfirmOpen}
          setAdvOpen={setAdvOpen}
        />
        <AgentMotorBlocs
          release={release}
          op={op}
          pbDetecte={pbDetecte}
          previous={previous}
          control={control}
          log={log}
        />
        <AgentMotorReplis
          op={op}
          pbDetecte={pbDetecte}
          state={state}
          journal={journal}
          installed={installed}
          onNavigateStorage={onNavigateStorage}
          advOpen={advOpen}
          setAdvOpen={setAdvOpen}
          onConnectGateway={onConnectGateway}
        />
      </section>

""" + "".join(DIALOGUE) + """
    </>
  );
}
"""

# ── 3. Assemblage ────────────────────────────────────────────────────────
# En-tête de fichier (lignes 1-55) : l'import react reçoit Dispatch /
# SetStateAction (types). Lignes 56-81 : imports de types (MotorOp,
# MotorControl ajoutés) + interface props + constantes — verbatim sinon.
teten = "".join(lignes[0:55])
teten = teten.replace(
    'import { useCallback, useEffect, useMemo, useState } from "react";',
    'import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";',
)

props_et_constantes = "".join(morceau(56, 81))
props_et_constantes = props_et_constantes.replace(
    "import type {\n  AgentRelease,\n  MotorState,\n  MotorJournalEntry as JournalWire,\n} from \"@/lib/chat-types\";",
    "import type {\n  AgentRelease,\n  MotorState,\n  MotorOp,\n  MotorControl,\n  MotorJournalEntry as JournalWire,\n} from \"@/lib/chat-types\";",
)

def bloc_fonction(glue: str, declarations: list[str], jsx: list[str]) -> str:
    corps = glue
    corps += "\n".join(declarations)
    corps += "\n  return (\n    <>\n"
    corps += "".join(jsx).rstrip("\n") + "\n"
    corps += "    </>\n  );\n}\n\n"
    return corps

feuille_entete = bloc_fonction(ENTETE_GLUE, ["".join(TON_ETAT)], EN_TETE)
feuille_blocs = bloc_fonction(
    BLOCS_GLUE,
    ["".join(MESSAGE), "".join(COPIER), "".join(FIL), "".join(NOTES)],
    BLOCS,
)
feuille_replis = bloc_fonction(REPLIS_GLUE, [], REPLIS)

parent = "export function AgentMotorCard({ connected = true, onNavigateStorage, onConnectGateway }: AgentMotorCardProps) {\n"
parent += ETATS_PARENT
parent += "\n" + "".join(APPLI)
parent += "\n" + "".join(DERIVE)
parent += "\n" + "".join(ACTIONS)
parent += "\n" + RETOUR_PARENT

nouveau = (
    teten
    + props_et_constantes
    + "\n" + NOTE_DECOUPE
    + feuille_entete
    + feuille_blocs
    + feuille_replis
    + parent
)

# ── 4. Vérifications AVANT écriture ──────────────────────────────────────
if "type Dispatch" not in teten:
    print("ÉCHEC : patch import react non appliqué")
    sys.exit(1)
if "  MotorOp,\n  MotorControl,\n" not in props_et_constantes:
    print("ÉCHEC : patch import types (MotorOp/MotorControl) non appliqué")
    sys.exit(1)
GARDES = (
    "Cause connue",                                   # garde source [11]
    "modulenotfounderror|importerror",                # garde [82]
    "relancez simplement l&apos;application",         # garde [82]
    "installe les dépendances depuis le dépôt du projet",  # garde [82]
    "n&apos;y répond pas",                            # garde [82]
)
for g in GARDES:
    if g not in nouveau:
        print(f"ÉCHEC : chaîne de garde absente du fichier assemblé : {g!r}")
        sys.exit(1)

FIC.write_text(nouveau, encoding="utf-8")
print(f"OK — {FIC} réécrit : {len(lignes)} lignes → {len(nouveau.splitlines())} lignes")
print("Feuilles : AgentMotorEnTete (pastille/fil/cause/actions), AgentMotorBlocs (notes/problème/fil live), AgentMotorReplis (autre poste/historique/documents)")
