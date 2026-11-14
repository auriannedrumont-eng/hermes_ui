// Diagnostic de la garde « un seul onglet » (2026-11-15) : une seule page,
// état brut + erreurs console — pour comprendre pourquoi le rôle n'est pas
// posé (QA test-single-tab.ts en échec au premier contrôle).
import { chromium } from "playwright";

const BASE = process.env.HERMES_TAB_BASE ?? "http://localhost:3000";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${String(e).slice(0, 300)}`));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForTimeout(4000);
  const state = await page.evaluate(() => ({
    role: (window as any).__hermesTabRole ?? null,
    reloadCount: (window as any).__hermesReloadCount ?? null,
    beat: localStorage.getItem("hermes.single.tab"),
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    title: document.title,
    bodyStart: document.body.innerText.slice(0, 200),
    rootChildren: document.body.children.length,
  }));
  console.log("STATE", JSON.stringify(state, null, 2));
  console.log("ERRORS", JSON.stringify(errors.slice(0, 10), null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
