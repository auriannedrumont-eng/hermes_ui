// QA DOM dédiée de StorageSection — chantier CRAP vague 7 UI (2026-11-24).
// Le composant StorageSection (CC 105) a été démonté en 5 feuilles VERBATIM
// (docs/crap-2026-11/scripts/extract_storage_leaves.py) : cette QA verrouille
// la structure et les comportements visibles — mêmes nœuds, mêmes libellés,
// mêmes interactions (bandeau compteurs, barre de filtres, bandeau de
// résultats, inventaire vide, effacement des filtres, mobile 375 px) — sur la
// VRAIE pile (Caddy :81 → front dev :3000, service :3003, base SQLite
// jetable), cf. qa-composer-dom.ts pour la recette : Next dev n'accepte pas
// la montée websocket /socket.io/, les QA passent par Caddy.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const FRONT = "http://127.0.0.1:81";

const qaDir = join(tmpdir(), `hermes-qa-storage-${Date.now()}`);
mkdirSync(qaDir, { recursive: true });

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// ── Pile auto-portée : service (base jetable) + front dev + passerelle ────
const serviceLog = openSync(join(qaDir, "service.log"), "a");
const frontLog = openSync(join(qaDir, "front.log"), "a");
const service = spawn("bun", ["run", "mini-services/hermes-chat/index.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, HERMES_CHAT_DB: join(qaDir, "qa.sqlite") },
  stdio: ["ignore", serviceLog, serviceLog],
});
const front = spawn("bun", ["dev"], {
  cwd: process.cwd(),
  stdio: ["ignore", frontLog, frontLog],
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
  try { front.kill(); } catch { /* déjà parti */ }
  rmSync(qaDir, { recursive: true, force: true });
}
process.on("exit", cleanup);

try {
  ok("service hermes-chat démarré (:3003)", await waitHttp("http://127.0.0.1:3003", 30_000));
  ok("front démarré (:3000)", await waitHttp("http://127.0.0.1:3000", 90_000));
  ok("passerelle Caddy (:81)", await waitHttp(FRONT, 20_000));

  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  // Ouvrir Paramètres → Stockage (la page vit dans le volet, rail de sections)
  await page.locator('button[aria-label*="paramètres"i]').first().click();
  await page.waitForTimeout(900);
  await page.locator('button:has-text("Stockage")').first().click();
  await page.waitForTimeout(2000);

  // ── Feuille Compteurs + en-tête de page ─────────────────────────────────
  const pane = page.locator('section[aria-label="Stockage des documents générés"]');
  ok("section Stockage rendue (aria-label intact)", (await pane.count()) === 1);
  ok("titre h1 « Stockage »", (await pane.locator("h1").innerText()) === "Stockage");
  const corps = await page.locator("body").innerText();
  ok(
    "bandeau compteurs présent (feuille Compteurs)",
    corps.includes("Documents générés"),
  );
  ok(
    "rappel undo 7 s (freedTotal à zéro, feuille Compteurs)",
    corps.includes("Le nettoyage s'applique projet par projet"),
  );

  // ── Feuille BarreFiltres : recherche, tri, chips de type ────────────────
  const recherche = pane.locator('input[aria-label="Rechercher un fichier par nom"]');
  ok("champ de recherche présent (feuille BarreFiltres)", (await recherche.count()) === 1);
  ok(
    "placeholder intact",
    ((await recherche.getAttribute("placeholder")) ?? "").includes("Rechercher un fichier…"),
  );
  const tri = pane.locator('select[aria-label="Trier les versions"]');
  ok("select de tri présent (feuille BarreFiltres)", (await tri.count()) === 1);
  ok(
    "les trois tris sont proposés",
    (await tri.locator("option").count()) === 3,
    `${await tri.locator("option").count()} options`,
  );
  const groupeTypes = pane.locator('div[role="group"][aria-label="Filtrer par type"]');
  ok("groupe de chips de type présent", (await groupeTypes.count()) === 1);
  ok(
    "chip « Tous » pressée au repos",
    (await groupeTypes.locator('button[aria-pressed="true"]').innerText()) === "Tous",
  );

  // ── Inventaire vide (base jetable : aucun document) ─────────────────────
  ok(
    "message d'inventaire vide honnête",
    corps.includes("Aucun document généré pour l"),
    "",
  );
  ok(
    "aucun groupe projet rendu à vide",
    (await pane.locator('section[aria-label^="Projet "]').count()) === 0,
  );

  // ── Filtrage : bandeau de résultats (feuille Bandeau) + effacement ──────
  await recherche.fill("qa-inexistant");
  await page.waitForTimeout(600);
  ok(
    "bandeau « Aucun fichier ne correspond » pendant le filtrage",
    (await pane.locator("text=Aucun fichier ne correspond").count()) === 1,
  );
  const effacer = pane.locator('button:has-text("effacer les filtres")');
  ok("bouton « effacer les filtres » présent (feuille Bandeau)", (await effacer.count()) === 1);
  await effacer.click();
  await page.waitForTimeout(600);
  ok(
    "effacement remet le champ à vide (finFiltrage au parent)",
    (await recherche.inputValue()) === "",
  );
  ok(
    "bandeau retiré après effacement",
    (await pane.locator("text=Aucun fichier ne correspond").count()) === 0,
  );

  // ── Mobile 375×667 : aucun débordement horizontal (le volet Paramètres
  //    n'est pas ouvert sur mobile : l'engrenage vit dans la sidebar,
  //    absente de ce viewport — même recette que qa-composer-dom.ts) ──────
  const mobile = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await mobile.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await mobile.waitForTimeout(4000);
  const over = await mobile.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    inner: window.innerWidth,
  }));
  ok("mobile 375 px sans débordement horizontal", over.scroll <= over.inner, `${over.scroll}px > ${over.inner}px ?`);
  ok(
    "mobile : la page d'accueil rend sans la section Stockage",
    (await mobile.locator('section[aria-label="Stockage des documents générés"]').count()) === 0,
  );

  await browser.close();
} catch (e) {
  failures++;
  console.log("ÉCHEC harnais :", String(e).slice(0, 300));
} finally {
  cleanup();
  console.log(failures === 0 ? "\nQA Storage DOM : TOUT VERT" : `\nQA Storage DOM : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
