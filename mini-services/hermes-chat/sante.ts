// Manifeste de santé du lanceur (§10 refonte (68), loi « une seule vérité »).
// Le lanceur écrit desktop/runtime/sante.json à chaque phase du démarrage
// (prérequis ✓/✗, état de l'agent, maillons, verdict) ; le service le lit
// ici et le diffuse (/diagnostics + system:update-state) — la fenêtre du
// lanceur et l'écran Système racontent enfin la même histoire.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SantePrerequis {
  nom: string;
  ok: boolean;
  note: string;
}
export interface SanteManifeste {
  horodatage: string;
  commit: string;
  pret: string;
  cause: string;
  prerequis: SantePrerequis[];
  agent: { etat: string; cause: string };
  maillons: { service: string; interface: string; passerelle: string; agent: string };
}

const chemin = join(import.meta.dir, "..", "..", "..", "desktop", "runtime", "sante.json");
let cache: { doc: SanteManifeste | null; lu: number } = { doc: null, lu: 0 };

/** Lit le manifeste du dernier démarrage (recache si le fichier a changé).
 *  Absent ou illisible → null honnête : l'écran Système n'invente rien. */
export function readSanteManifeste(): SanteManifeste | null {
  try {
    const mtime = statSync(chemin).mtimeMs;
    if (mtime !== cache.lu) {
      cache = { doc: JSON.parse(readFileSync(chemin, "utf8")) as SanteManifeste, lu: mtime };
    }
    return cache.doc;
  } catch {
    return null;
  }
}
