// Catalogue de modèles Hermes (Nous Research) + résolution de libellés.
// En mode « gateway », la liste réelle est récupérée depuis la gateway
// (GET /api/model/options) ; ce catalogue sert de repli honnête.
import type { ModelOption, ModelsResult } from "./types";

/** Échelle d'effort du portail Nous Research (repli du catalogue). */
const NOUS_EFFORTS = ["off", "standard", "élevé"];
const NOUS_EFFORT_LABEL = "Nous Portal";

export const MODEL_CATALOG: ModelOption[] = [
  {
    id: "hermes-4-405b",
    label: "Hermes 4 405B",
    provider: "Nous Research",
    description: "Le plus capable — raisonnement avancé, code et outils",
    badge: "Flagship",
    efforts: NOUS_EFFORTS,
    effortLabel: NOUS_EFFORT_LABEL,
    contextWindow: 128_000,
  },
  {
    id: "hermes-4-70b",
    label: "Hermes 4 70B",
    provider: "Nous Research",
    description: "Équilibre performance / latence pour l'usage quotidien",
    badge: "Défaut",
    efforts: NOUS_EFFORTS,
    effortLabel: NOUS_EFFORT_LABEL,
    contextWindow: 128_000,
  },
  {
    id: "hermes-4-14b",
    label: "Hermes 4 14B",
    provider: "Nous Research",
    description: "Rapide et léger, idéal pour les échanges courts",
    efforts: NOUS_EFFORTS,
    effortLabel: NOUS_EFFORT_LABEL,
    contextWindow: 128_000,
  },
  {
    id: "hermes-3-405b",
    label: "Hermes 3 405B",
    provider: "Nous Research",
    description: "Génération précédente, toujours solide en agent",
    efforts: NOUS_EFFORTS,
    effortLabel: NOUS_EFFORT_LABEL,
    contextWindow: 128_000,
  },
  {
    id: "hermes-3-8b",
    label: "Hermes 3 8B",
    provider: "Nous Research",
    description: "Ultra-léger, réponses quasi instantanées",
    efforts: NOUS_EFFORTS,
    effortLabel: NOUS_EFFORT_LABEL,
    contextWindow: 128_000,
  },
];

export const DEFAULT_MODEL_ID = "hermes-4-70b";

export function catalogModelsResult(): ModelsResult {
  return {
    models: MODEL_CATALOG,
    defaultModel: DEFAULT_MODEL_ID,
    source: "catalogue",
  };
}

/** Libellé d'affichage pour un id de modèle (repli : l'id brut). */
export function modelLabel(id?: string | null): string {
  if (!id) return "";
  const found = MODEL_CATALOG.find((m) => m.id === id);
  return found ? found.label : id;
}
