// Sélecteur de modèle — popover cmdk épuré : déclencheur au NOM du modèle en
// cours (+ chevron — à la demande : le nom remplace l'icône ✦ ; pastille A/B
// en comparaison, suivie du nom du slot), recherche
// (nom, id, fournisseur — insensible à la casse et aux accents), section Favoris
// (hermes.models.favorites) alimentée par l'étoile de chaque ligne (bascule ici
// même — fin du panneau mort « gérés depuis les paramètres »), groupes par
// fournisseur, échelle d'effort portée par le modèle (repli générique
// off·low·medium·high·max) et mode expert (F-22). Les notes explicatives vivent
// dans l'InfoTip — idiome unique du repo.
"use client";

import { useEffect, useMemo, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronDown, Search, Star, Zap } from "lucide-react";
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
import { InfoTip } from "@/components/shared/info-tip";
import {
  onSettingsChanged,
  readClientSetting,
  writeClientSetting,
} from "@/lib/settings";
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

/** Favoris : ids JSON — entrées non-chaîne ou JSON invalide ignorés. */
function parseFavoriteIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** Favoris du registre : ids disparus ignorés silencieusement à la lecture. */
function readFavoriteIds(): string[] {
  return parseFavoriteIds(readClientSetting<string>(FAVORITES_KEY) ?? "[]");
}

interface ModelPickerProps {
  models: ModelOption[];
  selectedModel: string | null;
  source: "gateway" | "catalogue" | "providers" | null;
  mode: "gateway" | "local" | null;
  disabled?: boolean;
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
      {/* Ligne titre : le chevron (devant, sens disclosure) porte l'état —
          les mots « déplier/replier » redondants sont tombés (épuration).
          L'InfoTip est hors du bouton (jamais de bouton dans un bouton). */}
      <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          Mode expert
          {activeCount > 0 ? (
            <span className="rounded-full bg-hermes/10 px-1.5 py-px text-[11px] font-medium text-hermes-text">
              {activeCount} actif{activeCount > 1 ? "s" : ""}
            </span>
          ) : null}
        </button>
        <InfoTip>
          Température, plafond de jetons et graine — champs vides = valeurs par
          défaut du fournisseur. Envoyés dans{" "}
          <code className="rounded bg-muted px-1 font-mono text-[11px]">api_turn_v1.settings</code>
          , ignorés sans dommage si non supportés.
        </InfoTip>
      </div>
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
              0 = déterministe · 1 = créatif (le fournisseur refuse au-delà).
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
  // Favoris partagés entre pickers (A/B du mode comparaison) : écriture locale
  // + reprise sur le bus des réglages (hermes-ui:settings-changed).
  useEffect(
    () =>
      onSettingsChanged(({ key, value }) => {
        if (key === FAVORITES_KEY) setFavoriteIds(parseFavoriteIds(value));
      }),
    []
  );

  const toggleFavorite = (id: string) => {
    const next = favoriteIds.includes(id)
      ? favoriteIds.filter((f) => f !== id)
      : [...favoriteIds, id];
    setFavoriteIds(next);
    writeClientSetting(FAVORITES_KEY, JSON.stringify(next));
  };

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
  // En grouped, le fournisseur porte le titre de section : la ligne mono ne
  // le répète pas. En flat (catalogue/moteur local), une seule section : il complète l'id.
  const byProvider =
    (source === "gateway" && mode === "gateway") || source === "providers";
  const grouped = useMemo(() => {
    const rest = filtered.filter((m) => !favoriteIdSet.has(m.id));
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
  }, [filtered, favoriteIdSet, byProvider]);

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
    const isFavorite = favoriteIds.includes(m.id);
    return (
      <CommandItem
        key={m.id}
        // Valeur normalisée : sélection clavier cohérente avec la recherche
        value={norm(`${m.label} ${m.id} ${m.provider}`)}
        onSelect={() => pick(m.id)}
        role="menuitemradio"
        aria-checked={isSelected}
        className="group/item flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left"
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          {isSelected ? <Check className="h-4 w-4 text-hermes-text" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">{m.label}</span>
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
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground/70">
            {byProvider ? m.id : `${m.id} · ${m.provider}`}
          </span>
        </span>
        {/* Étoile favori : révélée au survol / sélection / focus, pleine si
            favorite. Clic et Entrée/Espace isolés de cmdk (sinon la ligne
            serait sélectionnée en même temps que l'étoile basculée). */}
        <button
          type="button"
          aria-label={
            isFavorite
              ? `Retirer « ${m.label} » des favoris`
              : `Ajouter « ${m.label} » aux favoris`
          }
          aria-pressed={isFavorite}
          title={isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(m.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
          className={`mt-px flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-sm transition-opacity ${
            isFavorite
              ? "text-warning opacity-100 hover:bg-warning/10"
              : "text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/item:opacity-100 group-data-[selected=true]/item:opacity-100"
          }`}
        >
          <Star
            className={`h-3.5 w-3.5 ${isFavorite ? "fill-warning" : ""}`}
            strokeWidth={2}
          />
        </button>
      </CommandItem>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        // Relus à chaque ouverture : le registre est la source de vérité,
        // l'étoile de ce picker (ou un autre picker ouvert) l'écrit.
        if (o) setFavoriteIds(readFavoriteIds());
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        {/* Déclencheur au nom du modèle en cours (à la demande : le nom
            remplace l'icône ✦ ; en comparaison, pastille A/B suivie du nom du
            slot) — le title et l'aria-label restent complets. */}
        <Button
          variant="ghost"
          disabled={busy}
          title={
            slotLabel
              ? `Modèle ${slotLabel} : ${label}. Changer le modèle ${slotLabel}`
              : `Modèle sélectionné : ${label}. Changer de modèle`
          }
          className="h-8 gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-label={
            slotLabel
              ? `Modèle ${slotLabel} : ${label}. Changer le modèle ${slotLabel}`
              : `Modèle sélectionné : ${label}. Changer de modèle`
          }
        >
          {slotLabel ? (
            <>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-md bg-hermes/15 px-1 text-[11px] font-bold text-hermes-text">
                {slotLabel}
              </span>
              <span className="max-w-[120px] truncate">{label}</span>
            </>
          ) : (
            <span className="max-w-[160px] truncate">{label}</span>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[352px] p-0"
        // Le picker vit dans le composer : ouverture vers le haut
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false} className="overflow-hidden rounded-xl">
          {/* Pas d'en-tête : la recherche dit déjà quoi faire (épuration). */}
          <div className="px-2 pt-3 pb-1">
            <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2.5 focus-within:border-hermes focus-within:ring-2 focus-within:ring-hermes/20">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Rechercher un modèle…"
                className="h-9 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
                aria-label="Rechercher un modèle par nom, id ou fournisseur"
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

          <p className="flex items-center gap-1.5 border-t border-border/60 px-3.5 py-2 text-[11px] text-muted-foreground">
            <span>
              {filtered.length}
              {filtered.length > 1 ? " modèles" : " modèle"} · {providers.size}
              {providers.size > 1 ? " fournisseurs" : " fournisseur"}
            </span>
            <InfoTip>
              {source === "gateway" && mode === "gateway"
                ? "Modèles exposés par la gateway Hermes."
                : source === "providers"
                  ? "Modèles vivants de vos clés — Paramètres → Fournisseurs & clés."
                  : "Catalogue Hermes — ajoutez une clé dans Paramètres pour des modèles vivants."}
            </InfoTip>
          </p>

          {/* Échelle d'effort de raisonnement — portée par le modèle sélectionné */}
          <div className={bare ? "hidden" : "border-t border-border/60 px-3.5 py-2.5"}>
            <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
              <span className="flex items-center gap-1.5">
                Effort de raisonnement
                <InfoTip>
                  Échelle portée par le modèle sélectionné — repli générique
                  off·low·medium·high·max. La valeur part dans{" "}
                  <code className="rounded bg-muted px-1 font-mono text-[11px]">api_turn_v1.settings</code>
                  , ignorée sans dommage si le fournisseur ne la supporte pas.
                </InfoTip>
              </span>
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
