// Groupe dossier repliable + zone de dépôt — extraits de sidebar.tsx
// (découpage 2026-11, FORK.md §10) ; F-59 : en-tête actif sans bordure,
// menu « Nouveau dossier » en tête (crée un sous-dossier, un seul niveau),
// zone enfants avec règle verticale (sous-dossiers d'abord, comme la
// maquette v6), création inline, flash sur la ligne créée, lien disque.
// DropZone est exportée : la sidebar s'en sert aussi pour la zone
// « Sans dossier ».
"use client";

import { useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  FolderSymlink,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConversationItem, type ConvItemShared } from "@/components/chat/conversation-item";
import { ProjectSubgroup, type SubControls } from "@/components/chat/project-subgroup";
import type { ConversationMeta, Project } from "@/lib/chat-types";

export function DropZone({
  zoneId,
  projectId,
  className,
  children,
}: {
  zoneId: string;
  projectId: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `zone:${zoneId}`,
    data: { type: "dropzone", projectId },
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-xl",
        isOver && "bg-hermes/5 ring-1 ring-inset ring-hermes/50",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Groupe dossier repliable : en-tête draggable + sous-dossiers +
 *  conversations triées. */
export function ProjectGroup({
  project,
  conversations,
  subs,
  subControls,
  activeId,
  collapsed,
  onToggleCollapse,
  shared,
  renamingId,
  renameValue,
  setRenameValue,
  setRenamingId,
  onStartProjectRename,
  renamingProject,
  projectRenameValue,
  setProjectRenameValue,
  onCommitProjectRename,
  onCancelProjectRename,
  onNewInProject,
  onDeleteProject,
  onCreateSubfolder,
  dndEnabled = true,
}: {
  project: Project;
  conversations: ConversationMeta[];
  /** F-59 : sous-dossiers directs (un seul niveau), ordonnés. */
  subs: Project[];
  subControls: SubControls;
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  shared: ConvItemShared;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  setRenamingId: (id: string | null) => void;
  onStartProjectRename: () => void;
  renamingProject: boolean;
  projectRenameValue: string;
  setProjectRenameValue: (v: string) => void;
  onCommitProjectRename: () => void;
  onCancelProjectRename: () => void;
  onNewInProject: () => void;
  onDeleteProject: () => void;
  /** F-59 : crée un sous-dossier dans ce dossier (maquette v6). */
  onCreateSubfolder: (name: string) => Promise<Project | null>;
  /** Recherche : drag désactivé ( consultation seule). */
  dndEnabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `proj:${project.id}`,
    data: { type: "project", id: project.id },
    disabled: !dndEnabled,
  });
  const dragStyle = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  // Création inline d'un sous-dossier (menu « Nouveau dossier », maquette v6)
  const [creatingSub, setCreatingSub] = useState(false);
  const [newSubName, setNewSubName] = useState("");
  const [flashId, setFlashId] = useState<string | null>(null);

  const submitNewSub = async () => {
    const name = newSubName.trim();
    setCreatingSub(false);
    setNewSubName("");
    if (!name) return;
    const created = await onCreateSubfolder(name);
    if (created) {
      setFlashId(created.id);
      setTimeout(() => setFlashId(null), 1500);
    }
  };

  const openSubCreation = () => {
    if (collapsed) onToggleCollapse();
    setCreatingSub(true);
  };

  // Actif sans bordure (maquette v6) : la conversation affichée est
  // directement dans ce dossier.
  const activeHere = !!activeId && conversations.some((c) => c.id === activeId);

  return (
    <div className="mb-1">
      {renamingProject ? (
        <div className="flex items-center gap-1 rounded-lg bg-sidebar-accent px-2 py-1">
          <Folder className="h-4 w-4 shrink-0 text-hermes-text" />
          <Input
            autoFocus
            value={projectRenameValue}
            onChange={(e) => setProjectRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitProjectRename();
              else if (e.key === "Escape") onCancelProjectRename();
            }}
            className="h-8 border-none bg-transparent text-[12.5px] focus-visible:ring-0"
            aria-label="Nouveau nom du dossier"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onCommitProjectRename}
            aria-label="Valider le nom du dossier"
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onCancelProjectRename}
            aria-label="Annuler"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div
          ref={setNodeRef}
          style={dragStyle}
          {...attributes}
          {...listeners}
          className={cn(
            "group/proj flex cursor-grab items-center gap-0.5 rounded-lg px-1 py-1 hover:bg-sidebar-accent active:cursor-grabbing",
            activeHere && "bg-sidebar-accent",
            isDragging && "opacity-40"
          )}
        >
          <button
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Déplier" : "Replier"} le dossier ${project.name}`}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <Folder className="h-4 w-4 shrink-0 text-hermes-text" aria-hidden="true" />
            <span
              className={cn(
                "truncate text-[12.5px] font-semibold",
                activeHere && "text-hermes-text"
              )}
            >
              {project.name}
            </span>
            {project.diskPath ? (
              <FolderSymlink
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-label={`Liaison disque : ${project.diskPath}`}
              />
            ) : null}
            <span className="ml-1 shrink-0 rounded-full bg-sidebar-accent px-1.5 py-px text-[11px] tabular-nums text-muted-foreground">
              {conversations.length}
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover/proj:opacity-100"
            onClick={onNewInProject}
            aria-label={`Nouvelle conversation dans ${project.name}`}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover/proj:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Options pour ${project.name}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={openSubCreation}>
                <FolderPlus className="h-3.5 w-3.5" />
                Nouveau dossier
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onStartProjectRename}>
                <Pencil className="h-3.5 w-3.5" />
                Renommer
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDeleteProject}>
                <Trash2 className="h-3.5 w-3.5" />
                Supprimer le dossier
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {!collapsed ? (
        // Zone enfants : règle verticale comme la maquette v6 (kids) —
        // sous-dossiers d'abord, puis conversations, puis état vide.
        <div className="mb-0.5 ml-8 border-l border-sidebar-border pl-1.5 sm:ml-[46px]">
          {subs.map((s) => (
            <ProjectSubgroup
              key={s.id}
              project={s}
              conversations={subControls.conversationsOf(s.id)}
              controls={subControls}
              flash={s.id === flashId}
              dndEnabled={dndEnabled}
            />
          ))}
          {creatingSub ? (
            <div className="flex items-center gap-1 rounded-lg bg-sidebar-accent px-1.5 py-1">
              <FolderPlus className="h-3.5 w-3.5 shrink-0 text-hermes-text" />
              <Input
                autoFocus
                value={newSubName}
                onChange={(e) => setNewSubName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitNewSub();
                  else if (e.key === "Escape") {
                    setCreatingSub(false);
                    setNewSubName("");
                  }
                }}
                maxLength={80}
                placeholder="Nom du nouveau dossier"
                className="h-7 border-none bg-transparent text-[12.5px] focus-visible:ring-0"
                aria-label="Nom du nouveau sous-dossier"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => void submitNewSub()}
                aria-label="Créer le dossier"
              >
                <Check className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  setCreatingSub(false);
                  setNewSubName("");
                }}
                aria-label="Annuler"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : null}
          {conversations.length === 0 && subs.length === 0 && !creatingSub ? (
            <p className="px-2 py-2 text-[12.5px] italic text-muted-foreground">
              Aucune conversation.
            </p>
          ) : conversations.length > 0 ? (
            <ul className="mt-0.5 space-y-0.5 pr-0.5">
              {conversations.map((c) => (
                <ConversationItem
                  key={c.id}
                  c={c}
                  isActive={c.id === activeId}
                  renaming={renamingId === c.id}
                  renameValue={renameValue}
                  setRenameValue={setRenameValue}
                  setRenamingId={setRenamingId}
                  dndEnabled={dndEnabled}
                  {...shared}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
