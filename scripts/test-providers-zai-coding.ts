// Test d'intégration « clés z.ai GLM Coding Plan » (v2.4) — démarre le VRAI
// service hermes-chat (ports 3317/3318, base isolée) plus un FAUX z.ai local
// (port 3319) qui imite les DEUX surfaces réelles d'api.z.ai :
//   • surface standard  /api/paas/v4        — refuse les jetons JWT (401
//     « token expired or incorrect », comportement réel vérifié) ;
//   • surface « coding » /api/coding/paas/v4 — la SEULE que les clés Coding
//     Plan acceptent (docs.z.ai/devpack — Tool Integration).
// Vérifie de bout en bout :
//   [U] unitaire : looksLikeZaiJwt (JWT eyJ… oui, clé API xxx.yyy non)
//   [P] providers:add « z.ai » + adresse explicite → fournisseur canonique
//   [K] providers:add-key (JWT) puis providers:test-key → « ok » avec
//       « Coding Plan » dans le libellé, test passé sur la SURFACE CODING
//       du faux serveur (preuve du routage par le test de clé)
//   [M] models:list → liste vivante de la surface coding (embedding écarté)
//   [T] chat:send → tour streamé via la surface coding, clé Bearer JWT
//       transmise, la surface standard n'est JAMAIS appelée (preuve du
//       routage du moteur), message étiqueté glm-5.3 · z.ai
//   [F] repli documenté : surface coding privée de /models → la liste de
//       repli (glm-4.6…) prend le relais après invalidation du cache
// Aucun réseau externe : le faux serveur tourne sur localhost.
import { io } from "socket.io-client";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { looksLikeZaiJwt } from "../mini-services/hermes-chat/providers";

const TOKEN = "test-jeton-zai-ABC123";
const SOCK_URL = "http://localhost:3317";
const DB_DIR = "/home/z/my-project/hermes_ui/db-test-zai";
const MOCK_PORT = 3319;
// Jeton factice au format JWT (les clés Coding Plan réelles en sont).
const MOCK_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdXJpYW5uZSJ9.c2lnbmF0dXJlLWZhdXNzZQ";
const MOCK_API_KEY = "fauxecle.abcdef123456"; // clé API standard (paas/v4)
const MOCK_CONTENT = "Réponse du faux z.ai coding : la clé Coding Plan fonctionne.";

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

// ── Faux z.ai : deux surfaces, comme le vrai api.z.ai ──────────────────
function startMock(): Promise<{
  server: Server;
  hits: Map<string, number>;
  auths: Map<string, string[]>;
  codingModelsBroken: { value: boolean };
}> {
  const hits = new Map<string, number>();
  const auths = new Map<string, string[]>();
  const codingModelsBroken = { value: false };
  const bump = (k: string, auth: string) => {
    hits.set(k, (hits.get(k) ?? 0) + 1);
    auths.set(k, [...(auths.get(k) ?? []), auth]);
  };
  // Une clé Coding Plan (JWT) est refusée par la surface standard —
  // comportement réel observé : 401 « token expired or incorrect ».
  const isJwt = (a: string) => a.startsWith("Bearer eyJ");
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const auth = String(req.headers.authorization ?? "");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // Surface standard (paas/v4) : n'accepte QUE les clés API.
    if (req.method === "GET" && url === "/api/paas/v4/models") {
      bump("paas:models", auth);
      if (!auth || isJwt(auth) || auth !== `Bearer ${MOCK_API_KEY}`) {
        return json(401, { error: { code: "401", message: "token expired or incorrect" } });
      }
      return json(200, { data: [{ id: "glm-4.6" }] });
    }
    if (req.method === "POST" && url === "/api/paas/v4/chat/completions") {
      bump("paas:chat", auth);
      return json(401, { error: { code: "401", message: "token expired or incorrect" } });
    }

    // Surface « coding » : accepte le jeton Coding Plan.
    if (req.method === "GET" && url === "/api/coding/paas/v4/models") {
      bump("coding:models", auth);
      if (auth !== `Bearer ${MOCK_JWT}`) {
        return json(401, { error: { code: "401", message: "token expired or incorrect" } });
      }
      if (codingModelsBroken.value) {
        return json(404, { error: { message: "not found" } });
      }
      return json(200, {
        data: [
          { id: "glm-5.3" },
          { id: "glm-5.3-flash" },
          { id: "embed-glmu" }, // non-chat : doit être écarté
        ],
      });
    }
    if (req.method === "POST" && url === "/api/coding/paas/v4/chat/completions") {
      bump("coding:chat", auth);
      if (auth !== `Bearer ${MOCK_JWT}`) {
        return json(401, { error: { code: "401", message: "token expired or incorrect" } });
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        sse({ model: "glm-5.3", choices: [{ delta: { content: "Réponse du faux z.ai coding : " } }] });
        sse({ model: "glm-5.3", choices: [{ delta: { content: "la clé Coding Plan fonctionne." } }] });
        sse({ model: "glm-5.3", choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 8 } });
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    return json(404, { error: { message: `route inconnue : ${req.method} ${url}` } });
  });
  return new Promise((resolve) => {
    server.listen(MOCK_PORT, "127.0.0.1", () =>
      resolve({ server, hits, auths, codingModelsBroken })
    );
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
    cwd: "/home/z/my-project/hermes_ui",
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
    console.log("[boot] faux z.ai (3319) + service hermes-chat (3317/3318)…");
    mock = await startMock();
    service = await startService();
    socket = await connectSocket();

    // ── [U] Détection des jetons Coding Plan ───────────────────────────
    console.log("\n[U] Reconnaissance des clés Coding Plan (JWT)");
    {
      check("jeton JWT « eyJ… » reconnu", looksLikeZaiJwt(MOCK_JWT));
      check(
        "clé API « xxxxxxxx.yyyyyyyy » NON traitée comme JWT",
        !looksLikeZaiJwt(MOCK_API_KEY)
      );
      check("clé OpenAI « sk-… » NON traitée comme JWT", !looksLikeZaiJwt("sk-abc123def456ghi789"));
      check("texte quelconque NON traité comme JWT", !looksLikeZaiJwt("bonjour je suis une cle"));
    }

    // ── [P] Ajout du fournisseur z.ai (adresse du faux serveur) ───────
    console.log("\n[P] Ajout du fournisseur z.ai");
    let providerId: string | null = null;
    {
      const add = await emitAck(socket, "providers:add", {
        name: "z.ai",
        kind: "llm",
        baseUrl: `http://localhost:${MOCK_PORT}`,
      });
      providerId = add?.provider?.id ?? null;
      check("fournisseur créé", Boolean(providerId), JSON.stringify(add).slice(0, 90));
      check("nom canonique « z.ai »", add?.provider?.name === "z.ai", add?.provider?.name);
      check(
        "adresse explicite conservée (faux serveur local)",
        add?.provider?.baseUrl === `http://localhost:${MOCK_PORT}`,
        add?.provider?.baseUrl
      );
    }

    // ── [K] Clé Coding Plan + test → surface coding ────────────────────
    console.log("\n[K] Clé Coding Plan testée sur la bonne surface");
    let keyId: string | null = null;
    {
      const key = await emitAck(socket, "providers:add-key", {
        providerId,
        label: "Coding Plan",
        secret: MOCK_JWT,
      });
      keyId = key?.key?.id ?? null;
      check("clé JWT ajoutée", Boolean(keyId), JSON.stringify(key).slice(0, 80));

      const test = await emitAck(socket, "providers:test-key", { keyId });
      check(
        "test → ok (clé acceptée)",
        test?.ok === true && test?.key?.status === "ok",
        JSON.stringify(test?.key ?? test).slice(0, 90)
      );
      check(
        "libellé mentionne « Coding Plan » et le compte de modèles",
        /Coding Plan/.test(String(test?.key?.statusLabel ?? "")) &&
          /modèles/.test(String(test?.key?.statusLabel ?? "")),
        test?.key?.statusLabel
      );
      check(
        "le test a interrogé la SURFACE CODING du faux serveur",
        (mock!.hits.get("coding:models") ?? 0) >= 1,
        `coding:models=${mock!.hits.get("coding:models") ?? 0}`
      );
      check(
        "le test n'a PAS touché la surface standard",
        (mock!.hits.get("paas:models") ?? 0) === 0,
        `paas:models=${mock!.hits.get("paas:models") ?? 0}`
      );
    }

    // ── [M] Liste vivante via la surface coding ────────────────────────
    console.log("\n[M] Modèles du fournisseur (surface coding)");
    {
      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check("source « providers » (liste vivante)", models?.source === "providers", models?.source);
      check("glm-5.3 présent", ids.includes("glm-5.3"), ids.join(","));
      check("glm-5.3-flash présent", ids.includes("glm-5.3-flash"));
      check("embed-glmu écarté (non-chat)", !ids.includes("embed-glmu"));
      const glm = (models?.models ?? []).find((m: any) => m.id === "glm-5.3");
      check("provider « z.ai »", glm?.provider === "z.ai", glm?.provider);
    }

    // ── [T] Tour réel via la surface coding ────────────────────────────
    console.log("\n[T] Tour de chat via la clé Coding Plan");
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
        model: "glm-5.3",
      });
      check("ack chat:send → ok:true", ack?.ok === true, JSON.stringify(ack).slice(0, 90));
      const done = await Promise.race([doneP, wait(15000).then(() => null)]);
      check("stream:done reçu", Boolean(done?.message?.id));
      check(
        "contenu = réponse du faux z.ai coding",
        done?.message?.content === MOCK_CONTENT,
        JSON.stringify(done?.message?.content).slice(0, 90)
      );
      check(
        "message étiqueté avec le modèle réel (glm-5.3 · z.ai)",
        typeof done?.message?.model === "string" && done.message.model.includes("glm-5.3"),
        done?.message?.model
      );
      check(
        "clé Bearer JWT transmise à la surface coding",
        (mock!.auths.get("coding:chat") ?? []).includes(`Bearer ${MOCK_JWT}`),
        (mock!.auths.get("coding:chat") ?? [""])[0].slice(0, 30)
      );
      check(
        "la surface standard n'a JAMAIS servi le tour (routage moteur)",
        (mock!.hits.get("paas:chat") ?? 0) === 0,
        `paas:chat=${mock!.hits.get("paas:chat") ?? 0}`
      );
    }

    // ── [F] Repli documenté quand la surface coding n'a pas /models ────
    console.log("\n[F] Repli documenté (surface sans liste de modèles)");
    {
      mock!.codingModelsBroken.value = true;
      // Le changement du porte-clés vide les caches de listes.
      const k2 = await emitAck(socket, "providers:add-key", {
        providerId,
        label: "Seconde clé",
        secret: MOCK_JWT,
      });
      check("seconde clé ajoutée (force l'invalidation des caches)", Boolean(k2?.key?.id));
      const models = await emitAck(socket, "models:list");
      const ids = (models?.models ?? []).map((m: any) => m.id);
      check(
        "repli : glm-4.6 de la liste documentée présent",
        ids.includes("glm-4.6"),
        ids.join(",")
      );
      check(
        "repli : glm-5.3 (liste documentée) toujours proposé",
        ids.includes("glm-5.3"),
        ids.join(",")
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
