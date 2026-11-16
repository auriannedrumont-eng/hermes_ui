// Proxy QA : remplace Caddy pendant les tests navigateur du bac à sable.
// Même contrat que le XTransformPort du Caddyfile : la requête /ws arrive avec
// ?XTransformPort=3003 (ou 3004) → forward vers ce port local, paramètre retiré.
// WebSockets (socket.io) : tunnel TCP brut après l'handshake.
import http from "node:http";
import net from "node:net";

const LISTEN = Number(process.env.QA_PROXY_PORT ?? 8181);

function targetPort(url: string): number | null {
  const m = /[?&]XTransformPort=(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

function cleanUrl(url: string): string {
  return url
    .replace(/([?&])XTransformPort=\d+&?/, (s, sep) => (sep === "?" ? "?" : ""))
    .replace(/\?$/, "");
}

const server = http.createServer((req, res) => {
  const port = targetPort(req.url ?? "") ?? Number(process.env.QA_PROXY_NEXT ?? 3000);
  const fwd = http.request(
    {
      host: "127.0.0.1",
      port,
      path: cleanUrl(req.url ?? "/"),
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    }
  );
  fwd.on("error", () => {
    res.writeHead(502);
    res.end("proxy: service injoignable");
  });
  req.pipe(fwd);
});

// WebSockets : tunnel TCP brut — on écrit l'handshake tel quel vers la cible.
server.on("upgrade", (req, socket, head) => {
  const port = targetPort(req.url ?? "") ?? Number(process.env.QA_PROXY_NEXT ?? 3000);
  console.log(`[qa-proxy] upgrade ${req.url} → :${port}`);
  if (!port) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(port, "127.0.0.1", () => {
    const lines = [
      `${req.method} ${cleanUrl(req.url ?? "/")} HTTP/1.1`,
      ...Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`),
    ];
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.on("data", () => {}); // garde le flux vivant (pas de pause implicite)
  });
  upstream.on("error", (e) => {
    console.log(`[qa-proxy] upstream erreur :${port}`, e.message);
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
});

server.listen(LISTEN, () => {
  console.log(`[qa-proxy] écoute sur :${LISTEN} → XTransformPort local`);
});
