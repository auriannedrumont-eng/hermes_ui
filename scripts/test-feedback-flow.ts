// Test E2E du chantier « F-24 — Feedback intégré (👍/👎 + commentaire) » :
// pose/retrait du rating, commentaire (ajout, remplacement, effacement complet),
// garde-fous (message utilisateur refusé, commentaire sans rating refusé, trop
// long tronqué), persistance au rechargement (conversations:open), broadcast
// feedback:changed, isolation entre conversations. Nettoyage en fin de test.
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

/** Attends la fin d'un tour (done/error) pour une conversation. */
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
  // ── 1. Conversation témoin + tour réel ────────────────────────────
  const conv = await emit("conversations:create", { projectId: null });
  const convId = conv.conversation?.id;
  if (convId) createdConversationIds.push(convId);
  check("conversations:create", !!convId);

  const turnP = waitTurnEnd(convId);
  socket.emit("chat:send", { conversationId: convId, content: "Réponds exactement : Voici une réponse de test." });
  const turn = await turnP;
  check("tour de chat terminé", !!turn.done, turn.error ?? "");
  const opened = await emit("conversations:open", { id: convId });
  const msgs = (opened.messages ?? []) as any[];
  const userMsg = msgs.find((m) => m.role === "user");
  const assistantMsg = msgs.find((m) => m.role === "assistant");
  check("messages présents", !!userMsg && !!assistantMsg, `${msgs.length} message(s)`);

  // ── 2. Pose du feedback 👍 ────────────────────────────────────────
  let broadcast: any = null;
  socket.on("feedback:changed", (p) => {
    if (p.conversationId === convId) broadcast = p;
  });
  const up = await emit("feedback:set", {
    conversationId: convId,
    messageId: assistantMsg.id,
    rating: "up",
    comment: null,
  });
  check(
    "feedback:set 👍 sans commentaire",
    up.message?.feedbackRating === "up" && !up.message.feedbackComment
  );
  await new Promise((r) => setTimeout(r, 150));
  check("broadcast feedback:changed", broadcast?.message?.feedbackRating === "up", "reçu");

  // ── 3. Commentaire ────────────────────────────────────────────────
  const commented = await emit("feedback:set", {
    conversationId: convId,
    messageId: assistantMsg.id,
    rating: "up",
    comment: "Réponse claire et directe.",
  });
  check(
    "commentaire ajouté au 👍",
    commented.message?.feedbackRating === "up" &&
      commented.message?.feedbackComment === "Réponse claire et directe."
  );

  // Remplacement du commentaire
  const replaced = await emit("feedback:set", {
    conversationId: convId,
    messageId: assistantMsg.id,
    rating: "down",
    comment: "Trop court pour mon besoin.",
  });
  check(
    "rating inversé + commentaire remplacé",
    replaced.message?.feedbackRating === "down" &&
      replaced.message?.feedbackComment === "Trop court pour mon besoin."
  );

  // Commentaire trop long : tronqué à 2 000 (garde-fou du service)
  const long = await emit("feedback:set", {
    conversationId: convId,
    messageId: assistantMsg.id,
    rating: "down",
    comment: "x".repeat(2500),
  });
  check(
    "commentaire tronqué à 2 000",
    long.message?.feedbackComment?.length === 2000,
    `${long.message?.feedbackComment?.length ?? 0} caractères conservés`
  );

  // ── 4. Garde-fous ─────────────────────────────────────────────────
  const onUser = await emit("feedback:set", {
    conversationId: convId,
    messageId: userMsg.id,
    rating: "up",
    comment: null,
  });
  check("feedback sur message utilisateur refusé", !!onUser.error, onUser.error);

  const orphan = await emit("feedback:set", {
    conversationId: convId,
    messageId: "id-inconnu",
    rating: "up",
    comment: null,
  });
  check("feedback sur message introuvable refusé", !!orphan.error, orphan.error);

  const noRating = await emit("feedback:set", {
    conversationId: convId,
    messageId: assistantMsg.id,
    rating: null,
    comment: "Un commentaire sans vote ?",
  });
  check("commentaire sans rating refusé", !!noRating.error, noRating.error);

  const missing = await emit("feedback:set", { conversationId: convId });
  check("feedback:set sans paramètres refusé", !!missing.error);

  // ── 5. Retrait complet (re-clic 👎 → null) ────────────────────────
  const cleared = await emit("feedback:set", {
    conversationId: convId,
    messageId: assistantMsg.id,
    rating: null,
    comment: null,
  });
  check(
    "retrait complet du retour",
    !cleared.message?.feedbackRating && !cleared.message?.feedbackComment
  );

  // ── 6. Persistance au rechargement ────────────────────────────────
  const reup = await emit("feedback:set", {
    conversationId: convId,
    messageId: assistantMsg.id,
    rating: "up",
    comment: "Persistant.",
  });
  const reopened = await emit("conversations:open", { id: convId });
  const reopenedAssistant = (reopened.messages ?? []).find((m: any) => m.role === "assistant");
  check(
    "persistance : conversations:open remonte le feedback",
    reopenedAssistant?.feedbackRating === "up" &&
      reopenedAssistant?.feedbackComment === "Persistant."
  );

  // ── 7. Isolation : un autre client ne voit pas de feedback parasite ─
  const conv2 = await emit("conversations:create", { projectId: null });
  const conv2Id = conv2.conversation?.id;
  if (conv2Id) createdConversationIds.push(conv2Id);
  const opened2 = await emit("conversations:open", { id: conv2Id });
  const assistant2 = (opened2.messages ?? []).find((m: any) => m.role === "assistant");
  check("isolation — nouvelle conversation sans feedback", !assistant2?.feedbackRating);

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
