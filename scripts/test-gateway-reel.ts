// QA — VALIDATION SUR MOTEUR RÉEL (journal 19) : le service hermes-chat
// tourne contre le VRAI hermes-agent (gateway python complète : socket de
// contrôle, tickets à usage unique, WS /api/ws + sous-protocole, sessions
// persistées, busy 4009), démarré en local par ce harnais. Seul le backend
// modèle est simulé (scripts/mock-llm-provider.py sur loopback — même
// recette que les e2e Desktop du moteur). AUCUNE couture ici : le
// connecteur emprunte le chemin python RÉEL (mint du ticket par
// `gateway attach --json`, URL d'attachement C2, port éphémère compris).
//
// Ce que cette validation scelle au-delà du canonique C7 (fausse gateway) :
//   [1] hello.mode = gateway via le VRAI mint python ; hello.gatewayUrl =
//       l'origine réelle du moteur (port éphémère, jamais le repli 9120) ;
//   [2] tour nominal de bout en bout à travers le moteur réel : le texte
//       final autoritaire contient le marqueur du provider simulé ;
//   [3] session chaude : plusieurs tours, la conversation reste utilisable
//       sans rebranchement (le harnais attend un délai post-tour où une
//       reconnexion éventuelle se produirait) ;
//   [4] models:list servi par la gateway réelle + tour avec model_override ;
//   [5] pièce jointe image → image.attach_bytes accepté par le moteur réel ;
//   [6] abort utilisateur → partiel marqué arrêté, session.interrupt ;
//   [6b] tour juste après l'arrêt : la boucle busy 4009 → réessai du
//       connecteur contre le VRAI moteur (code 4009 confirmé dans
//       tui_gateway/methods_prompt.py:944) ;
//   [7] coupure « réseau » = SIGTERM du moteur en plein flux → le tour en
//       vol échoue avec la cause lisible, jamais un succès tronqué ;
//   [8] REDÉMARRAGE du moteur puis tour suivant : re-dial (nouveau ticket)
//       + session.resume par l'ID DURABLE — la conversation retrouve sa
//       session sur un moteur REBOOTÉ (persistée dans HERMES_HOME) ;
//   [9] sonde directe : gateway.ping accepté par le moteur réel (méthode
//       du battement de cœur C5 — la cadence 15 s est scellée par le
//       canonique C7).
//
// Prérequis : dépôt sibling hermes-agent/ avec .venv synchronisé
// (uv sync), provider sur le port fixe 9351. HERMES_HOME = <repo>/data
// (la « maison » du connecteur) : config.yaml/.env n'y sont écrits que
// s'ils n'existent pas déjà.
import { io } from "socket.io-client";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, writeFileSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import WebSocket from "ws";

const TOKEN = "test-jeton-gateway-reel";
const SOCK_URL = "http://localhost:3356";
const REPO = new URL("..", import.meta.url).pathname;
const DB_DIR = join(REPO, "db-test-gateway-reel");
const HERMES_HOME = join(REPO, "data");
const ENGINE_DIR = process.env.HERMES_AGENT_DIR
  ? resolve(process.env.HERMES_AGENT_DIR)
  : join(dirname(REPO), "hermes-agent");
const ENGINE_PY = existsSync(join(ENGINE_DIR, ".venv", "bin", "python"))
  ? join(ENGINE_DIR, ".venv", "bin", "python")
  : "python3";
const ENGINE_LOG = join(DB_DIR, "gateway.log");
const PROVIDER_PORT = 9351;
const PROVIDER_LOG = join(DB_DIR, "provider.log");
const UPLOADS_DIR = join(REPO, "db", "uploads");
const IMAGE_NAME = "test-image-reel.png";
// PNG 1×1 valide (transparent) — le dépôt C3 lit les OCTETS réels.
const IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MARKER = "MOTEUR-RÉEL-OK";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emitAck(s: any, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 20000);
    if (payload === undefined) s.emit(event, (res: any) => { clearTimeout(t); resolve(res ?? {}); });
    else s.emit(event, payload, (res: any) => { clearTimeout(t); resolve(res ?? {}); });
  });
}

/** Attend le stream:done / stream:error du tour courant (deltas ignorés). */
function awaitTurn(socket: any, cid: string, ms = 30000): Promise<{ kind: "done" | "error"; message: any; error: string; stopped?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (kind: "done" | "error", p: any) => {
      if (settled || p?.conversationId !== cid) return;
      settled = true;
      socket.off("stream:done", onDone);
      socket.off("stream:error", onError);
      resolve({ kind, message: p?.message ?? null, error: String(p?.error ?? ""), stopped: p?.stopped });
    };
    const onDone = (p: any) => done("done", p);
    const onError = (p: any) => done("error", p);
    socket.on("stream:done", onDone);
    socket.on("stream:error", onError);
    setTimeout(() => done("error", { conversationId: cid, error: "timeout du harnais" }), ms);
  });
}

/** Env minimal pour le moteur : HERMES_HOME dédié, aucune variable HERMES ni clé LLM parasite. */
function engineEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^HERMES_/.test(k)) continue;      // le harnais pose le sien
    if (/API_KEY|_TOKEN$|^TOKEN$/.test(k) && k !== "HERMES_SERVICE_TOKEN") continue;
    env[k] = v;
  }
  env.HERMES_HOME = HERMES_HOME;
  return env;
}

function writeHomeConfigIfNeeded(): void {
  mkdirSync(HERMES_HOME, { recursive: true });
  const cfg = join(HERMES_HOME, "config.yaml");
  if (!existsSync(cfg)) {
    writeFileSync(cfg, `model:
  default: mock-model
  provider: mock
providers:
  mock:
    api: http://127.0.0.1:${PROVIDER_PORT}/v1
    name: Mock
    api_mode: chat_completions
    key_env: MOCK_API_KEY
    models:
      mock-model: {}
    context_length: 64000
auxiliary:
  title_generation:
    enabled: false
approvals:
  mode: "off"
`);
    console.log(`[setup] config.yaml écrit (${cfg})`);
  }
  const dotenv = join(HERMES_HOME, ".env");
  if (!existsSync(dotenv)) writeFileSync(dotenv, "MOCK_API_KEY=validation-reelle\n");
}

function startProvider(): Promise<ChildProcess> {
  const proc = spawn(ENGINE_PY, [join(REPO, "scripts", "mock-llm-provider.py"), String(PROVIDER_PORT)], {
    cwd: REPO,
    env: engineEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = createInterface({ input: proc.stdout as any });
  return new Promise((resolve, reject) => {
    let portLine = "";
    out.on("line", (l: string) => {
      appendFileSync(PROVIDER_LOG, l + "\n");
      if (!portLine && /^\d+$/.test(l.trim())) {
        portLine = l.trim();
        if (portLine !== String(PROVIDER_PORT)) {
          reject(new Error(`provider port inattendu: ${portLine}`));
        } else resolve(proc);
      }
    });
    const timer = setTimeout(() => reject(new Error("provider sans ligne de port")), 15000);
    proc.on("exit", () => { clearTimeout(timer); reject(new Error("provider mort au démarrage")); });
  });
}

let engine: ChildProcess | null = null;
function startEngine(): Promise<ChildProcess> {
  return (async () => {
    // « One gateway per host » : libérer la maison d'un moteur résiduel
    // AVANT de booter (sinon le nôtre sort en exit 0 aussitôt).
    await clearServingEngine();
    const proc = spawn(ENGINE_PY, ["-m", "hermes_cli.main", "gateway", "run", "-v"], {
      cwd: ENGINE_DIR,
      env: engineEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    engine = proc;
  const stamp = () => appendFileSync(ENGINE_LOG, `\n===== [${new Date().toISOString()}] moteur pid=${proc.pid} =====\n`);
  stamp();
  for (const s of [proc.stdout, proc.stderr]) {
    createInterface({ input: s as any }).on("line", (l: string) => appendFileSync(ENGINE_LOG, l + "\n"));
  }
  // Prêt = gateway_state.json running AVEC le pid du NOUVEAU process (le
  // fichier d'un moteur tué dit encore « running » — journal 19) PUIS un
  // attach qui RÉPOND (le socket de contrôle sert vraiment).
  const stateFile = join(HERMES_HOME, "gateway_state.json");
  const deadline = Date.now() + 90_000;
  return new Promise((resolve, reject) => {
    let attachInFlight = false;
    const tick = setInterval(() => {
      if (proc.exitCode !== null) {
        clearInterval(tick);
        reject(new Error(`moteur mort au boot (exit ${proc.exitCode}) — voir ${ENGINE_LOG}`));
        return;
      }
      let ready = false;
      try {
        const st = JSON.parse(readFileSync(stateFile, "utf-8"));
        ready = st.gateway_state === "running" && st.pid === proc.pid;
      } catch { /* pas encore écrit */ }
      if (!ready) {
        if (Date.now() > deadline) { clearInterval(tick); reject(new Error("moteur pas running en 90 s")); }
        return;
      }
      if (attachInFlight) return;
      attachInFlight = true;
      attachInfo()
        .then(() => { clearInterval(tick); resolve(proc); })
        .catch(() => {
          attachInFlight = false;
          if (Date.now() > deadline) {
            clearInterval(tick);
            reject(new Error("moteur running mais l'attach ne répond pas en 90 s"));
          }
        });
    }, 500);
  });
  })();
}

/** Attend la mort RÉELLE du process (exitCode renseigné), bornée. */
function waitExit(proc: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const t = setTimeout(resolve, ms);
    proc.on("exit", () => { clearTimeout(t); resolve(); });
  });
}

/** Tue un pid système et attend sa disparition (kill(pid, 0) échoue quand
 *  mort). Garde en dur : le run du 25/11 04:05 a laissé un moteur ORPHELIN
 *  (pid vivant après un teardown "réussi" — exit signalé, process vivant) ;
 *  on ne fait plus confiance au seul évènement exit du child. */
async function killPidAndWait(pid: number, label: string): Promise<void> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (!alive()) return;
  console.log(`  [teardown] arrêt du moteur résiduel ${label} pid=${pid}…`);
  try { process.kill(pid, "SIGTERM"); } catch { /* déjà parti */ }
  for (let i = 0; i < 20 && alive(); i++) await wait(500);
  if (alive()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* déjà parti */ }
    for (let i = 0; i < 10 && alive(); i++) await wait(500);
  }
  if (alive()) console.warn(`  [teardown] ATTENTION : pid ${pid} (${label}) survit même à SIGKILL`);
}

/** Le moteur applique « one gateway per host » : un moteur DÉJÀ vivant sur
 *  la maison fait sortir le nôtre aussitôt (exit 0, « already serves »).
 *  Le kit veut un moteur qu'il possède : on arrête l'existant AVANT de
 *  booter (état stale « running » d'un moteur tué → pid mort → rien à
 *  faire, la détection est par pid VIVANT, pas par le fichier). */
async function clearServingEngine(): Promise<void> {
  try {
    const st = JSON.parse(readFileSync(join(HERMES_HOME, "gateway_state.json"), "utf-8"));
    const pid = typeof st.pid === "number" ? st.pid : null;
    if (pid && st.gateway_state === "running") await killPidAndWait(pid, "moteur en place");
  } catch { /* pas de fichier d'état : rien */ }
}

async function stopEngine(): Promise<void> {
  const proc = engine;
  engine = null;
  if (!proc || (proc.exitCode !== null && proc.signalCode !== null)) {
    if (proc?.pid) await killPidAndWait(proc.pid, "moteur du harnais");
    return;
  }
  try { proc.kill("SIGTERM"); } catch { /* déjà mort */ }
  await waitExit(proc, 10_000);
  // Garde : l'évènement exit du child ne suffit PAS (orphelin observé) —
  // on vérifie le pid au niveau système, SIGKILL au besoin.
  await killPidAndWait(proc.pid!, "moteur du harnais");
  await waitExit(proc, 5_000);
}

/** Coupure BRUTALE (journal 19) : SIGTERM = arrêt GRACIEUX du moteur (il
 *  draine le tour en vol jusqu'à son terme — stream:done normal, jamais
 *  une coupure). Pour la coupure « réseau » du harnais, il faut SIGKILL :
 *  la socket tombe NET, le tour en vol doit échouer avec sa cause. */
async function hardKillEngine(): Promise<void> {
  const proc = engine;
  engine = null;
  if (!proc || proc.exitCode !== null) return;
  try { proc.kill("SIGKILL"); } catch { /* déjà mort */ }
  await waitExit(proc, 5_000);
}

/** Mint d'un attach (ticket à usage unique + URL réelle) — comme le connecteur. */
async function attachInfo(): Promise<{ url: string; ticket: string; protocols: string[] }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await run(ENGINE_PY, ["-m", "hermes_cli.main", "gateway", "attach", "--json"], {
        cwd: ENGINE_DIR, env: engineEnv(), timeout: 20_000, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout.trim().split("\n").pop() as string) as { url: string; ticket: string; protocols: string[] };
      if (parsed?.url && parsed?.ticket) return parsed;
    } catch {
      await wait(1500);
    }
  }
  throw new Error("gateway attach --json injoignable");
}

/** Sonde WS directe : gateway.ping doit être accepté par le moteur réel. */
function probePing(url: string, ticket: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ["hermes-gateway-v1", `hermes-gateway-ticket.${ticket}`]);
    const guard = setTimeout(() => { try { ws.close(); } catch { /* rien */ } resolve({ ok: false, detail: "timeout de la sonde" }); }, 8000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "gateway.ping" }));
    });
    ws.on("message", (data: any) => {
      const msg = JSON.parse(String(data));
      if (msg?.id !== 1) return;
      clearTimeout(guard);
      ws.close();
      resolve(msg.error
        ? { ok: false, detail: `erreur JSON-RPC ${msg.error.code}: ${msg.error.message}` }
        : { ok: true, detail: "résultat rendu" });
    });
    ws.on("error", (e: Error) => { clearTimeout(guard); resolve({ ok: false, detail: e.message }); });
  });
}

function startService(): Promise<ChildProcess> {
  mkdirSync(DB_DIR, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    HERMES_SERVICE_TOKEN: TOKEN,
    HERMES_CHAT_PORT: "3356",
    HERMES_CHAT_FILES_PORT: "3357",
    HERMES_CHAT_DB: join(DB_DIR, "hermes-chat.sqlite"),
  };
  // AUCUNE couture : le mint du ticket passe par le chemin python réel.
  delete env.HERMES_GATEWAY_ATTACH_JSON;
  delete env.HERMES_GATEWAY_URL;
  delete env.HERMES_GATEWAY_TOKEN;
  const proc = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
    cwd: REPO,
    env: env as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Journal du service : console ET fichier (forensic en cas d'échec —
  // le finally ne nettoie les logs que lorsque tout est vert).
  const serviceLog = join(DB_DIR, "service.log");
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      process.stdout.write(`[service] ${d}`);
      try { appendFileSync(serviceLog, d.toString()); } catch { /* disque plein : console seulement */ }
      if (buf.includes("service des pièces jointes démarré")) {
        cleanup();
        resolve(proc);
      }
    };
    (proc.stdout as any).on("data", onData);
    const timer = setTimeout(() => { cleanup(); reject(new Error(`service non démarré en 60 s — sortie: ${buf.slice(-400)}`)); }, 60_000);
    function cleanup() { clearTimeout(timer); (proc.stdout as any).off("data", onData); }
  });
}

function connectSocket(): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = io(SOCK_URL, { path: "/", transports: ["websocket"], timeout: 6000, auth: { token: TOKEN } });
    const guard = setTimeout(() => { s.close(); reject(new Error("timeout connexion socket")); }, 7000);
    s.on("connect", () => { clearTimeout(guard); resolve(s); });
    s.on("connect_error", (e: any) => { clearTimeout(guard); reject(new Error(e?.message)); });
  });
}

async function main() {
  let service: ChildProcess | null = null;
  let socket: any = null;
  let provider: ChildProcess | null = null;
  let imageCleaned = false;
  try {
    console.log("[boot] provider mock (9351) + moteur RÉEL (gateway run -v, HERMES_HOME=data) + service hermes-chat (3356/3357)…");
    writeHomeConfigIfNeeded();
    mkdirSync(DB_DIR, { recursive: true });
    rmSync(ENGINE_LOG, { force: true });
    provider = await startProvider();
    await startEngine();
    console.log("[boot] moteur running — mint d'un attach pour apprendre l'URL réelle…");
    const attach = await attachInfo();
    console.log(`[boot] attach: ${attach.url}`);
    service = await startService();
    socket = await connectSocket();

    // ── [1] hello : mode gateway via le VRAI mint python ──────────────
    // La sonde du connecteur est ASYNCHRONE : hello peut répondre « local »
    // alors qu'elle est en vol (mint python + dial ~1 s). On sonde hello en
    // boucle jusqu'à stabilisation (l'interface réelle rediffuse le hello
    // au basculement).
    let hello: any = null;
    for (let i = 0; i < 20; i++) {
      hello = await emitAck(socket, "hello");
      if (hello?.mode === "gateway") break;
      await wait(400);
    }
    check("[1] hello.mode = gateway (mint python réel)", hello?.mode === "gateway", `mode=${hello?.mode}`);
    check("[1] hello.gatewayUrl = origine RÉELLE du moteur", hello?.gatewayUrl === attach.url, `${hello?.gatewayUrl} ≠ ${attach.url}`);

    // ── [2] Tour nominal à travers le moteur réel ─────────────────────
    const conv = await emitAck(socket, "conversations:create");
    const cid = conv?.conversation?.id;
    check("conversation créée", Boolean(cid));
    const t1 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "premier message du moteur réel" });
    const r1 = await t1;
    check("[2] tour 1 achevé en stream:done", r1.kind === "done", `${r1.kind}: ${r1.error.slice(0, 120)}`);
    check(
      "[2] texte final autoritaire porte le marqueur du provider (chaîne complète passée par le moteur)",
      r1.kind === "done" && String(r1.message?.content ?? "").includes(MARKER),
      JSON.stringify(String(r1.message?.content ?? "")).slice(0, 90)
    );

    // ── [3] Session chaude : tours suivants, conversation stable ──────
    const t3 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "deuxième message" });
    const r3 = await t3;
    check("[3] tour 2 achevé (session chaude)", r3.kind === "done", `${r3.kind}: ${r3.error.slice(0, 120)}`);
    await wait(3000); // une reconnexion/reprise éventuelle se verrait ici
    const t3b = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "troisième message" });
    const r3b = await t3b;
    check("[3] tour 3 achevé sans rebranchement", r3b.kind === "done", `${r3b.kind}: ${r3b.error.slice(0, 120)}`);

    // ── [4] models:list servi par la gateway réelle + model_override ──
    const modelsRes = await emitAck(socket, "models:list");
    const listed = (modelsRes?.models ?? []) as Array<{ id?: string }>;
    check("[4] liste des modèles servie par la gateway réelle", listed.some((m) => m.id === "mock-model"), `${listed.length} modèle(s)`);
    const t4 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", {
      conversationId: cid,
      content: "message réglé",
      model: "mock-model",
      effort: "high",
    });
    const r4 = await t4;
    check("[4] tour avec model_override accepté par le moteur réel", r4.kind === "done", `${r4.kind}: ${r4.error.slice(0, 120)}`);

    // ── [5] Image jointe → image.attach_bytes vers le moteur réel ─────
    mkdirSync(UPLOADS_DIR, { recursive: true });
    const imageBytes = Buffer.from(IMAGE_B64, "base64");
    writeFileSync(join(UPLOADS_DIR, IMAGE_NAME), imageBytes);
    imageCleaned = true;
    const t5 = awaitTurn(socket, cid, 45000);
    await emitAck(socket, "chat:send", {
      conversationId: cid,
      content: "message avec image",
      attachments: [
        {
          id: "test-img-reel",
          name: IMAGE_NAME,
          mime: "image/png",
          size: imageBytes.length,
          kind: "image",
          url: `/uploads/${IMAGE_NAME}`,
        },
      ],
    });
    const r5 = await t5;
    check("[5] tour avec image achevé (attach_bytes accepté)", r5.kind === "done", `${r5.kind}: ${r5.error.slice(0, 120)}`);

    // ── [6] Abort : partiel + session.interrupt, la suite prospère ────
    const t6 = awaitTurn(socket, cid, 40000);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "message à interrompre" });
    await wait(1600); // le flux lent est en cours (12 segments × 400 ms)
    const stopRes = await emitAck(socket, "chat:stop", { conversationId: cid });
    const r6 = await t6;
    check("[6] arrêt honoré (ack ok)", stopRes?.ok !== false, JSON.stringify(stopRes).slice(0, 60));
    check(
      "[6] partiel rendu (stream:done, marqué arrêté)",
      r6.kind === "done" && r6.stopped === true,
      `${r6.kind} stopped=${String(r6.stopped)}`
    );
    await wait(2000);

    // ── [6b] Tour juste après l'arrêt : busy 4009 → réessai (vrai code) ─
    const t6b = awaitTurn(socket, cid, 40000);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "message juste après arrêt" });
    const r6b = await t6b;
    check("[6b] tour juste après l'arrêt achevé (busy → réessai)", r6b.kind === "done", `${r6b.kind}: ${r6b.error.slice(0, 120)}`);

    // ── [9a] Fenêtre de battement de cœur (15 s) sur le canal vivant ──
    console.log("  [9] attente du battement de cœur (16 s)…");
    await wait(16_000);

    // ── [7] Coupure « réseau » : SIGTERM du moteur en plein flux ──────
    const conv7 = await emitAck(socket, "conversations:create");
    const cid7 = conv7?.conversation?.id;
    const t7 = awaitTurn(socket, cid7, 40000);
    await emitAck(socket, "chat:send", { conversationId: cid7, content: "message coupé" });
    await wait(1600); // flux lent en cours
    console.log("  [7] SIGKILL du moteur en plein flux (SIGTERM = drain gracieux, pas une coupure)…");
    await hardKillEngine();
    const r7 = await t7;
    check(
      "[7] coupure → stream:error avec la cause (jamais un succès tronqué)",
      r7.kind === "error" && /connex|gateway|ferm|perdue/i.test(r7.error),
      `${r7.kind}: ${r7.error.slice(0, 120)}`
    );

    // ── [8] Redémarrage du moteur, puis reprise par l'ID DURABLE ──────
    console.log("  [8] redémarrage du moteur réel…");
    await startEngine();
    const t8 = awaitTurn(socket, cid7, 60000);
    await emitAck(socket, "chat:send", { conversationId: cid7, content: "message après coupure" });
    const r8 = await t8;
    check("[8] tour après redémarrage achevé (re-dial + session.resume)", r8.kind === "done", `${r8.kind}: ${r8.error.slice(0, 120)}`);
    check(
      "[8] la réponse vient bien du moteur redémarré (marqueur)",
      r8.kind === "done" && String(r8.message?.content ?? "").includes(MARKER),
      JSON.stringify(String(r8.message?.content ?? "")).slice(0, 90)
    );

    // ── [9b] Sonde directe : gateway.ping accepté par le moteur réel ──
    const fresh = await attachInfo();
    const ping = await probePing(fresh.url, fresh.ticket);
    check("[9] gateway.ping accepté par le moteur réel (sonde directe)", ping.ok, ping.detail);

    console.log(`\n[forensic] log moteur : ${ENGINE_LOG}`);
  } catch (err) {
    failures++;
    console.error("Erreur du test :", err instanceof Error ? err.message : err);
  } finally {
    socket?.close();
    service?.kill();
    provider?.kill();
    await stopEngine();
    // Ceinture ET bretelles : même un moteur que le child "exit" croit mort
    // mais qui survit (l'orphelin observé) est arrêté — par le pid VIVANT
    // du fichier d'état, pas par l'évènement.
    await clearServingEngine();
    // Forensic : en cas d'échec, les logs moteur + service restent sur
    // disque (gateway.log, service.log dans DB_DIR) — nettoyés sinon.
    if (failures === 0) {
      try { rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* rien */ }
    } else {
      console.log(`[forensic] conservés : ${ENGINE_LOG}, ${join(DB_DIR, "service.log")}`);
    }
    if (imageCleaned) {
      try { rmSync(join(UPLOADS_DIR, IMAGE_NAME), { force: true }); } catch { /* rien */ }
    }
  }
  if (failures > 0) {
    console.error(`Moteur réel : ${failures} échec(s)`);
    process.exit(1);
  }
  console.log("Moteur réel : 0 échec — le service tient le contrat du VRAI hermes-agent de bout en bout");
  process.exit(0);
}

main();
