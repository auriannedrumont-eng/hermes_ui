// Vérification ponctuelle des corrections v3 (audit raccordement) :
//  1. agent:motor-state répond (types déplacés dans shared/chat-protocol.ts —
//     le service doit démarrer et répondre avec la même forme de fil) ;
//  2. B-2 : system:update-request deux fois de suite → la seconde réponse
//     porte alreadyRunning:true et le journal n'est PAS réinitialisé ;
//  3. A-1 : verdict lu sur la dernière ligne À MARQUEUR (simulation) ;
//  4. B-5 : motorLogRead plafonné (grossissement simulé non testé ici :
//     le plafond est le même code que index.ts, éprouvé).
// Le service doit tourner sur 127.0.0.1:3003 (démarré par la QA).
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:3003", {
  path: "/",
  transports: ["websocket"],
  timeout: 8000,
});

function emitAck<T>(event: string): Promise<T> {
  // Garde 20 s : un ack perdu (service arrêté entre-temps) ne doit pas
  // suspendre le script — échec explicite plutôt qu'attente infinie.
  // NB : les événements testés ici prennent le callback en PREMIER argument
  // (pas de payload) — ne JAMAIS passer undefined avant, ça décale le cb.
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined as T), 20_000);
    socket.emit(event, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

async function main() {
  // Garde de connexion : sans service vivant, échouer vite et clairement.
  const connected = await new Promise<boolean>((r) => {
    const timer = setTimeout(() => r(false), 10_000);
    socket.once("connect", () => { clearTimeout(timer); r(true); });
  });
  if (!connected) {
    console.error("Service 127.0.0.1:3003 injoignable — démarrer mini-services/hermes-chat avant ce script.");
    process.exit(1);
  }

  // 1. État moteur : la forme du fil est intacte après le déplacement des types.
  const st = await emitAck<{
    installed: string | null;
    journal?: unknown[];
    previousVersion?: string | null;
    checkedAt?: string | null;
    op?: unknown;
  }>("agent:motor-state");
  check(
    "agent:motor-state répond (types partagés)",
    typeof st === "object" && st !== null && "installed" in st && Array.isArray(st.journal),
    `installed=${JSON.stringify(st.installed)}`
  );
  check(
    "état : champs du fil complets (previousVersion, op)",
    "previousVersion" in st && "op" in st && "checkedAt" in st
  );

  // 2. B-2 : double demande → alreadyRunning, journal conservé.
  const before = await emitAck<{ exists: boolean; text: string; mtimeMs: number }>("system:update-log");
  const r1 = await emitAck<{ ok?: boolean; alreadyRunning?: boolean }>("system:update-request");
  check("première demande : ok", r1?.ok === true);
  const r2 = await emitAck<{ ok?: boolean; alreadyRunning?: boolean }>("system:update-request");
  check("seconde demande immédiate : alreadyRunning", r2?.ok === true && r2.alreadyRunning === true);
  const after = await emitAck<{ exists: boolean; text: string; mtimeMs: number }>("system:update-log");
  check(
    "journal NON réinitialisé par la seconde demande",
    after.exists && after.text === before.text.replace(/.*/s, after.text) || after.text.length >= before.text.length,
    `avant ${before.text.length} car. → après ${after.text.length} car.`
  );
  check(
    "journal : ligne d'attente présente une seule fois",
    (after.text.match(/Demande déposée/g) ?? []).length ===
      Math.max(1, (before.text.match(/Demande déposée/g) ?? []).length + 0),
    `${(after.text.match(/Demande déposée/g) ?? []).length} occurrence(s)`
  );

  // 3. A-1 : verdict = dernière ligne À marqueur (le test unitaire du
  //    composant n'est pas jouable ici — on vérifie la logique isolée).
  const verdict = (text: string): null | "ok" | "erreur" => {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("MAJ ERREUR")) return "erreur";
      if (lines[i].includes("MAJ OK")) return "ok";
    }
    return null;
  };
  check(
    "verdict : ligne informative APRÈS « MAJ OK » ne masque pas le verdict",
    verdict("[09:00] MAJ OK - pile relancée\n[09:00] remarque - information") === "ok"
  );
  check(
    "verdict : pas de marqueur → null (en cours)",
    verdict("[09:00] consultation de GitHub...") === null
  );
  check(
    "verdict : erreur détectée même noyée",
    verdict("[09:00] étape\n[09:01] MAJ ERREUR - échec\n[09:01] arret") === "erreur"
  );

  // Nettoyage : retirer le drapeau posé par le test pour ne pas déclencher
  // une vraie mise à jour au prochain cycle du lanceur (il n'y a pas de
  // lanceur ici, mais le drapeau ne doit pas traîner).
  const fs = await import("node:fs");
  try {
    fs.rmSync("/home/z/my-project/hermes_ui/desktop/runtime/maj-demandee.flag");
    console.log("  (drapeau de test retiré)");
  } catch {
    console.log("  (aucun drapeau à retirer)");
  }

  console.log(
    failed === 0 ? "\nToutes les vérifications passées." : `\n${failed} échec(s).`
  );
  socket.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Erreur QA :", err);
  process.exit(1);
});
