// Connecteur moteur Hermes :
// - Si une URL de gateway est configurée (Paramètres → Système, ou variable
//   HERMES_GATEWAY_URL en repli) et joignable, les tours parlent le protocole
//   de la gateway Hermes (WebSocket `/api/ws`, enveloppe `api_turn_v1`,
//   observation des deltas de stream / événements d'outils / raisonnement).
// - Sinon (ou en cas d'échec), le moteur local prend le relais : pool de clés
//   fournisseurs d'abord, LLM intégré (SDK) ensuite.
// - `listModels()` interroge l'API REST de la gateway
//   (GET /api/model/options) et retombe sur le catalogue Hermes.
import WebSocket from "ws";
import { LocalEngine } from "./local-engine";
import { catalogModelsResult } from "./models";
import type { LlmPoolApi, PoolTurnResult, TurnUsage } from "./llm-pool";
import type { Attachment, GatewayMode, ModelOption, ModelsResult } from "./types";
import type { TurnCallbacks, TurnRequest } from "./local-engine";

// Repli : variables d'environnement (l'URL saisie dans l'interface prime).
const ENV_GATEWAY_URL = process.env.HERMES_GATEWAY_URL ?? null;
const ENV_GATEWAY_TOKEN = process.env.HERMES_GATEWAY_TOKEN ?? null;
const HANDSHAKE_TIMEOUT_MS = 3000;
const TURN_TIMEOUT_MS = 180_000;
const MODELS_TIMEOUT_MS = 4000;

function toWsUrl(url: string): string {
  if (url.startsWith("ws://") || url.startsWith("wss://")) return url;
  if (url.endsWith("/api/ws")) return `ws://${url.replace(/^http/, "ws")}`;
  return `ws://${url.replace(/^http/, "ws").replace(/\/$/, "")}/api/ws`;
}

function toHttpBase(url: string): string {
  let base = url.replace(/^ws/, "http");
  if (base.endsWith("/api/ws")) base = base.slice(0, -"/api/ws".length);
  return base.replace(/\/$/, "");
}

/** Extrait tolérant d'une liste de modèles depuis la réponse de /api/model/options. */
function parseModelOptions(data: any): ModelOption[] {
  const out: ModelOption[] = [];
  const pushModel = (m: any, provider?: string) => {
    const id = typeof m === "string" ? m : (m?.id ?? m?.name ?? m?.model);
    if (!id || typeof id !== "string") return;
    if (out.some((x) => x.id === id)) return;
    if (typeof m === "string") {
      out.push({ id, label: id, provider: provider ?? "Gateway" });
      return;
    }
    // Échelle d'effort : tableau de crans (off, low…), booléen (budget) ou rien
    let efforts: string[] | undefined;
    const rawEfforts = m?.efforts ?? m?.effort_options ?? m?.reasoning_efforts;
    if (Array.isArray(rawEfforts) && rawEfforts.length > 0) {
      efforts = rawEfforts.map(String);
    } else if (rawEfforts === true) {
      efforts = ["off", "on"];
      // étiquette « budget » quand le provider expose un simple interrupteur
      m = { ...m, effortLabel: m?.effortLabel ?? "budget" };
    }
    // Fenêtre de contexte si exposée
    const rawWindow = m?.context_window ?? m?.contextWindow ?? m?.context_length;
    const contextWindow =
      typeof rawWindow === "number" && rawWindow > 0 ? rawWindow : undefined;
    out.push({
      id,
      label: m?.label ?? m?.display_name ?? id,
      provider: m?.provider ?? provider ?? "Gateway",
      description: m?.description ?? (m?.configured === false ? "Non configuré" : undefined),
      efforts,
      effortLabel: m?.effortLabel ?? m?.effort_label ?? undefined,
      contextWindow,
    });
  };
  const providers = data?.providers ?? data?.result?.providers;
  if (Array.isArray(providers)) {
    for (const p of providers) {
      const models = p?.models ?? p?.model_options;
      if (Array.isArray(models)) {
        for (const m of models) pushModel(m, p?.name ?? p?.id);
      }
    }
  }
  const flat = data?.models ?? data?.result?.models ?? data?.options;
  if (Array.isArray(flat)) {
    for (const m of flat) pushModel(m);
  }
  return out;
}

/** Erreur du moteur local rendue pédagogique : sur un poste sans bac à sable
 *  Z.ai, le SDK échoue faute de .z-ai-config — on oriente vers les clés. */
function friendlyLocalError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/z-ai-config|Configuration file not found/i.test(msg)) {
    return new Error(
      "Le moteur local n'a pas de LLM configuré sur cette machine (fichier .z-ai-config absent). " +
        "Ouvrez Paramètres → Fournisseurs & clés et ajoutez une clé, ou branchez la gateway Hermes " +
        "(Paramètres → Système) : les réponses viendront alors de l'agent réel."
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Résultat d'un tour, augmenté du moteur qui l'a produit. */
export interface TurnOutcome {
  content: string;
  reasoning: string;
  model: string;
  /** Moteur qui a répondu : pool de clés fournisseurs, LLM intégré (SDK), ou gateway. */
  engine?: "pool" | "sdk" | "gateway";
  /** Fournisseur du pool (p. ex. « z.ai ») quand engine = "pool". */
  provider?: string;
  /** Jetons consommés par le tour (F-21), quand l'API les renvoie. */
  usage?: TurnUsage;
}

export class HermesConnector {
  mode: GatewayMode = "local";
  /** URL de gateway active (saisie dans l'interface, repli environnement). */
  gatewayUrl: string | null = ENV_GATEWAY_URL;
  gatewayToken: string | null = ENV_GATEWAY_TOKEN;
  model = "Hermes (moteur local)";
  private engine = new LocalEngine();
  private modelsCache: ModelsResult | null = null;
  private pool: LlmPoolApi | null = null;

  /** Branche le pool de clés fournisseurs (v2.3) — appelé par le service. */
  attachPool(pool: LlmPoolApi): void {
    this.pool = pool;
  }

  /** Le porte-clés a changé : les listes vivantes sont invalidées. */
  invalidateModels(): void {
    this.pool?.invalidate();
  }

  async init(): Promise<void> {
    if (!this.gatewayUrl) {
      this.mode = "local";
      return;
    }
    const reachable = await this.probe();
    this.mode = reachable ? "gateway" : "local";
    if (reachable) this.model = "hermes (gateway)";
  }

  /** Branche (ou débranche, url vide/null) la gateway depuis l'interface :
   *  re-sonde la nouvelle URL et bascule le mode en conséquence. */
  async setGateway(
    url: string | null,
    token?: string | null
  ): Promise<GatewayMode> {
    const clean = typeof url === "string" ? url.trim() : "";
    this.gatewayUrl = clean || null;
    if (token !== undefined) {
      this.gatewayToken =
        typeof token === "string" && token.trim() ? token.trim() : null;
    }
    await this.init();
    return this.mode;
  }

  /** Liste des modèles : gateway si joignable, sinon pool vivant, sinon catalogue. */
  async listModels(): Promise<ModelsResult> {
    if (this.mode === "gateway" && this.gatewayUrl) {
      const fromGateway = await this.fetchGatewayModels();
      if (fromGateway && fromGateway.models.length > 0) return fromGateway;
    }
    // Moteur local : les fournisseurs à clé active exposent leurs vrais modèles.
    if (this.pool) {
      const pooled = await this.pool.listModels();
      if (pooled && pooled.models.length > 0) return pooled;
    }
    if (this.modelsCache?.source === "catalogue") return this.modelsCache;
    const result = catalogModelsResult();
    this.modelsCache = result;
    return result;
  }

  private async fetchGatewayModels(): Promise<ModelsResult | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
      const res = await fetch(
        `${toHttpBase(this.gatewayUrl!)}/api/model/options?include_unconfigured=1`,
        {
          signal: controller.signal,
          headers: this.gatewayToken
            ? { Authorization: `Bearer ${this.gatewayToken}` }
            : undefined,
        }
      );
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      const models = parseModelOptions(data);
      if (!models.length) return null;
      const result: ModelsResult = {
        models,
        defaultModel:
          (typeof data?.default === "string" && data.default) ||
          (typeof data?.current === "string" && data.current) ||
          models[0].id,
        source: "gateway",
      };
      this.modelsCache = result;
      return result;
    } catch {
      return null;
    }
  }

  private probe(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try {
          ws.removeAllListeners();
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(ok);
      };
      const ws = new WebSocket(toWsUrl(this.gatewayUrl!), {
        headers: this.gatewayToken ? { Authorization: `Bearer ${this.gatewayToken}` } : undefined,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
      const timer = setTimeout(() => done(false), HANDSHAKE_TIMEOUT_MS);
      ws.on("open", () => {
        clearTimeout(timer);
        done(true);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
    });
  }

  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnOutcome> {
    if (this.mode === "gateway" && this.gatewayUrl) {
      try {
        return await this.runGatewayTurn(req, cb);
      } catch {
        cb.onStatus("Gateway Hermes injoignable — réponse par le moteur local…");
      }
    }
    // Pool de clés fournisseurs d'abord (v2.3). Une erreur du pool ne retombe
    // PAS silencieusement sur le SDK : l'utilisatrice croirait parler au
    // modèle sélectionné. Repli SDK uniquement quand aucun fournisseur actif
    // n'existe (pool.runTurn → null).
    if (this.pool) {
      const pooled: PoolTurnResult | null = await this.pool.runTurn(req, cb);
      if (pooled) {
        this.model = `${pooled.model} · ${pooled.provider}`;
        return {
          content: pooled.content,
          reasoning: pooled.reasoning,
          model: pooled.model,
          engine: "pool",
          provider: pooled.provider,
          usage: pooled.usage,
        };
      }
    }
    try {
      const result = await this.engine.runTurn(req, cb);
      const label = result.model || this.model;
      this.model = label;
      return { ...result, model: label, engine: "sdk" };
    } catch (err) {
      throw friendlyLocalError(err);
    }
  }

  /** Synthèse de compaction : pool si possible, LLM intégré sinon. */
  async summarize(
    history: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    if (this.pool) {
      const pooled = await this.pool.summarize(history);
      if (pooled) return pooled;
    }
    try {
      return await this.engine.summarize(history);
    } catch (err) {
      throw friendlyLocalError(err);
    }
  }

  // Protocole de tour Hermes (cf. gateway/session_api_turn.py) :
  //   -> {"text": "...", "api_turn_v1": {"history": [...], "settings": {...},
  //        "attachments": [...]}}
  //   <- deltas de stream / événements d'outils / raisonnement / fin de tour
  // Les pièces jointes sont transmises dans l'enveloppe (le protocole Hermes
  // les supporte nativement : images, audio, vidéo, documents).
  private runGatewayTurn(
    req: TurnRequest,
    cb: TurnCallbacks
  ): Promise<TurnOutcome> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let content = "";
      let reasoning = "";
      const ws = new WebSocket(toWsUrl(this.gatewayUrl!), {
        headers: this.gatewayToken ? { Authorization: `Bearer ${this.gatewayToken}` } : undefined,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.removeAllListeners();
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else
          resolve({
            content,
            reasoning,
            model: req.model || "hermes (gateway)",
            engine: "gateway",
          });
      };

      const timer = setTimeout(() => finish(new Error("Timeout du tour gateway")), TURN_TIMEOUT_MS);

      ws.on("open", () => {
        cb.onStatus("Gateway Hermes connectée…");
        const attachments: Attachment[] | undefined = req.attachments?.length
          ? req.attachments
          : undefined;
        // Réglages additifs : requested_model + effort + permissions + prompt
        // système (F-11/F-19). L'échelle d'effort et les clés permissions sont
        // portées par le modèle / la gateway — ignorées sans dommage si non
        // supportées (clés à valider contre la gateway, cf. chantier
        // « Composer v2 »).
        const settings: Record<string, unknown> = {
          ...(req.modelId ? { requested_model: req.modelId } : {}),
          ...(req.settings?.reasoningEffort
            ? { reasoning_effort: req.settings.reasoningEffort }
            : {}),
          ...(req.settings?.permissionsMode
            ? { permissions: req.settings.permissionsMode }
            : {}),
          ...(req.systemPrompt ? { system_prompt: req.systemPrompt } : {}),
          // Mémoire utilisateur (F-18) : notes actives + apprentissage
          // automatique — clés à valider contre la gateway (même convention
          // que Composer v2 : ignorées sans dommage si non supportées).
          ...(req.settings?.memoryNotes
            ? { memory_notes: req.settings.memoryNotes }
            : {}),
          ...(req.settings?.memoryAutoLearn !== undefined
            ? { memory_auto_learn: req.settings.memoryAutoLearn }
            : {}),
          // Mode expert (F-22) : température / plafond de sortie / graine —
          // assainis côté service, ignorés sans dommage par la gateway.
          ...(req.settings?.temperature !== undefined
            ? { temperature: req.settings.temperature }
            : {}),
          ...(req.settings?.maxTokens !== undefined
            ? { max_tokens: req.settings.maxTokens }
            : {}),
          ...(req.settings?.seed !== undefined
            ? { seed: req.settings.seed }
            : {}),
        };
        ws.send(
          JSON.stringify({
            text: req.content,
            api_turn_v1: {
              history: req.history,
              settings,
              ...(attachments ? { attachments } : {}),
            },
          })
        );
      });

      ws.on("message", (raw) => {
        if (cb.signal.aborted) return finish();
        let data: any;
        try {
          data = JSON.parse(String(raw));
        } catch {
          return;
        }
        // Cartographie tolérante des événements de la gateway
        const delta: string | undefined =
          data?.stream_delta ?? data?.delta ?? data?.text ?? data?.content ?? data?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta && !data?.event && !data?.type) {
          content += delta;
          cb.onDelta(delta);
          return;
        }
        const think: string | undefined = data?.reasoning ?? data?.reasoning_delta ?? data?.choices?.[0]?.delta?.reasoning_content;
        if (typeof think === "string" && think) {
          reasoning += think;
          cb.onReasoning(think);
          return;
        }
        const evt = data?.event ?? data?.type;
        if (typeof evt === "string") {
          if (evt.includes("tool")) {
            cb.onToolEvent({
              name: data?.tool ?? data?.name ?? "outil",
              status: evt.includes("complete") || evt.includes("done") ? "done" : "running",
              detail: data?.detail,
            });
          } else if (evt.includes("status")) {
            cb.onStatus(String(data?.status ?? "Hermes travaille…"));
          } else if (evt.includes("turn_end") || evt.includes("complete") || evt.includes("done")) {
            if (typeof data?.text === "string" && data.text) {
              content = data.text;
              cb.onDelta("");
            }
            finish();
          } else if (evt.includes("error")) {
            finish(new Error(String(data?.error ?? "Erreur gateway")));
          }
        }
        if (data?.done === true) finish();
      });

      ws.on("error", (err) => finish(err));
      ws.on("close", () => finish());
    });
  }
}
