// Prompt système par conversation + presets réutilisables (F-11) et
// instructions personnalisées globales (F-19) — FORK.md §5 R1 : ce chantier
// vit dans ses propres fonctions du store ; index.ts n'ajoute que les
// événements socket `system-prompt:*`.
//
// Modèle de données (tables additives, R2) :
//   system_prompts (id, scope, conversation_id, title, content, updated_at)
//     scope = 'conversation' → une ligne par conversation au plus (prompt actif)
//     scope = 'preset'       → bibliothèque de presets réutilisables
//   Les instructions globales (F-19) vivent dans la table settings sous la clé
//   `hermes.instructions.custom` (registre §6) — aucune table dédiée.
import type { ChatMessage } from "./types";

// ── Mode expert (F-22) : assainissement des réglages d'un tour ─────────

/** Charge brute du client (trois champs optionnels, non typés). */
export interface ExpertSettingsInput {
  temperature?: unknown;
  maxTokens?: unknown;
  seed?: unknown;
}

/**
 * Assainit les réglages expert d'un tour (F-22) : température clampée à
 * [0, 1] (le moteur démo rejette au-delà — erreur 1210 du fournisseur),
 * plafond de jetons clampé à [1, 8192] (vérifié : 1 token = une unique
 * sortie, la troncation est réellement effective), graine entière 32 bits.
 * Toute valeur absente, non numérique ou non finie est ignorée — le tour
 * part alors avec les valeurs par défaut du fournisseur.
 */
export function sanitizeExpertSettings(
  input: ExpertSettingsInput | undefined | null
): {
  temperature?: number;
  maxTokens?: number;
  seed?: number;
} {
  if (!input) return {};
  // null/undefined/non-fini → ignoré (Number(null) vaut 0 : exclu d'office,
  // sinon un champ « vide » du client activerait la valeur 0).
  const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const temperature = num(input.temperature);
  const maxTokens = num(input.maxTokens);
  const seed = num(input.seed);
  return {
    ...(temperature !== undefined
      ? { temperature: Math.min(1, Math.max(0, temperature)) }
      : {}),
    ...(maxTokens !== undefined
      ? { maxTokens: Math.min(8192, Math.max(1, Math.round(maxTokens))) }
      : {}),
    ...(seed !== undefined
      ? { seed: Math.min(2 ** 31 - 1, Math.max(0, Math.round(seed))) }
      : {}),
  };
}

export interface SystemPromptRow {
  id: string;
  scope: "conversation" | "preset";
  conversation_id: string | null;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface SystemPromptPreset {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Clé du registre serveur des instructions personnalisées (F-19). */
export const CUSTOM_INSTRUCTIONS_KEY = "hermes.instructions.custom";

// ── Mémoire utilisateur (F-18) — consultable, éditable, effaçable ──────
// Notes persistantes injectées dans les instructions du tour tant que la
// mémoire est active. Fallback additif : absent = actif (cohérent avec le
// reste du fork) — une mise à jour ne coupe jamais la mémoire.
export const MEMORY_ENABLED_KEY = "hermes.memory.enabled";
/** Apprentissage automatique (exploité par le moteur en gateway). */
export const MEMORY_AUTO_KEY = "hermes.memory.autoLearn";
/** Contenu de la mémoire (notes libres). */
export const MEMORY_NOTES_KEY = "hermes.memory.notes";
export const MAX_MEMORY_CHARS = 12_000;

/** Limite de taille d'un prompt (garde-fou, aligné sur les usages LLM). */
export const MAX_PROMPT_CHARS = 12_000;

/** Limite des instructions personnalisées globales (plus courte). */
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 4_000;

/** Presets initiaux semés à la première ouverture (idempotent, « Démo » remplace tout). */
export const SEED_PRESETS: { title: string; content: string }[] = [
  {
    title: "Assistant sobre",
    content:
      "Réponds de façon directe et factuelle. Pas de préambule, pas de formule de politesse, pas de conclusion superflue. Va droit au but.",
  },
  {
    title: "Professeur patient",
    content:
      "Explique chaque notion comme à quelqu'un qui la découvre : une définition simple, une analogie concrète, puis les détails techniques. Vérifie la compréhension avec un exemple.",
  },
  {
    title: "Relecteur exigeant",
    content:
      "Tu relèves les fautes d'orthographe, grammaire et style. Liste chaque correction avec la règle qui la justifie, puis propose une version corrigée du texte complet.",
  },
  {
    title: "Développeur senior",
    content:
      "Écris du code production : typé, testable, commenté aux endroits non évidents. Explique tes choix techniques en quelques lignes avant le code. Signale explicitement les compromis.",
  },
  {
    title: "Démo Hermes",
    content:
      "Tu es en mode démonstration : illustre chaque réponse par un artefact complet (page HTML, tableau CSV, graphique SVG…) quand c'est pertinent, sinon explique ce que l'agent Hermes ferait avec ses outils.",
  },
];

/** Construit les instructions complètes du tour (démo) : système de base +
 * mémoire utilisateur (F-18) + instructions personnalisées + prompt de
 * conversation. Chaque section absente est simplement omise — ordre
 * stable, lisible dans les logs. */
export function composeDemoSystemPrompt(parts: {
  base: string;
  memoryNotes?: string | null;
  customInstructions?: string | null;
  conversationPrompt?: string | null;
}): string {
  const sections: string[] = [parts.base];
  const memory = (parts.memoryNotes ?? "").trim();
  if (memory) {
    sections.push(
      `Mémoire de l'utilisateur (ce qu'Hermes retient des échanges) :\n${memory}`
    );
  }
  const custom = (parts.customInstructions ?? "").trim();
  if (custom) {
    sections.push(`Instructions personnalisées de l'utilisateur :\n${custom}`);
  }
  const conv = (parts.conversationPrompt ?? "").trim();
  if (conv) {
    sections.push(`Prompt système de cette conversation :\n${conv}`);
  }
  return sections.join("\n\n");
}

/** Vérifie un texte de prompt (retourne une erreur FR courte ou null). */
export function validatePromptText(
  text: string,
  max: number
): string | null {
  const clean = text.trim();
  if (!clean) return "Le prompt ne peut pas être vide";
  if (clean.length > max) return `Trop long (max ${max.toLocaleString("fr-FR")} caractères)`;
  return null;
}

/** Rangée SQL → preset wire (aucune donnée serveur ne fuit). */
export function rowToPreset(r: SystemPromptRow): SystemPromptPreset {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type { ChatMessage };
