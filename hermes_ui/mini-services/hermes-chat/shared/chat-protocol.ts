// Protocole partagé front ↔ back (source unique — §60 du repo).
// v0.3.0 : volet Système (2 cartes) + page Stockage.

// ── Constantes du domaine stockage ───────────────────────────────────────
/** Fenêtre d'annulation des suppressions (spec §4.5). */
export const STORAGE_UNDO_MS = 7_000;

/** Formatage d'une taille en octets — UNE seule implémentation (§60) :
 *  les tailles transitent en octets entiers, jamais formatées. */
export function formatArtifactBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} Mo`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} Go`;
}

// ── Stockage : entrées d'inventaire, mutations ────────────────────────────
export interface StorageEntry {
  /** Identifiant de la ligne d'artefact (une version précise). */
  id: string;
  conversationId: string;
  conversationTitle: string;
  projectId: string | null;
  projectName: string;
  key: string;
  kind: string;
  name: string;
  version: number;
  size: number;
  pinned: boolean;
  createdAt: string;
}

/** Réponse de storage:list. */
export interface StorageListResult {
  entries: StorageEntry[];
}

/** Réponse OK d'une mutation (deleteVersion / cleanProject). */
export interface StorageMutationResult {
  ok: true;
  /** Nombre de lignes réellement supprimées. */
  removed: number;
  /** Octets réellement libérés — MESURE, jamais estimation (§5.3). */
  bytesFreed: number;
  /** Jeton d'annulation valable STORAGE_UNDO_MS (annulé au retour). */
  undoToken: string;
}

/** Réponse OK de storage:undo. */
export interface StorageUndoResult {
  ok: true;
  /** Nombre de lignes restaurées. */
  restored: number;
}

/** Refus d'une mutation : code machine + message humain. */
export interface StorageMutationError {
  ok: false;
  /** 409 épinglée · 404 absente · 410 fenêtre expirée. */
  code: "pinned" | "notfound" | "gone";
  error: string;
}

/** Canonicité du « nettoyable » (spec §5.2) : dépassée ET non épinglée.
 *  Même formule côté front (libellés) et côté back (nettoyage).
 *  `pinned` tolère la forme SQL (0/1) ET la forme protocole (booléen) :
 *  le test E2E passe des lignes brutes, le front des entrées traduites. */
export function isStorageCleanable(
  e: { pinned: number | boolean; version: number },
  maxVersion: number
): boolean {
  return !e.pinned && e.version < maxVersion;
}

// ── Système : cartes Mise à jour / Agent (spec §3) ─────────────────────────
export interface UpdateCheckResult {
  installed: string;
  available: string | null;
}

export interface RenderCacheStats {
  count: number;
  bytes: number;
  removed?: number;
  kept?: number;
}
