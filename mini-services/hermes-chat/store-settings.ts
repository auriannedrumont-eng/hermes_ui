// Store — domaine settings — extrait de store.ts (découpage 2026-11, FORK.md §10).
// Interface fusionnée dans Store (declaration merging) + implémentation
// posée au prototype par store.ts : l'API publique est inchangée.
import type { Store } from "./store";
import type { ShareRow } from "./shares";
import type { ExtensionRow, KeyRow, ProviderRow } from "./store";
import type { WebSource } from "./web-search";
import type { SystemPromptRow } from "./prompts";

export interface StoreSettingsMethods {
  getConversationPrompt(conversationId: string): SystemPromptRow | null;
  setConversationPrompt(
    conversationId: string,
    content: string,
    presetTitle?: string | null
  ): SystemPromptRow;
  clearConversationPrompt(conversationId: string): boolean;
  listPromptPresets(): SystemPromptRow[];
  createPromptPreset(title: string, content: string): SystemPromptRow;
  updatePromptPreset(id: string, title: string, content: string): SystemPromptRow | null;
  deletePromptPreset(id: string): boolean;
  seedPromptPresetsIfNeeded(seeds: { title: string; content: string }[]): void;
  getActiveShareByConversation(conversationId: string): ShareRow | null;
  getShareByToken(token: string): ShareRow | null;
  createShare(
    conversationId: string,
    title: string,
    snapshot: string,
    messageCount: number,
    token: string
  ): ShareRow;
  revokeShareByConversation(conversationId: string): boolean;
  revokeSharesOfConversation(conversationId: string): void;
  purgeAgedRevokedShares(olderThanDays?): number;
  getSetting(key: string): string | null;
  getSettingBool(key: string, fallback: boolean): boolean;
  setSettingBool(key: string, value: boolean): void;
  setSetting(key: string, value: string): void;
  listSettings(): { key: string; value: string; updatedAt: string }[];
  listProviderRows(): ProviderRow[];
  getProviderRow(id: string): ProviderRow | null;
  createProvider(p: {
    name: string;
    kind: string;
    baseUrl?: string | null;
  }): ProviderRow;
  listExtensionRows(): ExtensionRow[];
  getExtensionRow(id: string): ExtensionRow | null;
  createExtension(e: {
    name: string;
    kind: string;
    description?: string | null;
    source?: string | null;
    channel?: string | null;
    commit?: string | null;
    version?: string | null;
  }): ExtensionRow;
  deleteExtension(id: string): void;
  countPendingExtensions(): number;
  deleteProvider(id: string): void;
  setProviderStrategy(id: string, strategy: string): ProviderRow | null;
  setProviderBaseUrl(id: string, baseUrl: string | null): ProviderRow | null;
  listKeyRows(providerId: string): KeyRow[];
  getKeyRow(id: string): KeyRow | null;
  createProviderKey(providerId: string, label: string, secret: string, masked: string): KeyRow;
  deleteProviderKey(id: string): void;
  setKeyStatus(id: string, status: string, statusLabel: string | null): KeyRow | null;
  markKeyUsed(id: string): void;
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
  ): ExtensionRow | null;
}

export function buildSettings(): StoreSettingsMethods & ThisType<Store> {
  return {
    // ── Prompt système & presets (F-11 / F-19) ──────────────────────────────

    /** Prompt actif d'une conversation (null si aucun). */
    getConversationPrompt(conversationId: string): SystemPromptRow | null {
      const r = this.db
        .query(
          "SELECT id, scope, conversation_id, title, content, created_at, updated_at FROM system_prompts WHERE scope = 'conversation' AND conversation_id = ?"
        )
        .get(conversationId) as any;
      return r ? (r as SystemPromptRow) : null;
    },

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
    },

    /** Retire le prompt d'une conversation (les presets restent). */
    clearConversationPrompt(conversationId: string): boolean {
      const r = this.db
        .query("DELETE FROM system_prompts WHERE scope = 'conversation' AND conversation_id = ?")
        .run(conversationId);
      return r.changes > 0;
    },

    /** Liste des presets réutilisables (plus récents d'abord). */
    listPromptPresets(): SystemPromptRow[] {
      return (this.db
        .query(
          "SELECT id, scope, conversation_id, title, content, created_at, updated_at FROM system_prompts WHERE scope = 'preset' ORDER BY updated_at DESC"
        )
        .all() as any[]) as SystemPromptRow[];
    },

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
    },

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
    },

    /** Supprime un preset (sans toucher aux prompts actifs des conversations). */
    deletePromptPreset(id: string): boolean {
      const r = this.db
        .query("DELETE FROM system_prompts WHERE id = ? AND scope = 'preset'")
        .run(id);
      return r.changes > 0;
    },

    /** Seeds idempotents : crée les presets de départ si la table est vide. */
    seedPromptPresetsIfNeeded(seeds: { title: string; content: string }[]): void {
      const n = (
        this.db.query("SELECT COUNT(*) AS n FROM system_prompts WHERE scope = 'preset'").get() as any
      ).n;
      if (n > 0) return;
      for (const s of seeds) this.createPromptPreset(s.title, s.content);
    },
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
    },

    /** Ligne d'un partage par token (révoqué compris — l'HTTP décide du statut). */
    getShareByToken(token: string): ShareRow | null {
      const r = this.db
        .query(
          "SELECT id, token, conversation_id, title, snapshot, message_count, created_at, revoked_at FROM shares WHERE token = ?"
        )
        .get(token) as any;
      return r ? (r as ShareRow) : null;
    },

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
      // Transaction (Lot 2, audit L2-5) : révocation + création sont un seul
      // acte — un crash entre les deux laisserait un partage fantôme.
      this.db.transaction(() => {
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
      })();
      return this.getShareByToken(token)!;
    },

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
    },

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
    },

    /** Audit passe 3, F-10 : supprime les lignes révoquées de plus de
     *  `olderThanDays` jours — les métadonnées ne s'accumulent pas éternellement ;
     *  les révocations récentes restent pour la sémantique 410 vs 404. */
    purgeAgedRevokedShares(olderThanDays = 90): number {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
      const r = this.db
        .query("DELETE FROM shares WHERE revoked_at IS NOT NULL AND revoked_at < ?")
        .run(cutoff);
      return r.changes;
    },
    // ── Réglages serveur (cf. FORK.md §6) ──────────────────────────

    getSetting(key: string): string | null {
      const r = this.db
        .query("SELECT value FROM settings WHERE key = ?")
        .get(key) as { value: string } | null;
      return r?.value ?? null;
    },

    /** Réglage booléen : stocké "1"/"0" (lisible en base), absent = fallback. */
    getSettingBool(key: string, fallback: boolean): boolean {
      const raw = this.getSetting(key);
      if (raw === "1") return true;
      if (raw === "0") return false;
      return fallback;
    },

    setSettingBool(key: string, value: boolean): void {
      this.setSetting(key, value ? "1" : "0");
    },

    setSetting(key: string, value: string): void {
      const now = new Date().toISOString();
      this.db
        .query(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(key, value, now);
    },

    listSettings(): { key: string; value: string; updatedAt: string }[] {
      const rows = this.db
        .query("SELECT key, value, updated_at FROM settings ORDER BY key ASC")
        .all() as any[];
      return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
    },
    // ── Fournisseurs & clés (Paramètres v2.2) ────────────────────────

    listProviderRows(): ProviderRow[] {
      return this.db
        .query("SELECT * FROM providers ORDER BY position ASC, created_at ASC")
        .all() as ProviderRow[];
    },

    getProviderRow(id: string): ProviderRow | null {
      return (this.db.query("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow) ?? null;
    },

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
    },

    deleteProvider(id: string): void {
      this.db.query("DELETE FROM provider_keys WHERE provider_id = ?").run(id);
      this.db.query("DELETE FROM providers WHERE id = ?").run(id);
    },

    setProviderStrategy(id: string, strategy: string): ProviderRow | null {
      if (!this.getProviderRow(id)) return null;
      this.db
        .query("UPDATE providers SET strategy = ?, updated_at = ? WHERE id = ?")
        .run(strategy, new Date().toISOString(), id);
      return this.getProviderRow(id);
    },

    /** Adresse (endpoint) explicite du fournisseur, v2.5 — null = adresse
     *  canonique du catalogue. Utilisée par le champ éditable et par la
     *  bascule automatique de surface z.ai (providers:test-key). */
    setProviderBaseUrl(id: string, baseUrl: string | null): ProviderRow | null {
      if (!this.getProviderRow(id)) return null;
      this.db
        .query("UPDATE providers SET base_url = ?, updated_at = ? WHERE id = ?")
        .run(baseUrl, new Date().toISOString(), id);
      return this.getProviderRow(id);
    },

    listKeyRows(providerId: string): KeyRow[] {
      return this.db
        .query("SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY position ASC, created_at ASC")
        .all(providerId) as KeyRow[];
    },

    getKeyRow(id: string): KeyRow | null {
      return (this.db.query("SELECT * FROM provider_keys WHERE id = ?").get(id) as KeyRow) ?? null;
    },

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
    },

    deleteProviderKey(id: string): void {
      this.db.query("DELETE FROM provider_keys WHERE id = ?").run(id);
    },

    setKeyStatus(
      id: string,
      status: string,
      statusLabel: string | null
    ): KeyRow | null {
      this.db
        .query("UPDATE provider_keys SET status = ?, status_label = ?, last_tested_at = ? WHERE id = ?")
        .run(status, statusLabel, new Date().toISOString(), id);
      return this.getKeyRow(id);
    },

    /** Incrémente le compteur d'usage (stratégie « la moins utilisée »). */
    markKeyUsed(id: string): void {
      this.db
        .query("UPDATE provider_keys SET used_count = used_count + 1 WHERE id = ?")
        .run(id);
    },
    // ── Extensions : dépôts importés + serveurs MCP ──────────────────

    listExtensionRows(): ExtensionRow[] {
      return this.db
        .query("SELECT * FROM extensions ORDER BY created_at ASC")
        .all() as ExtensionRow[];
    },

    getExtensionRow(id: string): ExtensionRow | null {
      return (this.db.query("SELECT * FROM extensions WHERE id = ?").get(id) as ExtensionRow) ?? null;
    },

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
    },

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
        .run(...(Object.values(cols) as (string | number | bigint | boolean | null)[]), id);
      return this.getExtensionRow(id);
    },

    deleteExtension(id: string): void {
      this.db.query("DELETE FROM extensions WHERE id = ?").run(id);
    },

    /** Extensions dont l'état diffère de celui chargé (footer « N en attente »). */
    countPendingExtensions(): number {
      const r = this.db
        .query("SELECT COUNT(*) AS n FROM extensions WHERE enabled <> applied")
        .get() as any;
      return r?.n ?? 0;
    },

    /** Pièces jointes d'une conversation (pour le nettoyage disque). */
  };
}
