// Test de régression Lot 1 — flux fantômes du pool LLM (audit L1-4, correctif
// 1.5) : une erreur HTTP reçue APRÈS le fetch (401/429/500) doit libérer
// l'entrée du stallGuard — sinon elle reste à vie dans activeStreamEntries,
// /diagnostics montre des flux « en vol » éternels et le minuteur fuit (en
// débat parallèle ×3, un seul 401 créait 3 fantômes d'un coup).
//
// Le pool est monté EN PROCESSUS sur une base jetable : le fichier de la base
// de dev est mis de côté pendant le test puis restitué (aucune trace laissée).
//   1. tour → HTTP 401 → PoolAuthError ET activeStreams vidée
//   2. tour → HTTP 500 → erreur contextualisée ET activeStreams vidée
//   3. tour → HTTP 200 + SSE → tour réussi (le chemin heureux est intact)
//      ET activeStreams vidée à la fin
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../mini-services/hermes-chat/store";
import { createLlmPool } from "../mini-services/hermes-chat/llm-pool";
import type { TurnCallbacks } from "../mini-services/hermes-chat/local-engine";

const MOCK_PORT = 3444;
const DB_DIR = join(import.meta.dir, "..", "db");
const DB_BASE = join(DB_DIR, "hermes-chat.sqlite");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

// ── mise de côté de la base de dev (le store écrit à un chemin fixe) ─────
const hadDb = existsSync(DB_DIR);
const backups: string[] = [];
if (hadDb) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = DB_BASE + suffix;
    if (existsSync(src)) {
      renameSync(src, src + ".test-pool-backup");
      backups.push(src);
    }
  }
}
function restoreDb() {
  // Ne supprimer QUE les fichiers de base fraîchement créés — jamais le
  // dossier entier : les backups à restituer vivent dedans (et le dossier
  // contient aussi artifacts/ d'une éventuelle installation de dev).
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB_BASE + suffix;
    if (existsSync(f)) rmSync(f, { force: true });
  }
  for (const src of backups) {
    const b = src + ".test-pool-backup";
    if (existsSync(b)) renameSync(b, src);
  }
  backups.length = 0; // garde anti double-appel (finally + catch)
}

let mode: "401" | "500" | "200" = "401";
const server = Bun.serve({
  port: MOCK_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "fake-model" }] });
    if (url.pathname === "/v1/chat/completions") {
      if (mode === "401") return Response.json({ error: { message: "clé factice refusée" } }, { status: 401 });
      if (mode === "500") return new Response("boom", { status: 500 });
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Bonjour"}}]}\n\n'));
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":" le monde"}}]}\n\n'));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});

async function main() {
  let store: Store | null = null;
  try {
    mkdirSync(DB_DIR, { recursive: true });
    store = new Store();
    const provider = store.createProvider({ name: "GhostTest", kind: "llm", baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` });
    store.createProviderKey(provider.id, "test", "sk-fake-key", "sk-***");
    const pool = createLlmPool(store);
    const req = { content: "dis bonjour", history: [], modelId: "fake-model" };
    const cb = (): TurnCallbacks => ({
      signal: new AbortController().signal,
      onDelta: () => {},
      onReasoning: () => {},
      onStatus: () => {},
      onToolEvent: () => {},
    });
    const settle = () => new Promise((r) => setTimeout(r, 100));

    console.log("[1] HTTP 401 après l'envoi du fetch");
    mode = "401";
    let threw = "";
    try {
      await pool.runTurn(req, cb());
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check("401 → PoolAuthError contextualisée", threw.includes("clé refusée"), threw.slice(0, 60));
    await settle();
    check("401 → 0 flux fantôme dans activeStreams", pool.activeStreams().length === 0,
      `entrées: ${pool.activeStreams().length}`);

    console.log("[2] HTTP 500 après l'envoi du fetch");
    // Le 401 a déclassé la clé (comportement normal du porte-clés) : une clé
    // fraîche rend le fournisseur actif pour ce cas.
    store!.createProviderKey(provider.id, "test-2", "sk-fake-key-2", "sk-***");
    mode = "500";
    threw = "";
    try {
      await pool.runTurn(req, cb());
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check("500 → erreur contextualisée", threw.includes("HTTP 500"), threw.slice(0, 60));
    await settle();
    check("500 → 0 flux fantôme", pool.activeStreams().length === 0, `entrées: ${pool.activeStreams().length}`);

    console.log("[3] chemin heureux (200 + SSE)");
    store!.createProviderKey(provider.id, "test-3", "sk-fake-key-3", "sk-***");
    mode = "200";
    let content = "";
    const result = await pool.runTurn(req, { ...cb(), onDelta: (d) => (content += d) });
    check("200 → tour réussi", Boolean(result) && content === "Bonjour le monde", `contenu « ${content} »`);
    await settle();
    check("200 → 0 flux fantôme à la fin du tour", pool.activeStreams().length === 0,
      `entrées: ${pool.activeStreams().length}`);
  } finally {
    server.stop(true);
    store?.close();
    restoreDb();
  }

  console.log(failures === 0 ? "\nFlux fantômes : 0 échec" : `\nFlux fantômes : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  restoreDb();
  process.exit(1);
});
