// Versionnage fichiers (F-26) — politique du journal de versions.
//
// Le journal EST la table `artifacts` : une ligne par version, contenu
// immuable, déjà hors de portée de git (db/, ignoré) et préservée par le
// lanceur. Ce module porte la politique validée (cf. FORK.md §7.12) :
//   - une version est automatique (naissance d'artefact / contenu changé),
//   - une ré-émission au contenu identique ne crée PAS de version,
//   - une seule version par tour et par fichier (garantie par ArtifactTracker),
//   - quota par fichier avec purge FIFO des plus anciennes non épinglées,
//   - restaurer crée v(n+1) qui pointe la version d'origine (jamais d'écrasement).
import type { ArtifactRow } from "./store";

/** Plafond de versions par fichier (purge FIFO des plus anciennes non épinglées). */
export const MAX_VERSIONS = 50;

/** Plafond de versions épinglées par fichier (protégées de la purge). */
export const MAX_PINNED = 10;

/** Longueur maximale d'une étiquette humaine (double-clic dans le journal). */
export const MAX_LABEL = 80;

/** Libellé automatique porté par une version née d'une restauration. */
export function restoreLabel(fromVersion: number): string {
  return `Restauration de v${fromVersion}`;
}

/**
 * Dédoublonnage : ré-émission au contenu STRICTEMENT identique de la version
 * courante → pas de nouvelle version. On ne saute la création que si la
 * version courante est complète (`ready`) — une version en erreur ou restée
 * `generating` (tour interrompu) doit pouvoir être refaite.
 */
export function isIdenticalReissue(
  latest: ArtifactRow | null | undefined,
  content: string
): boolean {
  return !!latest && latest.content === content && latest.status === "ready";
}

/**
 * Sélection des versions à purger quand le plafond est dépassé :
 * les plus anciennes non épinglées d'abord, JAMAIS la version courante
 * (la dernière du journal). `versions` doit être trié par version croissante.
 */
export function selectPurgeable(versions: ArtifactRow[], keep = MAX_VERSIONS): ArtifactRow[] {
  if (versions.length <= keep) return [];
  const excess = versions.length - keep;
  const candidates = versions.slice(0, versions.length - 1).filter((r) => !r.pinned);
  return candidates.slice(0, excess);
}

/**
 * Statut d'une version restaurée : le HTML repart par le pipeline de rendu
 * (la carte affiche « Rendu de l'aperçu (Chrome)… » pendant l'opération),
 * les autres kinds sont prêts immédiatement (contenu copié à l'identique).
 */
export function restoredStatus(kind: string): { status: "rendering" | "ready"; statusLabel: string | null } {
  return kind === "html"
    ? { status: "rendering", statusLabel: "Rendu de l'aperçu (Chrome)…" }
    : { status: "ready", statusLabel: null };
}
