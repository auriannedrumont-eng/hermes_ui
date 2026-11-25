// QA DOM v3 — carte « Hermes » (agent-motor-card) après le découpage en
// trois sous-cartes feuilles (chantier UI 2026-11-25) : l'histoire complète
// rejouée dans la VRAIE pile (Caddy :81 → front dev :3000, service :3003)
// avec un moteur Hermes stubbé : faux binaire `hermes` (VERSION dans un
// dépôt git taggé), fausse release GitHub, fausse gateway sur 9120.
// Le harnais est celui de qa-v040-motor.ts (pile complète auto-portée) ;
// les attentes sont celles de la carte v3 actuelle (v0.5.1) : fil, notes de
// version bornées, « Deux façons de s'en sortir », message prêt à copier,
// fenêtre de confirmation 3 promesses, repli « autre poste », historique en
// <details>, mobile 375 px sans débordement.
// Les trois feuilles sont traversées : EnTete (pastille/fil/actions),
// Blocs (notes/problème/fil live), Replis (autre poste/historique/documents).
//
// Scénario gateway : le stub 9120 n'est PAS lancé au départ — la pré-sonde
// de agent:update-request refuse la mise à jour tant que Hermes « répond »
// (§9 (64)) ; la fausse gateway n'ouvre qu'AVANT le retour arrière, pour
// que son contrôle conclue « RETOUR OK ».
import { chromium } from "playwright";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
// Page chargée VIA CADDY (:81) comme dans qa-v040-motor : Next dev accepte
// la montée websocket /socket.io/ sans la relayer (rewrites HTTP seuls) —
// la socket de la page restait ouverte mais morte (jamais de handshake),
// l'application affichait « Reconnexion en cours ». Caddy reverse_proxy
// relaie les WS nativement — le vrai chemin de production.
const FRONT = "http://127.0.0.1:81";
const OUT = "/home/z/my-project/download/qa-motor-v3";

const qaDir = `/tmp/hermes-qa-motor-v3-${Date.now()}`;
mkdirSync(qaDir, { recursive: true });
mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// ── Stubs : dépôt git + binaire hermes + releases ──────────────────────────
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

// Fausse gateway (9120) — DÉMARRÉE PLUS TARD, juste avant le retour arrière
// : tant qu'elle écoute, la pré-sonde refuse la mise à jour (« Hermes est
// en marche », §9 (64)). Son arrêt/relance pilote le verdict du contrôle.
let gwSrv: ReturnType<typeof Bun.serve> | null = null;
const startGW = () => {
  if (gwSrv) return;
  gwSrv = Bun.serve({
    port: 9120,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/model/options")) return new Response("nf", { status: 404 });
      return new Response(
        JSON.stringify({ models: [{ id: "hermes-qa" }] }),
        { headers: { "content-type": "application/json" } }
      );
    },
  });
};
const stopGW = () => {
  try { gwSrv?.stop(true); } catch { /* déjà parti */ }
  gwSrv = null;
};

// ── Pile : service (env stubbé) + front dev + Caddy (:81) ─────────────────
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
const front = spawn("bun", ["dev"], {
  detached: true, // chef de groupe : le cleanup tue l'arbre (bun dev → next dev → next-server)
  cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"],
});
const caddy = spawn("caddy", ["run", "--config", "Caddyfile", "--adapter", "caddyfile"], {
  cwd: process.cwd(),
  stdio: ["ignore", "ignore", "inherit"],
});

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
  try { process.kill(-front.pid!, "SIGTERM"); } catch { /* groupe déjà parti */ }
  try { front.kill(); } catch { /* déjà parti */ }
  try { caddy.kill(); } catch { /* déjà parti */ }
  stopGW();
  relSrv.stop(true);
  rmSync(qaDir, { recursive: true, force: true });
}
process.on("exit", cleanup);

try {
  ok("service hermes-chat démarré (:3003)", await waitHttp("http://127.0.0.1:3003", 30_000));
  ok("front démarré (:3000)", await waitHttp("http://127.0.0.1:3000", 90_000));
  ok("passerelle Caddy (:81)", await waitHttp(FRONT, 20_000));

  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(FRONT, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(2500);

  // Ouvrir Paramètres → Système
  await page.locator('button[aria-label*="paramètres"i]').first().click();
  await page.waitForTimeout(900);
  await page.locator('button:has-text("Système")').first().click();
  await page.waitForTimeout(1800);

  // ── Sonde directe du service : l'état moteur vu PAR LE SERVICE ────────
  const { io: clientIo } = await import("socket.io-client");
  const probe = clientIo("http://127.0.0.1:3003", { transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    probe.on("connect", () => void resolve());
    probe.on("connect_error", (e: Error) => void reject(e));
    setTimeout(() => void reject(new Error("sonde : timeout connexion")), 15_000);
  });
  const etatService = await new Promise<any>((resolve) => {
    probe.emit("agent:motor-state", (res: any) => void resolve(res));
    setTimeout(() => void resolve({ TIMEOUT: true }), 10_000);
  });
  probe.close();
  ok(
    "sonde service — agent installé 0.9.0 vu par le service",
    etatService?.installed === "0.9.0",
    JSON.stringify({ installed: etatService?.installed, tag: etatService?.release?.tag, agentDir: etatService?.agentDir, error: etatService?.error })
  );
  ok(
    "sonde service — release v0.10.0 (stub)",
    etatService?.release?.tag === "0.10.0"
  );

  // ── (1) État « mise à jour disponible » : feuille EnTete + Blocs ──────
  let body = await page.locator("body").innerText();
  ok("feuille EnTete — état « Mise à jour disponible »", body.includes("Mise à jour disponible"));
  ok("feuille EnTete — fil 0.9.0 → 0.10.0", body.includes("0.10.0") && body.includes("0.9.0"));
  ok("feuille EnTete — bouton « Mettre Hermes à jour »", (await page.locator('button:has-text("Mettre Hermes à jour")').count()) === 1);
  ok("feuille EnTete — bouton « Revérifier »", body.includes("Revérifier"));
  ok("feuille EnTete — fil « mise de côté » (retour arrière promis)", body.includes("mise de côté"));
  ok("feuille Blocs — marqueur « touche la liaison »", body.includes("touche la liaison avec l&apos;application") || body.includes("touche la liaison avec l'application"));
  ok("feuille Blocs — notes « Ce qui change dans Hermes 0.10.0 »", body.includes("Ce qui change dans Hermes 0.10.0"));
  ok("feuille Blocs — ligne de changelog affichée", body.includes("Renamed the gateway websocket protocol"));
  ok("feuille Blocs — lien GitHub de la release", body.includes("Voir sur GitHub"));
  ok("feuille Replis — repli « autre poste » fermé au repos", body.includes("Hermes est installé sur un autre poste") && !body.includes("Le relier à cette application"));
  ok("feuille Replis — historique présent (fermé)", body.includes("Historique · "));
  ok("feuille Replis — lien documents générés", body.includes("Documents générés par Hermes"));
  await page.screenshot({ path: `${OUT}/1-disponible.png`, fullPage: false });

  // ── (2) Repli « autre poste » : la feuille Replis déplie son formulaire
  await page.locator('button:has-text("Hermes est installé sur un autre poste")').first().click();
  await page.waitForTimeout(400);
  body = await page.locator("body").innerText();
  ok("repli déplié — « Le relier à cette application »", body.includes("Le relier à cette application"));
  ok("repli — champ « Adresse du moteur »", body.includes("Adresse du moteur"));
  ok("repli — champ « Code d'accès »", body.includes("Code d'accès"));
  ok("repli — bouton relié à gateway:set (présent, muet sans adresse)", body.includes("Relier cette gateway"));
  await page.screenshot({ path: `${OUT}/2-autre-poste.png`, fullPage: false });
  await page.locator('button:has-text("Hermes est installé sur un autre poste")').first().click();

  // ── (3) Mise à jour → fil live (feuille Blocs) → contrôle en échec ────
  // Pas de gateway 9120 à ce stade : la pré-sonde laisse passer, et le
  // contrôle post-maj échoue naturellement (« la gateway ne répond pas »).
  await page.locator('button:has-text("Mettre Hermes à jour")').first().click();
  // La ligne de verdict est TRADUITE dans le fil (traduireLigneMotor) :
  // « MOTEUR MAJ OK — … » s'affiche « Hermes a installé la nouvelle version… ».
  await page.waitForFunction(
    () => document.body.innerText.includes("Hermes a installé la nouvelle version"),
    { timeout: 30_000 }
  );
  body = await page.locator("body").innerText();
  ok("fil live — jalons de la mise à jour affichés", body.includes("Demande envoyée") && body.includes("Sauvegarde"));
  ok("fil live — déroulé du stub visible", body.includes("sauvegarde complete avant mise a jour"));
  ok("fil live — verdict « Hermes a installé la nouvelle version »", body.includes("Hermes a installé la nouvelle version"));
  await page.screenshot({ path: `${OUT}/3-maj-ok.png`, fullPage: false });

  // Le contrôle retente 4 fois (≈ 15 s) avant de conclure à l'échec.
  await page.waitForFunction(
    () => document.body.innerText.includes("Hermes ne répond plus"),
    { timeout: 60_000 }
  );
  await page.waitForTimeout(600);
  body = await page.locator("body").innerText();
  ok("feuille EnTete — problème détecté après contrôle en échec", body.includes("Hermes ne répond plus"));
  ok(
    "feuille EnTete — retour arrière proposé",
    (await page.locator('button:has-text("Revenir à la version d\'avant")').count()) === 1
  );
  ok("feuille Blocs — « Deux façons de s'en sortir »", body.includes("Deux façons de s'en sortir"));
  ok("feuille Blocs — filet « La plus simple d'abord »", body.includes("La plus simple d'abord"));
  await page.screenshot({ path: `${OUT}/4-probleme.png`, fullPage: false });

  // ── (4) Message à transmettre (feuille Blocs) ─────────────────────────
  await page.locator('button:has-text("préparer un message prêt à copier")').first().click();
  await page.waitForTimeout(400);
  body = await page.locator("body").innerText();
  ok("message à transmettre déplié", body.includes("Message préparé pour la personne"));
  ok("le message porte la version lue et le détail", body.includes("moteur Hermes : 0.10.0"));
  ok("bouton Copier le message", (await page.locator('button:has-text("Copier le message")').count()) === 1);
  await page.screenshot({ path: `${OUT}/5-message.png`, fullPage: false });

  // ── (5) Fenêtre de confirmation du retour arrière (orchestrateur) ─────
  await page.locator('button:has-text("Revenir à la version d\'avant")').first().click();
  await page.waitForTimeout(400);
  // Radix AlertDialog : role="alertdialog" (le volet Paramètres, lui, est
  // un [role="dialog"] — le cibler ramenait le titre « Paramètres »).
  const dialog = page.locator('[role="alertdialog"]');
  const dialogText = (await dialog.count()) >= 1 ? await dialog.first().innerText() : "";
  ok("fenêtre : titre « Revenir à Hermes 0.9.0 »", dialogText.includes("Revenir à Hermes") && dialogText.includes("0.9.0"), dialogText.slice(0, 40));
  body = await page.locator("body").innerText();
  ok("fenêtre : promesse fichiers intacts", body.includes("ne sont pas touchés"));
  ok("fenêtre : boutons Annuler + Oui", body.includes("Annuler") && body.includes("Oui, revenir à Hermes 0.9.0"));
  await page.screenshot({ path: `${OUT}/6-confirmation.png`, fullPage: false });

  // ── (6) Retour arrière confirmé (gateway réparée) → tout revient vert ─
  startGW();
  await page.locator('button:has-text("Oui, revenir à Hermes 0.9.0")').first().click();
  // Verdict traduit : « RETOUR OK — … » s'affiche « Le retour arrière est terminé… ».
  await page.waitForFunction(
    () => document.body.innerText.includes("Le retour arrière est terminé"),
    { timeout: 40_000 }
  );
  await page.waitForTimeout(800);
  body = await page.locator("body").innerText();
  ok("retour arrière terminé (fil « Le retour arrière est terminé »)", body.includes("Le retour arrière est terminé"));
  ok("feuille Blocs — « l'historique ci-dessous garde la trace » (verdict frais)", body.includes("l'historique ci-dessous garde la trace complète") || body.includes("l&apos;historique ci-dessous garde la trace complète"));
  ok("moteur revenu à 0.9.0", body.includes("0.9.0"));

  // Historique : <details> fermé → ouvrir le summary avant de lire.
  await page.locator('summary:has-text("Historique")').first().click();
  await page.waitForTimeout(400);
  body = await page.locator("body").innerText();
  ok("feuille Replis — historique rempli (maj, contrôle, retour)", body.includes("Mise à jour du moteur Hermes") && body.includes("Contrôle automatique") && body.includes("Retour arrière"));
  await page.screenshot({ path: `${OUT}/7-retour-ok-historique.png`, fullPage: false });

  // ── (7) Mobile 375 px : rien ne déborde ───────────────────────────────
  await page.setViewportSize({ width: 375, height: 720 });
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(
    () => document.scrollingElement!.scrollWidth > document.documentElement.clientWidth
  );
  ok("mobile 375 px : aucun débordement horizontal", !overflow);
  await page.screenshot({ path: `${OUT}/8-mobile.png`, fullPage: false });

  await browser.close();
} catch (err) {
  failures++;
  console.error("échec inattendu de la QA :", err);
} finally {
  cleanup();
}

console.log(`\nQA carte v3 (3 feuilles) : ${failures === 0 ? "TOUT VERT" : failures + " échec(s)"}`);
process.exit(failures === 0 ? 0 : 1);
