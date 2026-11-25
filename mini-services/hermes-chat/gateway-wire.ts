// C5 (25/11, constat n°5 du plan de correction) — Framing JSON-RPC 2.0
// d'UNE WebSocket de gateway : allocation d'id, registre des requêtes en
// vol (rejetées à la mort de la socket — même loi que le Lot audit
// passe 2 : AUCUNE promesse rpc() ne survit à la fermeture, la fuite de
// closure du code d'origine est structurellement impossible ici), et
// diffusion des trames `event` aux abonnés (les tours s'abonnent au
// début et se désabonnent à la fin — la socket, elle, VIT).
// Une instance vit sur UNE socket ; la reconnexion (nouveau ticket
// one-use, nouvelle socket) fabrique une nouvelle instance — l'identité
// de l'instance EST la génération de connexion.
import type WebSocket from "ws";

export type WireEventHandler = (params: unknown) => void;
export type WireDeathHandler = (reason: string) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error & { code?: unknown }) => void;
}

/** Erreur JSON-RPC de la gateway : le code amont (4009 session busy,
 *  4091, invalid_params…) part avec la promesse — l'appelant peut
 *  réagir au CODE, pas au texte. */
function codedError(message: string, code: unknown): Error & { code?: unknown } {
  return Object.assign(new Error(message), { code });
}

export class GatewayWire {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers = new Set<WireEventHandler>();
  private readonly deathHandlers = new Set<WireDeathHandler>();
  private deathReason: string | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw: unknown) => this.dispatch(raw));
    ws.once("close", () => this.kill("Connexion gateway fermée"));
    ws.once("error", (err: Error) => this.kill(`Connexion gateway en erreur : ${err.message}`));
  }

  get alive(): boolean {
    return this.deathReason === null;
  }

  /** Mort de la socket (volontaire ou non) : rejette TOUT rpc en vol,
   *  désabonne les événements, prévient les abonnés de mort. */
  onDeath(handler: WireDeathHandler): () => void {
    this.deathHandlers.add(handler);
    return () => this.deathHandlers.delete(handler);
  }

  private dispatch(raw: unknown): void {
    let data: any;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    const pending = typeof data?.id === "number" ? this.pending.get(data.id) : undefined;
    if (pending) {
      this.pending.delete(data.id);
      if (data?.error) {
        pending.reject(codedError(String(data.error.message ?? "Erreur gateway"), data.error.code));
      } else {
        pending.resolve(data?.result);
      }
      return;
    }
    if (data?.method === "event") this.fanoutEvents(data?.params);
  }

  /** Diffusion d'une notification `event` aux abonnés (copies : un
   *  abonné peut se désabonner pendant la boucle). */
  private fanoutEvents(params: unknown): void {
    for (const handler of [...this.handlers]) handler(params);
  }

  /** Requête JSON-RPC avec réponse attendue (id alloué, registre,
   *  rejet codé à la fermeture). */
  rpc(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.deathReason) return Promise.reject(new Error(this.deathReason));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fire-and-forget : la réponse (si le moteur en émet une) est ignorée
   *  — utilisé par les battements de cœur et les signaux d'interruption,
   *  qui ne doivent JAMAIS bloquer un tour. */
  notify(method: string, params: Record<string, unknown>): void {
    if (this.deathReason) return;
    try {
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }));
    } catch {
      /* la mort suivra : close/error → onDeath */
    }
  }

  /** Abonnement aux trames `event` (flux d'un tour). Retourne le
   *  désabonnement — le tour l'appelle TOUJOURS à sa clôture. */
  onEvent(handler: WireEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Coupure ADMINISTRÉE de la socket (battement de cœur sans réponse,
   *  fermeture volontaire du canal) : la raison passe AVANT le close
   *  brut (« Connexion gateway fermée »), les abonnés de mort la
   *  reçoivent telle quelle. */
  terminate(reason: string): void {
    this.kill(reason);
    try {
      this.ws.terminate();
    } catch {
      /* déjà morte */
    }
  }

  private kill(reason: string): void {
    if (this.deathReason !== null) return;
    this.deathReason = reason;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    this.handlers.clear();
    for (const handler of [...this.deathHandlers]) handler(reason);
    this.deathHandlers.clear();
  }
}
