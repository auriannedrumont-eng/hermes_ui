// Hook de stream — extrait de use-hermes-chat.ts (découpage 2026-11,
// FORK.md §10) : registre des streams en vol (F-17 variantes a/b), déroulé
// multi-voix vivant (F-30), erreur persistante du tour (F-04) et notice de
// silence (F-31). Les handlers socket stream:* / mode:flow sont créés par
// `buildStreamHandlers` (posés par l'orchestrateur, qui possède les
// dépendances conversationnelles : setMessages, refreshConversations) ;
// l'état et la vigie vivent ici — c'est ce hook que MessageList consommera
// pour ne plus re-rendre toute la page à chaque delta (16 ms).
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  streamStore,
  useStreamsRecord,
  useStreamsCount,
  useFirstStreamId,
  useModeFlowLive,
  useTurnError,
  useStallNotice,
} from "@/lib/stream-store";
import { getSocket } from "@/lib/socket";
import type {
  ChatMessage,
  ConversationMeta,
  ModeFlowRow,
  StreamingState,
  ToolEvent,
} from "@/lib/chat-types";

export interface StreamDeps {
  activeIdRef: React.RefObject<string | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  refreshConversations: () => void;
}

export function useChatStream({ activeIdRef, setMessages, refreshConversations }: StreamDeps) {
  // F-17 — comparaison : DEUX réponses streament en parallèle (variantes
  // a/b). L'état vit dans une map par messageId ; `streaming` (première
  // entrée active) reste l'indicateur d'occupation pour tout le hook.
  // ── Store externe (bonus perf 2026-11) : les deltas à ~16 ms ne
  // re-rendent plus la PAGE — seuls les consommateurs ciblés (MessageList)
  // s'abonnent via useSyncExternalStore. Ce hook reste le SEUL écrivain.
  const setStreamsRecord = streamStore.setStreamsRecord;
  const setModeFlowLive = streamStore.setModeFlowLive;
  const setTurnError = streamStore.setTurnError;
  const setStallNotice = streamStore.setStallNotice;
  // Attention : useStreamsRecord() re-rend à CHAQUE delta — ce hook est
  // appelé par l'orchestrateur (page) : il ne doit suivre que les signaux
  // LENTS. Le registre complet vit dans le store, lu par MessageList.
  const streamsCount = useStreamsCount();
  // `streaming` = identité figée du tour en vol (booléen d'occupation pour
  // l'orchestrateur : !== null quand un tour court, sans suivre les deltas).
  const streaming = useFirstStreamId();
  /** Déroulé vivant du tour multi-voix (modes débat / conseil / auto).
   *  La réponse finale le porte en persistance — ce live n'est que le chemin. */
  const modeFlowLive = useModeFlowLive();
  /** Erreur persistante du dernier tour (F-04) : affichée dans le fil jusqu'à
   *  réessai / changement de conversation — plus d'effacement automatique. */
  const turnError = useTurnError();
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
  const stallNotice = useStallNotice();

  /** Machine à états du tour (F-01) : idle → streaming → done | stopped | error.
   *  L'état « stopped » est affiné par l'orchestrateur (dernier message du fil). */
  const turnState: "idle" | "streaming" | "stopped" | "error" = useMemo(() => {
    if (streaming) return "streaming";
    if (turnError) return "error";
    return "idle";
  }, [streaming, turnError]);

  // F-31 — vigie de silence : pendant un tour, un service vivant émet des
  // signes de vie (deltas, statuts, déroulé). Sans RIEN pendant 60 s, l'écran
  // le dit honnêtement au lieu de rester figé sur « réfléchit… ».
  // Notice DÉRIVÉE au rendu (pas d'écriture d'état dans un effet) : le
  // dernier signe de vie (bumpActivity, callback socket) et la voix en vol
  // sont les seuls états ; l'écran se raffraîchit par un intervalle de
  // re-rendu léger uniquement PENDANT un tour (1 tick / 10 s).
  const [tick, setTick] = useState(0);
  const derivedStallNotice: string | null = useMemo(() => {
    if (turnState !== "streaming") return null;
    const silentS = Math.round((Date.now() - lastActivityRef.current) / 1000);
    if (silentS < 60) return null;
    const voice = runningVoiceRef.current;
    return voice
      ? `${voice.label} travaille depuis ${Math.round(
          (Date.now() - voice.since) / 1000,
        )} s — réponse lente mais en vol (gardes côté service : 120 s pool, ` +
        `~240 s pilote webchat). Pour voir si des octets arrivent encore : ` +
        `icône clé à molette → « Copier le diagnostic » (section pool.streams).`
      : `Aucun signe d'activité depuis ${silentS} s — soit le fournisseur est lent ` +
        `(gardes côté service : 120 s pool, ~240 s pilote webchat), soit le service est ` +
        `mort. Ouvrez le dépannage (icône clé à molette en haut à droite, ou ?debug=1 ` +
        `dans l'adresse) puis « Copier le diagnostic » pour voir lequel.`;
    // tick : relance la dérivation quand l'horloge avance pendant un tour
  }, [turnState, tick]);

  useEffect(() => {
    if (turnState !== "streaming") return;
    const timer = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(timer);
  }, [turnState]);

  // La notice dérivée rejoint le store : les consommateurs LENTS (page,
  // MessageList) s'y abonnent sans suivre les ticks de ce hook.
  useEffect(() => {
    streamStore.setStallNotice(derivedStallNotice);
  }, [derivedStallNotice]);

  /** Signe de vie (callback socket — système externe, setState autorisé). */
  const bumpActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  /** Masque l'erreur du dernier tour (le partiel éventuel reste dans le fil). */
  const dismissTurnError = useCallback(() => setTurnError(null), []);

  // ── Handlers stream:* / mode:flow — posés par l'orchestrateur ───────────
  // (Ils référencent setMessages / refreshConversations : créés ici, retournés,
  // l'orchestrateur les attache à la socket dans son grand useEffect.)

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

  // F-30 — déroulé vivant du tour multi-voix (débat, conseil, auto) :
  // chaque étape est poussée par le service, la réponse finale portera
  // le déroulé en persistance.
  const onModeFlow = (p: {
    conversationId: string;
    messageId: string;
    rows: ModeFlowRow[];
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

  return {
    // ── Écritures (stables — l'orchestrateur reste le seul écrivain) ──
    setStreamsRecord,
    setModeFlowLive,
    setTurnError,
    // ── Signaux LENTS (ne changent pas à chaque delta) ──
    /** Nombre de streams en vol (0/1/2) — booléen d'occupation pour la page. */
    streamsCount,
    /** Premier stream en vol (référence stable entre deltas de CE stream :
     *  mise à jour seulement aux transitions de tour — la page suit le
     *  début/fin, pas les 16 ms). */
    streaming,
    modeFlowLive,
    turnError,
    dismissTurnError,
    stallNotice,
    // ── Références et dérivés internes ──
    bumpActivity,
    lastActivityRef,
    runningVoiceRef,
    turnState,
    // ── Handlers socket (l'orchestrateur les attache) ──
    onStreamStart,
    onStreamDelta,
    onStreamReasoning,
    onStreamStatus,
    onStreamTool,
    onStreamDone,
    onStreamError,
    onModeFlow,
  };
}
