// QA visuelle v0.4.0 — carte « Moteur Hermes » : l'histoire complète de la
// maquette validée, rejouée dans la VRAIE pile (front :81 via Caddy, service
// :3003) avec un moteur Hermes stubbé : faux binaire `hermes` (VERSION dans
// un dépôt git taggé), fausse release GitHub, fausse gateway sur 9120 dont
// le comportement bascule par fichier (ok / fail).
// Étapes : (1) dispo + changelog + marqueur ; (2) mise à jour puis contrôle
// en échec → problème détecté + filet ; (3) message à transmettre ;
// (4) fenêtre de confirmation ; (5) retour arrière confirmé → tout vert ;
// (6) mobile 375 px sans débordement.
import { chromium } from "playwright";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const FRONT = "http://127.0.0.1:81";
const OUT = "/home/z/my-project/download";

const qaDir = `/tmp/hermes-qa-v040-${Date.now()}`;
mkdirSync(qaDir, { recursive: true });
let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// ── Stubs : dépôt git + binaire hermes + releases + gateway pilotée ────────
const agentDir = join(qaDir, "agent");
mkdirSync(agentDir, { recursive: true });
const git = (args: string[]) => spawnSync("git", ["-C", agentDir, ...args], { encoding: "utf8" });
git(["init", "-q"]);
git(["config", "user.email", "qa@local"]);
git(["config", "user.name", "qa"]);
writeFileSync(join(agentDir, "VERSION"), "0.9.0\n");
git(["add", "-A"]); git(["commit", "-qm", "v0.9.0"]); git(["tag", "v0.9.0"]);
writeFileSync(join(agentDir, "VERSION"), "0.10.0\n");
git(["add", "-A"]); git(["commit", "-qm", "v0.10.0"]); git(["tag", "v0.10.0"]);
git(["checkout", "-q", "v0.9.0"]);

const bin = join(qaDir, "hermes-stub.sh");
writeFileSync(
  bin,
  [
    "#!/bin/sh",
    `DIR="${agentDir}"`,
    'case "$1" in',
    '  --version) cat "$DIR/VERSION" ;;',
    "  update)",
    '    echo "stub: sauvegarde complete avant mise a jour"',
    '    git -C "$DIR" checkout -q v0.10.0',
    '    echo "stub: nouvelle version 0.10.0 installee" ;;',
    "  gateway) echo \"stub: gateway $2\" ;;",
    "esac",
  ].join("\n"),
  "utf-8"
);
chmodSync(bin, 0o755);

const relSrv = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/latest") return new Response("not found", { status: 404 });
    return new Response(
      JSON.stringify({
        tag_name: "v0.10.0",
        name: "Hermes 0.10.0",
        body:
          "## What's new\n- Renamed the gateway websocket protocol\n" +
          "- Faster startup\n- Small fixes",
        html_url: "https://github.com/NousResearch/hermes-agent/releases/v0.10.0",
        published_at: new Date().toISOString(),
      }),
      { headers: { "content-type": "application/json" } }
    );
  },
});

// Gateway stub sur le port PAR DÉFAUT du connecteur (9120) : le mode (ok /
// fail) est lu dans un fichier à chaque requête — le scénario le bascule.
const modeFile = join(qaDir, "gw-mode");
writeFileSync(modeFile, "ok");
const gwSrv = Bun.serve({
  port: 9120,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/model/options")) return new Response("nf", { status: 404 });
    const { readFileSync: rd } = await import("node:fs");
    const mode = rd(modeFile, "utf-8").trim();
    if (mode !== "ok") return new Response("boom", { status: 500 });
    return new Response(
      JSON.stringify({ models: [{ id: "hermes-qa" }] }),
      { headers: { "content-type": "application/json" } }
    );
  },
});
const gwMode = (m: "ok" | "fail") => writeFileSync(modeFile, m);

// ── Pile : service (env stubbé) + front dev — via Caddy :81 ───────────────
const service = spawn("bun", ["run", "mini-services/hermes-chat/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HERMES_AGENT_BIN: bin,
    HERMES_AGENT_DIR: agentDir,
    HERMES_AGENT_RELEASES_URL: `http://127.0.0.1:${relSrv.port}/latest`,
    HERMES_CHAT_DB: join(qaDir, "qa.sqlite"),
    HERMES_MOTOR_LOG: join(qaDir, "motor.log"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const front = spawn("bun", ["dev"], { cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] });

async function waitHttp(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status > 0) return true;
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
  relSrv.stop(true);
  gwSrv.stop(true);
  rmSync(qaDir, { recursive: true, force: true });
}
process.on("exit", cleanup);

try {
  ok("service hermes-chat démarré (:3003)", await waitHttp("http://127.0.0.1:3003", 30_000));
  ok("front démarré (:3000)", await waitHttp("http://127.0.0.1:3000", 60_000));
  ok("passerelle Caddy (:81)", await waitHttp(FRONT, 15_000));

  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(FRONT, { waitUntil: "networkidle", timeout: 45_000 });
  await page.waitForTimeout(2500);

  // Ouvrir Paramètres → Système
  await page.locator('button[aria-label*="paramètres"i]').first().click();
  await page.waitForTimeout(900);
  await page.locator('button:has-text("Système")').first().click();
  await page.waitForTimeout(1800);

  // (1) État « mise à jour disponible » : changelog + marqueur + filet.
  let body = await page.locator("body").innerText();
  ok("carte Moteur Hermes présente", body.includes("Moteur Hermes"));
  ok("état « Mise à jour disponible »", body.includes("Mise à jour disponible"));
  ok("versions v0.9.0 → v0.10.0 affichées", body.includes("v0.9.0") && body.includes("v0.10.0"));
  ok("marqueur « touche des éléments utilisés par l'interface »", body.includes("touche des éléments utilisés par l'interface"));
  ok("changelog de la release affiché", body.includes("Renamed the gateway websocket protocol"));
  ok("filet de sécurité présent", body.includes("Filet de sécurité"));
  ok("carnet de bord présent", body.includes("Carnet de bord"));
  await page.screenshot({ path: `${OUT}/v0.4.0-1-moteur-dispo.png`, fullPage: false });

  // (2) Mise à jour, puis contrôle en échec → problème détecté.
  gwMode("fail");
  await page.locator('button:has-text("Mettre Hermes à jour")').first().click();
  await page.waitForFunction(
    () => document.body.innerText.includes("MOTEUR MAJ OK"),
    { timeout: 30_000 }
  );
  // Le contrôle retente 4 fois (≈ 15 s) avant de conclure à l'échec.
  await page.waitForFunction(
    () => document.body.innerText.includes("Problème détecté"),
    { timeout: 45_000 }
  );
  await page.waitForTimeout(600);
  body = await page.locator("body").innerText();
  ok("problème détecté après contrôle en échec", body.includes("Problème détecté"));
  ok("retour arrière proposé (v0.9.0)", body.includes("Revenir à Hermes v0.9.0"));
  ok("filet « prêt » avec version précédente", body.includes("v0.9.0"));
  await page.screenshot({ path: `${OUT}/v0.4.0-2-probleme.png`, fullPage: false });

  // (3) Message à transmettre.
  await page.locator('button:has-text("Voir le message à transmettre")').first().click();
  await page.waitForTimeout(400);
  body = await page.locator("body").innerText();
  ok("message à transmettre déplié", body.includes("Message préparé pour la personne"));
  ok("bouton Copier le message", (await page.locator('button:has-text("Copier le message")').count()) === 1);
  await page.screenshot({ path: `${OUT}/v0.4.0-3-message.png`, fullPage: false });

  // (4) Fenêtre de confirmation du retour arrière.
  await page.locator('button:has-text("Revenir à Hermes v0.9.0")').first().click();
  await page.waitForTimeout(400);
  body = await page.locator("body").innerText();
  const dialog = page.locator('[role="dialog"][aria-label="Confirmer le retour arrière"]');
  const dialogText = (await dialog.count()) === 1 ? await dialog.innerText() : "";
  ok(
    "fenêtre : titre « Revenir à Hermes v0.9.0 »",
    dialogText.includes("Revenir à Hermes") && dialogText.includes("v0.9.0"),
    dialogText.slice(0, 40)
  );
  ok("fenêtre : promesse fichiers intacts", body.includes("ne sont pas touchés"));
  ok("fenêtre : note méthode officielle", body.includes("procédure officielle de Hermes"));
  ok("fenêtre : boutons Annuler + Oui", body.includes("Annuler") && body.includes("Oui, revenir à Hermes v0.9.0"));
  await page.screenshot({ path: `${OUT}/v0.4.0-4-confirmation.png`, fullPage: false });

  // (5) Retour arrière confirmé (gateway réparée) → tout revient au vert.
  gwMode("ok");
  await page.locator('button:has-text("Oui, revenir à Hermes v0.9.0")').first().click();
  await page.waitForFunction(
    () => document.body.innerText.includes("RETOUR OK"),
    { timeout: 40_000 }
  );
  await page.waitForTimeout(800);
  body = await page.locator("body").innerText();
  ok("retour arrière terminé", body.includes("RETOUR OK"));
  ok("moteur revenu à v0.9.0", body.includes("v0.9.0"));
  ok("filet consommé (plus de précédente en mémoire)", !body.includes("Revenir à Hermes v0.9.0"));
  ok("carnet rempli (maj, contrôle, retour)", body.includes("Mise à jour du moteur Hermes") && body.includes("Contrôle automatique") && body.includes("Retour arrière"));
  await page.screenshot({ path: `${OUT}/v0.4.0-5-retour-ok.png`, fullPage: false });

  // (6) Mobile 375 px : rien ne déborde.
  await page.setViewportSize({ width: 375, height: 720 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(
    () => document.scrollingElement!.scrollWidth > document.documentElement.clientWidth
  );
  ok("mobile 375 px : aucun débordement horizontal", !overflow);
  await page.screenshot({ path: `${OUT}/v0.4.0-6-mobile.png`, fullPage: false });

  await browser.close();
} catch (err) {
  failures++;
  console.error("échec inattendu de la QA :", err);
} finally {
  cleanup();
}

console.log(`\nQA v0.4.0 : ${failures === 0 ? "TOUT VERT" : failures + " échec(s)"}`);
process.exit(failures === 0 ? 0 : 1);
