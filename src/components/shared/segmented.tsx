"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption {
  value: string;
  label: string;
}

type SegmentedProps = {
  ariaLabel: string;
  options: SegmentedOption[];
  /** Valeur sélectionnée ; null/absente = rien de coché (1re option tabbable). */
  value: string | null;
  onChange: (value: string) => void;
  className?: string;
  classNameItem?: string;
};

/* Le segmenté unique du repo (audit passe 2 C1.3) : un radiogroup accessible —
   flèches ←↑↓→ pour naviguer (sélection au déplacement, comme un vrai radio),
   une seule tabulation pour entrer dans le groupe (tabindex roving), pilule
   active en relief avec le libellé d'accent AA. Le focus vient de la règle
   globale *:focus-visible de globals.css — aucune exception locale. */
export function Segmented({
  ariaLabel,
  options,
  value,
  onChange,
  className,
  classNameItem,
}: SegmentedProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIdx = options.findIndex((o) => o.value === value);
  const tabbableIdx = selectedIdx >= 0 ? selectedIdx : 0;

  const move = (next: number) => {
    const i = (next + options.length) % options.length;
    refs.current[i]?.focus();
    onChange(options[i].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex flex-none gap-0.5 rounded-md bg-muted p-0.5", className)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(tabbableIdx === selectedIdx ? selectedIdx + 1 : tabbableIdx);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(tabbableIdx === selectedIdx ? selectedIdx - 1 : tabbableIdx - 1);
        }
      }}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={i === tabbableIdx ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "cursor-pointer rounded-sm px-2 py-[5px] text-[11px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
              selected && "bg-card font-semibold text-hermes-text shadow-sm",
              classNameItem
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
