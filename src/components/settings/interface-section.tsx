// Section Interface — extraite de settings-panel.tsx (découpage 2026-11,
// FORK.md §10). Registres client à effet immédiat (thème, conversations
// par défaut, comportements de la sidebar). Contient SettingRow (ligne de
// réglage : libellé, description, contrôle à droite), partagée avec la
// section Modèles.
"use client";

import { useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { Segmented } from "@/components/shared/segmented";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { InfoTip } from "@/components/shared/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getSettingDef,
  onSettingsChanged,
  readClientSetting,
  writeClientSetting,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/chat-types";

// ── Libellés FR des valeurs brutes du registre (présentation seule) ──
const SORT_LABELS: Record<string, string> = {
  updated: "Récents",
  created: "Création",
  title: "Nom",
};

export function SettingRow({
  label,
  description,
  children,
  dim = false,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-7 gap-y-2 border-b border-border py-3 transition-opacity last:border-b-0",
        dim ? "opacity-55 hover:opacity-100" : undefined
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {description ? (
          <div className="mt-px max-w-[480px] text-[12.5px] leading-snug text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// ── Section Interface (registres client — effet immédiat) ────────────

export function InterfacePane({ projects }: { projects: Project[] }) {
  // Le volet ne s'ouvre que sur interaction (post-hydration) : la valeur
  // du thème est donc toujours résolue lorsque ce composant est rendu.
  const { theme, setTheme } = useTheme();
  const [rev, setRev] = useState(0);
  useEffect(() => onSettingsChanged(() => setRev((r) => r + 1)), []);

  const values = useMemo(() => {
    let collapsed: string[] = [];
    try {
      const arr = JSON.parse(readClientSetting<string>("fork.projects.collapsed"));
      if (Array.isArray(arr)) collapsed = arr.filter((x): x is string => typeof x === "string");
    } catch {
      /* valeur absente ou invalide */
    }
    return {
      width: readClientSetting<number>("fork.ui.sidebar.width"),
      sort: readClientSetting<string>("fork.projects.sort"),
      gauge: readClientSetting<boolean>("fork.context.gauge"),
      showReasoning: readClientSetting<boolean>("fork.ui.showReasoning"),
      collapsed,
    };
  }, [rev]);

  const collapsedSet = useMemo(() => new Set(values.collapsed), [values.collapsed]);
  const allCollapsed =
    projects.length > 0 && projects.every((p) => collapsedSet.has(p.id));

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Interface</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Le confort de cette interface — appliqué dès le clic.
      </p>

      <SettingRow
        label="Thème"
        description="L'apparence de l'interface, claire ou sombre."
      >
        <Segmented
          ariaLabel="Thème"
          options={[
            { value: "system", label: "Système" },
            { value: "light", label: "Clair" },
            { value: "dark", label: "Sombre" },
          ]}
          value={theme ?? "system"}
          onChange={setTheme}
        />
      </SettingRow>

      <SettingRow
        label={getSettingDef("fork.ui.sidebar.width")!.label}
        description="La colonne des conversations, à gauche de l'écran."
      >
        <div className="flex w-[196px] flex-none items-center gap-2.5">
          <Slider
            aria-label="Largeur de la colonne"
            value={[Math.min(34, Math.max(12, Math.round(values.width ?? 19)))]}
            min={12}
            max={34}
            step={1}
            onValueChange={([v]) => writeClientSetting("fork.ui.sidebar.width", v)}
            className="flex-1"
          />
          <span className="w-[38px] flex-none text-right text-[11px] font-semibold tabular-nums text-hermes-text">
            {Math.round(values.width ?? 19)} %
          </span>
        </div>
      </SettingRow>

      <SettingRow
        label="Ordre des projets"
        description="Les plus récents d'abord, ou par ordre de nom."
      >
        <Select
          value={values.sort}
          onValueChange={(v) => writeClientSetting("fork.projects.sort", v)}
        >
          <SelectTrigger
            aria-label="Ordre des projets"
            className="h-8 w-[150px] max-w-full rounded-md bg-background px-[11px] text-[12.5px] font-medium hover:border-hermes focus-visible:ring-hermes/50"
          >
            <SelectValue placeholder="Récents" />
          </SelectTrigger>
          <SelectContent>
            {(getSettingDef("fork.projects.sort")!.options ?? []).map((v) => (
              <SelectItem key={v} value={v}>
                {SORT_LABELS[v] ?? v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label="Dossiers repliés"
        description="Les dossiers de projets démarrent fermés."
        dim={projects.length === 0}
      >
        <Switch
          aria-label="Dossiers repliés"
          checked={allCollapsed}
          disabled={projects.length === 0}
          onCheckedChange={(on) =>
            writeClientSetting(
              "fork.projects.collapsed",
              JSON.stringify(on ? projects.map((p) => p.id) : [])
            )
          }
        />
      </SettingRow>

      <SettingRow
        label={getSettingDef("fork.context.gauge")!.label}
        description="Affiche, autour du bouton d'envoi, la place restante dans la conversation."
      >
        <Switch
          aria-label="Jauge de contexte"
          checked={values.gauge !== false}
          onCheckedChange={(on) => writeClientSetting("fork.context.gauge", on)}
        />
      </SettingRow>

      <SettingRow
        label={getSettingDef("fork.ui.showReasoning")!.label}
        description="Montre le cheminement du modèle avant chaque réponse."
      >
        <Switch
          aria-label="Afficher le raisonnement"
          checked={values.showReasoning !== false}
          onCheckedChange={(on) => writeClientSetting("fork.ui.showReasoning", on)}
        />
      </SettingRow>
    </section>
  );
}

// ── Section Modèles (catalogue vivant) ───────────────────────────────
