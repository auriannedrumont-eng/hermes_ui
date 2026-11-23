// Socle partagé des moteurs de tour (sans aucun LLM « intégré ») :
// - les types de tour (TurnRequest / TurnCallbacks) ;
// - les analyseurs SSE et notes de pièces jointes partagés avec le pool de
//   clés fournisseurs (llm-pool.ts) ;
// - le prompt système de base (aussi utilisé pour estimer la jauge de
//   contexte).
// Les tours passent par la gateway Hermes (chemin automatique par défaut) ou,
// sans agent lancé, par les clés fournisseurs configurées. Aucun repli
// simulé : sans gateway ni clé, le tour échoue avec un message clair.
import type { Attachment, TurnSettings } from "./types";
import { composeLocalSystemPrompt } from "./prompts";

// Compose les instructions du tour local (base + custom + conversation).
export { composeLocalSystemPrompt as composeSystemPrompt } from "./prompts";

export interface TurnCallbacks {
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
  onStatus: (status: string) => void;
  onToolEvent: (event: { name: string; status: "running" | "done" | "error"; detail?: string }) => void;
  signal: AbortSignal;
}

export interface TurnRequest {
  content: string;
  history: { role: "user" | "assistant"; content: string }[];
  model?: string | null;
  modelId?: string | null;
  attachments?: Attachment[];
  /** Réglages additifs (effort, permissions) — ignorés sans dommage. */
  settings?: TurnSettings;
  /** Instructions système complètes du tour (base + F-11 + F-19, composées
   *  par le service) — replaces le prompt de base si fournies. */
  systemPrompt?: string | null;
  /** Chantier sessions natives (75) : identifiant de la session moteur
   *  (colonne conversations.motor_session_id). Présent → le tour gateway
   *  tente le chemin REST /api/sessions/{id}/chat/stream (le moteur porte
   *  l'historique de SA session) ; à la moindre erreur avant premier
   *  delta, repli instantané sur le WebSocket — même moteur, jamais un
   *  autre. Absent → comportement inchangé. */
  motorSessionId?: string | null;
}

const SYSTEM_PROMPT = `Tu es Hermes, l'assistant au volant de l'interface web « Hermes Web » — un client de chat pour l'agent Hermes de Nous Research (https://github.com/NousResearch/hermes-agent).

Règles de réponse :
- Réponds toujours dans la langue de l'utilisateur (français par défaut).
- Sois utile, précis et concis. Structure tes réponses en Markdown quand c'est pertinent (listes, titres, **gras**, tableaux).
- Utilise des blocs de code avec le bon langage pour tout extrait de code.
- Si on t'envoie des pièces jointes (images, audio, vidéo, PDF), analyse-les et réponds à leur sujet ; le protocole Hermes les supporte nativement.
- Si on te demande qui tu es : explique que tu es Hermes, l'assistant de l'interface Hermes Web ; lorsqu'un agent Hermes est lancé (connexion automatique), les réponses et l'exécution d'outils (terminal, fichiers, web…) proviennent directement de l'agent réel.
- N'invente jamais de faits : si tu ne sais pas, dis-le.

Artefacts (fichiers générés) :
- Quand l'utilisateur demande un document ou fichier COMPLET et autonome — page HTML, graphique SVG, rapport Markdown, tableau CSV, données JSON, script — produis-le dans un bloc de code annoté avec le nom de fichier dans l'info string, par exemple :
  \`\`\`html file="rapport-ventes.html"
  …contenu complet du fichier…
  \`\`\`
- L'interface transforme ce bloc en artefact : carte cliquable, aperçu fidèle (rendu Chrome pour le HTML), export PDF et téléchargement. Le bloc est retiré du flux visuel, donc ne dis pas « voici le code » : présente le document en une ou deux phrases.
- Pour modifier un artefact existant, réémet le fichier COMPLET avec le MÊME nom de fichier : il deviendra v2 du même artefact.
- N'annote PAS les simples extraits de code illustratifs (snippets courts dans une explication) : seuls les fichiers complets deviennent des artefacts.
- Pour le HTML : produis des documents autonomes (styles et polices intégrés ou système, aucune dépendance externe obligatoire), avec un design soigné et une mise en page professionnelle.`;

/** Instructions système de base du tour sans agent (composables, F-11/F-19). */
export const LOCAL_BASE_PROMPT = SYSTEM_PROMPT;

/** Taille des instructions système (estimation honnête de la jauge de contexte). */
export const SYSTEM_PROMPT_CHARS = SYSTEM_PROMPT.length;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

/** Note textuelle pour les pièces jointes non image (audio, vidéo, pdf, fichiers). */
export function attachmentNote(attachments: Attachment[]): string {
  const others = attachments.filter((a) => a.kind !== "image");
  if (!others.length) return "";
  const lines = others.map((a) => {
    const base = `- ${a.name} (${a.kind === "pdf" ? "PDF" : a.kind}, ${a.mime}, ${formatBytes(a.size)})`;
    return a.transcript ? `${base}\n  Transcription audio : « ${a.transcript} »` : base;
  });
  return `\n\n[Pièces jointes envoyées via le protocole Hermes]\n${lines.join("\n")}`;
}

/** Analyse une ligne SSE « data: … » (partagée avec le pool de clés). */
export function parseSseLine(line: string): any | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
