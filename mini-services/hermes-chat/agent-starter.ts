// Démarrage automatique de l'agent Hermes (loi « tout simplement », 2026-11-22).
// Le défaut automatique du connecteur est ws://127.0.0.1:9120/api/ws — il
// suffit de lancer la passerelle amont avec LA COMMANDE OFFICIELLE du projet
// (`python -m hermes_cli.main --profile default gateway run`, celle que
// hermes_cli/gateway_runtime_start.py construit lui-même — cf. lanceur (78))
// pour que l'interface se branche seule
// : le connecteur re-sonde à chaque tour et bascule en mode gateway sans
// aucune saisie. Ce module fait ce lancement UNE FOIS par boot du service :
//  - passerelle déjà répondante → ADOPTION (rien à faire, on ne touche pas
//    au processus de quelqu'un d'autre) ;
//  - installation amont introuvable (resolveAgentDir) → rien : l'interface
//    affiche son état honnête « agent non détecté » avec la marche à suivre ;
//  - lancement possible → python du VENV dédié d'abord (.venv de la maison,
//    refonte (69) D1 — isolé du python système qui sert aussi à F:\hermes),
//    système en repli ; sortie capturée dans db/agent-gateway.log ; attente
//    du port 15 s max, puis CAUSE lue dans le journal si muet (loi 2).
// Choix assumé : l'agent N'EST JAMAIS tué par ce module ni par le service —
// il est adopté au boot suivant et survit aux relances de l'interface
// (pas de kill sur pid non vérifié, même garde que S-03 côté webchat).
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { gatewayLogCause, gatewayLogPath, gatewayPortOpen, resolveAgentDir } from "./agent-motor";
import { trace } from "./trace";

const WAIT_MS = 15_000;

/** Le Python PORTABLE de l'application (loi 8 du plan v2, chantier 5) :
 *  posé par le lanceur dans desktop/runtime/python-portable, comme Bun et
 *  Caddy déjà. null si absent — jamais de chemin deviné. */
export function portablePythonPath(): string | null {
  const root = join(import.meta.dir, "..", "..", "desktop", "runtime", "python-portable");
  const candidates =
    process.platform === "win32"
      ? [join(root, "python.exe")]
      : [join(root, "python", "bin", "python3"), join(root, "bin", "python3")];
  for (const exe of candidates) {
    try {
      if (existsSync(exe)) return exe;
    } catch {
      /* indisponible : candidat suivant */
    }
  }
  return null;
}

/** Candidats python pour la gateway, dans l'ordre de confiance : le Python
 *  PORTABLE du dossier d'abord (loi 8, chantier 5 — il vit chez nous, le
 *  faux raccourci « python » du Microsoft Store ne peut plus répondre à sa
 *  place : cas réel du 23/11), puis le VENV DÉDIÉ de la maison (refonte (69)
 *  D1 — repli système : ses dépendances certifiées ne marchent jamais sur le
 *  python système qui fait aussi tourner vos autres Hermes), puis les
 *  interpréteurs système démasqués en dernier repli. */
export function pythonCandidates(agentDir: string): { cmd: string; args: string[] }[] {
  const list: { cmd: string; args: string[] }[] = [];
  const portable = portablePythonPath();
  if (portable) list.push({ cmd: portable, args: [] });
  const venvPython =
    process.platform === "win32"
      ? join(agentDir, ".venv", "Scripts", "python.exe")
      : join(agentDir, ".venv", "bin", "python");
  if (existsSync(venvPython)) list.push({ cmd: venvPython, args: [] });
  if (process.platform === "win32") {
    list.push({ cmd: "py", args: ["-3"] });
    list.push({ cmd: "python", args: [] });
  } else {
    list.push({ cmd: "python3", args: [] });
    list.push({ cmd: "python", args: [] });
  }
  return list;
}

/** Lance la passerelle amont si elle est éteinte et que l'installation
 *  officielle est présente. Retourne true si la gateway répond À LA FIN
 *  (déjà là, ou lancée avec succès). Jamais d'échec bloquant : en cas de
 *  doute, false et l'interface garde son état honnête. */
export async function startAgentGatewayIfDown(): Promise<boolean> {
  try {
    if (await gatewayPortOpen()) return true; // adoption : l'agent tourne déjà
    const agentDir = resolveAgentDir();
    if (!agentDir) return false; // pas d'installation connue : état honnête côté UI
    // ((81)) La COMMANDE OFFICIELLE du projet amont (le (78) côté lanceur) :
    // `python -m hermes_cli.main --profile default gateway run` — le runtime
    // supervise allume lui-même le listener 9120. L'ancien réflexe
    // `python gateway/run_api.py` ne peut pas tourner : le package `gateway`
    // n'est pas importable depuis son propre dossier et le module n'a pas de
    // __main__ (ModuleNotFoundError 'gateway', cas réel du 23/11 — c'était
    // la cause que la carte « Moteur Hermes » affichait, lue dans
    // db/agent-gateway.log).
    const cliMain = join(agentDir, "hermes_cli", "main.py");
    if (!existsSync(cliMain)) {
      trace("system", `agent non démarré automatiquement : ${cliMain} introuvable (installation officielle incomplète ?)`);
      return false;
    }
    let spawned = false;
    const log = gatewayLogPath();
    // Sortie de l'agent capturée DANS SON JOURNAL (fd ouvert en append) :
    // c'est elle qui portera la CAUSE si la gateway reste muette — avant
    // (69) elle partait dans /dev/null et l'utilisateur ne voyait qu'un
    // « éteint » sans mot (la panne réelle du 23/11).
    let logFd: number | null = null;
    try {
      logFd = openSync(log, "a");
    } catch {
      logFd = null; // journal impossible : on lance quand même, sans capture
    }
    for (const py of pythonCandidates(agentDir)) {
      // ((81)) Le marqueur de lancement est écrit AVANT le spawn : une cause
      // éventuelle arrive APRÈS lui dans le journal — gatewayLogCause() ne
      // lit que depuis le dernier marqueur (une erreur corrigée depuis ne
      // passe plus pour actuelle).
      try {
        appendFileSync(
          log,
          `${new Date().toISOString()} lancement automatique : ${py.cmd} -m hermes_cli.main --profile default gateway run --quiet\n`
        );
      } catch {
        /* journal best effort */
      }
      // ENOENT (interpréteur absent) arrive via l'événement "error", pas au
      // lancement — chaque candidat est éprouvé 2 s : sans erreur, il vit.
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const child = spawn(py.cmd, [...py.args, "-m", "hermes_cli.main", "--profile", "default", "gateway", "run", "--quiet"], {
          cwd: agentDir,
          detached: true,
          env: {
            ...process.env,
            // ((90)) Maison ÉPINGLÉE : un HERMES_HOME hérité d'une autre
            // installation faisait démarrer l'agent sur la maison d'à côté
            // (instance hybride du 23/11 23:42 — elle fauchait notre 9120).
            HERMES_HOME: join(import.meta.dir, "..", "..", "data"),
            PYTHONIOENCODING: "utf-8",
            PYTHONPATH: [agentDir, process.env.PYTHONPATH]
              .filter(Boolean)
              .join(process.platform === "win32" ? ";" : ":"),
          },
          stdio: logFd !== null ? ["ignore", logFd, logFd] : ["ignore", "ignore", "ignore"],
          windowsHide: true,
        });
        const finish = (result: boolean) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.once("error", () => finish(false));
        // Revue 95 : un candidat qui DÉMARRE puis quitte aussitôt avec un
        // code non nul (alias Windows Store, binaire cassé) ne doit pas
        // gagner par défaut — le timer de 2 s seul résolvait true sur un
        // processus déjà mort, et les candidats suivants n'étaient jamais
        // essayés. Une sortie non nulle avant l'échéance rattrape le verdict.
        child.once("exit", (code) => {
          if (code !== 0 && code !== null) finish(false);
        });
        const probe = setTimeout(() => finish(true), 2_000);
        probe.unref?.();
        child.unref();
      });
      if (!ok) continue;
      spawned = true;
      break;
    }
    if (logFd !== null) {
      try {
        // Le fils garde SA copie du fd : le parent peut fermer la sienne.
        closeSync(logFd);
      } catch {
        /* déjà fermé */
      }
    }
    if (!spawned) {
      trace("system", "agent non démarré automatiquement : aucun interpréteur python trouvé");
      return false;
    }
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      if (await gatewayPortOpen()) {
        trace("system", "agent Hermes démarré automatiquement — la gateway répond (9120)");
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const cause = gatewayLogCause();
    trace(
      "system",
      cause
        ? `agent lancé mais la gateway ne répond pas — cause lue dans son journal : ${cause}`
        : "agent lancé mais la gateway ne répond pas encore — l'interface reste sur son état honnête jusqu'au prochain sondage"
    );
    return false;
  } catch (err) {
    trace("system", `démarrage automatique de l'agent avorté : ${err instanceof Error ? err.message : "erreur"}`);
    return false;
  }
}
