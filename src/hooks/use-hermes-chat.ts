// Hook principal : orchestre les conversations, la sélection de modèle,
// les pièces jointes multimédia et le streaming via socket.io
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import { deleteClientSetting, onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import { useToast } from "@/hooks/use-toast";
import {
  contextWindowOf,
  estimateTokens,
  SYSTEM_PROMPT_ESTIMATE,
  type ContextRow,
} from "@/lib/tokens";
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
  Project,
  SearchHit,
  ServerHello,
  StreamingState,
  ToolEvent,
} from "@/lib/chat-types";

const MODEL_SETTING_KEY = "hermes.model"; // registre des réglages (FORK.md §6)
const COMPARE_KEY = "hermes.compare.models"; // F-17 : paire [a, b] persistée
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

/** Prompt système de la conversation active (F-11) — injecté par la page
 *  depuis le hook dédié `useSystemPrompts`, pour la jauge de contexte. */
export interface ChatPromptInfo {
  content: string;
  presetTitle?: string | null;
}

export function useHermesChat() {
  const { toast } = useToast();
  const [connected, setConnected] = useState(false);
  const [serverInfo, setServerInfo] = useState<ServerHello | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // F-17 — comparaison : DEUX réponses streament en parallèle (variantes
  // a/b). L'état vit dans une map par messageId ; `streaming` (première
  // entrée active) reste l'indicateur d'occupation pour tout le hook.
  const [streamsRecord, setStreamsRecord] = useState<Record<string, StreamingState>>({});
  const streams = useMemo(() => Object.values(streamsRecord), [streamsRecord]);
  const streaming = streams[0] ?? null;

  // F-17 — état du mode comparaison (paire persistée dans le registre).
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareModels, setCompareModels] = useState<{ a: string | null; b: string | null }>({ a: null, b: null });
  const compareEnabledRef = useRef(compareEnabled);
  compareEnabledRef.current = compareEnabled;
  const compareModelsRef = useRef(compareModels);
  compareModelsRef.current = compareModels;
  /** Erreur persistante du dernier tour (F-04) : affichée dans le fil jusqu'à
   *  réessai / changement de conversation — plus d'effacement automatique. */
  const [turnError, setTurnError] = useState<{ messageId: string; error: string } | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsSource, setModelsSource] = useState<ModelsResult["source"] | null>(null);
  const [selectedModel, setSelectedModelState] = useState<string | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  // ── Chantier « Composer v2 » : effort, permissions, compaction ──────
  /** Effort de raisonnement (valeur brute du fournisseur, persisté). */
  const [effort, setEffortState] = useState<string | null>(null);
  // ── Mode expert (F-22) : température, plafond de sortie, graine ─────
  /** Réglages expert persistés (champs absents = valeur par défaut). */
  const [expert, setExpertState] = useState<ExpertSettings>({});
  /** Autorisations : reset sur « ask » à chaque session — jamais restauré. */
  const [permissionsMode, setPermissionsMode] = useState<PermissionsMode>("ask");
  /** État de compaction de la conversation active. */
  const [compactInfo, setCompactInfo] = useState<CompactInfo | null>(null);
  /** Compaction en cours (synthèse LLM côté service). */
  const [compacting, setCompacting] = useState(false);
  // ── Prompt système de la conversation active (F-11) ─────────────────
  /** Prompt actif de la conversation ouverte (null si aucun) — suit le bus
   *  `system-prompt:changed` du service ; la page lit/écrit via le hook dédié. */
  const [promptInfo, setPromptInfo] = useState<ChatPromptInfo | null>(null);
  const promptInfoRef = useRef<ChatPromptInfo | null>(null);
  // ── Artefacts de la conversation active + panneau dédié ──────────
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  /** Contenu source en cours de stream, par clé d'artefact (aperçu vivant). */
  const [streamingArtifacts, setStreamingArtifacts] = useState<Record<string, string>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelArtifactId, setPanelArtifactId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const selectedModelRef = useRef<string | null>(null);
  /** Clé de l'artefact affiché dans le panneau (survit aux changements de version). */
  const panelKeyRef = useRef<string | null>(null);
  const effortRef = useRef<string | null>(null);
  const expertRef = useRef<ExpertSettings>({});
  const permissionsRef = useRef<PermissionsMode>("ask");

  // Synchronise les refs (lecture seule côté handlers d'événements)
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    effortRef.current = effort;
  }, [effort]);

  useEffect(() => {
    expertRef.current = expert;
  }, [expert]);

  useEffect(() => {
    permissionsRef.current = permissionsMode;
  }, [permissionsMode]);

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

  // Sélection persistée (registre des réglages, cf. FORK.md §6)
  useEffect(() => {
    const saved = readClientSetting<string | null>(MODEL_SETTING_KEY);
    if (saved) setSelectedModelState(saved);
    // F-17 : paire de comparaison mémorisée (best effort, ignorée si invalide)
    try {
      const raw = readClientSetting<string>(COMPARE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length === 2) {
        const [a, b] = parsed;
        if (typeof a === "string" && typeof b === "string" && a && b) {
          setCompareModels({ a, b });
        }
      }
    } catch {
      /* paire illisible : on repart à vide */
    }
    const savedEffort = readClientSetting<string>(EFFORT_SETTING_KEY);
    if (savedEffort) setEffortState(savedEffort);
    // Mode expert (F-22) : champs individuels, absents = défaut du fournisseur
    const savedTemperature = readClientSetting<number | null>(EXPERT_TEMPERATURE_KEY);
    const savedMaxTokens = readClientSetting<number | null>(EXPERT_MAX_TOKENS_KEY);
    const savedSeed = readClientSetting<number | null>(EXPERT_SEED_KEY);
    setExpertState({
      ...(savedTemperature !== null ? { temperature: savedTemperature } : {}),
      ...(savedMaxTokens !== null ? { maxTokens: savedMaxTokens } : {}),
      ...(savedSeed !== null ? { seed: savedSeed } : {}),
    });
  }, []);

  // Autorisations : reset explicite sur « ask » à chaque session (spec) —
  // la persistance viendra plus tard de la page de paramètres.
  useEffect(() => {
    writeClientSetting(PERMISSIONS_SETTING_KEY, "ask");
  }, []);

  // ── Application immédiate : réglages modifiés depuis le sheet Paramètres ─
  // (modèle, effort, permissions — le bus hermes-ui:settings-changed, FORK.md §7.4)
  useEffect(() => {
    return onSettingsChanged(({ key, value }) => {
      if (key === MODEL_SETTING_KEY && typeof value === "string") {
        setSelectedModelState(value);
      } else if (key === EFFORT_SETTING_KEY && typeof value === "string") {
        setEffortState(value);
      } else if (key === PERMISSIONS_SETTING_KEY) {
        setPermissionsMode(value === "auto" ? "auto" : "ask");
      } else if (
        key === EXPERT_TEMPERATURE_KEY ||
        key === EXPERT_MAX_TOKENS_KEY ||
        key === EXPERT_SEED_KEY
      ) {
        // Mode expert (F-22) : chaque champ vit sa clé (null = retiré)
        setExpertState((prev) => {
          const next = { ...prev };
          if (key === EXPERT_TEMPERATURE_KEY)
            next.temperature = typeof value === "number" ? value : undefined;
          if (key === EXPERT_MAX_TOKENS_KEY)
            next.maxTokens = typeof value === "number" ? value : undefined;
          if (key === EXPERT_SEED_KEY)
            next.seed = typeof value === "number" ? value : undefined;
          return next;
        });
      }
    });
  }, []);

  const setSelectedModel = useCallback((id: string) => {
    setSelectedModelState(id);
    writeClientSetting(MODEL_SETTING_KEY, id);
  }, []);

  /** Effort de raisonnement : valeur brute du fournisseur, persistée. */
  const setEffort = useCallback((e: string) => {
    setEffortState(e);
    writeClientSetting(EFFORT_SETTING_KEY, e);
  }, []);

  /** Mode expert (F-22) : fusionne et persiste champ par champ (undefined
   *  = retiré : la clé localStorage est EFFACÉE — pas écrite à null, sinon
   *  Number(null) persisterait 0 et la valeur « reviendrait » au rechargement). */
  const setExpert = useCallback((patch: Partial<ExpertSettings>) => {
    setExpertState((prev) => {
      const next = { ...prev, ...patch };
      // Champ présent → écrit ; champ retiré → suppression de la clé
      // (retour au défaut du fournisseur à la relecture).
      const persist = (key: string, v: number | undefined) => {
        if (v === undefined) deleteClientSetting(key);
        else writeClientSetting(key, v);
      };
      persist(EXPERT_TEMPERATURE_KEY, next.temperature);
      persist(EXPERT_MAX_TOKENS_KEY, next.maxTokens);
      persist(EXPERT_SEED_KEY, next.seed);
      return next;
    });
  }, []);

  /** Autorisations : armement explicite — jamais silencieux. */
  const changePermissions = useCallback((mode: PermissionsMode) => {
    setPermissionsMode(mode);
    writeClientSetting(PERMISSIONS_SETTING_KEY, mode);
  }, []);

  // L'échelle d'effort est portée par le modèle : quand le modèle change et
  // que l'effort courant n'existe pas dans la nouvelle échelle, on retombe
  // sur le cran équivalent le plus proche (standard > medium > milieu).
  useEffect(() => {
    if (!models.length || !selectedModel) return;
    const model = models.find((m) => m.id === selectedModel);
    if (!model) return;
    const scale = model.efforts?.length ? model.efforts : ["off", "low", "medium", "high", "max"];
    const current = effortRef.current;
    if (current && scale.includes(current)) return;
    const fallback =
      scale.find((e) => e === "standard") ??
      scale.find((e) => e === "medium") ??
      scale[Math.floor((scale.length - 1) / 2)];
    setEffortState(fallback);
    writeClientSetting(EFFORT_SETTING_KEY, fallback);
  }, [models, selectedModel]);

  const isBusy = streaming !== null || uploadingCount > 0;

  /** Paire de comparaison actuellement actionnable (F-17), sinon null. */
  const activeComparePair = useMemo(() => {
    const { a, b } = compareModelsRef.current;
    if (!compareEnabled || !a || !b || a === b) return null;
    return [a, b] as [string, string];
  }, [compareEnabled, compareModels]);

  /** Retrouve l'id d'un modèle depuis le libellé d'une réponse (« … (démo) »,
   *  « glm-4.6 · z.ai » — v2.3 : le suffixe fournisseur est retiré). */
  const modelIdFromLabel = useCallback(
    (label?: string) => {
      if (!label) return null;
      const clean = label
        .replace(/\s*\(démo\)$/, "")
        .replace(/\s*·\s*[^·]+$/, "");
      return models.find((m) => m.label === clean)?.id ?? null;
    },
    [models]
  );

  /** Machine à états du tour (F-01) : idle → streaming → done | stopped | error. */
  const turnState: "idle" | "streaming" | "stopped" | "error" = useMemo(() => {
    if (streaming) return "streaming";
    if (turnError) return "error";
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.stopped) return "stopped";
    return "idle";
  }, [streaming, turnError, messages]);

  const refreshConversations = useCallback(() => {
    const socket = getSocket();
    socket.emit("conversations:list", (res: { conversations?: ConversationMeta[] } = {}) => {
      if (res.conversations) setConversations(res.conversations);
    });
  }, []);

  /** Charge la liste des projets (rangement des conversations). */
  const fetchProjects = useCallback(() => {
    getSocket().emit("projects:list", (res: { projects?: Project[] } = {}) => {
      if (res.projects) setProjects(res.projects);
    });
  }, []);

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

  /** Charge les artefacts d'une conversation (toutes versions, métadonnées). */
  const fetchArtifacts = useCallback((conversationId: string) => {
    getSocket().emit(
      "artifacts:list",
      { conversationId },
      (res: { artifacts?: Artifact[] } = {}) => {
        if (conversationId === activeIdRef.current) {
          setArtifacts(res.artifacts ?? []);
        }
      }
    );
  }, []);

  // --- Connexion socket + écoute des événements de stream ---
  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => {
      setConnected(true);
      socket.emit("hello", (info: ServerHello) => setServerInfo(info));
      refreshConversations();
      fetchProjects();
      fetchModels();
    };
    const onDisconnect = () => {
      setConnected(false);
      setStreamsRecord({});
    };

    const onStreamStart = (p: {
      conversationId: string;
      messageId: string;
      variant?: "a" | "b";
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setTurnError(null); // un nouveau tour efface l'erreur précédente
      setStreamsRecord((prev) => ({
        ...prev,
        [p.messageId]: {
          messageId: p.messageId,
          conversationId: p.conversationId,
          variant: p.variant,
          content: "",
          reasoning: "",
          status: "Hermes réfléchit…",
          toolEvents: [],
        },
      }));
    };

    const onStreamDelta = (p: {
      conversationId: string;
      messageId: string;
      delta: string;
      variant?: "a" | "b";
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setStreamsRecord((prev) => {
        const s = prev[p.messageId];
        if (!s) return prev;
        return {
          ...prev,
          [p.messageId]: { ...s, content: s.content + p.delta, status: null },
        };
      });
    };

    const onStreamReasoning = (p: {
      conversationId: string;
      messageId: string;
      delta: string;
      variant?: "a" | "b";
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setStreamsRecord((prev) => {
        const s = prev[p.messageId];
        if (!s) return prev;
        return { ...prev, [p.messageId]: { ...s, reasoning: s.reasoning + p.delta } };
      });
    };

    const onStreamStatus = (p: {
      conversationId: string;
      messageId: string | null;
      status: string;
      variant?: "a" | "b";
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setStreamsRecord((prev) => {
        const next: Record<string, StreamingState> = {};
        for (const [id, s] of Object.entries(prev)) {
          // Statut global (messageId null, ex. arrêt) → tous les côtés.
          next[id] = !p.messageId || p.messageId === id ? { ...s, status: p.status } : s;
        }
        return next;
      });
    };

    const onStreamTool = (p: {
      conversationId: string;
      messageId: string;
      event: ToolEvent;
      variant?: "a" | "b";
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setStreamsRecord((prev) => {
        const s = prev[p.messageId];
        if (!s) return prev;
        return {
          ...prev,
          [p.messageId]: { ...s, toolEvents: [...s.toolEvents, p.event], status: null },
        };
      });
    };

    const onStreamDone = (p: {
      conversationId: string;
      messageId: string;
      conversation?: ConversationMeta;
      message?: ChatMessage;
      stopped?: boolean;
    }) => {
      if (p.conversationId !== activeIdRef.current) {
        refreshConversations();
        setStreamsRecord((prev) => {
          if (!(p.messageId in prev)) return prev;
          const next = { ...prev };
          delete next[p.messageId];
          return next;
        });
        return;
      }
      if (p.message) {
        setMessages((prev) => [...prev, p.message as ChatMessage]);
      }
      // F-17 : ne retirer que CE tour — l'autre variante peut couler encore.
      setStreamsRecord((prev) => {
        if (!(p.messageId in prev)) return prev;
        const next = { ...prev };
        delete next[p.messageId];
        return next;
      });
      setTurnError(null); // arrêt (stopped) ou succès : ce tour est clos
      refreshConversations();
    };

    const onStreamError = (p: {
      conversationId: string;
      messageId?: string;
      conversation?: ConversationMeta;
      message?: ChatMessage;
      error: string;
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      // Le partiel persisté (s'il existe) rejoint le fil immédiatement —
      // plus besoin de recharger la conversation pour le voir.
      if (p.message) {
        const partial = p.message;
        setMessages((prev) =>
          prev.some((m) => m.id === partial.id) ? prev : [...prev, partial]
        );
      }
      setTurnError({ messageId: p.messageId ?? p.message?.id ?? "", error: p.error });
      // F-17 : un côté peut échouer pendant que l'autre termine — on ne
      // retire que le tour concerné.
      setStreamsRecord((prev) => {
        const key = p.messageId ?? p.message?.id;
        if (!key || !(key in prev)) return {};
        const next = { ...prev };
        delete next[key];
        return next;
      });
      refreshConversations();
    };

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
      if (p.conversationId !== activeIdRef.current) return;
      setCompactInfo(p.compact ?? null);
      setCompacting(false);
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

    // Feedback 👍/👎 + commentaire (F-24) — broadcast d'un autre client
    const onFeedbackChanged = (p: {
      conversationId: string;
      message: ChatMessage;
    }) => {
      if (p.conversationId !== activeIdRef.current || !p.message) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === p.message.id
            ? {
                ...m,
                feedbackRating: p.message.feedbackRating,
                feedbackComment: p.message.feedbackComment,
              }
            : m
        )
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

    const onProjectDeleted = (p: { id: string }) => {
      setProjects((prev) => prev.filter((x) => x.id !== p.id));
      // Les conversations du projet retombent dans « Sans projet »
      setConversations((prev) =>
        prev.map((c) => (c.projectId === p.id ? { ...c, projectId: null } : c))
      );
    };

    const onProjectsReordered = (p: { projects?: Project[] }) => {
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

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
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
    const onMessagesRefreshed = (p: { conversationId: string; messages: ChatMessage[] }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setMessages(p.messages ?? []);
    };
    socket.on("messages:superseded", onMessagesSuperseded);
    socket.on("messages:refreshed", onMessagesRefreshed);
    socket.on("message:updated", onMessageUpdated);
    socket.on("feedback:changed", onFeedbackChanged);
    socket.on("conversations:pinned", onConversationsPinned);
    socket.on("conversations:created", onConversationsCreated);
    socket.on("projects:created", onProjectCreated);
    socket.on("projects:renamed", onProjectRenamed);
    socket.on("projects:deleted", onProjectDeleted);
    socket.on("projects:reordered", onProjectsReordered);
    socket.on("conversations:moved", onConversationMoved);
    socket.on("artifact:created", onArtifactCreated);
    socket.on("artifact:delta", onArtifactDelta);
    socket.on("artifact:updated", onArtifactUpdated);
    socket.on("models:changed", onModelsChanged);

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
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
      socket.off("feedback:changed", onFeedbackChanged);
      socket.off("conversations:pinned", onConversationsPinned);
      socket.off("conversations:created", onConversationsCreated);
      socket.off("projects:created", onProjectCreated);
      socket.off("projects:renamed", onProjectRenamed);
      socket.off("projects:deleted", onProjectDeleted);
      socket.off("projects:reordered", onProjectsReordered);
      socket.off("conversations:moved", onConversationMoved);
      socket.off("artifact:created", onArtifactCreated);
      socket.off("artifact:delta", onArtifactDelta);
      socket.off("artifact:updated", onArtifactUpdated);
      socket.off("models:changed", onModelsChanged);
    };
  }, [refreshConversations, fetchProjects, fetchModels, fetchArtifacts]);

  // --- Actions ---
  const newConversation = useCallback(
    async (projectId?: string | null): Promise<string | null> => {
      const socket = getSocket();
      return new Promise((resolve) => {
        socket.emit(
          "conversations:create",
          { projectId: projectId ?? null },
          (res: { conversation?: ConversationMeta }) => {
            if (res.conversation) {
              activeIdRef.current = res.conversation.id;
              setConversations((prev) => [res.conversation as ConversationMeta, ...prev]);
              setActiveId(res.conversation.id);
              setMessages([]);
              setTurnError(null);
              setCompactInfo(null);
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

  const openConversation = useCallback(
    (id: string) => {
      const socket = getSocket();
      setLoadingHistory(true);
      activeIdRef.current = id;
      setActiveId(id);
      setStreamsRecord({});
      setTurnError(null);
      setCompactInfo(null);
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
        } = {} as any) => {
          if (res.conversationId === id) {
            setMessages(res.messages ?? []);
            setCompactInfo(res.compact ?? null);
          }
          setLoadingHistory(false);
        }
      );
      fetchArtifacts(id);
    },
    [fetchArtifacts]
  );

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

  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      const content = text.trim();
      if ((!content && attachments.length === 0) || streaming) return;

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
      // F-17 : mode comparaison — un message, deux modèles, deux réponses.
      const pair = activeComparePair;
      socket.emit(
        "chat:send",
        {
          conversationId,
          content,
          ...(pair
            ? { compare: pair }
            : { model: selectedModelRef.current ?? undefined }),
          attachments: attachments.length ? attachments : undefined,
          effort: effortRef.current ?? undefined,
          permissionsMode: permissionsRef.current,
          ...expertRef.current,
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
    [newConversation, streaming, activeComparePair]
  );

  const stopGeneration = useCallback(() => {
    if (!activeIdRef.current) return;
    getSocket().emit("chat:stop", { conversationId: activeIdRef.current });
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
      const pair = activeComparePair;
      const base = {
        effort: effortRef.current ?? undefined,
        permissionsMode: permissionsRef.current,
        ...expertRef.current,
      };
      const resync = (res: { ok?: boolean; error?: string } | null) => {
        if (!res?.ok) openConversation(conversationId);
      };
      if (variant && !pair) {
        // Côté d'une comparaison (mode coupé ou session rechargée) :
        // retrouve le modèle de ce côté depuis le libellé de sa réponse.
        const last = [...messages].reverse().find((m) => m.variant === variant);
        const id = modelIdFromLabel(last?.model) ?? selectedModelRef.current ?? undefined;
        setMessages((prev) => {
          const next = [...prev];
          while (
            next.length > 0 &&
            next[next.length - 1].role === "assistant" &&
            next[next.length - 1].variant === variant
          )
            next.pop();
          return next;
        });
        getSocket().emit("chat:regenerate", { conversationId, variant, model: id, ...base }, resync);
        return;
      }
      if (pair) {
        // Comparaison active : les deux côtés repartent ensemble.
        setMessages((prev) => {
          const next = [...prev];
          while (next.length > 0 && next[next.length - 1].role === "assistant") next.pop();
          return next;
        });
        getSocket().emit("chat:regenerate", { conversationId, compare: pair, ...base }, resync);
        return;
      }
      // Tour simple : comportement historique (optimiste + resync au refus).
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
    [openConversation, streaming, activeComparePair, messages, modelIdFromLabel]
  );

  /** Masque l'erreur du dernier tour (le partiel éventuel reste dans le fil). */
  const dismissTurnError = useCallback(() => setTurnError(null), []);

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

  /** F-17 — active/coupe la comparaison ; à l'activation, pré-remplit le
   *  côté A avec le modèle courant et le côté B avec le premier modèle
   *  différent du catalogue. La paire est mémorisée dans le registre. */
  const toggleCompare = useCallback(() => {
    setCompareEnabled((on) => {
      if (on) return false; // simple extinction
      setCompareModels((cur) => {
        const a = cur.a ?? selectedModelRef.current ?? models[0]?.id ?? null;
        const b =
          cur.b ?? models.find((m) => m.id !== a)?.id ?? null;
        if (a && b && a !== b) writeClientSetting(COMPARE_KEY, JSON.stringify([a, b]));
        return { a, b };
      });
      return true;
    });
  }, [models]);

  /** F-17 — choisit le modèle d'un côté (a/b) et mémorise la paire. */
  const setCompareSlot = useCallback((slot: "a" | "b", id: string) => {
    setCompareModels((cur) => {
      const next = { ...cur, [slot]: id };
      if (next.a && next.b && next.a !== next.b) {
        writeClientSetting(COMPARE_KEY, JSON.stringify([next.a, next.b]));
      }
      return next;
    });
  }, []);

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
          // F-17 : en mode comparaison, l'édition relance les deux côtés.
          ...(activeComparePair
            ? { compare: activeComparePair }
            : { model: selectedModelRef.current ?? undefined }),
          effort: effortRef.current ?? undefined,
          permissionsMode: permissionsRef.current,
          ...expertRef.current,
        },
        (res: { ok?: boolean; error?: string }) => {
          if (!res?.ok) openConversation(conversationId);
        }
      );
    },
    [openConversation, streaming, activeComparePair]
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

  /** Pose / retire le feedback 👍/👎 (+ commentaire) d'une réponse (F-24).
   *  Local : jamais envoyé au modèle — persisté sur le message, broadcast. */
  const setMessageFeedback = useCallback(
    (
      messageId: string,
      rating: "up" | "down" | null,
      comment?: string | null
    ) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || messageId.startsWith("local-")) return;
      // Mise à jour optimiste : le clic est immédiat ; le broadcast confirme.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                feedbackRating: rating ?? undefined,
                feedbackComment: rating ? (comment ?? undefined) : undefined,
              }
            : m
        )
      );
      getSocket().emit(
        "feedback:set",
        { conversationId, messageId, rating, comment: comment ?? null },
        (res: { message?: ChatMessage; error?: string } = {}) => {
          if (res.message) {
            const confirmed = res.message;
            setMessages((prev) =>
              prev.map((m) => (m.id === confirmed.id ? confirmed : m))
            );
          } else if (res.error) {
            // Échec (message partiels, rôle) : retour à l'état antérieur
            openConversation(conversationId);
          }
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

  // ── Projets : actions ───────────────────────────────────────────

  /** Crée un projet (rangement de conversations). */
  const createProject = useCallback(
    (name: string): Promise<Project | null> =>
      new Promise((resolve) => {
        getSocket().emit(
          "projects:create",
          { name },
          (res: { project?: Project; error?: string } = {}) => {
            resolve(res.project ?? null);
          }
        );
      }),
    []
  );

  /** Renomme un projet. */
  const renameProject = useCallback((id: string, name: string) => {
    getSocket().emit(
      "projects:rename",
      { id, name },
      (res: { project?: Project } = {}) => {
        if (res.project)
          setProjects((prev) => prev.map((x) => (x.id === id ? res.project! : x)));
      }
    );
  }, []);

  /** Supprime un projet (les conversations passent dans « Sans projet »). */
  const deleteProject = useCallback((id: string) => {
    getSocket().emit("projects:delete", { id }, (res: { ok?: boolean } = {}) => {
      if (res.ok) {
        setProjects((prev) => prev.filter((x) => x.id !== id));
        setConversations((prev) =>
          prev.map((c) => (c.projectId === id ? { ...c, projectId: null } : c))
        );
      }
    });
  }, []);

  /** Réordonne les projets (liste complète d'ids). */
  const reorderProjects = useCallback((ids: string[]) => {
    getSocket().emit(
      "projects:reorder",
      { ids },
      (res: { projects?: Project[] } = {}) => {
        if (res.projects) setProjects(res.projects);
      }
    );
  }, []);

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

    // Instructions système : taille réelle du moteur démo, estimation sinon
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

  /** Peut-on compacter : conversation ouverte, ≥ 2 messages, tour au repos. */
  const canCompact = Boolean(activeId) && messages.length >= 2 && !streaming;

  // ── Artefacts : panneau, retry, versions ──────────────────────────────

  /** Ouvre le panneau sur un artefact précis (clic carte, carte « Ouvrir »). */
  const openArtifact = useCallback((artifact: Artifact) => {
    panelKeyRef.current = artifact.key;
    setPanelArtifactId(artifact.id);
    setPanelOpen(true);
  }, []);

  /** Referme le panneau (l'utilisateur reprend le fil de la conversation). */
  const closePanel = useCallback(() => setPanelOpen(false), []);

  /** Sélectionne une version précise dans le panneau (sans l'ouvrir). */
  const selectArtifactVersion = useCallback((artifact: Artifact) => {
    panelKeyRef.current = artifact.key;
    setPanelArtifactId(artifact.id);
  }, []);

  /** Relance le rendu d'un artefact en erreur. */
  const retryArtifact = useCallback((artifactId: string) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    getSocket().emit(
      "artifact:retry",
      { conversationId, artifactId },
      (res: { ok?: boolean; error?: string }) => {
        if (!res?.ok && res?.error) {
          console.warn("[hermes] retry artefact :", res.error);
        }
      }
    );
  }, []);

  /** Toutes les versions d'une clé d'artefact (sélecteur + diff du panneau). */
  const fetchArtifactVersions = useCallback(
    (key: string): Promise<Artifact[]> =>
      new Promise((resolve) => {
        const conversationId = activeIdRef.current;
        if (!conversationId) return resolve([]);
        getSocket().emit(
          "artifact:versions",
          { conversationId, key },
          (res: { versions?: Artifact[] } = {}) => resolve(res.versions ?? [])
        );
      }),
    []
  );

  return {
    connected,
    mode: (serverInfo?.mode ?? null) as GatewayMode | null,
    serverModel: serverInfo?.model ?? null,
    serverVersion: serverInfo?.version ?? null,
    conversations,
    projects,
    activeId,
    messages,
    streaming,
    /** F-17 : TOUS les streams actifs (tour simple + variantes a/b). */
    streams,
    isBusy,
    // F-17 — comparaison de modèles
    compareEnabled,
    compareModels,
    toggleCompare,
    setCompareSlot,
    turnState,
    turnError,
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
    // Feedback 👍/👎 (F-24)
    setMessageFeedback,
    togglePin,
    forkConversation,
    searchMessages,
    transcribeAudio,
    // Projets
    createProject,
    renameProject,
    deleteProject,
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
