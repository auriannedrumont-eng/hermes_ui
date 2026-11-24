// Transcription audio (ASR) via z-ai-web-dev-sdk — serveur uniquement.
// Utilisé pour : transcription automatique des pièces jointes audio et
// dictée vocale depuis l'interface (MediaRecorder -> base64 -> texte).
// L'API ASR n'accepte que WAV et WebM : les autres formats (mp3, m4a, ogg,
// flac…) sont convertis en WAV 16 kHz mono via ffmpeg si disponible.
import ZAI from "z-ai-web-dev-sdk";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASR_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 30_000;
/** Plafond explicite de transcription (audit passe 3, F-05). */
export const MAX_TRANSCRIBE_BYTES = 20 * 1024 * 1024;

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;

async function getZai() {
  if (!zaiInstance) zaiInstance = await ZAI.create();
  return zaiInstance;
}

/** Convertit un audio en WAV 16 kHz mono via ffmpeg (si nécessaire). */
async function ensureAsrFormat(buffer: Buffer, mime: string): Promise<Buffer> {
  const m = mime.toLowerCase();
  if (m.includes("wav") || m.includes("webm")) return buffer;
  const dir = mkdtempSync(join(tmpdir(), "hermes-asr-"));
  try {
    const input = join(dir, "in.bin");
    const output = join(dir, "out.wav");
    writeFileSync(input, buffer);
    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-i", input,
        "-f", "wav", "-ac", "1", "-ar", "16000",
        output,
      ]);
      // Audit passe 3, F-05 : un fichier corrompu ne doit pas suspendre le
      // service indéfiniment — on tue ffmpeg passé le délai.
      const timer = setTimeout(() => {
        ff.kill("SIGKILL");
        reject(new Error("Délai de conversion ffmpeg dépassé"));
      }, FFMPEG_TIMEOUT_MS);
      ff.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("Conversion ffmpeg impossible"));
      });
      ff.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return readFileSync(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Transcrit un audio encodé en base64 (sans préfixe data:) en texte.
 * `mime` permet de convertir les formats non WAV/WebM avant l'appel ASR.
 */
export async function transcribeAudioBase64(dataBase64: string, mime = ""): Promise<string> {
  const buffer = Buffer.from(dataBase64, "base64");
  // Audit passe 3, F-05 : plafond explicite (avant, seule la taille de trame
  // socket bornait la charge).
  if (buffer.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new Error(
      `Audio trop volumineux (${(buffer.byteLength / 1024 / 1024).toFixed(1)} Mo, max ${MAX_TRANSCRIBE_BYTES / 1024 / 1024} Mo)`
    );
  }
  const zai = await getZai();
  const wav = await ensureAsrFormat(buffer, mime);
  // Revue P1-P7 : le timer de sécurité est ANNULÉ après la course —
  // l'ancien setTimeout non annulé traînait (le process ne sortait pas
  // proprement tant qu'il vivait) et un rejet tardif après le succès était
  // un rejet orphelin.
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      zai.audio.asr.create({ file_base64: wav.toString("base64") }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Délai de transcription dépassé")), ASR_TIMEOUT_MS);
      }),
    ]);
    const text = (result as any)?.text ?? (result as any)?.result ?? "";
    return String(text).trim();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
