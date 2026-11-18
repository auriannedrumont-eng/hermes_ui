// Bulle de message : utilisateur (droite, éditable) ou assistant
// (markdown + outils + raisonnement), avec actions au survol.
// Actions = icônes seules : le libellé vit dans title/aria-label — jamais
// affiché à côté de l'icône (rangée compacte, idiome unique du repo).
"use client";

import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import { ConfirmDestructiveDialog } from "@/components/shared/confirm-destructive-dialog";
import { HermesAvatar } from "@/components/chat/hermes-logo";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { AttachmentsList } from "@/components/chat/attachments";
import { ArtifactCard } from "@/components/chat/artifact-card";
import { ModeFlowCard, ModeTag, modeFromTag, modeFlowSummary } from "@/components/chat/mode-flow";
import { useSpeech, useContinuousSpeech } from "@/hooks/use-speech";
import { UsageRow } from "@/components/chat/usage-row";
import { stripArtifactBlocks, downloadArtifactZip } from "@/lib/artifact-utils";
import { onSettingsChanged, readClientSetting } from "@/lib/settings";
import type { Artifact, ChatMessage, ModeFlowRow, ToolEvent, WebSource } from "@/lib/chat-types";
import type { ConversationMode } from "@/lib/modes";

function ToolEventRow({ event }: { event: ToolEvent }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[12.5px]">
      <Wrench className="h-3.5 w-3.5 shrink-0 text-hermes-text" />
      <span className="font-mono">{event.name}</span>
      {event.detail ? (
        <span className="truncate text-muted-foreground">— {event.detail}</span>
      ) : null}
      {event.status === "running" ? (
        <Loader2 className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Check
          className={`ml-auto h-3.5 w-3.5 shrink-0 ${
            event.status === "error" ? "text-destructive" : "text-success"
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
          <Brain className="h-3.5 w-3.5 text-hermes-text" />
          Raisonnement
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-2 whitespace-pre-wrap border-l-2 border-hermes/50 pl-3 text-[12.5px] italic leading-relaxed text-muted-foreground">
          {reasoning}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Bouton d'action du fil — icône seule : le libellé vit dans title et
 *  aria-label (info-bulle au survol, nom pour les lecteurs d'écran), jamais
 *  affiché à côté de l'icône. */
interface ActionButtonProps {
  /** Libellé d'accessibilité (title + aria-label) — non affiché. */
  label: string;
  /* Optionnel : quand le bouton sert de déclencheur à ConfirmDestructiveDialog,
     l'action est portée par le dialogue, pas par le bouton. */
  onClick?: () => void;
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
      className={`h-7 w-7 justify-center rounded-lg p-0 ${
        destructive
          ? "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          : active
            ? "text-hermes-text"
            : "text-muted-foreground"
      }`}
    >
      {icon}
    </Button>
  );
}

// ── Sources citées (F-12) — rangée cliquable sous la réponse ───────────
function SourcesRow({ sources }: { sources: WebSource[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px]">
      <span className="text-muted-foreground">Sources :</span>
      {sources.map((s) => (
        <a
          key={s.n}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${s.title}\n${s.snippet}`}
          className="max-w-[280px] truncate rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-muted-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
        >
          [{s.n}] {s.title}
        </a>
      ))}
    </div>
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
  /** F-14 — navigation entre les versions d'une réponse (‹ n/m ›). */
  onSetVersion?: (message: ChatMessage, index: number) => void;
  /** F-30 — déroulé du tour multi-voix + étiquette du mode (persistés). */
  modeTag?: string;
  modeFlow?: ModeFlowRow[];
  /** F-30 — les modèles dans le déroulé (hermes.modes.showModels). */
  showFlowModels?: boolean;
  /** F-30 — afficher le déroulé des messages PERSISTÉS
   *  (hermes.modes.showFlow « Déroulé dans la conversation »). */
  showFlow?: boolean;
  /** F-30 — mode de la conversation : fallback de modeFromTag pendant le
   *  streaming du verdict (message.modeTag n'existe pas encore). */
  fallbackMode?: ConversationMode;
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
  onSetVersion,
  modeTag,
  modeFlow,
  showFlowModels = true,
  showFlow = true,
  fallbackMode,
}: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);
  const speech = useSpeech(isStreaming ? "" : message.content);
  // F-16 — lecture continue pendant le stream (bouton dans la bulle vivante)
  const continuous = useContinuousSpeech(
    isStreaming ? (streamingContent ?? "") : "",
    isStreaming
  );
  // Réglage « Afficher le raisonnement » (fork.ui.showReasoning) — suivi
  // en direct via le bus `hermes-ui:settings-changed`. Initialisation
  // paresseuse (lecture au 1er rendu), l'effet ne fait que s'abonner.
  const [showReasoning, setShowReasoning] = useState(
    () => readClientSetting<boolean>("fork.ui.showReasoning") !== false
  );
  useEffect(
    () =>
      onSettingsChanged(({ key, value }) => {
        if (key === "fork.ui.showReasoning") setShowReasoning(value !== false);
      }),
    []
  );

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
              className="w-full resize-none bg-transparent text-[14px] leading-relaxed focus:outline-none"
            />
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
                className="h-7 rounded-lg px-2.5 text-[12.5px] text-muted-foreground"
              >
                <X className="h-3.5 w-3.5" />
                Annuler
              </Button>
              <Button
                size="sm"
                onClick={submitEdit}
                disabled={!editValue.trim() || isBusy}
                className="h-7 rounded-lg bg-hermes-strong px-2.5 text-[12.5px] text-hermes-foreground hover:bg-hermes-strong/90"
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
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100 group-hover/msg:opacity-100 max-md:opacity-100">
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
              <ConfirmDestructiveDialog
                trigger={
                  <ActionButton
                    label="Supprimer"
                    destructive
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  />
                }
                title="Supprimer ce message ?"
                description="Il disparaîtra de cette conversation, ainsi que le journal de versions de ses fichiers."
                confirmLabel="Supprimer le message"
                onConfirm={() => onDelete(message.id)}
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
  const reasoning = showReasoning
    ? isStreaming
      ? (streamingReasoning ?? "")
      : (message.reasoning ?? "")
    : "";
  const tools = isStreaming ? (streamingTools ?? []) : (message.toolEvents ?? []);
  const cards = artifactCards ?? [];
  const waitingFirstToken =
    isStreaming && !content && !reasoning && tools.length === 0 && cards.length === 0;
  // F-30 — déroulé + étiquette du mode : l'encart vivant (props) prime, la
  // réponse persistée porte le sien (message.mode_flow) au rechargement.
  const flowTag = modeTag ?? message.modeTag;
  const flowRows = modeFlow ?? message.modeFlow;

  // Réponse devenue invisible (bloc artefact retiré du flux) et sans carte
  // ancrée ici : pas de bulle vide dans la conversation. Le déroulé du mode
  // (F-30) compte comme du contenu — la bulle le porte même sans texte.
  if (
    !isStreaming &&
    !content &&
    !reasoning &&
    tools.length === 0 &&
    cards.length === 0 &&
    !flowRows?.length
  ) {
    return null;
  }

  return (
    <div className="message-in flex gap-3">
      <HermesAvatar />
      <div className="min-w-0 flex-1 space-y-2.5">
        {/* F-30 — l'étiquette du mode et le déroulé vivent au-dessus de la
            réponse conservée : on voit le débat/conseil/auto se dérouler. */}
        {flowTag ? <ModeTag tag={flowTag} /> : null}
        {/* F-30 (showFlow) : le réglage « Déroulé dans la conversation »
            masque aussi le déroulé des messages PERSISTÉS, pas seulement le
            vivant. fallbackMode : badge correct pendant le streaming du
            verdict (modeTag absent). */}
        {showFlow && flowRows?.length ? (
          <ModeFlowCard
            mode={modeFromTag(flowTag, fallbackMode)}
            summary={modeFlowSummary(modeFromTag(flowTag, fallbackMode), flowRows)}
            rows={flowRows}
            showModels={showFlowModels}
          />
        ) : null}
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

        {/* F-16 — lecture continue pendant le stream : parle les phrases
            complètes au fil de l'eau. Coupé = silence immédiat. */}
        {isStreaming && content && continuous.supported ? (
          <button
            type="button"
            onClick={continuous.toggle}
            aria-pressed={continuous.speaking}
            className={
              "flex w-fit cursor-pointer items-center gap-1.5 rounded-lg px-1 py-0.5 text-[12.5px] transition-colors " +
              (continuous.speaking
                ? "text-hermes-text"
                : "text-muted-foreground hover:text-hermes-text")
            }
          >
            {continuous.speaking ? (
              <>
                <VolumeX className="h-3.5 w-3.5" aria-hidden />
                Couper la lecture
              </>
            ) : (
              <>
                <Volume2 className="h-3.5 w-3.5" aria-hidden />
                Lire en continu
              </>
            )}
          </button>
        ) : null}

        {/* Réponse interrompue par l'utilisateur (bouton Stop) : le partiel
            reste dans le fil, clairement marqué — pas de faux « complet ». */}
        {!isStreaming && message.stopped ? (
          <p className="flex items-center gap-1.5 pt-0.5 text-[12.5px] text-muted-foreground">
            <Square className="h-2.5 w-2.5 shrink-0 fill-current" aria-hidden="true" />
            Réponse interrompue
            {isLastAssistant && onRegenerate ?
              " — « Régénérer » pour la compléter" : ""}
          </p>
        ) : null}

        {/* F-12 — sources de la recherche web : cliquables, titre au survol */}
        {!isStreaming && message.sources?.length ? (
          <SourcesRow sources={message.sources} />
        ) : null}

        {/* F-21 — jetons & coût du message (repliable) : réels quand
            l'API les renvoie, estimation honnête sinon. */}
        {!isStreaming ? <UsageRow message={message} /> : null}

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
                className="flex w-fit items-center gap-1.5 rounded-lg px-1 py-0.5 text-[12.5px] text-muted-foreground transition-colors hover:text-hermes-text"
              >
                <Package className="h-3.5 w-3.5" />
                Tout télécharger ({cards.length} fichiers, .zip)
              </button>
            ) : null}
          </div>
        ) : null}

        {/* F-14 — navigation entre versions : ‹ index/count ›, visible
            en permanence (contrôle de lecture, pas une action au survol). */}
        {!isStreaming && message.versions && message.versions.count > 1 && onSetVersion ? (
          <div className="flex items-center gap-0.5 pt-0.5 text-[11px] text-muted-foreground">
            <button
              type="button"
              aria-label="Version précédente"
              title="Version précédente"
              disabled={message.versions.index <= 1 || isBusy}
              onClick={() => onSetVersion(message, message.versions!.index - 1)}
              className="flex h-5.5 w-5.5 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-9 text-center tabular-nums">
              {message.versions.index}/{message.versions.count}
            </span>
            <button
              type="button"
              aria-label="Version suivante"
              title="Version suivante"
              disabled={message.versions.index >= message.versions.count || isBusy}
              onClick={() => onSetVersion(message, message.versions!.index + 1)}
              className="flex h-5.5 w-5.5 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <span className="sr-only">
              {message.versions.count} versions — version {message.versions.index} affichée
            </span>
          </div>
        ) : null}

        {!isStreaming ? (
          <div className="flex items-center gap-0.5 pt-0.5 opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100 group-hover/msg:opacity-100 max-md:opacity-100">
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
              <ConfirmDestructiveDialog
                trigger={
                  <ActionButton
                    label="Supprimer"
                    destructive
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  />
                }
                title="Supprimer ce message ?"
                description="Il disparaîtra de cette conversation, ainsi que le journal de versions de ses fichiers."
                confirmLabel="Supprimer le message"
                onConfirm={() => onDelete(message.id)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
