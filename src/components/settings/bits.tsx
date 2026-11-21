// Petits composants partagés du volet Paramètres v4 : pastille d'état
// (langue unique d'état — vert silencieux, orange action, rouge cassé)
// et lien d'ajout « + … » (design/maquette-parametres-v4.html).
"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PastilleTone = "ok" | "warn" | "err" | "off" | "busy";

export function Pastille({
  tone,
  label,
  className,
  title,
}: {
  tone: PastilleTone;
  label?: string;
  className?: string;
  title?: string;
}) {
  const dot = {
    ok: "bg-success",
    warn: "bg-warning",
    err: "bg-destructive",
    off: "bg-border",
    // « busy » (maquette Système — « Vérification… ») : point animé.
    busy: "bg-hermes animate-pulse",
  }[tone];
  const text = {
    ok: "text-muted-foreground",
    warn: "text-warning",
    err: "text-destructive",
    off: "text-muted-foreground",
    busy: "text-muted-foreground",
  }[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex flex-none items-center gap-1.5 text-[11px] font-semibold whitespace-nowrap",
        text,
        className
      )}
    >
      <i className={cn("size-[7px] rounded-full", dot)} aria-hidden />
      {label}
    </span>
  );
}

export function AddLine({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        "inline-flex h-auto cursor-pointer items-center justify-start gap-2 px-0 py-0 text-[12.5px] font-semibold text-hermes-text transition-opacity hover:bg-transparent hover:opacity-75 focus-visible:outline-2 focus-visible:outline-hermes",
        className
      )}
    >
      <Plus className="size-[13px]" strokeWidth={2.5} />
      {children}
    </Button>
  );
}
