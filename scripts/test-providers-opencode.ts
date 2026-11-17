// Test d'intégration « fournisseur opencode » (v2.4) — démarre le VRAI
// service hermes-chat (ports 3313/3314, base isolée) plus un FAUX opencode
// local (OpenAI-compatible, port 3315), puis vérifie de bout en bout :
//   [U] unitaire : « opencode » et son adresse sont reconnus (et pas
//       confondus avec OpenAI malgré le « openai » de l'URL)
//   [P] providers:add par adresse collée → fournisseur canonique opencode,
//       baseUrl explicite conservée ; doublon refusé proprement
//   [K] providers:add-key → le hello rediffusé expose engineProviders
//       (carte de statut honnête : « vos clés répondent »)
//   [M] models:list → liste vivante du faux opencode, libellés lisibles
//   [T] chat:send → tour réel streamé chez le faux opencode (SSE), clé
//       Bearer transmise, message persisté avec le modèle du fournisseur
//   [V] v2.5 — endpoint éditable : providers:set-base avec une adresse
//       COMPLÈTE (chemin) est honorée telle quelle par le moteur
// Aucun réseau externe : le faux serveur tourne sur localhost.
// v2.5 : l'adresse collée en [P] est une ORIGINE seule (proxy) — les
// chemins canoniques d'opencode sont conservés ; l'adresse AVEC chemin
// de [V] est, elle, utilisée verbatim (règle du champ « endpoint »).
import { io } from "socket.io-client";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  resolveKnownProvider,
  providerCapabilities,
} from "../mini-services/hermes-chat/providers";

const TOKEN = "test-jeton-opencode-ABC123";
const SOCK_URL = "http://localhost:3313";
const DB_DIR = new URL("../db-test-opencode", import.meta.url).pathname;
const MOCK_PORT = 3315;
const MOCK_KEY = "sk-faux-opencode-0123456789";
const MOCK_CONTENT = "Réponse du faux opencode : la chaîne complète fonctionne.";

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

// ── Faux opencode (OpenAI-compatible) sur localhost ────────────────────
// Même layout que le VRAI opencode.ai (vérifié en direct, 2026-11-15) :
//   • GET  /inference/v1/models               — surface du test de clé ;
//   • GET  /inference/openai/v1/models        — liste pour le moteur ;
//   • POST /inference/openai/v1/chat/completions — tours (SSE) + sonde
//     de génération du test de clé (mini-génération 1 jeton).
// Le moteur remplace l'ORIGINE de l'adresse saisie par celle du faux
// serveur en conservant les chemins canoniques (cf. resolveLlmEndpoint).
function startMock(): Promise<{ server: Server; sawAuth: string[]; sawBody: any[] }> {
  const sawAuth: string[] = [];
  const sawBody: any[] = [];
  const MODELS_BODY = {
    object: "list",
    data: [
      { id: "big-pickle", object: "model", name: "Big Pickle", type: "chat", limit: { context: 200000 } },
      { id: "tiny-pickle", object: "model", name: "Tiny Pickle", type: "chat", limit: { context: 100000 } },
      { id: "embed-pickle", object: "model", name: "Embed Pickle", type: "embedding" },
    ],
  };
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    sawAuth.push(String(req.headers.authorization ?? ""));
    if (req.method === "GET" && (url === "/inference/v1/models" || url === "/inference/openai/v1/models" || url === "/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MODELS_BODY));
      return;
    }
    if (req.method === "POST" && (url === "/inference/openai/v1/chat/completions" || url === "/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try { sawBody.push(JSON.parse(raw)); } catch { sawBody.push(null); }
        // Sonde du test de clé (1 jeton, pas de flux) : réponse simple.
        try {
          const body = JSON.parse(raw);
          if (body?.max_tokens === 1 && body?.stream === false) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }));
            return;
          }
        } catch { /* requête non JSON : on streame quand même */ }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        sse({ model: "big-pickle", choices: [{ delta: { reasoning_content: "Je raisonne." } }] });
        sse({ model: "big-pickle", choices: [{ delta: { content: "Réponse du faux opencode : " } }] });
        sse({ model: "big-pickle", choices: [{ delta: { content: "la chaîne complète fonctionne." } }] });
        sse({ model: "big-pickle", choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 9 } });
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `route inconnue : ${req.method} ${url}` } }));
  });
  return new Promise((resolve) => {
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ server, sawAuth, sawBody }));
  });
}

function startService(): Promise<ChildProcess> {
  mkdirSync(DB_DIR, { recursive: true });
  const env = {
    ...process.env,
    HERMES_SERVICE_TOKEN: TOKEN,
    HERMES_CHAT_PORT: "3313",
    HERMES_CHAT_FILES_PORT: "3314",
    HERMES_GATEWAY_URL: "", // moteur local/pool — la gateway n'existe pas ici
    HERMES_CHAT_DB: join(DB_DIR, "hermes-chat.sqlite"),
  };
  const proc = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  (proc.stderr as any).on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (/error|Error|ERREUR/.test(line)) console.log("    [service:err]", line.slice(0, 160));
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

async function main() {
  let service: ChildProcess | null = null;
  let mock: { server: Server; sawAuth: string[]; sawBody: any[] } | null = null;
  let socket: any = null;
  try {
    console.log("[boot] faux opencode (3315) + service hermes-chat (3313/3314)…");
    mock = await startMock();
    service = await startService();
    socket = await connectSocket();

    // ── [U] Résolution du nom et de l'adresse ─────────────────────────
    console.log("\n[U] Reconnaissance du fournisseur opencode");
    {
      const byName = resolveKnownProvider("opencode");
      check(
        "« opencode » reconnu comme fournisseur connu",
        byName && "known" in byName && byName.known.name === "opencode",
        JSON.stringify(byName && "known" in byName ? byName.known.name : byName)
      );
      const byUrl = resolveKnownProvider("https://opencode.ai/inference/openai/v1");
      check(
        "adresse opencode collée → opencode (PAS OpenAI)",
        byUrl && "known" in byUrl && byUrl.known.name === "opencode",
        JSON.stringify(byUrl && "known" in byUrl ? byUrl.known.name : byUrl)
      );
      const openai = resolveKnownProvider("OpenAI");
      check(
        "« OpenAI » reste reconnu comme OpenAI (non régressé)",
        openai && "known" in openai && openai.known.name === "OpenAI"
      );
      const caps = providerCapabilities("opencode", null);
      check(
        "capacités : kind llm + adresse canonique exposée",
        !!caps && caps.kind === "llm" && !!caps.defaultBaseUrl,
        caps?.defaultBaseUrl ?? ""
      );
    }

    // ── [P] providers:add par adresse + baseUrl locale ────────────────
    console.log("\n[P] Ajout du fournisseur");
    let providerId: string | null = null;
    {
      const hello0 = await emitAck(socket, "hello");
      check(
        "hello initial : mode local, aucun fournisseur actif",
        hello0?.mode === "local" && (hello0?.engineProviders ?? []).length === 0,
        `mode=${hello0?.mode} engineProviders=${JSON.stringify(hello0?.engineProviders ?? [])}`
      );

      const add = await emitAck(socket, "providers:add", {
        name: "https://opencode.ai/inference/openai/v1", // adresse collée
        kind: "llm",
        baseUrl: `http://localhost:${MOCK_PORT}`, // origine seule (proxy) : chemins canoniques conservés
      });
      providerId = add?.provider?.id ?? null;
      check("ajout par adresse → fournisseur créé", Boolean(providerId), JSON.stringify(add).slice(0, 100));
      check(
        "nom canonique « opencode » (pas OpenAI)",
        add?.provider?.name === "opencode",
        add?.provider?.name
      );
      check(
        "origine explicite conservée (faux serveur local)",
        add?.provider?.baseUrl === `http://localhost:${MOCK_PORT}`,
        add?.provider?.baseUrl
      );

      const dup = await emitAck(socket, "providers:add", { name: "opencode", kind: "llm" });
      check(
        "doublon « opencode » refusé proprement",
        typeof dup?.error === "string" && /déjà/.test(dup.error),
        JSON.stringify(dup).slice(0, 80)
      );
    }

    // ── [K] Clé + hello rediffusé (engineProviders) ───────────────────
    console.log("\n[K] Clé ajoutée → carte de statut honnête");
    {
      const helloNext = new Promise<any>((resolve) => {
        socket.on("hello", function onHello(info: any) {
          socket.off("hello", onHello);
          resolve(info);
        });
      });
      const key = await emitAck(socket, "providers:add-key", {
        providerId,
        label: "Faux test",
        secret: MOCK_KEY,
      });
      check("clé ajoutée", Boolean(key?.key?.id), JSON.stringify(key).slice(0, 80));
      const hello1 = await Promise.race([helloNext, wait(4000).then(() => null)]);
      check(
        "hello rediffusé : engineProviders contient « opencode »",
        Array.isArray(hello1?.engineProviders) && hello1.engineProviders.includes("opencode"),
        JSON.stringify(hello1?.engineProviders ?? null)
      );
    }

    // ── [M] Liste vivante des modèles ─────────────────────────────────
    console.log("\n[M] Modèles du fournisseur");
    {
      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check("source « providers » (liste vivante)", models?.source === "providers", models?.source);
      check("big-pickle présent", ids.includes("big-pickle"), ids.join(","));
      check("embed-pickle écarté (non-chat)", !ids.includes("embed-pickle"));
      const big = (models?.models ?? []).find((m: any) => m.id === "big-pickle");
      check(
        "libellé lisible « Big Pickle » (champ name)",
        big?.label === "Big Pickle",
        big?.label
      );
      check("provider « opencode »", big?.provider === "opencode", big?.provider);
    }

    // ── [T] Tour réel streamé chez le faux opencode ───────────────────
    console.log("\n[T] Tour de chat via le fournisseur");
    {
      const conv = await emitAck(socket, "conversations:create");
      const cid = conv?.conversation?.id;
      check("conversation créée", Boolean(cid));

      const doneP = new Promise<any>((resolve) => {
        socket.on("stream:done", function onDone(p: any) {
          if (p?.conversationId === cid) {
            socket.off("stream:done", onDone);
            resolve(p);
          }
        });
      });
      const ack = await emitAck(socket, "chat:send", {
        conversationId: cid,
        content: "Bonjour, qui es-tu ?",
        model: "big-pickle",
      });
      check("ack chat:send → ok:true", ack?.ok === true, JSON.stringify(ack).slice(0, 90));
      const done = await Promise.race([doneP, wait(15000).then(() => null)]);
      check("stream:done reçu", Boolean(done?.message?.id));
      check(
        "contenu = réponse du faux opencode",
        done?.message?.content === MOCK_CONTENT,
        JSON.stringify(done?.message?.content).slice(0, 90)
      );
      check(
        "message étiqueté avec le modèle du fournisseur",
        typeof done?.message?.model === "string" && done.message.model.includes("big-pickle"),
        done?.message?.model
      );
      check(
        "clé Bearer transmise au fournisseur",
        mock!.sawAuth.some((a) => a === `Bearer ${MOCK_KEY}`),
        mock!.sawAuth[mock!.sawAuth.length - 1] ?? ""
      );
      check(
        "requête OpenAI-compatible (messages + stream)",
        mock!.sawBody.length > 0 && Array.isArray(mock!.sawBody[0]?.messages) && mock!.sawBody[0]?.stream === true
      );

      const hello2 = await emitAck(socket, "hello");
      check(
        "hello après tour : le modèle réel est exposé (opencode)",
        typeof hello2?.model === "string" && hello2.model.includes("opencode"),
        hello2?.model
      );
    }

    // ── [V] v2.5 : endpoint éditable, adresse complète honorée ──────
    console.log("\n[V] Endpoint éditable : adresse avec chemin utilisée telle quelle");
    {
      const set = await emitAck(socket, "providers:set-base", {
        id: providerId,
        baseUrl: `http://localhost:${MOCK_PORT}/v1`,
      });
      check(
        "set-base avec chemin complet → enregistré tel quel",
        set?.provider?.baseUrl === `http://localhost:${MOCK_PORT}/v1`,
        set?.provider?.baseUrl
      );
      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check(
        "le moteur appelle /v1/models du faux serveur (verbatim)",
        models?.source === "providers" && ids.includes("big-pickle"),
        `${models?.source} · ${ids.join(",")}`
      );
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
