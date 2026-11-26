// En-tête « Mes dossiers » avec les DEUX actions d'ajout — boutons-icône
// partagés par les branches « avec dossiers » (SidebarDossiers) et « sans
// dossier » (SidebarHistorique) de la sidebar ((38), 28/11) : l'ajout de
// dossier existe dans TOUS les états, y compris quand une conversation
// existe déjà mais qu'aucun dossier n'est lié (état où la feuille
// historique seule n'offrait aucune entrée — capture du 28/11).
// ((39), 28/11 — demande répétée de l'utilisatrice : « créer un dossier dès
// la phase d'ajout » ; la loi « pas de champ inline » est levée
// explicitement) : l'icône + crée un dossier NOMMÉ sur place (champ inline,
// Entrée valide, Échap ou clic extérieur annule, doublon actif refusé par
// liseré rouge) ; l'icône 📁↓ garde la liaison d'un dossier EXISTANT du
// disque — sélecteur natif Windows d'abord (loi (30)), repli dialogue
// maison porté par la branche hôte. Aucun disque n'est touché : le dossier
// créé est du rangement par nom (disk_path null).
"use client";

import { useEffect, useRef, useState } from "react";
import { FolderDown, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarSectionHeader } from "@/components/chat/sidebar-section-header";
import { pickWindowsDirectory } from "@/lib/directory-picker";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/chat-types";

/** Champ inline « Nom du nouveau dossier » ((39)) : Entrée valide, Échap ou
 *  clic extérieur annule ; un nom déjà pris par un dossier actif est refusé
 *  (liseré rouge, le champ reste ouvert) — sans phrase, l'écran parle. */
export function ChampCreationDossier({
  projects,
  onConfirmer,
  onFermer,
}: {
  /** Dossiers actifs : un nom déjà pris est refusé (doublon visible). */
  projects: Project[];
  /** Nom propre (trim, non vide, non doublon) à créer. */
  onConfirmer: (nom: string) => void;
  onFermer: () => void;
}) {
  const [nom, setNom] = useState("");
  const [dejaPris, setDejaPris] = useState(false);
  const champRef = useRef<HTMLInputElement>(null);
  useEffect(() => champRef.current?.focus(), []);

  const confirmer = (): void => {
    const nomPropre = nom.trim();
    if (!nomPropre) return;
    const pris = projects.some(
      (p) => !p.archived && p.name.toLowerCase() === nomPropre.toLowerCase()
    );
    if (pris) {
      setDejaPris(true);
      return;
    }
    onConfirmer(nomPropre);
  };

  return (
    <div className="px-2 pb-1">
      <Input
        ref={champRef}
        value={nom}
        onChange={(e) => {
          setNom(e.target.value);
          setDejaPris(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") confirmer();
          else if (e.key === "Escape") onFermer();
        }}
        onBlur={onFermer}
        placeholder="Nom du nouveau dossier"
        aria-label="Nom du nouveau dossier"
        aria-invalid={dejaPris || undefined}
        className={cn(
          "h-7 rounded-lg bg-sidebar-accent text-[12.5px]",
          dejaPris && "border-destructive focus-visible:ring-destructive"
        )}
      />
    </div>
  );
}

export function SidebarAjoutDossier({
  onCreateProject,
  onFallback,
  projects,
}: {
  /** Crée le dossier (projects:create) au retour du sélecteur natif. */
  onCreateProject: (
    name: string,
    parentId?: string | null,
    diskPath?: string | null
  ) => Promise<Project | null>;
  /** Ouvre le dialogue maison (API absente ou annulation). */
  onFallback: () => void;
  /** Dossiers actifs : un nom déjà pris est refusé (doublon visible). */
  projects: Project[];
}) {
  const [creationOuverte, setCreationOuverte] = useState(false);
  const [occupe, setOccupe] = useState(false);

  const fermer = (): void => setCreationOuverte(false);

  const creerParNom = async (nom: string): Promise<void> => {
    setOccupe(true);
    try {
      await onCreateProject(nom, null, null);
      fermer();
    } finally {
      setOccupe(false);
    }
  };

  return (
    <div>
      <SidebarSectionHeader
        title="Mes dossiers"
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-sidebar-foreground"
              // Le clic sur + pendant la saisie ne doit pas déclencher le
              // blur-annule du champ : sinon « fermer » puis « rouvrir ».
              onMouseDown={(e) => {
                if (creationOuverte) e.preventDefault();
              }}
              onClick={() => (creationOuverte ? fermer() : setCreationOuverte(true))}
              aria-label="Nouveau dossier"
              title="Nouveau dossier"
            >
              {occupe ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-sidebar-foreground"
              onClick={async () => {
                // ((107)) sélecteur natif d'abord (loi (30)) : la fenêtre
                // Windows porte le bouton « Nouveau dossier » ; annulation
                // ou API absente → dialogue maison (chemin exact, sémantique
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
          </>
        }
      />
      {creationOuverte ? (
        <ChampCreationDossier
          projects={projects}
          onConfirmer={(nom) => void creerParNom(nom)}
          onFermer={fermer}
        />
      ) : null}
    </div>
  );
}
