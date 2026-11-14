// QA visuelle du chantier v2.3 (2026-11-14) : rendu du composer avec le
// cluster de capacités (Web/Image/Agent), carte « jetons & coût » sous une
// réponse, bloc « Tarifs des modèles » du volet Paramètres. Captures JPEG
// dans download/qa-v23/. Chaque étape est tolérante (une capture manquante
// n'interrompt pas les suivantes) — contrôle ensuite à l'œil + relecture.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "download/qa-v23";
mkdirSync(OUT, { recursive: true });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto("http://localhost:81/", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // 1. Accueil : composer avec le cluster de capacités
  const web = page.locator('button[aria-label="Recherche web"]');
  console.log("toggle Web présent :", await web.count());
  await page.screenshot({ path: `${OUT}/01-accueil-composer.jpeg`, type: "jpeg", quality: 60 });
  console.log("capturé: 01-accueil-composer.jpeg");

  // 2. Un tour réel (SDK démo) : réponse + carte jetons & coût repliée
  try {
    const box = page.locator("textarea").last();
    await box.click();
    await box.fill("Bonjour ! Réponds en une seule phrase courte, puis présente-toi en deux mots.");
    await box.press("Enter");
    // Attendre la fin du stream (la rangée d'actions au survol ou la carte
    // jetons apparaît) — 25 s max, puis capture quoi qu'il arrive.
    await page.waitForTimeout(25000);
    await page.screenshot({ path: `${OUT}/02-reponse-carte-cout.jpeg`, type: "jpeg", quality: 60 });
    console.log("capturé: 02-reponse-carte-cout.jpeg");
  } catch (e) {
    console.log("étape tour ignorée :", String(e).slice(0, 80));
  }

  // 3. Volet Paramètres → section Modèles (bloc Tarifs)
  try {
    await page.locator('button[aria-label="Ouvrir les paramètres"]').click();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Modèles", exact: true }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/03-volet-modeles-tarifs.jpeg`, type: "jpeg", quality: 60 });
    console.log("capturé: 03-volet-modeles-tarifs.jpeg");
  } catch (e) {
    console.log("étape volet ignorée :", String(e).slice(0, 80));
  }

  await browser.close();
  console.log("QA visuelle v2.3 terminée — contrôler", OUT);
}

main().catch((e) => {
  console.error("ERREUR:", e);
  process.exit(1);
});
