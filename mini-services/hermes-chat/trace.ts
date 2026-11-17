// Pont de diagnostic (F-31) — journal tournant des événements du service.
//
// Chaque étape notable (tour démarré, voix orchestrée, pilote webchat,
// erreur) est consignée EN MÉMOIRE dans un anneau borné. GET /diagnostics
// (port 3004) renvoie ce journal avec l'état du service : l'interface
// (panneau ?debug=1, bouton « Copier le diagnostic ») peut alors produire
// un rapport à coller à l'agent qui dépanne — sans accès au terminal,
// sans secret (jamais de contenu de message, jamais de clé).
//
// Rien n'est écrit sur disque : le journal vit avec le processus, il
// repart de zéro à chaque lancement (comme les logs du terminal).

import { spawnSync } from "node:child_process";

export interface TraceEvent {
  /** Horodatage epoch ms. */
  t: number;
  /** Catégorie : turn · orch · webchat · pool · socket · error · boot. */
  cat: string;
  /** Une ligne, sans données personnelles (tronquée à 220 caractères). */
  msg: string;
}

const CAPACITY = 400;
const MSG_MAX = 220;
const ring: TraceEvent[] = [];

export const TRACE_BOOT_AT = Date.now();

/** Commit du dépôt au lancement (null hors git) — répond à « mon instance
 *  tourne-t-elle sur le code corrigé ? », première question de tout dépannage. */
const BOOT_COMMIT: string | null = (() => {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dir,
      encoding: "utf-8",
      timeout: 3000,
    });
    const sha = r.status === 0 ? String(r.stdout || "").trim() : "";
    return /^[0-9a-f]{7,12}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
})();

/** Consigne un événement (jamais bloquant, jamais d'exception vers l'appelant). */
export function trace(cat: string, msg: string): void {
  try {
    const clean = String(msg).replace(/\s+/g, " ").trim().slice(0, MSG_MAX);
    ring.push({ t: Date.now(), cat, msg: clean || "(vide)" });
    if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY);
    if (cat === "error") console.error(`[trace] ${clean}`);
  } catch {
    /* le pont ne doit jamais faire tomber le service */
  }
}

/** Métadonnées du service (entête du rapport de diagnostic). */
export function traceMeta(): {
  commit: string | null;
  bootAt: string;
  uptimeS: number;
  events: number;
  capacity: number;
} {
  return {
    commit: BOOT_COMMIT,
    bootAt: new Date(TRACE_BOOT_AT).toISOString(),
    uptimeS: Math.round((Date.now() - TRACE_BOOT_AT) / 1000),
    events: ring.length,
    capacity: CAPACITY,
  };
}

/** Derniers événements (du plus ancien au plus récent). */
export function traceDump(limit = 150): TraceEvent[] {
  return ring.slice(-Math.max(1, Math.min(limit, CAPACITY)));
}
