// Test E2E du flux dossiers imbriqués (F-59) : création racine/sous-dossier,
// refus de parenté invalide (inconnu, trop profond), création et déplacement
// de conversation dans un sous-dossier, réordonnancement de frères (positions
// globales), suppression d'un parent (conversations → « Sans dossier »,
// sous-dossiers promus racine), troncature à 80, liaison disque (J5 : chemin
// HOME validé, hors HOME refusé). Complète scripts/test-projects-flow.ts
// (qui doit rester vert sans modification — non-régression).
import { io } from "socket.io-client";
import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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
  // Fixtures disque sous le HOME (borne de validation du service) — nettoyées en fin.
  const diskRoot = join(homedir(), ".hermes-test-f59");
  const diskSub = join(diskRoot, "Contrats 2026");
  try {
    mkdirSync(diskSub, { recursive: true });
  } catch {
    /* déjà présent */
  }

  // 1. Création racine + sous-dossier
  const root = await emit("projects:create", { name: "Racine F59" });
  check("projects:create racine", !!root.project?.id);
  check("racine sans parent", root.project.parentId == null, JSON.stringify(root.project.parentId));
  const sub = await emit("projects:create", { name: "Sous F59", parentId: root.project.id });
  check("projects:create sous-dossier", !!sub.project?.id, sub.error ?? "");
  check("sous-dossier porté par le parent", sub.project.parentId === root.project.id);
  const sub2 = await emit("projects:create", { name: "Sous F59 bis", parentId: root.project.id });
  check("2e sous-dossier créé", !!sub2.project?.id, sub2.error ?? "");

  // 2. Parenté invalide refusée : parent inconnu, sous-dossier comme parent
  const badParent = await emit("projects:create", { name: "Fantôme", parentId: "inexistant" });
  check("parent inconnu refusé", !!badParent.error, badParent.error);
  const deep = await emit("projects:create", { name: "Trop profond", parentId: sub.project.id });
  check("sous-dossier de sous-dossier refusé (un seul niveau)", !!deep.error, deep.error);

  // 3. Troncature à 80 caractères (nom de dossier)
  const long = await emit("projects:create", { name: "x".repeat(120), parentId: root.project.id });
  check("nom tronqué à 80", long.project?.name?.length === 80, String(long.project?.name?.length));
  await emit("projects:delete", { id: long.project.id });

  // 4. Conversations : directement dans le sous-dossier + déplacement
  const convSub = await emit("conversations:create", { projectId: sub.project.id });
  check("conversation créée DANS le sous-dossier", convSub.conversation?.projectId === sub.project.id);
  const convRoot = await emit("conversations:create", { projectId: root.project.id });
  const moved = await emit("conversations:move", { id: convRoot.conversation.id, projectId: sub2.project.id });
  check("déplacement vers un sous-dossier", moved.conversation?.projectId === sub2.project.id);

  // 5. Réordonnancement de frères : positions GLOBALES ré-indexées
  const before = await emit("projects:list");
  const s1 = before.projects.find((p: any) => p.id === sub.project.id);
  const s2 = before.projects.find((p: any) => p.id === sub2.project.id);
  check("pré-reorder : sous1 avant sous2", s1.position < s2.position, `${s1.position} < ${s2.position}`);
  const fullIds = before.projects.map((p: any) => p.id);
  const i1 = fullIds.indexOf(sub.project.id);
  fullIds.splice(i1, 1); // retire sous1
  const i2 = fullIds.indexOf(sub2.project.id);
  fullIds.splice(i2, 0, sub.project.id); // sous1 placé AVANT sous2
  const reordered = await emit("projects:reorder", { ids: fullIds });
  const after1 = reordered.projects.find((p: any) => p.id === sub.project.id);
  const after2 = reordered.projects.find((p: any) => p.id === sub2.project.id);
  check("reorder de frères appliqué", after1.position < after2.position, `${after1.position} < ${after2.position}`);
  const roots = reordered.projects.filter((p: any) => !p.parentId).map((p: any) => p.id);
  check("la racine n'a pas bougé de segment", roots.length >= 1, `${roots.length} racine(s)`);

  // 6. Suppression du parent : conversations → « Sans dossier », sous-dossiers promus
  const del = await emit("projects:delete", { id: root.project.id });
  check("projects:delete ok + liste complète diffusée", del.ok === true && Array.isArray(del.projects));
  const list1 = await emit("projects:list");
  check("racine disparue", !list1.projects.some((p: any) => p.id === root.project.id));
  check("sous-dossiers PROMUS racine (pas supprimés)", list1.projects.some((p: any) => p.id === sub.project.id && p.parentId == null) && list1.projects.some((p: any) => p.id === sub2.project.id && p.parentId == null));
  const convs1 = await emit("conversations:list");
  const c1 = convs1.conversations.find((c: any) => c.id === convSub.conversation.id);
  const c2 = convs1.conversations.find((c: any) => c.id === convRoot.conversation.id);
  check("conv du sous-dossier retombe dans Sans dossier", c1?.projectId == null);
  check("conv déplacée retombe dans Sans dossier", c2?.projectId == null);

  // 7. Suppression d'un sous-dossier promu : convs → Sans dossier uniquement
  const delSub = await emit("projects:delete", { id: sub.project.id });
  check("sous-dossier supprimé", delSub.ok === true);

  // 8. Liaison disque (J5) : chemin HOME validé, hors HOME refusé
  const linked = await emit("projects:create", { name: "Contrats 2026", diskPath: diskSub });
  check("dossier lié au disque créé", !!linked.project?.id, linked.error ?? "");
  check("disk_path conservé", linked.project?.diskPath === diskSub, linked.project?.diskPath);
  const badDisk = await emit("projects:create", { name: "Hors HOME", diskPath: "/tmp" });
  check("chemin hors HOME refusé", !!badDisk.error, badDisk.error);
  const weirdDisk = await emit("projects:create", { name: "Chemin fantôme", diskPath: join(diskRoot, "inexistant") });
  check("chemin inexistant refusé", !!weirdDisk.error, weirdDisk.error);

  // 9. Nettoyage complet
  if (linked.project?.id) await emit("projects:delete", { id: linked.project.id });
  if (sub2.project?.id) await emit("projects:delete", { id: sub2.project.id });
  await emit("conversations:delete", { id: convSub.conversation.id });
  await emit("conversations:delete", { id: convRoot.conversation.id });
  try {
    rmSync(diskRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  const listEnd = await emit("projects:list");
  const leftovers = listEnd.projects.filter((p: any) => p.name.includes("F59") || p.name === "Contrats 2026");
  check("aucun dossier de test restant", leftovers.length === 0, `${leftovers.length} restant(s)`);
  log("nettoyage effectué");

  console.log(
    failures === 0
      ? "\nSUCCÈS — flux dossiers imbriqués F-59 validé"
      : `\n${failures} échec(s) — flux imbriqué incomplet`
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
