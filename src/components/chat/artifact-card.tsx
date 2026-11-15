// Carte artefact inline dans le message : compacte, cliquable, vivante.
// États : génération (squelette + étapes, code qui streame dans la carte),
// rendu en cours (Chrome), prêt (vignette + actions), erreur (Réessayer).
"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Braces,
  Download,
  FileCode2,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  Package,
  RefreshCw,
  Sheet,
  Table,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  artifactKindLabel,
  formatArtifactBytes,
  type Artifact,
  type ArtifactKind,
} from "@/lib/chat-types";
import { artifactUrl, downloadArtifact } from "@/lib/artifact-utils";
import { VersionPopover } from "@/components/chat/version-popover";

function KindIcon({ kind, className }: { kind: ArtifactKind; className?: string }) {
  const Icon =
    kind === "html"
      ? Globe
      : kind === "svg" || kind === "image"
        ? ImageIcon
        : kind === "json"
          ? Braces
          : kind === "csv"
            ? Sheet
            : kind === "code"
              ? FileCode2
              : kind === "pdf"
                ? FileText
                : Package;
  return <Icon className={className} />;
}

const KIND_TINT: Record<ArtifactKind, string> = {
  html: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  code: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  markdown: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
  csv: "bg-green-500/15 text-green-600 dark:text-green-400",
  json: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  svg: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
  image: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
  pdf: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Trois dernières lignes d'un source en cours de stream / terminé. */
function codePreviewTail(source: string, maxLines = 3): string {
  const lines = source.split("\n");
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > 260 ? tail.slice(-260) : tail;
}

interface ArtifactCardProps {
  artifact: Artifact;
  /** Contenu streamé en direct (génération en cours). */
  streamingContent?: string;
  onOpen: (artifact: Artifact) => void;
  onRetry: (artifactId: string) => void;
}

export function ArtifactCard({ artifact, streamingContent, onOpen, onRetry }: ArtifactCardProps) {
  const [imgError, setImgError] = useState(false);
  const isGenerating = artifact.status === "generating";
  const isRendering = artifact.status === "rendering";
  const isError = artifact.status === "error";
  const showStream =
    isGenerating && streamingContent !== undefined && streamingContent.length > 0;
  const hasThumb = !!artifact.thumbnailUrl && !imgError;

  return (
    <div
      className="group/art w-full max-w-[420px] overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all hover:border-hermes/50 hover:shadow-md"
      role="button"
      tabIndex={0}
      aria-label={`Artefact ${artifact.name} — ${artifactKindLabel(artifact.kind)}`}
      onClick={() => onOpen(artifact)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(artifact);
        }
      }}
    >
      {/* En-tête : icône, nom, version, statut */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${KIND_TINT[artifact.kind]}`}
        >
          <KindIcon kind={artifact.kind} className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate font-mono text-[13px] font-medium">{artifact.name}</p>
            {artifact.version > 1 ? (
              // F-26 : le badge EST la porte du journal des versions (design
              // validé : un seul point d'entrée, pas de bouton de plus).
              <VersionPopover artifact={artifact}>
                <Badge
                  variant="outline"
                  className="h-4 shrink-0 cursor-pointer rounded px-1 font-mono text-[10px] text-hermes transition-colors hover:border-hermes/60 hover:bg-hermes/10"
                  title="Historique des versions"
                >
                  v{artifact.version}
                </Badge>
              </VersionPopover>
            ) : null}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
            {isGenerating || isRendering ? (
              <>
                <Loader2 className="h-3 w-3 shrink-0 animate-spin text-hermes" />
                <span className="truncate">
                  {artifact.statusLabel ??
                    (isGenerating ? `Génération de ${artifact.name}…` : "Rendu…")}
                </span>
              </>
            ) : isError ? (
              <span className="truncate text-destructive">
                {artifact.error ?? "Échec de la génération"}
              </span>
            ) : (
              <>
                <span>{artifactKindLabel(artifact.kind)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatArtifactBytes(artifact.size)}</span>
                {artifact.pdfSize ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>PDF {formatArtifactBytes(artifact.pdfSize)}</span>
                  </>
                ) : null}
                <span aria-hidden="true">·</span>
                <span>{timeLabel(artifact.createdAt)}</span>
              </>
            )}
          </p>
        </div>
        {/* Actions */}
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {isError ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-hermes"
              onClick={() => onRetry(artifact.id)}
              aria-label="Réessayer le rendu"
              title="Réessayer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
              onClick={() => onOpen(artifact)}
              aria-label={`Ouvrir ${artifact.name}`}
              title="Ouvrir"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          {!isError ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
              onClick={() =>
                downloadArtifact(artifact, artifact.kind === "html" ? "pdf" : "source")
              }
              aria-label={`Télécharger ${artifact.name}`}
              title={artifact.kind === "html" && artifact.pdfUrl ? "Télécharger le PDF" : "Télécharger"}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Zone d'aperçu */}
      {isError ? (
        <div className="flex items-center gap-2 border-t border-border/60 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{artifact.error ?? "Le rendu a échoué."}</span>
        </div>
      ) : hasThumb ? (
        <div className="relative max-h-24 overflow-hidden border-t border-border/60">
          <img
            src={artifactUrl(artifact.thumbnailUrl!)}
            alt={`Aperçu de ${artifact.name}`}
            className="h-24 w-full object-cover object-top"
            loading="lazy"
            onError={() => setImgError(true)}
          />
          {artifact.renderedBy ? (
            <span className="absolute bottom-1.5 right-1.5 rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
              Rendu Chrome
            </span>
          ) : null}
        </div>
      ) : showStream ? (
        <div className="border-t border-border/60 bg-muted/40 px-3 py-2">
          <pre className="overflow-hidden font-mono text-[10.5px] leading-relaxed text-muted-foreground">
            <code>{codePreviewTail(streamingContent!)}</code>
          </pre>
        </div>
      ) : isGenerating || isRendering ? (
        <div className="border-t border-border/60">
          <div className="flex h-16 items-center justify-center gap-2 bg-muted/30 text-[12px] text-muted-foreground">
            {isRendering && artifact.kind === "html" ? (
              <>
                <Table className="h-3.5 w-3.5 text-hermes" />
                {artifact.statusLabel ?? "Rendu de l'aperçu (Chrome)…"}
              </>
            ) : (
              <>
                <span className="flex gap-1" aria-hidden="true">
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-hermes" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-hermes" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-hermes" />
                </span>
                {artifact.statusLabel ?? `Génération de ${artifact.name}…`}
              </>
            )}
          </div>
        </div>
      ) : artifact.preview ? (
        <div className="border-t border-border/60 bg-muted/30 px-3 py-1.5">
          <pre className="overflow-hidden font-mono text-[10.5px] leading-relaxed text-muted-foreground">
            <code>
              {artifact.preview.split("\n").slice(0, 3).join("\n").slice(0, 220)}
            </code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}
