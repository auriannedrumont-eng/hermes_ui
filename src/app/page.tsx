// Hermes Web — interface de chat type ChatGPT pour l'agent Hermes de Nous Research.
// Layout : la conversation reste le chef d'orchestre ; l'artefact est un objet
// de première classe — sidebar fluide à gauche, chat au centre, panneau artefact
// à droite (≈ 45 %) qui s'ouvre automatiquement à la naissance d'un artefact.
// Mobile : cartes inline + visionneuse plein écran avec swipe.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sidebar } from "@/components/chat/sidebar";
import { SettingsSheet } from "@/components/settings/settings-sheet";
import { ChatHeader, type ExportFormat } from "@/components/chat/chat-header";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { CommandPalette } from "@/components/chat/command-palette";
import { ArtifactPanel, ArtifactViewerDialog } from "@/components/chat/artifact-panel";
import { useHermesChat } from "@/hooks/use-hermes-chat";
import { exportJson, exportMarkdown, exportPdf } from "@/lib/export";
import { flashTitle, playCompletionBeep, setGeneratingTitle } from "@/lib/notify";
import { onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import type { Artifact } from "@/lib/chat-types";

const SIDEBAR_WIDTH_KEY = "fork.ui.sidebar.width"; // registre des réglages (FORK.md §6)

export default function HermesWebPage() {
  const chat = useHermesChat();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Visionneuse plein écran (mobile uniquement). */
  const [viewerOpen, setViewerOpen] = useState(false);
  /** Sheet Paramètres (engrenage de la carte de statut — FORK.md §7.4). */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sidebarRef = useRef<ImperativePanelHandle>(null);

  const activeConversation = useMemo(
    () => chat.conversations.find((c) => c.id === chat.activeId) ?? null,
    [chat.conversations, chat.activeId]
  );

  // ── Sidebar fluide : restaure la largeur mémorisée (registre fork) ───
  // Garde-fou : la librairie émet `onResize` dès le montage (taille par défaut) —
  // sans ce drapeau, elle écraserait la largeur persistée avant sa restauration.
  const sidebarRestoredRef = useRef(false);
  useEffect(() => {
    const pct = readClientSetting<number>(SIDEBAR_WIDTH_KEY);
    if (Number.isFinite(pct) && pct >= 12 && pct <= 34) {
      sidebarRef.current?.resize(pct);
    }
    sidebarRestoredRef.current = true;
  }, []);

  const handleSidebarResize = useCallback((size: number) => {
    if (!Number.isFinite(size)) return;
    if (!sidebarRestoredRef.current) return; // taille initiale au montage
    writeClientSetting(SIDEBAR_WIDTH_KEY, size);
  }, []);

  // ── Largeur de sidebar : application immédiate depuis le sheet ────────
  // (le garde-fou évite la boucle : le panneau réémet sa taille à l'écriture)
  useEffect(() => {
    return onSettingsChanged(({ key, value }) => {
      if (key !== SIDEBAR_WIDTH_KEY || typeof value !== "number") return;
      const pct = Math.min(34, Math.max(12, value));
      const cur = sidebarRef.current?.getSize();
      if (cur == null || Math.abs(cur - pct) > 0.05) {
        sidebarRef.current?.resize(pct);
      }
    });
  }, []);

  const handleNew = useCallback((projectId?: string | null) => {
    chat.newConversation(projectId);
    setMobileOpen(false);
  }, [chat]);

  const handleOpen = useCallback(
    (id: string) => {
      chat.openConversation(id);
      setMobileOpen(false);
    },
    [chat]
  );

  // ── Fork : crée une branche depuis un message et l'ouvre ────────────
  const handleFork = useCallback(
    async (messageId: string) => {
      const newId = await chat.forkConversation(messageId);
      if (newId) {
        toast({
          title: "Branche créée",
          description: "La conversation a été dupliquée depuis ce message.",
        });
        chat.openConversation(newId);
      } else {
        toast({ title: "Impossible de créer la branche", variant: "destructive" });
      }
    },
    [chat, toast]
  );

  // ── Artefacts : ouverture (panneau bureau / plein écran mobile) ─────
  const handleOpenArtifact = useCallback(
    (artifact: Artifact) => {
      chat.openArtifact(artifact);
      if (isMobile) setViewerOpen(true);
    },
    [chat, isMobile]
  );

  // ── Export de la conversation active ────────────────────────────────
  const handleExport = useCallback(
    (format: ExportFormat) => {
      if (!activeConversation || chat.messages.length === 0) return;
      try {
        if (format === "markdown") exportMarkdown(activeConversation, chat.messages);
        else if (format === "json") exportJson(activeConversation, chat.messages);
        else exportPdf(activeConversation, chat.messages);
        toast({
          title:
            format === "pdf"
              ? "Impression PDF lancée"
              : "Export téléchargé",
          description:
            format === "markdown"
              ? "Fichier Markdown généré."
              : format === "json"
                ? "Fichier JSON généré."
                : "Choisissez « Enregistrer au format PDF » dans la boîte d'impression.",
        });
      } catch {
        toast({ title: "Échec de l'export", variant: "destructive" });
      }
    },
    [activeConversation, chat.messages, toast]
  );

  // ── Raccourcis clavier globaux ─────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        handleNew();
        return;
      }
      if (
        e.key === "Escape" &&
        !paletteOpen
      ) {
        const target = e.target as HTMLElement | null;
        const inField =
          target &&
          (target.tagName === "TEXTAREA" ||
            target.tagName === "INPUT" ||
            target.isContentEditable);
        if (chat.panelOpen && !inField) {
          // Échap referme d'abord le panneau des artefacts
          e.preventDefault();
          chat.closePanel();
          return;
        }
        if (!inField && chat.isBusy) {
          e.preventDefault();
          chat.stopGeneration();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNew, paletteOpen, chat]);

  // ── Notifications de fin de génération (onglet en arrière-plan) ────
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const streamingNow = chat.streaming !== null;
    if (streamingNow) {
      wasStreamingRef.current = true;
      if (document.hidden) setGeneratingTitle(true);
    } else if (wasStreamingRef.current) {
      wasStreamingRef.current = false;
      setGeneratingTitle(false);
      if (document.hidden) {
        playCompletionBeep();
        flashTitle("Réponse prête — Hermes Web");
      }
    }
  }, [chat.streaming]);

  // Titre dynamique pendant la génération (même onglet visible)
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (chat.streaming) setGeneratingTitle(true);
      } else {
        setGeneratingTitle(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [chat.streaming]);

  const sidebar = (
    <Sidebar
      conversations={chat.conversations}
      projects={chat.projects}
      activeId={chat.activeId}
      mode={chat.mode}
      serverModel={chat.serverModel}
      connected={chat.connected}
      isBusy={chat.isBusy}
      onNew={handleNew}
      onOpen={handleOpen}
      onDelete={chat.deleteConversation}
      onRename={chat.renameConversation}
      onTogglePin={chat.togglePin}
      onSearchMessages={chat.searchMessages}
      onCreateProject={chat.createProject}
      onRenameProject={chat.renameProject}
      onDeleteProject={chat.deleteProject}
      onReorderProjects={chat.reorderProjects}
      onMoveConversation={chat.moveConversation}
      onOpenSettings={() => {
        setSettingsOpen(true);
        setMobileOpen(false); // mobile : le sheet remplace la sidebar
      }}
    />
  );

  return (
    <ResizablePanelGroup direction="horizontal" className="h-dvh w-full bg-background text-foreground">
      {/* Sidebar bureau — largeur fluide, mémorisée */}
      {!isMobile ? (
        <>
          <ResizablePanel
            ref={sidebarRef}
            id="sidebar"
            order={1}
            defaultSize={19}
            minSize={14}
            maxSize={34}
            onResize={handleSidebarResize}
            className="min-w-0"
          >
            {sidebar}
          </ResizablePanel>
          <ResizableHandle className="bg-sidebar-border" />
        </>
      ) : null}

      {/* Zone de conversation (le chef d'orchestre) */}
      <ResizablePanel id="chat" order={2} defaultSize={81} minSize={36} className="min-w-0">
        <main className="flex h-full min-w-0 flex-col">
          <ChatHeader
            activeConversation={activeConversation}
            mode={chat.mode}
            connected={chat.connected}
            hasMessages={chat.messages.length > 0}
            onExport={handleExport}
            onOpenSidebar={() => setMobileOpen(true)}
          />
          <MessageList
            messages={chat.messages}
            streaming={chat.streaming}
            loadingHistory={chat.loadingHistory}
            isBusy={chat.isBusy}
            artifacts={chat.artifacts}
            artifactStreams={chat.streamingArtifacts}
            onSuggestion={(prompt) => chat.sendMessage(prompt)}
            onRegenerate={chat.regenerate}
            onEdit={chat.editMessage}
            onDelete={chat.deleteMessage}
            onFork={handleFork}
            onOpenArtifact={handleOpenArtifact}
            onRetryArtifact={chat.retryArtifact}
          />
          <Composer
            disabled={!chat.connected}
            isBusy={chat.isBusy}
            draftKey={chat.activeId ?? "new"}
            models={chat.models}
            modelsSource={chat.modelsSource}
            mode={chat.mode}
            selectedModel={chat.selectedModel}
            onSelectModel={chat.setSelectedModel}
            effort={chat.effort}
            onEffortChange={chat.setEffort}
            permissionsMode={chat.permissionsMode}
            onPermissionsChange={chat.setPermissionsMode}
            contextBase={chat.contextBase}
            canCompact={chat.canCompact}
            compactRunning={chat.compacting}
            onCompact={chat.compactConversation}
            onNewSession={() => {
              void chat.startNewSession();
            }}
            onSend={(text, attachments) => chat.sendMessage(text, attachments)}
            onStop={chat.stopGeneration}
            onUploadFile={chat.uploadAttachment}
            onTranscribe={chat.transcribeAudio}
          />
        </main>
      </ResizablePanel>

      {/* Panneau artefact (bureau) — s'ouvre automatiquement à la naissance */}
      {chat.panelOpen && !isMobile ? (
        <>
          <ResizableHandle />
          <ResizablePanel
            id="artifacts"
            order={3}
            defaultSize={44}
            minSize={26}
            maxSize={62}
            className="min-w-0"
          >
            <ArtifactPanel
              artifacts={chat.artifacts}
              selectedId={chat.panelArtifactId}
              streamingArtifacts={chat.streamingArtifacts}
              onSelectVersion={chat.selectArtifactVersion}
              onClose={chat.closePanel}
              onRetry={chat.retryArtifact}
              fetchVersions={chat.fetchArtifactVersions}
            />
          </ResizablePanel>
        </>
      ) : null}

      {/* Sidebar mobile */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[300px] gap-0 p-0">
          <SheetTitle className="sr-only">Menu des conversations</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      {/* Visionneuse artefact plein écran (mobile) */}
      <ArtifactViewerDialog
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        artifacts={chat.artifacts}
        selectedId={chat.panelArtifactId}
        streamingArtifacts={chat.streamingArtifacts}
        onSelectVersion={chat.selectArtifactVersion}
        onRetry={chat.retryArtifact}
        fetchVersions={chat.fetchArtifactVersions}
      />

      {/* Sheet Paramètres (étage client — phase 1, maquette v3) */}
      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        mode={chat.mode}
        connected={chat.connected}
        models={chat.models}
        selectedModel={chat.selectedModel}
        projects={chat.projects}
      />

      {/* Palette de commandes (Cmd/Ctrl+K) */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        conversations={chat.conversations}
        activeConversation={activeConversation}
        models={chat.models}
        selectedModel={chat.selectedModel}
        isBusy={chat.isBusy}
        hasMessages={chat.messages.length > 0}
        onNewConversation={handleNew}
        onSelectModel={chat.setSelectedModel}
        onOpenConversation={handleOpen}
        onTogglePin={chat.togglePin}
        onRegenerate={chat.regenerate}
        onStop={chat.stopGeneration}
        onExport={handleExport}
        onSearchMessages={chat.searchMessages}
      />
    </ResizablePanelGroup>
  );
}
