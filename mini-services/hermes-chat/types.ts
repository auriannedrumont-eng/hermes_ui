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

/** Réglages d'un tour au moment de l'envoi (persistés sur le message).
 *  Audit 25/11 : permissionsMode est ENREGISTRÉ mais lu par aucun moteur —
 *  l'exécution réelle est pilotée par la configuration de l'agent (le
 *  contrat gateway n'a pas de réglage de permissions, session.mutate
 *  amont non plus) ; l'écran le dit (composer, bouclier). */
export interface TurnSettings {
  /** Échelle d'effort du fournisseur (off, low, medium, high, max, standard, élevé…). */
  reasoningEffort?: string;
  /** ask : confirmation avant chaque action · auto : tout exécuter.
   *  Préférence enregistrée (affichée, persistée) — ne change PAS la
   *  politique d'exécution réelle (voir en-tête). */
  permissionsMode?: "ask" | "auto";
  // ── Mémoire utilisateur (F-18) ─────────────────────────────────────
  // Les NOTES de mémoire voyagent dans systemPrompt des deux moteurs
  // (composeLocalSystemPrompt / gatewayContextSection) — pas ici : le champ
  // memoryNotes de ce littéral n'était lu par aucun connecteur (constat
  // 25/11). L'apprentissage mémoire (hermes.memory.autoLearn) est piloté
  // par la configuration de l'AGENT — aucun champ du contrat ne le porte
  // (champ memoryAutoLearn retiré : lu par personne, audit 25/11).
  // ── Mode expert (F-22) — température, plafond de sortie, graine ────
  // Transmis aux modèles connectés PAR CLÉ (pool local, llm-streams) ; le
  // contrat fermé prompt.submit n'en porte aucun (l'écran le dit).
  /** Température du tour (0–1 : le fournisseur refuse au-delà, erreur 1210). */
  temperature?: number;
  /** Plafond de jetons de la réponse (16–8192). */
  maxTokens?: number;
  /** Graine de reproductibilité (entier 32 bits). */
  seed?: number;
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
