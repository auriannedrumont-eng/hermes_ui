// Estimation de tokens pour la jauge de contexte (chantier « Composer v2 »).
//
// Honnêteté avant tout : sans tokenizer côté client, on estime. L'heuristique
// distingue texte latin (~3,5 caractères / token) et CJK (~1 caractère / token).
// Dès que la gateway remonte l'usage réel, ces fonctions serviront de repli.
//
// Format d'affichage : valeurs en « k » (30.6k), parts de fenêtre en « % ».

/** Heuristique latine : caractères par token (anglais/français, markdown, code). */
const LATIN_CHARS_PER_TOKEN = 3.5;
/** Heuristique CJK : un caractère japonais/chinois/coréen ≈ un token. */
const CJK_CHARS_PER_TOKEN = 1.0;

const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/;

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

/** Estime le nombre de tokens d'un texte (mélange latin / CJK). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch)) cjk += 1;
    else other += 1;
  }
  // Les espaces et sauts de ligne pèsent peu : on affine légèrement.
  const whitespace = (text.match(/\s/g) ?? []).length;
  const effectiveOther = Math.max(0, other - whitespace * 0.4);
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + effectiveOther / LATIN_CHARS_PER_TOKEN);
}

// ── Pièces jointes : coût approximatif envoyé au modèle ce tour ─────────
// Les images passent en contenu vision (~1,6 k tokens par image en pratique),
// les documents en texte extrait (∝ taille du fichier).

/** Coût estimé en tokens d'une pièce jointe, par type. */
export function estimateAttachmentTokens(a: {
  kind: string;
  size: number;
  transcript?: string;
}): number {
  switch (a.kind) {
    case "image":
      return 1568;
    case "pdf":
      return Math.max(500, Math.round(a.size / 4096) + 300);
    case "audio":
      return a.transcript ? estimateTokens(a.transcript) : 200;
    case "video":
      return 1000;
    default:
      return Math.max(120, Math.round(a.size / 3500));
  }
}

// ── Formatage ───────────────────────────────────────────────────────────

/** 30 600 → « 30.6k » ; 940 → « 940 » ; 1 000 → « 1k ». */
export function formatK(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  const k = tokens / 1000;
  // 1k, 1.7k, 20.3k, 105.2k — une décimale, sans traîneau de zéros
  const s = k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "");
  return `${s}k`;
}

/** Part de fenêtre en pourcentage, une décimale (82.1 → « 82.1 % »). */
export function formatPct(pct: number): string {
  const s = pct >= 99.95 ? "100" : pct.toFixed(1).replace(/\.0$/, "");
  return `${s} %`;
}

// ── Décomposition du contexte envoyé au modèle ──────────────────────────

export interface ContextRow {
  key: string;
  label: string;
  /** Sous-libellé (ex. « 18 messages », « 2 images · 1 PDF »). */
  sub?: string;
  tokens: number;
}

export interface ContextUsage {
  /** Postes réellement présents ce tour (les postes absents ne s'affichent pas). */
  rows: ContextRow[];
  /** Somme des postes. */
  total: number;
  /** Fenêtre du modèle en tokens. */
  windowTokens: number;
  /** true si la fenêtre est la valeur par défaut (badge « estimation »). */
  windowEstimated: boolean;
  /** Part de fenêtre consommée, 0-100. */
  pct: number;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Estimation des instructions système quand le service ne les expose pas. */
export const SYSTEM_PROMPT_ESTIMATE = 900;

/** Fenêtre du modèle : 128k par défaut, jamais de fausse précision. */
export function contextWindowOf(model: { contextWindow?: number } | null | undefined): {
  windowTokens: number;
  estimated: boolean;
} {
  return model?.contextWindow
    ? { windowTokens: model.contextWindow, estimated: false }
    : { windowTokens: DEFAULT_CONTEXT_WINDOW, estimated: true };
}

export function buildUsage(rows: ContextRow[], windowTokens: number, windowEstimated: boolean): ContextUsage {
  const total = rows.reduce((acc, r) => acc + r.tokens, 0);
  return {
    rows,
    total,
    windowTokens,
    windowEstimated,
    pct: Math.min(100, (total / windowTokens) * 100),
  };
}

/** Sous-libellé compact d'une liste de pièces jointes (« 2 images · 1 PDF »). */
export function attachmentsSub(atts: { kind: string }[]): string | undefined {
  if (!atts.length) return undefined;
  const names: Record<string, string> = {
    image: "images",
    pdf: "PDF",
    audio: "audios",
    video: "vidéos",
    file: "fichiers",
  };
  const counts = new Map<string, number>();
  for (const a of atts) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, n]) => `${n} ${n > 1 ? names[kind] : names[kind].replace(/s$/, "")}`)
    .join(" · ");
}
