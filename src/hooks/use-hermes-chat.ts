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

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      setConnected(true);
      // Lot 3 (audit L3-5) : reconnexion arrivée à temps — le verdict
      // « connexion perdue » programmé n'a plus lieu d'être.
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
      socket.emit("hello", (info: ServerHello) => setServerInfo(info));
      refreshConversations();
      fetchProjects();
      fetchModels();
      // v0.3.3 : réveil — le service vérifie de lui-même (démarrage + 6 h),
      // mais une coupure peut avoir manqué une diffusion : demander l'état
      // au retour, pour que le point orange apparaisse sans délai.
      socket.emit("system:update-check", (state?: unknown) => {
        if (state && typeof state === "object") setUpdateState(state as UpdateCheckResult);
      });
      // Reprise après coupure : la PREMIÈRE connexion n'a rien à
      // resynchroniser (aucune conversation ouverte), une RECONNEXION
      // recharge la conversation active — messages persistés, état de
      // compaction, tours en vol (re-semis serveur, contenu accumulé sans
      // trou) et cartes d'artefacts. La bannière « connexion perdue »
      // part avec (openConversation fait setTurnError(null)).
      if (wasDisconnectedRef.current) {
        wasDisconnectedRef.current = false;
        const active = activeIdRef.current;
        if (active) resyncConversationRef.current(active);
      }
    };
    // Lot 3 (audit L3-5) : une déconnexion BRÈVE (réseau qui tremble) se
    // rétablit seule — le tour continue côté service et les événements
    // reprennent au reconnect (les handlers restent attachés). Le verdict
    // « connexion perdue, rien n'arrivera davantage » n'est prononcé que si
    // la coupure PERSISTE 4 s ; sinon l'utilisateur voyait une erreur
    // définitive fausse puis la réponse arriver quand même.
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const onDisconnect = () => {
      setConnected(false);
      // Reprise après coupure : la prochaine connexion est une
      // REconnexion — elle resynchronisera la conversation active.
      wasDisconnectedRef.current = true;
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        // F-31 : si un tour était en vol, l'utilisateur a le droit de savoir
        // POURQUOI l'écran retombe — avant, le flux disparaissait en silence
        // et le déroulé restait « en cours » sans fin ni erreur.
        // M-11 (revue) : plus de setState dans l'updater — lecture directe
        // du store (get()), erreur affichée PUIS vidage scellé : les deltas
        // d'un tour mort ne peuvent plus s'y raccrober après la coupure.
        const inFlight = Object.keys(streamStore.get().streamsRecord)[0];
        if (inFlight) {
          setTurnError({
            messageId: inFlight,
            error:
              "Connexion au service perdue pendant le tour (service arrêté, planté ou réseau coupé) " +
              "— rien n'arrivera davantage. La reconnexion est automatique : attendez quelques secondes, " +
              "puis réessayez. Le panneau ?debug=1 fournit le diagnostic complet.",
          });
        }
        resetStreams();
      }, 4000);
    };
    // v2.4 : le service rediffuse le hello quand le porte-clés change —
    // la carte de statut de la sidebar suit l état réel du moteur en direct.
    // v0.3.3 : le hello porte aussi update (état de mise à jour vérifié
    // par le service lui-même) — fusion ici, source unique côté front.
    const onHello = (info: ServerHello) => {
      setServerInfo(info);
      if (info && typeof info.update === "object" && info.update !== null) {
        setUpdateState(info.update);
      }
      // §9 (61) : comparaison révision bundle ↔ révision service. Un côté
      // vide (build sans git, service sans dépôt) → pas de comparaison,
      // jamais de bandeau sur une supposition. Divergence → bandeau tant
      // que cette révision n'a pas été fermée ou la page rechargée ;
      // ré-égalité (rechargement réussi) → le bandeau tombe.
      const theirs = info?.appRevision ?? null;
      if (BUILD_REVISION && theirs) {
        const outdated =
          theirs !== BUILD_REVISION &&
          screenOutdatedDismissedRef.current !== theirs;
        screenOutdatedRef.current = outdated ? theirs : null;
        setScreenOutdated(outdated ? theirs : null);
      }
    };

    // v0.3.3 : état de mise à jour poussé par le service (6 h) — le point
    // orange suit sans ouvrir la page Système. Toast UNE fois par session
    // (au PREMIER passage à « disponible » uniquement).
    const onUpdateState = (state?: unknown) => {
      if (!state || typeof state !== "object") return;
      const u = state as UpdateCheckResult;
      setUpdateState(u);
      if (u.available && !updateToastShownRef.current) {
        updateToastShownRef.current = true;
        toast({
          title: "Mise à jour disponible",
          description:
            "Une nouvelle version de Hermes est prête. Ouvrez Paramètres → Système pour l'installer.",
        });
      }
    };
    socket.on("system:update-state", onUpdateState);

    const onConversationsDeleted = (p: { id: string }) => {
      setConversations((prev) => prev.filter((c) => c.id !== p.id));
      if (activeIdRef.current === p.id) {
        setActiveId(null);
        setMessages([]);
        setTurnError(null);
        setCompactInfo(null);
        setArtifacts([]);
        setStreamingArtifacts({});
        setPanelOpen(false);
        setPanelArtifactId(null);
        panelKeyRef.current = null;
      }
    };

    // Compaction terminée côté service : le résumé est en tête de session,
    // la jauge et le popover reflètent le nouveau contexte envoyé au modèle.
    const onConversationCompacted = (p: { conversationId: string; compact?: CompactInfo }) => {
      // (audit 2026-11-21) la compaction est terminée où qu'elle soit : on
      // lève le spinner AVANT le garde d'activité, sinon un ack/broadcast
      // arrivé pendant qu'une autre conversation est affichée le laissait
      // bloqué à true (plus rien ne le repassait à false).
      setCompacting(false);
      if (p.conversationId !== activeIdRef.current) return;
      setCompactInfo(p.compact ?? null);
      if (p.compact) {
        toast({
          title: "Contexte compacté",
          description: `${p.compact.summarizedCount} messages résumés — le fil continue dans la même session.`,
        });
      }
    };

    // ── Artefacts : naissance, stream du source, mises à jour ──────────
    const onArtifactCreated = (p: {
      conversationId: string;
      messageId: string;
      artifact: Artifact;
    }) => {
      if (p.conversationId !== activeIdRef.current || !p.artifact) return;
      const a = p.artifact;
      setArtifacts((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, a]));
      setStreamingArtifacts((prev) => ({ ...prev, [a.key]: prev[a.key] ?? "" }));
      // Ouverture automatique du panneau à la naissance d'un artefact
      panelKeyRef.current = a.key;
      setPanelArtifactId(a.id);
      setPanelOpen(true);
    };

    const onArtifactDelta = (p: { conversationId: string; key: string; delta: string }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setStreamingArtifacts((prev) => ({
        ...prev,
        [p.key]: (prev[p.key] ?? "") + (p.delta ?? ""),
      }));
    };

    const onArtifactUpdated = (p: { conversationId: string; artifact: Artifact }) => {
      if (p.conversationId !== activeIdRef.current || !p.artifact) return;
      const a = p.artifact;
      setArtifacts((prev) => {
        const idx = prev.findIndex((x) => x.id === a.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = a;
          return next;
        }
        return [...prev, a];
      });
      // Fin de génération : le source streamé laisse place au contenu final
      if (a.status !== "generating") {
        setStreamingArtifacts((prev) => {
          if (!(a.key in prev)) return prev;
          const next = { ...prev };
          delete next[a.key];
          return next;
        });
      }
      // Le panneau suit la dernière version de l'artefact affiché
      if (panelKeyRef.current === a.key) {
        setPanelArtifactId(a.id);
      }
    };

    // Le serveur confirme la persistance du message utilisateur :
    // remplace le message optimiste (id local-) par l'id réel.
    const onMessageAppended = (p: { conversationId: string; message: ChatMessage }) => {
      if (p.conversationId !== activeIdRef.current || !p.message) return;
      setMessages((prev) => {
        const idx = [...prev].reverse().findIndex(
          (m) => m.role === "user" && m.id.startsWith("local-")
        );
        if (idx < 0) {
          return prev.some((m) => m.id === p.message.id) ? prev : [...prev, p.message];
        }
        const realIdx = prev.length - 1 - idx;
        const next = [...prev];
        next[realIdx] = p.message;
        return next;
      });
    };

    // Suppression d'un message (broadcast)
    const onMessageDeleted = (p: { conversationId: string; messageId: string }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setMessages((prev) => prev.filter((m) => m.id !== p.messageId));
    };

    // Messages supprimés côté serveur (régénération)
    const onMessagesRemoved = (p: { conversationId: string; messageIds: string[] }) => {
      if (p.conversationId !== activeIdRef.current) return;
      const ids = new Set(p.messageIds);
      setMessages((prev) => prev.filter((m) => !ids.has(m.id)));
    };

    // Message modifié + tronqué (broadcast d'une autre session)
    const onMessageUpdated = (p: {
      conversationId: string;
      message: ChatMessage;
      removedIds: string[];
    }) => {
      if (p.conversationId !== activeIdRef.current || !p.message) return;
      const ids = new Set(p.removedIds ?? []);
      setMessages((prev) =>
        prev.map((m) => (m.id === p.message.id ? p.message : m)).filter((m) => !ids.has(m.id))
      );
    };

    // Conversation épinglée (broadcast)
    const onConversationsPinned = (p: { conversation: ConversationMeta }) => {
      if (!p.conversation) return;
      setConversations((prev) =>
        prev
          .map((c) => (c.id === p.conversation.id ? { ...c, pinned: p.conversation.pinned } : c))
          .sort(
            (a, b) =>
              Number(!!b.pinned) - Number(!!a.pinned) ||
              b.updatedAt.localeCompare(a.updatedAt)
          )
      );
    };

    // Nouvelle conversation créée (fork depuis une autre session)
    const onConversationsCreated = (p: { conversation: ConversationMeta }) => {
      if (!p.conversation) return;
      setConversations((prev) =>
        prev.some((c) => c.id === p.conversation.id) ? prev : [p.conversation, ...prev]
      );
    };

    // Renommage (broadcast d'une autre session) : le titre de la liste
    // suivait uniquement dans la fenêtre qui avait renommé.
    const onConversationsRenamed = (p: { conversation?: ConversationMeta }) => {
      if (!p.conversation) return;
      const conv = p.conversation;
      setConversations((prev) =>
        prev.map((c) => (c.id === conv.id ? { ...c, title: conv.title } : c))
      );
    };

    // ── Projets : synchronisation multi-sessions ───────────────────
    const onProjectCreated = (p: { project?: Project }) => {
      if (!p.project) return;
      const project = p.project;
      setProjects((prev) =>
        prev.some((x) => x.id === project.id) ? prev : [...prev, project]
      );
    };

    const onProjectRenamed = (p: { project?: Project }) => {
      if (!p.project) return;
      const project = p.project;
      setProjects((prev) => prev.map((x) => (x.id === project.id ? project : x)));
    };

    const onProjectDeleted = (p: { id: string; projects?: Project[] }) => {
      // F-59 : le dossier et ses sous-dossiers (un niveau) disparaissent —
      // leurs conversations retombent dans « Sans projet ». Les ids affectés
      // sont calculés AVANT le remplacement éventuel de la liste.
      const children = new Set(
        projectsRef.current.filter((x) => x.parentId === p.id).map((x) => x.id)
      );
      setConversations((prev) =>
        prev.map((c) =>
          c.projectId && (c.projectId === p.id || children.has(c.projectId))
            ? { ...c, projectId: null }
            : c
        )
      );
      // Le broadcast emporte la liste complète à jour (sous-dossiers promus
      // racine côté service) : on la remplace, sinon fallback filtrage.
      if (Array.isArray(p.projects)) setProjects(p.projects);
      else setProjects((prev) => prev.filter((x) => x.id !== p.id && !children.has(x.id)));
    };

    const onProjectsReordered = (p: { projects?: Project[] }) => {
      if (Array.isArray(p.projects)) setProjects(p.projects);
    };

    // F-60 : un dossier a changé d'état (archivé/désarchivé) ici ou dans une
    // autre session — le broadcast emporte la liste complète à jour
    // (propagation aux sous-dossiers faite côté service).
    const onProjectUpdated = (p: { projects?: Project[] }) => {
      if (Array.isArray(p.projects)) setProjects(p.projects);
    };

    const onConversationMoved = (p: { conversation?: ConversationMeta }) => {
      if (!p.conversation) return;
      const moved = p.conversation;
      setConversations((prev) =>
        prev.map((c) => (c.id === moved.id ? { ...c, projectId: moved.projectId ?? null } : c))
      );
    };

    // v2.3 : le porte-clés a changé côté service (clé ajoutée/retirée/testée)
    // — les listes vivantes sont rechargées, la sélection s'aligne dessus.
    const onModelsChanged = () => fetchModels();

    // F-30 — mode changé (depuis cette session ou une autre) : toutes les
    // fenêtres suivent la conversation en direct.
    const onConversationMode = (p: {
      conversationId: string;
      conversation?: ConversationMeta;
    }) => {
      if (p.conversation) {
        const conv = p.conversation;
        setConversations((prev) =>
          prev.some((c) => c.id === conv.id)
            ? prev.map((c) => (c.id === conv.id ? { ...c, ...conv } : c))
            : prev
        );
      }
    };
    // F-31 : tout événement entrant est un signe de vie du service — un seul
    // point de mesure pour tous les canaux (stream:*, mode:flow, hello…).
    // F-31 : tout événement entrant est un signe de vie du service — un seul
    // point de mesure pour tous les canaux (stream:*, mode:flow, hello…).
    // (bumpActivity vit dans use-chat-stream.ts : notice dérivée au rendu.)
    const onAnyActivity = () => bumpActivity();
    socket.onAny(onAnyActivity);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("hello", onHello);
    socket.on("stream:start", onStreamStart);
    socket.on("stream:delta", onStreamDelta);
    socket.on("stream:reasoning", onStreamReasoning);
    socket.on("stream:status", onStreamStatus);
    socket.on("stream:tool", onStreamTool);
    socket.on("stream:done", onStreamDone);
    socket.on("stream:error", onStreamError);
    socket.on("conversations:deleted", onConversationsDeleted);
    socket.on("conversation:compacted", onConversationCompacted);
    socket.on("message:appended", onMessageAppended);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("messages:removed", onMessagesRemoved);
    // F-14 : réponse remplacée par une nouvelle version (régénération)
    // et fil rediffusé après bascule de version affichée.
    const onMessagesSuperseded = (p: { conversationId: string; messageIds: string[] }) => {
      if (p.conversationId !== activeIdRef.current) return;
      const ids = new Set(p.messageIds);
      setMessages((prev) => prev.filter((m) => !ids.has(m.id)));
    };
    const onMessagesRefreshed = (p: {
      conversationId: string;
      messages: ChatMessage[];
      compact?: CompactInfo | null;
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setMessages(p.messages ?? []);
      // F-14 (compaction) : le fil rediffusé emporte l'état de compaction
      // quand le service le fournit (y compris null = résumé invalidé —
      // la jauge repart honnêtement à zéro).
      if ("compact" in p) setCompactInfo(p.compact ?? null);
    };
    socket.on("messages:superseded", onMessagesSuperseded);
    socket.on("messages:refreshed", onMessagesRefreshed);
    socket.on("message:updated", onMessageUpdated);
    socket.on("conversations:pinned", onConversationsPinned);
    socket.on("conversations:created", onConversationsCreated);
    socket.on("conversations:renamed", onConversationsRenamed);
    socket.on("projects:created", onProjectCreated);
    socket.on("projects:renamed", onProjectRenamed);
    socket.on("projects:deleted", onProjectDeleted);
    socket.on("projects:reordered", onProjectsReordered);
    socket.on("projects:updated", onProjectUpdated);
    socket.on("conversations:moved", onConversationMoved);
    socket.on("artifact:created", onArtifactCreated);
    socket.on("artifact:delta", onArtifactDelta);
    socket.on("artifact:updated", onArtifactUpdated);
    socket.on("models:changed", onModelsChanged);
    socket.on("mode:flow", onModeFlow);
    socket.on("conversations:mode", onConversationMode);
    // Loi « jamais bloqué » (2026-11-22) : la pile prévient AVANT de
    // s'arrêter (drapeau d'arrêt propre du lanceur) — chaque tour en vol
    // reçoit sa clôture, l'écran annonce la relance au lieu de sembler
    // mourir en silence. Les verrous clients se relâchent d'eux-mêmes
    // (événements terminaux + vigie de silence en filet).
    const onSystemStopping = (p: { reason?: string; at?: string }) => {
      toast({
        title: "Hermes est relancé",
        description:
          "Mise à jour ou redémarrage : les réponses en cours sont clôturées proprement, l'écran se débloque tout seul.",
      });
    };
    socket.on("system:stopping", onSystemStopping);

    if (socket.connected) onConnect();

    return () => {
      socket.offAny(onAnyActivity);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("hello", onHello);
      socket.off("system:update-state", onUpdateState);
      socket.off("system:stopping", onSystemStopping);
      socket.off("stream:start", onStreamStart);
      socket.off("stream:delta", onStreamDelta);
      socket.off("stream:reasoning", onStreamReasoning);
      socket.off("stream:status", onStreamStatus);
      socket.off("stream:tool", onStreamTool);
      socket.off("stream:done", onStreamDone);
      socket.off("stream:error", onStreamError);
      socket.off("conversations:deleted", onConversationsDeleted);
      socket.off("conversation:compacted", onConversationCompacted);
      socket.off("message:appended", onMessageAppended);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("messages:removed", onMessagesRemoved);
      socket.off("messages:superseded", onMessagesSuperseded);
      socket.off("messages:refreshed", onMessagesRefreshed);
      socket.off("message:updated", onMessageUpdated);
      socket.off("conversations:pinned", onConversationsPinned);
      socket.off("conversations:created", onConversationsCreated);
      socket.off("conversations:renamed", onConversationsRenamed);
      socket.off("projects:created", onProjectCreated);
      socket.off("projects:renamed", onProjectRenamed);
      socket.off("projects:deleted", onProjectDeleted);
      socket.off("projects:reordered", onProjectsReordered);
      socket.off("projects:updated", onProjectUpdated);
      socket.off("conversations:moved", onConversationMoved);
      socket.off("artifact:created", onArtifactCreated);
      socket.off("artifact:delta", onArtifactDelta);
      socket.off("artifact:updated", onArtifactUpdated);
      socket.off("models:changed", onModelsChanged);
      socket.off("mode:flow", onModeFlow);
      socket.off("conversations:mode", onConversationMode);
    };
  }, [refreshConversations, fetchProjects, fetchModels, fetchArtifacts]);

  // --- Actions ---
  const newConversation = useCallback(
    async (projectId?: string | null): Promise<string | null> => {
      const socket = getSocket();
      // Lot 3 (audit L3-5) : garde anti double-émission — un double-clic sur
      // « Nouvelle conversation » avant l'ack créait DEUX conversations.
      if (creatingRef.current) return null;
      creatingRef.current = true;
      return new Promise((resolve) => {
        // (audit 2026-11-21) chien de garde : si l'ack n'arrive jamais
        // (service tué net, coupure socket au moment du clic), creatingRef
        // restait vrai pour toujours — plus aucune création possible, sans
        // aucun message. On libère au bout de 10 s.
        const watchdog = setTimeout(() => {
          if (!creatingRef.current) return;
          creatingRef.current = false;
          toast({
            title: "Création impossible",
            description: "Le service n'a pas répondu — vérifiez la connexion puis réessayez.",
            variant: "destructive",
          });
          resolve(null);
        }, 10_000);
        // F-30 : le mode des nouvelles conversations = choix « nouveau » de la
        // pastille, sinon le réglage hermes.modes.defaultMode. Le service le
        // résout et le borne (valeur inconnue → chat).
        const pending = pendingModeRef.current;
        const mode =
          pending?.mode ?? resolveMode(readClientSetting<string>("hermes.modes.defaultMode"));
        socket.emit(
          "conversations:create",
          {
            projectId: projectId ?? null,
            ...(mode !== "chat" ? { mode, modeConfig: pending?.config } : {}),
          },
          (res: { conversation?: ConversationMeta }) => {
            clearTimeout(watchdog);
            if (res.conversation) {
              activeIdRef.current = res.conversation.id;
              setConversations((prev) => [res.conversation as ConversationMeta, ...prev]);
              setActiveId(res.conversation.id);
              setMessages([]);
              setTurnError(null);
              setCompactInfo(null);
              setModeFlowLive(null);
              setPendingMode(null);
              // (audit 2026-11-21) un squelette d'historique resté en attente
              // sur l'ancienne conversation ne doit pas survivre au fil vierge.
              loadingForRef.current = null;
              setLoadingHistory(false);
              creatingRef.current = false;
              resolve(res.conversation.id);
            } else {
              creatingRef.current = false;
              resolve(null);
            }
          }
        );
      });
    },
    [toast]
  );

  const openConversation = useCallback(
    (id: string) => {
      const socket = getSocket();
      setLoadingHistory(true);
      loadingForRef.current = id;
      activeIdRef.current = id;
      setActiveId(id);
      // M-11 (revue 2026-11-19) : frontière étanche — resetStreams vide le
      // store ET le scelle : les deltas d'un ancien tour arrivant après le
      // changement de conversation ne peuvent plus reconstruire d'accumulation
      // orpheline. La ré-attache ci-dessous (tours en vol) et le prochain
      // stream:start rouvrent explicitement.
      resetStreams();
      setTurnError(null);
      setCompactInfo(null);
      // (audit 2026-11-21) le spinner « Compaction… » appartient à la
      // conversation quittée : sans reset, un broadcast reçu pendant qu'une
      // AUTRE conversation est ouverte (filtré par activeIdRef) le laissait
      // collé jusqu'au rechargement.
      setCompacting(false);
      setModeFlowLive(null);
      setPendingMode(null);
      // Le panneau appartient à la conversation : on le referme au changement
      setPanelOpen(false);
      setPanelArtifactId(null);
      panelKeyRef.current = null;
      setArtifacts([]);
      setStreamingArtifacts({});
      socket.emit(
        "conversations:open",
        { id },
        (res: {
          conversationId: string;
          messages: ChatMessage[];
          compact?: CompactInfo | null;
          /** Ré-attache : tours en vol de cette conversation (contenu accumulé). */
          live?: {
            messageId: string;
            variant?: "a" | "b";
            content?: string;
            reasoning?: string;
            status?: string | null;
            toolEvents?: ToolEvent[];
            modeFlow?: import("@/lib/chat-types").ModeFlowRow[];
          }[];
        } = {} as any) => {
          // Garde de course (Lot 1, audit L1-5) : l'ack compare à la
          // conversation ACTIVE (activeIdRef), pas à la closure — navigation
          // A→B→C rapide, l'ack tardif de A ne doit rien écrire dans le fil
          // de C ni couper prématurément son spinner d'historique.
          // (audit 2026-11-21) Le squelette ne doit jamais rester collé :
          // on n'écrit le fil que si la conversation est toujours active,
          // mais on lève le spinner dès que CET ack correspond au chargement
          // en cours — sinon un ack écarté (navigation A→B, nouvelle
          // conversation, suppression pendant le chargement) laissait
          // loadingHistory vrai pour toujours.
          if (loadingForRef.current === id) {
            loadingForRef.current = null;
            setLoadingHistory(false);
          }
          if (id !== activeIdRef.current) return;
          if (res.conversationId === id) {
            setMessages(res.messages ?? []);
            setCompactInfo(res.compact ?? null);
            // Ré-attache des tours en vol : quitter puis revenir pendant une
            // génération a effacé l'état de stream local (setStreamsRecord({})
            // au changement) et le message n'est pas encore persisté — sans
            // re-semis, les deltas suivants étaient jetés (pas d'entrée) et le
            // tour paraissait mort. Le service renvoie le contenu accumulé ;
            // les deltas suivants s'y raccordent sans trou ni doublon.
            for (const t of res.live ?? []) {
              if (!t?.messageId) continue;
              // reopen (M-11) : la ré-attache est une réouverture EXPPLICITE
              // du store scellé par resetStreams() au changement — ce sont
              // des tours vivants de CETTE conversation, pas des orphelins.
              setStreamsRecord(
                (prev) =>
                  prev[t.messageId]
                    ? prev
                    : {
                        ...prev,
                        [t.messageId]: {
                          messageId: t.messageId,
                          conversationId: id,
                          variant: t.variant,
                          content: t.content ?? "",
                          reasoning: t.reasoning ?? "",
                          status: t.status ?? null,
                          toolEvents: t.toolEvents ?? [],
                        },
                      },
                { reopen: true }
              );
              // Ré-attache du déroulé multi-voix (débat/conseil/auto, F-30) :
              // sans re-semis, le bloc des voix disparaît au retour dans la
              // conversation et ne revient qu'au prochain mode:flow (voix
              // suivante) ou à la persistance en fin de tour. Les lignes sont
              // poussées complètes à chaque émission : remplacement en bloc.
              if (t.modeFlow?.length) {
                setModeFlowLive({ messageId: t.messageId, rows: t.modeFlow });
              }
            }
          }
        }
      );
      fetchArtifacts(id);
    },
    [fetchArtifacts]
  );

  // Reprise après coupure (voir onConnect) : le handler de reconnexion
  // appelle la dernière identité du chargeur de conversation via le ref.
  useEffect(() => {
    resyncConversationRef.current = openConversation;
  }, [openConversation]);

  const deleteConversation = useCallback((id: string) => {
    getSocket().emit("conversations:delete", { id });
  }, []);

  const renameConversation = useCallback((id: string, title: string) => {
    const socket = getSocket();
    socket.emit("conversations:rename", { id, title }, (res: { conversation?: ConversationMeta }) => {
      if (res.conversation) {
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title: res.conversation!.title } : c))
        );
      }
    });
  }, []);

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
    async (text: string, attachments: Attachment[] = []) => {
      const content = text.trim();
      if (!content && attachments.length === 0) return;
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
        return;
      }
      if (streaming) {
        toast({
          title: "Hermes finit une réponse précédente",
          description:
            "Attendez la fin — ou appuyez sur le bouton rond « Arrêter » si rien ne bouge, puis renvoyez.",
        });
        return;
      }

      let conversationId = activeIdRef.current;
      if (!conversationId) {
        conversationId = await newConversation();
        if (!conversationId) return;
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
        (res: { error?: string } | null) => {
          if (res?.error) {
            setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
            setTurnError({ messageId: optimistic.id, error: res.error });
          }
        }
      );
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

  /** Épingle / détache une conversation. */
  const togglePin = useCallback(
    (id: string) => {
      const current = conversations.find((c) => c.id === id);
      const pinned = !current?.pinned;
      getSocket().emit(
        "conversations:pin",
        { id, pinned },
        (res: { conversation?: ConversationMeta }) => {
          if (res?.conversation) {
            const conv = res.conversation;
            setConversations((prev) =>
              prev
                .map((c) => (c.id === conv.id ? { ...c, pinned: conv.pinned } : c))
                .sort(
                  (a, b) =>
                    Number(!!b.pinned) - Number(!!a.pinned) ||
                    b.updatedAt.localeCompare(a.updatedAt)
                )
            );
          }
        }
      );
    },
    [conversations]
  );

  /** Duplique la conversation active (entière ou jusqu'à un message). */
  const forkConversation = useCallback(
    async (fromMessageId?: string): Promise<string | null> => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return null;
      return new Promise((resolve) => {
        getSocket().emit(
          "conversations:fork",
          { conversationId, fromMessageId },
          (res: { conversation?: ConversationMeta }) => {
            if (res?.conversation) {
              resolve(res.conversation.id);
            } else {
              resolve(null);
            }
          }
        );
      });
    },
    []
  );

  /** Recherche plein-texte dans les messages de toutes les conversations. */
  const searchMessages = useCallback((query: string): Promise<SearchHit[]> => {
    const q = query.trim();
    if (q.length < 2) return Promise.resolve([]);
    return new Promise((resolve) => {
      getSocket().emit(
        "conversations:search",
        { query: q },
        (res: { results?: SearchHit[] } = {}) => {
          resolve(res.results ?? []);
        }
      );
    });
  }, []);

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

  /** Déplace une conversation vers un projet (null = « Sans projet »). */
  const moveConversation = useCallback((id: string, projectId: string | null) => {
    getSocket().emit(
      "conversations:move",
      { id, projectId },
      (res: { conversation?: ConversationMeta } = {}) => {
        if (res.conversation) {
          const moved = res.conversation;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === id ? { ...c, projectId: moved.projectId ?? null } : c
            )
          );
        }
      }
    );
  }, []);

  // ── Compaction & nouvelle session (chantier « Composer v2 ») ──────────

  /** Lance la compaction de la conversation active (résumé en tête de session). */
  const compactConversation = useCallback(() => {
    const conversationId = activeIdRef.current;
    if (!conversationId || streaming) return;
    setCompacting(true);
    getSocket().emit(
      "conversation:compact",
      { conversationId },
      (res: { ok?: boolean; error?: string } = {}) => {
        if (!res?.ok) {
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
