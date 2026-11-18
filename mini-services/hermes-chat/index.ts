// Service de chat Hermes Web — socket.io sur le port 3003
// Événements client -> serveur :
//   hello, conversations:list/create/rename/delete/open/pin/fork/search/setMode,
//   chat:send, chat:stop, chat:regenerate (réglages expert F-22 : temperature/maxTokens/seed, assainis),
//   message:edit, message:delete,
//   models:list, attachments:upload, audio:transcribe,
//   artifacts:list, artifact:versions, artifact:retry,
//   artifact:restore/label/pin (F-26 — versionnage fichiers),
//   settings:get/set,
//   providers:list/catalog/add/remove/set-strategy/set-base/add-key/remove-key/test-key,
//   extensions:list/add/toggle/remove/pin/check/update,
//   registry:install (v2.6 — ajout unifié « nom ou adresse » : dépôt, MCP, fournisseur),
//   system-prompt:get/set/clear, system-prompts:list/create/update/delete,
//   custom-instructions:get/set,
//   memory:get/set-enabled/set-auto/set-notes,
//   share:get/create/revoke,
//   system:renderCache/clearRenderCache (v2.4 — profils de rendu Chrome)
//   system:update-request (drapeau au lanceur) / system:update-log (journal live)
//   webchat:status/open/close (fournisseur « Chats IA web » — pilotage navigateur)
// Événements serveur -> client :
//   stream:start, stream:delta, stream:reasoning, stream:status, stream:tool,
//   stream:done, stream:error, message:appended, message:deleted,
//   mode:flow (F-30 — déroulé du tour multi-voix, en direct),
//   conversations:mode (F-30 — mode changé, diffusé à toutes les sessions),
//   conversations:created, conversations:pinned,
//   artifact:created, artifact:delta, artifact:updated,
//   settings:changed, providers:changed, models:changed, extensions:changed,
//   system-prompt:changed, system-prompts:changed, custom-instructions:changed,
//   share:changed,
//   memory:changed,
//   system:update-log:changed (relais du journal du lanceur pendant la mise à jour)
// HTTP (port 3004) :
//   GET /uploads/<id>.<ext>            — pièces jointes multimédia
//   GET /artifacts/<id>/raw|download|thumb|pdf
//   GET /artifacts/zip?ids=a,b,c       — archive de plusieurs artefacts
//   GET /share/<token>/data.json       — snapshot public lecture seule (F-13)
//   GET /share/<token>/image.png       — capture Chrome du fil partagé (F-13)
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Server } from "socket.io";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCb);
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Store, type ArtifactRow, type ExtensionRow, type KeyRow, type ProviderRow } from "./store";
import { createTurnRunner } from "./turn-runner";
import { bindHandlerContext } from "./handlers/context";
import { registerConversationsHandlers } from "./handlers/conversations";
import { registerArtifactsSharesHandlers } from "./handlers/artifacts-shares";
import { registerProvidersExtensionsHandlers } from "./handlers/providers-extensions";
import { registerSettingsSystemHandlers } from "./handlers/settings-system";
import { HermesConnector } from "./hermes-connector";
import { createLlmPool } from "./llm-pool";
import {
  runWebSearch,
  webSearchSection,
  type WebSource,
} from "./web-search";
import {
  buildSnapshot,
  generateShareToken,
  isValidShareToken,
  parseSnapshot,
  rowToShareView,
  type SharedConversationData,
} from "./shares";
import { modelLabel, catalogModelsResult } from "./models";
import { transcribeAudioBase64 } from "./asr";
import {
  DEFAULT_MODEL_ID,
} from "./models";
import {
  MODE_LABELS,
  modeModel,
  normalizeModeConfig,
  resolveMode,
  resolveModePrompt,
  resolveVoiceChars,
  modePromptSection,
  voicesFor,
  voiceModel,
  type ConversationMode,
  type ModeConfig,
  type ModeVoice,
} from "./modes";
import {
  runOrchestratedTurn,
  type OrchestratorDeps,
  type OrchestratorPrompts,
} from "./orchestrator";
import {
  CUSTOM_INSTRUCTIONS_KEY,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_MEMORY_CHARS,
  MAX_PROMPT_CHARS,
  MEMORY_AUTO_KEY,
  MEMORY_ENABLED_KEY,
  MEMORY_NOTES_KEY,
  SEED_PRESETS,
  composeLocalSystemPrompt,
  rowToPreset,
  sanitizeExpertSettings,
  validatePromptText,
} from "./prompts";
import { LOCAL_BASE_PROMPT } from "./local-engine";
import {
  fetchRepoSnapshot,
  knownProviderCatalog,
  maskSecret,
  parseRepoInput,
  providerCapabilities,
  resolveKnownProvider,
  testProviderKey,
  toKeyView,
} from "./providers";
import type {
  Artifact,
  Attachment,
  ChatMessage,
  CompactInfo,
  ConversationPromptView,
  ExtensionView,
  ProviderView,
  ToolEvent,
  TurnSettings,
} from "./types";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  deleteAttachmentFiles,
  resolveUploadFile,
  saveAttachment,
} from "./uploads";
import {
  ARTIFACTS_DIR,
  ArtifactTracker,
  artifactPdfPath,
  artifactThumbPath,
  toWireArtifact,
} from "./artifacts";
import { chromeRenderer, chromeHeadlessStatus, chromeProfileStats, clearChromeProfiles } from "./render";
import {
  WEBCHAT_PROVIDER_LABEL,
  isWebchatModel,
  readWebchatConfig,
  readWebchatFile,
  runWebchatTurn,
  webchatModelLabel,
  webchatModelOptions,
  webchatStatus,
} from "./webchat/engine";
import { trace, traceDump, traceMeta } from "./trace";
import {
  ensureBrowser,
  isBrowserUp,
  killPilotBrowser,
  launchWatchdog,
  readPilotInfo,
  touchActivity,
} from "./webchat/browser";
import { findTab, listTargets, newTab } from "./webchat/cdp";
import { FICHES } from "./webchat/fiches";

/** Révision git du dépôt déployé (null si installation sans git — zip
 *  téléversé, bundle) : affichée telle quelle dans Paramètres → Système. */
function readAppRevision(): string | null {
  try {
    const gitDir = join(import.meta.dir, "..", "..", ".git");
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const direct = /^[0-9a-f]{40}$/i.test(head) ? head : null;
    if (direct) return direct.slice(0, 7);
    const m = head.match(/^ref:\s*(\S+)/);
    if (!m) return null;
    try {
      return readFileSync(join(gitDir, m[1]), "utf8").trim().slice(0, 7) || null;
    } catch {
      // Référence compactée (packed-refs) : sans équivalent ref lâche.
      try {
        const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
        const line = packed.split("\n").find((l) => l.endsWith(" " + m[1]));
        const sha = line?.split(" ")[0] ?? "";
        return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null;
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}
const APP_REVISION = readAppRevision();

// ── Vues « wire » fournisseurs & extensions (Paramètres v2.2) ──────────
// Les secrets ne partent jamais : seules les vues masquées circulent.

function providerWire(row: ProviderRow, keys: KeyRow[]): ProviderView {
  const caps = providerCapabilities(row.name, row.base_url);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ProviderView["kind"],
    strategy: row.strategy as ProviderView["strategy"],
    baseUrl: row.base_url,
    keyless: caps?.keyless ?? false,
    keys: keys.map(toKeyView),
  };
}

function providersWire(): ProviderView[] {
  return store.listProviderRows().map((p) => providerWire(p, store.listKeyRows(p.id)));
}

function extensionWire(r: ExtensionRow): ExtensionView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as ExtensionView["kind"],
    description: r.description,
    source: r.source,
    channel: r.channel,
    commit: r.commit,
    version: r.version,
    pinned: !!r.pinned,
    enabled: !!r.enabled,
    applied: !!r.applied,
    updateAvailable: r.update_available,
    lastCheckedAt: r.last_checked_at,
  };
}

function extensionsWire(): ExtensionView[] {
  return store.listExtensionRows().map(extensionWire);
}

function broadcastProviders(): void {
  // v2.3 : les listes vivantes dépendent du porte-clés — invalidation des
  // caches puis signal aux clients (le hook recharge models:list).
  // v2.4 : le hello est rediffusé aussi — la carte de statut de la sidebar
  // (« vos clés répondent ») suit le porte-clés en direct.
  connector.invalidateModels();
  io.emit("providers:changed", { providers: providersWire() });
  io.emit("models:changed", {});
  io.emit("hello", helloPayload());
}

function broadcastExtensions(): void {
  io.emit("extensions:changed", { extensions: extensionsWire() });
}

// ── Prompt système & instructions personnalisées (F-11 / F-19) ──────────

/** Vue wire du prompt d'une conversation (null si aucun). */
function conversationPromptWire(
  conversationId: string
): ConversationPromptView | null {
  const row = store.getConversationPrompt(conversationId);
  if (!row) return null;
  return {
    conversationId,
    content: row.content,
    presetTitle: row.title || null,
    updatedAt: row.updated_at,
  };
}

/** Diffuse l'état du prompt d'une conversation (F-11). */
function broadcastSystemPrompt(conversationId: string): void {
  io.emit("system-prompt:changed", {
    conversationId,
    prompt: conversationPromptWire(conversationId),
  });
}

/** Diffuse la bibliothèque de presets (F-11). */
function broadcastSystemPrompts(): void {
  io.emit("system-prompts:changed", {
    presets: store.listPromptPresets().map(rowToPreset),
  });
}

// Jeton de service (revue 2026-11-13) : quand HERMES_SERVICE_TOKEN est défini,
// toute connexion socket.io et toute route HTTP du 3004 (sauf les liens de
// partage publics /share/...) doit le présenter — sinon le mini-service,
// exposé via Caddy, est lisible/écrivable par n'importe quelle page visitée
// par l'utilisateur (DNS rebinding compris). Absent → mode dev inchangé.
const SERVICE_TOKEN = process.env.HERMES_SERVICE_TOKEN ?? null;

// Garde d'origine (Lot 1, audit L1-1) : sans jeton, le service ne doit pas
// être joignable depuis une page web tierce (DNS rebinding compris) — seules
// les origines boucle locale de la propre machine de l'utilisateur passent.
// Pas d'en-tête Origin (curl, scripts QA, chargement <img>, lien de partage
// ouvert en navigation) → laissé passer : les navigateurs n'envoient Origin
// que sur les requêtes fetch/XHR, jamais sur les navigations et images.
function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]"
  );
}

const PORT = Number(process.env.HERMES_CHAT_PORT ?? 3003);
const FILES_PORT = Number(process.env.HERMES_CHAT_FILES_PORT ?? 3004); // service HTTP dédié aux pièces jointes
// Écoute en boucle locale (complète le Lot 1, audit L1-1) : Caddy bind déjà
// 127.0.0.1 mais le service écoutait sur TOUTES les interfaces — le correctif
// « Caddy loopback seul » était incomplet, la pile restait joignable du réseau
// local. HERMES_CHAT_HOST existe pour un usage exposé explicite et assumé
// (définir alors AUSSI HERMES_SERVICE_TOKEN — les gardes d'origine seules ne
// suffisent pas hors boucle locale).
const HOST = process.env.HERMES_CHAT_HOST ?? "127.0.0.1";
const MAX_HISTORY = 30;

mkdirSync(ARTIFACTS_DIR, { recursive: true });

// ── Aides artefacts ──────────────────────────────────────────────────────

/** Ancre d'une clé : message de la première version encore existante. */
function artifactAnchor(conversationId: string, key: string, versions: ArtifactRow[]): string {
  const ids = new Set(store.getMessages(conversationId).map((m) => m.id));
  return (versions.find((v) => ids.has(v.message_id)) ?? versions[0]).message_id;
}

/** Payload wire complet (avec ancre et fichiers dérivés existants). */
function wireArtifact(conversationId: string, key: string, row: ArtifactRow): Artifact {
  const versions = store.listArtifactVersions(conversationId, key);
  return toWireArtifact(row, artifactAnchor(conversationId, key, versions));
}

/** Diffuse une mise à jour d'artefact à tous les clients. */
function broadcastArtifact(conversationId: string, row: ArtifactRow): void {
  io.emit("artifact:updated", {
    conversationId,
    artifact: wireArtifact(conversationId, row.key, row),
  });
}

/** Attache les cartes d'artefacts aux messages d'une conversation. */
function attachArtifactCards(conversationId: string, messages: ChatMessage[]): void {
  const rows = store.listConversationArtifacts(conversationId);
  if (rows.length === 0) return;
  // P-01 : ids des messages en UN chargement (l'ancien code rechargeait
  // TOUTE la conversation dans artifactAnchor à chaque clé d'artefact).
  const ids = new Set(store.getMessages(conversationId).map((m) => m.id));
  const byKey = new Map<string, ArtifactRow[]>();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key)!.push(r);
  }
  const anchors = new Map<string, string>();
  const cards = new Map<string, Artifact[]>();
  for (const [key, versions] of byKey) {
    const anchor = (versions.find((v) => ids.has(v.message_id)) ?? versions[0]).message_id;
    anchors.set(key, anchor);
    const card = toWireArtifact(versions[versions.length - 1], anchor);
    if (!cards.has(anchor)) cards.set(anchor, []);
    cards.get(anchor)!.push(card);
  }
  for (const m of messages) {
    const list = cards.get(m.id);
    if (list?.length) m.artifacts = list;
  }
}

/** Pipeline de rendu d'un artefact HTML (PNG plein page puis PDF vectoriel). */
async function renderHtmlArtifact(row: ArtifactRow): Promise<void> {
  const convId = row.conversation_id;
  try {
    store.updateArtifact(row.id, {
      status: "rendering",
      statusLabel: "Rendu de l'aperçu (Chrome)…",
      error: null,
    });
    broadcastArtifact(convId, store.getArtifactRow(row.id)!);
    const { png, pdf, renderMs } = await chromeRenderer.renderHtml(row.content);
    // 1. Vignette / aperçu PNG (remplace le squelette de la carte)
    writeFileSync(artifactThumbPath(row.id), png);
    broadcastArtifact(convId, store.getArtifactRow(row.id)!);
    // 2. Export PDF vectoriel
    store.updateArtifact(row.id, { statusLabel: "Export PDF…" });
    broadcastArtifact(convId, store.getArtifactRow(row.id)!);
    writeFileSync(artifactPdfPath(row.id), pdf);
    store.updateArtifact(row.id, { status: "ready", statusLabel: null });
    console.log(
      `[hermes-chat] artefact rendu : ${row.name} v${row.version} — ${renderMs} ms, PNG ${png.length} o, PDF ${pdf.length} o`
    );
    broadcastArtifact(convId, store.getArtifactRow(row.id)!);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Échec du rendu";
    console.warn(`[hermes-chat] rendu échoué (${row.name}) :`, message);
    store.updateArtifact(row.id, { status: "error", statusLabel: null, error: message });
    broadcastArtifact(convId, store.getArtifactRow(row.id)!);
  }
}

/** Supprime les fichiers dérivés d'une liste de lignes d'artefacts. */
function deleteArtifactFiles(rows: ArtifactRow[]): void {
  for (const r of rows) {
    for (const p of [artifactThumbPath(r.id), artifactPdfPath(r.id)]) {
      try {
        if (existsSync(p)) rmSync(p);
      } catch {
        /* déjà supprimé */
      }
    }
  }
}

/** F-26 : applique le quota du journal (purge FIFO) et nettoie les fichiers dérivés. */
function enforceVersionQuota(conversationId: string, keys: Iterable<string>): void {
  for (const key of keys) {
    deleteArtifactFiles(store.purgeArtifactVersions(conversationId, key));
  }
}

/** Autorisation HTTP : Authorization: Bearer <jeton> ou ?token=<jeton>. */
function httpAuthorized(req: IncomingMessage, u: URL): boolean {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const q = u.searchParams.get("token");
  const presented =
    (typeof bearer === "string" && bearer) || (typeof q === "string" && q) || "";
  return timingSafeEqualStr(presented, SERVICE_TOKEN!);
}

// ── Service HTTP : pièces jointes + artefacts (port 3004) ────────────────
const filesServer = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  if (
    SERVICE_TOKEN &&
    !isShareRoute &&
    !isPublicViewRoute &&
    !httpAuthorized(req, u)
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
    void handleDiagnostics(res);
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
    void handleArtifactZip(u, res);
    return;
  }

  // /artifacts/<id>/<action>
  const artMatch = /^\/artifacts\/([a-zA-Z0-9-]{8,64})\/(raw|view|download|thumb|pdf)$/.exec(
    u.pathname
  );
  if (artMatch) {
    handleArtifactFile(artMatch[1], artMatch[2], res);
    return;
  }

  // /share/<token>/(data.json|image.png) — lien public lecture seule (F-13)
  const shareMatch = /^\/share\/([A-Za-z0-9]{16,64})\/(data\.json|image\.png)$/.exec(u.pathname);
  if (shareMatch) {
    void handleShareFile(shareMatch[1], shareMatch[2], res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Introuvable");
});

/** GET /diagnostics — rapport JSON du pont de dépannage (F-31). */
async function handleDiagnostics(res: ServerResponse): Promise<void> {
  const config = readWebchatConfig(store);
  const pilot = readPilotInfo(config.profileDir);
  const up = await isBrowserUp(config.port);
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
      voiceChars: resolveVoiceChars(store),
    },
    webchat: {
      port: config.port,
      browserUp: up,
      pilot: pilot ? { pid: pilot.pid, startedAt: pilot.startedAt } : null,
      timeoutS: config.timeoutS,
      idleMin: config.idleMin,
      profileDir: config.profileDir,
      browserPath: config.browserPath || null,
    },
    // Tours LLM en vol (F-31ter) : lastByteAgeS grand = fournisseur muet,
    // petit = réponse lente mais vivante. Vide = aucun tour en cours.
    pool: { streams: pool.activeStreams() },
    trace: traceDump(150),
    traceMeta: traceMeta(),
  };
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

/** Sert la source / les fichiers dérivés d'un artefact. */
function handleArtifactFile(
  id: string,
  action: string,
  res: ServerResponse
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
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(row.content, "utf-8"),
        "Content-Security-Policy":
          "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
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
    const data = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": action === "thumb" ? "image/png" : "application/pdf",
      "Content-Length": data.byteLength,
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
      ...(action === "pdf"
        ? { "Content-Disposition": `attachment; filename*=UTF-8''${name.replace(/\.html?$/, "")}.pdf` }
        : {}),
    });
    res.end(data);
    return;
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Erreur de lecture de l'artefact");
  }
}

/** Archive zip de plusieurs artefacts (source + PDF le cas échéant). */
async function handleArtifactZip(u: URL, res: ServerResponse): Promise<void> {
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
        const pdfName = name.replace(/\.html?$/, "") + ".pdf";
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
    let ok = await compress("zip", ["-q", "-X", zipPath, ...fileNames]);
    if (!ok && process.platform === "win32") {
      try {
        rmSync(zipPath, { force: true });
      } catch {
        /* rien à effacer */
      }
      ok = await compress("tar", ["-a", "-c", "-f", zipPath, ...fileNames]);
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
function sharedConversationHtml(data: SharedConversationData): string {
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
  res: ServerResponse
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

const httpServer = createServer();

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: "/",
  // CORS (Lot 1, audit L1-1) : plus de « origin: * » — seules les origines
  // boucle locale obtiennent des en-têtes CORS (le client vit sur 127.0.0.1,
  // derrière Caddy ou en dev). Une page tierce reçoit une réponse sans
  // Access-Control-Allow-Origin : le navigateur la lui bloque.
  cors: {
    origin: (origin, cb) => {
      // Pas d'Origin : client non navigateur (curl, script QA) — autorisé,
      // les gardes io.use et 3004 ci-dessous tranchent pour les navigateurs.
      if (!origin) return cb(null, true);
      if (isLoopbackOrigin(origin)) return cb(null, origin);
      return cb(null, false);
    },
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  // Les pièces jointes montent en base64 (≈ +33 % de taille) : 25 Mo de marge
  maxHttpBufferSize: 25e6,
});

// Jeton de service : refus AVANT tout gestionnaire — une socket non
// authentifiée ne reçoit aucun événement applicatif. La comparaison est
// en temps constant (fuite d'information par chronométrage sinon).
// Canal : payload auth de la socket ou en-tête Authorization (audit passe
// 3, F-07 — la query d'URL reste réservée aux liens HTTP img/iframe du
// 3004, elle ne doit pas finir dans des journaux de passerelle côté WS).
function socketAuthorized(socket: { handshake: { auth?: unknown; headers?: Record<string, string | undefined> } }): boolean {
  if (!SERVICE_TOKEN) return true; // mode dev : pas de jeton configuré
  const bearer = socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, "");
  const auth = socket.handshake.auth as { token?: unknown } | null;
  const presented =
    (typeof auth?.token === "string" && auth.token) ||
    (typeof bearer === "string" && bearer) ||
    "";
  return timingSafeEqualStr(presented, SERVICE_TOKEN);
}

/** Comparaison en temps constant de deux chaînes (anti-chronométrage). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare quand même pour uniformiser le temps, puis rejette
    timingSafeEqualImpl(Buffer.from(a), Buffer.from(b));
    return false;
  }
  return timingSafeEqualImpl(Buffer.from(a), Buffer.from(b));
}
function timingSafeEqualImpl(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Garde d'origine (Lot 1, audit L1-1) : une page ouverte sur une origine
// non boucle locale ne connecte PAS de socket — avec ou sans jeton (le jeton
// protège les données, la garde d'origine empêche la connexion tierce
// elle-même, jeton absent comme présent).
io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin && !isLoopbackOrigin(origin)) {
    next(new Error("Origine non autorisée (boucle locale uniquement)"));
    return;
  }
  next();
});

io.use((socket, next) => {
  if (!socketAuthorized(socket as never)) {
    next(new Error("Jeton de service invalide ou manquant"));
    return;
  }
  next();
});

const store = new Store();
const connector = new HermesConnector();
// v2.3 : le moteur consomme le porte-clés du volet Paramètres — en moteur
// local, les tours partent sur l'API du fournisseur à clé active.
// v2.4 : référence conservée pour la carte de statut honnête (hello).
const pool = createLlmPool(store);
connector.attachPool(pool);

// Moteur de tour (découpage 2026-11, cf. FORK.md §10) : runAssistantTurn et
// ses registres vivent dans turn-runner.ts ; les helpers d'artefacts restent
// ici (partagés avec les handlers).
const {
  runAssistantTurn,
  isRunning,
  abortRunning,
  liveTurnsOf,
  validCompareIds,
  titleFrom,
  conversationModeState,
  comparePairFromMode,
  compactKey,
  readCompact,
  compactInfoWire,
  invalidateCompactIfNeeded,
} = createTurnRunner({
  store,
  connector,
  io,
  renderHtmlArtifact,
  enforceVersionQuota,
  attachArtifactCards,
});

// (fix fuite — il était posé dans io.on("connection"), donc un par socket,
// jamais annulé : N connexions = N intervalles et N diffusions dupliquées).
const majFlag = join(import.meta.dir, "..", "..", "desktop", "runtime", "maj-demandee.flag");
const majLog = join(import.meta.dir, "..", "..", "desktop", "runtime", "maj.log");
// Dernier contenu diffusé : on ne re-diffuse que sur changement réel.
let majLogSig = "";
const majLogRead = (): { exists: boolean; text: string; mtimeMs: number } => {
  try {
    const st = statSync(majLog);
    // Plafond 64 Ko : un journal ne doit jamais gonfler un message socket.
    const buf = readFileSync(majLog);
    const text = buf.length > 65_536 ? buf.subarray(buf.length - 65_536).toString("utf-8") : buf.toString("utf-8");
    return { exists: true, text, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, text: "", mtimeMs: 0 };
  }
};
// Relais en direct : le fichier est écrit par le lanceur, pas par nous —
// sondage léger (2 s), diffusion seulement si le contenu a vraiment changé.
setInterval(() => {
  const snap = majLogRead();
  if (!snap.exists) return;
  const sig = `${snap.mtimeMs}:${snap.text.length}`;
  if (sig === majLogSig) return;
  majLogSig = sig;
  io.emit("system:update-log:changed", snap);
}, 2000);

// Branchement des handlers (découpage 2026-11, FORK.md §10) : chaque domaine
// pose ses socket.on(...) ; le contexte partagé (handlers/context.ts) est
// câblé juste avant. disconnect/error (cycle de vie) restent ici.

// Contexte partagé des handlers (découpage 2026-11) : une seule pose, avant
// toute connexion client — majLogSig passe par accesseur (mutable côté service).
bindHandlerContext({
  store,
  io,
  connector,
  majFlag,
  majLog,
  majLogRead,
  majLogSig: () => majLogSig,
  setMajLogSig: (v) => {
    majLogSig = v;
  },
  turnRunner: {
    runAssistantTurn,
    isRunning,
    abortRunning,
    liveTurnsOf,
    validCompareIds,
    titleFrom,
    conversationModeState,
    comparePairFromMode,
    compactKey,
    readCompact,
    compactInfoWire,
    invalidateCompactIfNeeded,
  },
  artifacts: {
    wireArtifact,
    broadcastArtifact,
    attachArtifactCards,
    renderHtmlArtifact,
    deleteArtifactFiles,
    enforceVersionQuota,
  },
  views: {
    helloPayload,
    providersWire,
    extensionsWire,
    providerWire,
    extensionWire,
    broadcastProviders,
    broadcastExtensions,
    conversationPromptWire,
    broadcastSystemPrompt,
    broadcastSystemPrompts,
  },
});


// ── Gateway Hermes : URL/jeton persistés (Paramètres → Système) ──────────
// L'URL saisie dans l'interface prime sur HERMES_GATEWAY_URL, qui prime sur
// le défaut automatique (ws://127.0.0.1:9120/api/ws) : lancer l'agent Hermes
// suffit, rien à saisir. Un réglage VIDE = retour au défaut automatique.
const GATEWAY_URL_KEY = "hermes.gateway.url";
const GATEWAY_TOKEN_KEY = "hermes.gateway.token";
{
  const savedUrl = store.getSetting(GATEWAY_URL_KEY);
  // F-02.3 : un jeton saisi pour le DÉFAUT AUTOMATIQUE (URL vide) n'était
  // relu qu'avec une URL surchargée — il était oublié à chaque redémarrage.
  // On relit le jeton dans tous les cas (URL surchargée ou pas).
  const savedToken = store.getSetting(GATEWAY_TOKEN_KEY);
  if (savedUrl !== null && savedUrl.trim()) {
    connector.gatewayUrl = savedUrl.trim();
  }
  if (savedToken !== null && savedToken.trim()) {
    connector.gatewayToken = savedToken.trim();
  }
}

// Presets de départ semés une seule fois si la bibliothèque est vide (F-11).
store.seedPromptPresetsIfNeeded(SEED_PRESETS);

// Audit passe 3, F-10 : les lignes de partage révoquées de plus de 90 jours
// ne s'accumulent plus (titre et métadonnées compris).
{
  const purgedShares = store.purgeAgedRevokedShares();
  if (purgedShares > 0)
    console.log(`[hermes-chat] ${purgedShares} partage(s) révoqué(s) ancien(s) purgé(s)`);
}

// Tours en cours : clé -> AbortController. Clé = conversationId pour un
// tour simple, `${conversationId}:a` / `:b` pour les deux côtés d'une
// comparaison (F-17) — deux tours concurrents, un par modèle.

/** Taille réelle des instructions système (jauge honnête) : base + mémoire +
 * F-19 + prompt de la conversation donnée (le hello envoie la base + F-19). */
function systemPromptSize(conversationId?: string): number {
  const base = LOCAL_BASE_PROMPT.length;
  const memory = (store.getSettingBool(MEMORY_ENABLED_KEY, true)
    ? store.getSetting(MEMORY_NOTES_KEY) ?? ""
    : ""
  ).trim().length;
  const custom = (store.getSetting(CUSTOM_INSTRUCTIONS_KEY) ?? "").trim().length;
  const conv = conversationId
    ? (store.getConversationPrompt(conversationId)?.content ?? "").trim().length
    : 0;
  return base + memory + custom + conv;
}

function helloPayload() {
  // Fournisseurs LLM réellement actionnables (clé active ou keyless) : sans
  // eux, l'interface affiche un état honnête « agent non détecté » — jamais
  // de moteur simulé ; avec eux, elle indique « vos clés répondent ».
  const engineProviders = pool.activeProviderNames();
  // F-02 : l'URL RÉGLÉE dans l'interface, pas le défaut automatique — sinon
  // le champ de Paramètres restait pré-rempli avec ws://127.0.0.1:9120/api/ws
  // et le bouton « Débrancher » s'affichait même sans gateway configurée
  // (il semblait débrancher quelque chose qui n'était pas branché).
  const configuredGatewayUrl = store.getSetting(GATEWAY_URL_KEY)?.trim() || null;
  return {
    app: "hermes-web",
    version: "1.2.0",
    mode: connector.mode,
    model: connector.model,
    gatewayUrl: configuredGatewayUrl ?? connector.gatewayUrl,
    gatewayConfigured: configuredGatewayUrl !== null,
    gatewayTokenSet: Boolean(connector.gatewayToken),
    engineProviders,
    // Taille réelle des instructions système du moteur local (base + F-18 + F-19) ;
    // la gateway garde les siennes (le client retombe sur son estimation).
    systemPromptChars: connector.mode === "local" ? systemPromptSize() : null,
    // v2.4 (Paramètres → Système) : révision du dépôt et binaire de rendu,
    // sondes réelles — jamais simulées.
    appRevision: APP_REVISION,
    chromeHeadless: chromeHeadlessStatus(),
    // Mémoire active (F-18) : le client affiche un état honnête.
    memoryChars: store.getSettingBool(MEMORY_ENABLED_KEY, true)
      ? (store.getSetting(MEMORY_NOTES_KEY) ?? "").trim().length
      : 0,
  };
}

// ── Mise à jour depuis l'interface : journal live du lanceur ────────────
// Dépose un drapeau que le lanceur (desktop/hermes-ui.ps1 | .sh — boucle
// de surveillance) ramasse. Le relais du journal (system:update-log:changed)
// vit AU NIVEAU DU SERVICE : un seul intervalle pour toutes les connexions
io.on("connection", (socket) => {
  console.log(`[hermes-chat] client connecté : ${socket.id}`);
  trace("socket", `client connecté (${socket.id})`);

  registerConversationsHandlers(socket);
  registerArtifactsSharesHandlers(socket);
  registerProvidersExtensionsHandlers(socket);
  registerSettingsSystemHandlers(socket);

  socket.on("disconnect", () => {
    console.log(`[hermes-chat] client déconnecté : ${socket.id}`);
    trace("socket", "client déconnecté — un tour en vol côté client restera sans réponse jusqu'au prochain essai");
  });

  socket.on("error", (error) => {
    console.error(`[hermes-chat] erreur socket (${socket.id}) :`, error);
  });
});

connector
  .init()
  .then(async () => {
    // Checkpoint WAL périodique (dette revue 2026-11-13) : le -wal ne croît
    // plus sans borne ; checkpoint TRUNCATE en zone calme + arrêt propre.
    store.startWalCheckpoint();
    // Pré-charge la liste des modèles (gateway ou catalogue)
    try {
      const result = await connector.listModels();
      console.log(
        `[hermes-chat] modèles disponibles (${result.source}) : ${result.models
          .map((m) => m.label)
          .join(", ")}`
      );
    } catch {
      /* liste chargée à la demande par le client */
    }
    httpServer.listen(PORT, HOST, () => {
      console.log(`[hermes-chat] service démarré sur ${HOST}:${PORT} — mode : ${connector.mode}`);
      trace("boot", `service écoutant sur ${HOST}:${PORT} — mode ${connector.mode}`);
      filesServer.listen(FILES_PORT, HOST, () => {
        console.log(`[hermes-chat] service des pièces jointes démarré sur le port ${FILES_PORT}`);
        trace("boot", `HTTP fichiers + diagnostics écoutant sur ${HOST}:${FILES_PORT}`);
      });
      if (connector.mode === "local") {
        console.log(
          `[hermes-chat] agent Hermes non detecte (defaut ${connector.gatewayUrl}) — lancer l'agent, ou ajouter une cle fournisseur`
        );
      }
      // Audit passe 3, F-04 ; durci Lot 1 (L1-1) : sans jeton, les gardes
      // d'origine limitent l'accès aux origines boucle locale — le jeton du
      // lanceur reste la protection complète (données lues par une page).
      if (!SERVICE_TOKEN) {
        console.warn(
          `[hermes-chat] ⚠ HERMES_SERVICE_TOKEN non défini : accès limité aux origines boucle locale (garde Origin). Le lanceur génère ce jeton ; le définir pour tout usage exposé.`
        );
      }
    });
  })
  .catch((err) => {
    console.error("[hermes-chat] échec d'initialisation du connecteur :", err);
    httpServer.listen(PORT, HOST, () => {
      console.log(`[hermes-chat] service démarré sur ${HOST}:${PORT} — mode : ${connector.mode}`);
      trace("boot", `service écoutant sur ${HOST}:${PORT} — mode ${connector.mode}`);
      filesServer.listen(FILES_PORT, HOST, () => {
        console.log(`[hermes-chat] service des pièces jointes démarré sur le port ${FILES_PORT}`);
        trace("boot", `HTTP fichiers + diagnostics écoutant sur ${HOST}:${FILES_PORT}`);
      });
    });
  });

// Arrêt propre (audit passe 3, F-09) : on cesse D'ABORD d'accepter (ports
// fermés, sockets clientes déconnectées), on laisse un battement aux
// gestionnaires en vol, PUIS la base — l'inverse exposait des écritures sur
// une SQLite déjà fermée. Le timer du checkpoint est RÉFÉRENCÉ : une boucle
// d'événements vidée par les fermetures ne doit pas faire sortir Node
// AVANT le checkpoint final (sinon le -wal survit à l'arrêt).
function shutdown(signal: string): void {
  console.log(`[hermes-chat] arrêt (${signal})…`);
  chromeRenderer.shutdown();
  filesServer.close();
  httpServer.close();
  io.close(); // déconnecte les sockets clientes (plus aucun événement entrant)
  const exitTimer = setTimeout(() => {
    console.error("[hermes-chat] fermeture forcée après délai");
    process.exit(0);
  }, 5000);
  exitTimer.unref?.();
  setTimeout(() => {
    try {
      store.close(); // checkpoint WAL final + fermeture SQLite propre
      console.log("[hermes-chat] base fermée (checkpoint WAL)");
    } catch (err) {
      console.error("[hermes-chat] erreur à la fermeture de la base :", err);
    }
    clearTimeout(exitTimer);
    process.exit(0);
  }, 300);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
