// Pastille d'état (cartes Système) — couleur par verdict.
import { cn } from "@/lib/utils";

export function Pastille({ tone, children }: { tone: "ok" | "busy" | "warn" | "err" | "off"; children?: React.ReactNode }) {
  const dot = {
    ok: "bg-success",
    busy: "bg-muted-foreground/60 animate-pulse",
    warn: "bg-warning",
    err: "bg-destructive",
    off: "bg-muted-foreground",
  }[tone];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold">
      <span className={cn("size-[7px] flex-none rounded-full", dot)} />
      {children}
    </span>
  );
}
