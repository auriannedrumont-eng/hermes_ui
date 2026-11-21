// QA visuelle v0.3.3 — CAS « mise à jour disponible » : le service tourne
// avec HERMES_UPDATE_TEST_URL=stub (pointe f07f084 « version future »).
// Le front est chargé VIA CADDY :81 (comme en prod — le socket.io passe
// par ?XTransformPort=3003). À prouver : (1) point orange sur l'engrenage
// SANS page Système ouverte ; (2) toast une seule fois ; (3) badge sur
// l'onglet Système ; (4) carte « disponible » + bouton Mettre à jour.
import { chromium } from "playwright";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const FRONT = "http://127.0.0.1:81";
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(FRONT, { waitUntil: "networkidle", timeout: 30_000 });
  // Laisser la socket se connecter + le toast éventuel apparaître.
  await page.waitForTimeout(2500);

  // (1) Point orange sur l'engrenage, volet FERMÉ (page de chat seule).
  const gear = page.locator('button[aria-label*="paramètres"i]').first();
  const dot = page.locator('button[aria-label*="paramètres"i] i.bg-warning');
  ok("engrenage présent (page chat)", await gear.count() > 0);
  ok(
    "mise à jour disponible → point orange SUR L'ENGRENAGE (volet fermé)",
    (await dot.count()) > 0,
    `${await dot.count()} point(s)`
  );

  // (2) Toast une seule fois.
  const toast = page.locator("text=Mise à jour disponible");
  ok("toast « Mise à jour disponible » affiché", (await toast.count()) > 0);

  // (3) Ouvrir le volet : badge sur l'onglet Système.
  await gear.click();
  await page.waitForTimeout(900);
  const sysRow = page.locator('button:has-text("Système")').first();
  const badge = sysRow.locator("i.bg-warning");
  ok(
    "badge orange sur l'onglet Système",
    (await badge.count()) > 0,
    `${await badge.count()} badge(s)`
  );

  // (4) Carte Mise à jour en état « disponible ».
  await sysRow.click();
  await page.waitForTimeout(1500);
  const body = await page.locator("body").innerText();
  ok(
    "carte : « Une nouvelle version de Hermes est prête »",
    body.includes("Une nouvelle version de Hermes est prête"),
  );
  const majBtn = page.locator('button:has-text("Mettre à jour")');
  ok(
    "bouton « Mettre à jour » actif",
    (await majBtn.count()) > 0,
    `${await majBtn.count()} bouton(s)`
  );

  // Carte Agent — les textes simples doivent être là aussi via Caddy.
  ok(
    "carte Agent simple — présentes les deux lignes renommées",
    body.includes("Dernier contact") && body.includes("Liaison"),
  );

  await page.screenshot({ path: "/home/z/my-project/download/v0.3.3-systeme-disponible.png" });
  console.log("capture : v0.3.3-systeme-disponible.png");
} catch (e) {
  console.error("✗ erreur de parcours :", (e as Error).message);
  failures++;
} finally {
  await browser.close();
}

console.log(failures === 0 ? "── TOUT VERT ──" : `── ${failures} ÉCHEC(S) ──`);
process.exit(failures === 0 ? 0 : 1);
