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

  console.log("[13] le lanceur possède aussi Git — et Node sous Unix ((72), loi 8)");
  // L'audit demandé par l'utilisatrice (« je suis sûre que tu as oublié des
  // choses ») a révélé deux trous : Git n'était que DÉTECTÉ sur Windows (ni
  // mise à jour ni clonage sur une machine vierge) et le miroir Unix exigeait
  // node du système. De plus, l'agent officiel réserve ses dépendances sûres
  // à Python >= 3.14 (pydantic-core sans segfault, correctifs CVE) : le
  // portable suit 3.14, pas 3.12.
  check("ps1 : MinGit posé dans tools\\git (zip sans installeur de git-for-windows)",
    ps1F.includes("MinGit-2.51.0-64-bit.zip") &&
      ps1F.includes("$Script:GitDir = Resolve-Tool 'git' 'git.exe' $GitZipUrl $true"));
  check("ps1 : le git posé du dossier est résolu AVANT la mise à jour GitHub et le clonage",
    (() => {
      // ((77)) l'appel de l'agent a déménagé après la Phase 0 : l'ordre se
      // vérifie sur les lignes d'APPEL (4 espaces), pas sur une séquence figée.
      const g = ps1F.indexOf("$Script:GitDir = Resolve-Tool 'git'");
      const m = ps1F.search(/^\s{4}Update-FromGit\s*$/m);
      const c = ps1F.search(/^\s{4}Install-AgentIntoHome\s*$/m);
      return g > -1 && m > g && c > g && ps1F.includes("& $Script:GitExe -C $Root @GitArgs");
    })());
  check("ps1 : plus AUCUN appel git direct au PATH (le PATH n'est pas une source de vérité)",
    ps1F.includes("& git -C $Root") === false &&
      ps1F.includes("& git -C $homeDir") === false &&
      ps1F.includes("git clone $u $d") === false);
  check("ps1 : phase 0 = « Git (dans le dossier) », système en repli",
    ps1F.includes("Git (dans le dossier)") && ps1F.includes("Git (repli système)"));
  check("ps1 : le Python portable suit la version exigée par l'agent (3.14)",
    ps1F.includes("python-3.14.3-embed"));
  check("sh : node du dossier d'abord (nodejs.org officiel, dans le dossier, surchargeable)",
    shF.includes("ensure_node") && shF.includes("HERMES_NODE_URL") &&
      shF.includes("nodejs.org/dist") && shF.includes("node-portable"));
  check("sh : le python portable suit la version exigée par l'agent (3.14, install_only)",
    shF.includes("cpython-3.14.10") && shF.includes("install_only"));

  console.log("[14] sessions natives : fondation en lecture seule ((74))");
  // Le WS natif du moteur est un protocole fermé (JSON-RPC + tickets,
  // tui_gateway/ws.py) et `api_turn_v1` refuse toute clé inconnue
  // (session_api_turn.py:60-65, sans session_id). Nommer une session
  // passe donc par l'API REST OFFICIELLE du moteur (GET/POST
  // /api/sessions, header X-Hermes-Session-Id annoncé dans les CORS).
  // Ce tour ne pose que la fondation : la sonde LIT, jamais n'écrit
  // côté moteur — la base locale reste la seule source de vérité tant
  // que la bascule REST n'est pas construite et éprouvée.
  const msF = read("mini-services/hermes-chat/motor-sessions.ts");
  const schemaF = read("mini-services/hermes-chat/schema.ts");
  check("sonde : GET /api/sessions seulement — aucune méthode d'écriture côté moteur",
    msF.includes("/api/sessions") &&
      msF.includes("method:") === false &&
      msF.includes("\"POST\"") === false && msF.includes("'POST'") === false &&
      msF.includes("\"PUT\"") === false && msF.includes("\"DELETE\"") === false);
  check("sonde : non bloquante (aucun appelant n'attend son résultat)",
    read("mini-services/hermes-chat/index.ts").includes("void probeMotorSessionsOnce(connector, toHttpBase)"));
  check("schéma : la colonne de correspondance est une migration douce (base locale intacte)",
    schemaF.includes('softAlter(db, "conversations", "motor_session_id TEXT")'));

  console.log("[15] sessions natives : la bascule REST avec filet WS ((75))");
  // La bascule est sûre par construction : REST d'abord, WebSocket du MÊME
  // moteur en repli à toute erreur avant premier delta ; la liaison est
  // idempotente (201/409), jamais bloquante (échec → null → WS inchangé) ;
  // le store local écrit la liaison, jamais la base du moteur (qui ne
  // reçoit que POST /api/sessions et /chat/stream du contrat amont).
  const mrF = read("mini-services/hermes-chat/motor-rest.ts");
  const runTurn = read("mini-services/hermes-chat/hermes-connector.ts");
  const runnerF = read("mini-services/hermes-chat/turn-runner.ts");
  check("connector : REST tenté puis WS en repli, dans cet ordre, même moteur",
    runTurn.indexOf("runRestTurn(") < runTurn.indexOf("return await this.runGatewayTurn(req, cb)") &&
      runTurn.includes("MÊME moteur, jamais un") &&
      runTurn.includes("restTurnCandidate(req)"));
  check("connector : REST refusé pour les tours avec pièces jointes",
    runTurn.includes("!req.motorSessionId || req.attachments?.length"));
  check("liaison : idempotente (201 OU 409) et non bloquante (échec → null)",
    mrF.includes("res.ok || res.status === 409") &&
      runnerF.includes("await ensureConversationMotorLink(") &&
      mrF.includes("if (!ok)") && mrF.includes("return null"));
  check("liaison : écrit la base LOCALE, jamais la base du moteur",
    mrF.includes("store.setConversationMotorSession(conversationId, sessionId)") &&
      mrF.includes("DELETE") === false && mrF.includes("PATCH") === false);
  check("moteur : seuls POST /api/sessions et /chat/stream sont appelés",
    mrF.includes("/api/sessions`") && mrF.includes("/chat/stream`") &&
      mrF.includes("/messages") === false && mrF.includes("/fork") === false);
  check("stop utilisateur : partiel rendu sans repli (pas de travail relancé)",
    mrF.includes("signal.aborted") && runTurn.includes("cb.signal.aborted"));

  console.log("[16] mise à jour du lanceur : relance automatique, jamais de boucle ((76))");
  // Cas réel du 23/11 : la fenêtre tournait avec le lanceur d'AVANT la mise
  // à jour (PowerShell/bash ne relisent jamais leur propre fichier) — les
  // vieux messages restent affichés et l'installateur Python posé par la
  // mise à jour semblait ne rien faire. La relance immédiate du lanceur
  // mis à jour supprime ce retard d'un démarrage ; le marqueur (5 min côté
  // Windows, variable d'environnement côté Unix, conservée par exec)
  // interdit toute boucle de fenêtres.
  const shU = read("desktop/hermes-ui.sh");
  const psU = read("desktop/hermes-ui.ps1");
  check("sh : relance par exec du lanceur mis à jour, garde anti-boucle",
    shU.includes('exec bash "$0" start') &&
      shU.includes("HERMES_RELANCE") &&
      shU.includes("desktop/hermes-ui\\.sh$"));
  check("ps1 : relance Start-Process du lanceur mis à jour, marqueur 5 min",
    psU.includes("lanceur-relance.flag") &&
      psU.includes("$PSCommandPath") &&
      psU.includes("TotalMinutes -lt 5"));
  check("relance seulement pour start/restart (status/stop : pas de fenêtre surprise)",
    psU.includes("$Action -eq 'start' -or $Action -eq 'restart'"));
  check("relance APRÈS l'invalidation du build (le nouveau passage reconstruira)",
    psU.indexOf("Remove-Item -Recurse -Force (Join-Path $Root '.next')") < psU.indexOf("lanceur-relance.flag") &&
      shU.indexOf("rm -rf \"$ROOT/.next\"") < shU.indexOf("HERMES_RELANCE"));

  console.log("[17] le lanceur ALLUME l'agent — jamais seulement sondé ((77))");
  // Cas réel du 23/11 matin : Phase 0 toute verte (Git, Python portable
  // 3.14.3, pip, bun, caddy ✓), interface et passerelle répondaient — et
  // pourtant le bandeau restait « Hermes éteint · vos clés répondent ».
  // Cause : après la liaison passerelle, le lanceur se bornait à SONDER le
  // port 9120 (son commentaire le disait : « branché sur notre agent, sur
  // le vôtre déjà en marche, ou muet ») et PERSONNE n'allumait jamais
  // run_api.py — ni le ps1, ni le sh, ni l'interface. Complété : l'essai de
  // certification s'arrête toujours, puis Start-AgentRuntime /
  // start_agent_runtime allument le vrai, l'adoptent s'il tourne déjà,
  // écrivent la cause honnête (db/agent.log) sinon ; l'arrêt propre tue le
  // PID enregistré ; Install-AgentIntoHome tourne après la Phase 0 (elle
  // a besoin du Python portable), plus avant.
  const psN = psU.replace(/\r\n/g, "\n");
  check("ps1 : Start-AgentRuntime existe, PID en état",
    psN.includes("function Start-AgentRuntime") &&
      psN.includes("State-Set 'AGENT_PID'") &&
      psN.includes("Test-PortBusy 9120"));
  check("[78] LA COMMANDE OFFICIELLE amont, des deux lanceurs : python -m hermes_cli.main --profile default gateway run --quiet (cwd racine)",
    // Prouvé dans le dépôt amont : hermes_cli/gateway_runtime_start.py l.93
    // construit exactement [python, -m, hermes_cli.main, --profile, default,
    // gateway, run, --quiet] avec cwd = racine ; le listener 9120 est
    // gateway/webapp_listener.py (DEFAULT_PORT = 9120). Lancer
    // gateway/run_api.py en fichier était doublement faux : package
    // `gateway` non importable depuis son dossier (ModuleNotFoundError,
    // cas réel du 23/11 06:34) ET module qui exige un appelant ayant déjà
    // initialisé l'autorité de session.
    psN.includes("'-m', 'hermes_cli.main', '--profile', 'default', 'gateway', 'run', '--quiet'") &&
      shU.includes("-m hermes_cli.main --profile default gateway run --quiet") &&
      shU.includes('PYTHONIOENCODING=utf-8'));
  check("ps1 : appelé dans le flux juste avant la sonde 9120",
    /Start-AgentRuntime\r?\n\s*if \(Test-PortBusy 9120\)/.test(psU));
  check("arrêt propre : marque = le runtime supervise (plus run_api.py), les deux lanceurs",
    psN.includes("Stop-Tree 'AGENT_PID' $MAgent") &&
      psN.includes("$MAgent = 'hermes_cli\\.main.*gateway'") &&
      shU.includes('stop_tree AGENT_PID "hermes_cli\\.main.*gateway" TERM') &&
      shU.includes('wait_tree_gone AGENT_PID "hermes_cli\\.main.*gateway" 10'));
  check("ps1 : Install-AgentIntoHome déplacé APRÈS Phase-Prerequis (Python portable prêt)",
    (() => {
      // Lignes d'APPEL seules (la définition de fonction vit plus haut,
      // entre les deux appels — ce n'est pas elle qu'on ordonne).
      const upd = psN.search(/^\s{4}Update-FromGit\s*$/m);
      const pha = psN.search(/^\s{4}Phase-Prerequis\s*$/m);
      const ins = psN.search(/^\s{4}Install-AgentIntoHome\s*$/m);
      return upd > -1 && pha > upd && ins > pha &&
        psN.slice(upd, pha).search(/^\s{4}Install-AgentIntoHome\s*$/m) === -1;
    })());
  check("sh : start_agent_runtime existe, PID dans l'état, appelé avant la sonde",
    shU.includes("start_agent_runtime()") &&
      shU.includes("state_set AGENT_PID") &&
      /start_agent_runtime\r?\n\s*if port_open 9120/.test(shU));
  check("sh : status connaît l'agent (la marque d'arrêt est vérifiée plus haut, [78])",
    shU.includes('"AGENT_PID:run_api.py:AGENT_OWNED:agent"'));
  check("allumage honnête : cause écrite si l'agent ne répond pas (db/agent.log), jamais de Die",
    psN.includes("db\\agent.log") && shU.includes("db/agent.log"));

  console.log("[79] le portable EMBEDDABLE voit le code de l'agent — le ._pth doit contenir sa racine");
  // Cas réel du 23/11 12:03 : `ModuleNotFoundError: No module named
  // 'hermes_cli'` avec LE PORTABLE (F:\...\python-portable\python.exe). Le
  // « zip autonome » de python.org est l'embeddable : son ._pth force le
  // mode isolé — ni le dossier courant ni PYTHONPATH ne sont cherchés, même
  // en `python -m` avec le bon répertoire de travail. Le ps1 ouvrait déjà ce
  // ._pth pour pip (Lib\site-packages + import site) mais jamais pour le
  // code du dépôt. Corrigé : Add-AgentToPth inscrit la racine hermes-agent
  // dans le ._pth (idempotent, fichier du dossier de l'interface), appelé
  // AVANT l'essai de certification ET avant l'allumage ; le venv et les
  // pythons système ignorent le ._pth (aucun effet de bord). sh : PYTHONPATH
  // explicite par parité prudente.
  check("ps1 : Add-AgentToPth existe, écrit dans python*._pth, idempotent",
    psN.includes("function Add-AgentToPth") &&
      psN.includes("Filter 'python*._pth'") &&
      psN.includes("AppendAllText($pth.FullName") &&
      psN.includes("-ieq $houseDir"));
  check("ps1 : appelé AVANT l'essai de certification ET avant l'allumage",
    /Add-AgentToPth \$homeDir\r?\n\s*try \{ \$env:PYTHONIOENCODING/.test(psU) &&
      /Add-AgentToPth \$house\r?\n\s*try \{ \$env:PYTHONIOENCODING/.test(psU));
  check("sh : PYTHONPATH explicite dans les deux lancements (certification + allumage)",
    (shU.match(/PYTHONPATH="\$maison\$\{PYTHONPATH:\+:\$PYTHONPATH\}"/g) || []).length >= 2);

  console.log("[80] les dépendances viennent du DÉPÔT (pyproject.toml) — jamais d'une liste en dur");
  // Cas réel du 23/11 13:44 : `ModuleNotFoundError: No module named
  // 'ruamel'`. Le dépôt amont n'a PAS de requirements.txt : ses 45
  // dépendances core (ruamel.yaml, fastapi, uvicorn, pydantic, pywin32…,
  // pins exacts pour python 3.14 avec marqueurs) vivent dans
  // pyproject.toml. L'ancien lanceur, sans requirements.txt, écrivait
  // « sans-requirements » et n'installait RIEN. Corrigé : extraction
  // tomllib de [project].dependencies vers runtime/agent-requirements.txt
  // (régénérée dès que le pyproject est plus récent — un pull suffit),
  // repli sur requirements.txt du dépôt s'il en acquiert un un jour,
  // purge du marqueur périmé, timeout pip 5→10 min (45 paquets).
  check("ps1 : extraction tomllib de pyproject.toml vers agent-requirements.txt, régénérée si plus récent",
    psN.includes("agent-requirements.txt") &&
      psN.includes("tomllib.load(open(sys.argv[1],'rb'))") &&
      psN.includes("LastWriteTime -gt (Get-Item $req).LastWriteTime") &&
      psN.includes("Test-Path $reqDepot"));
  check("ps1 : le marqueur « sans-requirements » périmé est purgé (retente l'install)",
    psN.includes("sans-requirements") && psN.includes("Remove-Item $depsOk"));
  check("ps1 + sh : timeout pip 600 s (45 paquets)",
    psN.includes("-Timeout 600") && (shU.match(/timeout 600/g) || []).length >= 3);
  check("sh : extraction tomllib + repli requirements.txt du dépôt + purge marqueur vide",
    shU.includes("agent-requirements.txt") &&
      shU.includes('tomllib.load(open(sys.argv[1],"rb"))') &&
      shU.includes('[ "$maison/pyproject.toml" -nt "$genreq" ]') &&
      shU.includes("local reqsrc=") &&
      !shU.includes('-r "$maison/requirements.txt"'));
  check("sh : l'ancien early-return « requirements absent → rien installer » est parti",
    !/if \[ ! -f "\$maison\/requirements\.txt" \]; then\n\s*\[ -f "\$depsok" \] \|\| touch/.test(shU));

  console.log("[81] le starter de l'INTERFACE lance la COMMANDE OFFICIELLE (plus de run_api.py)");
  // Cas réel du 23/11 après-midi : la carte « Moteur Hermes » affichait
  // « Cause connue, lue dans le journal : ModuleNotFoundError 'gateway' » —
  // erreur corrigée au (78) CÔTÉ LANCEUR mais vivante dans le second chemin
  // d'allumage : agent-starter.ts (mini-service) spawnait encore
  // `gateway/run_api.py` en fichier (package non importable depuis son
  // dossier, pas de __main__). Corrigé : même commande officielle que le
  // (78), PYTHONPATH/env, garde hermes_cli/main.py ; et la cause affichée
  // n'est lue que DEPUIS le dernier « lancement automatique » (une erreur
  // périmée ne passe plus pour actuelle).
  const starterUi = read("mini-services/hermes-chat/agent-starter.ts");
  const motorUi = read("mini-services/hermes-chat/agent-motor.ts");
  check("starter : plus AUCUN lancement de gateway/run_api.py",
    !starterUi.includes('"gateway", "run_api.py"') &&
      !starterUi.includes("join(agentDir, \"gateway\")"));
  check("starter : la commande officielle amont littérale (comme le (78))",
    starterUi.includes('"-m", "hermes_cli.main", "--profile", "default", "gateway", "run", "--quiet"'));
  check("starter : garde hermes_cli/main.py + env PYTHONIOENCODING/PYTHONPATH",
    starterUi.includes('"hermes_cli", "main.py"') &&
      starterUi.includes("PYTHONIOENCODING") &&
      starterUi.includes("PYTHONPATH"));
  check("starter : marqueur « lancement automatique » écrit AVANT le spawn",
    starterUi.indexOf("lancement automatique") < starterUi.indexOf("const child = spawn"));
  check("motor : la cause ne lit que depuis le dernier lancement",
    motorUi.includes('lastIndexOf("lancement automatique")'));

  console.log("[82] la carte distingue cause-dépendances (remède : relance) et maj CLI");
  // Cas réel du 23/11 : cause « ModuleNotFoundError 'ruamel' » affichée à
  // côté du bouton « Mettre à jour » — la juxtaposition laissait croire que
  // la mise à jour de la CLI corrigait une cause qui relève du lanceur
  // (dépendances de la copie du dossier). La carte dit maintenant le bon
  // remède quand la cause est un défaut de modules.
  const motorCardUi = read("src/components/settings/agent-motor-card.tsx");
  check("carte : le défaut de dépendances renvoie à la RELANCE de l'application",
    motorCardUi.includes("modulenotfounderror|importerror") &&
      motorCardUi.includes("relancez simplement l&apos;application") &&
      motorCardUi.includes("installe les dépendances depuis le dépôt du projet"));
  check("carte : le bouton CLI est explicitement dit non pertinent pour cette cause",
    motorCardUi.includes("n&apos;y répond pas"));

  console.log("[83] deps : plus de verrou horaire, échec détaillé, preuve par import");
  // Cas réel du 23/11 : deux relances rapprochées, toujours « ruamel » —
  // l'ancien verrou « au plus tôt dans 1 h » sautait chaque nouvelle
  // tentative, le détail de l'échec pip était jeté, et « installées »
  // pouvait être écrit sans qu'aucun module ne s'importe vraiment.
  const ps183 = read("desktop/hermes-ui.ps1");
  const sh83 = read("desktop/hermes-ui.sh");
  const ps1Deps = ps183.split("\n").filter((l) => /dépendances/i.test(l)).join("\n");
  const shDeps = sh83.split("\n").filter((l) => /dépendances/i.test(l)).join("\n");
  check("ps1 : plus AUCUN verrou horaire sur les dépendances",
    !ps183.includes("depsDejaTentees") && !ps1Deps.includes("au plus tôt dans 1 h"));
  check("ps1 : l'échec pip montre ses dernières lignes",
    ps183.includes("détail de l'échec pip") && ps183.includes("Select-Object -Last 6"));
  check("ps1 : dépendances PROUVÉES par import de ruamel.yaml",
    ps183.includes('-c "import ruamel.yaml"') && ps183.includes("PROUVÉES par import"));
  check("ps1 : filet pip absent (testé avant l'installation)",
    ps183.includes("-m pip --version"));
  check("sh : plus AUCUN verrou horaire sur les dépendances",
    !sh83.includes("depsrecent") && !shDeps.includes("au plus tôt dans 1 h"));
  check("sh : l'échec pip montre la fin du journal",
    sh83.includes("Dernières lignes pip") && sh83.includes("tail -n 3"));
  check("sh : dépendances PROUVÉES par import de ruamel.yaml",
    sh83.includes('import ruamel.yaml" >/dev/null') && sh83.includes("PROUVÉES par import"));

  console.log(failures === 0 ? "\nGardes de source : 0 échec" : `\nGardes de source : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
