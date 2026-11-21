// Carte d'une extension (dépôt importé ou serveur MCP) — partagée par la
// section « Outils & extensions ». « Vérifier » et « Mettre à jour »
// interrogent réellement l'API GitHub via le mini-service.
"use client";

import { useState } from "react";
import {
  ChevronRight,
  Cloud,
  Globe,
  Loader2,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import type { ProvidersApi } from "@/hooks/use-providers";
import type { ExtensionCommit, ExtensionView } from "@/lib/chat-types";
import { ConfirmDestructiveDialog } from "@/components/shared/confirm-destructive-dialog";
import { Pastille } from "@/components/settings/bits";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/** Message commun quand le service n'acquitte pas (chien de garde 8 s). */
const SILENT_SERVICE =
  "Le service n'a pas répondu (8 s) — réessayez une fois la connexion rétablie.";

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

// ── Une extension (dépôt importé ou serveur) ─────────────────────────

export function ExtensionRow({
  ext,
  api,
  commits,
  onCommits,
}: {
  ext: ExtensionView;
  api: ProvidersApi;
  commits: ExtensionCommit[] | null;
  onCommits: (id: string, commits: ExtensionCommit[] | null) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"check" | "update" | null>(null);
  // Lot audit : garde sur la bascule (double-bascule rapide = deux événements
  // contradictoires) + garde destructive sur la suppression.
  const [toggling, setToggling] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(false);
  const isRepo = ext.kind === "repo";

  const handleToggle = async (enabled: boolean) => {
    if (toggling) return;
    setToggling(true);
    const res = await api.toggleExtension(ext.id, enabled);
    setToggling(false);
    if (res === null) {
      toast({ title: "Action impossible", description: SILENT_SERVICE, variant: "destructive" });
      return;
    }
    if (res.error) {
      toast({ title: "Action impossible", description: res.error, variant: "destructive" });
      return;
    }
    toast({
      title: enabled ? `${ext.name} activée` : `${ext.name} désactivée`,
      description: "Pris en compte au prochain redémarrage — les sessions en cours seront prévenues.",
    });
  };

  const handleCheck = async () => {
    if (busy) return;
    setBusy("check");
    const res = await api.checkExtension(ext.id);
    setBusy(null);
    if (res === null) {
      toast({ title: "Vérification impossible", description: SILENT_SERVICE, variant: "destructive" });
      return;
    }
    if (res.error) {
      toast({ title: "Vérification impossible", description: res.error, variant: "destructive" });
      return;
    }
    if (res.commits) onCommits(ext.id, res.commits);
    if (res.skipped) {
      toast({ title: "Version figée", description: "Épingle retirée pour vérifier les mises à jour." });
    } else if (res.changed && res.extension?.updateAvailable) {
      toast({
        title: "Mise à jour disponible",
        description: `${res.extension.updateAvailable} est disponible au téléchargement.`,
      });
    } else {
      toast({ title: "Vérification faite", description: "Rien à signaler." });
    }
  };

  const handleUpdate = async () => {
    if (busy) return;
    setBusy("update");
    const res = await api.updateExtension(ext.id);
    setBusy(null);
    if (res === null) {
      toast({ title: "Mise à jour impossible", description: SILENT_SERVICE, variant: "destructive" });
      return;
    }
    if (res.error) {
      toast({ title: "Mise à jour impossible", description: res.error, variant: "destructive" });
      return;
    }
    if (res.commits) onCommits(ext.id, res.commits);
    toast({
      title: "Mise à jour appliquée",
      description: `${ext.name} suit désormais ${res.extension?.version ?? "la dernière version"}.`,
    });
  };

  const handlePin = async () => {
    const res = await api.pinExtension(ext.id, !ext.pinned);
    if (res === null) {
      toast({ title: "Action impossible", description: SILENT_SERVICE, variant: "destructive" });
      return;
    }
    if (res.error) {
      toast({ title: "Action impossible", description: res.error, variant: "destructive" });
      return;
    }
    toast({
      title: ext.pinned ? "Épingle retirée" : "Version figée",
      description: ext.pinned
        ? "Les vérifications reprennent."
        : "Plus de mises à jour automatiques.",
    });
  };

  const handleRemove = async () => {
    const res = await api.removeExtension(ext.id);
    if (res === null) {
      toast({ title: "Suppression impossible", description: SILENT_SERVICE, variant: "destructive" });
      return;
    }
    if (res.error) {
      toast({ title: "Suppression impossible", description: res.error, variant: "destructive" });
      return;
    }
    toast({ title: "Extension retirée d'Hermes" });
  };

  const tone = !ext.enabled ? "off" : ext.updateAvailable ? "warn" : "ok";
  const statusLabel = ext.updateAvailable ? `${ext.updateAvailable} disponible` : undefined;
  const typeLabel = isRepo ? "dépôt importé" : "serveur ajouté";
  const sub = [
    ext.description ?? typeLabel,
    ...(ext.description ? [typeLabel] : []),
    ext.version ? (isRepo ? ext.version : ext.channel ?? null) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={cn(
        "mb-2.5 overflow-hidden rounded-xl border border-border bg-card",
        !ext.enabled && "opacity-40"
      )}
    >
      {/* En-tête : une zone d'ouverture dédiée, le Switch HORS du bouton —
          plus de double annonce, une seule tabulation par fonction. */}
      <div className="flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        >
          <span className="flex size-[30px] flex-none items-center justify-center rounded-md bg-muted">
            {isRepo ? (
              <Globe className="size-[15px]" strokeWidth={2} />
            ) : (
              <Cloud className="size-[15px]" strokeWidth={2} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <b className="flex items-center gap-1.5 text-[14px] font-semibold tracking-tight">
              {ext.name}
              {ext.pinned ? (
                <Pin className="size-[11px] text-warning" strokeWidth={2} aria-label="Version épinglée" />
              ) : null}
            </b>
            <span className="block truncate text-[12.5px] text-muted-foreground">{sub}</span>
          </span>
          <Pastille tone={tone} label={statusLabel} className="mt-[9px] self-start" />
          <ChevronRight
            className={cn(
              "size-[15px] flex-none text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
            strokeWidth={2}
          />
        </Button>
        <Switch
          checked={ext.enabled}
          onCheckedChange={(v) => void handleToggle(v)}
          disabled={toggling}
          aria-label={ext.enabled ? `Désactiver ${ext.name}` : `Activer ${ext.name}`}
        />
      </div>

      {/* Corps déplié : actions + dernières modifications */}
      {open ? (
        <div className="border-t border-border px-4 pt-2.5 pb-3.5">
          <div className="flex flex-wrap items-center gap-2">
            {isRepo && ext.updateAvailable ? (
              <Button
                type="button"
                variant="primary"
                onClick={handleUpdate}
                disabled={busy !== null}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-wait disabled:opacity-40"
              >
                {busy === "update" ? (
                  <Loader2 className="size-[12px] animate-spin" strokeWidth={2} />
                ) : null}
                Mettre à jour
              </Button>
            ) : null}
            {isRepo ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleCheck}
                disabled={busy !== null || ext.pinned}
                title={ext.pinned ? "Version épinglée — détachez-la pour vérifier" : undefined}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium transition-colors hover:border-hermes hover:text-hermes-text focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === "check" ? (
                  <Loader2 className="size-[12px] animate-spin" strokeWidth={2} />
                ) : null}
                Vérifier
              </Button>
            ) : null}
            {isRepo ? (
              <Button
                type="button"
                variant="outline"
                onClick={handlePin}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium transition-colors hover:border-hermes hover:text-hermes-text focus-visible:outline-2 focus-visible:outline-hermes"
              >
                {ext.pinned ? (
                  <PinOff className="size-[12px]" strokeWidth={2} />
                ) : (
                  <Pin className="size-[12px]" strokeWidth={2} />
                )}
                {ext.pinned ? "Retirer l'épingle" : "Épingler"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingRemove(true)}
              className="ml-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-destructive"
            >
              <Trash2 className="size-[12px]" strokeWidth={2} />
              Retirer
            </Button>
          </div>

          {/* Dernières modifications (dépôts) */}
          {isRepo ? (
            commits && commits.length > 0 ? (
              <div className="mt-3">
                <div className="mb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  Dernières modifications
                </div>
                {commits.slice(0, 5).map((c) => (
                  <div key={c.sha} className="flex items-baseline gap-2.5 py-[3px] text-[12.5px]">
                    <span className="w-[62px] flex-none text-[11px] text-muted-foreground">
                      {timeAgo(c.date)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-[11px] text-muted-foreground">
                « Vérifier » rapatrie les dernières modifications du dépôt.
              </p>
            )
          ) : null}
        </div>
      ) : null}

      {/* Garde destructive — retirer l'extension est irréversible. */}
      <ConfirmDestructiveDialog
        open={pendingRemove}
        onOpenChange={setPendingRemove}
        title={`Retirer ${ext.name} ?`}
        description={
          isRepo
            ? "Le dépôt n'est plus chargé par Hermes au prochain redémarrage. Cette action est irréversible."
            : "Le serveur n'est plus chargé par Hermes au prochain redémarrage. Cette action est irréversible."
        }
        confirmLabel={`Retirer ${ext.name}`}
        onConfirm={() => {
          setPendingRemove(false);
          void handleRemove();
        }}
      />
    </div>
  );
}
