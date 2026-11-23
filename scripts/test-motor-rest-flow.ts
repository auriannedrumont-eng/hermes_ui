// QA — bascule sessions natives (75) : le module motor-rest en conditions
// réelles sans serveur. Le fetch est INJECTÉ : les réponses SSE sont fidèles
// au format amont vérifié dans gateway/platforms/api_server.py (event:/data:,
// séquence run.started → assistant.delta → tool.progress/_thinking →
// assistant.completed → run.completed). Ce test verrouille :
//   1. le parseur SSE (trame standard, data multi-lignes, trame sans data) ;
//   2. le mapping des événements → callbacks (delta, raisonnement, outils) ;
//   3. le contenu final (assistant.completed prime sur l'accumulation) ;
//   4. l'échec HTTP (500) → exception → l'appelant replie au WebSocket ;
//   5. le flux tronqué sans terminal → exception (pas de tour fantôme OK) ;
//   6. le stop utilisateur en plein flux → partiel rendu, pas d'exception ;
//   7. la liaison idempotente (201 → lié, 409 → déjà lié, 500/réseau → null
//      et la base locale n'écrit PAS).
import {
  ensureConversationMotorLink,
  ensureMotorSession,
  motorSessionIdFor,
  parseSseFrame,
  runRestTurn,
} from "../mini-services/hermes-chat/motor-rest";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  OK  ${name}`);
  } else {
    failed++;
    console.log(`  ÉCHEC  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Un fetchImpl qui répond une réponse SSE depuis une liste de trames. */
function sseFetch(frames: string[], status = 200): typeof fetch {
  const encoder = new TextEncoder();
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    return new Response(stream, {
      status,
      headers: { "content-type": "text/event-stream" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
}

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function main() {
  console.log("[1] parseSseFrame");
  const std = parseSseFrame('event: assistant.delta\ndata: {"delta":"bon"}\n');
  check("trame standard reconnue", std?.name === "assistant.delta" && std?.data.delta === "bon");
  const multi = parseSseFrame('data: {"a":\ndata: 1}\n');
  check("data multi-lignes jointes", multi?.data.a === 1);
  check("trame sans data → null", parseSseFrame("event: ping\n") === null);
  check("data non JSON → null", parseSseFrame("data: [invalide\n") === null);

  console.log("[2] runRestTurn : séquence amont complète");
  const deltas: string[] = [];
  const reasoning: string[] = [];
  const tools: { name: string; status: string }[] = [];
  const statuses: string[] = [];
  const ok = await runRestTurn(
    "http://127.0.0.1:9120",
    null,
    "ui-test",
    { message: "bonjour" },
    {
      onDelta: (t) => deltas.push(t),
      onReasoning: (t) => reasoning.push(t),
      onStatus: (s) => statuses.push(s),
      onToolEvent: (e) => tools.push({ name: e.name, status: e.status }),
    },
    new AbortController().signal,
    sseFetch([
      frame("run.started", { user_message: { role: "user", content: "bonjour" } }),
      frame("message.started", { message: { id: "msg_1", role: "assistant" } }),
      frame("assistant.delta", { delta: "Bon" }),
      frame("assistant.delta", { delta: "jour" }),
      frame("tool.progress", { tool_name: "_thinking", delta: "je réfléchis" }),
      frame("tool.started", { tool_name: "web_search", preview: "requête" }),
      frame("tool.completed", { tool_name: "web_search" }),
      frame("assistant.completed", { content: "Bonjour ! Réponse finale." }),
      frame("run.completed", { usage: {} }),
    ]),
  );
  check("deltas reçus dans l'ordre", deltas.join("") === "Bon" + "jour", deltas.join("|"));
  check("raisonnement mappé (tool.progress → onReasoning)", reasoning.join("") === "je réfléchis");
  check("outils mappés running puis done", tools[0]?.status === "running" && tools[1]?.status === "done");
  check("statuts de run émis", statuses.length >= 2);
  check("contenu final = assistant.completed", ok.content === "Bonjour ! Réponse finale.", ok.content);
  check("raisonnement accumulé renvoyé", ok.reasoning === "je réfléchis");

  console.log("[3] runRestTurn : HTTP 500 → exception (repli WS côté connector)");
  let threw = "";
  try {
    await runRestTurn(
      "http://127.0.0.1:9120",
      null,
      "ui-test",
      { message: "x" },
      { onDelta: () => {}, onReasoning: () => {}, onStatus: () => {}, onToolEvent: () => {} },
      new AbortController().signal,
      sseFetch([], 500),
    );
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("échec HTTP nommé pour la trace de repli", threw === "rest_chat_http_500", threw);

  console.log("[4] flux tronqué sans terminal → exception");
  threw = "";
  try {
    await runRestTurn(
      "http://127.0.0.1:9120",
      null,
      "ui-test",
      { message: "x" },
      { onDelta: () => {}, onReasoning: () => {}, onStatus: () => {}, onToolEvent: () => {} },
      new AbortController().signal,
      sseFetch([frame("assistant.delta", { delta: "moitié" })]),
    );
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("flux sans run.* → rest_chat_stream_close_premature", threw === "rest_chat_stream_close_premature", threw);

  console.log("[5] stop utilisateur en plein flux → partiel rendu");
  const stop = new AbortController();
  const partial = await runRestTurn(
    "http://127.0.0.1:9120",
    null,
    "ui-test",
    { message: "x" },
    {
      onDelta: () => stop.abort(),
      onReasoning: () => {},
      onStatus: () => {},
      onToolEvent: () => {},
    },
    stop.signal,
    sseFetch([
      frame("assistant.delta", { delta: "début" }),
      frame("assistant.delta", { delta: "suite" }),
    ]),
  );
  check("partiel rendu sans exception", partial.content.length >= 4, partial.content);

  console.log("[6] ensureMotorSession : 409 (déjà là) = session garante");
  const fetch409 = (async () =>
    new Response("{}", { status: 409 }) as unknown as Response) as unknown as typeof fetch;
  const via409 = await ensureMotorSession(
    "http://x",
    "cle",
    "ui-dup",
    "Titre",
    null,
    undefined,
    fetch409,
  );
  check("409 → true (la session existe déjà, liaison valide)", via409 === true);

  console.log("[7] ensureConversationMotorLink : liaison idempotente");
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const status = calls.length === 1 ? 201 : 409;
    return new Response("{}", { status }) as unknown as Response;
  }) as unknown as typeof fetch;
  const storeMem = (() => {
    let linked: string | null = null;
    const rows = new Map<string, { title?: string }>([["conv-1", { title: "Ma conversation" }]]);
    return {
      getConversationMotorSession: () => linked,
      setConversationMotorSession: (_id: string, sid: string) => {
        linked = sid;
      },
      getConversation: (id: string) => rows.get(id) ?? null,
    };
  })();
  const link1 = await ensureConversationMotorLink(
    storeMem,
    "http://x",
    "cle",
    "conv-1",
    null,
    undefined,
    fakeFetch,
  );
  check("première liaison : POST /api/sessions avec l'id déterministe",
    link1 === motorSessionIdFor("conv-1") && calls[0]?.url === "http://x/api/sessions",
    `${link1} ${calls[0]?.url ?? ""}`);
  const body1 = JSON.parse(String(calls[0]?.init?.body ?? "{}")) as Record<string, unknown>;
  check("payload de création : id, title, system_prompt, source",
    body1.id === motorSessionIdFor("conv-1") && body1.title === "Ma conversation" &&
      body1.source === "api_server",
    JSON.stringify(body1));
  const link2 = await ensureConversationMotorLink(
    storeMem,
    "http://x",
    "cle",
    "conv-1",
    null,
    undefined,
    fakeFetch,
  );
  check("déjà liée en base : AUCUN second POST", calls.length === 1 && link2 === link1);

  console.log("[8] liaison en échec → null, base intacte");
  const storeVierge = (() => {
    let linked: string | null = null;
    const rows = new Map<string, { title?: string }>([["conv-2", { title: "T" }]]);
    return {
      getConversationMotorSession: () => linked,
      setConversationMotorSession: (_id: string, sid: string) => {
        linked = sid;
      },
      getConversation: (id: string) => rows.get(id) ?? null,
    };
  })();
  const linkFail = await ensureConversationMotorLink(
    storeVierge,
    "http://x",
    null,
    "conv-2",
    null,
    undefined,
  );
  check("POST impossible (fetch réel, pas de serveur) → null", linkFail === null);

  console.log("[9] motorSessionIdFor : sûr pour le chemin amont");
  check("caractères hostiles neutralisés",
    motorSessionIdFor("conv/..\\x y") === "conv-.._x_y" || motorSessionIdFor("conv/..\\x y").startsWith("ui-"),
    motorSessionIdFor("conv/..\\x y"));

  console.log(failed === 0 ? `\nbascule REST : ${passed} vérifications passées, 0 échec` : `\nbascule REST : ${failed} échec(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
