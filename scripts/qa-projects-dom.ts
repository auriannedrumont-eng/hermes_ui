// QA DOM des dossiers de la sidebar (F-59, maquette v6) — première QA DOM
// de cette zone (plan d'implémentation §7). Préparation des données via
// socket (comme l'utilisatrice n'aurait que son interface), scénarios
// maquette sur le rendu réel, nettoyage complet en fin de course.
// Prérequis : pile complète en marche (service 3003/3004 + interface) et
// BASE_URL (défaut : http://localhost:81/ — Caddy, cf. qa-v23-dom).
import { chromium } from "playwright";
import { io } from "socket.io-client";

const BASE = process.env.BASE_URL ?? "http://localhost:81/";
const SOCKET_URL = process.env.SOCKET_URL ?? "http://localhost:3003";
const MARK = "qa-f59";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  if (ok) console.log(`OK  ${label}${extra ? ` — ${extra}` : ""}`);
  else {
    failures++;
    console.log(`ÉCHEC  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function emit(socket: ReturnType<typeof io>, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (res: any) => resolve(res ?? {}));
    else socket.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

async function main() {
  // ── 0. Préparation : un dossier avec une conversation dedans ────────
  const socket = io(SOCKET_URL, { transports: ["websocket"] });
  const startedAt = Date.now();
  let folderId = "";
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => void resolve());
    socket.on("connect_error", (e: Error) => reject(e));
    setTimeout(() => reject(new Error("socket timeout")), 15000);
  });
  const seed = await emit(socket, "projects:create", { name: `Contrats ${MARK}` });
  folderId = seed.project?.id ?? "";
  check("préparation : dossier semé", !!folderId, folderId);
  const seedConv = await emit(socket, "conversations:create", { projectId: folderId });
  await emit(socket, "conversations:rename", {
    id: seedConv.conversation.id,
    title: `Contrat du bail ${MARK}`,
  });
  socket.close();

  // ── 1. Rendu de la sidebar ─────────────────────────────────────────
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);

    const body = await page.locator("body").innerText();
    check("titre de section « Mes dossiers »", /mes dossiers/i.test(body));
    check("titre de section « Sans dossier »", /sans dossier/i.test(body));
    check(
      "📁↓ « dossier du disque » à côté du titre",
      (await page.locator('button[aria-label="Ajouter un dossier de mon disque"]').first().count()) === 1,
    );
    check(
      "« + » sur le titre « Sans dossier »",
      (await page.locator('button[aria-label="Nouvelle conversation sans dossier"]').first().count()) === 1,
    );
    const rootBtn = page.locator('button[aria-label="Replier le dossier Contrats qa-f59"]').first();
    check("dossier semé visible (déplié par défaut)", (await rootBtn.count()) === 1);
    check("compteur direct = 1", (await rootBtn.innerText()).trim().endsWith("1"));

    // ── 2. Création d'un sous-dossier via le menu (en tête du menu) ────
    await page.locator('button[aria-label="Options pour Contrats qa-f59"]').first().click();
    await page.waitForTimeout(400);
    const menuItems = await page.getByRole("menuitem").allInnerTexts();
    check("« Nouveau dossier » en tête du menu", menuItems[0]?.includes("Nouveau dossier"), menuItems.join(" | ").slice(0, 80));
    await page.getByRole("menuitem", { name: "Nouveau dossier" }).click();
    await page.waitForTimeout(400);
    const subInput = page.locator('input[aria-label="Nom du nouveau sous-dossier"]').first();
    check("champ inline de création", (await subInput.count()) === 1);
    await subInput.fill("Signature");
    await subInput.press("Enter");
    await page.waitForTimeout(1200);
    const subRow = page.locator('button[aria-label="Replier le dossier Signature (sous-dossier)"]').first();
    check("sous-dossier créé et visible", (await subRow.count()) === 1);

    // ── 3. Indentation + dépliage du sous-dossier ─────────────────────
    const kidsBox = (await subRow.boundingBox()) ?? { x: 0 };
    const rootBox = (await rootBtn.boundingBox()) ?? { x: 0 };
    check("sous-dossier indenté sous son parent", kidsBox.x > rootBox.x, `+${Math.round(kidsBox.x - rootBox.x)} px`);
    await subRow.click(); // referme
    await page.waitForTimeout(300);
    check(
      "état vide du sous-dossier fermé",
      (await page.locator('button[aria-label="Déplier le dossier Signature (sous-dossier)"]').first().count()) === 1,
    );
    await page.locator('button[aria-label="Déplier le dossier Signature (sous-dossier)"]').first().click(); // rouvre
    await page.waitForTimeout(300);
    check("second clic rouvre", (await subRow.count()) === 1);

    // ── 4. État actif sans bordure : la conversation du dossier ───────
    await page.locator(`text=Contrat du bail ${MARK}`).first().click();
    await page.waitForTimeout(800);
    const headerDiv = rootBtn.locator("xpath=..");
    const styles = await headerDiv.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, shadow: cs.boxShadow, blw: cs.borderLeftWidth };
    });
    check("en-tête actif : fond accent", styles.bg !== "rgba(0, 0, 0, 0)", styles.bg);
    check("en-tête actif : sans bordure ni anneau", styles.shadow === "none" && styles.blw === "0px", `shadow=${styles.shadow} border-left=${styles.blw}`);

    // ── 5. Fil d'Ariane dans l'en-tête ────────────────────────────────
    // Nouvelle conversation dans le SOUS-dossier via son « + »
    await page.locator('button[aria-label="Nouvelle conversation dans Signature"]').first().click();
    await page.waitForTimeout(1000);
    const headText = await page.locator("header").innerText();
    check(
      "fil d'Ariane dossier › sous-dossier",
      /Contrats qa-f59\s*›\s*Signature/.test(headText.replace(/\n/g, " ")),
      headText.split("\n").slice(0, 2).join(" ").slice(0, 80),
    );
    check(
      "titre de conversation au bout du fil",
      /Nouvelle conversation/.test(headText),
      "",
    );

    // ── 6. « + » de « Sans dossier » + fil « Sans dossier › » ─────────
    await page.locator('button[aria-label="Nouvelle conversation sans dossier"]').first().click();
    await page.waitForTimeout(1000);
    const headText2 = await page.locator("header").innerText();
    check(
      "fil d'Ariane « Sans dossier › »",
      /Sans dossier\s*›/.test(headText2.replace(/\n/g, " ")),
      headText2.split("\n").slice(0, 2).join(" ").slice(0, 80),
    );

    // ── 7. Recherche : arbre filtré déplié ────────────────────────────
    await page.locator('input[aria-label="Rechercher dans les dossiers, les conversations et les messages"]').first().fill("Contrats");
    await page.waitForTimeout(900);
    const searchBody = await page.locator("body").innerText();
    check("recherche : le dossier visible par son NOM", searchBody.includes("Contrats qa-f59"));
    // Règle maquette : un sous-dossier sans correspondance (nom) ni
    // conversation visible reste masqué pendant la recherche.
    check("recherche : sous-dossier sans correspondance masqué", !searchBody.includes("Signature"));
    await page.locator('input[aria-label="Rechercher dans les dossiers, les conversations et les messages"]').first().fill("Signature");
    await page.waitForTimeout(900);
    const searchBodySub = await page.locator("body").innerText();
    check("recherche : sous-dossier visible par son nom", searchBodySub.includes("Signature"));
    await page.locator('input[aria-label="Rechercher dans les dossiers, les conversations et les messages"]').first().fill("zzz-aucune-correspondance");
    await page.waitForTimeout(900);
    const searchBody2 = await page.locator("body").innerText();
    check("recherche : message « aucun dossier »", searchBody2.includes("Aucun dossier ne correspond."));
  } catch (err) {
    check("scénario maquette complet", false, String(err).slice(0, 120));
  } finally {
    await browser.close();
  }

  // ── 8. Nettoyage : tout ce qui a été créé pendant la QA ────────────
  const socket2 = io(SOCKET_URL, { transports: ["websocket"] });
  await new Promise<void>((resolve) => {
    socket2.on("connect", () => void resolve());
    setTimeout(() => void resolve(), 10000);
  });
  const convs = await emit(socket2, "conversations:list");
  for (const c of convs.conversations ?? []) {
    const created = new Date(c.createdAt).getTime();
    if (c.title.includes(MARK) || created >= startedAt) {
      await emit(socket2, "conversations:delete", { id: c.id });
    }
  }
  const list = await emit(socket2, "projects:list");
  for (const p of list.projects ?? []) {
    if (p.name.includes(MARK) || p.name === "Signature") {
      await emit(socket2, "projects:delete", { id: p.id });
    }
  }
  const listEnd = await emit(socket2, "projects:list");
  const leftovers = (listEnd.projects ?? []).filter(
    (p: any) => p.name.includes(MARK) || p.name === "Signature"
  );
  check("nettoyage : aucun dossier de QA restant", leftovers.length === 0, `${leftovers.length} restant(s)`);
  socket2.close();

  console.log(
    failures === 0
      ? "\nSUCCÈS — QA DOM dossiers F-59 validée"
      : `\n${failures} échec(s) — QA DOM dossiers incomplète`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
