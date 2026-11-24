// Écoute des événements socket du chat — extrait de use-hermes-chat.ts
// (audit CRAP 2026-11 : le useEffect de câblage faisait 462 lignes et portait
// l'essentiel de la complexité du hook principal, CC 287).
// Corps des handlers VERBATIM ; les identifiants capturés arrivent par deps,
// déstructurés en tête — aucune autre modification. Le tableau de dépendances
// du useEffect est conservé à l'identique (mêmes identités, mêmes ré-abonnements).
"use client";

import { useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { getSocket } from "@/lib/socket";
import { streamStore } from "@/lib/stream-store";
import { BUILD_REVISION } from "@/lib/build-revision";
import { useProjects } from "@/hooks/use-projects";
import { useChatStream } from "@/hooks/use-chat-stream";
import { useArtifactsPanel } from "@/hooks/use-artifacts-panel";
import { useToast } from "@/hooks/use-toast";
import type {
  Artifact,
  ChatMessage,
  CompactInfo,
  ConversationMeta,
  Project,
  ServerHello,
  UpdateCheckResult,
} from "@/lib/chat-types";

type ProjectsApi = ReturnType<typeof useProjects>;
type StreamApi = ReturnType<typeof useChatStream>;
type ArtifactsApi = ReturnType<typeof useArtifactsPanel>;
type ToastFn = ReturnType<typeof useToast>["toast"];

/** Dépendances du câblage socket : tout identifiant du hook principal utilisé
 *  par les handlers, passé tel quel (identités conservées). */
export type ChatSocketEventsDeps = {
  // ── Projets (useProjects) + miroir ref ─────────────────────────────────
  setProjects: ProjectsApi["setProjects"];
  fetchProjects: ProjectsApi["fetchProjects"];
  projectsRef: RefObject<Project[]>;
  // ── État direct du hook principal ──────────────────────────────────────
  setConnected: Dispatch<SetStateAction<boolean>>;
  setServerInfo: Dispatch<SetStateAction<ServerHello | null>>;
  setUpdateState: Dispatch<SetStateAction<UpdateCheckResult | null>>;
  setScreenOutdated: Dispatch<SetStateAction<string | null>>;
  setConversations: Dispatch<SetStateAction<ConversationMeta[]>>;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setCompactInfo: Dispatch<SetStateAction<CompactInfo | null>>;
  setCompacting: Dispatch<SetStateAction<boolean>>;
  // ── Refs du hook principal ─────────────────────────────────────────────
  activeIdRef: RefObject<string | null>;
  updateToastShownRef: RefObject<boolean>;
  screenOutdatedRef: RefObject<string | null>;
  screenOutdatedDismissedRef: RefObject<string | null>;
  wasDisconnectedRef: RefObject<boolean>;
  resyncConversationRef: RefObject<(id: string) => void>;
  // ── Rappels du hook principal ──────────────────────────────────────────
  fetchModels: () => void;
  refreshConversations: () => void;
  toast: ToastFn;
} & Pick<
  StreamApi,
  | "setTurnError"
  | "resetStreams"
  | "bumpActivity"
  | "onStreamStart"
  | "onStreamDelta"
  | "onStreamReasoning"
  | "onStreamStatus"
  | "onStreamTool"
  | "onStreamDone"
  | "onStreamError"
  | "onModeFlow"
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

export function useChatSocketEvents(deps: ChatSocketEventsDeps) {
  const {
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
  } = deps;

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
      // Revue P1-P7 : le verdict « connexion perdue » programmé ne survit
      // pas au démontage du grand effet — l'ancien code ne nettoyait pas
      // disconnectTimer ici : un setState pouvait partir sur un hook mort.
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
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
}
