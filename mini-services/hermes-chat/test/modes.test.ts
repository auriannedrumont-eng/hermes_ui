// Tests du référentiel des modes (modes.ts) — comportements dérivés du code :
// valeur inconnue → chat, bornes appliquées (jamais de refus muet),
// consignes résolues à chaque envoi avec interpolation au moment du tour.
import { describe, expect, it } from "vitest";
import {
  AUTO_RETRIES_MAX,
  CONVERSATION_MODES,
  COUNCIL_MEMBERS_MAX,
  COUNCIL_MEMBERS_MIN,
  DEBATE_ROUNDS_MAX,
  DEBATE_ROUNDS_MIN,
  DEFAULT_PROMPTS,
  MAX_MODE_PROMPT_CHARS,
  MODE_LABELS,
  MODE_PROMPT_KEYS,
  MODE_PROMPTS_KEY,
  VOICE_CHARS_DEFAULT,
  VOICE_CHARS_KEY,
  interpolatePrompt,
  modePromptSection,
  normalizeModeConfig,
  readPromptOverrides,
  resolveMode,
  resolveModePrompt,
  resolveVoiceChars,
  voiceModel,
  voicesFor,
  modeModel,
  type ModeConfig,
} from "../modes";

const fakeStore = (raw: string | null) => ({ getSetting: (_: string) => raw });

describe("resolveMode", () => {
  it("laisse passer un mode connu", () => {
    expect(resolveMode("debate")).toBe("debate");
    expect(resolveMode("council")).toBe("council");
  });

  it("retombe sur chat pour TOUTE valeur inconnue (jamais d'écran cassé)", () => {
    expect(resolveMode("DEBAT")).toBe("chat");
    expect(resolveMode("patate")).toBe("chat");
    expect(resolveMode(42)).toBe("chat");
    expect(resolveMode(null)).toBe("chat");
    expect(resolveMode(undefined)).toBe("chat");
    expect(resolveMode({})).toBe("chat");
  });

  it("expose exactement les 7 modes et leurs libellés", () => {
    expect(CONVERSATION_MODES).toHaveLength(7);
    for (const mode of CONVERSATION_MODES) expect(MODE_LABELS[mode]).toBeTruthy();
  });
});

describe("normalizeModeConfig — bornes appliquées, jamais de refus muet", () => {
  it("objet absent ou non objet → config vide", () => {
    expect(normalizeModeConfig(undefined)).toEqual({});
    expect(normalizeModeConfig(null)).toEqual({});
    expect(normalizeModeConfig("chat")).toEqual({});
  });

  it("clamp les tours du débat dans 3–10", () => {
    expect(normalizeModeConfig({ rounds: 7 }).rounds).toBe(7);
    expect(normalizeModeConfig({ rounds: 99 }).rounds).toBe(DEBATE_ROUNDS_MAX);
    expect(normalizeModeConfig({ rounds: 1 }).rounds).toBe(DEBATE_ROUNDS_MIN);
    expect(normalizeModeConfig({ rounds: "7" }).rounds).toBe(7);
    expect(normalizeModeConfig({ rounds: 3.6 }).rounds).toBe(4);
  });

  it("clamp les membres du conseil dans 2–5", () => {
    expect(normalizeModeConfig({ members: 12 }).members).toBe(COUNCIL_MEMBERS_MAX);
    expect(normalizeModeConfig({ members: 0 }).members).toBe(COUNCIL_MEMBERS_MIN);
  });

  it("clamp les reprises auto dans 0–3, non numérique → repli 2", () => {
    expect(normalizeModeConfig({ retries: 10 }).retries).toBe(AUTO_RETRIES_MAX);
    expect(normalizeModeConfig({ retries: -1 }).retries).toBe(0);
    expect(normalizeModeConfig({ retries: "abc" }).retries).toBe(2);
  });

  it("les booléens non-booléens sont ignorés", () => {
    expect(normalizeModeConfig({ autoDebate: "true" }).autoDebate).toBeUndefined();
    expect(normalizeModeConfig({ debateParallel: 1 }).debateParallel).toBeUndefined();
    expect(normalizeModeConfig({ autoDebate: false }).autoDebate).toBe(false);
  });

  it("normalise les ids webchat au format fusionné (legacy webchat:<site>:<mode> accepté)", () => {
    const cfg = normalizeModeConfig({
      model: { chat: "webchat:zai:answer" },
      voices: { debate: { sceptique: "webchat:aistudio:answer" } },
    });
    expect(cfg.model?.chat).toBe("webchat:zai");
    expect(cfg.voices?.debate?.sceptique).toBe("webchat:aistudio");
  });

  it("un modèle non webchat passe inchangé, une valeur vide → null", () => {
    const cfg = normalizeModeConfig({ model: { chat: "hermes-4-70b", plan: "   " } });
    expect(cfg.model?.chat).toBe("hermes-4-70b");
    expect(cfg.model?.plan).toBeNull();
  });

  it("une map de voix non-objet est ignorée", () => {
    const cfg = normalizeModeConfig({ voices: { debate: "pas une map" } });
    expect(cfg.voices?.debate).toBeUndefined();
  });
});

describe("voicesFor — miroir de « qui travaille »", () => {
  it("débat : 4 voix fixes", () => {
    const ids = voicesFor("debate", null).map((v) => v.id);
    expect(ids).toEqual(["sceptique", "pragmatique", "innovateur", "juge"]);
  });

  it("conseil : N membres + président, membres clampés 2–5", () => {
    expect(voicesFor("council", { members: 3 } as ModeConfig)).toHaveLength(4);
    expect(voicesFor("council", null).map((v) => v.id)).toEqual([
      "membre-a",
      "membre-b",
      "president",
    ]);
    expect(voicesFor("council", { members: 99 } as ModeConfig)).toHaveLength(COUNCIL_MEMBERS_MAX + 1);
  });

  it("comparaison : voix A et B", () => {
    expect(voicesFor("compare", null).map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("auto : débat de cadrage présent sauf autoDebate=false", () => {
    const defaut = voicesFor("auto", {} as ModeConfig).map((v) => v.id);
    expect(defaut).toEqual(["debat", "plan", "code", "test"]);
    const sansDebat = voicesFor("auto", { autoDebate: false } as ModeConfig).map((v) => v.id);
    expect(sansDebat).toEqual(["plan", "code", "test"]);
  });

  it("modes sans voix → tableau vide", () => {
    expect(voicesFor("chat", null)).toEqual([]);
    expect(voicesFor("plan", null)).toEqual([]);
    expect(voicesFor("code", null)).toEqual([]);
  });
});

describe("voiceModel / modeModel", () => {
  const config: ModeConfig = {
    voices: { debate: { sceptique: "webchat:zai", juge: "   " } },
    model: { chat: "hermes-4-70b" },
  };
  it("choix par conversation, blanc = null (suit le fil)", () => {
    expect(voiceModel("debate", config, "sceptique")).toBe("webchat:zai");
    expect(voiceModel("debate", config, "juge")).toBeNull();
    expect(voiceModel("debate", null, "sceptique")).toBeNull();
    expect(modeModel(config, "chat")).toBe("hermes-4-70b");
    expect(modeModel(config, "plan")).toBeNull();
  });
});

describe("consignes : lecture des surcharges et résolution au tour", () => {
  it("13 consignes par défaut, clés uniques", () => {
    expect(MODE_PROMPT_KEYS).toHaveLength(13);
    expect(new Set(MODE_PROMPT_KEYS).size).toBe(13);
    expect(MODE_PROMPTS_KEY).toBe("hermes.modes.prompts");
    expect(MAX_MODE_PROMPT_CHARS).toBe(4_000);
  });

  it("store muet ou JSON invalide → défauts, jamais de plantage", () => {
    expect(readPromptOverrides(fakeStore(null))).toEqual({});
    expect(readPromptOverrides(fakeStore("{ pas du json"))).toEqual({});
    expect(readPromptOverrides(fakeStore("42"))).toEqual({});
  });

  it("surcharge : clés inconnues filtrées, texte trop long filtré, texte valide gardé", () => {
    // Structure réelle : { mode: { voix: texte } } — une clé plate « plan.main »
    // au premier niveau est ignorée (map non-objet).
    const raw = JSON.stringify({
      plan: { main: "Plan sur-mesure" },
      inconnu: { main: "fantôme" },
      debate: { conseiller: "x".repeat(MAX_MODE_PROMPT_CHARS + 1) },
    });
    expect(readPromptOverrides(fakeStore(raw))).toEqual({ "plan.main": "Plan sur-mesure" });
  });

  it("une clé plate au premier niveau (pas {mode:{voix}}) est ignorée", () => {
    const raw = JSON.stringify({ "plan.main": "Plan modifié" });
    expect(readPromptOverrides(fakeStore(raw))).toEqual({});
  });

  it("resolveModePrompt : surcharge d'abord, défaut sinon, vide → null", () => {
    const override = JSON.stringify({ plan: { main: "Plan modifié" } });
    expect(resolveModePrompt(fakeStore(override), "plan.main")).toBe("Plan modifié");
    expect(resolveModePrompt(fakeStore(null), "plan.main")).toBe(DEFAULT_PROMPTS["plan.main"]);
    expect(resolveModePrompt(fakeStore(null), "chat.main")).toBeNull();
    expect(resolveModePrompt(fakeStore(null), "inexistant.main")).toBeNull();
  });

  it("interpolation : mots-clés remplacés, inconnus laissés tels quels", () => {
    expect(interpolatePrompt("{angle} en {tours} tours", { angle: "coût", tours: 3 })).toBe(
      "coût en 3 tours",
    );
    expect(interpolatePrompt("{patate}", { angle: "x" })).toBe("{patate}");
    expect(interpolatePrompt("{membres}", {})).toBe("{membres}");
  });

  it("resolveVoiceChars : défaut, non numérique, bornes 500–8000", () => {
    expect(resolveVoiceChars(fakeStore(null))).toBe(VOICE_CHARS_DEFAULT);
    expect(resolveVoiceChars(fakeStore("abc"))).toBe(VOICE_CHARS_DEFAULT);
    expect(resolveVoiceChars(fakeStore("5000"))).toBe(5000);
    expect(resolveVoiceChars(fakeStore("999999"))).toBe(8000);
    expect(resolveVoiceChars(fakeStore("100"))).toBe(500);
    expect(resolveVoiceChars(fakeStore("1500.6"))).toBe(1501);
    expect(VOICE_CHARS_KEY).toBe("hermes.modes.voiceChars");
  });

  it("modePromptSection : en-tête libellé + corps", () => {
    expect(modePromptSection("Plan", "Fais un plan")).toBe(
      "Mode « Plan » actif pour cette conversation :\nFais un plan",
    );
  });
});
