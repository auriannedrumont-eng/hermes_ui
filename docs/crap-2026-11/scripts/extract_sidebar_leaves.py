#!/usr/bin/env python3
"""Chantier CRAP vague 5, 2026-11-25 — Sidebar (CC 138) → 5 feuilles + 2 algorithmes purs.

Coupes ANCRÉES (chaque borne est vérifiée par son contenu avant écriture),
corps déplacés VERBATIM : aucune ligne de JSX ni de handler modifiée — les
closures deviennent des props typées du même nom. La structure DOM (mêmes
nœuds, même ordre) et l'API publique de Sidebar sont inchangées.

Feuilles (dans le même fichier, appelées dans l'ordre du rendu) :
  SidebarRecherche   — branche « recherche » : arbre filtré, groupes de dates,
                       hits « Dans les messages » ;
  SidebarDossiers    — branche « avec dossiers » : arbre ProjectGroup, « Sans
                       dossier », Archives (F-60), dialogue de lien disque ;
  SidebarHistorique  — branche « sans dossier » : épinglées + groupes de dates ;
  SidebarStatut      — la carte de statut du moteur (voyant, libellé, entrée
                       des paramètres) ;
  SidebarDialogues   — les deux gardes de destruction (C5.1).

Algorithmes de module PURES (sortis du composant) :
  foldAccents         — normalisation NFD (déjà pure, monte au niveau module) ;
  computeSearchTree   — l'arbre filtré de la recherche (le memo appelle) ;
  reorderProjectsFlat — la liste plate du réordonnancement F-59 (frères
                        uniquement) ; retourne null si rien à faire, même
                        comportement que les `return` early d'origine.

Tout l'état reste dans l'orchestrateur (Sidebar). Les trois feuilles de
branche sont montées en exclusivité mutuelle (comme le JSX d'origine) ;
Statut et Dialogues sont montées en continu — même durée de vie.
"""
import sys
from pathlib import Path

FIC = Path("src/components/chat/sidebar.tsx")

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

def dedent(chunk: list[str], n: int) -> list[str]:
    """Retire n espaces de tête à chaque ligne (blancs préservés)."""
    out = []
    for l in chunk:
        if l.startswith(" " * n):
            out.append(l[n:])
        else:
            out.append(l)
    return out

# ── 0. Ancres : chaque borne est vérifiée AVANT toute écriture ──────────
ancre(9, 'import { useEffect, useMemo, useState } from "react";')
ancre(97, "function groupLabel(iso: string): string {")
ancre(113, 'const SEARCH_EMPTY_SET: Set<string> = new Set();')
ancre(115, "export function Sidebar({")
ancre(137, "}: SidebarProps) {")
ancre(217, "  const q = query.trim();")
ancre(219, "  const hasProjects = projects.length > 0;")
ancre(275, '  // Recherche insensible aux ACCENTS (revue 95) : « reunion » doit trouver')
ancre(276, '  // « Réunion » — normalisation NFD + retrait des diacritiques des deux côtés.')
ancre(277, "  const foldAccents = (s: string): string =>")
ancre(278, '    s.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase();')
ancre(299, "  // Recherche : arbre filtré — un dossier est visible si son nom correspond")
ancre(303, "  const searchTree = useMemo(() => {")
ancre(304, "    if (!isSearching || !hasProjects) return [];")
ancre(305, "    const ql = foldAccents(q);")
ancre(306, "    const matchConv = (c: ConversationMeta) =>")
ancre(332, "    return nodes;")
ancre(333, "  }, [isSearching, hasProjects, q, projects, conversationsByProject]);")
ancre(455, "  const handleDragEnd = (event: DragEndEvent) => {")
ancre(470, '    } else if (a.type === "project" && a.id && o.projectId) {')
ancre(475, "      const draggedId: string = a.id;")
ancre(476, "      const targetId: string = o.projectId;")
ancre(477, "      if (targetId === draggedId) return;")
ancre(483, "      const reorderSegment = (list: Project[]) => {")
ancre(492, "      const roots = projects")
ancre(507, "      const flat: string[] = [];")
ancre(512, "      onReorderProjects(flat);")
ancre(513, "    }")
ancre(514, "  };")
ancre(516, "  const itemProps = {")
ancre(528, "  return (")
ancre(529, '    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">')
ancre(560, "      {/* Historique */}")
ancre(571, "        >")
ancre(572, "          {isSearching ? (")
ancre(573, "            <>")
ancre(689, "            </>")
ancre(690, "          ) : hasProjects ? (")
ancre(691, "            <>")
ancre(826, "            </>")
ancre(827, "          ) : conversations.length === 0 ? (")
ancre(831, "          ) : (")
ancre(832, "            <>")
ancre(877, "            </>")
ancre(878, "          )}")
ancre(879, "        </nav>")
ancre(895, "      {/* Carte de statut du moteur — voyant d'état (§9 (62)) : une seule")
ancre(900, '      <div className="border-t border-sidebar-border p-3">')
ancre(967, "      </div>")
ancre(969, "      {/* Gardes de destruction (C5.1) — une seule façon de confirmer */}")
ancre(970, "      <ConfirmDestructiveDialog")
ancre(1017, "      />")
ancre(1018, "    </div>")
ancre(1019, "  );")
ancre(1020, "}")

# ── 1. Morceaux VERBATIM (bornes ancrées) ────────────────────────────────
SEARCH    = morceau(573, 689)   # branche « recherche » (fragment)
DOSSIERS  = morceau(691, 826)   # branche « avec dossiers » (fragment)
HISTO     = morceau(832, 877)   # branche « sans dossier » (fragment)
STATUT    = morceau(900, 967)   # carte de statut (div racine)
DIALOGUES = morceau(969, 1017)  # commentaire + les deux dialogues
FOLD      = morceau(275, 278)   # commentaire + foldAccents (déjà pur)
ST_BODY   = morceau(305, 332)   # corps du memo searchTree (après la garde)
COMMENT_ST = morceau(299, 302)  # commentaire de l'arbre filtré (reste au parent)
REORD_COMMENT = morceau(471, 474)  # commentaire du réordonnancement (reste au parent)
DRAGEND_HEAD  = morceau(455, 469)  # handleDragEnd jusqu'à la branche conversation
SEG       = morceau(483, 491)   # reorderSegment (corps verbatim)
REORD     = morceau(492, 511)   # roots/rootIds/childrenOrder/flat (verbatim)

# ── 2. Glue : note de découpage, helpers de module, feuilles ────────────
NOTE_DECOUPE = """// ── Découpage en feuilles (chantier CRAP vague 5, 2026-11-25) ───────────
// Le composant Sidebar (CC 138 au crapper) est démonté : cinq feuilles
// appelées dans l'ordre du rendu, corps déplacés VERBATIM (aucune ligne de
// JSX ni de handler modifiée — les closures deviennent des props typées du
// même nom), par chirurgie ancrée (ce script, versionné) :
//   SidebarRecherche   — la branche « recherche » : arbre des dossiers
//                        filtré, groupes de dates « Sans dossier », hits
//                        « Dans les messages » ;
//   SidebarDossiers    — la branche « avec dossiers » : arbre ProjectGroup,
//                        « Sans dossier », Archives (F-60), dialogue de
//                        lien disque ;
//   SidebarHistorique  — la branche « sans dossier » : épinglées puis
//                        groupes de dates ;
//   SidebarStatut      — la carte de statut du moteur (voyant, libellé,
//                        entrée unique des paramètres) ;
//   SidebarDialogues   — les deux gardes de destruction (C5.1).
// Deux algorithmes sortent en fonctions de module PURES :
//   computeSearchTree   — l'arbre filtré de la recherche (le memo appelle) ;
//   reorderProjectsFlat — la liste plate du réordonnancement F-59 (frères
//                         uniquement) ; retourne null si rien à faire, même
//                         comportement que les retours early d'origine.
// Tout l'état reste dans l'orchestrateur (Sidebar) ; les feuilles de branche
// sont montées en exclusivité mutuelle (comme le JSX d'origine), Statut et
// Dialogues en continu — même durée de vie. Structure DOM inchangée (mêmes
// nœuds dans le même ordre) ; props publiques de Sidebar inchangées.
"""

FOLD_MODULE = """// Recherche insensible aux ACCENTS (revue 95) : « reunion » doit trouver
// « Réunion » — normalisation NFD + retrait des diacritiques des deux côtés.
// (vague 5 : monte au niveau module — pure, utilisée par computeSearchTree
// et par le filtre « conversationsOf » de la recherche.)
""" + "".join(dedent(FOLD, 2)) + "\n"

SEARCHTREE_MODULE = """interface SearchTreeNode {
  project: Project;
  convs: ConversationMeta[];
  subs: { project: Project; convs: ConversationMeta[] }[];
}

/** Arbre filtré de la recherche : un dossier racine est visible si son nom
 *  correspond ou s'il contient (directement ou via un sous-dossier) des
 *  conversations visibles ; tout est déplié (maquette v6). Les dossiers
 *  ARCHIVÉS (F-60) sont hors de la recherche : ils vivent dans les
 *  Archives. Corps déplacé VERBATIM du memo (chantier CRAP vague 5,
 *  2026-11-25) — la garde isSearching/hasProjects reste au parent. */
function computeSearchTree(
  q: string,
  projects: Project[],
  conversationsByProject: Map<string, ConversationMeta[]>
): SearchTreeNode[] {
""" + "".join(dedent(ST_BODY, 2)) + """}

"""

REORDER_MODULE = """/** Réordonnancement F-59 : liste plate reconstruite depuis l'arbre courant
 *  (positions globales conservées pour tout ce qui n'a pas bougé), entre
 *  FRÈRES uniquement (cas limite plan §6.1). Corps déplacé VERBATIM du
 *  handler (chantier CRAP vague 5, 2026-11-25) — les retours early
 *  d'origine (« rien à faire ») deviennent `return null`, le handler
 *  n'appelle onReorderProjects que si la liste est construite. */
function reorderProjectsFlat(
  projects: Project[],
  draggedId: string,
  targetId: string
): string[] | null {
  if (targetId === draggedId) return null;
  const dragged = projects.find((p) => p.id === draggedId);
  const target = projects.find((p) => p.id === targetId);
  if (!dragged || !target) return null;
  if ((dragged.parentId ?? null) !== (target.parentId ?? null)) return null;
  const parentId = dragged.parentId ?? null;
""" + "".join(dedent(SEG, 6)) + "".join(dedent(REORD, 6)) + """  return flat;
}

"""

RECHERCHE_DOC = """/** Feuille 1 — la branche « recherche » de l'historique : l'arbre des
 *  dossiers filtré, les groupes de dates des conversations « Sans dossier »
 *  et les hits « Dans les messages ». Corps déplacé VERBATIM de
 *  l'orchestrateur (chantier CRAP vague 5, 2026-11-25) ; les valeurs
 *  dérivées (searchTree, searchGroups) restent calculées côté parent. */
interface SidebarRechercheProps {
  hasProjects: boolean;
  searchTree: SearchTreeNode[];
  searchSubControls: SubControls;
  activeId: string | null;
  shared: ConvItemShared;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setRenamingId: Dispatch<SetStateAction<string | null>>;
  setRenamingProjectId: Dispatch<SetStateAction<string | null>>;
  setProjectRenameValue: Dispatch<SetStateAction<string>>;
  renamingProjectId: string | null;
  projectRenameValue: string;
  commitProjectRename: () => void;
  handleDeleteProject: (p: Project) => void;
  onSetProjectArchived: (id: string, archived: boolean) => void;
  onNew: (projectId?: string | null) => void;
  onCreateProject: (
    name: string,
    parentId?: string | null,
    diskPath?: string | null
  ) => Promise<Project | null>;
  searchGroups: [string, ConversationMeta[]][];
  onOpen: (id: string) => void;
  messageHits: SearchHit[];
  searching: boolean;
  itemProps: ConvItemShared;
}

function SidebarRecherche({
  hasProjects,
  searchTree,
  searchSubControls,
  activeId,
  shared,
  renamingId,
  renameValue,
  setRenameValue,
  setRenamingId,
  setRenamingProjectId,
  setProjectRenameValue,
  renamingProjectId,
  projectRenameValue,
  commitProjectRename,
  handleDeleteProject,
  onSetProjectArchived,
  onNew,
  onCreateProject,
  searchGroups,
  onOpen,
  messageHits,
  searching,
  itemProps,
}: SidebarRechercheProps) {
  return (
"""
RECHERCHE_FIN = """  );
}

"""

DOSSIERS_DOC = """/** Feuille 2 — la branche « avec dossiers » : l'arbre des ProjectGroup
 *  (racines → sous-dossiers, un niveau), la section « Sans dossier » avec
 *  sa zone de dépôt, les Archives (F-60) et le dialogue de lien disque.
 *  Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP vague 5,
 *  2026-11-25). */
interface SidebarDossiersProps {
  projectTree: ProjectNode[];
  conversationsByProject: Map<string, ConversationMeta[]>;
  subControls: SubControls;
  activeId: string | null;
  collapsedProjects: Set<string>;
  toggleProjectCollapsed: (id: string) => void;
  shared: ConvItemShared;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setRenamingId: Dispatch<SetStateAction<string | null>>;
  setRenamingProjectId: Dispatch<SetStateAction<string | null>>;
  setProjectRenameValue: Dispatch<SetStateAction<string>>;
  renamingProjectId: string | null;
  projectRenameValue: string;
  commitProjectRename: () => void;
  handleDeleteProject: (p: Project) => void;
  onNew: (projectId?: string | null) => void;
  onSetProjectArchived: (id: string, archived: boolean) => void;
  onCreateProject: (
    name: string,
    parentId?: string | null,
    diskPath?: string | null
  ) => Promise<Project | null>;
  setAttachDiskOpen: Dispatch<SetStateAction<boolean>>;
  unprojected: ConversationMeta[];
  dateGroups: [string, ConversationMeta[]][];
  itemProps: ConvItemShared;
  archivedProjects: Project[];
  archivesCollapsed: boolean;
  toggleArchivesCollapsed: () => void;
  attachDiskOpen: boolean;
  projects: Project[];
  pinned: ConversationMeta[];
  conversations: ConversationMeta[];
}

function SidebarDossiers({
  projectTree,
  conversationsByProject,
  subControls,
  activeId,
  collapsedProjects,
  toggleProjectCollapsed,
  shared,
  renamingId,
  renameValue,
  setRenameValue,
  setRenamingId,
  setRenamingProjectId,
  setProjectRenameValue,
  renamingProjectId,
  projectRenameValue,
  commitProjectRename,
  handleDeleteProject,
  onNew,
  onSetProjectArchived,
  onCreateProject,
  setAttachDiskOpen,
  unprojected,
  dateGroups,
  itemProps,
  archivedProjects,
  archivesCollapsed,
  toggleArchivesCollapsed,
  attachDiskOpen,
  projects,
  pinned,
  conversations,
}: SidebarDossiersProps) {
  return (
"""
DOSSIERS_FIN = """  );
}

"""

HISTO_DOC = """/** Feuille 3 — la branche « sans dossier » : épinglées puis groupes de
 *  dates. Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP vague 5,
 *  2026-11-25) ; l'état « Pas encore de conversation. » reste la branche
 *  du ternaire parent (a toujours existé hors de ce fragment). */
interface SidebarHistoriqueProps {
  pinned: ConversationMeta[];
  activeId: string | null;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setRenamingId: Dispatch<SetStateAction<string | null>>;
  itemProps: ConvItemShared;
  dateGroups: [string, ConversationMeta[]][];
}

function SidebarHistorique({
  pinned,
  activeId,
  renamingId,
  renameValue,
  setRenameValue,
  setRenamingId,
  itemProps,
  dateGroups,
}: SidebarHistoriqueProps) {
  return (
"""
HISTO_FIN = """  );
}

"""

STATUT_DOC = """/** Feuille 4 — la carte de statut du moteur : le voyant d'état, le
 *  libellé (« une seule question à l'écran », §9 (62)) et l'entrée unique
 *  des paramètres. Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP
 *  vague 5, 2026-11-25) ; la teinte de la carte PORTE l'état : vert = ça
 *  répond, ambre pulsant = il faut allumer Hermes, gris = hors ligne. */
interface SidebarStatutProps {
  connected: boolean;
  mode: GatewayMode | null;
  serverModel: string | null;
  updateAvailable: string | null;
  onOpenSettings: () => void;
}

function SidebarStatut({
  connected,
  mode,
  serverModel,
  updateAvailable,
  onOpenSettings,
}: SidebarStatutProps) {
  return (
"""
STATUT_FIN = """  );
}

"""

DIALOGUES_DOC = """/** Feuille 5 — les gardes de destruction (C5.1) : les deux dialogues de
 *  confirmation (conversation, dossier). Corps déplacé VERBATIM de
 *  l'orchestrateur (chantier CRAP vague 5, 2026-11-25) ; le décompte des
 *  conversations et sous-dossiers du dossier visé (F-59, cas limite plan
 *  §6.4) voyage avec les listes projects/conversations. */
interface SidebarDialoguesProps {
  deleteConvTarget: ConversationMeta | null;
  setDeleteConvTarget: Dispatch<SetStateAction<ConversationMeta | null>>;
  deleteProjectTarget: Project | null;
  setDeleteProjectTarget: Dispatch<SetStateAction<Project | null>>;
  onDelete: (id: string) => void;
  onDeleteProject: (id: string) => void;
  projects: Project[];
  conversations: ConversationMeta[];
}

function SidebarDialogues({
  deleteConvTarget,
  setDeleteConvTarget,
  deleteProjectTarget,
  setDeleteProjectTarget,
  onDelete,
  onDeleteProject,
  projects,
  conversations,
}: SidebarDialoguesProps) {
  return (
    <>
"""
DIALOGUES_FIN = """    </>
  );
}

"""

# ── 3. Corps du parent : memo searchTree compact + handleDragEnd + retour ─
NEW_MEMO = """  const searchTree = useMemo(() => {
    if (!isSearching || !hasProjects) return [];
    return computeSearchTree(q, projects, conversationsByProject);
  }, [isSearching, hasProjects, q, projects, conversationsByProject]);
"""

NEW_DRAGEND = (
    "".join(DRAGEND_HEAD)
    + "    } else if (a.type === \"project\" && a.id && o.projectId) {\n"
    + "".join(REORD_COMMENT)
    + "      // (vague 5) l'algorithme vit dans reorderProjectsFlat (module) :\n"
    + "      // mêmes gardes, même liste plate ; null = rien à faire.\n"
    + "      const flat = reorderProjectsFlat(projects, a.id, o.projectId);\n"
    + "      if (flat) onReorderProjects(flat);\n"
    + "    }\n"
    + "  };\n"
)

TERMINAIRE = """          {isSearching ? (
            <SidebarRecherche
              hasProjects={hasProjects}
              searchTree={searchTree}
              searchSubControls={searchSubControls}
              activeId={activeId}
              shared={shared}
              renamingId={renamingId}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              setRenamingId={setRenamingId}
              setRenamingProjectId={setRenamingProjectId}
              setProjectRenameValue={setProjectRenameValue}
              renamingProjectId={renamingProjectId}
              projectRenameValue={projectRenameValue}
              commitProjectRename={commitProjectRename}
              handleDeleteProject={handleDeleteProject}
              onSetProjectArchived={onSetProjectArchived}
              onNew={onNew}
              onCreateProject={onCreateProject}
              searchGroups={searchGroups}
              onOpen={onOpen}
              messageHits={messageHits}
              searching={searching}
              itemProps={itemProps}
            />
          ) : hasProjects ? (
            <SidebarDossiers
              projectTree={projectTree}
              conversationsByProject={conversationsByProject}
              subControls={subControls}
              activeId={activeId}
              collapsedProjects={collapsedProjects}
              toggleProjectCollapsed={toggleProjectCollapsed}
              shared={shared}
              renamingId={renamingId}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              setRenamingId={setRenamingId}
              setRenamingProjectId={setRenamingProjectId}
              setProjectRenameValue={setProjectRenameValue}
              renamingProjectId={renamingProjectId}
              projectRenameValue={projectRenameValue}
              commitProjectRename={commitProjectRename}
              handleDeleteProject={handleDeleteProject}
              onNew={onNew}
              onSetProjectArchived={onSetProjectArchived}
              onCreateProject={onCreateProject}
              setAttachDiskOpen={setAttachDiskOpen}
              unprojected={unprojected}
              dateGroups={dateGroups}
              itemProps={itemProps}
              archivedProjects={archivedProjects}
              archivesCollapsed={archivesCollapsed}
              toggleArchivesCollapsed={toggleArchivesCollapsed}
              attachDiskOpen={attachDiskOpen}
              projects={projects}
              pinned={pinned}
              conversations={conversations}
            />
          ) : conversations.length === 0 ? (
            <p className="px-2 pt-6 text-center text-[12.5px] text-muted-foreground">
              Pas encore de conversation.
            </p>
          ) : (
            <SidebarHistorique
              pinned={pinned}
              activeId={activeId}
              renamingId={renamingId}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              setRenamingId={setRenamingId}
              itemProps={itemProps}
              dateGroups={dateGroups}
            />
          )}
"""

PIED = """      <SidebarStatut
        connected={connected}
        mode={mode}
        serverModel={serverModel}
        updateAvailable={updateAvailable}
        onOpenSettings={onOpenSettings}
      />

      <SidebarDialogues
        deleteConvTarget={deleteConvTarget}
        setDeleteConvTarget={setDeleteConvTarget}
        deleteProjectTarget={deleteProjectTarget}
        setDeleteProjectTarget={setDeleteProjectTarget}
        onDelete={onDelete}
        onDeleteProject={onDeleteProject}
        projects={projects}
        conversations={conversations}
      />
"""

# ── 4. Assemblage ────────────────────────────────────────────────────────
# En-tête (1-9) verbatim ; l'import react (ligne 9) reçoit Dispatch / SetStateAction.
teten = "".join(lignes[0:9])
teten = teten.replace(
    'import { useEffect, useMemo, useState } from "react";',
    'import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";',
)

# Corps du parent : signature → états → effets → memos → handlers → retour.
PARENT = (
    "".join(morceau(115, 219))   # signature + états + effets + sensors + q/isSearching/hasProjects
    + "".join(morceau(221, 273)) # effet recherche + bySort + conversationsByProject + unprojected
    + "".join(morceau(280, 302)) # searchGroups + commentaire de l'arbre filtré
    + NEW_MEMO
    + "".join(morceau(335, 362)) # dateGroups + pinned + shared
    + "".join(morceau(364, 440)) # actions dossiers + memos arbre + subControls + searchSubControls
    + "".join(morceau(442, 453)) # commentaire dnd + handleDragStart
    + NEW_DRAGEND
    + "".join(morceau(516, 526)) # itemProps
    + "".join(morceau(528, 571)) # return + racine + marque + recherche + DndContext + nav
    + TERMINAIRE
    + "".join(morceau(879, 899)) # /nav + DragOverlay + /DndContext + commentaire carte
    + PIED
    + "".join(morceau(1018, 1020))  # /div racine + ); + }
)

NOUVEAU = (
    teten
    + "".join(morceau(10, 113))
    + "\n" + NOTE_DECOUPE
    + FOLD_MODULE
    + SEARCHTREE_MODULE
    + REORDER_MODULE
    + RECHERCHE_DOC + "".join(SEARCH) + RECHERCHE_FIN
    + DOSSIERS_DOC + "".join(DOSSIERS) + DOSSIERS_FIN
    + HISTO_DOC + "".join(HISTO) + HISTO_FIN
    + STATUT_DOC + "".join(STATUT) + STATUT_FIN
    + DIALOGUES_DOC + "".join(DIALOGUES) + DIALOGUES_FIN
    + PARENT
)

# ── 5. Vérifications AVANT écriture ──────────────────────────────────────
if "type Dispatch" not in teten:
    print("ÉCHEC : patch import react non appliqué")
    sys.exit(1)

GARDES = (
    "Hermes branché",                                  # carte de statut
    "Pas encore de conversation.",                     # deux états vides
    "Aucun dossier — utilisez",                        # hint lien disque
    "Dans les messages",                               # section hits
    "Gardes de destruction (C5.1)",                    # dialogues
    "Épinglées",                                       # section épinglées
    "Reconnexion automatique en cours…",               # pied de carte
    "seront supprimés définitivement",                 # dialogue conversation
)
for g in GARDES:
    if g not in NOUVEAU:
        print(f"ÉCHEC : chaîne de garde absente du fichier assemblé : {g!r}")
        sys.exit(1)

COMPTEURS = (
    ("<ConversationItem", 4),  # usages : recherche, sans dossier, épinglées, dates
    ("<ProjectGroup", 2),      # usages : recherche, dossiers
    ("<ConfirmDestructiveDialog", 2),  # usages : conversation, dossier
    ("<DropZone", 2),          # usages : racine de projet, « _none »
    ("export function Sidebar", 1),
    ("function computeSearchTree", 1),
    ("function reorderProjectsFlat", 1),
    ("function groupLabel", 1),
)
for nom, attendu in COMPTEURS:
    reel = NOUVEAU.count(nom)
    if reel != attendu:
        print(f"ÉCHEC : compteur {nom!r} : attendu {attendu}, réel {reel}")
        sys.exit(1)

for feuille in ("SidebarRecherche", "SidebarDossiers", "SidebarHistorique", "SidebarStatut", "SidebarDialogues"):
    if f"function {feuille}(" not in NOUVEAU:
        print(f"ÉCHEC : feuille {feuille} absente (définition)")
        sys.exit(1)
    if f"<{feuille}" not in NOUVEAU:
        print(f"ÉCHEC : feuille {feuille} absente (usage)")
        sys.exit(1)

# Chaque morceau déplacé doit apparaître dans l'assemblage — à l'indentation
# d'origine (JSX) ou dédentée (corps de fonctions de module).
for nom, chunk, retrait in (
    ("SEARCH", SEARCH, 0), ("DOSSIERS", DOSSIERS, 0), ("HISTO", HISTO, 0),
    ("STATUT", STATUT, 0), ("DIALOGUES", DIALOGUES, 0),
    ("SEG", SEG, 6), ("REORD", REORD, 6), ("ST_BODY", ST_BODY, 2),
):
    if "".join(dedent(chunk, retrait) if retrait else chunk) not in NOUVEAU:
        print(f"ÉCHEC : morceau {nom} non retrouvé à l'identique dans l'assemblage")
        sys.exit(1)

FIC.write_text(NOUVEAU, encoding="utf-8")
print(f"OK — {FIC} réécrit : {len(lignes)} lignes → {len(NOUVEAU.splitlines())} lignes")
print("Feuilles : SidebarRecherche (%d l.), SidebarDossiers (%d l.), SidebarHistorique (%d l.), SidebarStatut (%d l.), SidebarDialogues (%d l.)" % (
    len(SEARCH), len(DOSSIERS), len(HISTO), len(STATUT), len(DIALOGUES)))
print("Algorithmes de module : computeSearchTree, reorderProjectsFlat (corps VERBATIM, retours early → null)")
