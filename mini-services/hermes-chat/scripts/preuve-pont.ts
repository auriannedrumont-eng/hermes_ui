// Preuve du pont de dépannage (F-31) — le chemin complet entre un échec réel
// et le rapport que l'agent peut lire :
//   1. plafond webchat ramené à 30 s (preuve rapide, remise à la fin),
//   2. débat 1 tour dont TOUTES les voix sont z.ai (webchat:zai) — comme la
//      conversation de l'utilisatrice bloquée sur « Tour 1 · Sceptique »,
//   3. le pilote échoue HONNÊTEMENT : la ligne passe en « error », le
//      stream:error remonte contextualisé,
//   4. GET /diagnostics (port 3004) renvoie commit, état du navigateur de
//      pilotage et le JOURNAL TOURNANT de tout ce qui vient de se passer.
import { io } from "socket.io-client";

const URL = "http://127.0.0.1:3003";
const DIAG = "http://127.0.0.1:3004/diagnostics";
const WC = "webchat:zai";
const t0 = Date.now();
const at = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const socket = io(URL, { transports: ["websocket"] });
let convId = "";
let flowRows: any[] = [];
let errorRowSeen = false;
let contextualError = "";

function cleanup(code: number) {
  // La preuve ne laisse rien derrière elle : conversation jetable + plafond.
  const done = () => process.exit(code);
  if (convId && socket.connected) {
    socket.emit("conversations:delete", { id: convId }, () => {
      socket.emit("settings:set", { key: "fork.webchat.timeoutS", value: "240" }, done);
    });
  } else if (socket.connected) {
    socket.emit("settings:set", { key: "fork.webchat.timeoutS", value: "240" }, done);
  } else done();
}

const watchdog = setTimeout(() => {
  console.log(`${at()} ÉCHEC DE LA PREUVE : rien après 150 s — le tour resterait bloqué.`);
  cleanup(2);
}, 150_000);

async function diagnostics() {
  try {
    const res = await fetch(DIAG);
    const json: any = await res.json();
    console.log(`${at()} ── PONT : GET /diagnostics ──`);
    console.log(
      `service : commit ${json.service?.commit ?? "?"}, démarré ${json.service?.bootAt}, uptime ${json.service?.uptimeS} s`,
    );
    console.log(
      `webchat : navigateur UP=${json.webchat?.browserUp} sur le port ${json.webchat?.port}, plafond ${json.webchat?.timeoutS} s`,
    );
    console.log(`journal tournant (${json.trace?.length ?? 0} derniers événements) :`);
    for (const e of json.trace ?? []) {
      console.log(`   ${new Date(e.t).toLocaleTimeString()} [${e.cat}] ${e.msg}`);
    }
  } catch (err) {
    console.log(`${at()} pont ILLISIBLE : ${err instanceof Error ? err.message : err}`);
  }
}

socket.on("connect", () => {
  console.log(`${at()} socket jointe`);
  socket.emit("settings:set", { key: "fork.webchat.timeoutS", value: "30" }, () => {
    socket.emit(
      "conversations:create",
      {
        title: "Preuve pont F-31",
        mode: "debate",
        modeConfig: {
          rounds: 1,
          voices: { debate: { sceptique: WC, pragmatique: WC, innovateur: WC, juge: WC } },
        },
      },
      (res: any) => {
        convId = res?.conversation?.id;
        if (!convId) {
          console.log(`${at()} création impossible : ${JSON.stringify(res).slice(0, 200)}`);
          cleanup(1);
          return;
        }
        console.log(`${at()} conversation débat (voix = z.ai) créée — chat:send…`);
        socket.emit("chat:send", {
          conversationId: convId,
          content: "Preuve du pont : cette question doit échouer HONNÊTEMENT, jamais rester « en cours ».",
        });
      },
    );
  });
});

socket.on("mode:flow", (p: any) => {
  flowRows = p.rows ?? [];
  for (const r of flowRows) {
    if (r.status === "running") {
      console.log(`${at()} déroulé : ${r.label} — en cours (${(r.detail ?? "").slice(0, 90)})`);
    } else if (r.status === "error") {
      console.log(`${at()} déroulé : ${r.label} — ERROR : ${(r.detail ?? "").slice(0, 140)}`);
    }
  }
  const scept = flowRows.find((r: any) => r.id === "t1-sceptique");
  if (scept?.status === "error" && !errorRowSeen) errorRowSeen = true;
});

socket.on("stream:error", (p: any) => {
  contextualError = String(p?.error ?? "");
  console.log(`${at()} stream:error → ${contextualError.slice(0, 220)}`);
  clearTimeout(watchdog);
  const ok = errorRowSeen && contextualError.includes("Sceptique");
  console.log(`${at()} ÉCHEC HONNÊTE ${ok ? "PROUVÉ ✓" : "PARTIEL ✗"} — lecture du pont…`);
  void diagnostics().then(() => cleanup(ok ? 0 : 1));
});
