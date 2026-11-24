// Câblage des pièces jointes extrait de use-hermes-chat.ts (audit CRAP
// 2026-11, vague 4). Corps des callbacks VERBATIM — upload base64 et
// transcription audio. useHermesChat consomme par déstructuration : l'API
// publique du hook ne change pas, la page n'est pas touchée.
"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import { getSocket } from "@/lib/socket";
import type { Attachment } from "@/lib/chat-types";

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 Mo, aligné sur le service

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error("Lecture du fichier impossible"));
    reader.readAsDataURL(file);
  });
}

/** Dépendances du câblage pièces jointes : tout identifiant du hook principal
 *  utilisé par les callbacks, passé tel quel (identités conservées). */
export type AttachmentsDeps = {
  setUploadingCount: Dispatch<SetStateAction<number>>;
};

export function useAttachmentsWiring(deps: AttachmentsDeps) {
  const { setUploadingCount } = deps;

  /** Envoie un fichier au service (base64) et renvoie la pièce jointe enregistrée. */
  const uploadAttachment = useCallback(async (file: File): Promise<Attachment | null> => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `« ${file.name} » dépasse la limite de ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo`
      );
    }
    const socket = getSocket();
    setUploadingCount((n) => n + 1);
    try {
      const dataBase64 = await fileToBase64(file);
      return await new Promise<Attachment | null>((resolve, reject) => {
        socket.emit(
          "attachments:upload",
          { name: file.name, mime: file.type || "application/octet-stream", dataBase64 },
          (res: { attachment?: Attachment; error?: string }) => {
            if (res?.attachment) resolve(res.attachment);
            else reject(new Error(res?.error ?? "Échec de l'envoi du fichier"));
          }
        );
      });
    } finally {
      setUploadingCount((n) => Math.max(0, n - 1));
    }
  }, [setUploadingCount]);

  /** Transcrit un audio base64 en texte (dictée vocale). */
  const transcribeAudio = useCallback(
    (dataBase64: string, mime = "audio/webm"): Promise<string> =>
      new Promise((resolve, reject) => {
        getSocket().emit(
          "audio:transcribe",
          { dataBase64, mime },
          (res: { text?: string; error?: string }) => {
            if (typeof res?.text === "string" && res.text) resolve(res.text);
            else reject(new Error(res?.error ?? "Échec de la transcription"));
          }
        );
      }),
    []
  );

  return { uploadAttachment, transcribeAudio };
}
