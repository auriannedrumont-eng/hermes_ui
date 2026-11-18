// Hook projets — extrait de use-hermes-chat.ts (découpage 2026-11, FORK.md §10).
// État `projects` + actions (create/rename/delete/reorder/move) : la couche
// conversation reste portée par l'orchestrateur use-hermes-chat.ts, qui
// appelle ce hook et expose les mêmes identifiants qu'avant (consommateurs
// inchangés — page.tsx, sidebar.tsx).
"use client";

import { useCallback, useState } from "react";
import { getSocket } from "@/lib/socket";
import type { Project } from "@/lib/chat-types";

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);

  /** Charge la liste des projets (rangement des conversations). */
  const fetchProjects = useCallback(() => {
    getSocket().emit("projects:list", (res: { projects?: Project[] } = {}) => {
      if (res.projects) setProjects(res.projects);
    });
  }, []);

  /** Crée un projet (rangement de conversations). */
  const createProject = useCallback(
    (name: string): Promise<Project | null> =>
      new Promise((resolve) => {
        getSocket().emit(
          "projects:create",
          { name },
          (res: { project?: Project; error?: string } = {}) => {
            resolve(res.project ?? null);
          }
        );
      }),
    []
  );

  /** Renomme un projet. */
  const renameProject = useCallback((id: string, name: string) => {
    getSocket().emit(
      "projects:rename",
      { id, name },
      (res: { project?: Project } = {}) => {
        if (res.project)
          setProjects((prev) => prev.map((x) => (x.id === id ? res.project! : x)));
      }
    );
  }, []);

  /** Supprime un projet (les conversations passent dans « Sans projet »). */
  const deleteProject = useCallback((id: string) => {
    getSocket().emit("projects:delete", { id }, (res: { ok?: boolean } = {}) => {
      if (res.ok) {
        setProjects((prev) => prev.filter((x) => x.id !== id));
      }
    });
  }, []);

  /** Réordonne les projets (liste complète d'ids). */
  const reorderProjects = useCallback((ids: string[]) => {
    getSocket().emit(
      "projects:reorder",
      { ids },
      (res: { projects?: Project[] } = {}) => {
        if (res.projects) setProjects(res.projects);
      }
    );
  }, []);

  return { projects, setProjects, fetchProjects, createProject, renameProject, deleteProject, reorderProjects };
}
