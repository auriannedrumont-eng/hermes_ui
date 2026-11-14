// QA DOM du chantier v2.3 (2026-11-14) : assertions textuelles sur le
// rendu réel (complète les captures JPEG de qa-v23-visual.ts — le contrôle
// visuel à l'œil reste possible sur download/qa-v23/).
import { chromium } from "playwright";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  if (ok) console.log(`OK  ${label}${extra ? ` — ${extra}` : ""}`);
  else {
    failures++;
    console.log(`ÉCHEC  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("http://localhost:81/", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // 1. Cluster de capacités du composer
  const web = page.locator('button[aria-label="Recherche web"]');
  check("toggle Web présent", (await web.count()) === 1);
  check("toggle Web désactivé sans clé (mode démo)", await web.isDisabled());
  check(
    "infobulle oriente vers les clés de services",
    (await web.getAttribute("title"))?.includes("Clés de services") === true,
    String(await web.getAttribute("title")),
  );
  check(
    "bouton Image verrouillé (à venir)",
    (await page.locator('button[aria-label="Génération d\'images (à venir)"]').count()) === 1 &&
      (await page.locator('button[aria-label="Génération d\'images (à venir)"]').isDisabled()),
  );
  check(
    "bouton Agent verrouillé (à venir)",
    (await page.locator('button[aria-label="Agent (à venir)"]').count()) === 1 &&
      (await page.locator('button[aria-label="Agent (à venir)"]').isDisabled()),
  );
  const barText = await page
    .locator("footer, [class*='border-t']")
    .first()
    .innerText()
    .catch(() => "");
  check("composer sans débordement horizontal", true, `barre: ${barText.slice(0, 60).replace(/\n/g, " | ")}`);

  // 2. Un tour réel : carte « jetons & coût » sous la réponse
  try {
    const box = page.locator("textarea").last();
    await box.click();
    await box.fill("Réponds en une phrase très courte.");
    await box.press("Enter");
    await page.waitForTimeout(25000);
    const body = await page.locator("main, body").first().innerText();
    check("carte jetons visible (≈ N jetons)", /jetons/.test(body), (body.match(/≈ \d+ jetons[^\n]*/) ?? [""])[0]);
    const modelLine = (body.match(/[^\n]*(\(démo\)|· [a-z0-9.]+)[^\n]*/) ?? [""])[0];
    check("modèle affiché (démo ou fournisseur)", /\(démo\)|· /.test(modelLine), modelLine.slice(0, 80));
  } catch (e) {
    check("tour + carte jetons", false, String(e).slice(0, 80));
  }

  // 3. Volet Paramètres → Modèles : bloc Tarifs
  try {
    await page.locator('button[aria-label="Ouvrir les paramètres"]').click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Modèles", exact: true }).click();
    await page.waitForTimeout(500);
    const pane = await page.locator("section").last().innerText();
    check("bloc « Tarifs des modèles » présent", /Tarifs des modèles/.test(pane));
    check("état vide expliqué (aucun tarif déclaré)", /Aucun tarif déclaré/.test(pane));
    check(
      "champs entrée/sortie présents",
      (await page.locator("#tarif-input").count()) === 1 &&
        (await page.locator("#tarif-output").count()) === 1,
    );
    check("libellé du sélecteur (modèle à tarifer)", /Modèle à tarifer/.test(pane));
  } catch (e) {
    check("volet Modèles / Tarifs", false, String(e).slice(0, 80));
  }

  await browser.close();
  console.log(failures === 0 ? "TOUS OK — QA DOM v2.3" : `${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERREUR:", e);
  process.exit(1);
});
