// Test du chantier F-01/F-04 : arrêt propre (stream:done stopped) + erreurs
// persistantes (stream:error avec partiel). Nécessite le mini-service sur 3003.
//
//   cd mini-services/hermes-chat && bun run dev
//   bun scripts/test-stop-error-flow.ts            # scénarios 1-3 (service normal)
//
//   # scénario 4 (erreur LLM simulée) : relancer le service avec le preload factice
//   bun --preload scripts/fake-zai-error.preload.ts mini-services/hermes-chat/index.ts
//   bun scripts/test-stop-error-flow.ts --erreur
//
// Scénarios :
//   1. tour interrompu par chat:stop        → stream:done { stopped: true, message.stopped }
//   2. persistance du marqueur              → conversations:open renvoie message.stopped
//   3. régénération après arrêt             → nouveau tour complet (stopped absent)
//   4. erreur réelle (moteur factice)       → stream:error { error, message: partiel }
import { io } from "socket.io-client";

const URL = "http://localhost:3003";
const ERROR_MODE = process.argv.includes("--erreur");
const socket = io(URL, { path: "/", transports: ["websocket"], timeout: 8000 });

function emit(event: string, payload?: any): Promise<any> {
  return new Promise((resolve) =>
    socket.emit(event, payload, (res: any) => resolve(res))
  );
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  const tag = ok ? "OK " : "ÉCHEC";
  console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function waitFor(event: string, timeoutMs = 60000): Promise<any> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (p: any) => {
      clearTimeout(to);
      resolve(p);
    });
  });
}

async function errorScenario(conversationId: string) {
  const errP = waitFor("stream:error", 30000);
  socket.emit("chat:send", {
    conversationId,
    content: "Réponds simplement : bonjour.",
  });
  const err: any = await errP;
  check(
    "4a. erreur remontée par stream:error",
    typeof err?.error === "string" && err.error.length > 0,
    String(err?.error).slice(0, 100)
  );
  check(
    "4b. partiel persisté transmis dans stream:error",
    typeof err?.message?.content === "string" && err.message.content.length > 0,
    `${err?.message?.content?.length ?? 0} caractères : « ${String(err?.message?.content).slice(0, 60)}… »`
  );
  check("4c. partiel d'erreur non marqué stopped", err?.message?.stopped !== true);
  check("4d. stream:error porte la conversation rafraîchie", Boolean(err?.conversation?.id));
  const reopenedErr: any = await emit("conversations:open", { id: conversationId });
  const lastErr = reopenedErr?.messages?.filter((m: any) => m.role === "assistant").pop();
  check(
    "4e. partiel d'erreur conservé après réouverture",
    typeof lastErr?.content === "string" && lastErr.content.length > 0,
    `${lastErr?.content?.length ?? 0} caractères`
  );
}

async function main() {
  await new Promise<void>((r) => socket.on("connect", () => r()));
  console.log("connecté :", socket.id);

  const conv = await emit("conversations:create");
  const conversationId = conv?.conversation?.id;
  check("conversation créée", Boolean(conversationId), String(conversationId));

  // Mode --erreur : uniquement le scénario 4 (service factice).
  if (ERROR_MODE) {
    await errorScenario(conversationId);
    console.log(failures === 0 ? "\nTOUS LES TESTS PASSENT" : `\n${failures} ÉCHEC(S)`);
    socket.close();
    process.exit(failures === 0 ? 0 : 1);
  }

  // ── 1. Tour interrompu par chat:stop ─────────────────────────────────
  const done1P = waitFor("stream:done", 90000);
  socket.emit("chat:send", {
    conversationId,
    content:
      "Écris-moi un paragraphe très détaillé d'au moins 300 mots sur l'histoire de la cartographie marine.",
  });
  await waitFor("stream:delta", 90000); // premier jeton
  await new Promise((r) => setTimeout(r, 900)); // laisse filer un peu
  socket.emit("chat:stop", { conversationId });
  const done1: any = await done1P;
  check("1a. arrêt clôturé par stream:done (pas stream:error)", Boolean(done1));
  check(
    "1b. stream:done porte stopped: true",
    done1?.stopped === true,
    `stopped=${JSON.stringify(done1?.stopped)}`
  );
  check(
    "1c. partiel conservé dans le message",
    typeof done1?.message?.content === "string" && done1.message.content.length > 0,
    `${done1?.message?.content?.length ?? 0} caractères`
  );
  check(
    "1d. message.stopped persisté",
    done1?.message?.stopped === true,
    `message.stopped=${JSON.stringify(done1?.message?.stopped)}`
  );

  // ── 2. Persistance : réouverture de la conversation ──────────────────
  const reopened: any = await emit("conversations:open", { id: conversationId });
  const last = reopened?.messages?.filter((m: any) => m.role === "assistant").pop();
  check(
    "2a. marqueur stopped conservé après réouverture",
    last?.stopped === true,
    `stopped=${JSON.stringify(last?.stopped)}`
  );

  // ── 3. Régénération après arrêt ──────────────────────────────────────
  const done2P = waitFor("stream:done", 120000);
  socket.emit("chat:regenerate", { conversationId });
  const regen: any = await done2P;
  check(
    "3a. régénération possible après arrêt",
    Boolean(regen?.message?.content),
    `${regen?.message?.content?.length ?? 0} caractères`
  );
  check(
    "3b. tour régénéré non marqué stopped",
    regen?.message?.stopped !== true && regen?.stopped !== true,
    `stopped=${JSON.stringify(regen?.stopped)} / message.stopped=${JSON.stringify(regen?.message?.stopped)}`
  );

  console.log(
    "\n(scénario 4 ignoré — le relancer avec --erreur contre le service factice,"
  );
  console.log(" cf. en-tête de ce script)"
  );

  console.log(failures === 0 ? "\nTOUS LES TESTS PASSENT" : `\n${failures} ÉCHEC(S)`);
  socket.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
