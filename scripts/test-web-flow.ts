// Test E2E du chantier F-09/F-12 « recherche web + citations » :
// un faux serveur local joue Tavily (/search) ET un LLM OpenAI-compatible
// (/chat/completions, /models). On vérifie : la bascule du toggle, l'événement
// outil « Recherche web » (running → done), l'injection des résultats dans le
// contexte du tour (la réponse du mock en porte la trace), les sources
// persistées et renvoyées, le repli sans clé (erreur honnête, tour sauf),
// et l'absence de recherche quand le toggle est éteint.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { io } from "socket.io-client";

const MOCK_PORT = 4602;
const MOCK_SECRET = "web-secret-123";
const socket = io("http://localhost:3003", { transports: ["websocket"] });
let failures = 0;
const createdConversationIds: string[] = [];
const createdProviderIds: string[] = [];

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

function waitEvent(name: string, timeoutMs = 20000): Promise<any> {
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

// ── Faux serveur (127.0.0.1:4602) : Tavily + LLM sur la même base ────────
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
      return send(200, { data: [{ id: "web-mini", display_name: "Web Mini" }] });
    }
    if (req.url === "/search" && req.method === "POST") {
      if (!good) return send(401, { error: { message: "Invalid API key" } });
      return send(200, {
        results: [
          {
            title: "Hermes Web",
            url: "https://example.com/hermes",
            content: "Hermes Web est une interface de chat.",
          },
          {
            title: "Docs",
            url: "https://example.com/docs",
            content: "La documentation.",
          },
        ],
      });
    }
    if (req.url === "/chat/completions" && req.method === "POST") {
      if (!good) return send(401, { error: { message: "Invalid API key" } });
      const body = JSON.parse((await readBody(req)) || "{}") as any;
      const system = String(body.messages?.[0]?.content ?? "");
      const withWeb = system.includes("[Résultats de recherche web");
      const content = withWeb
        ? "Selon [1], Hermes Web est une interface de chat."
        : "Réponse sans contexte web.";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          model: "web-mini",
          choices: [{ delta: { content } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          model: "web-mini",
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
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
  log("— F-09/F-12 : recherche web + citations —");

  // Nettoyage préalable
  const list0 = await emit("providers:list");
  for (const p of list0.providers ?? []) {
    if (p.baseUrl === `http://127.0.0.1:${MOCK_PORT}` || p.name === "Tavily") {
      await emit("providers:remove", { id: p.id });
    }
  }

  // 1. Fournisseur LLM (pool) + fournisseur Tavily (surcharge d'adresse locale)
  const llm = await emit("providers:add", { name: `http://127.0.0.1:${MOCK_PORT}`, kind: "llm" });
  check("providers:add LLM mock", !!llm.provider, llm.error);
  if (llm.provider) createdProviderIds.push(llm.provider.id);
  await emit("providers:add-key", { providerId: llm.provider?.id, label: "QA web LLM", secret: MOCK_SECRET });

  const tavily = await emit("providers:add", {
    name: "Tavily",
    kind: "service",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
  });
  check(
    "providers:add Tavily avec adresse explicite (surcharge)",
    tavily.provider?.baseUrl === `http://127.0.0.1:${MOCK_PORT}`,
    `${tavily.provider?.name} · ${tavily.provider?.baseUrl} (${tavily.error ?? ""})`,
  );
  if (tavily.provider) createdProviderIds.push(tavily.provider.id);
  const tkey = await emit("providers:add-key", {
    providerId: tavily.provider?.id,
    label: "QA web",
    secret: MOCK_SECRET,
  });
  check("add-key Tavily", !!tkey.key?.id);

  // 2. Tour AVEC recherche web
  const conv = await emit("conversations:create", {});
  const convId = conv.conversation?.id;
  if (convId) createdConversationIds.push(convId);

  const toolEvents: any[] = [];
  const onTool = (p: any) => {
    if (p.conversationId === convId) toolEvents.push(p.event);
  };
  socket.on("stream:tool", onTool);
  const doneP = waitEvent("stream:done", 20000);
  await emit("chat:send", {
    conversationId: convId,
    content: "Que disent les sources sur Hermes Web ?",
    modelId: "web-mini",
    webSearch: true,
  });
  try {
    const done = await doneP;
    const web = (done.message?.toolEvents ?? []).filter((e: any) => e.name === "Recherche web");
    check(
      "événements outil « Recherche web » (running puis done)",
      web.length >= 2 && web[0].status === "running" && web[web.length - 1].status === "done",
      web.map((e: any) => `${e.status}(${e.detail})`).join(" → "),
    );
    check(
      "sources persistées sur le message",
      done.message?.sources?.length === 2 &&
        done.message.sources[0].n === 1 &&
        done.message.sources[0].url === "https://example.com/hermes",
      JSON.stringify(done.message?.sources?.map((s: any) => s.title)),
    );
    check(
      "réponse citant [1] — preuve de l'injection dans le contexte",
      done.message?.content === "Selon [1], Hermes Web est une interface de chat.",
      JSON.stringify(done.message?.content),
    );
    check("tour via le pool", done.message?.model === "web-mini · 127.0.0.1", String(done.message?.model));
  } catch (e) {
    check("tour avec recherche web", false, String(e));
  }
  socket.off("stream:tool", onTool);

  // 3. Persistance à la réouverture
  const opened = await emit("conversations:open", { id: convId });
  const persisted = (opened.conversation?.messages ?? opened.messages ?? []).find(
    (m: any) => m.role === "assistant" && m.sources?.length,
  );
  check("sources persistées (réouverture du fil)", !!persisted, JSON.stringify(persisted?.sources?.map((s: any) => s.n)));

  // 4. Toggle éteint : aucune recherche, aucune source
  const done2P = waitEvent("stream:done", 20000);
  await emit("chat:send", {
    conversationId: convId,
    content: "Autre question sans le web",
    modelId: "web-mini",
    webSearch: false,
  });
  try {
    const done2 = await done2P;
    const web2 = (done2.message?.toolEvents ?? []).filter((e: any) => e.name === "Recherche web");
    check("toggle éteint : aucun événement recherche", web2.length === 0);
    check("toggle éteint : aucune source", !done2.message?.sources);
    check(
      "réponse sans contexte web",
      done2.message?.content === "Réponse sans contexte web.",
      JSON.stringify(done2.message?.content),
    );
  } catch (e) {
    check("toggle éteint", false, String(e));
  }

  // 5. Sans clé Tavily : erreur honnête, tour quand même
  const keys = await emit("providers:list");
  const tavilyView = (keys.providers ?? []).find((p: any) => p.name === "Tavily");
  for (const k of tavilyView?.keys ?? []) {
    await emit("providers:remove-key", { keyId: k.id });
  }
  const done3P = waitEvent("stream:done", 20000);
  await emit("chat:send", {
    conversationId: convId,
    content: "Encore une question, le web est allumé mais la clé est partie",
    modelId: "web-mini",
    webSearch: true,
  });
  try {
    const done3 = await done3P;
    const web3 = (done3.message?.toolEvents ?? []).filter((e: any) => e.name === "Recherche web");
    check(
      "sans clé : événement outil en erreur, message clair",
      web3.length >= 1 && web3[web3.length - 1].status === "error",
      web3.map((e: any) => `${e.status}(${e.detail})`).join(" → "),
    );
    check("sans clé : le tour n'échoue pas", !!done3.message?.content, JSON.stringify(done3.message?.content));
    check("sans clé : aucune source", !done3.message?.sources);
  } catch (e) {
    check("sans clé Tavily", false, String(e));
  }

  await finish();
}

async function finish() {
  if (finish.called) return;
  finish.called = true;
  for (const id of createdConversationIds) await emit("conversations:delete", { id });
  for (const id of createdProviderIds) await emit("providers:remove", { id });
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
