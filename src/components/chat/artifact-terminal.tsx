// Encart terminal du panneau artefacts : l'activité outil du tour qui a produit
// l'artefact affiché. Barre fine repliée par défaut — un tour vivant l'ouvre
// seul (un repli manuel est respecté) ; sans activité, pas d'encart du tout.
"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  Terminal,
} from "lucide-react";
import type { ToolEvent } from "@/lib/chat-types";

function heure(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function LigneOutil({ event }: { event: ToolEvent }) {
  return (
    <div className="flex items-start gap-2 px-3 py-1 font-mono text-[11.5px] leading-relaxed">
      {event.status === "running" ? (
        <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-zinc-400" />
      ) : event.status === "error" ? (
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-red-400" />
      ) : (
        <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
      )}
      <span className="shrink-0 text-zinc-500">{heure(event.at)}</span>
      <span className="shrink-0 text-zinc-200">{event.name}</span>
      {event.detail ? (
        <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-zinc-400">
          {event.detail}
        </span>
      ) : null}
    </div>
  );
}

export function ArtifactTerminal({
  events,
  live,
}: {
  events: ToolEvent[];
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** L'utilisateur a replié lui-même : ne pas rouvrir tant que le tour vit. */
  const [repliManuel, setRepliManuel] = useState(false);
  /** Mémorise le passage du tour en vivant (ajustement pendant le rendu). */
  const [vuVivant, setVuVivant] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Un tour vivant ouvre l'encart tout seul — le tour terminé ne le bouge plus.
  // (idiome React « état dérivé pendant le rendu », comme le panneau voisin)
  if (live && !vuVivant) {
    setVuVivant(true);
    if (!repliManuel) setOpen(true);
  }

  // Défilement collé en bas à chaque nouvelle étape.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && open) el.scrollTop = el.scrollHeight;
  }, [events.length, open]);

  if (events.length === 0 && !live) return null;

  return (
    <div className="shrink-0 border-t border-border/60">
      <button
        onClick={() => {
          setRepliManuel(true);
          setOpen((o) => !o);
        }}
        className="flex h-8 w-full items-center gap-2 bg-muted/30 px-3 text-[12px] text-muted-foreground transition-colors hover:bg-muted/50"
        aria-expanded={open}
        title={open ? "Replier le terminal" : "Déplier le terminal"}
      >
        <Terminal className="h-3.5 w-3.5 shrink-0 text-hermes-text" />
        <span>Terminal</span>
        {live ? (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
            aria-hidden="true"
          />
        ) : (
          <span className="text-[11px]">
            {events.length} étape{events.length > 1 ? "s" : ""}
          </span>
        )}
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open ? (
        <div ref={scrollRef} className="max-h-44 overflow-y-auto bg-[#0d1117]">
          {events.length === 0 ? (
            <p className="px-3 py-2 font-mono text-[11.5px] text-zinc-500">
              Hermes travaille…
            </p>
          ) : (
            events.map((ev, i) => (
              <LigneOutil key={`${ev.at}-${ev.name}-${i}`} event={ev} />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
