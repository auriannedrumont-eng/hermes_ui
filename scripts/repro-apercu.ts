// Repro « l'aperçu ne charge plus mes artefacts » — pile RÉELLE avec jetons
// (comme le lanceur desktop), semence qa-seed-view (Store DIRECT = artefact
// SANS miniature, l'état exact d'un rendu échoué/coincé/perdu), puis :
//  1. HTTP : /raw avec ?token= (200 — un iframe ne peut pas mettre de header),
//     /raw sans jeton (401), /view publique (200) — direct ET via Caddy :81.
//  2. Pré-condition : le PNG de miniature n'existe PAS sur disque.
//  3. Navigateur : ouverture de la conversation → AUTO-RÉPARATION (le service
//     re-rend l'aperçu manquant) → /thumb 200 capturé sur le réseau, le PNG
//     recréé sur disque, et la miniature visible dans le panneau.
import { chromium } from "playwright";
import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const FRONT = "http://127.0.0.1:81";
const TOKEN = "qa-jeton-apercu-42";
const THUMB_DIR = join(process.cwd(), "db", "artifacts");

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

const qaDir = join(tmpdir(), `hermes-repro-apercu-${Date.now()}`);
mkdirSync(qaDir, { recursive: true });
const envPile = {
  ...process.env,
  HERMES_CHAT_DB: join(qaDir, "qa.sqlite"),
  HERMES_SERVICE_TOKEN: TOKEN,
  NEXT_PUBLIC_SERVICE_TOKEN: TOKEN,
};

// 0. Caddy est-il vivant sur :81 ? Sinon on le démarre (config du dépôt).
let caddyProc: ReturnType<typeof spawn> | null = null;
try {
  execSync("ss -ltn | grep -q ':81 '");
} catch {
  const caddyLog = openSync(join(qaDir, "caddy.log"), "a");
  caddyProc = spawn("caddy", ["run", "--config", "Caddyfile"], {
    cwd: process.cwd(),
    stdio: ["ignore", caddyLog, caddyLog],
    detached: true,
  });
}

// 1. Semence (Store API direct — comme qa-seed-view ; PAS de rendu : la
// miniature n'existera pas, l'état « aperçu cassé » exact).
const seed = spawnSync("bun", ["scripts/qa-seed-view.ts"], {
  cwd: process.cwd(),
  env: { ...envPile, HERMES_SERVICE_TOKEN: "", NEXT_PUBLIC_SERVICE_TOKEN: "" },
  encoding: "utf-8",
});
const mSeed = /conversation=(\S+) artifact=(\S+)/.exec(seed.stdout ?? "");
const convId = mSeed?.[1] ?? "";
const artId = mSeed?.[2] ?? "";
ok("semence (conversation + artefact html)", Boolean(convId && artId), seed.stdout?.trim() ?? seed.stderr?.slice(0, 200));
const thumbAvant = join(THUMB_DIR, `${artId}.png`);
ok("pré-condition : miniature absente du disque (état cassé réel)", !existsSync(thumbAvant));

const serviceLog = openSync(join(qaDir, "service.log"), "a");
const frontLog = openSync(join(qaDir, "front.log"), "a");
const service = spawn("bun", ["run", "mini-services/hermes-chat/index.ts"], {
  cwd: process.cwd(),
  env: envPile,
  stdio: ["ignore", serviceLog, serviceLog],
});
const front = spawn("bun", ["dev"], {
  detached: true,
  cwd: process.cwd(),
  env: envPile,
  stdio: ["ignore", frontLog, frontLog],
});

async function waitHttp(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.status > 0) {
        await new Promise((r) => setTimeout(r, 700));
        return true;
      }
    } catch {
      /* pas encore */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function cleanup() {
  try { service.kill(); } catch { /* déjà parti */ }
  try { front.kill(); } catch { /* déjà parti */ }
  try { process.kill(-front.pid!, "SIGTERM"); } catch { /* groupe déjà parti */ }
  if (caddyProc) { try { process.kill(-caddyProc.pid!, "SIGTERM"); } catch { /* déjà parti */ } }
  rmSync(qaDir, { recursive: true, force: true });
}
process.on("exit", cleanup);

let browser: import("playwright").Browser | null = null;
try {
  ok("service :3003", await waitHttp("http://127.0.0.1:3003", 30_000));
  ok("front :3000", await waitHttp("http://127.0.0.1:3000", 90_000));
  ok("passerelle :81", await waitHttp(FRONT, 20_000));

  // ── 2. Contrôles HTTP directs (le chemin que fait l'iframe/<img>) ────────
  const direct = await fetch(`http://127.0.0.1:3004/artifacts/${artId}/raw?token=${TOKEN}`);
  ok(`/raw via :3004 avec ?token= seul (iframe sans header)`, direct.status === 200, `${direct.status}`);
  const viaCaddy = await fetch(`${FRONT}/artifacts/${artId}/raw?XTransformPort=3004&token=${TOKEN}`);
  ok(`/raw via Caddy :81 (XTransformPort + ?token=)`, viaCaddy.status === 200, `${viaCaddy.status}`);
  const sans = await fetch(`http://127.0.0.1:3004/artifacts/${artId}/raw`);
  ok(`/raw sans jeton → 401 attendu`, sans.status === 401, `${sans.status}`);
  const vue = await fetch(`${FRONT}/artifacts/${artId}/view?XTransformPort=3004`);
  ok(`/view publique via Caddy → 200`, vue.status === 200, `${vue.status}`);
  const corps = vue.status === 200 ? (await vue.text()).slice(0, 60) : "";
  ok(`/view sert le HTML semé`, corps.includes("<!doctype html>") || corps.includes("<!DOCTYPE html>"), corps);

  // ── 3. Navigateur : ouverture → AUTO-RÉPARATION → miniature visible ─────
  browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const reponses: Array<{ url: string; status: number }> = [];
  page.on("response", (r) => {
    if (r.url().includes("/artifacts/")) reponses.push({ url: r.url(), status: r.status() });
  });
  await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4500);

  // ouvrir la conversation semée dans la barre latérale
  const item = page.getByText("QA vue onglet + terminal").first();
  await item.click({ timeout: 15_000 });

  // AUTO-RÉPARATION : le service re-rend l'aperçu manquant → le PNG réapparaît
  let repare = false;
  for (let i = 0; i < 30 && !repare; i++) {
    await page.waitForTimeout(1000);
    repare = existsSync(thumbAvant);
  }
  ok("auto-réparation : PNG de miniature recréé sur disque", repare, thumbAvant);
  const thumbReq = reponses.find((r) => r.url.includes(`/artifacts/${artId}/thumb`));
  ok("le navigateur a chargé la miniature (réseau)", Boolean(thumbReq) && thumbReq!.status === 200,
    reponses.map((r) => `${r.status} ${r.url.slice(0, 90)}`).join(" | ") || "aucune requête /artifacts/");
  const vignette = page.locator(`img[src*="/artifacts/${artId}/thumb"]`).first();
  ok("miniature visible dans l'interface (carte/panneau)", await vignette.isVisible().catch(() => false));

  // le panneau : ouvrir la carte → l'onglet Aperçu affiche la vignette
  const carte = page.getByText("page-qa.html").first();
  await carte.click({ timeout: 15_000 });
  await page.waitForTimeout(2000);
  const apercu = page.locator(`img[src*="/artifacts/${artId}/thumb"]`).first();
  ok("panneau ouvert : Aperçu affiché (vignette rendue)", (await apercu.count()) > 0);
  const rawReq = reponses.find((r) => r.url.includes(`/artifacts/${artId}/raw`));
  ok("source chargée par le panneau (raw 200)", Boolean(rawReq) && rawReq!.status === 200, `${rawReq?.status ?? "aucune"}`);
} catch (e) {
  console.error("Erreur de la repro :", e);
  failures++;
} finally {
  await browser?.close().catch(() => {});
}

console.log(failures === 0 ? "\nREPRO : aperçu auto-réparé — TOUT VERT" : `\nREPRO : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
