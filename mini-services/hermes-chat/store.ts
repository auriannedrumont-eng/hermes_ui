// Persistance SQLite (bun:sqlite) : conversations + messages + artefacts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Artifact,
  ArtifactKind,
  Attachment,
  ChatMessage,
  ConversationMeta,
  Project,
  Role,
  SearchHit,
  ToolEvent,
} from "./types";

const DB_PATH = join(import.meta.dir, "..", "..", "db", "hermes-chat.sqlite");

/** Ligne interne d'artefact (une par version, contenu source inclus). */
export interface ArtifactRow {
  id: string;
  conversation_id: string;
  message_id: string;
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
  created_at: string;
}

export function rowToArtifactMeta(r: ArtifactRow): Omit<Artifact, "anchorMessageId"> {
  return {
    id: r.id,
    key: r.key,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    version: r.version,
    kind: r.kind as ArtifactKind,
    name: r.name,
    language: r.language ?? undefined,
    mime: r.mime,
    size: r.size,
    status: r.status as Artifact["status"],
    statusLabel: r.status_label ?? undefined,
    error: r.error ?? undefined,
    url: `/artifacts/${r.id}/download`,
    rawUrl: `/artifacts/${r.id}/raw`,
    createdAt: r.created_at,
  };
}

/** Ligne interne de projet (rangement des conversations). */
export interface ProjectRow {
  id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Store {
  private db: Database;

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning TEXT,
      tool_events TEXT,
      model TEXT,
      created_at TEXT NOT NULL
    )`);
    // Migration douce : colonne des pièces jointes multimédia
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
    } catch {
      /* colonne déjà présente */
    }
    // Migration douce : colonne des conversations épinglées
    try {
      this.db.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* colonne déjà présente */
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content)"
    );
    // ── Artefacts : fichiers générés par l'agent, versionnés par clé ─────
    this.db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      key TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      language TEXT,
      mime TEXT NOT NULL,
      content TEXT NOT NULL,
      size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      status_label TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    )`);
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_conv_key_version ON artifacts(conversation_id, key, version)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id, created_at)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id)"
    );
    // ── Projets : rangement des conversations par projet (fork) ──────
    this.db.exec(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    // Migration douce : colonne de rangement des conversations
    try {
      this.db.exec("ALTER TABLE conversations ADD COLUMN project_id TEXT");
    } catch {
      /* colonne déjà présente */
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)"
    );
    // ── Réglages serveur (persistés, cf. FORK.md §6) ─────────────────
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  // ── Artefacts ──────────────────────────────────────────────────────────

  /** Insère une version d'artefact. */
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
  }): ArtifactRow {
    const id = a.id ?? crypto.randomUUID();
    const version = this.nextArtifactVersion(a.conversationId, a.key);
    const created_at = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO artifacts (id, conversation_id, message_id, key, version, kind, name, language, mime, content, size, status, status_label, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        created_at
      );
    return this.getArtifactRow(id)!;
  }

  /** Version suivante d'une clé dans la conversation (1 si nouvelle). */
  private nextArtifactVersion(conversationId: string, key: string): number {
    const r = this.db
      .query(
        "SELECT MAX(version) AS v FROM artifacts WHERE conversation_id = ? AND key = ?"
      )
      .get(conversationId, key) as any;
    return (r?.v ?? 0) + 1;
  }

  getArtifactRow(id: string): ArtifactRow | null {
    return (
      (this.db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow) ?? null
    );
  }

  /** Toutes les versions d'artefacts d'une conversation (ordre chronologique). */
  listConversationArtifacts(conversationId: string): ArtifactRow[] {
    return this.db
      .query(
        "SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY version ASC, created_at ASC"
      )
      .all(conversationId) as ArtifactRow[];
  }

  /** Toutes les versions d'une clé. */
  listArtifactVersions(conversationId: string, key: string): ArtifactRow[] {
    return this.db
      .query(
        "SELECT * FROM artifacts WHERE conversation_id = ? AND key = ? ORDER BY version ASC"
      )
      .all(conversationId, key) as ArtifactRow[];
  }

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
  }

  /** Supprime les artefacts d'une conversation ; renvoie les lignes (nettoyage fichiers). */
  deleteConversationArtifacts(conversationId: string): ArtifactRow[] {
    const rows = this.listConversationArtifacts(conversationId);
    this.db.query("DELETE FROM artifacts WHERE conversation_id = ?").run(conversationId);
    return rows;
  }

  /** Duplique les artefacts d'une conversation vers un fork (re-ancrage des messages). */
  copyArtifactsToFork(
    fromConversationId: string,
    toConversationId: string,
    messageIdMap: Map<string, string>
  ): void {
    const rows = this.listConversationArtifacts(fromConversationId);
    for (const r of rows) {
      const newMessageId = messageIdMap.get(r.message_id) ?? r.message_id;
      // Conserve le numéro de version d'origine (identité stable dans le fork)
      this.db
        .query(
          `INSERT OR IGNORE INTO artifacts (id, conversation_id, message_id, key, version, kind, name, language, mime, content, size, status, status_label, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          crypto.randomUUID(),
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
          r.created_at
        );
    }
  }

  // ── Projets : rangement des conversations ─────────────────────────

  listProjects(): Project[] {
    const rows = this.db
      .query("SELECT * FROM projects ORDER BY position ASC, created_at ASC")
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  getProject(id: string): Project | null {
    const r = this.db
      .query("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | null;
    return r ? rowToProject(r) : null;
  }

  createProject(name: string): Project {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const r = this.db
      .query("SELECT MAX(position) AS p FROM projects")
      .get() as any;
    const position = (r?.p ?? -1) + 1;
    this.db
      .query(
        "INSERT INTO projects (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, name.trim().slice(0, 80), position, now, now);
    return this.getProject(id)!;
  }

  renameProject(id: string, name: string): Project | null {
    if (!this.getProject(id)) return null;
    this.db
      .query("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(name.trim().slice(0, 80), new Date().toISOString(), id);
    return this.getProject(id);
  }

  /** Supprime un projet ; ses conversations retombent dans « Sans projet ». */
  deleteProject(id: string): void {
    this.db.query("UPDATE conversations SET project_id = NULL WHERE project_id = ?").run(id);
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
  }

  /** Réordonne les projets selon la liste d'ids fournie (positions 0..n-1). */
  reorderProjects(ids: string[]): Project[] {
    const known = new Set(this.listProjects().map((p) => p.id));
    ids.forEach((pid, i) => {
      if (!known.has(pid)) return;
      this.db.query("UPDATE projects SET position = ? WHERE id = ?").run(i, pid);
    });
    return this.listProjects();
  }

  /** Déplace une conversation vers un projet (null = « Sans projet »). */
  moveConversation(conversationId: string, projectId: string | null): ConversationMeta | null {
    if (projectId && !this.getProject(projectId)) return null;
    const conv = this.getConversation(conversationId);
    if (!conv) return null;
    this.db
      .query("UPDATE conversations SET project_id = ? WHERE id = ?")
      .run(projectId, conversationId);
    return this.getConversation(conversationId);
  }

  // ── Réglages serveur (cf. FORK.md §6) ──────────────────────────

  getSetting(key: string): string | null {
    const r = this.db
      .query("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | null;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, now);
  }

  listSettings(): { key: string; value: string; updatedAt: string }[] {
    const rows = this.db
      .query("SELECT key, value, updated_at FROM settings ORDER BY key ASC")
      .all() as any[];
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  }

  listConversations(): ConversationMeta[] {
    const rows = this.db
      .query(
        `SELECT c.id, c.title, c.created_at, c.updated_at, c.pinned, c.project_id,
                COUNT(m.id) AS message_count,
                (SELECT content FROM messages m2 WHERE m2.conversation_id = c.id AND m2.role = 'user' ORDER BY m2.created_at DESC LIMIT 1) AS preview
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
         GROUP BY c.id
         ORDER BY c.pinned DESC, c.updated_at DESC`
      )
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: r.message_count ?? 0,
      preview: (r.preview ?? "").slice(0, 90),
      pinned: !!r.pinned,
      projectId: r.project_id ?? null,
    }));
  }

  createConversation(title: string, projectId?: string | null): ConversationMeta {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    // Le projet n'est appliqué que s'il existe réellement
    const project = projectId ? this.getProject(projectId) : null;
    this.db
      .query(
        "INSERT INTO conversations (id, title, created_at, updated_at, project_id) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, title, now, now, project ? project.id : null);
    return {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      preview: "",
      projectId: project ? project.id : null,
    };
  }

  deleteConversation(id: string): void {
    this.db.query("DELETE FROM messages WHERE conversation_id = ?").run(id);
    this.db.query("DELETE FROM conversations WHERE id = ?").run(id);
  }

  renameConversation(id: string, title: string): ConversationMeta | null {
    const conv = this.getConversation(id);
    if (!conv) return null;
    this.db
      .query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, new Date().toISOString(), id);
    return { ...conv, title, updatedAt: new Date().toISOString() };
  }

  getConversation(id: string): ConversationMeta | null {
    const r = this.db
      .query(
        "SELECT id, title, created_at, updated_at, pinned, project_id FROM conversations WHERE id = ?"
      )
      .get(id) as any;
    if (!r) return null;
    const count = (
      this.db
        .query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
        .get(id) as any
    ).n;
    return {
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: count,
      preview: "",
      pinned: !!(r as any).pinned,
      projectId: (r as any).project_id ?? null,
    };
  }

  /** Épingle / détache une conversation (remonte en haut de la liste). */
  setPinned(id: string, pinned: boolean): ConversationMeta | null {
    const conv = this.getConversation(id);
    if (!conv) return null;
    this.db
      .query("UPDATE conversations SET pinned = ? WHERE id = ?")
      .run(pinned ? 1 : 0, id);
    return { ...conv, pinned };
  }

  touchConversation(id: string, title?: string): ConversationMeta | null {
    const now = new Date().toISOString();
    if (title) {
      this.db
        .query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
        .run(title, now, id);
    } else {
      this.db
        .query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(now, id);
    }
    return this.getConversation(id);
  }

  getMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .query(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC"
      )
      .all(conversationId) as any[];
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as Role,
      content: r.content,
      reasoning: r.reasoning ?? undefined,
      toolEvents: r.tool_events ? (JSON.parse(r.tool_events) as ToolEvent[]) : undefined,
      attachments: r.attachments ? (JSON.parse(r.attachments) as Attachment[]) : undefined,
      model: r.model ?? undefined,
      createdAt: r.created_at,
    }));
  }

  appendMessage(msg: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: string }): ChatMessage {
    const id = msg.id ?? crypto.randomUUID();
    const createdAt = msg.createdAt ?? new Date().toISOString();
    this.db
      .query(
        "INSERT INTO messages (id, conversation_id, role, content, reasoning, tool_events, attachments, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        msg.conversationId,
        msg.role,
        msg.content,
        msg.reasoning ?? null,
        msg.toolEvents ? JSON.stringify(msg.toolEvents) : null,
        msg.attachments ? JSON.stringify(msg.attachments) : null,
        msg.model ?? null,
        createdAt
      );
    return { ...msg, id, createdAt } as ChatMessage;
  }

  /** Message individuel (ou null). */
  getMessage(conversationId: string, messageId: string): ChatMessage | null {
    const r = this.db
      .query("SELECT * FROM messages WHERE conversation_id = ? AND id = ?")
      .get(conversationId, messageId) as any;
    if (!r) return null;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as Role,
      content: r.content,
      reasoning: r.reasoning ?? undefined,
      toolEvents: r.tool_events ? (JSON.parse(r.tool_events) as ToolEvent[]) : undefined,
      attachments: r.attachments ? (JSON.parse(r.attachments) as Attachment[]) : undefined,
      model: r.model ?? undefined,
      createdAt: r.created_at,
    };
  }

  /** Supprime un message ; renvoie ses pièces jointes (nettoyage disque). */
  deleteMessage(conversationId: string, messageId: string): ChatMessage | null {
    const msg = this.getMessage(conversationId, messageId);
    if (!msg) return null;
    this.db
      .query("DELETE FROM messages WHERE conversation_id = ? AND id = ?")
      .run(conversationId, messageId);
    this.touchConversation(conversationId);
    return msg;
  }

  /**
   * Supprime les messages assistant en fin de fil (pour régénérer).
   * Renvoie le dernier message utilisateur et les ids supprimés.
   */
  deleteTrailingAssistant(conversationId: string): {
    lastUser: ChatMessage | null;
    removedIds: string[];
    removedAttachments: Attachment[];
  } {
    const msgs = this.getMessages(conversationId);
    const removedIds: string[] = [];
    const removedAttachments: Attachment[] = [];
    while (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
      const m = msgs.pop()!;
      removedIds.push(m.id);
      removedAttachments.push(...(m.attachments ?? []));
    }
    for (const id of removedIds) {
      this.db
        .query("DELETE FROM messages WHERE conversation_id = ? AND id = ?")
        .run(conversationId, id);
    }
    const lastUser = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    if (removedIds.length) this.touchConversation(conversationId);
    return { lastUser, removedIds, removedAttachments };
  }

  /**
   * Modifie le contenu d'un message utilisateur et supprime tout ce qui le suit
   * (relance du tour depuis ce point). Renvoie le message modifié et les ids supprimés.
   */
  editUserMessageAndTruncate(
    conversationId: string,
    messageId: string,
    content: string
  ): { message: ChatMessage; removedIds: string[]; removedAttachments: Attachment[] } | null {
    const msg = this.getMessage(conversationId, messageId);
    if (!msg || msg.role !== "user") return null;
    const all = this.getMessages(conversationId);
    const idx = all.findIndex((m) => m.id === messageId);
    if (idx < 0) return null;
    const removed = all.slice(idx + 1);
    for (const m of removed) {
      this.db
        .query("DELETE FROM messages WHERE conversation_id = ? AND id = ?")
        .run(conversationId, m.id);
    }
    this.db
      .query("UPDATE messages SET content = ? WHERE conversation_id = ? AND id = ?")
      .run(content, conversationId, messageId);
    this.touchConversation(conversationId);
    return {
      message: { ...msg, content },
      removedIds: removed.map((m) => m.id),
      removedAttachments: removed.flatMap((m) => m.attachments ?? []),
    };
  }

  /** Duplique une conversation jusqu'à un message donné (branche / fork). */
  forkConversation(
    conversationId: string,
    fromMessageId?: string
  ): ConversationMeta | null {
    const src = this.getConversation(conversationId);
    if (!src) return null;
    const messages = this.getMessages(conversationId);
    const upto = fromMessageId
      ? (() => {
          const idx = messages.findIndex((m) => m.id === fromMessageId);
          return idx >= 0 ? messages.slice(0, idx + 1) : messages;
        })()
      : messages;
    const forked = this.createConversation(
      `${src.title.slice(0, 60)} (branche)`.slice(0, 120),
      src.projectId // la branche reste dans le même projet
    );
    // Mapping ancien id -> nouvel id pour re-ancrer les artefacts du fork
    const messageIdMap = new Map<string, string>();
    for (const m of upto) {
      const copy = this.appendMessage({
        conversationId: forked.id,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        toolEvents: m.toolEvents,
        attachments: m.attachments,
        model: m.model,
        createdAt: m.createdAt,
      });
      messageIdMap.set(m.id, copy.id);
    }
    this.copyArtifactsToFork(conversationId, forked.id, messageIdMap);
    return this.getConversation(forked.id);
  }

  /** Recherche plein-texte dans le contenu des messages. */
  searchMessages(query: string, limit = 30): SearchHit[] {
    const q = query.trim();
    if (q.length < 2) return [];
    const pattern = `%${q.replace(/[%,_]/g, (c) => `\${c}`)}%`;
    const rows = this.db
      .query(
        `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
                c.title AS conversation_title
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.content LIKE ? ESCAPE '\\'
         ORDER BY m.created_at DESC
         LIMIT ?`
      )
      .all(pattern, limit) as any[];
    const hits: SearchHit[] = [];
    for (const r of rows) {
      const idx = r.content.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 40);
      const excerpt =
        (start > 0 ? "…" : "") +
        r.content.slice(start, start + 140).replace(/\s+/g, " ").trim() +
        (start + 140 < r.content.length ? "…" : "");
      hits.push({
        conversationId: r.conversation_id,
        conversationTitle: r.conversation_title,
        messageId: r.id,
        role: r.role as Role,
        excerpt,
        createdAt: r.created_at,
      });
    }
    return hits;
  }

  /** Pièces jointes d'une conversation (pour le nettoyage disque). */
  conversationAttachments(conversationId: string): Attachment[] {
    const rows = this.db
      .query("SELECT attachments FROM messages WHERE conversation_id = ?")
      .all(conversationId) as any[];
    const out: Attachment[] = [];
    for (const r of rows) {
      if (!r.attachments) continue;
      try {
        out.push(...(JSON.parse(r.attachments) as Attachment[]));
      } catch {
        /* JSON invalide — ignoré */
      }
    }
    return out;
  }
}
