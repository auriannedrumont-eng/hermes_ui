// Test de régression Lot 1 — passerelle Caddy figée (audit L1-1, correctif
// 1.4) : l'ancien relay ?XTransformPort=<n'importe quel port> permettait à une
// page web de pivoter vers un service local via la passerelle. Le Caddyfile
// ne doit plus relayer que les DEUX ports du service (3003 socket, 3004
// fichiers), et écouter la boucle locale uniquement.
//
// Monte la vraie pile : mini-service sur 3003/3004 (réutilise l'instance de
// dev si elle écoute déjà, sinon la démarre), serveur pivot factice sur 9050,
// Caddy sur le Caddyfile généré comme le fait le lanceur (sed des ports).
//   1. socket.io via passerelle (XTransformPort=3003) → handshake OK
//   2. /diagnostics via passerelle (XTransformPort=3004) → HTTP 200
//   3. pivot XTransformPort=9050 → PAS relayé (le corps du pivot est absent)
//   4. /socket.io/ avec XTransformPort=9050 → pas de handshake
//   5. sans XTransformPort → handle interface (502 attendu ici, pas d'UI)
//   6. la passerelle n'est pas joignable hors de la boucle locale (bind)
//
// SKIP (exit 42) si caddy est absent — la suite reste verte sans lui.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GW = 8181;
const PIVOT = 9050;

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const caddyPath = spawnSync("which", ["caddy"]).stdout?.toString().trim() ?? "";
if (!caddyPath) {
  console.log("SKIP — caddy indisponible sur cette machine, passerelle non testée");
  process.exit(42);
}

async function waitHttp(url: string, tries = 40): Promise<Response | null> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return null;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "hermes-gw-test-"));
  const svc = spawn("bun", ["index.ts"], {
    cwd: new URL("../mini-services/hermes-chat", import.meta.url).pathname,
    env: { ...process.env, HERMES_CHAT_PORT: "3003", HERMES_CHAT_FILES_PORT: "3004" },
    stdio: "ignore",
  });
  const caddy = spawn(caddyPath, ["run", "--config", join(tmp, "Caddyfile"), "--adapter", "caddyfile"], {
    stdio: "ignore",
  });
  const pivot = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("PIVOT-EXPOSE-9050");
  });
  pivot.listen(PIVOT, "127.0.0.1");

  try {
    // Caddyfile de test : les ports passerelle/interface des lanceurs, les
    // upstreams restent figés sur 3003/3004 (le but même du correctif).
    const tpl = await (await fetch(new URL("../Caddyfile", import.meta.url))).text();
    if (!tpl.includes("http://127.0.0.1:81")) throw new Error("Caddyfile : motif du lanceur introuvable");
    rmSync(join(tmp, "Caddyfile"), { force: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(tmp, "Caddyfile"),
      tpl.replace("http://127.0.0.1:81 {", `http://127.0.0.1:${GW} {`).replace("localhost:3000", "localhost:3900"),
    );

    if (!(await waitHttp(`http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling`)))
      throw new Error("mini-service injoignable sur 3003");
    if (!(await waitHttp(`http://127.0.0.1:${GW}/`))) throw new Error("passerelle Caddy injoignable");
    console.log("• pile prête (service 3003/3004, passerelle " + GW + ", pivot " + PIVOT + ")");

    console.log("[1-2] relais vers les DEUX ports du service");
    const hs = await fetch(`http://127.0.0.1:${GW}/socket.io/?EIO=4&transport=polling&XTransformPort=3003`);
    check("socket.io via passerelle → handshake OK", hs.status === 200 && (await hs.text()).includes("sid"));
    const diag = await fetch(`http://127.0.0.1:${GW}/diagnostics?XTransformPort=3004`);
    check("/diagnostics via passerelle → 200", diag.status === 200, `statut ${diag.status}`);

    console.log("[3-4] relay arbitraire supprimé");
    const piv = await fetch(`http://127.0.0.1:${GW}/?XTransformPort=${PIVOT}`);
    check("pivot XTransformPort=9050 → PAS relayé", !(await piv.text()).includes("PIVOT-EXPOSE-9050"),
      `statut ${piv.status}`);
    const piv2 = await fetch(`http://127.0.0.1:${GW}/socket.io/?EIO=4&transport=polling&XTransformPort=${PIVOT}`);
    check("/socket.io/ avec XTransformPort=9050 → pas de handshake",
      !(piv2.status === 200 && (await piv2.text()).includes("sid")), `statut ${piv2.status}`);

    console.log("[5] handle par défaut = interface");
    const ui = await fetch(`http://127.0.0.1:${GW}/`);
    check("sans XTransformPort → interface (absente ici → 502)", ui.status !== 200, `statut ${ui.status}`);

    console.log("[6] bind boucle locale uniquement");
    // Une interface non-loopback : la connexion doit échouer (refus/timeout).
    let offLoopback = false;
    try {
      const ip = spawnSync("hostname", ["-I"]).stdout?.toString().trim().split(/\s+/)[0];
      if (ip) {
        await fetch(`http://${ip}:${GW}/`, { signal: AbortSignal.timeout(3000) });
        offLoopback = true; // réponse reçue : la passerelle fuit hors boucle
      } else {
        console.log("  (pas d'IP non-loopback détectable — vérification sautée)");
      }
    } catch {
      offLoopback = false;
    }
    check("passerelle injoignable hors boucle locale", !offLoopback);
  } finally {
    spawnSync("kill", [String(caddy.pid), String(svc.pid)]);
    pivot.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nPasserelle figée : 0 échec" : `\nPasserelle figée : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
