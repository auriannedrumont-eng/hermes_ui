// Rendu des pièces jointes multimédia : images, vidéo, audio, PDF, fichiers
"use client";

import { useState } from "react";
import {
  ChevronDown,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  File as FileIcon,
  ImageIcon,
  Loader2,
  Quote,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { serviceUrl } from "@/lib/service";
import type { Attachment } from "@/lib/chat-types";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function kindIcon(kind: Attachment["kind"], className: string) {
  switch (kind) {
    case "image":
      return <ImageIcon className={className} />;
    case "audio":
      return <FileAudio className={className} />;
    case "video":
      return <FileVideo className={className} />;
    case "pdf":
      return <FileText className={className} />;
    default:
      return <FileIcon className={className} />;
  }
}

/** Vignette d'image cliquable, avec visionneuse plein écran. */
function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = serviceUrl(attachment.url);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group/img relative block max-h-56 overflow-hidden rounded-xl border border-border/60 bg-muted/40 transition-opacity hover:opacity-90"
        aria-label={`Agrandir l'image ${attachment.name}`}
      >
        <img
          src={src}
          alt={attachment.name}
          className="max-h-56 w-auto max-w-full object-cover"
          onLoad={() => setLoaded(true)}
        />
        {!loaded ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </span>
        ) : null}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="max-w-[90vw] gap-0 border-border bg-background/95 p-2 sm:max-w-3xl"
        >
          <DialogTitle className="sr-only">{attachment.name}</DialogTitle>
          <div className="max-h-[80vh] overflow-auto rounded-lg">
            <img
              src={src}
              alt={attachment.name}
              className="mx-auto h-auto max-w-full"
            />
          </div>
          <a
            href={src}
            download={attachment.name}
            className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            {attachment.name} · {formatBytes(attachment.size)}
          </a>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Lecteur vidéo intégré. */
function VideoAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <video
      src={serviceUrl(attachment.url)}
      controls
      preload="metadata"
      className="max-h-64 w-auto max-w-full rounded-xl border border-border/60"
      aria-label={`Vidéo ${attachment.name}`}
    />
  );
}

/** Lecteur audio intégré, avec transcription automatique le cas échéant. */
function AudioAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <div className="max-w-sm rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <FileAudio className="h-5 w-5 shrink-0 text-hermes-text" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium">{attachment.name}</p>
          <audio
            src={serviceUrl(attachment.url)}
            controls
            preload="metadata"
            className="mt-1 h-8 w-full"
            aria-label={`Audio ${attachment.name}`}
          />
        </div>
      </div>
      {attachment.transcript ? (
        <div className="mt-2 flex gap-2 rounded-lg bg-background/60 px-2.5 py-2">
          <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Transcription automatique
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed">
              {attachment.transcript}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** PDF : carte téléchargeable + aperçu intégré dépliable. */
function PdfAttachment({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const src = `${serviceUrl(attachment.url)}&name=${encodeURIComponent(attachment.name)}`;
  return (
    <div className="max-w-md">
      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hermes/10 text-hermes-text">
          <FileText className="h-4.5 w-4.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium">{attachment.name}</span>
          <span className="block text-[11px] text-muted-foreground">
            PDF · {formatBytes(attachment.size)}
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="h-8 gap-1 rounded-lg px-2 text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          {open ? "Masquer" : "Aperçu"}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </Button>
        <a
          href={src}
          download={attachment.name}
          aria-label={`Télécharger ${attachment.name}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      </div>
      {open ? (
        <iframe
          src={src}
          title={`Aperçu du PDF ${attachment.name}`}
          className="mt-2 h-[420px] w-full rounded-xl border border-border/60 bg-background"
        />
      ) : null}
    </div>
  );
}

/** PDF / fichier générique : carte téléchargeable. */
function FileAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <a
      href={`${serviceUrl(attachment.url)}&name=${encodeURIComponent(attachment.name)}`}
      download={attachment.name}
      className="flex max-w-xs items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 transition-colors hover:bg-muted/60"
      aria-label={`Télécharger ${attachment.name}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hermes/10 text-hermes-text">
        {kindIcon(attachment.kind, "h-4.5 w-4.5")}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-medium">{attachment.name}</span>
        <span className="block text-[11px] text-muted-foreground">
          {attachment.kind === "pdf" ? "PDF" : attachment.kind === "file" ? "Fichier" : attachment.kind}
          {" · "}
          {formatBytes(attachment.size)}
        </span>
      </span>
      <Download className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

/** Rendu d'une pièce jointe selon son type. */
export function AttachmentView({ attachment }: { attachment: Attachment }) {
  switch (attachment.kind) {
    case "image":
      return <ImageAttachment attachment={attachment} />;
    case "video":
      return <VideoAttachment attachment={attachment} />;
    case "audio":
      return <AudioAttachment attachment={attachment} />;
    case "pdf":
      return <PdfAttachment attachment={attachment} />;
    default:
      return <FileAttachment attachment={attachment} />;
  }
}

/** Grille des pièces jointes d'un message. */
export function AttachmentsList({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      {attachments.map((a) => (
        <AttachmentView key={a.id} attachment={a} />
      ))}
    </div>
  );
}

/** Puce de pièce jointe en attente d'envoi (composer). */
export function PendingAttachmentChip({
  name,
  size,
  kind,
  previewUrl,
  uploading,
  error,
  onRemove,
}: {
  name: string;
  size: number;
  kind: Attachment["kind"];
  previewUrl?: string;
  uploading: boolean;
  error?: string;
  onRemove: () => void;
}) {
  return (
    <div
      className={`group/pending relative flex items-center gap-2.5 rounded-xl border px-2.5 py-2 pr-8 ${
        error ? "border-destructive/40 bg-destructive/5" : "border-border/70 bg-muted/40"
      }`}
      title={error ?? name}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-hermes/10 text-hermes-text">
          {kindIcon(kind, "h-4.5 w-4.5")}
        </span>
      )}
      <span className="min-w-0 max-w-40">
        <span className="block truncate text-[12.5px] font-medium leading-tight">{name}</span>
        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
          {uploading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Envoi…
            </>
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : (
            <>
              {formatBytes(size)} · prêt
            </>
          )}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring group-hover/pending:opacity-100"
        aria-label={`Retirer ${name}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
