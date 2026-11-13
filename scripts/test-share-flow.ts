// Test E2E du chantier « F-13 — Partage public lecture seule + export image » :
// création du lien (snapshot figé), données publiques HTTP (JSON sans id interne),
// statuts 404/410, image PNG (pipeline Chrome), remplacement du lien (l'ancien
// devient 410), isolation entre conversations, révocation, liens orphelins.
// Les conversations créées sont supprimées en fin de test.
import { io } from "socket.io-client";

const SERVICE_HTTP = "http://localhost:3004";
const socket = io("http://localhost:3003", { transports: ["websocket"] });
let failures = 0;
const createdConversationIds: string[] = [];

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

async function httpGet(path: string): Promise<{ status: number; body: string; contentType: string; bytes: number; headHex: string }> {
  const res = await fetch(`${SERVICE_HTTP}${path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    body: buf.subarray(0, 400).toString("utf-8"),
    contentType: res.headers.get("content-type") ?? "",
    bytes: buf.byteLength,
    headHex: buf.subarray(0, 8).toString("hex"),
  };
}

async function main() {
  // ── 1. Conversation témoin + messages ────────────────────────────
  const conv = await emit("conversations:create", { projectId: null });
  const convId = conv.conversation?.id;
  if (convId) createdConversationIds.push(convId);
  check("conversations:create", !!convId);

  // Message utilisateur direct (pas de tour LLM : le contenu nous suffit)
  await emit("message:edit", {
    conversationId: convId,
    // message:edit nécessite un message existant ; on passe par un faux tour ?
  }).catch(() => {});
  // On insère via un mini tour réel : 1 aller-retour LLM suffit
  const turnDone = new Promise<void>((resolve) => {
    socket.on("stream:done", (p: { conversationId: string }) => {
      if (p.conversationId === convId) resolve();
    });
    socket.on("stream:error", () => resolve());
  });
  socket.emit("chat:send", {
    conversationId: convId,
    content: "Réponds exactement : Ceci est le message partagé.",
  });
  await turnDone;
  const opened = await emit("conversations:open", { id: convId });
  check(
    "conversation avec messages",
    (opened.messages ?? []).length >= 2,
    `${opened.messages?.length ?? 0} message(s)`
  );

  // ── 2. share:get — aucun lien au départ ──────────────────────────
  const none = await emit("share:get", { conversationId: convId });
  check("share:get — aucun lien au départ", none.share === null || none.share === undefined);

  const noConv = await emit("share:get", { conversationId: "" });
  check("share:get sans conversationId refusé", !!noConv.error);

  // ── 3. share:create — snapshot figé ──────────────────────────────
  let broadcast: any = null;
  socket.on("share:changed", (p) => {
    if (p.conversationId === convId) broadcast = p;
  });
  const created = await emit("share:create", { conversationId: convId });
  const token = created.share?.token as string | undefined;
  check(
    "share:create — vue wire sans snapshot",
    !!created.share &&
      typeof token === "string" &&
      token.length === 24 &&
      /^[A-Za-z0-9]+$/.test(token) &&
      !("snapshot" in (created.share ?? {})),
    `token ${token?.slice(0, 8)}… · ${created.share?.messageCount} message(s)`
  );
  const badCreate = await emit("share:create", { conversationId: "id-inconnu" });
  check("share:create conversation inconnue refusé", !!badCreate.error);

  // ── 4. HTTP data.json — données publiques ────────────────────────
  const data = await httpGet(`/share/${token}/data.json`);
  check("GET data.json — 200 JSON", data.status === 200 && data.contentType.includes("application/json"));
  let parsed: any = null;
  try {
    parsed = JSON.parse(data.body.padEnd(data.body.length));
  } catch {
    try {
      parsed = JSON.parse(await (await fetch(`${SERVICE_HTTP}/share/${token}/data.json`)).text());
    } catch {
      parsed = null;
    }
  }
  check(
    "data.json — vue publique sans id interne",
    !!parsed &&
      parsed.messages?.length >= 2 &&
      parsed.messages[0].content.includes("message partagé") === false === false &&
      !("conversationId" in parsed) &&
      !("id" in parsed),
    `${parsed?.messages?.length ?? 0} message(s) publics`
  );
  check(
    "data.json — contenu du snapshot",
    parsed?.messages?.some((m: any) => m.content?.includes("message partagé")),
    "la réponse LLM contient le texte attendu"
  );

  // ── 5. Statuts d'erreur HTTP ─────────────────────────────────────
  const notfound = await httpGet(`/share/${"x".repeat(24)}/data.json`);
  check("token inconnu → 404", notfound.status === 404, `HTTP ${notfound.status}`);
  const badFormat = await httpGet(`/share/ABC/data.json`);
  check("token malformé → 404", badFormat.status === 404, `HTTP ${badFormat.status}`);

  // ── 6. image.png — capture Chrome du fil ─────────────────────────
  try {
    const png = await httpGet(`/share/${token}/image.png`);
    // Signature binaire : 89 50 4E 47 0D 0A 1A 0A (jamais une chaîne UTF-8)
    const isPng =
      png.contentType.includes("image/png") &&
      png.bytes > 5000 &&
      png.headHex === "89504e470d0a1a0a";
    check(
      "GET image.png — capture Chrome plein page",
      isPng,
      isPng ? `${(png.bytes / 1024).toFixed(0)} Ko` : `HTTP ${png.status} · ${png.contentType}`
    );
  } catch (err) {
    check("GET image.png — capture Chrome plein page", false, String(err).slice(0, 80));
  }

  // ── 7. Nouveau lien = ancien révoqué (un seul actif) ──────────────
  broadcast = null;
  const recreated = await emit("share:create", { conversationId: convId });
  const token2 = recreated.share?.token as string | undefined;
  check("share:create recrée (token différent)", !!token2 && token2 !== token);
  const oldData = await httpGet(`/share/${token}/data.json`);
  check("ancien lien → 410 Gone", oldData.status === 410, `HTTP ${oldData.status}`);
  const oldImg = await httpGet(`/share/${token}/image.png`);
  check("ancien lien image → 410 Gone", oldImg.status === 410, `HTTP ${oldImg.status}`);
  const active = await emit("share:get", { conversationId: convId });
  check("share:get ne voit que le lien actif", active.share?.token === token2);
  await new Promise((r) => setTimeout(r, 150));
  check("broadcast share:changed (création)", !!broadcast?.share?.token || broadcast?.share === null, "reçu");

  // ── 8. Isolation : une autre conversation n'a pas de lien ────────
  const conv2 = await emit("conversations:create", { projectId: null });
  const conv2Id = conv2.conversation?.id;
  if (conv2Id) createdConversationIds.push(conv2Id);
  const other = await emit("share:get", { conversationId: conv2Id });
  check("isolation — l'autre conversation n'a pas de lien", other.share == null);

  // ── 9. Conversation vide : refus ────────────────────────────────
  const emptyShare = await emit("share:create", { conversationId: conv2Id });
  check("share:create conversation vide refusé", !!emptyShare.error, emptyShare.error);

  // ── 10. Révocation ───────────────────────────────────────────────
  const revoked = await emit("share:revoke", { conversationId: convId });
  check("share:revoke", !!revoked.ok);
  const afterRevoke = await httpGet(`/share/${token2}/data.json`);
  check("lien révoqué → 410 Gone", afterRevoke.status === 410, `HTTP ${afterRevoke.status}`);
  const afterShareGet = await emit("share:get", { conversationId: convId });
  check("share:get après révocation → null", afterShareGet.share == null);
  const revokeAgain = await emit("share:revoke", { conversationId: convId });
  check("share:revoke sans lien actif — ok:false", revokeAgain.ok === false);

  // ── Nettoyage ─────────────────────────────────────────────────────
  for (const id of createdConversationIds) {
    await emit("conversations:delete", { id });
  }
  const gone = await httpGet(`/share/${token2}/data.json`);
  check("suppression de la conversation → 410 persistant", gone.status === 410, `HTTP ${gone.status}`);

  socket.disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

socket.on("connect", () => {
  void main().catch((err) => {
    console.error("Erreur du scénario :", err);
    process.exit(1);
  });
});

socket.on("connect_error", () => {
  console.error("Service hermes-chat injoignable sur le port 3003 (lancer `bun run dev`)");
  process.exit(1);
});
