// Partage public lecture seule d'une conversation (F-13) — FORK.md §5 R1 :
// chantier isolé dans ce module ; index.ts n'ajoute que les événements socket
// `share:*` et les routes HTTP du 3004.
//
// Modèle (R2, additif) : table `shares` — un snapshot FIGÉ de la conversation
// à la création (titre + messages sérialisés) : le lien reste stable même si
// la conversation continue, et la révocation ne touche jamais la source.
// Le token est opaque (24 caractères base62, non énumérable).
import type { ChatMessage, ConversationMeta } from "./types";

export interface ShareRow {
  id: string;
  token: string;
  conversation_id: string;
  title: string;
  /** Snapshot JSON figé : { messages: ChatMessage[] } */
  snapshot: string;
  message_count: number;
  created_at: string;
  revoked_at: string | null;
}

export interface ShareView {
  id: string;
  token: string;
  conversationId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  revokedAt: string | null;
}

/** Vue « lecture seule » servie au destinataire du lien (aucun id interne). */
export interface SharedConversationData {
  title: string;
  messageCount: number;
  sharedAt: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    model?: string;
    createdAt: string;
    attachments?: Array<{ name: string; kind: string }>;
  }>;
}

/** Longueur du token (base62 → ~143 bits d'entropie). */
const TOKEN_LENGTH = 24;
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Génère un token opaque non énumérable. */
export function generateShareToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

/** Rangée SQL → vue wire (jamais le snapshot brut côté listes). */
export function rowToShareView(r: ShareRow): ShareView {
  return {
    id: r.id,
    token: r.token,
    conversationId: r.conversation_id,
    title: r.title,
    messageCount: r.message_count,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

/** Construit le snapshot figé + la vue publique depuis les messages source. */
export function buildSnapshot(
  conversation: ConversationMeta,
  messages: ChatMessage[]
): { snapshot: string; data: Omit<SharedConversationData, "sharedAt"> } {
  const light = messages.map((m) => ({
    role: m.role,
    content: m.content,
    model: m.model,
    createdAt: m.createdAt,
    attachments: m.attachments?.map((a) => ({ name: a.name, kind: a.kind })),
  }));
  return {
    snapshot: JSON.stringify({ messages: light }),
    data: {
      title: conversation.title,
      messageCount: messages.length,
      messages: light,
    },
  };
}

/** Parse défensif du snapshot (null si corrompu). */
export function parseSnapshot(
  row: ShareRow
): SharedConversationData | null {
  try {
    const parsed = JSON.parse(row.snapshot);
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return {
      title: row.title,
      messageCount: row.message_count,
      sharedAt: row.created_at,
      messages: parsed.messages,
    };
  } catch {
    return null;
  }
}

/** Valide un format de token reçu par HTTP (rejet rapide, pas de fuite). */
export function isValidShareToken(token: string): boolean {
  return (
    typeof token === "string" &&
    token.length === TOKEN_LENGTH &&
    TOKEN_ALPHABET.includes(token[0]) &&
    /^[A-Za-z0-9]+$/.test(token)
  );
}
