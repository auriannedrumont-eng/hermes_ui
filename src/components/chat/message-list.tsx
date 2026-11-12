// Liste des messages + état vide (accueil façon ChatGPT) + bouton retour en bas
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Code2, FileText, GitBranch, Lightbulb, Mail } from "lucide-react";
import { HermesLogo } from "@/components/chat/hermes-logo";
import { MessageBubble } from "@/components/chat/message-bubble";
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
  streaming: StreamingState | null;
  loadingHistory: boolean;
  isBusy: boolean;
  /** Toutes les versions d'artefacts de la conversation (état vivant). */
  artifacts: Artifact[];
  /** Contenu des artefacts en cours de génération, par clé. */
  artifactStreams: Record<string, string>;
  onSuggestion: (prompt: string) => void;
  onRegenerate: () => void;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onFork: (messageId: string) => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onRetryArtifact: (artifactId: string) => void;
}

export function MessageList({
  messages,
  streaming,
  loadingHistory,
  isBusy,
  artifacts,
  artifactStreams,
  onSuggestion,
  onRegenerate,
  onEdit,
  onDelete,
  onFork,
  onOpenArtifact,
  onRetryArtifact,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming?.content, streaming?.reasoning, streaming?.status]);

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

  const isEmpty = !loadingHistory && messages.length === 0 && !streaming;

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
            <h1 className="text-center text-[26px] font-semibold tracking-tight sm:text-[30px]">
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
                  <s.icon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-hermes" />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-medium">
                      {s.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
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
            {messages.map((m) => (
              <div key={m.id} className="group/msg">
                <MessageBubble
                  message={m}
                  isBusy={isBusy}
                  isLastAssistant={m.id === lastAssistantId && !streaming}
                  onRegenerate={onRegenerate}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onFork={onFork}
                  artifactCards={cardsForMessage(m.id, artifacts, m.artifacts)}
                  artifactStreams={artifactStreams}
                  onOpenArtifact={onOpenArtifact}
                  onRetryArtifact={onRetryArtifact}
                />
              </div>
            ))}
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
