// Gestion du navigateur de pilotage (spec §2.1, §2.2, §2.5) :
// - Profil DÉDIÉ à l'application (--user-data-dir propre) — l'utilisateur se
//   connecte une fois, à la main ; le code ne saisit ni ne stocke jamais un
//   identifiant.
// - NE JAMAIS TOUCHER au navigateur personnel : les kills sont faits sur un
//   pid enregistré par CE module ET vérifiés par la chaîne --user-data-dir du
//   profil applicatif (jamais sur le nom de l'exécutable — les deux
//   navigateurs tournent en même temps sur la machine).
// - Veilleur détaché : le navigateur de pilotage se ferme après quelques
//   minutes d'inactivité ; le pilote suivant le relance.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";

export interface PilotBrowserInfo {
  pid: number;
  port: number;
  profileDir: string;
  startedAt: string;
}

/** Chemins du registre du navigateur de pilotage (dans le profil dédié). */
export function pilotInfoPath(profileDir: string): string {
  return join(profileDir, "hermes-pilot-browser.json");
}
export function activityPath(profileDir: string): string {
  return join(profileDir, "hermes-pilot-activity");
}

export function readPilotInfo(profileDir: string): PilotBrowserInfo | null {
  try {
    const info = JSON.parse(readFileSync(pilotInfoPath(profileDir), "utf-8")) as PilotBrowserInfo;
    return typeof info?.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

/** Binaire navigateur : réglage (Paramètres) > variables > chemins connus. */
export function browserCandidates(configuredPath?: string): string[] {
  const env = [
    process.env.HERMES_PILOT_BROWSER ?? null,
    process.env.HERMES_WEBCHAT_BROWSER ?? null,
  ].filter((p): p is string => !!p);
  const known = IS_WIN
    ? [
        "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/usr/bin/brave-browser",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/snap/bin/chromium",
      ];
  return [...(configuredPath ? [configuredPath] : []), ...env, ...known];
}

/** Le navigateur de pilotage répond-il déjà sur ce port de débogage ? */
export async function isBrowserUp(port: number, timeoutMs = 900): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Vérifie qu'un pid est bien le navigateur DU PROFIL APPLICATIF : sur Linux,
 * lecture de /proc/<pid>/cmdline ; ailleurs, on ne tue que si le pid est
 * celui enregistré par ce module (double garde). Le navigateur personnel de
 * l'utilisatrice — même binaire, autre profil — ne peut jamais visé.
 */
export function isAppBrowserPid(pid: number, profileDir: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (existsSync(`/proc/${pid}/cmdline`)) {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
      return cmdline.includes(`--user-data-dir=${profileDir}`);
    }
    // Sans /proc (Windows) : uniquement le pid écrit par ce module, avec
    // relecture du registre (le pid a été posé par launchPilotBrowser).
    const info = readPilotInfo(profileDir);
    return info?.pid === pid;
  } catch {
    return false;
  }
}

/** Tue le navigateur de pilotage s'il correspond au profil — sinon refuse. */
export function killPilotBrowser(pid: number, profileDir: string): boolean {
  if (!isAppBrowserPid(pid, profileDir)) return false;
  try {
    process.kill(pid, "SIGTERM");
    rmSync(pilotInfoPath(profileDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface EnsureResult {
  up: boolean;
  pid: number | null;
  /** Message honnête pour l'interface quand up = false. */
  error: string | null;
}

/**
 * S'assure que le navigateur du profil tourne sur le port de débogage ; le
 * lance sinon (fenêtre visible : l'utilisateur se connecte à la main).
 * Idempotent : s'il tourne déjà, rien n'est relancé.
 */
export async function ensureBrowser(opts: {
  port: number;
  profileDir: string;
  browserPath?: string;
}): Promise<EnsureResult> {
  const { port, profileDir } = opts;
  mkdirSync(profileDir, { recursive: true });
  if (await isBrowserUp(port)) return { up: true, pid: null, error: null };

  const binary = browserCandidates(opts.browserPath).find((p) => p && existsSync(p));
  if (!binary) {
    return {
      up: false,
      pid: null,
      error:
        "Aucun navigateur Chromium/Brave trouvé — installez Chromium ou renseignez " +
        "le chemin du navigateur dans Paramètres → Chats web.",
    };
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Profil nu : ni Bureau ni Téléchargements fiables — les téléchargements
    // passent par le crochet fetch (pilote z.ai), jamais par le dialogue natif.
    "--disable-features=Translate",
  ];
  const child = spawn(binary, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const info: PilotBrowserInfo = {
    pid: child.pid ?? -1,
    port,
    profileDir,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(pilotInfoPath(profileDir), JSON.stringify(info));

  // Attente du port CDP — plafond explicite, échec franc (jamais un succès
  // « à peu près » : le pilote suivant re-sondera).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isBrowserUp(port)) return { up: true, pid: info.pid, error: null };
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    up: false,
    pid: info.pid,
    error: `Le navigateur de pilotage n'annonce pas son port CDP (${port}) après 20 s.`,
  };
}

/** Touche le fichier d'activité (le veilleur ferme après N minutes SANS lui). */
export function touchActivity(profileDir: string): void {
  try {
    const p = activityPath(profileDir);
    writeFileSync(p, String(Date.now()));
    utimesSync(p, new Date(), new Date());
  } catch {
    /* le veilleur se contentera du registre */
  }
}

/**
 * Lance le veilleur détaché (idempotent : un veilleur vivant n'est pas
 * doublon — il se relaie par le fichier d'activité). Il ferme le navigateur
 * de pilotage après `idleMin` minutes sans activité du pilote.
 */
export function launchWatchdog(profileDir: string, idleMin: number): void {
  if (!Number.isFinite(idleMin) || idleMin <= 0) return;
  // PID-file (Lot 2, audit L2-7) : l'idempotence annoncée n'était pas
  // implémentée — chaque appel du pilote spawne un veilleur détaché de plus
  // (vies jusqu'à 2 h). Un veilleur VIVANT n'est pas relancé ; le PID périmé
  // est nettoyé avant relance.
  const pidFile = join(profileDir, "watchdog.pid");
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return;
    rmSync(pidFile, { force: true });
  } catch {
    /* pas de PID-file : premier lancement */
  }
  const script = join(import.meta.dir, "watchdog.ts");
  const child = spawn(
    process.execPath,
    [script, "--profile", profileDir, "--idle-min", String(idleMin)],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  try {
    if (child.pid) writeFileSync(pidFile, String(child.pid));
  } catch {
    /* sans PID-file, la prochaine relance doublonnera — non bloquant */
  }
  child.unref();
}

/** Le processus correspond-il à un PID vivant ? (kill(pid, 0) sans effet). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM = vivant mais hors de nos droits ; ESRCH = mort.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
