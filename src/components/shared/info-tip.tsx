// Tooltip « ? » des réglages (design maquette v3 — design/maquette-parametres-v3.html),
// désormais monté sur la primitive Tooltip de Radix (shadcn) : positionnement et
// détection de collision du content par Radix (Portal), survol / focus clavier
// natifs. Comportements historiques conservés : bouton focusable, tap = bascule
// sur mobile avec un seul tooltip ouvert à la fois, Échap capturé pour ne pas
// refermer le sheet parent. Le contenu vient de la `description` du registre
// (FORK.md §6) — 2-3 phrases max, jamais de note inline dans la ligne.
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Referme le tooltip actuellement ouvert en mode « tap » (un seul à la fois). */
let closeOpenTip: (() => void) | null = null;

interface InfoTipProps {
  children: ReactNode;
  /** Ouvre vers le bas (utilisé près du bord haut du sheet). */
  below?: boolean;
  className?: string;
}

export function InfoTip({ children, below = false, className }: InfoTipProps) {
  const [open, setOpen] = useState(false);

  // Mode « tap » (mobile) : referme à Échap — en capture, pour que le sheet
  // (Radix) ne se referme pas avec le tooltip. La fermeture au clic extérieur
  // et à la perte de focus vient de Radix (onOpenChange).
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    closeOpenTip = close;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      if (closeOpenTip === close) closeOpenTip = null;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Plus d'informations"
          className={cn(
            "group relative inline-flex h-4 w-4 shrink-0 cursor-help select-none items-center justify-center rounded-full border border-border bg-card align-middle text-[11px] font-bold leading-none text-muted-foreground transition-colors",
            "hover:border-hermes hover:text-hermes-text focus-visible:border-hermes focus-visible:text-hermes-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hermes",
            open && "border-hermes text-hermes-text",
            className
          )}
          onClick={(e) => {
            e.stopPropagation();
            if (open) {
              setOpen(false);
            } else {
              closeOpenTip?.(); // un seul popover ouvert à la fois
              setOpen(true);
            }
          }}
        >
          ?
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={below ? "bottom" : "top"}
        sideOffset={9}
        className="w-max max-w-[250px] rounded-md bg-foreground px-[11px] py-2 text-left text-[11px] font-normal leading-relaxed text-background shadow-lg [&>svg]:fill-foreground"
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
