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
//   [4] conversation calme : `live` vide (aucune entrée fantôme) ;
//   [5] déroulé multi-voix (conseil, F-30) : le bloc des voix est ré-attaché
//       au retour (lignes complètes) et se retrouve intégralement dans la
//       réponse persistée — quel que soit le mode orchestré.
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
    // Le garde-fou de connexion s'annule dès la connexion : sans clear, il
    // fermerait le socket à t+7 s EN PLEIN TOUR (le tour conseil du test
    // dure plus de 7 s — la déconnexion « io client disconnect » observée).
    const guard = setTimeout(() => { s.close(); reject(new Error("timeout connexion socket")); }, 7000);
    s.on("connect", () => { clearTimeout(guard); resolve(s); });
    s.on("connect_error", (e: any) => { clearTimeout(guard); reject(new Error(e?.message)); });
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
    socket.on("disconnect", (reason: string) => {
      console.log(`[diag] socket déconnecté : ${reason}`);
    });
    socket.io.on("reconnect", () => {
      console.log("[diag] socket reconnecté");
    });

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

    // ── [5] Déroulé multi-voix (conseil, F-30) : le bloc des voix doit ──
    //    survivre au « quitter puis revenir » — quel que soit le mode.   ──
    const conv3 = await emitAck(socket, "conversations:create");
    const cid3 = conv3?.conversation?.id;
    const setMode = await emitAck(socket, "conversations:setMode", {
      conversationId: cid3,
      mode: "council",
      config: { members: 2 },
    });
    check("[5] mode conseil posé (2 membres)", setMode?.ok === true, JSON.stringify(setMode).slice(0, 90));

    let flowRows: any[] = [];
    let flowStartId: string | null = null;
    let done3Message: any = null;
    let err3: string | null = null;
    socket.on("mode:flow", (p: any) => {
      if (p?.conversationId !== cid3) return;
      flowRows = Array.isArray(p.rows) ? p.rows : [];
    });
    socket.on("stream:start", (p: any) => {
      if (p?.conversationId === cid3) flowStartId = p.messageId;
    });
    const done3 = new Promise<void>((resolve) => {
      socket.on("stream:done", (p: any) => {
        if (p?.conversationId !== cid3) return;
        done3Message = p.message ?? null;
        resolve();
      });
    });
    const err3Promise = new Promise<string>((resolve) => {
      socket.on("stream:error", (p: any) => {
        if (p?.conversationId !== cid3) return;
        err3 = String(p?.error ?? "");
        resolve(err3);
      });
    });
    await emitAck(socket, "chat:send", {
      conversationId: cid3,
      content: "Question au conseil",
      model: MODEL_ID,
    });

    // Attend la première émission du déroulé (voix lancées)
    const t0 = Date.now();
    while (flowRows.length === 0 && Date.now() - t0 < 10000) await wait(100);
    check("[5] déroulé vivant reçu (mode:flow)", flowRows.length > 0, `${flowRows.length} ligne(s)`);

    // « Retour » dans la conversation pendant le tour multi-voix
    const open3 = await new Promise<any>((resolve) => {
      socket.emit("conversations:open", { id: cid3 }, (res: any) => resolve(res ?? {}));
    });
    const live3: any[] = Array.isArray(open3?.live) ? open3.live : [];
    check("[5] open renvoie le tour en vol du conseil", live3.length === 1, `${live3.length} entrée(s)`);
    check("[5] live.messageId = stream:start du conseil", live3[0]?.messageId === flowStartId);
    const snapRows: any[] = Array.isArray(live3[0]?.modeFlow) ? live3[0].modeFlow : [];
    check(
      "[5] déroulé ré-attaché (lignes complètes au retour)",
      snapRows.length > 0 &&
        snapRows.every((r) => typeof r?.id === "string" && typeof r?.label === "string" && typeof r?.status === "string"),
      `${snapRows.length} ligne(s) au retour`
    );

    const raceStart = Date.now();
    const raceWinner = await Promise.race([
      done3.then(() => "done"),
      err3Promise.then(() => "error"),
      wait(25000).then(() => "timeout"),
    ]);
    console.log(`  [diag] course: ${raceWinner} en ${Math.round((Date.now() - raceStart) / 1000)} s`);
    check("[5] tour conseil achevé sans erreur", raceWinner === "done", `erreur: ${String(err3)}`);
    const finalRows: any[] = Array.isArray(done3Message?.modeFlow) ? done3Message.modeFlow : [];
    if (raceWinner !== "done") {
      try {
        const diag = await (
          await fetch(`http://localhost:3344/diagnostics?token=${encodeURIComponent(TOKEN)}`)
        ).json();
        const events: any[] = diag?.trace ?? [];
        console.log(
          `  [diag] trace service (fin) : ${events
            .slice(-14)
            .map((e) => `${e.cat}: ${String(e.msg).slice(0, 90)}`)
            .join(" | ")}`
        );
      } catch (e) {
        console.log(`  [diag] diagnostics injoignables : ${String(e).slice(0, 80)}`);
      }
      const still = await emitAck(socket, "conversations:open", { id: cid3 });
      const stillLive: any[] = Array.isArray(still?.live) ? still.live : [];
      console.log(
        `  [diag] tour encore en vol : ${stillLive.length > 0} — statut "${String(stillLive[0]?.status)}", contenu ${String(stillLive[0]?.content ?? "").length} car., modeFlow ${Array.isArray(stillLive[0]?.modeFlow) ? stillLive[0].modeFlow.length : 0} ligne(s), dernières lignes: ${JSON.stringify((stillLive[0]?.modeFlow ?? []).map((r: any) => `${r.label}:${r.status}`))}`
      );
    }
    check(
      "[5] déroulé persisté contient les lignes vues au retour (aucune perte)",
      finalRows.length >= snapRows.length &&
        snapRows.every((r) => finalRows.some((f) => f?.id === r?.id)),
      `${snapRows.length} ligne(s) au retour → ${finalRows.length} à la clôture ; message: stopped=${String(done3Message?.stopped)} contenu=${String(done3Message?.content ?? "").length} car. — ${JSON.stringify(done3Message).slice(0, 200)}`
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
