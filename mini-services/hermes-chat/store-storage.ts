// Extensions « stockage » du store + fenêtres d'annulation (v0.3.0).
// La page Stockage regroupe côté client (liste plate du service) ; le
// nettoyage et les fenêtres d'annulation vivent côté service.
// Architecture du service complet : les MÉTHODES vivent ici au sens du
// découpage 2026-11 (FORK.md §10) — buildStorage() est posé au prototype
// de Store par store.ts (Object.assign), comme les autres domaines ;
// les fenêtres d'annulation (état par module) et les fonctions libres
// (nettoyage, transformation) restent exportées ici.
import type { ArtifactRow, Store } from "./store";
import type { StorageEntry } from "./shared/chat-protocol";
import { STORAGE_UNDO_MS, isStorageCleanable } from "./shared/chat-protocol";
import { artifactPdfPath, artifactThumbPath } from "./artifacts";
import { rmSync } from "node:fs";

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

// ── Domaine « stockage » : méthodes posées au prototype de Store ────────

export interface StoreStorageMethods {
  /** Inventaire plat : toutes les versions, projet résolu, ordre stable.
   *  Le nom de projet est RÉSOLU en champ plat `projectName` (« Hors
   *  projet » si conversation sans projet) : le front regroupe sans
   *  re-jointure. */
  listStorageEntries(): Array<
    ArtifactRow & {
      conversation_title: string | null;
      project_id: string | null;
      project_name: string | null;
      projectName: string;
    }
  >;
  /** Suppression d'une version — refus franc si épinglée (409) ou
   *  absente (404) : la ligne reste intacte dans les deux cas. */
  deleteStorageVersion(id: string): { row: ArtifactRow } | { refuse: "notfound" | "pinned" };
}

export function buildStorage(): StoreStorageMethods & ThisType<Store> {
  return {
    listStorageEntries(this: Store) {
      return this.db
        .query(
          `SELECT a.*, c.title AS conversation_title, p.id AS project_id, p.name AS project_name,
                  CASE WHEN p.id IS NULL THEN 'Hors projet' ELSE p.name END AS projectName
           FROM artifacts a
           LEFT JOIN conversations c ON c.id = a.conversation_id
           LEFT JOIN projects p ON p.id = c.project_id
           ORDER BY c.created_at DESC, a.key COLLATE NOCASE, a.version ASC`
        )
        .all() as Array<
        ArtifactRow & {
          conversation_title: string | null;
          project_id: string | null;
          project_name: string | null;
          projectName: string;
        }
      >;
    },

    deleteStorageVersion(this: Store, id: string) {
      const row = this.getArtifactRow(id);
      if (!row) return { refuse: "notfound" as const };
      if (row.pinned) return { refuse: "pinned" as const };
      this.db.query("DELETE FROM artifacts WHERE id = ?").run(id);
      return { row };
    },
  };
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
    // Fuite de fichiers (94) : à l'expiration, les lignes SQL sont déjà
    // parties — les fichiers dérivés (.png / .pdf) restaient sur le disque
    // pour toujours. Supprimés ici ; force:true tolère un fichier jamais
    // généré, et le try/catch un verrou Windows (fichier servi à l'instant).
    timer: setTimeout(() => {
      for (const row of win.rows) {
        for (const file of [artifactThumbPath(row.id), artifactPdfPath(row.id)]) {
          try {
            rmSync(file, { force: true });
          } catch {
            /* verrou Windows ou fichier régénéré : conservé, sans incident */
          }
        }
      }
      undoWindows.delete(token);
    }, STORAGE_UNDO_MS),
  };
  undoWindows.set(token, win);
  return token;
}

/** Revue P1-P7 : purge les fichiers dérivés de toutes les fenêtres ouvertes —
 *  appelée à l'arrêt propre du service : le timer de 7 s ne tirera jamais,
 *  les .png/.pdf des suppressions non expirées restaient sur le disque pour
 *  toujours (fuite). Best effort, comme l'expiration normale. */
export function flushUndoWindows(): void {
  for (const [, win] of undoWindows) {
    clearTimeout(win.timer);
    for (const row of win.rows) {
      for (const file of [artifactThumbPath(row.id), artifactPdfPath(row.id)]) {
        try {
          rmSync(file, { force: true });
        } catch {
          /* verrou Windows ou fichier régénéré : conservé, sans incident */
        }
      }
    }
  }
  undoWindows.clear();
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
