// Types du protocole de chat Hermes Web (miroir de mini-services/hermes-chat/types.ts)

export type Role = "user" | "assistant";

export interface ToolEvent {
  name: string;
  status: "running" | "done" | "error";
  detail?: string;
  at: string;
}

// ── Pièces jointes multimédia (le protocole Hermes les supporte) ──────
export type AttachmentKind = "image" | "audio" | "video" | "pdf" | "file";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number; // octets
  kind: AttachmentKind;
  /** Chemin servi par le mini-service : /uploads/<id>.<ext> */
  url: string;
  /** Transcription automatique (fichiers audio, via ASR). */
  transcript?: string;
}

// ── Sélection de modèle ───────────────────────────────────────────────
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  description?: string;
  badge?: string;
  /** Échelle d'effort portée par le modèle (repli générique off·low·medium·high·max). */
  efforts?: string[];
  /** Libellé de l'échelle (ex. « Nous Portal », « OpenAI »). */
  effortLabel?: string;
  /** Fenêtre de contexte en tokens (absente = 128k estimé). */
  contextWindow?: number;
}

/** Échelle d'effort générique quand le fournisseur n'en expose pas. */
export const GENERIC_EFFORTS = ["off", "low", "medium", "high", "max"];

export interface ModelsResult {
  models: ModelOption[];
  defaultModel: string | null;
  source: "gateway" | "catalogue";
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  reasoning?: string;
  toolEvents?: ToolEvent[];
  attachments?: Attachment[];
  model?: string;
  createdAt: string;
  /** Cartes d'artefacts ancrées sur ce message (dernière version de chaque clé). */
  artifacts?: Artifact[];
  /** Réponse interrompue par l'utilisateur (bouton Stop) — partiel conservé. */
  stopped?: boolean;
  // ── Feedback utilisateur (F-24) — local, jamais envoyé au modèle ──
  /** 👍/👎 posé sur une réponse assistant (absent = pas de feedback). */
  feedbackRating?: "up" | "down";
  /** Commentaire libre associé au feedback (max 2 000 caractères). */
  feedbackComment?: string;
  // ── Comparaison de modèles (F-17) — réponse de la variante a ou b ──
  /** Variante du tour de comparaison (absent = message hors comparaison). */
  variant?: "a" | "b";
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  /** Conversation épinglée en haut de la liste. */
  pinned?: boolean;
  /** Projet de rangement (null = « Sans projet »). */
  projectId?: string | null;
}

// ── Projets : rangement des conversations (fork) ────────────────────
export interface Project {
  id: string;
  name: string;
  /** Ordre d'affichage dans la sidebar (croissant). */
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** Résultat de recherche plein-texte dans les messages. */
export interface SearchHit {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: Role;
  excerpt: string;
  createdAt: string;
}

export type GatewayMode = "gateway" | "demo";

/** Mode d'autorisation de l'agent (reset sur « ask » à chaque session). */
export type PermissionsMode = "ask" | "auto";

// ── Mode expert (F-22) : température, plafond de sortie, graine ────────

/** Réglages expert d'un tour — champs facultatifs, assainis côté service
 *  (température [0,1] : le moteur démo rejette au-delà ; plafond [1,8192] ;
 *  graine entière 32 bits). Absents = valeurs par défaut du fournisseur. */
export interface ExpertSettings {
  temperature?: number;
  maxTokens?: number;
  seed?: number;
}

export interface ServerHello {
  app: string;
  version: string;
  mode: GatewayMode;
  model: string;
  gatewayUrl: string | null;
  /** Taille des instructions système (estimation honnête de la jauge). */
  systemPromptChars?: number | null;
}

/** État de compaction d'une conversation (résumé conservé en tête de session). */
export interface CompactInfo {
  /** Date de la compaction (ISO). */
  at: string;
  /** Dernier message couvert par le résumé (les suivants partent en clair). */
  untilMessageId: string;
  /** Taille du résumé en caractères (comptage de la jauge). */
  summaryChars: number;
  /** Nombre de messages résumés. */
  summarizedCount: number;
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

// ── Artefacts : fichiers générés par l'agent, objets de première classe ──

export type ArtifactKind =
  | "html"
  | "code"
  | "markdown"
  | "csv"
  | "json"
  | "svg"
  | "image"
  | "pdf";

export type ArtifactStatus = "generating" | "ready" | "rendering" | "error";

export interface Artifact {
  /** Identifiant de CETTE version (une ligne = une version). */
  id: string;
  /** Identité stable dans la conversation : nom de fichier normalisé. */
  key: string;
  conversationId: string;
  /** Message qui a produit cette version. */
  messageId: string;
  /** Message où la carte est ancrée (première version du fichier). */
  anchorMessageId: string;
  version: number;
  kind: ArtifactKind;
  name: string;
  language?: string;
  mime: string;
  size: number;
  status: ArtifactStatus;
  statusLabel?: string;
  error?: string;
  preview?: string;
  url: string;
  rawUrl: string;
  thumbnailUrl?: string;
  pdfUrl?: string;
  pdfSize?: number;
  renderedBy?: string;
  createdAt: string;
}

export function artifactKindLabel(kind: ArtifactKind): string {
  switch (kind) {
    case "html":
      return "Page HTML";
    case "code":
      return "Code";
    case "markdown":
      return "Markdown";
    case "csv":
      return "CSV";
    case "json":
      return "JSON";
    case "svg":
      return "SVG";
    case "image":
      return "Image";
    case "pdf":
      return "PDF";
  }
}

export function formatArtifactBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

// ── Fournisseurs & clés + Extensions (Paramètres v2.2) ────────────────
// Miroir de mini-services/hermes-chat/types.ts — les secrets restent
// côté service : le client ne voit que les vues masquées.

export type ProviderKind = "llm" | "service";
export type ProviderStrategy = "fill_first" | "round_robin" | "least_used";
export type KeyStatus = "untested" | "ok" | "error" | "exhausted";

export interface ProviderKeyView {
  id: string;
  label: string;
  masked: string;
  status: KeyStatus;
  statusLabel?: string | null;
  lastTestedAt?: string | null;
}

export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKind;
  strategy: ProviderStrategy;
  baseUrl?: string | null;
  keyless?: boolean;
  keys: ProviderKeyView[];
}

export type ExtensionKind = "repo" | "mcp";

export interface ExtensionCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface ExtensionView {
  id: string;
  name: string;
  kind: ExtensionKind;
  description?: string | null;
  source?: string | null;
  channel?: string | null;
  commit?: string | null;
  version?: string | null;
  pinned: boolean;
  enabled: boolean;
  applied: boolean;
  updateAvailable?: string | null;
  lastCheckedAt?: string | null;
}

// ── Prompt système & instructions personnalisées (F-11 / F-19) ──────────
// Miroir de mini-services/hermes-chat/types.ts.

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
