// Sidebar : nouvelle conversation, projets (groupes repliables, drag & drop
// pour ranger et réordonner), recherche (titres + contenu des messages),
// historique groupé par date pour « Sans projet », conversations épinglées.
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HermesLogo } from "@/components/chat/hermes-logo";
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
  connected: boolean;
  isBusy: boolean;
  onNew: (projectId?: string | null) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onSearchMessages: (query: string) => Promise<SearchHit[]>;
  onCreateProject: (name: string) => Promise<Project | null>;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  onReorderProjects: (ids: string[]) => void;
  onMoveConversation: (id: string, projectId: string | null) => void;
  /** Ouvre le sheet Paramètres (engrenage de la carte de statut — FORK.md §7.4). */
  onOpenSettings: () => void;
}

/** Props communes aux items de conversation (partagées entre groupes). */
interface ConvItemShared {
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, projectId: string | null) => void;
  projects: Project[];
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

function ConversationItem({
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
          className="h-8 border-none bg-transparent text-[13px] focus-visible:ring-0"
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
            <Pin className="h-4 w-4 shrink-0 rotate-45 text-hermes" aria-label="Épinglée" />
          ) : (
            <MessageSquare
              className={`h-4 w-4 shrink-0 ${
                isActive ? "text-hermes" : "text-muted-foreground"
              }`}
            />
          )}
          <span className="truncate text-[13.5px]">{c.title}</span>
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
                    <span className="flex-1 truncate">Sans projet</span>
                    {!c.projectId ? <Check className="h-3.5 w-3.5 text-hermes" /> : null}
                  </DropdownMenuItem>
                  {projects.map((p) => (
                    <DropdownMenuItem key={p.id} onClick={() => onMove(c.id, p.id)}>
                      <Folder className="h-3.5 w-3.5" />
                      <span className="flex-1 truncate">{p.name}</span>
                      {c.projectId === p.id ? (
                        <Check className="h-3.5 w-3.5 text-hermes" />
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
function DropZone({
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
function ProjectGroup({
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
          <Folder className="h-4 w-4 shrink-0 text-hermes" />
          <Input
            autoFocus
            value={projectRenameValue}
            onChange={(e) => setProjectRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitProjectRename();
              else if (e.key === "Escape") onCancelProjectRename();
            }}
            className="h-8 border-none bg-transparent text-[13px] focus-visible:ring-0"
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
            <Folder className="h-4 w-4 shrink-0 text-hermes" aria-hidden="true" />
            <span className="truncate text-[12.5px] font-semibold">{project.name}</span>
            <span className="ml-1 shrink-0 rounded-full bg-sidebar-accent px-1.5 py-px text-[10.5px] tabular-nums text-muted-foreground">
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
          <p className="px-3 py-2 text-[12px] italic text-muted-foreground">
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

export function Sidebar({
  conversations,
  projects,
  activeId,
  mode,
  serverModel,
  engineProviders,
  connected,
  isBusy,
  onNew,
  onOpen,
  onDelete,
  onRename,
  onTogglePin,
  onSearchMessages,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onReorderProjects,
  onMoveConversation,
  onOpenSettings,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [messageHits, setMessageHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  // ── Projets : création / renommage inline, repliage persisté ────────
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
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

  // Carte de statut honnête (v2.4) : sans gateway, le moteur intégré répond
  // dès qu au moins un fournisseur a une clé active — on ne dit plus « démo »
  // quand les tours partent réellement sur les API des fournisseurs.
  const poolActive = (engineProviders?.length ?? 0) > 0;

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
      }
    });
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const q = query.trim();
  const isSearching = q.length >= 2;
  const hasProjects = projects.length > 0;

  // Recherche plein-texte (débouncée) dans le contenu des messages
  useEffect(() => {
    if (!isSearching) {
      setMessageHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const hits = await onSearchMessages(q);
        setMessageHits(hits);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, isSearching, onSearchMessages]);

  // Tri des conversations à l'intérieur d'un projet (fork.projects.sort)
  const bySort = useMemo(() => {
    return (a: ConversationMeta, b: ConversationMeta) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (sortMode === "created") return b.createdAt.localeCompare(a.createdAt);
      if (sortMode === "title") return a.title.localeCompare(b.title, "fr");
      return b.updatedAt.localeCompare(a.updatedAt);
    };
  }, [sortMode]);

  // Recherche : résultats plats (titre/aperçu)
  const searchGroups = useMemo(() => {
    const ql = q.toLowerCase();
    const pool = conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(ql) ||
        c.preview.toLowerCase().includes(ql)
    );
    const map = new Map<string, ConversationMeta[]>();
    for (const c of pool) {
      const label = groupLabel(c.updatedAt);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(c);
    }
    return Array.from(map.entries());
  }, [conversations, q]);

  // Conversations par projet + « Sans projet »
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

  // Groupes par date (mode sans projet, ou section « Sans projet »)
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
    onDelete,
    onMove: onMoveConversation,
    projects,
  };

  // ── Projets : actions locales ─────────────────────────────────────
  const toggleProjectCollapsed = (id: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeClientSetting("fork.projects.collapsed", JSON.stringify([...next]));
      return next;
    });
  };

  const submitNewProject = async () => {
    const name = newProjectName.trim();
    setCreatingProject(false);
    setNewProjectName("");
    if (!name) return;
    const p = await onCreateProject(name);
    if (p) setRenamingId(null);
  };

  const commitProjectRename = () => {
    const id = renamingProjectId;
    const name = projectRenameValue.trim();
    setRenamingProjectId(null);
    if (id && name) onRenameProject(id, name);
  };

  const handleDeleteProject = (p: Project) => {
    const count = conversationsByProject.get(p.id)?.length ?? 0;
    const msg =
      count > 0
        ? `Supprimer le projet « ${p.name} » ? Ses ${count} conversation${count > 1 ? "s" : ""} seront conservées et déplacées dans « Sans projet ».`
        : `Supprimer le projet « ${p.name} » ?`;
    if (window.confirm(msg)) onDeleteProject(p.id);
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
      // Rangement : déplacer la conversation dans la zone visée
      const conv = conversations.find((c) => c.id === a.id);
      const current = conv?.projectId ?? null;
      const target = o.projectId ?? null;
      if (current !== target) onMoveConversation(a.id, target);
    } else if (a.type === "project" && a.id && o.projectId) {
      // Réordonnancement : placer le projet avant le projet visé
      if (o.projectId === a.id) return;
      const ids = projects.map((p) => p.id);
      const from = ids.indexOf(a.id);
      if (from < 0) return;
      ids.splice(from, 1);
      const to = ids.indexOf(o.projectId);
      ids.splice(to < 0 ? ids.length : to, 0, a.id);
      onReorderProjects(ids);
    }
  };

  const itemProps = {
    onOpen,
    onRename,
    onTogglePin,
    onDelete,
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

      {/* Nouvelle conversation + nouveau projet */}
      <div className="space-y-1.5 px-3 pb-2">
        <Button
          onClick={() => onNew(null)}
          disabled={isBusy}
          variant="outline"
          className="h-10 w-full justify-start gap-2 rounded-xl border-sidebar-border bg-transparent text-[14px] font-medium hover:bg-sidebar-accent"
        >
          <Plus className="h-4 w-4" />
          Nouvelle conversation
        </Button>
        {creatingProject ? (
          <div className="flex items-center gap-1 rounded-xl bg-sidebar-accent px-2 py-1">
            <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitNewProject();
                else if (e.key === "Escape") {
                  setCreatingProject(false);
                  setNewProjectName("");
                }
              }}
              placeholder="Nom du projet…"
              className="h-8 border-none bg-transparent text-[13px] focus-visible:ring-0"
              aria-label="Nom du nouveau projet"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => void submitNewProject()}
              aria-label="Créer le projet"
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => {
                setCreatingProject(false);
                setNewProjectName("");
              }}
              aria-label="Annuler"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            onClick={() => setCreatingProject(true)}
            className="h-8 w-full justify-start gap-2 rounded-xl px-2 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <FolderPlus className="h-4 w-4" />
            Nouveau projet
          </Button>
        )}
      </div>

      {/* Recherche */}
      <div className="px-3 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher…"
            aria-label="Rechercher dans les conversations et les messages"
            className="h-9 rounded-xl border-transparent bg-sidebar-accent pl-9 text-[13px] focus-visible:border-transparent focus-visible:ring-1 focus-visible:ring-ring"
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
            <>
              <p className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Conversations ({searchGroups.reduce((n, [, items]) => n + items.length, 0)})
              </p>
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
                        <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                          {hit.role === "user" ? "Vous : " : "Hermes : "}
                          {hit.excerpt}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : hasProjects ? (
            <>
              {projects.map((p) => (
                <DropZone key={p.id} zoneId={p.id} projectId={p.id}>
                  <ProjectGroup
                    project={p}
                    conversations={conversationsByProject.get(p.id) ?? []}
                    activeId={activeId}
                    collapsed={collapsedProjects.has(p.id)}
                    onToggleCollapse={() => toggleProjectCollapsed(p.id)}
                    shared={shared}
                    renamingId={renamingId}
                    renameValue={renameValue}
                    setRenameValue={setRenameValue}
                    setRenamingId={setRenamingId}
                    onStartProjectRename={() => {
                      setRenamingProjectId(p.id);
                      setProjectRenameValue(p.name);
                    }}
                    renamingProject={renamingProjectId === p.id}
                    projectRenameValue={projectRenameValue}
                    setProjectRenameValue={setProjectRenameValue}
                    onCommitProjectRename={commitProjectRename}
                    onCancelProjectRename={() => setRenamingProjectId(null)}
                    onNewInProject={() => onNew(p.id)}
                    onDeleteProject={() => handleDeleteProject(p)}
                  />
                </DropZone>
              ))}
              {unprojected.length > 0 ? (
                <DropZone zoneId="_none" projectId={null} className="mt-2">
                  <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Sans projet
                  </p>
                  {dateGroups.map(([label, items]) => (
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
                  ))}
                </DropZone>
              ) : null}
              {!hasProjects && pinned.length === 0 && conversations.length === 0 ? (
                <p className="px-2 pt-6 text-center text-[13px] text-muted-foreground">
                  Pas encore de conversation.
                </p>
              ) : null}
            </>
          ) : conversations.length === 0 ? (
            <p className="px-2 pt-6 text-center text-[13px] text-muted-foreground">
              Pas encore de conversation.
            </p>
          ) : (
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
          )}
        </nav>

        <DragOverlay>
          {activeDrag ? (
            <div className="flex max-w-[220px] items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 shadow-lg">
              {activeDrag.type === "project" ? (
                <Folder className="h-4 w-4 shrink-0 text-hermes" />
              ) : (
                <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-[13px]">{activeDrag.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Carte de statut du moteur */}
      <div className="border-t border-sidebar-border p-3">
        <div className="rounded-xl bg-sidebar-accent px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                !connected
                  ? "bg-muted-foreground/50"
                  : mode === "gateway" || (mode === "demo" && poolActive)
                    ? "bg-emerald-500"
                    : "bg-hermes"
              }`}
              aria-hidden="true"
            />
            <p className="truncate text-[12.5px] font-medium leading-none">
              {!connected
                ? "Hors ligne"
                : mode === "gateway"
                  ? "Gateway Hermes connectée"
                  : poolActive
                    ? "Moteur intégré · vos clés répondent"
                    : "Mode démo · LLM intégré"}
            </p>
            {/* Entrée unique des paramètres (décision v1 confirmée v3) */}
            <button
              type="button"
              onClick={onOpenSettings}
              title="Paramètres"
              aria-label="Ouvrir les paramètres"
              className="ml-auto flex size-[27px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground hover:shadow-sm focus-visible:outline-2 focus-visible:outline-hermes"
            >
              <Settings className="size-[14px]" />
            </button>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
            {!connected ? (
              "Reconnexion automatique en cours…"
            ) : mode === "gateway" ? (
              (serverModel ?? "")
            ) : poolActive ? (
              <>
                Clés actives : {engineProviders!.join(", ")} — les réponses
                viennent de leurs API.
              </>
            ) : (
              <>
                Ajoutez une clé dans Paramètres → Fournisseurs &amp; clés, ou
                définissez{" "}
                <code className="break-all rounded bg-background/60 px-1 py-px font-mono text-[10.5px]">
                  HERMES_GATEWAY_URL
                </code>{" "}
                pour brancher l&apos;agent Hermes.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
