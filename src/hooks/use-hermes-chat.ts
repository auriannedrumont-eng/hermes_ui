// Hook principal : orchestre les conversations, la sélection de modèle,
// les pièces jointes multimédia et le streaming via socket.io
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import { deleteClientSetting, onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import { resolveMode, type ConversationMode, type ModeConfig } from "@/lib/modes";
import { useToast } from "@/hooks/use-toast";
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

  // ── F-30 — mode de la conversation : le service fait foi ──────────
  /** Mode/config choisis avant qu'une conversation n'existe (état « nouveau »).
   *  Appliqués à la création, puis vidés. */
  const [pendingMode, setPendingMode] = useState<{
    mode: ConversationMode;
    config: ModeConfig;
  } | null>(null);
  /** Déroulé vivant du tour multi-voix (modes débat / conseil / auto).
   *  La réponse finale le porte en persistance — ce live n'est que le chemin. */
  const [modeFlowLive, setModeFlowLive] = useState<{
    messageId: string;
    rows: import("@/lib/chat-types").ModeFlowRow[];
  } | null>(null);
  const pendingModeRef = useRef(pendingMode);
  pendingModeRef.current = pendingMode;
  /** Erreur persistante du dernier tour (F-04) : affichée dans le fil jusqu'à
   *  réessai / changement de conversation — plus d'effacement automatique. */
  const [turnError, setTurnError] = useState<{ messageId: string; error: string } | null>(null);
  // ── Pont de dépannage (F-31) : silence du tour ──────────────────────
  // Le service a ses gardes (120 s pool, ~240 s pilote webchat) ; mais si le
  // SERVICE meurt ou que la connexion tombe, plus aucun événement n'arrive et
  // l'écran resterait « Hermes réfléchit… » sans fin. Un filtre d'activité
  // (tout événement socket = signe de vie) rend ce silence visible.
  const lastActivityRef = useRef<number>(0);
  // Voix en vol (F-30/F-31) : le déroulé mode:flow dit QUI travaille — la
  // notice de silence s'en sert pour dire la vérité (« la voix tourne depuis
  // N s ») au lieu de crier au blocage pendant une réponse lente mais vivante.
  const runningVoiceRef = useRef<{ label: string; since: number } | null>(null);
  const [stallNotice, setStallNotice] = useState<string | null>(null);
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
  /** F-09/F-12 — recherche web du tour (Tavily/Exa), persistée (hermes.tools.web). */
  const [webSearch, setWebSearchState] = useState<boolean>(
    () => readClientSetting<boolean>("hermes.tools.web") === true
  );
  const webSearchRef = useRef(webSearch);
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

  useEffect(() => {
    webSearchRef.current = webSearch;
  }, [webSearch]);

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
      } else if (key === "hermes.tools.web") {
        // v2.4 : appliqué par un profil — la bascule du composer suit en direct.
        setWebSearchState(value === true);
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
   *  (« glm-4.6 · z.ai » — v2.3 : le suffixe fournisseur est retiré). */
  const modelIdFromLabel = useCallback(
    (label?: string) => {
      if (!label) return null;
      const clean = label.replace(/\s*·\s*[^·]+$/, "");
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

  // F-31 — vigie de silence : pendant un tour, un service vivant émet des
  // signes de vie (deltas, statuts, déroulé). Sans RIEN pendant 60 s, l'écran
  // le dit honnêtement au lieu de rester figé sur « réfléchit… ».
  useEffect(() => {
    if (turnState !== "streaming") {
      setStallNotice(null);
      runningVoiceRef.current = null;
      return;
    }
    lastActivityRef.current = Date.now();
    const timer = setInterval(() => {
      const silentS = Math.round((Date.now() - lastActivityRef.current) / 1000);
      const voice = runningVoiceRef.current;
      if (silentS >= 60) {
        setStallNotice(
          voice
            ? `${voice.label} travaille depuis ${Math.round(
                (Date.now() - voice.since) / 1000,
              )} s — réponse lente mais en vol (gardes côté service : 120 s pool, ` +
              `~240 s pilote webchat). Pour voir si des octets arrivent encore : ` +
              `icône clé à molette → « Copier le diagnostic » (section pool.streams).`
            : `Aucun signe d'activité depuis ${silentS} s — soit le fournisseur est lent ` +
              `(gardes côté service : 120 s pool, ~240 s pilote webchat), soit le service est ` +
              `mort. Ouvrez le dépannage (icône clé à molette en haut à droite, ou ?debug=1 ` +
              `dans l'adresse) puis « Copier le diagnostic » pour voir lequel.`,
        );
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [turnState]);

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
      if (disconnectTimer) clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        // F-31 : si un tour était en vol, l'utilisateur a le droit de savoir
        // POURQUOI l'écran retombe — avant, le flux disparaissait en silence
        // et le déroulé restait « en cours » sans fin ni erreur.
        setStreamsRecord((prev) => {
          const inFlight = Object.keys(prev)[0];
          if (inFlight) {
            setTurnError({
              messageId: inFlight,
              error:
                "Connexion au service perdue pendant le tour (service arrêté, planté ou réseau coupé) " +
                "— rien n'arrivera davantage. La reconnexion est automatique : attendez quelques secondes, " +
                "puis réessayez. Le panneau ?debug=1 fournit le diagnostic complet.",
            });
          }
          return {};
        });
      }, 4000);
    };
    // v2.4 : le service rediffuse le hello quand le porte-clés change —
    // la carte de statut de la sidebar suit l état réel du moteur en direct.
    const onHello = (info: ServerHello) => setServerInfo(info);

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
        // Lot 3 (audit L3-5) : dédoublonnage — un stream:done reçu deux fois
        // (rediffusion après reconnexion) dupliquait la réponse dans le fil.
        const done = p.message;
        setMessages((prev) =>
          prev.some((m) => m.id === done.id) ? prev : [...prev, done as ChatMessage]
        );
      }
      // F-30 : le déroulé vivant a fini de courir — la réponse persistée le
      // porte désormais (messages.mode_flow) ; le live ne sert qu'en vol.
      setModeFlowLive((cur) => (cur?.messageId === p.messageId ? null : cur));
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
      // F-30 : un déroulé vivant s'arrête avec son tour (la réponse partielle
      // ne porte pas de déroulé — rien ne reste « en cours » à l'écran).
      setModeFlowLive((cur) =>
        !p.messageId || cur?.messageId === p.messageId ? null : cur
      );
      // F-17 : un côté peut échouer pendant que l'autre termine — on ne
      // retire que le tour concerné.
      setStreamsRecord((prev) => {
        // Lot 3 (audit L3-5) : l'ancien code renvoyait {} dès que la cible
        // était absente — une erreur service sans messageId (ou visant un
        // tour déjà clos) VIDAIT tous les streams en vol, y compris l'autre
        // côté d'une comparaison qui, lui, continue normalement.
        const key = p.messageId ?? p.message?.id;
        if (!key || !(key in prev)) return prev;
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

    // F-30 — déroulé vivant du tour multi-voix (débat, conseil, auto) :
    // chaque étape est poussée par le service, la réponse finale portera
    // le déroulé en persistance.
    const onModeFlow = (p: {
      conversationId: string;
      messageId: string;
      rows: import("@/lib/chat-types").ModeFlowRow[];
    }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setModeFlowLive({ messageId: p.messageId, rows: p.rows ?? [] });
      // Suivi de la voix en vol pour la notice de silence (F-31).
      const running = (p.rows ?? []).find((r) => r.status === "running");
      if (running) {
        if (runningVoiceRef.current?.label !== running.label) {
          runningVoiceRef.current = { label: running.label, since: Date.now() };
        }
      } else {
        runningVoiceRef.current = null;
      }
    };
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
    const bumpActivity = () => {
      lastActivityRef.current = Date.now();
      setStallNotice(null);
    };
    socket.onAny(bumpActivity);

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
    const onMessagesRefreshed = (p: { conversationId: string; messages: ChatMessage[] }) => {
      if (p.conversationId !== activeIdRef.current) return;
      setMessages(p.messages ?? []);
    };
    socket.on("messages:superseded", onMessagesSuperseded);
    socket.on("messages:refreshed", onMessagesRefreshed);
    socket.on("message:updated", onMessageUpdated);
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
    socket.on("mode:flow", onModeFlow);
    socket.on("conversations:mode", onConversationMode);

    if (socket.connected) onConnect();

    return () => {
      socket.offAny(bumpActivity);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("hello", onHello);
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
      socket.off("projects:created", onProjectCreated);
      socket.off("projects:renamed", onProjectRenamed);
      socket.off("projects:deleted", onProjectDeleted);
      socket.off("projects:reordered", onProjectsReordered);
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
            if (res.conversation) {
              activeIdRef.current = res.conversation.id;
              setConversations((prev) => [res.conversation as ConversationMeta, ...prev]);
              setActiveId(res.conversation.id);
              setMessages([]);
              setTurnError(null);
              setCompactInfo(null);
              setModeFlowLive(null);
              setPendingMode(null);
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
          }[];
        } = {} as any) => {
          // Garde de course (Lot 1, audit L1-5) : l'ack compare à la
          // conversation ACTIVE (activeIdRef), pas à la closure — navigation
          // A→B→C rapide, l'ack tardif de A ne doit rien écrire dans le fil
          // de C ni couper prématurément son spinner d'historique.
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
              setStreamsRecord((prev) =>
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
              );
            }
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
            toast({
              title: "Résumé automatique créé",
              description: "La conversation continue, allégée en tête de session.",
            });
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
      if ((!content && attachments.length === 0) || streaming || compactingRef.current)
        return;

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

  /** F-09/F-12 — bascule la recherche web du tour (persistée hermes.tools.web). */
  const toggleWebSearch = useCallback(() => {
    setWebSearchState((v) => {
      const next = !v;
      writeClientSetting("hermes.tools.web", next);
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
    // v2.4 (Paramètres → Système) — sondes réelles du hello.
    serverRevision: serverInfo?.appRevision ?? null,
    chromeHeadless: serverInfo?.chromeHeadless ?? null,
    gatewayUrl: serverInfo?.gatewayUrl ?? null,
    /** Jeton de gateway enregistré côté service (booléen honnête). */
    gatewayTokenSet: serverInfo?.gatewayTokenSet ?? false,
    /** Paramètres → Système : brancher l'agent Hermes réel. */
    connectGateway,
    conversations,
    projects,
    activeId,
    messages,
    streaming,
    /** F-17 : TOUS les streams actifs (tour simple + variantes a/b). */
    streams,
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
