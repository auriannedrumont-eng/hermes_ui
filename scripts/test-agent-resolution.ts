// Test §9 (65) — la résolution du dossier de l'agent Hermes connaît UNE
// SEULE source automatique : hermes-agent/ DANS le dossier de l'interface
// (décision de l'utilisatrice : « je ne veux pas de ce filet de sécurité !
// retire. seule source hermes agent dans le dossier de mon interface »).
// Le test prouve le RETRAIT, pas seulement l'ajout : même quand les
// anciens emplacements de secours EXISTENT et contiennent une installation
// valide (dossier frère « hermes », %LOCALAPPDATA%/hermes, ~/.hermes), la
// résolution les IGNORE — réponse null si la maison est vide, jamais un
// branchement sur l'hermes d'ailleurs. La surcharge explicite
// HERMES_AGENT_DIR reste pour les tests et les bac à sable.
// Tout est construit en dossiers temporaires : aucun état du dépôt n'est
// touché (les marqueurs sont posés puis nettoyés).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

/** Marque un dossier comme installation Hermes (gateway/run_api.py). */
function poseMarqueur(dir: string) {
  mkdirSync(join(dir, "gateway"), { recursive: true });
  writeFileSync(join(dir, "gateway", "run_api.py"), "# stub de test\n");
}

async function main() {
  const { resolveAgentDir } = await import("../mini-services/hermes-chat/agent-motor");

  // Isolation : sans surcharge ni marqueur, la résolution ne doit rien
  // inventer (les vrais emplacements du bac à sable ne sont pas des agents).
  const isolDir = mkdtempSync(join(tmpdir(), "hermes-agent-res-"));
  const vraiHome = process.env.HOME;
  process.env.HOME = isolDir;
  delete process.env.HERMES_AGENT_DIR;
  try {
    console.log("[1] plus aucun filet : les anciens emplacements EXISTENT → ignorés");
    // On POSE une installation valide à chacun des trois anciens emplacements
    // de secours de (62) : frère, %LOCALAPPDATA%/hermes, ~/.hermes.
    const frere = join(repoRoot, "..", "hermes");
    poseMarqueur(frere);
    process.env.LOCALAPPDATA = isolDir;
    poseMarqueur(join(isolDir, "hermes"));
    poseMarqueur(join(isolDir, ".hermes"));
    try {
      check("frère « hermes » posé → IGNORÉ (réponse null)", resolveAgentDir() === null);
    } finally {
      rmSync(frere, { recursive: true, force: true });
      rmSync(join(isolDir, "hermes"), { recursive: true, force: true });
      rmSync(join(isolDir, ".hermes"), { recursive: true, force: true });
      delete process.env.LOCALAPPDATA;
    }

    console.log("[2] la maison officielle : hermes-agent/ DANS le dossier de l'interface");
    const maison = join(repoRoot, "hermes-agent");
    poseMarqueur(maison);
    try {
      const r1 = resolveAgentDir();
      check("l'agent dans l'interface est l'unique source trouvée", r1 === maison, `reçu : ${r1}`);
    } finally {
      rmSync(maison, { recursive: true, force: true });
    }

    console.log("[3] marqueur tolérant : .git seul suffit (copie clonée)");
    mkdirSync(join(maison, ".git"), { recursive: true });
    writeFileSync(join(maison, ".git", "HEAD"), "ref: refs/heads/main\n");
    try {
      const r2 = resolveAgentDir();
      check("un clone git (sans run_api.py) est reconnu", r2 === maison, `reçu : ${r2}`);
    } finally {
      rmSync(maison, { recursive: true, force: true });
    }

    console.log("[4] surcharge explicite : HERMES_AGENT_DIR reste prioritaire (tests/bac à sable)");
    const surcharge = join(isolDir, "agent-ou-je-dis");
    poseMarqueur(surcharge);
    process.env.HERMES_AGENT_DIR = surcharge;
    try {
      const r3 = resolveAgentDir();
      check("la surcharge d'environnement passe devant la maison", r3 === surcharge, `reçu : ${r3}`);
    } finally {
      delete process.env.HERMES_AGENT_DIR;
      rmSync(surcharge, { recursive: true, force: true });
    }
  } finally {
    process.env.HOME = vraiHome;
    rmSync(isolDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nRésolution agent : 0 échec" : `\nRésolution agent : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
