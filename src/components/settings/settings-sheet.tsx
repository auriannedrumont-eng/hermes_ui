// Sheet « Paramètres » — phase 1 (étage client) du chantier paramètres.
// Design de référence : design/maquette-parametres-v3.html (la maquette fait foi).
// FORK.md §7.4 : sheet overlay 460 px glissant depuis la droite (le chat reste
// visible), vue d'accueil = les réglages client des deux registres (effet
// immédiat via l'événement `hermes-ui:settings-changed`), porte « Paramètres
// moteur » en bas (10 sections, structure posée — contenu livré par les
// chantiers v2.2+, piloté par le schéma `settings:schema`).
//
// Aucune logique métier ici : les lignes rendent le registre `src/lib/settings.ts`
// (libellés + descriptions = tooltips « ? ») et écrivent via `writeClientSetting`.
"use client";

import { useEffect, useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileText,
  GitFork,
  KeyRound,
  Monitor,
  Plug,
  Settings,
  Settings2,
  Sparkles,
  Terminal,
  UserRound,
  X,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/settings/info-tip";
import {
  FORK_SETTINGS,
  HERMES_SETTINGS,
  getSettingDef,
  onSettingsChanged,
  readClientSetting,
  writeClientSetting,
} from "@/lib/settings";
import {
  GENERIC_EFFORTS,
  type GatewayMode,
  type ModelOption,
  type Project,
} from "@/lib/chat-types";
import { cn } from "@/lib/utils";

// ── Libellés FR des valeurs brutes du registre (présentation seule) ──────
const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  low: "Léger",
  medium: "Moyen",
  high: "Élevé",
  max: "Max",
  standard: "Standard",
  minimal: "Minimal",
};
const SORT_LABELS: Record<string, string> = {
  updated: "Récents",
  created: "Création",
  title: "Nom",
};
const PERMISSIONS_LABELS: Record<string, string> = {
  ask: "Demander",
  auto: "Auto",
};

// Réglages client internes (pas de ligne utilisateur dans le sheet).
const HIDDEN_CLIENT_KEYS = new Set(["hermes.models.favorites"]);

// ── Les 10 sections de l'étage moteur (v3) — structure posée, contenu v2.2+ ─
const ENGINE_SECTIONS: { icon: typeof Cpu; name: string; sub: string }[] = [
  { icon: Cpu, name: "Modèle & raisonnement", sub: "défauts moteur · fenêtre · modèle de secours" },
  { icon: KeyRound, name: "Fournisseurs & clés", sub: "porte-clés multi-clés · services d'API (Tavily, Exa…)" },
  { icon: GitFork, name: "Connecteurs", sub: "imports GitHub · vérifier, mettre à jour, épingler" },
  { icon: Terminal, name: "Outils", sub: "toolsets du moteur · modèle ou service associé" },
  { icon: Sparkles, name: "Skills", sub: "procédures .md · éditables dans le sheet" },
  { icon: Plug, name: "Serveurs MCP", sub: "outils externes · redémarrage averti" },
  { icon: Brain, name: "Mémoire", sub: "faits persistants · MEMORY.md, USER.md" },
  { icon: FileText, name: "Fichiers .md", sub: "SOUL.md, AGENTS.md, override, CLAUDE.md · éditables" },
  { icon: UserRound, name: "Profils", sub: "presets modèle · effort · permissions · skills" },
  { icon: Settings2, name: "Système", sub: "exécution, sauvegardes, mises à jour" },
];

type SettingsView = "home" | "engine";

interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: GatewayMode | null;
  connected: boolean;
  /** Catalogue vivant (service) pour la ligne « Modèle du chat ». */
  models: ModelOption[];
  /** Modèle sélectionné (état du hook, source de vérité côté chat). */
  selectedModel: string | null;
  projects: Project[];
  /** Modifications moteur pas encore appliquées (v2.2+ — caché à 0). */
  pendingEngineCount?: number;
}

// ── Contrôle segmenté (design v3 : fond muted, pilule active en relief) ──
function Segment({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: { value: string; label: string }[];
  value: string | null;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex flex-none gap-0.5 rounded-[9px] bg-muted p-[2.5px]"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "cursor-pointer whitespace-nowrap rounded-[7px] px-[9px] py-[5px] text-[11px] font-medium text-muted-foreground transition-all hover:text-foreground",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-hermes",
            o.value === value && "bg-card font-semibold text-hermes shadow-sm"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Une ligne de réglage : libellé (+ tooltip « ? ») à gauche, contrôle ────
function SettingRow({
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
        "px-4 py-[9px] transition-opacity hover:bg-muted/50",
        dim ? "opacity-55 hover:opacity-100" : undefined
      )}
    >
      <div className="flex flex-wrap items-center gap-[9px]">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-[7px] text-[13px] font-medium">
          {label}
          {description ? <InfoTip>{description}</InfoTip> : null}
        </span>
        {children}
      </div>
    </div>
  );
}

export function SettingsSheet({
  open,
  onOpenChange,
  mode,
  connected,
  models,
  selectedModel,
  projects,
  pendingEngineCount = 0,
}: SettingsSheetProps) {
  const [view, setView] = useState<SettingsView>("home");
  // Révision des réglages : chaque écriture (ici ou ailleurs) rafraîchit la lecture.
  const [rev, setRev] = useState(0);

  // Fermeture (Échap, overlay, croix) : la prochaine ouverture repart de la
  // vue d'accueil (maquette v3) — réinitialisé dans le handler, pas dans un effet.
  const handleOpenChange = (next: boolean) => {
    if (!next) setView("home");
    onOpenChange(next);
  };

  useEffect(() => {
    if (!open) return undefined;
    return onSettingsChanged(() => setRev((r) => r + 1));
  }, [open]);

  // ── Lecture des réglages client (registre = source de vérité) ─────────
  const values = useMemo(() => {
    let collapsed: string[] = [];
    try {
      const arr = JSON.parse(readClientSetting<string>("fork.projects.collapsed"));
      if (Array.isArray(arr)) collapsed = arr.filter((x): x is string => typeof x === "string");
    } catch {
      /* valeur absente ou invalide */
    }
    return {
      effort: readClientSetting<string>("hermes.reasoning.effort"),
      permissions: readClientSetting<string>("hermes.permissions.mode"),
      width: readClientSetting<number>("fork.ui.sidebar.width"),
      sort: readClientSetting<string>("fork.projects.sort"),
      gauge: readClientSetting<boolean>("fork.context.gauge"),
      collapsed,
    };
  }, [rev, open]);

  // Nombre de lignes client affichées (compteur de la section).
  const clientRowCount = useMemo(
    () =>
      [...HERMES_SETTINGS, ...FORK_SETTINGS].filter(
        (d) => d.scope === "client" && !HIDDEN_CLIENT_KEYS.has(d.key)
      ).length,
    []
  );

  // Échelle d'effort portée par le modèle sélectionné (cf. model-picker).
  const effortOptions = useMemo(() => {
    const m = models.find((x) => x.id === selectedModel);
    const scale = m?.efforts?.length ? m.efforts : GENERIC_EFFORTS;
    return scale.map((v) => ({ value: v, label: EFFORT_LABELS[v] ?? v }));
  }, [models, selectedModel]);
  const activeEffort =
    values.effort && effortOptions.some((o) => o.value === values.effort)
      ? values.effort
      : null;

  // « Dossiers repliés » : interrupteur dérivé de fork.projects.collapsed.
  const collapsedSet = useMemo(() => new Set(values.collapsed), [values.collapsed]);
  const allCollapsed =
    projects.length > 0 && projects.every((p) => collapsedSet.has(p.id));

  const isDemo = connected && mode === "demo";

  const head =
    view === "home"
      ? { title: "Paramètres", sub: "cette interface · effet immédiat", back: null }
      : {
          title: "Paramètres moteur",
          sub: `${ENGINE_SECTIONS.length} sections · appliquées par la gateway`,
          back: "Paramètres" as const,
        };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col overflow-hidden bg-card shadow-2xl outline-none sm:w-[460px] sm:border-l sm:border-border sm:rounded-l-[22px] data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:duration-300 data-[state=open]:duration-300"
        >
          {/* ── En-tête : retour + titre + fermeture ─────────────────────── */}
          <div className="flex flex-none items-center gap-[11px] border-b border-border px-4 py-[14px]">
            <button
              type="button"
              onClick={() => setView("home")}
              className={cn(
                "flex h-[29px] cursor-pointer items-center gap-[5px] rounded-[9px] pr-[9px] pl-1.5 text-[12px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                "focus-visible:outline-2 focus-visible:outline-hermes",
                !head.back && "hidden"
              )}
            >
              <ChevronLeft className="size-[13px]" strokeWidth={2.2} />
              {head.back}
            </button>
            <span className="flex size-[30px] flex-none items-center justify-center rounded-[10px] bg-hermes/10 text-hermes">
              <Settings className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-[15.5px] leading-tight font-semibold tracking-tight">
                {head.title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-px truncate text-[11px] text-muted-foreground">
                {head.sub}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                title="Fermer (Échap)"
                aria-label="Fermer les paramètres"
                className="flex size-[30px] flex-none cursor-pointer items-center justify-center rounded-[9px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-hermes"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </DialogPrimitive.Close>
          </div>

          {/* ── Corps défilant (vues) ───────────────────────────────────── */}
          <div key={view} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2.5 animate-in fade-in slide-in-from-right-1 duration-150">
            {view === "home" ? (
              <section>
                {/* Section « Cette interface » (réglages client, effet immédiat) */}
                <div className="flex items-center gap-[9px] px-4 pt-[15px] pb-[7px]">
                  <span className="flex size-[23px] flex-none items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <Monitor className="size-3" />
                  </span>
                  <h3 className="text-[13px] font-semibold tracking-tight">
                    Cette interface
                  </h3>
                  <span className="flex-none rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {clientRowCount}
                  </span>
                  <InfoTip below>
                    Réglages du navigateur, stockés localement (
                    <code className="rounded bg-background/15 px-1 font-mono text-[10px]">
                      hermes-ui:
                    </code>
                    ) — appliqués dès le clic, sans redémarrage.
                  </InfoTip>
                </div>

                {/* Modèle du chat — catalogue vivant du service */}
                <SettingRow
                  label={getSettingDef("hermes.model")!.label}
                  description={getSettingDef("hermes.model")!.description}
                >
                  <Select
                    value={selectedModel ?? undefined}
                    onValueChange={(id) => writeClientSetting("hermes.model", id)}
                  >
                    <SelectTrigger
                      aria-label="Modèle du chat"
                      className="h-8 w-[230px] max-w-full rounded-[10px] bg-background px-[11px] text-[12.5px] font-medium hover:border-hermes focus-visible:ring-hermes/50"
                    >
                      <SelectValue placeholder="Modèle du service" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[280px]">
                      {models.map((m) => (
                        <SelectItem key={m.id} value={m.id} className="py-2">
                          <span className="flex flex-col items-start gap-0.5">
                            <span className="text-[13px] font-medium">{m.label}</span>
                            <span className="font-mono text-[10.5px] text-muted-foreground">
                              {m.provider}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>

                {/* Effort de raisonnement — échelle portée par le modèle */}
                <SettingRow
                  label={getSettingDef("hermes.reasoning.effort")!.label}
                  description={getSettingDef("hermes.reasoning.effort")!.description}
                >
                  <Segment
                    ariaLabel="Effort de raisonnement"
                    options={effortOptions}
                    value={activeEffort}
                    onChange={(v) => writeClientSetting("hermes.reasoning.effort", v)}
                  />
                </SettingRow>

                {/* Permissions d'actions */}
                <SettingRow
                  label={getSettingDef("hermes.permissions.mode")!.label}
                  description={getSettingDef("hermes.permissions.mode")!.description}
                >
                  <Segment
                    ariaLabel="Permissions d'actions"
                    options={(getSettingDef("hermes.permissions.mode")!.options ?? ["ask", "auto"]).map(
                      (v) => ({ value: v, label: PERMISSIONS_LABELS[v] ?? v })
                    )}
                    value={values.permissions}
                    onChange={(v) => writeClientSetting("hermes.permissions.mode", v)}
                  />
                </SettingRow>

                {/* Largeur de la sidebar — application immédiate (resize du panneau) */}
                <SettingRow
                  label={getSettingDef("fork.ui.sidebar.width")!.label}
                  description={getSettingDef("fork.ui.sidebar.width")!.description}
                >
                  <div className="flex w-[196px] flex-none items-center gap-2.5">
                    <Slider
                      aria-label="Largeur de la sidebar"
                      value={[Math.min(34, Math.max(12, Math.round(values.width ?? 19)))]}
                      min={12}
                      max={34}
                      step={1}
                      onValueChange={([v]) =>
                        writeClientSetting("fork.ui.sidebar.width", v)
                      }
                      className="flex-1"
                    />
                    <span className="w-[38px] flex-none text-right text-[11.5px] font-semibold tabular-nums text-hermes">
                      {Math.round(values.width ?? 19)} %
                    </span>
                  </div>
                </SettingRow>

                {/* Tri des projets */}
                <SettingRow
                  label={getSettingDef("fork.projects.sort")!.label}
                  description={getSettingDef("fork.projects.sort")!.description}
                >
                  <Select
                    value={values.sort}
                    onValueChange={(v) => writeClientSetting("fork.projects.sort", v)}
                  >
                    <SelectTrigger
                      aria-label="Tri des projets"
                      className="h-8 w-[150px] max-w-full rounded-[10px] bg-background px-[11px] text-[12.5px] font-medium hover:border-hermes focus-visible:ring-hermes/50"
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

                {/* Dossiers de projet repliés — dérivé de fork.projects.collapsed */}
                <SettingRow
                  label={getSettingDef("fork.projects.collapsed")!.label}
                  description={getSettingDef("fork.projects.collapsed")!.description}
                  dim={projects.length === 0}
                >
                  <Switch
                    aria-label="Dossiers de projet repliés"
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

                {/* Jauge de contexte */}
                <SettingRow
                  label={getSettingDef("fork.context.gauge")!.label}
                  description={getSettingDef("fork.context.gauge")!.description}
                >
                  <Switch
                    aria-label="Jauge de contexte"
                    checked={values.gauge !== false}
                    onCheckedChange={(on) => writeClientSetting("fork.context.gauge", on)}
                  />
                </SettingRow>

                {/* ── Porte de l'étage moteur (drill-down v3) ─────────────── */}
                <button
                  type="button"
                  onClick={() => setView("engine")}
                  className="mx-4 mt-[14px] mb-2 flex w-[calc(100%-2rem)] cursor-pointer items-center gap-2.5 rounded-[14px] border-[1.5px] border-dashed border-hermes/50 px-[13px] py-3 text-left transition-colors hover:border-hermes hover:bg-hermes/10 focus-visible:outline-2 focus-visible:outline-hermes"
                >
                  <span className="flex size-[28px] flex-none items-center justify-center rounded-[10px] bg-muted">
                    <Cpu className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">
                      Paramètres moteur
                    </span>
                    <span className="mt-px block text-[10.5px] leading-snug text-muted-foreground">
                      gérés par la gateway · {ENGINE_SECTIONS.length} sections
                    </span>
                  </span>
                  <ChevronRight className="size-[15px] flex-none text-hermes" strokeWidth={2.2} />
                </button>
              </section>
            ) : (
              <section>
                {ENGINE_SECTIONS.map(({ icon: Icon, name, sub }) => (
                  <div
                    key={name}
                    className="flex items-center gap-[11px] border-b border-border/60 px-4 py-[11px] last:border-b-0"
                  >
                    <span className="flex size-[27px] flex-none items-center justify-center rounded-[9px] bg-muted">
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold">{name}</span>
                      <span className="mt-px block truncate text-[11px] text-muted-foreground">
                        {sub}
                      </span>
                    </span>
                    <span className="flex-none rounded-full bg-amber-500/12 px-2 py-0.5 text-[9.5px] font-semibold text-amber-600 dark:text-amber-500">
                      à venir
                    </span>
                  </div>
                ))}
                <p className="px-4 pt-3 pb-1 text-[11px] leading-relaxed text-muted-foreground">
                  Sections livrées progressivement (FORK.md §7.4) : leur contenu sera
                  piloté par le schéma <code className="rounded bg-muted px-1 font-mono text-[10px]">settings:schema</code>{" "}
                  exposé par la gateway — en mode démo, le mini-service en simulera la
                  surface complète.
                </p>
              </section>
            )}
          </div>

          {/* ── Pied de sheet : état démo + modifications en attente ────── */}
          <div className="flex flex-none items-center gap-2.5 border-t border-border bg-background px-4 py-[9px]">
            {isDemo ? (
              <div className="group relative flex min-w-0 cursor-help items-center gap-[7px] text-[11.5px] text-muted-foreground">
                <span className="size-[7px] flex-none rounded-full bg-amber-500" />
                <span className="truncate">Mode démo</span>
                <span className="pointer-events-none absolute bottom-full left-0 mb-2 w-max max-w-[260px] rounded-[10px] bg-foreground px-[11px] py-2 text-left text-[11px] leading-relaxed text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                  Réponses simulées par le LLM intégré. Une fois la gateway Hermes
                  branchée, cette pastille disparaît et les sections moteur
                  s&apos;activent.
                </span>
              </div>
            ) : (
              <span className="min-w-0" />
            )}
            {pendingEngineCount > 0 ? (
              <span
                title="Modifications moteur pas encore appliquées"
                className="ml-auto flex h-6 flex-none items-center gap-[5px] cursor-help rounded-full bg-hermes/10 px-2.5 text-[11px] font-semibold text-hermes"
              >
                {pendingEngineCount} en attente
              </span>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
