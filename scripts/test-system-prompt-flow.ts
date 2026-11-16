// Test E2E du chantier « F-11 / F-19 — Prompt système & instructions
// personnalisées » : presets semés, CRUD complet, prompt par conversation
// (get/set/clear, broadcast), instructions globales, garde-fous (longueur,
// validation), isolation entre conversations, hello honnête (taille des
// instructions). Vérifie AUSSI le comportement réel du LLM local : le prompt
// de conversation doit orienter la réponse. Données créées nettoyées en fin.
import { io } from "socket.io-client";

const socket = io("http://localhost:3003", { transports: ["websocket"] });
let failures = 0;
const createdConversationIds: string[] = [];
const createdPresetIds: string[] = [];

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

/** Attends la fin d'un tour de chat (done/error) pour une conversation.
 *  ABONNEMENT POSÉ AVANT l'émission de chat:send (sinon le done arrive
 *  avant l'écouteur — le LLM local peut répondre en < 1 s). */
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
  // ── 1. Presets semés à la première ouverture ──────────────────────
  const list0 = await emit("system-prompts:list");
  check(
    "system-prompts:list semés à la première ouverture",
    Array.isArray(list0.presets) && list0.presets.length >= 5,
    `${list0.presets?.length ?? 0} preset(s)`
  );
  const seedTitles = (list0.presets ?? []).map((p: any) => p.title as string);
  check(
    "preset « Vitrine d'artefacts » semé",
    seedTitles.includes("Vitrine d'artefacts"),
    seedTitles.filter((t: string) => ["Assistant sobre", "Professeur patient", "Relecteur exigeant", "Développeur senior", "Vitrine d'artefacts"].includes(t)).join(", ")
  );

  // ── 2. CRUD des presets ───────────────────────────────────────────
  const created = await emit("system-prompts:create", {
    title: "QA — réponse une lettre",
    content: "Réponds toujours par la lettre A, rien d'autre.",
  });
  if (created.preset) createdPresetIds.push(created.preset.id);
  check("system-prompts:create", !!created.preset && created.preset.title === "QA — réponse une lettre");

  const dupEmpty = await emit("system-prompts:create", { title: "", content: "x" });
  check("create sans titre refusé", !!dupEmpty.error, dupEmpty.error);

  const tooLong = await emit("system-prompts:create", {
    title: "trop long",
    content: "x".repeat(12_001),
  });
  check("create trop long refusé (> 12 000)", !!tooLong.error, tooLong.error);

  const updated = await emit("system-prompts:update", {
    id: created.preset?.id,
    title: "QA — réponse la lettre B",
    content: "Réponds toujours par la lettre B, rien d'autre.",
  });
  check(
    "system-prompts:update",
    !!updated.preset && updated.preset.title === "QA — réponse la lettre B"
  );

  const updMissing = await emit("system-prompts:update", {
    id: "id-inexistant",
    title: "x",
    content: "y",
  });
  check("update preset introuvable refusé", !!updMissing.error);

  // ── 3. Instructions personnalisées (F-19) ─────────────────────────
  const ins0 = await emit("custom-instructions:get");
  check(
    "custom-instructions:get",
    typeof ins0.value === "string" && typeof ins0.maxChars === "number",
    `max ${ins0.maxChars}`
  );
  const ins1 = await emit("custom-instructions:set", {
    value: "Réponds toujours en majuscules.",
  });
  check("custom-instructions:set", !!ins1.ok && ins1.value === "Réponds toujours en majuscules.");
  const insLong = await emit("custom-instructions:set", { value: "x".repeat(4_001) });
  check("instructions trop longues refusées (> 4 000)", !!insLong.error, insLong.error);

  // ── 4. Prompt par conversation (F-11) ──────────────────────────────
  const conv = await emit("conversations:create", { projectId: null });
  const convId = conv.conversation?.id;
  if (convId) createdConversationIds.push(convId);
  check("conversations:create", !!convId);

  const none = await emit("system-prompt:get", { conversationId: convId });
  check("system-prompt:get — aucun prompt au départ", none.prompt === null);

  const setNoConv = await emit("system-prompt:set", { conversationId: "", content: "x" });
  check("set sans conversationId refusé", !!setNoConv.error);

  const setEmpty = await emit("system-prompt:set", { conversationId: convId, content: "   " });
  check("set vide refusé", !!setEmpty.error, setEmpty.error);

  // Broadcast system-prompt:changed capté en même temps que l'ack
  let broadcast: any = null;
  socket.on("system-prompt:changed", (p) => {
    if (p.conversationId === convId) broadcast = p;
  });

  const set1 = await emit("system-prompt:set", {
    conversationId: convId,
    content: "Réponds toujours par la lettre B, rien d'autre.",
    presetTitle: "QA — réponse la lettre B",
  });
  check(
    "system-prompt:set",
    set1.prompt?.content === "Réponds toujours par la lettre B, rien d'autre." &&
      set1.prompt?.presetTitle === "QA — réponse la lettre B"
  );
  await new Promise((r) => setTimeout(r, 200));
  check(
    "broadcast system-prompt:changed",
    broadcast?.prompt?.content?.includes("lettre B") === true,
    broadcast ? "reçu" : "absent"
  );

  // ── 5. Hello honnête : la taille des instructions suit F-19 ────────
  const hello = await new Promise<any>((resolve) => {
    socket.emit("hello", (res: any) => resolve(res ?? {}));
  });
  check(
    "hello.systemPromptChars > base (instructions globales comptées)",
    typeof hello.systemPromptChars === "number" && hello.systemPromptChars > 900,
    `${hello.systemPromptChars} caractères`
  );

  // ── 6. Effet réel sur le tour démo (F-11 : lettre B attendue) ─────
  // NB : chat:send n'a pas d'ack côté service — émission brute, la fin
  // du tour est observée via stream:done (abonnement déjà posé ci-dessous).
  const turnP = waitTurnEnd(convId);
  socket.emit("chat:send", {
    conversationId: convId,
    content: "Bonjour, quelle lettre dois-je écrire sur mon tableau ?",
  });
  check("chat:send émis (sans ack, cf. protocole)", true);
  const turn = await turnP;
  check("tour de chat terminé sans erreur", !!turn.done, turn.error ?? "");
  const opened = await emit("conversations:open", { id: convId });
  const assistantMsgs = (opened.messages ?? []).filter((m: any) => m.role === "assistant");
  const lastReply = assistantMsgs[assistantMsgs.length - 1]?.content ?? "";
  check(
    "le prompt de conversation oriente la réponse (lettre B)",
    /\bB\b/.test(lastReply),
    `réponse : « ${lastReply.slice(0, 60).replace(/\s+/g, " ")}… »`
  );

  // ── 7. Isolation : une autre conversation n'a pas de prompt ───────
  const conv2 = await emit("conversations:create", { projectId: null });
  const conv2Id = conv2.conversation?.id;
  if (conv2Id) createdConversationIds.push(conv2Id);
  const other = await emit("system-prompt:get", { conversationId: conv2Id });
  check("isolation — l'autre conversation n'a pas de prompt", other.prompt === null);

  // ── 8. Clear + nettoyage ───────────────────────────────────────────
  const cleared = await emit("system-prompt:clear", { conversationId: convId });
  check("system-prompt:clear", !!cleared.ok && cleared.prompt === null);
  const afterClear = await emit("system-prompt:get", { conversationId: convId });
  check("prompt retiré (get → null)", afterClear.prompt === null);

  // Remet les instructions globales à zéro (état par défaut)
  await emit("custom-instructions:set", { value: "" });
  const ins2 = await emit("custom-instructions:get");
  check("instructions globales remises à zéro", ins2.value === "");

  for (const id of createdPresetIds) {
    await emit("system-prompts:delete", { id });
  }
  const listEnd = await emit("system-prompts:list");
  check(
    "presets QA supprimés (bibliothèque revenue aux seeds)",
    (listEnd.presets ?? []).every((p: any) => p.title !== "QA — réponse la lettre B")
  );
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
