// Protocole fil Hermes — source unique front ↔ back (découpage 2026-11,
// FORK.md §60 « déduplication »). Les interfaces du socket.io vivaient en
// double (src/lib/chat-types.ts ↔ mini-services/hermes-chat/types.ts) et
// avaient divergé : le service ÉMETTAIT engineProviders / gatewayTokenSet /
// memoryChars sans les déclarer, ModelsResult.defaultModel était `string`
// côté back alors que le fallback catalogue peut ne rien fixer. Ce module
// est le référentiel : les deux côtés ré-exportent, et une divergence y
// sera visible dans UN fichier au lieu de deux silencieuses.
//
// RÈGLES :
//  - aucune import React/lucide/icône ici (contraint bun ET next) ;
//  - tout champ ajouté au fil doit l'être ICI d'abord, puis ré-émis ;
//  - champ optionnel (?) = le service peut ne pas l'envoyer (compat
//    ascendante : anciens clients, nouveaux services).

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

export type ArtifactStatus =
  | "generating" // écrit en cours (stream du source)
  | "rendering" // aperçu en cours de rendu (Chrome)
  | "ready" // source final + aperçu (si applicable) disponibles
  | "error"; // rendu en échec (le source reste consultable)

/** Artefact d'une conversation — une version d'un fichier généré. */
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
  /** Vue « nouvel onglet » (HTML rendu derrière un bac à sable CSP). */
  viewUrl?: string;
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

// ── Modes du compositeur (F-30) : identifiants + config d'une conversation ──
// Les libellés/icônes d'affichage vivent côté front (lib/modes.ts), les
// consignes/prompts côté service (modes.ts) : ici, l'IDENTITÉ partagée.

export type ConversationMode =
  | "chat"
  | "plan"
  | "code"
  | "compare"
  | "debate"
  | "council"
  | "auto";

export const CONVERSATION_MODES: ConversationMode[] = [
  "chat",
  "plan",
  "code",
  "compare",
  "debate",
  "council",
  "auto",
];

/** Valeur inconnue → chat (jamais d'écran cassé, jamais de tour refusé). */
export function resolveMode(value: unknown): ConversationMode {
  return CONVERSATION_MODES.includes(value as ConversationMode)
    ? (value as ConversationMode)
    : "chat";
}

// ── Config d'une conversation (JSON conversations.mode_config) ─────────

export interface ModeConfig {
  /** Débat : tours par conversation (3–10). */
  rounds?: number;
  /** Conseil : membres par conversation (2–5). */
  members?: number;
  /** Auto : reprises après échec (0–3). */
  retries?: number;
  /** Auto : débat préalable de cadrage (désactivable pour les tâches évidentes). */
  autoDebate?: boolean;
  /** Débat : les voix d'un MÊME tour partent ensemble (voient les tours
   *  précédents, pas celles de leur tour) — ~3× plus rapide, activé par
   *  défaut (F-57). */
  debateParallel?: boolean;
  /** Modèle par voix — null/absent = modèle de la conversation. */
  voices?: Record<string, Record<string, string | null>>;
}

// ── Rôles et pièces jointes ─────────────────────────────────────────────

export type Role = "user" | "assistant";

export type AttachmentKind = "image" | "audio" | "video" | "pdf" | "file";

/** Pièce jointe d'un message (vue fil, déjà persistée côté service). */
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

// ── Messages et conversations ────────────────────────────────────────────

/** Événement d'outil pendant un tour (vue fil). */
export interface ToolEvent {
  name: string;
  status: "running" | "done" | "error";
  /** Détail : arguments/résultat compressés pour l'affichage. */
  detail?: string;
  at: string;
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
  // ── Modes du compositeur (F-30) — déroulé + étiquette du mode ──
  /** Étiquette du mode sur la réponse finale (« Verdict · Débat — 3 tours »). */
  modeTag?: string;
  /** Déroulé du tour multi-voix, affiché dans la conversation au-dessus de la réponse. */
  modeFlow?: ModeFlowRow[];
}

/** Conversation du fil (métadonnées de la liste). */
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
  // ── Modes du compositeur (F-30) — le service fait foi, relu à chaque envoi ──
  /** Mode de la conversation (chat par défaut — valeur inconnue retombe sur chat). */
  mode?: ConversationMode;
  /** Débat : tours (3–10), null = défaut du client. */
  modeRounds?: number | null;
  /** JSON des voix → modèles + membres/reprises/autoDebate (par conversation). */
  modeConfig?: ModeConfig | null;
}

/** Ligne du déroulé multi-voix (F-30). */
export interface ModeFlowRow {
  /** Identifiant stable de la ligne dans le déroulé. */
  id: string;
  /** Libellé affiché (« Tour 1 · Sceptique », « Membre A », « Plan »…). */
  label: string;
  /** Détail : rôle de la voix en cours, extrait de la réponse une fois terminée. */
  detail: string;
  /** Modèle court de la voix (absent = modèle de la conversation). */
  model?: string;
  status: "pending" | "running" | "done" | "error";
}

/** Projet de rangement des conversations (sidebar). */
export interface Project {
  id: string;
  name: string;
  /** Ordre d'affichage dans la sidebar (croissant). */
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** Résultat de recherche dans les messages (recherche de la sidebar). */
export interface SearchHit {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: Role;
  excerpt: string;
  createdAt: string;
}

/** Source web citée par un tour avec recherche web (F-09/F-12). */
export interface WebSource {
  /** Rang de citation, 1-based (le modèle cite sous la forme [n]). */
  n: number;
  title: string;
  url: string;
  snippet: string;
}

// ── Hello : statut réel du service (carte honnête) ──────────────────────

export type GatewayMode = "gateway" | "local";

/** Hello du service : la carte de statut ne simule rien — chaque champ
 *  reflète une sonde réelle (v2.4). Champ optionnel = le service peut ne
 *  pas l'envoyer : l'écran affiche alors « inconnu », jamais « ok » faux. */
// ── Système (v0.3.0) : carte Mise à jour du volet Système ────────────────

/** Réponse de system:update-check — même forme que l'état `update` du
 *  hello et de l'événement system:update-state (v0.3.3 : le service
 *  vérifie de lui-même au démarrage puis toutes les 6 h). */
export interface UpdateCheckResult {
  /** Révision git installée (7 caractères, null sans .git). */
  installed: string | null;
  /** Révision distante QUAND une version plus récente existe (null =
 *  à jour ou inconnu — voir error). */
  available: string | null;
  /** Date de la dernière vérification aboutie (ISO). */
  checkedAt?: string | null;
  /** Cause d'échec honnête (dépôt injoignable…) — null sinon. */
  error?: string | null;
}

export interface ServerHello {
  app: string;
  version: string;
  mode: GatewayMode;
  model: string;
  gatewayUrl: string | null;
  /** F-02 : true = une URL de gateway est RÉGLÉE dans l'interface (le
   *  champ et le bouton « Débrancher » s'affichent en fonction d'elle) ;
   *  false/null = défaut automatique — rien de configuré à débrancher. */
  gatewayConfigured?: boolean;
  /** Jeton de gateway enregistré côté service (booléen, jamais la valeur). */
  gatewayTokenSet?: boolean;
  /** Fournisseurs LLM actionnables (clé active ou keyless) — la carte de
   *  statut de la sidebar s'appuie dessus pour un état honnête. v2.4. */
  engineProviders?: string[] | null;
  /** Taille des instructions système (estimation honnête de la jauge). */
  systemPromptChars?: number | null;
  /** Révision git du dépôt déployé (null = installation sans git). v2.4. */
  appRevision?: string | null;
  /** Binaire chrome-headless-shell présent ou absent (sonde réelle). v2.4. */
  chromeHeadless?: "present" | "absent";
  /** Mémoire active en caractères (0 = désactivée) — F-18. */
  memoryChars?: number | null;
  /** v0.3.3 : état de mise à jour vérifié par le service (démarrage + 6 h).
   *  update.available non null → une nouvelle version existe sur GitHub :
   *  le front badge l'onglet Système et l'engrenage, même volet fermé. */
  update?: UpdateCheckResult | null;
}

// ── Modèles ─────────────────────────────────────────────────────────────

/** Modèle du catalogue/service (option du sélecteur). */
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
  /** Fournisseur « chats IA web » (pilotes navigateur) — pas un modèle du moteur. */
  webchat?: boolean;
  /** false = site non vérifié (verifie=false) : INDISPONIBLE, affiché comme tel. */
  available?: boolean;
}

/** Résultat de models:list — defaultModel null si le catalogue n'en fixe
 *  pas (le compositeur retombe alors sur le premier modèle de la liste). */
export interface ModelsResult {
  models: ModelOption[];
  defaultModel: string | null;
  source: "gateway" | "catalogue" | "providers";
}

// ── État de compaction (conversation longue) ───────────────────────────

/** État de compaction d'une conversation (résumé conservé en tête). */
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

// ── Fournisseurs & clés (vue masquée — le secret ne sort JAMAIS) ────────

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

// ── Extensions (v2.6 : Outils & extensions) : dépôts importés + serveurs MCP ──

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
  /** Canal de suivi des mises à jour (repo uniquement). */
  channel?: string | null;
  /** Référence figée (commit) — null = suivi du canal. */
  commit?: string | null;
  /** Version installée (tag/commit court). */
  version?: string | null;
  pinned: boolean;
  enabled: boolean;
  /** État réellement chargé par le service (false = au prochain redémarrage). */
  applied: boolean;
  /** Version/commit détecté par « Vérifier » (null = à jour). */
  updateAvailable?: string | null;
  lastCheckedAt?: string | null;
}

// ── Bornes des modes (miroir obligatoire : saisie UI ↔ revalidation) ────
// Le front affiche et borne la saisie, le service revalide : les bornes
// vivent ICI pour ne jamais diverger (une valeur est acceptée par l'écran
// puis rejetée par le tour = bug silencieux).

export const DEBATE_ROUNDS_MIN = 3;
export const DEBATE_ROUNDS_MAX = 10;
export const COUNCIL_MEMBERS_MIN = 2;
export const COUNCIL_MEMBERS_MAX = 5;
export const AUTO_RETRIES_MIN = 0;
export const AUTO_RETRIES_MAX = 3;
export const MAX_MODE_PROMPT_CHARS = 4_000;

/** Clé du registre (client ET serveur) de la taille des voix. */
export const VOICE_CHARS_KEY = "hermes.modes.voiceChars";
export const VOICE_CHARS_MIN = 500;
export const VOICE_CHARS_MAX = 8000;
export const VOICE_CHARS_DEFAULT = 2000;

// ── Échelle d'effort générique (affichée quand le modèle n'en déclare pas) ──

export const GENERIC_EFFORTS = ["off", "low", "medium", "high", "max"];

// ── Présentation (libellés FR, octets) — mêmes règles des deux côtés ────

/** Libellé humain du type d'artefact (carte, panneau, export). */
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
  return kind;
}

/** Octets en o / Ko / Mo (même logique côté service : formatBytes). */
export function formatArtifactBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

// ── Stockage (v0.3.0) : page Stockage, inventaire et mutations ──────────

/** Fenêtre d'annulation des suppressions (spec §4.5). */
export const STORAGE_UNDO_MS = 7_000;

/** Canonicité du « nettoyable » (spec §5.2) : dépassée ET non épinglée.
 *  Même formule côté front (libellés) et côté back (nettoyage).
 *  `pinned` tolère la forme SQL (0/1) ET la forme protocole (booléen). */
export function isStorageCleanable(
  e: { pinned: number | boolean; version: number },
  maxVersion: number
): boolean {
  return !e.pinned && e.version < maxVersion;
}

/** Entrée d'inventaire de la page Stockage (une version d'un document). */
export interface StorageEntry {
  /** Identifiant de la ligne d'artefact (une version précise). */
  id: string;
  conversationId: string;
  conversationTitle: string;
  projectId: string | null;
  projectName: string;
  key: string;
  kind: string;
  name: string;
  version: number;
  size: number;
  pinned: boolean;
  createdAt: string;
}

/** Réponse de storage:list. */
export interface StorageListResult {
  entries: StorageEntry[];
}

/** Réponse OK d'une mutation (deleteVersion / cleanProject). */
export interface StorageMutationResult {
  ok: true;
  /** Nombre de lignes réellement supprimées. */
  removed: number;
  /** Octets réellement libérés — MESURE, jamais estimation (§5.3). */
  bytesFreed: number;
  /** Jeton d'annulation valable STORAGE_UNDO_MS (annulé au retour). */
  undoToken: string;
}

/** Réponse OK de storage:undo. */
export interface StorageUndoResult {
  ok: true;
  /** Nombre de lignes restaurées. */
  restored: number;
}

/** Refus d'une mutation : code machine + message humain. */
export interface StorageMutationError {
  ok: false;
  /** 409 épinglée · 404 absente · 410 fenêtre expirée. */
  code: "pinned" | "notfound" | "gone";
  error: string;
}

