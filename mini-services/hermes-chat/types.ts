// Types partagés du protocole de chat Hermes Web
// (dupliqués côté frontend dans src/lib/chat-types.ts)

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

export interface ModelsResult {
  models: ModelOption[];
  defaultModel: string;
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
  /** Message où la carte est ancrée (première version, ou plus ancienne existante). */
  anchorMessageId: string;
  version: number;
  kind: ArtifactKind;
  /** Nom de fichier affiché / téléchargé. */
  name: string;
  /** Langage pour kind=code (js, ts, python…). */
  language?: string;
  mime: string;
  /** Taille de la source en octets. */
  size: number;
  status: ArtifactStatus;
  /** Étape en cours, affichée sur la carte (« Rendu de l'aperçu (Chrome)… »). */
  statusLabel?: string;
  error?: string;
  /** Aperçu textuel court (3 lignes) pour les kinds sans vignette. */
  preview?: string;
  /** Téléchargement de la source (attachment). */
  url: string;
  /** Source brute (inline, pour le panneau). */
  rawUrl: string;
  /** Vignette PNG (rendu plein page pour le HTML). */
  thumbnailUrl?: string;
  /** Export PDF vectoriel (HTML rendu par Chrome). */
  pdfUrl?: string;
  pdfSize?: number;
  /** Moteur de rendu, pour le badge de confiance (« chrome-headless-shell »). */
  renderedBy?: string;
  createdAt: string;
}

/** Événement de streaming du source d'un artefact (dans la carte). */
export interface ArtifactDeltaPayload {
  conversationId: string;
  messageId: string;
  key: string;
  delta: string;
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

/** Réglages additifs envoyés dans api_turn_v1.settings (ignorés sans dommage). */
export interface TurnSettings {
  /** Échelle d'effort du fournisseur (off, low, medium, high, max, standard, élevé…). */
  reasoningEffort?: string;
  /** ask : confirmation avant chaque action · auto : tout exécuter. */
  permissionsMode?: "ask" | "auto";
}

/** État de compaction d'une conversation (résumé conservé en tête de session). */
export interface CompactInfo {
  at: string;
  untilMessageId: string;
  summaryChars: number;
  summarizedCount: number;
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

// ── Fournisseurs & clés (chantier « Paramètres v2.2 ») ─────────────────
// Sécurité : le secret d'une clé ne quitte JAMAIS le service — le client
// ne reçoit que la vue masquée (`masked`) et un identifiant stable.

export type ProviderKind = "llm" | "service";
/** Stratégie de choix de la prochaine clé (pools d'identifiants moteur). */
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
  /** Fournisseur local sans clé (Ollama) — la carte l'explique. */
  keyless?: boolean;
  keys: ProviderKeyView[];
}

// ── Extensions : dépôts importés + serveurs MCP ───────────────────────

export type ExtensionKind = "repo" | "mcp";

/** Commit GitHub tel qu'affiché dans « Dernières modifications ». */
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
  /** « owner/repo » pour un dépôt ; adresse ou commande pour un serveur. */
  source?: string | null;
  channel?: string | null;
  commit?: string | null;
  version?: string | null;
  pinned: boolean;
  enabled: boolean;
  /** État réellement chargé par le service (false = au prochain redémarrage). */
  applied: boolean;
  /** Version/commit détecté par « Vérifier » (null = à jour). */
  updateAvailable?: string | null;
  lastCheckedAt?: string | null;
}
