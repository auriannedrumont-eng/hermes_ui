// Store SQLite — conversations, projets, artefacts versionnés (v0.3.0).
// Le chemin vient de DATABASE_URL (ou HERMES_CHAT_DB pour les tests) ;
// le module résout son chemin à l'import et le garde en cache.
import { Database } from "bun:sqlite";
import { isStorageCleanable } from "./shared/chat-protocol";
import fs from "node:fs";
import path from "node:path";

export interface ArtifactRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  key: string;
  version: number;
  kind: string;
  name: string;
  language: string | null;
  mime: string;
  content: string;
  size: number;
  status: string;
  status_label: string | null;
  error: string | null;
  label: string | null;
  pinned: number;
  restored_from: number | null;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  project_id: string | null;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

function resolveDbPath(): string {
  const fromEnv = process.env.HERMES_CHAT_DB || process.env.DATABASE_URL;
  const m = fromEnv?.match(/^file:(.+)$/);
  const raw = m ? m[1] : (fromEnv || "/home/z/my-project/hermes_ui/db/custom.db");
  const p = path.resolve(raw);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

export interface InsertArtifactInput {
  conversationId: string;
  messageId?: string | null;
  key: string;
  kind: string;
  name: string;
  language?: string | null;
  mime?: string;
  content: string;
  status?: string;
  statusLabel?: string | null;
  label?: string | null;
}

export class Store {
  db: Database;

  constructor() {
    this.db = new Database(resolveDbPath());
    // bun:sqlite : les pragmas passent par exec (pas de méthode .pragma).
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        key TEXT NOT NULL,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        language TEXT,
        mime TEXT,
        content TEXT,
        size INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'generating',
        status_label TEXT,
        error TEXT,
        label TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        restored_from INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, key, version)
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_conv ON artifacts (conversation_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_conv_key ON artifacts (conversation_id, key);
    `);
  }

  // ── Conversations & projets ────────────────────────────────────────────
  createConversation(title: string, projectId?: string | null): ConversationRow {
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO conversations (id, title, project_id) VALUES (?, ?, ?)"
      )
      .run(id, title, projectId ?? null);
    return this.getConversation(id)!;
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as
      | ConversationRow
      | undefined;
  }

  listConversations(): ConversationRow[] {
    return this.db.query("SELECT * FROM conversations ORDER BY created_at DESC").all() as ConversationRow[];
  }

  deleteConversation(id: string): void {
    this.db.query("DELETE FROM artifacts WHERE conversation_id = ?").run(id);
    this.db.query("DELETE FROM conversations WHERE id = ?").run(id);
  }

  createProject(name: string): ProjectRow {
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, name);
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  }

  listProjects(): ProjectRow[] {
    return this.db.query("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all() as ProjectRow[];
  }

  deleteProject(id: string): void {
    // Les conversations retombent « hors projet » (ON DELETE SET NULL) ;
    // le projet disparaît, les artefacts restent localisables.
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ── Artefacts (insertion versionnée) ──────────────────────────────────
  insertArtifact(input: InsertArtifactInput): ArtifactRow {
    const id = crypto.randomUUID();
    const next =
      (
        this.db
          .query(
            "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM artifacts WHERE conversation_id = ? AND key = ?"
          )
          .get(input.conversationId, input.key) as { v: number }
      ).v ?? 1;
    const content = input.content ?? "";
    const size = Buffer.byteLength(content, "utf-8");
    this.db
      .query(
        `INSERT INTO artifacts
         (id, conversation_id, message_id, key, version, kind, name, language, mime, content, size, status, status_label, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.messageId ?? null,
        input.key,
        next,
        input.kind,
        input.name,
        input.language ?? null,
        input.mime ?? "application/octet-stream",
        content,
        size,
        input.status ?? "ready",
        input.statusLabel ?? null,
        input.label ?? null
      );
    return this.getArtifactRow(id)!;
  }

  getArtifactRow(id: string): ArtifactRow | undefined {
    return this.db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as
      | ArtifactRow
      | undefined;
  }

  listArtifactVersions(conversationId: string, key: string): ArtifactRow[] {
    return this.db
      .query(
        "SELECT * FROM artifacts WHERE conversation_id = ? AND key = ? ORDER BY version ASC"
      )
      .all(conversationId, key) as ArtifactRow[];
  }

  listConversationArtifacts(conversationId: string): ArtifactRow[] {
    return this.db
      .query("SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_at DESC")
      .all(conversationId) as ArtifactRow[];
  }

  deleteConversationArtifacts(conversationId: string): void {
    this.db.query("DELETE FROM artifacts WHERE conversation_id = ?").run(conversationId);
  }

  setArtifactPinned(id: string, pinned: boolean): ArtifactRow | undefined {
    this.db.query("UPDATE artifacts SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
    return this.getArtifactRow(id);
  }

  // ── Stockage (page Stockage — v0.3.0) ──────────────────────────────────
  /** Inventaire plat : toutes les versions, projet résolu, ordre stable.
   *  Le nom de projet est RÉSOLU en champ plat `projectName` (« Hors
   *  projet » si conversation sans projet) : le test E2E et le front
   *  regroupent sans re-jointure. */
  listStorageEntries(): Array<
    ArtifactRow & {
      conversation_title: string | null;
      project_id: string | null;
      project_name: string | null;
      projectName: string;
    }
  > {
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
  }

  /** Suppression d'une version — la définition épinglée fait foi :
   *  jamais d'écrasement d'une version protégée (409 côté interface). */
  deleteStorageVersion(id: string): { row: ArtifactRow } | { refuse: "notfound" | "pinned" } {
    const row = this.getArtifactRow(id);
    if (!row) return { refuse: "notfound" };
    if (row.pinned) return { refuse: "pinned" };
    this.db.query("DELETE FROM artifacts WHERE id = ?").run(id);
    return { row };
  }

  /** Nettoyage d'un projet : versions dépassées non épinglées de chaque
   *  document (par numéro, jamais par date — §5.2). Idempotent par
   *  construction : un second appel ne trouve plus rien. */
  cleanStorageProject(projectId: string | null): ArtifactRow[] {
    const doomed: ArtifactRow[] = [];
    const entries = this.listStorageEntries().filter((e) =>
      projectId === null ? e.project_id === null : e.project_id === projectId
    );
    // Groupe par document (conversation + clé) : la dernière version de
    // chacun reste, les précédentes non épinglées partent.
    const byDoc = new Map<string, Array<{ id: string; key: string; version: number; pinned: number }>>();
    for (const e of entries) {
      const docKey = `${e.conversation_id}\u0000${e.key}`;
      const list = byDoc.get(docKey);
      if (list) list.push(e);
      else byDoc.set(docKey, [e]);
    }
    for (const docEntries of byDoc.values()) {
      const maxV = docEntries.reduce((m, e) => Math.max(m, e.version), 0);
      for (const e of docEntries) {
        if (!isStorageCleanable(e, maxV)) continue;
        const res = this.deleteStorageVersion(e.id);
        if ("row" in res) doomed.push(res.row);
      }
    }
    return doomed;
  }
}
