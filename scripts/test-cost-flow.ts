// Test E2E du chantier F-21 « jetons & coût par message » :
// 1) un faux fournisseur local renvoie un usage (input/output/cost facturé) —
//    il doit être persisté sur le message et transporté à l'ouverture du fil ;
// 2) les tarifs déclarés (settings `hermes.pricing`) font un aller-retour
//    complet avec broadcast ; 3) les fonctions pures de src/lib/pricing sont
//    testées directement (parsing des libellés, calcul de coût, format $).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { io } from "socket.io-client";
import {
  estimateCost,
  formatUsd,
  parseModelLabel,
  parsePricing,
} from "../src/lib/pricing";

const MOCK_PORT = 4601;
const MOCK_SECRET = "cost-secret-123";
const socket = io("http://localhost:3003", { transports: ["websocket"] });
let failures = 0;
const createdConversationIds: string[] = [];
let providerId: string | null = null;

function log(s: string) {
  console.log("  " + s);
}

function check(label: string, ok: boolean, extra = "") {
  if (ok) log(`OK  ${label}${extra ? ` — ${extra}` : ""}`);
  else {
    failures++;
    log(`ÉCHEC  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function emit(event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (res: any) => resolve(res ?? {}));
    else socket.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

function waitEvent(name: string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`timeout en attendant ${name}`));
    }, timeoutMs);
    const handler = (p: any) => {
      clearTimeout(timer);
      socket.off(name, handler);
      resolve(p);
    };
    socket.on(name, handler);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

// ── Faux serveur OpenAI-compatible (127.0.0.1:4601) ──────────────────────
const server = createServer((req, res) => {
  (async () => {
    const auth = req.headers.authorization ?? "";
    const good = auth === `Bearer ${MOCK_SECRET}`;
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url === "/models") {
      if (!good) return send(401, { error: { message: "Invalid API key" } });
      return send(200, { data: [{ id: "cost-mini", display_name: "Cost Mini" }] });
    }
    if (req.url === "/chat/completions" && req.method === "POST") {
      if (!good) return send(401, { error: { message: "Invalid API key" } });
      const body = JSON.parse((await readBody(req)) || "{}") as any;
      if (!body.stream) return send(200, { choices: [{ message: { content: "ok" } }] });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          model: "cost-mini",
          choices: [{ delta: { content: "Réponse chiffrée." } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          model: "cost-mini",
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 21, completion_tokens: 9, cost: 0.0021 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    send(404, { error: { message: "not found" } });
  })().catch(() => {
    if (!res.writableEnded) res.end();
  });
});
server.listen(MOCK_PORT, "127.0.0.1");

async function main() {
  log("— F-21 : jetons & coût par message —");

  // Nettoyage préalable (si un run précédent a échoué avant son cleanup)
  const list0 = await emit("providers:list");
  for (const p of list0.providers ?? []) {
    if (p.baseUrl === `http://127.0.0.1:${MOCK_PORT}`) await emit("providers:remove", { id: p.id });
  }

  // 1. Tour via le pool : usage renvoyé par le faux fournisseur
  const add = await emit("providers:add", { name: `http://127.0.0.1:${MOCK_PORT}`, kind: "llm" });
  check("providers:add mock coût", !!add.provider, add.error);
  providerId = add.provider?.id ?? null;
  await emit("providers:add-key", {
    providerId,
    label: "QA coût",
    secret: MOCK_SECRET,
  });

  const conv = await emit("conversations:create", {});
  const convId = conv.conversation?.id;
  if (convId) createdConversationIds.push(convId);
  const doneP = waitEvent("stream:done", 20000);
  await emit("chat:send", {
    conversationId: convId,
    content: "Réponds en une phrase",
    modelId: "cost-mini",
  });
  const done = await doneP;
  check("tour via le pool", done.message?.model === "cost-mini · 127.0.0.1", String(done.message?.model));
  check(
    "usage facturé transporté dans stream:done",
    done.message?.usage?.input === 21 &&
      done.message?.usage?.output === 9 &&
      done.message?.usage?.cost === 0.0021,
    JSON.stringify(done.message?.usage),
  );

  // 2. Persistance : réouverture du fil
  const opened = await emit("conversations:open", { id: convId });
  const persisted = (opened.conversation?.messages ?? opened.messages ?? []).find(
    (m: any) => m.role === "assistant",
  );
  check(
    "usage persisté (réouverture du fil)",
    persisted?.usage?.input === 21 && persisted?.usage?.output === 9 && persisted?.usage?.cost === 0.0021,
    JSON.stringify(persisted?.usage),
  );

  // 3. Tarifs : aller-retour settings + broadcast
  const changedP = waitEvent("settings:changed", 8000);
  const setRes = await emit("settings:set", {
    key: "hermes.pricing",
    value: JSON.stringify({ "cost-mini": { input: 10, output: 20 } }),
  });
  check("settings:set hermes.pricing", !!setRes.ok, setRes.error);
  try {
    const changed = await changedP;
    check("broadcast settings:changed", changed.key === "hermes.pricing");
  } catch (e) {
    check("broadcast settings:changed", false, String(e));
  }
  const got = await emit("settings:get", { key: "hermes.pricing" });
  check("settings:get round-trip", got.value?.includes('"cost-mini"') === true, String(got.value).slice(0, 80));

  // 4. Fonctions pures (src/lib/pricing)
  const p1 = parseModelLabel("glm-4.6 · z.ai");
  check("parseModelLabel « id · fournisseur »", p1?.id === "glm-4.6" && p1?.provider === "z.ai", JSON.stringify(p1));
  const p2 = parseModelLabel("Hermes 4 70B (démo)");
  check("parseModelLabel « (démo) »", p2?.id === "Hermes 4 70B" && !p2?.provider, JSON.stringify(p2));
  const p3 = parseModelLabel("Cost Mini");
  check("parseModelLabel libellé seul", p3?.id === "Cost Mini", JSON.stringify(p3));
  check("parseModelLabel vide", parseModelLabel("") === null && parseModelLabel(null) === null);

  check(
    "estimateCost avec tarifs (21×10 + 9×20 par M)",
    estimateCost({ input: 21, output: 9 }, { input: 10, output: 20 }) === 0.00039,
    String(estimateCost({ input: 21, output: 9 }, { input: 10, output: 20 })),
  );
  check("estimateCost sans tarifs → null", estimateCost({ input: 21, output: 9 }, undefined) === null);
  check("estimateCost tarifs nuls → null", estimateCost({ input: 21, output: 9 }, { input: 0, output: 0 }) === null);

  check("formatUsd petit montant", formatUsd(0.0021) === "0,0021 $", formatUsd(0.0021));
  check("formatUsd grand montant", formatUsd(12.4) === "12,40 $", formatUsd(12.4));
  check("formatUsd infinitésimal", formatUsd(0.000004) === "< 0,0001 $", formatUsd(0.000004));

  check(
    "parsePricing JSON valide",
    parsePricing('{"a":{"input":1,"output":2}}')?.a?.input === 1,
  );
  check("parsePricing JSON invalide → vide", Object.keys(parsePricing("{oops")).length === 0);
  check("parsePricing valeurs négatives ignorées", parsePricing('{"a":{"input":-1,"output":2}}').a === undefined);

  await finish();
}

async function finish() {
  if (finish.called) return;
  finish.called = true;
  for (const id of createdConversationIds) await emit("conversations:delete", { id });
  if (providerId) await emit("providers:remove", { id: providerId });
  await emit("settings:set", { key: "hermes.pricing", value: "{}" });
  log(`— ${failures === 0 ? "TOUS OK" : `${failures} ÉCHEC(S)`} —`);
  server.close();
  socket.close();
  process.exit(failures === 0 ? 0 : 1);
}
finish.called = false;

socket.on("connect", () => {
  main().catch((err) => {
    console.error("Erreur du scénario :", err);
    finish();
  });
});
socket.on("connect_error", (err: Error) => {
  console.error("Connexion impossible au service (port 3003) :", err.message);
  console.error("Lance d'abord le mini-service : cd mini-services/hermes-chat && bun run dev");
  process.exit(1);
});
