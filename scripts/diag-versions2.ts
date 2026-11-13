// Micro-test : clic JS direct (sans coordonnées) sur « Régénérer ».
import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("http://127.0.0.1:81/", { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => {
      const el = document.querySelector("textarea");
      return el && !el.hasAttribute("disabled");
    },
    undefined,
    { timeout: 20000 }
  );

  // Nouveau tour réel, puis inspection du bouton Régénérer
  await page.fill("textarea", "Réponds en une phrase : couleur du ciel la nuit ?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => !document.body.textContent?.includes("Hermes réfléchit"),
    undefined,
    { timeout: 90000 }
  );
  await page.waitForTimeout(800);

  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-label="Régénérer"]')).pop();
    if (!btn) return "ABSENT";
    const r = btn.getBoundingClientRect();
    const cover = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    (btn as HTMLElement).click();
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      cover: cover ? (cover.tagName + "." + String(cover.className).slice(0, 60)) : null,
      isBtn: cover === btn,
      disabled: (btn as HTMLButtonElement).disabled,
      btnHtml: btn.outerHTML.slice(0, 220),
    };
  });
  console.log("clic JS:", JSON.stringify(clicked));
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({
    reflechit: document.body.textContent?.includes("Hermes réfléchit") ?? false,
    ratio: document.body.textContent?.includes("/2") ?? false,
  }));
  console.log("3s après:", JSON.stringify(after));
  await page.screenshot({ path: "/tmp/qa-hermes/diag-3-jsclick.png" });
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
