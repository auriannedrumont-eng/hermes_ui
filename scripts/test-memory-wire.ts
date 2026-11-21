// Régression v0.5.2 (suivi) : `memory:get` doit répondre QUELLE QUE SOIT
// l'arité d'émission du client.
//
// Avant correctif, `emitAck("memory:get", undefined)` sérialisait le payload
// absent en `null` sur le fil : le handler `(cb?)` recevait `(null, ackFn)`,
// son paramètre `cb` valait null et n'acquittait JAMAIS — le handler
// s'exécutait (il lisait le magasin) mais sa réponse n'avait pas de
// destinataire. Résultat côté interface : « Mémoire non chargée » à chaque
// chargement du volet, et la carte mémoire toujours vide même avec des
// notes enregistrées (reproduit par sonde directe, corrigé des deux côtés :
// emit-ack.ts omet le payload absent ; le handler cherche le dernier
// argument fonction).
//
// Usage : bun scripts/test-memory-wire.ts [url service — défaut 127.0.0.1:3003]
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";

const base = process.argv[2] ?? "http://127.0.0.1:3003";
const DB = join(import.meta.dir, "..", "db", "hermes-chat.sqlite");

function emitArite(
  socket: Socket,
  variante: "undefined" | "null" | "sans-arg"
): Promise<{ notes?: unknown } | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 5000);
    const done = (res: { notes?: unknown }) => {
      clearTimeout(t);
      resolve(res ?? null);
    };
    if (variante === "sans-arg") socket.emit("memory:get", done);
    else if (variante === "null") socket.emit("memory:get", null, done);
    else socket.emit("memory:get", undefined, done);
  });
}

const socket = io(base, { transports: ["websocket"] });
socket.on("connect", async () => {
  let ok = true;
  for (const variante of ["undefined", "null", "sans-arg"] as const) {
    const res = await emitArite(socket, variante);
    const bon = !!res && typeof res.notes === "string";
    console.log(
      `${bon ? "✓" : "✗"} memory:get (${variante}) → ${
        res ? "ack" : "SILENCE (5 s)"
      }`
    );
    ok = ok && bon;
  }
  // Roundtrip set-notes (remet "" à la fin — aucun résidu de test)
  const sauve = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    socket.emit(
      "memory:set-notes",
      { value: "test-memory-wire" },
      (res: { ok?: boolean }) => {
        clearTimeout(t);
        resolve(!!res.ok);
      }
    );
  });
  const relu = await emitArite(socket, "undefined");
  const roundtrip = sauve && relu?.notes === "test-memory-wire";
  console.log(`${roundtrip ? "✓" : "✗"} set-notes → relecture (get)`);
  ok = ok && roundtrip;
  await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    socket.emit("memory:set-notes", { value: "" }, (res: { ok?: boolean }) => {
      clearTimeout(t);
      resolve(!!res.ok);
    });
  });
  const db = new Database(DB, { readonly: true });
  const row = db
    .query("SELECT value FROM settings WHERE key = 'hermes.memory.notes'")
    .get() as { value: string };
  db.close();
  const propre = row.value === "";
  console.log(`${propre ? "✓" : "✗"} nettoyage (base = "")`);
  ok = ok && propre;
  socket.disconnect();
  process.exit(ok ? 0 : 1);
});
setTimeout(() => {
  console.error("✗ connexion impossible au service");
  process.exit(2);
}, 8000);
