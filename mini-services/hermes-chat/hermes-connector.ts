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
import { mintNativeHttpTicket } from "./gateway-http-ticket";
import { GatewayChannel, openGatewaySocket } from "./gateway-channel";
import type { GatewayWire } from "./gateway-wire";
import { beginGatewayTurn, submitTurnPrompt, requireSessionId } from "./gateway-turn";
import { readFile } from "node:fs/promises";
import { trace } from "./trace";
import { portablePythonPath } from "./agent-starter";
import { resolveAgentDir } from "./agent-motor";

// URL par défaut : l'agent Hermes lancé localement (gateway/run_api.py).
// Priorité : interface (Paramètres → Système) > HERMES_GATEWAY_URL > défaut.
// ((104)) Le port suit HERMES_AGENT_GATEWAY_PORT (posé par le lanceur,
// webapp.port de config.yaml) — plus de 9120 figé, pour ne jamais croiser
// la passerelle d'une autre installation Hermes.
const DEFAULT_GATEWAY_URL = `ws://127.0.0.1:${process.env.HERMES_AGENT_GATEWAY_PORT ?? 9120}/api/ws`;
const ENV_GATEWAY_URL = process.env.HERMES_GATEWAY_URL ?? null;
const ENV_GATEWAY_TOKEN = process.env.HERMES_GATEWAY_TOKEN ?? null;
const HANDSHAKE_TIMEOUT_MS = 3000;
const REPROBE_TIMEOUT_MS = 1500;
const MODELS_TIMEOUT_MS = 4000;

// Protocole canonique de la gateway (hermes-gateway-v1) : l'upgrade exige un
// ticket one-use passé en sous-protocole (`hermes-gateway-ticket.<ticket>`),
// minter par `python -m hermes_cli.main gateway attach --json` (30 s TTL,
// une seule utilisation). L'ancienne enveloppe `api_turn_v1` est refusée :
// un tour est maintenant session.create → prompt.submit (JSON-RPC 2.0).
// (C5) : le sous-protocole de protocole et le prefix vivent dans
// gateway-channel.ts ; ici ne reste que le prefix utile au parse du
// `attach --json`.
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

/** Couture QA (C7, 25/11) : un harnais SANS moteur python peut injecter la
 *  réponse d'attachement (JSON inline, ou « @fichier » lu depuis le disque)
 *  — la fausse gateway canonique s'en sert pour tester le chemin nominal
 *  (ticket, URL d'attachement C2, tours). Variable jamais posée en
 *  production ; une couture invalide retombe sur le chemin python normal. */
async function seamAttachInfo(): Promise<GatewayAttachInfo | null> {
  const seam = process.env.HERMES_GATEWAY_ATTACH_JSON;
  if (!seam) return null;
  const raw = seam.startsWith("@")
    ? await readFile(seam.slice(1), "utf-8").catch(() => null)
    : seam;
  return parseSeamAttach(raw);
}

function parseSeamAttach(raw: string | null): GatewayAttachInfo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { ticket?: string; url?: string };
    const ticket = typeof parsed.ticket === "string" ? parsed.ticket.trim() : "";
    if (!ticket) return null;
    return {
      ticket,
      url: typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : null,
    };
  } catch {
    return null;
  }
}

/** La sortie de `gateway attach --json` → ticket + URL d'attachement.
 *  C2 (25/11) : l'URL accompagne le ticket — c'est l'origine RÉELLE de
 *  l'écouteur, port éphémère compris. Tolérance : un moteur ancien sans
 *  champ url → null, le repli 9120 reste. Jette sur JSON invalide
 *  (l'appelant traite ça comme un candidat python à sauter). */
function attachFromStdout(stdout: string): GatewayAttachInfo | null {
  const parsed = JSON.parse(stdout) as { ticket?: string; url?: string; protocols?: string[] };
  const ticket = parsed.ticket
    ?? parsed.protocols?.find((p) => p.startsWith(TICKET_PROTOCOL_PREFIX))?.slice(TICKET_PROTOCOL_PREFIX.length);
  if (!ticket) return null;
  const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
  return { ticket, url: url || null };
}

/** La « maison » HERMES_HOME du service (dossier data/ de l'interface) :
 *  le socket de contrôle du moteur (gateway.sock) y vit — c'est là que le
 *  ticket natif HTTP se minte (journal 19). */
function hermesHome(): string {
  return pathResolve(join(import.meta.dir, "..", "..", "data"));
}

async function mintGatewayAttach(): Promise<GatewayAttachInfo | null> {
  const seam = await seamAttachInfo();
  if (seam) return seam;
  const maison = hermesHome();
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
      const fromOut = attachFromStdout(out.stdout);
      if (fromOut) return fromOut;
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
          // Journal 19 : le moteur appaire model_override.provider aux SLUGS
          // du config (user_providers) — « mock », pas le nom affiché
          // « Mock » (gateway/session_cli_turn.py).
          for (const m of models) pushModel(m, p?.slug ?? p?.name ?? p?.id);
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

/** Fermeture silencieuse d'une socket de sonde (C5 : le dial partagé
 *  openGatewaySocket laisse une garde error no-op à vie — L2-8 ; ici on
 *  n'a plus qu'à fermer proprement, sans jamais retirer les listeners). */
function closeQuietly(ws: WebSocket): void {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
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
  /** C5 (25/11, constat n°5) : canal WebSocket PERSISTANT — UNE socket
   *  par service, vivante entre les tours (aucune récolte d'orphelin à
   *  20 s côté moteur : la session reste attachée), ticket re-minté à
   *  chaque (re)connexion, battement de cœur 15 s. Jeté quand la
   *  destination change volontairement. */
  private channel: GatewayChannel | null = null;
  /** C5 : sessions moteur par conversation (clé = motorSessionId
   *  déterministe). L'entrée porte le WIRE de la connexion qui l'a créée :
   *  même wire = session CHAUDE réutilisée sans create ; autre wire
   *  (reconnexion) = resume par stored_session_id. */
  private readonly wireSessions = new Map<
    string,
    {
      wire: GatewayWire;
      sid: string;
      stored: string | null;
      /** Dernière admission rendue par prompt.submit (journal 19) : à la
       *  reconnexion, si le moteur l'a marquée « unknown » (crash en plein
       *  tour), elle doit être SOLDÉE (prompt.resolve_unknown) sinon la
       *  FIFO du moteur reste en pause et le tour suivant ne part jamais. */
      lastAdmission?: string | null;
    }
  >();
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
    if (urlChanged) {
      // C5 (25/11) : autre destination → l'ancien canal (socket vivante,
      // sessions liées) est jeté — les sessions du nouveau point d'accès
      // repartent de zéro ; les tours en vol échouent proprement.
      this.channel?.close();
      this.channel = null;
      this.wireSessions.clear();
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
      // Journal 19 (moteur réel) : les routes HTTP du moteur exigent un
      // ticket natif à usage unique dans l'en-tête x-hermes-gateway-ticket
      // (mint sur le socket de contrôle) — sans lui, 401 Unauthorized et
      // repli catalogue alors que la gateway répond très bien.
      const nativeGrant = await mintNativeHttpTicket(hermesHome());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
      const res = await fetch(
        `${toHttpBase(this.gatewayUrl!)}/api/model/options?include_unconfigured=1`,
        { redirect: "error",
          signal: controller.signal,
          headers: {
            ...(this.gatewayToken ? { Authorization: `Bearer ${this.gatewayToken}` } : {}),
            ...(nativeGrant ? { "x-hermes-gateway-ticket": nativeGrant.ticket } : {}),
          },
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

  /** C5 (25/11) : le canal persistant, créé paresseusement au premier
   *  tour gateway. Le dialer mint le ticket one-use, applique l'origine
   *  réelle (C2) puis dial — à CHAQUE (re)connexion : un ticket ne vit
   *  qu'une fois, un port éphémère change au redémarrage du moteur. */
  private gatewayChannel(): GatewayChannel {
    if (!this.channel) {
      this.channel = new GatewayChannel(async () => {
        const attach = await mintGatewayAttach();
        if (!attach) {
          throw new Error(
            "Gateway Hermes injoignable : aucun ticket d'attachement (l'agent est-il lancé ?)"
          );
        }
        this.applyAttachUrl(attach.url);
        return openGatewaySocket(toWsUrl(this.gatewayUrl!), attach.ticket, HANDSHAKE_TIMEOUT_MS);
      });
    }
    return this.channel;
  }

  private async probe(timeoutMs: number = HANDSHAKE_TIMEOUT_MS): Promise<boolean> {
    // Sonde canonique : un upgrade accepté exige un ticket one-use en
    // sous-protocole. Pas de ticket minter → gateway absente (rien à sonder).
    // Ticket minté ASYNCHRONE avant la promesse socket (revue 95) : jamais
    // de boucle d'événements figée pendant les essais python.
    // C2 (25/11) : l'origine réelle de l'écouteur est appliquée AVANT le
    // dial — le 9120 en dur ne sert que de repli.
    // C5 (25/11) : la sonde reste une socket ÉPHÉMÈRE (dial partagé avec
    // le canal persistant) — elle ne prouve que la joignabilité.
    const attach = await mintGatewayAttach();
    if (!attach) return false;
    this.applyAttachUrl(attach.url);
    try {
      const ws = await openGatewaySocket(toWsUrl(this.gatewayUrl!), attach.ticket, timeoutMs);
      closeQuietly(ws);
      return true;
    } catch {
      return false;
    }
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
// L'ancienne enveloppe api_turn_v1 est refusée par la gateway. Le contrat
// par tour est fermé : le modèle demandé passe par model_override ; les
// instructions du tour (F-11/F-18/F-19/F-30, rôles des voix) partent dans
// le TEXTE du tour (bloc en tête) — le contrat n'a pas de champ prompt
// système. Température / maxTokens / graine (F-22) restent hors contrat :
// jamais transmis (badges « local » à l'écran).
  private async runGatewayTurn(
    req: TurnRequest,
    cb: TurnCallbacks
  ): Promise<TurnOutcome> {
    // C5 (25/11, constat n°5) : le tour est LOCATAIRE du canal persistant
    // — plus de socket (ni ticket) par tour. La WebSocket vit ENTRE les
    // tours (session chaude : le moteur ne détache plus la session à chaque
    // déconnexion, aucun ws_orphan_reap à 20 s), le re-mint du ticket et
    // l'origine réelle (C2) se font à la (re)connexion DANS le canal. Les
    // garanties du code d'origine sont conservées : abort immédiat avec
    // partiel rendu (désormais via session.interrupt, la socket survit),
    // partiel rendu, fermeture SANS fin annoncée = erreur jamais un succès
    // tronqué (L1-6), garde d'inactivité 240 s (C4).
    const wire = await this.gatewayChannel().ensureConnected();
    const turn = beginGatewayTurn(wire, req, cb);
    try {
      if (cb.signal.aborted) return await turn.done; // partiel (vide), rien n'est envoyé
      const sid = await this.ensureWireSession(wire, req);
      turn.bindSession(sid);
      // Pièces jointes (C3, 25/11) : dépôt canonique via image.attach_bytes
      // — le moteur n'accepte que des images de SON cache de staging ; les
      // chemins db/ de l'interface étaient refusés (invalid_params). Lancé
      // APRÈS session.create (le RPC vit sur la session en main) et AVANT
      // prompt.submit : une pièce non image jette une erreur claire, le tour
      // ne part pas, rien n'atteint le moteur.
      const attachments = await buildGatewayAttachments(
        // Journal 19 (moteur réel) : les RPC d'attach vivent SUR la session
        // — le moteur exige session_id dans les params (tui_gateway/
        // session_registry._sess_building), sans lui : 4000 invalid_params.
        (method, params) => wire.rpc(method, { ...params, session_id: sid }),
        req.attachments,
      );
      // Revue P1-P7 (B8, conservée par beginGatewayTurn) : le flux est
      // abonné AVANT la soumission — la gateway peut émettre des
      // événements dès la réception de prompt.submit.
      // submission_id OBLIGATOIRE (identité de la soumission, reprises/
      // replays côté gateway) ; busy 4009 → UNE réessai (interrupt-then-
      // retry du contrat amont, le running d'une interruption met ~1 s à
      // retomber).
      if (cb.signal.aborted) return await turn.done;
      // C6 (25/11, constat n°6) : model_override porte ce que le moteur
      // honore VRAIMENT — le modèle, son fournisseur (celui de la liste
      // GATEWAY uniquement : une paire modèle×fournisseur incohérente est
      // refusée par le garde amont) et l'échelle d'effort du compositeur
      // (settings.reasoningEffort).
      const override = this.modelOverrideFor(req);
      // Raccordement des consignes (25/11, demande utilisateur) : le contrat
      // fermé prompt.submit n'a pas de champ prompt système — l'ancien code
      // construisait req.systemPrompt (prompt de conversation F-11, consigne
      // du mode F-30, rôle d'une voix orchestrateur, mémoire F-18,
      // instructions F-19) puis le JETAIT : l'agent réel n'en voyait rien,
      // les modes tournaient « à vide ». Ces instructions partent désormais
      // dans le TEXTE du tour, en bloc en tête clairement délimité — même
      // esprit que le chemin REST (system_message) et les chats IA web
      // (prépende au message). La température / maxTokens / graine
      // (réglages expert F-22) restent hors contrat : aucune transmission
      // possible, l'écran le dit (badges « local »).
      const instructions = req.systemPrompt?.trim();
      const text = instructions
        ? `${instructions}\n\n---\n\n${req.content}`
        : req.content;
      // Usage du tour (F-21 vivant en gateway) : baseline = dernières
      // trames session.usage vues (fin du tour précédent sur session
      // chaude) ; le delta avec message.complete.usage se calcule à la
      // clôture (gateway-turn, outcome). Premier tour du canal → baseline
      // null → PAS d'usage affiché (jamais inventé).
      turn.captureUsageBaseline(sid);
      const admitted = await submitTurnPrompt(wire, cb.signal, {
        session_id: sid,
        text,
        submission_id: `hw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(override ? { model_override: override } : {}),
        ...(attachments ? { attachments } : {}),
      });
      // Journal 19 : admission rendue par le moteur — retenue pour le
      // soldage « unknown » à la reconnexion (ensureWireSession).
      const admissionId =
        typeof admitted?.admission_id === "string" ? admitted.admission_id : null;
      const entryKey = req.motorSessionId ?? null;
      if (entryKey) {
        const entry = this.wireSessions.get(entryKey);
        if (entry) entry.lastAdmission = admissionId;
      }
      return await turn.done;
    } finally {
      // Désabonne TOUT (événements, mort, abort, garde) — la socket,
      // elle, reste OUVERTE pour le tour suivant : c'est le cœur de C5.
      turn.dispose();
    }
  }

  /** C5 (25/11) : la session moteur du tour, par conversation (clé =
   *  motorSessionId déterministe). Même wire que la liaison = session
   *  CHAUDE, réutilisée telle quelle (pas de create, pas de reap) ;
   *  wire différent (reconnexion) = resume par stored_session_id —
   *  l'id DURABLE que session.create rend dès le premier tour et que
   *  le vrai moteur honore (le champ request_id de session.create est
   *  ignoré par le build actuel : la dérivation de session par triplet
   *  supposée au chantier 94 n'existe pas sur le moteur réel, elle
   *  n'était validée que par la fausse gateway). Session récoltée ou
   *  resume refusé → session fraîche, le tour part quand même. Sans
   *  identité de conversation (voix orchestrées, cas défensif) :
   *  session fraîche non liée, exactement comme avant C5. */
  private async ensureWireSession(wire: GatewayWire, req: TurnRequest): Promise<string> {
    const key = req.motorSessionId ?? null;
    const bound = key ? this.wireSessions.get(key) : undefined;
    if (bound && bound.wire === wire) return bound.sid;
    if (bound?.stored) {
      try {
        const resumed = await wire.rpc("session.resume", { session_id: bound.stored });
        const sid = requireSessionId(resumed, "session.resume");
        // Journal 19 (moteur réel) : un crash moteur en plein tour laisse
        // l'admission en « unknown » — la FIFO de la session est alors EN
        // PAUSE (session_authority._claim_next refuse unknown_execution) et
        // le tour soumis après la reprise ne part JAMAIS (silence). Le
        // contrat canonique prévoit prompt.receipt → prompt.resolve_unknown
        // pour solder le tour perdu ; tolérant : un moteur sans ces verbes
        // (l'ancien, la fausse gateway) passe outre.
        await this.settleUnknownAdmission(wire, sid, bound.lastAdmission ?? null);
        if (key) this.wireSessions.set(key, { wire, sid, stored: bound.stored, lastAdmission: bound.lastAdmission ?? null });
        return sid;
      } catch {
        // Récoltée/archivée pendant la déconnexion → session fraîche.
      }
    }
    const created = await wire.rpc("session.create", {});
    const sid = requireSessionId(created, "session.create");
    if (key) {
      const stored =
        typeof created?.stored_session_id === "string" ? created.stored_session_id : null;
      this.wireSessions.set(key, { wire, sid, stored, lastAdmission: null });
    }
    return sid;
  }

  /** ((108)) Supprime la session moteur d'une conversation côté passerelle :
   *  session.mutate {operation:'delete'} — session, messages, routage et
   *  médias orphelins dans data\state.db. Mutation bornée par révision :
   *  session.info la lit, essais bornés si elle a bougé. Best-effort :
   *  échec = false, la suppression interface continue (l'orphelin
   *  resterait dans le vidage manuel). sessionId null (conversation sans
   *  tour) → rien à supprimer, true. */
  async deleteMotorSessionById(
    sessionId: string | null,
  ): Promise<{ ok: boolean; erreurs: string[] }> {
    if (!sessionId) return { ok: true, erreurs: [] };
    const erreurs: string[] = [];
    try {
      const wire = await this.gatewayChannel().ensureConnected();
      let infos: unknown = null;
      try {
        infos = await wire.rpc("session.info", { session_id: sessionId });
      } catch {
        /* session déjà partie : la suppression d'un absent réussit quand même */
      }
      const revision = (() => {
        const stack: unknown[] = [infos];
        while (stack.length) {
          const cur = stack.pop();
          if (cur && typeof cur === "object") {
            for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
              if ((k === "revision" || k === "runtime_revision") && typeof v === "number") return v;
              if (v && typeof v === "object") stack.push(v);
            }
          }
        }
        return 0;
      })();
      for (const expectedRevision of [revision, 0, 1]) {
        try {
          await wire.rpc("session.mutate", {
            session_id: sessionId,
            operation: "delete",
            request_id: `delete-${sessionId}-${expectedRevision}-${Date.now()}`,
            expected_revision: expectedRevision,
            payload: {},
          });
          return { ok: true, erreurs };
        } catch (err) {
          erreurs.push(err instanceof Error ? err.message : String(err));
        }
      }
      return { ok: false, erreurs };
    } catch (err) {
      return { ok: false, erreurs: [err instanceof Error ? err.message : String(err)] };
    }
  }

  /** Solder une admission « unknown » après reconnexion (journal 19) :
   *  prompt.receipt lit le statut, prompt.resolve_unknown l'acquitte —
   *  « Acknowledge a turn lost across an owner restart; the FIFO behind
   *  it resumes ». Jamais bloquant : échec = on soumet quand même. */
  private async settleUnknownAdmission(
    wire: GatewayWire,
    sid: string,
    admissionId: string | null,
  ): Promise<void> {
    if (!admissionId) return;
    try {
      const receipt = await wire.rpc("prompt.receipt", {
        session_id: sid,
        admission_id: admissionId,
      });
      if (receipt?.status !== "unknown") return;
      const generation =
        typeof receipt?.execution_generation === "number" ? receipt.execution_generation : 0;
      await wire.rpc("prompt.resolve_unknown", {
        session_id: sid,
        admission_id: admissionId,
        execution_generation: generation,
      });
      console.log(
        `[hermes-chat] admission « unknown » soldée après reconnexion (session ${sid.slice(0, 8)}…) — la FIFO du moteur reprend`,
      );
    } catch {
      /* moteur sans les verbes canoniques : le tour part quand même */
    }
  }

  /** C6 (25/11) : model_override enrichi — modèle + fournisseur (uniquement
   *  si la liste vient de LA gateway branchée) + effort de raisonnement du
   *  compositeur. Null sans modèle choisi (le profil moteur décide seul). */
  private modelOverrideFor(req: TurnRequest): Record<string, string> | null {
    if (!req.modelId) return null;
    const provider =
      this.modelsCache?.source === "gateway"
        ? this.modelsCache.models.find((m) => m.id === req.modelId)?.provider
        : undefined;
    const reasoning = req.settings?.reasoningEffort?.trim() || undefined;
    return {
      model: req.modelId,
      ...(provider ? { provider } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }
}
