// Tests des fiches webchat (webchat/fiches.ts) — les sélecteurs sont des
// DONNÉES ; les invariants testés ici sont ceux que la spec §6 impose :
// un site non vérifié est INDISPONIBLE, l'id de modèle webchat est UNE
// entrée par site (format fusionné), le format legacy reste lisible.
import { describe, expect, it } from "vitest";
import {
  FICHES,
  normalizeWebchatModelId,
  parseWebchatModelId,
  webchatModelId,
  type WebchatSiteId,
} from "../webchat/fiches";

const SITES: WebchatSiteId[] = ["zai", "aistudio", "gemini-app"];

describe("FICHES — invariants de structure", () => {
  it("trois sites exactement", () => {
    expect(Object.keys(FICHES).sort()).toEqual(SITES.sort());
  });

  it("z.ai et AI Studio vérifiés, gemini-app en attente de relevé", () => {
    expect(FICHES.zai.verifie).toBe(true);
    expect(FICHES.aistudio.verifie).toBe(true);
    expect(FICHES["gemini-app"].verifie).toBe(false);
  });

  it("un site vérifié porte des sélecteurs, un site non vérifié reste vide sans mentir", () => {
    expect(FICHES.zai.sel_compositeur).toBeTruthy();
    expect(FICHES.zai.compositeur_pret).toBeTruthy();
    expect(FICHES["gemini-app"].sel_compositeur).toBe("");
    expect(FICHES["gemini-app"].compositeur_pret).toBe("");
  });

  it("modes exposés : z.ai answer+build, les autres answer seul", () => {
    expect(FICHES.zai.modes).toEqual(["answer", "build"]);
    expect(FICHES.aistudio.modes).toEqual(["answer"]);
    expect(FICHES["gemini-app"].modes).toEqual(["answer"]);
  });
});

describe("parseWebchatModelId", () => {
  it("format fusionné webchat:<site>", () => {
    expect(parseWebchatModelId("webchat:zai")).toEqual({ site: "zai" });
    expect(parseWebchatModelId("webchat:aistudio")).toEqual({ site: "aistudio" });
  });

  it("format legacy webchat:<site>:<mode> accepté si le mode est exposé", () => {
    expect(parseWebchatModelId("webchat:zai:answer")).toEqual({ site: "zai" });
    expect(parseWebchatModelId("webchat:zai:build")).toEqual({ site: "zai" });
  });

  it("legacy refusé si le mode n'est pas exposé par la fiche", () => {
    expect(parseWebchatModelId("webchat:aistudio:build")).toBeNull();
    expect(parseWebchatModelId("webchat:gemini-app:build")).toBeNull();
  });

  it("site inconnu, mode invalide, non webchat, vide → null", () => {
    expect(parseWebchatModelId("webchat:patate")).toBeNull();
    expect(parseWebchatModelId("webchat:zai:patate")).toBeNull();
    expect(parseWebchatModelId("webchat:")).toBeNull();
    expect(parseWebchatModelId("hermes-4-70b")).toBeNull();
    expect(parseWebchatModelId("webchat:zai:answer:extra")).toBeNull();
    expect(parseWebchatModelId(null)).toBeNull();
    expect(parseWebchatModelId(undefined)).toBeNull();
    expect(parseWebchatModelId("")).toBeNull();
  });
});

describe("webchatModelId / normalizeWebchatModelId", () => {
  it("construction de l'id fusionné", () => {
    expect(webchatModelId("zai")).toBe("webchat:zai");
    expect(webchatModelId("gemini-app")).toBe("webchat:gemini-app");
  });

  it("normalisation : legacy → fusion, id non webchat inchangé", () => {
    expect(normalizeWebchatModelId("webchat:zai:answer")).toBe("webchat:zai");
    expect(normalizeWebchatModelId("hermes-4-70b")).toBe("hermes-4-70b");
  });
});
