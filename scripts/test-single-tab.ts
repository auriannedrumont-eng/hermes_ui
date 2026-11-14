// QA de la garde « un seul onglet » (2026-11-15) — demande de
// l'utilisatrice : « que le lanceur détecte si un onglet Hermes est déjà
// ouvert et qu'il ferme ou relance sur ce même onglet ». Deux onglets dans
// le MÊME contexte Playwright (même origine : même localStorage, même
// BroadcastChannel), l'interface servie en direct. Le mini-service n'est
// pas requis : la garde vit dans le layout racine, pas dans le chat.
// Prérequis : interface joignable sur http://localhost:3000 (next dev).
import { chromium } from "playwright";

const BASE = process.env.HERMES_TAB_BASE ?? "http://localhost:3000";
const results: { ok: boolean; label: string }[] = [];
function check(ok: boolean, label: string): void {
  results.push({ ok, label });
  console.log(`${ok ? "OK   " : "ECHEC"} ${label}`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Onglet A : premier lancement du lanceur.
  const pageA = await context.newPage();
  await pageA.goto(BASE, { waitUntil: "domcontentloaded" });
  await pageA.waitForFunction(() => (window as any).__hermesTabRole === "primary", undefined, {
    timeout: 60000, // premier lancement dev : compilation à froid
  });
  const beat1 = await pageA.evaluate(() => localStorage.getItem("hermes.single.tab"));
  check(!!beat1 && JSON.parse(beat1).ts > 0, "onglet A principal + battement écrit");

  // Onglet B : « relance du lanceur » pendant qu'Hermes est déjà ouvert.
  const pageB = await context.newPage();
  await pageB.goto(BASE, { waitUntil: "domcontentloaded" });
  await pageB.waitForFunction(() => (window as any).__hermesTabRole === "duplicate", undefined, {
    timeout: 30000,
  });
  check(true, "le nouvel onglet se détecte comme doublon");

  const banner = pageB.getByText("Hermes est déjà ouvert dans un autre onglet").first();
  check(await banner.isVisible(), "bandeau affiché sur le nouvel onglet");

  // L'onglet EXISTANT doit se rafraîchir (compteur de rechargements) et
  // redevenir principal : c'est « relance sur ce même onglet ».
  await pageA.waitForFunction(
    () =>
      (window as any).__hermesReloadCount >= 1 && (window as any).__hermesTabRole === "primary",
    undefined,
    { timeout: 15000 },
  );
  check(true, "l'onglet existant s'est actualisé (rechargé) et reste principal");

  // Le doublon ne vole jamais le battement pendant son attente.
  const beat2 = await pageB.evaluate(() => localStorage.getItem("hermes.single.tab"));
  const idA = await pageA.evaluate(() => sessionStorage.getItem("hermes.tab.id"));
  check(!!beat2 && JSON.parse(beat2).id === idA, "le battement reste détenu par l'onglet existant");

  // La fermeture automatique peut être refusée par le navigateur (page
  // ouverte par le système, pas par un script) : la note honnête doit
  // apparaître — sinon la page s'est fermée toute seule, encore mieux.
  await pageB
    .waitForFunction(
      () => document.body.innerText.includes("fermez-la à la main"),
      undefined,
      { timeout: 9000 },
    )
    .catch(() => {});
  const noteVisible = await pageB
    .getByText("fermez-la à la main")
    .first()
    .isVisible()
    .catch(() => false);
  check(pageB.isClosed() || noteVisible, "fermeture auto tentée, note « à la main » si refusée");

  // Fermer l'ancien onglet : le doublon doit prendre le relais.
  await pageA.close();
  await pageB.waitForFunction(() => (window as any).__hermesTabRole === "primary", undefined, {
    timeout: 20000, // pire cas : expiration des 7 s si pagehide n'a pas pu courir
  });
  const bannerGone = !(await pageB
    .getByText("Hermes est déjà ouvert dans un autre onglet")
    .first()
    .isVisible()
    .catch(() => false));
  check(bannerGone, "relais pris par l'onglet en attente, bandeau retiré");

  const idB = await pageB.evaluate(() => sessionStorage.getItem("hermes.tab.id"));
  const beat3 = await pageB.evaluate(() => localStorage.getItem("hermes.single.tab"));
  check(!!beat3 && JSON.parse(beat3).id === idB, "le battement est désormais détenu par le relais");

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} contrôles verts`);
  if (failed.length > 0) {
    console.log("ECHECS :", failed.map((f) => f.label).join(" | "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
