// Seed de démonstration : 2 projets + quelques conversations rangées.
import { io } from "socket.io-client";

const socket = io("http://localhost:3003", { transports: ["websocket"] });

function emit(event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (res: any) => resolve(res ?? {}));
    else socket.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

async function main() {
  const existing = await emit("projects:list");
  for (const p of existing.projects ?? []) await emit("projects:delete", { id: p.id });

  const p1 = await emit("projects:create", { name: "Refonte site vitrine" });
  const p2 = await emit("projects:create", { name: "Benchmark rendu HTML" });
  console.log("projets :", p1.project?.name, "|", p2.project?.name);

  const convs = await emit("conversations:list");
  const all = (convs.conversations ?? []) as any[];
  console.log(`${all.length} conversations au total`);

  // Range les 3 premières dans le projet 1, les 2 suivantes dans le projet 2,
  // épingle la première du projet 1, et replie le projet 2 côté UI via le
  // réglage client (géré par la sidebar elle-même).
  for (const c of all.slice(0, 3)) {
    await emit("conversations:move", { id: c.id, projectId: p1.project.id });
  }
  await emit("conversations:pin", { id: all[0].id, pinned: true });
  for (const c of all.slice(3, 5)) {
    await emit("conversations:move", { id: c.id, projectId: p2.project.id });
  }
  const final = await emit("conversations:list");
  const inP1 = (final.conversations ?? []).filter((c: any) => c.projectId === p1.project.id).length;
  const inP2 = (final.conversations ?? []).filter((c: any) => c.projectId === p2.project.id).length;
  const none = (final.conversations ?? []).filter((c: any) => !c.projectId).length;
  console.log(`rangées : ${inP1} dans P1, ${inP2} dans P2, ${none} sans projet`);
  socket.close();
  process.exit(0);
}

socket.on("connect", () => void main());
setTimeout(() => process.exit(1), 15000);
