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

  console.log("[8] build : hermes-agent vit dans le dossier, jamais dans le build (§9 (66))");
  // Capture réelle : next build avalait le dépôt cloné (507 Ko d'erreurs
  // TS2307 des sources web/ evals/ website/ de l'agent) et l'interface
  // retombait en mode développement. L'agent vit chez nous, il ne fait
  // pas partie de notre build.
  const tsconfig = read("tsconfig.json");
  const excludeIdx = tsconfig.indexOf('"exclude"');
  check("tsconfig : hermes-agent exclu du type-check",
    tsconfig.slice(excludeIdx).includes('"hermes-agent"'));
  check("eslint : hermes-agent ignoré",
    read("eslint.config.mjs").includes('"hermes-agent/**"'));
  check("gitignore : la copie fraîche reste hors versionnage",
    read(".gitignore").includes("/hermes-agent/"));

  console.log("[9] manifeste de santé : une seule vérité, écrite et lue partout (§10 (68))");
  // La chaîne complète : ps1 + sh écrivent sante.json (et Die y consigne
  // l'échec), le service le lit et le diffuse, l'écran Système l'affiche —
  // plus jamais deux histoires différentes.
  const ps1Sante = read("desktop/hermes-ui.ps1");
  const shSante = read("desktop/hermes-ui.sh");
  const santeTs = read("mini-services/hermes-chat/sante.ts");
  check("ps1 : écrit sante.json + Die consigne l'échec",
    ps1Sante.includes("'sante.json'") && ps1Sante.includes("Write-Sante -pret 'echec' -cause $msg"));
  check("sh : écrit sante.json + die consigne l'échec",
    shSante.includes('"$RUNTIME_DIR/sante.json"') && shSante.includes('write_sante "echec" "$*"'));
  check("phase 0 : appelée avant tout démarrage de composant (ps1 + sh)",
    ps1Sante.includes("Phase-Prerequis") && shSante.includes("phase_prerequis"));
  check("service : lecteur honnête (null si absent), diffusé aux deux routes",
    santeTs.includes("SanteManifeste | null") &&
      read("mini-services/hermes-chat/index.ts").includes("manifeste: readSanteManifeste()") &&
      read("mini-services/hermes-chat/http-server.ts").includes("manifeste: readSanteManifeste()"));
  check("écran Système : la carte du manifeste est montée",
    read("src/components/settings/system-section.tsx").includes("<SanteCard />"));

  console.log("[10] cœur (69) : venv dédié d'abord, certification réelle, cause affichée");
  // La panne du 23/11 (agent lancé, gateway muette) meurt ici : le python
  // dédié de la maison évite les conflits avec le python système, la
  // certification prouve l'allumage AVANT de déclarer l'agent prêt, et une
  // gateway muette montre désormais SA cause lue dans son journal.
  const ps1Coeur = read("desktop/hermes-ui.ps1");
  const shCoeur = read("desktop/hermes-ui.sh");
  const starterC = read("mini-services/hermes-chat/agent-starter.ts");
  const motorC = read("mini-services/hermes-chat/agent-motor.ts");
  check("ps1 : venv dédié + allumage d'essai + marqueur agent-certifie.ok",
    ps1Coeur.includes("'.venv\\Scripts\\python.exe'") &&
      ps1Coeur.includes("agent-certifie.ok") &&
      ps1Coeur.includes("Test-PortBusy 9120"));
  check("sh : venv dédié + allumage d'essai + marqueur agent-certifie.ok",
    shCoeur.includes(".venv/bin/python") &&
      shCoeur.includes("agent-certifie.ok") &&
      shCoeur.includes("port_open 9120"));
  check("starter : le portable du dossier est le PREMIER candidat python (loi 8), venv ensuite",
    starterC.includes("portablePythonPath()") &&
      starterC.indexOf("portable") < starterC.indexOf("venvPython") &&
      starterC.includes("pythonCandidates(agentDir)") && starterC.includes(".venv"));  check("motor : la cause lue dans le journal est exposée (gatewayCause)",
    motorC.includes("gatewayCause") &&
      read("mini-services/hermes-chat/shared/chat-protocol.ts").includes("gatewayCause"));
  check("écran Système : la cause est affichée à la carte Hermes",
    read("src/components/settings/agent-motor-card.tsx").includes("Cause connue"));

  console.log("[11] faux python du store + re-certification après mise à jour ((70))");
  // Cas réel du 23/11 : le raccourci « python » du Microsoft Store répondait
  // AUSSI à la commande — un faux python disqualifié partout, et un changement
  // de version de l'agent qui refait dépendances + certification (vérifié
  // AVANT la sortie anticipée « déjà fait, on sort » que (69) avait ratée).
  const ps1F = read("desktop/hermes-ui.ps1");
  const shF = read("desktop/hermes-ui.sh");
  check("ps1 : le faux python est démasqué + remède exact (alias du store)",
    ps1F.includes("was not found") && ps1F.includes("Alias d'exécution d'applications"));
  check("sh : même détection du faux python + remède",
    shF.includes("was not found") && shF.includes("Alias d'exécution d'applications"));
  check("ps1 : la re-certification est vérifiée AVANT la sortie anticipée",
    ps1F.includes("-not $agentChange") && ps1F.includes("agent-deps-head.txt"));
  check("sh : la re-certification est vérifiée AVANT la sortie anticipée",
    shF.includes('[ "$agentchange" = "0" ]') && shF.includes("agent-deps-head.txt"));

  console.log("[12] la portabilité totale : le lanceur possède son Python ((71), loi 8)");
  // Rappel fondateur de l'utilisatrice : « tout doit fonctionner
  // indépendamment de ce qui est installé sur Windows, tout doit être
  // portable et utilisable depuis le dossier de l'interface » — le lanceur
  // télécharge et pose le Python DANS le dossier (comme Bun et Caddy déjà),
  // l'utilise en premier partout, et ne replie sur le python système
  // démasqué qu'en cas de besoin, avec la cause dite.
  check("ps1 : Ensure-PortablePython pose le python dans le dossier (python.org, zip autonome)",
    ps1F.includes("function Ensure-PortablePython") &&
      ps1F.includes("python.org/ftp/python") &&
      ps1F.includes("python-portable") &&
      ps1F.includes("get-pip.py"));
  check("ps1 : phase 0 = portable d'abord, système démasqué en repli",
    ps1F.includes("Python portable (dans le dossier)") && ps1F.includes("Python (repli système)"));
  check("ps1 : provisionnement et certification sur le portable",
    ps1F.includes("$pyKind -ne 'portable'") && ps1F.includes("python portable du dossier"));
  check("sh : ensure_portable_python télécharge dans le dossier (surchargeable pour les épreuves)",
    shF.includes("ensure_portable_python") &&
      shF.includes("HERMES_PYTHON_URL") &&
      shF.includes("python-portable"));
  check("sh : phase 0 et provisionnement passent par le portable en cas de besoin",
    shF.includes("Python (portable, dans le dossier)") &&
      shF.includes("le lanceur\n  # possède le sien") &&
      shF.includes("ensure_portable_python 2>/dev/null || echo ''"));
  check("starter : le python du dossier est résolu du vrai chemin, jamais deviné",
    starterC.includes('"desktop", "runtime", "python-portable"'));

  console.log(failures === 0 ? "\nGardes de source : 0 échec" : `\nGardes de source : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
