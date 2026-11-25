// CRUD conversations extrait de use-hermes-chat.ts (audit CRAP 2026-11, vague 3).
// Corps des callbacks VERBATIM — mêmes identités de dépendances, mêmes tableaux
// de deps. useHermesChat consomme les actions par déstructuration : l'API
// publique du hook ne change pas, la page n'est pas touchée.
"use client";

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { getSocket } from "@/lib/socket";
import { readClientSetting } from "@/lib/settings";
import { emitAck } from "@/lib/emit-ack";
import { resolveMode, type ConversationMode, type ModeConfig } from "@/lib/modes";
import { useToast } from "@/hooks/use-toast";
import { useChatStream } from "@/hooks/use-chat-stream";
import { useArtifactsPanel } from "@/hooks/use-artifacts-panel";
import type {
  ChatMessage,
  CompactInfo,
  ConversationMeta,
  SearchHit,
  ToolEvent,
} from "@/lib/chat-types";

type StreamApi = ReturnType<typeof useChatStream>;
type ArtifactsApi = ReturnType<typeof useArtifactsPanel>;
type ToastFn = ReturnType<typeof useToast>["toast"];

/** Dépendances du CRUD conversations : tout identifiant du hook principal
 *  utilisé par les callbacks, passé tel quel (identités conservées). */
export type ConversationsDeps = {
  toast: ToastFn;
  creatingRef: RefObject<boolean>;
  pendingModeRef: RefObject<{ mode: ConversationMode; config: ModeConfig } | null>;
  activeIdRef: RefObject<string | null>;
  loadingForRef: RefObject<string | null>;
  conversations: ConversationMeta[];
  setConversations: Dispatch<SetStateAction<ConversationMeta[]>>;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setLoadingHistory: Dispatch<SetStateAction<boolean>>;
  setCompactInfo: Dispatch<SetStateAction<CompactInfo | null>>;
  setCompacting: Dispatch<SetStateAction<boolean>>;
  setPendingMode: Dispatch<SetStateAction<{ mode: ConversationMode; config: ModeConfig } | null>>;
} & Pick<
  StreamApi,
  | "setTurnError"
  | "resetStreams"
  | "setStreamsRecord"
  | "setModeFlowLive"
  | "bumpActivity"
> &
  Pick<
    ArtifactsApi,
    | "setArtifacts"
    | "setStreamingArtifacts"
    | "setPanelOpen"
    | "setPanelArtifactId"
    | "panelKeyRef"
    | "fetchArtifacts"
  >;

export function useConversations(deps: ConversationsDeps) {
  const {
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
  } = deps;

  const newConversation = useCallback(
    async (projectId?: string | null): Promise<string | null> => {
      const socket = getSocket();
      // Lot 3 (audit L3-5) : garde anti double-émission — un double-clic sur
      // « Nouvelle conversation » avant l'ack créait DEUX conversations.
      if (creatingRef.current) return null;
      creatingRef.current = true;
      // ── Verrou « dossier des premières conversations » (2026-11-25) ──
      // Base vide (aucune conversation) + appel SANS dossier explicite :
      // la consigne du service est de ranger la première conversation dans
      // le dossier par défaut. On le lit ICI pour que l'écran ne crée jamais
      // à l'aveugle : réglage défini → injection ; réglage vide → blocage
      // LOCAL avec un message qui dit où définir (le service aurait aussi
      // refusé, mais l'erreur s'affiche mieux en amont).
      let targetProjectId = projectId ?? null;
      if (!targetProjectId && conversations.length === 0) {
        const res = await emitAck<{ value?: unknown }>("settings:get", {
          key: "hermes.conversations.defaultProject",
        });
        const defaultProjectId =
          res && typeof res.value === "string" ? res.value.trim() : "";
        if (!defaultProjectId) {
          creatingRef.current = false;
          toast({
            title: "Première conversation bloquée",
            description:
              "Choisissez d'abord un dossier par défaut dans Paramètres → Interface — la toute première conversation doit être rangée.",
            variant: "destructive",
          });
          return null;
        }
        targetProjectId = defaultProjectId;
      }
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
            projectId: targetProjectId ?? null,
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
    // Vague 3 : la liste couvre TOUTES les valeurs réactives du corps (le
    // compilateur React l'exige quand les deps traversent la frontière du
    // hook) — ce sont des setters useState et des refs : identités stables,
    // le callback garde la même fréquence de re-création qu'avant.
    // 2026-11-25 : `conversations` rejoint la liste — le verrou « première
    // conversation » lit sa LONGUEUR (base vide ou non) dans le corps.
    [
      toast,
      creatingRef,
      pendingModeRef,
      activeIdRef,
      loadingForRef,
      conversations,
      setConversations,
      setActiveId,
      setMessages,
      setTurnError,
      setCompactInfo,
      setModeFlowLive,
      setLoadingHistory,
      setPendingMode,
    ]
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
            // Revue P1-P7 (B14) : un tour ré-attaché est un signe de vie —
            // après F5, lastActivityRef vaut 0 (socket.onAny ne voit pas
            // les acks) et la vigie tuait le tour VIVANT au premier tick.
            if (res.live?.length) bumpActivity();
          }
        }
      );
      fetchArtifacts(id);
    },
    // (même règle : deps complètes — setters/refs à identité stable)
    [
      setLoadingHistory,
      loadingForRef,
      activeIdRef,
      setActiveId,
      resetStreams,
      setTurnError,
      setCompactInfo,
      setCompacting,
      setModeFlowLive,
      setPendingMode,
      setPanelOpen,
      setPanelArtifactId,
      panelKeyRef,
      setArtifacts,
      setStreamingArtifacts,
      setMessages,
      setStreamsRecord,
      bumpActivity,
      fetchArtifacts,
    ]
  );

  const deleteConversation = useCallback((id: string) => {
    getSocket().emit("conversations:delete", { id });
  }, []);

  const renameConversation = useCallback(
    (id: string, title: string) => {
      const socket = getSocket();
      socket.emit("conversations:rename", { id, title }, (res: { conversation?: ConversationMeta }) => {
        if (res.conversation) {
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, title: res.conversation!.title } : c))
          );
        }
      });
    },
    // (deps complètes : setter useState à identité stable)
    [setConversations]
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
    // (deps complètes : état + setter, tous deux réactifs ici)
    [conversations, setConversations]
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
    // (dep complète : ref du hook parent — identité stable)
    [activeIdRef]
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
    // (dep complète : setter useState à identité stable)
  }, [setConversations]);

  return {
    newConversation,
    openConversation,
    deleteConversation,
    renameConversation,
    togglePin,
    forkConversation,
    searchMessages,
    moveConversation,
  };
}
