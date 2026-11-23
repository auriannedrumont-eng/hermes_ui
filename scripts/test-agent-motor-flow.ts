// Test E2E du volet « Moteur Hermes » (v0.4.0) — mise à jour, contrôle,
// retour arrière, carnet de bord. Tout est stubbé : faux binaire `hermes`
// (script shell qui simule --version / update / gateway stop), faux dépôt
// git avec tags v0.9.0 / v0.10.0, fausse release GitHub (serveur HTTP
// local), fausse gateway (/api/model/options). Aucun réseau, aucun tour.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Partie A : briques pures ────────────────────────────────────────────────
async function partA() {
  console.log("\nPartie A — briques pures");
  const M = await import("../mini-services/hermes-chat/agent-motor");
  check("parseVersion « hermes v1.2.3 (build) » → 1.2.3", M.parseVersion("hermes v1.2.3 (build)") === "1.2.3");
  check("parseVersion « rien » → null", M.parseVersion("pas de version ici… si") === null);
  check("compareVersions 0.10 > 0.9", M.compareVersions("0.10.0", "0.9.0") > 0);
  check("compareVersions 0.9 < 0.9.1", M.compareVersions("0.9", "0.9.1") < 0);
  check("compareVersions 1.0 == 1.0.0", M.compareVersions("1.0", "1.0.0") === 0);
  check("notes « gateway websocket » → touche l'interface", M.releaseTouchesInterface("Renamed the gateway websocket protocol") === true);
  check("notes « faster startup » → ne touche pas", M.releaseTouchesInterface("Faster startup and small fixes") === false);

  process.env.HERMES_CHAT_DB = `/tmp/hermes-motor-a-${Date.now()}.sqlite`;
  const { Store } = await import("../mini-services/hermes-chat/store");
  const store = new Store();
  M.journalAppend(store, { type: "version", label: "Premier", resultat: "ok" });
  M.journalAppend(store, { type: "maj", label: "Deuxième", resultat: "echec" });
  const list = M.journalList(store);
  check("carnet : ordre antichronologique", list.length === 2 && list[0].label === "Deuxième", JSON.stringify(list.map((e) => e.label)));
  check("carnet : identifiants uniques", list[0].id !== list[1].id);
  await usingClosing(store);
}

function usingClosing(store: { close?: () => void }) {
  store.close?.();
  return Promise.resolve();
}

// ── Partie B : flux complet avec stubs ─────────────────────────────────────
async function partB() {
  console.log("\nPartie B — flux complet (stubs)");
  const root = `/tmp/hermes-motor-b-${Date.now()}`;
  mkdirSync(root, { recursive: true });
  const agentDir = join(root, "agent");

  // Faux dépôt git de l'agent : deux tags, VERSION porté par le checkout.
  const git = (args: string[]) =>
    spawnSync("git", ["-C", agentDir, ...args], { encoding: "utf8" });
  mkdirSync(agentDir, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "test@local"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(agentDir, "VERSION"), "0.9.0\n");
  git(["add", "-A"]); git(["commit", "-qm", "v0.9.0"]); git(["tag", "v0.9.0"]);
  writeFileSync(join(agentDir, "VERSION"), "0.10.0\n");
  git(["add", "-A"]); git(["commit", "-qm", "v0.10.0"]); git(["tag", "v0.10.0"]);
  // État initial : l'agent « installé » tourne la version 0.9.0.
  git(["checkout", "-q", "v0.9.0"]);
  check("dépôt stub : deux tags posés", git(["tag", "-l"]).stdout.trim().split("\n").length === 2);

  // Faux binaire `hermes` : version lue dans VERSION, update = checkout.
  const bin = join(root, "hermes-stub.sh");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `DIR="${agentDir}"`,
      'case "$1" in',
      '  --version) cat "$DIR/VERSION" ;;',
      "  update)",
      '    echo "stub: sauvegarde complete avant mise a jour"',
      '    git -C "$DIR" checkout -q v0.10.0',
      '    echo "stub: nouvelle version installee" ;;',
      "  gateway)",
      '    echo "stub: gateway arrêtée" ;;',
      "esac",
    ].join("\n"),
    "utf-8"
  );
  chmodSync(bin, 0o755);

  // Fausse release GitHub + fausse gateway : deux serveurs locaux.
  const relBody = "## What's new\n- Renamed the gateway websocket protocol\n- Faster startup";
  const relSrv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/latest") return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          tag_name: "v0.10.0",
          name: "Hermes 0.10.0",
          body: relBody,
          html_url: "https://github.com/NousResearch/hermes-agent/releases/v0.10.0",
          published_at: new Date().toISOString(),
        }),
        { headers: { "content-type": "application/json" } }
      );
    },
  });
  const gwSrv = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/model/options"))
        return new Response(
          JSON.stringify({ models: [{ id: "hermes-test" }, { id: "hermes-test-2" }] }),
          { headers: { "content-type": "application/json" } }
        );
      return new Response("not found", { status: 404 });
    },
  });

  process.env.HERMES_AGENT_BIN = bin;
  process.env.HERMES_AGENT_DIR = agentDir;
  process.env.HERMES_AGENT_RELEASES_URL = `http://127.0.0.1:${relSrv.port}/latest`;
  process.env.HERMES_CHAT_DB = join(root, "test.sqlite");
  process.env.HERMES_MOTOR_LOG = join(root, "motor.log");

  const M = await import("../mini-services/hermes-chat/agent-motor");
  const { Store } = await import("../mini-services/hermes-chat/store");
  const store = new Store();
  const events: string[] = [];
  const deps = {
    store,
    connector: {
      gatewayUrl: `http://127.0.0.1:${gwSrv.port}`,
      gatewayToken: null,
    } as unknown as import("../mini-services/hermes-chat/hermes-connector").HermesConnector,
    emit: (event: string) => events.push(event),
  };

  // 1. État initial : 0.9.0 installée, 0.10.0 publiée + marqueur interface.
  let st = await M.refreshMotorStatus(deps);
  check("état : version installée 0.9.0", st.installed === "0.9.0", st.installed ?? "null");
  check("état : release 0.10.0 détectée", st.release?.tag === "0.10.0", st.release?.tag ?? "null");
  check("état : marqueur « touche l'interface »", st.release?.touchesInterface === true);
  check("état : dossier agent résolu", st.agentDir === agentDir, st.agentDir ?? "null");
  check("diffusion agent:motor-changed émise", events.includes("agent:motor-changed"));

  // 2. Contrôle des sens : gateway stub → tout va bien.
  let ctl = await M.runSensesCheck(deps);
  check("contrôle : liaison + modèles OK", ctl.ok && ctl.liaison === "ok" && ctl.modeles === "ok");
  check("contrôle : version lue", ctl.versionLue === "0.9.0", ctl.versionLue ?? "null");

  // 3. Mise à jour : hermes update --backup (stub) → 0.10.0 + contrôle OK.
  const upd = await M.startAgentUpdate(deps);
  check("mise à jour : aboutie", upd.ok, upd.error ?? "");
  st = M.getMotorState();
  check("mise à jour : version 0.10.0 lue après", st.installed === "0.10.0", st.installed ?? "null");
  check("filet : version précédente 0.9.0 retenue", st.previousVersion === "0.9.0", st.previousVersion ?? "null");
  check("mise à jour : release absorbée (plus rien à installer)", st.release === null);
  const logText = M.motorLogRead().text;
  check("journal : marqueur MOTEUR MAJ OK", logText.includes("MOTEUR MAJ OK"));
  check("journal : marqueur CONTRÔLE OK", logText.includes("CONTRÔLE OK"));
  const jr = M.journalList(store);
  check("carnet : mise à jour notée", jr.some((e) => e.type === "maj" && e.version === "0.10.0"));

  // 3.b §9 (64) : Hermes EN MARCHE → refus immédiat en français, le binaire
  // officiel n'est jamais lancé, aucune sonde silencieuse ne fuit dans le
  // journal (capture réelle : « ✕ arrêté : plus de 4 s sans fin »).
  const logAvant = M.motorLogRead().text;
  process.env.HERMES_AGENT_GATEWAY_PORT = String(gwSrv.port); // un port QUI RÉPOND
  const refus = await M.startAgentUpdate(deps);
  check("refus : Hermes en marche → mise à jour refusée d'entrée", refus.ok === false, refus.error ?? "");
  check("refus : la marche à suivre est dite en français", (refus.error ?? "").toLowerCase().includes("fermez"));
  const ajoute = M.motorLogRead().text.slice(logAvant.length);
  check("refus : le binaire officiel n'a pas été lancé", !ajoute.includes("update --backup"));
  check("refus : aucune sonde silencieuse ne fuit (« arrêté »)", !ajoute.includes("(arrêté"));
  check("refus : aucune opération réservée", M.getMotorState().op === null);
  process.env.HERMES_AGENT_GATEWAY_PORT = "1"; // port vide — la suite du flux reste possible

  // 4. Problème simulé : la gateway ne répond plus (autre connecteur).
  const depsDown = {
    ...deps,
    connector: {
      gatewayUrl: `http://127.0.0.1:${relSrv.port}`, // rien sur /api/model/options
      gatewayToken: null,
    } as unknown as import("../mini-services/hermes-chat/hermes-connector").HermesConnector,
  };
  ctl = await M.runSensesCheck(depsDown);
  check("problème : contrôle en échec honnête", !ctl.ok && ctl.liaison === "echec");
  check("problème : version toujours lisible (moteur présent)", ctl.versionLue === "0.10.0");
  check("carnet : contrôle en échec noté", M.journalList(store)[0].type === "controle" && M.journalList(store)[0].resultat === "echec");

  // 5. Retour arrière : procédure officielle → retour aux fichiers 0.9.0.
  const rb = await M.startAgentRollback(deps);
  check("retour arrière : abouti", rb.ok, rb.error ?? "");
  st = M.getMotorState();
  check("retour arrière : version revenue à 0.9.0", st.installed === "0.9.0", st.installed ?? "null");
  check("retour arrière : filet consommé (plus de précédente)", st.previousVersion === null);
  const rev = spawnSync("git", ["-C", agentDir, "describe", "--tags"], { encoding: "utf8" });
  check("retour arrière : checkout git réel sur v0.9.0", rev.stdout.trim().startsWith("v0.9.0"), rev.stdout.trim());
  check("journal : marqueur RETOUR OK", M.motorLogRead().text.includes("RETOUR OK"));
  check("carnet : retour noté", M.journalList(store).some((e) => e.type === "retour" && e.version === "0.9.0"));

  // 6. Second retour sans version précédente : refus propre.
  const rb2 = await M.startAgentRollback(deps);
  check("retour sans précédente : refusé avec explication", !rb2.ok && /aucune version précédente/.test(rb2.error ?? ""), rb2.error ?? "");

  store.close?.();
  relSrv.stop(true);
  gwSrv.stop(true);
  rmSync(root, { recursive: true, force: true });
}

// ── Lancement ───────────────────────────────────────────────────────────────
async function main() {
  console.log("Test E2E — Moteur Hermes (agent-motor)");
  await partA();
  await partB();
  console.log(`\n${passed} vérifications passées, ${failed} échouées`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => {
  console.error("échec inattendu :", err);
  process.exit(1);
});
