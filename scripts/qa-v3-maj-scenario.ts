// QA scénario « maj en cours » (v3) : pilote la VRAIE chaîne côté service.
// Le bouton « Mettre à jour » de la carte dépose le drapeau + démarre le
// journal via system:update-request (B-2) ; ce script joue le rôle du
// lanceur : il écrit dans desktop/runtime/maj.log les étapes RÉELLES
// (phrases des lanceurs .sh/.ps1) au rythme réel accéléré, et le relais
// 2 s du service diffuse chaque changement à l'interface.
// Usage : bun run scripts/qa-v3-maj-scenario.ts
import { appendFileSync, writeFileSync } from "node:fs";
import { io } from "socket.io-client";

const LOG = "/home/z/my-project/hermes_ui/desktop/runtime/maj.log";

const socket = io("http://127.0.0.1:3003", {
  path: "/",
  transports: ["websocket"],
  timeout: 8000,
});

function stamp() {
  return new Date().toLocaleTimeString("fr-FR", { hour12: false });
}
function maj(line: string) {
  appendFileSync(LOG, `[${stamp()}] ${line}\n`, "utf-8");
  console.log("  journal ←", line);
}

async function main() {
  await new Promise<void>((r, j) => {
    socket.once("connect", r);
    setTimeout(() => j(new Error("service injoignable")), 8000);
  });
  console.log("connecté au service — dépôt de la demande (comme le bouton)…");

  // 1. La demande (le service écrit la première ligne + pose le drapeau).
  const res = await new Promise<Record<string, unknown>>((r) => {
    socket.emit("system:update-request", (ack: Record<string, unknown>) => r(ack));
  });
  console.log("réponse update-request :", JSON.stringify(res));

  // 2. Le lanceur ramasse (cycle ≤ 15 s — rythme réaliste accéléré).
  await new Promise((r) => setTimeout(r, 3000));
  maj("MAJ DEBUT - demande ramassée par le lanceur");
  await new Promise((r) => setTimeout(r, 2500));
  maj("arret des services...");
  await new Promise((r) => setTimeout(r, 2500));
  maj("consultation de GitHub...");
  await new Promise((r) => setTimeout(r, 2500));
  maj("fusion directe impossible — sauvegarde des fichiers locaux modifies, puis alignement sur GitHub...");
  await new Promise((r) => setTimeout(r, 2500));
  maj("mise à jour appliquée : 24 fichier(s) récupéré(s)");
  await new Promise((r) => setTimeout(r, 2500));
  maj("code de l'interface modifié — reconstruction (1 à 3 minutes)…");
  await new Promise((r) => setTimeout(r, 4000));
  maj("relance des services…");
  await new Promise((r) => setTimeout(r, 2500));
  maj("MAJ OK - pile relancée, rafraîchissez l'onglet Hermes (F5) pour charger la nouvelle version.");

  console.log("scénario maj terminé (verdict MAJ OK écrit).");
  socket.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
