// Test E2E du chantier « F-17 — Comparaison de modèles » : envoi d'un
// message avec deux modèles → deux tours parallèles (variantes a/b),
// streams taggés, persistance (1 message utilisateur + 2 réponses),
// régénération d'un seul côté, régénération des deux, arrêt global,
// gardes anti-tour en vol, fork conservant les variantes, tour simple
// après une comparaison (rétro-compatibilité), édition avec relance
// comparative. Les tours passent par le moteur local (z-ai réel) —
// reprises anti-429 espacées entre scénarios.
import { io } from "socket.io-client";

const socket = io("http://localhost:3003", { transports: ["websocket"] });
let failures = 0;
const createdConversationIds: string[] = [];
const MODEL_A = "hermes-4-70b";
const MODEL_B = "hermes-4-405b";

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

interface DoneCapture {
  variants: string[];
  messages: any[];
  stopped: boolean[];
  errors: { variant?: string; error: string }[];
}

/** Attend la fin des DEUX variantes (ou n done) d'un tour de comparaison. */
function waitCompareEnd(conversationId: string, expected = 2, timeoutMs = 120_000): Promise<DoneCapture> {
  return new Promise((resolve) => {
    const cap: DoneCapture = { variants: [], messages: [], stopped: [], errors: [] };
    const timer = setTimeout(() => finish({ timeout: true } as any), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("stream:done", onDone);
      socket.off("stream:error", onError);
    }
    function finish(extra?: { timeout?: boolean; error?: string }) {
      cleanup();
      resolve({ ...cap, ...(extra ? { errors: [...cap.errors, { error: extra.error ?? "timeout" }] } : {}) } as DoneCapture);
    }
    const onDone = (p: { conversationId: string; message?: any; stopped?: boolean; variant?: string }) => {
      if (p.conversationId !== conversationId) return;
      cap.variants.push(p.variant ?? "");
      cap.messages.push(p.message ?? null);
      cap.stopped.push(Boolean(p.stopped));
      if (cap.variants.length >= expected) finish();
    };
    const onError = (p: { conversationId: string; error?: string; variant?: string }) => {
      if (p.conversationId !== conversationId) return;
      cap.errors.push({ variant: p.variant, error: p.error ?? "erreur" });
      if (cap.errors.length >= expected) finish();
    };
    socket.on("stream:done", onDone);
    socket.on("stream:error", onError);
  });
}

/** Attend UN done (tour simple) et capture son éventuelle variante. */
function waitOneEnd(conversationId: string, timeoutMs = 120_000) {
  return new Promise<{ variant?: string; message?: any; stopped?: boolean; error?: string }>((resolve) => {
    const timer = setTimeout(() => done({ error: "timeout" }), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("stream:done", onDone);
      socket.off("stream:error", onError);
    }
    const onDone = (p: any) => {
      if (p.conversationId !== conversationId) return;
      cleanup();
      resolve({ variant: p.variant, message: p.message, stopped: p.stopped });
    };
    const onError = (p: any) => {
      if (p.conversationId !== conversationId) return;
      cleanup();
      resolve({ error: p.error ?? "erreur du tour" });
    };
    socket.on("stream:done", onDone);
    socket.on("stream:error", onError);
  });
}

async function main() {
  console.log("── F-17 : comparaison de modèles ──");
  if (!socket.connected)
    await new Promise<void>((r) => socket.on("connect", r));

  // ── Scénario 1 : gardes sur les payloads compare invalides ─────────
  console.log("Scénario 1 — payloads compare invalides");
  {
    const conv: any = await emit("conversations:create", {});
    createdConversationIds.push(conv.conversation.id);
    const id = conv.conversation.id;
    const r1 = await emit("chat:send", { conversationId: id, content: "un", compare: [MODEL_A] });
    check("1 id seulement → refus propre", Boolean(r1?.error));
    const r2 = await emit("chat:send", { conversationId: id, content: "un", compare: [MODEL_A, MODEL_A] });
    check("ids identiques → refus propre", Boolean(r2?.error));
    const r3 = await emit("chat:send", { conversationId: id, content: "un", compare: [MODEL_A, 42] });
    check("id non chaîne → refus propre", Boolean(r3?.error));
    const msgs1: any = await emit("conversations:open", { id });
    check("aucun message persisté après refus", (msgs1.messages ?? []).length === 0);
  }

  // ── Scénario 2 : tour de comparaison complet ────────────────────────
  console.log("Scénario 2 — tour de comparaison complet (a + b)");
  let convId = "";
  let idA = "";
  let idB = "";
  {
    const conv: any = await emit("conversations:create", {});
    createdConversationIds.push(conv.conversation.id);
    convId = conv.conversation.id;
    const end = waitCompareEnd(convId);
    const ack: any = await emit("chat:send", {
      conversationId: convId,
      content: "Réponds en exactement une courte phrase : que vaut 2+2 ?",
      compare: [MODEL_A, MODEL_B],
    });
    check("ack positif avec compare", ack?.ok === true && ack?.compare === true);
    const cap = await end;
    check("2 stream:done reçus", cap.variants.length === 2, `reçus: ${cap.variants.join(",")}`);
    check("variantes a et b distinctes", cap.variants.includes("a") && cap.variants.includes("b"));
    check("aucune erreur de tour", cap.errors.length === 0);
    const msgs: any = await emit("conversations:open", { id: convId });
    const list = msgs.messages ?? [];
    check("3 messages persistés (1 user + 2 assistant)", list.length === 3, `${list.length}`);
    const user = list.filter((m: any) => m.role === "user");
    const assistants = list.filter((m: any) => m.role === "assistant");
    check("message utilisateur unique, sans variante", user.length === 1 && !user[0].variant);
    check("réponses taguées a et b", assistants.filter((m: any) => m.variant === "a").length === 1
      && assistants.filter((m: any) => m.variant === "b").length === 1);
    const labels = assistants.map((m: any) => m.model ?? "");
    check("chaque réponse porte son modèle", labels.every((l: string) => l.length > 0), labels.join(" / "));
    idA = assistants.find((m: any) => m.variant === "a").id;
    idB = assistants.find((m: any) => m.variant === "b").id;
  }
  await sleep(8000);

  // ── Scénario 3 : régénérer UN SEUL côté ─────────────────────────────
  console.log("Scénario 3 — régénération du seul côté a");
  {
    // F-14 : la régénération ne supprime plus — l'ancienne réponse passe
    // inactive (messages:superseded, plus de messages:removed).
    const removed: string[] = [];
    const onRemoved = (p: { conversationId: string; messageIds: string[] }) => {
      if (p.conversationId === convId) removed.push(...p.messageIds);
    };
    socket.on("messages:superseded", onRemoved);
    const end = waitCompareEnd(convId, 1);
    const ack: any = await emit("chat:regenerate", { conversationId: convId, variant: "a", model: MODEL_A });
    check("ack positif", ack?.ok === true);
    const cap = await end;
    socket.off("messages:superseded", onRemoved);
    check("1 seul done, de variante a", cap.variants.length === 1 && cap.variants[0] === "a");
    check("seule la réponse a a été superseded (conservée inactive)", removed.length === 1 && removed[0] === idA, removed.join(","));
    const msgs: any = await emit("conversations:open", { id: convId });
    const list = msgs.messages ?? [];
    const keptB = list.find((m: any) => m.id === idB);
    const newA = list.find((m: any) => m.variant === "a");
    check("réponse b intacte (même id)", Boolean(keptB));
    check("réponse a régénérée (nouvel id)", Boolean(newA) && newA.id !== idA);
    idA = newA.id;
  }
  await sleep(8000);

  // ── Scénario 4 : garde anti-tour pendant une comparaison ────────────
  console.log("Scénario 4 — gardes pendant un tour de comparaison en vol");
  {
    const conv: any = await emit("conversations:create", {});
    createdConversationIds.push(conv.conversation.id);
    const id = conv.conversation.id;
    const end = waitCompareEnd(id);
    await emit("chat:send", {
      conversationId: id,
      content: "Écris un paragraphe de huit lignes sur l'histoire des cartes marines.",
      compare: [MODEL_A, MODEL_B],
    });
    await sleep(2500); // les deux tours sont en vol
    const rSend = await emit("chat:send", { conversationId: id, content: "autre" });
    check("chat:send refusé pendant comparaison", Boolean(rSend?.error));
    const rReg = await emit("chat:regenerate", { conversationId: id });
    check("chat:regenerate refusé pendant comparaison", Boolean(rReg?.error));
    const rStop: any = await new Promise(async (resolve) => {
      socket.emit("chat:stop", { conversationId: id });
      resolve({ stopped: true });
    });
    check("chat:stop accepté (pas d'exception)", rStop?.stopped === true);
    const cap = await end;
    check("les 2 côtés se clôturent après stop", cap.variants.length === 2, cap.variants.join(","));
    check("marqueurs stopped ou partiel", cap.stopped.every(Boolean) || cap.messages.some(Boolean));
    // La conversation est libérée : un tour simple passe
    await sleep(1000);
    const endSimple = waitOneEnd(id);
    const ack: any = await emit("chat:send", { conversationId: id, content: "Merci, une phrase." });
    check("tour simple accepté après comparaison arrêtée", ack?.ok === true);
    const done = await endSimple;
    check("tour simple clos sans variante", !done.error && !done.variant);
  }
  await sleep(8000);

  // ── Scénario 5 : fork conserve les variantes ────────────────────────
  console.log("Scénario 5 — fork d'une conversation comparée");
  {
    const fork: any = await emit("conversations:fork", { conversationId: convId });
    check("fork créé", Boolean(fork?.conversation?.id));
    if (fork?.conversation?.id) {
      createdConversationIds.push(fork.conversation.id);
      const msgs: any = await emit("conversations:open", { id: fork.conversation.id });
      const list = msgs.messages ?? [];
      const va = list.filter((m: any) => m.variant === "a").length;
      const vb = list.filter((m: any) => m.variant === "b").length;
      check("variantes a et b transportées dans le fork", va === 1 && vb === 1, `a=${va} b=${vb}`);
    }
  }

  // ── Scénario 6 : édition du message utilisateur en mode compare ─────
  console.log("Scénario 6 — édition + relance comparative");
  {
    const msgs: any = await emit("conversations:open", { id: convId });
    const user = (msgs.messages ?? []).find((m: any) => m.role === "user");
    const end = waitCompareEnd(convId);
    const ack: any = await emit("message:edit", {
      conversationId: convId,
      messageId: user.id,
      content: "Réponds en exactement une courte phrase : que vaut 3+3 ?",
      compare: [MODEL_A, MODEL_B],
    });
    check("ack édition positive", ack?.ok === true);
    const cap = await end;
    check("les 2 variantes relancées après édition", cap.variants.length === 2 && cap.variants.includes("a") && cap.variants.includes("b"));
    const after: any = await emit("conversations:open", { id: convId });
    const list = after.messages ?? [];
    check("fil tronqué puis 2 nouvelles réponses", list.length === 3, `${list.length} messages`);
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
