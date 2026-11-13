// Section « Extensions » du volet Paramètres v4 — dépôts GitHub importés
// (vérifier, mettre à jour, épingler) et serveurs ajoutés (MCP).
// Maquette de référence : design/maquette-parametres-v4.html (pane
// p-extensions). « Vérifier » et « Mettre à jour » interrogent réellement
// l'API GitHub via le mini-service.
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
import { AddLine, Pastille } from "@/components/settings/bits";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

// ── Une extension (dépôt importé ou serveur) ─────────────────────────

function ExtensionRow({
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
  const isRepo = ext.kind === "repo";

  const handleToggle = async (enabled: boolean) => {
    const res = await api.toggleExtension(ext.id, enabled);
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
        "mb-2.5 overflow-hidden rounded-[14px] border border-border bg-card",
        !ext.enabled && "opacity-70"
      )}
    >
      {/* En-tête cliquable (dépliage) */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-hermes"
      >
        <span className="flex size-[30px] flex-none items-center justify-center rounded-[10px] bg-muted">
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
              <Pin className="size-[11px] text-amber-600 dark:text-amber-500" strokeWidth={2.4} aria-label="Version épinglée" />
            ) : null}
          </b>
          <span className="block truncate text-[12px] text-muted-foreground">{sub}</span>
        </span>
        <Pastille tone={tone} label={statusLabel} className="mt-[9px] self-start" />
        <span
          role="switch"
          aria-checked={ext.enabled}
          aria-label={`Activer ${ext.name}`}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            void handleToggle(!ext.enabled);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              void handleToggle(!ext.enabled);
            }
          }}
          className="flex flex-none items-center"
        >
          <Switch checked={ext.enabled} onCheckedChange={(v) => void handleToggle(v)} />
        </span>
        <ChevronRight
          className={cn(
            "size-[15px] flex-none text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
          strokeWidth={2.2}
        />
      </button>

      {/* Corps déplié : actions + dernières modifications */}
      {open ? (
        <div className="border-t border-border px-4 pt-2.5 pb-3.5">
          <div className="flex flex-wrap items-center gap-2">
            {isRepo && ext.updateAvailable ? (
              <button
                type="button"
                onClick={handleUpdate}
                disabled={busy !== null}
                className="flex h-[28px] cursor-pointer items-center gap-1.5 rounded-[9px] bg-hermes px-3 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-wait disabled:opacity-60"
              >
                {busy === "update" ? (
                  <Loader2 className="size-[12px] animate-spin" strokeWidth={2.2} />
                ) : null}
                Mettre à jour
              </button>
            ) : null}
            {isRepo ? (
              <button
                type="button"
                onClick={handleCheck}
                disabled={busy !== null || ext.pinned}
                title={ext.pinned ? "Version épinglée — détachez-la pour vérifier" : undefined}
                className="flex h-[28px] cursor-pointer items-center gap-1.5 rounded-[9px] border border-border px-3 text-[12px] font-medium transition-colors hover:border-hermes hover:text-hermes focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "check" ? (
                  <Loader2 className="size-[12px] animate-spin" strokeWidth={2.2} />
                ) : null}
                Vérifier
              </button>
            ) : null}
            {isRepo ? (
              <button
                type="button"
                onClick={handlePin}
                className="flex h-[28px] cursor-pointer items-center gap-1.5 rounded-[9px] border border-border px-3 text-[12px] font-medium transition-colors hover:border-hermes hover:text-hermes focus-visible:outline-2 focus-visible:outline-hermes"
              >
                {ext.pinned ? (
                  <PinOff className="size-[12px]" strokeWidth={2.2} />
                ) : (
                  <Pin className="size-[12px]" strokeWidth={2.2} />
                )}
                {ext.pinned ? "Retirer l'épingle" : "Épingler"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleRemove}
              className="ml-auto flex h-[28px] cursor-pointer items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-2 focus-visible:outline-red-500"
            >
              <Trash2 className="size-[12px]" strokeWidth={2.2} />
              Retirer
            </button>
          </div>

          {/* Dernières modifications (dépôts) */}
          {isRepo ? (
            commits && commits.length > 0 ? (
              <div className="mt-3">
                <div className="mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                  Dernières modifications
                </div>
                {commits.slice(0, 5).map((c) => (
                  <div key={c.sha} className="flex items-baseline gap-2.5 py-[3px] text-[12px]">
                    <span className="w-[62px] flex-none text-[11px] text-muted-foreground">
                      {timeAgo(c.date)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-[11.5px] text-muted-foreground">
                « Vérifier » rapatrie les dernières modifications du dépôt.
              </p>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Le panneau Extensions ────────────────────────────────────────────

export function ExtensionsSection({ api }: { api: ProvidersApi }) {
  const { toast } = useToast();
  const [showRepo, setShowRepo] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [commitsByExt, setCommitsByExt] = useState<Record<string, ExtensionCommit[]>>({});

  const setCommits = (id: string, commits: ExtensionCommit[] | null) => {
    setCommitsByExt((m) => {
      const next = { ...m };
      if (commits) next[id] = commits;
      else delete next[id];
      return next;
    });
  };

  const handleImport = async () => {
    if (!repoUrl.trim() || importing) return;
    setImporting(true);
    const res = await api.addExtension("repo", repoUrl.trim());
    setImporting(false);
    if (res.error) {
      toast({ title: "Import impossible", description: res.error, variant: "destructive" });
      return;
    }
    if (res.commits && res.extension) setCommits(res.extension.id, res.commits);
    setRepoUrl("");
    setShowRepo(false);
    toast({
      title: "Import terminé",
      description: `${res.extension?.name ?? "Dépôt"} importé — ${res.extension?.version ?? ""} sur ${res.extension?.channel ?? "main"}.`,
    });
  };

  const handleAddMcp = async () => {
    if (!mcpUrl.trim()) return;
    const res = await api.addExtension("mcp", mcpUrl.trim());
    if (res.error) {
      toast({ title: "Ajout impossible", description: res.error, variant: "destructive" });
      return;
    }
    setMcpUrl("");
    setShowMcp(false);
    toast({
      title: "Serveur ajouté",
      description: "Activé au prochain redémarrage — les sessions en cours seront prévenues.",
    });
  };

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Extensions</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
        Dépôts et serveurs ajoutés, qui apportent de nouveaux pouvoirs à Hermes. Désactiver
        garde la configuration ; tout décharger.
      </p>

      {api.extensions.map((e) => (
        <ExtensionRow
          key={e.id}
          ext={e}
          api={api}
          commits={commitsByExt[e.id] ?? null}
          onCommits={setCommits}
        />
      ))}
      {api.extensions.length === 0 ? (
        <p className="mb-4 rounded-[14px] border border-dashed border-border px-4 py-5 text-center text-[12.5px] text-muted-foreground">
          Aucune extension pour l&apos;instant — importez un dépôt GitHub ou ajoutez un serveur.
        </p>
      ) : null}

      <div className="mt-1 flex flex-wrap gap-5">
        <AddLine onClick={() => setShowRepo((v) => !v)}>Importer un dépôt GitHub</AddLine>
        <AddLine onClick={() => setShowMcp((v) => !v)}>Ajouter un serveur</AddLine>
      </div>

      {showRepo ? (
        <div className="mt-2.5 rounded-[14px] border border-border bg-card px-4 py-3.5">
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleImport();
            }}
            placeholder="Adresse du dépôt (https://github.com/…)"
            aria-label="Adresse du dépôt GitHub"
            className="h-[34px] w-full rounded-[9px] border border-border bg-background px-3 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-hermes"
          />
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            Hermes analysera le dépôt et détectera ce qu&apos;il apporte : outils, skills,
            serveur.
          </p>
          <div className="mt-2.5 flex justify-end">
            <button
              type="button"
              onClick={handleImport}
              disabled={!repoUrl.trim() || importing}
              className="flex h-[31px] cursor-pointer items-center gap-1.5 rounded-[9px] bg-hermes px-3.5 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? (
                <Loader2 className="size-[12px] animate-spin" strokeWidth={2.2} />
              ) : null}
              {importing ? "Analyse…" : "Importer"}
            </button>
          </div>
        </div>
      ) : null}

      {showMcp ? (
        <div className="mt-2.5 rounded-[14px] border border-border bg-card px-4 py-3.5">
          <input
            value={mcpUrl}
            onChange={(e) => setMcpUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddMcp();
            }}
            placeholder="Adresse du serveur, ou commande de lancement"
            aria-label="Adresse du serveur MCP"
            className="h-[34px] w-full rounded-[9px] border border-border bg-background px-3 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-hermes"
          />
          <div className="mt-2.5 flex justify-end">
            <button
              type="button"
              onClick={handleAddMcp}
              disabled={!mcpUrl.trim()}
              className="h-[31px] cursor-pointer rounded-[9px] bg-hermes px-3.5 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-50"
            >
              Ajouter
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
