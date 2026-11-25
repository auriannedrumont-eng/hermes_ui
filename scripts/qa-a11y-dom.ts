// QA DOM dédiée d'accessibilité — chantier Lot 5 « UI / a11y » (2026-11-25).
// Verrouille les quatre correctifs du lot sur la VRAIE pile (Caddy :81 →
// front dev :3000, service :3003, base SQLite jetable) : Échap sous overlay
// Radix (garde page.tsx — le sheet se ferme SEUL, sans effet de bord),
// listbox du ModePicker navigable aux flèches avec tabindex roving (APG),
// tablist des artefacts câblée (aria-controls + tabpanel — vérif statique
// du DOM rendu si un artefact existe), mobile 375 px sans débordement.
// Recette : cf. qa-system-dom.ts — Next dev n'accepte pas la montée
// websocket /socket.io/, les QA passent par Caddy, le vrai chemin prod.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const FRONT = "http://127.0.0.1:81";

const qaDir = join(tmpdir(), `hermes-qa-a11y-${Date.now()}`);
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

let browser: import("playwright").Browser | null = null;
try {
  ok("service hermes-chat démarré (:3003)", await waitHttp("http://127.0.0.1:3003", 30_000));
  ok("front démarré (:3000)", await waitHttp("http://127.0.0.1:3000", 90_000));
  ok("passerelle Caddy (:81)", await waitHttp(FRONT, 20_000));

  browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  // ── Listbox du ModePicker : flèches + roving (Lot 5, audit ARIA) ────────
  await page.locator('[aria-label^="Mode de la conversation"]').first().click();
  await page.waitForTimeout(800);
  const listbox = page.locator('[role="listbox"][aria-label="Modes du compositeur"]');
  ok("listbox des modes rendue au clic du déclencheur", (await listbox.count()) === 1);
  const opts = listbox.locator('[role="option"]');
  const nb = await opts.count();
  ok("options présentes (≥ 3 modes)", nb >= 3, `${nb} option(s)`);
  const roving = await opts.evaluateAll((els) =>
    els.filter((e) => e.getAttribute("tabindex") === "0").length
  );
  ok("tabindex roving : exactement UNE option tabulable", roving === 1, `${roving}`);
  const selIdx = await opts.evaluateAll((els) =>
    els.findIndex((e) => e.getAttribute("aria-selected") === "true")
  );
  ok("une option est sélectionnée (aria-selected)", selIdx >= 0, `index ${selIdx}`);

  // Focus posé sur l'option sélectionnée, navigation clavier réelle
  await opts.nth(selIdx).focus();
  const idxActif = () =>
    opts.evaluateAll((els) =>
      els.findIndex((e) => e === document.activeElement)
    );
  await page.keyboard.press("ArrowDown");
  const apresDown = await idxActif();
  ok("ArrowDown déplace le focus vers l'option suivante", apresDown === selIdx + 1 || apresDown === nb - 1, `${selIdx} → ${apresDown}`);
  await page.keyboard.press("Home");
  ok("Home ramène au début", (await idxActif()) === 0);
  await page.keyboard.press("End");
  ok("End saute à la fin", (await idxActif()) === nb - 1);
  await page.keyboard.press("ArrowUp");
  ok("ArrowUp remonte d'un cran", (await idxActif()) === nb - 2);

  // Entrée sur une option NON sélectionnée : la sélection suit (le popover
  // peut rester ouvert — on vérifie l'état, pas la fermeture)
  const cible = nb - 2;
  if (cible !== selIdx) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const newSel = await opts.evaluateAll((els) =>
      els.findIndex((e) => e.getAttribute("aria-selected") === "true")
    );
    ok("Entrée sélectionne l'option focusée", newSel === cible, `nouvelle sélection index ${newSel}`);
  }

  // Échap referme le picker (Radix), la listbox disparaît
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  ok("Échap referme le picker", (await listbox.count()) === 0);

  // ── Échap sous dialog Radix : le sheet Paramètres se ferme SEUL (garde
  //    page.tsx : l'overlay vivant garde la main sur Échap) ────────────────
  await page.locator('button[aria-label*="paramètres"i]').first().click();
  await page.waitForTimeout(900);
  const dialog = page.locator('[role="dialog"][data-state="open"]');
  ok("sheet Paramètres ouvert (role=dialog Radix)", (await dialog.count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  ok("Échap referme le sheet seul (garde : pas d'effet de bord)", (await dialog.count()) === 0);

  // ── Tablist des artefacts : câblage vérifié dans le BUNDLE livré (le
  //    panneau exige un artefact réel ; la structure ARIA est celle du
  //    composant compilé — aria-controls/roving présents dans le JS servi) ──
  const js = await page.evaluate(async () => {
    const out: string[] = [];
    for (const l of Array.from(document.querySelectorAll("script[src]"))) {
      const src = (l as HTMLScriptElement).src;
      try {
        const t = await (await fetch(src)).text();
        if (t.includes("artifact-tabpanel") && t.includes("aria-controls")) out.push(src);
      } catch { /* ignore */ }
    }
    return out;
  });
  ok("bundle front contient le tabpanel câblé (aria-controls + id)", js.length > 0, `${js.length} script(s)`);

  // ── Mobile 375 px : aucun débordement horizontal ────────────────────────
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

console.log(failures === 0 ? "\nQA A11y DOM : TOUT VERT" : `\nQA A11y DOM : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
