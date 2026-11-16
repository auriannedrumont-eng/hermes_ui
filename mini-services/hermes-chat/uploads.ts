// Gestion des pièces jointes multimédia : sauvegarde sur disque (db/uploads),
// détection du type, service HTTP et nettoyage.
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { Attachment, AttachmentKind } from "./types";

const UPLOADS_DIR = join(import.meta.dir, "..", "..", "db", "uploads");

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 Mo par fichier
export const MAX_ATTACHMENTS_PER_MESSAGE = 6;

// svg exclu (risque XSS en service inline)
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/octet-stream": "bin",
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime])
);

export function attachmentKind(mime: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

function safeExt(name: string, mime: string): string {
  const fromMime = MIME_EXT[mime.toLowerCase()];
  if (fromMime) return fromMime;
  const fromName = name.includes(".") ? name.split(".").pop()! : "";
  const clean = fromName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean && clean.length <= 5 ? clean : "bin";
}

/** id de fichier sûr : hex court, sans traversal possible. */
function fileStem(id: string): string | null {
  return /^[a-zA-Z0-9-]{8,64}$/.test(id) ? id : null;
}

export function saveAttachment(name: string, mime: string, dataBase64: string): Attachment {
  const buffer = Buffer.from(dataBase64, "base64");
  if (buffer.byteLength === 0) throw new Error("Fichier vide");
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Fichier trop volumineux (${(buffer.byteLength / 1024 / 1024).toFixed(1)} Mo, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo)`
    );
  }
  if (mime.toLowerCase() === "image/svg+xml") {
    throw new Error("Le format SVG n'est pas accepté (sécurité)");
  }
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const ext = safeExt(name, mime);
  const fileName = `${id}.${ext}`;
  writeFileSync(join(UPLOADS_DIR, fileName), buffer);
  const safeMime = mime || MIME_EXT[ext] || "application/octet-stream";
  return {
    id,
    name: (name || `fichier.${ext}`).slice(0, 180),
    mime: safeMime,
    size: buffer.byteLength,
    kind: attachmentKind(safeMime),
    url: `/uploads/${fileName}`,
  };
}

export interface ServedFile {
  filePath: string;
  mime: string;
}

/** Résout un chemin de requête /uploads/<id>.<ext> en fichier servi. */
export function resolveUploadFile(urlPath: string): ServedFile | null {
  const match = /^\/uploads\/([a-zA-Z0-9-]{8,64})\.([a-z0-9]{1,5})$/.exec(urlPath);
  if (!match) return null;
  const [, , ext] = match;
  const filePath = resolve(UPLOADS_DIR, `${match[1]}.${ext}`);
  // Garde-fou : le fichier doit rester dans le dossier des uploads
  if (dirname(filePath) !== resolve(UPLOADS_DIR)) return null;
  if (!existsSync(filePath)) return null;
  return { filePath, mime: EXT_MIME[ext] ?? "application/octet-stream" };
}

/** Lit un fichier joint en data URL (pour l'envoi multimodal au moteur local). */
export function readAttachmentDataUrl(urlPath: string): string | null {
  const served = resolveUploadFile(urlPath);
  if (!served) return null;
  try {
    const data = readFileSync(served.filePath);
    return `data:${served.mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Supprime les fichiers d'une liste de pièces jointes (silencieux). */
export function deleteAttachmentFiles(attachments: Attachment[] | undefined | null): void {
  if (!attachments?.length) return;
  for (const a of attachments) {
    const served = resolveUploadFile(a.url);
    if (!served) continue;
    try {
      unlinkSync(served.filePath);
    } catch {
      /* déjà supprimé */
    }
  }
}
