// Moteur de démonstration : LLM intégré via z-ai-web-dev-sdk (streaming SSE)
// Utilisé lorsqu'aucune gateway Hermes n'est joignable.
// Supporte les pièces jointes : les images sont transmises en contenu
// multimodal (vision), les autres fichiers en métadonnées textuelles.
import ZAI from "z-ai-web-dev-sdk";
import { readAttachmentDataUrl } from "./uploads";
import type { Attachment, TurnSettings } from "./types";

interface VisionMessageLike {
  role: "assistant" | "user";
  content: string | Array<Record<string, unknown>>;
}

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
}

const SYSTEM_PROMPT = `Tu es Hermes, l'assistant au volant de l'interface web « Hermes Web » — un client de chat pour l'agent Hermes de Nous Research (https://github.com/NousResearch/hermes-agent).

Règles de réponse :
- Réponds toujours dans la langue de l'utilisateur (français par défaut).
- Sois utile, précis et concis. Structure tes réponses en Markdown quand c'est pertinent (listes, titres, **gras**, tableaux).
- Utilise des blocs de code avec le bon langage pour tout extrait de code.
- Si on t'envoie des pièces jointes (images, audio, vidéo, PDF), analyse-les et réponds à leur sujet ; le protocole Hermes les supporte nativement.
- Si on te demande qui tu es : explique que tu es le moteur de démonstration intégré de l'interface, et que lorsqu'une gateway Hermes est connectée (variable HERMES_GATEWAY_URL), les réponses proviennent directement de l'agent Hermes avec ses outils (terminal, fichiers, web…).
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

/** Taille des instructions système (estimation honnête de la jauge de contexte). */
export const SYSTEM_PROMPT_CHARS = SYSTEM_PROMPT.length;

// Décodeur UTF-8 persistant : gère les caractères multi-octets coupés entre chunks
const utf8Decoder = new TextDecoder("utf-8");

// Les chunks SSE arrivent parfois sous forme d'objets indexés par octet (UTF-8)
function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk && typeof (chunk as any)[Symbol.iterator] === "function") {
    const codes = Array.from(chunk as Iterable<any>, (c) => Number(c));
    if (codes.length && codes.every((c) => Number.isInteger(c) && c >= 0 && c < 256)) {
      // Octets UTF-8 -> texte (mode flux pour les séquences incomplètes)
      return utf8Decoder.decode(new Uint8Array(codes), { stream: true });
    }
    if (codes.length && codes.every((c) => Number.isInteger(c) && c >= 0 && c < 65536)) {
      return String.fromCharCode(...codes);
    }
  }
  return JSON.stringify(chunk);
}

function parseSseLine(line: string): any | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

/** Note textuelle pour les pièces jointes non image (audio, vidéo, pdf, fichiers). */
function attachmentNote(attachments: Attachment[]): string {
  const others = attachments.filter((a) => a.kind !== "image");
  if (!others.length) return "";
  const lines = others.map((a) => {
    const base = `- ${a.name} (${a.kind === "pdf" ? "PDF" : a.kind}, ${a.mime}, ${formatBytes(a.size)})`;
    return a.transcript ? `${base}\n  Transcription audio : « ${a.transcript} »` : base;
  });
  return `\n\n[Pièces jointes envoyées via le protocole Hermes]\n${lines.join("\n")}`;
}

export class DemoEngine {
  private zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

  async init(): Promise<void> {
    if (!this.zai) this.zai = await ZAI.create();
  }

  async runTurn(
    req: TurnRequest,
    cb: TurnCallbacks
  ): Promise<{ content: string; reasoning: string; model: string }> {
    await this.init();
    cb.onStatus("Hermes réfléchit…");

    const images = (req.attachments ?? []).filter((a) => a.kind === "image");
    const textContent = req.content + attachmentNote(req.attachments ?? []);

    // 1. Tentative multimodale (vision) si le tour contient des images
    if (images.length > 0) {
      try {
        const result = await this.runMultimodal(textContent, images, req.history, cb);
        if (result) {
          return { ...result, model: req.model || req.modelId || "glm-4-plus" };
        }
      } catch (err) {
        console.error(
          "[hermes-chat] vision indisponible :",
          err instanceof Error ? err.message : err
        );
        cb.onStatus("Vision indisponible — analyse textuelle…");
      }
    }

    // 2. Chemin standard : streaming texte
    const messages: any[] = [
      { role: "assistant", content: SYSTEM_PROMPT },
      ...req.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: textContent },
    ];

    // Effort de raisonnement : « off » coupe le thinking, toute autre valeur
    // du fournisseur l'active (échelle portée par le modèle, ignorée sans dommage).
    const thinkingType: "enabled" | "disabled" =
      req.settings?.reasoningEffort === "off" ? "disabled" : "enabled";

    const stream = await this.zai!.chat.completions.create({
      messages,
      stream: true,
      thinking: { type: thinkingType },
    });

    let content = "";
    let reasoning = "";
    let model = "glm-4-plus";
    let buffer = "";

    for await (const raw of stream as AsyncIterable<unknown>) {
      if (cb.signal.aborted) break;
      buffer += chunkToString(raw);

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const data = parseSseLine(line.trim());
        if (!data) continue;
        if (data.model) model = data.model;
        const delta = data.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          cb.onReasoning(delta.reasoning_content);
        }
        if (delta.reasoning) {
          reasoning += delta.reasoning;
          cb.onReasoning(delta.reasoning);
        }
        if (delta.content) {
          content += delta.content;
          cb.onDelta(delta.content);
        }
      }
    }

    return { content, reasoning, model: req.model || model };
  }

  /**
   * Synthèse de compaction : résume un fil de messages en un texte compact
   * conservé en tête de session (l'affichage de la conversation reste intact).
   */
  async summarize(
    history: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    await this.init();
    const transcript = history
      .map((m) => `${m.role === "user" ? "Utilisateur" : "Hermes"} : ${m.content}`)
      .join("\n\n")
      .slice(0, 60_000);
    const response = await this.zai!.chat.completions.create({
      messages: [
        {
          role: "user",
          content:
            "Résume la conversation suivante pour la suite d'une session de chat avec un agent. " +
            "Conserve : le sujet et l'objectif, les décisions prises, les fichiers/artefacts produits " +
            "(noms), les contraintes et préférences de l'utilisateur, et les prochaines étapes en cours. " +
            "Réponds en français, en 10 lignes maximum, sans préambule.\n\n" +
            transcript,
        },
      ],
      thinking: { type: "disabled" },
    });
    const content = (response as any)?.choices?.[0]?.message?.content ?? "";
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Résumé de compaction vide");
    }
    return content.trim();
  }

  /** Tour multimodal : images en content parts (format vision), réponse en un tenant. */
  private async runMultimodal(
    textContent: string,
    images: Attachment[],
    history: { role: "user" | "assistant"; content: string }[],
    cb: TurnCallbacks
  ): Promise<{ content: string; reasoning: string } | null> {
    const parts: any[] = [];
    const text = textContent.trim() || "Décris et analyse ces images.";
    parts.push({ type: "text", text });
    let added = 0;
    for (const img of images.slice(0, 4)) {
      const dataUrl = readAttachmentDataUrl(img.url);
      if (!dataUrl) continue;
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
      added++;
    }
    if (added === 0) return null;

    cb.onStatus(`Analyse de ${added} image${added > 1 ? "s" : ""} (vision)…`);

    const messages: VisionMessageLike[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: SYSTEM_PROMPT }],
      },
      ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: parts },
    ];

    // API vision du SDK (modèle glm-4.6v) — cf. skills/VLM
    const response = await (this.zai!.chat.completions as any).createVision({
      model: "glm-4.6v",
      messages,
      thinking: { type: "disabled" },
    });
    const choice = (response as any)?.choices?.[0]?.message;
    const content: string = choice?.content ?? "";
    if (!content) return null;
    // Émission progressive du résultat (rendu fluide côté interface)
    const chunks = content.match(/[\s\S]{1,90}/g) ?? [];
    for (const chunk of chunks) {
      if (cb.signal.aborted) break;
      cb.onDelta(chunk);
      await new Promise((r) => setTimeout(r, 24));
    }
    return { content, reasoning: "" };
  }
}
