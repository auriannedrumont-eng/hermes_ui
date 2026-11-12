// Diagnostic rapide du mini-service : hello, models:list, upload, HTTP
import { io } from "socket.io-client";

const URL = "http://localhost:3003";
const socket = io(URL, { path: "/", transports: ["websocket"], timeout: 8000 });

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function emit(event: string, payload?: any): Promise<any> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res: any) => resolve(res));
  });
}

async function main() {
  socket.on("connect", async () => {
    try {
      const hello = await emit("hello");
      console.log("hello :", JSON.stringify(hello));

      const models = await emit("models:list");
      console.log("models:list :", JSON.stringify(models).slice(0, 500));

      const upload = await emit("attachments:upload", {
        name: "pixel-rouge.png",
        mime: "image/png",
        dataBase64: PNG_B64,
      });
      console.log("upload :", JSON.stringify(upload));
      const attachment = upload?.attachment;

      if (attachment) {
        const res = await fetch(`${URL}${attachment.url}`);
        console.log("HTTP GET :", res.status, res.headers.get("content-type"), (await res.arrayBuffer()).byteLength, "o");
      }

      const svg = await emit("attachments:upload", {
        name: "x.svg",
        mime: "image/svg+xml",
        dataBase64: Buffer.from("<svg/>").toString("base64"),
      });
      console.log("rejet SVG :", JSON.stringify(svg));

      const conv = await emit("conversations:create");
      console.log("conversation :", conv?.conversation?.id);
    } catch (err) {
      console.error("ÉCHEC :", err);
    } finally {
      socket.close();
      process.exit(0);
    }
  });

  socket.on("connect_error", (err: any) => {
    console.error("Connexion impossible :", err.message);
    process.exit(1);
  });
}

main();
