// Section Modèles — extraite de settings-panel.tsx (découpage 2026-11,
// FORK.md §10). Catalogue vivant du service + tarifs F-21 (jetons &
// coût par modèle, persistés dans le registre).
"use client";

import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/shared/segmented";
import { X } from "lucide-react";
import { SettingRow } from "@/components/settings/interface-section";
import { onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import { GENERIC_EFFORTS, type ModelOption } from "@/lib/chat-types";
import { PRICING_KEY, type PricingMap, parseModelLabel } from "@/lib/pricing";
import { useModelPricing, usePricingState } from "@/hooks/use-pricing";
import { emitAck } from "@/lib/emit-ack";

// ── Libellés FR des valeurs brutes du registre (présentation seule) ──
const EFFORT_LABELS: Record<string, string> = {
  off: "Désactivé",
  low: "Léger",
  medium: "Moyen",
  high: "Élevé",
  max: "Max",
  standard: "Standard",
  minimal: "Minimal",
};

// Tarif $/M affiché sans perdre les petites valeurs (0,0005 s'affichait
// « 0,001 » voire « 0 » avec toLocaleString par défaut — même logique que
// formatUsd, sans le suffixe $).
const formatTarif = (n: number): string => {
  if (n > 0 && n < 0.0001) return "< 0,0001";
  if (n >= 1)
    return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
};

export function ModelesPane({
  models,
  selectedModel,
}: {
  models: ModelOption[];
  selectedModel: string | null;
}) {
  const [rev, setRev] = useState(0);
  const { toast } = useToast();
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
  // Lot audit 2026-11-21 : `pricingLoaded` garde TOUTE écriture tant que la
  // map serveur n'a pas été lue — ajouter/retirer un tarif pendant le
  // chargement écrivait une map neuve et effaçait tous les tarifs existants.
  const pricing = useModelPricing();
  const { loaded: pricingLoaded, error: pricingError } = usePricingState();
  const [tarifModel, setTarifModel] = useState<string>("");
  const [tarifInput, setTarifInput] = useState("");
  const [tarifOutput, setTarifOutput] = useState("");

  const savePricing = async (next: PricingMap) => {
    if (!pricingLoaded) return;
    // Lot 5 + lot 2026-11-21 : ack vérifié ET chien de garde — un service
    // muet (socket coupée) ne laisse plus croire à une sauvegarde réussie.
    const res = await emitAck<{ ok?: boolean; error?: string }>("settings:set", {
      key: PRICING_KEY,
      value: JSON.stringify(next),
    });
    if (res === null) {
      toast({
        title: "Tarifs non enregistrés",
        description: "Le service n'a pas répondu (8 s). Réessayez une fois la connexion rétablie.",
        variant: "destructive",
      });
      return;
    }
    if (res.error) {
      toast({ title: "Tarifs non enregistrés", description: res.error, variant: "destructive" });
    }
  };
  const parseFloatFr = (raw: string): number | null => {
    const n = Number(raw.trim().replace(",", "."));
    return raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const tarifIn = parseFloatFr(tarifInput);
  const tarifOut = parseFloatFr(tarifOutput);
  const canAdd = !!tarifModel && tarifIn !== null && tarifOut !== null && pricingLoaded;
  const addTarif = () => {
    if (!canAdd) return;
    void savePricing({ ...pricing, [tarifModel]: { input: tarifIn!, output: tarifOut! } });
    setTarifModel("");
    setTarifInput("");
    setTarifOutput("");
  };
  const labelOf = (id: string) =>
    models.find((m) => m.id === id)?.label ?? parseModelLabel(id)?.id ?? id;

  const windowLabel = (m: ModelOption) => {
    if (!m.contextWindow) return m.provider;
    const cw = m.contextWindow;
    // 1 500 000 jetons s'affichait « 2M » (Math.round) — décimale si besoin.
    const w =
      cw >= 1e6
        ? `${(cw / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}M`
        : `${Math.round(cw / 1000)}k`;
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
        description="Le modèle des nouvelles conversations — celui de la barre de saisie reste celui de la conversation en cours."
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
          Prix en $ par million de jetons (entrée, sortie) — le coût de chaque
          réponse s&apos;affiche sous la bulle.
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
          <Label className="sr-only" htmlFor="tarif-input">Tarif entrée ($/M jetons)</Label>
          <Input
            id="tarif-input"
            inputMode="decimal"
            placeholder="entrée $/M"
            value={tarifInput}
            onChange={(e) => setTarifInput(e.target.value)}
            className="h-8 w-[110px] rounded-md border border-border bg-background px-2.5 text-right text-[12.5px] tabular-nums outline-none focus-visible:border-hermes"
          />
          <Label className="sr-only" htmlFor="tarif-output">Tarif sortie ($/M jetons)</Label>
          <Input
            id="tarif-output"
            inputMode="decimal"
            placeholder="sortie $/M"
            value={tarifOutput}
            onChange={(e) => setTarifOutput(e.target.value)}
            className="h-8 w-[110px] rounded-md border border-border bg-background px-2.5 text-right text-[12.5px] tabular-nums outline-none focus-visible:border-hermes"
          />
          <Button
            type="button"
            variant="primary"
            onClick={addTarif}
            disabled={!canAdd}
            className="h-8 cursor-pointer rounded-md bg-hermes-strong px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Ajouter
          </Button>
        </div>
        {pricingError ? (
          <p className="mt-2 text-[11px] font-medium text-warning" role="alert">
            Le service n&apos;a pas répondu — les tarifs enregistrés ne sont pas
            chargés. La déclaration est bloquée pour ne rien écraser.
          </p>
        ) : !pricingLoaded ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Chargement des tarifs…
          </p>
        ) : Object.keys(pricing).length > 0 ? (
          <ul className="mt-2.5 grid gap-1">
            {Object.entries(pricing).map(([id, p]) => (
              <li
                key={id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[12.5px]"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{labelOf(id)}</span>
                <span className="flex-none tabular-nums text-muted-foreground">
                  entrée {formatTarif(p.input)} · sortie {formatTarif(p.output)} $/M
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Retirer le tarif de ${labelOf(id)}`}
                  onClick={() => {
                    const next = { ...pricing };
                    delete next[id];
                    void savePricing(next);
                  }}
                  className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Aucun tarif déclaré — le coût d&apos;une réponse s&apos;affiche dès que
            son modèle en a un.
          </p>
        )}
      </div>
    </section>
  );
}

