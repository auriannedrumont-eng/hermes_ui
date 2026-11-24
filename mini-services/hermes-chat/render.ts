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
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

// Résolution du binaire chrome-headless-shell, multiplateforme :
// 1) variable CHROME_HEADLESS_PATH (le lanceur portable la règle sur tools\) ;
// 2) caches Playwright — %LOCALAPPDATA%\ms-playwright sous Windows,
//    ~/.cache/ms-playwright sous Linux/macOS ($PLAYWRIGHT_BROWSERS_PATH
//    honoré aussi) — en scannant TOUTES les révisions : le dossier
//    « chromium_headless_shell-<rev> » change de numéro à chaque version de
//    Playwright, et épingler un chemin Linux en dur rendait le binaire
//    introuvable sous Windows même correctement installé ;
// 3) binaires système connus, en dernier recours.
const IS_WIN = process.platform === "win32";
const SHELL_EXE = IS_WIN ? "chrome-headless-shell.exe" : "chrome-headless-shell";
const SHELL_SUBDIRS = IS_WIN
  ? ["chrome-headless-shell-win64"]
  : ["chrome-headless-shell-linux64", "chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac"];

function scanPlaywrightShellCandidates(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  const bases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    IS_WIN && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "ms-playwright")
      : null,
    home ? join(home, IS_WIN ? "AppData/Local/ms-playwright" : ".cache/ms-playwright") : null,
  ].filter((b): b is string => !!b);
  const hits: string[] = [];
  for (const base of bases) {
    let revisions: string[];
    try {
      revisions = readdirSync(base)
        .filter((d) => d.startsWith("chromium_headless_shell-"))
        .sort()
        .reverse(); // révision la plus récente d'abord
    } catch {
      continue; // cache absent de cette machine
    }
    for (const rev of revisions) {
      for (const sub of SHELL_SUBDIRS) hits.push(join(base, rev, sub, SHELL_EXE));
      hits.push(join(base, rev, SHELL_EXE)); // archive extraite sans sous-dossier
    }
  }
  return hits;
}

const CHROME_CANDIDATES = [
  process.env.CHROME_HEADLESS_PATH || null,
  ...scanPlaywrightShellCandidates(),
  "/usr/bin/chrome-headless-shell",
  "/usr/bin/chromium",
];

const LAUNCH_ARGS_BASE = [
  "--remote-debugging-port=0",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-features=Translate,BackForwardCache",
];

/** Arguments de lancement, profil FRAIS à chaque appel (revue 95) :
 *  l'ancien tableau figé générait l'UUID de --user-data-dir UNE fois au
 *  chargement du module — un chrome qui plantait puis redémarrait via
 *  ensureStarted() réutilisait le même dossier de profil (verrous stales,
 *  préférences corrompues). */
function launchArgs(): string[] {
  return [
    ...LAUNCH_ARGS_BASE,
    "--user-data-dir=" + join(tmpdir(), `hermes-chrome-${crypto.randomUUID()}`),
    "about:blank",
  ];
}

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
  private eventWaiters: Array<{ method: string; resolve: (p: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];

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
    // Lot 2 (audit L2-8) : après le handshake il n'y avait PLUS aucun listener
    // « error » — un crash de Chrome levait une exception non gérée (processus
    // tué) et les requêtes en vol attendaient leur timeout 20 s. Erreur et
    // fermeture rejettent maintenant toutes les pending immédiatement.
    this.ws.on("error", (err: Error) =>
      this.rejectAllPending(`WebSocket CDP (rendu) : ${err.message}`)
    );
    this.ws.on("close", () =>
      this.rejectAllPending("WebSocket CDP (rendu) fermée (Chrome fermé ou crashé)")
    );
  }

  /** Rejette toutes les requêtes en vol (erreur/fermeture de la WebSocket). */
  private rejectAllPending(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    // Les attentes d'événements aussi : elles n'arriveront jamais — rejet
    // explicite (même sémantique que leur timeout).
    for (const w of this.eventWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    this.eventWaiters = [];
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
      this.eventWaiters.push({ method, resolve, reject, timer });
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
        const p = spawn(bin, launchArgs(), { stdio: ["ignore", "pipe", "pipe"] });
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

  /** Ouvre une page (target) et renvoie le client CDP + targetId.
   *  Auto-bornée et auto-nettoyante : si la création OU l'ouverture WebSocket
   *  dépasse le délai global, l'onglet déjà créé et son WebSocket sont
   *  refermés avant de rejeter. (Avant : renderHtml courait newPage contre
   *  une course de 45 s ; à l'expiration, targetId/page étaient encore null
   *  dans le finally pendant que newPage finissait en arrière-plan —
   *  l'onglet et sa WebSocket fuyaient dans le navigateur singleton.) */
  private async newPage(): Promise<{ page: CdpPage; targetId: string }> {
    await this.ensureStarted();
    const res = await fetch(`http://127.0.0.1:${this.debugPort}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(GLOBAL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Impossible d'ouvrir une page CDP (${res.status})`);
    const target = (await res.json()) as { webSocketDebuggerUrl: string; id: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Ouverture de page CDP expirée")),
          GLOBAL_TIMEOUT_MS
        );
        ws.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } catch (err) {
      try {
        ws.close();
      } catch {}
      await this.closeTarget(target.id); // l'onglet ne fuit pas
      throw err;
    }
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
        // Auto-bornée : newPage referme elle-même l'onglet si l'ouverture
        // dépasse le délai global (l'ancienne course laissait newPage finir
        // APRÈS l'expiration — onglet et WebSocket fuyants, invisibles du
        // finally ci-dessous).
        const opened = await this.newPage();
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

/** Profils de rendu « hermes-chrome-* » déposés par ce service dans le tmp. */
function listChromeProfiles(): string[] {
  try {
    const tmp = tmpdir();
    return readdirSync(tmp)
      .filter((d) => d.startsWith("hermes-chrome-"))
      .map((d) => join(tmp, d));
  } catch {
    return [];
  }
}

/** Sonde du binaire de rendu (Paramètres → Système, hello aux clients). */
export function chromeHeadlessStatus(): "present" | "absent" {
  for (const c of CHROME_CANDIDATES) {
    if (c && existsSync(c)) return "present";
  }
  return "absent";
}

/** Place occupée par les profils de rendu (affichée avant/nettoyage après). */
export function chromeProfileStats(): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const dir of listChromeProfiles()) {
    count += 1;
    try {
      const walk = (p: string) => {
        for (const ent of readdirSync(p, { withFileTypes: true })) {
          const full = join(p, ent.name);
          if (ent.isDirectory()) walk(full);
          else {
            try {
              bytes += statSync(full).size;
            } catch {
              /* fichier parti de sous l'appel */
          }
          }
        }
      };
      walk(dir);
    } catch {
      /* profil disparu de sous l'appel */
    }
  }
  return { count, bytes };
}

/** Nettoie les profils chrome orphelins de ce service (best effort). */
export function clearChromeProfiles(): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  for (const dir of listChromeProfiles()) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 0 });
      removed += 1;
    } catch {
      kept += 1; /* profil encore utilisé par un chrome vivant */
    }
  }
  return { removed, kept };
}

// Au chargement du module : purge des profils de l'incarnation précédente
// (hot-reload, redémarrage) — un chrome orphelin ne doit jamais verrouiller
// le profil du suivant.
clearChromeProfiles();

/** Singleton du service. */
export const chromeRenderer = new ChromeRenderer();
