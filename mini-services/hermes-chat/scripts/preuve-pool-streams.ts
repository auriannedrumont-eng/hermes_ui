// Preuve du suivi live des tours LLM (F-31ter) — le rapport /diagnostics doit
// trancher « lent vs mort » PENDANT le tour, sans attendre la garde :
//   1. faux fournisseur : 2 morceaux SSE puis silence TOTAL (connexion ouverte),
//   2. tour lancé → à +2 s : pool.streams = 1 entrée, bytes > 0, dernier octet
//      récent → « vivant mais lent » est LISIBLE,
//   3. garde d'inactivité (HERMES_TURN_STALL_MS=8000) coupe à ~8 s →
//      stream:error avec le motif parlant,
//   4. à la fin du vol : pool.streams VIDE (aucune entrée qui fuit).
import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const TOKEN = "jeton-preuve-pool";
const SOCK_URL = "http://127.0.0.1:3343";
const DIAG = "http://127.0.0.1:3344/diagnostics";
const DB_DIR = "/home/z/my-project/db-debug-poolstats";
const MOCK_PORT = 3341;
const STALL_MS = 8000;

const t0 = Date.now();
const at = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function emitAck(s: any, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) s.emit(event, (res: any) => resolve(res ?? {}));
    else s.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

// Faux fournisseur « bavard puis muet » : la connexion reste ouverte SANS
// envoyer le moindre octet après les deux morceaux — exactement le cas où la
// garde d'inactivité finit par tirer et où le rapport doit avoir dit avant.
const mock = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET" && (url === "/models" || url === "/api/paas/v4/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "glm-goutte" }] }));
    return;
  }
  if (
    req.method === "POST" &&
    (url === "/chat/completions" || url === "/api/paas/v4/chat/completions")
  ) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    });
    const chunk = (content: string) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    res.write(chunk("Bon"));
    setTimeout(() => {
      res.write(chunk("jour"));
      // …puis plus JAMAIS rien, et pas de fin de flux : fournisseur muet.
    }, 500);
    return;
  }
  res.writeHead(404);
  res.end("{}");
});

async function pools() {
  const res = await fetch(DIAG, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const json: any = await res.json();
  return json?.pool?.streams ?? [];
}

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  mkdirSync(DB_DIR, { recursive: true });
  const service = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
    cwd: "/home/z/my-project/hermes_ui",
    env: {
      ...process.env,
      HERMES_SERVICE_TOKEN: TOKEN,
      HERMES_CHAT_PORT: "3343",
      HERMES_CHAT_FILES_PORT: "3344",
      HERMES_GATEWAY_URL: "",
      HERMES_CHAT_DB: join(DB_DIR, "hermes-chat.sqlite"),
      HERMES_TURN_STALL_MS: String(STALL_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout!.on("data", (d: Buffer) => console.log(`  [SVC] ${d.toString().trim()}`));
  service.stderr!.on("data", (d: Buffer) => console.log(`  [SVC:err] ${d.toString().trim()}`));
  await wait(2500);

  const s = await new Promise<any>((resolve, reject) => {
    const sock = io(SOCK_URL, {
      path: "/",
      transports: ["websocket"],
      timeout: 6000,
      auth: { token: TOKEN },
    });
    sock.on("connect", () => resolve(sock));
    sock.on("connect_error", (e: any) => reject(new Error(e?.message)));
  });

  const add = await emitAck(s, "providers:add", {
    name: "z.ai",
    kind: "llm",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
  });
  const providerId = add?.provider?.id;
  await emitAck(s, "providers:add-key", {
    providerId,
    label: "Clé preuve",
    secret: "cle-preuve.goutte",
  });
  const conv = await emitAck(s, "conversations:create");
  const cid = conv?.conversation?.id;

  let guardError = "";
  s.on("stream:error", (p: any) => {
    guardError = String(p?.error ?? "");
    console.log(`${at()} stream:error → ${guardError.slice(0, 160)}`);
  });
  s.on("stream:done", (p: any) =>
    console.log(`${at()} stream:done → ${JSON.stringify(p?.message?.content ?? "").slice(0, 80)}`),
  );

  const before = await pools();
  console.log(`${at()} avant le tour : pool.streams = ${before.length} entrée(s)`);
  const ack = await emitAck(s, "chat:send", { conversationId: cid, content: "Salut", model: "glm-goutte" });
  console.log(`${at()} chat:send ack → ${JSON.stringify(ack).slice(0, 100)}`);

  await wait(2000); // morceaux à ~0/0.5 s, silence ensuite
  const inflight = await pools();
  const okInflight =
    inflight.length === 1 &&
    inflight[0].provider === "z.ai" &&
    inflight[0].model === "glm-goutte" &&
    inflight[0].bytes > 0 &&
    inflight[0].lastByteAgeS < 3 &&
    inflight[0].startedAgoS >= 1;
  console.log(
    `${at()} EN VOL : ${JSON.stringify(inflight)} → ${
      okInflight ? "LENT vs MORT LISIBLE ✓" : "✗ suivi en vol insuffisant"
    }`,
  );

  await wait(9000); // garde 8 s → erreur honnête + vol terminé
  const after = await pools();
  const guardOk = guardError.includes("plus aucun octet") && guardError.includes("z.ai");
  console.log(
    `${at()} APRÈS GARDE : pool.streams = ${after.length} entrée(s), motif = « ${guardError.slice(0, 120)} » → ${
      after.length === 0 && guardOk ? "NETTOYAGE + MOTIF PROUVÉS ✓" : "✗ fuite ou motif absent"
    }`,
  );

  s.close();
  service.kill("SIGKILL");
  mock.close();
  try {
    rmSync(DB_DIR, { recursive: true, force: true });
  } catch {}
  process.exit(okInflight && after.length === 0 && guardOk ? 0 : 1);
}
main();
