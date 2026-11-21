// Jauge de jetons & coût (F-21) — extrait de message-bubble.tsx (découpage
// 2026-11, FORK.md §10). Repliable, sous chaque réponse assistant.
// Jetons réels quand l'API les renvoie (pool de clés), estimation de la sortie
// sinon. Coût : facturé par le fournisseur s'il le renvoie (OpenRouter),
// sinon estimé à partir des tarifs déclarés dans le volet Modèles — jamais
// deviné : sans tarifs, on le dit.
"use client";

import { memo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { estimateTokens } from "@/lib/tokens";
import { estimateCost, formatTokens, formatUsd, parseModelLabel } from "@/lib/pricing";
import { useModelPricing } from "@/hooks/use-pricing";
import type { ChatMessage } from "@/lib/chat-types";

// Perf 2026-11-19 : mémoïsée — estimateTokens (boucle caractère par
// caractère) ne recalculait que à chaque re-rendu du fil ; un message
// persisté ne change plus jamais, la ligne saute la réconciliation.
export const UsageRow = memo(function UsageRow({ message }: { message: ChatMessage }) {
  const pricing = useModelPricing();
  const [open, setOpen] = useState(false);
  const usage = message.usage;
  const modelInfo = parseModelLabel(message.model);
  const modelPricing = modelInfo ? pricing[modelInfo.id] : undefined;

  const real = usage != null;
  const input = usage?.input;
  const output = usage?.output ?? estimateTokens(message.content);
  const total = (input ?? 0) + output;

  // Revue 2026-11-19, M-12 (C) : le coût estimé doit partir des valeurs
  // RÉCONCILIÉES. Avant, `estimateCost` recevait l'usage brut : un
  // fournisseur qui renvoie `usage` sans `output` affichait des jetons
  // de sortie estimés (repli ci-dessus) mais un coût calculé sur les
  // seuls jetons d'entrée — voire 0 $ — information financière fausse.
  const cost = usage?.cost ?? (real ? estimateCost({ input: input ?? 0, output }, modelPricing) : null);
  const costBasis: "facturé" | "estimé" | null =
    usage?.cost != null ? "facturé" : cost != null ? "estimé" : null;

  const summary = [
    real ? `${formatTokens(total)} jetons` : `≈ ${formatTokens(output)} jetons (estimation)`,
    costBasis === "facturé"
      ? `facturé ${formatUsd(cost!)}`
      : costBasis === "estimé"
        ? `≈ ${formatUsd(cost!)}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="pt-0.5 text-[11px] text-muted-foreground">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-ml-1 flex h-auto items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-normal transition-colors hover:text-foreground"
      >
        <ChevronDown
          className={`size-3 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
        <span className="tabular-nums">{summary}</span>
      </Button>
      {open ? (
        <div className="ml-4 mt-1.5 grid max-w-[420px] gap-1 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 leading-relaxed">
          <div className="flex justify-between gap-6">
            <span>Jetons d&apos;entrée</span>
            <span className="tabular-nums">{input != null ? formatTokens(input) : "— (non renvoyé)"}</span>
          </div>
          <div className="flex justify-between gap-6">
            <span>Jetons de sortie</span>
            <span className="tabular-nums">
              {usage?.output != null
                ? formatTokens(usage.output)
                : `≈ ${formatTokens(output)} (estimation)`}
            </span>
          </div>
          <div className="mt-0.5 flex justify-between gap-6 border-t border-border/60 pt-1">
            <span>Coût</span>
            <span className="tabular-nums">
              {costBasis === "facturé"
                ? `${formatUsd(cost!)} (facturé par le fournisseur)`
                : costBasis === "estimé"
                  ? `≈ ${formatUsd(cost!)} (selon vos tarifs)`
                  : "tarifs non renseignés — Paramètres → Modèles"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
});