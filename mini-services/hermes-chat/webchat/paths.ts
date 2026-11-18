// Garde de chemin (spec §5.10) — les noms de fichiers viennent du réseau :
// ils ne sont JAMAIS de confiance. Un nom qui sortirait du dossier de sortie
// est refusé et rapporté, jamais écrit. (Critère d'acceptation §7.3.)

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Ne garde que le dernier segment : le nom vient du paramètre `path=` de
 *  l'URL distante, jamais utilisé tel quel. */
export function safeBasename(name: string): string {
  const base = basename(String(name ?? "").trim());
  // Vide, points seuls, séparateurs déguisés → nom générique explicite.
  if (!base || base === "." || base === ".." || base.startsWith(".")) {
    return "";
  }
  return base.replace(/[\u0000-\u001f]/g, "");
}

/**
 * Résout `name` sous `outDir` et vérifie que le chemin RÉSOLU reste sous le
 * dossier (realpath + comparaison de segments). Retourne le chemin sûr, ou
 * null si le nom est refusé (sortie du dossier, traversée de lien, nom vide).
 */
export function resolveUnder(outDir: string, name: string): string | null {
  const base = safeBasename(name);
  if (!base) return null;
  if (isAbsolute(name)) return null;
  // Le dossier de sortie existe-t-il déjà ? Si oui, on le résout vers son
  // chemin RÉEL (casse canonique du disque, jonctions et lecteurs subst
  // résolus) : sous Windows, path.resolve() ne normalise QUE des antislashs
  // et conserve la casse saisie, ce qui rendait les comparaisonsstartsWith
  // fragiles ; realpathSync règle les deux problèmes d'un coup.
  mkdirSync(outDir, { recursive: true });
  const root = existsSync(outDir) ? realpathSync(outDir) : resolve(outDir);
  const target = resolve(join(root, base));
  // Appartenance vérifiée par path.relative : insensible aux séparateurs,
  // à la casse disque et aux préfixes frères (...\webchat-out vs
  // ...\webchat-out-autre). rel === "" (la racine) est refusé : on n'écrit
  // jamais un dossier lui-même.
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  // Si un parent intermédiaire existe déjà, vérifier qu'aucun n'est un lien
  // qui sortirait de la racine (realpath du parent résolu).
  const parent = dirname(target);
  if (existsSync(parent)) {
    const realParent = realpathSync(parent);
    const relParent = relative(root, resolve(realParent));
    if (
      !relParent ||
      relParent === ".." ||
      relParent.startsWith(`..${sep}`) ||
      isAbsolute(relParent)
    ) {
      return null;
    }
  }
  return target;
}

/**
 * Vérifie chaque destination puis écrit les OCTETS (jamais du texte décodé :
 * un binaire traversé par de l'UTF-8 est corrompu — spec Annexe A §11).
 * Retourne la liste des écrits et des refus, pour le rapport JSON.
 */
export function writeGuarded(
  outDir: string,
  files: { name: string; base64: string }[]
): {
  written: { name: string; path: string; bytes: number }[];
  refused: { name: string; reason: string }[];
} {
  const written: { name: string; path: string; bytes: number }[] = [];
  const refused: { name: string; reason: string }[] = [];
  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const target = resolveUnder(outDir, f.name);
    if (!target) {
      refused.push({
        name: String(f.name ?? "").slice(0, 120),
        reason: "nom refusé par la garde de chemin (sortie du dossier de sortie)",
      });
      continue;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(f.base64, "base64");
    } catch {
      refused.push({ name: f.name, reason: "contenu base64 illisible" });
      continue;
    }
    try {
      // Dernier contrôle après création du dossier : appartenance de la
      // cible au dossier RÉEL, via path.relative (séparateurs et casse).
      const finalRoot = realpathSync(outDir);
      const relFinal = relative(finalRoot, resolve(target));
      if (
        !relFinal ||
        relFinal === ".." ||
        relFinal.startsWith(`..${sep}`) ||
        isAbsolute(relFinal)
      ) {
        refused.push({ name: f.name, reason: "destination résolue hors du dossier" });
        continue;
      }
      writeBytes(target, buf);
      written.push({ name: f.name, path: target, bytes: buf.byteLength });
    } catch (err) {
      refused.push({
        name: f.name,
        reason: err instanceof Error ? err.message : "écriture impossible",
      });
    }
  }
  return { written, refused };
}

function writeBytes(path: string, buf: Buffer): void {
  writeFileSync(path, buf);
}
