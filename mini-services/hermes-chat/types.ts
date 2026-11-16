// Types partagés du protocole de chat Hermes Web
// (dupliqués côté frontend dans src/lib/chat-types.ts)

export type Role = "user" | "assistant";

export interface ToolEvent {
  name: string;
  status: "running" | "done" | "error";
  detail?: string;
  at: string;
}

// ── Sources citées par un tour avec recherche web (F-09/F-12) ──────────
export interface WebSource {
  /** Rang de citation, 1-based (le modèle cite sous la forme [n]). */
  n: number;
  title: string;
  url: string;
  snippet: string;
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
  source: "gateway" | "catalogue" | "providers";
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
  // ── Comparaison de modèles (F-17) — réponse de la variante a ou b ──
  /** Variante du tour de comparaison (absent = message hors comparaison). */
  variant?: "a" | "b";
  // ── Jetons & coût (F-21) — rempli quand l'API du fournisseur le renvoie ──
  /** Jetons consommés par le tour (réels si fournis par l'API). */
  usage?: { input?: number; output?: number; cost?: number };
  // ── Recherche web (F-12) — sources citées par ce tour ──
  /** Résultats injectés dans le contexte du tour, affichés cliquables. */
  sources?: WebSource[];
  // ── Versions de réponse (F-14) — régénérer conserve l'ancienne ──
  /** Présent uniquement si ce message a plusieurs versions (navigation ‹ n/m ›). */
  versions?: { group: string; index: number; count: number };
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
  // Versionnage fichiers (F-26) — couche humaine du journal
  /** Étiquette humaine (double-clic dans le journal des versions). */
  label?: string;
  /** Version épinglée : jamais purgée par le quota FIFO. */
  pinned?: boolean;
  /** Numéro de la version restaurée (marqueur ↩ dans le journal). */
  restoredFrom?: number;
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
  // ── Mémoire utilisateur (F-18) — transmis au moteur réel ───────────
  /** Notes de mémoire actives pour ce tour (undefined si mémoire coupée). */
  memoryNotes?: string;
  /** Apprentissage automatique demandé au moteur. */
  memoryAutoLearn?: boolean;
  // ── Mode expert (F-22) — température, plafond de sortie, graine ────
  /** Température du tour (0–1 : le moteur démo refuse au-delà, erreur 1210). */
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
}/** État de compaction d'une conversation (résumé conservé en tête de session). */
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
  /** Révision git du dépôt déployé (null = installation sans git). v2.4. */
  appRevision?: string | null;
  /** Binaire chrome-headless-shell présent ou absent (sonde réelle). v2.4. */
  chromeHeadless?: "present" | "absent";
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

/** Entrée du catalogue des fournisseurs connus (sélecteur d'ajout, v2.5).
 *  `name` est la valeur canonique à renvoyer telle quelle à providers:add. */
export interface ProviderCatalogEntry {
  name: string;
  /** Libellé court du sélecteur (p. ex. « z.ai — GLM Coding Plan (abonnement) »). */
  label: string;
  /** Description sous le sélecteur. */
  tagline: string;
  kind: ProviderKind;
  /** Adresse d'appel par défaut (null pour les services testés par requête). */
  defaultBaseUrl: string | null;
  /** Fournisseur local sans clé (Ollama). */
  keyless: boolean;
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
