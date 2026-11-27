// Dialogue « Ajouter un dossier de mon disque » (F-59 J5, maquette v6 📁↓).
// Liste les répertoires via GET /disk/list (service HTTP 3004, jeton requis) ;
// 2026-11-25 (31) : NAVIGATION DE TOUS LES DISQUES (demande explicite) —
// le point d'entrée est « Ce PC » (GET /disk/drives : C:\, D:\, F:\…), la
// borne HOME du service est levée ; lier un dossier crée un projet portant
// son nom avec la colonne disk_path — sémantique minimale : le dossier reste
// où il est, RIEN n'est lu ni déplacé (noms seuls, jamais de contenu).
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Folder, FolderPlus, FolderSymlink, HardDrive, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FILES_PORT, serviceFetchInit, serviceUrl } from "@/lib/service";
import type { Project } from "@/lib/chat-types";

interface DiskListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
}

/** Vue « Ce PC » (31) : les lecteurs du poste. */
interface DrivesListing {
  drives: { name: string; path: string }[];
  home: string;
}

/** Mode d'affichage : les lecteurs (« Ce PC ») ou un dossier navigué. */
type VueCourante =
  | { vue: "drives"; drives: DrivesListing }
  | { vue: "dossier"; listing: DiskListing };

/** ((40)) POST /disk/mkdir — crée un dossier RÉEL sous `dossier`. Retourne
 *  l'erreur du service (nom invalide, doublon, service injoignable) ou null
 *  au succès : le composant ne porte que l'état, pas le HTTP. */
async function mkdirSurDisque(
  dossier: string,
  name: string
): Promise<string | null> {
  try {
    const url = serviceUrl("/disk/mkdir", FILES_PORT);
    const res = await fetch(url, {
      ...serviceFetchInit(),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dossier, name }),
      cache: "no-store",
    });
    const json = (await res.json()) as { error?: string };
    if (!res.ok || json.error) {
      return json.error ?? `Service a répondu HTTP ${res.status}`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Service injoignable";
  }
}

/** ((40)) champ « Nom du nouveau dossier » : Entrée crée sur le disque,
 *  Échap ou clic extérieur annule ; l'erreur du service (nom invalide,
 *  doublon) remonte à la zone d'erreur commune de la modale. */
function ChampMkdirDossier({
  dossier,
  onErreur,
  onCree,
  onFerme,
}: {
  dossier: string;
  onErreur: (message: string) => void;
  onCree: () => Promise<void> | void;
  onFerme: () => void;
}) {
  const [nom, setNom] = useState("");
  const [occupe, setOccupe] = useState(false);

  const creer = async (): Promise<void> => {
    if (occupe) return;
    const nomPropre = nom.trim();
    if (!nomPropre) return;
    setOccupe(true);
    try {
      const erreur = await mkdirSurDisque(dossier, nomPropre);
      if (erreur) {
        onErreur(erreur);
        return;
      }
      await onCree();
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Input
      autoFocus
      value={nom}
      onChange={(e) => setNom(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void creer();
        else if (e.key === "Escape") onFerme();
      }}
      onBlur={onFerme}
      placeholder="Nom du nouveau dossier"
      aria-label="Nom du nouveau dossier"
      className="h-7 rounded-lg text-[12.5px]"
    />
  );
}

export function AttachDiskDialog({
  open,
  onOpenChange,
  projects,
  onAttach,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dossiers existants : un chemin déjà lié apparaît désactivé. */
  projects: Project[];
  /** Crée le dossier lié (projects:create { name, diskPath }) côté parent. */
  onAttach: (name: string, diskPath: string) => Promise<Project | null>;
}) {
  const [vue, setVue] = useState<VueCourante | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  // ((40)) création d'un dossier RÉEL sur le disque, dans le dossier
  // navigué (POST /disk/mkdir) — demande répétée de l'utilisatrice : la
  // création vit DANS la modale, pas dans l'explorateur Windows. L'état du
  // champ vit dans ChampMkdirDossier ; ici, juste son ouverture.
  const [mkdirOuverte, setMkdirOuverte] = useState(false);

  const linkedPaths = new Set(
    projects.map((p) => p.diskPath).filter((x): x is string => !!x)
  );

  /** Charge la vue « Ce PC » : les lecteurs du poste. (31) */
  const loadDrives = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = serviceUrl("/disk/drives", FILES_PORT);
      const res = await fetch(url, { ...serviceFetchInit(), cache: "no-store" });
      const json = (await res.json()) as DrivesListing & { error?: string };
      if (!res.ok || json.error) {
        setError(json.error ?? `Service a répondu HTTP ${res.status}`);
        return;
      }
      setVue({ vue: "drives", drives: json });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Service injoignable");
    } finally {
      setLoading(false);
    }
  }, []);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = serviceUrl(
        path ? `/disk/list?path=${encodeURIComponent(path)}` : "/disk/list",
        FILES_PORT
      );
      const res = await fetch(url, { ...serviceFetchInit(), cache: "no-store" });
      const json = (await res.json()) as DiskListing & { error?: string };
      if (!res.ok || json.error) {
        setError(json.error ?? `Service a répondu HTTP ${res.status}`);
        return;
      }
      setVue({ vue: "dossier", listing: json });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Service injoignable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Point d'entrée (31) : la vue « Ce PC » à l'ouverture — les lecteurs
    // d'abord, chaque disque ensuite. Recharge à chaque ouverture : le
    // disque peut avoir changé.
    if (open) {
      setVue(null);
      setError(null);
      void loadDrives();
    }
  }, [open, loadDrives]);

  const attach = async (name: string, path: string) => {
    setAttaching(path);
    setError(null);
    try {
      const created = await onAttach(name, path);
      if (created) onOpenChange(false);
      else setError("La création du dossier lié a échoué.");
    } finally {
      setAttaching(null);
    }
  };

  const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderSymlink className="h-4 w-4 text-hermes-text" />
            Ajouter un dossier de mon disque
          </DialogTitle>
          <DialogDescription>
            Le dossier reste où il est — rien ne bouge, rien n&apos;est lu. Il
            apparaît dans « Mes dossiers » et reste lié après redémarrage.
          </DialogDescription>
        </DialogHeader>

        {/* Chemin courant + navigation — ou la vue « Ce PC » (31) */}
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-sidebar-accent/50 px-2.5 py-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            disabled={vue?.vue !== "dossier" || !vue.listing.parent || loading}
            onClick={() => {
              if (vue?.vue === "dossier" && vue.listing.parent) {
                // Retour au parent, ou « Ce PC » si on remonte au dessus
                // de la racine d'un lecteur (C:\ n'a pas de parent).
                void load(vue.listing.parent);
              }
            }}
            aria-label="Dossier parent"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            disabled={loading}
            onClick={() => void loadDrives()}
            aria-label="Ce PC — tous les lecteurs"
            title="Ce PC — tous les lecteurs"
          >
            <HardDrive className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            disabled={loading || vue?.vue !== "dossier"}
            onClick={() => {
              if (vue?.vue === "dossier") void load(vue.listing.path);
            }}
            aria-label="Rafraîchir"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            disabled={loading || vue?.vue !== "dossier"}
            // Le clic sur le bouton pendant la saisie ne doit pas déclencher
            // le blur-annule du champ (sinon « fermer » puis « rouvrir »).
            onMouseDown={(e) => {
              if (mkdirOuverte) e.preventDefault();
            }}
            onClick={() => setMkdirOuverte((v) => !v)}
            aria-label="Nouveau dossier"
            title="Nouveau dossier"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
          <p
            className="truncate text-[12.5px] text-muted-foreground"
            title={vue?.vue === "dossier" ? vue.listing.path : undefined}
          >
            {vue?.vue === "dossier"
              ? vue.listing.path
              : vue?.vue === "drives"
                ? "Ce PC"
                : "…"}
          </p>
        </div>

        {/* ((40)) champ du nouveau dossier : Entrée crée RÉELLEMENT sur le
            disque, Échap ou clic extérieur annule ; l'erreur du service
            (nom invalide, doublon) s'affiche dans la zone d'erreur commune. */}
        {mkdirOuverte && vue?.vue === "dossier" ? (
          <ChampMkdirDossier
            dossier={vue.listing.path}
            onErreur={setError}
            onCree={async () => {
              setMkdirOuverte(false);
              await load(vue.listing.path);
            }}
            onFerme={() => setMkdirOuverte(false)}
          />
        ) : null}

        {/* Lier le dossier courant (pas les racines de lecteur) */}
        {vue?.vue === "dossier" && vue.listing.path !== vue.listing.home ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            disabled={loading || attaching === vue.listing.path || linkedPaths.has(vue.listing.path)}
            onClick={() => void attach(basename(vue.listing.path), vue.listing.path)}
          >
            <FolderSymlink className="h-3.5 w-3.5 text-hermes-text" />
            {linkedPaths.has(vue.listing.path)
              ? "Déjà lié dans Mes dossiers"
              : `Lier « ${basename(vue.listing.path)} »`}
          </Button>
        ) : null}

        {/* Vue « Ce PC » (31) : les lecteurs, puis les dossiers navigués */}
        <div className="max-h-64 min-h-16 overflow-y-auto rounded-lg border border-border">
          {loading && !vue ? (
            <p className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Lecture du disque…
            </p>
          ) : vue?.vue === "drives" ? (
            <ul className="py-1">
              {vue.drives.drives.map((d) => (
                <li key={d.path}>
                  <button
                    type="button"
                    onClick={() => void load(d.path)}
                    disabled={loading}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-sidebar-accent disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Ouvrir le lecteur ${d.name}`}
                  >
                    <HardDrive className="h-3.5 w-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px]">{d.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : vue && vue.listing.dirs.length === 0 ? (
            <p className="px-3 py-4 text-[12.5px] text-muted-foreground">
              Aucun sous-dossier ici.
            </p>
          ) : vue ? (
            <ul className="py-1">
              {vue.listing.dirs.map((d) => {
                const linked = linkedPaths.has(d.path);
                return (
                  <li key={d.path}>
                    {/* Revue P1-P7 : plus de contrôle interactif IMBRIQUÉ —
                        l'ancien <span role="button"> vivait dans un <button>
                        (navigateurs et lecteurs d'écran s'y perdent). Deux
                        boutons SŒURS : ouvrir / lier. */}
                    <div className="group flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sidebar-accent">
                      <button
                        type="button"
                        onClick={() => void load(d.path)}
                        disabled={loading}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`Ouvrir le dossier ${d.name}`}
                      >
                        <Folder className="h-3.5 w-3.5 shrink-0 text-hermes-text" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">{d.name}</span>
                      </button>
                      {linked ? (
                        <span className="shrink-0 rounded-full bg-sidebar-accent px-1.5 py-px text-[11px] text-muted-foreground">
                          déjà lié
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={(e) => {
                            e.stopPropagation();
                            void attach(d.name, d.path);
                          }}
                          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-hermes-text opacity-0 transition-opacity hover:bg-hermes/10 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
                          aria-label={`Lier le dossier ${d.name} à Mes dossiers`}
                        >
                          Lier
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        {error ? (
          <p className="text-[12.5px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
