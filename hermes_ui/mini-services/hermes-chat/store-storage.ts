// Extensions « stockage » du store + fenêtres d'annulation (v0.3.0).
// La page Stockage regroupe côté client (liste plate du service) ; le
// nettoyage et les fenêtres d'annulation vivent côté service.
import type { ArtifactRow, Store } from "./store";
import type { StorageEntry } from "./shared/chat-protocol";
import { STORAGE_UNDO_MS, isStorageCleanable } from "./shared/chat-protocol";

/** Transforme une ligne SQL jointe en entrée d'inventaire (§4.1). */
export function toStorageEntry(r: ArtifactRow & { conversation_title?: string | null; project_id?: string | null; project_name?: string | null }): StorageEntry {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    conversationTitle: r.conversation_title ?? "Conversation supprimée",
    projectId: r.project_id ?? null,
    projectName: r.project_id ? (r.project_name ?? "Projet supprimé") : "Hors projet",
    key: r.key,
    kind: r.kind,
    name: r.name,
    version: r.version,
    size: r.size,
    pinned: !!r.pinned,
    createdAt: r.created_at,
  };
}

/** Dernière version d'un document (par numéro — §5.2, jamais par date). */
export function storageMaxVersion(versions: number[]): number {
  return versions.reduce((m, v) => Math.max(m, v), 0);
}

/** Liste d'inventaire propre (entrées de protocole). */
export function listStorageEntries(store: Store): StorageEntry[] {
  return store.listStorageEntries().map(toStorageEntry);
}

/** Nettoyage d'un projet : versions dépassées non épinglées de chaque
 *  document (par numéro, jamais par date — §5.2). Idempotent par
 *  construction : un second appel ne trouve plus rien. */
export function cleanStorageProject(store: Store, projectId: string | null): ArtifactRow[] {
  const doomed: ArtifactRow[] = [];
  const entries = listStorageEntries(store).filter((e) =>
    projectId === null ? e.projectId === null : e.projectId === projectId
  );
  // Groupe par document (conversation + clé) : la dernière version de
  // chacun reste, les précédentes non épinglées partent.
  const byDoc = new Map<string, StorageEntry[]>();
  for (const e of entries) {
    const docKey = `${e.conversationId}\u0000${e.key}`;
    const list = byDoc.get(docKey);
    if (list) list.push(e);
    else byDoc.set(docKey, [e]);
  }
  for (const docEntries of byDoc.values()) {
    const maxV = storageMaxVersion(docEntries.map((e) => e.version));
    for (const e of docEntries) {
      if (!isStorageCleanable(e, maxV)) continue;
      const res = store.deleteStorageVersion(e.id);
      if ("row" in res) doomed.push(res.row);
    }
  }
  return doomed;
}

// ── Fenêtres d'annulation (7 s) — vivent au niveau du module ────────────
// Le handler (handlers/storage.ts) enregistre les lignes supprimées ici ;
// l'expiration purge le registre. Suppression effective immédiate +
// annulation = réinsertion des lignes DANS la fenêtre.

interface UndoWindow {
  rows: ArtifactRow[];
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const undoWindows = new Map<string, UndoWindow>();

/** Enregistre une fenêtre d'annulation pour des lignes supprimées. */
export function openUndoWindow(rows: ArtifactRow[]): string {
  const token = crypto.randomUUID();
  const win: UndoWindow = {
    rows,
    expiresAt: Date.now() + STORAGE_UNDO_MS,
    timer: setTimeout(() => undoWindows.delete(token), STORAGE_UNDO_MS),
  };
  undoWindows.set(token, win);
  return token;
}

/** Annule dans la fenêtre : réinsère les lignes ; « gone » si expirée. */
export function consumeUndoWindow(
  token: string,
  store: Store
): { restored: ArtifactRow[] } | { refuse: "gone" } {
  const win = undoWindows.get(token);
  if (!win) return { refuse: "gone" };
  clearTimeout(win.timer);
  undoWindows.delete(token);
  const restored: ArtifactRow[] = [];
  // bun:sqlite : la transaction est un constructeur — new db.transaction(fn).
  const txn = store.db.transaction(() => {
    for (const row of win.rows) {
      // La conversation a pu être supprimée entre-temps : la ligne ne
      // ressuscite pas dans le vide (garde applicative — le schéma
      // n'impose pas la clé étrangère ici).
      const conv = store.db
        .query("SELECT id FROM conversations WHERE id = ?")
        .get(row.conversation_id);
      if (!conv) continue;
      store.db
        .query(
          `INSERT OR REPLACE INTO artifacts
           (id, conversation_id, message_id, key, version, kind, name, language, mime, content, size, status, status_label, error, label, pinned, restored_from, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.id,
          row.conversation_id,
          row.message_id,
          row.key,
          row.version,
          row.kind,
          row.name,
          row.language,
          row.mime,
          row.content,
          row.size,
          row.status,
          row.status_label,
          row.error,
          row.label,
          row.pinned,
          row.restored_from,
          row.created_at
        );
      restored.push(row);
    }
  });
  txn();
  return { restored };
}
