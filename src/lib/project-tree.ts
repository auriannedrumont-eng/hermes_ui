// Helpers purs de l'arbre de dossiers (F-59) — R1 : nouveautés dans un
// fichier neuf, testables sans service (scripts/test-project-tree.ts).
//
// Rappel de conception (plan d'implémentation §4.1) : la position reste
// GLOBALE côté service (projects:reorder ré-indexe 0..n-1 la liste plate) ;
// l'arbre se reconstruit à l'affichage. Un seul niveau d'imbrication : un
// sous-dossier ne peut jamais être parent.
import type { Project } from "@/lib/chat-types";

/** Nœud d'arbre : un dossier racine et ses sous-dossiers directs. */
export interface ProjectNode {
  project: Project;
  children: Project[];
}

/** Construit l'arbre depuis la liste plate : racines et enfants chacun
 *  ordonnés par `position` (le service garantit des positions globales
 *  croissantes ; on trie quand même — l'appelant ne doit pas avoir à
 *  pré-trier). */
export function buildProjectTree(projects: Project[]): ProjectNode[] {
  const byPosition = (a: Project, b: Project) =>
    a.position - b.position || a.createdAt.localeCompare(b.createdAt);
  const childrenOf = new Map<string, Project[]>();
  const roots: Project[] = [];
  // Filet de sécurité (revue P1-P7, B18) : un enfant dont le parent est
  // ABSENT de la liste (parent encore archivé, enfant déjà désarchivé)
  // est rattaché aux racines — l'ancien code le laissait dans
  // childrenOf sans jamais l'atteindre : dossier et conversations
  // invisibles de toute la sidebar.
  const présents = new Set(projects.map((p) => p.id));
  for (const p of projects) {
    if (p.parentId && présents.has(p.parentId)) {
      const list = childrenOf.get(p.parentId) ?? [];
      list.push(p);
      childrenOf.set(p.parentId, list);
    } else {
      roots.push(p);
    }
  }
  return roots.sort(byPosition).map((project) => ({
    project,
    children: (childrenOf.get(project.id) ?? []).sort(byPosition),
  }));
}

/** Ids du dossier et de ses sous-dossiers (un niveau) — garde de suppression
 *  (compter toutes les conversations, cas limite plan §6.4) et dnd. */
export function subtreeIds(id: string, projects: Project[]): Set<string> {
  const ids = new Set<string>([id]);
  for (const p of projects) {
    if (p.parentId && ids.has(p.parentId)) ids.add(p.id);
  }
  return ids;
}

/** `projectId` est-il le dossier lui-même ou un de ses sous-dossiers ?
 *  (dnd : interdire le dépôt d'un dossier sur lui-même ou son descendant.) */
export function isSameOrDescendant(
  projectId: string,
  ancestorId: string,
  projects: Project[]
): boolean {
  return subtreeIds(ancestorId, projects).has(projectId);
}

/** Liste plate (parcours en profondeur : racine puis ses enfants) à envoyer à
 *  `projects:reorder` — le service ré-indexe les positions 0..n-1 et le tri
 *  à l'affichage restitue l'arbre. Préserve l'ordre de tout ce qui n'a pas
 *  bougé : construire TOUJOURS depuis l'arbre courant, jamais depuis les ids
 *  déplacés seuls (cas limite plan §6.1). */
export function flattenProjectTree(nodes: ProjectNode[]): string[] {
  const out: string[] = [];
  const walk = (list: ProjectNode[]) => {
    for (const n of list) {
      out.push(n.project.id);
      walk(
        n.children.map((c) => ({ project: c, children: [] as Project[] }))
      );
    }
  };
  walk(nodes);
  return out;
}
