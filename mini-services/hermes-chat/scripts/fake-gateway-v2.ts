// Fausse gateway CANONIQUE (C7, 25/11, constat n°8 du plan de correction)
// — elle parle le VRAI contrat du moteur Hermes (hermes-gateway-v1),
// celui que le connecteur rencontre en production, pour remplacer les
// faux `api_turn_v1` (protocole que le connecteur REFUSE : la QA ne
// pouvait pas tester le chemin nominal). Contrat implémenté, vérifié
// sur le code amont (tui_gateway/) :
//   • upgrade : sous-protocoles `hermes-gateway-v1` +
//     `hermes-gateway-ticket.<ticket>` (le faux accepte tout ticket —
//     le vrai vit 30 s et une seule utilisation, coupler le harnais à
//     l'horloge n'apporterait rien) et échoe le protocole canonique ;
//     sans les deux : refus 401 propre, comme la porte réelle ;
//   • JSON-RPC 2.0 par id : session.create rend {session_id (runtime),
//     stored_session_id (id DURABLE), message_count} ; session.resume
//     par l'id durable rend la session (rebinding de transport — le
//     vrai moteur persiste les sessions, le faux les garde en mémoire
//     et accepte tout resume : chemin nominal simulé) ;
//   • prompt.submit : réponse {status:"streaming"} PUIS notifications
//     `event` (status.update, message.delta, message.complete avec le
//     texte final autoritaire) — complete différé de slowMs pour
//     laisser le harnais couper en plein vol ; refus 4009 session busy
//     si un tour tourne ; 4006 session inconnue ;
//   • image.attach_bytes : {attached, path (chemin de staging moteur),
//     count} — le contenu base64 est compté, pas écrit ;
//   • gateway.ping : répondu {ok:true} par la boucle de lecture, même
//     pendant un tour (comme ws.py) — le battement de cœur C5 se voit ;
//   • session.interrupt : {ok:true}, compté ;
//   • REST : GET /api/model/options rend la liste (le connecteur en
//     tire modelsCache source « gateway » — le C6 y lit son
//     fournisseur) ; tout le reste (dont /v1/capabilities) répond 404
//     comme le webapp listener : la bascule REST reste coupée, le WS
//     est le chemin testé ;
//   • test.drop : contrôle DU HARNAIS — coupe la socket côté serveur
//     (simule une coupure réseau / un redémarrage du moteur).
// Mode bibliothèque : startFakeGateway() pour les tests (stats en
// direct). Mode script : `bun mini-services/hermes-chat/scripts/fake-gateway-v2.ts`
// pour brancher l'interface dessus à la main.
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeGatewayStats {
  connections: number;
  disconnects: number;
  creates: number;
  resumes: number;
  pings: number;
  interrupts: number;
  /** Une entrée par prompt.submit : le corps exact reçu (le harnais
   *  y asserte model_override C6, les attachments C3, session_id). */
  submits: Array<Record<string, unknown>>;
  /** Une entrée par image.attach_bytes (session_id exigée, journal 19). */
  attaches: Array<{ filename: string; ext: string; bytes: number; session_id: string }>;
}

interface FakeSession {
  sid: string;
  running: boolean;
  history: string[];
}

const hex8 = () => Math.random().toString(16).slice(2, 10);
const stampKey = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${hex8()}`;
};

function reply(ws: WebSocket, id: unknown, result: unknown): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function replyError(ws: WebSocket, id: unknown, code: number, message: string): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

function event(ws: WebSocket, type: string, payload: unknown): void {
  ws.send(JSON.stringify({ method: "event", params: { type, payload } }));
}

export interface FakeGateway {
  url: string;
  ticket: string;
  modelId: string;
  stats: FakeGatewayStats;
  /** Résout quand l'écoute est ouverte (à attendre avant de brancher le
   *  service dessus). */
  ready(): Promise<void>;
  /** Coupe TOUTES les sockets côté serveur (coupure réseau simulée —
   *  le canal persistant doit reconnecter le tour suivant). */
  dropAll(): void;
  close(): Promise<void>;
}

/** Démarre la fausse gateway canonique. `slowMs` retarde le
 *  message.complete (fenêtre de coupe du harnais). */
export function startFakeGateway(port = 9321, slowMs = 600): FakeGateway {
  const stats: FakeGatewayStats = {
    connections: 0,
    disconnects: 0,
    creates: 0,
    resumes: 0,
    pings: 0,
    interrupts: 0,
    submits: [],
    attaches: [],
  };
  const byStored = new Map<string, FakeSession>();
  const bySid = new Map<string, FakeSession>();
  const wss = new WebSocketServer({
    noServer: true,
    // Le vrai moteur n'accepte l'upgrade qu'avec le protocole canonique
    // ET un ticket en sous-protocole (gateway_client.py) — pareil ici,
    // ticket any (cf. en-tête) : l'écho du protocole prouve la négociation.
    handleProtocols(protocols: Set<string>): string | false {
      const hasTicket = [...protocols].some((p) => p.startsWith("hermes-gateway-ticket."));
      return protocols.has("hermes-gateway-v1") && hasTicket ? "hermes-gateway-v1" : false;
    },
  });
  wss.on("connection", (ws: WebSocket) => {
    stats.connections++;
    ws.on("close", () => {
      stats.disconnects++;
    });
    ws.on("message", (raw: unknown) => {
      let req: any;
      try {
        req = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (req?.method) {
        case "gateway.ping":
          stats.pings++;
          reply(ws, req.id, { ok: true });
          return;
        case "session.create": {
          stats.creates++;
          const sid = hex8();
          const stored = stampKey();
          const session: FakeSession = { sid, running: false, history: [] };
          byStored.set(stored, session);
          bySid.set(sid, session);
          reply(ws, req.id, { session_id: sid, stored_session_id: stored, message_count: 0 });
          return;
        }
        case "session.resume": {
          stats.resumes++;
          const stored = String(req?.params?.session_id ?? "");
          const session = byStored.get(stored) ?? { sid: hex8(), running: false, history: [] };
          byStored.set(stored, session);
          bySid.set(session.sid, session);
          reply(ws, req.id, { session_id: session.sid, stored_session_id: stored, message_count: session.history.length });
          return;
        }
        case "image.attach_bytes": {
          const p = req?.params ?? {};
          // Journal 19 (moteur réel) : le moteur exige session_id dans les
          // params (_sess_building) — sans lui, 4000 invalid_params. La
          // fausse DOIT refuser pareil, sinon elle validerait un contrat
          // que le vrai moteur rejette.
          if (typeof p?.session_id !== "string" || !p.session_id || !bySid.has(p.session_id)) {
            replyError(ws, req.id, 4000, "invalid_params: session_id requis (contrat moteur)");
            return;
          }
          const b64 = String(p?.content_base64 ?? "");
          // Longueur DÉCODÉE (padding compris) — ce que le moteur reçoit.
          const bytes =
            Math.floor(b64.length / 4) * 3 -
            (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
          stats.attaches.push({
            filename: String(p?.filename ?? "?"),
            ext: String(p?.ext ?? "?"),
            bytes,
            session_id: p.session_id,
          });
          reply(ws, req.id, {
            attached: true,
            path: `/tmp/hermes-fake-staging/${String(p?.filename ?? "image")}`,
            count: stats.attaches.length,
          });
          return;
        }
        case "prompt.submit": {
          const p = req?.params ?? {};
          stats.submits.push({
            session_id: p?.session_id,
            text: p?.text,
            submission_id: p?.submission_id,
            model_override: p?.model_override,
            attachments: p?.attachments,
          });
          const session = bySid.get(String(p?.session_id ?? ""));
          if (!session) {
            replyError(ws, req.id, 4006, "unknown session");
            return;
          }
          if (session.running) {
            replyError(ws, req.id, 4009, "session busy");
            return;
          }
          session.running = true;
          reply(ws, req.id, { status: "streaming" });
          event(ws, "status.update", { text: "Hermes réfléchit…" });
          event(ws, "message.delta", { text: "réponse " });
          event(ws, "message.delta", { text: "canonique" });
          const text = String(p?.text ?? "");
          setTimeout(() => {
            session.running = false;
            session.history.push(text);
            event(ws, "message.complete", { text: `réponse canonique à « ${text} »` });
          }, slowMs);
          return;
        }
        case "session.interrupt":
          stats.interrupts++;
          reply(ws, req.id, { ok: true });
          return;
        case "test.drop":
          // Contrôle du harnais : coupe la socket côté serveur (coupure
          // réseau simulée — le canal persistant doit se reconnecter).
          ws.terminate();
          return;
        default:
          replyError(ws, req.id, -32601, `unknown method: ${String(req?.method)}`);
      }
    });
  });
  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && (req.url ?? "").startsWith("/api/model/options")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              id: "glm-fake-canonique",
              label: "GLM fake canonique",
              provider: "zai-fake",
              efforts: ["off", "low", "high"],
            },
          ],
        })
      );
      return;
    }
    // Comme le webapp listener réel : pas de contrat REST ici (la sonde
    // /v1/capabilities reçoit 404 → bascule REST coupée, WS testé).
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("pas de contrat REST (comme le webapp listener réel)");
  });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const protocols = new Set(
      String(req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    );
    const hasTicket = [...protocols].some((p) => p.startsWith("hermes-gateway-ticket."));
    if (url.pathname !== "/api/ws" || !protocols.has("hermes-gateway-v1") || !hasTicket) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, req);
    });
  });
  const modelId = "glm-fake-canonique";
  const started = new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));
  const dropAll = () => {
    for (const client of wss.clients) client.terminate();
  };
  return {
    url: `ws://127.0.0.1:${port}/api/ws`,
    ticket: "fake-ticket-canonique",
    modelId,
    stats,
    ready: () => started,
    dropAll,
    close: () =>
      new Promise((resolve) => {
        dropAll();
        wss.close(() => resolve());
        httpServer.close(() => resolve());
      }),
  };
}

// Mode script : écoute seule (branchement manuel de l'interface — la
// couture HERMES_GATEWAY_ATTACH_JSON pointe sur ce port).
if (import.meta.main) {
  const port = Number(process.env.FAKE_GW_PORT ?? 9321);
  const slowMs = Number(process.env.FAKE_GW_SLOW_MS ?? 600);
  const gw = startFakeGateway(port, slowMs);
  void gw.ready().then(() => {
    console.log(`[fake-gw-v2] écoute canonique sur ${gw.url} (ticket ${gw.ticket}, complete +${slowMs} ms)`);
    console.log(
      `[fake-gw-v2] couture service : HERMES_GATEWAY_ATTACH_JSON='${JSON.stringify({ ticket: gw.ticket, url: gw.url })}'`
    );
  });
}
