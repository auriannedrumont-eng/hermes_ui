// Store — domaine artifacts — extrait de store.ts (découpage 2026-11, FORK.md §10).
// Interface fusionnée dans Store (declaration merging) + implémentation
// posée au prototype par store.ts : l'API publique est inchangée.
import { ARTIFACTS_DIR, artifactPdfPath, artifactThumbPath } from "./artifacts";
import { MAX_PINNED, MAX_VERSIONS, isIdenticalReissue, restoreLabel, restoredStatus, selectPurgeable } from "./versions";
import type { Artifact, ArtifactKind } from "./types";
import type { ArtifactRow, Store } from "./store";
import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

export interface StoreArtifactsMethods {
  insertArtifact(a: {
    id?: string;
    conversationId: string;
    messageId: string;
    key: string;
    kind: ArtifactKind;
    name: string;
    language?: string | null;
    mime: string;
    content: string;
    status: Artifact["status"];
    statusLabel?: string | null;
    error?: string | null;
    label?: string | null;
    restoredFrom?: number | null;
  }): ArtifactRow;
  deleteConversationArtifacts(conversationId: string): ArtifactRow[];
  deleteArtifactsOfMessages(conversationId: string, messageIds: string[]): ArtifactRow[];
  setArtifactLabel(id: string, label: string | null): ArtifactRow | null;
  setArtifactPinned(
    id: string,
    pinned: boolean
  ): { row: ArtifactRow | null; error?: string };
  restoreArtifactVersion(
    conversationId: string,
    key: string,
    fromVersion: number
  ): ArtifactRow | null;
  purgeArtifactVersions(
    conversationId: string,
    key: string,
    keep?: number
  ): ArtifactRow[];
  /** Sweep de démarrage (Lot 2, audit L2-7) : purges défensives des
   *  orphelins laissés par un crash. Idempotent. */
  sweepOrphanArtifacts(): { removedFiles: string[]; removedRows: string[] };
  copyArtifactsToFork(
    fromConversationId: string,
    toConversationId: string,
    messageIdMap: Map<string, string>
  ): void;
  getArtifactRow(id: string): ArtifactRow | null;
  latestArtifactRow(conversationId: string, key: string): ArtifactRow | null;
  previousArtifactRow(conversationId: string, key: string, beforeVersion: number): ArtifactRow | null;
  deleteArtifactRow(id: string): void;
  nextArtifactVersion(conversationId: string, key: string): number;
  listConversationArtifacts(conversationId: string): ArtifactRow[];
  listArtifactVersions(conversationId: string, key: string): ArtifactRow[];
  updateArtifact(id: string, patch: Record<string, unknown>): ArtifactRow | null;
}

export function buildArtifacts(): StoreArtifactsMethods & ThisType<Store> {
  return {
    // ── Artefacts ──────────────────────────────────────────────────────────

    /** Insère une version d'artefact.
     *  F-26 — dédoublonnage : une ré-émission au contenu strictement identique
     *  de la version courante (`ready`) ne crée PAS de version, on renvoie la
     *  ligne existante (le tracker réécrira le même contenu sans effet).
     *  `label` / `restoredFrom` ne servent qu'aux versions créées hors flux
     *  (restauration) — le flux de streaming ne les passe jamais. */
    insertArtifact(a: {
      id?: string;
      conversationId: string;
      messageId: string;
      key: string;
      kind: ArtifactKind;
      name: string;
      language?: string | null;
      mime: string;
      content: string;
      status: Artifact["status"];
      statusLabel?: string | null;
      error?: string | null;
      label?: string | null;
      restoredFrom?: number | null;
    }): ArtifactRow {
      // Revue P1-P7 : lecture « dernière version » + calcul du numéro suivant
      // + INSERT en UNE transaction — en mode Comparer, deux voix concurrentes
      // calculaient le même nextArtifactVersion et l'une des deux INSERT
      // violait l'UNIQUE (conversation_id, key, version).
      return this.db.transaction(() => {
        const latest = this.latestArtifactRow(a.conversationId, a.key);
        if (latest && isIdenticalReissue(latest, a.content)) return latest;
        const id = a.id ?? crypto.randomUUID();
        const version = this.nextArtifactVersion(a.conversationId, a.key);
        const created_at = new Date().toISOString();
        this.db
          .query(
            `INSERT INTO artifacts (id, conversation_id, message_id, key, version, kind, name, language, mime, content, size, status, status_label, error, label, pinned, restored_from, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            a.conversationId,
            a.messageId,
            a.key,
            version,
            a.kind,
            a.name,
            a.language ?? null,
            a.mime,
            a.content,
            Buffer.byteLength(a.content, "utf-8"),
            a.status,
            a.statusLabel ?? null,
            a.error ?? null,
            a.label ?? null,
            0,
            a.restoredFrom ?? null,
            created_at
          );
        return this.getArtifactRow(id)!;
      })();
    },

    /** Version courante d'une clé (la plus récente), null si nouvelle.
     *  C-03 : public — l'ArtifactTracker consulte la version courante à la
     *  clôture d'un bloc pour le dédoublonnage F-26. */
    latestArtifactRow(conversationId: string, key: string): ArtifactRow | null {
      return (
        (this.db
          .query(
            "SELECT * FROM artifacts WHERE conversation_id = ? AND key = ? ORDER BY version DESC LIMIT 1"
          )
          .get(conversationId, key) as ArtifactRow | undefined) ?? null
      );
    },

    /** Revue P1-P7 (B11) : version PRÉCÉDENTE d'une clé (version <
     *  beforeVersion, la plus récente d'abord) — latestArtifactRow
     *  renvoyait TOUJOURS la ligne provisoire v(n+1) tout juste insérée à
     *  l'ouverture du bloc : le dédoublonnage F-26 comparait la ligne à
     *  elle-même (previous.id !== existing.row.id jamais vrai) et chaque
     *  ré-émission identique créait une version dupliquée. */
    previousArtifactRow(
      conversationId: string,
      key: string,
      beforeVersion: number
    ): ArtifactRow | null {
      return (
        (this.db
          .query(
            "SELECT * FROM artifacts WHERE conversation_id = ? AND key = ? AND version < ? ORDER BY version DESC LIMIT 1"
          )
          .get(conversationId, key, beforeVersion) as ArtifactRow | undefined) ?? null
      );
    },

    /** C-03/F-26 : supprime la ligne provisoire v(n+1) d'une ré-émission
     *  identique — appelée par l'ArtifactTracker à la clôture du bloc. */
    deleteArtifactRow(id: string): void {
      this.db.query("DELETE FROM artifacts WHERE id = ?").run(id);
    },

    /** Version suivante d'une clé dans la conversation (1 si nouvelle). */
    nextArtifactVersion(conversationId: string, key: string): number {
      const r = this.db
        .query(
          "SELECT MAX(version) AS v FROM artifacts WHERE conversation_id = ? AND key = ?"
        )
        .get(conversationId, key) as any;
      return (r?.v ?? 0) + 1;
    },

    getArtifactRow(id: string): ArtifactRow | null {
      return (
        (this.db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow) ?? null
      );
    },

    /** Toutes les versions d'artefacts d'une conversation (ordre chronologique). */
    listConversationArtifacts(conversationId: string): ArtifactRow[] {
      return this.db
        .query(
          "SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY version ASC, created_at ASC"
        )
        .all(conversationId) as ArtifactRow[];
    },

    /** Toutes les versions d'une clé. */
    listArtifactVersions(conversationId: string, key: string): ArtifactRow[] {
      return this.db
        .query(
          "SELECT * FROM artifacts WHERE conversation_id = ? AND key = ? ORDER BY version ASC"
        )
        .all(conversationId, key) as ArtifactRow[];
    },

    /** Met à jour statut / contenu d'une version d'artefact. */
    updateArtifact(
      id: string,
      patch: {
        status?: Artifact["status"];
        statusLabel?: string | null;
        error?: string | null;
        content?: string;
      }
    ): ArtifactRow | null {
      const sets: string[] = [];
      const params: any[] = [];
      if (patch.status !== undefined) {
        sets.push("status = ?");
        params.push(patch.status);
      }
      if (patch.statusLabel !== undefined) {
        sets.push("status_label = ?");
        params.push(patch.statusLabel);
      }
      if (patch.error !== undefined) {
        sets.push("error = ?");
        params.push(patch.error);
      }
      if (patch.content !== undefined) {
        sets.push("content = ?", "size = ?");
        params.push(patch.content, Buffer.byteLength(patch.content, "utf-8"));
      }
      if (!sets.length) return this.getArtifactRow(id);
      params.push(id);
      this.db.query(`UPDATE artifacts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      return this.getArtifactRow(id);
    },

    /** Supprime les artefacts d'une conversation ; renvoie les lignes (nettoyage fichiers). */
    deleteConversationArtifacts(conversationId: string): ArtifactRow[] {
      const rows = this.listConversationArtifacts(conversationId);
      this.db.query("DELETE FROM artifacts WHERE conversation_id = ?").run(conversationId);
      return rows;
    },

    /** Supprime les lignes d'artefacts ancrées sur les messages donnés (Lot 2,
     *  audit L2-1) et les renvoie — l'appelant nettoie ensuite les fichiers
     *  dérivés (deleteArtifactFiles) pour ne pas laisser de PNG/PDF orphelins.
     *  Une v2 supprimée ne reste plus « ancrée » sur la carte de la v1. */
    deleteArtifactsOfMessages(conversationId: string, messageIds: string[]): ArtifactRow[] {
      if (messageIds.length === 0) return [];
      const rows: ArtifactRow[] = [];
      const stmt = this.db.query(
        "SELECT * FROM artifacts WHERE conversation_id = ? AND message_id = ?"
      );
      for (const mid of messageIds) {
        rows.push(...(stmt.all(conversationId, mid) as ArtifactRow[]));
      }
      for (const r of rows) {
        this.db.query("DELETE FROM artifacts WHERE id = ?").run(r.id);
      }
      return rows;
    },

    /** Sweep de démarrage (Lot 2, audit L2-7) : purge défensive des orphelins
     *  de crash — fichiers dérivés sans ligne (écriture réussie, DELETE
     *  manqué ou interrompu) et lignes sans conversation (cascade manquée à
     *  la suppression d'une conversation). Les lignes sans FICHIER sont
     *  volontairement épargnées : PNG/PDF sont des rendus dérivés à la
     *  demande — une ligne sans rendu est un état légitime (il sera
     *  régénéré). Idempotent : tout est cohérent ⇒ ne touche à rien. */
    sweepOrphanArtifacts(): { removedFiles: string[]; removedRows: string[] } {
      const removedFiles: string[] = [];
      const removedRows: string[] = [];
      // 1) fichiers dérivés sans ligne — restes de crash sur disque
      try {
        if (existsSync(ARTIFACTS_DIR)) {
          const known = new Set(
            (this.db.query("SELECT id FROM artifacts").all() as { id: string }[]).map(
              (r) => r.id
            )
          );
          for (const f of readdirSync(ARTIFACTS_DIR)) {
            const m = /^(.+)\.(png|pdf)$/.exec(f);
            if (m && !known.has(m[1])) {
              try {
                unlinkSync(join(ARTIFACTS_DIR, f));
                removedFiles.push(f);
              } catch {
                /* déjà parti — rien à réclamer */
              }
            }
          }
        }
      } catch {
        /* répertoire illisible : le boot ne doit jamais mourir ici */
      }
      // 2) lignes sans conversation (cascade manquée) — leurs fichiers suivent
      try {
        const dangling = this.db
          .query(
            `SELECT a.id FROM artifacts a
             LEFT JOIN conversations c ON c.id = a.conversation_id
             WHERE c.id IS NULL`
          )
          .all() as { id: string }[];
        if (dangling.length > 0) {
          // Transaction (Lot 2, audit L2-5) : les DELETE des lignes pendantes
          // forment un seul acte — les fichiers sont ensuite réclamés hors
          // base (un unlink manqué ne laisse qu'un fichier, jamais une ligne).
          this.db.transaction(() => {
            for (const r of dangling) {
              this.db.query("DELETE FROM artifacts WHERE id = ?").run(r.id);
              removedRows.push(r.id);
            }
          })();
          for (const r of dangling) {
            for (const p of [artifactThumbPath(r.id), artifactPdfPath(r.id)]) {
              try {
                if (existsSync(p)) {
                  unlinkSync(p);
                  removedFiles.push(basename(p));
                }
              } catch {
                /* déjà parti */
              }
            }
          }
        }
      } catch {
        /* DB indisponible au sweep : même garde de boot */
      }
      return { removedFiles, removedRows };
    },

    // ── Versionnage fichiers (F-26) : actions humaines sur le journal ───────

    /** Étiquette une version (double-clic dans le journal) ; null = efface. */
    setArtifactLabel(id: string, label: string | null): ArtifactRow | null {
      this.db.query("UPDATE artifacts SET label = ? WHERE id = ?").run(label, id);
      return this.getArtifactRow(id);
    },

    /** Épingle / détache une version (jamais purgée). Refuse au-delà du plafond. */
    setArtifactPinned(
      id: string,
      pinned: boolean
    ): { row: ArtifactRow | null; error?: string } {
      const row = this.getArtifactRow(id);
      if (!row) return { row: null, error: "Artefact introuvable" };
      if (pinned) {
        const r = this.db
          .query(
            "SELECT COUNT(*) AS n FROM artifacts WHERE conversation_id = ? AND key = ? AND pinned = 1"
          )
          .get(row.conversation_id, row.key) as any;
        if ((r?.n ?? 0) >= MAX_PINNED && !row.pinned) {
          return { row, error: `Maximum ${MAX_PINNED} versions épinglées par fichier` };
        }
      }
      this.db.query("UPDATE artifacts SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
      return { row: this.getArtifactRow(id) };
    },

    /**
     * Restaure une version antérieure : crée v(n+1) portant le contenu de vN
     * (jamais d'écrasement — l'historique reste linéaire et complet). La version
     * née d'une restauration porte le libellé automatique et le marqueur ↩.
     */
    restoreArtifactVersion(
      conversationId: string,
      key: string,
      fromVersion: number
    ): ArtifactRow | null {
      const src = (
        this.db
          .query(
            "SELECT * FROM artifacts WHERE conversation_id = ? AND key = ? AND version = ?"
          )
          .get(conversationId, key, fromVersion) as ArtifactRow | undefined
      );
      if (!src) return null;
      const { status, statusLabel } = restoredStatus(src.kind);
      // Revue P1-P7 : même transaction que insertArtifact — le numéro de
      // version et l'INSERT sont inséparables.
      return this.db.transaction(() => {
        const id = crypto.randomUUID();
        const version = this.nextArtifactVersion(conversationId, key);
        this.db
          .query(
            `INSERT INTO artifacts (id, conversation_id, message_id, key, version, kind, name, language, mime, content, size, status, status_label, error, label, pinned, restored_from, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            conversationId,
            src.message_id,
            key,
            version,
            src.kind,
            src.name,
            src.language,
            src.mime,
            src.content,
            src.size,
            status,
            statusLabel,
            null,
            restoreLabel(fromVersion),
            0,
            fromVersion,
            new Date().toISOString()
          );
        return this.getArtifactRow(id);
      })();
    },

    /**
     * Applique le quota du journal : supprime les plus anciennes versions non
     * épinglées au-delà du plafond (jamais la version courante) et renvoie les
     * lignes supprimées (nettoyage des fichiers dérivés par l'appelant).
     */
    purgeArtifactVersions(
      conversationId: string,
      key: string,
      keep = MAX_VERSIONS
    ): ArtifactRow[] {
      const versions = this.listArtifactVersions(conversationId, key);
      const doomed = selectPurgeable(versions, keep);
      for (const r of doomed) {
        this.db.query("DELETE FROM artifacts WHERE id = ?").run(r.id);
      }
      return doomed;
    },

    /** Duplique les artefacts d'une conversation vers un fork (re-ancrage des
     *  messages). Lot 2 (audit L2-2) : seuls les artefacts des messages
     *  RÉELLEMENT copiés suivent — un fork depuis un message intermédiaire
     *  n'hérite plus des artefacts du futur — et les fichiers dérivés (vignette
     *  PNG, PDF) sont copiés vers le NOUVEL id. */
    copyArtifactsToFork(
      fromConversationId: string,
      toConversationId: string,
      messageIdMap: Map<string, string>
    ): void {
      const rows = this.listConversationArtifacts(fromConversationId).filter((r) =>
        messageIdMap.has(r.message_id)
      );
      if (rows.length === 0) return;
      this.db.transaction(() => {
        for (const r of rows) {
          const newMessageId = messageIdMap.get(r.message_id)!;
          // Nouvel id de ligne : les fichiers dérivés doivent suivre (une
          // suppression dans le fork ne doit pas effacer ceux de l'original).
          const newId = crypto.randomUUID();
          this.db
            .query(
              `INSERT OR IGNORE INTO artifacts (id, conversation_id, message_id, key, version, kind, name, language, mime, content, size, status, status_label, error, label, pinned, restored_from, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              newId,
              toConversationId,
              newMessageId,
              r.key,
              r.version,
              r.kind,
              r.name,
              r.language,
              r.mime,
              r.content,
              r.size,
              r.status,
              r.status_label,
              r.error,
              r.label,
              r.pinned,
              r.restored_from,
              r.created_at
            );
          for (const [from, to] of [
            [artifactThumbPath(r.id), artifactThumbPath(newId)],
            [artifactPdfPath(r.id), artifactPdfPath(newId)],
          ] as const) {
            try {
              if (existsSync(from)) copyFileSync(from, to);
            } catch {
              /* vignette/PDF absents ou illisibles — la carte reste lisible */
            }
          }
        }
      })();
    }
  };
}
