// Connecteur moteur Hermes — la gateway est le chemin UNIQUE du chat :
// - URL automatique par défaut (ws://127.0.0.1:9120/api/ws) : lancer l'agent
//   Hermes suffit, rien à saisir. HERMES_GATEWAY_URL ou l'URL de l'interface
//   (Paramètres → Système) ne servent qu'aux installations spéciales.
// - Les tours parlent le protocole canonique de la gateway (WebSocket
//   `/api/ws`, ticket one-use en sous-protocole, puis session.create →
//   prompt.submit ; deltas via les événements message.delta / message.complete).
//   Sans agent lancé, re-sonde silencieuse à chaque tour (l'agent démarre
//   plus tard → ça se branche tout seul).
// - Sans gateway, les clés fournisseurs actives répondent (vrais modèles,
//   réels) ; sans gateway NI clé, le tour échoue avec un message clair —
//   JAMAIS de LLM simulé (mode démo supprimé).
// - `listModels()` interroge l'API REST de la gateway
//   (GET /api/model/options) et retombe sur le catalogue Hermes.
import WebSocket from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as pathResolve, join } from "node:path";
import { existsSync } from "node:fs";
import { catalogModelsResult } from "./models";
import type { LlmPoolApi, PoolTurnResult, TurnUsage } from "./llm-pool";
import type { GatewayMode, ModelOption, ModelsResult } from "./types";
import type { TurnCallbacks, TurnRequest } from "./local-engine";
import { runRestTurn } from "./motor-rest";
import { buildGatewayAttachments } from "./gateway-attachments";
import { trace } from "./trace";
import { portablePythonPath } from "./agent-starter";
import { resolveAgentDir } from "./agent-motor";

// URL par défaut : l'agent Hermes lancé localement (gateway/run_api.py).
// Priorité : interface (Paramètres → Système) > HERMES_GATEWAY_URL > défaut.
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:9120/api/ws";
const ENV_GATEWAY_URL = process.env.HERMES_GATEWAY_URL ?? null;
const ENV_GATEWAY_TOKEN = process.env.HERMES_GATEWAY_TOKEN ?? null;
const HANDSHAKE_TIMEOUT_MS = 3000;
const REPROBE_TIMEOUT_MS = 1500;
// C4 (25/11, constat n°4) : le plafond de DURÉE (180 s) coupait les tours
// longs de l'agent (outils, sous-agents). Remplacé par une garde
// d'INACTIVITÉ : le tour vit tant qu'un événement arrive (delta, outil,
// statut…) ; ce silence maximal clôture avec cause lisible. L'abort
// utilisateur reste immédiat, le partiel reçu reste rendu.
const TURN_INACTIVITY_MS = 240_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MODELS_TIMEOUT_MS = 4000;

// Protocole canonique de la gateway (hermes-gateway-v1) : l'upgrade exige un
// ticket one-use passé en sous-protocole (`hermes-gateway-ticket.<ticket>`),
// minter par `python -m hermes_cli.main gateway attach --json` (30 s TTL,
// une seule utilisation). L'ancienne enveloppe `api_turn_v1` est refusée :
// un tour est maintenant session.create → prompt.submit (JSON-RPC 2.0).
const GATEWAY_PROTOCOL = "hermes-gateway-v1";
const TICKET_PROTOCOL_PREFIX = "hermes-gateway-ticket.";
const TICKET_TIMEOUT_MS = 15_000;
// Candidats python pour minter le ticket (même ordre de confiance que le
// starter : portable d'abord, VENV dédié, système en dernier repli).
function ticketPythonCandidates(): string[] {
  const list: string[] = [];
  const portable = portablePythonPath();
  if (portable) list.push(portable);
  const agentDir = resolveAgentDir();
  if (agentDir) {
    const venv = process.platform === "win32"
      ? join(agentDir, ".venv", "Scripts", "python.exe")
      : join(agentDir, ".venv", "bin", "python");
    if (existsSync(venv)) list.push(venv);
  }
  if (process.platform === "win32") {
    list.push("py");
    list.push("python");
  } else {
    list.push("python3");
    list.push("python");
  }
  return list;
}

/** Minter un ticket one-use + l'URL d'attachement pour l'upgrade WebSocket
 *  canonique (30 s TTL). `gateway attach --json` renvoie aussi le ticket
 *  quand la gateway tourne déjà (state=ready) — c'est le chemin nominal.
 *  C2 (25/11, constat n°2) : la réponse contient AUSSI l'URL réelle de
 *  l'écouteur (`url`, port éphémère compris) — elle est désormais capturée
 *  au lieu d'être jetée. null = aucun python n'a répondu (la gateway est
 *  probablement absente ; la re-sonde s'en charge).
 *  ((90)) La maison est ÉPINGLÉE (HERMES_HOME du dossier) : un héritage de
 *  l'environnement d'une AUTRE installation Hermes (console de lancement,
 *  IDE) faisait répondre la gateway de l'autre maison — ticket d'un autre
 *  profil, refus 4403 à l'upgrade, tours muets sans cause visible.
 *  Asynchrone (revue 95) : l'ancien spawnSync gelait TOUTE la boucle
 *  d'événements du service (sockets, HTTP, streams en vol) pendant chaque
 *  essai python — jusqu'à 4 candidats × 15 s = 60 s de service figé, à
 *  chaque re-sonde périodique (toutes les 30 s en mode local) et au départ
 *  de chaque tour gateway. execFile promisifié libère la boucle. */
const execFileP = promisify(execFile);

export interface GatewayAttachInfo {
  ticket: string;
  /** Origine réelle de l'écouteur (ws://…/api/ws, port compris). null si le
   *  moteur ne la renvoie pas (version ancienne) — le repli 9120 reste. */
  url: string | null;
}

async function mintGatewayAttach(): Promise<GatewayAttachInfo | null> {
  const maison = pathResolve(join(import.meta.dir, "..", "..", "data"));
  const env = { ...process.env, HERMES_HOME: maison };
  const cwd = resolveAgentDir() ?? process.cwd();
  for (const cmd of ticketPythonCandidates()) {
    try {
      const args = cmd === "py" ? ["-3"] : [];
      const out = await execFileP(
        cmd,
        [...args, "-m", "hermes_cli.main", "gateway", "attach", "--json"],
        {
          timeout: TICKET_TIMEOUT_MS,
          encoding: "utf-8",
          windowsHide: true,
          env,
          cwd,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (!out.stdout) continue;
      const parsed = JSON.parse(out.stdout) as { ticket?: string; url?: string; protocols?: string[] };
      const ticket = parsed.ticket
        ?? parsed.protocols?.find((p) => p.startsWith(TICKET_PROTOCOL_PREFIX))?.slice(TICKET_PROTOCOL_PREFIX.length);
      // C2 (25/11) : l'URL d'attachement accompagne le ticket — c'est
      // l'origine RÉELLE de l'écouteur, port éphémère compris. Tolérance :
      // un moteur ancien sans champ url → null, le repli 9120 reste.
      if (ticket) {
        const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
        return { ticket, url: url || null };
      }
    } catch {
      /* candidat suivant */
    }
  }
  return null;
}

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

/** Extrait tolérant d'une liste de modèles depuis la réponse de /api/model/options.
 *  Exporté (audit CRAP 2026-11) pour être pincé par des tests unitaires Vitest. */
export function parseModelOptions(data: any): ModelOption[] {
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

/** Erreur claire quand la gateway ne répond pas : UNE seule voix dans le
 *  chat (Hermes) — pas de repli. Le préfixe [HERMES_OFFLINE] est reconnu
 *  par l'interface pour afficher la carte dédiée avec le bouton Paramètres. */
function noEngineError(): Error {
  return new Error(
    "[HERMES_OFFLINE] Hermes n'est pas connecté — lancez l'application " +
      "(Hermes-Web.bat) ou vérifiez la connexion dans Paramètres → Système."
  );
}

/** C4 (25/11, constat n°4) : garde d'inactivité + battement de cœur d'un
 *  tour — À LA PLACE du plafond de durée 180 s qui coupait les tours longs
 *  de l'agent. Retourne les commandes du tour : noteActivity (tout événement
 *  de l'agent réarme la garde ; les pongs ne comptent PAS — sinon un agent
 *  muet sur connexion vivante ne clôturerait jamais) et stop (nettoyage à
 *  la clôture, idempotent). Budget CRAP du plan : ≤ 10. */
function startTurnGuard(
  ws: WebSocket,
  nextRpcId: () => number,
  finish: (err?: Error) => void,
): { noteActivity: () => void; stop: () => void } {
  let lastActivity = Date.now();
  let inactivityTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    // Garde d'inactivité : silence événementiel ≥ 240 s → clôture AVEC
    // cause (l'ancien « Timeout du tour gateway » ne disait rien).
    if (Date.now() - lastActivity >= TURN_INACTIVITY_MS) {
      finish(new Error("Aucune activité de l'agent depuis 4 minutes — tour clôturé (garde d'inactivité, C4)"));
    }
  }, 5_000);
  // Battement de cœur : gateway.ping toutes les 15 s (cadence des clients
  // natifs du projet, tui_gateway/ws.py) — une connexion morte se voit en
  // quinze secondes par error/close → finish, au lieu d'attendre la garde.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: nextRpcId(), method: "gateway.ping", params: {} }));
      } catch {
        /* error/close suivra → finish */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  return {
    noteActivity: () => { lastActivity = Date.now(); },
    stop: () => {
      if (inactivityTimer !== null) clearInterval(inactivityTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      inactivityTimer = null;
      heartbeatTimer = null;
    },
  };
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
  /** C2 (25/11) : true = l'URL active a été posée par la découverte
   *  automatique (attachement du moteur) — une nouvelle origine du même
   *  attachement (redémarrage sur un autre port éphémère) la remplace.
   *  false = défaut/env/interface : la découverte peut s'appliquer, une
   *  URL EXPLICITEMENT choisie n'est jamais écrasée. */
  private autoGatewayUrl = false;
  /** Bascule REST (93) : le moteur annonce-t-il le contrat sessions natives
   *  (/v1/capabilities → session_create + session_chat_stream) ? null = pas
   *  encore sondé. Le listener 9120 du webapp n'a que le GET /api/sessions
   *  (POST → 405) : le contrat vit dans l'adaptateur api_server (port 8642,
   *  clé API_SERVER_KEY). Sans annonce, la bascule REST est coupée — plus
   *  jamais une trace d'échec pour un chemin qui n'existe pas. Re-sondé à
   *  chaque reconnexion gateway (le moteur peut arriver après l'interface). */
  private restContract: boolean | null = null;

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
    // C2 (25/11) : toute décision explicite d'URL (saisie OU retour au
    // défaut) ré-autorise la découverte automatique au prochain attach.
    this.autoGatewayUrl = false;
    // Nouvelle destination (93) : le verdict REST repart de zéro.
    this.restContract = null;
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

  /** C2 (25/11, constat n°2) : quand la cible active est le DÉFAUT (aucune
   *  saisie, aucun HERMES_GATEWAY_URL) ou déjà le fruit d'une découverte
   *  automatique, l'URL d'attachement du moteur remplace le 9120 en dur —
   *  port éphémère compris. Priorité conservée : interface >
   *  HERMES_GATEWAY_URL > attach > défaut. S-02 intacte : cette résolution
   *  ne touche JAMAIS une URL choisie explicitement, donc le jeton saisi
   *  ne part que vers sa destination. toHttpBase() suit automatiquement
   *  (il dérive de gatewayUrl) : liste des modèles et sonde REST parlent
   *  à la vraie origine sans code supplémentaire. */
  private applyAttachUrl(url: string | null): void {
    if (!url) return;
    const normalized = toWsUrl(url);
    if (!normalized || normalized === DEFAULT_GATEWAY_URL) return;
    if (this.gatewayUrl !== DEFAULT_GATEWAY_URL && !this.autoGatewayUrl) return;
    this.autoGatewayUrl = true;
    if (this.gatewayUrl === normalized) return;
    this.gatewayUrl = normalized;
    // Nouvelle origine (93) : le verdict REST repart de zéro.
    this.restContract = null;
    console.log(
      `[hermes-chat] gateway détectée sur ${normalized} (URL d'attachement, C2)`
    );
  }

  private async probe(timeoutMs: number = HANDSHAKE_TIMEOUT_MS): Promise<boolean> {
    // Sonde canonique : un upgrade accepté exige un ticket one-use en
    // sous-protocole. Pas de ticket minter → gateway absente (rien à sonder).
    // Ticket minté ASYNCHRONE avant la promesse socket (revue 95) : jamais
    // de boucle d'événements figée pendant les essais python.
    // C2 (25/11) : l'origine réelle de l'écouteur est appliquée AVANT le
    // dial — le 9120 en dur ne sert que de repli.
    const attach = await mintGatewayAttach();
    if (!attach) return false;
    this.applyAttachUrl(attach.url);
    const ticket = attach.ticket;
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
      const ws = new WebSocket(
        toWsUrl(this.gatewayUrl!),
        [GATEWAY_PROTOCOL, TICKET_PROTOCOL_PREFIX + ticket],
        { handshakeTimeout: timeoutMs }
      );
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
      // Le moteur vient d'arriver : le verdict REST (93) est re-sondé au
      // prochain tour — ce n'est peut-être plus le même listener.
      this.restContract = null;
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

  /** Bascule REST (93) : interroge UNE fois /v1/capabilities et retient si le
   *  moteur annonce le contrat sessions natives. Toute erreur (404 sur un
   *  webapp listener, réseau, JSON inattendu) = contrat absent. Non bloquant :
   *  en cas de doute, la bascule est coupée et le WS reste le chemin. */
  async hasRestContract(): Promise<boolean> {
    if (this.restContract !== null) return this.restContract;
    if (!this.gatewayUrl) return false;
    try {
      const res = await fetch(`${toHttpBase(this.gatewayUrl)}/v1/capabilities`, {
        headers: this.gatewayToken ? { Authorization: `Bearer ${this.gatewayToken}` } : {},
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const caps = (await res.json()) as { endpoints?: { name?: string }[] };
      const names = new Set((caps.endpoints ?? []).map((e) => e.name));
      this.restContract = names.has("session_create") && names.has("session_chat_stream");
    } catch {
      this.restContract = false;
    }
    if (!this.restContract) {
      trace(
        "motor-rest",
        "bascule REST désactivée (93) : le moteur n'annonce pas le contrat sessions natives — les tours passent au WebSocket",
      );
    }
    return this.restContract;
  }

  /** Bascule REST (75) : un candidat existe si la conversation est liée à
   *  une session moteur, que le tour n'emporte pas de pièces jointes, et
   *  que le moteur ANNONCE le contrat (93) — sinon null, sans appel REST
   *  voué au 405 ni trace d'échec. */
  private async restTurnCandidate(req: TurnRequest): Promise<{ base: string; sessionId: string } | null> {
    if (!req.motorSessionId || req.attachments?.length || !this.gatewayUrl) return null;
    if (!(await this.hasRestContract())) return null;
    return { base: toHttpBase(this.gatewayUrl), sessionId: req.motorSessionId };
  }

  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnOutcome> {
    await this.reprobeIfOffline();
    if (this.mode === "gateway" && this.gatewayUrl) {
      // Bascule sessions natives (75) : conversation liée au moteur + tour
      // sans pièces jointes (contrat multimodal REST non éprouvé) → le tour
      // tente le chemin REST /api/sessions/{id}/chat/stream — le moteur
      // porte alors l'historique de SA session. Toute erreur AVANT le
      // premier delta replie sur le WebSocket : MÊME moteur, jamais un
      // autre (la loi du chemin unique vise un autre moteur ; ici seul le
      // transport change, pas le cerveau).
      const rest = await this.restTurnCandidate(req);
      if (rest) {
        // Revue P1-P7 (B9) : si des deltas sont DÉJÀ partis vers le fil,
        // un repli WebSocket referait dérouler le même tour sur la même
        // bulle — deux réponses concaténées. Le repli n'est permis que
        // SANS aucun delta émis (erreur avant premier jeton).
        let emittedDelta = false;
        try {
          const out = await runRestTurn(
            rest.base,
            this.gatewayToken,
            rest.sessionId,
            {
              message: req.content,
              ...(req.modelId ? { model: req.modelId } : {}),
              ...(req.systemPrompt ? { system_message: req.systemPrompt } : {}),
            },
            {
              onDelta: (d: string) => {
                if (d) emittedDelta = true;
                cb.onDelta(d);
              },
              onReasoning: cb.onReasoning,
              onStatus: cb.onStatus,
              onToolEvent: cb.onToolEvent,
            },
            cb.signal,
          );
          return {
            content: out.content,
            reasoning: out.reasoning,
            model: req.model || "hermes (gateway)",
            engine: "gateway",
          };
        } catch (err) {
          if (cb.signal.aborted) {
            // Stop utilisateur avant tout delta : partiel (vide) rendu —
            // pas de repli qui relancerait le travail interrompu.
            return {
              content: "",
              reasoning: "",
              model: req.model || "hermes (gateway)",
              engine: "gateway",
            };
          }
          if (emittedDelta) {
            // Réponse partielle déjà livrée : on relance l'erreur telle
            // quelle, JAMAIS de relance complète par un autre transport.
            throw err;
          }
          trace(
            "motor-rest",
            `REST indisponible (${err instanceof Error ? err.message : String(err)}) — repli WebSocket, même moteur`,
          );
        }
      }
      // Chemin unique du chat : la gateway répond, ou l'erreur est affichée
      // telle quelle — jamais de repli silencieux vers un autre moteur.
      return await this.runGatewayTurn(req, cb);
    }
    // Sans agent lancé : le moteur local (clés fournisseurs configurées dans
    // l'interface) sert le tour — c'est le contrat affiché par le sélecteur
    // de modèles (listModels : « pool vivant »), suivi d'usage (F-21) et
    // encodé par la suite de tests (fixtures auto-portées). Correction CI
    // 2026-11-24 : la loi (94) « carte offline » avait retiré CE bloc entier,
    // rendant tout tour local impossible (HERMES_OFFLINE dès l'envoi) alors
    // que l'interface propose toujours les modèles fournisseurs — le retour
    // au pool ne contredit PAS (94) : sa carte offline reste servie par le
    // même noEngineError() quand AUCUNE clé n'est configurée (pool absent ou
    // sans réponse), et la bande du mode + l'étiquette du modèle qui a répondu
    // disent toujours la vérité (jamais « Hermes » pour un modèle brut).
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

  /** Synthèse de compaction : pool de clés d'abord, gateway en repli.
   *  Revue P1-P7 (B3) : en mode gateway PUR (aucune clé locale), l'ancien
   *  code levait [HERMES_OFFLINE] — « Compacter » était mort alors que la
   *  gateway EST un fournisseur de résumé. Session VIERGE côté gateway
   *  (pas de request_id / motorSessionId) : le prompt de résumé ne doit
   *  jamais polluer l'historique de la session de la conversation. */
  async summarize(
    history: { role: "user" | "assistant"; content: string }[]
  ): Promise<string> {
    if (this.pool) {
      const pooled = await this.pool.summarize(history);
      if (pooled) return pooled;
    }
    if (this.mode === "gateway" && this.gatewayUrl) {
      const prompt =
        "Résume la conversation suivante pour la suite d'une session de chat avec un agent. " +
        "Conserve : le sujet et l'objectif, les décisions prises, les fichiers/artefacts produits " +
        "(noms), les contraintes et préférences de l'utilisateur, et les prochaines étapes en cours. " +
        "Réponds en français, en 10 lignes maximum, sans préambule.\n\n" +
        history
          .map((m) => `${m.role === "user" ? "Utilisateur" : "Hermes"} : ${m.content}`)
          .join("\n\n")
          .slice(0, 60_000);
      const out = await this.runGatewayTurn(
        { content: prompt, history: [], motorSessionId: null, modelId: null, model: null },
        {
          onDelta: () => {},
          onReasoning: () => {},
          onStatus: () => {},
          onToolEvent: () => {},
          signal: new AbortController().signal,
        },
      );
      const text = out.content?.trim();
      if (text) return text;
      throw new Error("La gateway n'a produit aucun résumé — compaction impossible");
    }
    // Ni pool ni gateway : l'erreur dit CE QUI manque (fournisseur de
    // résumé) au lieu du message hors-ligne générique.
    throw new Error(
      "[COMPACT_SANS_MOTEUR] Aucun fournisseur de résumé disponible — " +
        "connectez la gateway ou ajoutez une clé fournisseur dans Paramètres."
    );
  }

  // Protocole canonique de tour Hermes (hermes-gateway-v1) :
  //   1. upgrade avec ticket one-use (sous-protocole hermes-gateway-ticket.<t>)
  //   2. session.create {}                      -> session_id
  //   3. prompt.submit {session_id, text, submission_id [, attachments]}
  //   <- événements JSON-RPC (method=event) : message.delta (payload.text),
  //      reasoning.delta, tool.* / status.update, message.complete (final).
  // L'ancienne enveloppe api_turn_v1 est refusée par la gateway. Les réglages
  // par tour sont limités au contrat fermé du canonical wire : le modèle
  // demandé passe par model_override ; effort / permissions / prompt système /
  // mémoire / température ne font pas partie du contrat (ignorés).
  private async runGatewayTurn(
    req: TurnRequest,
    cb: TurnCallbacks
  ): Promise<TurnOutcome> {
    // Ticket one-use : sans gateway vivante, `attach --json` échoue →
    // erreur claire (la re-sonde rebranchera au tour suivant). Minté
    // ASYNCHRONE avant la promesse socket (revue 95) — jamais de boucle
    // d'événements figée pendant les essais python.
    // C2 (25/11) : l'origine réelle (port éphémère compris) prime sur le
    // 9120 en dur quand l'URL active est encore le défaut — même priorité
    // que la sonde (interface > env > attach > défaut).
    const attach = await mintGatewayAttach();
    if (!attach) {
      throw new Error(
        "Gateway Hermes injoignable : aucun ticket d'attachement (l'agent est-il lancé ?)"
      );
    }
    this.applyAttachUrl(attach.url);
    const ticket = attach.ticket;
    return new Promise((resolve, reject) => {
      let settled = false;
      // true = la gateway a annoncé la fin (message.complete). Une
      // fermeture SANS fin annoncée résout en erreur, pas en « succès » avec
      // un contenu tronqué présenté comme complet (Lot 1, audit L1-6).
      let endedProperly = false;
      let content = "";
      let reasoning = "";
      const ws = new WebSocket(
        toWsUrl(this.gatewayUrl!),
        [GATEWAY_PROTOCOL, TICKET_PROTOCOL_PREFIX + ticket],
        { handshakeTimeout: HANDSHAKE_TIMEOUT_MS }
      );

      // Lot audit passe 2 : registre des rejets des requêtes JSON-RPC en vol —
      // finish() draine ce registre pour qu'aucun await rpc() ne survive à la
      // fermeture de la WebSocket (fuite de promesse + closure). Déclaré AVANT
      // finish : l'abort peut être déjà posé et finish() appelé de façon
      // synchrone pendant le montage (temporal dead zone interdite).
      const rpcRejectors = new Set<(err: Error) => void>();

      // C4 (25/11) : garde d'inactivité + battement de cœur (startTurnGuard),
      // arrêtée dans finish. Déclarée AVANT finish (même loi que rpcRejectors :
      // l'abort peut être déjà posé et finish() appelé de façon synchrone
      // pendant le montage — temporal dead zone interdite ; null = rien à
      // nettoyer).
      let turnGuard: ReturnType<typeof startTurnGuard> | null = null;
      const clearTurnTimers = () => {
        turnGuard?.stop();
        turnGuard = null;
      };

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTurnTimers();
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
        // Lot audit passe 2 : la socket vient de mourir (ou le tour est clôturé)
        // — TOUTE promesse JSON-RPC encore en vol est rejetée. Sans cela, un
        // await rpc("session.create"/"prompt.submit") interrompu par une
        // fermeture restait en attente pour toujours (closure fugitive).
        for (const rejRpc of rpcRejectors)
          rejRpc(new Error("Connexion gateway fermée avant la réponse JSON-RPC"));
        rpcRejectors.clear();
      };

      // Stop utilisateur (Lot 1, audit L1-6) : l'abort est câblé à la
      // WebSocket — fermeture immédiate et partiel rendu, au lieu de courir
      // jusqu'au timeout 180 s avec un fil qui ne s'arrête jamais.
      const onAbort = () => finish();
      if (cb.signal.aborted) onAbort();
      else cb.signal.addEventListener("abort", onAbort, { once: true });

      // C4 (25/11) : si le tour est déjà clôturé (abort synchrone pendant le
      // montage), la garde ne démarre même pas — un timer démarré après un
      // finish() définitif ne serait jamais nettoyé.
      if (!settled) turnGuard = startTurnGuard(ws, () => nextRpcId++, finish);

      let nextRpcId = 1;
      // Outils en cours (tool.start sans tool.complete) : clos d'office à la
      // fin du tour — aucun spinner ne survit à la réponse livrée.
      const outilsOuverts = new Set<string>();
      // Réponse à une requête JSON-RPC par id ; null si la socket meurt avant.
      const rpc = (method: string, params: Record<string, unknown>): Promise<any> =>
        new Promise((res, rej) => {
          const id = nextRpcId++;
          const onFrame = (raw: unknown) => {
            let data: any;
            try {
              data = JSON.parse(String(raw));
            } catch {
              return;
            }
            if (data?.id !== id) return;
            ws.off("message", onFrame);
            ws.off("close", onDead);
            ws.off("error", onErr);
            rpcRejectors.delete(rejectRpc);
            if (data?.error) rej(new Error(String(data.error.message ?? "Erreur gateway")));
            else res(data?.result);
          };
          // Lot audit passe 2 : la socket peut mourir AVANT la réponse —
          // close/error rejettent maintenant la promesse (au lieu de la
          // laisser pendre indéfiniment avec sa closure).
          const rejectRpc = (err: Error) => {
            ws.off("message", onFrame);
            ws.off("close", onDead);
            ws.off("error", onErr);
            rpcRejectors.delete(rejectRpc);
            rej(err);
          };
          const onDead = () =>
            rejectRpc(new Error("Connexion gateway fermée avant la réponse JSON-RPC"));
          const onErr = (err: Error) =>
            rejectRpc(new Error(`Connexion gateway en erreur avant la réponse JSON-RPC : ${err.message}`));
          rpcRejectors.add(rejectRpc);
          ws.on("message", onFrame);
          ws.once("close", onDead);
          ws.once("error", onErr);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });

      ws.on("error", (err) => finish(err));
      ws.on("close", () => finish());

      ws.on("open", async () => {
        try {
          cb.onStatus("Gateway Hermes connectée…");
          // 1. La session canonique (l'historique vit DANS la gateway ; les
          //    messages de la conversation ne sont pas rejoués — le wire
          //    fermé n'accepte pas d'historique client).
          // Mémoire de conversation en WS (94) : quand la conversation est
          // liée à une session moteur (motorSessionId, id déterministe
          // `ui-<conversationId>`), il part comme request_id de
          // session.create — la gateway dérive l'id de session du triplet
          // (profil, principal, request_id) et rend LA MÊME session à chaque
          // tour, avec l'historique de la conversation. Avant : {} à chaque
          // message → session vierge → l'agent oubliait tout à chaque tour.
          const created = await rpc("session.create", req.motorSessionId
            ? { request_id: req.motorSessionId }
            : {});
          const sid: string | undefined = created?.session_id;
          if (!sid || typeof sid !== "string") {
            finish(new Error("session.create : pas de session_id renvoyé"));
            return;
          }
          // 2. La soumission : submission_id OBLIGATOIRE (identité de la
          //    soumission, sert aux reprises/replays côté gateway).
          const submissionId = `hw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          // Pièces jointes (C3, 25/11) : dépôt canonique via image.attach_bytes
          // — le moteur n'accepte que des images de SON cache de staging ; les
          // chemins db/ de l'interface étaient refusés (invalid_params). Lancé
          // APRÈS session.create (le RPC vit sur la session en main) et AVANT
          // prompt.submit : une pièce non image jette une erreur claire, le
          // tour ne part pas, rien n'atteint le moteur.
          const attachments = await buildGatewayAttachments(rpc, req.attachments);
          // 3. Le stream : frames d'événements (method=event, params.type).
          // Revue P1-P7 (B8) : l'écouteur est posé AVANT prompt.submit —
          // la gateway peut émettre message.delta / error / message.complete
          // dès la RÉCEPTION de la soumission ; ces trames arrivaient avant
          // le tour de boucle qui posait onEvent, étaient ignorées par
          // onFrame (id inconnu) et figeaient le tour jusqu'au timeout.
          const onEvent = (raw: unknown) => {
            if (cb.signal.aborted) return finish();
            let data: any;
            try {
              data = JSON.parse(String(raw));
            } catch {
              return;
            }
            if (data?.method !== "event") return;
            // C4 : tout événement de l'agent réarme la garde d'inactivité.
            turnGuard?.noteActivity();
            const params = data?.params ?? {};
            const evt: string = params?.type ?? "";
            const payload = params?.payload ?? {};
            if (evt === "message.delta") {
              const delta = payload?.text;
              if (typeof delta === "string" && delta) {
                content += delta;
                cb.onDelta(delta);
              }
            } else if (evt === "reasoning.delta" || evt === "thinking.delta") {
              const think = payload?.text;
              if (typeof think === "string" && think) {
                reasoning += think;
                cb.onReasoning(think);
              }
            } else if (evt.startsWith("tool.")) {
              // Loi du fil propre (24/11) : SEUL le couple tool.start →
              // tool.complete crée/ferme une carte. Les autres variantes
              // (tool.generating, tool.progress, tool.output_risk) sont des
              // signaux intermédiaires : les transformer en cartes créait
              // des spinners JAMAIS fermés après la réponse livrée (capture
              // du 24/11 : 3 web_extract, 6 terminal, 8 read_file figés).
              if (evt === "tool.start" || evt === "tool.complete") {
                const toolName = payload?.name ?? payload?.tool ?? "outil";
                if (evt === "tool.complete") outilsOuverts.delete(toolName);
                else outilsOuverts.add(toolName);
                cb.onToolEvent({
                  name: toolName,
                  status: evt === "tool.complete" ? "done" : "running",
                  detail: payload?.summary ?? payload?.preview,
                });
              }
            } else if (evt === "status.update") {
              cb.onStatus(String(payload?.text ?? payload?.status ?? "Hermes travaille…"));
            } else if (evt === "message.complete") {
              // Texte final autoritaire ; usage disponible dans le payload.
              // Filet : tout outil resté "running" (complete perdu) est clos —
              // le fil ne garde AUCUN spinner après la réponse livrée.
              for (const nom of outilsOuverts) {
                cb.onToolEvent({ name: nom, status: "done" });
              }
              outilsOuverts.clear();
              const finalText = payload?.text ?? payload?.content;
              if (typeof finalText === "string" && finalText && !cb.signal.aborted) {
                content = finalText;
                cb.onDelta("");
              }
              endedProperly = true;
              ws.off("message", onEvent);
              finish();
            } else if (evt === "error") {
              ws.off("message", onEvent);
              finish(new Error(String(payload?.error ?? payload?.message ?? "Erreur gateway")));
            }
          };
          ws.on("message", onEvent);
          await rpc("prompt.submit", {
            session_id: sid,
            text: req.content,
            submission_id: submissionId,
            ...(req.modelId ? { model_override: { model: req.modelId } } : {}),
            ...(attachments ? { attachments } : {}),
          });
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }
}
