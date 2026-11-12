// Pipeline de rendu des artefacts HTML par chrome-headless-shell (CDP).
// - Aperçu PNG plein page (captureBeyondViewport) : fidélité garantie, le même
//   fichier sert de vignette à la carte — validé par le benchmark interne
//   (chrome-headless-shell vs Obscura, 12/11/2026).
// - Export PDF vectoriel au texte sélectionnable (Page.printToPDF).
// Client CDP minimal sur `ws` (aucune dépendance puppeteer), navigateur
// singleton réutilisé, rends sérialisés dans une file.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

const CHROME_CANDIDATES = [
  process.env.CHROME_HEADLESS_PATH,
  join(
    process.env.HOME ?? "/home/z",
    ".cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell"
  ),
  "/usr/bin/chrome-headless-shell",
  "/usr/bin/chromium",
];

const LAUNCH_ARGS = [
  "--remote-debugging-port=0",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-features=Translate,BackForwardCache",
  // Profil unique par incarnation du service : un chrome orphelin (hot-reload,
  // redémarrage) ne doit jamais verrouiller le profil du suivant.
  "--user-data-dir=" + join(tmpdir(), `hermes-chrome-${crypto.randomUUID()}`),
  "about:blank",
];

const VIEWPORT_WIDTH = 1280;
const NAV_TIMEOUT_MS = 20_000;
const SETTLE_MS = 450;
const GLOBAL_TIMEOUT_MS = 45_000;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
}

class CdpPage {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventWaiters: Array<{ method: string; resolve: (p: any) => void; timer: NodeJS.Timeout }> = [];

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
        return;
      }
      if (msg.method) {
        for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
          if (this.eventWaiters[i].method === msg.method) {
            const w = this.eventWaiters[i];
            clearTimeout(w.timer);
            this.eventWaiters.splice(i, 1);
            w.resolve(msg.params);
          }
        }
      }
    });
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

  /** Attend un événement CDP une fois. */
  waitForEvent(method: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.eventWaiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.eventWaiters.splice(idx, 1);
        reject(new Error(`Événement non reçu : ${method}`));
      }, timeoutMs);
      this.eventWaiters.push({ method, resolve, timer });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* déjà fermée */
    }
  }
}

export class ChromeRenderer {
  private proc: ChildProcess | null = null;
  private browserWsUrl: string | null = null;
  private debugPort: number | null = null;
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private findBinary(): string | null {
    for (const c of CHROME_CANDIDATES) {
      if (c && existsSync(c)) return c;
    }
    return null;
  }

  /** Démarre chrome-headless-shell (une fois) et résout l'URL CDP. */
  private async ensureStarted(): Promise<void> {
    if (this.proc && this.browserWsUrl && !(this.proc as any).exitCode) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const bin = this.findBinary();
      if (!bin) throw new Error("chrome-headless-shell introuvable sur cette machine");
      if (this.proc) {
        try {
          this.proc.kill();
        } catch {}
        this.proc = null;
      }
      await new Promise<void>((resolve, reject) => {
        const p = spawn(bin, LAUNCH_ARGS, { stdio: ["ignore", "pipe", "pipe"] });
        let settled = false;
        const onData = (chunk: Buffer) => {
          const s = chunk.toString();
          const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[0-9a-f-]+/.exec(s);
          if (m && !settled) {
            settled = true;
            this.debugPort = Number(m[1]);
            // L'URL browser complète figure sur la même ligne
            const full = /(ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+)/.exec(s);
            this.browserWsUrl = full ? full[1] : `ws://127.0.0.1:${this.debugPort}`;
            resolve();
          }
        };
        p.stderr?.on("data", onData);
        p.stdout?.on("data", onData);
        p.on("error", (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        p.on("exit", () => {
          this.proc = null;
          this.browserWsUrl = null;
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("chrome-headless-shell : pas de port CDP annoncé"));
          }
        }, 15_000);
        this.proc = p;
      });
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** Ouvre une page (target) et renvoie le client CDP + targetId. */
  private async newPage(): Promise<{ page: CdpPage; targetId: string }> {
    await this.ensureStarted();
    const res = await fetch(`http://127.0.0.1:${this.debugPort}/json/new?about:blank`, {
      method: "PUT",
    });
    if (!res.ok) throw new Error(`Impossible d'ouvrir une page CDP (${res.status})`);
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err: Error) => reject(err));
    });
    return { page: new CdpPage(ws), targetId: target.id };
  }

  private async closeTarget(targetId: string): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${this.debugPort}/json/close/${targetId}`);
    } catch {
      /* déjà fermée */
    }
  }

  /** Rend un HTML : PNG plein page + PDF vectoriel. Sérialisé par file. */
  renderHtml(html: string): Promise<{ png: Buffer; pdf: Buffer; renderMs: number }> {
    const job = async () => {
      const started = Date.now();
      let targetId: string | null = null;
      let page: CdpPage | null = null;
      const tmpHtml = join(tmpdir(), `hermes-artifact-${crypto.randomUUID()}.html`);
      try {
        mkdirSync(tmpdir(), { recursive: true });
        writeFileSync(tmpHtml, html, "utf-8");
        const opened = await Promise.race([
          this.newPage(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Ouverture de page CDP expirée")), GLOBAL_TIMEOUT_MS)
          ),
        ]);
        page = opened.page;
        targetId = opened.targetId;
        await page.send("Page.enable");
        await page.send("Emulation.setDeviceMetricsOverride", {
          width: VIEWPORT_WIDTH,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const loaded = page.waitForEvent("Page.loadEventFired", NAV_TIMEOUT_MS);
        const nav = await page.send("Page.navigate", {
          url: `file://${tmpHtml}`,
        });
        if (nav?.errorText) throw new Error(`Navigation échouée : ${nav.errorText}`);
        await loaded;
        // Stabilisation : polices web + animations + peinture
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        try {
          await page.send("Runtime.evaluate", {
            expression: "document.fonts && document.fonts.status === 'loading' ? document.fonts.ready.then(() => 1) : 1",
            awaitPromise: true,
            timeout: 4000,
          });
        } catch {
          /* polices : au mieux */
        }
        // 1. Capture PNG plein page (au-delà du viewport)
        const shot = await page.send(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: true, fromSurface: true },
          GLOBAL_TIMEOUT_MS
        );
        // 2. Export PDF vectoriel (texte sélectionnable)
        const pdf = await page.send(
          "Page.printToPDF",
          {
            printBackground: true,
            preferCSSPageSize: true,
            marginTop: 0,
            marginRight: 0,
            marginBottom: 0,
            marginLeft: 0,
            scale: 1,
          },
          GLOBAL_TIMEOUT_MS
        );
        return {
          png: Buffer.from(shot.data, "base64"),
          pdf: Buffer.from(pdf.data, "base64"),
          renderMs: Date.now() - started,
        };
      } finally {
        page?.close();
        if (targetId) await this.closeTarget(targetId);
        try {
          unlinkSync(tmpHtml);
        } catch {
          /* déjà supprimé */
        }
      }
    };
    // File d'attente : un rendu à la fois (le navigateur singleton est partagé)
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  shutdown(): void {
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
    this.browserWsUrl = null;
  }
}

/** Nettoie les profils chrome orphelins de ce service (best effort). */
try {
  const tmp = tmpdir();
  for (const dir of readdirSync(tmp)) {
    if (dir.startsWith("hermes-chrome-")) {
      try {
        rmSync(join(tmp, dir), { recursive: true, force: true, maxRetries: 0 });
      } catch {
        /* profil encore utilisé par un chrome vivant */
      }
    }
  }
} catch {
  /* /tmp illisible — sans conséquence */
}

/** Singleton du service. */
export const chromeRenderer = new ChromeRenderer();
