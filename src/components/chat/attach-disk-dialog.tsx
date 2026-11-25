// Dialogue « Ajouter un dossier de mon disque » (F-59 J5, maquette v6 📁↓).
// Liste les répertoires via GET /disk/list (service HTTP 3004, jeton requis,
// BORNÉ AU HOME côté service) ; lier un dossier crée un projet portant son
// nom avec la colonne disk_path — sémantique minimale : le dossier reste où
// il est, RIEN n'est lu ni déplacé. Fichier neuf (R1).
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Folder, FolderSymlink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const [listing, setListing] = useState<DiskListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);

  const linkedPaths = new Set(
    projects.map((p) => p.diskPath).filter((x): x is string => !!x)
  );

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
      setListing(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Service injoignable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !listing) void load();
  }, [open, listing, load]);

  // Recharge à chaque ouverture : le disque peut avoir changé.
  useEffect(() => {
    if (open) {
      setListing(null);
      setError(null);
    }
  }, [open]);

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

        {/* Chemin courant + navigation */}
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-sidebar-accent/50 px-2.5 py-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void load(listing.parent)}
            aria-label="Dossier parent"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            disabled={loading}
            onClick={() => void load(listing?.path)}
            aria-label="Rafraîchir"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
          <p className="truncate text-[12.5px] text-muted-foreground" title={listing?.path}>
            {listing ? listing.path : "…"}
          </p>
        </div>

        {/* Lier le dossier courant (jamais le HOME racine) */}
        {listing && listing.path !== listing.home ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            disabled={loading || attaching === listing.path || linkedPaths.has(listing.path)}
            onClick={() => void attach(basename(listing.path), listing.path)}
          >
            <FolderSymlink className="h-3.5 w-3.5 text-hermes-text" />
            {linkedPaths.has(listing.path)
              ? "Déjà lié dans Mes dossiers"
              : `Lier « ${basename(listing.path)} »`}
          </Button>
        ) : null}

        {/* Répertoires du chemin courant */}
        <div className="max-h-64 min-h-16 overflow-y-auto rounded-lg border border-border">
          {loading && !listing ? (
            <p className="flex items-center gap-2 px-3 py-4 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Lecture du disque…
            </p>
          ) : listing && listing.dirs.length === 0 ? (
            <p className="px-3 py-4 text-[12.5px] text-muted-foreground">
              Aucun sous-dossier ici.
            </p>
          ) : listing ? (
            <ul className="py-1">
              {listing.dirs.map((d) => {
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
