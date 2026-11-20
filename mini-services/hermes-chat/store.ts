// Persistance SQLite (bun:sqlite) : conversations + messages + artefacts
// Le chemin est surchargeable par HERMES_CHAT_DB (tests d'intégration —
// sinon la base de dev du service).
// Découpage 2026-11 (FORK.md §10) : schéma dans schema.ts ; méthodes par
// domaine dans store-messages.ts / store-artifacts.ts / store-settings.ts —
// interface fusionnée (declaration merging) + implémentation posée au
// prototype ci-dessous. L'API publique (Store, types de lignes) est
// inchangée — les tests importent Store depuis ./store.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { applySchema } from "./schema";
import { buildSettings, type StoreSettingsMethods } from "./store-settings";
import { buildArtifacts, type StoreArtifactsMethods } from "./store-artifacts";
import { buildMessages, type StoreMessagesMethods } from "./store-messages";
import { buildStorage, type StoreStorageMethods } from "./store-storage";
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
import { resolveMode } from "./modes";
import type { ConversationMode, ModeConfig } from "./modes";
import { normalizeWebchatModelId } from "./webchat/fiches";
import type { ModeFlowRow } from "./types";

const DB_PATH =
  process.env.HERMES_CHAT_DB ??
  join(import.meta.dir, "..", "..", "db", "hermes-chat.sqlite");

/** JSON.parse protégé pour les colonnes persistées (audit L2-6) : une ligne
 *  malformée ne doit jamais rendre une conversation impossible à ouvrir — la
 *  valeur par défaut du champ est rendue à la place. */
export function parseJsonWire<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** mode_config stocké en JSON — charge invalide = null (jamais de plantage).
 *  Les ids webchat du format historique (webchat:<site>:<mode>) sont ramenés
 *  au format fusionné (webchat:<site>) À LA LECTURE — les conversations déjà
 *  en base continuent de pointer vers le bon site, sans migration. */
export function parseModeConfigWire(raw: string): ModeConfig | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const cfg = parsed as ModeConfig;
    if (cfg.voices) {
      for (const map of Object.values(cfg.voices)) {
        if (!map || typeof map !== "object") continue;
        for (const [voiceId, id] of Object.entries(map)) {
          if (id) map[voiceId] = normalizeWebchatModelId(id);
        }
      }
    }
    if (cfg.model) {
      for (const [modeKey, id] of Object.entries(cfg.model)) {
        if (id) cfg.model[modeKey] = normalizeWebchatModelId(id);
      }
    }
    return cfg;
  } catch {
    return null;
  }
}

/** mode_flow stocké en JSON — charge invalide = absent. */
export function parseModeFlowWire(raw: string): ModeFlowRow[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length ? (parsed as ModeFlowRow[]) : undefined;
  } catch {
    return undefined;
  }
}

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

export function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging --
   usage délibéré : les méthodes par domaine (store-*.ts) gagnent leurs
   signatures sur Store via le merging, l'implémentation est posée au
   prototype par Object.assign en pied de fichier — API publique intouchée. */
/** Fusion des domaines (découpage 2026-11) : les méthodes vivent dans
 *  store-messages.ts / store-artifacts.ts / store-settings.ts ; cette
 *  interface leur donne leurs signatures sur Store (declaration merging),
 *  l'implémentation est posée au prototype en pied de fichier. */
export interface Store
  extends StoreSettingsMethods,
    StoreArtifactsMethods,
    StoreMessagesMethods,
    StoreStorageMethods {}

export class Store {
  db: Database;
  /** Checkpointeur périodique du WAL (dette revue 2026-11-13 : sans lui,
   *  le -wal croît sans borne entre les redémarrages ; SQLite ne fait un
   *  checkpoint automatique qu'au franchissement du seuil ~1000 pages
   *  en pleine écriture, jamais sur un service majoritairement en lecture). */
  private walTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH, { create: true });
    // Schéma + PRAGMA + migrations douces : cf. schema.ts (découpage 2026-11).
    applySchema(this.db);
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

// Implémentation des domaines : posée au prototype (this.db reste valide —
// les méthodes sont des méthodes de Store, définies dans store-*.ts).
Object.assign(Store.prototype, buildSettings());
Object.assign(Store.prototype, buildArtifacts());
Object.assign(Store.prototype, buildMessages());
Object.assign(Store.prototype, buildStorage());

/** Intervalle du checkpoint périodique (5 min en zone calme par défaut,
 *  tunable par HERMES_WAL_CHECKPOINT_MS pour les tests). */
const CHECKPOINT_INTERVAL_MS = Number(process.env.HERMES_WAL_CHECKPOINT_MS ?? 300_000);
