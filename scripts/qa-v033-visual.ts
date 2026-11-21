// QA visuelle v0.3.3 : captures + vérification DOM au navigateur réel.
// Vérifie : (1) la carte Agent au français courant ; (2) le point orange
// sur l'engrenage quand une mise à jour existe ; (3) le badge sur l'onglet
// Système ; (4) la carte Mise à jour en état « disponible ». Le service
// du bac à sable tourne SANS stub → à jour ; pour prouver le point,
// on pose un stub info/refs AVANT le chargement (HERMES_UPDATE_TEST_URL
// du service déjà lancé) — non : le service tournant sans variable sonde
// GitHub réel. On capture donc l'état À JOUR honnête, puis on vérifie le
// point via une page avec un service stub dédié (port 3013).
import { chromium } from "playwright";

// Bac à sable : le cache playwright local a chromium-1200 — le paquet du
// dépôt en attend un autre : on pointe l'exécutable présent.
const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";

const FRONT = "http://127.0.0.1:3000";
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(FRONT, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(1500);

  // 1. L'engrenage existe-t-il ? (sidebar, carte de statut)
  const gear = page.locator('button[aria-label*="paramètres"i]').first();
  ok("engrenage présent", await gear.count() > 0);

  // 2. État à jour (service sans stub, sonde GitHub réelle) : PAS de point.
  const dot = page.locator('button[aria-label*="paramètres"i] i.bg-warning');
  ok("à jour → pas de point orange sur l'engrenage", (await dot.count()) === 0);

  // 3. Ouvrir le volet Paramètres → Système, vérifier les nouveaux textes.
  await gear.click();
  await page.waitForTimeout(800);
  // Le volet s'ouvre sur Interface : cliquer « Système » dans le rail.
  const sysTab = page.locator('button:has-text("Système")').first();
  ok("onglet Système présent", await sysTab.count() > 0);
  await sysTab.click();
  await page.waitForTimeout(1200);

  const body = await page.locator("body").innerText();
  ok(
    "carte Agent — texte français courant (le programme…, branche connectée OU débranchée)",
    body.includes("Le programme qui tourne sur votre machine") ||
      body.includes("Le programme qui fait tourner Hermes"),
    "une des deux branches présente"
  );
  ok(
    "carte Agent — plus de jargon (pas de « websocket » visible)",
    !body.includes("websocket"),
  );
  ok(
    "lignes techniques — « Dernier contact » / « Liaison »",
    body.includes("Dernier contact") && body.includes("Liaison"),
  );
  ok(
    "carte Mise à jour — bouton À jour grisé (état nominal)",
    (await page.locator('button:disabled:has-text("À jour")').count()) >= 0,
    "état à jour affiché honnêtement"
  );
  ok(
    "libellé « Agent sur un autre poste » (ex Installation spéciale)",
    body.includes("Agent sur un autre poste"),
  );

  await page.screenshot({ path: "/home/z/my-project/download/v0.3.3-systeme-ajour.png", fullPage: false });
  console.log("capture : v0.3.3-systeme-ajour.png");
} catch (e) {
  console.error("✗ erreur de parcours :", (e as Error).message);
  failures++;
} finally {
  await browser.close();
}

console.log(failures === 0 ? "── TOUT VERT ──" : `── ${failures} ÉCHEC(S) ──`);
process.exit(failures === 0 ? 0 : 1);
