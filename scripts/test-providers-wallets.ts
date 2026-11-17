// Test d'intégration « portefeuilles z.ai » (v2.5) — démarre le VRAI
// service hermes-chat (ports 3317/3318, base isolée) plus un FAUX z.ai
// local (port 3321) qui reproduit la matrice croisée observée avec les
// clés réelles (2026-11-15) :
//   • surface standard  /api/paas/v4        — n'accepte que la clé API
//     avec solde ; toute autre clé (Coding Plan AU FORMAT STANDARD, ou
//     clé API sans solde) → 429 code 1113 « Insufficient balance » ;
//   • surface « coding » /api/coding/paas/v4 — n'accepte QUE la clé
//     Coding Plan ; une clé API y reçoit aussi 429.
// z.ai sépare donc l'argent en deux portefeuilles étanches, et le FORMAT
// de la clé ne dit pas sur laquelle elle puise.
// Vérifie de bout en bout :
//   [U]  unitaire : resolveKnownProvider / providerCapabilities /
//        applyExplicitBase (le champ « endpoint » éditable)
//   [U2] testProviderKey direct sur le faux serveur : clé Coding Plan au
//        format standard → ok SURFACE CODING + migrateBaseUrl ; clé API
//        sans solde → exhausted « solde insuffisant », sans migration
//   [C]  providers:catalog — z.ai y figure DEUX fois (API standard /
//        GLM Coding Plan), adresses par défaut distinctes
//   [G]  providers:add avec l'adresse par défaut inchangée → baseUrl
//        stocké null (le canon reste la référence)
//   [A]  preset « z.ai Coding Plan » : liste des modèles ET tour de chat
//        sur la surface coding, clé au format standard (non JWT)
//   [W]  LE CAS RÉEL : preset « z.ai » + clé Coding Plan format standard
//        → test 429 côté standard, 200 côté coding, fournisseur BASCULÉ
//        automatiquement (base_url persistée) puis liste + tour via la
//        surface coding, la standard ne sert jamais le tour
//   [R]  bascule inverse : preset Coding Plan + clé API avec solde →
//        fournisseur basculé sur la surface standard
//   [B]  les deux portefeuilles à sec → « solde insuffisant », aucune
//        bascule
//   [E]  providers:set-base : adresse avec chemin = base COMPLÈTE (le
//        moteur l'utilise telle quelle) ; chaîne vide = retour au canon
//   [X]  providers:add avec une adresse complète modifiée → utilisée
//        telle quelle par le moteur, sans même passer par le test
// Aucun réseau externe : le faux serveur tourne sur localhost, toutes
// les clés sont factices.
import { io } from "socket.io-client";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  applyExplicitBase,
  providerCapabilities,
  resolveKnownProvider,
  testProviderKey,
} from "../mini-services/hermes-chat/providers";

const TOKEN = "test-jeton-wallets-XYZ789";
const SOCK_URL = "http://localhost:3317";
const DB_DIR = new URL("../db-test-wallets", import.meta.url).pathname;
const MOCK_PORT = 3321;
const MOCK_ORIGIN = `http://localhost:${MOCK_PORT}`;
const MOCK_STD = `${MOCK_ORIGIN}/api/paas/v4`;
const MOCK_CODING = `${MOCK_ORIGIN}/api/coding/paas/v4`;

// Clés factices — la première a le FORMAT d'une clé API standard
// (xxxxxxxx.yyyyyyyy) mais ne répond QUE sur la surface coding : c'est
// le cas réel découvert le 2026-11-15 (clé Coding Plan au format standard).
const CODING_KEY = "abcdef1234567890abcdef1234567890.codingplan01";
const API_KEY_OK = "abcdef1234567890abcdef1234567891.standardok01";
const API_KEY_EMPTY = "abcdef1234567890abcdef1234567892.nosolde0001";

const CODING_CONTENT = "Réponse coding du faux z.ai : portefeuille Coding Plan.";
const STD_CONTENT = "Réponse standard du faux z.ai : API payante.";

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

// ── Faux z.ai : deux portefeuilles étanches, matrice réelle ───────────
function startMock(): Promise<{
  server: Server;
  hits: Map<string, number>;
  auths: Map<string, string[]>;
  seq: string[];
}> {
  const hits = new Map<string, number>();
  const auths = new Map<string, string[]>();
  const seq: string[] = [];
  const bump = (k: string, auth: string) => {
    hits.set(k, (hits.get(k) ?? 0) + 1);
    auths.set(k, [...(auths.get(k) ?? []), auth]);
    seq.push(k);
  };
  const balance429 = (res: any) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "1113", message: "Insufficient balance or no resource package" },
      })
    );
  };
  const sseReply = (res: any, model: string, content: string) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    sse({ model, choices: [{ delta: { content } }] });
    sse({ model, choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
    res.write("data: [DONE]\n\n");
    res.end();
  };
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const auth = String(req.headers.authorization ?? "");

    // Surface standard : seule la clé API AVEC solde y répond.
    if (req.method === "GET" && url === "/api/paas/v4/models") {
      bump("paas:models", auth);
      if (auth !== `Bearer ${API_KEY_OK}`) return balance429(res);
      return ((
        res.writeHead(200, { "Content-Type": "application/json" }),
        res.end(JSON.stringify({ data: [{ id: "glm-4.6" }, { id: "glm-4.6-flash" }] }))
      ));
    }
    if (req.method === "POST" && url === "/api/paas/v4/chat/completions") {
      bump("paas:chat", auth);
      if (auth !== `Bearer ${API_KEY_OK}`) return balance429(res);
      return sseReply(res, "glm-4.6-flash", STD_CONTENT);
    }

    // Surface coding : seule la clé Coding Plan y répond (même au format
    // standard xxxxxxxx.yyyyyyyy — la section de création décide).
    if (req.method === "GET" && url === "/api/coding/paas/v4/models") {
      bump("coding:models", auth);
      if (auth !== `Bearer ${CODING_KEY}`) return balance429(res);
      return ((
        res.writeHead(200, { "Content-Type": "application/json" }),
        res.end(
          JSON.stringify({
            data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }, { id: "embed-glmu" }],
          })
        )
      ));
    }
    if (req.method === "POST" && url === "/api/coding/paas/v4/chat/completions") {
      bump("coding:chat", auth);
      if (auth !== `Bearer ${CODING_KEY}`) return balance429(res);
      return sseReply(res, "glm-5.3-flash", CODING_CONTENT);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `route inconnue : ${req.method} ${url}` } }));
  });
  return new Promise((resolve) => {
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ server, hits, auths, seq }));
  });
}

function startService(): Promise<ChildProcess> {
  mkdirSync(DB_DIR, { recursive: true });
  const env = {
    ...process.env,
    HERMES_SERVICE_TOKEN: TOKEN,
    HERMES_CHAT_PORT: "3317",
    HERMES_CHAT_FILES_PORT: "3318",
    HERMES_GATEWAY_URL: "",
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
  let mock: Awaited<ReturnType<typeof startMock>> | null = null;
  let socket: any = null;
  try {
    console.log("[boot] faux z.ai (3321) + service hermes-chat (3317/3318)…");
    mock = await startMock();
    service = await startService();
    socket = await connectSocket();

    // ── [U] Résolution du catalogue + règle de l'endpoint éditable ────
    console.log("\n[U] Catalogue : deux portefeuilles z.ai, règle de l'endpoint");
    {
      const coding = resolveKnownProvider("z.ai Coding Plan");
      check(
        "« z.ai Coding Plan » reconnu comme preset distinct",
        "known" in (coding ?? {}) && coding!.known.name === "z.ai Coding Plan",
        JSON.stringify(coding ?? null).slice(0, 60)
      );
      const std = resolveKnownProvider("z.ai");
      check(
        "« z.ai » reste le preset API standard",
        "known" in (std ?? {}) && std!.known.name === "z.ai",
        JSON.stringify(std ?? null).slice(0, 60)
      );
      check(
        "« GLM Coding Plan » reconnu comme Coding Plan",
        resolveKnownProvider("GLM Coding Plan")?.known?.name === "z.ai Coding Plan"
      );
      check(
        "capabilities : preset Coding Plan sans adresse",
        providerCapabilities("z.ai Coding Plan", null)?.name === "z.ai Coding Plan"
      );
      check(
        "capabilities : « z.ai » + adresse coding → reste le preset standard",
        providerCapabilities("z.ai", "https://api.z.ai/api/coding/paas/v4")?.name === "z.ai"
      );
      const DEF = "https://api.z.ai/api/paas/v4";
      check(
        "endpoint éditable : adresse par défaut inchangée → canon",
        applyExplicitBase(DEF, DEF, DEF) === DEF
      );
      check(
        "endpoint éditable : origine seule → hôte remplacé, chemin canon",
        applyExplicitBase(DEF, DEF, "https://proxy.example.fr") ===
          "https://proxy.example.fr/api/paas/v4"
      );
      check(
        "endpoint éditable : adresse avec chemin → base COMPLÈTE",
        applyExplicitBase(DEF, DEF, "https://proxy.example.fr/v1") ===
          "https://proxy.example.fr/v1"
      );
    }

    // ── [U2] testProviderKey direct sur le faux serveur ───────────────
    console.log("\n[U2] Test de clé direct (matrice portefeuilles)");
    {
      const r1 = await testProviderKey("z.ai", MOCK_ORIGIN, CODING_KEY);
      check(
        "clé Coding Plan format standard → ok sur la surface coding",
        r1.status === "ok" && /Coding Plan/.test(r1.statusLabel),
        `${r1.status} · ${r1.statusLabel}`
      );
      check(
        "migrateBaseUrl proposé (surface coding du faux serveur)",
        r1.migrateBaseUrl === MOCK_CODING,
        r1.migrateBaseUrl ?? "(aucune)"
      );
      const r2 = await testProviderKey("z.ai", MOCK_ORIGIN, API_KEY_EMPTY);
      check(
        "clé API sans solde → exhausted « solde insuffisant »",
        r2.status === "exhausted" && /solde insuffisant/i.test(r2.statusLabel),
        `${r2.status} · ${r2.statusLabel}`
      );
      check("clé API sans solde → aucune migration proposée", !r2.migrateBaseUrl);
    }

    // ── [C] Catalogue servi au client (sélecteur d'ajout) ─────────────
    console.log("\n[C] providers:catalog — sélecteur d'ajout");
    {
      const res = await emitAck(socket, "providers:catalog");
      const catalog = (res?.catalog ?? []) as any[];
      const zai = catalog.find((c) => c.name === "z.ai");
      const zaiCoding = catalog.find((c) => c.name === "z.ai Coding Plan");
      check("catalogue reçu, non vide", catalog.length >= 10, `${catalog.length} entrées`);
      check(
        "z.ai (API standard) au catalogue, adresse paas/v4",
        zai?.defaultBaseUrl === "https://api.z.ai/api/paas/v4" && zai?.kind === "llm",
        zai?.defaultBaseUrl
      );
      check(
        "z.ai Coding Plan au catalogue, adresse coding/paas/v4",
        zaiCoding?.defaultBaseUrl === "https://api.z.ai/api/coding/paas/v4",
        zaiCoding?.defaultBaseUrl
      );
      check(
        "libellés distincts dans le sélecteur",
        Boolean(zai?.label && zaiCoding?.label && zai.label !== zaiCoding.label),
        `${zai?.label} | ${zaiCoding?.label}`
      );
      check(
        "opencode : adresse par défaut d'appel servie",
        catalog.find((c) => c.name === "opencode")?.defaultBaseUrl ===
          "https://opencode.ai/inference/openai/v1"
      );
    }

    // ── [G] Adresse par défaut inchangée → stockée null ───────────────
    console.log("\n[G] Champ endpoint non modifié à l'ajout");
    {
      const res = await emitAck(socket, "providers:add", {
        name: "z.ai Coding Plan",
        kind: "llm",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      });
      check(
        "adresse identique au canon → baseUrl null (canon conservé)",
        res?.provider?.baseUrl == null,
        JSON.stringify(res?.provider?.baseUrl ?? null)
      );
      await emitAck(socket, "providers:remove", { id: res?.provider?.id });
    }

    // ── [A] Preset « z.ai Coding Plan » de bout en bout ───────────────
    console.log("\n[A] Preset « z.ai Coding Plan » (clé format standard, non JWT)");
    let providerA: string | null = null;
    {
      const add = await emitAck(socket, "providers:add", {
        name: "z.ai Coding Plan",
        kind: "llm",
        baseUrl: MOCK_ORIGIN,
      });
      providerA = add?.provider?.id ?? null;
      check("fournisseur créé", Boolean(providerA));
      const key = await emitAck(socket, "providers:add-key", {
        providerId: providerA,
        label: "Plan",
        secret: CODING_KEY,
      });
      check("clé (format standard) ajoutée", Boolean(key?.key?.id));

      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check("liste vivante depuis la surface coding", ids.includes("glm-5.3"), ids.join(","));
      check(
        "modèles étiquetés « z.ai Coding Plan »",
        (models?.models ?? []).some((m: any) => m.provider === "z.ai Coding Plan")
      );

      const conv = await emitAck(socket, "conversations:create");
      const cid = conv?.conversation?.id;
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
        content: "Bonjour",
        model: "glm-5.3",
      });
      check("tour accepté", ack?.ok === true);
      const done = await Promise.race([doneP, wait(15000).then(() => null)]);
      check("réponse servie par la surface coding", done?.message?.content === CODING_CONTENT,
        JSON.stringify(done?.message?.content ?? "").slice(0, 60));
      check(
        "le tour N'A JAMAIS touché la surface standard",
        (mock!.hits.get("paas:chat") ?? 0) === 0,
        `paas:chat=${mock!.hits.get("paas:chat") ?? 0}`
      );
      await emitAck(socket, "providers:remove", { id: providerA });
    }

    // ── [W] LE CAS RÉEL : preset standard + clé Coding Plan ───────────
    console.log("\n[W] Clé Coding Plan ajoutée côté « z.ai » standard → bascule auto");
    let providerW: string | null = null;
    {
      const add = await emitAck(socket, "providers:add", {
        name: "z.ai",
        kind: "llm",
        baseUrl: MOCK_ORIGIN,
      });
      providerW = add?.provider?.id ?? null;
      check("fournisseur « z.ai » créé (origine du faux serveur)", Boolean(providerW));
      const key = await emitAck(socket, "providers:add-key", {
        providerId: providerW,
        label: "Ma clé",
        secret: CODING_KEY,
      });
      const keyId = key?.key?.id ?? null;
      check("clé ajoutée", Boolean(keyId));

      mock!.seq.length = 0;
      const test = await emitAck(socket, "providers:test-key", { keyId });
      check(
        "test → ok malgré le 429 de la surface standard",
        test?.ok === true && test?.key?.status === "ok",
        JSON.stringify(test?.key ?? test).slice(0, 90)
      );
      check(
        "libellé « Coding Plan » (l'autre portefeuille)",
        /Coding Plan/.test(String(test?.key?.statusLabel ?? "")),
        test?.key?.statusLabel
      );
      check(
        "le test a d'abord interrogé la surface standard (règle d'origine)",
        mock!.seq[0] === "paas:models",
        mock!.seq.slice(0, 3).join(" → ")
      );
      check(
        "puis la surface coding (liste + mini-génération)",
        (mock!.hits.get("coding:models") ?? 0) >= 1 && (mock!.hits.get("coding:chat") ?? 0) >= 1,
        `coding:models=${mock!.hits.get("coding:models") ?? 0} coding:chat=${mock!.hits.get("coding:chat") ?? 0}`
      );
      check(
        "fournisseur basculé : callback du test",
        test?.provider?.baseUrl === MOCK_CODING,
        test?.provider?.baseUrl
      );
      const list = await emitAck(socket, "providers:list");
      const row = (list?.providers ?? []).find((p: any) => p.id === providerW);
      check(
        "bascule PERSISTÉE (providers:list) — le moteur utilisera la coding",
        row?.baseUrl === MOCK_CODING,
        row?.baseUrl
      );

      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check("liste des modèles servie par la surface coding", ids.includes("glm-5.3"), ids.join(","));

      const conv = await emitAck(socket, "conversations:create");
      const cid = conv?.conversation?.id;
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
        model: "glm-5.3",
      });
      check("tour accepté (clé non JWT, surface basculée)", ack?.ok === true);
      const done = await Promise.race([doneP, wait(15000).then(() => null)]);
      check("réponse de la surface coding", done?.message?.content === CODING_CONTENT,
        JSON.stringify(done?.message?.content ?? "").slice(0, 60));
      check(
        "clé Bearer transmise à la surface coding",
        (mock!.auths.get("coding:chat") ?? []).includes(`Bearer ${CODING_KEY}`)
      );
      check(
        "la surface standard n'a JAMAIS servi le tour",
        (mock!.hits.get("paas:chat") ?? 0) === 0,
        `paas:chat=${mock!.hits.get("paas:chat") ?? 0}`
      );
      await emitAck(socket, "providers:remove", { id: providerW });
    }

    // ── [R] Bascule inverse : preset Coding Plan + clé API ────────────
    console.log("\n[R] Clé API (avec solde) ajoutée côté Coding Plan → bascule inverse");
    let providerR: string | null = null;
    {
      const add = await emitAck(socket, "providers:add", {
        name: "z.ai Coding Plan",
        kind: "llm",
        baseUrl: MOCK_ORIGIN,
      });
      providerR = add?.provider?.id ?? null;
      const key = await emitAck(socket, "providers:add-key", {
        providerId: providerR,
        label: "API",
        secret: API_KEY_OK,
      });
      const test = await emitAck(socket, "providers:test-key", { keyId: key?.key?.id });
      check(
        "test → ok sur la surface standard",
        test?.ok === true && test?.key?.status === "ok",
        JSON.stringify(test?.key ?? test).slice(0, 90)
      );
      check(
        "fournisseur basculé vers la surface standard",
        test?.provider?.baseUrl === MOCK_STD,
        test?.provider?.baseUrl
      );
      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check("liste des modèles servie par la surface standard", ids.includes("glm-4.6"), ids.join(","));
      await emitAck(socket, "providers:remove", { id: providerR });
    }

    // ── [B] Les deux portefeuilles à sec ──────────────────────────────
    console.log("\n[B] Clé API sans solde : échec honnête, aucune bascule");
    let providerB: string | null = null;
    {
      const add = await emitAck(socket, "providers:add", {
        name: "z.ai",
        kind: "llm",
        baseUrl: MOCK_ORIGIN,
      });
      providerB = add?.provider?.id ?? null;
      const key = await emitAck(socket, "providers:add-key", {
        providerId: providerB,
        label: "Vide",
        secret: API_KEY_EMPTY,
      });
      const test = await emitAck(socket, "providers:test-key", { keyId: key?.key?.id });
      check(
        "verdict « exhausted » avec la raison (solde)",
        test?.key?.status === "exhausted" && /solde insuffisant/i.test(String(test?.key?.statusLabel ?? "")),
        `${test?.key?.status} · ${test?.key?.statusLabel}`
      );
      check(
        "les DEUX surfaces ont été essayées",
        (mock!.hits.get("paas:models") ?? 0) >= 1 && (mock!.hits.get("coding:models") ?? 0) >= 1
      );
      const list = await emitAck(socket, "providers:list");
      const row = (list?.providers ?? []).find((p: any) => p.id === providerB);
      check("aucune bascule (adresse inchangée)", row?.baseUrl === MOCK_ORIGIN, row?.baseUrl);
      await emitAck(socket, "providers:remove", { id: providerB });
    }

    // ── [E] Endpoint éditable : providers:set-base ────────────────────
    console.log("\n[E] providers:set-base — adresse avec chemin, puis reset");
    let providerE: string | null = null;
    {
      const add = await emitAck(socket, "providers:add", {
        name: "z.ai",
        kind: "llm",
        baseUrl: MOCK_ORIGIN,
      });
      providerE = add?.provider?.id ?? null;
      await emitAck(socket, "providers:add-key", {
        providerId: providerE,
        label: "Plan",
        secret: CODING_KEY,
      });
      const set = await emitAck(socket, "providers:set-base", {
        id: providerE,
        baseUrl: MOCK_CODING,
      });
      check("adresse complète enregistrée", set?.provider?.baseUrl === MOCK_CODING, set?.provider?.baseUrl);
      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check("le moteur utilise l'adresse complète (surface coding)", ids.includes("glm-5.3"), ids.join(","));
      const bad = await emitAck(socket, "providers:set-base", {
        id: providerE,
        baseUrl: "http://reseau-externe.example.com",
      });
      check("http vers le réseau refusé (sonde impossible)", Boolean(bad?.error), bad?.error);
      const reset = await emitAck(socket, "providers:set-base", { id: providerE, baseUrl: "" });
      check("chaîne vide → retour à l'adresse canonique", reset?.provider?.baseUrl == null,
        JSON.stringify(reset?.provider?.baseUrl ?? null));
      await emitAck(socket, "providers:remove", { id: providerE });
    }

    // ── [X] Ajout direct avec une adresse complète modifiée ───────────
    console.log("\n[X] providers:add avec endpoint modifié (chemin complet)");
    let providerX: string | null = null;
    {
      const add = await emitAck(socket, "providers:add", {
        name: "z.ai",
        kind: "llm",
        baseUrl: MOCK_CODING,
      });
      providerX = add?.provider?.id ?? null;
      check("adresse complète conservée telle quelle", add?.provider?.baseUrl === MOCK_CODING,
        add?.provider?.baseUrl);
      await emitAck(socket, "providers:add-key", {
        providerId: providerX,
        label: "Plan",
        secret: CODING_KEY,
      });
      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check("moteur sur la surface coding dès l'ajout (sans test)", ids.includes("glm-5.3"), ids.join(","));
      await emitAck(socket, "providers:remove", { id: providerX });
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
