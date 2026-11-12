// Test E2E du flux projets : création, renommage, rangement, réordonnancement,
// suppression (retombée « Sans projet ») + réglages serveur persistés.
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
  // 1. Liste initiale
  const list0 = await emit("projects:list");
  check("projects:list", Array.isArray(list0.projects), `${list0.projects.length} projet(s)`);

  // 2. Création de deux projets
  const a = await emit("projects:create", { name: "Projet Alpha" });
  const b = await emit("projects:create", { name: "Projet Beta" });
  check("projects:create Alpha", !!a.project, a.project?.id);
  check("projects:create Beta", !!b.project, b.project?.id);
  check("positions croissantes", a.project.position < b.project.position, `${a.project.position} < ${b.project.position}`);

  // 3. Nom vide refusé
  const bad = await emit("projects:create", { name: "   " });
  check("nom vide refusé", !!bad.error, bad.error);

  // 4. Conversation créée directement dans Alpha
  const conv = await emit("conversations:create", { projectId: a.project.id });
  check("conversation dans Alpha", conv.conversation?.projectId === a.project.id, conv.conversation?.id);

  // 5. Compat ancien appel : emit(event, cb) sans payload
  const conv2 = await emit("conversations:create");
  check("compat create sans payload", conv2.conversation?.projectId == null, conv2.conversation?.id);

  // 6. Déplacement vers Beta puis retour « Sans projet »
  const moved = await emit("conversations:move", { id: conv.conversation.id, projectId: b.project.id });
  check("move vers Beta", moved.conversation?.projectId === b.project.id);
  const back = await emit("conversations:move", { id: conv.conversation.id, projectId: null });
  check("move vers Sans projet", back.conversation?.projectId == null);
  const badMove = await emit("conversations:move", { id: conv.conversation.id, projectId: "inexistant" });
  check("move vers projet inconnu refusé", !!badMove.error, badMove.error);

  // 7. Renommage
  const renamed = await emit("projects:rename", { id: a.project.id, name: "Projet Alpha 2" });
  check("projects:rename", renamed.project?.name === "Projet Alpha 2");

  // 8. La liste des conversations expose projectId
  const convs = await emit("conversations:list");
  const withProject = convs.conversations.find((c: any) => c.id === conv.conversation.id);
  check("conversations:list expose projectId", withProject?.projectId == null, JSON.stringify(withProject?.projectId));

  // 9. Réordonnancement (Beta avant Alpha)
  const reordered = await emit("projects:reorder", { ids: [b.project.id, a.project.id] });
  const posB = reordered.projects.find((p: any) => p.id === b.project.id)?.position;
  const posA = reordered.projects.find((p: any) => p.id === a.project.id)?.position;
  check("projects:reorder", posB === 0 && posA === 1, `Beta=${posB}, Alpha=${posA}`);

  // 10. Réglages serveur persistés
  const set1 = await emit("settings:set", { key: "fork.test", value: "v1" });
  check("settings:set", set1.ok === true);
  const get1 = await emit("settings:get", { key: "fork.test" });
  check("settings:get", get1.value === "v1", get1.value);
  const set2 = await emit("settings:set", { key: "fork.test", value: "v2" });
  const get2 = await emit("settings:get", { key: "fork.test" });
  check("settings:set écrase", get2.value === "v2", get2.value);

  // 11. Suppression de Beta : ses conversations retombent dans « Sans projet »
  const moved2 = await emit("conversations:move", { id: conv.conversation.id, projectId: b.project.id });
  check("pré-suppression : conv dans Beta", moved2.conversation?.projectId === b.project.id);
  const del = await emit("projects:delete", { id: b.project.id });
  check("projects:delete", del.ok === true);
  const convs2 = await emit("conversations:list");
  const after = convs2.conversations.find((c: any) => c.id === conv.conversation.id);
  check("conv retombe dans Sans projet", after?.projectId == null, JSON.stringify(after?.projectId));
  const listEnd = await emit("projects:list");
  check("Beta disparu de la liste", !listEnd.projects.some((p: any) => p.id === b.project.id));

  // 12. Nettoyage : conversation de test + projet Alpha + réglage de test
  await emit("conversations:delete", { id: conv.conversation.id });
  await emit("conversations:delete", { id: conv2.conversation.id });
  await emit("projects:delete", { id: a.project.id });
  await emit("settings:set", { key: "fork.test", value: "" });
  log("nettoyage effectué");

  console.log(
    failures === 0
      ? "\nSUCCÈS — flux projets + réglages validé"
      : `\n${failures} échec(s) — flux incomplet`
  );
  socket.close();
  process.exit(failures === 0 ? 0 : 1);
}

socket.on("connect", () => void main());
socket.on("connect_error", (e: Error) => {
  console.error("Connexion impossible (service démarré ? bun run dev dans mini-services/hermes-chat) :", e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("TIMEOUT — événements vus :");
  seen.forEach((s) => console.log(" ", s));
  process.exit(1);
}, 30000);
