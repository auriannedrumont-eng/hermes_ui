// Volet « Paramètres » v4 — remplace le sheet 460 px de la phase 1.
// Design de référence : design/maquette-parametres-v4.html (la maquette
// fait foi) : volet gauche ~860 px ancré (plein écran < 1100 px),
// navigation par rail, pastilles comme seule langue d'état, descriptions
// simples sous les libellés.
//
// Sections livrées : Interface (registres client, effet immédiat),
// Modèles (catalogue vivant du service + tarifs), Fournisseurs / Clés de
// services (porte-clés, test réel), Extensions (dépôts GitHub + serveurs),
// Hermes (presets + instructions + mémoire + conversations longues) et
// — v2.4 — Outils, Skills, Profils, Système (statuts et sondes réels,
// jamais simulés ; le moteur reste verrouillé « gateway »).
"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Segmented } from "@/components/shared/segmented";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { InfoTip } from "@/components/shared/info-tip";
import {
  getSettingDef,
  onSettingsChanged,
  readClientSetting,
  writeClientSetting,
} from "@/lib/settings";
import {
  GENERIC_EFFORTS,
  type GatewayMode,
  type MemoryState,
  type ModelOption,
  type Project,
  type SystemPromptPreset,
} from "@/lib/chat-types";
import {
  PRICING_KEY,
  type PricingMap,
  parseModelLabel,
} from "@/lib/pricing";
import { useModelPricing } from "@/hooks/use-pricing";
import { getSocket } from "@/lib/socket";
import type { ProvidersApi } from "@/hooks/use-providers";
import { ProvidersSection } from "@/components/settings/providers-section";
import { ExtensionsSection } from "@/components/settings/extensions-section";
import { HermesSection } from "@/components/settings/hermes-section";
import { ToolsSection } from "@/components/settings/tools-section";
import { SkillsSection } from "@/components/settings/skills-section";
import { ProfilesSection } from "@/components/settings/profiles-section";
import { SystemSection } from "@/components/settings/system-section";
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
  /** Fournisseurs LLM actionnables (v2.4) — pastille « moteur intégré » honnête. */
  engineProviders?: string[] | null;
  connected: boolean;
  /** Catalogue vivant (service) pour la ligne « Modèle de conversation ». */
  models: ModelOption[];
  /** Modèle sélectionné (état du hook, source de vérité côté chat). */
  selectedModel: string | null;
  projects: Project[];
  /** Fournisseurs & extensions (use-providers). */
  api: ProvidersApi;
  /** Prompt système & instructions (use-system-prompts, F-11/F-19). */
  promptsApi: {
    presets: SystemPromptPreset[];
    customInstructions: string | null;
    customMaxChars: number;
    createPreset: (title: string, content: string) => Promise<SystemPromptPreset | null>;
    updatePreset: (id: string, title: string, content: string) => Promise<SystemPromptPreset | null>;
    deletePreset: (id: string) => Promise<boolean>;
    saveCustomInstructions: (value: string) => Promise<boolean>;
  };
  /** Mémoire utilisateur (use-memory, F-18). */
  memoryApi: {
    state: MemoryState | null;
    setEnabled: (enabled: boolean) => Promise<boolean>;
    setAuto: (autoLearn: boolean) => Promise<boolean>;
    saveNotes: (value: string) => Promise<boolean>;
  };
  /** Version du service (hello) — pied du rail. */
  serverVersion?: string | null;
  /** v2.4 (section Système) — sondes réelles du hello. */
  appRevision?: string | null;
  chromeHeadless?: "present" | "absent" | null;
  gatewayUrl?: string | null;
  /** v2.4 (section Outils) — même calcul que la bascule « Web » du composer. */
  webSearchAvailable?: boolean;
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

  // Tarifs (F-21) : déclarés ici, appliqués au coût des réponses.
  const pricing = useModelPricing();
  const [tarifModel, setTarifModel] = useState<string>("");
  const [tarifInput, setTarifInput] = useState("");
  const [tarifOutput, setTarifOutput] = useState("");

  const savePricing = (next: PricingMap) => {
    getSocket().emit("settings:set", {
      key: PRICING_KEY,
      value: JSON.stringify(next),
    });
  };
  const parseFloatFr = (raw: string): number | null => {
    const n = Number(raw.trim().replace(",", "."));
    return raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const tarifIn = parseFloatFr(tarifInput);
  const tarifOut = parseFloatFr(tarifOutput);
  const canAdd = !!tarifModel && tarifIn !== null && tarifOut !== null;
  const addTarif = () => {
    if (!canAdd) return;
    savePricing({ ...pricing, [tarifModel]: { input: tarifIn!, output: tarifOut! } });
    setTarifModel("");
    setTarifInput("");
    setTarifOutput("");
  };
  const labelOf = (id: string) =>
    models.find((m) => m.id === id)?.label ?? parseModelLabel(id)?.id ?? id;

  const windowLabel = (m: ModelOption) => {
    if (!m.contextWindow) return m.provider;
    const cw = m.contextWindow;
    const w = cw >= 1e6 ? `${Math.round(cw / 1e6)}M` : `${Math.round(cw / 1000)}k`;
    return `${m.provider} · fenêtre ${w}`;
  };

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Modèles</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
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
            className="h-8 w-[230px] max-w-full rounded-md bg-background px-[11px] text-[12.5px] font-medium hover:border-hermes focus-visible:ring-hermes/50"
          >
            <SelectValue placeholder="Modèle du service" />
          </SelectTrigger>
          <SelectContent className="max-h-[280px]">
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id} className="py-2">
                <span className="flex flex-col items-start gap-0.5">
                  <span className="text-[12.5px] font-medium">{m.label}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
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
        <Segmented
          ariaLabel="Effort de raisonnement"
          options={effortOptions}
          value={activeEffort}
          onChange={(v) => writeClientSetting("hermes.reasoning.effort", v)}
        />
      </SettingRow>

      {/* F-21 — tarifs déclarés par l'utilisatrice : le coût des réponses
          est calculé à partir d'EUX (jamais deviné) et affiché par bulle. */}
      <div className="border-b border-border py-3">
        <div className="text-[14px] font-medium">Tarifs des modèles</div>
        <p className="mt-px max-w-[520px] text-[12.5px] leading-snug text-muted-foreground">
          $ par million de jetons, entrée et sortie — le coût de chaque réponse
          sera affiché sous la bulle. Rien n&apos;est pré-rempli : le fournisseur fait
          foi ; aucune donnée ne quitte votre machine.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Select value={tarifModel || undefined} onValueChange={setTarifModel}>
            <SelectTrigger
              aria-label="Modèle à tarifer"
              className="h-8 w-[210px] max-w-full rounded-md bg-background px-[11px] text-[12.5px] font-medium hover:border-hermes focus-visible:ring-hermes/50"
            >
              <SelectValue placeholder="Modèle à tarifer" />
            </SelectTrigger>
            <SelectContent className="max-h-[240px]">
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="py-2">
                  {m.label} · {m.provider}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="sr-only" htmlFor="tarif-input">Tarif entrée ($/M jetons)</label>
          <input
            id="tarif-input"
            inputMode="decimal"
            placeholder="entrée $/M"
            value={tarifInput}
            onChange={(e) => setTarifInput(e.target.value)}
            className="h-8 w-[110px] rounded-md border border-border bg-background px-2.5 text-right text-[12.5px] tabular-nums outline-none focus-visible:border-hermes"
          />
          <label className="sr-only" htmlFor="tarif-output">Tarif sortie ($/M jetons)</label>
          <input
            id="tarif-output"
            inputMode="decimal"
            placeholder="sortie $/M"
            value={tarifOutput}
            onChange={(e) => setTarifOutput(e.target.value)}
            className="h-8 w-[110px] rounded-md border border-border bg-background px-2.5 text-right text-[12.5px] tabular-nums outline-none focus-visible:border-hermes"
          />
          <button
            type="button"
            onClick={addTarif}
            disabled={!canAdd}
            className="h-8 cursor-pointer rounded-md bg-hermes px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Ajouter
          </button>
        </div>
        {Object.keys(pricing).length > 0 ? (
          <ul className="mt-2.5 grid gap-1">
            {Object.entries(pricing).map(([id, p]) => (
              <li
                key={id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[12.5px]"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{labelOf(id)}</span>
                <span className="flex-none tabular-nums text-muted-foreground">
                  entrée {p.input.toLocaleString("fr-FR")} · sortie {p.output.toLocaleString("fr-FR")} $/M
                </span>
                <button
                  type="button"
                  aria-label={`Retirer le tarif de ${labelOf(id)}`}
                  onClick={() => {
                    const next = { ...pricing };
                    delete next[id];
                    savePricing(next);
                  }}
                  className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Aucun tarif déclaré — les réponses afficheront leur coût dès qu&apos;un
            tarif sera renseigné (ou tel que facturé par le fournisseur).
          </p>
        )}
      </div>

      <p className="mt-6 flex items-start gap-2 text-[12.5px] leading-relaxed text-muted-foreground">
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
  engineProviders = null,
  connected,
  models,
  selectedModel,
  projects,
  api,
  promptsApi,
  memoryApi,
  serverVersion,
  appRevision = null,
  chromeHeadless = null,
  gatewayUrl = null,
  webSearchAvailable = false,
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
  // v2.4 : « démo » seulement si AUCUN fournisseur n a de clé active —
  // sinon le moteur intégré répond réellement via les API des fournisseurs.
  const poolActive = (engineProviders?.length ?? 0) > 0;
  const extUpdate = api.extensions.some((e) => e.updateAvailable);

  // Navigation interne du volet (liens croisés des sections v2.4).
  const goto = (id: string) => {
    if (SECTIONS.some((s) => s.id === id)) setSection(id as SectionId);
  };

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
      case "hermes":
        return (
          <HermesSection
            presets={promptsApi.presets}
            customInstructions={promptsApi.customInstructions}
            customMaxChars={promptsApi.customMaxChars}
            onCreatePreset={promptsApi.createPreset}
            onUpdatePreset={promptsApi.updatePreset}
            onDeletePreset={promptsApi.deletePreset}
            onSaveCustomInstructions={promptsApi.saveCustomInstructions}
            memory={memoryApi.state}
            onSetMemoryEnabled={memoryApi.setEnabled}
            onSetMemoryAuto={memoryApi.setAuto}
            onSaveMemoryNotes={memoryApi.saveNotes}
            models={models}
            selectedModel={selectedModel}
          />
        );
      case "outils":
        return (
          <ToolsSection
            webSearchAvailable={webSearchAvailable}
            onNavigate={goto}
          />
        );
      case "skills":
        return <SkillsSection onNavigate={goto} />;
      case "profils":
        return <ProfilesSection />;
      case "systeme":
        return (
          <SystemSection
            mode={mode}
            engineProviders={engineProviders}
            serverVersion={serverVersion ?? null}
            appRevision={appRevision}
            chromeHeadless={chromeHeadless}
            gatewayUrl={gatewayUrl}
          />
        );
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="w-full gap-0 overflow-hidden bg-card p-0 shadow-2xl sm:max-w-none min-[1100px]:w-[860px] min-[1100px]:max-w-none min-[1100px]:flex-row min-[1100px]:rounded-r-[22px] min-[1100px]:border-r min-[1100px]:border-border data-[state=open]:duration-300"
      >
        <SheetTitle className="sr-only">Paramètres</SheetTitle>

          {/* ── Rail de sections ─────────────────────────────────────── */}
          <nav
            aria-label="Sections des paramètres"
            className="flex flex-none flex-col gap-2 border-border bg-background p-3 max-[1100px]:flex-row max-[1100px]:overflow-x-auto max-[1100px]:border-b min-[1100px]:w-[208px] min-[1100px]:border-r"
          >
            <div className="flex items-center gap-2 px-1 pb-1 max-[1100px]:hidden">
              <span className="flex size-[22px] items-center justify-center rounded-sm bg-hermes/10 text-hermes-text">
                <Sparkle className="size-[13px]" strokeWidth={2} />
              </span>
              <b className="text-[12.5px] font-semibold tracking-tight">Paramètres</b>
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
                      "flex flex-none cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-hermes",
                      active && "bg-muted font-semibold text-foreground"
                    )}
                  >
                    <Icon className="size-[14px] flex-none" strokeWidth={2} />
                    <span className="whitespace-nowrap">{label}</span>
                    {id === "extensions" && extUpdate ? (
                      <i
                        className="ml-auto size-[7px] flex-none rounded-full bg-warning max-[1100px]:ml-1"
                        aria-label="Mise à jour disponible"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="mt-auto px-2 pt-2 text-[11px] whitespace-nowrap text-muted-foreground max-[1100px]:hidden">
              {isDemo ? (
                poolActive ? (
                  <span className="inline-flex items-center gap-1.5">
                    <InfoTip>Les réponses viennent de l'API de vos fournisseurs — vos clés, votre quota.</InfoTip>
                    <i className="size-[6px] rounded-full bg-success" aria-hidden />
                    moteur intégré
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <InfoTip>Réponses simulées par le LLM intégré du moteur — aucune clé n'est utilisée.</InfoTip>
                    <i className="size-[6px] rounded-full bg-warning" aria-hidden />
                    mode démo
                  </span>
                )
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <i className="size-[6px] rounded-full bg-success" aria-hidden />
                  gateway
                </span>
              )}
              {serverVersion ? (
                <span className="block pt-0.5">service v{serverVersion}</span>
              ) : null}
            </div>
          </nav>

          {/* ── Contenu ──────────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col pt-4 min-[1100px]:pt-0">

            <div
              key={section}
              className="min-h-0 flex-1 animate-in fade-in overflow-y-auto overscroll-contain px-5 pt-2 pb-8 duration-150 min-[1100px]:px-[34px] min-[1100px]:pt-0 min-[1100px]:pb-[70px]"
            >
              {pane()}
            </div>

            {/* Pied : état démo + modifications en attente (v4) */}
            <div className="flex flex-none items-center gap-2.5 border-t border-border bg-background px-5 py-[9px] min-[1100px]:px-[34px]">
              {isDemo ? (
                poolActive ? (
                  <div className="group relative flex min-w-0 cursor-help items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="size-[7px] flex-none rounded-full bg-success" />
                    <span className="truncate">Moteur intégré</span>
                    <span className="pointer-events-none absolute bottom-full left-0 mb-2 w-max max-w-[260px] rounded-md bg-foreground px-[11px] py-2 text-left text-[11px] leading-relaxed text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                      Les réponses partent sur l&apos;API de vos fournisseurs
                      (clés actives : {engineProviders!.join(", ")}). Ajoutez ou
                      retirez des clés dans la section Fournisseurs.
                    </span>
                  </div>
                ) : (
                <div className="group relative flex min-w-0 cursor-help items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="size-[7px] flex-none rounded-full bg-warning" />
                  <span className="truncate">Mode démo</span>
                  <span className="pointer-events-none absolute bottom-full left-0 mb-2 w-max max-w-[260px] rounded-md bg-foreground px-[11px] py-2 text-left text-[11px] leading-relaxed text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                    Réponses simulées par le LLM intégré. Ajoutez la clé d&apos;un
                    fournisseur (section Fournisseurs) ou branchez la gateway
                    Hermes pour de vraies réponses.
                  </span>
                </div>
                )
              ) : (
                <span className="min-w-0" />
              )}
              {api.pendingEngineCount > 0 ? (
                <span
                  className="ml-auto flex h-6 flex-none items-center gap-1 rounded-full bg-hermes/10 px-2 text-[11px] font-semibold text-hermes-text"
                >
                  {api.pendingEngineCount} en attente
                  <InfoTip>Modifications moteur pas encore appliquées — pris en compte au prochain redémarrage du moteur.</InfoTip>
                </span>
              ) : null}
            </div>
          </div>
      </SheetContent>
    </Sheet>
  );
}
