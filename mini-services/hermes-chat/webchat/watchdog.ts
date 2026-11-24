// Veilleur détaché (spec §2.5) — ferme le navigateur de pilotage après
// quelques minutes d'inactivité ; le pilote suivant le relance. Processus
// séparé du pilote : il survit à la fin du sous-processus de tour.
//
// Sécurité : le kill n'a lieu que si le pid est enregistré par ce module ET
// que sa ligne de commande porte le --user-data-dir du profil applicatif
// (isAppBrowserPid) — le navigateur personnel ne peut jamais être visé.

import { existsSync, statSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activityPath, killPilotBrowser, readPilotInfo } from "./browser";

function argOf(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const profileArg = argOf("--profile");
const idleArg = Number(argOf("--idle-min") ?? "5");

if (!profileArg || !Number.isFinite(idleArg) || idleArg <= 0) {
  process.exit(2);
}
// Resserrés pour le reste du module (les fermetures ci-dessous ne héritent
// pas du rétrécissement de flux de la garde ci-dessus).
const profileDir: string = profileArg;
const idleMin: number = idleArg;

const IDLE_MS = idleMin * 60_000;
const POLL_MS = 30_000;

// Revue 95 : le PID-file est effacé À CHAQUE sortie du veilleur — sinon un
// OS qui réattribue le pid à un autre processus faisait croire au pilote
// (launchWatchdog) que le veilleur vivait encore, et plus AUCUN veilleur
// n'était relancé (le navigateur restait ouvert pour toujours).
const selfPidFile = join(profileDir, "watchdog.pid");
function retirePidFile(): void {
  try {
    rmSync(selfPidFile, { force: true });
  } catch {
    /* best effort : la relance nettoie un pid périmé de toute façon */
  }
}

async function tick(): Promise<void> {
  const info = readPilotInfo(profileDir);
  if (!info || info.pid <= 0) {
    retirePidFile();
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
    // S-03 : killPilotBrowser est async (vérification CIM de la ligne de
    // commande sous Windows) — un pid non vérifiable ne peut pas être tué.
    const killed = await killPilotBrowser(info.pid, profileDir);
    retirePidFile();
    process.exit(killed ? 0 : 1);
  }
}

// Inscription du pid du veilleur courant (le pilote la lit pour l'idempotence).
try {
  writeFileSync(selfPidFile, String(process.pid));
} catch {
  /* best effort : sans PID-file, la prochaine relance doublonnera */
}

await tick();
const timer = setInterval(() => void tick(), POLL_MS);
// Le veilleur ne bloque pas la machine au-delà de son travail : auto-sortie
// après 2 h (le pilote suivant relance un veilleur neuf de toute façon).
setTimeout(() => {
  clearInterval(timer);
  retirePidFile();
  process.exit(0);
}, 2 * 60 * 60_000).unref?.();
