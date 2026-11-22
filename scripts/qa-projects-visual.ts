// Capture visuelle de la sidebar « dossiers » (F-59) : dossier + sous-dossier
// + conversation active, clair et sombre — complète qa-projects-dom.ts
// (assertions calculées) par un contrôle à l'œil (convention qa-*-visual).
// Sortie : download/qa-f59/*.jpg (hors git, comme les autres QA).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { io } from "socket.io-client";

const BASE = process.env.BASE_URL ?? "http://localhost:81/";
const SOCKET_URL = process.env.SOCKET_URL ?? "http://localhost:3003";
const OUT = join(import.meta.dir, "..", "..", "download", "qa-f59");

function emit(socket: ReturnType<typeof io>, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (res: any) => resolve(res ?? {}));
    else socket.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const socket = io(SOCKET_URL, { transports: ["websocket"] });
  await new Promise<void>((r) => socket.on("connect", () => void r()));
  const folder = await emit(socket, "projects:create", { name: "Démarches" });
  const sub = await emit(socket, "projects:create", { name: "Logement", parentId: folder.project.id });
  const c1 = await emit(socket, "conversations:create", { projectId: sub.project.id });
  await emit(socket, "conversations:rename", { id: c1.conversation.id, title: "Relire la section 3.2" });
  const c2 = await emit(socket, "conversations:create", { projectId: folder.project.id });
  await emit(socket, "conversations:rename", { id: c2.conversation.id, title: "Devis Caddy" });
  socket.close();

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // Ouvre la conversation du sous-dossier (état actif + fil d'Ariane)
  await page.locator("text=Relire la section 3.2").first().click();
  await page.waitForTimeout(800);
  const sidebar = page.locator("nav").first();
  await sidebar.screenshot({ path: join(OUT, "sidebar-clair.jpg"), quality: 80, type: "jpeg" });
  await page.screenshot({ path: join(OUT, "page-claire.jpg"), quality: 70, type: "jpeg" });

  // Sombre
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(600);
  const toggles = page.locator('button[aria-label="Basculer entre thème clair et sombre"]');
  if (await toggles.count()) await toggles.first().click();
  await page.waitForTimeout(800);
  await sidebar.screenshot({ path: join(OUT, "sidebar-sombre.jpg"), quality: 80, type: "jpeg" });

  // F-60 : archive le dossier, déplie les Archives, capture
  await page.locator('button[aria-label="Options pour Démarches"]').first().click();
  await page.waitForTimeout(400);
  await page.getByRole("menuitem", { name: "Archiver le dossier" }).click();
  await page.waitForTimeout(1000);
  await page.locator('button[aria-label="Déplier les Archives"]').first().click();
  await page.waitForTimeout(500);
  await sidebar.screenshot({ path: join(OUT, "sidebar-archives.jpg"), quality: 80, type: "jpeg" });
  // Retour à l'état actif pour le nettoyage inchangé
  await page.locator('button[aria-label="Désarchiver le dossier Démarches"]').first().click();
  await page.waitForTimeout(800);

  // F-61 : densité (indentations resserrées) puis masquage de la sidebar —
  // la même icône d'en-tête la réaffiche.
  await page.screenshot({ path: join(OUT, "page-densite.jpg"), quality: 70, type: "jpeg" });
  await page.locator('button[aria-label="Masquer la sidebar"]').first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, "page-sans-sidebar.jpg"), quality: 70, type: "jpeg" });
  const restore = page.locator('button[aria-label="Afficher la sidebar"]');
  if ((await restore.count()) >= 1) await restore.first().click();  await page.waitForTimeout(800);

  await browser.close();

  // Nettoyage
  const socket2 = io(SOCKET_URL, { transports: ["websocket"] });
  await new Promise<void>((r) => socket2.on("connect", () => void r()));
  await emit(socket2, "conversations:delete", { id: c1.conversation.id });
  await emit(socket2, "conversations:delete", { id: c2.conversation.id });
  await emit(socket2, "projects:delete", { id: sub.project.id });
  await emit(socket2, "projects:delete", { id: folder.project.id });
  socket2.close();
  console.log(`captures écrites dans ${OUT}`);
  process.exit(0);
}

void main();
