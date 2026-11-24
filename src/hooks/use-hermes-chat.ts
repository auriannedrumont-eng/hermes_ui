// Hook principal : orchestre les conversations, la sélection de modèle,
// les pièces jointes multimédia et le streaming via socket.io
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import { streamStore } from "@/lib/stream-store";
import { BUILD_REVISION } from "@/lib/build-revision";
import { deleteClientSetting, onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import { resolveMode, type ConversationMode, type ModeConfig } from "@/lib/modes";
import { useToast } from "@/hooks/use-toast";
import { useProjects } from "@/hooks/use-projects";
import { useChatSettings } from "@/hooks/use-chat-settings";
import { useArtifactsPanel } from "@/hooks/use-artifacts-panel";
import { useChatStream } from "@/hooks/use-chat-stream";
import { useChatSocketEvents } from "@/hooks/use-chat-socket-events";
import { useConversations } from "@/hooks/use-conversations";
import {
  contextWindowOf,
  estimateTokens,
  SYSTEM_PROMPT_ESTIMATE,
  type ContextRow,
} from "@/lib/tokens";
import { shouldAutoCompact, clampCompactThreshold } from "@/lib/compaction";
import type {
  Artifact,
  Attachment,
  ChatMessage,
  CompactInfo,
  ConversationMeta,
  ExpertSettings,
  GatewayMode,
  ModelOption,
  ModelsResult,
  PermissionsMode,
  UpdateCheckResult,
  Project,
  SearchHit,
  ServerHello,
  StreamingState,
  ToolEvent,
} from "@/lib/chat-types";

const MODEL_SETTING_KEY = "hermes.model"; // registre des réglages (FORK.md §6)
const EFFORT_SETTING_KEY = "hermes.reasoning.effort";
const PERMISSIONS_SETTING_KEY = "hermes.permissions.mode";
// Mode expert (F-22) — registre des réglages (FORK.md §6)
const EXPERT_TEMPERATURE_KEY = "hermes.expert.temperature";
const EXPERT_MAX_TOKENS_KEY = "hermes.expert.maxTokens";
const EXPERT_SEED_KEY = "hermes.expert.seed";
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 Mo, aligné sur le service

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error("Lecture du fichier impossible"));
    reader.readAsDataURL(file);
  });
}

/** Prompt système de la conversation active (F-11) — injecté par la page
 *  depuis le hook dédié `useSystemPrompts`, pour la jauge de contexte. */
export interface ChatPromptInfo {
  content: string;
  presetTitle?: string | null;
}

export function useHermesChat() {
  // Garde anti double-émission de conversations:create (Lot 3, audit L3-5).
  const creatingRef = useRef(false);

  const { toast } = useToast();
  const {
    projects,
    setProjects,
    fetchProjects,
    createProject,
    renameProject,
    deleteProject,
    setProjectArchived,
    reorderProjects,
  } = useProjects();
  /** Miroir ref de `projects` (F-59) : les écouteurs socket (projects:deleted)
   *  ont besoin des sous-dossiers courants sans dépendre du tableau de deps. */
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const [connected, setConnected] = useState(false);
  const [serverInfo, setServerInfo] = useState<ServerHello | null>(null);
  // v0.3.3 — état de mise à jour poussé par le service (vérifié au
  // démarrage puis toutes les 6 h, sans ouvrir la page Système) :
  // source unique du point orange sur l'engrenage/onglet Système.
  const [updateState, setUpdateState] = useState<UpdateCheckResult | null>(null);
  // Toast de mise à jour : UNE fois par session de navigateur — un
  // rediffusion hello/update-state ne doit pas ressusciter le toast.
  const updateToastShownRef = useRef(false);
  // §9 (61) — écran vieux : révision cuite dans ce bundle (BUILD_REVISION,
  // au build) != appRevision du hello du service. Un onglet ouvert avant
  // une mise à jour se reconnecte en silence (socket.io) et peut vivre
  // des heures sur l'ancienne interface sans qu'on puisse le lui dire.
  // Bandeau « Recharger la page » dans page.tsx — JAMAIS de rechargement
  // forcé : l'utilisatrice choisit son moment (pas en plein tour).
  const [screenOutdated, setScreenOutdated] = useState<string | null>(null);
  // Miroir de screenOutdated (lecture par le dismiss sans dépendre du
  // state) + révision pour laquelle le bandeau a été fermé : une simple
  // rediffusion hello ne doit pas le ressusciter (même loi que le toast).
  const screenOutdatedRef = useRef<string | null>(null);
  const screenOutdatedDismissedRef = useRef<string | null>(null);
  const dismissScreenOutdated = useCallback(() => {
    if (screenOutdatedRef.current) {
      screenOutdatedDismissedRef.current = screenOutdatedRef.current;
    }
    screenOutdatedRef.current = null;
    setScreenOutdated(null);
  }, []);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  // Projets : hook dédié (découpage 2026-11, FORK.md §10).
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Streams en vol : hook dédié (découpage 2026-11, FORK.md §10) — registre
  // F-17, déroulé F-30, erreur F-04, notice de silence F-31. Câblé après
  // refreshConversations (les handlers ont besoin de setMessages).

  // ── F-30 — mode de la conversation : le service fait foi ──────────
  /** Mode/config choisis avant qu'une conversation n'existe (état « nouveau »).
   *  Appliqués à la création, puis vidés. */
  const [pendingMode, setPendingMode] = useState<{
    mode: ConversationMode;
    config: ModeConfig;
  } | null>(null);
  const pendingModeRef = useRef(pendingMode);
  pendingModeRef.current = pendingMode;
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  /** État de compaction de la conversation active. */
  const [compactInfo, setCompactInfo] = useState<CompactInfo | null>(null);
  /** Compaction en cours (synthèse LLM côté service). */
  const [compacting, setCompacting] = useState(false);
  /** Miroir ref de `compacting` (garde anti-double-tour immédiate, v2.4). */
  const compactingRef = useRef(false);
  /** Dernière base de contexte connue (v2.4 — décision de résumé automatique
   *  au moment d'envoyer ; synchro par effet après chaque rendu). */
  const contextBaseRef = useRef<{
    rows: ContextRow[];
    historyCount: number;
    windowTokens: number;
  } | null>(null);
  // ── Prompt système de la conversation active (F-11) ─────────────────
  /** Prompt actif de la conversation ouverte (null si aucun) — suit le bus
   *  `system-prompt:changed` du service ; la page lit/écrit via le hook dédié. */
  const [promptInfo, setPromptInfo] = useState<ChatPromptInfo | null>(null);
  const promptInfoRef = useRef<ChatPromptInfo | null>(null);
  const activeIdRef = useRef<string | null>(null);
  /** (audit 2026-11-21) Identifiant du chargement d'historique EN COURS :
   *  un ack écarté (navigation, nouvelle conversation, suppression) ne doit
   *  jamais laisser loadingHistory vrai — le squelette restait collé. */
  const loadingForRef = useRef<string | null>(null);

  // Synchronise la ref activeId (lecture seule côté handlers d'événements)
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Réglages du compositeur : hook dédié (découpage 2026-11, FORK.md §10) —
  // modèles, effort, expert F-22, permissions, recherche web F-09/F-12.
  const {
    models,
    setModels,
    modelsSource,
    setModelsSource,
    selectedModel,
    selectedModelRef,
    setSelectedModelState,
    effort,
    effortRef,
    expert,
    expertRef,
    permissionsMode,
    permissionsRef,
    webSearch,
    webSearchRef,
    setSelectedModel,
    setEffort,
    setExpert,
    changePermissions,
    toggleWebSearch,
  } = useChatSettings();

  // Artefacts + panneau : hook dédié (découpage 2026-11, FORK.md §10) —
  // états, fetch des versions, ouverture du panneau, retry.
  const {
    artifacts,
    setArtifacts,
    streamingArtifacts,
    setStreamingArtifacts,
    panelOpen,
    setPanelOpen,
    panelArtifactId,
    setPanelArtifactId,
    panelKeyRef,
    fetchArtifacts,
    openArtifact,
    closePanel,
    selectArtifactVersion,
    retryArtifact,
    fetchArtifactVersions,
  } = useArtifactsPanel({ activeIdRef });

  // ── Prompt système de la conversation active (F-11) ───────────────────
  // Suit le bus du service ; le changement de conversation recharge l'état.
  useEffect(() => {
    promptInfoRef.current = promptInfo;
  }, [promptInfo]);

  useEffect(() => {
    const socket = getSocket();
    const load = (id: string | null) => {
      if (!id) {
        setPromptInfo(null);
        return;
      }
      socket.emit(
        "system-prompt:get",
        { conversationId: id },
        (res: { prompt?: ChatPromptInfo | null } = {}) => {
          if (id !== activeIdRef.current) return;
          setPromptInfo(
            res.prompt?.content
              ? { content: res.prompt.content, presetTitle: res.prompt.presetTitle ?? null }
              : null
          );
        }
      );
    };
    const onPromptChanged = (p: {
      conversationId: string;
      prompt?: ChatPromptInfo | null;
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setPromptInfo(
        p.prompt?.content
          ? { content: p.prompt.content, presetTitle: p.prompt.presetTitle ?? null }
          : null
      );
    };
    socket.on("system-prompt:changed", onPromptChanged);
    load(activeId);
    return () => {
      socket.off("system-prompt:changed", onPromptChanged);
    };
  }, [activeId]);

  // (Sélection persistée, bus hermes-ui:settings-changed, actions réglages
  // et échelle d'effort : tout vit dans use-chat-settings.ts — découpage
  // 2026-11, FORK.md §10.)

  // ── F-30 — mode effectif de la conversation ouverte ───────────────────
  // La liste des conversations fait foi (meta du service) ; sans
  // conversation, le choix « nouveau » (pastille avant la première
  // conversation) prime, sinon le réglage hermes.modes.defaultMode.
  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );
  const conversationMode: ConversationMode = useMemo(() => {
    if (activeConv) return resolveMode(activeConv.mode ?? "chat");
    if (pendingMode) return pendingMode.mode;
    return resolveMode(readClientSetting<string>("hermes.modes.defaultMode"));
  }, [activeConv, pendingMode]);
  const conversationModeConfig: ModeConfig | null =
    activeConv?.modeConfig ?? pendingMode?.config ?? null;

  /** F-30 — change le mode de la conversation (ou prépare l'état « nouveau »).
   *  Le service résout, borne et persiste ; l'écran suit son ack. */
  const setConversationMode = useCallback(
    (mode: ConversationMode, config: ModeConfig) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) {
        // Pas encore de conversation : mémorisé, appliqué à la création
        setPendingMode({ mode, config });
        return;
      }
      getSocket().emit(
        "conversations:setMode",
        { conversationId, mode, config },
        (res: { ok?: boolean; conversation?: ConversationMeta; error?: string } | null) => {
          if (res?.ok && res.conversation) {
            const conv = res.conversation;
            setConversations((prev) =>
              prev.map((c) => (c.id === conversationId ? { ...c, ...conv } : c))
            );
          } else if (res?.error) {
            toast({
              title: "Changement de mode impossible",
              description: res.error,
              variant: "destructive",
            });
          }
        }
      );
    },
    [toast]
  );

  /** Retrouve l'id d'un modèle depuis le libellé d'une réponse
   *  (« glm-4.6 · z.ai » — v2.3 : le suffixe fournisseur est retiré).
   *  C-08 : le serveur stocke `${result.model} · ${result.provider}` où
   *  result.model est l'ID (ex. « big-pickle »), pas le label (« Big
   *  Pickle ») — la recherche par label seul échouait et retombait sur le
   *  modèle du compositeur au lieu de celui de la voix A/B. */
  const modelIdFromLabel = useCallback(
    (label?: string) => {
      if (!label) return null;
      const clean = label.replace(/\s*·\s*[^·]+$/, "");
      return models.find((m) => m.id === clean || m.label === clean)?.id ?? null;
    },
    [models]
  );


  // (Vigie de silence F-31 : vit dans use-chat-stream.ts.)

  const refreshConversations = useCallback(() => {
    const socket = getSocket();
    socket.emit("conversations:list", (res: { conversations?: ConversationMeta[] } = {}) => {
      if (res.conversations) setConversations(res.conversations);
    });
  }, []);

  // Streams en vol : hook dédié (découpage 2026-11, FORK.md §10). Câblé ici —
  // les handlers stream:*/mode:flow ont besoin de setMessages et du refresh.
  const {
    setStreamsRecord,
    resetStreams,
    streamsCount: _streamsCount,
    streaming,
    modeFlowLive,
    setModeFlowLive,
    turnError,
    setTurnError,
    dismissTurnError,
    stallNotice,
    bumpActivity,
    lastActivityRef,
    runningVoiceRef,
    turnState: baseTurnState,
    onStreamStart,
    onStreamDelta,
    onStreamReasoning,
    onStreamStatus,
    onStreamTool,
    onStreamDone,
    onStreamError,
    onModeFlow,
  } = useChatStream({ activeIdRef, setMessages, refreshConversations });

  const isBusy = streaming !== null || uploadingCount > 0;

  /** État du tour complet (F-01) : le hook de stream fournit la base
   *  (idle/streaming/error) ; le « stopped » se déduit du fil ici (le hook
   *  ne connaît pas les messages). */
  const turnState: "idle" | "streaming" | "stopped" | "error" = useMemo(() => {
    if (baseTurnState === "streaming") return "streaming";
    if (baseTurnState === "error") return "error";
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.stopped) return "stopped";
    return "idle";
  }, [baseTurnState, messages]);



  const fetchModels = useCallback(() => {
    const socket = getSocket();
    socket.emit("models:list", (res: ModelsResult = {} as ModelsResult) => {
      const list = res.models ?? [];
      if (list.length > 0) {
        setModels(list);
        setModelsSource(res.source ?? "catalogue");
        setSelectedModelState((current) => {
          if (current && list.some((m) => m.id === current)) return current;
          return res.defaultModel && list.some((m) => m.id === res.defaultModel)
            ? res.defaultModel
            : list[0].id;
        });
      }
    });
  }, []);

  /** Ré-attache les tours LLM en vol (réponse en cours de génération) — le
   *  registre vit dans le service, l'écran re-sème son état de stream. */
  // (fetchArtifacts vit dans use-artifacts-panel.ts — découpage 2026-11.)

  // --- Connexion socket + écoute des événements de stream ---
  // Reprise après coupure (sonde E2E reconnexion, 2026-11-19) : une
  // REconnexion doit resynchroniser la conversation ACTIVE — le tour
  // interrompu a pu se terminer (ou persister en partiel) côté service
  // pendant la coupure ; sans ça, la bannière « connexion perdue » qui
  // promet une reprise automatique restait bloquée à jamais (F5 requis).
  // openConversation vit plus bas dans le hook : un ref l'expose au
  // handler sans erreur de temporelle morte (TDZ) ni ré-abonnement des
  // listeners socket à chaque rendu.
  const wasDisconnectedRef = useRef(false);
  const resyncConversationRef = useRef<(id: string) => void>(() => {});

  useChatSocketEvents({
    setProjects,
    fetchProjects,
    projectsRef,
    setConnected,
    setServerInfo,
    setUpdateState,
    setScreenOutdated,
    setConversations,
    setActiveId,
    setMessages,
    setCompactInfo,
    setCompacting,
    activeIdRef,
    updateToastShownRef,
    screenOutdatedRef,
    screenOutdatedDismissedRef,
    wasDisconnectedRef,
    resyncConversationRef,
    fetchModels,
    refreshConversations,
    toast,
    setTurnError,
    resetStreams,
    bumpActivity,
    onStreamStart,
    onStreamDelta,
    onStreamReasoning,
    onStreamStatus,
    onStreamTool,
    onStreamDone,
    onStreamError,
    onModeFlow,
    setArtifacts,
    setStreamingArtifacts,
    setPanelOpen,
    setPanelArtifactId,
    panelKeyRef,
    fetchArtifacts,
  });

  // --- Actions ---
  // CRUD conversations extrait dans use-conversations.ts (vague 3) —
  // appelé ici : il consomme les setters du stream et du panneau, déjà
  // créés plus haut. Corps des callbacks verbatim de l'autre côté.
  const {
    newConversation,
    openConversation,
    deleteConversation,
    renameConversation,
    togglePin,
    forkConversation,
    searchMessages,
    moveConversation,
  } = useConversations({
    toast,
    creatingRef,
    pendingModeRef,
    activeIdRef,
    loadingForRef,
    conversations,
    setConversations,
    setActiveId,
    setMessages,
    setLoadingHistory,
    setTurnError,
    setCompactInfo,
    setCompacting,
    setPendingMode,
    resetStreams,
    setStreamsRecord,
    setModeFlowLive,
    bumpActivity,
    setPanelOpen,
    setPanelArtifactId,
    panelKeyRef,
    setArtifacts,
    setStreamingArtifacts,
    fetchArtifacts,
  });

  // Reprise après coupure (voir onConnect) : le handler de reconnexion
  // appelle la dernière identité du chargeur de conversation via le ref.
  useEffect(() => {
    resyncConversationRef.current = openConversation;
  }, [openConversation]);

  /** Envoie un fichier au service (base64) et renvoie la pièce jointe enregistrée. */
  const uploadAttachment = useCallback(async (file: File): Promise<Attachment | null> => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `« ${file.name} » dépasse la limite de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo`
      );
    }
    const socket = getSocket();
    setUploadingCount((n) => n + 1);
    try {
      const dataBase64 = await fileToBase64(file);
      return await new Promise<Attachment | null>((resolve, reject) => {
        socket.emit(
          "attachments:upload",
          { name: file.name, mime: file.type || "application/octet-stream", dataBase64 },
          (res: { attachment?: Attachment; error?: string }) => {
            if (res?.attachment) resolve(res.attachment);
            else reject(new Error(res?.error ?? "Échec de l'envoi du fichier"));
          }
        );
      });
    } finally {
      setUploadingCount((n) => Math.max(0, n - 1));
    }
  }, []);

  /** v2.4 — déclenche la compaction et attend l'ack FINAL du service
   *  (contract v2.4 : {ok:true, compact, done} à la fin, {ok:false, error}
   *  en échec ; l'ack « started » initial est ignoré). Best effort : en cas
   *  d'échec ou de timeout (60 s), le tour part quand même — le service
   *  retombera sur l'historique récent (limite 30 entrées), comme avant. */
  const autoCompactBeforeSend = useCallback(
    (conversationId: string) =>
      new Promise<void>((resolve) => {
        const socket = getSocket();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          compactingRef.current = false;
          setCompacting(false);
          resolve();
        };
        const timer = setTimeout(() => {
          toast({
            title: "Résumé automatique lent",
            description: "Le tour part sans attendre la fin du résumé.",
          });
          finish();
        }, 60_000);
        compactingRef.current = true;
        setCompacting(true);
        socket.emit("conversation:compact", { conversationId }, (res: {
          ok?: boolean;
          done?: boolean;
          started?: boolean;
          error?: string;
        } = {}) => {
          if (res?.done) {
            // Pas de toast ici : le service diffuse déjà conversation:compacted,
            // dont onConversationCompacted affiche le toast avec le nombre
            // EXACT de messages résumés — l'ancien double toast racontait
            // deux fois la même histoire à l'utilisateur.
            finish();
          } else if (res && (res.ok === false || res.error)) {
            toast({
              title: "Résumé automatique impossible",
              description: res.error ?? "Le tour part sur l'historique récent.",
              variant: "destructive",
            });
            finish();
          }
          // started (ok:true) : la compaction tourne — on attend la fin.
        });
      }),
    [toast]
  );

  const sendMessage = useCallback(
    // Revue P1-P7 : retourne true quand l'envoi est ACCEPTÉ (le compositeur
    // ne vide le brouillon qu'alors) — false sur chaque refus (résumé en
    // cours, réponse en vol, échec de création de conversation).
    async (text: string, attachments: Attachment[] = []): Promise<boolean> => {
      const content = text.trim();
      if (!content && attachments.length === 0) return false;
      // Loi « jamais bloqué » (2026-11-22) : un envoi n'est JAMAIS avalé en
      // silence — l'ancien garde unique `return` jetait l'envoi sans un mot
      // quand un verrou (réponse en vol, résumé) restait collé : l'écran
      // paraissait mort (cas réel du 2026-11-22). Chaque blocage dit
      // pourquoi et donne l'issue en une phrase ; la vigie (use-chat-stream)
      // relâche de toute façon un verrou muet depuis plus de 6 min.
      if (compactingRef.current) {
        toast({
          title: "Résumé du contexte en cours",
          description: "Quelques secondes — réenvoyez juste après.",
        });
        return false;
      }
      if (streaming) {
        toast({
          title: "Hermes finit une réponse précédente",
          description:
            "Attendez la fin — ou appuyez sur le bouton rond « Arrêter » si rien ne bouge, puis renvoyez.",
        });
        return false;
      }

      let conversationId = activeIdRef.current;
      if (!conversationId) {
        conversationId = await newConversation();
        if (!conversationId) return false;
      }

      // Message utilisateur optimiste
      const optimistic: ChatMessage = {
        id: `local-${Date.now()}`,
        conversationId,
        role: "user",
        content,
        attachments: attachments.length ? attachments : undefined,
        model: selectedModelRef.current ?? undefined,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);

      const socket = getSocket();

      // v2.4 — conversations longues : résumé automatique avant le tour.
      // Même mesure que la jauge du composer (base du tour + brouillon) contre
      // la fenêtre du modèle. Le résumé part sur l'historique SANS ce message
      // (il n'est pas encore en base) — le service l'ajoutera après.
      const base = contextBaseRef.current;
      if (base) {
        const draftTokens = estimateTokens(content);
        const usedTokens =
          base.rows.reduce((acc, r) => acc + r.tokens, 0) + draftTokens;
        if (
          shouldAutoCompact({
            enabled:
              readClientSetting<boolean>("hermes.compaction.auto") === true,
            thresholdPct: clampCompactThreshold(
              readClientSetting<number>("hermes.compaction.threshold")
            ),
            windowTokens: base.windowTokens,
            usedTokens,
            messageCount: base.historyCount,
          })
        ) {
          await autoCompactBeforeSend(conversationId);
        }
      }

      // F-30 : le mode de la conversation (Comparer compris) est relu par le
      // SERVICE à chaque envoi — l'écran n'envoie plus de paire de comparaison.
      socket.emit(
        "chat:send",
        {
          conversationId,
          content,
          model: selectedModelRef.current ?? undefined,
          attachments: attachments.length ? attachments : undefined,
          effort: effortRef.current ?? undefined,
          permissionsMode: permissionsRef.current,
          ...expertRef.current,
          webSearch: webSearchRef.current,
        },
        // Ack (revue 2026-11-13) : refus propre si un tour est déjà en vol
        // sur cette conversation (le serveur n'entrelace plus deux streams).
        // Le message optimiste est retiré, une erreur claire s'affiche.
        // Revue P1-P7 : l'erreur n'écrit turnError que si SA conversation est
        // toujours active — l'utilisateur peut avoir changé de conversation
        // pendant l'envoi (ou pendant l'attente du résumé) : l'erreur de
        // convA n'écrase plus l'écran de convB.
        (res: { error?: string } | null) => {
          if (res?.error) {
            setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
            if (activeIdRef.current === conversationId) {
              setTurnError({ messageId: optimistic.id, error: res.error });
            }
          }
        }
      );
      // Accepté : le tour part — le compositeur peut vider le brouillon.
      return true;
    },
    [newConversation, streaming, autoCompactBeforeSend]
  );

  const stopGeneration = useCallback(() => {
    if (!activeIdRef.current) return;
    // Lot 3 (audit L3-5) : le stop est désormais acquitté par le service —
    // l'état « interrompu » reste porté par stream:status/stream:done ; l'ack
    // ne fait que fermer la promesse (aucun toast en cas de succès).
    getSocket().emit("chat:stop", { conversationId: activeIdRef.current }, () => {});
  }, []);

  /** Régénère la dernière réponse (relance le tour depuis le dernier message utilisateur). */
  /** F-17 : `variant` régénère UN côté d'une comparaison ; sans argument,
   *  en mode comparaison, les deux côtés sont relancés ; sinon tour simple. */
  const regenerate = useCallback(
    (rawVariant?: "a" | "b") => {
      // Garde : un branchement direct onClick={regenerate} transmet
      // l'événement React en premier argument — seul "a"/"b" compte.
      const variant = rawVariant === "a" || rawVariant === "b" ? rawVariant : undefined;
      const conversationId = activeIdRef.current;
      if (!conversationId || streaming) return;
      const base = {
        effort: effortRef.current ?? undefined,
        permissionsMode: permissionsRef.current,
        ...expertRef.current,
        webSearch: webSearchRef.current,
      };
      const resync = (res: { ok?: boolean; error?: string } | null) => {
        if (!res?.ok) openConversation(conversationId);
      };
      if (variant) {
        // Côté d'une comparaison (mode coupé ou session rechargée) :
        // retrouve le modèle de ce côté depuis le libellé de sa réponse.
        const last = [...messages].reverse().find((m) => m.variant === variant);
        const id = modelIdFromLabel(last?.model) ?? selectedModelRef.current ?? undefined;
        // F-17/F-14 : retirer la réponse assistant de CETTE variante située
        // APRÈS le dernier message utilisateur — l'ancienne boucle par la fin
        // butait sur la réponse de l'autre variante (b en fin de fil : la
        // réponse a restait affichée en doublon du tour relancé).
        setMessages((prev) => {
          let lastUserIdx = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "user") {
              lastUserIdx = i;
              break;
            }
          }
          return prev.filter(
            (m, idx) => !(idx > lastUserIdx && m.role === "assistant" && m.variant === variant)
          );
        });
        getSocket().emit("chat:regenerate", { conversationId, variant, model: id, ...base }, resync);
        return;
      }
      // Tour simple — le service relu le mode de la conversation : en mode
      // Comparer, les DEUX côtés repartent ensemble ; en mode orchestré, la
      // chaîne complète rejoue (une seule réponse conservée, comme à l'envoi).
      setMessages((prev) => {
        const next = [...prev];
        while (next.length > 0 && next[next.length - 1].role === "assistant") next.pop();
        return next;
      });
      getSocket().emit(
        "chat:regenerate",
        { conversationId, model: selectedModelRef.current ?? undefined, ...base },
        resync
      );
    },
    [openConversation, streaming, messages, modelIdFromLabel]
  );

  /** F-14 — affiche la version `index` d'une réponse multi-versions. La
   *  version choisie devient aussi celle envoyée au modèle au tour suivant ;
   *  le fil entier revient par `messages:refreshed` (y compris à l'émetteur). */
  const setMessageVersion = useCallback(
    (message: ChatMessage, index: number) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || !message.versions || streaming) return;
      getSocket().emit(
        "message:setVersion",
        { conversationId, group: message.versions.group, index },
        (res: { ok?: boolean; error?: string } | null) => {
          if (!res?.ok) openConversation(conversationId);
        }
      );
    },
    [openConversation, streaming]
  );

  /** Réessai après erreur (F-04) : relance le tour depuis le dernier message utilisateur. */
  const retryAfterError = useCallback(() => {
    setTurnError(null);
    regenerate();
  }, [regenerate]);

  /** Modifie un message utilisateur et relance le tour depuis ce point. */
  const editMessage = useCallback(
    (messageId: string, content: string) => {
      const conversationId = activeIdRef.current;
      const clean = content.trim();
      if (!conversationId || !clean || streaming) return;
      const socket = getSocket();
      if (messageId.startsWith("local-")) {
        // Message pas encore synchronisé : resynchronise le fil
        openConversation(conversationId);
        return;
      }
      // Optimiste : met à jour le contenu et retire tout ce qui suit
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx < 0) return prev;
        return [...prev.slice(0, idx), { ...prev[idx], content: clean }];
      });
      socket.emit(
        "message:edit",
        {
          conversationId,
          messageId,
          content: clean,
          // F-30 : le mode de la conversation (Comparer compris) est relu par
          // le service — l'édition relance ce que le mode décide, sans paire
          // envoyée par l'écran.
          model: selectedModelRef.current ?? undefined,
          effort: effortRef.current ?? undefined,
          permissionsMode: permissionsRef.current,
          ...expertRef.current,
          webSearch: webSearchRef.current,
        },
        (res: { ok?: boolean; error?: string }) => {
          if (!res?.ok) openConversation(conversationId);
        }
      );
    },
    [openConversation, streaming]
  );

  /** Supprime un message individuel. */
  const deleteMessage = useCallback(
    (messageId: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return;
      if (messageId.startsWith("local-")) {
        openConversation(conversationId);
        return;
      }
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      getSocket().emit(
        "message:delete",
        { conversationId, messageId },
        (res: { ok?: boolean; error?: string }) => {
          if (!res?.ok) openConversation(conversationId);
        }
      );
    },
    [openConversation]
  );

  /** Transcrit un audio base64 en texte (dictée vocale). */
  const transcribeAudio = useCallback(
    (dataBase64: string, mime = "audio/webm"): Promise<string> =>
      new Promise((resolve, reject) => {
        getSocket().emit(
          "audio:transcribe",
          { dataBase64, mime },
          (res: { text?: string; error?: string }) => {
            if (typeof res?.text === "string" && res.text) resolve(res.text);
            else reject(new Error(res?.error ?? "Échec de la transcription"));
          }
        );
      }),
    []
  );

  // (actions projets : vit dans use-projects.ts)

  // ── Compaction & nouvelle session (chantier « Composer v2 ») ──────────

  /** Lance la compaction de la conversation active (résumé en tête de session). */
  const compactConversation = useCallback(() => {
    const conversationId = activeIdRef.current;
    if (!conversationId || streaming) return;
    // Revue P1-P7 : le verrou compactingRef est posé par la compaction
    // MANUELLE aussi — l'autoCompact le posait, pas celle-ci : sendMessage
    // pouvait partir pendant un résumé manuel. Timeout 90 s : sur coupure
    // socket (ack jamais rendu), le spinner ne reste plus collé à vie.
    compactingRef.current = true;
    setCompacting(true);
    const garde = setTimeout(() => {
      compactingRef.current = false;
      setCompacting(false);
      toast({
        title: "Compaction lente",
        description: "Le service n'a pas confirmé le résumé — réessayez.",
        variant: "destructive",
      });
    }, 90_000);
    getSocket().emit(
      "conversation:compact",
      { conversationId },
      (res: { ok?: boolean; error?: string } = {}) => {
        if (!res?.ok) {
          clearTimeout(garde);
          compactingRef.current = false;
          setCompacting(false);
          toast({ title: "Compaction impossible", description: res?.error, variant: "destructive" });
        }
        // Succès : la confirmation arrive par conversation:compacted (broadcast)
      }
    );
  }, [streaming, toast]);

  /** Ouvre une conversation vierge, dans le projet de la conversation active. */
  const startNewSession = useCallback(async (): Promise<string | null> => {
    const current = conversations.find((c) => c.id === activeIdRef.current);
    return newConversation(current?.projectId ?? null);
  }, [conversations, newConversation]);

  /** Base du contexte du tour courant (le brouillon est ajouté par le composer). */
  const contextBase = useMemo(() => {
    const model = models.find((m) => m.id === selectedModel) ?? null;
    const { windowTokens, estimated } = contextWindowOf(model);

    // Instructions système : taille réelle du moteur local, estimation sinon
    const systemTokens = serverInfo?.systemPromptChars
      ? Math.ceil(serverInfo.systemPromptChars / 3.5)
      : SYSTEM_PROMPT_ESTIMATE;

    // Historique tel qu'il partira au modèle : résumé de compaction en tête,
    // puis les messages postérieurs (le service limite à 30 entrées).
    const MAX_HISTORY = 30;
    let historyTokens = 0;
    let historyCount = messages.length;
    let historySub: string | undefined =
      messages.length > 0 ? `${messages.length} messages` : undefined;
    if (compactInfo) {
      const untilIdx = messages.findIndex((m) => m.id === compactInfo.untilMessageId);
      const recent = messages.slice(untilIdx >= 0 ? untilIdx + 1 : 0);
      const summaryTokens = Math.ceil(compactInfo.summaryChars / 3.5);
      const recentTokens = recent.reduce(
        (acc, m) => acc + estimateTokens(m.content ?? ""),
        0
      );
      historyTokens = summaryTokens + recentTokens;
      historyCount = compactInfo.summarizedCount + recent.length;
      historySub = `résumé + ${recent.length} message${recent.length > 1 ? "s" : ""}`;
    } else {
      historyTokens = messages
        .slice(-MAX_HISTORY)
        .reduce((acc, m) => acc + estimateTokens(m.content ?? ""), 0);
    }

    const rows: ContextRow[] = [
      { key: "system", label: "Instructions système", tokens: systemTokens },
    ];
    // Prompt système de la conversation (F-11) : poids séparé, honnête,
    // issu du hook dédié — absent de la liste quand la conversation n'en a pas.
    if (promptInfo) {
      rows.push({
        key: "prompt",
        label: "Prompt de conversation",
        sub: promptInfo.presetTitle ?? undefined,
        tokens: Math.ceil(promptInfo.content.length / 3.5),
      });
    }
    if (messages.length > 0 || compactInfo) {
      rows.push({ key: "history", label: "Historique", sub: historySub, tokens: historyTokens });
    }

    return {
      rows,
      historyCount,
      historyCompacted: Boolean(compactInfo),
      windowTokens,
      windowEstimated: estimated,
    };
  }, [models, selectedModel, serverInfo, messages, compactInfo, promptInfo]);

  // v2.4 — miroir ref de la base de contexte (décision de résumé automatique
  // dans sendMessage, lecture fraiche au moment du clic).
  useEffect(() => {
    contextBaseRef.current = contextBase
      ? {
          rows: contextBase.rows,
          historyCount: contextBase.historyCount,
          windowTokens: contextBase.windowTokens,
        }
      : null;
  }, [contextBase]);

  /** Peut-on compacter : conversation ouverte, ≥ 2 messages, tour au repos. */
  const canCompact = Boolean(activeId) && messages.length >= 2 && !streaming;

  // (Actions artefacts : openArtifact, closePanel, selectArtifactVersion,
  // retryArtifact, fetchArtifactVersions — vit dans use-artifacts-panel.ts.)

  /** Branche (ou débranche, url vide) la gateway Hermes — Paramètres →
   *  Système. Le hello rediffusé par le service met mode, statut et modèles
   *  à jour en direct sur tous les clients. */
  const connectGateway = useCallback(
    (url: string, token?: string): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolve) => {
        getSocket().emit(
          "gateway:set",
          { url, ...(token !== undefined ? { token } : {}) },
          (res: { ok?: boolean; error?: string } = {}) => {
            if (!res?.ok && res?.error)
              console.warn("[hermes] gateway :", res.error);
            resolve({ ok: Boolean(res?.ok), error: res?.error });
          }
        );
      }),
    []
  );

  return {
    connected,
    mode: (serverInfo?.mode ?? null) as GatewayMode | null,
    serverModel: serverInfo?.model ?? null,
    // v2.4 — fournisseurs LLM actionnables (carte de statut honnête).
    engineProviders: serverInfo?.engineProviders ?? null,
    serverVersion: serverInfo?.version ?? null,
    // v0.3.3 — état de mise à jour (service : démarrage + 6 h) : badge
    // sur l'onglet Système, point sur l'engrenage, carte Mise à jour.
    updateAvailable: (updateState?.available ?? null) as string | null,
    updateState: updateState ?? null,
    // v2.4 (Paramètres → Système) — sondes réelles du hello.
    serverRevision: serverInfo?.appRevision ?? null,
    // §9 (61) — révision du service != révision cuite dans ce bundle :
    // l'écran affiche encore l'ancienne interface (bandeau page.tsx).
    screenOutdated,
    dismissScreenOutdated,
    chromeHeadless: serverInfo?.chromeHeadless ?? null,
    gatewayUrl: serverInfo?.gatewayUrl ?? null,
    /** F-02 : gateway réellement CONFIGURÉE (vs défaut automatique) — le
     *  bouton « Débrancher » ne s'affiche que pour une vraie surcharge. */
    gatewayConfigured: serverInfo?.gatewayConfigured ?? false,
    /** Jeton de gateway enregistré côté service (booléen honnête). */
    gatewayTokenSet: serverInfo?.gatewayTokenSet ?? false,
    /** Paramètres → Système : brancher l'agent Hermes réel. */
    connectGateway,
    conversations,
    projects,
    activeId,
    messages,
    streaming,
    // (streams complet : vit dans stream-store, lu par MessageList)
    isBusy,
    // F-30 — modes du compositeur (le service fait foi)
    conversationMode,
    conversationModeConfig,
    setConversationMode,
    modeFlowLive,
    turnState,
    turnError,
    /** F-31 — notice de silence pendant un tour (aucun événement depuis 60 s). */
    stallNotice,
    dismissTurnError,
    retryAfterError,
    loadingHistory,
    models,
    modelsSource,
    selectedModel,
    setSelectedModel,
    // Chantier « Composer v2 »
    effort,
    expert,
    setExpert,
    setEffort,
    permissionsMode,
    setPermissionsMode: changePermissions,
    // F-09/F-12 — recherche web du tour (Tavily/Exa)
    webSearch,
    toggleWebSearch,
    contextBase,
    // ── Prompt système de la conversation active (F-11) ───────────
    promptInfo,
    canCompact,
    compacting,
    compactConversation,
    startNewSession,
    uploadAttachment,
    newConversation,
    openConversation,
    deleteConversation,
    renameConversation,
    sendMessage,
    stopGeneration,
    regenerate,
    editMessage,
    deleteMessage,
    // F-14 — navigation entre versions d'une réponse
    setMessageVersion,
    togglePin,
    forkConversation,
    searchMessages,
    transcribeAudio,
    // Projets
    createProject,
    renameProject,
    deleteProject,
    setProjectArchived,
    reorderProjects,
    moveConversation,
    // Artefacts
    artifacts,
    streamingArtifacts,
    panelOpen,
    panelArtifactId,
    openArtifact,
    closePanel,
    selectArtifactVersion,
    retryArtifact,
    fetchArtifactVersions,
  };
}
