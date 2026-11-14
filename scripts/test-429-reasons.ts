// Test d'intégration « raisons des refus 429 » (v2.4) — démarre le VRAI
// service hermes-chat (ports 3323/3324, base isolée) plus un FAUX z.ai local
// (port 3321, surface /api/paas/v4) dont /chat/completions renvoie 429 avec
// les CORPS RÉELS observés en production :
//   [A] z.ai code 1113 « Insufficient balance or no resource package » —
//       compte sans crédit (cas d'Aurianne, 2026-11-15) ;
//   [B] opencode « FreeUsageLimitError » — quota gratuit épuisé (cas
//       d'Aurianne, 2026-11-15) ;
//   [C] « Too many requests » — simple limite de débit ;
//   [D] corps vide — comportement historique conservé mot pour mot ;
//   [E] raison inconnue — le message du fournisseur est repris tel quel ;
//   [S] chemin de réussite — un 200 streamé passe toujours (non-régression).
// Vérifie pour chaque cas le message du tour (stream:error) ET l'étiquette
// posée sur la carte de la clé (providers:list → keys[].statusLabel).
import { io } from "socket.io-client";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

const TOKEN = "test-jeton-429-RR";
const SOCK_URL = "http://localhost:3323";
const DB_DIR = "/home/z/my-project/db-test-429";
const MOCK_PORT = 3321;
const MOCK_API_KEY = "clefaux.quatrevingtneuf";
const MODEL_ID = "glm-test-429";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emitAck(s: any, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) s.emit(event, (res: any) => resolve(res ?? {}));
    else s.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

// ── Faux z.ai : /models accepte la clé, /chat/completions suit la consigne ──
// body.value === "__OK__" → 200 streamé ; sinon 429 avec ce corps
// (json.value décide du Content-Type, pour le cas « corps vide »).
function startMock(): Promise<{
  server: Server;
  body: { value: string };
  json: { value: boolean };
  hits: Map<string, number>;
}> {
  const body = { value: "" };
  const json = { value: true };
  const hits = new Map<string, number>();
  const bump = (k: string) => hits.set(k, (hits.get(k) ?? 0) + 1);
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const auth = String(req.headers.authorization ?? "");
    const reply = (code: number, hdr: Record<string, string>, payload: string) => {
      res.writeHead(code, hdr);
      res.end(payload);
    };
    if (req.method === "GET" && url === "/api/paas/v4/models") {
      bump("models");
      if (auth !== `Bearer ${MOCK_API_KEY}`)
        return reply(401, { "Content-Type": "application/json" },
          JSON.stringify({ error: { code: "401", message: "token expired or incorrect" } }));
      return reply(200, { "Content-Type": "application/json" },
        JSON.stringify({ data: [{ id: MODEL_ID }] }));
    }
    if (req.method === "POST" && url === "/api/paas/v4/chat/completions") {
      bump("chat");
      if (auth !== `Bearer ${MOCK_API_KEY}`)
        return reply(401, { "Content-Type": "application/json" },
          JSON.stringify({ error: { code: "401", message: "token expired or incorrect" } }));
      if (body.value === "__OK__") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          sse({ model: MODEL_ID, choices: [{ delta: { content: "Réponse saine du faux z.ai." } }] });
          sse({ model: MODEL_ID, choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 6 } });
          res.write("data: [DONE]\n\n");
          res.end();
        });
        return;
      }
      return reply(429, json.value ? { "Content-Type": "application/json" } : {}, body.value);
    }
    return reply(404, { "Content-Type": "application/json" },
      JSON.stringify({ error: { message: `route inconnue : ${req.method} ${url}` } }));
  });
  return new Promise((resolve) =>
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ server, body, json, hits }))
  );
}

function startService(): Promise<ChildProcess> {
  mkdirSync(DB_DIR, { recursive: true });
  const env = {
    ...process.env,
    HERMES_SERVICE_TOKEN: TOKEN,
    HERMES_CHAT_PORT: "3323",
    HERMES_CHAT_FILES_PORT: "3324",
    HERMES_GATEWAY_URL: "",
    HERMES_CHAT_DB: join(DB_DIR, "hermes-chat.sqlite"),
  };
  const proc = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
    cwd: "/home/z/my-project",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("service des pièces jointes démarré")) {
        cleanup();
        resolve(proc);
      }
    };
    (proc.stdout as any).on("data", onData);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`service non démarré en 40 s — sortie: ${buf.slice(-400)}`));
    }, 40000);
    function cleanup() { clearTimeout(timer); (proc.stdout as any).off("data", onData); }
  });
}

function connectSocket(): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = io(SOCK_URL, { path: "/", transports: ["websocket"], timeout: 6000, auth: { token: TOKEN } });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e: any) => reject(new Error(e?.message)));
    setTimeout(() => { s.close(); reject(new Error("timeout connexion socket")); }, 7000);
  });
}

/** Un tour de chat ; renvoie l'erreur stream:error (ou le contenu si succès). */
async function runTurn(socket: any, cid: string): Promise<string> {
  const settled = new Promise<string>((resolve) => {
    const onErr = (p: any) => {
      if (p?.conversationId === cid) {
        socket.off("stream:error", onErr);
        socket.off("stream:done", onDone);
        resolve(`ERROR::${String(p?.error ?? "")}`);
      }
    };
    const onDone = (p: any) => {
      if (p?.conversationId === cid) {
        socket.off("stream:error", onErr);
        socket.off("stream:done", onDone);
        resolve(`DONE::${String(p?.message?.content ?? "")}`);
      }
    };
    socket.on("stream:error", onErr);
    socket.on("stream:done", onDone);
  });
  await emitAck(socket, "chat:send", { conversationId: cid, content: "Bonjour", model: MODEL_ID });
  return Promise.race([settled, wait(15000).then(() => "TIMEOUT")]);
}

async function keyOf(socket: any, keyId: string): Promise<any> {
  const list = await emitAck(socket, "providers:list");
  for (const p of list?.providers ?? [])
    for (const k of p?.keys ?? []) if (k?.id === keyId) return k;
  return null;
}

async function main() {
  let service: ChildProcess | null = null;
  let mock: Awaited<ReturnType<typeof startMock>> | null = null;
  let socket: any = null;
  try {
    console.log("[boot] faux z.ai 429 (3321) + service hermes-chat (3323/3324)…");
    mock = await startMock();
    service = await startService();
    socket = await connectSocket();

    // ── [P] Fournisseur z.ai pointé sur le faux serveur ────────────────
    console.log("\n[P] Fournisseur z.ai (adresse du faux serveur)");
    let providerId: string | null = null;
    let keyId: string | null = null;
    {
      const add = await emitAck(socket, "providers:add", {
        name: "z.ai",
        kind: "llm",
        baseUrl: `http://localhost:${MOCK_PORT}`,
      });
      providerId = add?.provider?.id ?? null;
      check("fournisseur créé", Boolean(providerId), JSON.stringify(add).slice(0, 80));

      const key = await emitAck(socket, "providers:add-key", {
        providerId,
        label: "Clé 429",
        secret: MOCK_API_KEY,
      });
      keyId = key?.key?.id ?? null;
      check("clé ajoutée", Boolean(keyId));

      const test = await emitAck(socket, "providers:test-key", { keyId });
      check("test de clé → ok (le 429 ne concerne que la génération)",
        test?.ok === true && test?.key?.status === "ok",
        JSON.stringify(test?.key ?? test).slice(0, 80));
    }

    // ── Scénarios 429 ──────────────────────────────────────────────────
    const scenarios: {
      id: string;
      body: string;
      json: boolean;
      wantLong: string;   // attendu dans le message d'erreur du tour
      exact?: string;     // … ou message EXACT (corps vide)
      wantShort: string;  // étiquette attendue sur la carte de la clé
    }[] = [
      {
        id: "A",
        body: JSON.stringify({ error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." } }),
        json: true,
        wantLong: "solde insuffisant : rechargez le compte chez le fournisseur",
        wantShort: "solde insuffisant (recharge requise)",
      },
      {
        id: "B",
        body: JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go" } }),
        json: true,
        wantLong: "quota gratuit épuisé : un abonnement payant du fournisseur est nécessaire",
        wantShort: "quota gratuit épuisé",
      },
      {
        id: "C",
        body: JSON.stringify({ error: { message: "Too many requests. Please retry later." } }),
        json: true,
        wantLong: "trop de requêtes à la minute : réessayez dans un instant",
        wantShort: "trop de requêtes (réessayez)",
      },
      {
        id: "D",
        body: "",
        json: false,
        exact: "z.ai : limite z.ai atteinte (HTTP 429) — plus aucune clé disponible",
        wantShort: "limite atteinte à l'usage",
      },
      {
        id: "E",
        body: JSON.stringify({ error: { message: "Quota exceeded for tier" } }),
        json: true,
        wantLong: "Quota exceeded for tier",
        wantShort: "Quota exceeded for tier",
      },
    ];

    for (const sc of scenarios) {
      console.log(`\n[${sc.id}] Corps 429 : ${sc.body ? sc.body.slice(0, 70) + "…" : "(vide)"}`);
      mock!.body.value = sc.body;
      mock!.json.value = sc.json;

      // Remet la clé en service (le tour précédent l'a épuisée).
      const retest = await emitAck(socket, "providers:test-key", { keyId });
      check("clé remise en service (test → ok)", retest?.key?.status === "ok");

      const conv = await emitAck(socket, "conversations:create");
      const cid = conv?.conversation?.id;
      const out = await runTurn(socket, cid);

      if (sc.exact) {
        check(`erreur EXACTE (comportement historique)`, out === `ERROR::${sc.exact}`, out.slice(0, 120));
      } else {
        check(
          `message du tour porte la raison (« ${sc.wantLong.slice(0, 30)}… »)`,
          out.startsWith("ERROR::") && out.includes("limite z.ai atteinte (HTTP 429)") && out.includes(sc.wantLong) && out.includes("plus aucune clé disponible"),
          out.slice(0, 160)
        );
      }
      const k = await keyOf(socket, keyId!);
      check("clé marquée épuisée", k?.status === "exhausted", k?.status);
      check(
        `étiquette de la carte clé = « ${sc.wantShort} »`,
        k?.statusLabel === sc.wantShort,
        JSON.stringify(k?.statusLabel)
      );
    }

    // ── [S] Chemin de réussite intact ──────────────────────────────────
    console.log("\n[S] Non-régression : un 200 streamé passe toujours");
    {
      mock!.body.value = "__OK__";
      const retest = await emitAck(socket, "providers:test-key", { keyId });
      check("clé remise en service (test → ok)", retest?.key?.status === "ok");
      const conv = await emitAck(socket, "conversations:create");
      const cid = conv?.conversation?.id;
      const out = await runTurn(socket, cid);
      check("tour réussi, contenu du faux z.ai reçu", out === "DONE::Réponse saine du faux z.ai.", out.slice(0, 100));
      const k = await keyOf(socket, keyId!);
      check("clé toujours « ok » après un tour réussi", k?.status === "ok", k?.statusLabel);
      check("le faux serveur a bien servi les 429 puis le 200",
        (mock!.hits.get("chat") ?? 0) === scenarios.length + 1,
        `chat=${mock!.hits.get("chat") ?? 0}`);
    }
  } catch (err) {
    failures++;
    console.error("ERREUR DU TEST :", err instanceof Error ? err.message : err);
  } finally {
    try { socket?.close(); } catch {}
    try { service?.kill("SIGKILL"); } catch {}
    try { mock?.server.close(); } catch {}
    try { rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${failures === 0 ? "TOUS LES TESTS PASSENT" : `${failures} ÉCHEC(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
