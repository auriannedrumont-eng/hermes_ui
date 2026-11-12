// Utilitaires artefacts côté frontend : URLs du mini-service, diff de lignes,
// téléchargements (fichier seul ou archive zip).
"use client";

import { serviceUrl } from "@/lib/service";
import type { Artifact } from "@/lib/chat-types";

/** URL complète d'une ressource d'artefact (via la gateway, port fichiers). */
export function artifactUrl(path: string): string {
  return serviceUrl(path);
}

/** Télécharge un artefact (source, ou PDF pour le HTML). */
export function downloadArtifact(artifact: Artifact, prefer?: "pdf" | "source"): void {
  const usePdf = prefer === "pdf" && artifact.pdfUrl;
  const path = usePdf ? artifact.pdfUrl! : artifact.url;
  window.open(artifactUrl(path), "_blank", "noopener");
}

/** Archive zip de plusieurs artefacts (bouton « Tout télécharger »). */
export function downloadArtifactZip(artifacts: Artifact[]): void {
  if (artifacts.length === 0) return;
  const ids = artifacts.map((a) => a.id).join(",");
  const name = `artefacts-hermes-${new Date().toISOString().slice(0, 10)}.zip`;
  window.open(
    artifactUrl(`/artifacts/zip?ids=${encodeURIComponent(ids)}&name=${encodeURIComponent(name)}`),
    "_blank",
    "noopener"
  );
}

// ── Extraction miroir des règles serveur (mini-services/hermes-chat/artifacts.ts) ──

/** Extrait un nom de fichier d'une info string de bloc : ```html file="x.html". */
function parseFileName(info: string): string | null {
  if (!info) return null;
  const quoted = /(?:file|filename|title|fichier)\s*=\s*["']([^"']+)["']/i.exec(info);
  if (quoted?.[1]) return quoted[1];
  for (const token of info.split(/\s+/).slice(1)) {
    if (/^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,6}$/.test(token)) return token;
  }
  return null;
}

/** Ce bloc fence devient-il un artefact ? (mêmes règles que le serveur) */
function isArtifactFence(info: string, content: string): boolean {
  if (parseFileName(info)) return true;
  const lang = info ? info.split(/\s+/)[0]?.toLowerCase() : "";
  if ((lang === "html" || lang === "svg") && content.length >= 400) return true;
  return false;
}

/**
 * Retire du texte affiché les blocs devenus artefacts (annotés `file=` ou
 * HTML/SVG volumineux, règles identiques au serveur) : le flux de conversation
 * reste lisible, la carte compacte remplace le bloc. Les blocs encore en cours
 * de stream (non fermés) sont retirés dès qu'ils qualifient.
 */
export function stripArtifactBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^```(.*)$/.exec(lines[i].trim());
    if (!open) {
      out.push(lines[i]);
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
    const content = contentLines.join("\n");
    if (isArtifactFence(info, content)) {
      // Bloc artefact : retiré du flux (ouvert ou fermé)
      i = complete ? j + 1 : lines.length;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

// ── Diff de lignes (LCS simple) pour le toggle « diff » des artefacts code ──

export interface DiffRow {
  type: "same" | "add" | "del";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Diff unifié ligne à ligne entre deux sources (algorithme LCS). */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  // Table LCS (tailles raisonnables : sources d'artefacts < ~5 000 lignes)
  if (n * m > 4_000_000) {
    return [
      ...a.map((text, i) => ({ type: "del" as const, text, oldLine: i + 1 })),
      ...b.map((text, i) => ({ type: "add" as const, text, newLine: i + 1 })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i], oldLine: i + 1 });
      i++;
    } else {
      rows.push({ type: "add", text: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: "del", text: a[i], oldLine: i + 1 });
    i++;
  }
  while (j < m) {
    rows.push({ type: "add", text: b[j], newLine: j + 1 });
    j++;
  }
  return rows;
}

/** Parseur CSV minimal (guillemets et virgules échappées). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let k = 0; k < src.length; k++) {
    const c = src[k];
    if (inQuotes) {
      if (c === '"') {
        if (src[k + 1] === '"') {
          field += '"';
          k++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === "," || c === ";" && !text.includes(",")) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}
