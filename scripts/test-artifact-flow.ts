// Test E2E du flux artefact : chat:send avec bloc html -> événements -> rendu
import { io } from "socket.io-client";

const socket = io("http://localhost:3003", { transports: ["websocket"] });
const seen: string[] = [];
let convId: string | null = null;

function log(s: string) {
  seen.push(s);
  console.log("  " + s);
}

socket.on("connect", () => {
  console.log("connecté");
  socket.emit("conversations:create", (res: any) => {
    convId = res.conversation.id;
    console.log("conversation:", convId);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:40px;background:#fdf8f3}h1{color:#b3592a}</style></head><body><h1>Test Artefact</h1><p>Page de test du flux complet artefact.</p></body></html>`;
    socket.emit("chat:send", {
      conversationId: convId,
      content: `Génère-moi ce fichier exactement, sans rien changer :\n\n\`\`\`html file="test-flux.html"\n${html}\n\`\`\`\n\nMerci !`,
    });
  });
});

socket.on("artifact:created", (p: any) => {
  log(`created: ${p.artifact.name} (${p.artifact.kind}, ${p.artifact.status}, ancre=${p.artifact.anchorMessageId === p.messageId})`);
});
socket.on("artifact:delta", (p: any) => {
  log(`delta: +${p.delta.length} car`);
});
socket.on("artifact:updated", (p: any) => {
  const a = p.artifact;
  log(`updated: v${a.version} ${a.status}${a.statusLabel ? ` (${a.statusLabel})` : ""} thumb=${!!a.thumbnailUrl} pdf=${!!a.pdfUrl}${a.pdfSize ? ` (${a.pdfSize}o)` : ""}`);
  if (a.status === "ready" && a.pdfUrl) {
    log(`OK — URLs: ${a.url} | ${a.rawUrl} | ${a.thumbnailUrl} | ${a.pdfUrl}`);
    // Vérifie le service HTTP
    fetch(`http://localhost:3004${a.thumbnailUrl}`)
      .then((r) => {
        log(`thumb HTTP: ${r.status} ${r.headers.get("content-type")}`);
        return fetch(`http://localhost:3004${a.pdfUrl}`);
      })
      .then((r) => {
        log(`pdf HTTP: ${r.status}`);
        return fetch(`http://localhost:3004${a.rawUrl}`);
      })
      .then((r) => {
        log(`raw HTTP: ${r.status} ${r.headers.get("content-type")}`);
        console.log("\nSUCCÈS — flux artefact complet validé");
        socket.close();
        process.exit(0);
      })
      .catch((e) => {
        console.error("Échec HTTP:", e);
        process.exit(1);
      });
  }
});
socket.on("stream:done", (p: any) => {
  log(`stream:done — artefacts sur le message: ${p.message.artifacts?.length ?? 0}`);
  if (p.message.artifacts?.[0]) {
    log(`carte: ${p.message.artifacts[0].name} v${p.message.artifacts[0].version} (${p.message.artifacts[0].status})`);
  }
});
socket.on("stream:error", (p: any) => {
  console.error("stream:error:", p.error);
  process.exit(1);
});

setTimeout(() => {
  console.log("TIMEOUT — événements vus :");
  seen.forEach((s) => console.log(" ", s));
  process.exit(1);
}, 90000);
