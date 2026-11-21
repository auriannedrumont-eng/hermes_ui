// Menu de commandes slash — extrait de composer.tsx (découpage 2026-11,
// FORK.md §10). Rendu pur : la liste des modèles de prompt filtrés, la
// navigation clavier (index), la sélection à la souris. Lot 5 (conservé) :
// Échap ferme le menu sans modifier le texte.
"use client";

import { Button } from "@/components/ui/button";
import type { PromptTemplate } from "@/lib/prompt-library";

export function SlashMenu({
  matches,
  slashIndex,
  onPick,
}: {
  matches: PromptTemplate[];
  slashIndex: number;
  onPick: (tpl: PromptTemplate) => void;
}) {
  return (
    <div className="absolute bottom-full left-3 z-20 mb-2 w-[min(92%,26rem)] overflow-hidden rounded-xl border border-border bg-card shadow-lg">
      <ul className="max-h-60 overflow-y-auto p-1">
        {matches.map((tpl, i) => (
          <li key={tpl.slash}>
            <Button
              variant="ghost"
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(tpl)}
              className={`flex h-auto w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left font-normal leading-normal transition-colors ${
                i === slashIndex ? "bg-muted/70" : "hover:bg-muted/50"
              }`}
            >
              <span className="shrink-0 rounded-md bg-hermes/10 px-1.5 py-0.5 font-mono text-[12.5px] font-medium text-hermes-text">
                /{tpl.slash}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium">{tpl.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {tpl.description}
                </span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
