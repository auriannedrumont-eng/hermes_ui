// Item de conversation — extrait de sidebar.tsx (découpage 2026-11,
// FORK.md §10) : titre, épinglage, renommage inline, menu contextuel
// (déplacer vers un dossier/sous-dossier F-59, épingler, renommer,
// supprimer), poignée de drag & drop pour le rangement. Props partagées
// ConvItemShared.
"use client";

import { useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import {
  Check,
  Folder,
  FolderInput,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ConversationMeta, Project } from "@/lib/chat-types";

/** Props communes aux items de conversation (partagées entre groupes). */
export interface ConvItemShared {
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, projectId: string | null) => void;
  projects: Project[];
}

export function ConversationItem({
  c,
  isActive,
  renaming,
  renameValue,
  setRenameValue,
  onRename,
  onTogglePin,
  onDelete,
  onOpen,
  setRenamingId,
  onMove,
  projects,
  dndEnabled,
}: ConvItemShared & {
  c: ConversationMeta;
  isActive: boolean;
  renaming: boolean;
  renameValue: string;
  setRenameValue: (v: string) => void;
  setRenamingId: (id: string | null) => void;
  dndEnabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `conv:${c.id}`,
    data: { type: "conversation", id: c.id, title: c.title },
    disabled: !dndEnabled || renaming,
  });
  const dragStyle = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  // F-59 : le menu « Déplacer vers… » liste l'arbre — racines d'abord, leurs
  // sous-dossiers indentés sous chacune (« Parent › Sous-dossier »).
  const moveTargets = useMemo(() => {
    // Revue P1-P7 : les dossiers ARCHIVÉS ne sont pas des cibles de
    // déplacement (on ne dépose pas une conversation dans les archives).
    const actifs = projects.filter((p) => !p.archived);
    const roots = actifs
      .filter((p) => !p.parentId)
      .sort((a, b) => a.position - b.position);
    const out: { project: Project; label: string; nested: boolean }[] = [];
    for (const r of roots) {
      out.push({ project: r, label: r.name, nested: false });
      for (const s of actifs
        .filter((p) => p.parentId === r.id)
        .sort((a, b) => a.position - b.position)) {
        out.push({ project: s, label: `${r.name} › ${s.name}`, nested: true });
      }
    }
    // Projets orphelins (parent supprimé entre-temps) : listés à la fin.
    const seen = new Set(out.map((x) => x.project.id));
    for (const p of actifs) {
      if (!seen.has(p.id)) out.push({ project: p, label: p.name, nested: false });
    }
    return out;
  }, [projects]);

  if (renaming) {
    return (
      <li className="flex items-center gap-1 rounded-lg bg-sidebar-accent px-2 py-1">
        <Input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onRename(c.id, renameValue);
              setRenamingId(null);
            } else if (e.key === "Escape") {
              setRenamingId(null);
            }
          }}
          className="h-8 border-none bg-transparent text-[12.5px] focus-visible:ring-0"
          aria-label="Nouveau titre"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => {
            onRename(c.id, renameValue);
            setRenamingId(null);
          }}
          aria-label="Valider le titre"
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
      </li>
    );
  }
  return (
    <li
      ref={setNodeRef}
      style={dragStyle}
      {...(dndEnabled ? { ...attributes, ...listeners } : {})}
      className={cn("list-none", isDragging && "opacity-40")}
    >
      <div
        className={`group/item flex items-center rounded-lg ${
          isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"
        }`}
      >
        <button
          onClick={() => onOpen(c.id)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-2 text-left"
          aria-current={isActive ? "page" : undefined}
        >
          {c.pinned ? (
            <Pin className="h-4 w-4 shrink-0 rotate-45 text-hermes-text" aria-label="Épinglée" />
          ) : (
            <MessageSquare
              className={`h-4 w-4 shrink-0 ${
                isActive ? "text-hermes-text" : "text-muted-foreground"
              }`}
            />
          )}
          <span className="truncate text-[14px]">{c.title}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover/item:opacity-100 data-[state=open]:opacity-100"
              aria-label={`Options pour ${c.title}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => onTogglePin(c.id)}>
              {c.pinned ? (
                <>
                  <PinOff className="h-3.5 w-3.5" />
                  Détacher
                </>
              ) : (
                <>
                  <Pin className="h-3.5 w-3.5" />
                  Épingler
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setRenamingId(c.id);
                setRenameValue(c.title);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              Renommer
            </DropdownMenuItem>
            {projects.length > 0 || c.projectId ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInput className="h-3.5 w-3.5" />
                  Déplacer vers…
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                  <DropdownMenuItem onClick={() => onMove(c.id, null)}>
                    <Inbox className="h-3.5 w-3.5" />
                    <span className="flex-1 truncate">Sans dossier</span>
                    {!c.projectId ? <Check className="h-3.5 w-3.5 text-hermes-text" /> : null}
                  </DropdownMenuItem>
                  {moveTargets.map(({ project: p, label, nested }) => (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => onMove(c.id, p.id)}
                      className={nested ? "pl-7" : undefined}
                    >
                      <Folder className="h-3.5 w-3.5" />
                      <span className="flex-1 truncate">{label}</span>
                      {c.projectId === p.id ? (
                        <Check className="h-3.5 w-3.5 text-hermes-text" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(c.id)}>
              <Trash2 className="h-3.5 w-3.5" />
              Supprimer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/** Zone de dépôt d'un groupe (projet ou « Sans projet »). */
