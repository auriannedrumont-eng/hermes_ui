// Diagnostic F-14 : pourquoi le sélecteur n'apparaît pas après régénération.
import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  await page.goto("http://127.0.0.1:81/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => {
      const el = document.querySelector("textarea");
      return el && !el.hasAttribute("disabled");
    },
    undefined,
    { timeout: 20000 }
  );

  await page.fill("textarea", "Réponds en une phrase : capitale du Portugal ?");
  await page.keyboard.press("Enter");
  // Attend la fin du tour : plus de statut « réfléchit »
  await page.waitForFunction(
    () => !document.body.textContent?.includes("Hermes réfléchit"),
    undefined,
    { timeout: 90000 }
  );
  await page.waitForTimeout(800);

  // Cherche TOUS les boutons régénérer et leurs attributs
  const regenInfo = await page.evaluate(() => {
    const out: Array<Record<string, string | null>> = [];
    for (const b of Array.from(document.querySelectorAll("button"))) {
      const hay = ((b.textContent ?? "") + (b.getAttribute("aria-label") ?? "") + (b.title ?? "")).toLowerCase();
      if (hay.includes("régén")) {
        out.push({
          text: (b.textContent ?? "").trim().slice(0, 30) || null,
          aria: b.getAttribute("aria-label"),
          title: b.title || null,
        });
      }
    }
    return out;
  });
  console.log("boutons régénérer:", JSON.stringify(regenInfo));

  await page.screenshot({ path: "/tmp/qa-hermes/diag-1-apres-tour.png" });

  // Clic par aria-label précis si présent, sinon texte
  const target = page.locator('button[aria-label="Régénérer"]').last();
  if ((await target.count()) === 0) await page.locator('button:has-text("Régénérer")').last().click();
  else await target.click({ force: true });
  console.log("clic régénérer effectué");

  // Attend la fin du nouveau tour (retour au calme)
  await page.waitForFunction(
    () => !document.body.textContent?.includes("Hermes réfléchit"),
    undefined,
    { timeout: 120000 }
  );
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "/tmp/qa-hermes/diag-2-apres-regen.png" });

  const state = await page.evaluate(() => ({
    hasRatio: document.body.textContent?.includes("/2") ?? false,
    prevBtns: document.querySelectorAll('button[aria-label="Version précédente"]').length,
    errorRow: document.body.textContent?.includes("Réessayer") ?? false,
    logTail: (document.querySelector('[role="log"]')?.textContent ?? "").slice(-200),
  }));
  console.log("état:", JSON.stringify(state, null, 1));
  console.log("erreurs console:", consoleErrors.slice(0, 5));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
