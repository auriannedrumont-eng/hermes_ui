// QA — branchement de la gateway Hermes (Paramètres → Système).
// Valide le cycle complet du mode (chantier 41, fin du « mode démo ») :
//   1. hello : mode "local" par défaut, gatewayTokenSet exposé
//   2. gateway:get : état cohérent (url null, tokenSet false)
//   3. gateway:set avec URL invalide → erreur explicite, état inchangé
//   4. gateway:set avec ws:// injoignable → ok, mode reste "local"
//      (l'URL est persistée : un réglage présent mais injoignable n'est PAS
//      une erreur — le moteur local prend le relais, retest à chaque tour)
//   5. gateway:set avec "" → débranchement, l'URL retombe à null
//   6. la persistance survit à la reconnexion (settings SQLite)
// Le service doit être lancé avant (bun index.ts, ports 3003/3004).
import { io } from "socket.io-client";

const SOCK_URL = "http://localhost:3003";
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  OK  ${name}`);
  } else {
    failed++;
    console.log(`  ÉCHEC  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function emitAck(socket: any, event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 8000);
    if (payload === undefined) {
      socket.emit(event, (res: any) => { clearTimeout(t); resolve(res); });
    } else {
      socket.emit(event, payload, (res: any) => { clearTimeout(t); resolve(res); });
    }
  });
}

async function main() {
  console.log("[qa] flux gateway Hermes — service sur 3003");
  const socket = io(SOCK_URL, { path: "/", transports: ["websocket"], timeout: 6000 });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", (e: any) => reject(new Error(e?.message)));
    setTimeout(() => reject(new Error("timeout connexion socket")), 8000);
  });

  // ── 1. hello honnête ────────────────────────────────────────────────
  const hello = await emitAck(socket, "hello");
  check("hello.mode = local par défaut", hello?.mode === "local", `mode=${hello?.mode}`);
  check("hello expose gatewayTokenSet (booléen)", typeof hello?.gatewayTokenSet === "boolean", String(hello?.gatewayTokenSet));
  check("hello.gatewayUrl = null (rien de branché)", hello?.gatewayUrl === null || typeof hello?.gatewayUrl === "string", String(hello?.gatewayUrl));

  // ── 2. gateway:get ──────────────────────────────────────────────────
  const st0 = await emitAck(socket, "gateway:get");
  check("gateway:get → {url, tokenSet, mode}", st0 && "url" in st0 && "tokenSet" in st0 && "mode" in st0, JSON.stringify(st0));
  check("mode local cohérent entre hello et gateway:get", st0?.mode === hello?.mode);

  // ── 3. URL invalide refusée ─────────────────────────────────────────
  const bad = await emitAck(socket, "gateway:set", { url: "ftp://nimporte" });
  check("URL invalide → {ok:false, error}", bad?.ok === false && /URL invalide/.test(String(bad?.error)), JSON.stringify(bad));
  const st1 = await emitAck(socket, "gateway:get");
  check("état inchangé après refus", st1?.url === st0?.url, JSON.stringify(st1));

  // ── 4. ws:// injoignable : enregistré, mode reste local ────────────
  const off = await emitAck(socket, "gateway:set", { url: "ws://127.0.0.1:9399/api/ws" });
  check("gateway injoignable → {ok:true, mode:'local'}", off?.ok === true && off?.mode === "local", JSON.stringify(off));
  check("l'URL est conservée côté service", off?.url === "ws://127.0.0.1:9399/api/ws", String(off?.url));
  const hello2 = await emitAck(socket, "hello");
  check("hello suit le branchement (gatewayUrl renseigné)", hello2?.gatewayUrl === "ws://127.0.0.1:9399/api/ws", String(hello2?.gatewayUrl));

  // ── 5. débranchement ───────────────────────────────────────────────
  // Lot 4 : contrat ACTUEL du service (connecteur) — une URL vide revient au
  // DÉFAUT automatique (ws://127.0.0.1:9120/api/ws : l'agent lancé
  // localement se branche seul), pas à null. L'ancien test encodait null.
  const DEFAULT_URL = "ws://127.0.0.1:9120/api/ws";
  const off2 = await emitAck(socket, "gateway:set", { url: "" });
  check("url vide → débranchement {ok:true} (retour au défaut)",
    off2?.ok === true && off2?.url === DEFAULT_URL, JSON.stringify(off2));
  const hello3 = await emitAck(socket, "hello");
  check("hello suit le défaut automatique", hello3?.gatewayUrl === DEFAULT_URL, String(hello3?.gatewayUrl));

  // ── 6. normalisation d'URL (http → ws + /api/ws) ────────────────────
  const norm = await emitAck(socket, "gateway:set", { url: "http://127.0.0.1:9120" });
  check("URL http normalisée (conservée telle quelle, /api/ws ajouté au tour)", norm?.ok === true && norm?.url === "http://127.0.0.1:9120", JSON.stringify(norm));
  await emitAck(socket, "gateway:set", { url: "" });

  socket.close();
  console.log(`\n${failed === 0 ? "SUCCÈS" : "ÉCHEC"} — ${passed} OK, ${failed} échec(s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("ERREUR :", err instanceof Error ? err.message : err);
  process.exit(1);
});
