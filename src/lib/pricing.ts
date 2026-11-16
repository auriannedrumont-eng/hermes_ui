// Tarifs des modèles et coût des réponses (F-21).
// Les tarifs sont saisis par l'utilisatrice (volet Paramètres → Modèles) et
// persistés côté service sous la clé `hermes.pricing` : JSON
// { "<id du modèle>": { "input": <$/M jetons entrée>, "output": <$/M sortie> } }.
// Aucun tarif n'est pré-rempli : le coût affiché est celui que VOUS déclarez —
// le fournisseur fait foi.
export const PRICING_KEY = "hermes.pricing";

export interface ModelPricing {
  /** $ par million de jetons d'entrée. */
  input: number;
  /** $ par million de jetons de sortie. */
  output: number;
}

export type PricingMap = Record<string, ModelPricing>;

/** Tarif par défaut d'une carte de saisie (champ vide = non renseigné). */
export const EMPTY_PRICING: ModelPricing = { input: 0, output: 0 };

/** Analyse tolérante du JSON des tarifs (réglage `hermes.pricing`). */
export function parsePricing(raw: string | null | undefined): PricingMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: PricingMap = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id || typeof v !== "object" || v === null) continue;
      const { input, output } = v as { input?: unknown; output?: unknown };
      const i = Number(input);
      const o = Number(output);
      if (Number.isFinite(i) && i >= 0 && Number.isFinite(o) && o >= 0) {
        out[id] = { input: i, output: o };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Décompose un libellé persisté : « glm-4.6 · z.ai » → { id: "glm-4.6",
 *  provider: "z.ai" } ; un libellé sans fournisseur → { id } seul. */
export function parseModelLabel(label?: string | null): {
  id: string;
  provider?: string;
} | null {
  if (!label) return null;
  let rest = label.trim();
  let provider: string | undefined;
  const dot = rest.lastIndexOf("·");
  if (dot >= 0) {
    provider = rest.slice(dot + 1).trim() || undefined;
    rest = rest.slice(0, dot).trim();
  }
  if (!rest) return null;
  return { id: rest, provider };
}

/** Coût d'un tour à partir des tarifs déclarés ($/M jetons). null si les
 *  tarifs du modèle ne sont pas renseignés ou incomplets. */
export function estimateCost(
  usage: { input?: number; output?: number },
  pricing: ModelPricing | undefined,
): number | null {
  if (!pricing) return null;
  if (pricing.input <= 0 && pricing.output <= 0) return null;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cost = (input / 1e6) * pricing.input + (output / 1e6) * pricing.output;
  return cost > 0 ? cost : 0;
}

/** Montant en dollars lisible : « 0,0012 $ », « 12,40 $ », « < 0,0001 $ ». */
export function formatUsd(n: number): string {
  if (n < 0.0001) return "< 0,0001 $";
  if (n >= 1) {
    return `${n.toLocaleString("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} $`;
  }
  return `${n.toLocaleString("fr-FR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} $`;
}

/** Jetons formatés : « 1 234 », « 21,4k ». */
export function formatTokens(n: number): string {
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("fr-FR");
}
