// Persistance SQLite (bun:sqlite) : conversations + messages + artefacts
// Le chemin est surchargeable par HERMES_CHAT_DB (tests d'intégration —
// sinon la base de dev du service).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ShareRow } from "./shares";
import type { SystemPromptRow } from "./prompts";
import type { WebSource } from "./web-search";
import { MAX_PINNED, MAX_VERSIONS, isIdenticalReissue, restoreLabel, restoredStatus, selectPurgeable } from "./versions";
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

const DB_PATH =
  process.env.HERMES_CHAT_DB ??
  join(import.meta.dir, "..", "..", "db", "hermes-chat.sqlite");

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
  // Versionnage fichiers (F-26) — couche humaine du journal de versions
  label: string | null;
  pinned: number;
  restored_from: number | null;
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
    label: r.label ?? undefined,
    pinned: !!r.pinned,
    restoredFrom: r.restored_from ?? undefined,
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

/** Ligne interne d'un fournisseur (LLM ou service d'API). */
export interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  strategy: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Ligne interne d'une clé — `secret` ne quitte jamais le service. */
export interface KeyRow {
  id: string;
  provider_id: string;
  label: string;
  secret: string;
  masked: string;
  status: string;
  status_label: string | null;
  last_tested_at: string | null;
  position: number;
  used_count: number;
  created_at: string;
}

/** Ligne interne d'une extension (dépôt importé ou serveur MCP). */
export interface ExtensionRow {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  source: string | null;
  channel: string | null;
  commit: string | null;
  version: string | null;
  pinned: number;
  enabled: number;
  applied: number;
  update_available: string | null;
  last_checked_at: string | null;
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
  /** Checkpointeur périodique du WAL (dette revue 2026-11-13 : sans lui,
   *  le -wal croît sans borne entre les redémarrages ; SQLite ne fait un
   *  checkpoint automatique qu'au franchissement du seuil ~1000 pages
   *  en pleine écriture, jamais sur un service majoritairement en lecture). */
  private walTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA wal_autocheckpoint = 0;"); // checkpoint géré ici, en zone calme
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
    // Migration douce : marqueur des réponses interrompues (bouton Stop)
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN stopped INTEGER");
    } catch {
      /* colonne déjà présente */
    }
    // Migration douce : feedback utilisateur (F-24) — 👍/👎 + commentaire
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN feedback_rating TEXT");
    } catch {
      /* colonne déjà présente */
    }
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN feedback_comment TEXT");
    } catch {
      /* colonne déjà présente */
    }
    // Migration douce : variante de comparaison (F-17) — "a" | "b" | null
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN variant TEXT");
    } catch {
      /* colonne déjà présente */
    }
    // Migration douce (F-14) : versions de réponse — régénérer conserve
    // l'ancienne version (groupe + index ; active = celle affichée/envoyée).
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN version_group TEXT");
    } catch {
      /* colonne déjà présente */
    }
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN version_index INTEGER");
    } catch {
      /* colonne déjà présente */
    }
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN version_active INTEGER");
    } catch {
      /* colonne déjà présente */
    }
    // Migration douce (F-21) : usage par message — jetons réellement facturés
    // (input/output) et coût facturé par le fournisseur quand il le renvoie.
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN usage_input INTEGER");
    } catch {
      /* colonne déjà présente */
    }
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN usage_output INTEGER");
    } catch {
      /* colonne déjà présente */
    }
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN usage_cost REAL");
    } catch {
      /* colonne déjà présente */
    }
    // Migration douce (F-12) : sources citées par un tour avec recherche web.
    try {
      this.db.exec("ALTER TABLE messages ADD COLUMN sources TEXT");
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
    // ── Versionnage fichiers (F-26) : couche humaine du journal ────────
    // La table artifacts est déjà un journal immuable (une ligne par
    // version) ; on y ajoute l'étiquette, l'épinglage et le marqueur de
    // restauration. Migration douce (R2 : additives uniquement).
    try {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN label TEXT");
    } catch {
      /* colonne déjà présente */
    }
    try {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* colonne déjà présente */
    }
    try {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN restored_from INTEGER");
    } catch {
      /* colonne déjà présente */
    }
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
    // ── Fournisseurs & clés (Paramètres v2.2) ────────────────────────
    // Les secrets restent côté service : seules les vues masquées
    // partent vers le navigateur (providers.ts / toKeyView).
    this.db.exec(`CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT,
      strategy TEXT NOT NULL DEFAULT 'fill_first',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS provider_keys (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      label TEXT NOT NULL,
      secret TEXT NOT NULL,
      masked TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'untested',
      status_label TEXT,
      last_tested_at TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider_id, position)"
    );
    // ── Extensions : dépôts importés + serveurs MCP (Paramètres v2.2) ─
    // `applied` suit l'état réellement chargé : un toggle change `enabled`,
    // le redémarrage du service (re)charge l'état courant → applied = enabled.
    this.db.exec(`CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT,
      source TEXT,
      channel TEXT,
      "commit" TEXT,
      version TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      applied INTEGER NOT NULL DEFAULT 1,
      update_available TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    // ── Prompt système par conversation + presets (F-11, FORK.md §7.7) ──
    // Table additive : scope 'conversation' (une ligne par conversation au
    // plus) et 'preset' (bibliothèque réutilisable). Les instructions
    // globales (F-19) vivent dans `settings` (hermes.instructions.custom).
    this.db.exec(`CREATE TABLE IF NOT EXISTS system_prompts (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      conversation_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_system_prompts_conversation ON system_prompts(scope, conversation_id) WHERE scope = 'conversation'"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_system_prompts_preset ON system_prompts(updated_at DESC) WHERE scope = 'preset'"
    );
    // ── Partage public lecture seule (F-13) — snapshot figé ───────────
    this.db.exec(`CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_shares_conversation ON shares(conversation_id, created_at DESC)"
    );
    // Au démarrage, l'état courant devient l'état appliqué (les toggles
    // effectués sous l'ancien process ont été pris en compte au relancement).
    this.db.exec("UPDATE extensions SET applied = enabled WHERE applied <> enabled");
  }

  // ── Prompt système & presets (F-11 / F-19) ──────────────────────────────

  /** Prompt actif d'une conversation (null si aucun). */
  getConversationPrompt(conversationId: string): SystemPromptRow | null {
    const r = this.db
      .query(
        "SELECT id, scope, conversation_id, title, content, created_at, updated_at FROM system_prompts WHERE scope = 'conversation' AND conversation_id = ?"
      )
      .get(conversationId) as any;
    return r ? (r as SystemPromptRow) : null;
  }

  /** Définit le prompt d'une conversation (crée ou remplace). */
  setConversationPrompt(
    conversationId: string,
    content: string,
    presetTitle?: string | null
  ): SystemPromptRow {
    const now = new Date().toISOString();
    const existing = this.getConversationPrompt(conversationId);
    if (existing) {
      this.db
        .query("UPDATE system_prompts SET content = ?, title = ?, updated_at = ? WHERE id = ?")
        .run(content, presetTitle ?? existing.title, now, existing.id);
    } else {
      this.db
        .query(
          `INSERT INTO system_prompts (id, scope, conversation_id, title, content, created_at, updated_at)
           VALUES (?, 'conversation', ?, ?, ?, ?, ?)`
        )
        .run(crypto.randomUUID(), conversationId, presetTitle ?? "", content, now, now);
    }
    return this.getConversationPrompt(conversationId)!;
  }

  /** Retire le prompt d'une conversation (les presets restent). */
  clearConversationPrompt(conversationId: string): boolean {
    const r = this.db
      .query("DELETE FROM system_prompts WHERE scope = 'conversation' AND conversation_id = ?")
      .run(conversationId);
    return r.changes > 0;
  }

  /** Liste des presets réutilisables (plus récents d'abord). */
  listPromptPresets(): SystemPromptRow[] {
    return (this.db
      .query(
        "SELECT id, scope, conversation_id, title, content, created_at, updated_at FROM system_prompts WHERE scope = 'preset' ORDER BY updated_at DESC"
      )
      .all() as any[]) as SystemPromptRow[];
  }

  /** Crée un preset. */
  createPromptPreset(title: string, content: string): SystemPromptRow {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO system_prompts (id, scope, conversation_id, title, content, created_at, updated_at)
         VALUES (?, 'preset', NULL, ?, ?, ?, ?)`
      )
      .run(id, title, content, now, now);
    return this.db
      .query(
        "SELECT id, scope, conversation_id, title, content, created_at, updated_at FROM system_prompts WHERE id = ?"
      )
      .get(id) as SystemPromptRow;
  }

  /** Met à jour un preset (renvoie null s'il n'existe pas). */
  updatePromptPreset(id: string, title: string, content: string): SystemPromptRow | null {
    const now = new Date().toISOString();
    const r = this.db
      .query("UPDATE system_prompts SET title = ?, content = ?, updated_at = ? WHERE id = ? AND scope = 'preset'")
      .run(title, content, now, id);
    if (r.changes === 0) return null;
    return this.db
      .query(
        "SELECT id, scope, conversation_id, title, content, created_at, updated_at FROM system_prompts WHERE id = ?"
      )
      .get(id) as SystemPromptRow;
  }

  /** Supprime un preset (sans toucher aux prompts actifs des conversations). */
  deletePromptPreset(id: string): boolean {
    const r = this.db
      .query("DELETE FROM system_prompts WHERE id = ? AND scope = 'preset'")
      .run(id);
    return r.changes > 0;
  }

  /** Seeds idempotents : crée les presets de départ si la table est vide. */
  seedPromptPresetsIfNeeded(seeds: { title: string; content: string }[]): void {
    const n = (
      this.db.query("SELECT COUNT(*) AS n FROM system_prompts WHERE scope = 'preset'").get() as any
    ).n;
    if (n > 0) return;
    for (const s of seeds) this.createPromptPreset(s.title, s.content);
  }

  // ── Partage public lecture seule (F-13, FORK.md §7.8) ────────────────
  // Snapshot figé : le lien reste stable même si la conversation continue ;
  // la révocation marque la ligne (revoked_at) sans toucher la source.

  /** Partage actif d'une conversation (null si aucun ou révoqué). */
  getActiveShareByConversation(conversationId: string): ShareRow | null {
    const r = this.db
      .query(
        "SELECT id, token, conversation_id, title, snapshot, message_count, created_at, revoked_at FROM shares WHERE conversation_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1"
      )
      .get(conversationId) as any;
    return r ? (r as ShareRow) : null;
  }

  /** Ligne d'un partage par token (révoqué compris — l'HTTP décide du statut). */
  getShareByToken(token: string): ShareRow | null {
    const r = this.db
      .query(
        "SELECT id, token, conversation_id, title, snapshot, message_count, created_at, revoked_at FROM shares WHERE token = ?"
      )
      .get(token) as any;
    return r ? (r as ShareRow) : null;
  }

  /** Crée (ou recrée) le partage d'une conversation : un seul lien actif,
   *  l'ancien est révoqué silencieusement (snapshot purgé — même dette
   *  revue 2026-11-13 que revokeShareByConversation). */
  createShare(
    conversationId: string,
    title: string,
    snapshot: string,
    messageCount: number,
    token: string
  ): ShareRow {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE shares SET revoked_at = ?, snapshot = '', message_count = 0, title = ''
         WHERE conversation_id = ? AND revoked_at IS NULL`
      )
      .run(now, conversationId);
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO shares (id, token, conversation_id, title, snapshot, message_count, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(id, token, conversationId, title.slice(0, 300), snapshot, messageCount, now);
    return this.getShareByToken(token)!;
  }

  /** Révoque le partage actif d'une conversation (le lien devient 410). */
  revokeShareByConversation(conversationId: string): boolean {
    const now = new Date().toISOString();
    // Dette revue 2026-11-13 : la révocation PURGE le snapshot — marquer
    // revoked_at laissait le JSON complet (messages, donc données
    // personnelles) en base, lisible par tout accès direct au fichier.
    // Audit passe 3, F-10 : le titre est purgé aussi (il ne sert plus au 410).
    const r = this.db
      .query(
        `UPDATE shares SET revoked_at = ?, snapshot = '', message_count = 0, title = ''
         WHERE conversation_id = ? AND revoked_at IS NULL`
      )
      .run(now, conversationId);
    return r.changes > 0;
  }

  /** Supprime les partages d'une conversation supprimée ( liens 410 ).
   *  Même purge du snapshot que revokeShareByConversation. */
  revokeSharesOfConversation(conversationId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE shares SET revoked_at = ?, snapshot = '', message_count = 0, title = ''
         WHERE conversation_id = ? AND revoked_at IS NULL`
      )
      .run(now, conversationId);
  }

  /** Audit passe 3, F-10 : supprime les lignes révoquées de plus de
   *  `olderThanDays` jours — les métadonnées ne s'accumulent pas éternellement ;
   *  les révocations récentes restent pour la sémantique 410 vs 404. */
  purgeAgedRevokedShares(olderThanDays = 90): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
    const r = this.db
      .query("DELETE FROM shares WHERE revoked_at IS NOT NULL AND revoked_at < ?")
      .run(cutoff);
    return r.changes;
  }

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
  }

  /** Version courante d'une clé (la plus récente), null si nouvelle. */
  private latestArtifactRow(conversationId: string, key: string): ArtifactRow | null {
    return (
      (this.db
        .query(
          "SELECT * FROM artifacts WHERE conversation_id = ? AND key = ? ORDER BY version DESC LIMIT 1"
        )
        .get(conversationId, key) as ArtifactRow | undefined) ?? null
    );
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

  // ── Versionnage fichiers (F-26) : actions humaines sur le journal ───────

  /** Étiquette une version (double-clic dans le journal) ; null = efface. */
  setArtifactLabel(id: string, label: string | null): ArtifactRow | null {
    this.db.query("UPDATE artifacts SET label = ? WHERE id = ?").run(label, id);
    return this.getArtifactRow(id);
  }

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
  }

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
  }

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
      // F-26 : l'étiquette, l'épinglage et le marqueur de restauration suivent.
      this.db
        .query(
          `INSERT OR IGNORE INTO artifacts (id, conversation_id, message_id, key, version, kind, name, language, mime, content, size, status, status_label, error, label, pinned, restored_from, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          r.label,
          r.pinned,
          r.restored_from,
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

  /** Réglage booléen : stocké "1"/"0" (lisible en base), absent = fallback. */
  getSettingBool(key: string, fallback: boolean): boolean {
    const raw = this.getSetting(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  }

  setSettingBool(key: string, value: boolean): void {
    this.setSetting(key, value ? "1" : "0");
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
    // F-14 : le fil vivant ne montre que la version ACTIVE de chaque
    // réponse (version_active NULL = message jamais régénéré).
    const rows = this.db
      .query(
        "SELECT * FROM messages WHERE conversation_id = ? AND (version_active IS NULL OR version_active = 1) ORDER BY created_at ASC, rowid ASC"
      )
      .all(conversationId) as any[];
    const counts = new Map<string, number>();
    const vrows = this.db
      .query(
        "SELECT version_group AS g, COUNT(*) AS n FROM messages WHERE conversation_id = ? AND version_group IS NOT NULL GROUP BY version_group"
      )
      .all(conversationId) as any[];
    for (const v of vrows) counts.set(v.g, v.n);
    return rows.map((r) => ({
      versions:
        r.version_group && (counts.get(r.version_group) ?? 1) > 1
          ? {
              group: r.version_group,
              index: r.version_index ?? 1,
              count: counts.get(r.version_group) ?? 1,
            }
          : undefined,
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as Role,
      content: r.content,
      reasoning: r.reasoning ?? undefined,
      toolEvents: r.tool_events ? (JSON.parse(r.tool_events) as ToolEvent[]) : undefined,
      attachments: r.attachments ? (JSON.parse(r.attachments) as Attachment[]) : undefined,
      model: r.model ?? undefined,
      createdAt: r.created_at,
      stopped: r.stopped ? true : undefined,
      feedbackRating: (r.feedback_rating as "up" | "down" | null) ?? undefined,
      feedbackComment: r.feedback_comment ?? undefined,
      variant: (r.variant as "a" | "b" | null) ?? undefined,
      usage:
        r.usage_input != null || r.usage_output != null || r.usage_cost != null
          ? {
              input: (r.usage_input as number | null) ?? undefined,
              output: (r.usage_output as number | null) ?? undefined,
              cost: (r.usage_cost as number | null) ?? undefined,
            }
          : undefined,
      sources: r.sources ? (JSON.parse(r.sources) as WebSource[]) : undefined,
    }));
  }

  /** Définit le feedback d'un message assistant (F-24) — null = effacé. */
  setMessageFeedback(
    conversationId: string,
    messageId: string,
    rating: "up" | "down" | null,
    comment?: string | null
  ): ChatMessage | null {
    const msg = this.getMessage(conversationId, messageId);
    if (!msg || msg.role !== "assistant") return null;
    const clean = typeof comment === "string" ? comment.trim().slice(0, 2000) : null;
    this.db
      .query("UPDATE messages SET feedback_rating = ?, feedback_comment = ? WHERE conversation_id = ? AND id = ?")
      .run(rating, rating ? (clean ?? null) : null, conversationId, messageId);
    return this.getMessage(conversationId, messageId);
  }

  appendMessage(
    msg: Omit<ChatMessage, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
      /** F-14 : version de réponse (groupe partagé, index 1-based). */
      versionGroup?: string;
      versionIndex?: number;
      versionActive?: number;
    }
  ): ChatMessage {
    const id = msg.id ?? crypto.randomUUID();
    const createdAt = msg.createdAt ?? new Date().toISOString();
    this.db
      .query(
        "INSERT INTO messages (id, conversation_id, role, content, reasoning, tool_events, attachments, model, created_at, stopped, variant, version_group, version_index, version_active, usage_input, usage_output, usage_cost, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        createdAt,
        msg.stopped ? 1 : null,
        msg.variant ?? null,
        msg.versionGroup ?? null,
        msg.versionIndex ?? null,
        msg.versionActive ?? (msg.versionGroup ? 1 : null),
        msg.usage?.input ?? null,
        msg.usage?.output ?? null,
        msg.usage?.cost ?? null,
        msg.sources ? JSON.stringify(msg.sources) : null
      );
    return { ...msg, id, createdAt } as ChatMessage;
  }

  /** F-14 — nombre de versions d'un groupe (1 si inconnu). */
  countVersions(group: string): number {
    const r = this.db
      .query("SELECT COUNT(*) AS n FROM messages WHERE version_group = ?")
      .get(group) as any;
    return r?.n ?? 0;
  }

  /** F-14 — retire DU FIL (sans supprimer) les réponses assistant en fin
   *  de conversation : version_active=0, avec retro-complétion du groupe
   *  (première régénération d'une réponse jamais versionnée). Renvoie le
   *  groupe de version par côté, pour versionner les nouveaux tours. */
  supersedeTrailingAssistant(
    conversationId: string,
    variant?: "a" | "b"
  ): {
    lastUser: ChatMessage | null;
    supersededIds: string[];
    groups: { plain?: string; a?: string; b?: string };
  } {
    const msgs = this.getMessages(conversationId);
    const supersededIds: string[] = [];
    const groups: { plain?: string; a?: string; b?: string } = {};
    // Parcours de la fin : on supersede les réponses de la variante visée
    // (ou toutes si sans variante), on TRAVERSE les réponses de l'autre
    // côté (F-17 : l'ordre d'achèvement a/b est aléatoire), et on stoppe
    // au premier message utilisateur.
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role === "assistant") {
      const m = msgs[i];
      if (variant !== undefined && m.variant !== variant) {
        i--;
        continue;
      }
      const group = m.versions?.group ?? m.id;
      // Retro-complétion : une réponse non versionnée devient v1 de son groupe
      this.db
        .query(
          "UPDATE messages SET version_group = ?, version_index = ?, version_active = 0 WHERE conversation_id = ? AND id = ?"
        )
        .run(group, m.versions?.index ?? 1, conversationId, m.id);
      supersededIds.push(m.id);
      const key = variant === undefined ? "plain" : m.variant;
      if (key === "a" || key === "b" || key === "plain") {
        if (!groups[key]) groups[key] = group;
      }
      i--;
    }
    const rest = msgs.slice(0, i + 1);
    const lastUser = [...rest].reverse().find((m) => m.role === "user") ?? null;
    return { lastUser, supersededIds, groups };
  }

  /** F-14 — affiche la version `index` du groupe (les autres passent inactives). */
  setMessageVersion(
    conversationId: string,
    group: string,
    index: number
  ): ChatMessage[] | null {
    const count = this.countVersions(group);
    if (count < 1 || index < 1 || index > count) return null;
    this.db
      .query(
        "UPDATE messages SET version_active = 0 WHERE conversation_id = ? AND version_group = ?"
      )
      .run(conversationId, group);
    this.db
      .query(
        "UPDATE messages SET version_active = 1 WHERE conversation_id = ? AND version_group = ? AND version_index = ?"
      )
      .run(conversationId, group, index);
    return this.getMessages(conversationId);
  }

  /** Message individuel (ou null). */
  getMessage(conversationId: string, messageId: string): ChatMessage | null {
    const r = this.db
      .query("SELECT * FROM messages WHERE conversation_id = ? AND id = ?")
      .get(conversationId, messageId) as any;
    if (!r) return null;
    let versions: ChatMessage["versions"] = undefined;
    if (r.version_group) {
      const c = this.db
        .query("SELECT COUNT(*) AS n FROM messages WHERE version_group = ?")
        .get(r.version_group) as any;
      const count = c?.n ?? 1;
      if (count > 1)
        versions = { group: r.version_group, index: r.version_index ?? 1, count };
    }
    return {
      versions,
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as Role,
      content: r.content,
      reasoning: r.reasoning ?? undefined,
      toolEvents: r.tool_events ? (JSON.parse(r.tool_events) as ToolEvent[]) : undefined,
      attachments: r.attachments ? (JSON.parse(r.attachments) as Attachment[]) : undefined,
      model: r.model ?? undefined,
      createdAt: r.created_at,
      stopped: r.stopped ? true : undefined,
      feedbackRating: (r.feedback_rating as "up" | "down" | null) ?? undefined,
      feedbackComment: r.feedback_comment ?? undefined,
      variant: (r.variant as "a" | "b" | null) ?? undefined,
      usage:
        r.usage_input != null || r.usage_output != null || r.usage_cost != null
          ? {
              input: (r.usage_input as number | null) ?? undefined,
              output: (r.usage_output as number | null) ?? undefined,
              cost: (r.usage_cost as number | null) ?? undefined,
            }
          : undefined,
      sources: r.sources ? (JSON.parse(r.sources) as WebSource[]) : undefined,
    };
  }

  /** Supprime un message ; renvoie ses pièces jointes (nettoyage disque). */
  deleteMessage(conversationId: string, messageId: string): ChatMessage | null {
    const msg = this.getMessage(conversationId, messageId);
    if (!msg) return null;
    this.db
      .query("DELETE FROM messages WHERE conversation_id = ? AND id = ?")
      .run(conversationId, messageId);
    // F-14 : si la version supprimée était celle affichée et que le groupe
    // compte encore des versions, promouvoir la plus récente — le message
    // ne disparaît pas du fil tant que des versions existent.
    if (msg.versions?.group) {
      const g = msg.versions.group;
      const remaining = this.db
        .query(
          "SELECT id FROM messages WHERE conversation_id = ? AND version_group = ? ORDER BY version_index DESC LIMIT 1"
        )
        .get(conversationId, g) as any;
      if (remaining) {
        this.db
          .query(
            "UPDATE messages SET version_active = 1 WHERE conversation_id = ? AND id = ?"
          )
          .run(conversationId, remaining.id);
      }
    }
    this.touchConversation(conversationId);
    return msg;
  }

  /**
   * Supprime les messages assistant en fin de fil (pour régénérer).
   * Renvoie le dernier message utilisateur et les ids supprimés.
   */
  deleteTrailingAssistant(
    conversationId: string,
    variant?: "a" | "b"
  ): {
    lastUser: ChatMessage | null;
    removedIds: string[];
    removedAttachments: Attachment[];
  } {
    const msgs = this.getMessages(conversationId);
    const removedIds: string[] = [];
    const removedAttachments: Attachment[] = [];
    // F-17 : variante donnée → on ne retire que les réponses de CETTE
    // variante (régénération d'un seul côté de la comparaison).
    const matches = (m: ChatMessage) =>
      m.role === "assistant" && (variant === undefined || m.variant === variant);
    while (msgs.length > 0 && matches(msgs[msgs.length - 1])) {
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
        stopped: m.stopped,
        variant: m.variant,
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

  // ── Fournisseurs & clés (Paramètres v2.2) ────────────────────────

  listProviderRows(): ProviderRow[] {
    return this.db
      .query("SELECT * FROM providers ORDER BY position ASC, created_at ASC")
      .all() as ProviderRow[];
  }

  getProviderRow(id: string): ProviderRow | null {
    return (this.db.query("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow) ?? null;
  }

  createProvider(p: {
    name: string;
    kind: string;
    baseUrl?: string | null;
  }): ProviderRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const r = this.db.query("SELECT MAX(position) AS p FROM providers").get() as any;
    const position = (r?.p ?? -1) + 1;
    this.db
      .query(
        "INSERT INTO providers (id, name, kind, base_url, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, p.name.slice(0, 60), p.kind, p.baseUrl ?? null, position, now, now);
    return this.getProviderRow(id)!;
  }

  deleteProvider(id: string): void {
    this.db.query("DELETE FROM provider_keys WHERE provider_id = ?").run(id);
    this.db.query("DELETE FROM providers WHERE id = ?").run(id);
  }

  setProviderStrategy(id: string, strategy: string): ProviderRow | null {
    if (!this.getProviderRow(id)) return null;
    this.db
      .query("UPDATE providers SET strategy = ?, updated_at = ? WHERE id = ?")
      .run(strategy, new Date().toISOString(), id);
    return this.getProviderRow(id);
  }

  /** Adresse (endpoint) explicite du fournisseur, v2.5 — null = adresse
   *  canonique du catalogue. Utilisée par le champ éditable et par la
   *  bascule automatique de surface z.ai (providers:test-key). */
  setProviderBaseUrl(id: string, baseUrl: string | null): ProviderRow | null {
    if (!this.getProviderRow(id)) return null;
    this.db
      .query("UPDATE providers SET base_url = ?, updated_at = ? WHERE id = ?")
      .run(baseUrl, new Date().toISOString(), id);
    return this.getProviderRow(id);
  }

  listKeyRows(providerId: string): KeyRow[] {
    return this.db
      .query("SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY position ASC, created_at ASC")
      .all(providerId) as KeyRow[];
  }

  getKeyRow(id: string): KeyRow | null {
    return (this.db.query("SELECT * FROM provider_keys WHERE id = ?").get(id) as KeyRow) ?? null;
  }

  createProviderKey(providerId: string, label: string, secret: string, masked: string): KeyRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const r = this.db
      .query("SELECT MAX(position) AS p FROM provider_keys WHERE provider_id = ?")
      .get(providerId) as any;
    const position = (r?.p ?? -1) + 1;
    this.db
      .query(
        `INSERT INTO provider_keys (id, provider_id, label, secret, masked, status, position, created_at)
         VALUES (?, ?, ?, ?, ?, 'untested', ?, ?)`
      )
      .run(id, providerId, label.slice(0, 40), secret, masked, position, now);
    return this.getKeyRow(id)!;
  }

  deleteProviderKey(id: string): void {
    this.db.query("DELETE FROM provider_keys WHERE id = ?").run(id);
  }

  setKeyStatus(
    id: string,
    status: string,
    statusLabel: string | null
  ): KeyRow | null {
    this.db
      .query("UPDATE provider_keys SET status = ?, status_label = ?, last_tested_at = ? WHERE id = ?")
      .run(status, statusLabel, new Date().toISOString(), id);
    return this.getKeyRow(id);
  }

  /** Incrémente le compteur d'usage (stratégie « la moins utilisée »). */
  markKeyUsed(id: string): void {
    this.db
      .query("UPDATE provider_keys SET used_count = used_count + 1 WHERE id = ?")
      .run(id);
  }

  // ── Extensions : dépôts importés + serveurs MCP ──────────────────

  listExtensionRows(): ExtensionRow[] {
    return this.db
      .query("SELECT * FROM extensions ORDER BY created_at ASC")
      .all() as ExtensionRow[];
  }

  getExtensionRow(id: string): ExtensionRow | null {
    return (this.db.query("SELECT * FROM extensions WHERE id = ?").get(id) as ExtensionRow) ?? null;
  }

  createExtension(e: {
    name: string;
    kind: string;
    description?: string | null;
    source?: string | null;
    channel?: string | null;
    commit?: string | null;
    version?: string | null;
  }): ExtensionRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO extensions (id, name, kind, description, source, channel, "commit", version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        e.name.slice(0, 80),
        e.kind,
        e.description ?? null,
        e.source ?? null,
        e.channel ?? null,
        e.commit ?? null,
        e.version ?? null,
        now,
        now
      );
    return this.getExtensionRow(id)!;
  }

  updateExtensionRow(
    id: string,
    patch: Partial<{
      name: string;
      description: string | null;
      channel: string | null;
      commit: string | null;
      version: string | null;
      pinned: boolean;
      enabled: boolean;
      applied: boolean;
      update_available: string | null;
      last_checked_at: string | null;
    }>
  ): ExtensionRow | null {
    if (!this.getExtensionRow(id)) return null;
    // Audit passe 3, F-11 : allowlist défensive — les noms de colonnes du
    // SET sont bâtis depuis les clés du patch, on n'accepte que les champs
    // connus du schéma (les valeurs restent 100 % paramétrées).
    const ALLOWED = new Set([
      "name", "kind", "description", "source", "channel", "commit", "version",
      "pinned", "enabled", "applied", "update_available", "last_checked_at",
      "updated_at",
    ]);
    const cols: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && ALLOWED.has(k)) cols[k] = v;
    }
    const sets = Object.keys(cols)
      .map((k) => `"${k}" = ?`)
      .join(", ");
    this.db
      .query(`UPDATE extensions SET ${sets} WHERE id = ?`)
      .run(...Object.values(cols), id);
    return this.getExtensionRow(id);
  }

  deleteExtension(id: string): void {
    this.db.query("DELETE FROM extensions WHERE id = ?").run(id);
  }

  /** Extensions dont l'état diffère de celui chargé (footer « N en attente »). */
  countPendingExtensions(): number {
    const r = this.db
      .query("SELECT COUNT(*) AS n FROM extensions WHERE enabled <> applied")
      .get() as any;
    return r?.n ?? 0;
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

  // ── Checkpoint WAL (dette revue 2026-11-13) ─────────────────────────

  /** Démarre le checkpointeur périodique : PRAGMA wal_checkpoint(TRUNCATE)
   *  toutes les CHECKPOINT_INTERVAL_MS en zone calme (aucune requête en
   *  vol n'est bloquée — SQLite sert les lecteurs depuis le WAL). */
  startWalCheckpoint(): void {
    if (this.walTimer) return;
    this.walTimer = setInterval(() => this.walCheckpointNow(), CHECKPOINT_INTERVAL_MS);
    // Le timer ne doit pas garder le processus vivant seul
    if (typeof this.walTimer.unref === "function") this.walTimer.unref();
  }

  /** Checkpoint immédiat (appelé aussi à l'arrêt) : TRUNCATE ramène le
   *  -wal à zéro octet et intègre les pages dans la base principale. */
  walCheckpointNow(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      /* un lecteur actif peut différer le checkpoint — réessayé au tick suivant */
    }
  }

  /** Fermeture propre : checkpoint final + fermeture de la connexion. */
  close(): void {
    this.walCheckpointNow();
    if (this.walTimer) {
      clearInterval(this.walTimer);
      this.walTimer = null;
    }
    try {
      this.db.close();
    } catch {
      /* déjà fermée */
    }
  }
}

/** Intervalle du checkpoint périodique (5 min en zone calme par défaut,
 *  tunable par HERMES_WAL_CHECKPOINT_MS pour les tests). */
const CHECKPOINT_INTERVAL_MS = Number(process.env.HERMES_WAL_CHECKPOINT_MS ?? 300_000);
