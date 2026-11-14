// Debug : pourquoi le tour ne passe-t-il pas par le fournisseur du faux z.ai ?
// Reproduit le flux du test-429-reasons en affichage TOUS les journaux du service.
import { io } from "socket.io-client";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const TOKEN = "debug-jeton-429";
const SOCK_URL = "http://localhost:3323";
const DB_DIR = "/home/z/my-project/db-debug-429";
const MOCK_PORT = 3321;
const MOCK_API_KEY = "clefaux.quatrevingtneuf";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function emitAck(s: any, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) s.emit(event, (res: any) => resolve(res ?? {}));
    else s.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

const mock = createServer((req, res) => {
  const url = req.url ?? "";
  console.log(`  [MOCK] ${req.method} ${url}`);
  if (req.method === "GET" && url === "/api/paas/v4/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "glm-test-429" }] }));
    return;
  }
  if (req.method === "POST" && url === "/api/paas/v4/chat/completions") {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." } }));
    return;
  }
  res.writeHead(404); res.end("{}");
});

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  mkdirSync(DB_DIR, { recursive: true });
  const service = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
    cwd: "/home/z/my-project",
    env: {
      ...process.env,
      HERMES_SERVICE_TOKEN: TOKEN,
      HERMES_CHAT_PORT: "3323",
      HERMES_CHAT_FILES_PORT: "3324",
      HERMES_GATEWAY_URL: "",
      HERMES_CHAT_DB: join(DB_DIR, "hermes-chat.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout!.on("data", (d: Buffer) => console.log(`  [SVC] ${d.toString().trim()}`));
  service.stderr!.on("data", (d: Buffer) => console.log(`  [SVC:err] ${d.toString().trim()}`));
  await wait(2500);

  const s = await new Promise<any>((resolve, reject) => {
    const sock = io(SOCK_URL, { path: "/", transports: ["websocket"], timeout: 6000, auth: { token: TOKEN } });
    sock.on("connect", () => resolve(sock));
    sock.on("connect_error", (e: any) => reject(new Error(e?.message)));
  });

  const add = await emitAck(s, "providers:add", { name: "z.ai", kind: "llm", baseUrl: `http://localhost:${MOCK_PORT}` });
  console.log("add →", JSON.stringify(add).slice(0, 160));
  const providerId = add?.provider?.id;
  const key = await emitAck(s, "providers:add-key", { providerId, label: "Clé debug", secret: MOCK_API_KEY });
  console.log("add-key →", JSON.stringify(key).slice(0, 120));
  const test = await emitAck(s, "providers:test-key", { keyId: key?.key?.id });
  console.log("test-key →", JSON.stringify(test).slice(0, 160));

  const models = await emitAck(s, "models:list");
  console.log("models:list →", JSON.stringify(models).slice(0, 300));

  const conv = await emitAck(s, "conversations:create");
  const cid = conv?.conversation?.id;
  s.on("stream:error", (p: any) => console.log("stream:error →", p?.error));
  s.on("stream:done", (p: any) => console.log("stream:done →", JSON.stringify(p?.message?.content ?? "").slice(0, 120), "| model:", p?.message?.model));
  const ack = await emitAck(s, "chat:send", { conversationId: cid, content: "Bonjour", model: "glm-test-429" });
  console.log("chat:send ack →", JSON.stringify(ack).slice(0, 120));
  await wait(6000);

  s.close(); service.kill("SIGKILL"); mock.close();
  try { rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
main();
