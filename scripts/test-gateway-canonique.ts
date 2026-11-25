// QA — intégration gateway CANONIQUE (C7, 25/11) : la fausse gateway v2
// parle le VRAI contrat du moteur (ticket en sous-protocole, JSON-RPC
// session.create/session.resume/prompt.submit/image.attach_bytes/
// gateway.ping/session.interrupt) et le service tourne CONTRE elle via
// la couture HERMES_GATEWAY_ATTACH_JSON (mint injecté, URL d'attachement
// C2 appliquée par le connecteur). Ce que ce test scelle (plan de
// correction, chantiers C5/C3/C6) :
//   [1] mode gateway au hello : la sonde se branche (dial + ticket) ;
//   [2] tour nominal : stream:done avec le texte final autoritaire ;
//   [3] SESSION CHAUDE : le 2e message NE rouvre PAS de socket et NE
//       recrée PAS de session (créée 1 fois, submit ×2, connexions
//       stables) — plus de récolte d'orphelin à 20 s (C5) ;
//   [4] C6 : model_override porte modèle + fournisseur (liste gateway)
//       + effort de raisonnement du compositeur ;
//   [5] C3 : pièce jointe image → image.attach_bytes (octets) puis
//       prompt.submit avec le chemin de staging MOTEUR ;
//   [6] abort utilisateur : partiel rendu, session.interrupt reçu par
//       le moteur — la socket reste vivante ;
//   [7] coupure réseau (drop côté serveur) : le tour en vol échoue
//       avec la cause lisible, JAMAIS un succès tronqué ;
//   [8] reconnexion : le tour suivant RE-DIAL (nouvelle connexion) et
//       session.resume par l'id DURABLE — la conversation retrouve sa
//       session, create reste à 1 ;
//   [9] battement de cœur : gateway.ping périodique vu sur le canal
//       vivant entre les tours (15 s, cadence C5) ;
//   [10] raccordement des consignes (25/11) : le prompt de conversation
//       voyage DANS le texte de prompt.submit (contrat sans champ prompt
//       système — l'ancien code le jetait) et la soumission ne porte
//       aucun param hors contrat.
import { io } from "socket.io-client";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeGateway, type FakeGateway } from "../mini-services/hermes-chat/scripts/fake-gateway-v2";

const TOKEN = "test-jeton-gateway-canonique";
const SOCK_URL = "http://localhost:3346";
const DB_DIR = new URL("../db-test-gateway-canonique", import.meta.url).pathname;
const GW_PORT = 9321;
const UPLOADS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "uploads");
const IMAGE_NAME = "test-image-canonique.png";
// PNG 1×1 valide (transparent) — le dépôt C3 lit les OCTETS réels.
const IMAGE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emitAck(s: any, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 9000);
    if (payload === undefined) s.emit(event, (res: any) => { clearTimeout(t); resolve(res ?? {}); });
    else s.emit(event, payload, (res: any) => { clearTimeout(t); resolve(res ?? {}); });
  });
}

function startService(gw: FakeGateway): Promise<ChildProcess> {
  mkdirSync(DB_DIR, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    HERMES_SERVICE_TOKEN: TOKEN,
    HERMES_CHAT_PORT: "3346",
    HERMES_CHAT_FILES_PORT: "3347",
    HERMES_CHAT_DB: join(DB_DIR, "hermes-chat.sqlite"),
    // Couture QA (C7) : la réponse d'attachement du « moteur » — ticket +
    // URL RÉELLE (port du faux). Le connecteur l'applique par C2 (le 9120
    // en dur n'est qu'un repli, jamais atteint ici).
    HERMES_GATEWAY_ATTACH_JSON: JSON.stringify({ ticket: gw.ticket, url: gw.url }),
  };
  // C2 exige une cible par DÉFAUT pour que l'URL d'attachement s'applique :
  // aucune URL d'environnement ne doit exister.
  delete env.HERMES_GATEWAY_URL;
  delete env.HERMES_GATEWAY_TOKEN;
  const proc = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: env as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("service des pièces jointes démarré")) {
        cleanup();
        resolve(proc);
      }
    };
    (proc.stdout as any).on("data", onData);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`service non démarré en 40 s — sortie: ${buf.slice(-400)}`));
    }, 40000);
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

/** Attend le stream:done / stream:error du tour courant (deltas ignorés). */
function awaitTurn(socket: any, cid: string, ms = 12000): Promise<{ kind: "done" | "error"; message: any; error: string; stopped?: boolean }> {
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

async function main() {
  let service: ChildProcess | null = null;
  let socket: any = null;
  let gw: FakeGateway | null = null;
  let imageCleaned = false;
  try {
    console.log("[boot] fausse gateway canonique (9321, complete +900 ms) + service hermes-chat (3346/3347)…");
    const fake = startFakeGateway(GW_PORT, 900);
    gw = fake;
    await fake.ready();
    service = await startService(fake);
    socket = await connectSocket();
    const stats = fake.stats;

    // ── [1] hello : mode gateway (la sonde s'est branchée) ────────────
    const hello = await emitAck(socket, "hello");
    check("[1] hello.mode = gateway (sonde branchée)", hello?.mode === "gateway", `mode=${hello?.mode}`);
    check("[1] hello.gatewayUrl = URL d'attachement C2", hello?.gatewayUrl === fake.url, String(hello?.gatewayUrl));

    // ── [2] Tour nominal ──────────────────────────────────────────────
    const conv = await emitAck(socket, "conversations:create");
    const cid = conv?.conversation?.id;
    check("conversation créée", Boolean(cid));
    const t1 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "premier message" });
    const r1 = await t1;
    check("[2] tour 1 achevé en stream:done", r1.kind === "done", `${r1.kind}: ${r1.error.slice(0, 90)}`);
    check(
      "[2] texte final autoritaire rendu",
      String(r1.message?.content ?? "") === "réponse canonique à « premier message »",
      JSON.stringify(r1.message?.content ?? "").slice(0, 90)
    );
    const connsAfterTurn1 = stats.connections;
    check("[2] une session créée, une soumission", stats.creates === 1 && stats.submits.length === 1, `creates=${stats.creates} submits=${stats.submits.length}`);
    check("[2] deux dials (sonde + canal persistant)", connsAfterTurn1 === 2, `connections=${connsAfterTurn1}`);

    // ── [3] Session chaude : 2e message, même socket, même session ────
    const t2 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "deuxième message" });
    const r2 = await t2;
    check("[3] tour 2 achevé", r2.kind === "done", `${r2.kind}: ${r2.error.slice(0, 90)}`);
    await wait(300); // une reconnexion éventuelle se verrait ici
    check("[3] socket PERSISTANTE (aucun nouveau dial)", stats.connections === connsAfterTurn1, `connections=${stats.connections}`);
    check("[3] session réutilisée (aucun create)", stats.creates === 1, `creates=${stats.creates}`);
    check("[3] deux soumissions", stats.submits.length === 2, `submits=${stats.submits.length}`);

    // ── [4] C6 : model_override modèle + fournisseur + effort ─────────
    // Le cache de modèles doit venir de la GATEWAY (source « gateway »)
    // pour que C6 joigne le fournisseur — la liste est demandée comme le
    // fait l'écran au branchement.
    const modelsRes = await emitAck(socket, "models:list");
    const listed = (modelsRes?.models ?? []) as Array<{ id?: string }>;
    check(
      "[4] liste des modèles servie par la gateway",
      listed.some((m) => m.id === fake.modelId),
      `${listed.length} modèle(s)`
    );
    const t4 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", {
      conversationId: cid,
      content: "message réglé",
      model: fake.modelId,
      effort: "high",
    });
    const r4 = await t4;
    check("[4] tour réglé achevé", r4.kind === "done", `${r4.kind}: ${r4.error.slice(0, 90)}`);
    const override = stats.submits[stats.submits.length - 1]?.model_override as Record<string, unknown> | undefined;
    check(
      "[4] model_override = {model, provider, reasoning}",
      override?.model === fake.modelId && override?.provider === "zai-fake" && override?.reasoning === "high",
      JSON.stringify(override ?? null)
    );

    // ── [5] C3 : image jointe → attach_bytes + chemin de staging ──────
    mkdirSync(UPLOADS_DIR, { recursive: true });
    const imageBytes = Buffer.from(IMAGE_B64, "base64");
    writeFileSync(join(UPLOADS_DIR, IMAGE_NAME), imageBytes);
    imageCleaned = true;
    const t5 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", {
      conversationId: cid,
      content: "message avec image",
      attachments: [
        {
          id: "test-img-canonique",
          name: IMAGE_NAME,
          mime: "image/png",
          size: imageBytes.length,
          kind: "image",
          url: `/uploads/${IMAGE_NAME}`,
        },
      ],
    });
    const r5 = await t5;
    check("[5] tour avec image achevé", r5.kind === "done", `${r5.kind}: ${r5.error.slice(0, 120)}`);
    check(
      "[5] image.attach_bytes reçu (octets complets, SUR la session)",
      stats.attaches.length === 1 &&
        stats.attaches[0].filename === IMAGE_NAME &&
        stats.attaches[0].bytes === imageBytes.length &&
        stats.attaches[0].session_id === stats.submits[stats.submits.length - 1]?.session_id,
      JSON.stringify(stats.attaches)
    );
    const submitted = stats.submits[stats.submits.length - 1]?.attachments as any[] | undefined;
    check(
      "[5] prompt.submit porte le chemin de STAGING moteur",
      Array.isArray(submitted) &&
        submitted.length === 1 &&
        submitted[0]?.path === `/tmp/hermes-fake-staging/${IMAGE_NAME}` &&
        submitted[0]?.mime === "image/png",
      JSON.stringify(submitted ?? null)
    );

    // ── [6] Abort : partiel + session.interrupt, socket vivante ───────
    const connsBeforeAbort = stats.connections;
    const t6 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "message à interrompre" });
    await wait(300); // les 2 deltas sont partis, complete pend à +900 ms
    const stopRes = await emitAck(socket, "chat:stop", { conversationId: cid });
    const r6 = await t6;
    check("[6] arrêt honoré (ack ok)", stopRes?.ok !== false, JSON.stringify(stopRes).slice(0, 60));
    check(
      "[6] partiel rendu (stream:done, marqué arrêté)",
      r6.kind === "done" && r6.stopped === true,
      `${r6.kind} stopped=${String(r6.stopped)} contenu=${JSON.stringify(r6.message?.content ?? "").slice(0, 60)}`
    );
    await wait(300);
    check("[6] session.interrupt reçu par le moteur", stats.interrupts >= 1, `interrupts=${stats.interrupts}`);
    check("[6] la socket SURVIT à l'arrêt (aucun dial)", stats.connections === connsBeforeAbort, `connections=${stats.connections}`);

    // ── [6b] Interrupt-then-retry : message juste après l'arrêt ───────
    // Le moteur réel garde running ~1 s après l'interruption (le faux
    // aussi) ; le contrat amont prévoit la boucle busy → attendre →
    // réessayer (submitTurnPrompt) : la première soumission est refusée
    // 4009, la réessie passe.
    const submitsBefore6b = stats.submits.length;
    const t6b = awaitTurn(socket, cid, 15000);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "message juste après arrêt" });
    const r6b = await t6b;
    check("[6b] tour juste après l'arrêt achevé (busy → réessai)", r6b.kind === "done", `${r6b.kind}: ${r6b.error.slice(0, 110)}`);
    check(
      "[6b] la boucle busy → réessai a bien eu lieu",
      stats.submits.length >= submitsBefore6b + 2,
      `submits=${stats.submits.length} (avant ${submitsBefore6b})`
    );

    // ── [7] Coupure réseau en plein vol : erreur claire ───────────────
    // Conversation NEUVE (session non occupée) : la coupure tombe en
    // plein flux (deltas reçus, complete pend) — pas pendant la fenêtre
    // busy-retry, le milieu de tour est vraiment couvert.
    const conv7 = await emitAck(socket, "conversations:create");
    const cid7 = conv7?.conversation?.id;
    const t7 = awaitTurn(socket, cid7);
    await emitAck(socket, "chat:send", { conversationId: cid7, content: "message coupé" });
    await wait(300); // deltas partis, complete pend à +900 ms
    const createsBeforeDrop = stats.creates;
    fake.dropAll();
    const r7 = await t7;
    check(
      "[7] coupure → stream:error avec la cause (jamais un succès tronqué)",
      r7.kind === "error" && /Connexion gateway ferm/.test(r7.error),
      `${r7.kind}: ${r7.error.slice(0, 110)}`
    );

    // ── [8] Reconnexion : nouveau dial + session.resume par l'id durable
    const t8 = awaitTurn(socket, cid7);
    await emitAck(socket, "chat:send", { conversationId: cid7, content: "message après coupure" });
    const r8 = await t8;
    check("[8] tour après coupure achevé", r8.kind === "done", `${r8.kind}: ${r8.error.slice(0, 110)}`);
    check("[8] reconnexion (nouveau dial)", stats.connections > connsBeforeAbort, `connections=${stats.connections}`);
    check("[8] session.resume par l'id DURABLE", stats.resumes >= 1, `resumes=${stats.resumes}`);
    check("[8] aucune création de session à la reprise", stats.creates === createsBeforeDrop, `creates=${stats.creates}`);

    // ── [9] Battement de cœur : ping périodique sur le canal vivant ────
    console.log("  [9] attente du battement de cœur (15 s)…");
    const pingsBefore = stats.pings;
    await wait(16_500);
    check("[9] gateway.ping vu entre les tours", stats.pings > pingsBefore, `pings=${stats.pings} (avant ${pingsBefore})`);

    // ── [10] Raccordement des consignes (25/11) : le prompt de conversation
    // part dans le TEXTE du tour — le contrat fermé prompt.submit n'a pas de
    // champ prompt système et l'ancien code construisait req.systemPrompt
    // puis le JETAIT (les modes tournaient à vide sur l'agent réel).
    await emitAck(socket, "system-prompt:set", {
      conversationId: cid,
      content: "CONSIGNE-CANONIQUE : réponds en haïku.",
    });
    const t10 = awaitTurn(socket, cid);
    await emitAck(socket, "chat:send", { conversationId: cid, content: "message consigné" });
    const r10 = await t10;
    check("[10] tour avec consigne achevé", r10.kind === "done", `${r10.kind}: ${r10.error.slice(0, 90)}`);
    const text10 = String(stats.submits[stats.submits.length - 1]?.text ?? "");
    check(
      "[10] la CONSIGNE voyage dans le texte soumis",
      text10.includes("CONSIGNE-CANONIQUE"),
      JSON.stringify(text10.slice(0, 90))
    );
    check(
      "[10] le message utilisateur suit le bloc d'instructions",
      text10.includes("---") && text10.trimEnd().endsWith("message consigné"),
      JSON.stringify(text10.slice(-60))
    );
    const ALLOWED_SUBMIT_KEYS = new Set(["session_id", "text", "submission_id", "model_override", "attachments"]);
    const keys10 = Object.keys(stats.submits[stats.submits.length - 1] ?? {});
    check(
      "[10] aucun param hors contrat (garde invalid_params du vrai moteur)",
      keys10.length > 0 && keys10.every((k) => ALLOWED_SUBMIT_KEYS.has(k)),
      keys10.join(",")
    );
  } catch (err) {
    failures++;
    console.error("Erreur du test :", err instanceof Error ? err.message : err);
  } finally {
    socket?.close();
    service?.kill();
    try { await gw?.close(); } catch { /* rien */ }
    try { rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* rien */ }
    if (imageCleaned) {
      try { rmSync(join(UPLOADS_DIR, IMAGE_NAME), { force: true }); } catch { /* rien */ }
    }
  }
  if (failures > 0) {
    console.error(`Gateway canonique : ${failures} échec(s)`);
    process.exit(1);
  }
  console.log("Gateway canonique : 0 échec — contrat réel tenu de bout en bout");
  process.exit(0);
}

main();
