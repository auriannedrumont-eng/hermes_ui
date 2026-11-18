// Déroulé d'un tour multi-voix (F-30) — l'encart qui vit dans la conversation,
// au-dessus de la réponse conservée : tours du débat, membres du conseil,
// étapes de l'auto, reprises. Design de référence : design/maquette-modes.html
// scènes C et D. Une seule réponse reste enregistrée — le déroulé ne sert
// qu'à voir le travail se faire (rôle + extrait + modèle par ligne).
"use client";

import { Check, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModeFlowRow } from "@/lib/chat-types";
import { modeDef, type ConversationMode } from "@/lib/modes";

interface ModeFlowCardProps {
  mode: string;
  /** Ligne de titre (« 3 conseillers · 3 tours », « 3 membres en parallèle »…). */
  summary: string;
  rows: ModeFlowRow[];
  /** Le déroulé est encore vivant (point pulsant, statut « déroule… »). */
  live?: boolean;
  /** Les modèles apparaissent à côté de chaque voix (hermes.modes.showModels). */
  showModels?: boolean;
}

export function ModeFlowCard({
  mode,
  summary,
  rows,
  live = false,
  showModels = true,
}: ModeFlowCardProps) {
  const def = modeDef(mode as ConversationMode);
  return (
    <div
      className="mb-2 max-w-[82%] overflow-hidden rounded-2xl border border-border bg-card"
      aria-label={`Déroulé du mode ${def.label}`}
    >
      <div className="flex items-center gap-2 bg-muted px-3 py-2 text-[12.5px] font-semibold">
        <span className="rounded-full bg-hermes/10 px-2 py-px text-[11px] font-bold text-hermes-text">
          {def.label}
        </span>
        <span className="truncate">{summary}</span>
        {live ? (
          <span className="ml-auto inline-flex flex-none items-center gap-1.5 text-[11px] font-semibold text-hermes-text">
            <Loader2 className="h-3 w-3 animate-spin" />
            déroule…
          </span>
        ) : null}
      </div>
      <div>
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[12.5px] first:border-t-0"
          >
            <span className="flex-none font-semibold">{row.label}</span>
            {showModels && row.model ? (
              <span
                className="flex-none rounded-full bg-hermes/10 px-1.5 py-px text-[11px] font-bold tracking-wide text-hermes-text"
                title={`Modèle de cette voix : ${row.model}`}
              >
                {row.model}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {row.detail}
            </span>
            <span
              className={cn(
                "flex-none text-[11px] font-semibold",
                row.status === "done" && "text-success",
                row.status === "running" && "text-hermes-text",
                row.status === "error" && "text-destructive",
                row.status === "pending" && "text-muted-foreground"
              )}
            >
              {row.status === "running" ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> en cours
                </span>
              ) : row.status === "done" ? (
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3 w-3" /> terminé
                </span>
              ) : row.status === "error" ? (
                <span className="inline-flex items-center gap-1">
                  <TriangleAlert className="h-3 w-3" /> échec
                </span>
              ) : (
                "en attente"
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Étiquette du mode sur la réponse conservée (« Verdict · Débat — 3 tours »). */
export function ModeTag({ tag }: { tag: string }) {
  return (
    <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-hermes/10 px-2.5 py-0.5 text-[11px] font-bold text-hermes-text">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2l2.9 6.26L21.5 9.3l-4.75 4.87L17.8 21 12 17.77 6.2 21l1.05-6.83L2.5 9.3l6.6-1.04z" />
      </svg>
      {tag}
    </span>
  );
}

/** Le mode d'un déroulé persisté, retrouvé depuis son étiquette
 *  (« Verdict · Débat… » → debate, « Fusion · Conseil… » → council).
 *  Fallback paramétrable (F-30) : pendant le streaming du verdict d'un
 *  débat, message.modeTag n'existe pas encore — retomber sur le mode de
 *  la CONVERSATION (l'ancien « council » strict affichait le badge
 *  « Conseil » sur le verdict d'un débat). */
export function modeFromTag(
  tag?: string | null,
  fallback: ConversationMode = "council"
): ConversationMode {
  if (!tag) return fallback;
  if (tag.includes("Débat")) return "debate";
  if (tag.includes("Conseil")) return "council";
  if (tag.includes("Auto")) return "auto";
  return fallback;
}

/** Ligne de titre du déroulé — l'état du service, dit simplement
 *  (« 3 conseillers · 3 tours », « 3 membres en parallèle »…). */
export function modeFlowSummary(mode: ConversationMode, rows: ModeFlowRow[]): string {
  const done = rows.filter((r) => r.status === "done").length;
  switch (mode) {
    case "debate":
      // F-30 : le débat se terminait sur « tours en cours » même une fois
      // toutes les voix terminées.
      return rows.length > 0 && done === rows.length
        ? "3 conseillers · terminé"
        : "3 conseillers · tours en cours";
    case "council":
      return `${rows.filter((r) => r.id.startsWith("membre")).length || 3} membres en parallèle`;
    case "auto":
      return `débat → plan → code → test · ${done}/${rows.length} étapes`;
    default:
      return "";
  }
}
