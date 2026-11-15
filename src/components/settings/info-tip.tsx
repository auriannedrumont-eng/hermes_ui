// Tooltip « ? » des réglages (design maquette v3 — design/maquette-parametres-v3.html).
// Bouton focusable : survol / focus clavier ouvrent le popover, tap = bascule sur
// mobile (un seul popover ouvert à la fois). Le contenu vient de la `description`
// du registre (FORK.md §6) — 2-3 phrases max, jamais de note inline dans la ligne.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
  const ref = useRef<HTMLButtonElement>(null);

  // Mode « tap » (mobile) : referme au clic extérieur ou à Échap.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    closeOpenTip = close;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture : le sheet (Radix) ne doit pas se refermer avec le tooltip.
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      if (closeOpenTip === close) closeOpenTip = null;
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <button
      ref={ref}
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
      onBlur={() => setOpen(false)}
    >
      ?
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-[70] w-max max-w-[250px] -translate-x-1/2 rounded-md bg-foreground px-[11px] py-2 text-left text-[11px] font-normal leading-relaxed text-background opacity-0 shadow-lg transition-[opacity,transform] duration-150",
          "after:absolute after:left-1/2 after:-translate-x-1/2 after:border-5 after:border-transparent after:content-['']",
          below
            ? "after:bottom-full after:border-b-foreground top-[calc(100%+9px)] -translate-y-1 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100"
            : "after:top-full after:border-t-foreground bottom-[calc(100%+9px)] translate-y-1 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100",
          open && "pointer-events-auto translate-y-0 opacity-100"
        )}
      >
        {children}
      </span>
    </button>
  );
}
