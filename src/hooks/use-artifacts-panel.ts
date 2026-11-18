// Hook artefacts + panneau — extrait de use-hermes-chat.ts (découpage
// 2026-11, FORK.md §10) : liste des artefacts de la conversation active,
// contenus en cours de stream, panneau dédié (ouverture, sélection de
// version, retry) et fetch des versions. Les handlers socket artifact:*
// restent dans l'orchestrateur (ils dépendent de la conversation active et
// du toast) ; les états et actions autonomes vivent ici.
"use client";

import { useCallback, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import type { Artifact } from "@/lib/chat-types";

export interface ArtifactsPanelDeps {
  activeIdRef: React.RefObject<string | null>;
}

export function useArtifactsPanel({ activeIdRef }: ArtifactsPanelDeps) {
  // ── Artefacts de la conversation active + panneau dédié ──────────
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  /** Contenu source en cours de stream, par clé d'artefact (aperçu vivant). */
  const [streamingArtifacts, setStreamingArtifacts] = useState<Record<string, string>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelArtifactId, setPanelArtifactId] = useState<string | null>(null);
  /** Clé de l'artefact affiché dans le panneau (survit aux changements de version). */
  const panelKeyRef = useRef<string | null>(null);

  /** Charge les artefacts d'une conversation (toutes versions, métadonnées). */
  const fetchArtifacts = useCallback(
    (conversationId: string) => {
      getSocket().emit(
        "artifacts:list",
        { conversationId },
        (res: { artifacts?: Artifact[] } = {}) => {
          if (conversationId === activeIdRef.current) {
            setArtifacts(res.artifacts ?? []);
          }
        }
      );
    },
    [activeIdRef]
  );

  // ── Artefacts : panneau, retry, versions ──────────────────────────────

  /** Ouvre le panneau sur un artefact précis (clic carte, carte « Ouvrir »). */
  const openArtifact = useCallback((artifact: Artifact) => {
    panelKeyRef.current = artifact.key;
    setPanelArtifactId(artifact.id);
    setPanelOpen(true);
  }, []);

  /** Referme le panneau (l'utilisateur reprend le fil de la conversation). */
  const closePanel = useCallback(() => setPanelOpen(false), []);

  /** Sélectionne une version précise dans le panneau (sans l'ouvrir). */
  const selectArtifactVersion = useCallback((artifact: Artifact) => {
    panelKeyRef.current = artifact.key;
    setPanelArtifactId(artifact.id);
  }, []);

  /** Relance le rendu d'un artefact en erreur. */
  const retryArtifact = useCallback(
    (artifactId: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return;
      getSocket().emit(
        "artifact:retry",
        { conversationId, artifactId },
        (res: { ok?: boolean; error?: string }) => {
          if (!res?.ok && res?.error) {
            console.warn("[hermes] retry artefact :", res.error);
          }
        }
      );
    },
    [activeIdRef]
  );

  /** Toutes les versions d'une clé d'artefact (sélecteur + diff du panneau). */
  const fetchArtifactVersions = useCallback(
    (key: string): Promise<Artifact[]> =>
      new Promise((resolve) => {
        const conversationId = activeIdRef.current;
        if (!conversationId) return resolve([]);
        getSocket().emit(
          "artifact:versions",
          { conversationId, key },
          (res: { versions?: Artifact[] } = {}) => resolve(res.versions ?? [])
        );
      }),
    [activeIdRef]
  );

  return {
    artifacts,
    setArtifacts,
    streamingArtifacts,
    setStreamingArtifacts,
    panelOpen,
    setPanelOpen,
    panelArtifactId,
    setPanelArtifactId,
    panelKeyRef,
    fetchArtifacts,
    openArtifact,
    closePanel,
    selectArtifactVersion,
    retryArtifact,
    fetchArtifactVersions,
  };
}
