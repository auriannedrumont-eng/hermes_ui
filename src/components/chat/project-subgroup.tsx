// Sous-dossier d'un dossier (F-59, maquette v6 validée) — fichier neuf (R1).
// Ligne repliable indentée sous son parent : chevron, nom (double-clic =
// renommage, menu = Renommer/Supprimer pour le clavier), compteur de
// conversations directes, « + », zone de dépôt pour ranger une conversation.
// Un seul niveau d'imbrication : un sous-dossier ne peut pas en contenir.
"use client";

import { useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
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
import type { ConversationMeta, Project } from "@/lib/chat-types";

/** Props transmises par la sidebar aux sous-dossiers (via ProjectGroup). */
export interface SubControls {
  activeId: string | null;
  shared: ConvItemShared;
  // Renommage des conversations (pass-through ConversationItem)
  renamingId: string | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  setRenamingId: (id: string | null) => void;
  // Repliage persisté (fork.projects.collapsed — ids uniques racines/sous)
  collapsedSubs: Set<string>;
  onToggleSubCollapse: (id: string) => void;
  // Renommage inline des dossiers (même état que les racines)
  renamingProjectId: string | null;
  projectRenameValue: string;
  setProjectRenameValue: (v: string) => void;
  onStartProjectRename: (id: string) => void;
  onCommitProjectRename: () => void;
  onCancelProjectRename: () => void;
  // Actions
  onNewInProject: (projectId: string) => void;
  onDeleteProject: (id: string) => void;
  /** F-60 : archive (ou désarchive) un dossier — sous-arbre côté service. */
  onSetProjectArchived: (id: string, archived: boolean) => void;
  /** Conversations directes d'un sous-dossier (liste triée de la sidebar). */
  conversationsOf: (projectId: string) => ConversationMeta[];
}

export function ProjectSubgroup({
  project,
  conversations,
  controls,
  flash = false,
  dndEnabled = true,
}: {
  project: Project;
  conversations: ConversationMeta[];
  controls: SubControls;
  /** F-59 : bref halo après la création (maquette v6). */
  flash?: boolean;
  /** Recherche : drag désactivé (consultation seule). */
  dndEnabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `proj:${project.id}`,
    data: { type: "project", id: project.id },
    disabled: !dndEnabled,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `zone:${project.id}`,
    data: { type: "dropzone", projectId: project.id },
  });
  const dragStyle = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  const collapsed = controls.collapsedSubs.has(project.id);
  const renaming = controls.renamingProjectId === project.id;
  // Actif sans bordure (maquette) : la conversation affichée est directement
  // dans ce sous-dossier.
  const activeHere = !!controls.activeId && conversations.some((c) => c.id === controls.activeId);

  return (
    <div
      ref={setDropRef}
      className={cn(
        "my-px rounded-lg",
        isOver && "bg-hermes/5 ring-1 ring-inset ring-hermes/50"
      )}
    >
      {renaming ? (
        <div className="flex items-center gap-1 rounded-lg bg-sidebar-accent px-1.5 py-1">
          <Folder className="h-3.5 w-3.5 shrink-0 text-hermes-text" />
          <Input
            autoFocus
            value={controls.projectRenameValue}
            onChange={(e) => controls.setProjectRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") controls.onCommitProjectRename();
              else if (e.key === "Escape") controls.onCancelProjectRename();
            }}
            className="h-7 border-none bg-transparent text-[12.5px] focus-visible:ring-0"
            aria-label="Nouveau nom du dossier"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={controls.onCommitProjectRename}
            aria-label="Valider le nom du dossier"
          >
            <Check className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={controls.onCancelProjectRename}
            aria-label="Annuler"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <div
          ref={setNodeRef}
          style={dragStyle}
          {...attributes}
          {...listeners}
          className={cn(
            "group/sub flex cursor-grab items-center gap-0.5 rounded-lg px-1 py-1 hover:bg-sidebar-accent active:cursor-grabbing",
            activeHere && "bg-sidebar-accent",
            flash && "hermes-flash",
            isDragging && "opacity-40"
          )}
        >
          <button
            onClick={() => controls.onToggleSubCollapse(project.id)}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Déplier" : "Replier"} le dossier ${project.name} (sous-dossier)`}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left",
              activeHere && "bg-sidebar-accent"
            )}
          >
            {collapsed ? (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <Folder className="h-3.5 w-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
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
            <span className="ml-0.5 shrink-0 rounded-full bg-sidebar-accent px-1.5 py-px text-[10.5px] tabular-nums text-muted-foreground">
              {conversations.length}
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-6 w-6 shrink-0 transition-opacity",
              collapsed
                ? "opacity-0 group-hover/sub:opacity-100"
                : "opacity-70 group-hover/sub:opacity-100"
            )}
            onClick={() => controls.onNewInProject(project.id)}
            aria-label={`Nouvelle conversation dans ${project.name}`}
          >
            <Plus className="h-3 w-3" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover/sub:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Options pour ${project.name}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={() => controls.onSetProjectArchived(project.id, true)}
              >
                <Archive className="h-3.5 w-3.5" />
                Archiver
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => controls.onStartProjectRename(project.id)}
              >
                <Pencil className="h-3.5 w-3.5" />
                Renommer
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => controls.onDeleteProject(project.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Supprimer le dossier
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {!collapsed ? (
        // F-61 (densité) : zone enfants resserrée (20 px au lieu de 26) —
        // une conversation dans un sous-dossier gagne ~22 px au total.
        <div className="mb-0.5 ml-[18px] border-l border-sidebar-border pl-1.5 sm:ml-[20px]">
          {conversations.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] italic text-muted-foreground">
              Aucune conversation.
            </p>
          ) : (
            <ul className="space-y-0.5 pr-0.5">
              {conversations.map((c) => (
                <ConversationItem
                  key={c.id}
                  c={c}
                  isActive={c.id === controls.activeId}
                  renaming={controls.renamingId === c.id}
                  renameValue={controls.renameValue}
                  setRenameValue={controls.setRenameValue}
                  setRenamingId={controls.setRenamingId}
                  dndEnabled={dndEnabled}
                  {...controls.shared}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
