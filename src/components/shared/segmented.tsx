"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

/* Le segmenté unique du repo (audit passe 2 C1.3), désormais monté sur la
   primitive Tabs de Radix (shadcn) : navigation clavier native — flèches
   ←→ et Home/End, sélection au déplacement, une seule tabulation pour
   entrer dans le groupe (tabindex roving géré par Radix). Pilule active
   en relief avec le libellé d'accent AA, classes historiques conservées.
   L'API (ariaLabel, value nullable, classNameItem) ne change pas pour
   les usages existants du repo. Le focus vient de la règle globale
   *:focus-visible de globals.css — aucune exception locale. */
export function Segmented({
  ariaLabel,
  options,
  value,
  onChange,
  className,
  classNameItem,
}: SegmentedProps) {
  return (
    <Tabs
      /* Toujours contrôlé : la valeur vide ne correspond à aucune option, donc
         rien de coché — la 1re option reçoit le tab stop (roving Radix). */
      value={value ?? ""}
      onValueChange={onChange}
      className="flex-none gap-0"
    >
      <TabsList
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-auto flex-none justify-start gap-0.5 rounded-md bg-muted p-0.5",
          className
        )}
      >
        {options.map((o) => (
          <TabsTrigger
            key={o.value}
            value={o.value}
            className={cn(
              "h-auto flex-none cursor-pointer rounded-sm px-2 py-[5px] text-[11px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
              "data-[state=active]:bg-card data-[state=active]:font-semibold data-[state=active]:text-hermes-text data-[state=active]:shadow-sm",
              classNameItem
            )}
          >
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
