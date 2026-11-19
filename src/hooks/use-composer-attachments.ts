// Pièces jointes en attente du compositeur — extrait de composer.tsx
// (découpage 2026-11, FORK.md §10). État `pending` + upload un à un +
// purge F-03 : les pièces en attente appartiennent à la conversation
// précédente — changement de conversation = vidage ET révocation des
// aperçus blob (pas de fuite d'objets URL).
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "@/lib/chat-types";

export const MAX_ATTACHMENTS = 6;
const MAX_BYTES = 15 * 1024 * 1024; // aligné sur le service

/** Pièce jointe en attente (avant l'envoi du message). */
export interface PendingAttachment {
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

export function useComposerAttachments(deps: {
  /** Clé du brouillon (id de conversation ou "new") : F-03, le changement
   *  de conversation vide les pièces en attente et révoque les aperçus. */
  draftKey: string;
  onUploadFile: (file: File) => Promise<Attachment | null>;
}) {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const pendingRef = useRef<PendingAttachment[]>([]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // F-03 : les pièces jointes en attente appartiennent à la conversation
  // précédente — elles ne suivent pas le brouillon textuel dans le
  // changement de conversation : purge ET révocation des aperçus blob.
  useEffect(() => {
    return () => {
      for (const a of pendingRef.current) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    };
  }, [deps.draftKey]);
  // F-03 : vidage au changement de conversation — ajustement pendant le
  // rendu (motif React officiel), pas dans un effet.
  const [purgedKey, setPurgedKey] = useState<string | null>(null);
  if (purgedKey !== deps.draftKey) {
    setPurgedKey(deps.draftKey);
    setPending([]);
  }

  const uploadOne = useCallback(
    async (localId: string, file: File) => {
      try {
        const uploaded = await deps.onUploadFile(file);
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
    [deps.onUploadFile]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      const localId = () =>
        `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      type NewEntry = PendingAttachment & { shouldUpload: boolean };
      const entries: NewEntry[] = [];
      // Revue 2026-11-19, 4.9 (F) : la capacité se compare au TOTAL (pièces
      // déjà en attente + nouvelles), pas aux seules nouvelles entrées. Le
      // bouton d'ajout est désactivé à la limite, mais glisser-déposer et
      // collage bypassent ce disabled : 5 en attente + drop de 4 = 9 pièces.
      const room = MAX_ATTACHMENTS - pendingRef.current.length;
      const limit = Math.max(0, room);
      for (const file of list) {
        if (entries.length >= limit) break;
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

  /** Retire une pièce en attente (révoque son aperçu blob). */
  const removePending = useCallback((localId: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  }, []);

  /** Après l'envoi : vide la liste et révoque tous les aperçus. */
  const clearAll = useCallback(() => {
    setPending((prev) => {
      prev.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      });
      return [];
    });
  }, []);

  return { pending, setPending, addFiles, removePending, clearAll };
}
