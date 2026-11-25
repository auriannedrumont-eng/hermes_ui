// Feuille 6 — l'écran « Premiers pas » de la sidebar (2026-11-25, épuré
// façon Claude/ChatGPT) : remplace le texte « Pas encore de conversation. »
// quand la base est vide. Le verrou impose une première conversation RANGÉE
// (hermes.conversations.defaultProject côté service) — l'unique action est
// l'icône 📁↓ « ajouter un dossier de mon disque » (F-62 : pas de gros
// boutons), qui ouvre l'AttachDiskDialog existant. Créer un dossier neuf se
// fait dans l'explorateur Windows, pas ici. Copie minimale, une phrase :
// dire où l'on est, pas un cours. Feuille dédiée (chantier CRAP) :
// l'orchestrateur Sidebar reste maître d'état.
"use client";

import { useState } from "react";
import { Folder, FolderDown, Loader2, Sparkles } from "lucide-react";
import { AttachDiskDialog } from "@/components/chat/attach-disk-dialog";
import type { Project } from "@/lib/chat-types";

export function SidebarDemarrage({
  projects,
  onNew,
  onCreateProject,
}: {
  /** Dossiers actifs — listés sous l'action (un clic = commencer dedans). */
  projects: Project[];
  /** Crée la première conversation rangée (ou déclenche le garde du verrou). */
  onNew: (projectId?: string | null) => void;
  /** Crée le dossier lié (projects:create { name, diskPath }) puis onNew. */
  onCreateProject: (
    name: string,
    parentId?: string | null,
    diskPath?: string | null
  ) => Promise<Project | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [attachDiskOpen, setAttachDiskOpen] = useState(false);

  // Le dialogue de liaison disque crée le dossier (onAttach) ; à la
  // fermeture SANS création, la carte reste. Avec création → la
  // conversation naît rangée immédiatement.
  const handleAttach = async (
    name: string,
    diskPath: string
  ): Promise<Project | null> => {
    setBusy(true);
    try {
      const p = await onCreateProject(name, null, diskPath);
      if (p) {
        onNew(p.id);
      }
      return p;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 pb-2">
      {/* Titre discret + l'unique action (icône, droite — même gabarit que
          les « + » de la sidebar). Pas de carte encadrée : la section vit
          dans le flux de la sidebar, comme les autres. */}
      <div className="flex min-h-7 items-center gap-1.5 pt-2.5 pb-1">
        <Sparkles className="size-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Premiers pas
        </span>
        {busy ? (
          <span
            className="ml-auto flex size-6 items-center justify-center text-muted-foreground"
            aria-label="Création du dossier en cours"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAttachDiskOpen(true)}
            aria-label="Ajouter un dossier de mon disque"
            title="Ajouter un dossier de mon disque"
            className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-hermes"
          >
            <FolderDown className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {projects.length > 0 ? (
        <ul className="space-y-0.5">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onNew(p.id)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent"
                aria-label={`Commencer dans ${p.name}`}
              >
                <Folder className="size-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* La section garde son état quand le dialogue ferme sans création :
          avec création, la conversation naît dans handleAttach. */}
      <AttachDiskDialog
        open={attachDiskOpen}
        onOpenChange={setAttachDiskOpen}
        projects={projects}
        onAttach={handleAttach}
      />
    </div>
  );
}
