// QA visuelle F-14 : envoi, régénération → sélecteur de versions ‹ 2/2 ›,
// clic ‹ → bascule 1/2, capture des deux états + mesures DOM.
import { chromium } from "playwright";

const OUT = "/tmp/qa-hermes";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("http://127.0.0.1:81/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => {
      const el = document.querySelector("textarea");
      return el && !el.hasAttribute("disabled");
    },
    { timeout: 20000 }
  );

  // 1. Premier tour
  await page.fill("textarea", "Réponds en une phrase : que vaut 6+7 ?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => {
      const log = document.querySelector('[role="log"]') ?? document.body;
      const btns = Array.from(document.querySelectorAll("button")).some(
        (b) => b.getAttribute("aria-label") === "Régénérer" || b.textContent?.includes("Régénérer")
      );
      return btns && !log.textContent?.includes("Hermes réfléchit");
    },
    undefined,
    { timeout: 90000 }
  );
  await page.waitForTimeout(500);

  // 2. Régénérer (bouton d'action de la dernière réponse)
  await page.hover('[role="log"] > div:last-child');
  const regen = page.locator('button:has-text("Régénérer")').last();
  await regen.click();
  await page.waitForFunction(
    () => document.body.textContent?.includes("/2"),
    undefined,
    { timeout: 120000 }
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/versions-1-v2.png` });

  // 3. Mesures : le sélecteur et son état
  const m1 = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[aria-label="Version précédente"]'));
    const label = btns[0]?.parentElement?.textContent ?? null;
    return { pickers: btns.length, label };
  });
  console.log("après régénération:", JSON.stringify(m1));

  // 4. Bascule vers v1
  await page.click('button[aria-label="Version précédente"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/versions-2-v1.png` });
  const m2 = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button[aria-label="Version précédente"]'));
    const label = btns[0]?.parentElement?.textContent ?? null;
    return { pickers: btns.length, label };
  });
  console.log("après bascule ‹:", JSON.stringify(m2));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
