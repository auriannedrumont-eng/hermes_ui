// Sonde du journal live de mise à jour (system:update-request / :log / :changed).
// Contrat testé : (1) la demande écrit le drapeau ET démarre le journal avec
// une ligne d'attente ; (2) system:update-log relit le journal ; (3) une
// ligne ajoutée au fichier arrive par le relais system:update-log:changed ;
// (4) le verdict terminal « MAJ OK » ferme la boucle.
import { Socket, io } from "socket.io-client";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const majLog = join(ROOT, "desktop", "runtime", "maj.log");
const majFlag = join(ROOT, "desktop", "runtime", "maj-demandee.flag");
let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(ok ? "  OK  " : "  ÉCHEC", label);
  if (!ok) failures++;
};

// État propre au départ (le service pourrait avoir tourné avant).
try { rmSync(majLog); } catch {}
try { rmSync(majFlag); } catch {}

const socket: Socket = io("http://127.0.0.1:3003", { transports: ["websocket"] });
const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));

socket.on("connect", async () => {
  console.log("connecté au mini-service");

  // (1) Demande de mise à jour → drapeau + première ligne du journal.
  const req: any = await new Promise((r) => socket.emit("system:update-request", r));
  check(req?.ok === true, "system:update-request → ack ok");
  check(existsSync(majFlag), "drapeau maj-demandee.flag posé");
  check(existsSync(majLog), "journal maj.log démarré");
  const first = existsSync(majLog) ? readFileSync(majLog, "utf-8") : "";
  check(first.includes("Demande déposée"), "première ligne = demande déposée (attente lanceur)");

  // (2) Lecture à la demande.
  const snap: any = await new Promise((r) => socket.emit("system:update-log", r));
  check(snap?.exists === true && snap?.text?.includes("Demande déposée"), "system:update-log relit le journal");

  // (3) Relais en direct : une ligne ajoutée par « le lanceur » arrive.
  let changed: any = null;
  socket.on("system:update-log:changed", (s: any) => { changed = s; });
  appendFileSync(majLog, "[00:00:02] MAJ DEBUT - demande ramassée par le lanceur (sonde)\n");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !(changed?.text ?? "").includes("MAJ DEBUT")) await timeout(200);
  check((changed?.text ?? "").includes("MAJ DEBUT"), "relais system:update-log:changed diffuse l'étape du lanceur");

  // (4) Verdict terminal.
  changed = null;
  appendFileSync(majLog, "[00:00:05] MAJ OK - pile relancée (sonde)\n");
  const deadline2 = Date.now() + 8000;
  while (Date.now() < deadline2 && !(changed?.text ?? "").includes("MAJ OK")) await timeout(200);
  check((changed?.text ?? "").includes("MAJ OK"), "verdict MAJ OK diffusé");

  socket.close();
  try { rmSync(majFlag); } catch {}
  console.log(failures === 0 ? "SUCCÈS — sonde journal live validée" : `ÉCHEC — ${failures} vérification(s)`);
  process.exit(failures === 0 ? 0 : 1);
});

setTimeout(() => {
  console.log("ÉCHEC — mini-service injoignable sur 3003");
  process.exit(1);
}, 10000);
