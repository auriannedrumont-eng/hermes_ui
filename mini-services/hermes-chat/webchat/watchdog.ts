// Veilleur détaché (spec §2.5) — ferme le navigateur de pilotage après
// quelques minutes d'inactivité ; le pilote suivant le relance. Processus
// séparé du pilote : il survit à la fin du sous-processus de tour.
//
// Sécurité : le kill n'a lieu que si le pid est enregistré par ce module ET
// que sa ligne de commande porte le --user-data-dir du profil applicatif
// (isAppBrowserPid) — le navigateur personnel ne peut jamais être visé.

import { existsSync, statSync } from "node:fs";
import { activityPath, killPilotBrowser, readPilotInfo } from "./browser";

function argOf(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const profileDir = argOf("--profile");
const idleMin = Number(argOf("--idle-min") ?? "5");

if (!profileDir || !Number.isFinite(idleMin) || idleMin <= 0) {
  process.exit(2);
}

const IDLE_MS = idleMin * 60_000;
const POLL_MS = 30_000;

async function tick(): Promise<void> {
  const info = readPilotInfo(profileDir);
  if (!info || info.pid <= 0) {
    process.exit(0); // rien à surveiller : le veilleur se retire
  }
  let lastActivity = 0;
  const actPath = activityPath(profileDir);
  if (existsSync(actPath)) {
    try {
      lastActivity = statSync(actPath).mtimeMs;
    } catch {
      lastActivity = 0;
    }
  }
  // Naissance du registre = autre signal d'activité (lancement récent).
  const bornAt = Date.parse(info.startedAt ?? "") || 0;
  const active = Math.max(lastActivity, bornAt);
  if (Date.now() - active >= IDLE_MS) {
    const killed = killPilotBrowser(info.pid, profileDir);
    process.exit(killed ? 0 : 1);
  }
}

await tick();
const timer = setInterval(() => void tick(), POLL_MS);
// Le veilleur ne bloque pas la machine au-delà de son travail : auto-sortie
// après 2 h (le pilote suivant relance un veilleur neuf de toute façon).
setTimeout(() => {
  clearInterval(timer);
  process.exit(0);
}, 2 * 60 * 60_000).unref?.();
