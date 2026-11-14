// Barre de saisie façon ChatGPT : textarea auto-redimensionnable,
// envoi/stop, pièces jointes (trombone, glisser-déposer, coller),
// sélecteur de modèle, dictée vocale, commandes slash et brouillons.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Columns2,
  CornerDownLeft,
  Globe,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  ShieldCheck,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PendingAttachmentChip } from "@/components/chat/attachments";
import { ContextGauge } from "@/components/chat/context-gauge";
import { ModelPicker } from "@/components/chat/model-picker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDictation } from "@/hooks/use-dictation";
import { filterPromptLibrary, type PromptTemplate } from "@/lib/prompt-library";
import { onSettingsChanged, readClientSetting } from "@/lib/settings";
import {
  attachmentsSub,
  buildUsage,
  estimateAttachmentTokens,
  estimateTokens,
  type ContextRow,
} from "@/lib/tokens";
import type {
  Attachment,
  ExpertSettings,
  GatewayMode,
  ModelOption,
  PermissionsMode,
} from "@/lib/chat-types";

const MAX_ATTACHMENTS = 6;
const MAX_BYTES = 15 * 1024 * 1024; // aligné sur le service

interface PendingAttachment {
  localId: string;
  file: File;
  kind: Attachment["kind"];
  previewUrl?: string; // objet URL local (aperçu instantané)
  uploading: boolean;
  error?: string;
  uploaded?: Attachment; // pièce jointe enregistrée côté service
}

function detectKind(file: File): Attachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  if (file.type === "application/pdf") return "pdf";
  return "file";
}

interface ComposerProps {
  disabled: boolean;
  isBusy: boolean;
  /** Clé du brouillon (id de conversation ou "new"). */
  draftKey: string;
  models: ModelOption[];
  modelsSource: "gateway" | "catalogue" | "providers" | null;
  /** F-17 — comparaison de modèles : état, paire choisie et actions. */
  compareEnabled: boolean;
  compareModels: { a: string | null; b: string | null };
  onToggleCompare: () => void;
  onSetCompareSlot: (slot: "a" | "b", id: string) => void;
  mode: GatewayMode | null;
  /** F-09/F-12 — recherche web du tour (Tavily/Exa). */
  webSearch: boolean;
  onToggleWebSearch: () => void;
  /** Une clé Tavily/Exa active existe côté service. */
  webSearchAvailable: boolean;
  selectedModel: string | null;
  onSelectModel: (id: string) => void;
  /** Effort de raisonnement courant (valeur brute du fournisseur). */
  effort: string | null;
  onEffortChange: (effort: string) => void;
  /** Réglages expert (F-22) — absents = valeurs par défaut du fournisseur. */
  expert?: ExpertSettings;
  onExpertChange?: (patch: Partial<ExpertSettings>) => void;
  /** Mode d'autorisations (ask | auto) — reset sur « ask » à chaque session. */
  permissionsMode: PermissionsMode;
  onPermissionsChange: (mode: PermissionsMode) => void;
  /** Base du contexte du tour (système + historique + fenêtre) — le brouillon
   *  et les pièces jointes en attente sont ajoutés ici, en direct. */
  contextBase: {
    rows: ContextRow[];
    historyCount: number;
    historyCompacted: boolean;
    windowTokens: number;
    windowEstimated: boolean;
  } | null;
  /** Compaction possible (conversation ouverte, ≥ 2 messages, tour au repos). */
  canCompact: boolean;
  /** Compaction en cours (synthèse LLM). */
  compactRunning: boolean;
  onCompact: () => void;
  onNewSession: () => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onUploadFile: (file: File) => Promise<Attachment | null>;
  onTranscribe: (dataBase64: string, mime?: string) => Promise<string>;
}

function draftStorageKey(draftKey: string): string {
  return `hermes.draft.${draftKey}`;
}

export function Composer({
  disabled,
  isBusy,
  draftKey,
  models,
  modelsSource,
  compareEnabled,
  compareModels,
  onToggleCompare,
  onSetCompareSlot,
  webSearch,
  onToggleWebSearch,
  webSearchAvailable,
  mode,
  selectedModel,
  onSelectModel,
  effort,
  onEffortChange,
  expert,
  onExpertChange,
  permissionsMode,
  onPermissionsChange,
  contextBase,
  canCompact,
  compactRunning,
  onCompact,
  onNewSession,
  onSend,
  onStop,
  onUploadFile,
  onTranscribe,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [permDialogOpen, setPermDialogOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  // Visibilité de la jauge : réglage fork.context.gauge (registre, défaut : affichée)
  const [gaugeVisible, setGaugeVisible] = useState(true);
  useEffect(() => {
    setGaugeVisible(readClientSetting<boolean>("fork.context.gauge") !== false);
    // Application immédiate depuis le sheet Paramètres (FORK.md §7.4)
    return onSettingsChanged(({ key, value }) => {
      if (key === "fork.context.gauge") setGaugeVisible(value !== false);
    });
  }, []);

  // ── Brouillons persistants (localStorage, par conversation) ──────────
  useEffect(() => {
    try {
      setValue(window.localStorage.getItem(draftStorageKey(draftKey)) ?? "");
    } catch {
      setValue("");
    }
    if (textareaRef.current) textareaRef.current.focus();
  }, [draftKey]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (value.trim()) {
          window.localStorage.setItem(draftStorageKey(draftKey), value);
        } else {
          window.localStorage.removeItem(draftStorageKey(draftKey));
        }
      } catch {
        /* stockage indisponible */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [value, draftKey]);

  // ── Auto-redimensionnement ───────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // ── Dictée vocale ────────────────────────────────────────────────────
  const insertText = useCallback((text: string) => {
    setValue((prev) => {
      const needsSpace = prev.length > 0 && !/\s$/.test(prev);
      return prev + (needsSpace ? " " : "") + text;
    });
    textareaRef.current?.focus();
  }, []);

  const dictation = useDictation({
    onTranscript: insertText,
    transcribe: (b64) => onTranscribe(b64, "audio/webm"),
  });

  // ── Commandes slash ──────────────────────────────────────────────────
  const slashToken = /^\/(\S*)$/.exec(value.trim())?.[0] ?? null;
  const slashMatches: PromptTemplate[] = useMemo(
    () => (slashToken ? filterPromptLibrary(slashToken) : []),
    [slashToken]
  );
  const showSlash = slashMatches.length > 0;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashToken]);

  const applyPrompt = useCallback((tpl: PromptTemplate) => {
    setValue(tpl.prompt);
    textareaRef.current?.focus();
    // Place le curseur à la fin
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
  }, []);

  // ── Pièces jointes ───────────────────────────────────────────────────
  const uploadOne = useCallback(
    async (localId: string, file: File) => {
      try {
        const uploaded = await onUploadFile(file);
        if (!uploaded) throw new Error("Pièce jointe refusée par le service");
        setPending((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? { ...p, uploading: false, uploaded, error: undefined }
              : p
          )
        );
      } catch (err) {
        setPending((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? {
                  ...p,
                  uploading: false,
                  uploaded: undefined,
                  error: err instanceof Error ? err.message : "Échec de l'envoi",
                }
              : p
          )
        );
      }
    },
    [onUploadFile]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      const localId = () =>
        `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      type NewEntry = PendingAttachment & { shouldUpload: boolean };
      const entries: NewEntry[] = [];
      for (const file of list) {
        if (entries.length >= MAX_ATTACHMENTS) break;
        if (file.type === "image/svg+xml") {
          entries.push({
            localId: localId(),
            file,
            kind: "file",
            uploading: false,
            error: "SVG non accepté (sécurité)",
            shouldUpload: false,
          });
          continue;
        }
        if (file.size > MAX_BYTES) {
          entries.push({
            localId: localId(),
            file,
            kind: detectKind(file),
            uploading: false,
            error: "Fichier trop volumineux (max 15 Mo)",
            shouldUpload: false,
          });
          continue;
        }
        const kind = detectKind(file);
        entries.push({
          localId: localId(),
          file,
          kind,
          previewUrl:
            kind === "image" && typeof URL !== "undefined"
              ? URL.createObjectURL(file)
              : undefined,
          uploading: true,
          shouldUpload: true,
        });
      }
      setPending((prev) => [...prev, ...entries.map(({ shouldUpload: _s, ...rest }) => rest)]);
      // Lance l'upload de chaque nouveau fichier valide
      for (const entry of entries) {
        if (entry.shouldUpload) uploadOne(entry.localId, entry.file);
      }
    },
    [uploadOne]
  );

  const removePending = (localId: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  };

  const ready = pending.filter((p) => p.uploaded);
  const uploading = pending.some((p) => p.uploading);
  const hasBlocking = pending.some((p) => !p.uploaded && !p.error);
  const canSend =
    !disabled && !isBusy && !uploading && !hasBlocking && (value.trim().length > 0 || ready.length > 0);

  // ── Jauge de contexte : base du fil + brouillon en direct ─────────────
  // Le brouillon se compte pendant la frappe : la jauge grossit avant
  // même l'envoi. Les pièces jointes prêtes partent aussi dans le tour.
  const contextUsage = useMemo(() => {
    if (!contextBase) return null;
    const rows = [...contextBase.rows];
    const readyAtts = ready.map((p) => p.uploaded!);
    if (readyAtts.length > 0) {
      rows.push({
        key: "attachments",
        label: "Pièces jointes",
        sub: attachmentsSub(readyAtts),
        tokens: readyAtts.reduce((acc, a) => acc + estimateAttachmentTokens(a), 0),
      });
    }
    const draftTokens = estimateTokens(value);
    if (draftTokens > 0) {
      rows.push({
        key: "draft",
        label: "Brouillon",
        sub: "comptage en direct",
        tokens: draftTokens,
      });
    }
    return buildUsage(rows, contextBase.windowTokens, contextBase.windowEstimated);
  }, [contextBase, ready, value]);

  const submit = () => {
    if (!canSend) return;
    onSend(value, ready.map((p) => p.uploaded!));
    setValue("");
    try {
      window.localStorage.removeItem(draftStorageKey(draftKey));
    } catch {
      /* stockage indisponible */
    }
    setPending((prev) => {
      prev.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      });
      return [];
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepthRef.current += 1;
          if (e.dataTransfer?.types?.includes("Files")) setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer?.types?.includes("Files")) setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepthRef.current = 0;
          setDragOver(false);
          if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
        }}
        className={`relative rounded-[26px] border bg-card shadow-sm transition-all focus-within:shadow-md ${
          dragOver
            ? "border-hermes ring-2 ring-hermes/30"
            : "border-border"
        }`}
      >
        {/* Indicateur de dépôt */}
        {dragOver ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[26px] bg-hermes/5">
            <p className="rounded-full bg-background/90 px-3.5 py-1.5 text-[13px] font-medium text-hermes shadow-sm">
              Déposez vos fichiers pour les joindre
            </p>
          </div>
        ) : null}

        {/* Suggestions de commandes slash */}
        {showSlash ? (
          <div className="absolute bottom-full left-3 z-20 mb-2 w-[min(92%,26rem)] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <p className="border-b border-border/70 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Commandes · Entrée pour insérer, Échap pour ignorer
            </p>
            <ul className="max-h-60 overflow-y-auto p-1">
              {slashMatches.map((tpl, i) => (
                <li key={tpl.slash}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyPrompt(tpl)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      i === slashIndex ? "bg-muted/70" : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="shrink-0 rounded-md bg-hermes/10 px-1.5 py-0.5 font-mono text-[12px] font-medium text-hermes">
                      /{tpl.slash}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{tpl.title}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {tpl.description}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Puces des pièces jointes en attente */}
        {pending.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3.5 pt-3 sm:px-4">
            {pending.map((p) => (
              <PendingAttachmentChip
                key={p.localId}
                name={p.file.name}
                size={p.file.size}
                kind={p.kind}
                previewUrl={p.previewUrl}
                uploading={p.uploading}
                error={p.error}
                onRemove={() => removePending(p.localId)}
              />
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-1.5 px-3 py-2.5 sm:px-4">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/gif,image/webp,image/bmp,image/avif,audio/*,video/*,application/pdf,text/plain,text/markdown,text/csv,application/json,application/zip"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
            aria-label="Joindre des fichiers"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || pending.length >= MAX_ATTACHMENTS}
            aria-label="Joindre des fichiers (images, audio, vidéo, PDF)"
            className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
          >
            <Paperclip className="h-4.5 w-4.5" />
          </Button>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (showSlash && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setSlashIndex((i) => {
                  const n = slashMatches.length;
                  return e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
                });
                return;
              }
              if (showSlash && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
                e.preventDefault();
                applyPrompt(slashMatches[slashIndex] ?? slashMatches[0]);
                return;
              }
              if (e.key === "Escape" && showSlash) {
                setValue(`${value} `); // sort du mode slash
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length > 0) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            placeholder={
              dictation.recording
                ? `J'écoute… ${secondsLabel(dictation.seconds)} (clic sur le micro pour arrêter)`
                : dictation.processing
                  ? "Transcription de la dictée…"
                  : "Envoyer un message à Hermes… (/ pour les commandes)"
            }
            aria-label="Message pour Hermes"
            rows={1}
            disabled={disabled}
            className="max-h-[200px] min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[15px] leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          />
          {dictation.supported ? (
            <Button
              type="button"
              variant={dictation.recording ? "default" : "ghost"}
              size="icon"
              onClick={dictation.recording || dictation.processing ? dictation.stop : dictation.start}
              disabled={disabled && !dictation.recording}
              aria-label={
                dictation.recording ? "Arrêter la dictée et transcrire" : "Dicter un message"
              }
              title={dictation.error ?? undefined}
              className={`h-9 w-9 shrink-0 rounded-full ${
                dictation.recording
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : dictation.processing
                    ? "bg-muted text-muted-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
              }`}
            >
              {dictation.recording ? (
                <span className="relative flex h-4 w-4 items-center justify-center">
                  <span className="absolute inline-flex h-4 w-4 animate-ping rounded-full bg-white/60" />
                  <Square className="relative h-3 w-3 fill-current" />
                </span>
              ) : dictation.processing ? (
                <Loader2 className="h-4.5 w-4.5 animate-spin" />
              ) : (
                <Mic className="h-4.5 w-4.5" />
              )}
            </Button>
          ) : null}
          {isBusy ? (
            <Button
              type="button"
              onClick={onStop}
              size="icon"
              aria-label="Arrêter la génération"
              className="h-9 w-9 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : uploading || hasBlocking ? (
            <Button
              type="button"
              size="icon"
              disabled
              aria-label="Envoi des pièces jointes en cours"
              className="h-9 w-9 shrink-0 rounded-full bg-hermes text-hermes-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={submit}
              disabled={!canSend}
              size="icon"
              aria-label="Envoyer le message"
              className="h-9 w-9 shrink-0 rounded-full bg-hermes text-hermes-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp className="h-4.5 w-4.5" />
            </Button>
          )}
        </div>

        {/* Barre inférieure : modèle · aide clavier · bouclier · jauge.
            Ordre immuable du groupe de droite — la jauge reste l'élément
            le plus à droite. */}
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-1">
            {/* F-17 — comparaison : un message, deux modèles, deux réponses */}
            <Button
              type="button"
              variant="ghost"
              onClick={onToggleCompare}
              title={compareEnabled ? "Couper la comparaison" : "Comparer deux modèles côte à côte"}
              aria-pressed={compareEnabled}
              className={
                compareEnabled
                  ? "h-8 gap-1.5 rounded-full bg-hermes/15 px-2.5 text-[12.5px] font-semibold text-hermes hover:bg-hermes/25"
                  : "h-8 gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }
            >
              <Columns2 className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Comparer</span>
            </Button>
            {compareEnabled ? (
              <>
                <ModelPicker
                  compact
                  bare
                  slotLabel="A"
                  models={models}
                  selectedModel={compareModels.a}
                  source={modelsSource}
                  mode={mode}
                  onSelect={(id) => onSetCompareSlot("a", id)}
                  effort={effort}
                  onEffortChange={onEffortChange}
                />
                <ModelPicker
                  compact
                  bare
                  slotLabel="B"
                  models={models}
                  selectedModel={compareModels.b}
                  source={modelsSource}
                  mode={mode}
                  onSelect={(id) => onSetCompareSlot("b", id)}
                  effort={effort}
                  onEffortChange={onEffortChange}
                />
              </>
            ) : (
              <ModelPicker
                compact
                models={models}
                selectedModel={selectedModel}
                source={modelsSource}
                mode={mode}
                onSelect={onSelectModel}
                effort={effort}
                onEffortChange={onEffortChange}
                expert={expert}
                onExpertChange={onExpertChange}
              />
            )}

            {/* F-09 — capacités du tour : recherche web actionnable via les
                clés de services ; agent et images attendent la gateway. */}
            <span
              className="mx-0.5 hidden h-5 w-px bg-border/60 sm:block"
              aria-hidden="true"
            />
            <Button
              type="button"
              variant="ghost"
              onClick={onToggleWebSearch}
              disabled={!webSearchAvailable || mode !== "demo"}
              title={
                mode !== "demo"
                  ? "Recherche web : gérée par l'agent Hermes quand la gateway est branchée"
                  : webSearchAvailable
                    ? webSearch
                      ? "Couper la recherche web (Tavily/Exa)"
                      : "Recherche web (Tavily/Exa) : les résultats sont injectés dans le contexte du tour, sources citées sous la réponse"
                    : "Recherche web : ajoutez une clé Tavily ou Exa dans Paramètres → Clés de services"
              }
              aria-pressed={webSearch}
              aria-label="Recherche web"
              className={
                webSearch
                  ? "h-8 gap-1.5 rounded-full bg-hermes/15 px-2.5 text-[12.5px] font-semibold text-hermes hover:bg-hermes/25 disabled:opacity-45"
                  : "h-8 gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-45"
              }
            >
              <Globe className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Web</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled
              title="Génération d'images : nécessite la gateway (moteur réel)"
              aria-label="Génération d'images (à venir)"
              className="h-[34px] w-[34px] shrink-0 rounded-full text-muted-foreground opacity-45"
            >
              <ImageIcon className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled
              title="Agent (outils) : nécessite la gateway (moteur réel)"
              aria-label="Agent (à venir)"
              className="h-[34px] w-[34px] shrink-0 rounded-full text-muted-foreground opacity-45"
            >
              <Bot className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <p className="hidden items-center gap-1.5 text-[11.5px] text-muted-foreground lg:flex">
              <CornerDownLeft className="h-3 w-3" />
              Entrée pour envoyer
            </p>
            {/* Bouclier des autorisations — sans objet en mode démo (pas d'outils) */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                if (mode !== "gateway") return;
                if (permissionsMode === "auto") onPermissionsChange("ask");
                else setPermDialogOpen(true);
              }}
              disabled={mode !== "gateway"}
              title={
                mode === "gateway"
                  ? permissionsMode === "auto"
                    ? "Autorisations : tout exécuter sans confirmation — cliquer pour revenir en mode « ask »"
                    : "Autorisations : confirmation avant chaque action"
                  : "Sans objet en mode démo — actif avec une gateway"
              }
              aria-label="Autorisations de l'agent"
              className={`h-[34px] w-[34px] shrink-0 rounded-full transition-colors ${
                permissionsMode === "auto"
                  ? "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              } ${mode !== "gateway" ? "opacity-45" : ""}`}
            >
              <ShieldCheck className="h-4 w-4" />
            </Button>
            {/* Jauge de contexte — visible selon fork.context.gauge */}
            {gaugeVisible ? (
              <ContextGauge
                usage={contextUsage}
                historyCount={contextBase?.historyCount ?? 0}
                historyCompacted={contextBase?.historyCompacted ?? false}
                canCompact={canCompact}
                compactRunning={compactRunning}
                onCompact={onCompact}
                onNewSession={onNewSession}
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* Bandeau « toutes permissions » : le signal survit au scroll et à l'oubli */}
      {mode === "gateway" && permissionsMode === "auto" ? (
        <div
          className="mx-auto mt-2.5 flex w-full max-w-3xl items-center gap-2 rounded-xl bg-amber-500/12 px-3.5 py-2 text-[12.5px] font-medium"
          role="status"
        >
          <ShieldCheck className="h-[15px] w-[15px] shrink-0 text-amber-600 dark:text-amber-400" />
          Mode toutes permissions actif — l&apos;agent exécute sans confirmation
          <button
            type="button"
            onClick={() => onPermissionsChange("ask")}
            className="ml-auto shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11.5px] font-semibold text-amber-700 underline underline-offset-2 dark:text-amber-400"
          >
            Désactiver
          </button>
        </div>
      ) : null}

      {/* Armement explicite, jamais silencieux */}
      <AlertDialog open={permDialogOpen} onOpenChange={setPermDialogOpen}>
        <AlertDialogContent className="max-w-[340px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-[15px]">
              <ShieldCheck className="h-[18px] w-[18px] text-amber-600 dark:text-amber-400" />
              Autoriser toutes les actions ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Hermes pourra exécuter <strong>terminal, fichiers et web sans confirmation</strong>.
              Le mode se réinitialise à la prochaine session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onPermissionsChange("auto")}
              className="bg-amber-600 text-white hover:bg-amber-600/90"
            >
              Autoriser
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {dictation.error ? (
        <p className="mt-1.5 text-center text-[11.5px] text-destructive" role="alert">
          {dictation.error}
        </p>
      ) : null}
      <p className="mt-2 text-center text-[11.5px] text-muted-foreground">
        Hermes Web · images, audio, vidéo et PDF acceptés · les réponses sont
        générées par l&apos;agent — vérifiez les informations importantes.
      </p>
    </div>
  );
}

function secondsLabel(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
