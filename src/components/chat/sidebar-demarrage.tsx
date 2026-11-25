// Feuille 6 — la section « Projets » de la sidebar (2026-11-25, renommée
// depuis « Premiers pas ») : visible seulement quand la base est vide
// (aucune conversation) — ensuite les en-têtes habituels reprennent la main.
// Le verrou impose une première conversation RANGÉE (côté service) ;
// l'icône 📁↓ (F-62 : pas de gros boutons) ouvre le SÉLECTEUR DE DOSSIERS
// NATIF DE WINDOWS (window.showDirectoryPicker, Chromium/Brave) — l'utilisateur
// choisit son dossier dans la vraie fenêtre de l'explorateur, création de
// dossier comprise. Il devient un projet, la conversation naît dedans.
// Repli (navigateur sans l'API) : l'AttachDiskDialog maison existant.
// Feuille dédiée (chantier CRAP) : l'orchestrateur Sidebar reste maître
// d'état ; cette feuille ne porte que busy + le repli dialogue.
"use client";

import { useState } from "react";
import { Folder, FolderDown, Loader2, Sparkles } from "lucide-react";
import { AttachDiskDialog } from "@/components/chat/attach-disk-dialog";
import { pickWindowsDirectory } from "@/lib/directory-picker";
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
  /** Crée le dossier (projects:create) puis onNew. */
  onCreateProject: (
    name: string,
    parentId?: string | null,
    diskPath?: string | null
  ) => Promise<Project | null>;
}) {
  const [busy, setBusy] = useState(false);
  /** Repli : dialogue maison si le sélecteur natif est indisponible. */
  const [attachDiskOpen, setAttachDiskOpen] = useState(false);

  // Crée le projet du dossier choisi puis la conversation rangée dedans.
  // diskPath reste null : le sélecteur natif ne donne pas de chemin disque
  // (sécurité du web) — le rangement porte le NOM du dossier.
  const createFromName = async (name: string): Promise<void> => {
    setBusy(true);
    try {
      const p = await onCreateProject(name, null, null);
      if (p) onNew(p.id);
    } finally {
      setBusy(false);
    }
  };

  // L'icône : sélecteur natif de Windows. Sans l'API (Firefox/Safari,
  // annulation) → repli sur le dialogue maison existant.
  const handlePick = async (): Promise<void> => {
    const picked = await pickWindowsDirectory();
    if (picked?.name) {
      await createFromName(picked.name);
      return;
    }
    setAttachDiskOpen(true);
  };

  // Repli maison : à la création, la conversation naît rangée.
  const handleAttach = async (
    name: string,
    diskPath: string
  ): Promise<Project | null> => {
    setBusy(true);
    try {
      const p = await onCreateProject(name, null, diskPath);
      if (p) onNew(p.id);
      return p;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3 pb-2">
      {/* En-tête « Projets » + l'unique action (icône, droite — même gabarit
          que les « + » de la sidebar). Aucune phrase : l'écran parle par
          ses objets (title au survol pour la découverte). */}
      <div className="flex min-h-7 items-center gap-1.5 pt-2.5 pb-1">
        <Sparkles className="size-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Projets
        </span>
        {busy ? (
          <span
            className="ml-auto flex size-6 items-center justify-center text-muted-foreground"
            aria-label="Création du projet en cours"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void handlePick()}
            aria-label="Ajouter un dossier"
            title="Ajouter un dossier"
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

      {/* Repli (sélecteur natif indisponible) : le dialogue maison garde
          son état quand il ferme sans création ; avec création, la
          conversation naît dans handleAttach. */}
      <AttachDiskDialog
        open={attachDiskOpen}
        onOpenChange={setAttachDiskOpen}
        projects={projects}
        onAttach={handleAttach}
      />
    </div>
  );
}
