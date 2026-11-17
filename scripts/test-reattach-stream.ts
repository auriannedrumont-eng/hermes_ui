// Test de ré-attache d'un tour en vol (audit « quitter puis revenir ») :
// quitter une conversation pendant une génération puis y revenir efface
// l'état de stream local du client (stream:start déjà parti) et le message
// assistant n'est pas encore persisté — sans ré-attache, les deltas suivants
// étaient jetés et le tour PARAISSAIT arrêté alors qu'il vivait côté service.
//
// Contrat vérifié ici contre le VRAI service (faux fournisseur local, flux
// lent multi-chunks) :
//   [1] conversations:open pendant le tour renvoie `live` : l'entrée du tour,
//       messageId = celui du stream:start, contenu accumulé NON VIDE ;
//   [2] le snapshot messages de cet open ne contient PAS la réponse (elle n'est
//       persistée qu'à la clôture) — c'est la condition du bug documentée ;
//   [3] le contenu re-semé est un préfixe exact des deltas déjà reçus (pas de
//       trou) et les deltas suivants le complètent SANS doublon :
//       contenuAuRetour + deltasAprès === contenu final du stream:done ;
//   [4] conversation calme : `live` vide (aucune entrée fantôme).
import { io } from "socket.io-client";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

const TOKEN = "test-jeton-reattach";
const SOCK_URL = "http://localhost:3343";
const DB_DIR = new URL("../db-test-reattach", import.meta.url).pathname;
const MOCK_PORT = 3341;
const MOCK_API_KEY = "clefaux.reattach";
const MODEL_ID = "glm-test-reattach";
const CHUNKS = [" Un,", " deux,", " trois,", " quatre,", " cinq,", " six,", " sept,", " huit."];
const CHUNK_MS = 300;

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emitAck(s: any, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) s.emit(event, (res: any) => resolve(res ?? {}));
    else s.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

// ── Faux fournisseur : /models accepte la clé, /chat/completions streame
//    LENTEMENT (CHUNKS espacés) pour laisser le temps de quitter/ revenir. ──
function startMock(): Promise<{ server: Server }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const auth = String(req.headers.authorization ?? "");
    const reply = (code: number, payload: string) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(payload);
    };
    if (req.method === "GET" && url === "/api/paas/v4/models") {
      if (auth !== `Bearer ${MOCK_API_KEY}`)
        return reply(401, JSON.stringify({ error: { message: "token incorrect" } }));
      return reply(200, JSON.stringify({ data: [{ id: MODEL_ID }] }));
    }
    if (req.method === "POST" && url === "/api/paas/v4/chat/completions") {
      if (auth !== `Bearer ${MOCK_API_KEY}`)
        return reply(401, JSON.stringify({ error: { message: "token incorrect" } }));
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        // Sonde du test de clé (1 jeton, pas de flux) — défensive.
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.max_tokens === 1 && parsed?.stream === false) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }));
            return;
          }
        } catch { /* on streame quand même */ }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        let i = 0;
        const timer = setInterval(() => {
          if (i < CHUNKS.length) {
            sse({ model: MODEL_ID, choices: [{ delta: { content: CHUNKS[i] } }] });
            i++;
            return;
          }
          clearInterval(timer);
          sse({ model: MODEL_ID, choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 10 } });
          res.write("data: [DONE]\n\n");
          res.end();
        }, CHUNK_MS);
      });
      return;
    }
    return reply(404, JSON.stringify({ error: { message: `route inconnue : ${req.method} ${url}` } }));
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ server })));
}

function startService(): Promise<ChildProcess> {
  mkdirSync(DB_DIR, { recursive: true });
  const env = {
    ...process.env,
    HERMES_SERVICE_TOKEN: TOKEN,
    HERMES_CHAT_PORT: "3343",
    HERMES_CHAT_FILES_PORT: "3344",
    HERMES_GATEWAY_URL: "",
    HERMES_CHAT_DB: join(DB_DIR, "hermes-chat.sqlite"),
  };
  const proc = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
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
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e: any) => reject(new Error(e?.message)));
    setTimeout(() => { s.close(); reject(new Error("timeout connexion socket")); }, 7000);
  });
}

async function main() {
  let service: ChildProcess | null = null;
  let mock: { server: Server } | null = null;
  let socket: any = null;
  try {
    console.log("[boot] faux fournisseur lent (3341) + service hermes-chat (3343/3344)…");
    mock = await startMock();
    service = await startService();
    socket = await connectSocket();

    // Fournisseur pointé sur le faux serveur
    const add = await emitAck(socket, "providers:add", {
      name: "z.ai",
      kind: "llm",
      baseUrl: `http://localhost:${MOCK_PORT}`,
    });
    const providerId = add?.provider?.id ?? null;
    check("fournisseur créé", Boolean(providerId));
    const key = await emitAck(socket, "providers:add-key", {
      providerId,
      label: "Clé ré-attache",
      secret: MOCK_API_KEY,
    });
    check("clé ajoutée", Boolean(key?.key?.id));

    // ── [1..3] Tour en vol, quitter puis revenir ────────────────────────
    const conv = await emitAck(socket, "conversations:create");
    const cid = conv?.conversation?.id;
    check("conversation créée", Boolean(cid));

    let startMessageId: string | null = null;
    const deltasBefore: string[] = [];
    const deltasAfter: string[] = [];
    let opened = false;
    let doneMessage: any = null;
    let doneStopped: boolean | undefined;
    let startVariant: string | undefined = undefined;

    socket.on("stream:start", (p: any) => {
      if (p?.conversationId !== cid) return;
      startMessageId = p.messageId;
      startVariant = p.variant;
    });
    socket.on("stream:delta", (p: any) => {
      if (p?.conversationId !== cid) return;
      (opened ? deltasAfter : deltasBefore).push(String(p.delta ?? ""));
    });
    const donePromise = new Promise<void>((resolve) => {
      socket.on("stream:done", (p: any) => {
        if (p?.conversationId !== cid) return;
        doneMessage = p.message ?? null;
        doneStopped = p.stopped;
        resolve();
      });
    });
    const errPromise = new Promise<string>((resolve) => {
      socket.on("stream:error", (p: any) => {
        if (p?.conversationId !== cid) return;
        resolve(String(p?.error ?? ""));
      });
    });

    await emitAck(socket, "chat:send", { conversationId: cid, content: "Bonjour", model: MODEL_ID });

    // Laisse filer ≥ 3 chunks (300 ms chacun) avant de « revenir »
    await wait(1150);
    check("deltas reçus avant le retour", deltasBefore.join("").length > 0, `${deltasBefore.length} delta(s)`);
    check("stream:start reçu avant le retour", Boolean(startMessageId));

    // « Retour » dans la conversation : conversations:open PENDANT le tour.
    // Le drapeau `opened` est posé DANS le callback socket (pas après le
    // await) : un delta déjà en file après l'ack doit compter comme « après ».
    const openRes = await new Promise<any>((resolve) => {
      socket.emit("conversations:open", { id: cid }, (res: any) => {
        opened = true;
        resolve(res ?? {});
      });
    });

    const live: any[] = Array.isArray(openRes?.live) ? openRes.live : [];
    const messages: any[] = Array.isArray(openRes?.messages) ? openRes.messages : [];
    const receivedBefore = deltasBefore.join("");

    check("[1] open renvoie UNE entrée live", live.length === 1, JSON.stringify(live).slice(0, 120));
    check("[1] live.messageId = stream:start", live[0]?.messageId === startMessageId, `${live[0]?.messageId} vs ${startMessageId}`);
    check("[1] live sans variante (tour simple)", live[0]?.variant === undefined && startVariant === undefined);
    check(
      "[1] contenu accumulé non vide",
      typeof live[0]?.content === "string" && live[0].content.length > 0,
      `${String(live[0]?.content ?? "").length} car.`
    );
    check(
      "[2] snapshot sans la réponse (condition du bug)",
      !messages.some((m) => m.role === "assistant"),
      `${messages.length} message(s), rôles: ${messages.map((m) => m.role).join(",") || "aucun"}`
    );
    check(
      "[3] contenu re-semé = préfixe exact des deltas reçus",
      live[0]?.content?.startsWith(receivedBefore) === true,
      `"${receivedBefore.slice(-30)}" ⊄ "${String(live[0]?.content ?? "").slice(0, 60)}…"`
    );

    // Le tour doit se terminer normalement malgré le « quitter/ revenir »
    const verdict = await Promise.race([
      donePromise.then(() => "done"),
      errPromise.then((e) => `error:${e}`),
      wait(15000).then(() => "timeout"),
    ]);
    check("tour achevé en stream:done", verdict === "done", verdict.slice(0, 120));

    const finalContent = String(doneMessage?.content ?? "");
    const reconstructed = String(live[0]?.content ?? "") + deltasAfter.join("");
    check(
      "[3] re-semé + deltas suivants = contenu final (sans trou ni doublon)",
      reconstructed === finalContent,
      `reconstitué ${reconstructed.length} car. ≠ final ${finalContent.length} car.`
    );
    check("[3] le message final porte l'id du tour", doneMessage?.id === startMessageId);
    check("tour non marqué arrêté", doneStopped !== true);

    // ── [4] Conversation calme : aucune entrée live fantôme ─────────────
    const conv2 = await emitAck(socket, "conversations:create");
    const quiet = await emitAck(socket, "conversations:open", { id: conv2?.conversation?.id });
    check("[4] conversation calme : live vide", Array.isArray(quiet?.live) && quiet.live.length === 0);

    // Après clôture : un nouvel open ne ré-attache plus rien (registre purgé)
    const after = await emitAck(socket, "conversations:open", { id: cid });
    check("après clôture : live vide (registre purgé)", Array.isArray(after?.live) && after.live.length === 0);
    check(
      "après clôture : la réponse persistée est dans le snapshot",
      (after?.messages ?? []).some((m: any) => m.id === startMessageId)
    );
  } catch (err) {
    failures++;
    console.error("Erreur du test :", err instanceof Error ? err.message : err);
  } finally {
    socket?.close();
    service?.kill();
    mock?.server.close();
    try { rmSync(DB_DIR, { recursive: true, force: true }); } catch { /* rien */ }
  }
  if (failures > 0) {
    console.error(`Ré-attache : ${failures} échec(s)`);
    process.exit(1);
  }
  console.log("Ré-attache : 0 échec — le tour survit à quitter/ revenir");
  process.exit(0);
}

main();
