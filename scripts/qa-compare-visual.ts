// QA visuelle F-17 : active le mode comparaison, envoie un message,
// capture les deux colonnes en streaming puis terminées, et mesure le DOM.
import { chromium } from "playwright";

const OUT = "/tmp/qa-hermes";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:81/", { waitUntil: "networkidle" });
  await page.waitForSelector("text=Comment puis-je vous aider", { timeout: 20000 });
  // L'app doit être CONNECTÉE au mini-service (via Caddy) pour chatter.
  await page.waitForFunction(
    () => {
      const el = document.querySelector("textarea");
      return el && !el.hasAttribute("disabled");
    },
    { timeout: 15000 }
  );

  // 1. Active le mode comparaison
  await page.click('button[title*="Comparer deux modèles"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/compare-1-toggle.png` });

  // 2. Vérifie les deux pickers A/B
  const pickers = await page.evaluate(() => ({
    a: document.querySelector('[aria-label^="Modèle A"]')?.textContent?.trim() ?? null,
    b: document.querySelector('[aria-label^="Modèle B"]')?.textContent?.trim() ?? null,
  }));
  console.log("pickers:", JSON.stringify(pickers));

  // 3. Envoie une question
  await page.fill("textarea", "En une phrase : pourquoi le ciel est-il bleu ?");
  await page.keyboard.press("Enter");

  // 4. Capture en streaming (les deux colonnes vivent)
  await page.waitForSelector('text=Modèle A, text=A', { timeout: 10000 }).catch(() => {});
  await page.waitForSelector('[aria-label="Réponses comparées"]', { timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/compare-2-streaming.png` });

  // 5. Attend la fin des deux côtés (plus de « Réfléchit », réponses là)
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[role="log"]');
      return el && !el.textContent?.includes("Hermes réfléchit");
    },
    { timeout: 90000 }
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/compare-3-done.png` });

  // 6. Mesures DOM : la paire, ses deux colonnes, leurs contenus
  const measures = await page.evaluate(() => {
    const pair = document.querySelector('[aria-label="Réponses comparées"]');
    if (!pair) return { error: "paire absente" };
    const cols = Array.from(pair.children).map((c) => ({
      w: Math.round(c.getBoundingClientRect().width),
      header: c.querySelector("span.truncate")?.textContent?.trim() ?? null,
      len: c.querySelector('[class*="prose"], .markdown, p')?.textContent?.length ?? 0,
    }));
    return { pairW: Math.round(pair.getBoundingClientRect().width), cols };
  });
  console.log("mesures:", JSON.stringify(measures, null, 1));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
