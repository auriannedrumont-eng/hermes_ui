// Sélecteur de modèle — chantier « Composer v2 » :
// popover cmdk avec recherche (nom, id, fournisseur — insensible à la casse
// et aux accents), section Favoris (hermes.models.favorites), groupes par
// fournisseur en mode gateway, et échelle d'effort de raisonnement portée
// par le modèle (repli générique off·low·medium·high·max).
"use client";

import { useMemo, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronDown, Search, Sparkles, Star, Zap } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { readClientSetting, writeClientSetting } from "@/lib/settings";
import { GENERIC_EFFORTS, type ExpertSettings, type ModelOption } from "@/lib/chat-types";

const FAVORITES_KEY = "hermes.models.favorites";
const EFFORT_KEY = "hermes.reasoning.effort";

/** Normalisation de recherche : minuscules + suppression des diacritiques. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Favoris du registre : ids JSON, ids disparus ignorés silencieusement. */
function readFavoriteIds(): string[] {
  try {
    const raw = readClientSetting<string>(FAVORITES_KEY) ?? "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface ModelPickerProps {
  models: ModelOption[];
  selectedModel: string | null;
  source: "gateway" | "catalogue" | "providers" | null;
  mode: "gateway" | "demo" | null;
  disabled?: boolean;
  /** Variante compacte (dans le composer). */
  compact?: boolean;
  onSelect: (id: string) => void;
  /** Effort de raisonnement courant (valeur brute du fournisseur). */
  effort: string | null;
  onEffortChange: (effort: string) => void;
  /** Réglages expert (F-22) — absents = valeurs par défaut du fournisseur. */
  expert?: ExpertSettings;
  onExpertChange?: (patch: Partial<ExpertSettings>) => void;
  /** F-17 — comparaison : libellé du côté (A/B) affiché dans le déclencheur. */
  slotLabel?: "A" | "B";
  /** F-17 — comparaison : masque effort + mode expert (comparaison brute). */
  bare?: boolean;
}

/** Champs numériques libres du mode expert : borne la saisie en live. */
function expertClamp(
  field: "temperature" | "maxTokens" | "seed",
  raw: string
): number | undefined {
  if (!raw.trim()) return undefined;
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return undefined;
  if (field === "temperature") return Math.min(1, Math.max(0, n));
  if (field === "maxTokens") return Math.min(8192, Math.max(1, Math.round(n)));
  return Math.min(2 ** 31 - 1, Math.max(0, Math.round(n)));
}

/** Section repliable « Mode expert » (F-22) du popover : température
 *  (curseur 0–1), plafond de jetons, graine. Champs vides = retirés. */
function ExpertPanel({
  expert,
  onExpertChange,
}: {
  expert: ExpertSettings;
  onExpertChange: (patch: Partial<ExpertSettings>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const activeCount = [expert.temperature, expert.maxTokens, expert.seed].filter(
    (v) => v !== undefined
  ).length;
  return (
    <div className="border-t border-border/60 px-3.5 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center justify-between text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          Mode expert
          {activeCount > 0 ? (
            <span className="rounded-full bg-hermes/10 px-1.5 py-px text-[11px] font-medium text-hermes-text">
              {activeCount} actif{activeCount > 1 ? "s" : ""}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] font-medium">
          {expanded ? "replier" : "déplier"}
          <ChevronDown
            className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2.5">
          <div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">Température</span>
              <span className="tabular-nums">
                {expert.temperature !== undefined
                  ? expert.temperature.toLocaleString("fr-FR", { maximumFractionDigits: 2 })
                  : "défaut"}
              </span>
            </div>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[expert.temperature ?? 0.7]}
              onValueChange={([v]) => onExpertChange({ temperature: v })}
              aria-label="Température"
              className="mt-3 w-full"
            />
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              0 = déterministe · 1 = créatif (le moteur démo refuse au-delà).
            </p>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              Plafond de jetons
            </span>
            <input
              type="number"
              min={1}
              max={8192}
              placeholder="8192"
              value={expert.maxTokens ?? ""}
              onChange={(e) =>
                onExpertChange({ maxTokens: expertClamp("maxTokens", e.target.value) })
              }
              aria-label="Plafond de jetons de la réponse"
              className="h-7 w-24 rounded-sm border border-border bg-background px-2 text-right text-[11px] tabular-nums outline-none focus-visible:border-hermes/60"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">Graine</span>
            <input
              type="number"
              min={0}
              placeholder="—"
              value={expert.seed ?? ""}
              onChange={(e) => onExpertChange({ seed: expertClamp("seed", e.target.value) })}
              aria-label="Graine de reproductibilité"
              className="h-7 w-24 rounded-sm border border-border bg-background px-2 text-right text-[11px] tabular-nums outline-none focus-visible:border-hermes/60"
            />
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Champs vides = valeurs par défaut du fournisseur. Envoyés dans{" "}
            <code className="rounded bg-muted px-1 font-mono text-[11px]">api_turn_v1.settings</code>{" "}
            — ignorés sans dommage si non supportés.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ModelPicker({
  models,
  selectedModel,
  source,
  mode,
  disabled,
  compact = false,
  onSelect,
  effort,
  onEffortChange,
  expert,
  onExpertChange,
  slotLabel,
  bare = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);

  const list = useMemo(() => (Array.isArray(models) ? models : []), [models]);
  const current = useMemo(
    () => list.find((m) => m.id === selectedModel) ?? null,
    [list, selectedModel]
  );
  const label = current?.label ?? "Modèle";
  const busy = disabled || list.length === 0;

  // ── Recherche (insensible casse + accents, sur nom / id / fournisseur) ──
  const q = norm(query.trim());
  const filtered = useMemo(
    () =>
      q
        ? list.filter((m) => norm(`${m.label} ${m.id} ${m.provider}`).includes(q))
        : list,
    [list, q]
  );

  // ── Favoris (masqués si vides, ids disparus ignorés) ───────────────────
  const favorites = useMemo(
    () =>
      favoriteIds
        .map((id) => filtered.find((m) => m.id === id))
        .filter((m): m is ModelOption => Boolean(m)),
    [favoriteIds, filtered]
  );
  const favoriteIdSet = useMemo(() => new Set(favorites.map((m) => m.id)), [favorites]);

  // ── Groupes : par fournisseur en gateway ou en pool vivant (v2.3) ──
  const grouped = useMemo(() => {
    const rest = filtered.filter((m) => !favoriteIdSet.has(m.id));
    const byProvider = (source === "gateway" && mode === "gateway") || source === "providers";
    if (byProvider) {
      const groups = new Map<string, ModelOption[]>();
      for (const m of rest) {
        const k = m.provider || "Gateway";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(m);
      }
      return [...groups.entries()];
    }
    return rest.length ? [["", rest] as [string, ModelOption[]]] : [];
  }, [filtered, favoriteIdSet, source, mode]);

  const providers = useMemo(
    () => new Set(filtered.map((m) => m.provider || "Gateway")),
    [filtered]
  );

  // ── Échelle d'effort : portée par le modèle, repli générique ───────────
  const efforts = current?.efforts?.length ? current.efforts : GENERIC_EFFORTS;
  const effortScaleLabel = current?.effortLabel
    ? `Échelle : ${current.effortLabel}`
    : source === "gateway" && mode === "gateway" && current?.provider
      ? `Échelle : ${current.provider}`
      : "Échelle : générique";
  const activeEffort = effort && efforts.includes(effort) ? effort : null;

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
    setQuery("");
  };

  const renderModel = (m: ModelOption) => {
    const isSelected = m.id === selectedModel;
    return (
      <CommandItem
        key={m.id}
        // Valeur normalisée : sélection clavier cohérente avec la recherche
        value={norm(`${m.label} ${m.id} ${m.provider}`)}
        onSelect={() => pick(m.id)}
        role="menuitemradio"
        aria-checked={isSelected}
        className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left"
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          {isSelected ? <Check className="h-4 w-4 text-hermes-text" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">{m.label}</span>
            {favoriteIds.includes(m.id) ? (
              <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />
            ) : null}
            {m.badge ? (
              <span
                className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-medium ${
                  m.badge === "Défaut"
                    ? "bg-muted text-muted-foreground"
                    : "bg-hermes/10 text-hermes-text"
                }`}
              >
                {m.badge === "Flagship" ? <Zap className="h-2.5 w-2.5" /> : null}
                {m.badge}
              </span>
            ) : null}
          </span>
          {m.description ? (
            <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted-foreground">
              {m.description}
            </span>
          ) : null}
          <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground/70">
            {m.id} · {m.provider}
          </span>
        </span>
      </CommandItem>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // Les favoris sont relus à chaque ouverture (gérés depuis les paramètres)
        if (o) setFavoriteIds(readFavoriteIds());
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          disabled={busy}
          className={
            compact
              ? "h-8 gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              : "h-9 gap-1.5 rounded-xl px-2.5 text-[14px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          }
          aria-label={
            slotLabel
              ? `Modèle ${slotLabel} : ${label}. Changer le modèle ${slotLabel}`
              : `Modèle sélectionné : ${label}. Changer de modèle`
          }
        >
          {slotLabel ? (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-hermes/15 px-1 text-[11px] font-bold text-hermes-text">
              {slotLabel}
            </span>
          ) : compact ? (
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-hermes-text" />
          ) : null}
          <span className="max-w-40 truncate sm:max-w-none">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align={compact ? "start" : "center"}
        className="w-[352px] p-0"
        // Le picker vit dans le composer : ouverture vers le haut
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false} className="overflow-hidden rounded-xl">
          <div className="flex items-center gap-1.5 px-3.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-hermes-text" />
            Choisir un modèle
          </div>
          <div className="px-2 pb-1">
            <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2.5 focus-within:border-hermes focus-within:ring-2 focus-within:ring-hermes/20">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Rechercher par nom, id ou fournisseur…"
                className="h-9 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
                aria-label="Rechercher un modèle"
              />
              <kbd className="rounded border border-border bg-card px-1.5 py-px font-mono text-[11px] text-muted-foreground">
                esc
              </kbd>
            </div>
          </div>
          <CommandList className="max-h-[252px] overflow-y-auto p-1">
            <CommandEmpty className="py-5 text-center text-[12.5px] text-muted-foreground">
              Aucun modèle ne correspond à «&nbsp;{query.trim()}&nbsp;»
            </CommandEmpty>

            {favorites.length > 0 ? (
              <CommandGroup
                heading={
                  <span className="flex items-center gap-1.5">
                    <Star className="h-3 w-3 fill-warning text-warning" />
                    Favoris
                  </span>
                }
              >
                {favorites.map(renderModel)}
              </CommandGroup>
            ) : null}

            {grouped.map(([provider, groupModels]) =>
              provider ? (
                <CommandGroup key={provider} heading={provider}>
                  {groupModels.map(renderModel)}
                </CommandGroup>
              ) : (
                <CommandGroup key="__flat">{groupModels.map(renderModel)}</CommandGroup>
              )
            )}
          </CommandList>

          <p className="border-t border-border/60 px-3.5 py-2 text-[11px] leading-snug text-muted-foreground">
            {filtered.length}
            {filtered.length > 1 ? " modèles" : " modèle"} · {providers.size}
            {providers.size > 1 ? " fournisseurs — " : " fournisseur — "}
            {source === "gateway" && mode === "gateway"
              ? "modèles exposés par la gateway Hermes"
              : source === "providers"
                ? "modèles vivants de vos clés — Paramètres → Fournisseurs & clés"
                : "catalogue Hermes — ajoutez une clé pour des modèles vivants"}
          </p>

          {/* Échelle d'effort de raisonnement — portée par le modèle sélectionné */}
          <div className={bare ? "hidden" : "border-t border-border/60 px-3.5 py-2.5"}>
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
              <span>Effort de raisonnement</span>
              <span className="text-[11px] font-medium">{effortScaleLabel}</span>
            </div>
            <Segmented
              ariaLabel="Effort de raisonnement"
              options={efforts.map((e) => ({ value: e, label: e }))}
              value={activeEffort}
              onChange={(e) => {
                onEffortChange(e);
                writeClientSetting(EFFORT_KEY, e);
              }}
              className="w-full"
              classNameItem="flex-1 capitalize"
            />
            <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
              Envoyé dans <code className="rounded bg-muted px-1 font-mono text-[11px]">api_turn_v1.settings</code>{" "}
              — ignoré sans dommage si le fournisseur ne le supporte pas.
            </p>
          </div>

          {/* Mode expert (F-22) : température / plafond de sortie / graine */}
          {bare || !onExpertChange ? null : (
            <ExpertPanel expert={expert ?? {}} onExpertChange={onExpertChange} />
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default ModelPicker;
