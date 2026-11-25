// Feuille 6 — l'écran « Premiers pas » de la sidebar (2026-11-25) :
// remplace le simple texte « Pas encore de conversation. » quand la base
// est vide. Trois chemins, un seul but — la première conversation doit
// être RANGÉE (verrou hermes.conversations.defaultProject, côté service) :
//   1. « Commencer dans… » : un dossier existant, un clic, conversation
//      créée rangée (onNew(projectId)) ;
//   2. « Lier un dossier du disque » : ouvre l'AttachDiskDialog existant
//      (aucun nouveau dialogue) ; la conversation naît au retour ;
//   3. « Nouveau dossier » : champ inline, onCreateProject puis onNew.
// Feuille dédiée (chantier CRAP) : l'orchestrateur Sidebar reste maître
// d'état, ce composant ne porte que la saisie du chemin 3.
"use client";

import { useState } from "react";
import { Check, Folder, FolderDown, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AttachDiskDialog } from "@/components/chat/attach-disk-dialog";
import type { Project } from "@/lib/chat-types";

export function SidebarDemarrage({
  projects,
  onNew,
  onCreateProject,
}: {
  /** Dossiers actifs — le chemin 1 n'apparaît que s'il y en a. */
  projects: Project[];
  /** Crée la première conversation rangée (ou déclenche le garde du verrou). */
  onNew: (projectId?: string | null) => void;
  /** Crée un dossier (sous-dossier interdit ici : base vide = pas de parent). */
  onCreateProject: (
    name: string,
    parentId?: string | null,
    diskPath?: string | null
  ) => Promise<Project | null>;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachDiskOpen, setAttachDiskOpen] = useState(false);

  // Chemin 2 : le dialogue de liaison disque crée le dossier (onAttach) ;
  // à la fermeture SANS création, la carte reste. Avec création → la
  // conversation naît rangée immédiatement.
  const handleAttach = async (name: string, diskPath: string): Promise<Project | null> => {
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

  // Chemin 3 : validation inline (nom non vide, pas de doublon local),
  // création du dossier puis de la conversation rangée dedans.
  const handleCreateFolder = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    if (projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      // un dossier porte déjà ce nom : commencer dedans plutôt que doubler
      const existing = projects.find(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (existing) {
        onNew(existing.id);
        setCreating(false);
        setNewName("");
      }
      return;
    }
    setBusy(true);
    try {
      const p = await onCreateProject(name, null, null);
      if (p) {
        onNew(p.id);
        setCreating(false);
        setNewName("");
      }
    } finally {
      setBusy(false);
    }
  };

  const bouton =
    "w-full justify-start gap-2.5 h-9 rounded-md border border-border bg-background px-3 text-[12.5px] font-medium text-foreground hover:bg-sidebar-accent hover:border-hermes focus-visible:ring-hermes/50";

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
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
        La première conversation est rangée dans un dossier — les suivantes
        restent libres.
      </p>

      {projects.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            Dossiers existants
          </p>
          <ul className="space-y-0.5">
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
                  <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 space-y-1.5">
        <Button variant="outline" className={bouton} onClick={() => setAttachDiskOpen(true)} disabled={busy}>
          <FolderDown className="size-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
          Lier un dossier de mon disque
        </Button>

        {creating ? (
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateFolder();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
              placeholder="Nom du nouveau dossier"
              aria-label="Nom du nouveau dossier"
              className="h-8 rounded-md border-border bg-background text-[12.5px]"
              disabled={busy}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => void handleCreateFolder()}
              disabled={!newName.trim() || busy}
              aria-label="Créer le dossier et commencer"
            >
              <Check className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button variant="outline" className={bouton} onClick={() => setCreating(true)} disabled={busy}>
            <Plus className="size-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
            Créer un nouveau dossier
          </Button>
        )}
      </div>

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
