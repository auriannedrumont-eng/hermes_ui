// Feuille 6 — l'écran « Premiers pas » de la sidebar (2026-11-25, revu le
// même jour) : remplace le simple texte « Pas encore de conversation. »
// quand la base est vide. UNE SEULE action à l'écran — un bouton-icône
// « ajouter un dossier » (📁↓, F-62 : pas de gros boutons) — qui ouvre
// l'AttachDiskDialog existant : on y navigue dans SON disque, on lie le
// dossier voulu, la première conversation naît rangée dedans. Créer un
// dossier neuf se fait dans l'explorateur Windows, pas ici — le dialogue
// liste ce qui existe ; les dossiers déjà liés apparaissent en dessous.
// Feuille dédiée (chantier CRAP) : l'orchestrateur Sidebar reste maître
// d'état, cette feuille ne porte qu'un état (busy + dialogue ouvert).
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
    <div
      className="mx-1 mb-2 rounded-lg border border-border bg-card px-3 py-3.5"
      data-testid="sidebar-demarrage"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-hermes-text" aria-hidden="true" />
        <p className="text-[12.5px] font-semibold leading-snug">
          Commencez par un dossier
        </p>
        {/* L'unique action : bouton-icône, même grammaire que les « + »
            de la sidebar (F-62) — le dialogue de liaison disque fait le
            reste (navigation, choix, création). */}
        {busy ? (
          <span
            className="ml-auto flex size-[27px] items-center justify-center text-muted-foreground"
            aria-label="Création du dossier en cours"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAttachDiskOpen(true)}
            aria-label="Ajouter un dossier de mon disque"
            title="Ajouter un dossier de mon disque"
            className="ml-auto flex size-[27px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground hover:shadow-sm focus-visible:outline-2 focus-visible:outline-hermes"
          >
            <FolderDown className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
        La première conversation est rangée dans un dossier — les suivantes
        restent libres. Créez un dossier neuf depuis votre explorateur
        Windows, puis ajoutez-le ici.
      </p>

      {projects.length > 0 ? (
        <ul className="mt-2.5 space-y-0.5">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onNew(p.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent"
                aria-label={`Commencer dans ${p.name}`}
              >
                <Folder className="size-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* La carte garde son état quand le dialogue ferme sans création :
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
