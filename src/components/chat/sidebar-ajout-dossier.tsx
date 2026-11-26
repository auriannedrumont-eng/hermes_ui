// En-tête « Mes dossiers » avec l'unique action d'ajout 📁↓ — bouton-icône
// partagé par les branches « avec dossiers » (SidebarDossiers) et « sans
// dossier » (SidebarHistorique) de la sidebar ((38), 28/11) : l'ajout de
// dossier existe dans TOUS les états, y compris quand une conversation
// existe déjà mais qu'aucun dossier n'est lié (état où la feuille
// historique seule n'offrait aucune entrée — capture du 28/11).
// Sélecteur natif Windows d'abord (loi (30)) : la fenêtre de l'explorateur
// porte le bouton « Nouveau dossier » ; annulation ou API absente → repli
// dialogue maison (AttachDiskDialog porté par la branche hôte).
"use client";

import { FolderDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarSectionHeader } from "@/components/chat/sidebar-section-header";
import { pickWindowsDirectory } from "@/lib/directory-picker";
import type { Project } from "@/lib/chat-types";

export function SidebarAjoutDossier({
  onCreateProject,
  onFallback,
}: {
  /** Crée le dossier (projects:create) au retour du sélecteur natif. */
  onCreateProject: (
    name: string,
    parentId?: string | null,
    diskPath?: string | null
  ) => Promise<Project | null>;
  /** Ouvre le dialogue maison (API absente ou annulation). */
  onFallback: () => void;
}) {
  return (
    <SidebarSectionHeader
      title="Mes dossiers"
      actions={
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-sidebar-foreground"
          onClick={async () => {
            // ((107)) sélecteur natif d'abord (loi (30)) : la fenêtre
            // Windows porte le bouton « Nouveau dossier » ; annulation ou
            // API absente → dialogue maison (chemin exact, sémantique
            // disk_path).
            const picked = await pickWindowsDirectory();
            if (picked?.name) {
              await onCreateProject(picked.name, null, null);
              return;
            }
            onFallback();
          }}
          aria-label="Ajouter un dossier de mon disque"
          title="Ajouter un dossier de mon disque"
        >
          <FolderDown className="h-4 w-4" />
        </Button>
      }
    />
  );
}
