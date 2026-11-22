// Démarrage automatique de l'agent Hermes (loi « tout simplement », 2026-11-22).
// Le défaut automatique du connecteur est ws://127.0.0.1:9120/api/ws — il
// suffit de lancer la passerelle amont (`gateway/run_api.py` du checkout
// officiel, cf. FORK.md §9 2026-11-16) pour que l'interface se branche seule
// : le connecteur re-sonde à chaque tour et bascule en mode gateway sans
// aucune saisie. Ce module fait ce lancement UNE FOIS par boot du service :
//  - passerelle déjà répondante → ADOPTION (rien à faire, on ne touche pas
//    au processus de quelqu'un d'autre) ;
//  - installation amont introuvable (resolveAgentDir) → rien : l'interface
//    affiche son état honnête « agent non détecté » avec la marche à suivre ;
//  - lancement possible → python (py -3 / python3 / python) en détaché,
//    journal dédié db/agent-gateway.log, attente du port 15 s max.
// Choix assumé : l'agent N'EST JAMAIS tué par ce module ni par le service —
// il est adopté au boot suivant et survit aux relances de l'interface
// (pas de kill sur pid non vérifié, même garde que S-03 côté webchat).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { resolveAgentDir } from "./agent-motor";
import { trace } from "./trace";

const GATEWAY_HOST = "127.0.0.1";
const GATEWAY_PORT = 9120;
const WAIT_MS = 15_000;

/** Le port de la passerelle répond-il ? (TCP — un port WS suffit.) */
function gatewayPortOpen(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: GATEWAY_HOST, port: GATEWAY_PORT });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function pythonCandidates(): { cmd: string; args: string[] }[] {
  if (process.platform === "win32") {
    return [
      { cmd: "py", args: ["-3"] },
      { cmd: "python", args: [] },
    ];
  }
  return [{ cmd: "python3", args: [] }, { cmd: "python", args: [] }];
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
    const script = join(agentDir, "gateway", "run_api.py");
    if (!existsSync(script)) {
      trace("system", `agent non démarré automatiquement : ${script} introuvable`);
      return false;
    }
    let spawned = false;
    const log = join(import.meta.dir, "..", "..", "..", "db", "agent-gateway.log");
    for (const py of pythonCandidates()) {
      // ENOENT (interpréteur absent) arrive via l'événement "error", pas au
      // lancement — chaque candidat est éprouvé 2 s : sans erreur, il vit.
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const child = spawn(py.cmd, [...py.args, script], {
          cwd: agentDir,
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          windowsHide: true,
        });
        const finish = (result: boolean) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.once("error", () => finish(false));
        const probe = setTimeout(() => finish(true), 2_000);
        probe.unref?.();
        child.unref();
      });
      if (!ok) continue;
      // Journal léger côté fork : une ligne par lancement (le journal
      // complet de l'agent vit dans sa propre console amont).
      try {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(
          log,
          `${new Date().toISOString()} lancement automatique ${py.cmd} ${py.args.join(" ")}\n`
        );
      } catch {
        /* journal best effort */
      }
      spawned = true;
      break;
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
    trace(
      "system",
      "agent lancé mais la gateway ne répond pas encore — l'interface reste sur son état honnête jusqu'au prochain sondage"
    );
    return false;
  } catch (err) {
    trace("system", `démarrage automatique de l'agent avorté : ${err instanceof Error ? err.message : "erreur"}`);
    return false;
  }
}
