// Test E2E du chantier v2.3 « moteur via clés fournisseurs » (llm-pool.ts) :
// un faux serveur OpenAI-compatible tourne sur 127.0.0.1:4599 (le mini-service
// autorise http strictement local, même règle que le test de clé). On y
// déclare un fournisseur personnalisé, puis on vérifie : listes vivantes,
// filtrage des modèles non-chat, clé refusée (déclassement + erreur claire),
// tour nominal streamé, stop en plein vol, retente vision, repli SDK quand
// le porte-clés est vide. Les données créées sont nettoyées en fin de test.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { io } from "socket.io-client";

const MOCK_PORT = 4599;
const MOCK_SECRET = "mock-secret-123";
const socket = io("http://localhost:3003", { transports: ["websocket"] });
let failures = 0;
const createdConversationIds: string[] = [];
let customProviderId: string | null = null;

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

// ── Faux serveur OpenAI-compatible (127.0.0.1:4599) ──────────────────────
// GET /models → 200 si Bearer mock-secret-123, sinon 401.
// POST /chat/completions : 401 si mauvais secret ; 400 « image » si le modèle
// mock-mini reçoit des content parts ; sinon SSE (ou JSON si stream absent).
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization ?? "";
  // La mauvaise clé passe la LISTE (comme une clé tout juste périmée) mais
  // est refusée au TOUR — c'est ce chemin que le QA doit couvrir.
  const known = auth === `Bearer ${MOCK_SECRET}` || auth === "Bearer wrong-key";
  const good = auth === `Bearer ${MOCK_SECRET}`;
  const send = (status: number, json: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  };
  if (req.url === "/models") {
    if (!known) return send(401, { error: { message: "Invalid API key" } });
    return send(200, {
      data: [
        { id: "mock-mini", display_name: "Mock Mini" },
        { id: "mock-vision", display_name: "Mock Vision" },
        { id: "mock-embed" },
        { id: "mock-tts" },
      ],
    });
  }
  if (req.url === "/chat/completions" && req.method === "POST") {
    if (!good) return send(401, { error: { message: "Invalid API key for this model" } });
    const body = JSON.parse((await readBody(req)) || "{}") as any;
    const userMsg = body.messages?.[body.messages.length - 1];
    const hasImages = Array.isArray(userMsg?.content);
    const text =
      typeof userMsg?.content === "string"
        ? userMsg.content
        : String(userMsg?.content?.[0]?.text ?? "");
    if (body.model === "mock-mini" && hasImages) {
      return send(400, {
        error: { message: "mock-mini does not support image content parts" },
      });
    }
    if (!body.stream) {
      // Synthèse non streamée (compaction via pool)
      return send(200, {
        choices: [{ message: { content: "Résumé mock de compaction." } }],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      });
    }
    const slow = /LENTEUR/.test(text);
    const vision = body.model === "mock-vision";
    const chunks = vision
      ? ["Voici ", "l'image ", "décrite."]
      : ["Bonjour ", "du mock ! ", "Comment allez-vous ?"];
    const events: unknown[] = [];
    const finalEvent = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, slow ? 500 : 0);
      });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const c of chunks) {
      await finalEvent();
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: c } }] })}\n\n`);
    }
    res.write(
      `data: ${JSON.stringify({
        model: body.model,
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 21, completion_tokens: 9 },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  send(404, { error: { message: "not found" } });
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.writableEnded) res.end();
  });
});
server.listen(MOCK_PORT, "127.0.0.1");

async function main() {
  log("— Chantier v2.3 : tours via clés fournisseurs (llm-pool) —");

  // 0. État initial : base vierge de fournisseur (sinon on nettoie d'abord)
  const list0 = await emit("providers:list");
  for (const p of list0.providers ?? []) {
    if (p.name === "localhost") await emit("providers:remove", { id: p.id });
  }

  // 1. Fournisseur personnalisé → base http locale (autorisée)
  const add = await emit("providers:add", { name: `http://127.0.0.1:${MOCK_PORT}`, kind: "llm" });
  check("providers:add mock personnalisé", !!add.provider, add.error);
  if (!add.provider) return finish();
  customProviderId = add.provider.id;
  check(
    "base du fournisseur = http local",
    add.provider.baseUrl === `http://127.0.0.1:${MOCK_PORT}`,
    add.provider.baseUrl,
  );

  // 2. Clé erronée d'abord (untested → le pool la tentera)
  const badKey = await emit("providers:add-key", {
    providerId: customProviderId,
    label: "Piège",
    secret: "wrong-key",
  });
  check("add-key « Piège »", !!badKey.key?.id);

  // 3. models:list pendant que la seule clé est untested → vivante
  const ml = await emit("models:list");
  check(
    "models:list source providers",
    ml.source === "providers",
    `source=${ml.source} (${(ml.models ?? []).length} modèles)`,
  );
  const ids = (ml.models ?? []).map((m: any) => m.id);
  check("liste vivante contient mock-mini et mock-vision", ids.includes("mock-mini") && ids.includes("mock-vision"), ids.join(","));
  check("modèles non-chat filtrés (embed, tts)", !ids.includes("mock-embed") && !ids.includes("mock-tts"));
  check(
    "defaultModel = premier modèle vivant",
    ml.defaultModel === "mock-mini",
    `default=${ml.defaultModel}`,
  );
  check(
    "libellés exposés (display_name)",
    (ml.models ?? []).find((m: any) => m.id === "mock-mini")?.label === "Mock Mini",
  );

  // 4. Tour avec la clé erronée → 401 mock → déclassement → erreur claire
  const conv1 = await emit("conversations:create", {});
  if (conv1.conversation) createdConversationIds.push(conv1.conversation.id);
  const convId1 = conv1.conversation.id;
  const errP = waitEvent("stream:error", 20000);
  await emit("chat:send", {
    conversationId: convId1,
    content: "Dis bonjour",
    modelId: "mock-mini",
  });
  try {
    const err = await errP;
    check(
      "stream:error explicite (clé refusée, pas de repli silencieux)",
      /refusée/.test(String(err.error)) && /plus aucune clé|aucune clé/.test(String(err.error)),
      String(err.error).slice(0, 120),
    );
  } catch (e) {
    check("stream:error explicite (clé refusée)", false, String(e));
  }
  const afterAuth = await emit("providers:list");
  const pi = (afterAuth.providers ?? []).find((p: any) => p.id === customProviderId);
  const badRow = pi?.keys.find((k: any) => k.label === "Piège");
  check(
    "clé fautive déclassée (status error)",
    badRow?.status === "error" && /refusée/.test(String(badRow.statusLabel)),
    `${badRow?.status} · ${badRow?.statusLabel}`,
  );

  // 5. Ajout de la bonne clé → retour aux listes vivantes
  const goodKey = await emit("providers:add-key", {
    providerId: customProviderId,
    label: "Bonne",
    secret: MOCK_SECRET,
  });
  check("add-key « Bonne »", !!goodKey.key?.id);
  const ml2 = await emit("models:list");
  check("models:list providers rétabli", ml2.source === "providers" && (ml2.models ?? []).some((m: any) => m.id === "mock-mini"));

  // 6. Tour nominal streamé
  const deltasP = waitEvent("stream:done", 20000);
  const deltaChunks: string[] = [];
  const onDelta = (p: any) => {
    if (p.conversationId === convId1 && p.delta) deltaChunks.push(p.delta);
  };
  socket.on("stream:delta", onDelta);
  await emit("chat:send", {
    conversationId: convId1,
    content: "Dis bonjour (2e tentative)",
    modelId: "mock-mini",
  });
  try {
    const done = await deltasP;
    check("tour nominal : stream:done", !!done.message, `stopped=${done.stopped}`);
    check(
      "contenu complet streamé",
      done.message?.content === "Bonjour du mock ! Comment allez-vous ?",
      JSON.stringify(done.message?.content),
    );
    // Coalescence 16 ms du service : 2 deltas groupés suffisent (stream vivant).
    check("deltas reçus en direct", deltaChunks.length >= 2, `${deltaChunks.length} deltas (coalescence 16 ms)`);
    check(
      "message persisté sous le modèle réel du fournisseur",
      done.message?.model === "mock-mini · 127.0.0.1",
      String(done.message?.model),
    );
  } catch (e) {
    check("tour nominal", false, String(e));
  }
  socket.off("stream:delta", onDelta);

  // 7. Stop en plein vol (mock lent) : on coupe au premier delta
  const doneSlowP = waitEvent("stream:done", 25000);
  let stoppedSent = false;
  const onStopDelta = (p: any) => {
    if (p.conversationId !== convId1 || stoppedSent || !p.delta) return;
    stoppedSent = true;
    emit("chat:stop", { conversationId: convId1 });
  };
  socket.on("stream:delta", onStopDelta);
  await emit("chat:send", {
    conversationId: convId1,
    content: "LENTEUR raconte quelque chose de long",
    modelId: "mock-mini",
  });
  try {
    const done = await doneSlowP;
    check(
      "stop en plein vol : partiel conservé, marqueur stopped",
      done.stopped === true &&
        typeof done.message?.content === "string" &&
        done.message.content.length > 0 &&
        done.message.content.length < 40,
      `partiel=${JSON.stringify(done.message?.content)}`,
    );
  } catch (e) {
    check("stop en plein vol", false, String(e));
  }
  socket.off("stream:delta", onStopDelta);

  // 8. Vision : mock-mini refuse les images → retente automatiquement mock-vision
  const png1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const up = await emit("attachments:upload", {
    name: "point.png",
    mime: "image/png",
    dataBase64: png1x1,
  });
  check("upload image", !!up.attachment?.url, up.error);
  const doneVisionP = waitEvent("stream:done", 25000);
  await emit("chat:send", {
    conversationId: convId1,
    content: "Décris cette image",
    modelId: "mock-mini",
    attachments: up.attachment ? [up.attachment] : undefined,
  });
  try {
    const done = await doneVisionP;
    check(
      "retente vision automatique sur mock-vision",
      done.message?.model === "mock-vision · 127.0.0.1",
      String(done.message?.model),
    );
    check(
      "réponse du modèle vision",
      done.message?.content === "Voici l'image décrite.",
      JSON.stringify(done.message?.content),
    );
  } catch (e) {
    check("retente vision", false, String(e));
  }

  // 9. Retrait du fournisseur → repli catalogue puis SDK
  const rm = await emit("providers:remove", { id: customProviderId });
  check("providers:remove", !!rm.ok, rm.error);
  customProviderId = null;
  const ml3 = await emit("models:list");
  check(
    "repli catalogue sans fournisseur actif",
    ml3.source === "catalogue" && (ml3.models ?? []).some((m: any) => m.id === "hermes-4-70b"),
    `source=${ml3.source}`,
  );
  const doneSdkP = waitEvent("stream:done", 30000);
  const errSdkP = waitEvent("stream:error", 30000);
  await emit("chat:send", {
    conversationId: convId1,
    content: "Réponds en un mot : ok",
    modelId: null,
  });
  try {
    const done = await Promise.race([doneSdkP, errSdkP]);
    if (done.message?.content) {
      check(
        "repli SDK intégré (bac à sable) : tour (démo)",
        /\(démo\)$/.test(String(done.message?.model)),
        String(done.message?.model),
      );
    } else {
      check(
        "sans SDK : erreur pédagogique orientant vers les clés",
        /\.z-ai-config/.test(String(done.error)) && /Fournisseurs & clés/.test(String(done.error)),
        String(done.error).slice(0, 140),
      );
    }
  } catch (e) {
    check("repli SDK / erreur pédagogique", false, String(e));
  }

  await finish();
}

async function finish() {
  if (finish.called) return;
  finish.called = true;
  // Nettoyage : conversations et fournisseur de test
  for (const id of createdConversationIds) {
    await emit("conversations:delete", { id });
  }
  if (customProviderId) await emit("providers:remove", { id: customProviderId });
  const end = await emit("models:list");
  check("nettoyage : retour au catalogue", end.source !== "providers" || (end.models ?? []).every((m: any) => m.id !== "mock-mini"));
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
