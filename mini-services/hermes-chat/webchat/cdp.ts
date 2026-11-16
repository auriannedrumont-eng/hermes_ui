// Client CDP minimal (idiome du repo : render.ts, aucune dépendance
// puppeteer) — adapté au pilotage : connexion à un navigateur DÉJÀ LANCÉ sur
// un port de débogage fixe, gestion des onglets par HTTP (/json, /json/close,
// /json/new), évaluation JS, navigation, insertion de texte et clics réels.
//
// Rappels de la spec (§2) : une seule connexion CDP par appel suffit ; un
// crochet posé via Page.addScriptToEvaluateOnNewDocument meurt avec la
// connexion qui l'a posé — le signal de fin reste le DOM.

import WebSocket from "ws";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
}

/** Onglet « page » tel que listé par GET /json. */
export interface TargetInfo {
  id: string;
  type: string;
  title?: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

// ── Endpoints HTTP du port de débogage ───────────────────────────────

async function devtoolsJson(port: number, path: string, method = "GET"): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  if (!res.ok) throw new Error(`CDP ${method} ${path} → ${res.status}`);
  return res.json();
}

/** Liste des cibles « page » du navigateur de pilotage. */
export async function listTargets(port: number): Promise<TargetInfo[]> {
  const raw = (await devtoolsJson(port, "/json")) as TargetInfo[];
  return Array.isArray(raw) ? raw.filter((t) => t.type === "page") : [];
}

/** Ferme un onglet par id (hygiène : about:blank et doublons). */
export async function closeTarget(port: number, id: string): Promise<void> {
  try {
    await devtoolsJson(port, `/json/close/${id}`);
  } catch {
    /* déjà fermé */
  }
}

/** Ouvre un onglet et le laisse sur about:blank (la navigation suit par CDP). */
export async function newTab(port: number, url = "about:blank"): Promise<TargetInfo> {
  // Les versions récentes de Chrome exigent PUT pour /json/new.
  try {
    return (await devtoolsJson(port, `/json/new?${url}`, "PUT")) as TargetInfo;
  } catch {
    return (await devtoolsJson(port, `/json/new?${url}`)) as TargetInfo;
  }
}

/** Trouve l'onglet du site (url contenant match), null s'il n'existe pas. */
export function findTab(targets: TargetInfo[], match: string): TargetInfo | null {
  return targets.find((t) => (t.url ?? "").includes(match)) ?? null;
}

// ── Connexion WebSocket à une cible page ─────────────────────────────

export class CdpPage {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on("message", (data: WebSocket.RawData) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }

  static async connect(wsUrl: string): Promise<CdpPage> {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err: Error) => reject(err));
    });
    return new CdpPage(ws);
  }

  send(method: string, params?: any, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout : ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runtime.evaluate avec valeur de retour sérialisée (returnByValue). */
  async evaluate<T = any>(expression: string, timeoutMs = 15_000): Promise<T> {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      timeoutMs
    );
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails?.exception?.description ??
        res.exceptionDetails?.text ??
        "exception JS";
      throw new Error(`Évaluation JS : ${String(desc).slice(0, 300)}`);
    }
    return res?.result?.value as T;
  }

  /** Navigation — Page.navigate, erreur explicite si la page refuse. */
  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    const res = await this.send("Page.navigate", { url }, timeoutMs);
    if (res?.errorText) throw new Error(`Navigation échouée : ${res.errorText}`);
  }

  /** Rechargement sans cache (AI Studio : discussion neuve garée). */
  async reloadIgnoringCache(): Promise<void> {
    await this.send("Page.reload", { ignoreCache: true });
  }

  /**
   * Insertion de texte SANS frappe touche par touche : Input.insertText sur
   * l'élément focalisé (fonctionne aussi sur les contenteditable). Une Entrée
   * nue activerait l'élément qui a le focus — jamais utilisée.
   */
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /**
   * Clic réel sur un sélecteur : l'élément est retrouvé VISIBLE (offsetParent
   * non nul et rect > 0 — piège du doublon caché 0×0, spec §8), survolé puis
   * pressé par Input.dispatchMouseEvent (clic de vraie souris, pas .click()).
   */
  async click(selector: string, timeoutMs = 10_000): Promise<boolean> {
    return this.clickFinder(
      `(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = els.find((e) => {
          if (!e || !(e instanceof Element)) return false;
          if (!e.offsetParent && getComputedStyle(e).position !== "fixed") return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!el) return null;
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
      timeoutMs
    );
  }

  /** Clic réel sur un point retourné par une expression JS (null = rien). */
  async clickFinder(finderExpr: string, timeoutMs = 10_000): Promise<boolean> {
    const point = await this.evaluate(finderExpr, timeoutMs);
    if (!point || typeof point.x !== "number") return false;
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, button: "none",
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
    });
    return true;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* déjà fermée */
    }
  }
}

/** Attente générique (plafond explicite — jamais une durée qui « réussit »). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
