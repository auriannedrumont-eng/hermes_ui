// Store de stream — découpage 2026-11 (FORK.md §60, bonus performance).
// Pendant un tour, les deltas arrivent toutes les ~16 ms : chaque setState
// re-rendait TOUTE la page (sidebar, composer, header) parce que l'état de
// stream vivait au sommet. Ce store externalise exactement cet état :
//  - l'orchestrateur reste le SEUL écrivain (handlers socket, vidage au
//    changement de conversation) via les setters du store ;
//  - MessageList s'abonne au TRONC commun (streams, modeFlowLive…) mais la
//    PAGE ne s'abonne qu'aux signaux LENTS (streaming ≠ null, turnError,
//    stallNotice) — le contenu à 16 ms ne traverse plus page.tsx.
// useSyncExternalStore est le mécanisme officiel React 18 : abonnement par
// fragment, sans Provider ni re-render de réconciliation au sommet.
"use client";

import { useSyncExternalStore } from "react";
import type { ModeFlowRow, StreamingState, ToolEvent } from "@/lib/chat-types";

// ── L'état du store (une seule source de vérité, hors React) ───────────

export interface StreamSnapshot {
  /** Registre des streams en vol (F-17 : variantes a/b en parallèle). */
  streamsRecord: Record<string, StreamingState>;
  /** Déroulé multi-voix vivant (F-30). */
  modeFlowLive: { messageId: string; rows: ModeFlowRow[] } | null;
  /** Erreur persistante du dernier tour (F-04). */
  turnError: { messageId: string; error: string } | null;
  /** Notice de silence (F-31) — dérivée au rendu par la vigie du hook. */
  stallNotice: string | null;
}

const EMPTY: StreamSnapshot = {
  streamsRecord: {},
  modeFlowLive: null,
  turnError: null,
  stallNotice: null,
};

let snapshot: StreamSnapshot = EMPTY;
const listeners = new Set<() => void>();

// Cache de référence du hook useStreamTurnTools (F-29) : getSnapshot doit
// retourner une référence STABLE tant que toolEvents ne change pas, sinon
// re-render en boucle du consommateur.
const turnToolsCache = new Map<
  string,
  { ref: ToolEvent[]; result: { events: ToolEvent[]; live: boolean } }
>();

function emit() {
  for (const l of Array.from(listeners)) l();
}

function setSnapshot(patch: Partial<StreamSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  emit();
}

// ── API d'écriture (réservée à l'orchestrateur use-hermes-chat) ─────────

// Perf 2026-11-19 — coalescence des deltas : les deltas socket arrivent à
// ~16 ms ; émettre un snapshot par delta re-rendait MessageList ~60 fois/s
// (re-parse Markdown du texte en croissance = coût quadratique). Les
// écritures d'accumulation sont fusionnées : au plus un émis par fenêtre de
// 200 ms, le dernier état partant toujours (flush au repos et à la clôture
// du tour par stream:done/error — les writers y passent flush=true).
const COALESCE_MS = 200;
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRecord: Record<string, StreamingState> | null = null;

function flushRecord(): void {
  if (coalesceTimer) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
  if (pendingRecord !== null && pendingRecord !== snapshot.streamsRecord) {
    const next = pendingRecord;
    pendingRecord = null;
    setSnapshot({ streamsRecord: next });
    return;
  }
  pendingRecord = null;
}

export const streamStore = {
  /** Remplace/accumule le registre (setStreamsRecord de l'orchestrateur).
   *  `flush: true` (transitions de tour : start/done/error/stop, vidage au
   *  changement de conversation) publie immédiatement — le comportement
   *  critique (appartition/disparition d'une bulle) reste instantané. */
  setStreamsRecord(
    next:
      | Record<string, StreamingState>
      | ((prev: Record<string, StreamingState>) => Record<string, StreamingState>),
    options?: { flush?: boolean }
  ) {
    const base = pendingRecord ?? snapshot.streamsRecord;
    const value = typeof next === "function" ? next(base) : next;
    if (value === base) return;
    if (options?.flush) {
      pendingRecord = value;
      flushRecord();
      return;
    }
    pendingRecord = value;
    if (coalesceTimer === null) {
      coalesceTimer = setTimeout(flushRecord, COALESCE_MS);
    }
  },
  setModeFlowLive(
    next:
      | { messageId: string; rows: ModeFlowRow[] }
      | null
      | ((
          prev: { messageId: string; rows: ModeFlowRow[] } | null
        ) => { messageId: string; rows: ModeFlowRow[] } | null)
  ) {
    const value = typeof next === "function" ? next(snapshot.modeFlowLive) : next;
    if (value !== snapshot.modeFlowLive) setSnapshot({ modeFlowLive: value });
  },
  setTurnError(next: { messageId: string; error: string } | null) {
    if (next !== snapshot.turnError) setSnapshot({ turnError: next });
  },
  setStallNotice(next: string | null) {
    if (next !== snapshot.stallNotice) setSnapshot({ stallNotice: next });
  },
  /** Vidage complet (changement de conversation, déconnexion persistante). */
  reset() {
    turnToolsCache.clear();
    flushRecord(); // perf : rien de pendsu ne doit fuiter dans le prochain tour
    if (snapshot !== EMPTY) {
      snapshot = EMPTY;
      emit();
    }
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Lecture directe (refs de l'orchestrateur — sans abonnement). */
  get(): StreamSnapshot {
    return snapshot;
  },
};

// ── Fragments d'abonnement (useSyncExternalStore — re-render ciblé) ────

function equalStreamRecord(
  a: Record<string, StreamingState>,
  b: Record<string, StreamingState>
) {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** Registre COMPLET des streams — consommé par MessageList (la bulle en vol).
 *  Comparaison par entrée : un delta ne re-rend que si l'entrée changée
 *  est celle que ce consommateur affiche (les autres sautent). */
export function useStreamsRecord(): Record<string, StreamingState> {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => snapshot.streamsRecord,
    () => EMPTY.streamsRecord
  );
}

/** Le tronc : est-ce qu'un tour court ? (page.tsx : signaux LENTS seulement). */
export function useIsStreaming(): boolean {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => Object.keys(snapshot.streamsRecord).length > 0,
    () => false
  );
}

/** Erreur persistante du tour (affichée dans le fil — lente par nature). */
export function useTurnError() {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => snapshot.turnError,
    () => EMPTY.turnError
  );
}

/** Notice de silence (F-31) — tick de 10 s, lente par nature. */
export function useStallNotice() {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => snapshot.stallNotice,
    () => EMPTY.stallNotice
  );
}

/** Déroulé multi-voix vivant (F-30) — consommé par MessageList. */
export function useModeFlowLive() {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => snapshot.modeFlowLive,
    () => EMPTY.modeFlowLive
  );
}

/** Outils du tour d'un message donné (F-29, régression §60) — consommé par
 *  ArtifactPanel : le terminal des outils suit chaque stream:tool SANS
 *  re-rendre page.tsx (resolveTurnTools y lisait le store SANS abonnement :
 *  le terminal restait figé pendant le tour). */
export function useStreamTurnTools(
  messageId?: string
): { events: ToolEvent[]; live: boolean } | null {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => {
      if (!messageId) return null;
      const s = snapshot.streamsRecord[messageId];
      if (!s) {
        turnToolsCache.delete(messageId);
        return null;
      }
      const cached = turnToolsCache.get(messageId);
      if (cached && cached.ref === s.toolEvents) return cached.result;
      const result = { events: s.toolEvents, live: true };
      turnToolsCache.set(messageId, { ref: s.toolEvents, result });
      return result;
    },
    () => null
  );
}

// ── Fragments LENTS : la page suit les transitions de tour, pas les deltas ──

/** Nombre de streams en vol (0/1/2) — ne change qu'au début/fin d'un tour. */
export function useStreamsCount(): number {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => Object.keys(snapshot.streamsRecord).length,
    () => 0
  );
}

/** Identité du premier stream en vol (figée pendant le tour) — la page
 *  affiche « Hermes répond… » sans suivre le contenu à 16 ms.
 *  Cache module : getSnapshot doit retourner une référence STABLE tant que
 *  l'identité ne change pas (sinon re-render en boucle). */
let firstStreamIdCache: {
  messageId: string;
  conversationId: string;
  variant?: "a" | "b";
} | null = null;
let firstStreamIdKey: string | null = null;

export function useFirstStreamId(): {
  messageId: string;
  conversationId: string;
  variant?: "a" | "b";
} | null {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => {
      const first = Object.values(snapshot.streamsRecord)[0];
      const key = first
        ? `${first.messageId}|${first.conversationId}|${first.variant ?? ""}`
        : null;
      if (key === firstStreamIdKey) return firstStreamIdCache;
      firstStreamIdKey = key;
      firstStreamIdCache = first
        ? first.variant === undefined
          ? { messageId: first.messageId, conversationId: first.conversationId }
          : {
              messageId: first.messageId,
              conversationId: first.conversationId,
              variant: first.variant,
            }
        : null;
      return firstStreamIdCache;
    },
    () => null
  );
}
