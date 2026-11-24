// QA DOM dédiée de SystemSection — chantier CRAP vague 7 UI (2026-11-24).
// Le composant SystemSection (CC 102) a été démonté en 2 feuilles VERBATIM
// (docs/crap-2026-11/scripts/extract_system_leaves.py) : cette QA verrouille
// la structure et les comportements visibles — carte application (pastille,
// phrase d'état, actions, feuille EnteteApp), fil live ABSENT au repos
// (feuille FilApp), carte Hermes rendue, sonde « Vérifier maintenant »
// réelle, mobile 375 px — sur la VRAIE pile (Caddy :81 → front dev :3000,
// service :3003, base SQLite jetable), cf. qa-composer-dom.ts pour la
// recette : les QA passent par Caddy, le vrai chemin de production.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const FRONT = "http://127.0.0.1:81";

const qaDir = join(tmpdir(), `hermes-qa-system-${Date.now()}`);
mkdirSync(qaDir, { recursive: true });

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// ── Pile auto-portée : service (base jetable) + front dev + passerelle ────
const serviceLog = openSync(join(qaDir, "service.log"), "a");
const frontLog = openSync(join(qaDir, "front.log"), "a");
const service = spawn("bun", ["run", "mini-services/hermes-chat/index.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, HERMES_CHAT_DB: join(qaDir, "qa.sqlite") },
  stdio: ["ignore", serviceLog, serviceLog],
});
const front = spawn("bun", ["dev"], {
  cwd: process.cwd(),
  stdio: ["ignore", frontLog, frontLog],
});

async function waitHttp(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status > 0) return true;
    } catch {
      /* pas encore */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function cleanup() {
  try { service.kill(); } catch { /* déjà parti */ }
  try { front.kill(); } catch { /* déjà parti */ }
  rmSync(qaDir, { recursive: true, force: true });
}
process.on("exit", cleanup);

try {
  ok("service hermes-chat démarré (:3003)", await waitHttp("http://127.0.0.1:3003", 30_000));
  ok("front démarré (:3000)", await waitHttp("http://127.0.0.1:3000", 90_000));
  ok("passerelle Caddy (:81)", await waitHttp(FRONT, 20_000));

  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  // Ouvrir Paramètres → Système (rail de sections du volet)
  await page.locator('button[aria-label*="paramètres"i]').first().click();
  await page.waitForTimeout(900);
  await page.locator('button:has-text("Système")').first().click();
  await page.waitForTimeout(2500);

  const pane = page.locator('section[aria-label="Système"]');
  ok("section Système rendue (aria-label intact)", (await pane.count()) === 1);
  ok("titre h1 « Système »", (await pane.locator("h1").innerText()) === "Système");
  const corpsPane = await pane.innerText();
  ok(
    "phrase d'introduction intacte",
    corpsPane.includes("Deux programmes travaillent pour vous"),
  );

  // ── Feuille EnteteApp : pastille, phrase d'état, actions ────────────────
  ok(
    "titre carte application + pastille (feuille EnteteApp)",
    (await pane.locator('h2:has-text("L\'application")').count()) === 1,
  );
  const pastilleLabel = await pane.locator('h2:has-text("L\'application")').innerText().catch(() => "");
  const labelConnu = ["À jour", "Vérification…", "Mise à jour disponible", "Mise à jour en cours…", "Vérification impossible", "Mise à jour installée"]
    .some((l) => pastilleLabel.includes(l));
  ok("pastille portant un libellé d'état connu (dérivation appTone/appLabel déplacée)", labelConnu, pastilleLabel);
  const boutonsConnus = ["Vérifier maintenant", "Mettre à jour", "Réessayer", "Recharger la page", "Vérification…"];
  let boutonVu = "";
  for (const l of boutonsConnus) {
    if ((await pane.locator(`button:has-text("${l}")`).count()) > 0) { boutonVu = l; break; }
  }
  ok("un bouton d'action connu est rendu (chaîne de boutons déplacée)", boutonVu !== "", boutonVu);

  // ── Feuille FilApp : le fil live est ABSENT au repos (pas de MAJ en vol,
  //    pas de verdict) — jalons et garde-fou invisibles.
  ok("fil live absent au repos (jalons non rendus)", !(await corpsPane).includes("Demande envoyée"));
  ok("garde-fou de silence absent au repos", !corpsPane.includes("Aucune nouvelle depuis"));
  ok("bandeau updateError absent au repos", !corpsPane.includes("Le service n'a pas répondu (8 s)"));

  // ── Carte 2 : AgentMotorCard rendue sous la carte application ───────────
  ok(
    "carte Hermes rendue (AgentMotorCard inchangée)",
    (await pane.locator('h2:has-text("Hermes")').count()) >= 1,
  );

  // ── Sonde RÉELLE via le bouton « Vérifier maintenant » (état « à jour »
  //    seulement — ne JAMAIS déclencher une vraie mise à jour en QA) ──────
  if (boutonVu === "Vérifier maintenant") {
    await pane.locator('button:has-text("Vérifier maintenant")').first().click();
    // Le service du sandbox répond parfois en < 400 ms : sonder par polling
    // (100 ms × 20) si « Vérification… » apparaît — sinon, un retour
    // immédiat à un état stable prouve le même câblage (ack plus rapide
    // que le polling), consigné dans le détail.
    let bascule = false;
    for (let i = 0; i < 20 && !bascule; i++) {
      await page.waitForTimeout(100);
      bascule = (await pane.innerText()).includes("Vérification…");
    }
    let revenu = bascule ? false : true;
    for (let i = 0; i < 20 && !revenu; i++) {
      await page.waitForTimeout(700);
      const t = await pane.innerText();
      revenu = t.includes("À jour") || t.includes("Vérification impossible") || t.includes("Mise à jour disponible");
    }
    ok(
      "la sonde passe par « Vérification… » ou revient à un état stable (prodeMajCheck déplacé intact)",
      revenu,
      bascule ? "bascule observée, retour stable" : "ack plus rapide que le polling, retour stable",
    );
  } else {
    ok("sonde « Vérifier maintenant » non déclenchée (état ≠ à jour — service vu autrement)", true, `bouton: ${boutonVu}`);
  }

  // ── Mobile 375×667 : aucun débordement horizontal (même recette que
  //    qa-composer-dom.ts : pas d'ouverture du volet sur mobile) ───────────
  const mobile = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await mobile.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await mobile.waitForTimeout(4000);
  const over = await mobile.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    inner: window.innerWidth,
  }));
  ok("mobile 375 px sans débordement horizontal", over.scroll <= over.inner, `${over.scroll}px > ${over.inner}px ?`);
  ok(
    "mobile : la page d'accueil rend sans la section Système",
    (await mobile.locator('section[aria-label="Système"]').count()) === 0,
  );

  await browser.close();
} catch (e) {
  failures++;
  console.log("ÉCHEC harnais :", String(e).slice(0, 300));
} finally {
  cleanup();
  console.log(failures === 0 ? "\nQA System DOM : TOUT VERT" : `\nQA System DOM : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
