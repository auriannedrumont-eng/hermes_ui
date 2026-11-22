// Test unitaire autonome des helpers de l'arbre de dossiers (F-59) —
// sans service ni navigateur : src/lib/project-tree.ts est pur.
// Convention de la suite : exit 0 = tout passe, exit 1 = échec.

import {
  buildProjectTree,
  flattenProjectTree,
  isSameOrDescendant,
  subtreeIds,
} from "../src/lib/project-tree";
import type { Project } from "../src/lib/chat-types";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  if (ok) console.log(`OK  ${label}${extra ? ` — ${extra}` : ""}`);
  else {
    failures++;
    console.log(`ÉCHEC  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function proj(id: string, name: string, position: number, parentId?: string | null): Project {
  return {
    id,
    name,
    position,
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:00.000Z",
    parentId: parentId ?? null,
    diskPath: null,
  };
}

const list = [
  proj("r2", "Racine B", 1),
  proj("s1", "Sous A1", 2, "r1"), // enfant de r1 (position globale 2)
  proj("r1", "Racine A", 0),
  proj("s2", "Sous A2", 3, "r1"),
];

// 1. Arbre : racines ordonnées par position, enfants sous leur parent
const tree = buildProjectTree(list);
check("2 racines", tree.length === 2, tree.map((n) => n.project.id).join(","));
check("racine A avant B (position)", tree[0].project.id === "r1" && tree[1].project.id === "r2");
check("r1 a 2 enfants", tree[0].children.length === 2, tree[0].children.map((c) => c.id).join(","));
check("enfants ordonnés (position globale)", tree[0].children[0].id === "s1" && tree[0].children[1].id === "s2");
check("r2 sans enfant", tree[1].children.length === 0);

// 2. Sous-dossier de sous-dossier (liste invalide) : jamais rendu, jamais crash
const deep = buildProjectTree([
  proj("r1", "Racine", 0),
  proj("s1", "Sous", 1, "r1"),
  proj("ss", "Sous-sous", 2, "s1"),
]);
check("imbrication invalide invisible (pas de crash)", deep.length === 1 && deep[0].children.length === 1);

// 3. subtreeIds : le dossier + ses sous-dossiers (garde de suppression)
const ids = subtreeIds("r1", list);
check("subtreeIds contient le dossier", ids.has("r1"));
check("subtreeIds contient les 2 sous-dossiers", ids.has("s1") && ids.has("s2"));
check("subtreeIds ne contient pas l'autre racine", !ids.has("r2"));

// 4. isSameOrDescendant : garde dnd (dépôt sur soi ou son descendant)
check("dépot sur soi refusé", isSameOrDescendant("r1", "r1", list));
check("dépot sur son sous-dossier refusé", isSameOrDescendant("s1", "r1", list));
check("dépot sur l'autre racine autorisé", !isSameOrDescendant("r1", "r2", list));
check("dépot d'une racine dans un sous-dossier autorisé (pas un descendant)", !isSameOrDescendant("r1", "s1", list));

// 5. flattenProjectTree : parcours en profondeur (racine puis enfants) —
// la liste plate pour projects:reorder conserve tout ce qui n'a pas bougé.
const flat = flattenProjectTree(tree);
check(
  "ordre plat profondeur",
  flat.join(",") === "r1,s1,s2,r2",
  flat.join(",")
);
const flatReversedRoots = flattenProjectTree([tree[1], tree[0]]);
check(
  "ordre plat suit l'ordre des racines",
  flatReversedRoots.join(",") === "r2,r1,s1,s2",
  flatReversedRoots.join(",")
);

// 6. Compteur : les conversations directes se comptent côté appelant —
// ici on valide juste que l'arbre n'agrège PAS les petits-enfants.
check(
  "arbre à un niveau (pas d'aplatissement caché)",
  tree.every((n) => n.children.every((c) => !("children" in c) || !Array.isArray((c as unknown as { children?: unknown }).children))),
);

console.log(
  failures === 0
    ? "\nSUCCÈS — helpers d'arbre F-59 validés"
    : `\n${failures} échec(s) — helpers d'arbre incomplets`
);
process.exit(failures === 0 ? 0 : 1);
