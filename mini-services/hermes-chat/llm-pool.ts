// Pools de clés fournisseurs → tours LLM réels (v2.3, cf. FORK.md §7.4).
// Le moteur local consomme ENFIN le porte-clés du volet Paramètres : les tours
// partent sur l'API du fournisseur (clé choisie par la stratégie, compteur
// d'usage entretenu), la liste des modèles devient vivante (GET /models) et la
// compaction suit le même chemin. Sans fournisseur actif ni agent Hermes,
// le tour échoue avec un message clair — aucun LLM simulé (démo supprimée).
//
// Formats supportés :
//  - OpenAI-compatible (z.ai, OpenRouter, Mistral, OpenAI, DeepSeek, Groq,
//    Ollama, adresses personnalisées) : POST {base}/chat/completions, SSE.
//  - Anthropic (messages API) : POST {base}/messages, SSE événementiel.
// Le mini-service reste le SEUL détenteur des secrets (providers.ts) — aucune
// clé ne quitte ce module, seuls les ids/vues masquées circulent.
import type { KeyRow, ProviderRow, Store } from "./store";
import type { ModelOption, ModelsResult, ProviderStrategy } from "./types";
import {
  LOCAL_BASE_PROMPT,
  attachmentNote,
  parseSseLine,
  type TurnCallbacks,
  type TurnRequest,
} from "./local-engine";
import {
  pickActiveKey,
  providerCapabilities,
  looksLikeZaiJwt,
  explainQuotaError,
  applyExplicitBase,
  ZAI_CODING_BASE,
  ZAI_STANDARD_BASE,
} from "./providers";
import { readAttachmentDataUrl } from "./uploads";

// ── Types publics du pool ─────────────────────────────────────────────

/** Jetons consommés par un tour (rempli passivement si l'API le renvoie). */
export interface TurnUsage {
  input?: number;
  output?: number;
  /** Coût USD facturé, quand le fournisseur le renvoie (p. ex. OpenRouter). */
  cost?: number;
}

/** Résultat d'un tour exécuté par le pool. */
export interface PoolTurnResult {
  content: string;
  reasoning: string;
  /** Modèle réellement utilisé (id renvoyé par l'API, repli : id demandé). */
  model: string;
  /** Nom canonique du fournisseur (affichage, p. ex. « z.ai »). */
  provider: string;
  usage?: TurnUsage;
}

/** Contrat consommé par le connecteur (hermes-connector.ts). */
/** Tour LLM en vol — suivi interne, alimenté à chaque octet par la garde. */
interface StreamTraceEntry {
  provider: string;
  model: string;
  startedAt: number;
  lastByteAt: number;
  bytes: number;
}

/** Instantané public d'un tour en vol — /diagnostics (F-31ter) tranche
 *  « fournisseur lent » (octets récents) vs « mort » (silence long) PENDANT
 *  le tour, sans attendre la garde d'inactivité. */
export interface PoolStreamSnapshot {
  provider: string;
  model: string;
  /** Secondes depuis le lancement du tour. */
  startedAgoS: number;
  /** Secondes depuis le DERNIER octet reçu du fournisseur. */
  lastByteAgeS: number;
  /** Octets bruts reçus (encadrement SSE compris). */
  bytes: number;
}

export interface LlmPoolApi {
  listModels(): Promise<ModelsResult | null>;
  runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<PoolTurnResult | null>;
  summarize(history: { role: "user" | "assistant"; content: string }[]): Promise<string | null>;
  /** Vide les caches de liste (appelé quand le porte-clés change). */
  invalidate(): void;
  /** Noms des fournisseurs LLM actionnables (clé active ou keyless) —
   *  alimente la carte de statut honnête de la sidebar (v2.4). */
  activeProviderNames(): string[];
  /** Tours LLM en vol à l'instant T — section pool du pont de dépannage. */
  activeStreams(): PoolStreamSnapshot[];
}

// ── Endpoints LLM connus ───────────────────────────────────────────────

interface LlmEndpoint {
  base: string;
  style: "openai" | "anthropic";
  auth: "bearer" | "x-api-key" | "none";
  extraHeaders?: Record<string, string>;
  keyless: boolean;
  providerLabel: string;
}

const KNOWN_LLM_BASES: Record<string, string> = {
  "z.ai": ZAI_STANDARD_BASE,
  // v2.5 : preset dédié du sélecteur — la surface coding est la base
  // CANONIQUE de ce fournisseur (clés d'abonnement GLM Coding Plan).
  "z.ai Coding Plan": ZAI_CODING_BASE,
  opencode: "https://opencode.ai/inference/openai/v1",
  OpenRouter: "https://openrouter.ai/api/v1",
  Anthropic: "https://api.anthropic.com/v1",
  Mistral: "https://api.mistral.ai/v1",
  OpenAI: "https://api.openai.com/v1",
  DeepSeek: "https://api.deepseek.com",
  Groq: "https://api.groq.com/openai/v1",
};

// Surface « coding » de z.ai : celle que les clés GLM Coding Plan
// acceptent (docs.z.ai/devpack — Tool Integration). Une clé Coding Plan
// testée sur paas/v4 est refusée. v2.5 : la bascule peut aussi venir du
// test de clé (migrateBaseUrl → base_url explicite) pour les clés Coding
// Plan au format standard — cf. providers.ts.

// Repli documenté si la surface coding n'expose pas /models : modèles GLM
// cités par la documentation du Coding Plan (glm-5.3, glm-5.3-flash, glm-5.2
// et glm-4.6/4.5) — la liste vivante reste prioritaire dès qu'elle répond.
const ZAI_CODING_FALLBACK_MODELS = [
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-4.6",
  "glm-4.5",
];

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** https requis, ou http strictement local (même règle que le test de clé,
 *  providers.ts — le moteur ne doit pas servir de sonde vers le réseau). */
function safeBase(base: string): URL | null {
  try {
    const u = new URL(base);
    const local =
      u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u;
    return null;
  } catch {
    return null;
  }
}

/** Résout un fournisseur enregistré en endpoint d'appel. null = pas un LLM
 *  parlant (ou adresse refusée) — le fournisseur est exclu du pool. */
function resolveLlmEndpoint(row: ProviderRow): LlmEndpoint | null {
  const caps = providerCapabilities(row.name, row.base_url);
  let base: string | null = null;
  let style: "openai" | "anthropic" = "openai";
  let auth: "bearer" | "x-api-key" | "none" = "bearer";
  let extraHeaders: Record<string, string> | undefined;
  let keyless = false;
  let providerLabel = row.name;

  if (caps && caps.kind === "llm" && KNOWN_LLM_BASES[caps.name]) {
    providerLabel = caps.name;
    base = KNOWN_LLM_BASES[caps.name];
    if (caps.name === "Anthropic") {
      style = "anthropic";
      auth = "x-api-key";
      extraHeaders = { "anthropic-version": "2023-06-01" };
    }
    if (caps.keyless) {
      // Ollama : API compatible sur /v1, aucune clé nécessaire.
      keyless = true;
      auth = "none";
      base = `${caps.defaultBaseUrl ?? "http://localhost:11434"}/v1`;
    }
  }
  // L'adresse saisie par l'utilisatrice gagne sur l'adresse canonique
  // (v2.5, même règle que le test de clé — providers.ts, applyExplicitBase) :
  //  • champ non modifié (identique au canon) → canon ;
  //  • adresse avec CHEMIN → base COMPLÈTE, utilisée telle quelle (détail
  //    éditable demandé : bascule z.ai vers la surface coding, proxy
  //    précis…) ;
  //  • origine seule → seul l'hôte du canon est remplacé (proxy, auto-
  //    hébergé) — le chemin canonique fait partie du contrat (/api/paas/v4
  //    chez z.ai, /inference/openai/v1 chez opencode, /v1 chez Anthropic…).
  // Fournisseur personnalisé : l'adresse est la base complète (convention
  // OpenAI, base + /chat/completions). Ollama (sans clé) : l'adresse
  // désigne le serveur, la surface /v1 du moteur est conservée.
  // Sans cette règle, le bouton « Tester » validait {origine}/api/paas/v4/models
  // pendant que le moteur appelait {origine}/models — deux adresses différentes
  // pour la même clé (constaté avec la clé z.ai réelle, 2026-11-15).
  if (row.base_url && /^https?:\/\//i.test(row.base_url)) {
    const explicit = trimSlash(row.base_url);
    const canonical = caps && caps.kind === "llm" ? KNOWN_LLM_BASES[caps.name] : undefined;
    if (keyless) {
      base = /\/v1$/.test(explicit) ? explicit : `${explicit}/v1`;
    } else if (canonical) {
      base = applyExplicitBase(canonical, canonical, explicit);
    } else {
      base = explicit;
    }
  }
  if (!base) return null;
  if (!safeBase(base)) return null;
  return { base: trimSlash(base), style, auth, extraHeaders, keyless, providerLabel };
}

/** z.ai : une clé Coding Plan (JWT) ne parle qu'à la surface « coding » —
 *  l'endpoint est réécrit pour la clé effectivement choisie. Les clés API
 *  (format xxxxxxxx.yyyyyyyy) restent sur la surface standard paas/v4…
 *  SAUF base explicite (preset « z.ai Coding Plan », bascule automatique
 *  du test de clé) : la base enregistrée fait foi. Une adresse
 *  EXPLICITEMENT saisie (proxy, serveur local) garde son origine — seul
 *  le chemin passe à la surface coding. */
function routeZaiCoding(endpoint: LlmEndpoint, secret: string | null): LlmEndpoint {
  if (endpoint.providerLabel !== "z.ai" || !secret || !looksLikeZaiJwt(secret)) {
    return endpoint;
  }
  if (endpoint.base === ZAI_CODING_BASE) return endpoint;
  if (endpoint.base === ZAI_STANDARD_BASE) {
    return {
      ...endpoint,
      base: ZAI_CODING_BASE,
      style: "openai",
      auth: "bearer",
      extraHeaders: undefined,
    };
  }
  // Origine explicite conservée, chemin codé en dur vers la surface coding.
  try {
    const u = new URL(endpoint.base);
    return {
      ...endpoint,
      base: `${u.origin}/api/coding/paas/v4`,
      style: "openai",
      auth: "bearer",
      extraHeaders: undefined,
    };
  } catch {
    return endpoint;
  }
}

// ── Erreurs du pool ────────────────────────────────────────────────────

/** Erreur d'authentification : la clé est déclassée puis une autre est tentée. */
class PoolAuthError extends Error {
  constructor(
    message: string,
    readonly exhausted: boolean,
    readonly keyLabel: string,
  ) {
    super(message);
    this.name = "PoolAuthError";
  }
}

// ── Aides d'analyse des réponses ────────────────────────────────────────

/** Modèles non-chat à écarter de la liste (embeddings, TTS, rerank…). */
const NON_CHAT = /embed|rerank|bge-|tts|asr|speech|voice|audio|guard|moderation/i;

/** Extrait tolérant d'une liste de modèles (openai / anthropic / v1). */
function parseModelList(json: unknown, provider: string): ModelOption[] {
  const out: ModelOption[] = [];
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const arr = (j.data ?? j.models) as unknown;
  if (!Array.isArray(arr)) return out;
  for (const m of arr) {
    const id = typeof m === "string" ? m : (m as any)?.id ?? (m as any)?.name;
    if (typeof id !== "string" || !id || NON_CHAT.test(id)) continue;
    if (out.some((x) => x.id === id)) continue;
    const label =
      typeof m === "object" && m
        ? ((m as any).display_name ?? (m as any).label ?? (m as any).name)
        : undefined;
    out.push({
      id,
      label: typeof label === "string" && label ? label : id,
      provider,
    });
  }
  return out;
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

/** Modèle de repli pour un tour multimodal, si la liste en expose un. */
const VISION_MODEL = /(-v\b|vision|glm-4v|glm-4\.5v|glm-4\.6v)/i;
function isVisionModel(id: string): boolean {
  return VISION_MODEL.test(id);
}

// ── Construction du pool ───────────────────────────────────────────────

export function createLlmPool(store: Store): LlmPoolApi {
  // Cache des listes par fournisseur (vidé par invalidate()).
  const modelsCache = new Map<string, ModelOption[] | null>();
  // Tours LLM en vol — rempli par stallGuard à chaque lancement, vidé en
  // finally à chaque fin ; alimente la section pool de /diagnostics (F-31ter).
  const activeStreamEntries = new Set<StreamTraceEntry>();
  // Adresses déjà signalées (évite les logs en boucle).
  const warned = new Set<string>();

  /** Lignes de clés adaptées au contrat de pickActiveKey (providers.ts). */
  function keyCandidates(row: ProviderRow): KeyRow[] {
    return store.listKeyRows(row.id);
  }

  function pickKey(row: ProviderRow): KeyRow | null {
    const keys = keyCandidates(row).map((k) => ({
      id: k.id,
      status: k.status as import("./types").KeyStatus,
      position: k.position,
      usedCount: k.used_count,
      raw: k,
    }));
    const picked = pickActiveKey(row.id, row.strategy as ProviderStrategy, keys);
    return picked ? picked.raw : null;
  }

  /** Fournisseurs LLM actionnables : endpoint résolu + clé dispo (ou keyless). */
  function activeLlmProviders(): { row: ProviderRow; endpoint: LlmEndpoint }[] {
    const out: { row: ProviderRow; endpoint: LlmEndpoint }[] = [];
    for (const row of store.listProviderRows()) {
      if (row.kind !== "llm") continue;
      const endpoint = resolveLlmEndpoint(row);
      if (!endpoint) continue;
      if (endpoint.keyless) {
        out.push({ row, endpoint });
        continue;
      }
      const keys = keyCandidates(row);
      const available = keys.some((k) => k.status === "ok" || k.status === "untested");
      if (available) out.push({ row, endpoint });
    }
    return out;
  }

  /** Liste des modèles d'un fournisseur (cache, GET /models, 8 s). Les
   *  clés Coding Plan de z.ai interrogent la surface coding ; si elle
   *  n'expose pas de liste, le repli documenté sert de liste vivante. */
  async function providerModels(
    row: ProviderRow,
    endpoint: LlmEndpoint,
  ): Promise<ModelOption[] | null> {
    const cached = modelsCache.get(row.id);
    if (cached !== undefined) return cached;
    let result: ModelOption[] | null = null;
    try {
      const key = endpoint.keyless ? null : pickKey(row);
      const routed = routeZaiCoding(endpoint, key?.secret ?? null);
      const res = await fetch(`${routed.base}/models`, {
        headers: {
          ...(routed.auth === "bearer" && key
            ? { Authorization: `Bearer ${key.secret}` }
            : {}),
          ...(routed.auth === "x-api-key" && key ? { "x-api-key": key.secret } : {}),
          ...(routed.extraHeaders ?? {}),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        result = parseModelList(await res.json(), routed.providerLabel);
      } else if (!warned.has(`${row.id}:models`)) {
        warned.add(`${row.id}:models`);
        console.warn(
          `[hermes-chat] liste indisponible pour ${row.name} (HTTP ${res.status}) — fournisseur ignoré`
        );
      }
    } catch {
      if (!warned.has(`${row.id}:models`)) {
        warned.add(`${row.id}:models`);
        console.warn(
          `[hermes-chat] ${row.name} injoignable pour la liste des modèles — fournisseur ignoré`
        );
      }
    }
    // Repli z.ai Coding Plan : la liste vivante a échoué (surface sans
    // /models ou indisponible) — les modèles documentés du plan prennent
    // le relais pour ne jamais bloquer la sélection de l'utilisatrice.
    // v2.5 : la surface coding se reconnaît à la base routée (preset
    // « z.ai Coding Plan », bascule du test de clé, ou jeton JWT).
    if (!result || result.length === 0) {
      const keyForFallback = endpoint.keyless ? null : pickKey(row);
      const routedForFallback = routeZaiCoding(endpoint, keyForFallback?.secret ?? null);
      const codingSurface =
        routedForFallback.providerLabel === "z.ai Coding Plan" ||
        /\/api\/coding\/paas\/v4$/.test(routedForFallback.base);
      if (keyForFallback && codingSurface) {
        if (!warned.has(`${row.id}:fallback`)) {
          warned.add(`${row.id}:fallback`);
          console.warn(
            `[hermes-chat] ${row.name} : liste coding indisponible — repli documenté (${ZAI_CODING_FALLBACK_MODELS.join(", ")})`
          );
        }
        result = ZAI_CODING_FALLBACK_MODELS.map((id) => ({
          id,
          label: id,
          provider: endpoint.providerLabel,
        }));
      }
    }
    modelsCache.set(row.id, result);
    return result;
  }

  /** Contenu utilisateur du tour (texte + note des pièces jointes, ou
   *  content parts multimodal quand le tour porte des images). */
  function buildUserPayload(
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

  // Garde d'inactivité des tours fournisseur : la gateway a son timeout de
  // tour (180 s) et le webchat son délai global de pilote — sans garde, une
  // connexion fournisseur qui s'enraye (aucune réponse, ou des octets qui
  // cessent) bloque le tour indéfiniment. C'est une garde d'INACTIVITÉ : le
  // minuteur repart à chaque octet reçu — une réponse longue mais vivante
  // reste licite, un fournisseur muet est coupé avec un motif parlant.
  // Surcharge par env pour les preuves (jamais en production).
  const TURN_STALL_TIMEOUT_MS = Math.max(
    5_000,
    Number(process.env.HERMES_TURN_STALL_MS) || 120_000,
  );

  /** Signal combiné pour un tour streaming : annulation utilisateur (cb.signal)
   *  + minuteur d'inactivité. reset() repart le minuteur (octet reçu) ;
   *  done() nettoie à la fin du tour. Le déclenchement annule le fetch avec un
   *  motif parlant — l'erreur remonte telle quelle jusqu'à l'interface. */
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

  /** POST {base}/chat/completions en streaming (style openai). */
  async function streamOpenAiTurn(
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
      res = await fetch(`${endpoint.base}/chat/completions`, {
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
    } catch (err) {
      guard.done();
      throw err;
    }
    // Les en-têtes sont arrivés : le fournisseur vit — le minuteur repart
    // pour la lecture du flux.
    guard.reset();
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
  async function streamAnthropicTurn(
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
      res = await fetch(`${endpoint.base}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(endpoint.auth === "x-api-key" && secret ? { "x-api-key": secret } : {}),
          ...(endpoint.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: guard.signal,
      });
    } catch (err) {
      guard.done();
      throw err;
    }
    // Les en-têtes sont arrivés : le fournisseur vit — le minuteur repart
    // pour la lecture du flux.
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

  // ── runTurn : résolution fournisseur + porte-clés ────────────────────

  async function runTurn(
    req: TurnRequest,
    cb: TurnCallbacks,
  ): Promise<PoolTurnResult | null> {
    const actives = activeLlmProviders();
    if (actives.length === 0) return null;

    // 1. Le modèle demandé appartient-il à un fournisseur actif ?
    let chosen: { row: ProviderRow; endpoint: LlmEndpoint } | null = null;
    let modelId: string | null = null;
    let chosenList: ModelOption[] | null = null;
    if (req.modelId) {
      for (const a of actives) {
        const list = await providerModels(a.row, a.endpoint);
        const hit = list?.find((m) => m.id === req.modelId);
        if (hit) {
          chosen = a;
          modelId = hit.id;
          chosenList = list ?? null;
          break;
        }
      }
    }
    // 2. Sinon : le premier fournisseur actif qui expose des modèles, et son
    //    premier modèle. La sélection de l'utilisatrice (p. ex. un id du
    //    catalogue Hermes) ne peut pas partir telle quelle sur l'API — le
    //    message persistera le modèle RÉELLEMENT utilisé.
    if (!chosen) {
      for (const a of actives) {
        const list = await providerModels(a.row, a.endpoint);
        if (list && list.length > 0) {
          chosen = a;
          modelId = list[0].id;
          chosenList = list;
          break;
        }
      }
    }
    if (!chosen || !modelId) return null;

    // 3. Porte-clés : jusqu'à 3 tentatives (la clé fautive est déclassée,
    //    la stratégie propose la suivante). Ollama (keyless) passe sans clé.
    let lastAuthLabel: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = chosen.endpoint.keyless ? null : pickKey(chosen.row);
      if (!chosen.endpoint.keyless && !key) {
        throw new Error(
          lastAuthLabel
            ? `${chosen.endpoint.providerLabel} : ${lastAuthLabel} — plus aucune clé disponible`
            : `${chosen.endpoint.providerLabel} : aucune clé disponible (ajoutez ou testez une clé dans Paramètres)`
        );
      }
      const secret = key?.secret ?? null;
      // z.ai Coding Plan : la clé choisie décide de la surface (coding vs
      // paas/v4) — le routage se fait ici, clé en main.
      const turnEndpoint = routeZaiCoding(chosen.endpoint, secret);
      try {
        const result =
          turnEndpoint.style === "anthropic"
            ? await streamAnthropicTurn(turnEndpoint, secret, modelId, req, cb)
            : await streamOpenAiTurn(turnEndpoint, secret, modelId, req, cb);
        if (key) store.markKeyUsed(key.id);
        console.log(
          `[hermes-chat] tour fournisseur : ${chosen.endpoint.providerLabel}/${result.model}` +
            (key ? ` (clé « ${key.label} »)` : "")
        );
        return result;
      } catch (err) {
        if (err instanceof PoolAuthError) {
          if (key) store.setKeyStatus(key.id, err.exhausted ? "exhausted" : "error", err.keyLabel);
          lastAuthLabel = err.message;
          console.warn(`[hermes-chat] ${err.message} — clé « ${key?.label ?? "?"} » déclassée`);
          continue; // retente avec la clé suivante
        }
        // Modèle non vision alors que le tour porte des images : une seule
        // retente sur un modèle vision de la liste, si elle en expose un.
        const hasImages = (req.attachments ?? []).some((a) => a.kind === "image");
        const msg = err instanceof Error ? err.message : String(err);
        if (
          hasImages &&
          !isVisionModel(modelId) &&
          /image|vision|multimodal|content.?parts/i.test(msg) &&
          chosenList?.some((m) => isVisionModel(m.id))
        ) {
          const vision = chosenList.find((m) => isVisionModel(m.id))!;
          console.warn(
            `[hermes-chat] ${modelId} ne supporte pas les images — retente sur ${vision.id}`
          );
          modelId = vision.id;
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      lastAuthLabel
        ? `${chosen.endpoint.providerLabel} : ${lastAuthLabel} — plus aucune clé disponible`
        : `${chosen.endpoint.providerLabel} : impossible d'exécuter le tour`
    );
  }

  // ── listModels : listes vivantes des fournisseurs actifs ─────────────

  async function listModels(): Promise<ModelsResult | null> {
    const actives = activeLlmProviders();
    const models: ModelOption[] = [];
    for (const a of actives) {
      const list = await providerModels(a.row, a.endpoint);
      if (list) models.push(...list);
    }
    if (models.length === 0) return null;
    return { models, defaultModel: models[0].id, source: "providers" };
  }

  // ── summarize : compaction via le pool (repli SDK sinon) ─────────────

  async function summarize(
    history: { role: "user" | "assistant"; content: string }[],
  ): Promise<string | null> {
    const actives = activeLlmProviders();
    if (actives.length === 0) return null;
    // Premier fournisseur actif exposant des modèles.
    for (const a of actives) {
      const list = await providerModels(a.row, a.endpoint);
      if (!list || list.length === 0) continue;
      const key = a.endpoint.keyless ? null : pickKey(a.row);
      if (!a.endpoint.keyless && !key) continue;
      const secret = key?.secret ?? null;
      const sumEndpoint = routeZaiCoding(a.endpoint, secret);
      const prompt =
        "Résume la conversation suivante pour la suite d'une session de chat avec un agent. " +
        "Conserve : le sujet et l'objectif, les décisions prises, les fichiers/artefacts produits " +
        "(noms), les contraintes et préférences de l'utilisateur, et les prochaines étapes en cours. " +
        "Réponds en français, en 10 lignes maximum, sans préambule.\n\n" +
        history
          .map((m) => `${m.role === "user" ? "Utilisateur" : "Hermes"} : ${m.content}`)
          .join("\n\n")
          .slice(0, 60_000);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...(a.endpoint.auth === "bearer" && secret ? { Authorization: `Bearer ${secret}` } : {}),
          ...(a.endpoint.auth === "x-api-key" && secret ? { "x-api-key": secret } : {}),
          ...(a.endpoint.extraHeaders ?? {}),
        };
        let text = "";
        if (sumEndpoint.style === "anthropic") {
          const res = await fetch(`${sumEndpoint.base}/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: list[0].id,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 1024,
            }),
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = (await res.json()) as any;
          text = (j?.content ?? [])
            .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
            .join("\n")
            .trim();
        } else {
          const res = await fetch(`${sumEndpoint.base}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: list[0].id,
              messages: [{ role: "user", content: prompt }],
            }),
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = (await res.json()) as any;
          text = String(j?.choices?.[0]?.message?.content ?? "").trim();
        }
        if (key) store.markKeyUsed(key.id);
        if (text) {
          console.log(
            `[hermes-chat] compaction via ${a.endpoint.providerLabel}/${list[0].id}` +
              (key ? ` (clé « ${key.label} »)` : "")
          );
          return text;
        }
      } catch (err) {
        console.warn(
          `[hermes-chat] compaction via ${a.endpoint.providerLabel} impossible :`,
          err instanceof Error ? err.message : err
        );
      }
    }
    return null;
  }

  function invalidate(): void {
    modelsCache.clear();
  }

  function activeProviderNames(): string[] {
    const names = new Set<string>();
    for (const { endpoint } of activeLlmProviders()) names.add(endpoint.providerLabel);
    return [...names];
  }

  /** Instantané des tours LLM en vol (F-31ter) — vide une fois le vol fini. */
  function activeStreams(): PoolStreamSnapshot[] {
    const now = Date.now();
    return [...activeStreamEntries].map((e) => ({
      provider: e.provider,
      model: e.model,
      startedAgoS: Math.round((now - e.startedAt) / 1000),
      lastByteAgeS: Math.round((now - e.lastByteAt) / 1000),
      bytes: e.bytes,
    }));
  }

  return { listModels, runTurn, summarize, invalidate, activeProviderNames, activeStreams };
}
