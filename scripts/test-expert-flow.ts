// Test E2E du chantier « F-22 — Mode expert » : assainissement des
// réglages (température bornée [0,1] — le moteur démo rejette au-delà,
// erreur 1210 du fournisseur ; plafond [1,8192] ; graine entière 32 bits),
// tolérance aux non-numériques, et vérification comportementale : le
// plafond de jetons tronque réellement la réponse du tour (maxTokens=3 →
// environ trois jetons). Les tours passent par le chemin complet
// `chat:send` → service → moteur démo (z-ai réel).
import { io } from "socket.io-client";
import { sanitizeExpertSettings } from "../mini-services/hermes-chat/prompts";

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

async function assistantReply(
  content: string,
  expert: { temperature?: unknown; maxTokens?: unknown; seed?: unknown }
): Promise<{ ok: boolean; text: string; error?: string }> {
  // Pause anti-429 : le fournisseur démo limite les requêtes rapprochées
  // (3 essais espacés de 8 s avant l'abandon).
  for (let attempt = 0; attempt < 3; attempt++) {
    const conv = await emit("conversations:create", { projectId: null });
    const conversationId = conv.conversation?.id;
    if (!conversationId) return { ok: false, text: "", error: "création impossible" };
    createdConversationIds.push(conversationId);
    const wait = waitTurnEnd(conversationId);
    socket.emit("chat:send", { conversationId, content, ...expert });
    const r = await wait;
    if (r.done) {
      const opened = await emit("conversations:open", { id: conversationId });
      const a = (opened.messages ?? []).find((m: any) => m.role === "assistant");
      return { ok: true, text: (a?.content ?? "").trim() };
    }
    if (!String(r.error ?? "").includes("429")) {
      return { ok: false, text: "", error: r.error };
    }
    await new Promise((res) => setTimeout(res, 8000));
  }
  return { ok: false, text: "", error: "429 persistant" };
}

async function main() {
  // ── 1. Assainissement (fonction pure, mêmes bornes côté service) ────
  const s1 = sanitizeExpertSettings({ temperature: 1.7 });
  check("température 1,7 → clampée à 1", s1.temperature === 1);
  const s2 = sanitizeExpertSettings({ temperature: -0.4 });
  check("température -0,4 → clampée à 0", s2.temperature === 0);
  const s3 = sanitizeExpertSettings({ maxTokens: 0 });
  check("plafond 0 → clampé à 1", s3.maxTokens === 1);
  const s4 = sanitizeExpertSettings({ maxTokens: 99_999 });
  check("plafond 99 999 → clampé à 8192", s4.maxTokens === 8192);
  const s5 = sanitizeExpertSettings({ seed: 5_000_000_000 });
  check("graine 5e9 → clampée à 2^31-1", s5.seed === 2 ** 31 - 1);
  const s6 = sanitizeExpertSettings({ seed: 12.7 });
  check("graine décimale → entière", s6.seed === 13);
  const s7 = sanitizeExpertSettings({ temperature: "abc", maxTokens: NaN, seed: null });
  check(
    "non-numériques ignorés",
    s7.temperature === undefined && s7.maxTokens === undefined && s7.seed === undefined
  );
  const s8 = sanitizeExpertSettings(undefined);
  check("charge absente → objet vide", Object.keys(s8).length === 0);
  const s9 = sanitizeExpertSettings({ temperature: "0.5", seed: "42" });
  check(
    "numéros en chaîne acceptés",
    s9.temperature === 0.5 && s9.seed === 42
  );

  // ── 2. Comportemental : maxTokens tronque réellement la réponse ────
  // (vérifié : 1 jeton ≈ un mot ; maxTokens=3 → ~3 jetons de sortie)
  const full = await assistantReply(
    "Écris exactement cette phrase complète : Le renard brun saute par-dessus le chien paresseux.",
    {}
  );
  check("tour sans réglages : réponse complète", full.ok && full.text.includes("paresseux"), `« ${full.text.slice(0, 40)}… »`);
  const cut = await assistantReply(
    "Écris exactement cette phrase complète : Le renard brun saute par-dessus le chien paresseux.",
    { maxTokens: 3 }
  );
  check(
    "maxTokens=3 : réponse tronquée à ~3 jetons",
    cut.ok && cut.text.length < full.text.length / 2,
    `« ${cut.text} »`
  );

  // ── 3. Bornes : les valeurs hors plage ne plantent pas le tour ──────
  // (clampées côté service ; sans clamp, le fournisseur répondrait 1210)
  const hot = await assistantReply("Réponds exactement : bonjour", { temperature: 2.5 });
  check("température 2,5 clampée : tour réussi", hot.ok, hot.error ?? hot.text.slice(0, 30));
  const seedTurn = await assistantReply("Réponds exactement : bonjour", { seed: 42, temperature: 0.1 });
  check("seed + température basses : tour réussi", seedTurn.ok, seedTurn.error ?? "");

  // ── 4. Tolérance : non-numériques = valeurs par défaut ─────────────
  const junk = await assistantReply("Réponds exactement : bonjour", {
    temperature: "pas-un-nombre",
    maxTokens: NaN,
    seed: "x",
  });
  check("valeurs non numériques : tour réussi (ignorées)", junk.ok, junk.error ?? "");

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
  console.error("Service hermes-chat injoignable sur le port 3003 (lancer `bun index.ts`)");
  process.exit(1);
});
