// Mécanique de streaming des tours LLM — extraite de createLlmPool (vague 2).
// Tout est PUR ici : aucune fermeture sur l'état du pool. La garde
// d'inactivité reçoit l'ensemble des streams en vol (suivi live /diagnostics,
// F-31ter) via la fabrique stallGuardFor ; les fonctions de tour reçoivent
// leur garde en premier paramètre. Le porte-clés, le cache des listes et le
// routage restent dans llm-pool.ts.
import type { LlmEndpoint, PoolTurnResult, StreamTraceEntry, TurnUsage } from "./llm-pool";
import {
  LOCAL_BASE_PROMPT,
  attachmentNote,
  parseSseLine,
  type TurnCallbacks,
  type TurnRequest,
} from "./local-engine";
import { explainQuotaError } from "./providers";
import { readAttachmentDataUrl } from "./uploads";

// ── Garde d'inactivité des tours fournisseur ────────────────────────────
// La gateway a son timeout de tour (180 s) et le webchat son délai global de
// pilote — sans garde, une connexion fournisseur qui s'enraye (aucune
// réponse, ou des octets qui cessent) bloque le tour indéfiniment. C'est une
// garde d'INACTIVITÉ : le minuteur repart à chaque octet reçu — une réponse
// longue mais vivante reste licite, un fournisseur muet est coupé avec un
// motif parlant.
// Surcharge par env pour les preuves (jamais en production).
export const TURN_STALL_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.HERMES_TURN_STALL_MS) || 120_000,
);

/** Garde renvoyée par stallGuardFor : signal combiné + suivi d'activité. */
export interface StreamGuard {
  signal: AbortSignal;
  reset(bytes?: number): void;
  done(): void;
}

/** Fabrique de gardes, liée au vivier de streams d'un pool. */
export type StreamGuardFactory = (
  signal: AbortSignal,
  stallMs: number,
  label: string,
  modelId: string,
) => StreamGuard;

/** Signal combiné pour un tour streaming : annulation utilisateur (cb.signal)
 *  + minuteur d'inactivité. reset() repart le minuteur (octet reçu) ;
 *  done() nettoie à la fin du tour. Le déclenchement annule le fetch avec un
 *  motif parlant — l'erreur remonte telle quelle jusqu'à l'interface. */
export function stallGuardFor(
  activeStreamEntries: Set<StreamTraceEntry>,
): StreamGuardFactory {
  function stallGuard(signal: AbortSignal, stallMs: number, label: string, modelId: string) {
    const controller = new AbortController();
    const onUserAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onUserAbort();
    else signal.addEventListener("abort", onUserAbort, { once: true });
    // Suivi live (F-31ter) : l'entrée existe du lancement au nettoyage (done,
    // en finally) — /diagnostics la lit pour trancher lent vs mort en vol.
    const entry: StreamTraceEntry = {
      provider: label,
      model: modelId,
      startedAt: Date.now(),
      lastByteAt: Date.now(),
      bytes: 0,
    };
    activeStreamEntries.add(entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        controller.abort(
          new Error(
            `${label} : plus aucun octet reçu depuis ${Math.round(stallMs / 1000)} s — tour abandonné (garde d'inactivité)`,
          ),
        );
      }, stallMs);
    };
    arm();
    return {
      signal: controller.signal,
      reset(bytes = 0) {
        entry.lastByteAt = Date.now();
        entry.bytes += bytes;
        arm();
      },
      done() {
        if (timer) clearTimeout(timer);
        activeStreamEntries.delete(entry);
        signal.removeEventListener("abort", onUserAbort);
      },
    };
  }
  return stallGuard;
}

// ── Erreurs du pool ────────────────────────────────────────────────────

/** Erreur d'authentification : la clé est déclassée puis une autre est tentée. */
export class PoolAuthError extends Error {
  constructor(
    message: string,
    readonly exhausted: boolean,
    readonly keyLabel: string,
  ) {
    super(message);
    this.name = "PoolAuthError";
  }
}

/** Message d'erreur lisible depuis un corps d'API (JSON ou texte). */
async function readErrorBody(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw) as any;
    const msg = j?.error?.message ?? j?.message ?? j?.detail;
    if (typeof msg === "string" && msg) return msg.slice(0, 200);
  } catch {
    /* corps non JSON */
  }
  return raw.slice(0, 200) || `(corps vide)`;
}

// Traduction des 429 partagée avec le test de clé (providers.ts) —
// `long` accompagne l'erreur du tour, `short` étiquette la carte clé.
const rateLimitWhy = explainQuotaError;

// ── Contenu utilisateur ────────────────────────────────────────────────

/** Contenu utilisateur du tour (texte + note des pièces jointes, ou
 *  content parts multimodal quand le tour porte des images). */
export function buildUserPayload(
  req: TurnRequest,
  style: "openai" | "anthropic",
): { text: string; parts: unknown[] | null } {
  const images = (req.attachments ?? []).filter((a) => a.kind === "image");
  const textContent = req.content + attachmentNote(req.attachments ?? []);
  if (images.length === 0) return { text: textContent, parts: null };
  const parts: any[] = [{ type: "text", text: req.content.trim() || "Décris et analyse ces images." }];
  let added = 0;
  for (const img of images.slice(0, 4)) {
    const dataUrl = readAttachmentDataUrl(img.url);
    if (!dataUrl) continue;
    if (style === "anthropic") {
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (!m) continue;
      parts.push({
        type: "image",
        source: { type: "base64", media_type: m[1], data: m[2] },
      });
    } else {
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    }
    added++;
  }
  return added > 0 ? { text: textContent, parts } : { text: textContent, parts: null };
}

// ── Tours streaming ────────────────────────────────────────────────────

/** POST {base}/chat/completions en streaming (style openai). */
export async function streamOpenAiTurn(
  stallGuard: StreamGuardFactory,
  endpoint: LlmEndpoint,
  secret: string | null,
  modelId: string,
  req: TurnRequest,
  cb: TurnCallbacks,
): Promise<PoolTurnResult> {
  const system = req.systemPrompt ?? LOCAL_BASE_PROMPT;
  const { text, parts } = buildUserPayload(req, "openai");
  const messages: any[] = [
    { role: "system", content: system },
    ...req.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: parts ?? text },
  ];
  const expert = req.settings ?? {};
  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: true,
    // z.ai (les deux portefeuilles) : l'effort « off » coupe explicitement
    // le raisonnement GLM ; toute autre valeur laisse le défaut du modèle
    // (aucun risque d'erreur sur les modèles non-raisonnement).
    ...((endpoint.providerLabel === "z.ai" ||
      endpoint.providerLabel === "z.ai Coding Plan") &&
    req.settings?.reasoningEffort === "off"
      ? { thinking: { type: "disabled" } }
      : {}),
    ...(expert.temperature !== undefined ? { temperature: expert.temperature } : {}),
    ...(expert.maxTokens !== undefined ? { max_tokens: expert.maxTokens } : {}),
    ...(expert.seed !== undefined ? { seed: expert.seed } : {}),
  };

  const guard = stallGuard(cb.signal, TURN_STALL_TIMEOUT_MS, endpoint.providerLabel, modelId);
  let res: Response;
  try {
    res = await fetch(`${endpoint.base}/chat/completions`, { redirect: "error",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(endpoint.auth === "bearer" && secret ? { Authorization: `Bearer ${secret}` } : {}),
        ...(endpoint.auth === "x-api-key" && secret ? { "x-api-key": secret } : {}),
        ...(endpoint.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    // Les erreurs HTTP passent par ce try : lancées hors try, elles laissent
    // l'entrée du garde à vie dans activeStreamEntries (flux fantôme éternel
    // dans /diagnostics, timer qui fuit).
    if (!res.ok) {
      const detail = await readErrorBody(res);
      if (res.status === 401 || res.status === 403)
        throw new PoolAuthError(`clé refusée par ${endpoint.providerLabel} (HTTP ${res.status})`, false, "clé refusée à l'usage");
      if (res.status === 429) {
        const why = rateLimitWhy(detail);
        throw new PoolAuthError(
          `limite ${endpoint.providerLabel} atteinte (HTTP 429)${why.long ? ` — ${why.long}` : ""}`,
          true,
          why.short,
        );
      }
      throw new Error(`${endpoint.providerLabel} a répondu HTTP ${res.status} : ${detail}`);
    }
    if (!res.body) throw new Error(`${endpoint.providerLabel} : flux vide`);
  } catch (err) {
    guard.done();
    throw err;
  }
  // Les en-têtes sont arrivés : le fournisseur vit — le minuteur repart
  // pour la lecture du flux.
  guard.reset();

  let content = "";
  let reasoning = "";
  let model = modelId;
  let usage: TurnUsage | undefined;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  const consume = (line: string) => {
    const data = parseSseLine(line.trim());
    if (!data) return;
    if (typeof data.model === "string" && data.model) model = data.model;
    const u = data.usage;
    if (u && typeof u === "object") {
      usage = {
        input: typeof u.prompt_tokens === "number" ? u.prompt_tokens : u.input_tokens,
        output: typeof u.completion_tokens === "number" ? u.completion_tokens : u.output_tokens,
        cost: typeof u.cost === "number" ? u.cost : undefined,
      };
    }
    const d = data.choices?.[0]?.delta;
    if (!d) return;
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === "string" && r) {
      reasoning += r;
      cb.onReasoning(r);
    }
    if (typeof d.content === "string" && d.content) {
      content += d.content;
      cb.onDelta(d.content);
    }
  };

  try {
    for (;;) {
      if (cb.signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      guard.reset(value.byteLength);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    // Fin de flux sans \n final (revue 95) : le résidu du buffer — le
    // dernier jeton ou l'objet usage de la dernière trame SSE — était
    // perdu si le serveur clôturait le flux sans sauter de ligne.
    if (buffer.trim()) consume(buffer);
  } catch (err) {
    // Stop utilisateur pendant le vol : on rend le partiel reçu. Une garde
    // d'inactivité déclenchée n'est PAS un arrêt utilisateur : le motif
    // parlant remonte tel quel.
    if (!cb.signal.aborted) throw err;
  } finally {
    guard.done();
  }
  return { content, reasoning, model, provider: endpoint.providerLabel, usage };
}

/** POST {base}/messages en streaming (style anthropic). */
export async function streamAnthropicTurn(
  stallGuard: StreamGuardFactory,
  endpoint: LlmEndpoint,
  secret: string | null,
  modelId: string,
  req: TurnRequest,
  cb: TurnCallbacks,
): Promise<PoolTurnResult> {
  const system = req.systemPrompt ?? LOCAL_BASE_PROMPT;
  const { text, parts } = buildUserPayload(req, "anthropic");
  const expert = req.settings ?? {};
  const body: Record<string, unknown> = {
    model: modelId,
    system,
    messages: [
      ...req.history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: parts ?? text },
    ],
    stream: true,
    // Anthropic exige un plafond de sortie.
    max_tokens: expert.maxTokens !== undefined ? expert.maxTokens : 4096,
    ...(expert.temperature !== undefined ? { temperature: expert.temperature } : {}),
  };

  const guard = stallGuard(cb.signal, TURN_STALL_TIMEOUT_MS, endpoint.providerLabel, modelId);
  let res: Response;
  try {
    res = await fetch(`${endpoint.base}/messages`, { redirect: "error",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(endpoint.auth === "x-api-key" && secret ? { "x-api-key": secret } : {}),
        ...(endpoint.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    // Les erreurs HTTP passent par ce try : lancées hors try, elles laissent
    // l'entrée du garde à vie dans activeStreamEntries (flux fantôme éternel
    // dans /diagnostics, timer qui fuit).
    if (!res.ok) {
      const detail = await readErrorBody(res);
      if (res.status === 401 || res.status === 403)
        throw new PoolAuthError(`clé refusée par ${endpoint.providerLabel} (HTTP ${res.status})`, false, "clé refusée à l'usage");
      if (res.status === 429) {
        const why = rateLimitWhy(detail);
        throw new PoolAuthError(
          `limite ${endpoint.providerLabel} atteinte (HTTP 429)${why.long ? ` — ${why.long}` : ""}`,
          true,
          why.short,
        );
      }
      throw new Error(`${endpoint.providerLabel} a répondu HTTP ${res.status} : ${detail}`);
    }
    if (!res.body) throw new Error(`${endpoint.providerLabel} : flux vide`);
  } catch (err) {
    guard.done();
    throw err;
  }
  // Les en-têtes sont arrivés : le fournisseur vit — le minuteur repart
  // pour la lecture du flux.
  guard.reset();

  let content = "";
  let reasoning = "";
  let model = modelId;
  let usage: TurnUsage | undefined;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  const consume = (line: string) => {
    const data = parseSseLine(line.trim());
    if (!data) return;
    if (typeof data.model === "string" && data.model) model = data.model;
    switch (data.type) {
      // message_start porte usage.input_tokens (jetons du prompt) et le
      // modèle réellement servi — l'ignorer laissait l'usage Anthropic
      // sans entrée « input » jusqu'au message_delta final (F-21).
      case "message_start": {
        if (typeof data.message?.model === "string" && data.message.model) {
          model = data.message.model;
        }
        const u = data.message?.usage;
        if (u && typeof u === "object") {
          usage = {
            input: typeof u.input_tokens === "number" ? u.input_tokens : usage?.input,
            output: typeof u.output_tokens === "number" ? u.output_tokens : usage?.output,
            cost: usage?.cost,
          };
        }
        break;
      }
      case "content_block_delta": {
        const d = data.delta ?? {};
        if (typeof d.thinking === "string" && d.thinking) {
          reasoning += d.thinking;
          cb.onReasoning(d.thinking);
        }
        if (typeof d.text === "string" && d.text) {
          content += d.text;
          cb.onDelta(d.text);
        }
        break;
      }
      case "message_delta": {
        const u = data.usage;
        if (u && typeof u === "object") {
          usage = {
            input: typeof u.input_tokens === "number" ? u.input_tokens : usage?.input,
            output: typeof u.output_tokens === "number" ? u.output_tokens : usage?.output,
            cost: usage?.cost,
          };
        }
        break;
      }
      case "error":
        throw new Error(
          `${endpoint.providerLabel} : ${String(data.error?.message ?? "erreur de flux")}`
        );
      default:
        break;
    }
  };

  try {
    for (;;) {
      if (cb.signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      guard.reset(value.byteLength);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    // Fin de flux sans \n final (revue 95) : le résidu du buffer — le
    // dernier jeton ou l'objet usage de la dernière trame SSE — était
    // perdu si le serveur clôturait le flux sans sauter de ligne.
    if (buffer.trim()) consume(buffer);
  } catch (err) {
    // Stop utilisateur pendant le vol : on rend le partiel reçu. Une garde
    // d'inactivité déclenchée n'est PAS un arrêt utilisateur : le motif
    // parlant remonte tel quel.
    if (!cb.signal.aborted) throw err;
  } finally {
    guard.done();
  }
  return { content, reasoning, model, provider: endpoint.providerLabel, usage };
}
