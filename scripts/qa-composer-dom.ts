// QA DOM dédiée du Composer — chantier CRAP vague 6 UI (2026-11-25).
// Le composant Composer (CC 110) a été démonté en 7 feuilles VERBATIM
// (docs/crap-2026-11/scripts/extract_composer_leaves.py) : cette QA
// verrouille la structure et les comportements visibles — mêmes nœuds,
// mêmes libellés, mêmes interactions (menu slash, envoi bloqué, indicateur
// de dépôt, jauge, mobile 375 px) — sur la VRAIE pile (Caddy :81 → front
// dev :3000, service :3003, base SQLite jetable), cf. qa-motor-card-v3-dom
// pour la recette : Next dev n'accepte pas la montée websocket /socket.io/,
// les QA passent par Caddy, le vrai chemin de production.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXEC =
  "/home/z/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const FRONT = "http://127.0.0.1:81";

const qaDir = join(tmpdir(), `hermes-qa-composer-${Date.now()}`);
mkdirSync(qaDir, { recursive: true });

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// ── Pile auto-portée : service (base jetable) + front dev + passerelle ────
// Passerelle : le sandbox fait tourner SON caddy (pid 1-2, /app/Caddyfile)
// sur :81 → :3000 (502 si le front est bas, 200 sinon) — on l'utilise tel
// quel, un `caddy run --config Caddyfile` local ne pourrait pas binder.
// journaux du service et du front dans des fichiers (aucun pipe
// bloquant, les échecs de démarrage restent lisibles).
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

const CONTENEUR = "div.rounded-2xl.border.bg-card";

try {
  ok("service hermes-chat démarré (:3003)", await waitHttp("http://127.0.0.1:3003", 30_000));
  ok("front démarré (:3000)", await waitHttp("http://127.0.0.1:3000", 90_000));
  ok("passerelle Caddy (:81)", await waitHttp(FRONT, 20_000));

  const browser = await chromium.launch({ executablePath: EXEC });

  // ── Bureau 1440×900 : structure et comportements ────────────────────────
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // domcontentloaded + attente fixe : la socket long-polling empêche
  // networkidle de se stabiliser quand le service est hors d'atteinte.
  await page.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4000);

  const trombone = page.locator('button[aria-label="Joindre des fichiers (images, audio, vidéo, PDF)"]');
  ok("trombone présent (feuille Saisie)", (await trombone.count()) === 1);

  const textarea = page.locator('textarea[aria-label="Message pour Hermes"]');
  ok("textarea présente (feuille Saisie)", (await textarea.count()) === 1);
  ok(
    "placeholder par défaut",
    ((await textarea.getAttribute("placeholder")) ?? "").includes("Envoyer un message à Hermes…"),
    String(await textarea.getAttribute("placeholder")),
  );

  const envoi = page.locator('button[aria-label="Envoyer le message"]');
  ok("bouton envoi présent", (await envoi.count()) === 1);
  ok("envoi désactivé à vide (canSend)", await envoi.isDisabled());

  const web = page.locator('button[aria-label="Recherche web"]');
  ok("toggle recherche web présent (feuille Barre)", (await web.count()) === 1);
  ok(
    "toggle web aria-disabled sans gateway ni clé",
    (await web.getAttribute("aria-disabled")) === "true",
    String(await web.getAttribute("aria-disabled")),
  );

  const bouclier = page.locator('button[aria-label="Autorisations de l\'agent"]');
  ok("bouclier des autorisations présent (feuille Barre)", (await bouclier.count()) === 1);
  ok(
    "bouclier aria-disabled en moteur local",
    (await bouclier.getAttribute("aria-disabled")) === "true",
  );

  const corps = await page.locator("body").innerText();
  // ContextGauge : `if (!usage) return null` — sur l'accueil, sans
  // conversation ouverte (contextBase null), la jauge ne rend RIEN
  // (comportement inchangé au HEAD) ; la page complète rendue prouve que
  // le câblage des props des feuilles Barre/Pied ne casse pas le rendu.
  ok("jauge absente sans conversation (HEAD : !usage → null)", !/≈ .*jetons/i.test(corps));
  ok("pied de page présent (feuille Pied)", corps.includes("Hermes Web · images, audio, vidéo et PDF acceptés"));
  ok("bandeau « toutes permissions » absent en local", !corps.includes("Mode toutes permissions actif"));
  ok(
    "AlertDialog des permissions absent au repos",
    (await page.locator("text=Autoriser toutes les actions ?").count()) === 0,
  );

  // Indicateur de dépôt (feuille Recouvrement) : dragenter → visible, sortie → masqué.
  const conteneur = page.locator(CONTENEUR).first();
  await conteneur.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "qa.txt"));
    el.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(400);
  ok(
    "indicateur de dépôt visible au dragenter",
    (await page.locator("text=Déposez vos fichiers pour les joindre").count()) === 1,
  );
  await conteneur.evaluate((el) => {
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent("dragleave", { bubbles: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent("dragleave", { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(400);
  ok(
    "indicateur de dépôt masqué après sortie",
    (await page.locator("text=Déposez vos fichiers pour les joindre").count()) === 0,
  );

  // Menu slash (feuille Slash) : « / » ouvre, Échap ferme SANS modifier le texte.
  await textarea.click();
  await textarea.pressSequentially("/");
  await page.waitForTimeout(400);
  ok("menu slash ouvert par « / »", (await page.locator(`${CONTENEUR} ul li`).count()) > 0);
  await textarea.press("Escape");
  await page.waitForTimeout(300);
  ok("Échap ferme le menu", (await page.locator(`${CONTENEUR} ul li`).count()) === 0);
  ok("le texte reste intact après Échap", (await textarea.inputValue()) === "/");

  // Saisie d'un vrai texte → envoi activé (canSend), envoi bloqué pendant l'upload.
  await textarea.fill("QA composer — structure vérifiée");
  await page.waitForTimeout(300);
  ok("envoi activé après saisie", await envoi.isEnabled());
  ok("textarea auto-redimensionnée (style.height modifié)", await textarea.evaluate(
    (el) => el.style.height !== "" && el.style.height !== "auto",
  ));

  // ── Mobile 375×667 : aucun débordement horizontal ───────────────────────
  const mobile = await browser.newPage({ viewport: { width: 375, height: 667 } });
  await mobile.goto(FRONT, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await mobile.waitForTimeout(4000);
  const over = await mobile.evaluate(() => ({
    scroll: document.scrollingElement?.scrollWidth ?? 0,
    inner: window.innerWidth,
  }));
  ok("mobile 375 px sans débordement horizontal", over.scroll <= over.inner, `${over.scroll}px > ${over.inner}px ?`);
  ok(
    "mobile : composer présent",
    (await mobile.locator('textarea[aria-label="Message pour Hermes"]').count()) === 1,
  );

  await browser.close();
} catch (e) {
  failures++;
  console.log("ÉCHEC harnais :", String(e).slice(0, 300));
} finally {
  cleanup();
  console.log(failures === 0 ? "\nQA Composer DOM : TOUT VERT" : `\nQA Composer DOM : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}
