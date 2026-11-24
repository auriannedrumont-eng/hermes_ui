// Service HTTP : pièces jointes + artefacts (port 3004) — extrait d'index.ts
// (découpage 2026-11, cf. FORK.md). Sert :
//   GET /uploads/<id>.<ext>            — pièces jointes multimédia
//   GET /artifacts/<id>/raw|view|download|thumb|pdf
//   GET /artifacts/zip?ids=a,b,c       — archive de plusieurs artefacts
//   GET /share/<token>/data.json|image.png — lien public lecture seule (F-13)
//   GET /diagnostics                   — pont de dépannage (F-31)
// Les dépendances (store, rendu Chrome, statut webchat, pool) sont passées
// en paramètre : ce module ne connaît rien au cycle de vie du service.
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createReadStream, readFileSync, writeFileSync, rmSync, existsSync, statSync, mkdirSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCb);
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, basename, dirname, sep } from "node:path";
import type { Store } from "./store";
import { resolveUploadFile } from "./uploads";
import { artifactPdfPath, artifactThumbPath } from "./artifacts";
import { chromeRenderer } from "./render";
import {
  isLoopbackOrigin,
  httpAuthorized,
  SERVICE_TOKEN,
} from "./auth";
import { parseSnapshot, isValidShareToken, type SharedConversationData } from "./shares";
import { readWebchatConfig } from "./webchat/engine";
import { readPilotInfo, isBrowserUp, browserCandidates } from "./webchat/browser";
import { readSanteManifeste } from "./sante";
import { resolveVoiceChars } from "./modes";
import { traceDump, traceMeta } from "./trace";

export interface HttpDeps {
  store: Store;
  /** Diagnostic : tours LLM en vol (F-31ter) — snapshots vivants du pool. */
  activeStreams: () => unknown[];
  /** Diagnostic : longueur visée des interventions du débat (F-58). */
  resolveVoiceChars: () => number;
}

export const PORT = Number(process.env.HERMES_CHAT_PORT ?? 3003);
export const FILES_PORT = Number(process.env.HERMES_CHAT_FILES_PORT ?? 3004); // service HTTP dédié aux pièces jointes

/** Crée le serveur HTTP du 3004 (fichiers, artefacts, partages, diagnostics). */
export function createFilesServer(deps: HttpDeps) {
  const { store } = deps;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" || !req.url) {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Méthode non autorisée");
      return;
    }
    // Garde d'origine (Lot 1, audit L1-1) : une page web tierce ne doit pas
    // pouvoir lire les fichiers locaux via fetch (avec ou sans jeton). Les
    // navigations légitimes (<img>, <a download>, lien de partage ouvert dans
    // un onglet) et les clients non navigateurs n'envoient pas d'Origin :
    // ils restent permises.
    const reqOrigin = req.headers.origin;
    if (reqOrigin && !isLoopbackOrigin(reqOrigin)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Origine non autorisée");
      return;
    }
    const u = new URL(req.url, "http://localhost");

    // Jeton de service (revue 2026-11-13) : les routes HTTP du 3004 servent
    // les pièces jointes et artefacts de l'utilisateur — protégées par le même
    // jeton que la socket, via Authorization: Bearer ou ?token=. EXCEPTIONS :
    //   - /share/<token>/(data.json|image.png) reste public (le destinataire
    //     du lien n'a pas de session — F-13) ;
    //   - /artifacts/<id>/view : public (S-01) — le HTML généré par le LLM
    //     s'exécute sandboxé AVEC scripts : un jeton dans l'URL serait lisible
    //     par window.location.search et exfiltrable. Le jeton reste exigé sur
    //     /raw, /download, /thumb et /pdf.
    const isShareRoute = u.pathname.startsWith("/share/");
    const isPublicViewRoute = /^\/artifacts\/[a-zA-Z0-9-]{8,64}\/view$/.test(u.pathname);
    // Revue 95 : une page tierce peut embarquer <iframe src=".../artifacts/<id>/view">
    // ou /artifacts/<id>/thumb sans en-tête Origin (les navigations embarquées
    // n'en envoient pas) — la garde d'origine ci-dessus laissait passer. Le
    // contexte de requête navigateur dit la vérité : sec-fetch-site:cross-site
    // = initié par un site distant, refusé SAUF /share/ (le destinataire d'un
    // lien de partage peut venir de n'importe où). Les clients non navigateurs
    // (curl, <img> du même site) n'envoient pas sec-fetch-site : inchangés.
    const fetchSite = req.headers["sec-fetch-site"];
    const crossSite = fetchSite === "cross-site";
    if (
      SERVICE_TOKEN &&
      !isShareRoute &&
      (crossSite ||
        (!isPublicViewRoute && !httpAuthorized(req, u)))
    ) {
      res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
      res.end("Jeton de service requis");
      return;
    }

    // GET /diagnostics — pont de dépannage (F-31) : état du service, navigateur
    // de pilotage webchat, journal tournant des derniers événements. Même jeton
    // que le reste du 3004 (Authorization: Bearer ou ?token=). Ne contient JAMAIS
    // de message, d'identifiant ni de clé — que des compteurs, des durées et des
    // motifs d'échec : le rapport peut circuler (collé dans une conversation d'agent).
    if (u.pathname === "/diagnostics") {
      void handleDiagnostics(res, deps);
      return;
    }

    // GET /disk/list?path=… — liaison « dossier du disque » (F-59 J5) :
    // liste les répertoires pour le dialogue 📁↓. Jeton requis (garde
    // générale ci-dessus), chemin BORNÉ AU HOME, noms seuls — jamais de
    // lecture du contenu du disque (plan D4, sémantique minimale).
    if (u.pathname === "/disk/list") {
      handleDiskList(u, res);
      return;
    }

    // /uploads/<id>.<ext> — pièces jointes multimédia
    const served = resolveUploadFile(u.pathname);
    if (served) {
      // P-01 : lecture STREAMÉE (createReadStream + pipe) — l'ancien
      // readFileSync chargeait tout en mémoire et FIGEAIT la boucle
      // d'événements pendant le transfert de fichiers de plusieurs Mo.
      try {
        const stat = statSync(served.filePath);
        const name = u.searchParams.get("name");
        res.writeHead(200, {
          "Content-Type": served.mime,
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=31536000, immutable",
          ...(name
            ? { "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}` }
            : {}),
          "X-Content-Type-Options": "nosniff",
        });
        createReadStream(served.filePath).pipe(res);
        return;
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Erreur de lecture du fichier");
        return;
      }
    }

    // /artifacts/zip?ids=a,b,c — archive « tout télécharger »
    if (u.pathname === "/artifacts/zip") {
      void handleArtifactZip(u, res, store);
      return;
    }

    // /artifacts/<id>/<action>
    const artMatch = /^\/artifacts\/([a-zA-Z0-9-]{8,64})\/(raw|view|download|thumb|pdf)$/.exec(
      u.pathname
    );
    if (artMatch) {
      handleArtifactFile(artMatch[1], artMatch[2], res, store);
      return;
    }

    // /share/<token>/(data.json|image.png) — lien public lecture seule (F-13)
    const shareMatch = /^\/share\/([A-Za-z0-9]{16,64})\/(data\.json|image\.png)$/.exec(u.pathname);
    if (shareMatch) {
      void handleShareFile(shareMatch[1], shareMatch[2], res, store);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Introuvable");
  });
}

/** GET /diagnostics — rapport JSON du pont de dépannage (F-31). */
async function handleDiagnostics(res: ServerResponse, deps: HttpDeps): Promise<void> {
  const { store } = deps;
  const config = readWebchatConfig(store);
  const pilot = readPilotInfo(config.profileDir);
  const up = await isBrowserUp(config.port);
  // Loi « le diagnostic dit le présent » (2026-11-22) : le registre
  // `hermes-pilot-browser.json` est le souvenir du DERNIER lancement, pas
  // l'état courant — le 2026-11-22, un pid du 16/11 y faisait croire à un
  // pilote vivant alors que le navigateur (conçu pour dormir après
  // idleMin minutes) était couché et se serait réveillé tout seul au
  // prochain tour. `pilot` n'est décrit que si le navigateur répond
  // RÉELLEMENT ; sinon le registre part en `lastLaunch` et le binaire
  // réellement disponible est montré (`browserFound`) — le rapport dit
  // « couché, se réveillera au prochain tour », jamais « peut-être cassé ».
  const browserFound =
    browserCandidates(config.browserPath || undefined).find((p) => p && existsSync(p)) ?? "";
  const body = {
    service: {
      name: "hermes-chat",
      commit: traceMeta().commit,
      bootAt: traceMeta().bootAt,
      uptimeS: traceMeta().uptimeS,
      port: PORT,
      filesPort: FILES_PORT,
      authenticated: Boolean(SERVICE_TOKEN),
      // Débat : longueur visée des interventions (F-58) — visible dans le
      // rapport sans rien déduire du code.
      voiceChars: deps.resolveVoiceChars(),
    },
    webchat: {
      port: config.port,
      browserUp: up,
      pilot: up && pilot ? { pid: pilot.pid, startedAt: pilot.startedAt } : null,
      lastLaunch: !up && pilot ? { pid: pilot.pid, startedAt: pilot.startedAt } : null,
      browserFound: browserFound || null,
      timeoutS: config.timeoutS,
      idleMin: config.idleMin,
      profileDir: config.profileDir,
      browserPath: config.browserPath || null,
    },
    // Tours LLM en vol (F-31ter) : lastByteAgeS grand = fournisseur muet,
    // petit = réponse lente mais vivante. Vide = aucun tour en cours.
    pool: { streams: deps.activeStreams() },
    // Manifeste du dernier démarrage (refonte (68)) : ce que le lanceur a
    // vérifié et ce qu'il en conclut — la même vérité que la fenêtre.
    manifeste: readSanteManifeste(),
    trace: traceDump(150),
    traceMeta: traceMeta(),
  };
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

/** GET /disk/list?path=… — répertoires listables pour la liaison disque
 *  (F-59 J5). Le chemin demandé (HOME par défaut) est résolu (realpath :
 *  suit les liens symboliques AVANT la vérification) puis STRICTEMENT borné
 *  au HOME — jamais de chemin arbitraire, jamais de contenu (noms seuls).
 *  Réponse : { path, parent, home, dirs: [{ name, path }] }. */
function handleDiskList(u: URL, res: ServerResponse): void {
  const jsonError = (code: number, error: string) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error }));
  };
  const raw = u.searchParams.get("path")?.trim() || homedir();
  let target: string;
  let home: string;
  try {
    home = realpathSync(homedir());
    target = realpathSync(raw);
  } catch {
    jsonError(400, "Chemin introuvable");
    return;
  }
  if (target !== home && !target.startsWith(home + sep)) {
    jsonError(403, "Hors du dossier utilisateur");
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    jsonError(400, "Dossier illisible");
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .slice(0, 200)
    .map((e) => ({ name: e.name, path: join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      path: target,
      parent: target === home ? null : dirname(target),
      home,
      dirs,
    })
  );
}

/** Sert la source / les fichiers dérivés d'un artefact. */
function handleArtifactFile(
  id: string,
  action: string,
  res: ServerResponse,
  store: Store
): void {
  const row = store.getArtifactRow(id);
  if (!row) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Artefact introuvable");
    return;
  }
  try {
    const name = encodeURIComponent(row.name);
    if (action === "view" && row.kind === "html") {
      // Vue « nouvel onglet » du HTML : servi rendu (text/html) derrière un
      // bac à sable CSP — origine opaque, ni cookies ni stockage ni jetons de
      // l'application accessibles. /raw reste texte brut (img, fetch panel).
      // S-01 : cette page est publique (route exemptée de jeton) — le HTML
      // généré par le LLM s'exécute AVEC scripts : un jeton dans l'URL serait
      // lisible par window.location.search et exfiltrable. On boucle en plus
      // toutes les sorties réseau explicites (default-src/connect-src
      // 'none') et on coupe le Referer : un script qui tenterait d'exfiltrer
      // quoi que ce soit (jeton, contenu) vers l'extérieur est bloqué par la
      // CSP même s'il arrive à lire la barre d'adresse.
      // S-03 : plus de allow-forms / allow-popups — sans form-action 'none'
      // ni restriction de navigation, une soumission de formulaire ou un
      // window.open() permettait d'exfiltrer vers une origine tierce.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(row.content, "utf-8"),
        "Content-Security-Policy":
          "sandbox allow-scripts allow-modals; default-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(row.content, "utf-8");
      return;
    }
    if (action === "raw" || action === "view") {
      // Le HTML n'est servi rendu QUE par la branche ci-dessus (bac à sable
      // CSP, origine opaque) — ici texte brut (XSS), sauf SVG (nécessaire
      // pour <img>) derrière un CSP qui neutralise les scripts.
      const isSvg = row.kind === "svg";
      const headers: Record<string, string | number> = {
        "Content-Type": isSvg ? "image/svg+xml" : "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(row.content, "utf-8"),
        "X-Content-Type-Options": "nosniff",
      };
      if (isSvg) headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'";
      res.writeHead(200, headers);
      res.end(row.content, "utf-8");
      return;
    }
    if (action === "download") {
      res.writeHead(200, {
        "Content-Type": row.mime === "text/html" ? "text/plain; charset=utf-8" : row.mime,
        "Content-Disposition": `attachment; filename*=UTF-8''${name}`,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(row.content, "utf-8");
      return;
    }
    const filePath = action === "thumb" ? artifactThumbPath(id) : artifactPdfPath(id);
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Fichier non encore généré");
      return;
    }
    // P-01 : lecture STREAMÉE (statSync + createReadStream + pipe), comme
    // /uploads/ — l'ancien readFileSync chargeait le PNG/PDF entier en
    // mémoire et gelait la boucle d'événements sur les gros rendus.
    const stat = statSync(filePath);
    res.writeHead(200, {
      "Content-Type": action === "thumb" ? "image/png" : "application/pdf",
      "Content-Length": stat.size,
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
      ...(action === "pdf"
        ? { "Content-Disposition": `attachment; filename*=UTF-8''${name.replace(/\.html?$/, "")}.pdf` }
        : {}),
    });
    createReadStream(filePath).pipe(res);
    return;
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Erreur de lecture de l'artefact");
  }
}

/** Archive zip de plusieurs artefacts (source + PDF le cas échéant). */
async function handleArtifactZip(u: URL, res: ServerResponse, store: Store): Promise<void> {
  const ids = (u.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);
  if (ids.length === 0) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Aucun identifiant d'artefact");
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), "hermes-zip-"));
  try {
    const used = new Set<string>();
    const fileNames: string[] = [];
    for (const id of ids) {
      const row = store.getArtifactRow(id);
      if (!row) continue;
      const safe = basename(row.name).replace(/[^\w.\-() ]+/g, "_") || "artefact";
      let name = safe;
      let n = 2;
      while (used.has(name.toLowerCase())) {
        const dot = safe.lastIndexOf(".");
        name = dot > 0 ? `${safe.slice(0, dot)}-${n}${safe.slice(dot)}` : `${safe}-${n}`;
        n++;
      }
      used.add(name.toLowerCase());
      writeFileSync(join(tmp, name), row.content, "utf-8");
      fileNames.push(name);
      const pdfPath = artifactPdfPath(row.id);
      if (row.kind === "html" && existsSync(pdfPath)) {
        // Dédoublonné via le MÊME ensemble `used` (revue 95) : un artefact
        // « rapport.html » + « rapport.pdf » venus de deux ids differents
        // ecrasaient silencieusement le premier PDF dans l'archive.
        let pdfName = name.replace(/\.html?$/, "") + ".pdf";
        let pn = 2;
        while (used.has(pdfName.toLowerCase())) {
          pdfName = `${name.replace(/\.html?$/, "")}-${pn}.pdf`;
          pn++;
        }
        used.add(pdfName.toLowerCase());
        writeFileSync(join(tmp, pdfName), readFileSync(pdfPath));
        fileNames.push(pdfName);
      }
    }
    if (fileNames.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Aucun artefact valide");
      return;
    }
    const zipPath = join(tmp, "artefacts.zip");
    // zip.exe n'existe pas en standard sous Windows : en cas d'échec
    // (binaire absent ou code non nul), repli sur bsdtar — tar.exe est
    // intégré à Windows 10+ et son option -a déduit le format zip de
    // l'extension .zip. Sous Linux/macOS, le zip du système suffit.
    // Lot 2 (audit L2-9) : spawnSync gelait l'event loop du service pendant
    // la compression — execFile async à la place.
    const compress = async (bin: string, args: string[]) => {
      try {
        await execFile(bin, args, { cwd: tmp });
        return true;
      } catch {
        return false;
      }
    };
    let ok = await compress("zip", ["-q", "-X", zipPath, "--", ...fileNames]);
    if (!ok && process.platform === "win32") {
      try {
        rmSync(zipPath, { force: true });
      } catch {
        /* rien à effacer */
      }
      ok = await compress("tar", ["-a", "-c", "-f", zipPath, "--", ...fileNames]);
    }
    if (!ok || !existsSync(zipPath)) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Échec de la création de l'archive");
      return;
    }
    const data = readFileSync(zipPath);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": data.byteLength,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
        u.searchParams.get("name") ?? "artefacts-hermes.zip"
      )}`,
    });
    res.end(data);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Erreur pendant la création de l'archive");
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* nettoyage best effort */
    }
  }
}

// ── Partage public lecture seule (F-13) — HTTP du port 3004 ─────────────
// data.json : snapshot figé (jamais d'id interne) ; image.png : capture
// Chrome plein page du fil, via le même pipeline que les artefacts HTML
// (badge de confiance « Rendu Chrome »). 410 Gone pour un lien révoqué.

function shareEscapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Document autonome du fil partagé (base du rendu Chrome et de la page). */
export function sharedConversationHtml(data: SharedConversationData): string {
  const msgs = data.messages
    .map((m) => {
      const who = m.role === "user" ? "Vous" : "Hermes";
      const atts = m.attachments?.length
        ? `<div class="atts">${m.attachments
            .map((a) => shareEscapeHtml(`${a.name} (${a.kind})`))
            .join(" · ")}</div>`
        : "";
      return `<div class="msg ${m.role}">
  <div class="who">${shareEscapeHtml(who)}${m.model ? ` · ${shareEscapeHtml(m.model)}` : ""}</div>
  <div class="body">${shareEscapeHtml(m.content)}</div>${atts}
</div>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${shareEscapeHtml(data.title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: Georgia, 'Times New Roman', serif; margin: 0; background: #faf9f7; color: #1a1a1a; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 64px; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  .meta { color: #8a8378; font-size: 12.5px; margin-bottom: 36px; font-family: system-ui, sans-serif; }
  .meta b { color: #b3592a; }
  .msg { margin: 0 0 28px; }
  .who { font-family: system-ui, sans-serif; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 6px; color: #8a8378; }
  .msg.user .who { color: #b3592a; }
  .body { white-space: pre-wrap; line-height: 1.6; font-size: 15px; }
  .msg.assistant .body { background: #fff; border: 1px solid #eee7dd; border-radius: 14px; padding: 14px 18px; }
  .atts { margin-top: 6px; font-size: 12px; color: #8a8378; font-family: system-ui, sans-serif; }
  footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid #eee7dd; color: #b6ada0; font-size: 11.5px; font-family: system-ui, sans-serif; }
</style></head><body><div class="wrap">
<h1>${shareEscapeHtml(data.title)}</h1>
<p class="meta">Conversation partagée depuis <b>Hermes Web</b> · ${data.messageCount} message(s) · le ${new Date(data.sharedAt).toLocaleString("fr-FR")}</p>
${msgs}
<footer>Lecture seule — partagé via Hermes Web (interface de chat pour l'agent Hermes).</footer>
</div></body></html>`;
}

async function handleShareFile(
  token: string,
  action: string,
  res: ServerResponse,
  store: Store
): Promise<void> {
  if (!isValidShareToken(token)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Lien invalide");
    return;
  }
  const row = store.getShareByToken(token);
  if (!row) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Lien introuvable");
    return;
  }
  if (row.revoked_at) {
    res.writeHead(410, { "Content-Type": "text/plain" });
    res.end("Ce lien de partage a été révoqué");
    return;
  }
  const data = parseSnapshot(row);
  if (!data) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Partage illisible");
    return;
  }
  try {
    if (action === "data.json") {
      const body = JSON.stringify(data);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body, "utf-8"),
        // Public : le destinataire n'a pas de session — pas de nosniff strict
        // sur le JSON (la page publique le fetch), mais jamais de HTML servi.
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body, "utf-8");
      return;
    }
    // image.png — capture Chrome plein page du document autonome
    const { png } = await chromeRenderer.renderHtml(sharedConversationHtml(data));
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": png.byteLength,
      "Cache-Control": "public, max-age=86400",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(
        `hermes-${row.title.slice(0, 40).replace(/[^\w -]+/g, "") || "conversation"}.png`
      )}`,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(png);
  } catch (err) {
    console.warn(
      "[hermes-chat] rendu du partage impossible :",
      err instanceof Error ? err.message : err
    );
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Rendu indisponible (chrome-headless-shell introuvable ?)");
  }
}
