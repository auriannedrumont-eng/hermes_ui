// QA DOM dédiée de la passe design — tokens de statut (2026-11-25, §9 (16)).
// Preuve d'identité visuelle : pour chaque token statique, le computed style
// est comparé au computed style de la classe brute d'origine (même palette
// Tailwind au bit près) — clair ET sombre. Pour le domaine thémé (canon
// --success/--warning) : preuve que la MIGRATION a eu lieu (le computed ne
// vaut plus l'amber/emerald brut) et que la paire clair/sombre est vivante.
// KIND_TINT (palette catégorique assumée) : vérifié toujours présent.
// Recette : cf. qa-a11y-dom.ts — vraie pile, waitHttp accepte tout statut.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const FRONT = "http://127.0.0.1:81";

const qaDir = join(tmpdir(), `hermes-qa-design-${Date.now()}`);
mkdirSync(qaDir, { recursive: true });

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

const serviceLog = openSync(join(qaDir, "service.log"), "a");
const frontLog = openSync(join(qaDir, "front.log"), "a");
const service = spawn("bun", ["run", "mini-services/hermes-chat/index.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, HERMES_CHAT_DB: join(qaDir, "qa.sqlite") },
  stdio: ["ignore", serviceLog, serviceLog],
});
const front = spawn("bun", ["dev"], {
  detached: true,
  cwd: process.cwd(),
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
  try { process.kill(-front.pid!, "SIGTERM"); } catch { /* groupe déjà parti */ }
  try { front.kill(); } catch { /* déjà parti */ }
  rmSync(qaDir, { recursive: true, force: true });
}
process.on("exit", cleanup);

// lecture du computed style d'une classe Tailwind posée sur un span jetable
// (cmp est AUTO-CONTENUE : page.evaluate la sérialise, les fermetures Node
// ne voyagent pas dans le navigateur)
// NORMALISATION : un même colorant peut se sérialiser différemment selon la
// voie d'arrivée (lab() pour un token statique, rgba()/oklab pour la palette
// du thème) — on ré-injecte chaque valeur dans un style inline et on relit le
// computed : le CSSOM impose ALORS le même canon de sérialisation aux deux.
const cmp = ({ a, b, prop }: { a: string; b: string; prop: string }) => {
  const READ = (cls: string, p: string) => {
    const el = document.createElement("span");
    el.className = cls;
    document.body.appendChild(el);
    const v = getComputedStyle(el).getPropertyValue(p);
    el.remove();
    return v.trim();
  };
  const va = READ(a, prop), vb = READ(b, prop);
  if (va === "" || vb === "") return { eq: false, va, vb };
  // PIXELS : un même colorant arrive ici sous deux espaces (lab() pour le
  // token direct, oklab() via color-mix côté palette) — fillStyle préserve
  // l'espace d'entrée. Le critère honnête du « zéro delta » est le pixel
  // RENDU : on rasterise chaque valeur sur un canvas et on compare les
  // octets sRGB 8 bits de getImageData (prémultipliés, même chemin des
  // deux côtés).
  const PIX = (v: string) => {
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data).join(",");
  };
  const na = PIX(va), nb = PIX(vb);
  const invalide = na === "0,0,0,0" || nb === "0,0,0,0";
  return { eq: !invalide && na === nb, va: na, vb: nb };
};

let browser: import("playwright").Browser | null = null;
try {
  ok("service hermes-chat démarré (:3003)", await waitHttp("http://127.0.0.1:3003", 30_000));
  ok("front démarré (:3000)", await waitHttp("http://127.0.0.1:3000", 90_000));
  ok("passerelle Caddy (:81)", await waitHttp(FRONT, 20_000));

  browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  // FORCER le thème clair : la page peut charger en sombre (préférence
  // stockée next-themes) — le bloc .dark de globals.css écraserait alors
  // les valeurs « claires » attendues (constaté : --success sombre
  // oklch(0.765 0.13 163) → lab L 74.5, pris à tort pour la valeur claire).
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.waitForTimeout(200);

  // ── ZÉRO DELTA : tokens statiques == palette brute d'origine ────────────
  // (canvas sombres fixes du diff et du terminal — clair OU sombre)
  const zeroDelta: Array<[string, string, string]> = [
    ["text-success-bright", "text-emerald-400", "color"],
    ["text-success-soft", "text-emerald-200", "color"],
    ["text-danger-bright", "text-red-400", "color"],
    ["text-danger-soft", "text-red-200", "color"],
    ["bg-success-canvas", "bg-emerald-500", "background-color"],
    ["bg-danger", "bg-red-500", "background-color"],
    ["bg-success-canvas/10", "bg-emerald-500/10", "background-color"],
    ["bg-success-canvas/20", "bg-emerald-500/20", "background-color"],
    ["bg-danger/10", "bg-red-500/10", "background-color"],
    ["bg-danger/20", "bg-red-500/20", "background-color"],
  ];
  for (const [tok, brut, prop] of zeroDelta) {
    const r = await page.evaluate(cmp, { a: tok, b: brut, prop });
    ok(`zéro delta ${tok} == ${brut}`, r.eq, `${r.va} vs ${r.vb}`);
  }

  // ── CANON : le domaine thémé migre vers --success/--warning ─────────────
  // texte warning : résout la paire du thème (et n'est PLUS l'amber brut)
  const rWarn = await page.evaluate(cmp, { a: "text-warning", b: "text-amber-600", prop: "color" });
  ok("text-warning résout --warning (≠ amber-600 brut)", rWarn.va !== "" && rWarn.va !== rWarn.vb, `${rWarn.va} vs ${rWarn.vb}`);
  const rOk = await page.evaluate(cmp, { a: "text-success", b: "text-emerald-600", prop: "color" });
  ok("text-success résout --success (≠ emerald-600 brut)", rOk.va !== "" && rOk.va !== rOk.vb, `${rOk.va} vs ${rOk.vb}`);

  // ── Mode sombre : les statiques ne bougent pas, la paire suit ───────────
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForTimeout(150);
  const rBrightDark = await page.evaluate(cmp, { a: "text-success-bright", b: "text-emerald-400", prop: "color" });
  ok("sombre : token statique inchangé (canvas fixe)", rBrightDark.eq, `${rBrightDark.va}`);
  // la paire --success est vivante : en sombre elle CHANGE (et ne devient pas
  // la statique du canvas — chromas différents par design : 0.13 vs 0.177)
  const darkOk = await page.evaluate(cmp, { a: "text-success", b: "text-success-bright", prop: "color" });
  ok("sombre : --success suit sa paire (≠ sa valeur claire, ≠ la statique du canvas)",
    darkOk.va !== rOk.va && !darkOk.eq, `${rOk.va} → ${darkOk.va}`);
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  // ── KIND_TINT intact : la palette catégorique reste servie ──────────────
  const js = await page.evaluate(async () => {
    const out: string[] = [];
    for (const l of Array.from(document.querySelectorAll("script[src]"))) {
      const src = (l as HTMLScriptElement).src;
      try {
        const t = await (await fetch(src)).text();
        if (t.includes("bg-emerald-500/15") && t.includes("KIND_TINT")) out.push(src);
      } catch { /* ignore */ }
    }
    return out;
  });
  ok("KIND_TINT catégorique conservé dans le bundle servi", js.length > 0, `${js.length} script(s)`);

  // ── Mobile 375 px : aucun débordement (le bandeau migrated inclus) ──────
  const mob = await browser.newPage({ viewport: { width: 375, height: 700 } });
  await mob.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await mob.waitForTimeout(4000);
  const w = await mob.evaluate(() => document.documentElement.scrollWidth);
  ok("mobile 375 px sans débordement horizontal", w <= 375, `${w}px`);
  await mob.close();
} catch (e) {
  console.error("Erreur de la QA :", e);
  failures++;
} finally {
  await browser?.close().catch(() => {});
}

console.log(failures === 0 ? "\nQA Design DOM : TOUT VERT" : `\nQA Design DOM : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
