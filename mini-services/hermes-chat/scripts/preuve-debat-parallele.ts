// Preuve du débat parallèle (debateParallel) — les trois voix d'un tour
// partent ENSEMBLE et ne voient que les tours précédents :
//   1. service jetable (3345/3346) + faux fournisseur qui RÉPOND (SSE complet),
//   2. débat 1 tour, debateParallel: true, toutes les voix sur le faux fournisseur,
//   3. preuve A (réseau) : les POST /chat/completions se CHEVAUCHENT dans le temps,
//   4. preuve B (déroulé) : un instantané mode:flow montre 3 lignes « running »,
//   5. le verdict arrive (stream:done) — débat complet, pas de blocage.
import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const TOKEN = "jeton-preuve-parallele";
const SOCK_URL = "http://127.0.0.1:3345";
const DB_DIR = "/home/z/my-project/db-debug-debat-parallele";
const MOCK_PORT = 3342;
const MODEL = "glm-eclair";

const t0 = Date.now();
const at = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function emitAck(s: any, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) s.emit(event, (res: any) => resolve(res ?? {}));
    else s.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

// Journal des requêtes fournisseur : {start, end} — le chevauchement d'au
// moins deux fenêtres prouve le parallélisme côté réseau, sans ambiguïté.
const calls: { start: number; end: number }[] = [];
const mock = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.method === "GET" && /\/(v1\/)?models$/.test(url)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  if (req.method === "POST" && /\/(v1\/)?chat\/completions$/.test(url)) {
    const start = Date.now();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "argument " + i + ". " } }] })}\n\n`,
      );
      if (i >= 8) {
        clearInterval(timer);
        res.write("data: [DONE]\n\n");
        res.end();
        calls.push({ start, end: Date.now() });
      }
    }, 120);
    return;
  }
  res.writeHead(404);
  res.end("{}");
});

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  mkdirSync(DB_DIR, { recursive: true });
  const service = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
    cwd: "/home/z/my-project/hermes_ui",
    env: {
      ...process.env,
      HERMES_SERVICE_TOKEN: TOKEN,
      HERMES_CHAT_PORT: "3345",
      HERMES_CHAT_FILES_PORT: "3346",
      HERMES_GATEWAY_URL: "",
      HERMES_CHAT_DB: join(DB_DIR, "hermes-chat.sqlite"),
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
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
  });
  const providerId = add?.provider?.id;
  await emitAck(s, "providers:add-key", {
    providerId,
    label: "Clé preuve",
    secret: "cle-parallele",
  });

  let maxRunning = 0;
  let rowsSeen: any[] = [];
  s.on("mode:flow", (p: any) => {
    const running = (p.rows ?? []).filter((r: any) => r.status === "running").length;
    if (running > maxRunning) {
      maxRunning = running;
      rowsSeen = p.rows ?? [];
    }
  });
  let finalContent = "";
  let done = false;
  s.on("stream:delta", (p: any) => {
    finalContent += String(p?.delta ?? "");
  });
  s.on("stream:error", (p: any) => {
    console.log(`${at()} stream:error → ${String(p?.error ?? "").slice(0, 200)}`);
  });
  s.on("stream:done", () => {
    done = true;
  });

  const conv = await emitAck(s, "conversations:create", {
    mode: "debate",
    modeConfig: {
      rounds: 1,
      debateParallel: true,
      voices: {
        debate: { sceptique: MODEL, pragmatique: MODEL, innovateur: MODEL, juge: MODEL },
      },
    },
  });
  const cid = conv?.conversation?.id;
  if (!cid) {
    console.log(`${at()} création impossible : ${JSON.stringify(conv).slice(0, 200)}`);
    process.exit(1);
  }
  const ack = await emitAck(s, "chat:send", {
    conversationId: cid,
    content: "Faut-il brancher un agent IA sur notre support client ?",
  });
  if (!ack?.ok) {
    console.log(`${at()} chat:send refusé : ${JSON.stringify(ack).slice(0, 160)}`);
    process.exit(1);
  }

  // Attente de la fin (3 voix + verdict ≈ 5 flux × ~1 s) — plafond de sûreté 45 s.
  for (let i = 0; i < 90 && !done; i++) await wait(500);

  // Preuve A — chevauchement réseau des voix du tour 1 (les 3 premières
  // requêtes ; le verdict part après, il ne doit pas compter).
  const tour1 = calls.slice(0, 3);
  const overlap = tour1.some((a) =>
    tour1.some((b) => b !== a && b.start < a.end && a.start < b.end),
  );
  console.log(
    `${at()} fenêtres des 3 premières voix : ${tour1
      .map((c) => `${(c.start - t0) / 1000}→${((c.end - t0) / 1000).toFixed(1)}s`)
      .join(" | ")} → chevauchement ${overlap ? "OUI ✓" : "NON ✗"}`,
  );

  // Preuve B — le déroulé a montré 3 voix « running » au même instant.
  console.log(
    `${at()} déroulé : maximum de lignes « running » simultanées = ${maxRunning} ${
      maxRunning === 3 ? "✓" : "✗"
    }`,
  );
  for (const r of rowsSeen) {
    console.log(`   flow: ${r.id} | ${r.label} | ${r.status} | ${(r.detail ?? "").slice(0, 60)}`);
  }
  console.log(
    `${at()} tour terminé : stream:done ${done ? "reçu ✓" : "ABSENT ✗"}, verdict ${finalContent.length} car.`,
  );

  s.close();
  service.kill("SIGKILL");
  mock.close();
  try {
    rmSync(DB_DIR, { recursive: true, force: true });
  } catch {}
  const ok = overlap && maxRunning === 3 && done;
  console.log(`${at()} === PREUVE DÉBAT PARALLÈLE ${ok ? "RÉUSSIE ✓" : "ÉCHOUÉE ✗"} ===`);
  process.exit(ok ? 0 : 1);
}
main();
