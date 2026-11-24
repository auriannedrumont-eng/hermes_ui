// Panneau artefact (bureau, split view) + visionneuse plein écran (mobile).
// Un rendu par type : code (coloration + numéros + wrap + diff), image/SVG
// (zoom), HTML (aperçu = PNG plein page rendu par Chrome / code + export PDF),
// Markdown, CSV (tableau), JSON, PDF (visionneuse intégrée).
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileDown,
  GitCompare,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  RefreshCw,
  WrapText,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownContent } from "@/components/chat/markdown-content";
import {
  artifactKindLabel,
  formatArtifactBytes,
  type Artifact,
  type TurnTools,
} from "@/lib/chat-types";
import {
  artifactUrl,
  downloadArtifact,
  openArtifactInTab,
} from "@/lib/artifact-utils";
import {
  useArtifactSource,
  CodeView,
  DiffView,
  CsvTableView,
  JsonView,
  ImageView,
  LiveSourceView,
} from "@/components/chat/artifact-views";
import { ArtifactTerminal } from "@/components/chat/artifact-terminal";
import { serviceFetchInit } from "@/lib/service";
import { useStreamTurnTools } from "@/lib/stream-store";

// ── Encart terminal du tour porteur (F-29, régression §60) ───────────────

/** Terminal des outils du tour qui porte l'artefact : abonné au store de
 *  stream — il suit chaque stream:tool EN DIRECT pendant le tour, sans
 *  faire re-rendre page.tsx (qui ne s'abonne plus au registre depuis le
 *  bonus perf §60 : resolveTurnTools y lisait le store sans abonnement,
 *  le terminal restait figé). Repli sur la résolution synchrone pour les
 *  messages persistés d'un tour terminé. */
function ArtifactTurnTerminal({
  messageId,
  resolveTurnTools,
}: {
  messageId?: string;
  resolveTurnTools: (messageId?: string) => TurnTools;
}) {
  const live = useStreamTurnTools(messageId);
  const tools = live ?? resolveTurnTools(messageId);
  return <ArtifactTerminal key={messageId} {...tools} />;
}

// ── Chargement du source (cache module partagé panneau / visionneuse) ───

// ── Corps du panneau : un rendu par type ─────────────────────────────────

type ViewMode = "preview" | "code";

function ArtifactBody({
  artifact,
  source,
  sourceError,
  onRetrySource,
  streamingContent,
  versions,
  onRetry,
  fetchVersions,
}: {
  artifact: Artifact;
  source: string | null;
  /** Lot audit passe 2 : le fetch du source a échoué (hook useArtifactSource). */
  sourceError?: boolean;
  /** Relance du chargement du source (bouton « Réessayer »). */
  onRetrySource?: () => void;
  streamingContent?: string;
  versions: Artifact[];
  onRetry: (id: string) => void;
  fetchVersions: (key: string) => Promise<Artifact[]>;
}) {
  const [mode, setMode] = useState<ViewMode>("preview");
  const [wrap, setWrap] = useState(false);
  const [diff, setDiff] = useState(false);
  const [prevSource, setPrevSource] = useState<string | null>(null);
  // Reset des vues quand on change d'artefact (état dérivé, pattern React)
  const [viewedKey, setViewedKey] = useState(artifact.key);
  const [viewedVersion, setViewedVersion] = useState(artifact.version);
  if (viewedKey !== artifact.key) {
    setViewedKey(artifact.key);
    setViewedVersion(artifact.version);
    setMode("preview");
    setDiff(false);
    setPrevSource(null);
  } else if (viewedVersion !== artifact.version) {
    setViewedVersion(artifact.version);
    setDiff(false);
    setPrevSource(null);
  }
  const hasPreviewToggle =
    artifact.kind === "html" ||
    artifact.kind === "svg" ||
    artifact.kind === "markdown" ||
    artifact.kind === "csv" ||
    artifact.kind === "json";
  const isLive = artifact.status === "generating" || artifact.status === "rendering";
  const canDiff =
    (artifact.kind === "code" || artifact.kind === "markdown") && artifact.version > 1;
  const prevArtifact = useMemo(
    () => versions.find((v) => v.version === artifact.version - 1) ?? null,
    [versions, artifact.version]
  );

  // Source de la version précédente quand le diff est activé
  useEffect(() => {
    if (!diff || !prevArtifact) return;
    let cancelled = false;
    fetch(artifactUrl(prevArtifact.rawUrl), serviceFetchInit())
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        if (!cancelled) setPrevSource(t);
      })
      .catch(() => {
        if (!cancelled) setPrevSource("");
      });
    return () => {
      cancelled = true;
    };
  }, [diff, prevArtifact]);

  // ── Génération / rendu en cours ────────────────────────────────────
  if (isLive) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-hermes-text" />
          {artifact.statusLabel ??
            (artifact.status === "generating"
              ? `Génération de ${artifact.name}…`
              : "Rendu de l'aperçu (Chrome)…")}
        </div>
        {streamingContent && streamingContent.length > 0 ? (
          // Perf 2026-11-19 : texte brut pendant la génération — l'ancien
          // CodeView (Prism) re-tokenisait TOUT le fichier à chaque delta
          // (~60 Hz). La colorisation n'arrive qu'à l'état « ready ».
          <div className="min-h-0 flex-1 overflow-auto">
            <LiveSourceView source={streamingContent} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="w-full max-w-sm space-y-2">
              <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
            </div>
          </div>
        )}
      </div>
    );
  }

  if (artifact.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <div>
          <p className="font-medium">Le rendu a échoué</p>
          <p className="mt-1 max-w-sm text-[12.5px] text-muted-foreground">
            {artifact.error ?? "Erreur inconnue pendant la génération de l'artefact."}
          </p>
        </div>
        {artifact.kind === "html" ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-2 rounded-lg"
            onClick={() => onRetry(artifact.id)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Réessayer le rendu
          </Button>
        ) : null}
      </div>
    );
  }

  // ── Prêt : rendu par type ──────────────────────────────────────────
  // Lot audit passe 2 : échec de chargement du source — bandeau explicite
  // avec relance, à la place du panneau silencieusement vide.
  const sourceFailed = (sourceError ?? false) && !isLive && source === null;
  const retryBanner = sourceFailed ? (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
      <AlertTriangle className="h-3.5 w-3.5 flex-none" />
      <span className="min-w-0 flex-1">Le chargement du contenu de l'artefact a échoué.</span>
      {onRetrySource ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 rounded-lg"
          onClick={onRetrySource}
        >
          <RefreshCw className="h-3 w-3" />
          Réessayer
        </Button>
      ) : null}
    </div>
  ) : null;

  const toggle = hasPreviewToggle ? (
    <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
      {(["preview", "code"] as const).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
            mode === m
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          aria-pressed={mode === m}
        >
          {m === "preview" ? "Aperçu" : "Code"}
        </button>
      ))}
    </div>
  ) : null;

  let body: React.ReactNode = null;
  if (artifact.kind === "html") {
    body =
      mode === "preview" ? (
        artifact.thumbnailUrl ? (
          <ImageView src={artifactUrl(artifact.thumbnailUrl)} alt={`Aperçu de ${artifact.name}`} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            Aperçu indisponible.
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeView source={source ?? ""} language="html" wrap={wrap} />
        </div>
      );
  } else if (artifact.kind === "svg") {
    body =
      mode === "preview" ? (
        <ImageView src={artifactUrl(artifact.rawUrl)} alt={`Aperçu de ${artifact.name}`} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeView source={source ?? ""} language="xml" wrap={wrap} />
        </div>
      );
  } else if (artifact.kind === "image") {
    body = <ImageView src={artifactUrl(artifact.rawUrl)} alt={artifact.name} />;
  } else if (artifact.kind === "pdf") {
    body = (
      <iframe
        src={artifactUrl(artifact.rawUrl)}
        title={`PDF ${artifact.name}`}
        className="min-h-0 flex-1 border-0 bg-muted/30"
      />
    );
  } else if (artifact.kind === "markdown") {
    // Revue P1-P7 (B16) : le bouton « Diff » était actif pour le Markdown
    // (canDiff) mais seul le bloc code rendait <DiffView> — le clic ne
    // changeait rien. Même rendu que le code quand une version précédente
    // existe.
    body =
      diff && prevSource !== null ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <DiffView oldSource={prevSource} newSource={source ?? ""} />
        </div>
      ) : mode === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <MarkdownContent content={source ?? ""} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeView source={source ?? ""} language="markdown" wrap={wrap} />
        </div>
      );
  } else if (artifact.kind === "csv") {
    body =
      mode === "preview" ? (
        <CsvTableView source={source ?? ""} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeView source={source ?? ""} language="text" wrap={wrap} />
        </div>
      );
  } else if (artifact.kind === "json") {
    body =
      mode === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <JsonView source={source ?? ""} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeView source={source ?? ""} language="text" wrap={wrap} />
        </div>
      );
  } else {
    // code
    body = diff && prevSource !== null ? (
      <div className="min-h-0 flex-1 overflow-auto">
        <DiffView oldSource={prevSource} newSource={source ?? ""} />
      </div>
    ) : (
      <div className="min-h-0 flex-1 overflow-auto">
        <CodeView
          source={source ?? ""}
          language={artifact.language}
          wrap={wrap}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {retryBanner}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
        {toggle}
        {artifact.kind === "code" || artifact.kind === "html" || artifact.kind === "markdown" ||
        artifact.kind === "csv" || artifact.kind === "json" || artifact.kind === "svg" ? (
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 rounded-lg ${wrap ? "text-hermes-text" : "text-muted-foreground"}`}
            onClick={() => setWrap((w) => !w)}
            aria-label="Retour à la ligne"
            title="Retour à la ligne on/off"
          >
            <WrapText className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {canDiff ? (
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 gap-1.5 rounded-lg px-2 text-[12.5px] ${
              diff ? "text-hermes-text" : "text-muted-foreground"
            }`}
            onClick={() => setDiff((d) => !d)}
            aria-pressed={diff}
            title={`Différences v${artifact.version - 1} → v${artifact.version}`}
          >
            <GitCompare className="h-3.5 w-3.5" />
            Diff v{artifact.version - 1}→v{artifact.version}
          </Button>
        ) : null}
        {artifact.kind === "html" && artifact.pdfUrl ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 gap-1.5 rounded-lg border-hermes/40 px-2.5 text-[12.5px] text-hermes-text hover:bg-hermes/10"
            onClick={() => downloadArtifact(artifact, "pdf")}
          >
            <FileDown className="h-3.5 w-3.5" />
            PDF {artifact.pdfSize ? formatArtifactBytes(artifact.pdfSize) : ""}
          </Button>
        ) : null}
      </div>
      {body}
    </div>
  );
}

// ── En-tête partagé : nom, version, actions ──────────────────────────────

function useCopySource(source: string | null) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    if (source === null) return;
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard indisponible */
    }
  }, [source]);
  return { copied, copy };
}

function ArtifactHeaderActions({
  artifact,
  source,
  versions,
  onRetry,
  onSelectVersion,
}: {
  artifact: Artifact;
  source: string | null;
  versions: Artifact[];
  onRetry: (id: string) => void;
  onSelectVersion: (artifact: Artifact) => void;
}) {
  const { copied, copy } = useCopySource(source);
  const canDownload = artifact.status === "ready";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
        onClick={() => openArtifactInTab(artifact)}
        disabled={!canDownload}
        aria-label="Ouvrir dans un nouvel onglet"
        title="Ouvrir dans un nouvel onglet"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </Button>
      {versions.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-lg px-2 font-mono text-[12.5px] text-muted-foreground"
              aria-label="Choisir la version"
              title="Versions"
            >
              v{artifact.version}
              <Badge variant="outline" className="h-4 rounded px-1 text-[11px]">
                {versions.length}
              </Badge>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel>Versions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {[...versions].reverse().map((v) => (
              <DropdownMenuItem
                key={v.id}
                onClick={() => onSelectVersion(v)}
                className={v.id === artifact.id ? "bg-muted font-medium" : ""}
              >
                <span className="font-mono text-[12.5px]">v{v.version}</span>
                <span className="ml-2 text-[12.5px] text-muted-foreground">
                  {new Date(v.createdAt).toLocaleString("fr-FR", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {v.status === "error" ? (
                  <AlertTriangle className="ml-auto h-3 w-3 text-destructive" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
        onClick={copy}
        disabled={source === null}
        aria-label="Copier le source"
        title="Copier le source"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground"
        onClick={() => downloadArtifact(artifact, artifact.kind === "html" ? "pdf" : "source")}
        disabled={!canDownload}
        aria-label="Télécharger"
        title={
          artifact.kind === "html" && artifact.pdfUrl
            ? "Télécharger le PDF vectoriel"
            : "Télécharger le fichier"
        }
      >
        <Download className="h-3.5 w-3.5" />
      </Button>
      {artifact.status === "error" && artifact.kind === "html" ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-lg text-hermes-text"
          onClick={() => onRetry(artifact.id)}
          aria-label="Réessayer"
          title="Réessayer le rendu"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function ArtifactMetaLine({ artifact }: { artifact: Artifact }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
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
      <span>
        {new Date(artifact.createdAt).toLocaleString("fr-FR", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      {artifact.renderedBy ? (
        <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-medium">
          <Globe className="h-3 w-3 text-hermes-text" />
          Rendu Chrome — fidélité garantie
        </span>
      ) : null}
    </div>
  );
}

// ── Panneau bureau (split view) ──────────────────────────────────────────

/** Revue P1-P7 (B16) : historique COMPLET des versions de l'artefact
 *  affiché — l'état artifacts ne garde que la DERNIÈRE version par clé,
 *  donc l'ancien `versions` n'avait qu'une entrée : ni prevArtifact ni
 *  diff possible (le clic « Diff » ne changeait rien, même pour le code).
 *  Le résultat de fetchVersions était jeté (`void fetchVersions(...)`).
 *  Ici : chargement par clé + UNION avec l'état live (une v3 arrivée en
 *  streaming reste visible même après l'historique servi). */
function useVersionHistory(
  selected: Artifact | null,
  artifacts: Artifact[],
  fetchVersions: (key: string) => Promise<Artifact[]>
): Artifact[] {
  const [history, setHistory] = useState<Record<string, Artifact[]>>({});
  const selectedKey = selected?.key ?? null;
  const hasVersions = !!selected && selected.version > 1;
  useEffect(() => {
    if (!selectedKey || !hasVersions) return;
    let cancelled = false;
    void fetchVersions(selectedKey).then((list) => {
      if (cancelled || list.length === 0) return;
      setHistory((prev) => ({ ...prev, [selectedKey]: list }));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, hasVersions, fetchVersions]);
  return useMemo(() => {
    if (!selected) return [];
    const parId = new Map<string, Artifact>();
    for (const v of history[selected.key] ?? []) parId.set(v.id, v);
    for (const a of artifacts) if (a.key === selected.key) parId.set(a.id, a);
    return [...parId.values()].sort((a, b) => a.version - b.version);
  }, [selected, artifacts, history]);
}

export interface ArtifactPanelProps {
  artifacts: Artifact[];
  selectedId: string | null;
  streamingArtifacts: Record<string, string>;
  /** Activité outil du tour qui porte un artefact (encart terminal). */
  resolveTurnTools: (messageId?: string) => TurnTools;
  onSelectVersion: (artifact: Artifact) => void;
  onClose: () => void;
  onRetry: (artifactId: string) => void;
  fetchVersions: (key: string) => Promise<Artifact[]>;
}

export function ArtifactPanel({
  artifacts,
  selectedId,
  streamingArtifacts,
  resolveTurnTools,
  onSelectVersion,
  onClose,
  onRetry,
  fetchVersions,
}: ArtifactPanelProps) {
  // Onglets : dernière version de chaque clé, par ordre de création
  const tabs = useMemo(() => {
    const byKey = new Map<string, Artifact>();
    for (const a of artifacts) {
      const cur = byKey.get(a.key);
      if (!cur || a.version > cur.version) byKey.set(a.key, a);
    }
    return [...byKey.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [artifacts]);

  const selected = useMemo(() => {
    const exact = artifacts.find((a) => a.id === selectedId);
    if (exact) return exact;
    const key = tabs.find((t) => t.id === selectedId)?.key;
    if (key) {
      const latest = artifacts.filter((a) => a.key === key).sort((a, b) => b.version - a.version);
      return latest[0] ?? null;
    }
    return tabs[0] ?? null;
  }, [artifacts, selectedId, tabs]);

  const versions = useVersionHistory(selected, artifacts, fetchVersions);

  const { text: source, error: sourceError, retry: retrySource } = useArtifactSource(selected);
  const streamingContent = selected ? streamingArtifacts[selected.key] : undefined;
  const selectedKey = selected?.key;
  const selectedHasVersions = !!selected && selected.version > 1;

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Aucun artefact dans cette conversation.
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      {/* Onglets + actions */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Artefacts de la conversation"
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={t.key === selected.key}
              onClick={() => onSelectVersion(t)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors ${
                t.key === selected.key
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
              title={t.name}
            >
              <span className="max-w-36 truncate font-mono">{t.name}</span>
              {t.version > 1 ? (
                <span className="rounded bg-hermes/15 px-1 font-mono text-[11px] text-hermes-text">
                  v{t.version}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <ArtifactHeaderActions
          artifact={selected}
          source={source}
          versions={versions}
          onRetry={onRetry}
          onSelectVersion={onSelectVersion}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Fermer le panneau des artefacts"
          title="Fermer"
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>

      <ArtifactBody
        artifact={selected}
        source={source}
        sourceError={sourceError}
        onRetrySource={retrySource}
        streamingContent={streamingContent}
        versions={versions}
        onRetry={onRetry}
        fetchVersions={fetchVersions}
      />
      <ArtifactTurnTerminal
        messageId={selected.messageId}
        resolveTurnTools={resolveTurnTools}
      />
      <ArtifactMetaLine artifact={selected} />
    </div>
  );
}

// ── Visionneuse plein écran (mobile) ─────────────────────────────────────

export function ArtifactViewerDialog({
  open,
  onOpenChange,
  artifacts,
  selectedId,
  streamingArtifacts,
  resolveTurnTools,
  onSelectVersion,
  onRetry,
  fetchVersions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: Artifact[];
  selectedId: string | null;
  streamingArtifacts: Record<string, string>;
  /** Activité outil du tour qui porte un artefact (encart terminal). */
  resolveTurnTools: (messageId?: string) => TurnTools;
  onSelectVersion: (artifact: Artifact) => void;
  onRetry: (artifactId: string) => void;
  fetchVersions: (key: string) => Promise<Artifact[]>;
}) {
  const tabs = useMemo(() => {
    const byKey = new Map<string, Artifact>();
    for (const a of artifacts) {
      const cur = byKey.get(a.key);
      if (!cur || a.version > cur.version) byKey.set(a.key, a);
    }
    return [...byKey.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [artifacts]);

  const selected = useMemo(
    () => artifacts.find((a) => a.id === selectedId) ?? tabs[0] ?? null,
    [artifacts, selectedId, tabs]
  );
  const idx = selected ? tabs.findIndex((t) => t.key === selected.key) : -1;

  const go = useCallback(
    (dir: 1 | -1) => {
      if (idx < 0 || tabs.length === 0) return;
      const next = tabs[(idx + dir + tabs.length) % tabs.length];
      onSelectVersion(next);
    },
    [idx, tabs, onSelectVersion]
  );

  // Swipe horizontal entre artefacts
  const touchX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchX.current === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX.current) - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
  };

  const versions = useVersionHistory(selected, artifacts, fetchVersions);
  const { text: source, error: sourceError, retry: retrySource } = useArtifactSource(selected);
  const streamingContent = selected ? streamingArtifacts[selected.key] : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[100dvh] max-h-[100dvh] w-full max-w-none flex-col gap-0 rounded-none border-0 p-0 sm:h-[100dvh] sm:max-h-[100dvh] sm:w-full sm:max-w-none sm:rounded-none sm:border-0"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">
          {selected ? `Artefact ${selected.name}` : "Artefact"}
        </DialogTitle>
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          {tabs.length > 1 ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-lg"
              onClick={() => go(-1)}
              aria-label="Artefact précédent"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate font-mono text-[12.5px] font-medium">
              {selected?.name ?? "—"}
            </p>
            {tabs.length > 1 ? (
              <p className="text-[11px] text-muted-foreground">
                {idx + 1} / {tabs.length} · glissez pour naviguer
              </p>
            ) : null}
          </div>
          {tabs.length > 1 ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-lg"
              onClick={() => go(1)}
              aria-label="Artefact suivant"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : null}
          {selected ? (
            <ArtifactHeaderActions
              artifact={selected}
              source={source}
              versions={versions}
              onRetry={onRetry}
              onSelectVersion={onSelectVersion}
            />
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-lg"
            onClick={() => onOpenChange(false)}
            aria-label="Fermer la visionneuse"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div
          className="flex min-h-0 flex-1 flex-col"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {selected ? (
            <ArtifactBody
              artifact={selected}
              source={source}
              sourceError={sourceError}
              onRetrySource={retrySource}
              streamingContent={streamingContent}
              versions={versions}
              onRetry={onRetry}
              fetchVersions={fetchVersions}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Aucun artefact.
            </div>
          )}
        </div>
        {selected ? (
          <ArtifactTurnTerminal
            messageId={selected.messageId}
            resolveTurnTools={resolveTurnTools}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
