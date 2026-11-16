// Modes du compositeur (F-30) — miroir d'affichage du référentiel service
// (mini-services/hermes-chat/modes.ts fait foi). Sept modes : le sélecteur
// de la zone de message, le panneau « qui travaille » et la section
// Paramètres « Modes de chat » rendent ces données.
// Toute valeur inconnue retombe sur « chat » (resolveMode), comme au service.
import {
  Code2,
  Columns2,
  MessagesSquare,
  ScrollText,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ── Identifiants et bornes (miroir du service — revalidées à l'envoi) ───

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

export function resolveMode(value: unknown): ConversationMode {
  return CONVERSATION_MODES.includes(value as ConversationMode)
    ? (value as ConversationMode)
    : "chat";
}

export const DEBATE_ROUNDS_MIN = 3;
export const DEBATE_ROUNDS_MAX = 10;
export const COUNCIL_MEMBERS_MIN = 2;
export const COUNCIL_MEMBERS_MAX = 5;
export const AUTO_RETRIES_MIN = 0;
export const AUTO_RETRIES_MAX = 3;
export const MAX_MODE_PROMPT_CHARS = 4_000;

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ── Config par conversation (miroir conversations.mode_config) ─────────

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

/** Valeurs par défaut des voix (réglage hermes.modes.voices — page Paramètres). */
export const DEFAULT_VOICES: Record<string, Record<string, string | null>> = {
  debate: {
    sceptique: "hermes-4-405b",
    pragmatique: "hermes-4-70b",
    innovateur: "hermes-3-405b",
    juge: null,
  },
  council: {
    "membre-a": "hermes-4-405b",
    "membre-b": "hermes-4-70b",
    "membre-c": null,
    president: null,
  },
  auto: {
    debat: "hermes-3-405b",
    plan: "hermes-4-70b",
    code: "hermes-4-405b",
    test: "hermes-4-14b",
  },
  compare: { a: "hermes-4-405b", b: "hermes-4-70b" },
};

/** Fusionne la config d'une conversation sur les défauts du registre :
 *  le panneau « qui travaille » montre toujours une valeur par voix. */
export function mergedVoices(
  mode: ConversationMode,
  config: ModeConfig | null | undefined,
  defaults: Record<string, Record<string, string | null>>,
): Record<string, string | null> {
  const base = defaults[mode] ?? {};
  const perConv = config?.voices?.[mode] ?? {};
  return { ...base, ...perConv };
}

// ── Le référentiel affiché (libellés simples, sans jargon) ──────────────

export interface ModeDef {
  id: ConversationMode;
  label: string;
  /** Une ligne dans le sélecteur — ce que fait le mode, dit simplement. */
  desc: string;
  /** Note du pied du sélecteur (détail honnête du fonctionnement). */
  note: string;
  icon: LucideIcon;
  /** Le mode fait travailler plusieurs voix (« qui travaille »). */
  hasVoices: boolean;
  /** Le mode déroule ses tours dans la conversation. */
  orchestrated: boolean;
}

export const MODES: ModeDef[] = [
  {
    id: "chat",
    label: "Chat",
    desc: "La conversation ordinaire — rien n'est ajouté.",
    note: "Le modèle de la conversation répond directement. Rien d'autre.",
    icon: MessagesSquare,
    hasVoices: false,
    orchestrated: false,
  },
  {
    id: "plan",
    label: "Plan",
    desc: "Un plan d'étapes d'abord — rien n'est modifié.",
    note: "Hermes agit en chef de projet : des étapes numérotées, sans estimation de durée, et rien n'est modifié tant que le plan n'est pas accepté.",
    icon: ScrollText,
    hasVoices: false,
    orchestrated: false,
  },
  {
    id: "code",
    label: "Code",
    desc: "Lire avant de changer — chaque changement est prouvé.",
    note: "Hermes lit les fichiers avant de changer quoi que ce soit, et prouve chaque modification par une commande et son résultat — jamais de « c'est fait » sans la preuve.",
    icon: Code2,
    hasVoices: false,
    orchestrated: false,
  },
  {
    id: "compare",
    label: "Comparer",
    desc: "Le même message à deux modèles, côte à côte.",
    note: "Votre message part vers deux modèles — A et B — et les deux réponses s'affichent côte à côte ; chaque côté peut être régénéré seul. C'est l'ancienne bascule Comparer, devenue un mode.",
    icon: Columns2,
    hasVoices: true,
    orchestrated: false,
  },
  {
    id: "debate",
    label: "Débat",
    desc: "3 conseillers débattent, un juge tranche.",
    note: "Les conseillers se répondent tour après tour et contredisent sur des faits, pas sur des généralités. À la fin, un juge tranche — le verdict est la seule réponse conservée.",
    icon: MessagesSquare,
    hasVoices: true,
    orchestrated: true,
  },
  {
    id: "council",
    label: "Conseil",
    desc: "Des avis en parallèle, anonymisés — le président les réunit.",
    note: "Les membres répondent en parallèle, sans se voir et sans rien modifier — anonymisés (A, B, C). Le président compare ensuite leurs avis, les réunit et dit ce qu'il écarte.",
    icon: Users,
    hasVoices: true,
    orchestrated: true,
  },
  {
    id: "auto",
    label: "Auto",
    desc: "Débat, plan, code, test — et il retente en cas d'échec.",
    note: "Hermes enchaîne tout seul : débat, plan, code, test — sans demander confirmation. En cas d'échec, il corrige la vraie cause puis retente (reprises réglables).",
    icon: Workflow,
    hasVoices: true,
    orchestrated: true,
  },
];

export function modeDef(mode: ConversationMode): ModeDef {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

/** Libellé de la pastille du composer (l'état reste visible sans ouvrir le menu). */
export function modePillLabel(
  mode: ConversationMode,
  config: ModeConfig | null | undefined,
): string {
  switch (mode) {
    case "debate":
      return `Débat · ${clampInt(config?.rounds, DEBATE_ROUNDS_MIN, DEBATE_ROUNDS_MAX, DEBATE_ROUNDS_MIN)} tours`;
    case "council":
      return `Conseil · ${clampInt(config?.members, COUNCIL_MEMBERS_MIN, COUNCIL_MEMBERS_MAX, COUNCIL_MEMBERS_MIN)} membres`;
    case "auto":
      return `Auto · ${clampInt(config?.retries, AUTO_RETRIES_MIN, AUTO_RETRIES_MAX, 2)} reprises`;
    case "compare":
      return "Comparer · 2 modèles";
    default:
      return modeDef(mode).label;
  }
}

// ── Voix « qui travaille » (miroir de l'orchestrateur) ─────────────────

export interface ModeVoiceView {
  id: string;
  name: string;
  role: string;
}

export function voicesFor(
  mode: ConversationMode,
  config: ModeConfig | null | undefined,
): ModeVoiceView[] {
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
    const out: ModeVoiceView[] = [];
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
    const out: ModeVoiceView[] = [];
    if (config?.autoDebate !== false)
      out.push({ id: "debat", name: "Débat", role: "cadrage préalable — 3 tours" });
    out.push({ id: "plan", name: "Plan", role: "chef de projet — étapes" });
    out.push({ id: "code", name: "Code", role: "constructeur — applique" });
    out.push({ id: "test", name: "Test", role: "testeur — prouve" });
    return out;
  }
  return [];
}

/** Texte « Qui travaille — … » : combien de voix ont leur modèle. */
export function whoTextFor(
  voices: ModeVoiceView[],
  modelByVoice: Record<string, string | null>,
): string {
  if (!voices.length) return "Qui travaille — le modèle de la conversation décide";
  const custom = voices.filter((v) => modelByVoice[v.id]).length;
  if (custom === 0)
    return `Qui travaille — ${voices.length} voix, toutes suivent la conversation`;
  return `Qui travaille — ${custom} voix ont leur modèle, ${voices.length - custom} suivent la conversation`;
}

// ── Les 13 consignes (miroir du service — l'édition vit dans Paramètres) ──

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

/** Libellés d'affichage des consignes (clé « mode.voix » → titre + rôle). */
export const PROMPT_META: Record<
  string,
  { title: string; used: string; placeholders?: string[] }
> = {
  "chat.main": {
    title: "Consigne du mode Chat",
    used: "ajoutée à chaque message, telle quelle — optionnelle",
  },
  "plan.main": {
    title: "Consigne du mode Plan",
    used: "appliquée à chaque message d'une conversation en mode Plan",
  },
  "code.main": {
    title: "Consigne du mode Code",
    used: "appliquée à chaque message d'une conversation en mode Code",
  },
  "debate.conseiller": {
    title: "Conseiller",
    used: "utilisée par chaque conseiller — Sceptique · Pragmatique · Innovateur",
    placeholders: ["{angle}", "{tours}"],
  },
  "debate.juge": {
    title: "Juge",
    used: "utilisée au tour du verdict — une seule fois par débat",
    placeholders: ["{tours}"],
  },
  "council.membre": {
    title: "Membre",
    used: "utilisée par chaque membre, en parallèle et sans se connaître",
  },
  "council.president": {
    title: "Président",
    used: "utilisée après la collecte anonymisée A, B, C…",
    placeholders: ["{membres}"],
  },
  "auto.debat": {
    title: "Débat",
    used: "étape de cadrage — si Débat préalable est activé",
  },
  "auto.plan": { title: "Plan", used: "étape de planification" },
  "auto.code": { title: "Code", used: "étape de modification" },
  "auto.test": { title: "Test", used: "étape de preuve" },
  "auto.reprise": {
    title: "Reprise",
    used: "après un échec prouvé — 0 à 3 fois, selon le réglage de la conversation",
    placeholders: ["{reprises}"],
  },
  "compare.main": {
    title: "Consigne commune",
    used: "ajoutée aux deux colonnes si renseignée — sinon le message part tel quel",
  },
};

/** Icône d'un mode (usage hors sélecteur : déroulé, section Paramètres). */
export const SparklesIcon = Sparkles;
