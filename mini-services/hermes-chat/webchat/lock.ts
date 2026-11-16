// Verrou mono-pilote (spec §2.3) — deux pilotes simultanés se coupent la
// parole dans la même page. Le verrou est un fichier + pid : un verrou laissé
// par un processus MORT doit être repris, sinon un plantage bloque la machine
// pour toujours. Le titulaire est nommé dans l'erreur du perdant (critère
// d'acceptation §7.4 : le second s'arrête proprement en nommant le premier).

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

export interface LockInfo {
  pid: number;
  site: string;
  mode: string;
  startedAt: string;
}

/** Le pid détient-il encore un processus vivant ? (0 = toujours vivant — soi-même). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 : ne tue rien, signale juste l'existence du processus.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true; // vivant mais protégé
    return false; // ESRCH = aucun processus
  }
}

function parseLock(raw: string): LockInfo | null {
  try {
    const info = JSON.parse(raw) as LockInfo;
    if (typeof info?.pid !== "number") return null;
    return info;
  } catch {
    return null; // fichier corrompu : repris comme un verrou mort
  }
}

export class DriverLock {
  private path: string;
  private acquired = false;

  constructor(lockPath: string) {
    this.path = lockPath;
  }

  /**
   * Acquiert le verrou. Retourne null si acquis, sinon l'info du titulaire
   * vivant qui le détient. Un verrou stale (processus mort, JSON illisible,
   * fichier de plus de 30 min sans renouvellement) est repris sans état d'âme.
   */
  acquire(site: string, mode: string): LockInfo | null {
    if (this.acquired) return null;
    // 1. Verrou présent ?
    if (existsSync(this.path)) {
      let info: LockInfo | null = null;
      let stale = false;
      try {
        info = parseLock(readFileSync(this.path, "utf-8"));
        // Verrou non renouvelé depuis 30 min : le pilote est planté depuis
        // longtemps (le pilote vivant le touche à chaque état).
        const ageMs = Date.now() - statSync(this.path).mtimeMs;
        stale = ageMs > 30 * 60_000;
      } catch {
        stale = true;
      }
      if (info && pidAlive(info.pid) && !stale) {
        return info; // tenu par un vivant → sortie propre, en le nommant
      }
      // Processus mort ou verrou périmé : reprise.
      try {
        rmSync(this.path, { force: true });
      } catch {
        /* le fichier repartira à l'écriture */
      }
    }
    // 2. Écriture atomique simple : le fichier EST le verrou (un seul disque).
    const mine: LockInfo = {
      pid: process.pid,
      site,
      mode,
      startedAt: new Date().toISOString(),
    };
    try {
      // "wx" : échoue si le fichier vient d'apparaître (course entre pilotes).
      writeFileSync(this.path, JSON.stringify(mine), { flag: "wx" });
    } catch {
      // Un concurrent a gagné la course : relisons-le honnêtement.
      try {
        const other = parseLock(readFileSync(this.path, "utf-8"));
        if (other && pidAlive(other.pid)) return other;
      } catch {
        /* retombe sur l'échec générique */
      }
      return { pid: -1, site: "?", mode: "?", startedAt: "?" };
    }
    this.acquired = true;
    return null;
  }

  /** Renvoie la fiche du titulaire (pour le message d'erreur du perdant). */
  readHolder(): LockInfo | null {
    try {
      return parseLock(readFileSync(this.path, "utf-8"));
    } catch {
      return null;
    }
  }

  /** Touche le verrou (renouvellement — le veilleur et les longues générations). */
  touch(): void {
    if (!this.acquired) return;
    try {
      const info = this.readHolder();
      if (info && info.pid === process.pid) {
        writeFileSync(this.path, JSON.stringify(info));
      }
    } catch {
      /* au prochain touch */
    }
  }

  release(): void {
    if (!this.acquired) return;
    this.acquired = false;
    try {
      const info = this.readHolder();
      // On ne retire que SON verrou — jamais celui d'un autre pilote.
      if (info && info.pid === process.pid) rmSync(this.path, { force: true });
    } catch {
      /* déjà parti */
    }
  }
}
