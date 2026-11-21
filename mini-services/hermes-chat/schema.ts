// Schéma SQLite : créations de tables, index, PRAGMA et migrations douces
// (ALTER TABLE additives) — extraits du constructeur de Store (découpage
// 2026-11, cf. FORK.md). La signature est une fonction pure qui reçoit la
// connexion : le constructeur de Store reste l'unique point d'entrée.
import type { Database } from "bun:sqlite";

/** Applique PRAGMA + tables + migrations douces à la connexion donnée.
 *  Ordre immuable : PRAGMA → conversations/messages → artefacts → projets →
 *  réglages → fournisseurs/clés → extensions → prompts système → partages. */
export function applySchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  // D-03 : un accès concurrent très bref (script de test, second process)
  // levait immédiatement SQLITE_BUSY ; 5 s d'attente active résorbent
  // les collisions courtes au lieu de faire échouer l'opération.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA wal_autocheckpoint = 0;"); // checkpoint géré par Store, en zone calme
  db.exec(`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
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
  softAlter(db, "messages", "attachments TEXT");
  // Migration douce : marqueur des réponses interrompues (bouton Stop)
  softAlter(db, "messages", "stopped INTEGER");
  // Migration douce : variante de comparaison (F-17) — "a" | "b" | null
  softAlter(db, "messages", "variant TEXT");
  // Migration douce (F-14) : versions de réponse — régénérer conserve
  // l'ancienne version (groupe + index ; active = celle affichée/envoyée).
  softAlter(db, "messages", "version_group TEXT");
  softAlter(db, "messages", "version_index INTEGER");
  softAlter(db, "messages", "version_active INTEGER");
  // Migration douce (F-21) : usage par message — jetons réellement facturés
  // (input/output) et coût facturé par le fournisseur quand il le renvoie.
  softAlter(db, "messages", "usage_input INTEGER");
  softAlter(db, "messages", "usage_output INTEGER");
  softAlter(db, "messages", "usage_cost REAL");
  // Migration douce (F-12) : sources citées par un tour avec recherche web.
  softAlter(db, "messages", "sources TEXT");
  // Migration douce : colonne des conversations épinglées
  softAlter(
    db,
    "conversations",
    "pinned INTEGER NOT NULL DEFAULT 0"
  );
  // Migration douce (F-30) : mode du compositeur — chat | plan | code |
  // compare | debate | council | auto (valeur inconnue retombe sur chat).
  softAlter(db, "conversations", "mode TEXT");
  // Migration douce (F-30) : tours du débat (3–10), null = défaut du client.
  softAlter(db, "conversations", "mode_rounds INTEGER");
  // Migration douce (F-30) : config du mode par conversation (JSON —
  // voix → modèles, membres du conseil, reprises de l'auto, débat préalable).
  softAlter(db, "conversations", "mode_config TEXT");
  // Migration douce (F-30) : étiquette du mode sur la réponse finale
  // (« Verdict · Débat — 3 tours ») et déroulé du tour multi-voix (JSON).
  softAlter(db, "messages", "mode_tag TEXT");
  softAlter(db, "messages", "mode_flow TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)"
  );
  // D-03 : plus d'index B-tree sur le texte INTÉGRAL des messages —
  // searchMessages() fait un LIKE '%…%' (joker en tête) pour lequel un
  // tel index est inutilisable : il doublait la base sur disque et
  // ralentissait chaque INSERT sans aucun gain de lecture. (La FTS5
  // viendrait le jour où la recherche plein-texte devient un besoin réel.)
  // On supprime l'index hérité des bases existantes.
  db.exec("DROP INDEX IF EXISTS idx_messages_content");
  // ── Artefacts : fichiers générés par l'agent, versionnés par clé ─────
  db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
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
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_conv_key_version ON artifacts(conversation_id, key, version)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id, created_at)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id)"
  );
  // ── Versionnage fichiers (F-26) : couche humaine du journal ────────
  // La table artifacts est déjà un journal immuable (une ligne par
  // version) ; on y ajoute l'étiquette, l'épinglage et le marqueur de
  // restauration. Migration douce (R2 : additives uniquement).
  softAlter(db, "artifacts", "label TEXT");
  softAlter(db, "artifacts", "pinned INTEGER NOT NULL DEFAULT 0");
  softAlter(db, "artifacts", "restored_from INTEGER");
  // ── Projets : rangement des conversations par projet (fork) ──────
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  // Migration douce : colonne de rangement des conversations
  softAlter(db, "conversations", "project_id TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id)"
  );
  // ── Réglages serveur (persistés, cf. FORK.md §6) ─────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  // ── Fournisseurs & clés (Paramètres v2.2) ────────────────────────
  // Les secrets restent côté service : seules les vues masquées
  // partent vers le navigateur (providers.ts / toKeyView).
  db.exec(`CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT,
      strategy TEXT NOT NULL DEFAULT 'fill_first',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS provider_keys (
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
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider_id, position)"
  );
  // ── Extensions : dépôts importés + serveurs MCP (Paramètres v2.2) ─
  // `applied` suit l'état réellement chargé : un toggle change `enabled`,
  // le redémarrage du service (re)charge l'état courant → applied = enabled.
  db.exec(`CREATE TABLE IF NOT EXISTS extensions (
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
  db.exec(`CREATE TABLE IF NOT EXISTS system_prompts (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      conversation_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_system_prompts_conversation ON system_prompts(scope, conversation_id) WHERE scope = 'conversation'"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_system_prompts_preset ON system_prompts(updated_at DESC) WHERE scope = 'preset'"
  );
  // ── Partage public lecture seule (F-13) — snapshot figé ───────────
  db.exec(`CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_shares_conversation ON shares(conversation_id, created_at DESC)"
  );
  // Au démarrage, l'état courant devient l'état appliqué (les toggles
  // effectués sous l'ancien process ont été pris en compte au relancement).
  db.exec("UPDATE extensions SET applied = enabled WHERE applied <> enabled");
}

/** ALTER TABLE … ADD COLUMN tolérant : silencieux si la colonne existe. */
function softAlter(db: Database, table: string, column: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
  } catch (err) {
    // (audit 2026-11-21) Seule l'erreur « colonne déjà présente » est
    // tolérée : avaler TOUT (ex. SQLITE_BUSY résiduel) sautait silencieusement
    // une migration, et les requêtes ultérieures échouaient en
    // « no such column » sans explication.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|duplicate column/i.test(msg)) throw err;
  }
}
