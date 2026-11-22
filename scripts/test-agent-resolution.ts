// Test §9 (62) — la résolution du dossier de l'agent Hermes est RELATIVE
// et dans le bon ordre (demande de l'utilisatrice : « les fichiers d'hermes
// agent vivent dans le dossier qui héberge l'interface », « pas de chemins
// absolus », « peu importe le nom du dossier »). Le service doit trouver :
//   1) hermes-agent/ DANS le dossier de l'interface (la maison officielle,
//      où le lanceur range l'agent trouvé ailleurs) ;
//   2) le dossier frère « hermes » à côté du dossier de l'interface —
//      quel que soit le nom du dossier de l'interface ;
//   3) %LOCALAPPDATA%/hermes puis ~/.hermes (installations historiques).
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
  process.env.HOME = isolDir; // ~/.hermes absent → rien
  delete process.env.HERMES_AGENT_DIR;
  delete process.env.LOCALAPPDATA;
  try {
    console.log("[1] aucun agent nulle part → null (état honnête)");
    check("aucun candidat ne donne un faux positif", resolveAgentDir() === null);

    console.log("[2] la maison officielle : hermes-agent/ DANS le dossier de l'interface");
    const maison = join(repoRoot, "hermes-agent");
    poseMarqueur(maison);
    try {
      const r1 = resolveAgentDir();
      check("l'agent à l'intérieur de l'interface est trouvé en priorité", r1 === maison, `reçu : ${r1}`);
    } finally {
      rmSync(maison, { recursive: true, force: true });
    }

    console.log("[3] le dossier frère « hermes » à côté du dossier de l'interface");
    const frere = join(repoRoot, "..", "hermes");
    poseMarqueur(frere);
    try {
      const r2 = resolveAgentDir();
      check("l'agent voisin est trouvé (règle relative, nom du dossier libre)", r2 === frere, `reçu : ${r2}`);
    } finally {
      rmSync(frere, { recursive: true, force: true });
    }

    console.log("[4] priorité : la maison officielle gagne sur le frère");
    poseMarqueur(maison);
    poseMarqueur(frere);
    try {
      const r3 = resolveAgentDir();
      check("hermes-agent (intérieur) bat hermes (frère)", r3 === maison, `reçu : ${r3}`);
    } finally {
      rmSync(maison, { recursive: true, force: true });
      rmSync(frere, { recursive: true, force: true });
    }

    console.log("[5] surcharge explicite : HERMES_AGENT_DIR reste prioritaire");
    const surcharge = join(isolDir, "agent-ou-je-dis");
    poseMarqueur(surcharge);
    process.env.HERMES_AGENT_DIR = surcharge;
    try {
      const r4 = resolveAgentDir();
      check("la surcharge d'environnement passe devant tout", r4 === surcharge, `reçu : ${r4}`);
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
