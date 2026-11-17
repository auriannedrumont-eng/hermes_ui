// Test de régression Lot 1 — gardes d'origine du mini-service (audit L1-1,
// correctif 1.3) : sans jeton, une page web tierce ne connecte plus de socket
// et ne lit plus les fichiers locaux. Le service est démarré SANS jeton sur
// des ports dédiés (3307/3308) — le comportement AVEC jeton est couvert par
// test-service-token.ts. Vérifié :
//   1. handshake socket.io SANS Origin (curl, scripts QA) → HTTP 200
//   2. handshake avec Origin boucle locale → 200 + ACAO reflétée
//   3. handshake avec Origin tierce (evil.example) → réponse SANS ACAO
//      (le navigateur bloque) et socket rejetée par la garde io.use
//   4. socket.io client Origin tierce → connect_error « Origine non autorisée »
//   5. socket.io client Origin loopback → connecté
//   6. socket.io client sans Origin (scripts QA) → connecté
//   7. 3004 /diagnostics avec Origin tierce → 403
//   8. 3004 /diagnostics sans Origin (curl) → 200
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const { io } = createRequire(
  new URL("../mini-services/hermes-chat/package.json", import.meta.url).pathname
)("socket.io-client") as typeof import("socket.io-client");

const CHAT = 3307;
const FILES = 3308;

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function socketProbe(origin?: string): Promise<string> {
  return new Promise((resolve) => {
    const s = io(`http://127.0.0.1:${CHAT}`, {
      transports: ["polling"],
      timeout: 4000,
      ...(origin ? { extraHeaders: { Origin: origin } } : {}),
    });
    const done = (r: string) => {
      s.disconnect();
      resolve(r);
    };
    s.on("connect", () => done("connecté"));
    s.on("connect_error", (err: Error) => done(`refusée (${err.message})`));
    setTimeout(() => done("timeout"), 5000);
  });
}

async function main() {
  // ── fixture : service sans jeton sur 3307/3308 (base isolée — ne touche
  // jamais à la base de dev) ───────────────────────────────────────────────
  const proc = spawn("bun", ["index.ts"], {
    cwd: new URL("../mini-services/hermes-chat", import.meta.url).pathname,
    env: {
      ...process.env,
      HERMES_CHAT_PORT: String(CHAT),
      HERMES_CHAT_FILES_PORT: String(FILES),
      HERMES_CHAT_DB: new URL("../db-test-origin-guards/hermes-chat.sqlite", import.meta.url).pathname,
    },
    stdio: "ignore",
  });
  const killFixture = () => spawnSync("kill", [String(proc.pid)]);
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { await fetch(`http://127.0.0.1:${FILES}/diagnostics`); ready = true; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!ready) throw new Error("fixture : service injoignable sur " + CHAT);

    console.log("[1] handshake socket.io sans Origin (client non navigateur)");
    const r1 = await fetch(`http://127.0.0.1:${CHAT}/socket.io/?EIO=4&transport=polling`);
    check("handshake sans Origin → HTTP 200", r1.status === 200, `statut ${r1.status}`);
    check("handshake sans Origin → pas d'ACAO requis", r1.status === 200);

    console.log("[2] handshake avec Origin boucle locale");
    const r2 = await fetch(`http://127.0.0.1:${CHAT}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: "http://127.0.0.1:8123" },
    });
    check("handshake Origin loopback → ACAO reflétée",
      r2.headers.get("access-control-allow-origin") === "http://127.0.0.1:8123",
      `ACAO: ${r2.headers.get("access-control-allow-origin")}`);

    console.log("[3] handshake avec Origin tierce");
    const r3 = await fetch(`http://127.0.0.1:${CHAT}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: "http://evil.example" },
    });
    check("handshake Origin tierce → réponse sans ACAO (navigateur bloqué)",
      !r3.headers.get("access-control-allow-origin"),
      `ACAO: ${r3.headers.get("access-control-allow-origin") ?? "aucun"}`);

    console.log("[4-6] socket.io client (garde io.use)");
    const evil = await socketProbe("http://evil.example");
    check("socket Origin tierce → refusée", evil.startsWith("refusée"), evil);
    const loop = await socketProbe("http://127.0.0.1:8123");
    check("socket Origin loopback → connectée", loop === "connecté", loop);
    const none = await socketProbe();
    check("socket sans Origin (scripts QA) → connectée", none === "connecté", none);

    console.log("[7-8] service HTTP 3308");
    const r4 = await fetch(`http://127.0.0.1:${FILES}/diagnostics`, {
      headers: { Origin: "http://evil.example" },
    });
    check("3004 avec Origin tierce → 403", r4.status === 403, `statut ${r4.status}`);
    const r5 = await fetch(`http://127.0.0.1:${FILES}/diagnostics`);
    check("3004 sans Origin (curl) → 200", r5.status === 200, `statut ${r5.status}`);
  } finally {
    killFixture();
    // Hygiène (audit) : la base jetable ne doit pas survivre au test —
    // db-test-origin-guards/ s'accumulait à chaque passage de la suite.
    try {
      rmSync(new URL("../db-test-origin-guards", import.meta.url).pathname, {
        recursive: true,
        force: true,
      });
    } catch {
      /* déjà parti */
    }
  }

  console.log(failures === 0 ? "\nGardes d'origine : 0 échec" : `\nGardes d'origine : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
