// Section « Système » du volet Paramètres v4 (v2.4) — versions, exécution,
// journaux. Sondes RÉELLES uniquement : révision git du déploiement, état
// du binaire chrome-headless, place des profils de rendu (mesurée sur le
// système de fichiers). Les réglages du MOTEUR (mises à jour, exécution
// des commandes, journaux) restent verrouillés « gateway » — jamais simulés.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pastille } from "@/components/settings/bits";
import { getSocket } from "@/lib/socket";
import type { GatewayMode } from "@/lib/chat-types";

interface SystemSectionProps {
  mode: GatewayMode | null;
  /** Fournisseurs LLM actionnables (v2.4) — pastille « moteur intégré » honnête. */
  engineProviders?: string[] | null;
  serverVersion: string | null;
  /** Révision git du déploiement (null = installation sans git). */
  appRevision: string | null;
  chromeHeadless: "present" | "absent" | null;
  gatewayUrl: string | null;
}

interface RenderCacheStats {
  count: number;
  bytes: number;
  removed?: number;
  kept?: number;
}

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "0 o";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function SystemSection({
  mode,
  engineProviders = null,
  serverVersion,
  appRevision,
  chromeHeadless,
  gatewayUrl,
}: SystemSectionProps) {
  const [stats, setStats] = useState<RenderCacheStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);

  const load = useCallback(() => {
    getSocket().emit(
      "system:renderCache",
      (res: RenderCacheStats = { count: 0, bytes: 0 }) => setStats(res)
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const clear = () => {
    setClearing(true);
    setCleared(null);
    getSocket().emit("system:clearRenderCache", (res: RenderCacheStats = { count: 0, bytes: 0 }) => {
      setStats(res);
      setClearing(false);
      setCleared(
        `${res.removed ?? 0} profil${(res.removed ?? 0) > 1 ? "s" : ""} supprimé${(res.removed ?? 0) > 1 ? "s" : ""}${
          res.kept ? `, ${res.kept} en cours d'utilisation` : ""
        }`
      );
    });
  };

  const demo = mode !== "gateway";
  // v2.4 : « démo » seulement si aucune clé fournisseur ne peut répondre —
  // sinon le moteur intégré est RÉEL (tours sur les API des fournisseurs).
  const poolActive = (engineProviders?.length ?? 0) > 0;

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Système</h1>
      <p className="mt-1 mb-2 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Versions, exécution des commandes, journaux.
      </p>

      {/* ── Interface & service — sondes réelles ─────────────────────── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-1">
        <div className="flex items-center gap-3 py-[11px]">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Service</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Le mini-service qui répond derrière cette interface.
            </div>
          </div>
          <span className="flex-none text-[12.5px] font-medium tabular-nums text-muted-foreground">
            {serverVersion ? `v${serverVersion}` : "—"}
          </span>
        </div>
        <div className="flex items-center gap-3 border-t border-border/60 py-[11px]">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Révision de l&apos;interface</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              {appRevision
                ? "Révision git du déploiement installé sur cette machine."
                : "Installation sans git (archive téléversée) — la révision ne peut pas être lue."}
            </div>
          </div>
          <span className="flex-none font-mono text-[12.5px] font-medium tabular-nums text-muted-foreground">
            {appRevision ?? "inconnue"}
          </span>
        </div>
        <div className="flex items-center gap-3 border-t border-border/60 py-[11px]">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Moteur</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              {demo
                ? poolActive
                  ? `Moteur intégré — les réponses partent sur l'API de vos fournisseurs (clés actives : ${engineProviders!.join(", ")}).`
                  : gatewayUrl
                    ? `Gateway non branchée (${gatewayUrl}). Aucune clé fournisseur active : ajoutez-en une (Fournisseurs) pour de vraies réponses.`
                    : "Aucune clé fournisseur active : les tours sont simulés par le LLM intégré. Ajoutez une clé (Fournisseurs) ou branchez la gateway Hermes."
                : "Gateway Hermes connectée — les réponses viennent du moteur réel."}
            </div>
          </div>
          {demo ? (
            poolActive ? (
              <Pastille tone="ok" label="moteur" className="flex-none" />
            ) : (
              <Pastille tone="warn" label="démo" className="flex-none" />
            )
          ) : (
            <Pastille tone="ok" label="gateway" className="flex-none" />
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border/60 py-[11px]">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Rendu (chrome-headless)</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Vignettes des artefacts, PDF et images des conversations partagées.
            </div>
          </div>
          <Pastille
            tone={chromeHeadless === "absent" ? "err" : "ok"}
            label={chromeHeadless === "absent" ? "introuvable" : "présent"}
            className="flex-none"
          />
        </div>
      </div>

      {/* ── Profils de rendu — sonde réelle + purge ───────────────────── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold">Profils de rendu</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Régénérés à chaque rendu, purgés aussi à chaque démarrage du service.
            </div>
          </div>
          <span className="flex-none text-[12.5px] font-medium tabular-nums text-muted-foreground">
            {stats ? `${stats.count} · ${fmtBytes(stats.bytes)}` : "…"}
          </span>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {cleared ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-success">
              <Check className="size-[13px] flex-none" strokeWidth={2.5} />
              <span className="truncate">{cleared}</span>
            </span>
          ) : (
            <span className="min-w-0 text-[11px] text-muted-foreground">
              Libère de la place si les documents s&apos;accumulent.
            </span>
          )}
          <button
            type="button"
            onClick={clear}
            disabled={clearing || !stats || stats.count === 0}
            className="inline-flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-destructive"
          >
            <Trash2 className="size-[13px]" strokeWidth={2} />
            {clearing ? "Nettoyage…" : "Nettoyer maintenant"}
          </button>
        </div>
      </div>

      {/* ── Moteur Hermes — verrouillé « gateway », jamais simulé ─────── */}
      <div className="mt-4">
        <h2 className="text-[14px] font-semibold tracking-tight">Moteur Hermes</h2>
        <div className={cn("mt-2 rounded-xl border border-dashed border-border px-4 py-1")}>
          {[
            {
              name: "Version & mises à jour",
              desc: "version installée, canal, sauvegarde avant mise à jour",
            },
            {
              name: "Exécution des commandes",
              desc: "sur votre machine, conteneur isolé ou machine distante ; durée max, réseau isolé",
            },
            {
              name: "Journaux & télémétrie",
              desc: "journalisation détaillée, ce qui sort de votre machine",
            },
          ].map((it, i) => (
            <div
              key={it.name}
              className={cn(
                "flex items-center gap-3 py-[11px]",
                i > 0 && "border-t border-border/60"
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold">{it.name}</div>
                <div className="mt-px text-[11px] leading-snug text-muted-foreground">
                  {it.desc}
                </div>
              </div>
              <Pastille tone="off" label="gateway" className="flex-none" />
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Ces réglages pilotent le moteur réel : ils s&apos;activeront au branchement de
          la gateway (FORK.md §4). Rien n&apos;est simulé en attendant.
        </p>
      </div>
    </section>
  );
}
