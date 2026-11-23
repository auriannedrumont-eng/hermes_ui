// Connecteur moteur Hermes — la gateway est le chemin UNIQUE du chat :
// - URL automatique par défaut (ws://127.0.0.1:9120/api/ws) : lancer l'agent
//   Hermes suffit, rien à saisir. HERMES_GATEWAY_URL ou l'URL de l'interface
//   (Paramètres → Système) ne servent qu'aux installations spéciales.
// - Les tours parlent le protocole de la gateway (WebSocket `/api/ws`,
//   enveloppe `api_turn_v1`, deltas de stream / événements d'outils /
//   raisonnement). Sans agent lancé, re-sonde silencieuse à chaque tour
//   (l'agent démarre plus tard → ça se branche tout seul).
// - Sans gateway, les clés fournisseurs actives répondent (vrais modèles,
//   réels) ; sans gateway NI clé, le tour échoue avec un message clair —
//   JAMAIS de LLM simulé (mode démo supprimé).
// - `listModels()` interroge l'API REST de la gateway
//   (GET /api/model/options) et retombe sur le catalogue Hermes.
import WebSocket from "ws";
import { catalogModelsResult } from "./models";
import type { LlmPoolApi, PoolTurnResult, TurnUsage } from "./llm-pool";
import type { Attachment, GatewayMode, ModelOption, ModelsResult } from "./types";
import type { TurnCallbacks, TurnRequest } from "./local-engine";

// URL par défaut : l'agent Hermes lancé localement (gateway/run_api.py).
// Priorité : interface (Paramètres → Système) > HERMES_GATEWAY_URL > défaut.
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:9120/api/ws";
const ENV_GATEWAY_URL = process.env.HERMES_GATEWAY_URL ?? null;
const ENV_GATEWAY_TOKEN = process.env.HERMES_GATEWAY_TOKEN ?? null;
const HANDSHAKE_TIMEOUT_MS = 3000;
const REPROBE_TIMEOUT_MS = 1500;
const TURN_TIMEOUT_MS = 180_000;
const MODELS_TIMEOUT_MS = 4000;

function toWsUrl(url: string): string {
  // `replace(/^http/i, "ws")` convertit déjà http→ws et https→wss :
  // re-préfixer par `ws://` produisait `ws://ws://…` / `ws://wss://…`
  // (URL invalide). Une URL déjà en ws:// ou wss:// (sans /api/ws) est
  // désormais complétée elle aussi.
  const clean = url.trim().replace(/^http/i, "ws").replace(/\/+$/, "");
  return clean.endsWith("/api/ws") ? clean : `${clean}/api/ws`;
}

// Exporté pour la sonde REST « sessions natives » (motor-sessions.ts) :
// même base HTTP que la gateway du chat, déjà résolue ici.
export function toHttpBase(url: string): string {
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

/** Erreur claire quand ni l'agent Hermes ni une clé fournisseur ne répondent. */
function noEngineError(): Error {
  return new Error(
    "Agent Hermes non détecté (défaut ws://127.0.0.1:9120/api/ws) — lancez l'agent " +
      "(gateway/run_api.py du dépôt hermes-agent) ; il se branche automatiquement. " +
      "Ou ajoutez une clé fournisseur dans Paramètres → Fournisseurs & clés."
  );
}

/** Résultat d'un tour, augmenté du moteur qui l'a produit. */
export interface TurnOutcome {
  content: string;
  reasoning: string;
  model: string;
  /** Moteur qui a répondu : pool de clés fournisseurs ou gateway. */
  engine?: "pool" | "gateway";
  /** Fournisseur du pool (p. ex. « z.ai ») quand engine = "pool". */
  provider?: string;
  /** Jetons consommés par le tour (F-21), quand l'API les renvoie. */
  usage?: TurnUsage;
}

export class HermesConnector {
  mode: GatewayMode = "local";
  /** URL de gateway active (interface > environnement > défaut automatique). */
  gatewayUrl: string | null = ENV_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
  gatewayToken: string | null = ENV_GATEWAY_TOKEN;
  model = "hermes (gateway)";
  private modelsCache: ModelsResult | null = null;
  private pool: LlmPoolApi | null = null;
  /** Dernière re-sonde infructueuse : throttle (une par 10 s max). */
  private lastReprobe = 0;

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
  }

  /** Branche (ou débranche, url vide/null) la gateway depuis l'interface :
   *  re-sonde la nouvelle URL et bascule le mode en conséquence. URL vide =
   *  retour au défaut automatique (l'agent lancé localement se branche seul).
   *  S-02 : changer l'URL SANS ressaisir de jeton n'envoie JAMAIS l'ancien
   *  jeton secret à la nouvelle destination — il est effacé (l'utilisateur
   *  le ressaisira si la nouvelle gateway en demande un). */
  async setGateway(
    url: string | null,
    token?: string | null
  ): Promise<GatewayMode> {
    const clean = typeof url === "string" ? url.trim() : "";
    const previousUrl = this.gatewayUrl;
    const nextUrl = clean || ENV_GATEWAY_URL || DEFAULT_GATEWAY_URL;
    const urlChanged = nextUrl !== previousUrl;
    if (token !== undefined) {
      this.gatewayToken =
        typeof token === "string" && token.trim() ? token.trim() : null;
    } else if (urlChanged) {
      // Jeton conservé seulement si l'URL ne change pas : vers une NOUVELLE
      // destination, l'ancien secret ne part jamais sans accord explicite.
      this.gatewayToken = null;
    }
    this.gatewayUrl = nextUrl;
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
        { redirect: "error",
          signal: controller.signal,
          headers: this.gatewayToken
            ? { Authorization: `Bearer ${this.gatewayToken}` }
            : undefined,
        }
      );
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
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

  private probe(timeoutMs: number = HANDSHAKE_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try {
          ws.removeAllListeners();
          // Lot 2 (famille audit L2-8) : fermer une socket ENCORE EN CONNEXION
          // fait émettre un « error » par la lib ws — sans listener, le
          // processus ENTIER meurt (Unhandled error), ce qui tuait le service
          // à chaque gateway:set vers une adresse qui stalle. Un no-op absorbe.
          ws.on("error", () => {});
          ws.on("close", () => {});
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(ok);
      };
      const ws = new WebSocket(toWsUrl(this.gatewayUrl!), {
        headers: this.gatewayToken ? { Authorization: `Bearer ${this.gatewayToken}` } : undefined,
        handshakeTimeout: timeoutMs,
      });
      const timer = setTimeout(() => done(false), timeoutMs);
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

  /** Re-sonde silencieuse (throttlée) : l'agent lancé APRÈS le service se
   *  branche tout seul au tour suivant — aucune action utilisateur. */
  private async reprobeIfOffline(): Promise<void> {
    if (this.mode === "gateway" || !this.gatewayUrl) return;
    const now = Date.now();
    if (now - this.lastReprobe < 10_000) return;
    this.lastReprobe = now;
    if (await this.probe(REPROBE_TIMEOUT_MS)) {
      this.mode = "gateway";
      console.log(
        `[hermes-chat] agent Hermes détecté sur ${this.gatewayUrl} → mode gateway`
      );
    }
  }

  /** Sonde IMMÉDIATE (loi « tout simplement », 2026-11-22) : après le
   *  démarrage automatique de l'agent par agent-starter, l'interface apprend
   *  TOUT DE SUITE que la gateway répond (hello rediffusé) — sans attendre
   *  le prochain tour. Ignore le throttle de 10 s (c'est le but). */
  async probeNow(): Promise<boolean> {
    this.lastReprobe = 0;
    await this.reprobeIfOffline();
    return this.mode === "gateway";
  }

  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnOutcome> {
    await this.reprobeIfOffline();
    if (this.mode === "gateway" && this.gatewayUrl) {
      // Chemin unique du chat : la gateway répond, ou l'erreur est affichée
      // telle quelle — jamais de repli silencieux vers un autre moteur.
      return await this.runGatewayTurn(req, cb);
    }
    // Sans agent lancé : clés fournisseurs actives (vrais modèles, réels).
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
    throw noEngineError();
  }

  /** Synthèse de compaction : pool de clés uniquement (pas de LLM simulé). */
  async summarize(
    history: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    if (this.pool) {
      const pooled = await this.pool.summarize(history);
      if (pooled) return pooled;
    }
    throw noEngineError();
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
      // true = la gateway a annoncé la fin (turn_end/complete/done). Une
      // fermeture SANS fin annoncée résout en erreur, pas en « succès » avec
      // un contenu tronqué présenté comme complet (Lot 1, audit L1-6).
      let endedProperly = false;
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
        cb.signal.removeEventListener("abort", onAbort);
        try {
          ws.removeAllListeners();
          // Lot 2 (famille audit L2-8) : même garde que la sonde — la
          // fermeture d'une WebSocket en connexion émet un « error » sans
          // listener qui tuerait le service.
          ws.on("error", () => {});
          ws.on("close", () => {});
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else if (cb.signal.aborted)
          // Stop utilisateur : le partiel reçu est rendu — le tour se clôt
          // avec le marqueur « stopped », pas une erreur (contrat index.ts).
          resolve({
            content,
            reasoning,
            model: req.model || "hermes (gateway)",
            engine: "gateway",
          });
        else if (!endedProperly)
          reject(new Error("Connexion gateway fermée avant la fin du tour"));
        else
          resolve({
            content,
            reasoning,
            model: req.model || "hermes (gateway)",
            engine: "gateway",
          });
      };

      // Stop utilisateur (Lot 1, audit L1-6) : l'abort est câblé à la
      // WebSocket — fermeture immédiate et partiel rendu, au lieu de courir
      // jusqu'au timeout 180 s avec un fil qui ne s'arrête jamais.
      const onAbort = () => finish();
      if (cb.signal.aborted) onAbort();
      else cb.signal.addEventListener("abort", onAbort, { once: true });

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
          // F-30 — Mode Plan : mise en plan demandée au premier tour
          // (tenté une fois, refus non bloquant — la consigne écrite du
          // mode reste la garantie).
          ...(req.settings?.planMode ? { plan_mode: true } : {}),
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
            endedProperly = true;
            finish();
          } else if (evt.includes("error")) {
            finish(new Error(String(data?.error ?? "Erreur gateway")));
          }
        }
        if (data?.done === true) {
          endedProperly = true;
          finish();
        }
      });

      ws.on("error", (err) => finish(err));
      ws.on("close", () => finish());
    });
  }
}
