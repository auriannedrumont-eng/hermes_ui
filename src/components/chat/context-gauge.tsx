// Jauge de contexte — chantier « Composer v2 ».
// Anneau discret dans le pied du composer ; au clic, popover détaillant ce
// qui part au modèle ce tour : un poste par source réelle (les postes absents
// de la session ne s'affichent pas), part de fenêtre en % et poids en « k ».
// Seuils : ambre à 50 %, rouge à 80 %. Actions en pied : Compacter (résumé
// conservé en tête de session) et Nouvelle session — toujours des choix
// explicites, jamais de troncature silencieuse.
"use client";

import { useState } from "react";
import { Loader2, MessageSquarePlus, Minimize2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatK, formatPct, type ContextUsage } from "@/lib/tokens";

/** Circonférences des anneaux SVG (r = 8.5 et r = 17). */
const C_SMALL = 2 * Math.PI * 8.5;
const C_LARGE = 2 * Math.PI * 17;

function toneOf(pct: number): "ok" | "warn" | "danger" {
  if (pct >= 80) return "danger";
  if (pct >= 50) return "warn";
  return "ok";
}

const STROKE: Record<"ok" | "warn" | "danger", string> = {
  ok: "var(--hermes)",
  warn: "var(--warning)",
  danger: "var(--destructive, #dc2626)",
};

const TEXT_TONE: Record<"ok" | "warn" | "danger", string> = {
  ok: "text-hermes-text",
  warn: "text-warning",
  danger: "text-destructive",
};

function Ring({
  pct,
    size,
  strokeWidth,
  className,
}: {
  pct: number;
  size: "sm" | "lg";
  strokeWidth: number;
  className?: string;
}) {
  const tone = toneOf(pct);
  const c = size === "sm" ? C_SMALL : C_LARGE;
  const r = size === "sm" ? 8.5 : 17;
  const dims = size === "sm" ? 22 : 42;
  return (
    <svg
      width={dims}
      height={dims}
      viewBox={`0 0 ${dims} ${dims}`}
      className={className}
      aria-hidden="true"
    >
      <circle
        cx={dims / 2}
        cy={dims / 2}
        r={r}
        fill="none"
        stroke="var(--muted, #e7e5e4)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={dims / 2}
        cy={dims / 2}
        r={r}
        fill="none"
        stroke={STROKE[tone]}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(100, pct) / 100)}
        transform={`rotate(-90 ${dims / 2} ${dims / 2})`}
      />
    </svg>
  );
}

export interface ContextGaugeProps {
  /** Décomposition du tour ; null tant que les données ne sont pas prêtes. */
  usage: ContextUsage | null;
  /** Nombre de messages du fil (texte du dialogue de compaction). */
  historyCount: number;
  /** true si le fil est déjà compacté (résumé en tête de session). */
  historyCompacted: boolean;
  /** Compaction possible (conversation ouverte, ≥ 2 messages, tour au repos). */
  canCompact: boolean;
  /** Compaction en cours (synthèse LLM). */
  compactRunning: boolean;
  onCompact: () => void;
  onNewSession: () => void;
}

export function ContextGauge({
  usage,
  historyCount,
  historyCompacted,
  canCompact,
  compactRunning,
  onCompact,
  onNewSession,
}: ContextGaugeProps) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "compact" | "fresh">(null);

  if (!usage) return null;

  const pctInt = Math.round(usage.pct);
  const tone = toneOf(usage.pct);
  const historyRow = usage.rows.find((r) => r.key === "history");

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            title={`Contexte : ≈ ${formatK(usage.total)} / ${formatK(usage.windowTokens)} jetons`}
            aria-label={`Contexte : ${pctInt} % de la fenêtre utilisés. Ouvrir le détail`}
            className="relative h-9 w-[34px] shrink-0 rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <Ring pct={usage.pct} size="sm" strokeWidth={2} />
            {/* Le chiffre 8 px superposé à l'anneau est retiré (micro-texte
               illisible, audit P2.2) : l'info reste dans title, l'aria-label,
               le popover et la couleur de l'anneau. */}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="w-[352px] p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* En-tête : anneau + total + fenêtre */}
          <div className="flex items-center gap-3.5 px-4 pt-3.5 pb-2.5">
            <div className="relative flex shrink-0 items-center justify-center">
              <Ring pct={usage.pct} size="lg" strokeWidth={4.5} />
              <span
                className={`absolute text-[11px] font-bold ${TEXT_TONE[tone]}`}
              >
                {pctInt}%
              </span>
            </div>
            <div className="min-w-0">
              <div className="text-[15px] font-bold tracking-tight">
                ≈ {formatK(usage.total)} jetons
              </div>
              <div className="mt-px text-[11px] text-muted-foreground">
                fenêtre {usage.windowEstimated ? "estimée" : ""} :{" "}
                {formatK(usage.windowTokens)}
              </div>
            </div>
            {usage.windowEstimated ? (
              <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                estimation
              </span>
            ) : null}
          </div>

          {/* Postes réels du tour : part de fenêtre en % + poids en k */}
          <div className="px-4 pb-2 pt-1">
            {usage.rows.map((row) => {
              const rowPct = (row.tokens / usage.windowTokens) * 100;
              return (
                <div
                  key={row.key}
                  className="flex items-center gap-2.5 py-[4.5px]"
                >
                  <span className="w-[118px] shrink-0 text-[12.5px] leading-tight">
                    {row.label}
                    {row.sub ? (
                      <span className="block text-[11px] text-muted-foreground">
                        {row.sub}
                      </span>
                    ) : null}
                  </span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full min-w-[3px] rounded-full"
                      style={{
                        width: `${Math.max(0.4, rowPct)}%`,
                        background:
                          row.key === "history" && tone === "danger"
                            ? STROKE.danger
                            : "var(--hermes)",
                      }}
                    />
                  </span>
                  <span className="flex w-[54px] shrink-0 flex-col items-end text-right leading-tight tabular-nums">
                    <b className="text-[12.5px] font-semibold">
                      {formatPct(rowPct)}
                    </b>
                    <span className="text-[11px] text-muted-foreground">
                      {formatK(row.tokens)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          {/* Alerte au seuil rouge : l'information devient action */}
          {usage.pct >= 80 ? (
            <div
              className="mx-3 mb-2.5 flex items-start gap-2.5 rounded-xl bg-destructive/10 px-3 py-2.5 text-[12.5px]"
              role="status"
            >
              <TriangleAlert className="mt-px h-[15px] w-[15px] shrink-0 text-destructive" />
              Contexte presque plein — la qualité peut chuter avant la limite.
            </div>
          ) : null}

          {/* Actions : toujours disponibles, jamais automatiques */}
          <div className="flex gap-2 border-t border-border/60 px-3.5 py-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canCompact || compactRunning}
              onClick={() => setConfirm("compact")}
              className="h-8 flex-1 gap-1.5 rounded-md text-[12.5px] font-semibold"
            >
              {compactRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Minimize2 className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              {compactRunning ? "Compaction…" : "Compacter"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirm("fresh")}
              className="h-8 flex-1 gap-1.5 rounded-md text-[12.5px] font-semibold"
            >
              <MessageSquarePlus className="h-3.5 w-3.5 text-muted-foreground" />
              Nouvelle session
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Confirmations explicites (aucune action silencieuse) */}
      <AlertDialog open={confirm === "compact"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="max-w-[340px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-[15px]">
              <Minimize2 className="h-4 w-4 text-warning" />
              Compacter le contexte ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Hermes résume {historyCompacted ? "à nouveau " : ""}l&apos;historique (
              {historyCount} messages
              {historyRow ? ` · ≈ ${formatK(historyRow.tokens)} jetons` : ""}) en une
              synthèse conservée en tête de session. La conversation continue, dans la
              même session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(null);
                setOpen(false);
                onCompact();
              }}
            >
              Compacter
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "fresh"} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="max-w-[340px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-[15px]">
              <MessageSquarePlus className="h-4 w-4 text-warning" />
              Démarrer une nouvelle session ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Le contexte repart à zéro : instructions système et pièces jointes sont
              rechargées. La conversation actuelle reste dans l&apos;historique du dossier.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(null);
                setOpen(false);
                onNewSession();
              }}
            >
              Nouvelle session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default ContextGauge;
