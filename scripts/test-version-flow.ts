// Test E2E du chantier « F-14 — Navigation entre versions » : régénérer
// ne supprime plus l'ancienne réponse — elle devient une version inactive
// conservée en base ; le fil n'affiche que la version active, avec la meta
// ‹ index/count › ; message:setVersion bascule la version affichée (et
// envoyée au modèle) ; les côtés d'une comparaison versionnent séparément ;
// supprimer la version active promeut la précédente. Tours via moteur démo.
import { io } from "socket.io-client";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attend n stream:done (tour simple ou variantes) et capture les messages. */
function waitEnds(conversationId: string, expected = 1, timeoutMs = 120_000) {
  return new Promise<{ messages: any[]; errors: string[] }>((resolve) => {
    const messages: any[] = [];
    const errors: string[] = [];
    const timer = setTimeout(() => finish(), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("stream:done", onDone);
      socket.off("stream:error", onError);
    }
    function finish() {
      cleanup();
      resolve({ messages, errors });
    }
    const onDone = (p: { conversationId: string; message?: any }) => {
      if (p.conversationId !== conversationId) return;
      messages.push(p.message ?? null);
      if (messages.length >= expected) finish();
    };
    const onError = (p: { conversationId: string; error?: string }) => {
      if (p.conversationId !== conversationId) return;
      errors.push(p.error ?? "erreur");
      if (errors.length >= expected) finish();
    };
    socket.on("stream:done", onDone);
    socket.on("stream:error", onError);
  });
}

async function main() {
  console.log("── F-14 : navigation entre versions ──");
  if (!socket.connected) await new Promise<void>((r) => socket.on("connect", r));

  // ── Scénario 1 : régénérer conserve l'ancienne réponse ──────────────
  console.log("Scénario 1 — régénération = version, pas suppression");
  let convId = "";
  let v1Id = "";
  {
    const conv: any = await emit("conversations:create", {});
    createdConversationIds.push(conv.conversation.id);
    convId = conv.conversation.id;
    let end = waitEnds(convId);
    await emit("chat:send", { conversationId: convId, content: "Réponds en une phrase : que vaut 5+5 ?" });
    let cap = await end;
    v1Id = cap.messages[0]?.id;
    check("v1 reçue", Boolean(v1Id));

    // Écoute de la supersession AVANT la régénération
    const supersededIds: string[] = [];
    const removedIds: string[] = [];
    const onSup = (p: { conversationId: string; messageIds: string[] }) => {
      if (p.conversationId === convId) supersededIds.push(...p.messageIds);
    };
    const onRem = (p: { conversationId: string; messageIds: string[] }) => {
      if (p.conversationId === convId) removedIds.push(...p.messageIds);
    };
    socket.on("messages:superseded", onSup);
    socket.on("messages:removed", onRem);

    end = waitEnds(convId);
    await sleep(6000); // anti-429
    await emit("chat:regenerate", { conversationId: convId, model: "hermes-4-70b" });
    cap = await end;
    socket.off("messages:superseded", onSup);
    socket.off("messages:removed", onRem);

    const v2 = cap.messages[0];
    check("v2 reçue", Boolean(v2?.id) && v2.id !== v1Id);
    check("messages:superseded diffusé (pas removed)", supersededIds.includes(v1Id) && !removedIds.includes(v1Id),
      `superseded=${supersededIds.join(",")}`);
    check("v2 porte la meta versions {index:2, count:2}",
      v2?.versions?.group === v1Id && v2?.versions?.index === 2 && v2?.versions?.count === 2,
      JSON.stringify(v2?.versions ?? null));

    const msgs: any = await emit("conversations:open", { id: convId });
    const list = msgs.messages ?? [];
    check("fil = 1 user + 1 assistant actif", list.filter((m: any) => m.role === "assistant").length === 1,
      `${list.length} messages`);
    const active = list.find((m: any) => m.role === "assistant");
    check("l'active est v2 avec meta n/m", active?.id === v2.id && active?.versions?.index === 2);
    check("v1 conservée en base (id différent)", active?.id !== v1Id);
  }

  // ── Scénario 2 : navigation entre versions ──────────────────────────
  console.log("Scénario 2 — bascule de version affichée");
  let group = "";
  {
    const refreshed: any[] = [];
    const onRef = (p: { conversationId: string; messages: any[] }) => {
      if (p.conversationId === convId) refreshed.push(p.messages);
    };
    socket.on("messages:refreshed", onRef);
    const bad = await emit("message:setVersion", { conversationId: convId, group: v1Id, index: 9 });
    check("index hors bornes → refus propre", Boolean(bad?.error));
    const okRes = await emit("message:setVersion", { conversationId: convId, group: v1Id, index: 1 });
    check("bascule vers v1 acceptée", okRes?.ok === true);
    await sleep(500);
    socket.off("messages:refreshed", onRef);
    check("messages:refreshed diffusé", refreshed.length >= 1);
    const list1 = refreshed[refreshed.length - 1] ?? [];
    const active1 = list1.find((m: any) => m.role === "assistant");
    check("v1 est désormais la version active", active1?.id === v1Id && active1?.versions?.index === 1,
      `id=${active1?.id?.slice(0, 8)} index=${active1?.versions?.index}`);
    group = active1?.versions?.group ?? v1Id;

    // Retour sur v2 (état final propre pour la suite)
    await emit("message:setVersion", { conversationId: convId, group, index: 2 });
    await sleep(300);
  }

  // ── Scénario 3 : comparaison — chaque côté versionne séparément ─────
  console.log("Scénario 3 — versions par côté de comparaison");
  {
    const conv: any = await emit("conversations:create", {});
    createdConversationIds.push(conv.conversation.id);
    const id = conv.conversation.id;
    let end = waitEnds(id, 2);
    await sleep(6000);
    await emit("chat:send", {
      conversationId: id,
      content: "Réponds en une phrase : que vaut 7+7 ?",
      compare: ["hermes-4-70b", "hermes-4-405b"],
    });
    let cap = await end;
    const v1a = cap.messages.find((m: any) => m.variant === "a");
    const v1b = cap.messages.find((m: any) => m.variant === "b");
    check("première comparaison : a et b reçus", Boolean(v1a && v1b));

    // Régénère SEULEMENT le côté a
    end = waitEnds(id, 1);
    await sleep(6000);
    await emit("chat:regenerate", { conversationId: id, variant: "a", model: "hermes-4-70b" });
    cap = await end;
    const v2a = cap.messages[0];
    check("a v2 reçue, versionnée {index:2}", v2a?.versions?.group === v1a.id && v2a?.versions?.index === 2,
      JSON.stringify(v2a?.versions ?? null));
    const msgs: any = await emit("conversations:open", { id });
    const list = msgs.messages ?? [];
    const actA = list.find((m: any) => m.variant === "a");
    const actB = list.find((m: any) => m.variant === "b");
    check("b intact, NON versionné (jamais régénéré)", actB?.id === v1b.id && !actB?.versions);
    check("a active = v2 avec meta", actA?.id === v2a.id && actA?.versions?.count === 2);

    // Bascule a vers v1 : b ne bouge pas
    await emit("message:setVersion", { conversationId: id, group: v1a.id, index: 1 });
    await sleep(300);
    const msgs2: any = await emit("conversations:open", { id });
    const list2 = msgs2.messages ?? [];
    check("a revenu sur v1, b toujours intact",
      list2.find((m: any) => m.variant === "a")?.id === v1a.id &&
      list2.find((m: any) => m.variant === "b")?.id === v1b.id);
  }

  // ── Scénario 4 : suppression de la version active → promotion ───────
  console.log("Scénario 4 — suppression d'une version active");
  {
    const msgs: any = await emit("conversations:open", { id: convId });
    const active = (msgs.messages ?? []).find((m: any) => m.role === "assistant");
    check("active avant suppression = v2", active?.versions?.index === 2);
    await emit("message:delete", { conversationId: convId, messageId: active.id });
    const after: any = await emit("conversations:open", { id: convId });
    const list = after.messages ?? [];
    const newActive = list.find((m: any) => m.role === "assistant");
    check("v1 promue après suppression de v2", newActive?.id === v1Id, `id=${newActive?.id?.slice(0, 8)}`);
    check("plus de meta versions (groupe à 1)", !newActive?.versions, JSON.stringify(newActive?.versions ?? null));
  }

  // ── Scénario 5 : garde — setVersion refusé pendant un tour ──────────
  console.log("Scénario 5 — gardes");
  {
    const r1 = await emit("message:setVersion", { conversationId: convId, group: "inexistant", index: 1 });
    check("groupe inconnu → refus propre", Boolean(r1?.error));
    const r2 = await emit("message:setVersion", { conversationId: convId });
    check("paramètres manquants → refus propre", Boolean(r2?.error));
  }

  // ── Nettoyage ───────────────────────────────────────────────────────
  for (const id of createdConversationIds) await emit("conversations:delete", { id });
  socket.close();
  console.log(failures === 0 ? "\n✓ TOUS LES TESTS PASSENT" : `\n✗ ${failures} échec(s)`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("ERREUR:", e);
  process.exit(1);
});
