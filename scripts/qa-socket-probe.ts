// Sonde socket.io à travers le proxy QA (websocket + polling).
import { io } from "socket.io-client";

const url = process.argv[2] ?? "http://localhost:8181";
const s = io(`${url}/?XTransformPort=3003`, {
  transports: ["websocket"],
  path: "/",
  timeout: 4000,
});
s.on("connect", () => {
  console.log("WS proxy : CONNECTÉ", s.id);
  s.emit("conversations:list", (res: any) => {
    console.log("conversations:list →", Array.isArray(res?.conversations) ? `${res.conversations.length} conversation(s)` : JSON.stringify(res)?.slice(0, 80));
    s.close();
    process.exit(0);
  });
});
s.on("connect_error", (e: Error) => {
  console.log("WS proxy : ERREUR", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log("timeout");
  process.exit(2);
}, 6000);
