// Section « Archives » (F-60, renommée « Bibliothèque » → « Archives » le
// 22-11 à la demande de l'utilisatrice) — les dossiers archivés. Repliée par
// défaut (fork.archives.collapsed), compteur toujours visible ; chaque ligne
// propose Désarchiver (repart dans « Mes dossiers ») et Supprimer (même garde
// que les dossiers actifs). Rien n'est draggable ici : hors du rangement
// actif. Fichier neuf (R1).
"use client";

import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarSectionHeader } from "@/components/chat/sidebar-section-header";
import type { ConversationMeta, Project } from "@/lib/chat-types";

export function SidebarArchives({
  projects,
  allProjects,
  conversationsOf,
  collapsed,
  onToggle,
  onRestore,
  onDelete,
}: {
  /** Dossiers archivés (drapeau `archived` du service). */
  projects: Project[];
  /** Liste complète — pour préfixer les sous-dossiers « Parent › ». */
  allProjects: Project[];
  conversationsOf: (projectId: string) => ConversationMeta[];
  collapsed: boolean;
  onToggle: () => void;
  onRestore: (id: string) => void;
  onDelete: (p: Project) => void;
}) {
  return (
    <div className="mt-1">
      <SidebarSectionHeader
        title="Archives"
        actions={
          <>
            <span
              className="rounded-full bg-sidebar-accent px-1.5 py-px text-[11px] tabular-nums text-muted-foreground"
              aria-label={`${projects.length} dossier${projects.length > 1 ? "s" : ""} archivé${projects.length > 1 ? "s" : ""}`}
            >
              {projects.length}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-sidebar-foreground"
              onClick={onToggle}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Déplier les Archives" : "Replier les Archives"}
            >
              {collapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </Button>
          </>
        }
      />
      {!collapsed ? (
        <ul className="space-y-0.5 pb-1">
          {projects.map((p) => {
            const parent = p.parentId
              ? allProjects.find((x) => x.id === p.parentId)
              : null;
            const count = conversationsOf(p.id).length;
            return (
              <li
                key={p.id}
                className="group/arch flex items-center gap-0.5 rounded-lg px-1 py-1 hover:bg-sidebar-accent"
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-left">
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate text-[12.5px] text-muted-foreground">
                    {parent ? `${parent.name} › ${p.name}` : p.name}
                  </span>
                  <span className="ml-1 shrink-0 rounded-full bg-sidebar-accent px-1.5 py-px text-[11px] tabular-nums text-muted-foreground">
                    {count}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover/arch:opacity-100"
                  onClick={() => onRestore(p.id)}
                  aria-label={`Désarchiver le dossier ${p.name}`}
                >
                  <ArchiveRestore className="h-3.5 w-3.5" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover/arch:opacity-100 data-[state=open]:opacity-100"
                      aria-label={`Options pour ${p.name} (archivé)`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => onRestore(p.id)}>
                      <Archive className="h-3.5 w-3.5" />
                      Désarchiver
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => onDelete(p)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Supprimer le dossier
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
