// Modes du compositeur (F-30) — référentiel côté service.
// Sept modes : chat · plan · code · compare · debate · council · auto.
// Ce fichier fait foi : le client (src/lib/modes.ts) n'en est que le miroir
// d'affichage. Toute valeur inconnue retombe sur « chat » au chargement et à
// l'envoi, sans casser l'écran (resolveMode).
//
// Les 13 consignes par défaut vivent ICI (DEFAULT_PROMPTS) ; l'édition est
// enregistrée dans la table settings du service sous la clé
// `hermes.modes.prompts` (JSON { mode: { voix: texte } }) — surcharge absente
// ou null = défaut de ce fichier. La résolution se fait À CHAQUE ENVOI
// (resolveModePrompt) : le systemPrompt est recomposé, une édition s'applique
// au prochain message de toutes les conversations, sans redémarrage.
//
// Bornes affichées à l'écran et revalidées ici : débat 3–10 tours,
// conseil 2–5 membres, auto 0–3 reprises, consigne 4 000 caractères.

// ── Identifiants et libellés ────────────────────────────────────────────

export type ConversationMode =
  | "chat"
  | "plan"
  | "code"
  | "compare"
  | "debate"
  | "council"
  | "auto";

export const CONVERSATION_MODES: ConversationMode[] = [
  "chat",
  "plan",
  "code",
  "compare",
  "debate",
  "council",
  "auto",
];

/** Valeur inconnue → chat (jamais d'écran cassé, jamais de tour refusé). */
export function resolveMode(value: unknown): ConversationMode {
  return CONVERSATION_MODES.includes(value as ConversationMode)
    ? (value as ConversationMode)
    : "chat";
}

export const MODE_LABELS: Record<ConversationMode, string> = {
  chat: "Chat",
  plan: "Plan",
  code: "Code",
  compare: "Comparer",
  debate: "Débat",
  council: "Conseil",
  auto: "Auto",
};

// ── Bornes (affichées dans l'UI, revalidées ici — arrêtées à la saisie) ──

export const DEBATE_ROUNDS_MIN = 3;
export const DEBATE_ROUNDS_MAX = 10;
export const COUNCIL_MEMBERS_MIN = 2;
export const COUNCIL_MEMBERS_MAX = 5;
export const AUTO_RETRIES_MIN = 0;
export const AUTO_RETRIES_MAX = 3;
export const MAX_MODE_PROMPT_CHARS = 4_000;

/** Clé du registre serveur portant les surcharges des 13 consignes. */
export const MODE_PROMPTS_KEY = "hermes.modes.prompts";

// ── Config d'une conversation (JSON conversations.mode_config) ─────────

export interface ModeConfig {
  /** Débat : tours par conversation (3–10). */
  rounds?: number;
  /** Conseil : membres par conversation (2–5). */
  members?: number;
  /** Auto : reprises après échec (0–3). */
  retries?: number;
  /** Auto : débat préalable de cadrage (désactivable pour les tâches évidentes). */
  autoDebate?: boolean;
  /** Modèle par voix — null/absent = modèle de la conversation. */
  voices?: Record<string, Record<string, string | null>>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Normalise une charge client : bornes appliquées (jamais de refus muet —
 *  la valeur est ramenée dans les limites affichées à l'écran). */
export function normalizeModeConfig(raw: unknown): ModeConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: ModeConfig = {};
  if (src.rounds !== undefined && src.rounds !== null)
    out.rounds = clampInt(src.rounds, DEBATE_ROUNDS_MIN, DEBATE_ROUNDS_MAX, DEBATE_ROUNDS_MIN);
  if (src.members !== undefined && src.members !== null)
    out.members = clampInt(src.members, COUNCIL_MEMBERS_MIN, COUNCIL_MEMBERS_MAX, COUNCIL_MEMBERS_MIN);
  if (src.retries !== undefined && src.retries !== null)
    out.retries = clampInt(src.retries, AUTO_RETRIES_MIN, AUTO_RETRIES_MAX, 2);
  if (typeof src.autoDebate === "boolean") out.autoDebate = src.autoDebate;
  if (src.voices && typeof src.voices === "object") {
    const voices: Record<string, Record<string, string | null>> = {};
    for (const [modeKey, map] of Object.entries(src.voices as Record<string, unknown>)) {
      if (!map || typeof map !== "object") continue;
      const slot: Record<string, string | null> = {};
      for (const [voiceId, model] of Object.entries(map as Record<string, unknown>)) {
        slot[voiceId] = typeof model === "string" && model.trim() ? model.trim() : null;
      }
      voices[modeKey] = slot;
    }
    out.voices = voices;
  }
  return out;
}

// ── Voix des modes multi-acteurs (miroir de « qui travaille ») ──────────

export interface ModeVoice {
  id: string;
  name: string;
  role: string;
}

/** Les voix du mode — utilisées par l'orchestrateur et le panneau « qui
 *  travaille » du client. La config porte les choix par conversation. */
export function voicesFor(
  mode: ConversationMode,
  config: ModeConfig | null,
): ModeVoice[] {
  if (mode === "debate") {
    return [
      { id: "sceptique", name: "Sceptique", role: "conseiller — cherche ce qui casse" },
      { id: "pragmatique", name: "Pragmatique", role: "conseiller — pèse le coût réel" },
      { id: "innovateur", name: "Innovateur", role: "conseiller — cherche l'angle neuf" },
      { id: "juge", name: "Juge", role: "compare les tours, rend le verdict" },
    ];
  }
  if (mode === "council") {
    const members = clampInt(
      config?.members,
      COUNCIL_MEMBERS_MIN,
      COUNCIL_MEMBERS_MAX,
      COUNCIL_MEMBERS_MIN,
    );
    const letters = ["A", "B", "C", "D", "E"];
    const out: ModeVoice[] = [];
    for (let i = 0; i < members; i++) {
      out.push({
        id: `membre-${letters[i].toLowerCase()}`,
        name: `Membre ${letters[i]}`,
        role: "lecture seule — ne voit pas les autres",
      });
    }
    out.push({ id: "president", name: "Président", role: "compare les avis anonymisés, fusionne" });
    return out;
  }
  if (mode === "compare") {
    return [
      { id: "a", name: "Voix A", role: "première colonne" },
      { id: "b", name: "Voix B", role: "seconde colonne" },
    ];
  }
  if (mode === "auto") {
    const roles: ModeVoice[] = [];
    if (config?.autoDebate !== false)
      roles.push({ id: "debat", name: "Débat", role: "cadrage préalable — 3 tours" });
    roles.push({ id: "plan", name: "Plan", role: "chef de projet — étapes" });
    roles.push({ id: "code", name: "Code", role: "constructeur — applique" });
    roles.push({ id: "test", name: "Test", role: "testeur — prouve" });
    return roles;
  }
  return [];
}

/** Modèle d'une voix : choix par conversation (mode_config.voices) sinon
 *  null = modèle de la conversation (l'orchestrateur suit le fil). */
export function voiceModel(
  mode: ConversationMode,
  config: ModeConfig | null,
  voiceId: string,
): string | null {
  const slot = config?.voices?.[mode]?.[voiceId];
  return typeof slot === "string" && slot.trim() ? slot.trim() : null;
}

// ── Les 13 consignes par défaut (miroir exact de la maquette validée) ───

export const DEFAULT_PROMPTS: Record<string, string> = {
  "chat.main": "",
  "plan.main":
    "Tu es chef de projet. Avant toute modification, propose un plan d'étapes numérotées — une seule fin par étape, jamais d'estimation de durée. Ne modifie rien tant que le plan n'est pas accepté.",
  "code.main":
    "Lis avant de changer : ouvre les fichiers concernés, ne renomme rien sans raison, prouve chaque modification par une commande et sa sortie. Jamais de « c'est fait » sans la preuve qui le montre.",
  "debate.conseiller":
    "Tu es conseiller ({angle}) dans un débat de {tours} tours. Chaque tour voit ce qui a été dit avant : contredis sur des faits, jamais sur des généralités. Cite ce qui casse, ce qui tient, et à quelles conditions.",
  "debate.juge":
    "Tu rends le verdict après {tours} tours. Compare les arguments réellement tenus, tranche une seule position, dis ce que tu écartes et pourquoi. Une position tranchée vaut mieux qu'une synthèse tiède.",
  "council.membre":
    "Tu es membre d'un conseil en lecture seule : tu ne vois ni les autres membres ni leurs avis, tu ne peux rien modifier. Donne un avis autonome en points fermes, avec ce qui reste à vérifier.",
  "council.president":
    "{membres} avis anonymisés t'ont été remis, sans attribution. Compare-les, dis ce que tu écartes et pourquoi, puis fusionne en une seule réponse qui tranche — la fusion est signée de toi seul.",
  "auto.debat":
    "Cadrage express avant d'agir : ce qui fait consensus, ce qui reste ouvert, l'angle d'attaque retenu. Pas de code à ce stade.",
  "auto.plan":
    "Établis le plan d'exécution : étapes numérotées, critère de réussite par étape, fichiers concernés. Rien n'est modifié à ce stade.",
  "auto.code":
    "Applique le plan, une étape à la fois : preuve par commande et sortie pour chaque modification. Ne renomme rien sans raison.",
  "auto.test":
    "Prouve que ça tient : rejoue les critères du plan et montre la sortie qui les valide. Tout écart devient la cause racine de la reprise.",
  "auto.reprise":
    "L'échec est prouvé : identifie LA cause racine — jamais la rustine au jugé — corrige à cet endroit précis, puis repasse le test. Reprises restantes : {reprises}.",
  "compare.main": "",
};

export const MODE_PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS);

/** La règle de lecture seule du conseil n'est PAS une consigne modifiable :
 *  le moteur la fait respecter de toute façon (contrat intact, maquette §spec). */
export const COUNCIL_READ_ONLY_RULE =
  "Rappel de la règle du conseil : tu ne peux rien écrire ni exécuter — lecture seule.";

/** Interpolation des mots-clés au moment de l'envoi — jamais enregistrés
 *  remplacés. Une valeur inconnue reste telle quelle (jamais de casse). */
export function interpolatePrompt(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(angle|tours|membres|reprises)\}/g, (full, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? full : String(v);
  });
}

export interface ModePromptStore {
  getSetting(key: string): string | null;
}

/** Lit les surcharges enregistrées (settings du service). Charge invalide
 *  ou tronquée au-delà de la limite = défaut (jamais de plantage). */
export function readPromptOverrides(store: ModePromptStore): Record<string, string> {
  const raw = store.getSetting(MODE_PROMPTS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [modeKey, map] of Object.entries(parsed as Record<string, unknown>)) {
      if (!map || typeof map !== "object") continue;
      for (const [voiceKey, text] of Object.entries(map as Record<string, unknown>)) {
        const key = `${modeKey}.${voiceKey}`;
        if (!MODE_PROMPT_KEYS.includes(key)) continue;
        if (typeof text !== "string") continue;
        if (text.length > MAX_MODE_PROMPT_CHARS) continue; // tronqué à la saisie, revalidé ici
        out[key] = text;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Résout une consigne au tour : réglage modifié d'abord, défaut sinon,
 *  mots-clés remplacés. Retourne null si la consigne résolue est vide. */
export function resolveModePrompt(
  store: ModePromptStore,
  key: string,
  vars: Record<string, string | number> = {},
): string | null {
  const overrides = readPromptOverrides(store);
  const text = (overrides[key] ?? DEFAULT_PROMPTS[key] ?? "").trim();
  if (!text) return null;
  return interpolatePrompt(text, vars);
}

/** Section « mode » ajoutée au systemPrompt du tour (recomposé à chaque
 *  envoi — aucune consigne fantôme possible). */
export function modePromptSection(label: string, text: string): string {
  return `Mode « ${label} » actif pour cette conversation :\n${text}`;
}

// ── État du mode d'une conversation (lu À CHAQUE ENVOI — le service fait foi) ──

export interface ConversationModeState {
  mode: ConversationMode;
  rounds: number;
  config: ModeConfig | null;
}

/** Réglages par défaut du déroulé affiché dans la conversation (le client
 *  porte ses propres clés hermes.modes.showFlow/showModels — ici, rien). */
export const PLAN_MODE_TURN_SETTING = "plan_mode"; // clé api_turn_v1.settings (tenté, refus non bloquant)
