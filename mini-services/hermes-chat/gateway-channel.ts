// C5 (25/11, constat n°5 du plan de correction) — Canal WebSocket
// PERSISTANT du service vers la gateway Hermes. Avant : une socket (et
// un ticket) par tour, refermée à la fin → à chaque déconnexion le
// moteur détachait la session et programmait sa récolte d'orphelin
// après 20 s de grâce (ws_orphan_reap) : trois messages espacés d'une
// minute perdaient la session, la mémoire de conversation partait avec.
// Maintenant : UNE socket par service, vivante ENTRE les tours (aucun
// reap : la session reste attachée), re-mint du ticket one-use à
// chaque (re)connexion, battement de cœur gateway.ping toutes les 15 s
// (la boucle de lecture amont y répond même un handler bloqué — une
// connexion morte se voit en 15 s et la socket est coupée proprement).
// La reconnexion se fait À LA DEMANDE (prochain tour / prochaine
// sonde) — aucun retry en tâche de fond qui martèlerait le mint
// python pendant que l'agent est éteint (sensibilité revue 95).
import WebSocket from "ws";
import { GatewayWire } from "./gateway-wire";

export const GATEWAY_PROTOCOL = "hermes-gateway-v1";
export const TICKET_PROTOCOL_PREFIX = "hermes-gateway-ticket.";
const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;

/** Fabrique de connexion du canal : mint le ticket one-use, applique
 *  l'origine réelle (C2) et rend la WebSocket OUVERTE. Jette une Error
 *  CLAIRE si la gateway est injoignable — le canal ne devine rien. */
export type GatewayDialer = () => Promise<WebSocket>;

/** Dial + attente d'open : le mécanisme PARTAGÉ par la sonde (socket
 *  éphémère) et le canal persistant. Garde L2-8 : une WebSocket qui
 *  meurt sans listener « error » tuerait le service — un no-op
 *  d'absorption reste attaché à vie. */
export function openGatewaySocket(
  url: string,
  ticket: string,
  timeoutMs: number
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [GATEWAY_PROTOCOL, TICKET_PROTOCOL_PREFIX + ticket], {
      handshakeTimeout: timeoutMs,
    });
    ws.on("error", () => {}); // garde permanente (L2-8), jamais retirée
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`Gateway Hermes injoignable sur ${url} (délai dépassé)`));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (err: Error) => {
      cleanup();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`Connexion gateway impossible : ${err.message}`));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    }
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

/** La socket persistante. Une instance par service ; le connecteur la
 *  ferme (et la jette) quand la destination change volontairement. */
export class GatewayChannel {
  private wire: GatewayWire | null = null;
  private connecting: Promise<GatewayWire> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly dialer: GatewayDialer) {}

  /** Le framing de la connexion courante (à ne garder que le temps du
   *  tour : l'instance change à chaque reconnexion). */
  ensureConnected(): Promise<GatewayWire> {
    if (this.closed) {
      return Promise.reject(new Error("Canal gateway fermé (destination changée)"));
    }
    if (this.wire?.alive) return Promise.resolve(this.wire);
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    return this.connecting;
  }

  /** Fermeture VOLONTAIRE (bascule d'URL/mode) : les tours en vol
   *  échouent proprement, aucune reconnexion. */
  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.wire?.terminate("Canal gateway fermé (destination changée)");
    this.wire = null;
  }

  private async connect(): Promise<GatewayWire> {
    try {
      const ws = await this.dialer();
      const wire = new GatewayWire(ws);
      wire.onDeath(() => this.onWireDeath(wire));
      this.wire = wire;
      this.startHeartbeat(wire);
      return wire;
    } finally {
      this.connecting = null;
    }
  }

  private onWireDeath(wire: GatewayWire): void {
    if (this.wire !== wire) return; // déjà remplacée par une reconnexion
    this.wire = null;
    this.stopHeartbeat();
    // Pas de retry en tâche de fond : le prochain tour (ou la prochaine
    // sonde) reconnecte à la demande — re-mint inclus.
  }

  private startHeartbeat(wire: GatewayWire): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.pingOnce(wire), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** Un battement : gateway.ping → la boucle de lecture amont répond
   *  MÊME si un handler est bloqué ; n'importe quelle réponse (résultat
   *  OU erreur JSON-RPC) prouve la connexion vivante. Silence > 10 s :
   *  la socket est coupée proprement, la mort se propage aux tours. */
  private pingOnce(wire: GatewayWire): void {
    if (!wire.alive || this.wire !== wire) return;
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (this.wire === wire) {
        wire.terminate("gateway.ping sans réponse — connexion gateway morte");
      }
    }, PONG_TIMEOUT_MS);
    const onSettled = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
    };
    wire.rpc("gateway.ping", {}).then(onSettled, onSettled);
  }
}
