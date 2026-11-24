// Tests de parseModelOptions (hermes-connector.ts) — l'extrait tolérant du
// catalogue gateway : fonction exportée par l'audit CRAP 2026-11 pour être
// pincée ici (densité de décisions la plus élevée du repo : CC 66 / 49 lignes).
import { describe, expect, it } from "vitest";
import { parseModelOptions } from "../hermes-connector";

describe("formes plates", () => {
  it("chaînes brutes → provider « Gateway »", () => {
    expect(parseModelOptions({ models: ["m1", "m2"] })).toEqual([
      { id: "m1", label: "m1", provider: "Gateway", description: undefined, efforts: undefined, effortLabel: undefined, contextWindow: undefined },
      { id: "m2", label: "m2", provider: "Gateway", description: undefined, efforts: undefined, effortLabel: undefined, contextWindow: undefined },
    ]);
  });

  it("objets : id ?? name ?? model, libellé replié sur l'id", () => {
    expect(parseModelOptions({ models: [{ id: "a", label: "A" }, { name: "b" }, { model: "c" }] })).toEqual([
      { id: "a", label: "A", provider: "Gateway", description: undefined, efforts: undefined, effortLabel: undefined, contextWindow: undefined },
      { id: "b", label: "b", provider: "Gateway", description: undefined, efforts: undefined, effortLabel: undefined, contextWindow: undefined },
      { id: "c", label: "c", provider: "Gateway", description: undefined, efforts: undefined, effortLabel: undefined, contextWindow: undefined },
    ]);
  });

  it("déduplication par id", () => {
    const out = parseModelOptions({ models: ["m1", { id: "m1" }, "m2", { name: "m2" }] });
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("id non chaîne ou vide → ignoré silencieusement", () => {
    expect(parseModelOptions({ models: [null, 42, {}, { id: "" }, { id: 7 }] })).toEqual([]);
  });
});

describe("formes imbriquées (providers)", () => {
  it("data.providers[].models avec nom de provider", () => {
    const out = parseModelOptions({
      providers: [{ name: "Nous", models: [{ id: "h4", label: "Hermes 4" }] }],
    });
    expect(out).toEqual([
      { id: "h4", label: "Hermes 4", provider: "Nous", description: undefined, efforts: undefined, effortLabel: undefined, contextWindow: undefined },
    ]);
  });

  it("data.result.providers et model_options acceptés aussi", () => {
    const out = parseModelOptions({
      result: { providers: [{ id: "p1", model_options: ["x"] }] },
    });
    expect(out[0].id).toBe("x");
    expect(out[0].provider).toBe("p1");
  });

  it("chaîne plate data.options acceptée, doublon inter-formes dédupliqué", () => {
    const out = parseModelOptions({
      providers: [{ name: "Nous", models: ["h4"] }],
      options: ["h4", "h5"],
    });
    expect(out.map((m) => m.id)).toEqual(["h4", "h5"]);
    expect(out[0].provider).toBe("Nous");
  });
});

describe("efforts — échelle, interrupteur budget, ou rien", () => {
  it("tableau de crans → mappé en chaînes", () => {
    const out = parseModelOptions({ models: [{ id: "a", efforts: ["off", "low"] }] });
    expect(out[0].efforts).toEqual(["off", "low"]);
    expect(out[0].effortLabel).toBeUndefined();
  });

  it("effort_options et reasoning_efforts acceptés comme synonymes", () => {
    expect(parseModelOptions({ models: [{ id: "a", effort_options: [1, 2] }] })[0].efforts).toEqual(["1", "2"]);
    expect(parseModelOptions({ models: [{ id: "a", reasoning_efforts: ["min"] }] })[0].efforts).toEqual(["min"]);
  });

  it("booléen true → interrupteur [off, on] + étiquette « budget »", () => {
    const out = parseModelOptions({ models: [{ id: "a", efforts: true }] });
    expect(out[0].efforts).toEqual(["off", "on"]);
    expect(out[0].effortLabel).toBe("budget");
  });

  it("effortLabel explicite respecté ; avec efforts=true, effort_label est ÉCRASÉ par « budget » (anomalie mineure relevée à l'audit, comportement pincé tel quel)", () => {
    expect(parseModelOptions({ models: [{ id: "a", efforts: true, effort_label: "Nous Portal" }] })[0].effortLabel).toBe("budget");
    expect(parseModelOptions({ models: [{ id: "a", efforts: true, effortLabel: "déjà posé" }] })[0].effortLabel).toBe("déjà posé");
  });
});

describe("context window et description", () => {
  it("context_window / contextWindow / context_length numériques > 0", () => {
    expect(parseModelOptions({ models: [{ id: "a", context_window: 128000 }] })[0].contextWindow).toBe(128000);
    expect(parseModelOptions({ models: [{ id: "a", context_length: 32000 }] })[0].contextWindow).toBe(32000);
    expect(parseModelOptions({ models: [{ id: "a", contextWindow: -5 }] })[0].contextWindow).toBeUndefined();
    expect(parseModelOptions({ models: [{ id: "a", context_window: "128k" }] })[0].contextWindow).toBeUndefined();
  });

  it("configured=false → description « Non configuré »", () => {
    expect(parseModelOptions({ models: [{ id: "a", configured: false }] })[0].description).toBe("Non configuré");
    expect(parseModelOptions({ models: [{ id: "a", description: "libre" }] })[0].description).toBe("libre");
  });
});

describe("entrées non exploitables", () => {
  it("data vide, sans modèles, ou formes non-tableau → liste vide", () => {
    expect(parseModelOptions(undefined)).toEqual([]);
    expect(parseModelOptions(null)).toEqual([]);
    expect(parseModelOptions({})).toEqual([]);
    expect(parseModelOptions({ models: "pas un tableau" })).toEqual([]);
    expect(parseModelOptions({ providers: "pas un tableau" })).toEqual([]);
    expect(parseModelOptions({ providers: [{ name: "p" }] })).toEqual([]);
  });
});
