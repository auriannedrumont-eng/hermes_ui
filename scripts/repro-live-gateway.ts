// Repro LIVE (25/11) — fausse gateway « moteur réel » pour tester DANS LE
// NAVIGATEUR le stream fin et le panneau artefact, par la pile complète
// (Caddy 81 → Next 3000 → services 3003/3004). Contrairement à la fausse
// canonique (harnais), celle-ci :
//   • coupe le texte en fragments de 1–5 caractères toutes les 12–35 ms
//     (rythme d'un vrai moteur, coupures EN PLEIN MOT) ;
//   • intercale des trames status/reasoning en pleine réponse ;
//   • répond avec un VRAI jeu HTML (casse-briques canvas, window.__frames)
//     dans une barre ```html — la carte artefact doit naître au fil du
//     stream et la vue « Interactif » doit peindre le jeu.
// Usage : bun scripts/repro-live-gateway.ts [port] [ticket]
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

const port = Number(process.argv[2] ?? 9331);
const ticket = process.argv[3] ?? "livetest123";

// ── Le jeu HTML servi dans la réponse (casse-briques minimal) ──────────
const GAME = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Casse-briques</title>
<style>
  body{margin:0;background:#141414;color:#eee;font-family:system-ui;display:flex;flex-direction:column;align-items:center;gap:10px}
  h1{font-size:18px;margin:14px 0 0}
  canvas{background:#1e1e1e;border-radius:10px;box-shadow:0 0 24px #000}
  #score{font-size:14px}
</style>
</head>
<body>
<h1>Casse-briques</h1>
<canvas id="c" width="480" height="320"></canvas>
<p id="score">Score : 0</p>
<script>
(function(){
  window.__gameReady = true;
  window.__frames = 0;
  var c = document.getElementById('c'), x = c.getContext('2d');
  var ball = {x:240,y:200,dx:3,dy:-3,r:6}, pad = {x:200,w:80}, bricks = [], score = 0;
  for (var r=0;r<3;r++) for (var k=0;k<8;k++) bricks.push({x:20+k*56,y:40+r*24,w:48,h:16,alive:true});
  c.addEventListener('mousemove', function(e){
    var b = c.getBoundingClientRect();
    pad.x = Math.min(400, Math.max(0, (e.clientX-b.left)*480/b.width - pad.w/2));
  });
  function loop(){
    window.__frames++;
    x.clearRect(0,0,480,320);
    ball.x += ball.dx; ball.y += ball.dy;
    if (ball.x < ball.r || ball.x > 480 - ball.r) ball.dx *= -1;
    if (ball.y < ball.r) ball.dy *= -1;
    if (ball.y > 300 && ball.y < 312 && ball.x > pad.x && ball.x < pad.x + pad.w) ball.dy = -Math.abs(ball.dy);
    if (ball.y > 320) { ball.x = 240; ball.y = 200; ball.dy = -3; }
    for (var i=0;i<bricks.length;i++){
      var b = bricks[i];
      if (!b.alive) continue;
      if (ball.x > b.x && ball.x < b.x + b.w && ball.y > b.y && ball.y < b.y + b.h) {
        b.alive = false; ball.dy *= -1; score++;
        document.getElementById('score').textContent = 'Score : ' + score;
      }
      x.fillStyle = '#e67e22'; x.fillRect(b.x, b.y, b.w, b.h);
    }
    x.fillStyle = '#eee'; x.beginPath(); x.arc(ball.x, ball.y, ball.r, 0, 7); x.fill();
    x.fillRect(pad.x, 306, pad.w, 8);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
</script>
</body>
</html>
`;

const CONTENT = `Voici le jeu demandé — un casse-briques complet, dans une seule page HTML autonome. Les briques, la balle et le raquet sont là : bougez la souris pour jouer.

\`\`\`html
${GAME}\`\`\`

Ouvrez la carte ci-dessus en vue « Interactif » : le tour se lance dès l'ouverture. Le score persiste en localStorage.
`;

// ── Découpage « moteur réel » : fragments 1–5 chars, pauses irrégulières ──
// + le motif ACCUSÉ par l'utilisatrice : une PAUSE longue en pleine réponse
// (outils/réflexion côté moteur) puis une RAFALE de ~400 caractères d'un
// coup — le rendu brut saute ; la révélation douce doit l'étaler.
async function streamLikeEngine(ws: WebSocket, full: string): Promise<void> {
  let i = 0;
  let n = 0;
  const burstAt = Math.floor(full.length * 0.3);
  while (i < full.length) {
    if (i === burstAt) {
      ws.send(JSON.stringify({ method: "event", params: { type: "status.update", payload: { text: "cogitating… (_o_)" } } }));
      await new Promise((r) => setTimeout(r, 2500)); // pause « outils »
      const burst = full.slice(i, i + 400);
      i += 400;
      ws.send(JSON.stringify({ method: "event", params: { type: "message.delta", payload: { text: burst } } }));
      await new Promise((r) => setTimeout(r, 60));
      continue;
    }
    const size = 1 + Math.floor(Math.random() * 5);
    const chunk = full.slice(i, i + size);
    i += size;
    ws.send(JSON.stringify({ method: "event", params: { type: "message.delta", payload: { text: chunk } } }));
    n++;
    if (n % 40 === 0) {
      // Trames interleavées : statut (comme l'amont) et un cran de raisonnement.
      ws.send(JSON.stringify({ method: "event", params: { type: "status.update", payload: { text: "cogitating… (_o_)" } } }));
      ws.send(JSON.stringify({ method: "event", params: { type: "reasoning.delta", payload: { text: "je pose la structure du jeu, canvas et boucle…" } } }));
    }
    await new Promise((r) => setTimeout(r, 12 + Math.floor(Math.random() * 23)));
  }
}

function reply(ws: WebSocket, id: unknown, result: unknown): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function replyError(ws: WebSocket, id: unknown, code: number, message: string): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}
const hex8 = () => Math.random().toString(16).slice(2, 10);

interface FakeSession { sid: string; running: boolean; usage: { input: number; output: number; total: number } }
const byStored = new Map<string, FakeSession>();
const bySid = new Map<string, FakeSession>();

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (raw: unknown) => {
    let req: any;
    try { req = JSON.parse(String(raw)); } catch { return; }
    switch (req?.method) {
      case "gateway.ping":
        reply(ws, req.id, { ok: true });
        return;
      case "session.create": {
        const sid = hex8();
        const stored = hex8() + Date.now().toString(16);
        const session: FakeSession = { sid, running: false, usage: { input: 0, output: 0, total: 0 } };
        byStored.set(stored, session);
        bySid.set(sid, session);
        reply(ws, req.id, { session_id: sid, stored_session_id: stored, message_count: 0 });
        return;
      }
      case "session.resume": {
        const stored = String(req?.params?.session_id ?? "");
        const session = byStored.get(stored) ?? { sid: hex8(), running: false, usage: { input: 0, output: 0, total: 0 } };
        byStored.set(stored, session);
        bySid.set(session.sid, session);
        reply(ws, req.id, { session_id: session.sid, stored_session_id: stored, message_count: 0 });
        return;
      }
      case "prompt.submit": {
        const p = req?.params ?? {};
        const session = bySid.get(String(p?.session_id ?? ""));
        if (!session) { replyError(ws, req.id, 4006, "unknown session"); return; }
        if (session.running) { replyError(ws, req.id, 4009, "session busy"); return; }
        session.running = true;
        reply(ws, req.id, { status: "streaming", admission_id: hex8() });
        void (async () => {
          ws.send(JSON.stringify({ method: "event", params: { type: "status.update", payload: { text: "Hermes réfléchit…" } } }));
          await new Promise((r) => setTimeout(r, 400));
          await streamLikeEngine(ws, CONTENT);
          const usage = {
            input: session.usage.input + 900,
            output: session.usage.output + 640,
            total: session.usage.total + 1540,
          };
          session.usage = usage;
          session.running = false;
          ws.send(JSON.stringify({
            method: "event",
            params: {
              type: "session.usage",
              session_id: session.sid,
              payload: { usage: { ...usage }, input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.total },
            },
          }));
          ws.send(JSON.stringify({ method: "event", params: { type: "message.complete", payload: { text: CONTENT, usage: { ...usage } } } }));
        })();
        return;
      }
      case "session.interrupt":
        reply(ws, req.id, { ok: true });
        return;
      default:
        replyError(ws, req.id, -32601, `unknown method: ${String(req?.method)}`);
    }
  });
});

const httpServer = createServer((req, res) => {
  if (req.method === "GET" && (req.url ?? "").startsWith("/api/model/options")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ id: "glm-live-fake", label: "GLM live fake", provider: "zai-fake", efforts: ["off", "low", "high"] }] }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("pas de contrat REST");
});
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const protocols = new Set(
    String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  );
  const hasTicket = [...protocols].some((p) => p.startsWith(`hermes-gateway-ticket.${ticket}`));
  if (url.pathname !== "/api/ws" || !protocols.has("hermes-gateway-v1") || !hasTicket) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit("connection", ws, req);
  });
});
httpServer.listen(port, "127.0.0.1", () => {
  console.log(`repro-live-gateway prêt sur ws://127.0.0.1:${port}/api/ws (ticket ${ticket})`);
});
