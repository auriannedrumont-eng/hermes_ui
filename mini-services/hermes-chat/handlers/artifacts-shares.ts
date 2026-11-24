// Handlers « artifacts-shares » — extraits d'index.ts (découpage 2026-11, FORK.md §10).
// Pose ses socket.on(...) via register*(socket) ; les identifiants libres
// (ctx.store, ctx.io, ctx.connector, helpers du tour, vues wire) viennent du contexte
// partagé handlers/context.ts — câblé une fois par index.ts.
import type { Socket } from "socket.io";
import { ctx } from "./context";

// ── Découpage interne (audit CRAP 2026-11, vague 4) ───────────────────────
// registerArtifactsSharesHandlers ne pose plus 7 socket.on() dans un seul
// corps : trois sous-registres, un par domaine, chacun appelé dans l'ordre
// source d'origine. Les blocs sont VERBATIM (aucune ligne de handler
// modifiée) ; seuls les corps englobants changent — l'ordre de pose et les
// identifiants ctx.* sont inchangés, le protocole socket est intouché.

/** Vue des artefacts : toutes les versions d'une clé (sélecteur de version /
 *  diff du panneau) et relance du rendu d'un HTML en erreur (Réessayer). */
function registerArtifactViewHandlers(socket: Socket) {
// Toutes les versions d'une clé (sélecteur de version / diff du panneau)
socket.on(
  "artifact:versions",
  (payload: { conversationId?: string; key?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.conversationId;
    const key = payload?.key;
    if (!id || !key) {
      if (typeof cb === "function") cb({ versions: [] });
      return;
    }
    const rows = ctx.store.listArtifactVersions(id, key);
    const versions = rows.map((r) => ctx.wireArtifact(id, key, r));
    if (typeof cb === "function") cb({ versions });
  }
);


// Relance le rendu d'un artefact HTML en erreur (Réessayer sur la carte)
socket.on(
  "artifact:retry",
  (payload: { conversationId?: string; artifactId?: string }, cb?: (data: unknown) => void) => {
    const row = ctx.store.getArtifactRow(payload?.artifactId ?? "");
    if (!row) {
      if (typeof cb === "function") cb({ error: "Artefact introuvable" });
      return;
    }
    if (row.kind !== "html") {
      if (typeof cb === "function") cb({ error: "Cet artefact n'a pas de rendu à relancer" });
      return;
    }
    if (typeof cb === "function") cb({ ok: true });
    void ctx.renderHtmlArtifact(row);
  }
);


}

/** Versionnage fichiers (F-26) : restaurer une version antérieure — crée
 *  v(n+1) d'après vN, jamais d'écrasement —, étiqueter une version
 *  (double-clic dans le journal) et épingler (jamais purgée par le quota). */
function registerFileVersionHandlers(socket: Socket) {
// ── Versionnage fichiers (F-26) : restaurer, étiqueter, épingler ─────

// Restaure une version antérieure : crée v(n+1) d'après vN (jamais d'écrasement).
socket.on(
  "artifact:restore",
  (
    payload: { conversationId?: string; key?: string; version?: number },
    cb?: (data: unknown) => void
  ) => {
    const id = payload?.conversationId;
    const key = payload?.key;
    const version = payload?.version;
    if (!id || !key || !Number.isFinite(version)) {
      if (typeof cb === "function") cb({ error: "conversationId, key et version requis" });
      return;
    }
    const row = ctx.store.restoreArtifactVersion(id, key, version!);
    if (!row) {
      if (typeof cb === "function") cb({ error: "Version introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ artifact: ctx.wireArtifact(id, key, row) });
    // Le HTML restauré repart par le pipeline de rendu ; les autres kinds
    // sont prêts immédiatement — dans les deux cas on diffuse l'état.
    if (row.kind === "html") void ctx.renderHtmlArtifact(row);
    else ctx.broadcastArtifact(id, row);
    ctx.enforceVersionQuota(id, [key]);
  }
);


// Étiquette une version (double-clic dans le journal ; vide = efface)
socket.on(
  "artifact:label",
  (payload: { artifactId?: string; label?: string }, cb?: (data: unknown) => void) => {
    const row = ctx.store.setArtifactLabel(
      payload?.artifactId ?? "",
      payload?.label?.trim().slice(0, 80) || null
    );
    if (!row) {
      if (typeof cb === "function") cb({ error: "Artefact introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ artifact: ctx.wireArtifact(row.conversation_id, row.key, row) });
    ctx.broadcastArtifact(row.conversation_id, row);
  }
);


// Épingle / détache une version (jamais purgée par le quota)
socket.on(
  "artifact:pin",
  (payload: { artifactId?: string; pinned?: boolean }, cb?: (data: unknown) => void) => {
    const res = ctx.store.setArtifactPinned(payload?.artifactId ?? "", !!payload?.pinned);
    if (res.error || !res.row) {
      if (typeof cb === "function") cb({ error: res.error ?? "Artefact introuvable" });
      return;
    }
    if (typeof cb === "function")
      cb({ artifact: ctx.wireArtifact(res.row.conversation_id, res.row.key, res.row) });
    ctx.broadcastArtifact(res.row.conversation_id, res.row);
  }
);


}

/** Partage public lecture seule (F-13) : l'état actif de la conversation,
 *  la création du lien (snapshot FIGÉ au moment du partage) et la
 *  révocation (le snapshot et la conversation ne bougent pas). */
function registerShareHandlers(socket: Socket) {
// ── Partage public lecture seule (F-13) ───────────────────────────

// Partage actif de la conversation (null si aucun)
socket.on(
  "share:get",
  (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.conversationId;
    if (!id) {
      if (typeof cb === "function") cb({ error: "conversationId requis" });
      return;
    }
    const row = ctx.store.getActiveShareByConversation(id);
    if (typeof cb === "function")
      cb({ share: row ? ctx.rowToShareView(row) : null });
  }
);


// Crée (ou recrée) le lien — snapshot FIGÉ des messages au moment du partage
socket.on(
  "share:create",
  (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.conversationId;
    if (!id) {
      if (typeof cb === "function") cb({ error: "conversationId requis" });
      return;
    }
    const conversation = ctx.store.getConversation(id);
    if (!conversation) {
      if (typeof cb === "function") cb({ error: "Conversation introuvable" });
      return;
    }
    const messages = ctx.store.getMessages(id);
    if (messages.length === 0) {
      if (typeof cb === "function") cb({ error: "Rien à partager : conversation vide" });
      return;
    }
    const { snapshot, data } = ctx.buildSnapshot(conversation, messages);
    const row = ctx.store.createShare(
      id,
      conversation.title,
      snapshot,
      data.messageCount,
      ctx.generateShareToken()
    );
    if (typeof cb === "function") cb({ share: ctx.rowToShareView(row) });
    ctx.io.emit("share:changed", { conversationId: id, share: ctx.rowToShareView(row) });
  }
);


// Révoque le lien actif (le snapshot et la conversation ne bougent pas)
socket.on(
  "share:revoke",
  (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.conversationId;
    if (!id) {
      if (typeof cb === "function") cb({ error: "conversationId requis" });
      return;
    }
    const ok = ctx.store.revokeShareByConversation(id);
    if (typeof cb === "function") cb({ ok });
    if (ok) ctx.io.emit("share:changed", { conversationId: id, share: null });
  }
);

}

/* Orchestrateur (audit CRAP 2026-11, vague 4) : l'export public et l'ordre
 * de pose des socket.on() sont inchangés — index.ts n'est pas touché. */
export function registerArtifactsSharesHandlers(socket: Socket) {
  registerArtifactViewHandlers(socket);
  registerFileVersionHandlers(socket);
  registerShareHandlers(socket);
}
