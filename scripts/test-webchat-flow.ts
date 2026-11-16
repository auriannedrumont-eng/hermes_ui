// QA « Chats IA web » (fournisseur webchat) — deux volets :
//  1. Unitaires hors service : verrou mono-pilote (dont reprise d'un mort),
//     garde de chemin (../ refusé, rien écrit), filtre de processus du
//     navigateur applicatif, fiches, contrat JSON du pilote (site non vérifié).
//  2. Flux service (si le mini-service écoute sur 3003) : models:list expose
//     le groupe « Chats IA web » (dont l'indisponible), settings roundtrip des
//     réglages webchat, webchat:status, tour webchat:gemini-app refusé
//     explicitement (stream:error qui dit quoi faire — jamais un succès muet).
import { io } from "socket.io-client";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DriverLock, pidAlive } from "../mini-services/hermes-chat/webchat/lock";
import { resolveUnder, writeGuarded, safeBasename } from "../mini-services/hermes-chat/webchat/paths";
import { isAppBrowserPid } from "../mini-services/hermes-chat/webchat/browser";
import { FICHES, parseWebchatModelId, webchatModelId } from "../mini-services/hermes-chat/webchat/fiches";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK  " : "ÉCHEC"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function unitTests() {
  console.log("1. Unitaires (hors service)");

  // ── Fiches ────────────────────────────────────────────────────────────
  const ids = Object.keys(FICHES);
  check("fiches : trois sites", ids.length === 3 && ids.includes("zai") && ids.includes("aistudio") && ids.includes("gemini-app"));
  check("fiches : zai/aistudio vérifiés, gemini-app non", FICHES.zai.verifie && FICHES.aistudio.verifie && !FICHES["gemini-app"].verifie);
  check("fiches : zai expose answer+build", FICHES.zai.modes.includes("answer") && FICHES.zai.modes.includes("build"));
  const parsed = parseWebchatModelId(webchatModelId("zai", "build"));
  check("ids webchat : webchat:<site>:<mode>", parsed?.site === "zai" && parsed?.mode === "build");
  check("ids webchat : mode non exposé refusé", parseWebchatModelId(webchatModelId("aistudio", "build" as any)) === null);
  check("ids webchat : site inconnu refusé", parseWebchatModelId("webchat:inconnu:answer") === null);

  // ── Verrou mono-pilote ────────────────────────────────────────────────
  const lockDir = mkdtempSync(join(tmpdir(), "webchat-qa-"));
  const lock = new DriverLock(join(lockDir, "pilot.lock"));
  const holder = lock.acquire("zai", "answer");
  check("verrou : acquis au premier", holder === null);
  const second = new DriverLock(join(lockDir, "pilot.lock"));
  const refused = second.acquire("aistudio", "answer");
  check("verrou : refusé au second, titulaire nommé", refused !== null && refused.pid === process.pid, `pid ${refused?.pid}`);
  const holderInfo = second.readHolder();
  check("verrou : fiche du titulaire lisible", holderInfo?.site === "zai" && holderInfo?.mode === "answer");

  // Reprise d'un verrou laissé par un processus MORT (spec §2.3).
  const stalePath = join(lockDir, "stale.lock");
  writeFileSync(stalePath, JSON.stringify({ pid: 2_000_000_000, site: "zai", mode: "build", startedAt: new Date().toISOString() }));
  const third = new DriverLock(stalePath);
  check("verrou : reprise d'un processus mort", third.acquire("zai", "build") === null);
  check("pidAlive : 0 et négatif refusés", !pidAlive(0) && !pidAlive(-3) && !pidAlive(Number.NaN));

  // Verrou sur un profil FRAIS — dossier parent inexistant (bug réel du
  // 16/11 : l'écriture du verrou précède la création du dossier par le
  // navigateur → ENOENT déguisé en « verrou tenu par pid -1 »).
  const freshPath = join(lockDir, "profil-frais", "pilot.lock");
  const fresh = new DriverLock(freshPath);
  check(
    "verrou : profil frais (dossier absent) → créé et acquis",
    fresh.acquire("zai", "answer") === null && existsSync(freshPath)
  );
  fresh.release();
  check("verrou : release sur profil frais", !existsSync(freshPath));

  // Touche/release : le verrou d'AUTRUI n'est jamais retiré.
  const shared = join(lockDir, "shared.lock");
  const a = new DriverLock(shared);
  a.acquire("zai", "answer");
  const b = new DriverLock(shared);
  b.release(); // b ne détient pas le verrou : ne doit rien retirer
  check("verrou : release d'autrui sans effet", existsSync(shared));
  a.release();
  check("verrou : release du titulaire", !existsSync(shared));
  rmSync(lockDir, { recursive: true, force: true });

  // ── Garde de chemin (spec §7.3 : ../ refusé, jamais écrit) ────────────
  const outDir = mkdtempSync(join(tmpdir(), "webchat-out-"));
  const victim = join(tmpdir(), "webchat-qa-victime.txt");
  writeFileSync(victim, "intact");
  const guard = writeGuarded(outDir, [
    { name: "../webchat-qa-victime.txt", base64: Buffer.from("PISTÉ").toString("base64") },
    { name: "..\\webchat-qa-victime.txt", base64: Buffer.from("PISTÉ").toString("base64") },
    { name: "/etc/webchat-qa-escape.txt", base64: Buffer.from("PISTÉ").toString("base64") },
    { name: "..", base64: Buffer.from("PISTÉ").toString("base64") },
    { name: ".hidden", base64: Buffer.from("PISTÉ").toString("base64") },
    { name: "rapport.html", base64: Buffer.from("<h1>ok</h1>").toString("base64") },
  ]);
  check("garde : ../ refusé", guard.refused.some((r) => r.name.includes("..")) && guard.written.every((w) => w.name === "rapport.html"),
    `${guard.refused.length} refus(s)`);
  check("garde : le fichier cible n'a PAS été écrasé", readFileSync(victim, "utf-8") === "intact");
  check("garde : rien d'écrit hors du dossier", !existsSync(join(tmpdir(), "webchat-qa-escape.txt")));
  const inDir = readdirSync(outDir);
  check("garde : contenu du dossier = uniquement le fichier sûr", inDir.length === 1 && inDir[0] === "rapport.html", inDir.join(", "));
  check("garde : resolveUnder refuse les chemins absolus", resolveUnder(outDir, "/etc/passwd") === null);
  check("garde : safeBasename vide → refus", safeBasename("   ") === "" && resolveUnder(outDir, "   ") === null);
  rmSync(outDir, { recursive: true, force: true });
  rmSync(victim, { force: true });

  // ── Filtre de processus (spec §2.2/§7.6 : jamais le navigateur personnel) ──
  const fakeProfile = mkdtempSync(join(tmpdir(), "webchat-prof-"));
  check("filtre : pid inexistant refusé", isAppBrowserPid(2_000_000_001, fakeProfile) === false);
  check("filtre : pid 0/négatif refusé", isAppBrowserPid(0, fakeProfile) === false && isAppBrowserPid(-1, fakeProfile) === false);
  rmSync(fakeProfile, { recursive: true, force: true });

  // ── Contrat JSON du pilote (site non vérifié — sans navigateur) ───────
  const driverPath = join(import.meta.dir, "..", "mini-services", "hermes-chat", "webchat", "driver.ts");
  const proc = Bun.spawnSync([process.execPath, driverPath, "--site", "gemini-app", "--mode", "answer", "--prompt", "bonjour"]);
  const lastLine = proc.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? "";
  let json: any = {};
  try { json = JSON.parse(lastLine); } catch { /* ligne manquante */ }
  check("pilote gemini-app : ok:false explicite", json.ok === false && typeof json.error === "string" && json.error.includes("indisponible"), json.error?.slice(0, 60));
  check("pilote gemini-app : code de sortie non nul", proc.exitCode !== 0, `code ${proc.exitCode}`);
  check("pilote : une seule ligne JSON (contrat stdout)", proc.stdout.toString().trim().split("\n").filter(Boolean).length === 1);

  // Site/mode incohérent : refus franc AVANT toute ouverture de navigateur.
  const bad = Bun.spawnSync([process.execPath, driverPath, "--site", "aistudio", "--mode", "build", "--prompt", "x"]);
  const badJson = JSON.parse(bad.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? "{}");
  check("pilote : mode non exposé refusé", badJson.ok === false && String(badJson.error).includes("mode"));

  // Build sans --out : refus franc.
  const noOut = Bun.spawnSync([process.execPath, driverPath, "--site", "zai", "--mode", "build", "--prompt", "x"]);
  const noOutJson = JSON.parse(noOut.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? "{}");
  check("pilote : build sans --out refusé", noOutJson.ok === false && String(noOutJson.error).includes("--out"));
}

async function serviceTests() {
  console.log("2. Flux service (mini-service sur 3003)");
  const socket = io("http://localhost:3003", { transports: ["websocket"], timeout: 4000 });
  const emit = (event: string, payload?: unknown): Promise<any> =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ error: "timeout service" }), 8000);
      if (payload === undefined) socket.emit(event, (res: any) => { clearTimeout(t); resolve(res ?? {}); });
      else socket.emit(event, payload, (res: any) => { clearTimeout(t); resolve(res ?? {}); });
    });

  await new Promise((resolve) => socket.on("connect", () => resolve(null)).on("connect_error", () => resolve(null)));
  if (!socket.connected) {
    console.log("  SAUTÉ — mini-service non joignable sur 3003 (lancez-le pour ce volet)");
    socket.close();
    return;
  }

  // models:list : le groupe « Chats IA web » est à part, toujours proposé.
  const ml = await emit("models:list");
  const webchat = (ml.models ?? []).filter((m: any) => m.webchat === true);
  check("models:list : groupe webchat présent", webchat.length >= 4, `${webchat.length} entrée(s)`);
  check("models:list : provider « Chats IA web »", webchat.every((m: any) => m.provider === "Chats IA web"));
  check("models:list : gemini-app indisponible", webchat.some((m: any) => m.id === "webchat:gemini-app:answer" && m.available === false));
  check("models:list : z.ai expose answer et build", webchat.some((m: any) => m.id === "webchat:zai:answer") && webchat.some((m: any) => m.id === "webchat:zai:build"));

  // Réglages serveur roundtrip (clés du volet « Chats web »).
  const setPort = await emit("settings:set", { key: "fork.webchat.port", value: 9223 });
  check("settings:set fork.webchat.port", setPort.ok === true);
  const getPort = await emit("settings:get", { key: "fork.webchat.port" });
  check("settings:get roundtrip", Number(getPort.value) === 9223, String(getPort.value));

  // webchat:status : sondes réelles (sans navigateur ici).
  const st = await emit("webchat:status");
  check("webchat:status : sites", Array.isArray(st.sites) && st.sites.length === 3);
  check("webchat:status : config avec défauts", Number(st.config?.port) === 9223 || Number(st.config?.port) === 9222, `port ${st.config?.port}`);
  check("webchat:status : browserFound honnête", typeof st.config?.browserFound === "string");

  // Tour sur un site non vérifié : refus explicite qui dit quoi faire.
  const conv = await emit("conversations:create", {});
  const conversationId = conv.conversation?.id;
  const errEvent: any = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ error: "timeout stream:error" }), 15000);
    socket.on("stream:error", (p: any) => { clearTimeout(t); resolve(p); });
    socket.emit("chat:send", { conversationId, content: "bonjour", model: "webchat:gemini-app:answer" }, () => {});
  });
  check("tour gemini-app : stream:error explicite", typeof errEvent.error === "string" && errEvent.error.includes("indisponible"), errEvent.error?.slice(0, 70));
  const noTool: any = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({}), 3000);
    socket.on("stream:error", (p: any) => { clearTimeout(t); resolve(p); });
  });
  check("tour gemini-app : aucun outil simulé", !noTool.toolEvents || noTool.toolEvents.length === 0);

  // webchat:close sans navigateur lancé : ok, sans rien casser.
  const closed = await emit("webchat:close");
  check("webchat:close sans navigateur", closed.ok === true && closed.closed === false, JSON.stringify(closed));

  // Nettoyage : réglage de test + conversation.
  await emit("settings:set", { key: "fork.webchat.port", value: 9222 });
  await emit("conversations:delete", { id: conversationId });
  socket.close();
}

await unitTests();
await serviceTests();
console.log(
  failures === 0
    ? "\nSUCCÈS — QA webchat validée"
    : `\n${failures} échec(s) — QA webchat incomplète`
);
process.exit(failures === 0 ? 0 : 1);
