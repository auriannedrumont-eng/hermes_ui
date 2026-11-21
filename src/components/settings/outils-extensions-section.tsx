// Section « Outils & extensions » (v2.6) — la fusion de trois sections
// (Outils, Extensions, Skills) : tout ce qu'on ajoute à Hermes et ce qu'il
// sait faire, au même endroit. Ajout par le champ unifié (AddAnything) :
// nom ou adresse, install résolue par le service ; clé API ensuite sur la
// fiche. Statuts RÉELS uniquement — ce qui n'est pas livré n'est pas
// listé (pas de rangée « gateway » décorative).
"use client";

import { useEffect, useState } from "react";
import { ExtensionRow } from "@/components/settings/extensions-section";
import { AddAnything } from "@/components/settings/add-anything";
import { Pastille } from "@/components/settings/bits";
import type { PastilleTone } from "@/components/settings/bits";
import { Button } from "@/components/ui/button";
import type { ExtensionCommit } from "@/lib/chat-types";
import type { ProvidersApi } from "@/hooks/use-providers";
import { cn } from "@/lib/utils";

interface ToolRow {
  name: string;
  desc: string;
  tone: PastilleTone;
  status: string;
  action?: { label: string; section: string };
}

interface ToolsExtensionsSectionProps {
  /** Une clé Tavily/Exa active existe côté service (même calcul que le composer). */
  webSearchAvailable: boolean;
  /** Navigation interne du volet (les lignes renvoient vers la bonne section). */
  onNavigate: (section: string) => void;
  api: ProvidersApi;
}

function ToolRowLine({
  it,
  onNavigate,
}: {
  it: ToolRow;
  onNavigate: (section: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-[11px]">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold">{it.name}</div>
        <div className="mt-px text-[11px] leading-snug text-muted-foreground">{it.desc}</div>
      </div>
      {it.action ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => onNavigate(it.action!.section)}
          className="flex-none cursor-pointer rounded-sm px-2 py-1 text-[11px] font-semibold text-hermes-text transition-colors hover:bg-hermes/10"
        >
          {it.action.label}
        </Button>
      ) : null}
      <Pastille tone={it.tone} label={it.status} className="flex-none" />
    </div>
  );
}

export function ToolsExtensionsSection({
  webSearchAvailable,
  onNavigate,
  api,
}: ToolsExtensionsSectionProps) {
  const [commitsByExt, setCommitsByExt] = useState<Record<string, ExtensionCommit[]>>({});
  const setCommits = (id: string, commits: ExtensionCommit[] | null) => {
    setCommitsByExt((m) => {
      const next = { ...m };
      if (commits) next[id] = commits;
      else delete next[id];
      return next;
    });
  };
  // Lot audit : purge des commits d'une extension retirée (entrées orphelines).
  // queueMicrotask : pas de setState synchrone dans le corps d'un effet
  // (règle react-hooks/set-state-in-effect, motif du repo).
  useEffect(() => {
    queueMicrotask(() => {
      setCommitsByExt((m) => {
        const ids = new Set(api.extensions.map((e) => e.id));
        const next: Record<string, ExtensionCommit[]> = {};
        let changed = false;
        for (const k of Object.keys(m)) {
          if (ids.has(k)) next[k] = m[k];
          else changed = true;
        }
        return changed ? next : m;
      });
    });
  }, [api.extensions]);

  // Outils réellement disponibles aujourd'hui — rien de décoratif.
  const tools: ToolRow[] = [
    {
      name: "Recherche web",
      desc: "Cherche sur le web (Tavily, Exa) et cite ses sources — bascule « Web » de la barre de saisie.",
      tone: webSearchAvailable ? "ok" : "warn",
      status: webSearchAvailable ? "prête" : "sans clé",
      action: { label: "Gérer les clés", section: "cles" },
    },
    {
      name: "Analyse d'images",
      desc: "Les modèles vision analysent les images jointes.",
      // Neutre : la capacité dépend du modèle choisi, rien n'est « prêt » ici.
      tone: "off",
      status: "selon le modèle",
    },
    {
      name: "Voix — dictée et lecture",
      desc: "Dictée par le micro de la barre de saisie, lecture à voix haute sous chaque réponse.",
      tone: "ok",
      status: "présente",
    },
  ];

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Outils &amp; extensions</h1>
      <p className="mt-1 mb-4 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Ce qu&apos;Hermes sait faire, et ce que vous lui avez ajouté.
      </p>

      {/* ── Ajout : un seul champ, le service résout tout seul ───────── */}
      <AddAnything
        api={api}
        hint="Un nom (tavily…) ou une adresse (dépôt GitHub, https) : Hermes trouve et installe. La clé, si le service en demande une, se règle ensuite sur sa fiche dans « Clés de services »."
      />

      {/* ── Ajoutés : dépôts et serveurs ─────────────────────────────── */}
      <h2 className="mt-6 text-[14px] font-semibold tracking-tight">Dépôts &amp; serveurs ajoutés</h2>
      <div className="mt-2">
        {api.extensions.map((e) => (
          <ExtensionRow
            key={e.id}
            ext={e}
            api={api}
            commits={commitsByExt[e.id] ?? null}
            onCommits={setCommits}
          />
        ))}
        {api.extensions.length === 0 && api.providersLoaded ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-[12.5px] text-muted-foreground">
            Aucun dépôt ni serveur pour l&apos;instant — collez une adresse dans le champ ci-dessus.
          </p>
        ) : null}
        {api.extensions.length === 0 && !api.providersLoaded ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-[12.5px] text-muted-foreground">
            Chargement…
          </p>
        ) : null}
      </div>

      {/* ── Prêts : outils livrés ────────────────────────────────────── */}
      <h2 className="mt-6 text-[14px] font-semibold tracking-tight">Ce qu&apos;Hermes sait faire</h2>
      <div className="mt-2 rounded-xl border border-border px-4 py-1">
        {tools.map((it, i) => (
          <div key={it.name} className={cn(i > 0 && "border-t border-border/60")}>
            <ToolRowLine it={it} onNavigate={onNavigate} />
          </div>
        ))}
      </div>

      {/* ── Skills : état réel (moteur) ──────────────────────────────── */}
      <div className="mt-6 flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold">Skills</div>
          <div className="mt-px text-[11px] leading-snug text-muted-foreground">
            Aucun pour l&apos;instant — les procédures du moteur apparaîtront ici au branchement.
          </div>
        </div>
        <Pastille tone="off" label="à venir" className="flex-none" />
      </div>
    </section>
  );
}
