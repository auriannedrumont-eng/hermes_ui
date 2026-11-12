// Connecteur gateway Hermes :
// - Si HERMES_GATEWAY_URL est défini, tente de parler le protocole de tour
//   de la gateway Hermes (WebSocket `/api/ws`, enveloppe `api_turn_v1`,
//   observation des deltas de stream / événements d'outils / raisonnement).
// - Sinon (ou en cas d'échec), bascule sur le moteur de démo intégré.
// - `listModels()` interroge l'API REST de la gateway
//   (GET /api/model/options) et retombe sur le catalogue Hermes.
import WebSocket from "ws";
import { DemoEngine } from "./demo-engine";
import { catalogModelsResult } from "./models";
import type { Attachment, GatewayMode, ModelOption, ModelsResult } from "./types";
import type { TurnCallbacks, TurnRequest } from "./demo-engine";

const GATEWAY_URL = process.env.HERMES_GATEWAY_URL ?? null;
const GATEWAY_TOKEN = process.env.HERMES_GATEWAY_TOKEN ?? null;
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
    out.push({
      id,
      label: typeof m === "string" ? id : (m?.label ?? m?.display_name ?? id),
      provider: (typeof m === "string" ? undefined : m?.provider) ?? provider ?? "Gateway",
      description:
        typeof m === "string"
          ? undefined
          : (m?.description ?? (m?.configured === false ? "Non configuré" : undefined)),
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

export class HermesConnector {
  mode: GatewayMode = "demo";
  gatewayUrl: string | null = GATEWAY_URL;
  model = "Hermes 4 70B (démo)";
  private demo = new DemoEngine();
  private modelsCache: ModelsResult | null = null;

  async init(): Promise<void> {
    if (!GATEWAY_URL) {
      this.mode = "demo";
      return;
    }
    const reachable = await this.probe();
    this.mode = reachable ? "gateway" : "demo";
    if (reachable) this.model = "hermes (gateway)";
  }

  /** Liste des modèles : depuis la gateway si joignable, sinon le catalogue. */
  async listModels(): Promise<ModelsResult> {
    if (this.mode === "gateway" && GATEWAY_URL) {
      const fromGateway = await this.fetchGatewayModels();
      if (fromGateway && fromGateway.models.length > 0) return fromGateway;
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
        `${toHttpBase(GATEWAY_URL!)}/api/model/options?include_unconfigured=1`,
        {
          signal: controller.signal,
          headers: GATEWAY_TOKEN
            ? { Authorization: `Bearer ${GATEWAY_TOKEN}` }
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
      const ws = new WebSocket(toWsUrl(GATEWAY_URL!), {
        headers: GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : undefined,
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

  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<{ content: string; reasoning: string; model: string }> {
    if (this.mode === "gateway" && GATEWAY_URL) {
      try {
        return await this.runGatewayTurn(req, cb);
      } catch {
        cb.onStatus("Gateway Hermes injoignable — basculement en mode démo…");
      }
    }
    const result = await this.demo.runTurn(req, cb);
    const label = result.model || this.model;
    this.model = `${label} (démo)`;
    return { ...result, model: label };
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
  ): Promise<{ content: string; reasoning: string; model: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let content = "";
      let reasoning = "";
      const ws = new WebSocket(toWsUrl(GATEWAY_URL!), {
        headers: GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : undefined,
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
          });
      };

      const timer = setTimeout(() => finish(new Error("Timeout du tour gateway")), TURN_TIMEOUT_MS);

      ws.on("open", () => {
        cb.onStatus("Gateway Hermes connectée…");
        const attachments: Attachment[] | undefined = req.attachments?.length
          ? req.attachments
          : undefined;
        ws.send(
          JSON.stringify({
            text: req.content,
            api_turn_v1: {
              history: req.history,
              settings: req.modelId ? { requested_model: req.modelId } : {},
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
