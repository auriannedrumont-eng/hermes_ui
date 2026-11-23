// Test du module fil-live (v0.5.1) : les parseurs des journaux vivaient en
// double exemplaire dans les deux cartes de la section Système sans aucun
// test. Ici : les phrases RÉELLES des producteurs (desktop/hermes-ui.sh,
// desktop/hermes-ui.ps1, mini-services/hermes-chat/agent-motor.ts et le
// service lui-même), la régression v0.5.0 (ligne « ATTENTION … non
// appliquée » captée trop tôt par startsWith("attention") → branche
// morte), les verdicts à marqueur (A-1) et l'horloge du fil.
// Convention : exit 0 = tout passe, exit 1 = échec.
import {
  sansAccents,
  splitHeure,
  verdictApp,
  verdictMotor,
  derniereLigne,
  traduireLigneApp,
  traduireLigneMotor,
  parseFil,
  heureVersMs,
} from "../src/components/settings/fil-live";

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

// ── Partie 1 : briques pures ───────────────────────────────────────────────
console.log("\nPartie 1 — briques pures");
check("sansAccents retire accents et casse", sansAccents("ATTENTION - Version GitHub Appliquée") === "attention - version github appliquee");
check("splitHeure sur ligne horodatée", (() => { const r = splitHeure("[07:42:11] MAJ OK - pile relancée"); return r.heure === "07:42:11" && r.texte === "MAJ OK - pile relancée"; })());
check("splitHeure sans préfixe → heure null, texte intact", (() => { const r = splitHeure("ligne brute"); return r.heure === null && r.texte === "ligne brute"; })());
check("derniereLigne ignore les lignes vides", derniereLigne("[10:00:00] a\n\n[10:00:01] b\n\n") === "[10:00:01] b");
check("derniereLigne vide → chaîne vide", derniereLigne("") === "");

// ── Partie 2 : verdicts à marqueur (A-1) ───────────────────────────────────
console.log("\nPartie 2 — verdicts à marqueur (A-1)");
check("verdictApp : MAJ OK", verdictApp("[07:42:11] MAJ OK - pile relancée") === "ok");
check("verdictApp : MAJ ERREUR", verdictApp("[07:41:02] MAJ ERREUR - échec de la relance") === "erreur");
check("verdictApp : la DERNIÈRE ligne marquée fait foi (erreur après OK)", verdictApp("[07:41:00] MAJ OK - a\n[07:42:00] MAJ ERREUR - b") === "erreur");
check("verdictApp : ligne suivant le verdict ne masque pas le marqueur", verdictApp("[07:41:00] MAJ OK - terminé\n[07:41:01] une ligne de plus") === "ok");
check("verdictApp : aucun marqueur → null", verdictApp("[07:40:00] consultation de GitHub…") === null);
check("verdictMotor : MOTEUR MAJ OK", verdictMotor("[11:00:01] MOTEUR MAJ OK — mise à jour installée par Hermes.") === "ok");
check("verdictMotor : RETOUR OK", verdictMotor("[11:05:00] RETOUR OK — Hermes est revenu à la version 4.2.1") === "ok");
check("verdictMotor : RETOUR EFFECTUÉ (accents réels du moteur)", verdictMotor("[11:05:00] RETOUR EFFECTUÉ (version 4.2.1) mais l'agent n'a pas répondu") === "ok");
check("verdictMotor : CONTRÔLE OK", verdictMotor("[11:02:00] CONTRÔLE OK — l'interface reçoit bien les infos.") === "ok");
check("verdictMotor : MOTEUR MAJ ERREUR", verdictMotor("[11:00:01] MOTEUR MAJ ERREUR — la mise à jour n'a pas abouti") === "erreur");
check("verdictMotor : CONTRÔLE ÉCHOUÉ n'est PAS un verdict (le retour peut suivre)", verdictMotor("[11:03:00] CONTRÔLE ÉCHOUÉ — la gateway ne répond pas.") === null);

// ── Partie 3 : traducteur APPLICATION (phrases réelles des lanceurs) ───────
console.log("\nPartie 3 — traducteur application (lanceurs .sh/.ps1)");
const T = (s: string) => traduireLigneApp(s);

// Régression v0.5.0 : cette ligne commençait par « ATTENTION » ET portait
// « non appliquée … version locale conservée » — la règle startsWith
// ("attention") capturait avant la règle spécialisée (branche morte).
const NON_APPLIQUEE_SH = "[07:41:30] ATTENTION - nouvelle version disponible mais non appliquée — version locale conservée";
const NON_APPLIQUEE_PS1 = "[07:41:30] ATTENTION - nouvelle version disponible mais non appliquee — version locale conservee";
check("régression : « non appliquée » traduite (sh, avec accents)", T(NON_APPLIQUEE_SH).classe === "ko" && !T(NON_APPLIQUEE_SH).texte.startsWith("ATTENTION"), JSON.stringify(T(NON_APPLIQUEE_SH)));
check("régression : « non appliquée » traduite (ps1, sans accents)", T(NON_APPLIQUEE_PS1).classe === "ko" && !T(NON_APPLIQUEE_PS1).texte.startsWith("ATTENTION"), JSON.stringify(T(NON_APPLIQUEE_PS1)));
// Le ps1 écrit « ATTENTION - build de production echoue » (sans accents).
check("régression : « build échoué » traduit (ps1, mode développement)", T("[07:41:40] ATTENTION - build de production echoue — l'interface demarrera en mode developpement").texte.includes("mode développement"), JSON.stringify(T("[07:41:40] ATTENTION - build de production echoue — l'interface demarrera en mode developpement")));
check("« ATTENTION » inconnu reste brut (jamais masqué)", (() => { const r = T("[07:41:50] ATTENTION - quelque chose d'inédit"); return r.texte === "ATTENTION - quelque chose d'inédit" && r.classe === "ko"; })());

check("MAJ OK → phrase de fin, jalon 3, classe ok", (() => { const r = T("[07:42:11] MAJ OK - pile relancée, rafraîchissez l'onglet Hermes (F5)"); return r.jalon === 3 && r.classe === "ok" && r.texte.includes("Rechargez la page"); })());
check("MAJ ERREUR → phrase d'échec, classe ko", (() => { const r = T("[07:41:02] MAJ ERREUR - échec de la relance (détail : ...)"); return r.classe === "ko" && r.texte.includes("n'a pas abouti"); })());
check("Demande déposée (service) → jalon 0", T("[07:40:00] Demande déposée depuis l'interface — attente du lanceur (cycle de surveillance ≤ 15 s)…").jalon === 0);
check("MAJ DEBUT (sh et ps1) → jalon 0", T("[07:40:05] MAJ DEBUT - demande ramassee par le lanceur").jalon === 0);
check("arret des services (ps1 sans accents) → jalon 0", T("[07:40:06] arret des services...").jalon === 0);
check("consultation de GitHub… → jalon 1", T("[07:40:10] consultation de GitHub...").jalon === 1);
check("fusion directe impossible (ps1) → jalon 1, promesse sauvegarde", (() => { const r = T("[07:40:12] fusion directe impossible — sauvegarde des fichiers locaux modifies, puis alignement sur GitHub..."); return r.jalon === 1 && r.texte.includes("jamais perdues") === false && r.texte.includes("mises de côté"); })());
check("mise à jour appliquée (sh) → jalon 1", T("[07:40:20] mise à jour appliquée : 24 fichier(s) récupéré(s)").jalon === 1);
check("version GitHub appliquée (ps1) → jalon 1", T("[07:40:20] version GitHub appliquee (dossier aligne sur le depot distant)").jalon === 1);
check("code de l'interface modifié → jalon 2 (reconstruction)", T("[07:40:22] code de l'interface modifie — reconstruction lancee (1 a 3 minutes)...").jalon === 2);
check("reconstruction (sh) → jalon 2", T("[07:40:22] code de l'interface modifié — reconstruction (1 à 3 minutes)…").jalon === 2);
check("construction de l'interface (ps1, relance) → jalon 2", T("[07:40:30] construction de l'interface (1 a 3 minutes)...").jalon === 2);
check("relance des services (sh, accents) → jalon 2", T("[07:41:00] relance des services…").jalon === 2);
check("services arretes (ps1) → jalon 2", T("[07:40:11] services arretes...").jalon === 2);
check("déjà à jour (sh) → verdict ok, jalon 3", (() => { const r = T("[07:40:12] déjà à jour — aucune nouvelle version sur GitHub"); return r.jalon === 3 && r.classe === "ok"; })());
check("deja a jour (ps1, sans accents) → verdict ok", T("[07:40:12] deja a jour — aucune nouvelle version sur GitHub").classe === "ok");
check("GitHub injoignable (ps1) → incident ko", T("[07:40:11] GitHub injoignable (reseau ou connexion) — version locale conservee").classe === "ko");
check("pas de branche distante (ps1) → incident ko", T("[07:40:11] pas de branche distante suivie — version locale conservee").classe === "ko");
check("remarque lanceur (ps1) → conseil de relance, pas d'incident", (() => { const r = T("[07:42:12] remarque - le lanceur lui-meme a ete mis a jour : fermez sa fenetre puis relancez Hermes-Web.bat (une seule fois)"); return r.classe === "" && r.texte.includes("relancez"); })());
check("ligne inconnue → brute, neutre", (() => { const r = T("[07:40:13] une ligne que personne n'a prévue"); return r.texte === "une ligne que personne n'a prévue" && r.jalon === -1 && r.classe === ""; })());

// ── Partie 4 : traducteur MOTEUR (phrases réelles d'agent-motor.ts) ────────
console.log("\nPartie 4 — traducteur moteur (agent-motor.ts)");
const M = (s: string) => traduireLigneMotor(s);
check("mise à jour du moteur demandée → jalon 0", M("[11:00:00] mise à jour du moteur Hermes demandée depuis l'interface — version actuelle 4.2.1, gardée en mémoire pour un retour arrière").jalon === 0);
check("$ commande → ligne technique neutre", (() => { const r = M("[11:00:01] $ hermes update --backup"); return r.jalon === -1 && r.classe === ""; })());
check("MOTEUR MAJ OK → jalon 3 (contrôle suit)", M("[11:01:00] MOTEUR MAJ OK — mise à jour installée par Hermes. Contrôle de l'interface…").jalon === 3);
check("CONTRÔLE OK → classe ok", M("[11:01:30] CONTRÔLE OK — l'interface reçoit bien les infos du moteur.").classe === "ok");
check("CONTRÔLE ÉCHOUÉ → classe ko", M("[11:01:30] CONTRÔLE ÉCHOUÉ — la gateway ne répond pas. Un retour arrière vers 4.2.1 est proposé dans le volet Système.").classe === "ko");
check("retour arrière demandé → jalon 0", M("[11:05:00] retour arrière demandé — procédure officielle de Hermes, retour vers la version 4.2.1").jalon === 0);
check("étape 1/3 → jalon 1", M("[11:05:01] étape 1/3 — arrêt de la gateway Hermes…").jalon === 1);
check("étape 2/3 → jalon 2", M("[11:05:05] étape 2/3 — retour aux fichiers de la version 4.2.1…").jalon === 2);
check("étape 3/3 → jalon 3", M("[11:05:10] étape 3/3 — relancez l'agent Hermes comme d'habitude : le contrôle suivra tout seul (jusqu'à 2 minutes).").jalon === 3);
check("RETOUR EFFECTUÉ → classe ok", M("[11:06:00] RETOUR EFFECTUÉ (version 4.2.1) mais l'agent n'a pas répondu au contrôle — relancez l'agent, puis « Revérifier » dans le volet Système.").classe === "ok");
check("commande introuvable → incident ko", M("[11:05:02] commande introuvable : spawn hermes ENOENT").classe === "ko");
check("ligne brute du stdout → neutre", M("[11:00:30] Downloading hermes-agent 4.3.0 ...").classe === "");

// §9 (64) : le refus du programme officiel quand Hermes tourne déjà —
// capture réelle du 23 (refus anglais brut + ✕ « arrêté : plus de 4 s »).
check("REFUSÉ (Hermes en marche) → mots simples, classe ko", (() => { const r = M("[11:00:01] MOTEUR MAJ REFUSÉ — Hermes est en marche : le programme officiel refuse de se mettre à jour tant qu'il tourne (fichiers verrouillés). Fermez l'application Hermes et les autres terminaux Hermes, puis refaites la mise à jour ici — rien n'a été modifié."); return r.texte.includes("refuse de se mettre à jour tant qu'il tourne") && r.classe === "ko"; })());
check("ligne .pyd du refus officiel → expliquée", M("[11:00:02] On Windows these keep native extension files (.pyd) locked, so the").texte.includes("verrouillés"));
check("consigne officielle « close the desktop app » → marche à suivre", M("[11:00:03] Close the Hermes desktop app / other Hermes terminals, then re-run:").texte.includes("Fermez l'application Hermes"));
check("option --force-venv → conseil de ne pas forcer", M("[11:00:04] (or use `hermes update --force-venv` to proceed anyway at your own risk)").texte.includes("risque d'abîmer"));
check("dépendances verrouillées → risque expliqué", M("[11:00:05] dependency update would fail partway and leave a broken install.").texte.includes("casserait l'installation"));
check("verdictMotor : MOTEUR MAJ REFUSÉ → erreur", verdictMotor("[11:00:06] MOTEUR MAJ REFUSÉ — Hermes est en marche : fermez-le puis relancez.") === "erreur");

// ── Partie 5 : parseFil — les jalons ne reculent jamais ────────────────────
console.log("\nPartie 5 — parseFil");
// Journal réaliste : « déjà à jour » est une ligne MI-PARCOURS — les
// lanceurs relancent ensuite la pile et terminent toujours par un
// marqueur terminal (MAJ OK / MAJ ERREUR). Un journal sans marqueur
// (cas pathologique : early-return du lanceur) laisse majDone null et
// le garde-fou 30 s prend le relais — couvert par la maquette v3.
const journalApp = [
  "[07:40:00] Demande déposée depuis l'interface — attente du lanceur (cycle de surveillance ≤ 15 s)…",
  "[07:40:05] MAJ DEBUT - demande ramassée par le lanceur",
  "[07:40:10] consultation de GitHub...",
  "[07:40:12] déjà à jour — aucune nouvelle version sur GitHub",
  "[07:40:13] une ligne inconnue",
  "[07:41:00] relance des services…",
  "[07:42:11] MAJ OK - pile relancée, rafraîchissez l'onglet Hermes (F5) pour charger la nouvelle version.",
].join("\n");
const filApp = parseFil(journalApp, traduireLigneApp);
check("parseFil : 7 lignes non vides", filApp.length === 7, `${filApp.length}`);
check("parseFil : une ligne d'info (-1) reste info, même après un jalon atteint", filApp[4].jalon === -1, `${filApp[4].jalon}`);
check("parseFil : une ligne à jalon ne RECULE jamais sous un jalon déjà atteint", parseFil("[07:41:00] relance des services…\n[07:41:05] consultation de GitHub...", traduireLigneApp)[1].jalon === 2);
check("parseFil : verdict cohérent avec verdictApp (terminal présent)", verdictApp(journalApp) === "ok");
check("parseFil : journal sans marqueur terminal → verdict null (garde-fou 30 s prend le relais)", verdictApp("[07:40:12] déjà à jour — aucune nouvelle version sur GitHub") === null);

// ── Partie 6 : l'horloge du fil ────────────────────────────────────────────
console.log("\nPartie 6 — horloge");
const now = new Date();
const hh = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
const ilYADixS = new Date(now.getTime() - 10_000);
const age = Math.round((now.getTime() - heureVersMs(hh(ilYADixS))) / 1000);
check("heureVersMs : il y a 10 s → ~10 s", age >= 9 && age <= 11, `${age}`);
const dansOnzeH = new Date(now.getTime() + 11 * 3600_000);
const tsFutur = heureVersMs(hh(dansOnzeH));
check("heureVersMs : heure « dans le futur » → datée d'hier (maj à minuit)", tsFutur <= now.getTime() + 60_000, `${new Date(tsFutur).toISOString()}`);

// ── Verdict ────────────────────────────────────────────────────────────────
console.log(`\n${passed} ✓, ${failed} ✗`);
if (failed > 0) process.exit(1);
process.exit(0);
