// Types du protocole de chat Hermes Web — façade du référentiel partagé
// (découpage 2026-11, FORK.md §60 « déduplication ») : les formes du fil
// vivent dans mini-services/hermes-chat/shared/chat-protocol.ts (contraint
// par le tsconfig du service ET celui du front) ; ce fichier ne garde que
// les types PROPREMENT FRONT (état d'écran, vues Paramètres). Les imports
// existants (`from "@/lib/chat-types"`) restent valides : tout est
// ré-exporté.
//
// Divergences corrigées au passage (le service émettait sans déclarer) :
// ServerHello porte désormais gatewayTokenSet / engineProviders / memoryChars
// (réellement émis par helloPayload) ; ModelsResult.defaultModel est
// string | null (le fallback catalogue peut ne rien fixer).
import type { ConversationMode, ModeConfig } from "@/lib/modes";

export type { ConversationMode, ModeConfig };

// ── Ré-exports du protocole partagé (source unique front ↔ back) ────────
import type { ToolEvent } from "../../mini-services/hermes-chat/shared/chat-protocol";

export * from "../../mini-services/hermes-chat/shared/chat-protocol";
export { resolveMode, CONVERSATION_MODES } from "../../mini-services/hermes-chat/shared/chat-protocol";

// ── État d'écran (front uniquement) ────────────────────────────────────

/** Mode d'autorisation de l'agent (reset sur « ask » à chaque session). */
export type PermissionsMode = "ask" | "auto";

// ── Mode expert (F-22) : température, plafond de sortie, graine ────────

/** Réglages expert d'un tour — champs facultatifs, assainis côté service
 *  (température [0,1] : le fournisseur rejette au-delà ; plafond [1,8192] ;
 *  graine entière 32 bits). Absents = valeurs par défaut du fournisseur. */
export interface ExpertSettings {
  temperature?: number;
  maxTokens?: number;
  seed?: number;
}

// Message en cours de streaming côté assistant
export interface StreamingState {
  messageId: string;
  conversationId: string;
  /** Variante du tour de comparaison (F-17) — absent = tour simple. */
  variant?: "a" | "b";
  content: string;
  reasoning: string;
  status: string | null;
  toolEvents: ToolEvent[];
}

/** Activité outil d'un tour — encart terminal du panneau artefacts. */
export interface TurnTools {
  /** Événements du tour, dans l'ordre d'arrivée. */
  events: ToolEvent[];
  /** Tour encore vivant (stream en cours) : l'encart s'ouvre seul. */
  live: boolean;
}

// ── Prompt système & instructions personnalisées (F-11 / F-19) ──────────
// (vues consommées par le front : SystemPromptPreset, ConversationPrompt,
// SystemPromptChanged ; le service a ses View/Payload équivalents.)

/** Preset de prompt réutilisable (bibliothèque, section Hermes du volet). */
export interface SystemPromptPreset {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Prompt système d'une conversation (F-11) — le contenu part au modèle. */
export interface ConversationPrompt {
  conversationId: string;
  content: string;
  /** Titre indicatif du preset d'origine, s'il a été appliqué. */
  presetTitle?: string | null;
  updatedAt: string;
}

/** Charge du bus `system-prompt:changed` (broadcast). */
export interface SystemPromptChanged {
  conversationId: string;
  prompt: ConversationPrompt | null;
}

// ── Mémoire utilisateur (F-18) — consultable, éditable, effaçable ───────

/** État de la mémoire servie par `memory:get` / maintenue par le bus. */
export interface MemoryState {
  enabled: boolean;
  autoLearn: boolean;
  notes: string;
  maxChars: number;
}

// ── Partage public lecture seule (F-13) ────────────────────────────────
// Miroir de mini-services/hermes-chat/shares.ts (vues wire uniquement).

/** Lien de partage d'une conversation (vu par le propriétaire). */
export interface ShareView {
  id: string;
  token: string;
  conversationId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  revokedAt: string | null;
}

/** Données publiques servies au destinataire (aucun id interne). */
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
