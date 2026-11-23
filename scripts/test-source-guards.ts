// Test de régression Lot 1 — gardes de source (audit L1-2 et L1-5) : deux
// correctifs d'une ligne fragile que la compilation ne détecte pas (le code
// compile même sans l'import — c'était le crash) et que la capture du fil
// d'une autre conversation ne révèle qu'à l'usage.
//   1. webchat/engine.ts importe `resolve` (sinon ReferenceError dès qu'un
//      site piloté produit des fichiers) et s'en sert pour borner le chemin ;
//   2. src/hooks/use-hermes-chat.ts : l'ack de conversations:open compare à
//      activeIdRef AVANT de couper le spinner (sinon navigation A→B→C rapide,
//      l'ack tardif de A écrase le fil de C) ;
//   3. chaque handler stream:*/mode:flow/artifact:* porte la garde
//      activeIdRef — les deltas d'une conversation en vol ne fuient pas dans
//      celle qu'on vient d'ouvrir ;
//   4. use-hermes-chat.ts : onHello compare appRevision du service à
//      BUILD_REVISION (révision cuite au build) et exige les deux côtés
//      présents — l'écran vieux affiche le bandeau « recharger » au lieu
//      de vivre des heures sur l'ancienne interface (§9 (61)) ;
//   5. les deux lanceurs INSTALLENT une copie fraîche officielle de l'agent
//      dans <racine>/hermes-agent et ne déplacent JAMAIS l'hermes existant
//      de l'utilisatrice — décision verrouillée (§9 (63)) : aucun
//      robocopy/robocopy /MOVE côté ps1, plus aucun bloc de rangement
//      (agent_src) côté sh, et l'appel à l'installeur est présent.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

async function main() {
  console.log("[1] webchat/engine.ts : import resolve (L1-2)");
  const engine = read("mini-services/hermes-chat/webchat/engine.ts");
  check("resolve est importé depuis node:path",
    engine.includes(`import { join, resolve } from "node:path"`));
  check("le bornage du chemin utilise resolve(safe)/resolve(path)",
    /resolve\(safe\)\s*!==\s*resolve\(path\)/.test(engine));

  console.log("[2] use-hermes-chat.ts : ack conversations:open (L1-5)");
  const hook = read("src/hooks/use-hermes-chat.ts");
  const openIdx = hook.indexOf('"conversations:open"');
  check("l'ouverture de conversation émet conversations:open", openIdx >= 0);
  const ackWindow = hook.slice(openIdx, openIdx + 3600);
  // Fenêtre large : le corps de l'ack porte aussi le re-semis des tours en
  // vol (ré-attache « quitter puis revenir » : contenu accumulé + déroulé
  // multi-voix, ~2 000 car.) — l'invariant vérifié reste la POSITION
  // relative garde → coupure du spinner.
  const guardIdx = ackWindow.indexOf("id !== activeIdRef.current");
  const spinnerIdx = ackWindow.indexOf("setLoadingHistory(false)");
  const gateIdx = ackWindow.indexOf("loadingForRef.current === id");
  check("l'ack porte la garde activeIdRef", guardIdx >= 0);
  // (audit 2026-11-21) la coupure du spinner est ENCADRÉE par la porte
  // loadingForRef : elle ne s'exprime que si l'ack correspond au chargement
  // EN COURS — un ack tardif de A pendant que C charge ne coupe rien.
  // (L'ancien ordre « garde puis coupure » laissait au contraire le
  // squelette collé pour toujours quand A n'était plus active du tout :
  // nouvelle conversation, suppression pendant le chargement.)
  check("la coupure du spinner est gated par loadingForRef (l'ack tardif ne coupe pas le chargement de C)",
    gateIdx >= 0 && spinnerIdx >= 0 && gateIdx < spinnerIdx);
  const seedIdx = ackWindow.indexOf("res.live ?? []");
  check("le re-semis des tours en vol est dans l'ack, derrière la garde (l'ack tardif d'une autre conversation ne sème rien)",
    seedIdx > guardIdx);
  const flowIdx = ackWindow.indexOf("t.modeFlow?.length");
  check("le déroulé multi-voix (modeFlow) est ré-attaché dans l'ack, derrière la garde (le bloc des voix survit à quitter/ revenir)",
    flowIdx > guardIdx);

  console.log("[3] handlers stream:*/mode:flow/artifact:* : garde activeIdRef");
  // Découpage 2026-11 (FORK.md §10) : les handlers stream:*/mode:flow vivent
  // dans use-chat-stream.ts, les handlers conversationnels restent dans
  // l'orchestrateur — la garde activeIdRef est vérifiée là où le handler EST.
  const streamHook = read("src/hooks/use-chat-stream.ts");
  const guarded: { name: string; file: string }[] = [
    { name: "onStreamStart", file: "stream" },
    { name: "onStreamDelta", file: "stream" },
    { name: "onStreamReasoning", file: "stream" },
    { name: "onStreamStatus", file: "stream" },
    { name: "onStreamTool", file: "stream" },
    { name: "onStreamDone", file: "stream" },
    { name: "onStreamError", file: "stream" },
    { name: "onModeFlow", file: "stream" },
    { name: "onArtifactDelta", file: "hook" },
    { name: "onArtifactCreated", file: "hook" },
    { name: "onArtifactUpdated", file: "hook" },
    { name: "onMessageAppended", file: "hook" },
    { name: "onMessagesRemoved", file: "hook" },
    { name: "onMessagesSuperseded", file: "hook" },
    { name: "onMessagesRefreshed", file: "hook" },
  ];
  for (const { name: h, file } of guarded) {
    const target = file === "stream" ? streamHook : hook;
    const m = new RegExp(`const ${h} = \\((?:[^{]|\\{[^}]*\\})*\\)\\s*=>\\s*\\{`).exec(target);
    if (!m) {
      check(`handler ${h} présent`, false, "introuvable — signature changée ?");
      continue;
    }
    const end = target.indexOf("\n    };", m.index);
    const body = target.slice(m.index, end > 0 ? end : m.index + 2000);
    check(`handler ${h} filtre par activeIdRef`, body.includes("activeIdRef.current"));
  }

  console.log("[4] use-hermes-chat.ts : écran vieux — comparaison révision bundle ↔ service (§9 (61))");
  const revLib = read("src/lib/build-revision.ts");
  check("BUILD_REVISION est lu depuis NEXT_PUBLIC_BUILD_REVISION",
    revLib.includes("NEXT_PUBLIC_BUILD_REVISION"));
  const helloIdx = hook.indexOf("const onHello");
  check("le hook traite le hello", helloIdx >= 0);
  const helloWindow = hook.slice(helloIdx, helloIdx + 1800);
  check("onHello compare appRevision à BUILD_REVISION",
    helloWindow.includes("BUILD_REVISION") && helloWindow.includes("appRevision"));
  check("la comparaison exige les deux révisions présentes (jamais de bandeau sur supposition)",
    /if \(BUILD_REVISION && theirs\)/.test(helloWindow));
  check("une révision fermée ne ressuscite pas le bandeau (rediffusion hello)",
    helloWindow.includes("screenOutdatedDismissedRef.current !== theirs"));
  const page = read("src/app/page.tsx");
  check("page.tsx rend le bandeau quand screenOutdated est posé",
    page.includes("chat.screenOutdated") && page.includes("window.location.reload()"));

  console.log("[5] lanceurs : copie fraîche de l'agent, jamais de déplacement de l'existant (§9 (63))");
  const ps1 = read("desktop/hermes-ui.ps1");
  const sh = read("desktop/hermes-ui.sh");
  check("ps1 : l'installeur officiel est défini ET appelé au démarrage",
    ps1.includes("function Install-AgentIntoHome") && ps1.includes("\n    Install-AgentIntoHome"));
  check("ps1 : source officielle NousResearch/hermes-agent",
    ps1.includes("https://github.com/NousResearch/hermes-agent"));
  check("ps1 : aucun déplacement de l'hermes existant (robocopy banni)", !ps1.includes("robocopy"));
  check("ps1 : le déplacement (62) est bien retiré", !ps1.includes("Move-AgentIntoHome"));
  check("sh : l'installeur officiel est défini ET appelé au démarrage",
    sh.includes("install_agent_fresh() {") && sh.includes("\n  install_agent_fresh"));
  check("sh : source officielle NousResearch/hermes-agent",
    sh.includes("https://github.com/NousResearch/hermes-agent"));
  check("sh : aucun déplacement de l'agent existant (bloc agent_src supprimé)", !sh.includes("agent_src"));

  console.log("[6] moteur : refus AVANT lancement + sondes silencieuses sans fuite (§9 (64))");
  const motor = read("mini-services/hermes-chat/agent-motor.ts");
  check("startAgentUpdate : pré-sonde de la passerelle avant tout lancement",
    motor.includes("if (await gatewayPortOpen()) {"));
  check("runLogged : la ligne d'arrêt est gated par quiet (plus de fuite « plus de 4 s »)",
    /if \(!opts\.quiet\) logLine\(deps, `\(arrêté/.test(motor));
  check("runLogged : « commande introuvable » est gated par quiet",
    /if \(!opts\.quiet\) logLine\(deps, `commande introuvable/.test(motor));
  check("verdict/traduction : le refus officiel est reconnu (MOTEUR MAJ REFUSÉ)",
    read("src/components/settings/fil-live.tsx").includes("MOTEUR MAJ REFUSÉ"));

  console.log("[7] résolution : UNE SEULE source — la maison, aucun filet (§9 (65))");
  // Décision verrouillée : resolveAgentDir ne connaît que
  // <racine interface>/hermes-agent (+ surcharge explicite pour les tests).
  // Aucune mention des anciens secours de (62) : frère, LOCALAPPDATA, ~/.hermes.
  const resolveIdx = motor.indexOf("export function resolveAgentDir");
  const resolveBody = motor.slice(resolveIdx, motor.indexOf("/** Dernière release", resolveIdx));
  check("resolveAgentDir ne connaît que hermes-agent dans l'interface",
    resolveBody.includes('join(repoRoot, "hermes-agent")'));
  check("exactement deux candidats : surcharge explicite + maison",
    (resolveBody.match(/candidates\.push/g) ?? []).length === 2);
  check("plus de %LOCALAPPDATA%\\hermes", !resolveBody.includes("LOCALAPPDATA"));
  check("plus de ~/.hermes", !resolveBody.includes(".hermes"));
  check("la surcharge explicite HERMES_AGENT_DIR reste (tests/bac à sable)",
    resolveBody.includes("HERMES_AGENT_DIR"));
  // Borné à la fonction d'installation : le .sh a un « SIGKILL de secours »
  // légitime dans l'arrêt du webchat, hors sujet ici.
  const ps1Install = read("desktop/hermes-ui.ps1").slice(
    read("desktop/hermes-ui.ps1").indexOf("function Install-AgentIntoHome"),
    read("desktop/hermes-ui.ps1").indexOf("── ARRET PROPRE")
  );
  const shFull = read("desktop/hermes-ui.sh");
  const shInstall = shFull.slice(shFull.indexOf("install_agent_fresh() {"), shFull.indexOf("── Démarrage des composants"));
  check("les lanceurs ne promettent plus de « secours » pour l'agent",
    !ps1Install.includes("secours") && !shInstall.includes("secours"));

  console.log(failures === 0 ? "\nGardes de source : 0 échec" : `\nGardes de source : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
