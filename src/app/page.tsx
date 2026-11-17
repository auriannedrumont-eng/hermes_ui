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
import { useProviders } from "@/hooks/use-providers";
import { useSystemPrompts } from "@/hooks/use-system-prompts";
import { useMemory } from "@/hooks/use-memory";
import { useIsMobile } from "@/hooks/use-mobile";
import { getSocket } from "@/lib/socket";
import { Sidebar } from "@/components/chat/sidebar";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { SystemPromptPanel } from "@/components/settings/system-prompt-panel";
import { ChatHeader, type ExportFormat } from "@/components/chat/chat-header";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { CommandPalette } from "@/components/chat/command-palette";
import { DebugBridge } from "@/components/chat/debug-bridge";
import { ArtifactPanel, ArtifactViewerDialog } from "@/components/chat/artifact-panel";
import { useHermesChat } from "@/hooks/use-hermes-chat";
import { exportJson, exportMarkdown, exportPdf } from "@/lib/export";
import { flashTitle, playCompletionBeep, setGeneratingTitle } from "@/lib/notify";
import { onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import type { Artifact, ShareView, TurnTools } from "@/lib/chat-types";

const SIDEBAR_WIDTH_KEY = "fork.ui.sidebar.width"; // registre des réglages (FORK.md §6)

export default function HermesWebPage() {
  // La page orchestre deux hooks : le chat (source de vérité) et les prompts
  // système (F-11/F-19). Le prompt actif de la conversation est injecté dans
  // la jauge de contexte du composer (poste « Prompt de conversation »).
  const chat = useHermesChat();
  const promptsApi = useSystemPrompts(chat.activeId);
  // Mémoire utilisateur (F-18) — section Hermes du volet Paramètres.
  const memoryApi = useMemory();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Visionneuse plein écran (mobile uniquement). */
  const [viewerOpen, setViewerOpen] = useState(false);
  /** Sheet Paramètres (engrenage de la carte de statut — FORK.md §7.4). */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Sheet « Prompt système de la conversation » (F-11). */
  const [promptOpen, setPromptOpen] = useState(false);
  const providersApi = useProviders();
  /** F-09 — une clé Tavily/Exa active rend le toggle « Web » du composer actionnable. */
  const webSearchAvailable = useMemo(
    () =>
      providersApi.providers.some(
        (p) =>
          p.kind === "service" &&
          /tavily|exa/i.test(p.name) &&
          p.keys.some((k) => k.status === "ok" || k.status === "untested"),
      ),
    [providersApi.providers],
  );
  const sidebarRef = useRef<ImperativePanelHandle>(null);

  // ── Partage public lecture seule (F-13) ────────────────────────────────
  // Un seul lien actif par conversation ; le bus share:changed (broadcast)
  // maintient l'état à jour, le changement de conversation recharge (l'ack
  // repart de zéro : null tant que la réponse n'est pas arrivée).
  const [share, setShare] = useState<ShareView | null>(null);
  useEffect(() => {
    const id = chat.activeId;
    if (!id) return;
    const socket = getSocket();
    socket.emit(
      "share:get",
      { conversationId: id },
      (res: { share?: ShareView | null } = {}) => {
        if (id !== chat.activeId) return;
        setShare(res.share ?? null);
      }
    );
  }, [chat.activeId]);
  useEffect(() => {
    const socket = getSocket();
    const onShareChanged = (p: { conversationId: string; share?: ShareView | null }) => {
      if (p.conversationId !== chat.activeId) return;
      setShare(p.share ?? null);
    };
    socket.on("share:changed", onShareChanged);
    return () => {
      socket.off("share:changed", onShareChanged);
    };
  }, [chat.activeId]);

  /** Crée le lien public (snapshot figé) et copie l'URL dans le presse-papier. */
  const handleShareCreate = useCallback(async (): Promise<ShareView | null> => {
    const id = chat.activeId;
    if (!id) return null;
    return new Promise((resolve) => {
      getSocket().emit(
        "share:create",
        { conversationId: id },
        (res: { share?: ShareView; error?: string } = {}) => {
          if (res.share) {
            setShare(res.share);
            const url = `${window.location.origin}/shared/${res.share.token}`;
            navigator.clipboard
              ?.writeText(url)
              .then(() => {
                toast({
                  title: "Lien de partage créé et copié",
                  description: `${res.share!.messageCount} message(s) figés — lecture seule, révocable à tout moment.`,
                  duration: 4000,
                });
              })
              .catch(() => {
                toast({
                  title: "Lien de partage créé",
                  description: url,
                  duration: 6000,
                });
              });
          } else if (res.error) {
            toast({
              title: "Partage impossible",
              description: res.error,
              variant: "destructive",
            });
          }
          resolve(res.share ?? null);
        }
      );
    });
  }, [chat.activeId, toast]);

  /** Révoque le lien actif (le destinataire voit « lien révoqué »). */
  const handleShareRevoke = useCallback(() => {
    const id = chat.activeId;
    if (!id) return;
    getSocket().emit(
      "share:revoke",
      { conversationId: id },
      (res: { ok?: boolean } = {}) => {
        if (res.ok) {
          setShare(null);
          toast({ title: "Lien révoqué", description: "La vue publique n'est plus accessible.", duration: 3000 });
        }
      }
    );
  }, [chat.activeId, toast]);

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

  // ── Terminal du tour : activité outil du message qui porte l'artefact ─
  // Le stream vivant d'abord (étapes en direct), le message persisté ensuite.
  const resolveTurnTools = useCallback(
    (messageId?: string): TurnTools => {
      const stream = messageId ? chat.streams[messageId] : undefined;
      if (stream) return { events: stream.toolEvents, live: true };
      const msg = messageId
        ? chat.messages.find((m) => m.id === messageId)
        : undefined;
      return { events: msg?.toolEvents ?? [], live: false };
    },
    [chat.streams, chat.messages]
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
      engineProviders={chat.engineProviders}
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
    // Wrapper à hauteur fixe : ResizablePanelGroup pose un style inline
    // height:100% qui écrase h-dvh — il faut un parent dimensionné, sinon
    // l'app tient sur la hauteur de son contenu (composer non ancré en bas,
    // bande vide sous la sidebar — constaté en QA 2026-11-14).
    <div className="h-app-full w-full bg-background text-foreground">
      <ResizablePanelGroup direction="horizontal" className="h-full w-full">
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
            hasPrompt={chat.promptInfo !== null}
            onOpenPrompt={() => setPromptOpen(true)}
            share={share}
            onShareCreate={handleShareCreate}
            onShareRevoke={handleShareRevoke}
            onExport={handleExport}
            onOpenSidebar={() => setMobileOpen(true)}
          />
          <MessageList
            messages={chat.messages}
            streams={chat.streams}
            loadingHistory={chat.loadingHistory}
            isBusy={chat.isBusy}
            turnError={chat.turnError}
            stallNotice={chat.stallNotice}
            artifacts={chat.artifacts}
            artifactStreams={chat.streamingArtifacts}
            onSuggestion={(prompt) => chat.sendMessage(prompt)}
            onRegenerate={() => chat.regenerate()}
            onRegenerateVariant={(v) => chat.regenerate(v)}
            onSetVersion={chat.setMessageVersion}
            onRetryError={chat.retryAfterError}
            onDismissError={chat.dismissTurnError}
            onEdit={chat.editMessage}
            onDelete={chat.deleteMessage}
            onFork={handleFork}
            onOpenArtifact={handleOpenArtifact}
            onRetryArtifact={chat.retryArtifact}
            conversationMode={chat.conversationMode}
            modeFlowLive={chat.modeFlowLive}
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
            conversationMode={chat.conversationMode}
            conversationModeConfig={chat.conversationModeConfig}
            onSetConversationMode={chat.setConversationMode}
            effort={chat.effort}
            onEffortChange={chat.setEffort}
            expert={chat.expert}
            onExpertChange={chat.setExpert}
            permissionsMode={chat.permissionsMode}
            onPermissionsChange={chat.setPermissionsMode}
            webSearch={chat.webSearch}
            onToggleWebSearch={chat.toggleWebSearch}
            webSearchAvailable={webSearchAvailable}
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
              resolveTurnTools={resolveTurnTools}
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
        resolveTurnTools={resolveTurnTools}
        onSelectVersion={chat.selectArtifactVersion}
        onRetry={chat.retryArtifact}
        fetchVersions={chat.fetchArtifactVersions}
      />

      {/* Volet Paramètres v4 (860 px, rail) — Interface, Modèles,
          Fournisseurs, Clés de services, Extensions, Hermes, Outils,
          Skills, Profils, Système… */}
      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        mode={chat.mode}
        engineProviders={chat.engineProviders}
        connected={chat.connected}
        models={chat.models}
        selectedModel={chat.selectedModel}
        projects={chat.projects}
        api={providersApi}
        promptsApi={promptsApi}
        memoryApi={memoryApi}
        serverVersion={chat.serverVersion}
        appRevision={chat.serverRevision}
        chromeHeadless={chat.chromeHeadless}
        gatewayUrl={chat.gatewayUrl}
        gatewayTokenSet={chat.gatewayTokenSet}
        onConnectGateway={chat.connectGateway}
        webSearchAvailable={webSearchAvailable}
      />

      {/* Sheet « Prompt système de la conversation » (F-11) */}
      <SystemPromptPanel
        open={promptOpen}
        onOpenChange={setPromptOpen}
        prompt={promptsApi.prompt}
        presets={promptsApi.presets}
        conversationTitle={activeConversation?.title ?? null}
        onSave={(content, presetTitle) => {
          void promptsApi.savePrompt(content, presetTitle);
        }}
        onClear={() => {
          void promptsApi.clearPrompt();
        }}
        onCreatePreset={promptsApi.createPreset}
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
      {/* Pont de dépannage (F-31) — visible quand l'URL porte ?debug=1 :
          journal live + « Copier le diagnostic » à coller à l'agent. */}
      <DebugBridge />
    </div>
  );
}
