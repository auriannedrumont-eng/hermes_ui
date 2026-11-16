// Fausse gateway Hermes : écoute ws://127.0.0.1:9120/api/ws et répond
// turn_end au premier tour reçu. Sert à valider le branchement automatique.
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 9120, path: "/api/ws" });
wss.on("connection", (ws) => {
  console.log("[fake-gw] connexion acceptée");
  ws.on("message", (raw) => {
    const data = JSON.parse(String(raw));
    if (data?.api_turn_v1) {
      console.log("[fake-gw] tour reçu:", data.text);
      ws.send(JSON.stringify({ event: "status", status: "Hermes réfléchit…" }));
      ws.send(JSON.stringify({ stream_delta: "bonjour " }));
      ws.send(JSON.stringify({ stream_delta: "depuis la gateway" }));
      ws.send(JSON.stringify({ event: "turn_end" }));
    }
  });
});
console.log("[fake-gw] en écoute sur ws://127.0.0.1:9120/api/ws");
