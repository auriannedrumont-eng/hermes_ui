// Fausse gateway AVEC verrou : imite la porte du webapp de hermes-agent
// 0.21.x — la poignée de main /api/ws n'est acceptée qu'avec
// ?token=<JETON> correct ; sinon réponse HTTP 401 propre, comme
// auth_middleware amont (hermes_cli/web_server.py).
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const JETON = process.env.GATEWAY_TOKEN ?? "tok-test-1234";
const wss = new WebSocketServer({ noServer: true });
let admis = 0;
let refuses = 0;

const httpServer = createServer((_req, res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("pas de page à la racine (comme l'agent réel)");
});
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const token = url.searchParams.get("token") ?? "";
  if (pathname !== "/api/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (token !== JETON) {
    refuses++;
    console.log(`[fake-gw-gated] DIAL ${req.url} → REFUSÉ 401 (${refuses}e)`);
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  admis++;
  console.log(`[fake-gw-gated] DIAL ${req.url} → ADMIS (${admis}e)`);
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit("connection", ws, req);
  });
});
wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (raw) => {
    const data = JSON.parse(String(raw));
    if (data?.api_turn_v1) {
      ws.send(JSON.stringify({ event: "status", status: "Hermes réfléchit…" }));
      ws.send(JSON.stringify({ stream_delta: "bonjour " }));
      ws.send(JSON.stringify({ stream_delta: "depuis la gateway verrouillée" }));
      ws.send(JSON.stringify({ event: "turn_end" }));
    }
  });
});
httpServer.listen(9120, "127.0.0.1", () => {
  console.log(`[fake-gw-gated] en écoute sur ws://127.0.0.1:9120/api/ws (jeton requis)`);
});
