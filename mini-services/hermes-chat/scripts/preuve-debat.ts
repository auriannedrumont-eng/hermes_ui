// Preuve du correctif « débat bloqué sur le sceptique » :
// 1. ajoute un fournisseur personnalisé pointant sur le serveur muet (9299),
// 2. lance un débat (1 tour) — la première voix part dessus,
// 3. attend la garde d'inactivité (120 s) et vérifie :
//    - la ligne « Tour 1 · Sceptique » passe en status=error avec le motif,
//    - un stream:error contextualisé arrive (plus jamais un blocage sans fin).
import { io } from "socket.io-client";

const URL = "http://127.0.0.1:3003";
const t0 = Date.now();
const at = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const socket = io(URL, { transports: ["websocket"] });

const watchdog = setTimeout(() => {
  console.log(`${at()} ÉCHEC DE LA PREUVE : rien après 170 s — le tour resterait bloqué.`);
  process.exit(2);
}, 170_000);

let flowRows: any[] = [];
let errorRowSeen = false;
let contextualError = "";
let convId = "";
let providerId = "";

function finish(code: number) {
  console.log(`${at()} === BILAN ===`);
  for (const r of flowRows) {
    console.log(`flow: ${r.id} | ${r.label} | status=${r.status} | ${(r.detail ?? "").slice(0, 110)}`);
  }
  console.log(`stream:error reçu : ${contextualError.slice(0, 200)}`);
  if (providerId && socket.connected) {
    socket.emit("providers:remove", { id: providerId }, () => process.exit(code));
  } else process.exit(code);
}

socket.on("connect", () => {
  socket.emit(
    "providers:add",
    { name: "http://127.0.0.1:9299/v1", kind: "llm" },
    (res: any) => {
      if (res?.error) {
        // Relance après un watchdog : le fournisseur existe déjà — le retrouver.
        if (!/déjà dans la liste/.test(String(res.error))) {
          console.log(`${at()} providers:add → ${res.error}`);
          process.exit(1);
        }
        socket.emit("providers:list", (lst: any) => {
          const found = (lst?.providers ?? []).find(
            (p: any) => p.name === "127.0.0.1" && p.kind === "llm"
          );
          if (!found) {
            console.log(`${at()} fournisseur muet introuvable après l'erreur « déjà dans la liste »`);
            process.exit(1);
          }
          providerId = found.id;
          console.log(`${at()} fournisseur muet déjà présent (${providerId}) — réutilisé`);
          startDebate();
        });
        return;
      }
      providerId = res?.provider?.id;
      console.log(`${at()} fournisseur muet ajouté (${providerId})`);
      socket.emit(
        "providers:add-key",
        { providerId, label: "Preuve", secret: "stallkey12345" },
        (res2: any) => {
          if (res2?.error && !/déjà/.test(String(res2.error))) {
            console.log(`${at()} providers:add-key → ${res2.error}`);
            process.exit(1);
          }
          console.log(`${at()} clé « Preuve » en place (untested → actif)`);
          startDebate();
        }
      );
    }
  );
});

function startDebate() {
  socket.emit(
    "conversations:create",
    { mode: "debate", modeConfig: { rounds: 1 } },
    (res3: any) => {
      convId = res3?.conversation?.id;
      console.log(`${at()} conversation débat créée (${convId})`);
      socket.emit("chat:send", {
        conversationId: convId,
        content: "Faut-il brancher un agent IA sur notre support client ?",
      });
      console.log(`${at()} chat:send envoyé — attente de la garde d'inactivité (120 s)…`);
    }
  );
}

socket.on("mode:flow", (p: any) => {
  flowRows = p.rows;
  const scept = p.rows.find((r: any) => r.id === "t1-sceptique");
  if (scept?.status === "error" && !errorRowSeen) {
    errorRowSeen = true;
    console.log(`${at()} mode:flow → la ligne du sceptique est bien passée en ERROR : « ${(scept.detail ?? "").slice(0, 130)} »`);
  }
});
socket.on("stream:error", (p: any) => {
  contextualError = String(p?.error ?? "");
  console.log(`${at()} stream:error → ${contextualError.slice(0, 220)}`);
  const ok =
    errorRowSeen &&
    contextualError.includes("Sceptique") &&
    contextualError.includes("garde d'inactivité");
  clearTimeout(watchdog);
  console.log(`${at()} PREUVE ${ok ? "RÉUSSIE ✓" : "PARTIELLE ✗"}`);
  finish(ok ? 0 : 1);
});
