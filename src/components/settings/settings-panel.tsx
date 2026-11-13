// Volet « Paramètres » v4 — remplace le sheet 460 px de la phase 1.
// Design de référence : design/maquette-parametres-v4.html (la maquette
// fait foi) : volet gauche ~860 px ancré (plein écran < 1100 px),
// navigation par rail, pastilles comme seule langue d'état, descriptions
// simples sous les libellés.
//
// Sections livrées : Interface (registres client, effet immédiat),
// Modèles (catalogue vivant du service), Fournisseurs / Clés de services
// (porte-clés, test réel) et Extensions (dépôts GitHub + serveurs).
// Les sections moteur (Outils, Skills, Hermes, Profils, Système)
// affichent leur structure cible sans données simulées (v2.3+).
"use client";

import { useEffect, useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTheme } from "next-themes";
import {
  Cpu,
  Database,
  KeyRound,
  Layers,
  Monitor,
  Package,
  Settings2,
  Sparkle,
  Sparkles,
  UserRound,
  Wrench,
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
import {
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
import type { ProvidersApi } from "@/hooks/use-providers";
import { ProvidersSection } from "@/components/settings/providers-section";
import { ExtensionsSection } from "@/components/settings/extensions-section";
import { cn } from "@/lib/utils";

// ── Libellés FR des valeurs brutes du registre (présentation seule) ──
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

// ── Les 10 sections du rail v4 ──────────────────────────────────────
const SECTIONS = [
  { id: "interface", icon: Monitor, label: "Interface" },
  { id: "modeles", icon: Cpu, label: "Modèles" },
  { id: "fournisseurs", icon: Layers, label: "Fournisseurs" },
  { id: "cles", icon: KeyRound, label: "Clés de services" },
  { id: "extensions", icon: Package, label: "Extensions" },
  { id: "outils", icon: Wrench, label: "Outils" },
  { id: "skills", icon: Sparkles, label: "Skills" },
  { id: "hermes", icon: Sparkle, label: "Hermes" },
  { id: "profils", icon: UserRound, label: "Profils" },
  { id: "systeme", icon: Settings2, label: "Système" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: GatewayMode | null;
  connected: boolean;
  /** Catalogue vivant (service) pour la ligne « Modèle de conversation ». */
  models: ModelOption[];
  /** Modèle sélectionné (état du hook, source de vérité côté chat). */
  selectedModel: string | null;
  projects: Project[];
  /** Fournisseurs & extensions (use-providers). */
  api: ProvidersApi;
  /** Version du service (hello) — pied du rail. */
  serverVersion?: string | null;
}

// ── Contrôle segmenté (fond muted, pilule active en relief) ──────────
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
            "cursor-pointer rounded-[7px] px-[9px] py-[5px] text-[11px] font-medium whitespace-nowrap text-muted-foreground transition-all hover:text-foreground",
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

// ── Une ligne de réglage : libellé + description à gauche, contrôle ──
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
        "flex flex-wrap items-center justify-between gap-x-7 gap-y-2 border-b border-border py-3 transition-opacity last:border-b-0",
        dim ? "opacity-55 hover:opacity-100" : undefined
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        {description ? (
          <div className="mt-px max-w-[480px] text-[12px] leading-snug text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// ── Section « à venir » (structure cible, aucune donnée simulée) ─────
function SoonPane({
  title,
  sub,
  items,
}: {
  title: string;
  sub: string;
  items: { name: string; desc: string }[];
}) {
  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">{title}</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
        {sub}
      </p>
      <div className="rounded-[14px] border border-dashed border-border px-4 py-1">
        {items.map((it, i) => (
          <div
            key={it.name}
            className={cn(
              "flex items-center gap-3 py-[11px]",
              i > 0 && "border-t border-border/60"
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">{it.name}</div>
              <div className="mt-px text-[11.5px] leading-snug text-muted-foreground">
                {it.desc}
              </div>
            </div>
            <span className="flex-none rounded-full bg-amber-500/12 px-2 py-0.5 text-[9.5px] font-semibold text-amber-600 dark:text-amber-500">
              à venir
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        Le contenu de cette section sera piloté par le schéma découvert du moteur
        (<code className="rounded bg-muted px-1 font-mono text-[10px]">settings:schema</code>) —
        en mode démo, le mini-service en simulera la surface complète (FORK.md §7.4).
      </p>
    </section>
  );
}

// ── Section Interface (registres client — effet immédiat) ────────────
function InterfacePane({ projects }: { projects: Project[] }) {
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
      <p className="mt-1 mb-5 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
        Le confort de cette interface — appliqué dès le clic.
      </p>

      <SettingRow
        label="Thème"
        description="L'apparence de l'interface, claire ou sombre."
      >
        <Segment
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
          <span className="w-[38px] flex-none text-right text-[11.5px] font-semibold tabular-nums text-hermes">
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
function ModelesPane({
  models,
  selectedModel,
}: {
  models: ModelOption[];
  selectedModel: string | null;
}) {
  const [rev, setRev] = useState(0);
  useEffect(() => onSettingsChanged(() => setRev((r) => r + 1)), []);

  const effort = useMemo(() => readClientSetting<string>("hermes.reasoning.effort"), [rev]);
  const effortOptions = useMemo(() => {
    const m = models.find((x) => x.id === selectedModel);
    const scale = m?.efforts?.length ? m.efforts : GENERIC_EFFORTS;
    return scale.map((v) => ({ value: v, label: EFFORT_LABELS[v] ?? v }));
  }, [models, selectedModel]);
  const activeEffort =
    effort && effortOptions.some((o) => o.value === effort) ? effort : null;

  const windowLabel = (m: ModelOption) => {
    if (!m.contextWindow) return m.provider;
    const cw = m.contextWindow;
    const w = cw >= 1e6 ? `${Math.round(cw / 1e6)}M` : `${Math.round(cw / 1000)}k`;
    return `${m.provider} · fenêtre ${w}`;
  };

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Modèles</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
        Qui répond, qui travaille en arrière-plan, et avec quel effort.
      </p>

      <SettingRow
        label="Modèle de conversation"
        description="Le modèle qui rédige les réponses — celui de la barre de saisie vaut pour la conversation en cours, ceci règle celui des nouvelles conversations."
      >
        <Select
          value={selectedModel ?? undefined}
          onValueChange={(id) => writeClientSetting("hermes.model", id)}
        >
          <SelectTrigger
            aria-label="Modèle de conversation"
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
                    {windowLabel(m)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        label="Effort de raisonnement"
        description="La profondeur de réflexion avant de répondre — les niveaux proposés dépendent du modèle choisi."
      >
        <Segment
          ariaLabel="Effort de raisonnement"
          options={effortOptions}
          value={activeEffort}
          onChange={(v) => writeClientSetting("hermes.reasoning.effort", v)}
        />
      </SettingRow>

      <p className="mt-6 flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
        <Database className="mt-[1px] size-[13px] flex-none" strokeWidth={2} />
        Le modèle d&apos;arrière-plan (travaux invisibles) et le modèle de secours
        arriveront avec la découverte du moteur (v2.3). La place dont Hermes dispose
        pour une conversation est détectée automatiquement — voir la section Hermes.
      </p>
    </section>
  );
}

// ── Le volet ─────────────────────────────────────────────────────────
export function SettingsPanel({
  open,
  onOpenChange,
  mode,
  connected,
  models,
  selectedModel,
  projects,
  api,
  serverVersion,
}: SettingsPanelProps) {
  const [section, setSection] = useState<SectionId>("interface");

  // Fermeture : la prochaine ouverture repart de la première section.
  const handleOpenChange = (next: boolean) => {
    if (!next) setSection("interface");
    onOpenChange(next);
  };

  // À l'ouverture : rafraîchit fournisseurs & extensions (données serveur).
  useEffect(() => {
    if (open) api.refresh();
  }, [open, api]);

  const isDemo = connected && mode === "demo";
  const extUpdate = api.extensions.some((e) => e.updateAvailable);

  const pane = () => {
    switch (section) {
      case "interface":
        return <InterfacePane projects={projects} />;
      case "modeles":
        return <ModelesPane models={models} selectedModel={selectedModel} />;
      case "fournisseurs":
        return <ProvidersSection kind="llm" api={api} />;
      case "cles":
        return <ProvidersSection kind="service" api={api} />;
      case "extensions":
        return <ExtensionsSection api={api} />;
      case "outils":
        return (
          <SoonPane
            title="Outils"
            sub="Ce qu'Hermes peut faire, outil par outil — les changements s'appliqueront au prochain message."
            items={[
              { name: "Recherche & lecture", desc: "recherche web (via Tavily, Exa…), navigateur, vision" },
              { name: "Création", desc: "génération d'images, vidéo, synthèse vocale" },
              { name: "Exécution & fichiers", desc: "terminal, fichiers, exécution de code" },
            ]}
          />
        );
      case "skills":
        return (
          <SoonPane
            title="Skills"
            sub="Des procédures réutilisables, cherchables, éditables dans ce volet."
            items={[
              { name: "Bibliothèque de skills", desc: "recherche, sources (dépôts importés ou locaux), activation" },
              { name: "Éditeur intégré", desc: "chaque skill s'ouvre et s'enregistre ici — effet au rechargement" },
              { name: "Contrôle qualité", desc: "dernière vérification et source, en langage clair" },
            ]}
          />
        );
      case "hermes":
        return (
          <SoonPane
            title="Hermes"
            sub="La mémoire, les fichiers de contexte et le comportement de l'agent."
            items={[
              { name: "Mémoire", desc: "MEMORY.md, USER.md — faits persistants, consultables et effaçables" },
              { name: "Fichiers .md", desc: "SOUL.md, AGENTS.md, AGENTS.override.md, CLAUDE.md — éditables" },
              { name: "Compaction & comportement", desc: "seuils de résumé, approbations d'écriture mémoire" },
            ]}
          />
        );
      case "profils":
        return (
          <SoonPane
            title="Profils"
            sub="Des préréglages complets — modèle, effort, permissions, skills — applicables en un clic."
            items={[
              { name: "Éditeur de profils", desc: "nom, modèle par défaut, effort, permissions, sélection de skills" },
              { name: "Appliquer / Dupliquer", desc: "effet immédiat via le bus client, sans dépendance moteur" },
            ]}
          />
        );
      case "systeme":
        return (
          <SoonPane
            title="Système"
            sub="Exécution, sauvegardes et mises à jour — moteur, interface, extensions."
            items={[
              { name: "Exécution", desc: "backend du terminal (local, docker, ssh), timeout, sandbox réseau" },
              { name: "Sauvegardes", desc: "snapshot avant mise à jour (rapide, complète, off)" },
              { name: "Mises à jour", desc: "moteur selon la gateway ; interface par recette git (FORK.md §10)" },
            ]}
          />
        );
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 flex h-dvh w-full flex-col overflow-hidden bg-card shadow-2xl outline-none min-[1100px]:w-[860px] min-[1100px]:rounded-r-[22px] min-[1100px]:border-r min-[1100px]:border-border data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=closed]:duration-300 data-[state=open]:duration-300"
        >
          <DialogPrimitive.Title className="sr-only">Paramètres</DialogPrimitive.Title>

          {/* ── Rail de sections ─────────────────────────────────────── */}
          <nav
            aria-label="Sections des paramètres"
            className="flex flex-none flex-col gap-2 border-border bg-background p-3 max-[1100px]:flex-row max-[1100px]:overflow-x-auto max-[1100px]:border-b min-[1100px]:w-[208px] min-[1100px]:border-r"
          >
            <div className="flex items-center gap-2 px-1 pb-1 max-[1100px]:hidden">
              <span className="flex size-[22px] items-center justify-center rounded-[7px] bg-hermes/10 text-hermes">
                <Sparkle className="size-[13px]" strokeWidth={2.2} />
              </span>
              <b className="text-[13px] font-semibold tracking-tight">Paramètres</b>
            </div>
            <div className="flex flex-col gap-0.5 max-[1100px]:flex-row max-[1100px]:gap-1">
              {SECTIONS.map(({ id, icon: Icon, label }) => {
                const active = id === section;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSection(id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex flex-none cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-hermes",
                      active && "bg-muted font-semibold text-foreground"
                    )}
                  >
                    <Icon className="size-[14px] flex-none" strokeWidth={2} />
                    <span className="whitespace-nowrap">{label}</span>
                    {id === "extensions" && extUpdate ? (
                      <i
                        className="ml-auto size-[7px] flex-none rounded-full bg-amber-500 max-[1100px]:ml-1"
                        title="Mise à jour disponible"
                        aria-label="Mise à jour disponible"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="mt-auto px-2 pt-2 text-[10.5px] whitespace-nowrap text-muted-foreground max-[1100px]:hidden">
              {isDemo ? (
                <span className="inline-flex items-center gap-1.5" title="Réponses simulées par le LLM intégré">
                  <i className="size-[6px] rounded-full bg-amber-500" aria-hidden />
                  mode démo
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5" title="Gateway Hermes connectée">
                  <i className="size-[6px] rounded-full bg-emerald-500" aria-hidden />
                  gateway
                </span>
              )}
              {serverVersion ? (
                <span className="block pt-0.5">service v{serverVersion}</span>
              ) : null}
            </div>
          </nav>

          {/* ── Contenu ──────────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-none justify-end px-5 pt-4 min-[1100px]:px-[34px]">
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  title="Fermer (Échap)"
                  aria-label="Fermer les paramètres"
                  className="flex size-[30px] cursor-pointer items-center justify-center rounded-[9px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-hermes"
                >
                  <X className="size-4" strokeWidth={2} />
                </button>
              </DialogPrimitive.Close>
            </div>

            <div
              key={section}
              className="min-h-0 flex-1 animate-in fade-in overflow-y-auto overscroll-contain px-5 pt-2 pb-8 duration-150 min-[1100px]:px-[34px] min-[1100px]:pt-0 min-[1100px]:pb-[70px]"
            >
              {pane()}
            </div>

            {/* Pied : état démo + modifications en attente (v4) */}
            <div className="flex flex-none items-center gap-2.5 border-t border-border bg-background px-5 py-[9px] min-[1100px]:px-[34px]">
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
              {api.pendingEngineCount > 0 ? (
                <span
                  title="Modifications moteur pas encore appliquées — pris en compte au prochain redémarrage"
                  className="ml-auto flex h-6 flex-none cursor-help items-center gap-[5px] rounded-full bg-hermes/10 px-2.5 text-[11px] font-semibold text-hermes"
                >
                  {api.pendingEngineCount} en attente
                </span>
              ) : null}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
