#!/usr/bin/env python3
"""Chantier CRAP vague 6 UI, 2026-11-25 — Composer (CC 110) → 7 feuilles VERBATIM.

Coupes ANCRÉES (chaque borne est vérifiée par son contenu avant écriture),
corps déplacés VERBATIM : aucune ligne de JSX ni de handler modifiée — les
closures deviennent des props typées du même nom. La structure DOM (mêmes
nœuds, même ordre) et l'API publique de Composer sont inchangées.

Feuilles (dans le même fichier, appelées dans l'ordre du rendu) :
  ComposerRecouvrement — l'indicateur de dépôt du glisser-déposer ;
  ComposerSlash        — le menu des commandes slash ;
  ComposerPuces        — les puces des pièces jointes en attente ;
  ComposerSaisie       — la rangée de saisie : trombone, textarea (raccourcis
                         clavier, coller), dictée, boutons stop / envoi bloqué
                         / envoi ;
  ComposerBarre        — la barre inférieure : mode, modèle, recherche web,
                         bouclier des autorisations, jauge de contexte ;
  ComposerAlertes      — le bandeau « toutes permissions » et l'AlertDialog
                         de confirmation ;
  ComposerPied         — l'erreur de dictée et la ligne de pied de page.

Tout l'état reste dans l'orchestrateur (Composer) : brouillons persistants,
dictée, slash, jauge, contexte, submit. Les refs (textarea, file input)
restent à l'orchestrateur et descendent en props (convention RefObject du
repo, cf. use-conversations.ts).
"""
import sys
from pathlib import Path

FIC = Path("src/components/chat/composer.tsx")

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
ancre(1, "// Barre de saisie façon ChatGPT : textarea auto-redimensionnable,")
ancre(6, 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";')
ancre(59, "interface ComposerProps {")
ancre(109, "function draftStorageKey(draftKey: string): string {")
ancre(113, "export function Composer({")
ancre(143, "}: ComposerProps) {")
ancre(144, '  const [value, setValue] = useState("");')
ancre(297, "  const ready = pending.filter((p) => p.uploaded);")
ancre(330, "  const submit = () => {")
ancre(350, "  };")
ancre(352, "  return (")
ancre(353, '    <div className="mx-auto w-full max-w-3xl px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">')
ancre(354, "      <div")
ancre(380, "      >")
ancre(381, "        {/* Indicateur de dépôt */}")
ancre(382, "        {dragOver ? (")
ancre(388, "        ) : null}")
ancre(390, "        {/* Suggestions de commandes slash */}")
ancre(391, "        {showSlash ? (")
ancre(393, "        ) : null}")
ancre(395, "        {/* Puces des pièces jointes en attente */}")
ancre(396, "        {pending.length > 0 ? (")
ancre(411, "        ) : null}")
ancre(413, '        <div className="flex items-end gap-1.5 px-3 py-2.5 sm:px-4">')
ancre(549, "        </div>")
ancre(551, "        {/* Barre inférieure : modèle · aide clavier · bouclier · jauge.")
ancre(554, '        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 sm:px-4">')
ancre(627, "          </div>")
ancre(628, '          <div className="flex items-center gap-1.5">')
ancre(677, "          </div>")
ancre(678, "        </div>")
ancre(679, "      </div>")
ancre(681, "      {/* Bandeau « toutes permissions » : le signal survit au scroll et à l'oubli */}")
ancre(682, '      {mode === "gateway" && permissionsMode === "auto" ? (')
ancre(697, "      ) : null}")
ancre(699, "      {/* Armement explicite, jamais silencieux */}")
ancre(700, "      <AlertDialog open={permDialogOpen} onOpenChange={setPermDialogOpen}>")
ancre(722, "      </AlertDialog>")
ancre(723, "      {dictation.error ? (")
ancre(727, "      ) : null}")
ancre(728, '      <p className="mt-2 text-center text-[11px] text-muted-foreground">')
ancre(731, "      </p>")
ancre(732, "    </div>")
ancre(733, "  );")
ancre(734, "}")
ancre(736, "function secondsLabel(s: number): string {")
ancre(740, "}")

# ── 1. Morceaux VERBATIM (bornes ancrées) ────────────────────────────────
REC     = morceau(381, 388)   # indicateur de dépôt
SLASH   = morceau(390, 393)   # menu des commandes slash
PUCES   = morceau(395, 411)   # puces des pièces jointes
SAISIE  = morceau(413, 549)   # rangée de saisie (input, trombone, textarea, micro, envoi)
BARRE   = morceau(551, 678)   # barre inférieure (mode, modèle, web, bouclier, jauge)
ALERTES = morceau(681, 722)   # bandeau « toutes permissions » + AlertDialog
PIED    = morceau(723, 731)   # erreur de dictée + pied de page

# ── 2. Glue : note de découpage, interfaces props, feuilles ─────────────
NOTE_DECOUPE = """// ── Découpage en feuilles (chantier CRAP vague 6 UI, 2026-11-25) ────────
// Le composant Composer (CC 110 au crapper) est démonté : sept feuilles
// appelées dans l'ordre du rendu, corps déplacés VERBATIM (aucune ligne de
// JSX ni de handler modifiée — les closures deviennent des props typées du
// même nom), par chirurgie ancrée (ce script, versionné) :
//   ComposerRecouvrement — l'indicateur de dépôt du glisser-déposer ;
//   ComposerSlash        — le menu des commandes slash ;
//   ComposerPuces        — les puces des pièces jointes en attente ;
//   ComposerSaisie       — la rangée de saisie : trombone, textarea (raccourcis
//                          clavier, coller), dictée, boutons stop / envoi
//                          bloqué / envoi ;
//   ComposerBarre        — la barre inférieure : mode, modèle, recherche web,
//                          bouclier des autorisations, jauge de contexte ;
//   ComposerAlertes      — le bandeau « toutes permissions » et l'AlertDialog
//                          de confirmation ;
//   ComposerPied         — l'erreur de dictée et la ligne de pied de page.
// Tout l'état reste dans l'orchestrateur (Composer) : brouillons persistants,
// dictée, slash, jauge de contexte, submit. Les refs (textarea, file input)
// restent à l'orchestrateur et descendent en props (convention RefObject du
// repo, cf. use-conversations.ts). Structure DOM inchangée (mêmes nœuds dans
// le même ordre) ; props publiques de Composer inchangées. Les feuilles à
// plusieurs enfants racine (un commentaire JSX compte comme un enfant) sont
// enveloppées dans un fragment — aucun nœud DOM ajouté.

"""

REC_DOC = """/** Feuille 1 — l'indicateur de dépôt du glisser-déposer. Corps déplacé
 *  VERBATIM de l'orchestrateur (chantier CRAP vague 6 UI, 2026-11-25). */
interface ComposerRecouvrementProps {
  dragOver: boolean;
}

function ComposerRecouvrement({ dragOver }: ComposerRecouvrementProps) {
  return (
    <>
"""
REC_FIN = """    </>
  );
}

"""

SLASH_DOC = """/** Feuille 2 — le menu des commandes slash. Corps déplacé VERBATIM de
 *  l'orchestrateur (chantier CRAP vague 6 UI, 2026-11-25) ; les matches et
 *  la sélection clavier restent calculés côté parent. */
interface ComposerSlashProps {
  showSlash: boolean;
  slashMatches: PromptTemplate[];
  slashIndex: number;
  applyPrompt: (tpl: PromptTemplate) => void;
}

function ComposerSlash({
  showSlash,
  slashMatches,
  slashIndex,
  applyPrompt,
}: ComposerSlashProps) {
  return (
    <>
"""
SLASH_FIN = """    </>
  );
}

"""

PUCES_DOC = """/** Feuille 3 — les puces des pièces jointes en attente. Corps déplacé
 *  VERBATIM de l'orchestrateur (chantier CRAP vague 6 UI, 2026-11-25) ;
 *  l'état des pièces jointes reste au hook useComposerAttachments (parent). */
interface ComposerPucesProps {
  pending: PendingAttachment[];
  removePending: (localId: string) => void;
}

function ComposerPuces({ pending, removePending }: ComposerPucesProps) {
  return (
    <>
"""
PUCES_FIN = """    </>
  );
}

"""

SAISIE_DOC = """/** Feuille 4 — la rangée de saisie : trombone, textarea (raccourcis clavier
 *  du menu slash, Entrée = envoi, coller), dictée vocale, boutons stop /
 *  envoi bloqué / envoi. Corps déplacé VERBATIM de l'orchestrateur (chantier
 *  CRAP vague 6 UI, 2026-11-25) ; les refs restent au parent et descendent
 *  en props (convention RefObject du repo). */
interface ComposerSaisieProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  addFiles: ReturnType<typeof useComposerAttachments>["addFiles"];
  disabled: boolean;
  pending: PendingAttachment[];
  value: string;
  setSlashDismissed: Dispatch<SetStateAction<boolean>>;
  setValue: Dispatch<SetStateAction<string>>;
  showSlash: boolean;
  slashMatches: PromptTemplate[];
  slashIndex: number;
  setSlashIndex: Dispatch<SetStateAction<number>>;
  applyPrompt: (tpl: PromptTemplate) => void;
  dictation: ReturnType<typeof useDictation>;
  isBusy: boolean;
  onStop: () => void;
  uploading: boolean;
  hasBlocking: boolean;
  submit: () => void;
  canSend: boolean;
}

function ComposerSaisie({
  textareaRef,
  fileInputRef,
  addFiles,
  disabled,
  pending,
  value,
  setSlashDismissed,
  setValue,
  showSlash,
  slashMatches,
  slashIndex,
  setSlashIndex,
  applyPrompt,
  dictation,
  isBusy,
  onStop,
  uploading,
  hasBlocking,
  submit,
  canSend,
}: ComposerSaisieProps) {
  return (
"""
SAISIE_FIN = """  );
}

"""

BARRE_DOC = """/** Feuille 5 — la barre inférieure : sélecteurs de mode et de modèle,
 *  recherche web (F-09/F-12), bouclier des autorisations, jauge de contexte.
 *  Ordre immuable du groupe de droite — la jauge reste l'élément le plus à
 *  droite. Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP vague 6
 *  UI, 2026-11-25). */
interface ComposerBarreProps {
  conversationMode: ConversationMode;
  conversationModeConfig: ModeConfig | null;
  onSetConversationMode: (mode: ConversationMode, config: ModeConfig) => void;
  models: ModelOption[];
  disabled: boolean;
  isBusy: boolean;
  selectedModel: string | null;
  modelsSource: ComposerProps["modelsSource"];
  mode: GatewayMode | null;
  onSelectModel: (id: string) => void;
  effort: string | null;
  onEffortChange: (effort: string) => void;
  expert?: ExpertSettings;
  onExpertChange?: (patch: Partial<ExpertSettings>) => void;
  webSearch: boolean;
  onToggleWebSearch: () => void;
  webSearchAvailable: boolean;
  permissionsMode: PermissionsMode;
  onPermissionsChange: (mode: PermissionsMode) => void;
  setPermDialogOpen: Dispatch<SetStateAction<boolean>>;
  gaugeVisible: boolean;
  contextUsage: ContextUsage | null;
  contextBase: ComposerProps["contextBase"];
  canCompact: boolean;
  compactRunning: boolean;
  onCompact: () => void;
  onNewSession: () => void;
}

function ComposerBarre({
  conversationMode,
  conversationModeConfig,
  onSetConversationMode,
  models,
  disabled,
  isBusy,
  selectedModel,
  modelsSource,
  mode,
  onSelectModel,
  effort,
  onEffortChange,
  expert,
  onExpertChange,
  webSearch,
  onToggleWebSearch,
  webSearchAvailable,
  permissionsMode,
  onPermissionsChange,
  setPermDialogOpen,
  gaugeVisible,
  contextUsage,
  contextBase,
  canCompact,
  compactRunning,
  onCompact,
  onNewSession,
}: ComposerBarreProps) {
  return (
    <>
"""
BARRE_FIN = """    </>
  );
}

"""

ALERTES_DOC = """/** Feuille 6 — le bandeau « toutes permissions » (le signal survit au
 *  scroll et à l'oubli) et l'AlertDialog de confirmation. Corps déplacé
 *  VERBATIM de l'orchestrateur (chantier CRAP vague 6 UI, 2026-11-25). */
interface ComposerAlertesProps {
  mode: GatewayMode | null;
  permissionsMode: PermissionsMode;
  onPermissionsChange: (mode: PermissionsMode) => void;
  permDialogOpen: boolean;
  setPermDialogOpen: Dispatch<SetStateAction<boolean>>;
}

function ComposerAlertes({
  mode,
  permissionsMode,
  onPermissionsChange,
  permDialogOpen,
  setPermDialogOpen,
}: ComposerAlertesProps) {
  return (
    <>
"""
ALERTES_FIN = """    </>
  );
}

"""

PIED_DOC = """/** Feuille 7 — l'erreur de dictée (role="alert") et la ligne de pied de
 *  page. Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP vague 6
 *  UI, 2026-11-25). */
interface ComposerPiedProps {
  dictation: ReturnType<typeof useDictation>;
}

function ComposerPied({ dictation }: ComposerPiedProps) {
  return (
    <>
"""
PIED_FIN = """    </>
  );
}

"""

# ── 3. Appels des feuilles dans l'orchestrateur (ordre du rendu) ─────────
APPELS = """        <ComposerRecouvrement dragOver={dragOver} />

        <ComposerSlash
          showSlash={showSlash}
          slashMatches={slashMatches}
          slashIndex={slashIndex}
          applyPrompt={applyPrompt}
        />

        <ComposerPuces pending={pending} removePending={removePending} />

        <ComposerSaisie
          textareaRef={textareaRef}
          fileInputRef={fileInputRef}
          addFiles={addFiles}
          disabled={disabled}
          pending={pending}
          value={value}
          setSlashDismissed={setSlashDismissed}
          setValue={setValue}
          showSlash={showSlash}
          slashMatches={slashMatches}
          slashIndex={slashIndex}
          setSlashIndex={setSlashIndex}
          applyPrompt={applyPrompt}
          dictation={dictation}
          isBusy={isBusy}
          onStop={onStop}
          uploading={uploading}
          hasBlocking={hasBlocking}
          submit={submit}
          canSend={canSend}
        />

        <ComposerBarre
          conversationMode={conversationMode}
          conversationModeConfig={conversationModeConfig}
          onSetConversationMode={onSetConversationMode}
          models={models}
          disabled={disabled}
          isBusy={isBusy}
          selectedModel={selectedModel}
          modelsSource={modelsSource}
          mode={mode}
          onSelectModel={onSelectModel}
          effort={effort}
          onEffortChange={onEffortChange}
          expert={expert}
          onExpertChange={onExpertChange}
          webSearch={webSearch}
          onToggleWebSearch={onToggleWebSearch}
          webSearchAvailable={webSearchAvailable}
          permissionsMode={permissionsMode}
          onPermissionsChange={onPermissionsChange}
          setPermDialogOpen={setPermDialogOpen}
          gaugeVisible={gaugeVisible}
          contextUsage={contextUsage}
          contextBase={contextBase}
          canCompact={canCompact}
          compactRunning={compactRunning}
          onCompact={onCompact}
          onNewSession={onNewSession}
        />
      </div>

      <ComposerAlertes
        mode={mode}
        permissionsMode={permissionsMode}
        onPermissionsChange={onPermissionsChange}
        permDialogOpen={permDialogOpen}
        setPermDialogOpen={setPermDialogOpen}
      />

      <ComposerPied dictation={dictation} />
"""

# ── 4. Assemblage ────────────────────────────────────────────────────────
# En-tête (1-112) verbatim ; l'import react reçoit les types de props
# (Dispatch / SetStateAction / RefObject) et l'import tokens le type
# ContextUsage — mêmes conventions que use-conversations.ts / tokens.ts.
teten = "".join(morceau(1, 112))
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
teten = teten.replace(
    "  type ContextRow,\n} from \"@/lib/tokens\";",
    "  type ContextRow,\n  type ContextUsage,\n} from \"@/lib/tokens\";",
)

# Corps du parent : signature → états → effets → memos → submit → return.
PARENT = (
    "".join(morceau(113, 351))   # signature + état + effets + slash + canSend + contextUsage + submit
    + "".join(morceau(352, 380)) # return + div extérieur + conteneur drag & drop
    + APPELS                     # les sept feuilles, dans l'ordre du rendu
    + "".join(morceau(732, 740)) # /div extérieur + ); + } + secondsLabel
)

NOUVEAU = (
    teten
    + NOTE_DECOUPE
    + REC_DOC + "".join(REC) + REC_FIN
    + SLASH_DOC + "".join(SLASH) + SLASH_FIN
    + PUCES_DOC + "".join(PUCES) + PUCES_FIN
    + SAISIE_DOC + "".join(SAISIE) + SAISIE_FIN
    + BARRE_DOC + "".join(BARRE) + BARRE_FIN
    + ALERTES_DOC + "".join(ALERTES) + ALERTES_FIN
    + PIED_DOC + "".join(PIED) + PIED_FIN
    + PARENT
)

# ── 5. Vérifications AVANT écriture ──────────────────────────────────────
if "type Dispatch," not in teten or "type RefObject," not in teten:
    print("ÉCHEC : patch import react non appliqué")
    sys.exit(1)
if "type ContextUsage," not in teten:
    print("ÉCHEC : patch import tokens (ContextUsage) non appliqué")
    sys.exit(1)

GARDES = (
    "Déposez vos fichiers pour les joindre",            # recouvrement
    "Envoyer un message à Hermes… (/ pour les commandes)",  # placeholder
    "Arrêter la génération",                           # bouton stop
    "Envoyer le message",                              # bouton envoi
    "Recherche web : ajoutez une clé Tavily ou Exa",   # infobulle recherche
    "Autorisations de l'agent : actives quand le moteur Hermes est lancé",
    "Mode toutes permissions actif",                   # bandeau
    "Autoriser toutes les actions ?",                  # AlertDialog
    "Hermes Web · images, audio, vidéo et PDF acceptés",  # pied de page
    "Ordre immuable du groupe de droite",              # commentaire barre
)
for g in GARDES:
    if g not in NOUVEAU:
        print(f"ÉCHEC : chaîne de garde absente du fichier assemblé : {g!r}")
        sys.exit(1)

COMPTEURS = (
    ("<SlashMenu", 1),              # usages JSX
    ("<PendingAttachmentChip", 1),
    ("<textarea", 1),
    ("<input", 1),
    ("<ModePicker", 1),
    ("<ModelPicker", 1),
    ("<ContextGauge", 1),
    ("<AlertDialogContent", 1),
    ("export function Composer", 1),
    ("function secondsLabel", 1),
    ("interface ComposerProps", 1),
)
for nom, attendu in COMPTEURS:
    reel = NOUVEAU.count(nom)
    if reel != attendu:
        print(f"ÉCHEC : compteur {nom!r} : attendu {attendu}, réel {reel}")
        sys.exit(1)

for feuille in ("ComposerRecouvrement", "ComposerSlash", "ComposerPuces",
                "ComposerSaisie", "ComposerBarre", "ComposerAlertes", "ComposerPied"):
    if f"function {feuille}(" not in NOUVEAU:
        print(f"ÉCHEC : feuille {feuille} absente (définition)")
        sys.exit(1)
    if f"<{feuille}" not in NOUVEAU:
        print(f"ÉCHEC : feuille {feuille} absente (usage)")
        sys.exit(1)

# Chaque morceau déplacé doit apparaître dans l'assemblage — à
# l'indentation d'origine (aucun dédent ici : feuilles JSX contiguës).
for nom, chunk in (
    ("REC", REC), ("SLASH", SLASH), ("PUCES", PUCES), ("SAISIE", SAISIE),
    ("BARRE", BARRE), ("ALERTES", ALERTES), ("PIED", PIED),
):
    if "".join(chunk) not in NOUVEAU:
        print(f"ÉCHEC : morceau {nom} non retrouvé à l'identique dans l'assemblage")
        sys.exit(1)

# Le corps de l'orchestrateur (état + effets + submit) est intact : les
# plages 113-351, 352-380 et 732-740 doivent figurer mot pour mot.
for nom, debut, fin in (
    ("PARENT-LOGIQUE", 113, 351),
    ("PARENT-RENDU", 352, 380),
    ("PARENT-PIED", 732, 740),
):
    if "".join(morceau(debut, fin)) not in NOUVEAU:
        print(f"ÉCHEC : plage parente {nom} ({debut}-{fin}) altérée dans l'assemblage")
        sys.exit(1)

FIC.write_text(NOUVEAU, encoding="utf-8")
print(f"OK — {FIC} réécrit : {len(lignes)} lignes → {len(NOUVEAU.splitlines())} lignes")
print("Feuilles : ComposerRecouvrement (%d l.), ComposerSlash (%d l.), ComposerPuces (%d l.), ComposerSaisie (%d l.), ComposerBarre (%d l.), ComposerAlertes (%d l.), ComposerPied (%d l.)" % (
    len(REC), len(SLASH), len(PUCES), len(SAISIE), len(BARRE), len(ALERTES), len(PIED)))
deplacees = sum(len(c) for c in (REC, SLASH, PUCES, SAISIE, BARRE, ALERTES, PIED))
print(f"Lignes déplacées VERBATIM : {deplacees}")
