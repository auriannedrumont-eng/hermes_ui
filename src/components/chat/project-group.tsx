// Groupe projet repliable + zone de dépôt — extraits de sidebar.tsx
// (découpage 2026-11, FORK.md §10) : en-tête draggable (réordonnancement),
// renommage inline du projet, conversations triées, zone de dépôt (projet ou
// « Sans projet »). DropZone est exportée : la sidebar s'en sert aussi pour
// la zone « Sans projet ».
"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ConfirmDestructiveDialog } from "@/components/shared/confirm-destructive-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConversationItem, type ConvItemShared } from "@/components/chat/conversation-item";
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

/** Groupe projet repliable : en-tête draggable + conversations triées. */

export function ProjectGroup({
  project,
  conversations,
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
}: {
  project: Project;
  conversations: ConversationMeta[];
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
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `proj:${project.id}`,
    data: { type: "project", id: project.id },
  });
  const dragStyle = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

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
            aria-label="Nouveau nom du projet"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onCommitProjectRename}
            aria-label="Valider le nom du projet"
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
          className={`group/proj flex cursor-grab items-center gap-0.5 rounded-lg px-1 py-1 hover:bg-sidebar-accent active:cursor-grabbing ${
            isDragging ? "opacity-40" : ""
          }`}
        >
          <button
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Déplier" : "Replier"} le projet ${project.name}`}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <Folder className="h-4 w-4 shrink-0 text-hermes-text" aria-hidden="true" />
            <span className="truncate text-[12.5px] font-semibold">{project.name}</span>
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
              <DropdownMenuItem onClick={onStartProjectRename}>
                <Pencil className="h-3.5 w-3.5" />
                Renommer
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDeleteProject}>
                <Trash2 className="h-3.5 w-3.5" />
                Supprimer le projet
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {!collapsed ? (
        conversations.length === 0 ? (
          <p className="px-3 py-2 text-[12.5px] italic text-muted-foreground">
            Glissez une conversation ici
          </p>
        ) : (
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
                dndEnabled
                {...shared}
              />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

