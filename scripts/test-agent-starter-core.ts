// Épreuves du cœur de la refonte ((69) + loi 8 (70)) : l'ordre python (le
// PORTABLE du dossier d'abord — jamais le faux raccourci du magasin ; venv
// dédié ensuite pour le repli ; système en dernier), l'extracteur de cause
// honnête, la lecture du vrai journal de l'agent. Elles complètent les
// épreuves comportementales du lanceur (venv → deps → certification avec
// sonde réelle du 9120, portables compris).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractGatewayCause, gatewayLogCause } from "../mini-services/hermes-chat/agent-motor";
import {
  pythonCandidates,
  startAgentGatewayIfDown,
} from "../mini-services/hermes-chat/agent-starter";

let echecs = 0;
function check(nom: string, ok: boolean) {
  console.log(`  ${ok ? "OK " : "ECHEC"} ${nom}`);
  if (!ok) echecs++;
}

const tmp = mkdtempSync(join(tmpdir(), "refonte69-"));
// Le portable de test vit dans le dossier réel de l'application (desktop/
// runtime) — c'est LÀ que la loi 8 le cherche ; il est retiré à la fin.
const portDir = join(import.meta.dir, "..", "desktop", "runtime", "python-portable");
try {
  // ── Ordre des candidats python (loi 8 : le portable du dossier d'abord) ──
  const maison = join(tmp, "hermes-agent");
  mkdirSync(join(maison, ".venv", "bin"), { recursive: true });
  writeFileSync(join(maison, ".venv", "bin", "python"), "#!/bin/sh\n");
  // Sans portable posé : l'ordre (69) reste venv d'abord, système ensuite.
  const cands = pythonCandidates(maison);
  check("sans portable : venv dédié d'abord (D1)", cands[0].cmd.endsWith(join(".venv", "bin", "python")));
  check("sans portable : système en repli ensuite", cands[1].cmd === "python3");
  // Avec un portable posé dans le dossier : il PREND LA TÊTE — le faux
  // raccourci « python » du Microsoft Store ne peut plus répondre à sa
  // place (cas réel du 23/11).
  mkdirSync(join(portDir, "bin"), { recursive: true });
  writeFileSync(join(portDir, "bin", "python3"), "#!/bin/sh\n");
  const cands2 = pythonCandidates(maison);
  check("portable du dossier PREMIER candidat (loi 8)", cands2[0].cmd.includes("python-portable"));
  check("venv dédié ensuite (repli)", cands2[1].cmd.endsWith(join(".venv", "bin", "python")));
  check("système démasqué en dernier", cands2[2].cmd === "python3");
  rmSync(portDir, { recursive: true, force: true });
  const cands3 = pythonCandidates(join(tmp, "vide"));
  check("sans venv ni portable : système d'abord", cands3[0].cmd === "python3");

  // ── Extracteur de cause (loi 2 « un échec = cause ») ──
  check(
    "ModuleNotFoundError reconnu parmi les lignes",
    (extractGatewayCause("lancement\nTraceback (dernier appel)\nModuleNotFoundError: No module named 'fastapi'") ?? "").includes(
      "ModuleNotFoundError"
    )
  );
  check("dernière ligne sinon", extractGatewayCause("ligne a\nligne b") === "ligne b");
  check("journal vide → null", extractGatewayCause("  \n  ") === null);
  const longue = extractGatewayCause("x".repeat(300)) ?? "";
  check("ligne trop longue tronquée", longue.length <= 201 && longue.endsWith("…"));

  // ── Cause lue depuis le VRAI journal (surchargeable) ──
  process.env.HERMES_AGENT_GATEWAY_LOG = join(tmp, "gw.log");
  writeFileSync(
    process.env.HERMES_AGENT_GATEWAY_LOG,
    "2026-11-23 lancement automatique\n2026-11-23 ModuleNotFoundError: No module named 'uvicorn'\n"
  );
  check("cause lue depuis le journal réel", (gatewayLogCause() ?? "").includes("uvicorn"));
  // ((81)) Une erreur PÉRIMÉE (avant le dernier lancement) n'est plus la
  // cause actuelle : corrigée depuis, elle ne doit plus s'afficher comme
  // actuelle — c'était le « Cause connue : ModuleNotFoundError 'gateway' »
  // qui persistait alors que le (78) avait changé la commande depuis.
  writeFileSync(
    process.env.HERMES_AGENT_GATEWAY_LOG,
    "2026-11-22 ModuleNotFoundError: No module named 'gateway'\n" +
      "2026-11-23 lancement automatique : python -m hermes_cli.main gateway run\n" +
      "2026-11-23 gateway en ligne, 9120 répond\n"
  );
  check("erreur corrigée depuis ≠ cause actuelle", gatewayLogCause() === "2026-11-23 gateway en ligne, 9120 répond");
  process.env.HERMES_AGENT_GATEWAY_LOG = join(tmp, "absent.log");
  check("journal absent → null (rien d'inventé)", gatewayLogCause() === null);
  delete process.env.HERMES_AGENT_GATEWAY_LOG;

  // ── Le module reste importable sans effet de bord violent ──
  check("startAgentGatewayIfDown est exporté", typeof startAgentGatewayIfDown === "function");
} finally {
  rmSync(portDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
}

console.log(echecs === 0 ? "\nCœur refonte ((69)+loi 8) : 0 échec" : `\nCœur refonte ((69)+loi 8) : ${echecs} échec(s)`);
process.exit(echecs === 0 ? 0 : 1);
