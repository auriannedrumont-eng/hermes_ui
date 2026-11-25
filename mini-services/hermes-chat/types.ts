// Types du protocole de chat Hermes Web — façade du référentiel partagé
// (découpage 2026-11, FORK.md §60 « déduplication ») : les formes du fil
// vivent dans shared/chat-protocol.ts (contraint par ce tsconfig ET par
// celui du front) ; ce fichier ne garde que les types PROPRES au service
// (payloads internes, vues persistées). Les imports existants
// (`from "./types"`) restent valides : tout est ré-exporté.
import type { ConversationMode, ModeConfig } from "./modes";

export type { ConversationMode, ModeConfig };

// ── Ré-exports du protocole partagé (source unique front ↔ back) ────────
export * from "./shared/chat-protocol";

// ── Payloads et vues propres au service ────────────────────────────────

/** Événement de streaming du source d'un artefact (dans la carte). */
export interface ArtifactDeltaPayload {
  conversationId: string;
  messageId: string;
  key: string;
  delta: string;
}

/** Réglages d'un tour au moment de l'envoi (persistés sur le message). */
export interface TurnSettings {
  /** Échelle d'effort du fournisseur (off, low, medium, high, max, standard, élevé…). */
  reasoningEffort?: string;
  /** ask : confirmation avant chaque action · auto : tout exécuter. */
  permissionsMode?: "ask" | "auto";
  // ── Mémoire utilisateur (F-18) ─────────────────────────────────────
  // Les NOTES de mémoire voyagent dans systemPrompt des deux moteurs
  // (composeLocalSystemPrompt / gatewayContextSection) — pas ici : le champ
  // memoryNotes de ce littéral n'était lu par aucun connecteur (constat
  // 25/11). Seul l'apprentissage reste un réglage de tour.
  /** Apprentissage automatique demandé au moteur. */
  memoryAutoLearn?: boolean;
  // ── Mode expert (F-22) — température, plafond de sortie, graine ────
  /** Température du tour (0–1 : le fournisseur refuse au-delà, erreur 1210). */
  temperature?: number;
  /** Plafond de jetons de la réponse (16–8192). */
  maxTokens?: number;
  /** Graine de reproductibilité (entier 32 bits). */
  seed?: number;
  // ── Mode Plan (F-30) : mise en plan demandée au moteur au premier tour —
  // tenté une fois, refus non bloquant — la consigne écrite reste la garantie.
  planMode?: boolean;
}

// ── Prompt système & instructions personnalisées (F-11 / F-19) ──────────

/** Preset de prompt réutilisable (bibliothèque, section Hermes du volet). */
export interface SystemPromptPresetView {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Prompt système d'une conversation (F-11) — le contenu part au modèle. */
export interface ConversationPromptView {
  conversationId: string;
  content: string;
  /** Titre indicatif du preset d'origine, s'il a été appliqué. */
  presetTitle?: string | null;
  updatedAt: string;
}

/** Charge du bus `system-prompt:changed` (broadcast). */
export interface SystemPromptChangedPayload {
  conversationId: string;
  prompt: ConversationPromptView | null;
}
