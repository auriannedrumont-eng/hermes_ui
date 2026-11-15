// Journal des versions d'un fichier (F-26) — LE composant unique du
// versionnage : badge de la carte → popover ancré. Réutilisable tel quel
// quand l'espace projet existera (même carte, même badge, même popover).
//
// Design validé (« UI épurée, intuitive, pas de redondances ») :
//   - la version est automatique, l'humain ne fait que nommer et restaurer ;
//   - une ligne = date + étiquette éventuelle + étoile (épinglée) + ↩
//     (née d'une restauration) — rien de plus ;
//   - étiqueter = double-clic sur la ligne (édition inline, Entrée valide) ;
//   - restaurer = sélectionner la ligne → bouton unique (crée v(n+1),
//     toast sans dialogue ni annuler) ;
//   - télécharger = la version sélectionnée.
"use client";

import { useCallback, useState } from "react";
import { CornerDownRight, Download, Loader2, RotateCcw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { getSocket } from "@/lib/socket";
import { cn } from "@/lib/utils";
import type { Artifact } from "@/lib/chat-types";
import { artifactUrl } from "@/lib/artifact-utils";

/** Date relative courte pour la liste (« à l'instant », « hier 14:02 »…). */
function relativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const jours = Math.floor(h / 24);
  if (jours === 1)
    return `hier ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  if (jours < 7) return `il y a ${jours} j`;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

interface VersionPopoverProps {
  /** Version courante affichée par la carte (porte la clé + conversation). */
  artifact: Artifact;
  /** Déclencheur : le badge v{n} de la carte. */
  children: React.ReactNode;
}

export function VersionPopover({ artifact, children }: VersionPopoverProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Artifact[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [restoring, setRestoring] = useState(false);

  /** Charge le journal à l'ouverture (événement artifact:versions existant). */
  const fetchVersions = useCallback((): Promise<Artifact[]> => {
    return new Promise((resolve) => {
      getSocket().emit(
        "artifact:versions",
        { conversationId: artifact.conversationId, key: artifact.key },
        (res: { versions?: Artifact[] } = {}) => resolve(res.versions ?? [])
      );
    });
  }, [artifact.conversationId, artifact.key]);

  /**
   * Ouverture du popover : charge le journal (événement artifact:versions
   * existant) et réinitialise la sélection. Les mutations d'état vivent dans
   * ce handler d'événement — jamais dans un effet (règle lint du repo).
   */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        setVersions(null);
        setSelectedId(null);
        void fetchVersions().then(setVersions);
      }
    },
    [fetchVersions]
  );

  const selected = versions?.find((v) => v.id === selectedId) ?? null;
  const current = versions?.find((v) => v.version === artifact.version) ?? null;

  /** Étiqueter (double-clic → champ → Entrée). Vide = efface l'étiquette. */
  const commitLabel = useCallback(
    (target: Artifact) => {
      getSocket().emit(
        "artifact:label",
        { artifactId: target.id, label: draft },
        (res: { artifact?: Artifact; error?: string }) => {
          if (res.error) {
            toast({ title: "Étiquette refusée", description: res.error });
            return;
          }
          setVersions((prev) =>
            prev
              ? prev.map((v) => (v.id === target.id ? { ...v, label: res.artifact!.label } : v))
              : prev
          );
        }
      );
      setEditingId(null);
    },
    [draft, toast]
  );

  /** Épingler / détacher (étoile). */
  const togglePin = useCallback(
    (target: Artifact) => {
      getSocket().emit(
        "artifact:pin",
        { artifactId: target.id, pinned: !target.pinned },
        (res: { artifact?: Artifact; error?: string }) => {
          if (res.error) {
            toast({ title: "Épinglage refusé", description: res.error });
            return;
          }
          const updated = res.artifact!;
          setVersions((prev) =>
            prev
              ? prev.map((v) => (v.id === updated.id ? { ...v, pinned: updated.pinned } : v))
              : prev
          );
        }
      );
    },
    [toast]
  );

  /** Restaurer (bouton unique) : crée v(n+1) d'après la version sélectionnée. */
  const restore = useCallback(() => {
    if (!selected || !current || selected.version === current.version) return;
    setRestoring(true);
    getSocket().emit(
      "artifact:restore",
      { conversationId: artifact.conversationId, key: artifact.key, version: selected.version },
      (res: { artifact?: Artifact; error?: string }) => {
        setRestoring(false);
        if (res.error) {
          toast({ title: "Restauration refusée", description: res.error });
          return;
        }
        const created = res.artifact!;
        toast({
          title: `v${created.version} créée d'après v${selected.version}`,
          description: `${artifact.name} — l'historique reste complet.`,
        });
        setOpen(false);
      }
    );
  }, [selected, current, artifact, toast]);

  /** Télécharger la version sélectionnée (sinon la courante). */
  const download = useCallback(() => {
    const target = selected ?? artifact;
    window.open(artifactUrl(target.url), "_blank");
  }, [selected, artifact]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild onClick={(e) => e.stopPropagation()}>
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* En-tête : nom du fichier + règle discrète */}
        <div className="border-b border-border/60 px-3 py-2">
          <p className="truncate font-mono text-[12.5px] font-medium">{artifact.name}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {versions ? `${versions.length} version${versions.length > 1 ? "s" : ""}` : "…"}
            <span aria-hidden="true"> · </span>
            double-clic pour étiqueter
          </p>
        </div>

        {/* Journal : une ligne = étoile / ↩ / vN / date / étiquette */}
        <div
          role="listbox"
          aria-label={`Versions de ${artifact.name}`}
          className="max-h-72 overflow-y-auto px-1 py-1"
        >
          {!versions ? (
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : versions.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
              Aucune version enregistrée.
            </p>
          ) : (
            [...versions].reverse().map((v) => {
              const isCurrent = v.version === artifact.version;
              const isSelected = v.id === selectedId;
              const isEditing = v.id === editingId;
              return (
                <div
                  key={v.id}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  className={cn(
                    "group/row flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] outline-none transition-colors",
                    isSelected ? "bg-accent" : "hover:bg-accent/60",
                    isCurrent && !isSelected && "bg-muted/50"
                  )}
                  onClick={() => setSelectedId(v.id)}
                  onDoubleClick={() => {
                    setEditingId(v.id);
                    setDraft(v.label ?? "");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isEditing) setSelectedId(v.id);
                  }}
                >
                  {/* Étoile = épinglée (jamais purgée) */}
                  <button
                    type="button"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                    aria-label={v.pinned ? `Détacher v${v.version}` : `Épingler v${v.version}`}
                    aria-pressed={!!v.pinned}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(v);
                    }}
                  >
                    <Star
                      className={cn(
                        "h-3.5 w-3.5 transition-colors",
                        v.pinned
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/40 opacity-0 group-hover/row:opacity-100"
                      )}
                    />
                  </button>
                  {/* ↩ = née d'une restauration */}
                  {v.restoredFrom != null ? (
                    <CornerDownRight
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-label={`Restaurée d'après v${v.restoredFrom}`}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[11px]",
                      isCurrent ? "font-semibold text-hermes" : "text-muted-foreground"
                    )}
                  >
                    v{v.version}
                  </span>
                  <span className="shrink-0 text-muted-foreground/80">
                    {relativeDate(v.createdAt)}
                  </span>
                  {/* Étiquette : texte ou édition inline (double-clic) */}
                  {isEditing ? (
                    <Input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitLabel(v);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      placeholder="Étiquette…"
                      className="h-6 flex-1 px-2 text-[12px]"
                      maxLength={80}
                      aria-label={`Étiquette de v${v.version}`}
                    />
                  ) : (
                    v.label ? (
                      <span className="truncate italic text-muted-foreground">« {v.label} »</span>
                    ) : null
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Pied : les deux seules actions — restaurer et télécharger */}
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
          <Button
            size="sm"
            variant="default"
            disabled={!selected || !current || selected.version === current.version || restoring}
            onClick={restore}
            className="h-7 gap-1.5 px-2.5 text-[12px]"
          >
            {restoring ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            {selected && current && selected.version !== current.version
              ? `Restaurer v${selected.version}`
              : "Restaurer"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={download}
            className="h-7 gap-1.5 px-2.5 text-[12px] text-muted-foreground hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            Télécharger
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
