// Petits composants partagés du volet Paramètres v4 : pastille d'état
// (langue unique d'état — vert silencieux, orange action, rouge cassé)
// et lien d'ajout « + … » (design/maquette-parametres-v4.html).
"use client";

import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export type PastilleTone = "ok" | "warn" | "err" | "off";

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
    ok: "bg-emerald-500",
    warn: "bg-amber-500",
    err: "bg-red-500",
    off: "bg-border",
  }[tone];
  const text = {
    ok: "text-muted-foreground",
    warn: "text-amber-600 dark:text-amber-500",
    err: "text-red-600 dark:text-red-500",
    off: "text-muted-foreground",
  }[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex flex-none items-center gap-[6px] text-[11px] font-semibold whitespace-nowrap",
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
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-[7px] text-[12.5px] font-semibold text-hermes transition-opacity hover:opacity-75 focus-visible:outline-2 focus-visible:outline-hermes",
        className
      )}
    >
      <Plus className="size-[13px]" strokeWidth={2.5} />
      {children}
    </button>
  );
}
