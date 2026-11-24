// Tests du catalogue de repli (models.ts) — l'invariant qui porte le design :
// le modèle PAR DÉFAUT doit toujours être un modèle DU catalogue (jamais un
// webchat, jamais un id fantôme), sinon le repli « moteur muet » est menteur.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  catalogModelsResult,
  modelLabel,
} from "../models";

describe("MODEL_CATALOG", () => {
  it("5 modèles Hermes, ids uniques, tous Nous Research", () => {
    expect(MODEL_CATALOG).toHaveLength(5);
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(5);
    for (const m of MODEL_CATALOG) expect(m.provider).toBe("Nous Research");
  });

  it("chaque modèle porte l'échelle d'effort du portail et une fenêtre de contexte", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.efforts).toEqual(["off", "standard", "élevé"]);
      expect(m.effortLabel).toBe("Nous Portal");
      expect(m.contextWindow).toBe(128_000);
    }
  });

  it("INVARIANT : le modèle par défaut appartient au catalogue", () => {
    expect(DEFAULT_MODEL_ID).toBe("hermes-4-70b");
    expect(MODEL_CATALOG.some((m) => m.id === DEFAULT_MODEL_ID)).toBe(true);
  });
});

describe("catalogModelsResult — le repli honnête « moteur muet »", () => {
  it("source catalogue, modèle par défaut, liste complète", () => {
    const result = catalogModelsResult();
    expect(result.source).toBe("catalogue");
    expect(result.defaultModel).toBe(DEFAULT_MODEL_ID);
    expect(result.models).toBe(MODEL_CATALOG);
  });
});

describe("modelLabel", () => {
  it("id connu → libellé, id inconnu → brut, vide → chaîne vide", () => {
    expect(modelLabel("hermes-4-70b")).toBe("Hermes 4 70B");
    expect(modelLabel("patate-inconnue")).toBe("patate-inconnue");
    expect(modelLabel(null)).toBe("");
    expect(modelLabel(undefined)).toBe("");
    expect(modelLabel("")).toBe("");
  });
});
