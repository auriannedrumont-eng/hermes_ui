// Handlers « storage » — page Stockage du volet Paramètres (v0.3.0).
// Événements client -> serveur :
//   storage:list           — inventaire complet (liste plate, groupement client)
//   storage:deleteVersion  — suppression d'UNE version (409 épinglée / 404 absente) + jeton
//   storage:cleanProject   — nettoyage d'un projet (idempotent) + jeton
//   storage:undo           — annulation dans la fenêtre de 7 s (410 si expirée)
// Événement serveur -> clients :
//   storage:changed        — une mutation a eu lieu (l'inventaire a changé)
// Le delta annoncé est TOUJOURS la mesure du service (octets des lignes
// réellement supprimées) — jamais l'estimation d'avant (§5.3).
import type { Socket } from "socket.io";
import { ctx } from "./context";
import { openUndoWindow, consumeUndoWindow, cleanStorageProject } from "../store-storage";
import type {
  StorageEntry,
  StorageMutationResult,
  StorageUndoResult,
  StorageMutationError,
} from "../shared/chat-protocol";

export function registerStorageHandlers(socket: Socket): void {

  // ── Inventaire (page Stockage) — liste plate, regroupement client ────
  socket.on(
    "storage:list",
    (payload: { refresh?: boolean } | ((data: unknown) => void) | undefined,
    maybeCb?: (data: unknown) => void) => {
      const cb = typeof payload === "function" ? payload : maybeCb;
      const entries: StorageEntry[] = ctx.store.listStorageEntries().map((r) => ({
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
      }));
      if (typeof cb === "function") cb({ entries });
    }
  );

  // ── Suppression d'une version — refus franc, jamais de demi-suppression ──
  socket.on(
    "storage:deleteVersion",
    (payload: { id?: string }, cb?: (data: unknown) => void) => {
      const id = typeof payload?.id === "string" ? payload.id.trim() : "";
      if (!id) {
        const res: StorageMutationError = {
          ok: false,
          code: "notfound",
          error: "id de version requis",
        };
        if (typeof cb === "function") cb(res);
        return;
      }
      const res = ctx.store.deleteStorageVersion(id);
      if ("refuse" in res) {
        // Épinglée (409) ou absente (404) : la ligne reste intacte — les
        // compteurs de l'interface ne décrémentent jamais sur un refus.
        const out: StorageMutationError = {
          ok: false,
          code: res.refuse,
          error:
            res.refuse === "pinned"
              ? "Version épinglée — la suppression est refusée (l'épingle appartient à la conversation)"
              : "Version introuvable",
        };
        if (typeof cb === "function") cb(out);
        return;
      }
      const out: StorageMutationResult = {
        ok: true,
        removed: 1,
        bytesFreed: res.row.size,
        undoToken: openUndoWindow([res.row]),
      };
      if (typeof cb === "function") cb(out);
      ctx.broadcast("storage:changed");
    }
  );

  // ── Nettoyage d'un projet — idempotent, delta mesuré ───────────────────
  socket.on(
    "storage:cleanProject",
    (payload: { projectId?: string | null }, cb?: (data: unknown) => void) => {
      const projectId = payload?.projectId === undefined ? null : payload.projectId;
      const doomed = cleanStorageProject(ctx.store, projectId);
      const bytesFreed = doomed.reduce((s, r) => s + r.size, 0);
      const out: StorageMutationResult = {
        ok: true,
        removed: doomed.length,
        bytesFreed,
        undoToken: openUndoWindow(doomed),
      };
      if (typeof cb === "function") cb(out);
      ctx.broadcast("storage:changed");
    }
  );

  // ── Annulation — restaure dans la fenêtre, 410 « gone » sinon ────────
  socket.on(
    "storage:undo",
    (payload: { token?: string }, cb?: (data: unknown) => void) => {
      const token = typeof payload?.token === "string" ? payload.token.trim() : "";
      if (!token) {
        const res: StorageMutationError = {
          ok: false,
          code: "gone",
          error: "jeton d'annulation requis",
        };
        if (typeof cb === "function") cb(res);
        return;
      }
      const res = consumeUndoWindow(token, ctx.store);
      if ("refuse" in res) {
        const out: StorageMutationError = {
          ok: false,
          code: "gone",
          error: "Fenêtre d'annulation expirée — la suppression est définitive.",
        };
        if (typeof cb === "function") cb(out);
        return;
      }
      const out: StorageUndoResult = { ok: true, restored: res.restored.length };
      if (typeof cb === "function") cb(out);
      ctx.broadcast("storage:changed");
    }
  );
}
