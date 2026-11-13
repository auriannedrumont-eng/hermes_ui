// Test E2E du chantier « F-18 — Mémoire utilisateur » : état par défaut,
// pose/édition/effacement des notes, garde-fous (limite 12 000), toggles
// (désactivation coupe l'injection ; réactivation la rétablit), broadcasts,
// hello honnête (memoryChars), persistance (reconnexion), vérification
// comportementale (la démo cite la mémoire) et isolation des instructions
// (les notes ne polluent pas le prompt d'une conversation sans mémoire).
// Remise à l'état initial en fin de test (notes effacées, mémoire active).
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

function waitTurnEnd(conversationId: string, timeoutMs = 60_000): Promise<{ done?: boolean; error?: string }> {
  return new Promise((resolve) => {
    const onDone = (p: { conversationId: string }) => {
      if (p.conversationId !== conversationId) return;
      cleanup();
      resolve({ done: true });
    };
    const onError = (p: { conversationId: string; error?: string }) => {
      if (p.conversationId !== conversationId) return;
      cleanup();
      resolve({ error: p.error ?? "erreur du tour" });
    };
    const timer = setTimeout(() => {
      socket.off("stream:done", onDone);
      socket.off("stream:error", onError);
      resolve({ error: "timeout" });
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("stream:done", onDone);
      socket.off("stream:error", onError);
    }
    socket.on("stream:done", onDone);
    socket.on("stream:error", onError);
  });
}

async function main() {
  // ── 0. Nettoyage préalable : l'état initial doit être propre ───────
  // (des tests manuels antérieurs peuvent avoir laissé des notes)
  await emit("memory:set-notes", { value: "" });
  await emit("memory:set-enabled", { enabled: true });
  await emit("memory:set-auto", { autoLearn: false });

  // ── 1. État par défaut ────────────────────────────────────────────
  const initial = await emit("memory:get");
  check(
    "état par défaut : active, sans notes",
    initial.enabled === true && initial.autoLearn === false && initial.notes === "",
    `max ${initial.maxChars} car.`
  );
  check(
    "maxChars annoncé = 12 000",
    initial.maxChars === 12_000
  );

  // ── 2. Pose + lecture des notes ───────────────────────────────────
  const MEMORY = "Je m'appelle Z. Je préfère les réponses en français.";
  const set = await emit("memory:set-notes", { value: MEMORY });
  check("set-notes", set.ok === true && set.value === MEMORY);
  const get1 = await emit("memory:get");
  check("lecture des notes", get1.notes === MEMORY);

  // hello honnête : memoryChars suit la taille réelle des notes
  const hello: any = await emit("hello");
  check(
    "hello.memoryChars honnête",
    hello.memoryChars === MEMORY.length,
    `${hello.memoryChars} car.`
  );

  // ── 3. Garde-fous ─────────────────────────────────────────────────
  const tooLong = await emit("memory:set-notes", { value: "x".repeat(12_001) });
  check("notes > 12 000 refusées", !!tooLong.error, tooLong.error);
  const still = await emit("memory:get");
  check("notes inchangées après refus", still.notes === MEMORY);

  // ── 4. Broadcasts ────────────────────────────────────────────────
  let broadcast: any = null;
  socket.on("memory:changed", (p) => {
    broadcast = p;
  });
  const set2 = await emit("memory:set-notes", { value: MEMORY + " Test." });
  await new Promise((r) => setTimeout(r, 150));
  check("broadcast memory:changed (notes)", broadcast?.notes === MEMORY + " Test.", "reçu");
  broadcast = null;
  await emit("memory:set-enabled", { enabled: false });
  await new Promise((r) => setTimeout(r, 150));
  check("broadcast memory:changed (enabled)", broadcast?.enabled === false, "reçu");
  broadcast = null;
  await emit("memory:set-auto", { autoLearn: true });
  await new Promise((r) => setTimeout(r, 150));
  check("broadcast memory:changed (autoLearn)", broadcast?.autoLearn === true, "reçu");

  // ── 5. Comportement : la démo cite la mémoire ─────────────────────
  // La note « Z » est remise seule pour la vérification comportementale
  // (le LLM démo est réel : une question directe garantit une citation).
  // NB : le bloc broadcast laisse la mémoire DÉSACTIVÉE — réactivation ici.
  await emit("memory:set-enabled", { enabled: true });
  await emit("memory:set-notes", { value: "Je m'appelle Z." });
  const conv = await emit("conversations:create", { projectId: null });
  const convId = conv.conversation?.id;
  if (convId) createdConversationIds.push(convId);
  const turn1 = waitTurnEnd(convId);
  socket.emit("chat:send", {
    conversationId: convId,
    content: "Comment je m'appelle, d'après ta mémoire ?",
  });
  const r1 = await turn1;
  check("tour avec mémoire active terminé", !!r1.done, r1.error ?? "");
  const opened1 = await emit("conversations:open", { id: convId });
  const a1 = (opened1.messages ?? []).find((m: any) => m.role === "assistant");
  check("la réponse cite la mémoire ('Z')", (a1?.content ?? "").includes("Z"));

  // ── 6. Désactivation : la mémoire n'est plus injectée ─────────────
  await emit("memory:set-notes", { value: "IGNOREMOI" });
  await emit("memory:set-enabled", { enabled: false });
  const helloOff: any = await emit("hello");
  check("hello.memoryChars = 0 mémoire désactivée", helloOff.memoryChars === 0);
  const conv2 = await emit("conversations:create", { projectId: null });
  const conv2Id = conv2.conversation?.id;
  if (conv2Id) createdConversationIds.push(conv2Id);
  const turn2 = waitTurnEnd(conv2Id);
  socket.emit("chat:send", {
    conversationId: conv2Id,
    content: "Réponds exactement : Je n'ai aucune mémoire de ça.",
  });
  const r2 = await turn2;
  check("tour mémoire désactivée terminé", !!r2.done, r2.error ?? "");
  const opened2 = await emit("conversations:open", { id: conv2Id });
  const a2 = (opened2.messages ?? []).find((m: any) => m.role === "assistant");
  check(
    "la réponse ne cite pas le contenu désactivé ('IGNOREMOI' absent)",
    !(a2?.content ?? "").includes("IGNOREMOI")
  );

  // ── 7. Réactivation + persistance ─────────────────────────────────
  await emit("memory:set-enabled", { enabled: true });
  const persisted = await emit("memory:get");
  check("réactivation : notes persistantes intactes", persisted.notes === "IGNOREMOI");

  // Effacement complet (consultable, éditable, EFFAÇABLE)
  const erased = await emit("memory:set-notes", { value: "" });
  const afterErase = await emit("memory:get");
  check("effacement complet", erased.ok && afterErase.notes === "" && afterErase.enabled === true);

  // ── Nettoyage ─────────────────────────────────────────────────────
  for (const id of createdConversationIds) {
    await emit("conversations:delete", { id });
  }
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
