// Artefacts : extraction des fichiers générés par l'agent depuis ses réponses
// (blocs de code annotés `file="nom.ext"` + auto-détection HTML/SVG), suivi de
// streaming, versioning par clé et construction des payloads « wire ».
import { existsSync, statSync } from "node:fs";
import type { Artifact, ArtifactKind } from "./types";
import type { ArtifactRow } from "./store";

// ── Dossiers des fichiers dérivés (PNG / PDF), servis par le port 3004 ──
import { join } from "node:path";
export const ARTIFACTS_DIR = join(import.meta.dir, "..", "..", "db", "artifacts");

export function artifactThumbPath(id: string): string {
  return join(ARTIFACTS_DIR, `${id}.png`);
}
export function artifactPdfPath(id: string): string {
  return join(ARTIFACTS_DIR, `${id}.pdf`);
}

// ── Détection du type ────────────────────────────────────────────────────

const EXT_KIND: Record<string, { kind: ArtifactKind; mime: string }> = {
  html: { kind: "html", mime: "text/html" },
  htm: { kind: "html", mime: "text/html" },
  svg: { kind: "svg", mime: "image/svg+xml" },
  md: { kind: "markdown", mime: "text/markdown" },
  markdown: { kind: "markdown", mime: "text/markdown" },
  csv: { kind: "csv", mime: "text/csv" },
  json: { kind: "json", mime: "application/json" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  pdf: { kind: "pdf", mime: "application/pdf" },
};

const LANG_KIND: Record<string, { kind: ArtifactKind; mime: string }> = {
  html: { kind: "html", mime: "text/html" },
  svg: { kind: "svg", mime: "image/svg+xml" },
  md: { kind: "markdown", mime: "text/markdown" },
  markdown: { kind: "markdown", mime: "text/markdown" },
  csv: { kind: "csv", mime: "text/csv" },
  json: { kind: "json", mime: "application/json" },
  jsonc: { kind: "json", mime: "application/json" },
};

const CODE_LANGS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "python", "sh", "bash", "zsh",
  "css", "scss", "less", "sql", "yaml", "yml", "toml", "ini", "xml", "java",
  "c", "cpp", "h", "hpp", "go", "rs", "rb", "php", "swift", "kt", "dart",
  "lua", "r", "pl", "tex", "txt", "text", "diff", "makefile", "dockerfile",
]);

const LANG_LABELS: Record<string, string> = {
  py: "python", js: "javascript", ts: "typescript", sh: "bash",
};

/** Résout kind / mime / langage depuis le nom de fichier puis le langage du bloc. */
function resolveKind(name: string | null, lang: string | null): {
  kind: ArtifactKind;
  mime: string;
  language?: string;
} | null {
  const ext = name?.includes(".")
    ? name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "")
    : null;
  if (ext && EXT_KIND[ext]) {
    const { kind, mime } = EXT_KIND[ext];
    const language =
      kind === "code" ? (LANG_LABELS[ext] ?? ext) : undefined;
    return { kind, mime, language };
  }
  if (lang) {
    const l = lang.toLowerCase();
    if (LANG_KIND[l]) return { ...LANG_KIND[l] };
    if (CODE_LANGS.has(l)) {
      return { kind: "code", mime: "text/plain", language: LANG_LABELS[l] ?? l };
    }
  }
  // Nom sans extension connue + langage inconnu : code générique
  return { kind: "code", mime: "text/plain", language: lang ?? undefined };
}

// ── Extraction des blocs fichier ─────────────────────────────────────────

export interface FileBlock {
  /** Nom de fichier (null si bloc non annoté). */
  name: string | null;
  lang: string | null;
  content: string;
  /** Bloc fermé (``` final vu) ou encore ouvert (streaming). */
  complete: boolean;
  index: number;
}

/**
 * Extrait les blocs de code « fichier » d'un texte (partiel ou complet),
 * par un balayage ligne à ligne : un bloc ouvert sans clôture est renvoyé
 * avec complete=false (streaming en cours).
 * Un bloc devient un artefact si :
 *  - son info string porte un nom de fichier (file="x", filename="x", title="x"
 *    ou un jeton nu avec extension), ou
 *  - il est de type html/svg d'au moins 400 caractères (auto-détection).
 */
export function extractFileBlocks(text: string): FileBlock[] {
  const lines = text.split("\n");
  const blocks: FileBlock[] = [];
  let i = 0;
  let idx = 0;
  while (i < lines.length) {
    const open = /^```(.*)$/.exec(lines[i].trim());
    if (!open) {
      i++;
      continue;
    }
    const info = (open[1] ?? "").trim();
    const contentLines: string[] = [];
    let j = i + 1;
    let complete = false;
    while (j < lines.length) {
      if (/^```\s*$/.test(lines[j].trim())) {
        complete = true;
        break;
      }
      contentLines.push(lines[j]);
      j++;
    }
    const lang = info ? info.split(/\s+/)[0] || null : null;
    blocks.push({
      name: parseFileName(info),
      lang,
      content: contentLines.join("\n"),
      complete,
      index: idx++,
    });
    i = j + 1;
  }
  return blocks;
}

/** Extrait un nom de fichier d'une info string de bloc : ```html file="x.html". */
function parseFileName(info: string): string | null {
  if (!info) return null;
  const quoted = /(?:file|filename|title|fichier)\s*=\s*["']([^"']+)["']/i.exec(info);
  if (quoted?.[1]) return sanitizeFileName(quoted[1]);
  // Jeton nu avec extension : ```html rapport-ventes.html
  for (const token of info.split(/\s+/).slice(1)) {
    if (/^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,6}$/.test(token)) {
      return sanitizeFileName(token);
    }
  }
  return null;
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name; // anti-traversal
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim();
  return (clean || "fichier.txt").slice(0, 120);
}

/** Nom généré pour un artefact auto-détecté. */
function generatedName(kind: ArtifactKind, n: number): string {
  switch (kind) {
    case "html":
      return `page-${n}.html`;
    case "svg":
      return `schema-${n}.svg`;
    default:
      return `artefact-${n}.txt`;
  }
}

export interface ArtifactCandidate {
  key: string;
  name: string;
  kind: ArtifactKind;
  language?: string;
  mime: string;
  content: string;
  complete: boolean;
}

export function artifactKey(name: string): string {
  return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Filtre les blocs qui deviennent des artefacts. */
export function toArtifactCandidates(text: string): ArtifactCandidate[] {
  const blocks = extractFileBlocks(text);
  const out: ArtifactCandidate[] = [];
  let auto = 0;
  for (const b of blocks) {
    const resolved = resolveKind(b.name, b.lang);
    if (!resolved) continue;
    const annotated = !!b.name;
    const autoDetect =
      !b.name && (b.lang?.toLowerCase() === "html" || b.lang?.toLowerCase() === "svg") &&
      b.content.length >= 400;
    if (!annotated && !autoDetect) continue;
    const name = b.name ?? generatedName(resolved.kind, ++auto);
    out.push({
      key: artifactKey(name),
      name,
      kind: resolved.kind,
      language: resolved.language,
      mime: resolved.mime,
      content: b.content,
      complete: b.complete,
    });
  }
  return out;
}

// ── Payload « wire » (sans contenu) ──────────────────────────────────────

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export function artifactPreview(content: string): string {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(0, 3).join("\n").slice(0, 300);
}

/** Construit l'artefact wire depuis une ligne SQL + fichiers dérivés existants. */
export function toWireArtifact(row: ArtifactRow, anchorMessageId?: string): Artifact {
  const base = {
    id: row.id,
    key: row.key,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    anchorMessageId: anchorMessageId ?? row.message_id,
    version: row.version,
    kind: row.kind as ArtifactKind,
    name: row.name,
    language: row.language ?? undefined,
    mime: row.mime,
    size: row.size,
    status: row.status as Artifact["status"],
    statusLabel: row.status_label ?? undefined,
    error: row.error ?? undefined,
    preview: artifactPreview(row.content),
    url: `/artifacts/${row.id}/download`,
    rawUrl: `/artifacts/${row.id}/raw`,
    createdAt: row.created_at,
  };
  const thumb = artifactThumbPath(row.id);
  const pdf = artifactPdfPath(row.id);
  if (existsSync(thumb)) {
    (base as any).thumbnailUrl = `/artifacts/${row.id}/thumb`;
    if (row.kind === "html") (base as any).renderedBy = "chrome-headless-shell";
  }
  if (existsSync(pdf)) {
    (base as any).pdfUrl = `/artifacts/${row.id}/pdf`;
    (base as any).pdfSize = statSync(pdf).size;
  }
  // F-26 : couche humaine du journal de versions
  if (row.label) (base as any).label = row.label;
  if (row.pinned) (base as any).pinned = true;
  if (row.restored_from != null) (base as any).restoredFrom = row.restored_from;
  return base as Artifact;
}

// ── Suivi des artefacts pendant un tour assistant ────────────────────────

export interface TrackerEvents {
  onCreated: (artifact: Artifact) => void;
  onDelta: (payload: { key: string; delta: string }) => void;
  onUpdated: (artifact: Artifact) => void;
  /** Appelé quand un artefact HTML est prêt à être rendu (clôture du bloc). */
  onHtmlReady: (row: ArtifactRow) => void;
}

interface TrackedBlock {
  key: string;
  row: ArtifactRow;
  sentLength: number;
  complete: boolean;
}

/**
 * Suit l'apparition des blocs fichier dans le contenu qui streame :
 * - ouverture du bloc → création de la carte (statut « generating »)
 * - contenu qui streame → deltas vers la carte
 * - clôture → persistance + rendu (HTML) / prêt (texte)
 */
export class ArtifactTracker {
  private tracked = new Map<string, TrackedBlock>();

  constructor(
    private store: {
      insertArtifact: (a: any) => ArtifactRow;
      updateArtifact: (id: string, patch: any) => ArtifactRow | null;
      getArtifactRow: (id: string) => ArtifactRow | null;
    },
    private conversationId: string,
    private messageId: string,
    private events: TrackerEvents
  ) {}

  /** Appelé à chaque flush du contenu accumulé pendant le streaming. */
  update(fullContent: string): void {
    const candidates = toArtifactCandidates(fullContent);
    for (const c of candidates) {
      const existing = this.tracked.get(c.key);
      if (!existing) {
        // Naissance de l'artefact : carte « generating »
        const status = c.complete ? (c.kind === "html" ? "rendering" : "ready") : "generating";
        const statusLabel = c.complete
          ? c.kind === "html"
            ? "Rendu de l'aperçu (Chrome)…"
            : null
          : `Génération de ${c.name}…`;
        const row = this.store.insertArtifact({
          conversationId: this.conversationId,
          messageId: this.messageId,
          key: c.key,
          kind: c.kind,
          name: c.name,
          language: c.language,
          mime: c.mime,
          content: c.content,
          status,
          statusLabel,
        });
        this.tracked.set(c.key, { key: c.key, row, sentLength: 0, complete: c.complete });
        this.events.onCreated(toWireArtifact(row));
        this.events.onDelta({ key: c.key, delta: c.content });
        this.tracked.get(c.key)!.sentLength = c.content.length;
        if (c.complete && c.kind === "html") this.events.onHtmlReady(row);
        continue;
      }
      // Bloc déjà suivi : nouveau contenu → delta ; clôture → transition
      if (c.content.length > existing.sentLength) {
        this.events.onDelta({
          key: c.key,
          delta: c.content.slice(existing.sentLength),
        });
        existing.sentLength = c.content.length;
        this.store.updateArtifact(existing.row.id, { content: c.content });
      }
      if (c.complete && !existing.complete) {
        existing.complete = true;
        const isHtml = c.kind === "html";
        const row = this.store.updateArtifact(existing.row.id, {
          status: isHtml ? "rendering" : "ready",
          statusLabel: isHtml ? "Rendu de l'aperçu (Chrome)…" : null,
          content: c.content,
        });
        if (row) {
          existing.row = row;
          this.events.onUpdated(toWireArtifact(row));
          if (isHtml) this.events.onHtmlReady(row);
        }
      }
    }
  }

  /**
   * Clôture du tour : marque les blocs restés ouverts (stream interrompu),
   * renvoie les lignes persistées.
   */
  finalize(fullContent: string, aborted: boolean): ArtifactRow[] {
    this.update(fullContent);
    const rows: ArtifactRow[] = [];
    for (const t of this.tracked.values()) {
      if (!t.complete && aborted) {
        const row = this.store.updateArtifact(t.row.id, {
          status: "error",
          statusLabel: null,
          error: "Génération interrompue",
        });
        if (row) {
          t.row = row;
          this.events.onUpdated(toWireArtifact(row));
        }
      }
      rows.push(t.row);
    }
    return rows;
  }
}
