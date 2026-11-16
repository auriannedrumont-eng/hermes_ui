// QA layout — mesure le DOM réel de l'accueil et du volet Paramètres.
// Usage: bunx playwright test? Non : bun run scripts/qa-layout.ts [width] [height]
import { chromium } from "playwright";

const W = Number(process.argv[2] ?? 1280);
const H = Number(process.argv[3] ?? 1080);
const OUT = "/tmp/qa-hermes";

async function boxes(page, sels) {
  return page.evaluate((sels) => {
    const out = {};
    for (const [name, sel] of Object.entries(sels)) {
      const el = document.querySelector(sel);
      if (!el) { out[name] = null; continue; }
      const b = el.getBoundingClientRect();
      out[name] = { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) };
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dvhSupported: CSS.supports("height", "100dvh"),
      boxes: out,
    };
  }, sels);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto("http://127.0.0.1:3000/", { waitUntil: "networkidle" });
  await page.waitForSelector("text=Comment puis-je vous aider", { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/home-${W}x${H}.png` });

  const home = await boxes(page, {
    group: ".h-app-full",                 // wrapper racine pleine hauteur
    panelGroup: "[data-panel-group-id]",  // ResizablePanelGroup (style inline height:100%)
    sidebar: '[aria-label="Historique des conversations"]',
    composer: "textarea",
  });
  // carte de statut (contient « Moteur local ») cherchée par texte
  home.statusCard = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("*")).find(
      (e) => e.children.length === 0 && e.textContent?.includes("Moteur local"),
    );
    return el ? el.closest("div.border, section, footer, div")?.getBoundingClientRect().toJSON() ?? null : null;
  });
  console.log("=== ACCUEIL ===");
  console.log(JSON.stringify(home, null, 1));

  // Ouvre le volet Paramètres (engrenage de la carte de statut)
  await page.click('[aria-label="Ouvrir les paramètres"]');
  await page.waitForSelector('text=Le confort de cette interface', { timeout: 10000 });
  await page.waitForTimeout(600); // laisse finir l'animation d'entrée
  await page.screenshot({ path: `${OUT}/settings-${W}x${H}.png` });

  const settings = await page.evaluate(() => {
    const drawer = document.querySelector('[role="dialog"]');
    const r = {};
    r.drawer = drawer?.getBoundingClientRect().toJSON();
    const kids = drawer ? Array.from(drawer.children).map((k) => ({
      tag: k.tagName.toLowerCase(),
      cls: String(k.className).slice(0, 60),
      box: k.getBoundingClientRect().toJSON(),
    })) : [];
    r.children = kids;
    const title = Array.from(document.querySelectorAll("h2, h3, b")).find((e) => e.textContent?.trim() === "Interface");
    r.titleInterface = title?.getBoundingClientRect().toJSON();
    const close = document.querySelector('[aria-label="Fermer les paramètres"]');
    r.closeBtn = close?.getBoundingClientRect().toJSON();
    return r;
  });
  console.log("=== VOLET PARAMÈTRES ===");
  console.log(JSON.stringify(settings, null, 1));

  // Test viewport < 1100px aussi (rail horizontal attendu)
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(300);
  await page.click('[aria-label="Ouvrir les paramètres"]');
  await page.waitForSelector('text=Le confort de cette interface', { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/settings-900x800.png` });

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
