// Décision de compaction automatique (v2.4) — pure, testable hors DOM.
// La décision appartient au client (il connaît la fenêtre du modèle et le
// brouillon en cours) ; l'exécution reste l'événement `conversation:compact`
// existant (résumé réel par le pool, conservé en tête de session).
// Sémantique identique à la jauge du composer : le remplissage compte les
// instructions système + le prompt de conversation + l'historique + le
// brouillon en cours d'envoi.
export const MIN_MESSAGES_FOR_AUTO_COMPACT = 4;
export const COMPACT_THRESHOLD_MIN = 50;
export const COMPACT_THRESHOLD_MAX = 95;
export const COMPACT_THRESHOLD_DEFAULT = 80;

/** Borne le seuil déclaré dans un réglage tombé hors bornes. */
export function clampCompactThreshold(value: number | null | undefined): number {
  // Absent → défaut (jamais 0 : Number(null) vaut 0, piège documenté F-22).
  if (value === null || value === undefined) return COMPACT_THRESHOLD_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return COMPACT_THRESHOLD_DEFAULT;
  return Math.min(COMPACT_THRESHOLD_MAX, Math.max(COMPACT_THRESHOLD_MIN, Math.round(n)));
}

export interface AutoCompactInput {
  enabled: boolean;
  /** Seuil en % de remplissage (borné par clampCompactThreshold). */
  thresholdPct: number;
  /** Fenêtre du modèle en jetons (peut être une estimation). */
  windowTokens: number;
  /** Jetons qui partiront au modèle pour CE tour (base + brouillon). */
  usedTokens: number;
  /** Messages de la conversation (compaction refusée sur un fil trop court). */
  messageCount: number;
}

/** Doit-on résumer avant ce tour ? Même règle que le bouton « Compacter » :
 *  jamais sur un fil trop court (le résumé n'apporterait rien). */
export function shouldAutoCompact(input: AutoCompactInput): boolean {
  if (!input.enabled) return false;
  if (input.messageCount < MIN_MESSAGES_FOR_AUTO_COMPACT) return false;
  if (!Number.isFinite(input.windowTokens) || input.windowTokens <= 0) return false;
  const threshold = clampCompactThreshold(input.thresholdPct);
  if (!Number.isFinite(input.usedTokens) || input.usedTokens <= 0) return false;
  return (input.usedTokens / input.windowTokens) * 100 >= threshold;
}
