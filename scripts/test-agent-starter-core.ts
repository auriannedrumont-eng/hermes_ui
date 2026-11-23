// Épreuves du cœur de la refonte (69) : l'ordre python (VENV DÉDIÉ d'abord,
// système en repli), l'extracteur de cause honnête, la lecture du vrai
// journal de l'agent. Elles complètent les épreuves comportementales du
// lanceur (venv → deps → certification avec sonde réelle du 9120).
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
try {
  // ── Ordre des candidats python ──
  const maison = join(tmp, "hermes-agent");
  mkdirSync(join(maison, ".venv", "bin"), { recursive: true });
  writeFileSync(join(maison, ".venv", "bin", "python"), "#!/bin/sh\n");
  const cands = pythonCandidates(maison);
  check("venv dédié d'abord (D1)", cands[0].cmd.endsWith(join(".venv", "bin", "python")));
  check("système en repli ensuite", cands[1].cmd === "python3");
  const cands2 = pythonCandidates(join(tmp, "vide"));
  check("sans venv : système d'abord", cands2[0].cmd === "python3");

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
  process.env.HERMES_AGENT_GATEWAY_LOG = join(tmp, "absent.log");
  check("journal absent → null (rien d'inventé)", gatewayLogCause() === null);
  delete process.env.HERMES_AGENT_GATEWAY_LOG;

  // ── Le module reste importable sans effet de bord violent ──
  check("startAgentGatewayIfDown est exporté", typeof startAgentGatewayIfDown === "function");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(echecs === 0 ? "\nCœur refonte (69) : 0 échec" : `\nCœur refonte (69) : ${echecs} échec(s)`);
process.exit(echecs === 0 ? 0 : 1);
