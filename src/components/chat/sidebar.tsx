// Sidebar : dossiers (arbre à un niveau, sous-dossiers repliables,
// drag & drop pour ranger et réordonner entre frères), recherche
// (dossiers + titres + contenu des messages), historique groupé par date pour
// « Sans dossier », conversations épinglées, Archives des dossiers
// archivés (F-60). F-59, maquette v6 validée ; F-62 : le bouton « Nouvelle
// conversation » pleine largeur est retiré (les « + » suffisent).
"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Folder, FolderDown, MessageSquare, Plus, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ConfirmDestructiveDialog } from "@/components/shared/confirm-destructive-dialog";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HermesLogo } from "@/components/chat/hermes-logo";
import { ConversationItem, type ConvItemShared } from "@/components/chat/conversation-item";
import { DropZone, ProjectGroup } from "@/components/chat/project-group";
import { type SubControls } from "@/components/chat/project-subgroup";
import { AttachDiskDialog } from "@/components/chat/attach-disk-dialog";
import { SidebarArchives } from "@/components/chat/sidebar-archives";
import { SidebarSectionHeader } from "@/components/chat/sidebar-section-header";
import { buildProjectTree, subtreeIds, type ProjectNode } from "@/lib/project-tree";
import { onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import type {
  ConversationMeta,
  GatewayMode,
  Project,
  SearchHit,
} from "@/lib/chat-types";

// ── Identifiants drag & drop ────────────────────────────────────────────
// conv:<id>   — conversation draggable (rangement)
// proj:<id>   — en-tête de projet draggable (réordonnancement)
// zone:<id>   — zone de dépôt (projet ou « Sans projet » = zone:_none)

interface SidebarProps {
  conversations: ConversationMeta[];
  projects: Project[];
  activeId: string | null;
  mode: GatewayMode | null;
  serverModel: string | null;
  /** Fournisseurs LLM actionnables (v2.4) — carte de statut honnête. */
  engineProviders: string[] | null;
  /** v0.3.3 — révision disponible sur GitHub (null = à jour) : point
   *  orange sur l'engrenage, l'info vit sans ouvrir la page Système. */
  updateAvailable?: string | null;
  connected: boolean;
  onNew: (projectId?: string | null) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onSearchMessages: (query: string) => Promise<SearchHit[]>;
  /** F-59 : `parentId` optionnel — crée un sous-dossier (un seul niveau) ;
   *  `diskPath` optionnel — lie un dossier du disque (validé côté service). */
  onCreateProject: (
    name: string,
    parentId?: string | null,
    diskPath?: string | null
  ) => Promise<Project | null>;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  /** F-60 : archive (ou désarchive) un dossier — propagation au sous-arbre
   *  côté service, liste complète diffusée en retour. */
  onSetProjectArchived: (id: string, archived: boolean) => void;
  onReorderProjects: (ids: string[]) => void;
  onMoveConversation: (id: string, projectId: string | null) => void;
  /** Ouvre le sheet Paramètres (engrenage de la carte de statut — FORK.md §7.4). */
  onOpenSettings: () => void;
}

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(now) - startOfDay(d)) / (1000 * 60 * 60 * 24)
  );
  if (diffDays <= 0) return "Aujourd'hui";
  if (diffDays === 1) return "Hier";
  if (diffDays <= 7) return "7 derniers jours";
  if (diffDays <= 30) return "30 derniers jours";
  return "Plus ancien";
}

// Ensemble stable « rien de replié » pendant la recherche (identité fixe).
const SEARCH_EMPTY_SET: Set<string> = new Set();

// ── Découpage en feuilles (chantier CRAP vague 5, 2026-11-25) ───────────
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
// Recherche insensible aux ACCENTS (revue 95) : « reunion » doit trouver
// « Réunion » — normalisation NFD + retrait des diacritiques des deux côtés.
// (vague 5 : monte au niveau module — pure, utilisée par computeSearchTree
// et par le filtre « conversationsOf » de la recherche.)
// Recherche insensible aux ACCENTS (revue 95) : « reunion » doit trouver
// « Réunion » — normalisation NFD + retrait des diacritiques des deux côtés.
const foldAccents = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

interface SearchTreeNode {
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
  const ql = foldAccents(q);
  const matchConv = (c: ConversationMeta) =>
    foldAccents(c.title).includes(ql) || foldAccents(c.preview).includes(ql);
  const nodes: {
    project: Project;
    convs: ConversationMeta[];
    subs: { project: Project; convs: ConversationMeta[] }[];
  }[] = [];
  const roots = projects
    .filter((p) => !p.parentId && !p.archived)
    .sort((a, b) => a.position - b.position);
  for (const root of roots) {
    const kids = projects
      .filter((p) => p.parentId === root.id && !p.archived)
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        project: s,
        convs: (conversationsByProject.get(s.id) ?? []).filter(matchConv),
      }))
      .filter(
        (s) => foldAccents(s.project.name).includes(ql) || s.convs.length > 0
      );
    const convs = (conversationsByProject.get(root.id) ?? []).filter(matchConv);
    if (foldAccents(root.name).includes(ql) || convs.length > 0 || kids.length > 0) {
      nodes.push({ project: root, convs, subs: kids });
    }
  }
  return nodes;
}

/** Réordonnancement F-59 : liste plate reconstruite depuis l'arbre courant
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
const reorderSegment = (list: Project[]) => {
  const seg = list.map((p) => p.id);
  const from = seg.indexOf(draggedId);
  if (from < 0) return seg;
  seg.splice(from, 1);
  const to = seg.indexOf(targetId);
  seg.splice(to < 0 ? seg.length : to, 0, draggedId);
  return seg;
};
const roots = projects
  .filter((p) => !p.parentId)
  .sort((x, y) => x.position - y.position);
const rootIds =
  parentId === null ? reorderSegment(roots) : roots.map((p) => p.id);
const childrenOrder = new Map<string, string[]>();
for (const r of roots) {
  const kids = projects
    .filter((p) => p.parentId === r.id)
    .sort((x, y) => x.position - y.position);
  childrenOrder.set(
    r.id,
    parentId === r.id ? reorderSegment(kids) : kids.map((p) => p.id)
  );
}
const flat: string[] = [];
for (const rid of rootIds) {
  flat.push(rid);
  flat.push(...(childrenOrder.get(rid) ?? []));
}
  return flat;
}

/** Feuille 1 — la branche « recherche » de l'historique : l'arbre des
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
            <>
              {hasProjects ? (
                <>
                  <SidebarSectionHeader title="Mes dossiers" />
                  {searchTree.length === 0 ? (
                    <p className="px-2 py-2 text-[12.5px] text-muted-foreground">
                      Aucun dossier ne correspond.
                    </p>
                  ) : (
                    searchTree.map((node) => (
                      <ProjectGroup
                        key={node.project.id}
                        project={node.project}
                        conversations={node.convs}
                        subs={node.subs.map((s) => s.project)}
                        subControls={searchSubControls}
                        activeId={activeId}
                        collapsed={false}
                        onToggleCollapse={() => {}}
                        shared={shared}
                        renamingId={renamingId}
                        renameValue={renameValue}
                        setRenameValue={setRenameValue}
                        setRenamingId={setRenamingId}
                        onStartProjectRename={() => {
                          setRenamingProjectId(node.project.id);
                          setProjectRenameValue(node.project.name);
                        }}
                        renamingProject={renamingProjectId === node.project.id}
                        projectRenameValue={projectRenameValue}
                        setProjectRenameValue={setProjectRenameValue}
                        onCommitProjectRename={commitProjectRename}
                        onCancelProjectRename={() => setRenamingProjectId(null)}
                        onNewInProject={() => onNew(node.project.id)}
                        onDeleteProject={() => handleDeleteProject(node.project)}
                        onArchiveProject={() =>
                          onSetProjectArchived(node.project.id, true)
                        }
                        onCreateSubfolder={(name) =>
                          onCreateProject(name, node.project.id)
                        }
                        dndEnabled={false}
                      />
                    ))
                  )}
                  <SidebarSectionHeader
                    title="Sans dossier"
                    actions={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-sidebar-foreground"
                        onClick={() => onNew(null)}
                        aria-label="Nouvelle conversation sans dossier"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    }
                  />
                </>
              ) : null}
              {searchGroups.length === 0 ? (
                <p className="px-2 py-2 text-[12.5px] text-muted-foreground">
                  Aucune conversation ne correspond.
                </p>
              ) : (
                searchGroups.map(([label, items]) => (
                  <div key={label} className="mb-2">
                    <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground/80">
                      {label}
                    </p>
                    <ul className="space-y-0.5">
                      {items.map((c) => (
                        <ConversationItem
                          key={c.id}
                          c={c}
                          isActive={c.id === activeId}
                          renaming={renamingId === c.id}
                          renameValue={renameValue}
                          setRenameValue={setRenameValue}
                          setRenamingId={setRenamingId}
                          dndEnabled={false}
                          {...itemProps}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              )}
              <p className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Dans les messages {searching ? "…" : `(${messageHits.length})`}
              </p>
              {messageHits.length === 0 && !searching ? (
                <p className="px-2 py-2 text-[12.5px] text-muted-foreground">
                  Aucun message ne correspond.
                </p>
              ) : (
                <ul className="space-y-1">
                  {messageHits.map((hit) => (
                    <li key={hit.messageId}>
                      <button
                        onClick={() => onOpen(hit.conversationId)}
                        className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent"
                      >
                        <span className="block truncate text-[12.5px] font-medium">
                          {hit.conversationTitle}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                          {hit.role === "user" ? "Vous : " : "Hermes : "}
                          {hit.excerpt}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
  );
}

/** Feuille 2 — la branche « avec dossiers » : l'arbre des ProjectGroup
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
            <>
              <SidebarSectionHeader
                title="Mes dossiers"
                actions={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-sidebar-foreground"
                    onClick={() => setAttachDiskOpen(true)}
                    aria-label="Ajouter un dossier de mon disque"
                    title="Ajouter un dossier de mon disque"
                  >
                    <FolderDown className="h-4 w-4" />
                  </Button>
                }
              />
              {projectTree.map((node: ProjectNode) => (
                <DropZone
                  key={node.project.id}
                  zoneId={node.project.id}
                  projectId={node.project.id}
                >
                  <ProjectGroup
                    project={node.project}
                    conversations={conversationsByProject.get(node.project.id) ?? []}
                    subs={node.children}
                    subControls={subControls}
                    activeId={activeId}
                    collapsed={collapsedProjects.has(node.project.id)}
                    onToggleCollapse={() => toggleProjectCollapsed(node.project.id)}
                    shared={shared}
                    renamingId={renamingId}
                    renameValue={renameValue}
                    setRenameValue={setRenameValue}
                    setRenamingId={setRenamingId}
                    onStartProjectRename={() => {
                      setRenamingProjectId(node.project.id);
                      setProjectRenameValue(node.project.name);
                    }}
                    renamingProject={renamingProjectId === node.project.id}
                    projectRenameValue={projectRenameValue}
                    setProjectRenameValue={setProjectRenameValue}
                    onCommitProjectRename={commitProjectRename}
                    onCancelProjectRename={() => setRenamingProjectId(null)}
                    onNewInProject={() => onNew(node.project.id)}
                    onDeleteProject={() => handleDeleteProject(node.project)}
                    onArchiveProject={() =>
                      onSetProjectArchived(node.project.id, true)
                    }
                    onCreateSubfolder={(name) =>
                      onCreateProject(name, node.project.id)
                    }
                  />
                </DropZone>
              ))}
              {projectTree.length === 0 ? (
                <p className="px-2 py-2 text-[12.5px] text-muted-foreground/70">
                  Aucun dossier — utilisez 📁↓ pour en lier un du disque.
                </p>
              ) : null}
              <SidebarSectionHeader
                title="Sans dossier"
                actions={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-sidebar-foreground"
                    onClick={() => onNew(null)}
                    aria-label="Nouvelle conversation sans dossier"
                    title="Nouvelle conversation"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                }
              />
              <DropZone zoneId="_none" projectId={null} className="mb-2">
                {unprojected.length === 0 ? (
                  <p className="px-2 py-2 text-[12.5px] text-muted-foreground/70">
                    Aucune conversation hors dossier.
                  </p>
                ) : (
                  dateGroups.map(([label, items]) => (
                    <div key={label} className="mb-1">
                      <p className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground/80">
                        {label}
                      </p>
                      <ul className="space-y-0.5">
                        {items.map((c) => (
                          <ConversationItem
                            key={c.id}
                            c={c}
                            isActive={c.id === activeId}
                            renaming={renamingId === c.id}
                            renameValue={renameValue}
                            setRenameValue={setRenameValue}
                            setRenamingId={setRenamingId}
                            dndEnabled
                            {...itemProps}
                          />
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </DropZone>
              {/* F-60 : Archives — les dossiers archivés, repliés par
                  défaut ; la section ne s'affiche que s'il y en a. */}
              {archivedProjects.length > 0 ? (
                <SidebarArchives
                  projects={archivedProjects}
                  allProjects={projects}
                  conversationsOf={(id) => conversationsByProject.get(id) ?? []}
                  collapsed={archivesCollapsed}
                  onToggle={toggleArchivesCollapsed}
                  onRestore={(id) => onSetProjectArchived(id, false)}
                  onDelete={(p) => handleDeleteProject(p)}
                />
              ) : null}
              {/* (audit 2026-11-21) ce bloc vit DANS la branche hasProjects :
                  !hasProjects y est toujours faux et le message ne s'affichait
                  jamais — projets existants + zéro conversation = zone vide. */}
              {pinned.length === 0 && conversations.length === 0 ? (
                <p className="px-2 pt-6 text-center text-[12.5px] text-muted-foreground">
                  Pas encore de conversation.
                </p>
              ) : null}
              <AttachDiskDialog
                open={attachDiskOpen}
                onOpenChange={setAttachDiskOpen}
                projects={projects}
                onAttach={async (name, diskPath) => {
                  const p = await onCreateProject(name, null, diskPath);
                  return p;
                }}
              />
            </>
  );
}

/** Feuille 3 — la branche « sans dossier » : épinglées puis groupes de
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
            <>
              {pinned.length > 0 ? (
                <div className="mb-2">
                  <p className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Épinglées
                  </p>
                  <ul className="space-y-0.5">
                    {pinned.map((c) => (
                      <ConversationItem
                        key={c.id}
                        c={c}
                        isActive={c.id === activeId}
                        renaming={renamingId === c.id}
                        renameValue={renameValue}
                        setRenameValue={setRenameValue}
                        setRenamingId={setRenamingId}
                        dndEnabled={false}
                        {...itemProps}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
              {dateGroups.map(([label, items]) => (
                <div key={label} className="mb-2">
                  <p className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {label}
                  </p>
                  <ul className="space-y-0.5">
                    {items.map((c) => (
                      <ConversationItem
                        key={c.id}
                        c={c}
                        isActive={c.id === activeId}
                        renaming={renamingId === c.id}
                        renameValue={renameValue}
                        setRenameValue={setRenameValue}
                        setRenamingId={setRenamingId}
                        dndEnabled={false}
                        {...itemProps}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </>
  );
}

/** Feuille 4 — la carte de statut du moteur : le voyant d'état, le
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
      <div className="border-t border-sidebar-border p-3">
        <div
          className={`rounded-xl px-3 py-2.5 ring-1 ring-inset transition-colors ${
            !connected
              ? "bg-sidebar-accent ring-sidebar-border"
              : mode === "gateway"
                ? "bg-success/10 ring-success/30"
                : "bg-warning/10 ring-warning/30"
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                !connected
                  ? "bg-muted-foreground/50"
                  : mode === "gateway"
                    ? "bg-success"
                    : "bg-warning animate-pulse"
              }`}
              aria-hidden="true"
            />
            <p className="truncate text-[12.5px] font-semibold leading-none text-foreground">
              {/* Dictionnaire (loi « tout simplement », 2026-11-22) : le sujet
                  est toujours Hermes, en mots simples — plus de « moteur local ».
                  Hermes éteint : l'application l'allume seule s'il est installé. */}
              {!connected
                ? "Hors ligne"
                : mode === "gateway"
                  ? "Hermes branché"
                  : "Hermes est éteint"}
            </p>
            {/* Entrée unique des paramètres (décision v1 confirmée v3).
                v0.3.3 : point orange tant qu'une mise à jour est
                disponible — l'info arrive sans ouvrir la page Système. */}
            <button
              type="button"
              onClick={onOpenSettings}
              title={updateAvailable ? "Mise à jour disponible — ouvrir Paramètres → Système" : "Paramètres"}
              aria-label={
                updateAvailable
                  ? "Ouvrir les paramètres — mise à jour disponible"
                  : "Ouvrir les paramètres"
              }
              className="relative ml-auto flex size-[27px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground hover:shadow-sm focus-visible:outline-2 focus-visible:outline-hermes"
            >
              <Settings className="size-[14px]" />
              {updateAvailable ? (
                <i
                  className="absolute -top-0.5 -right-0.5 size-[8px] rounded-full border-2 border-background bg-warning"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            {!connected ? (
              "Reconnexion automatique en cours…"
            ) : mode === "gateway" ? (
              (serverModel ?? "")
            ) : (
              <>
                L&apos;application allume Hermes toute seule dès qu&apos;il est
                installé — sans lui, aucune réponse n&apos;est envoyée.
              </>
            )}
          </p>
        </div>
      </div>
  );
}

/** Feuille 5 — les gardes de destruction (C5.1) : les deux dialogues de
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
      {/* Gardes de destruction (C5.1) — une seule façon de confirmer */}
      <ConfirmDestructiveDialog
        open={!!deleteConvTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteConvTarget(null);
        }}
        title={deleteConvTarget ? `Supprimer « ${deleteConvTarget.title} » ?` : ""}
        description="La conversation, son historique et le journal de versions de ses fichiers seront supprimés définitivement."
        confirmLabel="Supprimer la conversation"
        onConfirm={() => {
          if (deleteConvTarget) onDelete(deleteConvTarget.id);
          setDeleteConvTarget(null);
        }}
      />
      <ConfirmDestructiveDialog
        open={!!deleteProjectTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteProjectTarget(null);
        }}
        title={deleteProjectTarget ? `Supprimer le dossier « ${deleteProjectTarget.name} » ?` : ""}
        description={
          deleteProjectTarget
            ? (() => {
                // F-59 : la garde compte TOUTES les conversations (dossier +
                // sous-dossiers, cas limite plan §6.4) ; les sous-dossiers
                // sont promus au premier niveau, jamais supprimés.
                const ids = subtreeIds(deleteProjectTarget.id, projects);
                const count = conversations.filter(
                  (c) => c.projectId && ids.has(c.projectId)
                ).length;
                const subs = projects.filter((p) => p.parentId === deleteProjectTarget!.id).length;
                const convTxt =
                  count > 0
                    ? `Ses ${count} conversation${count > 1 ? "s" : ""} (dossier et sous-dossiers) seront conservées et déplacées dans « Sans dossier ». `
                    : "Les conversations, s'il y en a, resteront dans « Sans dossier ». ";
                const subTxt =
                  subs > 0
                    ? `Son${subs > 1 ? "s" : ""} ${subs} sous-dossier${subs > 1 ? "s" : ""} remonter${subs > 1 ? "nt" : ""} au premier niveau.`
                    : "";
                return `${convTxt}${subTxt}`;
              })()
            : undefined
        }
        confirmLabel="Supprimer le dossier"
        onConfirm={() => {
          if (deleteProjectTarget) onDeleteProject(deleteProjectTarget.id);
          setDeleteProjectTarget(null);
        }}
      />
    </>
  );
}

export function Sidebar({
  conversations,
  projects,
  activeId,
  mode,
  serverModel,
  engineProviders,
  updateAvailable = null,
  connected,
  onNew,
  onOpen,
  onDelete,
  onRename,
  onTogglePin,
  onSearchMessages,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onSetProjectArchived,
  onReorderProjects,
  onMoveConversation,
  onOpenSettings,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  // Gardes de destruction (C5.1) : cibles des dialogues de confirmation.
  const [deleteConvTarget, setDeleteConvTarget] = useState<ConversationMeta | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [messageHits, setMessageHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  // ── Dossiers : renommage inline, repliage persisté, lien disque (F-59) ─
  // La création d'un dossier vit dans les groupes (menu « Nouveau dossier »
  // = sous-dossier) et dans le dialogue de liaison disque (📁↓) — plus de
  // bouton de création racine (maquette v6).
  const [attachDiskOpen, setAttachDiskOpen] = useState(false);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    try {
      const arr = JSON.parse(readClientSetting<string>("fork.projects.collapsed"));
      return Array.isArray(arr)
        ? new Set(arr.filter((x): x is string => typeof x === "string"))
        : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const [sortMode, setSortMode] = useState<string>(() => readClientSetting<string>("fork.projects.sort"));
  const [activeDrag, setActiveDrag] = useState<{ type: string; label: string } | null>(null);
  // F-60 : section « Archives » repliée par défaut (persisté).
  const [archivesCollapsed, setArchivesCollapsed] = useState<boolean>(
    () => readClientSetting<boolean>("fork.archives.collapsed") ?? true
  );

  const toggleArchivesCollapsed = () => {
    setArchivesCollapsed((prev) => {
      const next = !prev;
      writeClientSetting("fork.archives.collapsed", next);
      return next;
    });
  };

  // Carte de statut honnête (v2.4) : l'agent Hermes connecté ou un état
  // « Hermes éteint » clair — jamais de moteur simulé. Loi « une seule
  // voix » (24/11) : sans gateway, AUCUNE réponse n'arrive (les clés
  // fournisseurs ne parlent plus dans le chat), donc plus d'état
  // « vos clés répondent » qui promettait l'inverse du réel.

  // ── Application immédiate des réglages (page Paramètres) ──────────────
  // Tri des projets et repliage suivent le bus `hermes-ui:settings-changed`.
  useEffect(() => {
    return onSettingsChanged(({ key, value }) => {
      if (key === "fork.projects.sort") {
        setSortMode(typeof value === "string" ? value : "updated");
      } else if (key === "fork.projects.collapsed") {
        try {
          const arr = JSON.parse(typeof value === "string" ? value : "[]");
          setCollapsedProjects(
            Array.isArray(arr)
              ? new Set(arr.filter((x): x is string => typeof x === "string"))
              : new Set<string>()
          );
        } catch {
          setCollapsedProjects(new Set<string>());
        }
      } else if (key === "fork.archives.collapsed") {
        setArchivesCollapsed(typeof value === "boolean" ? value : true);
      }
    });
  }, []);

  // Lot 5 (audit) : le réordonnancement des projets était à la SOURIS
  // uniquement (PointerSensor seul) — inaccessible au clavier. Sensor
  // clavier + coordonnées triables (Espace/Entrée = saisir, flèches =
  // déplacer, Échap = annuler).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const q = query.trim();
  const isSearching = q.length >= 2;
  const hasProjects = projects.length > 0;
  // Recherche plein-texte (débouncée) dans le contenu des messages
  // Lot audit passe 2 : garde anti-course — une réponse lente pour une
  // requête COURTE peut revenir APRÈS celle d'une requête plus récente et
  // l'écraser. `cancelled` est posé par le cleanup (q changé, démontage) :
  // seuls les résultats de la DERNIÈRE requête sont affichés.
  useEffect(() => {
    let cancelled = false;
    if (!isSearching) {
      setMessageHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const hits = await onSearchMessages(q);
        if (!cancelled) setMessageHits(hits);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, isSearching, onSearchMessages]);

  // Tri des conversations à l'intérieur d'un dossier (fork.projects.sort)
  const bySort = useMemo(() => {
    return (a: ConversationMeta, b: ConversationMeta) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (sortMode === "created") return b.createdAt.localeCompare(a.createdAt);
      if (sortMode === "title") return a.title.localeCompare(b.title, "fr");
      return b.updatedAt.localeCompare(a.updatedAt);
    };
  }, [sortMode]);

  // Conversations par dossier + « Sans dossier »
  const conversationsByProject = useMemo(() => {
    const map = new Map<string, ConversationMeta[]>();
    for (const p of projects) {
      map.set(
        p.id,
        conversations.filter((c) => (c.projectId ?? null) === p.id).sort(bySort)
      );
    }
    return map;
  }, [conversations, projects, bySort]);

  const unprojected = useMemo(
    () => conversations.filter((c) => !c.projectId || !conversationsByProject.has(c.projectId)),
    [conversations, conversationsByProject]
  );
  // Recherche : groupes de dates des conversations « Sans dossier » (avec
  // dossiers, l'arbre filtré ci-dessous porte les conversations rangées).
  const searchGroups = useMemo(() => {
    const ql = foldAccents(q);
    const pool = conversations.filter(
      (c) =>
        (foldAccents(c.title).includes(ql) ||
          foldAccents(c.preview).includes(ql)) &&
        (!hasProjects || !c.projectId || !conversationsByProject.has(c.projectId))
    );
    const map = new Map<string, ConversationMeta[]>();
    for (const c of pool) {
      const label = groupLabel(c.updatedAt);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(c);
    }
    return Array.from(map.entries());
  }, [conversations, q, hasProjects, conversationsByProject]);

  // Recherche : arbre filtré — un dossier est visible si son nom correspond
  // ou s'il contient (directement ou via un sous-dossier) des conversations
  // visibles ; tout est déplié (maquette v6). Les dossiers ARCHIVÉS (F-60)
  // sont hors de la recherche : ils vivent dans les Archives.
  const searchTree = useMemo(() => {
    if (!isSearching || !hasProjects) return [];
    return computeSearchTree(q, projects, conversationsByProject);
  }, [isSearching, hasProjects, q, projects, conversationsByProject]);
  // Groupes par date (mode sans projet, ou section « Sans dossier »)
  const dateGroups = useMemo(() => {
    const map = new Map<string, ConversationMeta[]>();
    for (const c of unprojected) {
      if (!hasProjects && c.pinned) continue; // sans projets, les épinglées ont leur section
      const label = groupLabel(c.updatedAt);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(c);
    }
    return Array.from(map.entries());
  }, [unprojected, hasProjects]);

  const pinned = useMemo(
    () => (!hasProjects && !q ? conversations.filter((c) => c.pinned) : []),
    [conversations, q, hasProjects]
  );

  const shared: ConvItemShared = {
    onOpen,
    onRename,
    onTogglePin,
    onDelete: (id: string) => {
      const c = conversations.find((x) => x.id === id);
      if (c) setDeleteConvTarget(c);
    },
    onMove: onMoveConversation,
    projects,
  };
  // ── Dossiers : actions locales ────────────────────────────────────
  const toggleProjectCollapsed = (id: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeClientSetting("fork.projects.collapsed", JSON.stringify([...next]));
      return next;
    });
  };

  const commitProjectRename = () => {
    const id = renamingProjectId;
    const name = projectRenameValue.trim();
    setRenamingProjectId(null);
    if (id && name) onRenameProject(id, name);
  };

  const handleDeleteProject = (p: Project) => {
    setDeleteProjectTarget(p);
  };

  // ── F-59 : arbre des dossiers (racines → sous-dossiers, un niveau) ────
  // F-60 : les dossiers ARCHIVÉS sortent de l'arbre actif — ils vivent dans
  // les Archives (section repliée en bas) ; leurs conversations restent
  // « projetées » (conversationsByProject couvre tous les projets) : elles
  // n'apparaissent ni dans « Sans dossier » ni dans la recherche.
  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects]);
  const archivedProjects = useMemo(() => projects.filter((p) => p.archived), [projects]);
  const projectTree = useMemo(() => buildProjectTree(activeProjects), [activeProjects]);

  // Props transmises aux sous-dossiers (bundle unique via les groupes)
  const subControls: SubControls = {
    activeId,
    shared,
    renamingId,
    renameValue,
    setRenameValue,
    setRenamingId,
    collapsedSubs: collapsedProjects,
    onToggleSubCollapse: toggleProjectCollapsed,
    renamingProjectId,
    projectRenameValue,
    setProjectRenameValue,
    onStartProjectRename: (id: string) => {
      const p = projects.find((x) => x.id === id);
      setRenamingProjectId(id);
      setProjectRenameValue(p?.name ?? "");
    },
    onCommitProjectRename: commitProjectRename,
    onCancelProjectRename: () => setRenamingProjectId(null),
    onNewInProject: (projectId: string) => onNew(projectId),
    onDeleteProject: (id: string) => {
      const p = projects.find((x) => x.id === id);
      if (p) handleDeleteProject(p);
    },
    onSetProjectArchived: (id: string, archived: boolean) =>
      onSetProjectArchived(id, archived),
    conversationsOf: (projectId: string) => conversationsByProject.get(projectId) ?? [],
  };
  // Recherche : tout est déplié (maquette v6) — repliage neutralisé,
  // conversations filtrées par la requête dans les sous-dossiers.
  const searchSubControls: SubControls = {
    ...subControls,
    collapsedSubs: SEARCH_EMPTY_SET,
    onToggleSubCollapse: () => {},
    conversationsOf: (projectId: string) => {
      // Revue P1-P7 : SANS ACCENTS — l'ancien filtre brut (toLowerCase)
      // faisait dire « Aucune conversation » à « reunion » pour « Réunion ».
      const ql = foldAccents(q);
      return (conversationsByProject.get(projectId) ?? []).filter(
        (c) =>
          foldAccents(c.title).includes(ql) ||
          foldAccents(c.preview).includes(ql)
      );
    },
  };
  // ── Drag & drop ───────────────────────────────────────────────────
  const handleDragStart = (event: DragStartEvent) => {
    const d = event.active.data.current as { type?: string; id?: string; title?: string } | undefined;
    if (d?.type === "conversation") {
      setActiveDrag({ type: "conversation", label: d.title ?? "" });
    } else if (d?.type === "project") {
      setActiveDrag({
        type: "project",
        label: projects.find((p) => p.id === d.id)?.name ?? "",
      });
    }
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const a = active.data.current as { type?: string; id?: string } | undefined;
    const o = over.data.current as { type?: string; projectId?: string | null } | undefined;
    if (!a?.type || o?.type !== "dropzone") return;

    if (a.type === "conversation" && a.id) {
      // Rangement : déplacer la conversation dans la zone visée (dossier,
      // sous-dossier ou « Sans dossier »)
      const conv = conversations.find((c) => c.id === a.id);
      const current = conv?.projectId ?? null;
      const target = o.projectId ?? null;
      if (current !== target) onMoveConversation(a.id, target);
    } else if (a.type === "project" && a.id && o.projectId) {
      // Réordonnancement : placer le projet avant le projet visé —
      // F-59 : entre FRÈRES uniquement (cas limite plan §6.1) ; la liste
      // plate envoyée au service est reconstruite depuis l'arbre courant
      // (positions globales conservées pour tout ce qui n'a pas bougé).
      // (vague 5) l'algorithme vit dans reorderProjectsFlat (module) :
      // mêmes gardes, même liste plate ; null = rien à faire.
      const flat = reorderProjectsFlat(projects, a.id, o.projectId);
      if (flat) onReorderProjects(flat);
    }
  };
  const itemProps = {
    onOpen,
    onRename,
    onTogglePin,
    onDelete: (id: string) => {
      const c = conversations.find((x) => x.id === id);
      if (c) setDeleteConvTarget(c);
    },
    onMove: onMoveConversation,
    projects,
  };
  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Marque */}
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-hermes text-hermes-foreground">
          <HermesLogo className="h-5 w-5" />
        </span>
        <div className="leading-tight">
          <p className="text-[15px] font-semibold tracking-tight">Hermes</p>
          <p className="text-[11px] text-muted-foreground">Web · Nous Research</p>
        </div>
      </div>

      {/* F-62 : le gros bouton « Nouvelle conversation » est retiré à la
          demande de l'utilisatrice — la création reste accessible via les
          « + » (section « Sans dossier », en-têtes de dossiers et de
          sous-dossiers), présents même quand la liste est vide. */}

      {/* Recherche */}
      <div className="px-3 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher…"
            aria-label="Rechercher dans les dossiers, les conversations et les messages"
            className="h-9 rounded-xl border-transparent bg-sidebar-accent pl-9 text-[12.5px] focus-visible:border-transparent focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>

      {/* Historique */}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDrag(null)}
      >
        <nav
          aria-label="Historique des conversations"
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-2"
        >
          {isSearching ? (
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
        </nav>

        <DragOverlay>
          {activeDrag ? (
            <div className="flex max-w-[220px] items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 shadow-lg">
              {activeDrag.type === "project" ? (
                <Folder className="h-4 w-4 shrink-0 text-hermes-text" />
              ) : (
                <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-[12.5px]">{activeDrag.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Carte de statut du moteur — voyant d'état (§9 (62)) : une seule
          question à l'écran — Hermes répond-il, et sinon que faire ? La
          teinte de la carte PORTE l'état : vert = ça répond, ambre pulsant
          = il faut allumer Hermes, gris = hors ligne (reconnexion seule
          en cours). */}
      <SidebarStatut
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
    </div>
  );
}
