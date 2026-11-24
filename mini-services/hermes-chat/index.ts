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
// (Le serveur HTTP du 3004 et les gardes d'authentification vivent dans
// http-server.ts et auth.ts depuis le découpage §60 — câblés plus bas.)
import { createServer } from "http";
import { Server } from "socket.io";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Store, type ArtifactRow, type ExtensionRow, type KeyRow, type ProviderRow } from "./store";
import { createTurnRunner } from "./turn-runner";
import { bindHandlerContext } from "./handlers/context";
import { registerConversationsHandlers } from "./handlers/conversations";
import { registerArtifactsSharesHandlers } from "./handlers/artifacts-shares";
import { registerProvidersExtensionsHandlers } from "./handlers/providers-extensions";
import { registerSettingsSystemHandlers, startUpdateWatchdog, currentUpdateState } from "./handlers/settings-system";
import { registerAgentMotorHandlers } from "./handlers/agent-motor";
import { startAgentMotorWatchdog } from "./agent-motor";
import { probeMotorSessionsOnce } from "./motor-sessions";
import { toHttpBase } from "./hermes-connector";
import { registerStorageHandlers } from "./handlers/storage";
import { startDrainWatchdog } from "./handlers/drain";
import { startAgentGatewayIfDown } from "./agent-starter";
import { readSanteManifeste } from "./sante";
import { HermesConnector } from "./hermes-connector";
import { createLlmPool } from "./llm-pool";
import {
  runWebSearch,
  webSearchSection,
  type WebSource,
} from "./web-search";
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
  ARTIFACTS_DIR,
  ArtifactTracker,
  artifactPdfPath,
  artifactThumbPath,
  toWireArtifact,
} from "./artifacts";
// Déduplication §60 (audit S-04) : auth.ts est la source unique du jeton de
// service et des gardes d'origine ; http-server.ts celle du serveur du 3004.
import { SERVICE_TOKEN, isLoopbackOrigin, socketAuthorized } from "./auth";
import { createFilesServer, PORT, FILES_PORT } from "./http-server";
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

// Jeton de service, gardes d'origine, jeton HTTP et constantes de ports :
// SOURCES UNIQUEES dans auth.ts et http-server.ts (découpage §60, S-04).

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

/** Attache les cartes d'artefacts aux messages d'une conversation.
 *  fullHistory (revue 95) : l'appelant déclare s'il a fourni le fil COMPLET
 *  — l'ancien test `messages.length > 1` rechargeait toute la conversation
 *  depuis SQLite à chaque ouverture d'une conversation à UN message. */
function attachArtifactCards(
  conversationId: string,
  messages: ChatMessage[],
  fullHistory = false
): void {
  const rows = store.listConversationArtifacts(conversationId);
  if (rows.length === 0) return;
  // P-01 : ids des messages en UN chargement (l'ancien code rechargeait
  // TOUTE la conversation dans artifactAnchor à chaque clé d'artefact).
  // F-29 (perf) : quand l'appelant fournit déjà le fil complet, on s'appuie
  // sur SES ids — le rechargement complet ne reste qu'en fin de tour, où
  // seul [doneMessage] est passé (≤ 1 message, pas un fil complet).
  const ids = fullHistory
    ? new Set(messages.map((m) => m.id))
    : new Set(store.getMessages(conversationId).map((m) => m.id));
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

// Jeton de service (revue 2026-11-13) : refus AVANT tout gestionnaire — une
// socket non authentifiée ne reçoit aucun événement applicatif. La comparaison
// en temps constant et le canal (payload auth ou en-tête Authorization — la
// query d'URL reste réservée aux liens HTTP img/iframe du 3004) vivent dans
// auth.ts, source unique depuis le découpage §60 (audit S-04).

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

// Déduplication §60 (audit S-04) : le serveur HTTP du 3004 (pièces jointes,
// artefacts, partages, diagnostics) vit dans http-server.ts — câblé ici avec
// le store, les tours LLM en vol du pool et la longueur des voix du débat.
const filesServer = createFilesServer({
  store,
  activeStreams: () => pool.activeStreams(),
  resolveVoiceChars: () => resolveVoiceChars(store),
});

// Moteur de tour (découpage 2026-11, cf. FORK.md §10) : runAssistantTurn et
// ses registres vivent dans turn-runner.ts ; les helpers d'artefacts restent
// ici (partagés avec les handlers).
const {
  runAssistantTurn,
  isRunning,
  abortRunning,
  abortAllRunning,
  hasLiveTurns,
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

// Arrêt propre des tours en vol (loi « jamais bloqué », 2026-11-22) : le
// lanceur dépose `arret-propre.flag` avant toute relance ; le service clôt
// alors chaque tour en vol (partiel persisté + événement terminal par
// client) au lieu de mourir dans l'œuf — plus aucun écran laissé collé
// sur « Envoi… » par une mise à jour qui coupait une génération.
// Logique complète dans handlers/drain.ts (nouveau fichier, FORK.md R1).
const drainFlag = join(import.meta.dir, "..", "..", "desktop", "runtime", "arret-propre.flag");
startDrainWatchdog({
  flagPath: drainFlag,
  abortAllRunning,
  trace,
  emit: (event, payload) => io.emit(event, payload),
});

// Démarrage automatique de l'agent Hermes (loi « tout simplement », 2026-11-22) :
// si la passerelle 9120 est éteinte et que l'installation amont officielle
// est connue (resolveAgentDir), la lancer une fois au boot — le connecteur
// re-sonde déjà à chaque tour et bascule en mode gateway sans aucune saisie.
// Adoption si l'agent tourne déjà, jamais de kill, échec non bloquant
// (l'interface garde son état honnête). Logique : agent-starter.ts.
void startAgentGatewayIfDown().then((up) => {
  if (!up) return;
  // L'agent répond : sonde immédiate + hello rediffusé — la barre latérale
  // et la carte Hermes passent à « branché » sans attendre le prochain message.
  connector
    .probeNow()
    .then((ok) => {
      if (ok) io.emit("hello", helloPayload());
    })
    .catch(() => {});
});

// Branchement des handlers (découpage 2026-11, FORK.md §10) : chaque domaine
// pose ses socket.on(...) ; le contexte partagé (handlers/context.ts) est
// câblé juste avant. disconnect/error (cycle de vie) restent ici.

// ((90)) Re-sonde périodique tant que le mode est local : la sonde unique de
// boot (probeNow ci-dessus) a perdu une course réelle le 23/11 00:21 — le
// port 9120 répondait déjà mais la poignée de main WS n'était pas prête, et
// sans tour utilisateur le badge restait « éteint » pour toujours alors que
// l'agent vivait. Un timer léger (30 s, throttlé par reprobeIfOffline, zéro
// requête dès que le mode est gateway) rend la bascule automatique certaine ;
// le passage gateway rediffuse le hello comme le fait probeNow.
setInterval(() => {
  if (connector.mode !== "gateway") {
    void connector.probeNow().then((ok) => {
      if (ok) io.emit("hello", helloPayload());
    });
  }
}, 30_000).unref?.();

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
    version: "1.3.0",
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
    // v0.3.3 : état de mise à jour partagé (vérifié par le service au
    // démarrage puis toutes les 6 h, diffusé aussi via system:update-state).
    // update.available non null = une nouvelle version existe sur GitHub —
    // le front affiche le point d'information ET l'onglet Système le
    // badge orange, même sans jamais ouvrir la page.
    update: currentUpdateState(),
    // Manifeste du dernier démarrage (refonte (68)) : prérequis ✓/✗, état
    // de l'agent, maillons — écrit par le lanceur, la même vérité partout.
    manifeste: readSanteManifeste(),
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
  registerAgentMotorHandlers(socket);
  registerStorageHandlers(socket);

  socket.on("disconnect", (reason) => {
    console.log(`[hermes-chat] client déconnecté : ${socket.id} (${reason})`);
    // La raison socket.io (« transport close », « ping timeout »,
    // « transport error »…) fait la différence entre un rechargement de
    // page et une connexion instable — demandée par le diagnostic client.
    // Loi « le diagnostic dit le présent » (2026-11-22) : la phrase « tour
    // en vol restera sans réponse » ne sort QUE s'il y a réellement un tour
    // en vol — l'ancien message sortait à chaque déconnexion et faisait
    // passer une simple coupure (ou un rechargement) pour une réponse
    // perdue (cf. diagnostic du 2026-11-22). De plus, un tour en vol SURVIT
    // à la déconnexion : il continue côté service, se persiste à la clôture
    // et se resynchronise à la reconnexion (ré-attache liveTurnsOf).
    trace(
      "socket",
      hasLiveTurns()
        ? `client déconnecté (${reason}) — tour(s) en vol : ils continuent côté service et se resynchroniseront à la reconnexion`
        : `client déconnecté (${reason}) — aucun tour en vol`
    );
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
      // v0.3.3 : vérification de mise à jour au démarrage puis toutes
      // les 6 h — l'utilisateur est informé sans ouvrir la page Système.
      startUpdateWatchdog();
      // v0.4.0 : sonde du moteur Hermes (version installée + dernière
      // release) au démarrage puis toutes les 6 h — même idiome que la
      // carte Mise à jour de l'application.
      startAgentMotorWatchdog({
        store,
        connector,
        emit: (event, payload) => io.emit(event, payload),
      });
      // Chantier sessions natives (74) : sonde REST en lecture seule au
      // démarrage — détecte la capacité /api/sessions du moteur installé,
      // n'écrit rien côté moteur, ne bloque aucun chemin du service.
      void probeMotorSessionsOnce(connector, toHttpBase);
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
      // v0.3.3 : vérification de mise à jour au démarrage puis toutes
      // les 6 h — l'utilisateur est informé sans ouvrir la page Système.
      startUpdateWatchdog();
      // v0.4.0 : sonde du moteur Hermes (version installée + dernière
      // release) au démarrage puis toutes les 6 h — même idiome que la
      // carte Mise à jour de l'application.
      startAgentMotorWatchdog({
        store,
        connector,
        emit: (event, payload) => io.emit(event, payload),
      });
      // Chantier sessions natives (74) : sonde REST en lecture seule au
      // démarrage — détecte la capacité /api/sessions du moteur installé,
      // n'écrit rien côté moteur, ne bloque aucun chemin du service.
      void probeMotorSessionsOnce(connector, toHttpBase);
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
// (audit 2026-11-21) Filets process : un payload réseau mal typé qui
// échapperait à une garde levait un TypeError hors des listeners socket.io
// — rejection non gérée = mort immédiate du service (défaut Node/Bun),
// toutes les conversations perdaient le fil. On journalise et on continue :
// pour un service local de chat, la résilience prime sur l'arrêt sec.
process.on("unhandledRejection", (reason) => {
  console.error("[hermes-chat] promesse rejetée non gérée :", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[hermes-chat] exception non interceptée :", err);
});
