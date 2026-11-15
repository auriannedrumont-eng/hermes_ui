// Liste des messages + état vide (accueil façon ChatGPT) + bouton retour en bas
// + rangée d'erreur persistante du dernier tour (F-04 : Réessayer / Masquer).
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Code2,
  FileText,
  GitBranch,
  Lightbulb,
  Mail,
  RefreshCw,
} from "lucide-react";
import { HermesLogo } from "@/components/chat/hermes-logo";
import { MessageBubble } from "@/components/chat/message-bubble";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Artifact, ChatMessage, StreamingState } from "@/lib/chat-types";

const SUGGESTIONS = [
  {
    icon: FileText,
    title: "Créer un rapport HTML",
    prompt:
      "Crée-moi une page HTML « rapport-ventes.html » : un rapport de ventes trimestriel soigné, avec cartes de KPI, tableau et graphique.",
  },
  {
    icon: Code2,
    title: "Écrire un script",
    prompt:
      "Écris un script Python qui surveille un dossier et archive les fichiers de plus de 30 jours dans une archive horodatée.",
  },
  {
    icon: Mail,
    title: "Rédiger un email",
    prompt:
      "Rédige un email professionnel et courtois pour reporter une réunion de vendredi à lundi prochain.",
  },
  {
    icon: Lightbulb,
    title: "Brainstormer un projet",
    prompt:
      "Aide-moi à brainstormer 5 idées d'applications pour un agent IA connecté à Telegram.",
  },
];

/** Cartes d'artefacts ancrées sur un message (dernière version par clé). */
function cardsForMessage(
  messageId: string,
  artifacts: Artifact[],
  fallback?: Artifact[]
): Artifact[] {
  const byKey = new Map<string, Artifact>();
  for (const a of artifacts) {
    if (a.anchorMessageId !== messageId) continue;
    const cur = byKey.get(a.key);
    if (
      !cur ||
      a.version > cur.version ||
      (a.version === cur.version && a.createdAt > cur.createdAt)
    ) {
      byKey.set(a.key, a);
    }
  }
  if (byKey.size > 0) return [...byKey.values()];
  return fallback ?? [];
}

interface MessageListProps {
  messages: ChatMessage[];
  /** F-17 : tous les streams actifs (tour simple + variantes a/b). */
  streams: StreamingState[];
  loadingHistory: boolean;
  isBusy: boolean;
  /** Erreur persistante du dernier tour (F-04) — affichée sous le fil. */
  turnError: { messageId: string; error: string } | null;
  /** Toutes les versions d'artefacts de la conversation (état vivant). */
  artifacts: Artifact[];
  /** Contenu des artefacts en cours de génération, par clé. */
  artifactStreams: Record<string, string>;
  onSuggestion: (prompt: string) => void;
  onRegenerate: () => void;
  /** F-17 : régénérer UN côté de la dernière comparaison. */
  onRegenerateVariant: (variant: "a" | "b") => void;
  /** F-14 — basculer la version affichée d'une réponse multi-versions. */
  onSetVersion: (message: ChatMessage, index: number) => void;
  onRetryError: () => void;
  onDismissError: () => void;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onFork: (messageId: string) => void;
  /** Feedback 👍/👎 + commentaire (F-24) — réponses assistant. */
  onSetFeedback: (messageId: string, rating: "up" | "down" | null, comment?: string | null) => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onRetryArtifact: (artifactId: string) => void;
}

/** Une colonne de comparaison : réponse persistée et/ou stream en cours. */
interface CompareCell {
  message?: ChatMessage;
  stream?: StreamingState;
}

type Row =
  | { kind: "single"; message: ChatMessage }
  | { kind: "pair"; a?: CompareCell; b?: CompareCell };

/** Regroupe le fil en lignes : les réponses assistant portant une variante
 *  (F-17) forment une paire côte à côte ; tout le reste reste en Pleine largeur. */
function buildRows(messages: ChatMessage[], streams: StreamingState[]): Row[] {
  const rows: Row[] = [];
  let openPair: Extract<Row, { kind: "pair" }> | null = null;
  const closePair = () => {
    openPair = null;
  };
  for (const m of messages) {
    if (m.role === "assistant" && m.variant) {
      if (!openPair) {
        openPair = { kind: "pair" };
        rows.push(openPair);
      }
      const cell: CompareCell = { message: m };
      if (m.variant === "a" && !openPair.a) openPair.a = cell;
      else if (m.variant === "b" && !openPair.b) openPair.b = cell;
      else {
        // Deux réponses de la même variante d'affilée (régén. d'un côté
        // après rechargement) : nouvelle paire.
        openPair = { kind: "pair", ...(m.variant === "a" ? { a: cell } : { b: cell }) };
        rows.push(openPair);
      }
    } else {
      closePair();
      rows.push({ kind: "single", message: m });
    }
  }
  // Les streams de comparaison rejoignent la dernière paire (ou en ouvrent une).
  for (const st of streams) {
    if (!st.variant) continue;
    let pair = rows[rows.length - 1];
    if (!pair || pair.kind !== "pair") {
      pair = { kind: "pair" };
      rows.push(pair);
    }
    const cell: CompareCell = { stream: st };
    if (st.variant === "a" && !pair.a) pair.a = cell;
    else if (st.variant === "b" && !pair.b) pair.b = cell;
    else {
      rows.push({ kind: "pair", ...(st.variant === "a" ? { a: cell } : { b: cell }) });
    }
  }
  return rows;
}

export function MessageList({
  messages,
  streams,
  loadingHistory,
  isBusy,
  turnError,
  artifacts,
  artifactStreams,
  onSuggestion,
  onRegenerate,
  onRegenerateVariant,
  onSetVersion,
  onRetryError,
  onDismissError,
  onEdit,
  onDelete,
  onFork,
  onSetFeedback,
  onOpenArtifact,
  onRetryArtifact,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  /** Tour simple (sans variante) — la bulle de stream en bas de fil. */
  const streaming = streams.find((st) => !st.variant) ?? null;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streams]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    pinnedRef.current = nearBottom;
    setShowJump(!nearBottom && el.scrollHeight > el.clientHeight + 200);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Identifiant de la dernière réponse assistant (pour « Régénérer »)
  let lastAssistantId: string | null = null;
  for (const m of messages) {
    if (m.role === "assistant") lastAssistantId = m.id;
  }

  const isEmpty = !loadingHistory && messages.length === 0 && streams.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-label="Fil de conversation"
      >
        {isEmpty ? (
          <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-4 py-10">
            <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-hermes text-hermes-foreground">
              <HermesLogo className="h-9 w-9" />
            </span>
            <h1 className="text-center text-[19px] font-semibold tracking-tight sm:text-[19px]">
              Bonjour.
            </h1>
            <p className="mt-1.5 text-center text-[15px] text-muted-foreground">
              Comment puis-je vous aider aujourd&apos;hui ?
            </p>
            <div className="mt-8 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.title}
                  onClick={() => onSuggestion(s.prompt)}
                  className="group flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-hermes/50 hover:shadow-sm"
                >
                  <s.icon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-hermes-text" />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">
                      {s.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                      {s.prompt}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
            {loadingHistory ? (
              <div className="space-y-6" aria-label="Chargement de la conversation">
                <Skeleton className="ml-auto h-10 w-2/5 rounded-3xl" />
                <div className="flex gap-3">
                  <Skeleton className="h-7 w-7 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-4/5" />
                  </div>
                </div>
              </div>
            ) : null}
            {buildRows(messages, streams).map((row, i) =>
              row.kind === "single" ? (
                <div key={row.message.id} className="group/msg">
                  <MessageBubble
                    message={row.message}
                    isBusy={isBusy}
                    isLastAssistant={row.message.id === lastAssistantId && streams.length === 0}
                    onRegenerate={onRegenerate}
                    onSetVersion={onSetVersion}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onFork={onFork}
                    onSetFeedback={onSetFeedback}
                    artifactCards={cardsForMessage(row.message.id, artifacts, row.message.artifacts)}
                    artifactStreams={artifactStreams}
                    onOpenArtifact={onOpenArtifact}
                    onRetryArtifact={onRetryArtifact}
                  />
                </div>
              ) : (
                <ComparePair
                  key={`compare-${i}`}
                  pair={row}
                  isBusy={isBusy}
                  onRegenerateVariant={onRegenerateVariant}
                  onSetVersion={onSetVersion}
                  artifacts={artifacts}
                  artifactStreams={artifactStreams}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onFork={onFork}
                  onSetFeedback={onSetFeedback}
                  onOpenArtifact={onOpenArtifact}
                  onRetryArtifact={onRetryArtifact}
                />
              )
            )}
            {streaming ? (
              <div className="group/msg">
                <MessageBubble
                  message={{
                    id: streaming.messageId,
                    conversationId: streaming.conversationId,
                    role: "assistant",
                    content: streaming.content,
                    createdAt: new Date().toISOString(),
                  }}
                  isStreaming
                  streamingContent={streaming.content}
                  streamingReasoning={streaming.reasoning}
                  streamingStatus={streaming.status}
                  streamingTools={streaming.toolEvents}
                  artifactCards={cardsForMessage(streaming.messageId, artifacts)}
                  artifactStreams={artifactStreams}
                  onOpenArtifact={onOpenArtifact}
                  onRetryArtifact={onRetryArtifact}
                />
              </div>
            ) : null}

            {/* Erreur persistante du dernier tour (F-04) : le partiel éventuel
                est déjà dans le fil au-dessus — ici, la cause et la sortie. */}
            {streams.length === 0 && turnError ? (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-destructive">
                    La génération a échoué
                  </p>
                  <p className="mt-0.5 break-words text-[12.5px] text-muted-foreground">
                    {turnError.error}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onRetryError}
                      disabled={isBusy}
                      className="h-7 rounded-lg px-2.5 text-[12.5px]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Réessayer
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={onDismissError}
                      className="h-7 rounded-lg px-2.5 text-[12.5px] text-muted-foreground"
                    >
                      Masquer
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="h-2" />
          </div>
        )}
      </div>

      {/* Bouton retour en bas */}
      {showJump ? (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="Revenir au dernier message"
          className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:text-foreground"
        >
          <ArrowDown className="h-4.5 w-4.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Paire de comparaison (F-17) : deux réponses côte à côte (desktop),
 *  empilées sous 768 px. Chaque côté garde ses actions et son modèle. */
function ComparePair({
  pair,
  isBusy,
  onRegenerateVariant,
  onSetVersion,
  artifacts,
  artifactStreams,
  onEdit,
  onDelete,
  onFork,
  onSetFeedback,
  onOpenArtifact,
  onRetryArtifact,
}: {
  pair: Extract<Row, { kind: "pair" }>;
  isBusy: boolean;
  onRegenerateVariant: (variant: "a" | "b") => void;
  onSetVersion: (message: ChatMessage, index: number) => void;
  artifacts: Artifact[];
  artifactStreams: Record<string, string>;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onFork: (messageId: string) => void;
  onSetFeedback: (messageId: string, rating: "up" | "down" | null, comment?: string | null) => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onRetryArtifact: (artifactId: string) => void;
}) {
  const slots: Array<{ variant: "a" | "b"; cell?: CompareCell }> = [
    { variant: "a", cell: pair.a },
    { variant: "b", cell: pair.b },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Réponses comparées">
      {slots.map(({ variant, cell }) => (
        <div
          key={variant}
          className="group/msg flex min-w-0 flex-col rounded-2xl border border-border/70 bg-card/40 p-2.5"
        >
          <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
            <span
              className={
                variant === "a"
                  ? "flex h-5 min-w-5 items-center justify-center rounded-md bg-hermes/15 px-1 text-[11px] font-bold text-hermes-text"
                  : "flex h-5 min-w-5 items-center justify-center rounded-md bg-primary/15 px-1 text-[11px] font-bold text-primary"
              }
              aria-label={`Modèle ${variant.toUpperCase()}`}
            >
              {variant.toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {cell?.message?.model ?? cell?.stream?.status ?? "Réponse…"}
            </span>
            <button
              type="button"
              title={`Régénérer la réponse ${variant.toUpperCase()}`}
              aria-label={`Régénérer la réponse ${variant.toUpperCase()}`}
              disabled={isBusy}
              onClick={() => onRegenerateVariant(variant)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          {cell?.message ? (
            <MessageBubble
              message={cell.message}
              isBusy={isBusy}
              isLastAssistant={false}
              onRegenerate={() => onRegenerateVariant(variant)}
              onSetVersion={onSetVersion}
              onEdit={onEdit}
              onDelete={onDelete}
              onFork={onFork}
              onSetFeedback={onSetFeedback}
              artifactCards={cardsForMessage(cell.message.id, artifacts, cell.message.artifacts)}
              artifactStreams={artifactStreams}
              onOpenArtifact={onOpenArtifact}
              onRetryArtifact={onRetryArtifact}
            />
          ) : cell?.stream ? (
            <MessageBubble
              message={{
                id: cell.stream.messageId,
                conversationId: cell.stream.conversationId,
                role: "assistant",
                content: cell.stream.content,
                createdAt: new Date().toISOString(),
                variant,
              }}
              onSetVersion={undefined}
              isStreaming
              streamingContent={cell.stream.content}
              streamingReasoning={cell.stream.reasoning}
              streamingStatus={cell.stream.status}
              streamingTools={cell.stream.toolEvents}
              artifactCards={cardsForMessage(cell.stream.messageId, artifacts)}
              artifactStreams={artifactStreams}
              onOpenArtifact={onOpenArtifact}
              onRetryArtifact={onRetryArtifact}
            />
          ) : (
            <div className="flex min-h-16 items-center justify-center rounded-xl border border-dashed border-border text-[12.5px] text-muted-foreground">
              Réponse en attente
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
