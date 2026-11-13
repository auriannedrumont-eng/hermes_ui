// Bulle de message : utilisateur (droite, éditable) ou assistant
// (markdown + outils + raisonnement), avec actions au survol.
"use client";

import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  GitBranch,
  Loader2,
  Package,
  Pencil,
  RefreshCw,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { HermesAvatar } from "@/components/chat/hermes-logo";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { AttachmentsList } from "@/components/chat/attachments";
import { ArtifactCard } from "@/components/chat/artifact-card";
import { stripArtifactBlocks, downloadArtifactZip } from "@/lib/artifact-utils";
import type { Artifact, ChatMessage, ToolEvent } from "@/lib/chat-types";

function ToolEventRow({ event }: { event: ToolEvent }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[12.5px]">
      <Wrench className="h-3.5 w-3.5 shrink-0 text-hermes" />
      <span className="font-mono">{event.name}</span>
      {event.detail ? (
        <span className="truncate text-muted-foreground">— {event.detail}</span>
      ) : null}
      {event.status === "running" ? (
        <Loader2 className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Check
          className={`ml-auto h-3.5 w-3.5 shrink-0 ${
            event.status === "error" ? "text-destructive" : "text-emerald-500"
          }`}
        />
      )}
    </div>
  );
}

function ReasoningBlock({
  reasoning,
  defaultOpen = false,
}: {
  reasoning: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!reasoning.trim()) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted"
          aria-expanded={open}
        >
          <Brain className="h-3.5 w-3.5 text-hermes" />
          Raisonnement
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-2 whitespace-pre-wrap border-l-2 border-hermes/50 pl-3 text-[13px] italic leading-relaxed text-muted-foreground">
          {reasoning}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Lecture vocale d'une réponse (synthèse vocale du navigateur). */
function useSpeech(content: string) {
  const [speaking, setSpeaking] = useState(false);
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const toggle = () => {
    if (!supported) return;
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    // Nettoyage léger du markdown pour la lecture
    const plain = content
      .replace(/```[\s\S]*?```/g, " bloc de code ")
      .replace(/[#*_`>|~\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const utterance = new SpeechSynthesisUtterance(plain.slice(0, 4000));
    utterance.lang = "fr-FR";
    utterance.rate = 1.02;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  return { supported, speaking, toggle };
}

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
  destructive?: boolean;
}

function ActionButton({
  label,
  onClick,
  icon,
  disabled,
  active,
  destructive,
}: ActionButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`h-7 gap-1.5 rounded-lg px-2 text-[12px] ${
        destructive
          ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          : active
            ? "text-hermes"
            : "text-muted-foreground"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  streamingContent?: string;
  streamingReasoning?: string;
  streamingStatus?: string | null;
  streamingTools?: ToolEvent[];
  /** Cartes d'artefacts ancrées sur ce message (état vivant). */
  artifactCards?: Artifact[];
  /** Contenu source en cours de stream, par clé. */
  artifactStreams?: Record<string, string>;
  /** Dernière réponse du fil : autorise « Régénérer ». */
  isLastAssistant?: boolean;
  isBusy?: boolean;
  onRegenerate?: () => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onRetryArtifact?: (artifactId: string) => void;
}

export function MessageBubble({
  message,
  isStreaming = false,
  streamingContent,
  streamingReasoning,
  streamingStatus,
  streamingTools,
  artifactCards,
  artifactStreams,
  isLastAssistant = false,
  isBusy = false,
  onRegenerate,
  onEdit,
  onDelete,
  onFork,
  onOpenArtifact,
  onRetryArtifact,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);
  const speech = useSpeech(isStreaming ? "" : message.content);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard indisponible */
    }
  };

  const startEdit = () => {
    setEditValue(message.content);
    setEditing(true);
    requestAnimationFrame(() => {
      const el = editRef.current;
      if (el) {
        el.focus();
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
      }
    });
  };

  const submitEdit = () => {
    const clean = editValue.trim();
    if (!clean || !onEdit) return;
    setEditing(false);
    onEdit(message.id, clean);
  };

  // ── Message utilisateur ──────────────────────────────────────────────
  if (message.role === "user") {
    const hasAttachments = (message.attachments?.length ?? 0) > 0;
    return (
      <div className="message-in flex flex-col items-end gap-1.5">
        {hasAttachments ? (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2 sm:max-w-[75%]">
            <AttachmentsList attachments={message.attachments!} />
          </div>
        ) : null}
        {editing ? (
          <div className="w-full max-w-[85%] rounded-2xl rounded-br-md border border-hermes/40 bg-card p-3 sm:max-w-[75%]">
            <textarea
              ref={editRef}
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value);
                const el = e.target as HTMLTextAreaElement;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              rows={2}
              aria-label="Modifier le message"
              className="w-full resize-none bg-transparent text-[14.5px] leading-relaxed focus:outline-none"
            />
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
                className="h-7 rounded-lg px-2.5 text-[12px] text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
                Annuler
              </Button>
              <Button
                size="sm"
                onClick={submitEdit}
                disabled={!editValue.trim() || isBusy}
                className="h-7 rounded-lg bg-hermes px-2.5 text-[12px] text-hermes-foreground hover:opacity-90"
              >
                <Check className="h-3.5 w-3.5" />
                Envoyer et relancer
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              La réponse sera régénérée depuis ce message.
            </p>
          </div>
        ) : message.content ? (
          <div className="max-w-[85%] rounded-3xl rounded-br-md bg-muted px-4 py-2.5 sm:max-w-[75%]">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
              {message.content}
            </p>
          </div>
        ) : null}
        {!editing ? (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
            <ActionButton
              label={copied ? "Copié" : "Copier"}
              onClick={copy}
              icon={
                copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />
              }
            />
            {onEdit ? (
              <ActionButton
                label="Modifier"
                onClick={startEdit}
                disabled={isBusy}
                icon={<Pencil className="h-3.5 w-3.5" />}
              />
            ) : null}
            {onFork ? (
              <ActionButton
                label="Branche"
                onClick={() => onFork(message.id)}
                icon={<GitBranch className="h-3.5 w-3.5" />}
              />
            ) : null}
            {onDelete ? (
              <ActionButton
                label="Supprimer"
                onClick={() => onDelete(message.id)}
                destructive
                icon={<Trash2 className="h-3.5 w-3.5" />}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  // ── Assistant ────────────────────────────────────────────────────────
  const rawContent = isStreaming ? (streamingContent ?? "") : message.content;
  // Les blocs devenus artefacts disparaissent du flux : la carte les remplace
  const content = stripArtifactBlocks(rawContent);
  const reasoning = isStreaming
    ? (streamingReasoning ?? "")
    : (message.reasoning ?? "");
  const tools = isStreaming ? (streamingTools ?? []) : (message.toolEvents ?? []);
  const cards = artifactCards ?? [];
  const waitingFirstToken =
    isStreaming && !content && !reasoning && tools.length === 0 && cards.length === 0;

  // Réponse devenue invisible (bloc artefact retiré du flux) et sans carte
  // ancrée ici : pas de bulle vide dans la conversation.
  if (!isStreaming && !content && !reasoning && tools.length === 0 && cards.length === 0) {
    return null;
  }

  return (
    <div className="message-in flex gap-3">
      <HermesAvatar />
      <div className="min-w-0 flex-1 space-y-2.5">
        {tools.length > 0 ? (
          <div className="space-y-1.5">
            {tools.map((ev, i) => (
              <ToolEventRow key={`${ev.name}-${i}`} event={ev} />
            ))}
          </div>
        ) : null}

        {reasoning ? (
          <ReasoningBlock reasoning={reasoning} defaultOpen={isStreaming} />
        ) : null}

        {waitingFirstToken ? (
          <div className="flex items-center gap-2 py-1 text-[14px] text-muted-foreground">
            <span className="flex gap-1" aria-hidden="true">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-hermes" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-hermes" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-hermes" />
            </span>
            <span className="sr-only">Hermes réfléchit</span>
            {streamingStatus ?? "Hermes réfléchit…"}
          </div>
        ) : content ? (
          isStreaming ? (
            <div className="text-[15px] leading-relaxed">
              <MarkdownContent content={content} />
              <span className="streaming-cursor" aria-hidden="true" />
            </div>
          ) : (
            <MarkdownContent content={content} />
          )
        ) : null}

        {isStreaming && streamingStatus && content ? (
          <p className="text-[12.5px] italic text-muted-foreground">
            {streamingStatus}
          </p>
        ) : null}

        {/* Réponse interrompue par l'utilisateur (bouton Stop) : le partiel
            reste dans le fil, clairement marqué — pas de faux « complet ». */}
        {!isStreaming && message.stopped ? (
          <p className="flex items-center gap-1.5 pt-0.5 text-[12px] text-muted-foreground">
            <Square className="h-2.5 w-2.5 shrink-0 fill-current" aria-hidden="true" />
            Réponse interrompue
            {isLastAssistant && onRegenerate ?
              " — « Régénérer » pour la compléter" : ""}
          </p>
        ) : null}

        {/* Cartes d'artefacts — compactes, jamais plein format dans le flux */}
        {cards.length > 0 && onOpenArtifact ? (
          <div className="flex flex-col gap-2 pt-1">
            {cards.map((a) => (
              <ArtifactCard
                key={a.key}
                artifact={a}
                streamingContent={artifactStreams?.[a.key]}
                onOpen={onOpenArtifact}
                onRetry={onRetryArtifact ?? (() => {})}
              />
            ))}
            {cards.length > 1 ? (
              <button
                type="button"
                onClick={() => downloadArtifactZip(cards)}
                className="flex w-fit items-center gap-1.5 rounded-lg px-1 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-hermes"
              >
                <Package className="h-3.5 w-3.5" />
                Tout télécharger ({cards.length} fichiers, .zip)
              </button>
            ) : null}
          </div>
        ) : null}

        {!isStreaming ? (
          <div className="flex items-center gap-0.5 pt-0.5 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100 group-hover/msg:opacity-100">
            <ActionButton
              label={copied ? "Copié" : "Copier"}
              onClick={copy}
              icon={
                copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />
              }
            />
            {isLastAssistant && onRegenerate ? (
              <ActionButton
                label="Régénérer"
                onClick={onRegenerate}
                disabled={isBusy}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
              />
            ) : null}
            {speech.supported ? (
              <ActionButton
                label={speech.speaking ? "Arrêter" : "Écouter"}
                onClick={speech.toggle}
                active={speech.speaking}
                icon={
                  speech.speaking ? (
                    <VolumeX className="h-3.5 w-3.5" />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" />
                  )
                }
              />
            ) : null}
            {onFork ? (
              <ActionButton
                label="Branche"
                onClick={() => onFork(message.id)}
                icon={<GitBranch className="h-3.5 w-3.5" />}
              />
            ) : null}
            {onDelete ? (
              <ActionButton
                label="Supprimer"
                onClick={() => onDelete(message.id)}
                destructive
                icon={<Trash2 className="h-3.5 w-3.5" />}
              />
            ) : null}
            {message.model ? (
              <span className="ml-1 font-mono text-[10.5px] text-muted-foreground/70">
                {message.model}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
