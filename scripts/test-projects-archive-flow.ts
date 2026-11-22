// Test E2E de l'archivage de dossiers (F-60 — Bibliothèque) : archive et
// désarchive via projects:setArchived, propagation au sous-arbre, conversations
// INTACTES (ni déplacées ni supprimées — c'est la différence avec la
// suppression), suppression d'un dossier archivé, validation du payload.
// Complète test-projects-nested-flow.ts (F-59) et test-projects-flow.ts.
import { io } from "socket.io-client";

const socket = io("http://localhost:3003", { transports: ["websocket"] });
const seen: string[] = [];
let failures = 0;

function log(s: string) {
  seen.push(s);
  console.log("  " + s);
}

function check(label: string, ok: boolean, extra = "") {
  if (ok) log(`OK  ${label}${extra ? ` — ${extra}` : ""}`);
  else {
    failures++;
    log(`ÉCHEC  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function emit(event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (res: any) => resolve(res ?? {}));
    else socket.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

async function main() {
  // 1. Fixture : racine + sous-dossier + deux conversations
  const root = await emit("projects:create", { name: "Archives F60" });
  check("racine créée", !!root.project?.id);
  const sub = await emit("projects:create", { name: "Sous F60", parentId: root.project.id });
  check("sous-dossier créé", !!sub.project?.id);
  const convSub = await emit("conversations:create", { projectId: sub.project.id });
  const convRoot = await emit("conversations:create", { projectId: root.project.id });

  // 2. Validation du payload : id manquant, archived manquant
  const bad1 = await emit("projects:setArchived", { archived: true });
  check("id manquant refusé", !!bad1.error, bad1.error);
  const bad2 = await emit("projects:setArchived", { id: root.project.id });
  check("archived manquant refusé", !!bad2.error, bad2.error);
  const bad3 = await emit("projects:setArchived", { id: "inexistant", archived: true });
  check("dossier inconnu refusé", !!bad3.error, bad3.error);

  // 3. Archivage de la racine : propagé au sous-dossier, conversations intactes
  const arch = await emit("projects:setArchived", { id: root.project.id, archived: true });
  check("projects:setArchived ok", !!arch.project?.archived, JSON.stringify(arch.project?.archived));
  check("le broadcast emporte la liste complète", Array.isArray(arch.projects));
  const list1 = await emit("projects:list");
  const r1 = list1.projects.find((p: any) => p.id === root.project.id);
  const s1 = list1.projects.find((p: any) => p.id === sub.project.id);
  check("racine archivée en liste", r1?.archived === true);
  check("sous-dossier archivé par propagation", s1?.archived === true);
  const convs1 = await emit("conversations:list");
  const c1 = convs1.conversations.find((c: any) => c.id === convSub.conversation.id);
  const c2 = convs1.conversations.find((c: any) => c.id === convRoot.conversation.id);
  check("conversation du sous-dossier INTACTE", c1?.projectId === sub.project.id);
  check("conversation de la racine INTACTE", c2?.projectId === root.project.id);

  // 4. Désarchivage : tout le sous-arbre revient
  const rest = await emit("projects:setArchived", { id: root.project.id, archived: false });
  check("désarchivage ok", rest.project?.archived === false);
  const list2 = await emit("projects:list");
  const s2 = list2.projects.find((p: any) => p.id === sub.project.id);
  check("sous-dossier désarchivé par propagation", s2?.archived === false);

  // 5. Sous-dossier archivé SEUL : la racine reste active
  const archSub = await emit("projects:setArchived", { id: sub.project.id, archived: true });
  check("sous-dossier archivé seul", archSub.project?.archived === true);
  const list3 = await emit("projects:list");
  const r3 = list3.projects.find((p: any) => p.id === root.project.id);
  check("la racine reste active", r3?.archived === false);

  // 6. Suppression d'un dossier archivé (garde + promotion inchangées)
  const del = await emit("projects:delete", { id: sub.project.id });
  check("dossier archivé supprimé", del.ok === true);
  const convs2 = await emit("conversations:list");
  const c4 = convs2.conversations.find((c: any) => c.id === convSub.conversation.id);
  check("sa conversation retombe dans Sans dossier", c4?.projectId == null);

  // 7. Nettoyage
  await emit("conversations:delete", { id: convSub.conversation.id });
  await emit("conversations:delete", { id: convRoot.conversation.id });
  await emit("projects:delete", { id: root.project.id });
  const listEnd = await emit("projects:list");
  const leftovers = listEnd.projects.filter((p: any) => p.name.includes("F60"));
  check("aucun dossier de test restant", leftovers.length === 0, `${leftovers.length} restant(s)`);
  log("nettoyage effectué");

  console.log(
    failures === 0
      ? "\nSUCCÈS — flux archivage F-60 validé"
      : `\n${failures} échec(s) — flux archivage incomplet`
  );
  socket.close();
  process.exit(failures === 0 ? 0 : 1);
}

socket.on("connect", () => void main());
socket.on("connect_error", (e: Error) => {
  console.error(
    "Connexion impossible (service démarré ? bun run dev dans mini-services/hermes-chat) :",
    e.message
  );
  process.exit(1);
});

setTimeout(() => {
  console.log("TIMEOUT — événements vus :");
  seen.forEach((s) => console.log(" ", s));
  process.exit(1);
}, 30000);
