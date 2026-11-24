// Tests de prompts.ts — sanitizeExpertSettings (garde contre Number(null)=0),
// composition du systemPrompt local, presets semés.
import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_MEMORY_CHARS,
  MAX_PROMPT_CHARS,
  MEMORY_NOTES_KEY,
  SEED_PRESETS,
  composeLocalSystemPrompt,
  sanitizeExpertSettings,
  validatePromptText,
} from "../prompts";

describe("sanitizeExpertSettings — null/vide = champ ignoré, jamais 0 actif", () => {
  it("entrée absente → objet vide", () => {
    expect(sanitizeExpertSettings(undefined)).toEqual({});
    expect(sanitizeExpertSettings(null)).toEqual({});
    expect(sanitizeExpertSettings({})).toEqual({});
  });

  it("temperature bornée 0–1, chaîne numérique acceptée", () => {
    expect(sanitizeExpertSettings({ temperature: 0.7 }).temperature).toBe(0.7);
    expect(sanitizeExpertSettings({ temperature: "0.7" }).temperature).toBe(0.7);
    expect(sanitizeExpertSettings({ temperature: 1.5 }).temperature).toBe(1);
    expect(sanitizeExpertSettings({ temperature: -0.5 }).temperature).toBe(0);
  });

  it("maxTokens borné 1–8192, arrondi", () => {
    expect(sanitizeExpertSettings({ maxTokens: "100.4" }).maxTokens).toBe(100);
    expect(sanitizeExpertSettings({ maxTokens: 0 }).maxTokens).toBe(1);
    expect(sanitizeExpertSettings({ maxTokens: 99_999 }).maxTokens).toBe(8192);
  });

  it("seed borné 0–2^31-1, arrondi", () => {
    expect(sanitizeExpertSettings({ seed: 4_294_967_296 }).seed).toBe(2 ** 31 - 1);
    expect(sanitizeExpertSettings({ seed: -3 }).seed).toBe(0);
    expect(sanitizeExpertSettings({ seed: 10.9 }).seed).toBe(11);
  });

  it("null, undefined, chaîne vide, non-fini → champ ABSENT (pas 0)", () => {
    const out = sanitizeExpertSettings({
      temperature: null,
      maxTokens: "",
      seed: Number.NaN,
    });
    expect(out).toEqual({});
  });
});

describe("composeLocalSystemPrompt — sections dans l'ordre, absentes omises", () => {
  it("base seule", () => {
    expect(composeLocalSystemPrompt({ base: "BASE" })).toBe("BASE");
  });

  it("ordre stable : mémoire, instructions, prompt de conversation (jointes par une ligne vide)", () => {
    const out = composeLocalSystemPrompt({
      base: "BASE",
      memoryNotes: "note mémoire",
      customInstructions: "instruction",
      conversationPrompt: "prompt conversation",
    });
    expect(out).toBe(
      [
        "BASE",
        "Mémoire de l'utilisateur (ce qu'Hermes retient des échanges) :\nnote mémoire",
        "Instructions personnalisées de l'utilisateur :\ninstruction",
        "Prompt système de cette conversation :\nprompt conversation",
      ].join("\n\n"),
    );
  });

  it("sections vides ou blanches omises", () => {
    const out = composeLocalSystemPrompt({
      base: "BASE",
      memoryNotes: "   ",
      customInstructions: null,
    });
    expect(out).toBe("BASE");
    expect(out).not.toContain("Mémoire");
    expect(out).not.toContain("Instructions");
  });
});

describe("presets semés et limites", () => {
  it("5 presets, titres et contenus non vides, vitrine présente", () => {
    expect(SEED_PRESETS).toHaveLength(5);
    for (const p of SEED_PRESETS) {
      expect(p.title.trim()).toBeTruthy();
      expect(p.content.trim()).toBeTruthy();
    }
    expect(SEED_PRESETS.map((p) => p.title)).toContain("Vitrine d'artefacts");
  });

  it("limites documentées", () => {
    expect(MAX_MEMORY_CHARS).toBe(12_000);
    expect(MAX_PROMPT_CHARS).toBe(12_000);
    expect(MAX_CUSTOM_INSTRUCTIONS_CHARS).toBe(4_000);
    expect(MEMORY_NOTES_KEY).toBe("hermes.memory.notes");
  });
});

describe("validatePromptText — erreur FR courte ou null", () => {
  it("vide ou blanc → erreur", () => {
    expect(validatePromptText("", 4000)).toBe("Le prompt ne peut pas être vide");
    expect(validatePromptText("   ", 4000)).toBe("Le prompt ne peut pas être vide");
  });

  it("trop long → erreur avec la limite formatée", () => {
    expect(validatePromptText("x".repeat(4001), 4000)).toBe(
      `Trop long (max ${Number(4000).toLocaleString("fr-FR")} caractères)`,
    );
  });

  it("texte valide → null", () => {
    expect(validatePromptText("  un prompt  ", 4000)).toBeNull();
  });
});
