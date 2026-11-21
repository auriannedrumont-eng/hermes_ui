// Test de bout en bout du mini-service hermes-chat (port 3003 + fichiers 3004) :
// hello, models:list, attachments:upload, service HTTP, rejet SVG, tour complet.
import { io } from "socket.io-client";

const URL = "http://localhost:3003";
const FILES_URL = "http://localhost:3004";
const socket = io(URL, { path: "/", transports: ["websocket"], timeout: 8000 });

// 1x1 pixel PNG rouge
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ack(event: string): Promise<any> {
  return new Promise((resolve) => socket.emit(event, (res: any) => resolve(res)));
}
function emit(event: string, payload: any): Promise<any> {
  return new Promise((resolve) =>
    socket.emit(event, payload, (res: any) => resolve(res))
  );
}

async function main() {
  socket.on("connect", async () => {
    try {
      console.log("[1] connecté :", socket.id);

      const hello = await ack("hello");
      console.log("[2] hello :", JSON.stringify(hello));

      const models = await ack("models:list");
      console.log(
        "[3] models :",
        models?.models?.map((m: any) => `${m.label} (${m.id})`).join(" · "),
        "| défaut :",
        models?.defaultModel,
        "| source :",
        models?.source
      );

      const upload = await emit("attachments:upload", {
        name: "pixel-rouge.png",
        mime: "image/png",
        dataBase64: PNG_B64,
      });
      console.log("[4] upload :", JSON.stringify(upload));
      const attachment = upload?.attachment;

      if (attachment) {
        const res = await fetch(`${FILES_URL}${attachment.url}`);
        console.log(
          "[5] HTTP GET :",
          res.status,
          res.headers.get("content-type"),
          (await res.arrayBuffer()).byteLength,
          "octets"
        );
      }

      const svg = await emit("attachments:upload", {
        name: "x.svg",
        mime: "image/svg+xml",
        dataBase64: Buffer.from("<svg/>").toString("base64"),
      });
      console.log("[6] rejet SVG :", JSON.stringify(svg));

      const conv = await ack("conversations:create");
      const conversationId = conv?.conversation?.id;
      console.log("[7] conversation :", conversationId);

      const done = await new Promise<any>((resolve) => {
        socket.on("stream:done", (p: any) => resolve(p));
        socket.emit("chat:send", {
          conversationId,
          content: "Réponds en une phrase : quelle est la couleur dominante de cette image ?",
          model: "hermes-4-405b",
          attachments: attachment ? [attachment] : undefined,
        });
      });

      console.log(
        "[8] tour terminé — model :",
        done?.message?.model,
        "| contenu :",
        (done?.message?.content ?? "").slice(0, 200)
      );

      const reopened = await emit("conversations:open", { id: conversationId });
      const userMsg = reopened?.messages?.find((m: any) => m.role === "user");
      console.log(
        "[9] historique — pièces jointes persistées :",
        JSON.stringify(userMsg?.attachments ?? null)
      );
    } catch (err) {
      // (audit 2026-11-21) l'échec doit sortir en 1 : le try/catch avalait
      // l'exception et le finally sortait toujours en 0 — le test comptait
      // « OK » dans bun run test:e2e même en erreur.
      console.error("ÉCHEC DU TEST :", err);
      process.exitCode = 1;
    } finally {
      socket.close();
      process.exit(process.exitCode === 1 ? 1 : 0);
    }
  });

  socket.on("connect_error", (err: any) => {
    console.error("Connexion impossible :", err.message);
    process.exit(1);
  });
}

main();
