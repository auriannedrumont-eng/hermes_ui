// Store — domaine messages — extrait de store.ts (découpage 2026-11, FORK.md §10).
// Interface fusionnée dans Store (declaration merging) + implémentation
// posée au prototype par store.ts : l'API publique est inchangée.
import type { Store, ArtifactRow, ProjectRow } from "./store";
import { parseJsonWire, parseModeConfigWire, parseModeFlowWire, rowToProject } from "./store";
import { copyFileSync, existsSync } from "node:fs";
import { copyAttachmentForFork } from "./uploads";
import { resolveMode } from "./modes";
import type { ConversationMode, ModeConfig } from "./modes";
import { normalizeWebchatModelId } from "./webchat/fiches";
import type { ModeFlowRow, Artifact, ArtifactKind, Attachment, ChatMessage, ConversationMeta, Project, Role, SearchHit, ToolEvent } from "./types";
import type { WebSource } from "./web-search";

export interface StoreMessagesMethods {
  listProjects(): Project[];
  getProject(id: string): Project | null;
  /** F-59 : `parentId` validé par le handler (parent existant et racine) ;
   *  `diskPath` validé par le handler (dossier HOME existant, J5). */
  createProject(name: string, parentId?: string | null, diskPath?: string | null): Project;
  renameProject(id: string, name: string): Project | null;
  /** F-59 : sous-dossiers promus racine, conversations (en profondeur)
   *  retournées dans « Sans projet » — le tout en une transaction. */
  deleteProject(id: string): void;
  /** F-59 (J5) : lie (ou délie, path null) un projet à un dossier du disque. */
  setProjectDiskPath(id: string, diskPath: string | null): Project | null;
  /** F-60 : archive (ou désarchive) un dossier — propagé à ses sous-dossiers
   *  (le dossier range tout son contenu) ; rien n'est supprimé. */
  setProjectArchived(id: string, archived: boolean): Project | null;
  reorderProjects(ids: string[]): Project[];
  moveConversation(conversationId: string, projectId: string | null): ConversationMeta | null;
  listConversations(): ConversationMeta[];
  createConversation(
    title: string,
    projectId?: string | null,
    mode?: ConversationMode,
    modeRounds?: number | null,
    modeConfig?: ModeConfig | null,
  ): ConversationMeta;
  deleteConversation(id: string): void;
  renameConversation(id: string, title: string): ConversationMeta | null;
  getConversation(id: string): ConversationMeta | null;
  getConversationModeState(conversationId: string): {
    mode: ConversationMode;
    rounds: number | null;
    config: ModeConfig | null;
  };
  setConversationMode(
    id: string,
    mode: ConversationMode,
    rounds: number | null,
    config: ModeConfig | null,
  ): ConversationMeta | null;
  /** Chantier sessions natives (75) : identifiant de la session moteur
    * rattachée à la conversation (API REST /api/sessions du moteur). */
  getConversationMotorSession(id: string): string | null;
  setConversationMotorSession(id: string, motorSessionId: string): void;
  setPinned(id: string, pinned: boolean): ConversationMeta | null;
  touchConversation(id: string, title?: string): ConversationMeta | null;
  getMessages(conversationId: string): ChatMessage[];
  appendMessage(
    msg: Omit<ChatMessage, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
      /** F-14 : version de réponse (groupe partagé, index 1-based). */
      versionGroup?: string;
      versionIndex?: number;
      versionActive?: number;
    }
  ): ChatMessage;
  countVersions(group: string): number;
  supersedeTrailingAssistant(
    conversationId: string,
    variant?: "a" | "b"
  ): {
    lastUser: ChatMessage | null;
    supersededIds: string[];
    groups: { plain?: string; a?: string; b?: string };
  };
  setMessageVersion(
    conversationId: string,
    group: string,
    index: number
  ): ChatMessage[] | null;
  /** F-14 : réactive la version la plus récente d'un groupe si (et
   *  seulement si) aucune n'est active — tour régénéré stoppé ou échoué
   *  avant le premier jeton : l'ancienne réponse revient au lieu de
   *  disparaître définitivement du fil. */
  restoreLatestVersion(conversationId: string, group: string): void;
  getMessage(conversationId: string, messageId: string): ChatMessage | null;
  deleteMessage(conversationId: string, messageId: string): ChatMessage | null;
  purgeInactiveVersionsOf(
    conversationId: string,
    removedIds: string[],
  ): { purgedIds: string[]; purgedAttachments: Attachment[] };
  deleteTrailingAssistant(
    conversationId: string,
    variant?: "a" | "b"
  ): {
    lastUser: ChatMessage | null;
    removedIds: string[];
    removedAttachments: Attachment[];
  };
  editUserMessageAndTruncate(
    conversationId: string,
    messageId: string,
    content: string
  ): { message: ChatMessage; removedIds: string[]; removedAttachments: Attachment[] } | null;
  forkConversation(
    conversationId: string,
    fromMessageId?: string
  ): ConversationMeta | null;
  searchMessages(query: string, limit?: number): SearchHit[];
  conversationAttachments(conversationId: string): Attachment[];
}

export function buildMessages(): StoreMessagesMethods & ThisType<Store> {
  return {
    // ── Projets : rangement des conversations ─────────────────────────

    listProjects(): Project[] {
      const rows = this.db
        .query("SELECT * FROM projects ORDER BY position ASC, created_at ASC")
        .all() as ProjectRow[];
      return rows.map(rowToProject);
    },

    getProject(id: string): Project | null {
      const r = this.db
        .query("SELECT * FROM projects WHERE id = ?")
        .get(id) as ProjectRow | null;
      return r ? rowToProject(r) : null;
    },

    createProject(name: string, parentId?: string | null, diskPath?: string | null): Project {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const r = this.db
        .query("SELECT MAX(position) AS p FROM projects")
        .get() as any;
      const position = (r?.p ?? -1) + 1;
      // F-59 : garde défensive (le handler a déjà validé) — un parent doit
      // exister et être racine (un seul niveau d'imbrication) ; sinon la
      // création retombe sur un projet racine plutôt que d'insérer un
      // parent fantôme. diskPath est validé par le handler (HOME, J5).
      let parent: string | null = null;
      if (parentId) {
        const p = this.getProject(parentId);
        if (p && !p.parentId) parent = p.id;
      }
      this.db
        .query(
          "INSERT INTO projects (id, name, position, created_at, updated_at, parent_id, disk_path) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(id, name.trim().slice(0, 80), position, now, now, parent, diskPath ?? null);
      return this.getProject(id)!;
    },

    renameProject(id: string, name: string): Project | null {
      if (!this.getProject(id)) return null;
      this.db
        .query("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
        .run(name.trim().slice(0, 80), new Date().toISOString(), id);
      return this.getProject(id);
    },

    /** Supprime un projet : ses conversations — et celles de ses
     *  sous-dossiers (F-59) — retombent dans « Sans projet », et ses
     *  sous-dossiers sont promus au niveau racine (jamais de cascade de
     *  suppression). Pas de clé étrangère : tout se fait en code, dans une
     *  transaction (cas limite plan §6.3). */
    deleteProject(id: string): void {
      this.db.transaction(() => {
        this.db
          .query(
            "UPDATE conversations SET project_id = NULL WHERE project_id IN (SELECT id FROM projects WHERE id = ? OR parent_id = ?)"
          )
          .run(id, id);
        this.db
          .query("UPDATE projects SET parent_id = NULL WHERE parent_id = ?")
          .run(id);
        this.db.query("DELETE FROM projects WHERE id = ?").run(id);
      })();
    },

    /** F-59 (J5) : lie (ou délie, path null) un projet à un dossier du
     *  disque — champ informatif, le service ne lit jamais ce chemin. */
    setProjectDiskPath(id: string, diskPath: string | null): Project | null {
      if (!this.getProject(id)) return null;
      this.db
        .query("UPDATE projects SET disk_path = ?, updated_at = ? WHERE id = ?")
        .run(diskPath, new Date().toISOString(), id);
      return this.getProject(id);
    },

    /** F-60 : archive (ou désarchive) un dossier — la propagation au
     *  sous-arbre (id + ses sous-dossiers directs, un seul niveau) range
     *  tout le contenu en un geste, comme une suppression ; ici RIEN n'est
     *  supprimé : conversations et sous-dossiers restent en base. */
    setProjectArchived(id: string, archived: boolean): Project | null {
      if (!this.getProject(id)) return null;
      this.db
        .query(
          "UPDATE projects SET archived = ?, updated_at = ? WHERE id = ? OR parent_id = ?"
        )
        .run(archived ? 1 : 0, new Date().toISOString(), id, id);
      return this.getProject(id);
    },

    /** Réordonne les projets selon la liste d'ids fournie (positions 0..n-1). */
    reorderProjects(ids: string[]): Project[] {
      const known = new Set(this.listProjects().map((p) => p.id));
      // Transaction (Lot 2, audit L2-5) : un crash au milieu du réordonnancement
      // ne doit pas laisser deux projets avec la même position.
      this.db.transaction(() => {
        ids.forEach((pid, i) => {
          if (!known.has(pid)) return;
          this.db.query("UPDATE projects SET position = ? WHERE id = ?").run(i, pid);
        });
      })();
      return this.listProjects();
    },

    /** Déplace une conversation vers un projet (null = « Sans projet »). */
    moveConversation(conversationId: string, projectId: string | null): ConversationMeta | null {
      if (projectId && !this.getProject(projectId)) return null;
      const conv = this.getConversation(conversationId);
      if (!conv) return null;
      this.db
        .query("UPDATE conversations SET project_id = ? WHERE id = ?")
        .run(projectId, conversationId);
      return this.getConversation(conversationId);
    },
    listConversations(): ConversationMeta[] {
      const rows = this.db
        .query(
          `SELECT c.id, c.title, c.created_at, c.updated_at, c.pinned, c.project_id, c.mode, c.mode_rounds, c.mode_config,
                  COUNT(m.id) AS message_count,
                  (SELECT content FROM messages m2 WHERE m2.conversation_id = c.id AND m2.role = 'user' AND (m2.version_active IS NULL OR m2.version_active = 1) ORDER BY m2.created_at DESC LIMIT 1) AS preview
           FROM conversations c
           LEFT JOIN messages m ON m.conversation_id = c.id AND (m.version_active IS NULL OR m.version_active = 1)
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
        mode: (r.mode as ConversationMeta["mode"]) ?? "chat",
        modeRounds: r.mode_rounds ?? null,
        modeConfig: r.mode_config ? parseModeConfigWire(r.mode_config) : null,
      }));
    },

    createConversation(
      title: string,
      projectId?: string | null,
      mode?: ConversationMode,
      modeRounds?: number | null,
      modeConfig?: ModeConfig | null,
    ): ConversationMeta {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      // Le projet n'est appliqué que s'il existe réellement
      const project = projectId ? this.getProject(projectId) : null;
      this.db
        .query(
          "INSERT INTO conversations (id, title, created_at, updated_at, project_id, mode, mode_rounds, mode_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          id,
          title,
          now,
          now,
          project ? project.id : null,
          mode ?? null,
          modeRounds ?? null,
          modeConfig && Object.keys(modeConfig).length ? JSON.stringify(modeConfig) : null,
        );
      return {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        preview: "",
        projectId: project ? project.id : null,
        mode: mode ?? "chat",
        modeRounds: modeRounds ?? null,
        modeConfig: modeConfig ?? null,
      };
    },

    deleteConversation(id: string): void {
      // D-02 : tout ce qui vit POUR cette conversation part avec elle —
      // messages, artefacts, mais aussi prompt système de conversation
      // (system_prompts) et résumé de compaction (settings compact:<id>),
      // sinon les lignes orphelines s'accumulent en base.
      this.db.query("DELETE FROM messages WHERE conversation_id = ?").run(id);
      this.db.query("DELETE FROM artifacts WHERE conversation_id = ?").run(id);
      this.db
        .query("DELETE FROM system_prompts WHERE scope = 'conversation' AND conversation_id = ?")
        .run(id);
      this.db
        .query("DELETE FROM settings WHERE key = ?")
        .run(`compact:${id}`);
      this.db.query("DELETE FROM conversations WHERE id = ?").run(id);
    },

    renameConversation(id: string, title: string): ConversationMeta | null {
      const conv = this.getConversation(id);
      if (!conv) return null;
      this.db
        .query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
        .run(title, new Date().toISOString(), id);
      return { ...conv, title, updatedAt: new Date().toISOString() };
    },

    getConversation(id: string): ConversationMeta | null {
      const r = this.db
        .query(
          "SELECT id, title, created_at, updated_at, pinned, project_id, mode, mode_rounds, mode_config FROM conversations WHERE id = ?"
        )
        .get(id) as any;
      if (!r) return null;
      // F-14 : seules les versions ACTIVES comptent (l'ancien comptage
      // comptait les version_active = 0 : le badge de la sidebar gonflait
      // à chaque régénération).
      const count = (
        this.db
          .query(
            "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND (version_active IS NULL OR version_active = 1)"
          )
          .get(id) as any
      ).n;
      // F-14 : le VRAI aperçu du dernier message utilisateur (l'ancien
      // `preview: ""` écrasait l'aperçu de la sidebar au renommage, au
      // déplacement, au changement de mode et en fin de tour).
      const prevRow = this.db
        .query(
          "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND (version_active IS NULL OR version_active = 1) ORDER BY created_at DESC LIMIT 1"
        )
        .get(id) as { content?: string } | null;
      return {
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: count,
        preview: (prevRow?.content ?? "").slice(0, 90),
        pinned: !!(r as any).pinned,
        projectId: (r as any).project_id ?? null,
        mode: (r.mode as ConversationMeta["mode"]) ?? "chat",
        modeRounds: r.mode_rounds ?? null,
        modeConfig: r.mode_config ? parseModeConfigWire(r.mode_config) : null,
      };
    },
    // ── Modes du compositeur (F-30) — le service fait foi, relu à chaque envoi ──

    /** État du mode d'une conversation : mode résolu (inconnu → chat) + config. */
    getConversationModeState(conversationId: string): {
      mode: ConversationMode;
      rounds: number | null;
      config: ModeConfig | null;
    } {
      const r = this.db
        .query("SELECT mode, mode_rounds, mode_config FROM conversations WHERE id = ?")
        .get(conversationId) as any;
      return {
        mode: resolveMode(r?.mode ?? "chat"),
        rounds: typeof r?.mode_rounds === "number" ? r.mode_rounds : null,
        config: r?.mode_config ? parseModeConfigWire(r.mode_config) : null,
      };
    },

    /** Change le mode d'une conversation (valeurs bornées en amont par
      * normalizeModeConfig) et renvoie la conversation à jour. */
    setConversationMode(
      id: string,
      mode: ConversationMode,
      rounds: number | null,
      config: ModeConfig | null,
    ): ConversationMeta | null {
      const conv = this.getConversation(id);
      if (!conv) return null;
      this.db
        .query(
          "UPDATE conversations SET mode = ?, mode_rounds = ?, mode_config = ?, updated_at = ? WHERE id = ?"
        )
        .run(
          mode,
          rounds ?? null,
          config && Object.keys(config).length ? JSON.stringify(config) : null,
          new Date().toISOString(),
          id,
        );
      return this.getConversation(id);
    },

    /** Sessions natives (75) : lecture de la liaison conversation → session
      * moteur (null tant que la bascule REST n'a pas lié la conversation). */
    getConversationMotorSession(id: string): string | null {
      const r = this.db
        .query("SELECT motor_session_id FROM conversations WHERE id = ?")
        .get(id) as { motor_session_id: string | null } | null;
      return r?.motor_session_id ?? null;
    },

    /** Sessions natives (75) : écriture de la liaison. L'identifiant est
      * déterministe (`ui-<conversationId>`) : la ligne moteur est créée une
      * fois par conversation et jamais renommée. */
    setConversationMotorSession(id: string, motorSessionId: string): void {
      this.db
        .query("UPDATE conversations SET motor_session_id = ? WHERE id = ?")
        .run(motorSessionId, id);
    },

    /** Épingle / détache une conversation (remonte en haut de la liste). */
    setPinned(id: string, pinned: boolean): ConversationMeta | null {
      const conv = this.getConversation(id);
      if (!conv) return null;
      this.db
        .query("UPDATE conversations SET pinned = ? WHERE id = ?")
        .run(pinned ? 1 : 0, id);
      return { ...conv, pinned };
    },

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
    },
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
        toolEvents: parseJsonWire<ToolEvent[] | undefined>(r.tool_events, undefined),
        attachments: parseJsonWire<Attachment[] | undefined>(r.attachments, undefined),
        model: r.model ?? undefined,
        createdAt: r.created_at,
        stopped: r.stopped ? true : undefined,
        variant: (r.variant as "a" | "b" | null) ?? undefined,
        modeTag: r.mode_tag ?? undefined,
        modeFlow: r.mode_flow ? parseModeFlowWire(r.mode_flow) : undefined,
        usage:
          r.usage_input != null || r.usage_output != null || r.usage_cost != null
            ? {
                input: (r.usage_input as number | null) ?? undefined,
                output: (r.usage_output as number | null) ?? undefined,
                cost: (r.usage_cost as number | null) ?? undefined,
              }
            : undefined,
        sources: parseJsonWire<WebSource[] | undefined>(r.sources, undefined),
      }));
    },

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
          "INSERT INTO messages (id, conversation_id, role, content, reasoning, tool_events, attachments, model, created_at, stopped, variant, version_group, version_index, version_active, usage_input, usage_output, usage_cost, sources, mode_tag, mode_flow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
          msg.sources ? JSON.stringify(msg.sources) : null,
          (msg as { modeTag?: string }).modeTag ?? null,
          (msg as { modeFlow?: ModeFlowRow[] }).modeFlow?.length
            ? JSON.stringify((msg as { modeFlow?: ModeFlowRow[] }).modeFlow)
            : null
        );
      return { ...msg, id, createdAt } as ChatMessage;
    },

    /** F-14 — nombre de versions d'un groupe (1 si inconnu). */
    countVersions(group: string): number {
      const r = this.db
        .query("SELECT COUNT(*) AS n FROM messages WHERE version_group = ?")
        .get(group) as any;
      return r?.n ?? 0;
    },

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
        // Lot 3 (audit L3-4) : en régénération SANS variante (Comparer = les
        // deux côtés), la clé ne doit pas être « plain » pour tout — sinon
        // groups.a/groups.b restent indéfinis et les nouveaux tours partent
        // SANS versionGroup : le sélecteur ‹ 1/2 › n'apparaît jamais. La clé
        // suit la variante du message traversé (a/b), « plain » sans variante.
        const key = variant === undefined ? (m.variant ?? "plain") : m.variant;
        if (key === "a" || key === "b" || key === "plain") {
          if (!groups[key]) groups[key] = group;
        }
        i--;
      }
      const rest = msgs.slice(0, i + 1);
      const lastUser = [...rest].reverse().find((m) => m.role === "user") ?? null;
      return { lastUser, supersededIds, groups };
    },

    /** F-14 — affiche la version `index` du groupe (les autres passent inactives). */
    setMessageVersion(
      conversationId: string,
      group: string,
      index: number
    ): ChatMessage[] | null {
      const count = this.countVersions(group);
      if (count < 1 || index < 1 || index > count) return null;
      // F-14 : la ligne cible doit exister AVANT de tout désactiver — avec
      // des version_index désynchronisés, l'ancien code passait le groupe
      // entier à version_active = 0 sans jamais en réactiver une : le
      // message disparaissait du fil.
      const target = this.db
        .query(
          "SELECT id FROM messages WHERE conversation_id = ? AND version_group = ? AND version_index = ?"
        )
        .get(conversationId, group, index) as { id?: string } | null;
      if (!target?.id) return null;
      // Transaction (Lot 2, audit L2-5) : un crash entre les deux UPDATE
      // laisserait le groupe SANS version active.
      this.db.transaction(() => {
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
      })();
      return this.getMessages(conversationId);
    },

    /** F-14 — réactive la version la plus récente d'un groupe si aucune
     *  n'est active (tour régénéré stoppé/échoué avant le premier jeton :
     *  l'ancienne réponse revient au lieu de disparaître du fil). */
    restoreLatestVersion(conversationId: string, group: string): void {
      const active = this.db
        .query(
          "SELECT id FROM messages WHERE conversation_id = ? AND version_group = ? AND version_active = 1 LIMIT 1"
        )
        .get(conversationId, group);
      if (active) return;
      const latest = this.db
        .query(
          "SELECT id FROM messages WHERE conversation_id = ? AND version_group = ? ORDER BY version_index DESC, created_at DESC LIMIT 1"
        )
        .get(conversationId, group) as { id?: string } | null;
      if (latest?.id) {
        this.db
          .query(
            "UPDATE messages SET version_active = 1 WHERE conversation_id = ? AND id = ?"
          )
          .run(conversationId, latest.id);
      }
    },

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
        toolEvents: parseJsonWire<ToolEvent[] | undefined>(r.tool_events, undefined),
        attachments: parseJsonWire<Attachment[] | undefined>(r.attachments, undefined),
        model: r.model ?? undefined,
        createdAt: r.created_at,
        stopped: r.stopped ? true : undefined,
        variant: (r.variant as "a" | "b" | null) ?? undefined,
        modeTag: r.mode_tag ?? undefined,
        modeFlow: r.mode_flow ? parseModeFlowWire(r.mode_flow) : undefined,
        usage:
          r.usage_input != null || r.usage_output != null || r.usage_cost != null
            ? {
                input: (r.usage_input as number | null) ?? undefined,
                output: (r.usage_output as number | null) ?? undefined,
                cost: (r.usage_cost as number | null) ?? undefined,
              }
            : undefined,
        sources: parseJsonWire<WebSource[] | undefined>(r.sources, undefined),
      };
    },

    /** Supprime un message ; renvoie ses pièces jointes (nettoyage disque). */
    deleteMessage(conversationId: string, messageId: string): ChatMessage | null {
      const msg = this.getMessage(conversationId, messageId);
      if (!msg) return null;
      // F-14 : suppression, promotion et renumérotation forment UN acte
      // (transaction) — un crash au milieu ne doit laisser ni groupe sans
      // version active, ni version_index en dents de scie (affichage
      // « 3/2 », clic ‹ vers un index absent, collision à la régénération).
      this.db.transaction(() => {
        this.db
          .query("DELETE FROM messages WHERE conversation_id = ? AND id = ?")
          .run(conversationId, messageId);
        if (msg.versions?.group) {
          const g = msg.versions.group;
          // Si la version supprimée était celle affichée et que le groupe
          // compte encore des versions, promouvoir la plus récente — le
          // message ne disparaît pas du fil tant que des versions existent.
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
          // Renumérotation 1..k des lignes restantes du groupe : l'ancien
          // code laissait {2,3} après suppression de la 1 (compteur « 3/2 »,
          // flèche ‹ vers un index sans ligne, countVersions+1 en collision).
          const rest = this.db
            .query(
              "SELECT id FROM messages WHERE conversation_id = ? AND version_group = ? ORDER BY version_index ASC, created_at ASC, rowid ASC"
            )
            .all(conversationId, g) as any[];
          if (rest.length > 1) {
            rest.forEach((row, i) => {
              this.db
                .query(
                  "UPDATE messages SET version_index = ? WHERE conversation_id = ? AND id = ?"
                )
                .run(i + 1, conversationId, row.id);
            });
          } else if (rest.length === 1) {
            // Une seule version restante : le message redevient un message
            // normal à version unique (plus de sélecteur ‹ 1/1 › fantôme).
            this.db
              .query(
                "UPDATE messages SET version_group = NULL, version_index = NULL, version_active = NULL WHERE conversation_id = ? AND id = ?"
              )
              .run(conversationId, rest[0].id);
          }
        }
      })();
      this.touchConversation(conversationId);
      return msg;
    },

    /**
     * D-02 : purge des versions INACTIVES des groupes dont une version a été
     * supprimée par une troncature. getMessages() ne voit que la version
     * active : les version_active = 0 situées après le point de troncature
     * restaient en base pour toujours (avec leurs pièces jointes et leurs
     * artefacts) sans jamais être réaffichées. Renvoie ids et pièces jointes
     * purgés — l'appelant nettoie artefacts et fichiers joints (F-14 : ces
     * lignes avaient elles aussi des artefacts et des attachments, sinon
     * orphelins).
     */
    purgeInactiveVersionsOf(
      conversationId: string,
      removedIds: string[],
    ): { purgedIds: string[]; purgedAttachments: Attachment[] } {
      if (!removedIds.length) return { purgedIds: [], purgedAttachments: [] };
      const placeholders = removedIds.map(() => "?").join(",");
      const groups = this.db
        .query(
          `SELECT DISTINCT version_group AS g FROM messages
           WHERE conversation_id = ? AND id IN (${placeholders}) AND version_group IS NOT NULL`
        )
        .all(conversationId, ...removedIds) as any[];
      const purged: string[] = [];
      const purgedAttachments: Attachment[] = [];
      for (const { g } of groups) {
        const rows = this.db
          .query(
            "SELECT id, attachments FROM messages WHERE conversation_id = ? AND version_group = ? AND version_active = 0"
          )
          .all(conversationId, g) as any[];
        for (const r of rows) {
          purgedAttachments.push(
            ...(parseJsonWire<Attachment[] | undefined>(r.attachments, undefined) ?? [])
          );
          this.db
            .query("DELETE FROM messages WHERE conversation_id = ? AND id = ?")
            .run(conversationId, r.id);
          purged.push(r.id);
        }
      }
      return { purgedIds: purged, purgedAttachments };
    },

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
      // D-02 : les versions inactives des groupes touchés partent aussi —
      // plus jamais réaffichées, elles n'ont pas lieu de survivre à la
      // troncature (le régénérateur crée ses propres v(n+1)). F-14 : leurs
      // ids et pièces jointes rejoignent removedIds/removedAttachments pour
      // que l'appelant nettoie leurs artefacts et fichiers.
      const { purgedIds, purgedAttachments } = this.purgeInactiveVersionsOf(
        conversationId,
        removedIds,
      );
      removedIds.push(...purgedIds);
      removedAttachments.push(...purgedAttachments);
      const lastUser = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      if (removedIds.length) this.touchConversation(conversationId);
      return { lastUser, removedIds, removedAttachments };
    },

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
      // D-02 : purge des versions inactives des groupes touchés (même règle
      // que deleteTrailingAssistant — jamais de lignes fantômes conservées).
      // F-14 : ids et pièces jointes purgés rejoignent la réponse — leurs
      // artefacts et fichiers doivent être nettoyés eux aussi.
      const { purgedIds, purgedAttachments } = this.purgeInactiveVersionsOf(
        conversationId,
        removed.map((m) => m.id),
      );
      this.db
        .query("UPDATE messages SET content = ? WHERE conversation_id = ? AND id = ?")
        .run(content, conversationId, messageId);
      this.touchConversation(conversationId);
      return {
        message: { ...msg, content },
        removedIds: [...removed.map((m) => m.id), ...purgedIds],
        removedAttachments: [
          ...removed.flatMap((m) => m.attachments ?? []),
          ...purgedAttachments,
        ],
      };
    },

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
        src.projectId, // la branche reste dans le même projet
        src.mode, // F-30 : la branche hérite du mode de la conversation d'origine
        src.modeRounds ?? null,
        src.modeConfig ?? null,
      );
      // D-02 : le prompt système de la conversation (system_prompts,
      // scope 'conversation') accompagne la branche — sinon la fork tournait
      // sans ses instructions dédiées, silencieusement.
      {
        const originPrompt = this.db
          .query(
            "SELECT title, content FROM system_prompts WHERE scope = 'conversation' AND conversation_id = ?"
          )
          .get(conversationId) as any;
        if (originPrompt?.content) {
          this.db
            .query(
              `INSERT INTO system_prompts (id, scope, conversation_id, title, content, created_at, updated_at)
               VALUES (?, 'conversation', ?, ?, ?, ?, ?)`
            )
            .run(
              crypto.randomUUID(),
              forked.id,
              originPrompt.title ?? null,
              originPrompt.content,
              new Date().toISOString(),
              new Date().toISOString(),
            );
        }
      }
      // Transaction (Lot 2, audit L2-5) : la copie des messages ET le
      // re-ancrage des artefacts sont un seul acte — un crash au milieu laissait
      // un fork à moitié rempli (transaction imbriquée = savepoint chez
      // bun:sqlite, donc copyArtifactsToFork reste correct).
      this.db.transaction(() => {
        // Mapping ancien id -> nouvel id pour re-ancrer les artefacts du fork
        const messageIdMap = new Map<string, string>();
        for (const m of upto) {
          const copy = this.appendMessage({
            conversationId: forked.id,
            role: m.role,
            content: m.content,
            reasoning: m.reasoning,
            toolEvents: m.toolEvents,
            // Pièces jointes : COPIES physiques (nouvel id, nouveau fichier
            // sous db/uploads) — même convention que copyArtifactsToFork.
            // Avant : les mêmes URLs /uploads étaient référencées par les deux
            // branches et la première suppression (original ou fork) cassait
            // les images/audio de l'autre (fichier unlinké sous ses pieds).
            attachments: m.attachments?.map(copyAttachmentForFork),
            model: m.model,
            createdAt: m.createdAt,
            stopped: m.stopped,
            variant: m.variant,
            modeTag: m.modeTag,
            modeFlow: m.modeFlow,
          });
          messageIdMap.set(m.id, copy.id);
        }
        this.copyArtifactsToFork(conversationId, forked.id, messageIdMap);
      })();
      return this.getConversation(forked.id);
    },

    /** Recherche plein-texte dans le contenu des messages. */
    searchMessages(query: string, limit = 30): SearchHit[] {
      const q = query.trim();
      if (q.length < 2) return [];
      const pattern = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
      const rows = this.db
        .query(
          `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at,
                  c.title AS conversation_title
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.content LIKE ? ESCAPE '\\' AND (m.version_active IS NULL OR m.version_active = 1)
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
    },
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
  };
}
