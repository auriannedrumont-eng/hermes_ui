"use client";

// Panneau Paramètres — navigation Système / Stockage (v0.3.0).
// Le lien profond ?section=stockage&projet=… n'ouvre le groupe qu'une
// fois (600 ms) : l'état d'interface n'est PAS persisté (spec §4.3).
import { useCallback, useEffect, useState } from "react";
import { Settings, Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHermesChat } from "@/hooks/use-hermes-chat";
import { SystemSection } from "@/components/settings/system-section";
import { StorageSection } from "@/components/settings/storage-section";

type SectionKey = "systeme" | "stockage";

/** Lien profond consommé une fois : le paramètre disparaît après l'entrée. */
function readDeepLink(): { section: SectionKey; projet: string | null } {
  if (typeof window === "undefined") return { section: "systeme", projet: null };
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  const projet = params.get("projet");
  return {
    section: section === "stockage" ? "stockage" : "systeme",
    projet: projet ? decodeURIComponent(projet) : null,
  };
}

export function SettingsPanel() {
  const [section, setSection] = useState<SectionKey>("systeme");
  const [lienProfond, setLienProfond] = useState<{ projet: string | null } | null>(null);
  const { connected } = useHermesChat();

  // Entrée : consommer le lien profond UNE fois, puis l'oublier (§4.3 —
  // les navigations suivantes repartent du repli par défaut).
  useEffect(() => {
    const dl = readDeepLink();
    setSection(dl.section);
    if (dl.section === "stockage" && dl.projet) {
      setLienProfond({ projet: dl.projet });
      // Nettoyage de l'URL : le paramètre ne doit pas survivre à un
      // rechargement (l'état d'interface n'est pas persisté).
      window.history.replaceState(null, "", window.location.pathname);
    }
    return () => {
      setLienProfond(null);
    };
  }, []);

  const goto = useCallback((s: SectionKey) => setSection(s), []);

  return (
    <div className="flex min-h-screen">
      {/* Rail latéral : Paramètres (Système) + Stockage */}
      <nav className="sticky top-0 hidden h-screen w-[220px] flex-none flex-col border-r border-border bg-card px-3 py-4 md:flex" aria-label="Navigation Paramètres">
        <div className="flex items-center gap-2.5 px-2.5 pb-4">
          <span className="grid size-[26px] flex-none place-items-center rounded-sm bg-hermes text-[12px] font-bold text-hermes-foreground">
            H
          </span>
          <b className="text-[14px] tracking-tight">Hermes</b>
          <span className="ml-auto rounded-full bg-hermes-soft px-2 py-0.5 text-[10px] font-bold text-hermes-text">
            0.3.0
          </span>
        </div>
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          <button
            type="button"
            onClick={() => goto("systeme")}
            aria-current={section === "systeme" ? "page" : undefined}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors",
              section === "systeme"
                ? "bg-hermes-soft font-semibold text-hermes-text"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Settings className="size-[15px] flex-none" strokeWidth={2} />
            Système
          </button>
          <button
            type="button"
            onClick={() => goto("stockage")}
            aria-current={section === "stockage" ? "page" : undefined}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors",
              section === "stockage"
                ? "bg-hermes-soft font-semibold text-hermes-text"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Archive className="size-[15px] flex-none" strokeWidth={2} />
            Stockage
          </button>
        </div>
        <div className="border-t border-border px-2.5 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          Hermes Web — l&apos;agent local garde vos documents.
        </div>
      </nav>

      {/* Corps : la section active */}
      <main className="min-w-0 flex-1">
        <div className="px-6 py-6 pb-20 md:px-8">
          {section === "systeme" ? (
            <SystemSection connected={connected} onNavigateStorage={() => goto("stockage")} />
          ) : (
            <StorageSection initialProject={lienProfond?.projet ?? null} />
          )}
        </div>
      </main>
    </div>
  );
}
