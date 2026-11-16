// Section « Système » du volet Paramètres v4 (v2.4) — versions, connexion à
// l'agent Hermes (gateway), journaux. Sondes RÉELLES uniquement : révision git
// du déploiement, état du binaire chrome-headless, place des profils de rendu
// (mesurée sur le système de fichiers), sonde WebSocket de la gateway. Les
// réglages du MOTEUR (mises à jour, exécution des commandes, journaux)
// restent verrouillés « gateway » — jamais simulés.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pastille } from "@/components/settings/bits";
import { getSocket } from "@/lib/socket";
import type { GatewayMode } from "@/lib/chat-types";

interface SystemSectionProps {
  mode: GatewayMode | null;
  /** Fournisseurs LLM actionnables (v2.4) — pastille « moteur local » honnête. */
  engineProviders?: string[] | null;
  serverVersion: string | null;
  /** Révision git du déploiement (null = installation sans git). */
  appRevision: string | null;
  chromeHeadless: "present" | "absent" | null;
  gatewayUrl: string | null;
  /** Jeton de gateway enregistré côté service (jamais la valeur). */
  gatewayTokenSet?: boolean;
  /** Branche/débranche la gateway (URL vide = débranchement). */
  onConnectGateway?: (
    url: string,
    token?: string
  ) => Promise<{ ok: boolean; error?: string }>;
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
  gatewayTokenSet = false,
  onConnectGateway,
}: SystemSectionProps) {
  const [stats, setStats] = useState<RenderCacheStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  // ── Formulaire de connexion de la gateway (URL + jeton facultatif) ──
  const [urlDraft, setUrlDraft] = useState(gatewayUrl ?? "");
  const [tokenDraft, setTokenDraft] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectedFlash, setConnectedFlash] = useState(false);

  // Resynchronise le champ si l'URL change côté service (hello rediffusé).
  useEffect(() => {
    setUrlDraft(gatewayUrl ?? "");
  }, [gatewayUrl]);

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

  const local = mode !== "gateway";
  // « local » : sans agent lancé, seules les clés fournisseurs actives
  // répondent (réel) ; sinon état « agent non détecté » — rien n'est simulé.
  const poolActive = (engineProviders?.length ?? 0) > 0;

  const submitGateway = async (url: string) => {
    if (!onConnectGateway || connecting) return;
    setConnecting(true);
    setConnectError(null);
    const res = await onConnectGateway(url, tokenDraft.trim() || undefined);
    setConnecting(false);
    if (res.ok) {
      setTokenDraft("");
      setConnectedFlash(true);
      setTimeout(() => setConnectedFlash(false), 4000);
    } else {
      setConnectError(res.error ?? "Échec de la connexion");
    }
  };

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
              {local
                ? poolActive
                  ? `Agent non lancé — les réponses partent sur l'API de vos fournisseurs (clés actives : ${engineProviders!.join(", ")}).`
                  : "Agent Hermes non détecté — lancez l'agent (connexion automatique) ou ajoutez une clé fournisseur (Fournisseurs)."
                : "Agent Hermes connecté — les réponses viennent de l'agent réel (outils inclus)."}
            </div>
          </div>
          {local ? (
            poolActive ? (
              <Pastille tone="ok" label="clés" className="flex-none" />
            ) : (
              <Pastille tone="off" label="non détecté" className="flex-none" />
            )
          ) : (
            <Pastille tone="ok" label="agent" className="flex-none" />
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

      {/* ── Connexion à l'agent Hermes (gateway) — sonde WebSocket réelle ── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold">
              Connexion à l&apos;agent Hermes
            </div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Branchez la gateway de l&apos;agent réel — ses outils (terminal,
              fichiers, web) et ses modèles deviennent ceux de l&apos;interface.
            </div>
          </div>
          {mode === "gateway" ? (
            <Pastille tone="ok" label="connectée" className="flex-none" />
          ) : (
            <Pastille tone="off" label="non branchée" className="flex-none" />
          )}
        </div>
        <div className="mt-2.5 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="grid gap-1">
            <span className="text-[11px] text-muted-foreground">
              URL — facultative (connexion automatique par défaut)
            </span>
            <input
              type="text"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitGateway(urlDraft.trim());
              }}
              placeholder="auto : ws://127.0.0.1:9120/api/ws"
              aria-label="URL de la gateway Hermes — vide pour la connexion automatique"
              className="h-9 rounded-sm border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-hermes/60"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] text-muted-foreground">
              Jeton {gatewayTokenSet ? "(enregistré — laisser vide pour conserver)" : "(facultatif)"}
            </span>
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitGateway(urlDraft.trim());
              }}
              placeholder={gatewayTokenSet ? "••••••••" : "ticket de session"}
              aria-label="Jeton de la gateway Hermes"
              className="h-9 rounded-sm border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-hermes/60"
            />
          </label>
          <div className="flex gap-1.5 sm:pb-px">
            <button
              type="button"
              onClick={() => void submitGateway(urlDraft.trim())}
              disabled={connecting || !onConnectGateway}
              className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-hermes px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {connecting ? "Connexion…" : "Connecter"}
            </button>
            {gatewayUrl ? (
              <button
                type="button"
                onClick={() => void submitGateway("")}
                disabled={connecting || !onConnectGateway}
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Débrancher
              </button>
            ) : null}
          </div>
        </div>
        {connectError ? (
          <p className="mt-2 text-[11px] font-medium text-destructive" role="alert">
            {connectError}
          </p>
        ) : connectedFlash ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-success">
            <Check className="size-[13px] flex-none" strokeWidth={2.5} />
            {mode === "gateway"
              ? "Agent connecté — Hermes répond."
              : "Enregistré — l'agent n'a pas répondu, re-sonde automatique à chaque message."}
          </p>
        ) : (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Rien à configurer : lancer l'agent Hermes suffit (défaut
            ws://127.0.0.1:9120/api/ws). Ce champ ne sert qu'aux installations
            spéciales (port ou machine différents).
          </p>
        )}
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
