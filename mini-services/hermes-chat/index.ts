// Service de chat Hermes Web — socket.io sur le port 3003
// Événements client -> serveur :
//   hello, conversations:list/create/rename/delete/open/pin/fork/search,
//   chat:send, chat:stop, chat:regenerate (réglages expert F-22 : temperature/maxTokens/seed, assainis),
//   message:edit, message:delete,
//   models:list, attachments:upload, audio:transcribe,
//   artifacts:list, artifact:versions, artifact:retry,
//   settings:get/set,
//   providers:list/add/remove/set-strategy/add-key/remove-key/test-key,
//   extensions:list/add/toggle/remove/pin/check/update,
//   system-prompt:get/set/clear, system-prompts:list/create/update/delete,
//   custom-instructions:get/set,
//   memory:get/set-enabled/set-auto/set-notes,
//   share:get/create/revoke, feedback:set,
//   system:renderCache/clearRenderCache (v2.4 — profils de rendu Chrome)
// Événements serveur -> client :
//   stream:start, stream:delta, stream:reasoning, stream:status, stream:tool,
//   stream:done, stream:error, message:appended, message:deleted,
//   conversations:created, conversations:pinned,
//   artifact:created, artifact:delta, artifact:updated,
//   settings:changed, providers:changed, models:changed, extensions:changed,
//   system-prompt:changed, system-prompts:changed, custom-instructions:changed,
//   share:changed, feedback:changed,
//   memory:changed
// HTTP (port 3004) :
//   GET /uploads/<id>.<ext>            — pièces jointes multimédia
//   GET /artifacts/<id>/raw|download|thumb|pdf
//   GET /artifacts/zip?ids=a,b,c       — archive de plusieurs artefacts
//   GET /share/<token>/data.json       — snapshot public lecture seule (F-13)
//   GET /share/<token>/image.png       — capture Chrome du fil partagé (F-13)
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Server } from "socket.io";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Store, type ArtifactRow, type ExtensionRow, type KeyRow, type ProviderRow } from "./store";
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
import { modelLabel } from "./models";
import { transcribeAudioBase64 } from "./asr";
import {
  CUSTOM_INSTRUCTIONS_KEY,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_MEMORY_CHARS,
  MAX_PROMPT_CHARS,
  MEMORY_AUTO_KEY,
  MEMORY_ENABLED_KEY,
  MEMORY_NOTES_KEY,
  SEED_PRESETS,
  composeDemoSystemPrompt,
  rowToPreset,
  sanitizeExpertSettings,
  validatePromptText,
} from "./prompts";
import { DEMO_BASE_PROMPT } from "./demo-engine";
import {
  fetchRepoSnapshot,
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
  connector.invalidateModels();
  io.emit("providers:changed", { providers: providersWire() });
  io.emit("models:changed", {});
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

const PORT = Number(process.env.HERMES_CHAT_PORT ?? 3003);
const FILES_PORT = Number(process.env.HERMES_CHAT_FILES_PORT ?? 3004); // service HTTP dédié aux pièces jointes
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
  const byKey = new Map<string, ArtifactRow[]>();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key)!.push(r);
  }
  const anchors = new Map<string, string>();
  const cards = new Map<string, Artifact[]>();
  for (const [key, versions] of byKey) {
    const anchor = artifactAnchor(conversationId, key, versions);
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
  const u = new URL(req.url, "http://localhost");

  // Jeton de service (revue 2026-11-13) : les routes HTTP du 3004 servent
  // les pièces jointes et artefacts de l'utilisateur — protégées par le même
  // jeton que la socket, via Authorization: Bearer ou ?token=. EXCEPTION :
  // /share/<token>/(data.json|image.png) reste public (le destinataire du
  // lien n'a pas de session — F-13).
  const isShareRoute = u.pathname.startsWith("/share/");
  if (SERVICE_TOKEN && !isShareRoute && !httpAuthorized(req, u)) {
    res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
    res.end("Jeton de service requis");
    return;
  }

  // /uploads/<id>.<ext> — pièces jointes multimédia
  const served = resolveUploadFile(u.pathname);
  if (served) {
    try {
      const data = readFileSync(served.filePath);
      const name = u.searchParams.get("name");
      res.writeHead(200, {
        "Content-Type": served.mime,
        "Content-Length": data.byteLength,
        "Cache-Control": "public, max-age=31536000, immutable",
        ...(name
          ? { "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}` }
          : {}),
        "X-Content-Type-Options": "nosniff",
      });
      res.end(data);
      return;
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Erreur de lecture du fichier");
      return;
    }
  }

  // /artifacts/zip?ids=a,b,c — archive « tout télécharger »
  if (u.pathname === "/artifacts/zip") {
    handleArtifactZip(u, res);
    return;
  }

  // /artifacts/<id>/<action>
  const artMatch = /^\/artifacts\/([a-zA-Z0-9-]{8,64})\/(raw|download|thumb|pdf)$/.exec(
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
    if (action === "raw") {
      // Le HTML généré n'est JAMAIS servi comme text/html (XSS) — texte brut,
      // sauf SVG (nécessaire pour <img>) derrière un CSP qui neutralise les scripts.
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
function handleArtifactZip(u: URL, res: ServerResponse): void {
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
    const zipRes = spawnSync("zip", ["-q", "-X", zipPath, ...fileNames], { cwd: tmp });
    if (zipRes.status !== 0 || !existsSync(zipPath)) {
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
  cors: { origin: "*", methods: ["GET", "POST"] },
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

io.use((socket, next) => {
  if (!socketAuthorized(socket as never)) {
    next(new Error("Jeton de service invalide ou manquant"));
    return;
  }
  next();
});

const store = new Store();
const connector = new HermesConnector();
// v2.3 : le moteur consomme le porte-clés du volet Paramètres — en mode
// démo, les tours partent sur l'API du fournisseur à clé active.
connector.attachPool(createLlmPool(store));

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
const running = new Map<string, AbortController>();

/** Une des clés de tour de cette conversation est-elle active ? */
function isRunning(conversationId: string): boolean {
  return (
    running.has(conversationId) ||
    running.has(`${conversationId}:a`) ||
    running.has(`${conversationId}:b`)
  );
}

/** Interrompt TOUS les tours de la conversation (simple, a et b). */
function abortRunning(conversationId: string): void {
  running.get(conversationId)?.abort();
  running.get(`${conversationId}:a`)?.abort();
  running.get(`${conversationId}:b`)?.abort();
}

/** Charge compare valide : exactement 2 ids distincts non vides. */
function validCompareIds(raw: unknown): [string, string] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [a, b] = raw;
  if (typeof a !== "string" || typeof b !== "string" || !a || !b || a === b) return null;
  return [a, b];
}

function titleFrom(text: string, attachments?: Attachment[]): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean) return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
  const first = attachments?.[0];
  if (first) return first.name.slice(0, 48);
  return "Nouvelle conversation";
}

/** Instructions complètes du tour (mode démo) : base + F-18 (si active) + F-19 + F-11. */
function demoSystemPrompt(conversationId: string): string {
  return composeDemoSystemPrompt({
    base: DEMO_BASE_PROMPT,
    memoryNotes: store.getSettingBool(MEMORY_ENABLED_KEY, true)
      ? store.getSetting(MEMORY_NOTES_KEY)
      : null,
    customInstructions: store.getSetting(CUSTOM_INSTRUCTIONS_KEY),
    conversationPrompt: store.getConversationPrompt(conversationId)?.content ?? null,
  });
}

/** Taille réelle des instructions système (jauge honnête) : base + mémoire +
 * F-19 + prompt de la conversation donnée (le hello envoie la base + F-19). */
function systemPromptSize(conversationId?: string): number {
  const base = DEMO_BASE_PROMPT.length;
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
  return {
    app: "hermes-web",
    version: "1.2.0",
    mode: connector.mode,
    model: connector.model,
    gatewayUrl: connector.gatewayUrl,
    // Taille réelle des instructions système du moteur démo (base + F-18 + F-19) ;
    // la gateway garde les siennes (le client retombe sur son estimation).
    systemPromptChars: connector.mode === "demo" ? systemPromptSize() : null,
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

// ── Compaction : résumé conservé en tête de session ────────────────────
// Stocké dans la table settings (aucune migration SQLite) sous la clé
// `compact:<conversationId>` — l'affichage de la conversation reste intact,
// seul ce qui part au modèle change (résumé + messages postérieurs).

function compactKey(conversationId: string): string {
  return `compact:${conversationId}`;
}

function readCompact(conversationId: string): (CompactInfo & { summary: string }) | null {
  const raw = store.getSetting(compactKey(conversationId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.summary === "string" &&
      typeof parsed.untilMessageId === "string" &&
      typeof parsed.at === "string"
    ) {
      return {
        summary: parsed.summary,
        at: parsed.at,
        untilMessageId: parsed.untilMessageId,
        summaryChars: parsed.summary.length,
        summarizedCount: typeof parsed.summarizedCount === "number" ? parsed.summarizedCount : 0,
      };
    }
  } catch {
    /* réglage illisible : ignoré */
  }
  return null;
}

/** Vue « wire » de la compaction pour le client (sans le résumé lui-même). */
function compactInfoWire(conversationId: string): CompactInfo | null {
  const c = readCompact(conversationId);
  if (!c) return null;
  const { summary: _s, ...info } = c;
  return info;
}

io.on("connection", (socket) => {
  console.log(`[hermes-chat] client connecté : ${socket.id}`);

  socket.emit("hello", helloPayload());

  socket.on("hello", (cb?: (info: unknown) => void) => {
    if (typeof cb === "function") cb(helloPayload());
  });

  socket.on("models:list", async (cb?: (data: unknown) => void) => {
    try {
      const result = await connector.listModels();
      if (typeof cb === "function") cb(result);
    } catch {
      if (typeof cb === "function") cb({ models: [], defaultModel: null, source: "catalogue" });
    }
  });

  socket.on(
    "attachments:upload",
    async (
      payload: { name?: string; mime?: string; dataBase64?: string },
      cb?: (data: unknown) => void
    ) => {
      try {
        const name = (payload?.name ?? "fichier").trim();
        const mime = (payload?.mime ?? "application/octet-stream").trim();
        const dataBase64 = payload?.dataBase64;
        if (typeof dataBase64 !== "string" || !dataBase64) throw new Error("Contenu manquant");
        const attachment = saveAttachment(name, mime, dataBase64);
        // Transcription automatique des pièces jointes audio (best effort)
        if (attachment.kind === "audio") {
          try {
            const transcript = await transcribeAudioBase64(dataBase64, attachment.mime);
            if (transcript) attachment.transcript = transcript;
          } catch (err) {
            console.warn(
              `[hermes-chat] transcription impossible pour ${attachment.name}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
        console.log(
          `[hermes-chat] pièce jointe enregistrée : ${attachment.name} (${attachment.mime}, ${attachment.size} o)`
        );
        if (typeof cb === "function") cb({ attachment });
      } catch (err) {
        if (typeof cb === "function")
          cb({ error: err instanceof Error ? err.message : "Échec de l'envoi du fichier" });
      }
    }
  );

  // Dictée vocale : audio base64 -> texte (ASR)
  socket.on(
    "audio:transcribe",
    async (
      payload: { dataBase64?: string; mime?: string },
      cb?: (data: unknown) => void
    ) => {
      try {
        if (typeof payload?.dataBase64 !== "string" || !payload.dataBase64) {
          throw new Error("Audio manquant");
        }
        const text = await transcribeAudioBase64(payload.dataBase64, payload?.mime ?? "");
        if (typeof cb === "function") cb({ text });
      } catch (err) {
        if (typeof cb === "function")
          cb({ error: err instanceof Error ? err.message : "Échec de la transcription" });
      }
    }
  );

  socket.on("conversations:list", (cb?: (data: unknown) => void) => {
    const conversations = store.listConversations();
    if (typeof cb === "function") cb({ conversations });
    else socket.emit("conversations:list", { conversations });
  });

  socket.on(
    "conversations:create",
    (
      payload: { projectId?: string | null } | ((data: unknown) => void),
      maybeCb?: (data: unknown) => void
    ) => {
      // Compat : emit("conversations:create", cb) sans payload
      const cb = typeof payload === "function" ? payload : maybeCb;
      const projectId =
        payload && typeof payload === "object" ? (payload.projectId ?? null) : null;
      const conversation = store.createConversation("Nouvelle conversation", projectId);
      if (typeof cb === "function") cb({ conversation });
      else socket.emit("conversations:created", { conversation });
    }
  );

  socket.on("conversations:rename", (payload: { id?: string; title?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    const title = (payload?.title ?? "").trim();
    if (!id || !title) {
      if (typeof cb === "function") cb({ error: "id et title requis" });
      return;
    }
    const conversation = store.renameConversation(id, title.slice(0, 120));
    if (typeof cb === "function") cb({ conversation });
    if (conversation) socket.emit("conversations:renamed", { conversation });
  });

  socket.on("conversations:delete", (payload: { id?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id) {
      if (typeof cb === "function") cb({ error: "id requis" });
      return;
    }
    abortRunning(id);
    // Nettoyage disque des pièces jointes et des artefacts de la conversation
    const attachments = store.conversationAttachments(id);
    const artifactRows = store.deleteConversationArtifacts(id);
    deleteAttachmentFiles(attachments);
    deleteArtifactFiles(artifactRows);
    // Les liens de partage deviennent 410 Gone (snapshot conservé en base)
    store.revokeSharesOfConversation(id);
    store.deleteConversation(id);
    if (typeof cb === "function") cb({ ok: true, id });
    socket.emit("conversations:deleted", { id });
  });

  socket.on("conversations:open", (payload: { id?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id) return;
    const messages = store.getMessages(id);
    attachArtifactCards(id, messages);
    const compact = compactInfoWire(id);
    if (typeof cb === "function") cb({ conversationId: id, messages, compact });
    else socket.emit("conversations:messages", { conversationId: id, messages, compact });
  });

  // ── Artefacts ─────────────────────────────────────────────────────────

  // Toutes les versions d'artefacts d'une conversation (métadonnées, sans contenu)
  socket.on(
    "artifacts:list",
    (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.conversationId;
      if (!id) {
        if (typeof cb === "function") cb({ artifacts: [] });
        return;
      }
      const rows = store.listConversationArtifacts(id);
      const artifacts = rows.map((r) => wireArtifact(id, r.key, r));
      if (typeof cb === "function") cb({ artifacts });
    }
  );

  // Toutes les versions d'une clé (sélecteur de version / diff du panneau)
  socket.on(
    "artifact:versions",
    (payload: { conversationId?: string; key?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.conversationId;
      const key = payload?.key;
      if (!id || !key) {
        if (typeof cb === "function") cb({ versions: [] });
        return;
      }
      const rows = store.listArtifactVersions(id, key);
      const versions = rows.map((r) => wireArtifact(id, key, r));
      if (typeof cb === "function") cb({ versions });
    }
  );

  // Relance le rendu d'un artefact HTML en erreur (Réessayer sur la carte)
  socket.on(
    "artifact:retry",
    (payload: { conversationId?: string; artifactId?: string }, cb?: (data: unknown) => void) => {
      const row = store.getArtifactRow(payload?.artifactId ?? "");
      if (!row) {
        if (typeof cb === "function") cb({ error: "Artefact introuvable" });
        return;
      }
      if (row.kind !== "html") {
        if (typeof cb === "function") cb({ error: "Cet artefact n'a pas de rendu à relancer" });
        return;
      }
      if (typeof cb === "function") cb({ ok: true });
      void renderHtmlArtifact(row);
    }
  );

  // Épingle / détache une conversation (remonte en haut de la liste)
  socket.on(
    "conversations:pin",
    (payload: { id?: string; pinned?: boolean }, cb?: (data: unknown) => void) => {
      const id = payload?.id;
      if (!id) {
        if (typeof cb === "function") cb({ error: "id requis" });
        return;
      }
      const conversation = store.setPinned(id, !!payload?.pinned);
      if (!conversation) {
        if (typeof cb === "function") cb({ error: "Conversation introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ conversation });
      socket.emit("conversations:pinned", { conversation });
    }
  );

  // Duplique une conversation (entière ou jusqu'à un message donné)
  socket.on(
    "conversations:fork",
    (
      payload: { conversationId?: string; fromMessageId?: string },
      cb?: (data: unknown) => void
    ) => {
      const conversationId = payload?.conversationId;
      if (!conversationId) {
        if (typeof cb === "function") cb({ error: "conversationId requis" });
        return;
      }
      const forked = store.forkConversation(conversationId, payload?.fromMessageId);
      if (!forked) {
        if (typeof cb === "function") cb({ error: "Conversation introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ conversation: forked });
      socket.emit("conversations:created", { conversation: forked });
    }
  );

  // Recherche plein-texte dans le contenu des messages
  socket.on(
    "conversations:search",
    (payload: { query?: string }, cb?: (data: unknown) => void) => {
      const q = (payload?.query ?? "").trim();
      const results = q.length >= 2 ? store.searchMessages(q) : [];
      if (typeof cb === "function") cb({ results });
    }
  );

  // ── Projets : rangement des conversations par projet (fork) ───────────

  socket.on("projects:list", (cb?: (data: unknown) => void) => {
    const projects = store.listProjects();
    if (typeof cb === "function") cb({ projects });
    else socket.emit("projects:list", { projects });
  });

  socket.on(
    "projects:create",
    (payload: { name?: string }, cb?: (data: unknown) => void) => {
      const name = (payload?.name ?? "").trim();
      if (!name) {
        if (typeof cb === "function") cb({ error: "name requis" });
        return;
      }
      const project = store.createProject(name);
      if (typeof cb === "function") cb({ project });
      io.emit("projects:created", { project });
    }
  );

  socket.on(
    "projects:rename",
    (payload: { id?: string; name?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.id;
      const name = (payload?.name ?? "").trim();
      if (!id || !name) {
        if (typeof cb === "function") cb({ error: "id et name requis" });
        return;
      }
      const project = store.renameProject(id, name);
      if (!project) {
        if (typeof cb === "function") cb({ error: "Projet introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ project });
      io.emit("projects:renamed", { project });
    }
  );

  // Supprime un projet : les conversations retombent dans « Sans projet »
  socket.on("projects:delete", (payload: { id?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id) {
      if (typeof cb === "function") cb({ error: "id requis" });
      return;
    }
    store.deleteProject(id);
    if (typeof cb === "function") cb({ ok: true, id });
    io.emit("projects:deleted", { id });
  });

  socket.on(
    "projects:reorder",
    (payload: { ids?: string[] }, cb?: (data: unknown) => void) => {
      const ids = Array.isArray(payload?.ids)
        ? payload.ids.filter((x): x is string => typeof x === "string")
        : [];
      if (!ids.length) {
        if (typeof cb === "function") cb({ error: "ids requis" });
        return;
      }
      const projects = store.reorderProjects(ids);
      if (typeof cb === "function") cb({ projects });
      io.emit("projects:reordered", { projects });
    }
  );

  // Déplace une conversation vers un projet (projectId null = « Sans projet »)
  socket.on(
    "conversations:move",
    (payload: { id?: string; projectId?: string | null }, cb?: (data: unknown) => void) => {
      const id = payload?.id;
      if (!id) {
        if (typeof cb === "function") cb({ error: "id requis" });
        return;
      }
      const conversation = store.moveConversation(id, payload?.projectId ?? null);
      if (!conversation) {
        if (typeof cb === "function")
          cb({ error: "Conversation ou projet introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ conversation });
      io.emit("conversations:moved", { conversation });
    }
  );

  // ── Réglages serveur (persistés, cf. FORK.md §6) ────────────────────

  socket.on(
    "settings:get",
    (payload: { key?: string }, cb?: (data: unknown) => void) => {
      const key = (payload?.key ?? "").trim();
      if (!key) {
        if (typeof cb === "function") cb({ settings: store.listSettings() });
        return;
      }
      if (typeof cb === "function") cb({ key, value: store.getSetting(key) });
    }
  );

  socket.on(
    "settings:set",
    (payload: { key?: string; value?: string }, cb?: (data: unknown) => void) => {
      const key = (payload?.key ?? "").trim();
      const value = payload?.value ?? "";
      if (!key) {
        if (typeof cb === "function") cb({ error: "key requise" });
        return;
      }
      store.setSetting(key, value);
      if (typeof cb === "function") cb({ ok: true, key, value });
      io.emit("settings:changed", { key, value });
    }
  );

  // ── Système (v2.4) : profils de rendu Chrome — sonde réelle ─────────
  // Le cache des rendus, ce sont les profils « hermes-chrome-* » du tmp :
  // régénérés à chaque rendu, purgés au démarrage du service. Jamais de
  // données simulées — count/bytes viennent du système de fichiers.
  socket.on("system:renderCache", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function") cb({ ...chromeProfileStats() });
  });

  socket.on("system:clearRenderCache", (cb?: (data: unknown) => void) => {
    const { removed, kept } = clearChromeProfiles();
    if (typeof cb === "function")
      cb({ ...chromeProfileStats(), removed, kept });
  });

  // ── Prompt système & instructions personnalisées (F-11 / F-19) ──────

  // Prompt actif d'une conversation (null si aucun)
  socket.on(
    "system-prompt:get",
    (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.conversationId;
      if (!id) {
        if (typeof cb === "function") cb({ error: "conversationId requis" });
        return;
      }
      if (typeof cb === "function") cb({ prompt: conversationPromptWire(id) });
    }
  );

  // Définit / remplace le prompt d'une conversation — effet au prochain tour
  socket.on(
    "system-prompt:set",
    (
      payload: { conversationId?: string; content?: string; presetTitle?: string },
      cb?: (data: unknown) => void
    ) => {
      const id = payload?.conversationId;
      const content = (payload?.content ?? "").trim();
      if (!id) {
        if (typeof cb === "function") cb({ error: "conversationId requis" });
        return;
      }
      const invalid = validatePromptText(content, MAX_PROMPT_CHARS);
      if (invalid) {
        if (typeof cb === "function") cb({ error: invalid });
        return;
      }
      store.setConversationPrompt(
        id,
        content,
        payload?.presetTitle ? String(payload.presetTitle).slice(0, 80) : null
      );
      if (typeof cb === "function") cb({ prompt: conversationPromptWire(id) });
      broadcastSystemPrompt(id);
    }
  );

  // Retire le prompt d'une conversation
  socket.on(
    "system-prompt:clear",
    (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.conversationId;
      if (!id) {
        if (typeof cb === "function") cb({ error: "conversationId requis" });
        return;
      }
      store.clearConversationPrompt(id);
      if (typeof cb === "function") cb({ ok: true, prompt: null });
      broadcastSystemPrompt(id);
    }
  );

  // Bibliothèque de presets réutilisables (section Hermes du volet)
  socket.on("system-prompts:list", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function")
      cb({ presets: store.listPromptPresets().map(rowToPreset) });
  });

  socket.on(
    "system-prompts:create",
    (payload: { title?: string; content?: string }, cb?: (data: unknown) => void) => {
      const title = (payload?.title ?? "").trim();
      const content = (payload?.content ?? "").trim();
      if (!title) {
        if (typeof cb === "function") cb({ error: "Titre requis" });
        return;
      }
      const invalid = validatePromptText(content, MAX_PROMPT_CHARS);
      if (invalid) {
        if (typeof cb === "function") cb({ error: invalid });
        return;
      }
      const row = store.createPromptPreset(title.slice(0, 80), content);
      if (typeof cb === "function") cb({ preset: rowToPreset(row) });
      broadcastSystemPrompts();
    }
  );

  socket.on(
    "system-prompts:update",
    (
      payload: { id?: string; title?: string; content?: string },
      cb?: (data: unknown) => void
    ) => {
      const id = payload?.id;
      const title = (payload?.title ?? "").trim();
      const content = (payload?.content ?? "").trim();
      if (!id || !title) {
        if (typeof cb === "function") cb({ error: "id et titre requis" });
        return;
      }
      const invalid = validatePromptText(content, MAX_PROMPT_CHARS);
      if (invalid) {
        if (typeof cb === "function") cb({ error: invalid });
        return;
      }
      const row = store.updatePromptPreset(id, title.slice(0, 80), content);
      if (!row) {
        if (typeof cb === "function") cb({ error: "Preset introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ preset: rowToPreset(row) });
      broadcastSystemPrompts();
    }
  );

  socket.on(
    "system-prompts:delete",
    (payload: { id?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.id;
      if (!id) {
        if (typeof cb === "function") cb({ error: "id requis" });
        return;
      }
      const ok = store.deletePromptPreset(id);
      if (!ok) {
        if (typeof cb === "function") cb({ error: "Preset introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ ok: true });
      broadcastSystemPrompts();
    }
  );

  // Instructions personnalisées globales (F-19) — registre serveur §6
  socket.on(
    "custom-instructions:get",
    (cb?: (data: unknown) => void) => {
      if (typeof cb === "function")
        cb({
          value: store.getSetting(CUSTOM_INSTRUCTIONS_KEY) ?? "",
          maxChars: MAX_CUSTOM_INSTRUCTIONS_CHARS,
        });
    }
  );

  socket.on(
    "custom-instructions:set",
    (payload: { value?: string }, cb?: (data: unknown) => void) => {
      const value = (payload?.value ?? "").trim();
      if (value.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
        if (typeof cb === "function")
          cb({
            error: `Trop long (max ${MAX_CUSTOM_INSTRUCTIONS_CHARS.toLocaleString("fr-FR")} caractères)`,
          });
        return;
      }
      store.setSetting(CUSTOM_INSTRUCTIONS_KEY, value);
      if (typeof cb === "function") cb({ ok: true, value });
      io.emit("custom-instructions:changed", { value });
    }
  );

  // ── Mémoire utilisateur (F-18) — consultable, éditable, effaçable ───
  // Notes persistantes injectées dans les instructions du tour tant que la
  // mémoire est active. Jamais un mot-clé magique : la composition reste
  // le fait du service (prompts.ts), le client n'assemble rien.

  socket.on("memory:get", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function")
      cb({
        enabled: store.getSettingBool(MEMORY_ENABLED_KEY, true),
        autoLearn: store.getSettingBool(MEMORY_AUTO_KEY, false),
        notes: store.getSetting(MEMORY_NOTES_KEY) ?? "",
        maxChars: MAX_MEMORY_CHARS,
      });
  });

  socket.on(
    "memory:set-enabled",
    (payload: { enabled?: boolean }, cb?: (data: unknown) => void) => {
      const enabled = payload?.enabled === true;
      store.setSettingBool(MEMORY_ENABLED_KEY, enabled);
      if (typeof cb === "function") cb({ ok: true, enabled });
      io.emit("memory:changed", { enabled });
    }
  );

  socket.on(
    "memory:set-auto",
    (payload: { autoLearn?: boolean }, cb?: (data: unknown) => void) => {
      const autoLearn = payload?.autoLearn === true;
      store.setSettingBool(MEMORY_AUTO_KEY, autoLearn);
      if (typeof cb === "function") cb({ ok: true, autoLearn });
      io.emit("memory:changed", { autoLearn });
    }
  );

  socket.on(
    "memory:set-notes",
    (payload: { value?: string }, cb?: (data: unknown) => void) => {
      const value = (payload?.value ?? "").trim();
      if (value.length > MAX_MEMORY_CHARS) {
        if (typeof cb === "function")
          cb({
            error: `Trop long (max ${MAX_MEMORY_CHARS.toLocaleString("fr-FR")} caractères)`,
          });
        return;
      }
      store.setSetting(MEMORY_NOTES_KEY, value);
      if (typeof cb === "function") cb({ ok: true, value });
      io.emit("memory:changed", { notes: value });
    }
  );

  // ── Partage public lecture seule (F-13) ───────────────────────────

  // Partage actif de la conversation (null si aucun)
  socket.on(
    "share:get",
    (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.conversationId;
      if (!id) {
        if (typeof cb === "function") cb({ error: "conversationId requis" });
        return;
      }
      const row = store.getActiveShareByConversation(id);
      if (typeof cb === "function")
        cb({ share: row ? rowToShareView(row) : null });
    }
  );

  // Crée (ou recrée) le lien — snapshot FIGÉ des messages au moment du partage
  socket.on(
    "share:create",
    (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.conversationId;
      if (!id) {
        if (typeof cb === "function") cb({ error: "conversationId requis" });
        return;
      }
      const conversation = store.getConversation(id);
      if (!conversation) {
        if (typeof cb === "function") cb({ error: "Conversation introuvable" });
        return;
      }
      const messages = store.getMessages(id);
      if (messages.length === 0) {
        if (typeof cb === "function") cb({ error: "Rien à partager : conversation vide" });
        return;
      }
      const { snapshot, data } = buildSnapshot(conversation, messages);
      const row = store.createShare(
        id,
        conversation.title,
        snapshot,
        data.messageCount,
        generateShareToken()
      );
      if (typeof cb === "function") cb({ share: rowToShareView(row) });
      io.emit("share:changed", { conversationId: id, share: rowToShareView(row) });
    }
  );

  // Révoque le lien actif (le snapshot et la conversation ne bougent pas)
  socket.on(
    "share:revoke",
    (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
      const id = payload?.conversationId;
      if (!id) {
        if (typeof cb === "function") cb({ error: "conversationId requis" });
        return;
      }
      const ok = store.revokeShareByConversation(id);
      if (typeof cb === "function") cb({ ok });
      if (ok) io.emit("share:changed", { conversationId: id, share: null });
    }
  );

  // ── Feedback utilisateur (F-24) — local, jamais envoyé au modèle ────
  // 👍/👎 + commentaire libre sur les réponses assistant. null = effacé.
  socket.on(
    "feedback:set",
    (
      payload: {
        conversationId?: string;
        messageId?: string;
        rating?: "up" | "down" | null;
        comment?: string | null;
      },
      cb?: (data: unknown) => void
    ) => {
      const conversationId = payload?.conversationId;
      const messageId = payload?.messageId;
      const rating =
        payload?.rating === "up" || payload?.rating === "down" ? payload.rating : null;
      if (!conversationId || !messageId) {
        if (typeof cb === "function") cb({ error: "Paramètres manquants" });
        return;
      }
      const comment =
        typeof payload?.comment === "string" ? payload.comment.trim().slice(0, 2000) : null;
      if (!rating && comment) {
        if (typeof cb === "function")
          cb({ error: "Un commentaire accompagne un 👍/👎 — effacez le retour complet" });
        return;
      }
      const message = store.setMessageFeedback(conversationId, messageId, rating, comment);
      if (!message) {
        if (typeof cb === "function") cb({ error: "Réponse introuvable (assistant seule)" });
        return;
      }
      if (typeof cb === "function") cb({ message });
      io.emit("feedback:changed", { conversationId, message });
    }
  );

  // ── Fournisseurs & clés (Paramètres v2.2) ──────────────────────────

  socket.on("providers:list", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function") cb({ providers: providersWire() });
  });

  socket.on(
    "providers:add",
    (
      payload: { name?: string; kind?: string; baseUrl?: string },
      cb?: (data: unknown) => void
    ) => {
      const raw = (payload?.name ?? "").trim();
      const kind = payload?.kind === "service" ? "service" : "llm";
      if (!raw) {
        if (typeof cb === "function") cb({ error: "Nom ou adresse requis" });
        return;
      }
      const resolved = resolveKnownProvider(raw);
      if (!resolved) {
        if (typeof cb === "function")
          cb({ error: "Fournisseur non reconnu — collez son adresse (https://…)" });
        return;
      }
      // Un fournisseur connu n'est pas dupliqué
      const canonicalName = "known" in resolved ? resolved.known.name : resolved.custom.name;
      const existing = store
        .listProviderRows()
        .find((p) => p.name.toLowerCase() === canonicalName.toLowerCase() && p.kind === kind);
      if (existing) {
        if (typeof cb === "function") cb({ error: `${canonicalName} est déjà dans la liste` });
        return;
      }
      let baseUrl =
        "known" in resolved
          ? (resolved.known.defaultBaseUrl ?? null)
          : resolved.custom.baseUrl;
      // Adresse explicite fournie : elle gagne sur l'adresse canonique
      // (surcharger un fournisseur connu — passerelle d'entreprise, tests).
      // https requis, ou http strictement local (même règle que le test de clé).
      const explicit = (payload?.baseUrl ?? "").trim();
      if (explicit && /^https?:\/\//i.test(explicit)) {
        try {
          const u = new URL(explicit);
          const local =
            u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
          if (u.protocol === "https:" || (u.protocol === "http:" && local)) {
            baseUrl = explicit.replace(/\/+$/, "");
          }
        } catch {
          /* adresse invalide : adresse canonique conservée */
        }
      }
      const row = store.createProvider({ name: canonicalName, kind, baseUrl });
      if (typeof cb === "function") cb({ provider: providerWire(row, []) });
      broadcastProviders();
    }
  );

  socket.on("providers:remove", (payload: { id?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id || !store.getProviderRow(id)) {
      if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
      return;
    }
    store.deleteProvider(id);
    if (typeof cb === "function") cb({ ok: true });
    broadcastProviders();
  });

  socket.on(
    "providers:set-strategy",
    (
      payload: { id?: string; strategy?: string },
      cb?: (data: unknown) => void
    ) => {
      const id = payload?.id;
      const strategy = payload?.strategy;
      const ok = ["fill_first", "round_robin", "least_used"];
      if (!id || !strategy || !ok.includes(strategy)) {
        if (typeof cb === "function") cb({ error: "Paramètres invalides" });
        return;
      }
      const row = store.setProviderStrategy(id, strategy);
      if (!row) {
        if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ provider: providerWire(row, store.listKeyRows(id)) });
      broadcastProviders();
    }
  );

  socket.on(
    "providers:add-key",
    (
      payload: { providerId?: string; label?: string; secret?: string },
      cb?: (data: unknown) => void
    ) => {
      const providerId = payload?.providerId;
      const label = (payload?.label ?? "").trim() || "Clé";
      const secret = (payload?.secret ?? "").trim();
      const provider = providerId ? store.getProviderRow(providerId) : null;
      if (!providerId || !provider) {
        if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
        return;
      }
      if (secret.length < 8) {
        if (typeof cb === "function") cb({ error: "Clé trop courte" });
        return;
      }
      const row = store.createProviderKey(providerId, label, secret, maskSecret(secret));
      console.log(
        `[hermes-chat] clé ajoutée pour ${provider.name} : « ${label} » (${row.masked})`
      );
      if (typeof cb === "function") cb({ key: toKeyView(row) });
      broadcastProviders();
    }
  );

  socket.on("providers:remove-key", (payload: { keyId?: string }, cb?: (data: unknown) => void) => {
    const keyId = payload?.keyId;
    if (!keyId || !store.getKeyRow(keyId)) {
      if (typeof cb === "function") cb({ error: "Clé introuvable" });
      return;
    }
    store.deleteProviderKey(keyId);
    if (typeof cb === "function") cb({ ok: true });
    broadcastProviders();
  });

  // « Tester » = appel minimal RÉEL exécuté par le service (liste des
  // modèles, ou requête minimale pour les services d'API) — réseau inclus.
  socket.on(
    "providers:test-key",
    async (payload: { keyId?: string }, cb?: (data: unknown) => void) => {
      const key = payload?.keyId ? store.getKeyRow(payload.keyId) : null;
      if (!key) {
        if (typeof cb === "function") cb({ error: "Clé introuvable" });
        return;
      }
      const provider = store.getProviderRow(key.provider_id);
      if (!provider) {
        if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
        return;
      }
      try {
        const result = await testProviderKey(provider.name, provider.base_url, key.secret);
        const updated = store.setKeyStatus(key.id, result.status, result.statusLabel);
        console.log(
          `[hermes-chat] test ${provider.name}/${key.label} → ${result.status} (${result.statusLabel})`
        );
        if (typeof cb === "function")
          cb({ ok: true, key: updated ? toKeyView(updated) : null, detail: result.detail ?? null });
        broadcastProviders();
      } catch (err) {
        if (typeof cb === "function")
          cb({ error: err instanceof Error ? err.message : "Test impossible" });
      }
    }
  );

  // ── Extensions : dépôts importés + serveurs MCP ───────────────────

  socket.on("extensions:list", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function") cb({ extensions: extensionsWire() });
  });

  // Import d'un dépôt GitHub : résolution réelle (infos, branche, tête)
  socket.on(
    "extensions:add",
    async (
      payload: { kind?: string; source?: string; channel?: string },
      cb?: (data: unknown) => void
    ) => {
      const kind = payload?.kind === "mcp" ? "mcp" : "repo";
      const source = (payload?.source ?? "").trim();
      if (!source) {
        if (typeof cb === "function") cb({ error: "Source requise" });
        return;
      }
      if (kind === "mcp") {
        const row = store.createExtension({
          name: source.slice(0, 80),
          kind,
          description: "serveur ajouté",
          source,
        });
        if (typeof cb === "function") cb({ extension: extensionWire(row) });
        broadcastExtensions();
        return;
      }
      const ref = parseRepoInput(source);
      if (!ref) {
        if (typeof cb === "function")
          cb({ error: "Adresse de dépôt invalide (https://github.com/owner/repo)" });
        return;
      }
      try {
        const snap = await fetchRepoSnapshot(ref, payload?.channel ?? null);
        const row = store.createExtension({
          name: snap.name,
          kind,
          description: snap.description,
          source: `${ref.owner}/${ref.repo}`,
          channel: snap.defaultBranch,
          commit: snap.headSha,
          version: snap.versionLabel,
        });
        console.log(
          `[hermes-chat] extension importée : ${row.source} @ ${row.channel} (${row.version})`
        );
        if (typeof cb === "function")
          cb({ extension: extensionWire(row), commits: snap.commits });
        broadcastExtensions();
      } catch (err) {
        if (typeof cb === "function")
          cb({ error: err instanceof Error ? err.message : "Import impossible" });
      }
    }
  );

  socket.on(
    "extensions:toggle",
    (payload: { id?: string; enabled?: boolean }, cb?: (data: unknown) => void) => {
      const id = payload?.id;
      if (!id) {
        if (typeof cb === "function") cb({ error: "id requis" });
        return;
      }
      // `applied` n'est PAS touché : le footer compte les écarts et le
      // redémarrage du service prendra le nouvel état en compte.
      const row = store.updateExtensionRow(id, { enabled: !!payload?.enabled });
      if (!row) {
        if (typeof cb === "function") cb({ error: "Extension introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ extension: extensionWire(row) });
      broadcastExtensions();
    }
  );

  socket.on("extensions:remove", (payload: { id?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id || !store.getExtensionRow(id)) {
      if (typeof cb === "function") cb({ error: "Extension introuvable" });
      return;
    }
    store.deleteExtension(id);
    if (typeof cb === "function") cb({ ok: true });
    broadcastExtensions();
  });

  socket.on(
    "extensions:pin",
    (payload: { id?: string; pinned?: boolean }, cb?: (data: unknown) => void) => {
      const id = payload?.id;
      if (!id) {
        if (typeof cb === "function") cb({ error: "id requis" });
        return;
      }
      const row = store.updateExtensionRow(id, { pinned: !!payload?.pinned });
      if (!row) {
        if (typeof cb === "function") cb({ error: "Extension introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ extension: extensionWire(row) });
      broadcastExtensions();
    }
  );

  // « Vérifier » : diff réel local ↔ distant via l'API GitHub.
  socket.on(
    "extensions:check",
    async (payload: { id?: string }, cb?: (data: unknown) => void) => {
      const row = payload?.id ? store.getExtensionRow(payload.id) : null;
      if (!row) {
        if (typeof cb === "function") cb({ error: "Extension introuvable" });
        return;
      }
      if (row.kind !== "repo" || !row.source) {
        if (typeof cb === "function") cb({ error: "Rien à vérifier pour ce type d'extension" });
        return;
      }
      if (row.pinned) {
        if (typeof cb === "function")
          cb({ ok: true, skipped: true, extension: extensionWire(row) });
        return;
      }
      const ref = parseRepoInput(row.source);
      if (!ref) {
        if (typeof cb === "function") cb({ error: "Source de dépôt invalide" });
        return;
      }
      try {
        const snap = await fetchRepoSnapshot(ref, row.channel);
        const changed = snap.headSha !== row.commit;
        const updated = store.updateExtensionRow(row.id, {
          update_available: changed ? snap.versionLabel : null,
          last_checked_at: new Date().toISOString(),
        })!;
        if (typeof cb === "function")
          cb({ ok: true, extension: extensionWire(updated), commits: snap.commits, changed });
        broadcastExtensions();
      } catch (err) {
        if (typeof cb === "function")
          cb({ error: err instanceof Error ? err.message : "Vérification impossible" });
      }
    }
  );

  // « Mettre à jour » : suit le commit distant (le rapatriement effectif
  // et le relancement du composant relèvent du moteur, post-gateway).
  socket.on(
    "extensions:update",
    async (payload: { id?: string }, cb?: (data: unknown) => void) => {
      const row = payload?.id ? store.getExtensionRow(payload.id) : null;
      if (!row) {
        if (typeof cb === "function") cb({ error: "Extension introuvable" });
        return;
      }
      if (row.kind !== "repo" || !row.source) {
        if (typeof cb === "function") cb({ error: "Cette extension ne se met pas à jour" });
        return;
      }
      const ref = parseRepoInput(row.source);
      if (!ref) {
        if (typeof cb === "function") cb({ error: "Source de dépôt invalide" });
        return;
      }
      try {
        const snap = await fetchRepoSnapshot(ref, row.channel);
        const updated = store.updateExtensionRow(row.id, {
          commit: snap.headSha,
          version: snap.versionLabel,
          update_available: null,
          last_checked_at: new Date().toISOString(),
        })!;
        console.log(
          `[hermes-chat] extension mise à jour : ${updated.source} → ${updated.version}`
        );
        if (typeof cb === "function")
          cb({ extension: extensionWire(updated), commits: snap.commits });
        broadcastExtensions();
      } catch (err) {
        if (typeof cb === "function")
          cb({ error: err instanceof Error ? err.message : "Mise à jour impossible" });
      }
    }
  );

  /**
   * Exécute un tour assistant complet : stream, événements d'outils,
   * raisonnement, persistance. Utilisé par chat:send, chat:regenerate
   * et message:edit. Le dernier message utilisateur du fil sert de contenu.
   */
  const runAssistantTurn = async (
    conversationId: string,
    opts: {
      content: string;
      attachments?: Attachment[];
      modelId?: string | null;
      settings?: TurnSettings;
      /** F-09/F-12 : recherche web du tour (clés Tavily/Exa, mode démo). */
      webSearch?: boolean;
      /** Variante de comparaison (F-17) : ce tour n'occupe que SON côté. */
      variant?: "a" | "b";
      /** F-14 : groupe de version — ce tour est une NOUVELLE version de la
       *  réponse qu'il remplace (l'ancienne est conservée, inactive). */
      versionGroup?: string;
    }
  ) => {
    const variant = opts.variant;
    const versionIndex = opts.versionGroup
      ? store.countVersions(opts.versionGroup) + 1
      : null;
    // Un seul tour actif par conversation. L'ANCIEN tour est aborté, mais
    // son finally ne doit JAMAIS retirer le contrôleur du NOUVEAU (course
    // critique : le finally du tour précédent exécutait running.delete()
    // après coup, supprimant le contrôleur remplaçant → chat:stop devenait
    // inopérant et deux tours s'entrelacaient). Chaque tour ne retire que
    // SA propre entrée.
    // F-17 : un tour de comparaison n'aborte PAS l'autre côté — chaque
    // variante vit sous sa propre clé (conv:a / conv:b).
    const turnKey = variant ? `${conversationId}:${variant}` : conversationId;
    const previous = running.get(turnKey);
    previous?.abort();
    const controller = new AbortController();
    running.set(turnKey, controller);

    // 0. Résout le modèle sélectionné (libellé d'affichage)
    const model = opts.modelId ? modelLabel(opts.modelId) || opts.modelId : null;
    const attachments = opts.attachments?.length ? opts.attachments : undefined;

    // 1. Prépare le tour assistant
    const messageId = crypto.randomUUID();
    socket.emit("stream:start", {
      conversationId,
      messageId,
      model,
      ...(variant ? { variant } : {}),
    });

    // Historique : tout ce qui précède le dernier message utilisateur.
    // Si la conversation est compactée, le résumé remplace les messages
    // couverts ; seuls les messages postérieurs partent en clair.
    const all = store.getMessages(conversationId);
    // F-17 : en comparaison, chaque modèle revoit le fil comme un dialogue
    // bilatéral — ses propres réponses, pas celles de l'autre variante.
    const existing = variant
      ? all.filter((m) => m.role === "user" || !m.variant || m.variant === variant)
      : all;
    let lastUserIdx = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      if (existing[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const cut = lastUserIdx >= 0 ? lastUserIdx : existing.length;
    let history: { role: "user" | "assistant"; content: string }[];
    const compact = readCompact(conversationId);
    if (compact) {
      const untilIdx = existing.findIndex((m) => m.id === compact.untilMessageId);
      const after = existing.slice(untilIdx >= 0 ? untilIdx + 1 : 0, cut);
      // Le résumé est TOUJOURS en tête (c'est le contrat de la compaction :
      // un contexte résumé permanent) — le plafond ne coupe que les messages
      // postérieurs. L'ancien slice(-MAX_HISTORY) sur le tout éliminait le
      // résumé dès le 30e message postérieur, vidant la session de son
      // contexte sans avertissement.
      history = [
        {
          role: "user" as const,
          content:
            `[Résumé des ${compact.summarizedCount} premiers messages de cette conversation — compaction du ${new Date(compact.at).toLocaleString("fr-FR")}]\n\n${compact.summary}`,
        },
        ...after
          .slice(-(MAX_HISTORY - 1))
          .map((m: ChatMessage) => ({ role: m.role, content: m.content })),
      ];
    } else {
      history = existing
        .slice(0, cut)
        .slice(-MAX_HISTORY)
        .map((m: ChatMessage) => ({ role: m.role, content: m.content }));
    }

    const toolEvents: ToolEvent[] = [];
    let contentAcc = "";
    let reasoningAcc = "";
    let lastEmit = 0;
    let lastSent = 0;
    let usedModel = model ?? connector.model;

    // Suivi des artefacts générés pendant le tour (blocs fichier du contenu)
    const tracker = new ArtifactTracker(store, conversationId, messageId, {
      onCreated: (artifact) =>
        io.emit("artifact:created", { conversationId, messageId, artifact }),
      onDelta: (p) =>
        io.emit("artifact:delta", {
          conversationId,
          messageId,
          key: p.key,
          delta: p.delta,
        }),
      onUpdated: (artifact) => io.emit("artifact:updated", { conversationId, artifact }),
      onHtmlReady: (row) => {
        void renderHtmlArtifact(row);
      },
    });

    // ── F-09/F-12 : recherche web du tour (clés de services Tavily/Exa) ──
    // Best effort : un échec n'annule jamais le tour, l'événement outil
    // l'affiche honnêtement dans la bulle (et le modèle répond sans contexte).
    let webSources: WebSource[] | undefined;
    const emitTool = (event: {
      name: string;
      status: "running" | "done" | "error";
      detail?: string;
    }) => {
      const toolEvent: ToolEvent = { ...event, at: new Date().toISOString() };
      toolEvents.push(toolEvent);
      socket.emit("stream:tool", {
        conversationId,
        messageId,
        event: toolEvent,
        ...(variant ? { variant } : {}),
      });
    };
    if (opts.webSearch) {
      if (connector.mode === "gateway") {
        emitTool({
          name: "Recherche web",
          status: "done",
          detail: "gérée par l'agent Hermes (gateway)",
        });
      } else {
        emitTool({
          name: "Recherche web",
          status: "running",
          detail: opts.content.slice(0, 80),
        });
        const outcome = await runWebSearch(store, opts.content);
        if (outcome.sources?.length) {
          webSources = outcome.sources;
          emitTool({
            name: "Recherche web",
            status: "done",
            detail: `${outcome.sources.length} sources (${outcome.provider})`,
          });
        } else {
          emitTool({
            name: "Recherche web",
            status: "error",
            detail: outcome.error ?? "aucun résultat",
          });
        }
      }
    }

    try {
      const result = await connector.runTurn(
        {
          content: opts.content,
          history,
          model,
          modelId: opts.modelId,
          attachments,
          // Réglages du tour : effort/permissions du composer + mémoire
          // utilisateur (F-18) — les notes ne partent que si la mémoire est
          // active (mode gateway ; en démo elles vivent dans systemPrompt).
          settings: {
            ...opts.settings,
            memoryNotes:
              store.getSettingBool(MEMORY_ENABLED_KEY, true)
                ? (store.getSetting(MEMORY_NOTES_KEY) ?? "").trim() || undefined
                : undefined,
            memoryAutoLearn: store.getSettingBool(MEMORY_AUTO_KEY, false),
          },
          // Instructions système du tour (F-11/F-19) : composées par le
          // service en mode démo ; en mode gateway, le prompt de conversation
          // part seul (la gateway garde ses instructions de base).
          // F-12 : les résultats de recherche web sont ajoutés en fin de
          // prompt système du tour démo (pool ou LLM intégré).
          systemPrompt:
            connector.mode === "demo"
              ? demoSystemPrompt(conversationId) +
                (webSources ? webSearchSection(webSources) : "")
              : store.getConversationPrompt(conversationId)?.content ?? null,
        },
        {
          signal: controller.signal,
          onDelta: (delta) => {
            contentAcc += delta;
            const now = Date.now();
            // Coalescence légère des deltas très rapprochés
            if (now - lastEmit > 16) {
              lastEmit = now;
              socket.emit("stream:delta", {
                conversationId,
                messageId,
                delta: contentAcc.slice(lastSent),
                ...(variant ? { variant } : {}),
              });
              lastSent = contentAcc.length;
              // Naissance / progression des artefacts du tour
              tracker.update(contentAcc);
            }
          },
          onReasoning: (delta) => {
            reasoningAcc += delta;
            socket.emit("stream:reasoning", {
              conversationId,
              messageId,
              delta,
              ...(variant ? { variant } : {}),
            });
          },
          onStatus: (status) => {
            socket.emit("stream:status", {
              conversationId,
              messageId,
              status,
              ...(variant ? { variant } : {}),
            });
          },
          onToolEvent: (event) => {
            const toolEvent: ToolEvent = { ...event, at: new Date().toISOString() };
            toolEvents.push(toolEvent);
            socket.emit("stream:tool", {
              conversationId,
              messageId,
              event: toolEvent,
              ...(variant ? { variant } : {}),
            });
          },
        }
      );

      // Flush final du contenu restant
      contentAcc = result.content || contentAcc;
      reasoningAcc = result.reasoning || reasoningAcc;
      if (result.model) {
        usedModel =
          result.engine === "pool" && result.provider
            ? `${result.model} · ${result.provider}`
            : connector.mode === "demo"
              ? `${result.model} (démo)`
              : result.model;
      }
      if (lastSent < contentAcc.length) {
        socket.emit("stream:delta", {
          conversationId,
          messageId,
          delta: contentAcc.slice(lastSent),
          ...(variant ? { variant } : {}),
        });
      }

      // Arrêt utilisateur (chat:stop) : le connecteur revient avec le partiel —
      // ce n'est pas une erreur, le tour se clôt normalement avec le marqueur.
      const stopped = controller.signal.aborted;

      // Arrêt avant le premier jeton : rien à conserver, pas de bulle vide
      if (stopped && !contentAcc && !reasoningAcc && toolEvents.length === 0) {
        const conversation = store.touchConversation(conversationId) ?? undefined;
        socket.emit("stream:done", {
          conversationId,
          messageId,
          conversation,
          stopped: true,
          ...(variant ? { variant } : {}),
        });
        return;
      }

      // Clôture du suivi des artefacts (persistance définitive)
      tracker.finalize(contentAcc, false);

      // Persiste la réponse assistant (INSERT avec l'id du tour)
      store.appendMessage({
        id: messageId,
        conversationId,
        role: "assistant",
        content: contentAcc || "(réponse vide)",
        reasoning: reasoningAcc || undefined,
        toolEvents: toolEvents.length ? toolEvents : undefined,
        model: usedModel,
        stopped: stopped || undefined,
        variant,
        // F-21 : jetons réels quand l'API les renvoie (pool de clés)
        usage: result.usage,
        // F-12 : sources de la recherche web du tour
        sources: webSources,
        ...(opts.versionGroup
          ? { versionGroup: opts.versionGroup, versionIndex: versionIndex ?? 1, versionActive: 1 }
          : {}),
      });
      const conversation = store.touchConversation(conversationId) ?? undefined;
      const doneMessage: ChatMessage = {
        id: messageId,
        conversationId,
        role: "assistant",
        content: contentAcc || "(réponse vide)",
        reasoning: reasoningAcc || undefined,
        toolEvents: toolEvents.length ? toolEvents : undefined,
        model: usedModel,
        createdAt: new Date().toISOString(),
        stopped: stopped || undefined,
        variant,
        usage: result.usage,
        sources: webSources,
        ...(opts.versionGroup
          ? { versions: { group: opts.versionGroup, index: versionIndex ?? 1, count: versionIndex ?? 1 } }
          : {}),
      };
      // Cartes d'artefacts ancrées sur ce message (celles créées par ce tour)
      attachArtifactCards(conversationId, [doneMessage]);
      socket.emit("stream:done", {
        conversationId,
        messageId,
        conversation,
        message: doneMessage,
        stopped,
        ...(variant ? { variant } : {}),
      });
    } catch (err) {
      // Sauvegarde du partiel déjà reçu
      tracker.finalize(contentAcc, true);
      const stopped = controller.signal.aborted;
      let partial: ChatMessage | null = null;
      if (contentAcc || reasoningAcc) {
        partial = store.appendMessage({
          id: messageId,
          conversationId,
          role: "assistant",
          content: contentAcc || "(interrompu)",
          reasoning: reasoningAcc || undefined,
          toolEvents: toolEvents.length ? toolEvents : undefined,
          model: usedModel,
          stopped: stopped || undefined,
          variant,
          // F-12 : la recherche a eu lieu avant l'échec — le partiel garde
          // ses sources (l'événement outil est déjà dans toolEvents).
          sources: webSources,
          ...(opts.versionGroup
            ? { versionGroup: opts.versionGroup, versionIndex: versionIndex ?? 1, versionActive: 1 }
            : {}),
        });
      }
      if (stopped) {
        // Abort levé en plein vol : même clôture qu'un arrêt propre
        const conversation = store.touchConversation(conversationId) ?? undefined;
        if (partial) attachArtifactCards(conversationId, [partial]);
        socket.emit("stream:done", {
          conversationId,
          messageId,
          conversation,
          message: partial ?? undefined,
          stopped: true,
          ...(variant ? { variant } : {}),
        });
      } else {
        // Erreur réelle : le partiel persisté part avec l'événement — le client
        // l'affiche dans le fil et propose « Réessayer » (F-04).
        const conversation = contentAcc || reasoningAcc
          ? store.touchConversation(conversationId) ?? undefined
          : undefined;
        if (partial) attachArtifactCards(conversationId, [partial]);
        socket.emit("stream:error", {
          conversationId,
          messageId,
          conversation,
          message: partial ?? undefined,
          error: err instanceof Error ? err.message : "Erreur inconnue du tour",
          ...(variant ? { variant } : {}),
        });
      }
    } finally {
      // Ne retire que SI c'est encore CE tour qui occupe la conversation :
      // un tour plus récent a pu prendre la place entre-temps (chat:send
      // pendant la génération — cf. ack ci-dessous) ; le retirer ici
      // casserait le chat:stop du tour actif.
      if (running.get(turnKey) === controller) {
        running.delete(turnKey);
      }
    }
  };

  socket.on(
    "chat:send",
    async (
      payload: {
        conversationId?: string;
        content?: string;
        model?: string;
        attachments?: Attachment[];
        effort?: string;
        permissionsMode?: "ask" | "auto";
        // Mode expert (F-22) — assaini avant l'envoi au moteur
        temperature?: unknown;
        maxTokens?: unknown;
        seed?: unknown;
        // Comparaison (F-17) : deux ids de modèles distincts
        compare?: string[];
        // F-09/F-12 : recherche web du tour (Tavily/Exa — ignorée en comparaison)
        webSearch?: boolean;
      },
      cb?: (data: unknown) => void
    ) => {
      const conversationId = payload?.conversationId;
      const content = (payload?.content ?? "").trim();
      const compareIds = validCompareIds(payload?.compare);
      const attachments = Array.isArray(payload?.attachments)
        ? payload!.attachments!.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
        : [];
      if (!conversationId || (!content && attachments.length === 0)) {
        if (typeof cb === "function") cb({ error: "Paramètres manquants" });
        return;
      }

      // Ack (revue 2026-11-13) : un tour en vol sur CETTE conversation → refus
      // PROPRE avec accusé d'erreur, au lieu d'aborter silencieusement le
      // tour en cours et d'entrelacer deux streams sur le même fil. Le
      // client reste maître : il peut arrêter (chat:stop) puis renvoyer.
      if (isRunning(conversationId)) {
        if (typeof cb === "function")
          cb({ error: "Un tour est déjà en cours dans cette conversation" });
        return;
      }
      if (payload?.compare !== undefined && !compareIds) {
        if (typeof cb === "function")
          cb({ error: "Comparaison : deux modèles distincts sont requis" });
        return;
      }

      // 1. Persiste le message utilisateur (avec ses pièces jointes)
      const existing = store.getMessages(conversationId);
      const isFirstUserMessage = !existing.some((m) => m.role === "user");
      const userMessage = store.appendMessage({
        conversationId,
        role: "user",
        content,
        attachments: attachments.length ? attachments : undefined,
      });
      store.touchConversation(
        conversationId,
        isFirstUserMessage ? titleFrom(content, attachments) : undefined
      );
      // Notifie le client (remplace le message optimiste par l'id réel)
      socket.emit("message:appended", { conversationId, message: userMessage });

      // 2. Lance le tour assistant (réglages additifs du chantier Composer v2).
      //    Ack positif AVANT le lancement : le tour tourne en arrière-plan,
      //    les streams suivent par les événements stream:*.
      if (typeof cb === "function")
        cb({ ok: true, message: userMessage, ...(compareIds ? { compare: true } : {}) });
      const turnSettings = {
        reasoningEffort: payload?.effort || undefined,
        permissionsMode: payload?.permissionsMode || undefined,
        ...sanitizeExpertSettings(payload),
      };
      // F-17 : comparaison — deux tours parallèles, un par modèle. Le
      // message utilisateur est unique ; chaque réponse assistant porte
      // sa variante (a/b) et son modèle.
      if (compareIds) {
        await Promise.all([
          runAssistantTurn(conversationId, {
            content,
            attachments: attachments.length ? attachments : undefined,
            modelId: compareIds[0],
            settings: turnSettings,
            variant: "a",
          }),
          runAssistantTurn(conversationId, {
            content,
            attachments: attachments.length ? attachments : undefined,
            modelId: compareIds[1],
            settings: turnSettings,
            variant: "b",
          }),
        ]);
        return;
      }
      await runAssistantTurn(conversationId, {
        content,
        attachments: attachments.length ? attachments : undefined,
        modelId: payload?.model ?? null,
        settings: turnSettings,
        webSearch: payload?.webSearch === true,
      });
    }
  );

  // Régénère la réponse : supprime les messages assistant en fin de fil
  // et relance un tour à partir du dernier message utilisateur.
  socket.on(
    "chat:regenerate",
    async (
      payload: {
        conversationId?: string;
        model?: string;
        effort?: string;
        permissionsMode?: "ask" | "auto";
        // Mode expert (F-22) — assaini avant l'envoi au moteur
        temperature?: unknown;
        maxTokens?: unknown;
        seed?: unknown;
        // F-17 : régénérer UN côté ("a"/"b") ou les deux (compare)
        variant?: "a" | "b";
        compare?: string[];
        // F-09/F-12 : recherche web du tour (Tavily/Exa — ignorée en comparaison)
        webSearch?: boolean;
      },
      cb?: (data: unknown) => void
    ) => {
      const conversationId = payload?.conversationId;
      if (!conversationId) return;
      // Garde (audit passe 3, F-02) : refuser pendant un tour en vol — la
      // troncature ci-dessous supprimerait le message que le tour rédige,
      // puis le tour aborté le ré-insérerait (message fantôme + streams
      // entrelacés). Même refus propre que chat:send (a et b compris).
      if (isRunning(conversationId)) {
        if (typeof cb === "function")
          cb({ error: "Un tour est déjà en cours dans cette conversation" });
        return;
      }
      const compareIds = validCompareIds(payload?.compare);
      if (payload?.compare !== undefined && !compareIds) {
        if (typeof cb === "function")
          cb({ error: "Comparaison : deux modèles distincts sont requis" });
        return;
      }
      if (payload?.variant && payload?.variant !== "a" && payload?.variant !== "b") {
        if (typeof cb === "function") cb({ error: "Variante invalide" });
        return;
      }
      const variant = payload?.variant;
      // F-14 : les anciennes réponses ne sont PLUS supprimées — elles
      // passent inactives (conservées, navigables ‹ n/m ›). F-17 : variante
      // donnée → un seul côté ; compare → les deux côtés.
      const { lastUser, supersededIds, groups } =
        store.supersedeTrailingAssistant(conversationId, variant);
      if (!lastUser) {
        if (typeof cb === "function") cb({ error: "Aucun message à régénérer" });
        return;
      }
      if (supersededIds.length) {
        socket.emit("messages:superseded", { conversationId, messageIds: supersededIds });
      }
      if (typeof cb === "function") cb({ ok: true });
      const turnSettings = {
        reasoningEffort: payload?.effort || undefined,
        permissionsMode: payload?.permissionsMode || undefined,
        ...sanitizeExpertSettings(payload),
      };
      if (compareIds) {
        await Promise.all([
          runAssistantTurn(conversationId, {
            content: lastUser.content,
            attachments: lastUser.attachments,
            modelId: compareIds[0],
            settings: turnSettings,
            variant: "a",
            versionGroup: groups.a,
          }),
          runAssistantTurn(conversationId, {
            content: lastUser.content,
            attachments: lastUser.attachments,
            modelId: compareIds[1],
            settings: turnSettings,
            variant: "b",
            versionGroup: groups.b,
          }),
        ]);
        return;
      }
      await runAssistantTurn(conversationId, {
        content: lastUser.content,
        attachments: lastUser.attachments,
        modelId: payload?.model ?? null,
        settings: turnSettings,
        webSearch: payload?.webSearch === true,
        variant,
        versionGroup: variant === "a" ? groups.a : variant === "b" ? groups.b : groups.plain,
      });
    }
  );

  // Modifie un message utilisateur et relance le tour depuis ce point
  socket.on(
    "message:edit",
    async (
      payload: {
        conversationId?: string;
        messageId?: string;
        content?: string;
        model?: string;
        effort?: string;
        permissionsMode?: "ask" | "auto";
        // Mode expert (F-22) — assaini avant l'envoi au moteur
        temperature?: unknown;
        maxTokens?: unknown;
        seed?: unknown;
        // Comparaison (F-17) : relance les deux variantes après édition
        compare?: string[];
        // F-09/F-12 : recherche web du tour (Tavily/Exa — ignorée en comparaison)
        webSearch?: boolean;
      },
      cb?: (data: unknown) => void
    ) => {
      const conversationId = payload?.conversationId;
      const messageId = payload?.messageId;
      const content = (payload?.content ?? "").trim();
      const compareIds = validCompareIds(payload?.compare);
      if (!conversationId || !messageId || !content) {
        if (typeof cb === "function") cb({ error: "Paramètres manquants" });
        return;
      }
      // Garde (audit passe 3, F-02) : même refus que chat:send et
      // chat:regenerate — la troncature ne doit pas courir sous un tour
      // en vol, au risque d'un message fantôme ré-inséré après coup.
      if (isRunning(conversationId)) {
        if (typeof cb === "function")
          cb({ error: "Un tour est déjà en cours dans cette conversation" });
        return;
      }
      if (payload?.compare !== undefined && !compareIds) {
        if (typeof cb === "function")
          cb({ error: "Comparaison : deux modèles distincts sont requis" });
        return;
      }
      const result = store.editUserMessageAndTruncate(conversationId, messageId, content);
      if (!result) {
        if (typeof cb === "function") cb({ error: "Message introuvable ou non modifiable" });
        return;
      }
      deleteAttachmentFiles(result.removedAttachments);
      if (typeof cb === "function")
        cb({ ok: true, message: result.message, removedIds: result.removedIds });
      socket.emit("message:updated", {
        conversationId,
        message: result.message,
        removedIds: result.removedIds,
      });
      const turnSettings = {
        reasoningEffort: payload?.effort || undefined,
        permissionsMode: payload?.permissionsMode || undefined,
        ...sanitizeExpertSettings(payload),
      };
      if (compareIds) {
        // F-17 : l'édition tronque tout ce qui suit (les deux variantes)
        // puis relance la comparaison sur le texte modifié.
        await Promise.all([
          runAssistantTurn(conversationId, {
            content,
            attachments: result.message.attachments,
            modelId: compareIds[0],
            settings: turnSettings,
            variant: "a",
          }),
          runAssistantTurn(conversationId, {
            content,
            attachments: result.message.attachments,
            modelId: compareIds[1],
            settings: turnSettings,
            variant: "b",
          }),
        ]);
        return;
      }
      await runAssistantTurn(conversationId, {
        content,
        attachments: result.message.attachments,
        modelId: payload?.model ?? null,
        settings: turnSettings,
        webSearch: payload?.webSearch === true,
      });
    }
  );

  // Supprime un message individuel
  socket.on(
    "message:delete",
    (payload: { conversationId?: string; messageId?: string }, cb?: (data: unknown) => void) => {
      const conversationId = payload?.conversationId;
      const messageId = payload?.messageId;
      if (!conversationId || !messageId) {
        if (typeof cb === "function") cb({ error: "Paramètres manquants" });
        return;
      }
      const removed = store.deleteMessage(conversationId, messageId);
      if (!removed) {
        if (typeof cb === "function") cb({ error: "Message introuvable" });
        return;
      }
      deleteAttachmentFiles(removed.attachments ?? []);
      if (typeof cb === "function") cb({ ok: true, messageId });
      socket.emit("message:deleted", { conversationId, messageId });
    }
  );

  // F-14 — naviguer entre les versions d'une réponse : la version choisie
  // devient la version active (affichée ET envoyée au modèle dans le tour
  // suivant) ; le fil entier est rediffusé à toutes les sessions.
  socket.on(
    "message:setVersion",
    (
      payload: { conversationId?: string; group?: string; index?: number },
      cb?: (data: unknown) => void
    ) => {
      const conversationId = payload?.conversationId;
      const group = payload?.group;
      const index = payload?.index;
      if (!conversationId || !group || typeof index !== "number") {
        if (typeof cb === "function") cb({ error: "Paramètres manquants" });
        return;
      }
      if (isRunning(conversationId)) {
        if (typeof cb === "function")
          cb({ error: "Un tour est en cours — attendez la fin de la génération" });
        return;
      }
      const messages = store.setMessageVersion(conversationId, group, index);
      if (!messages) {
        if (typeof cb === "function") cb({ error: "Version introuvable" });
        return;
      }
      if (typeof cb === "function") cb({ ok: true });
      io.emit("messages:refreshed", { conversationId, messages });
    }
  );

  socket.on("chat:stop", (payload: { conversationId?: string }) => {
    const id = payload?.conversationId;
    if (!id) return;
    // F-17 : stop coupe le tour simple ET les deux côtés d'une comparaison.
    const had = isRunning(id);
    abortRunning(id);
    if (had) {
      socket.emit("stream:status", { conversationId: id, messageId: null, status: "Génération interrompue" });
    }
  });

  // ── Compaction du contexte (chantier « Composer v2 ») ─────────────────
  // Résume l'historique de la conversation et conserve la synthèse en tête
  // de session : l'affichage reste intact, seul ce qui part au modèle change.
  // Aucune troncature silencieuse — le client ne déclenche que sur demande
  // explicite (bouton « Compacter » du popover de contexte).
  socket.on(
    "conversation:compact",
    async (
      payload: { conversationId?: string },
      cb?: (data: unknown) => void
    ) => {
      const conversationId = payload?.conversationId;
      if (!conversationId) {
        if (typeof cb === "function") cb({ error: "Paramètres manquants" });
        return;
      }
      if (isRunning(conversationId)) {
        if (typeof cb === "function") cb({ error: "Un tour est en cours — attendez la fin de la génération" });
        return;
      }
      const messages = store.getMessages(conversationId);
      if (messages.length < 2) {
        if (typeof cb === "function") cb({ error: "Rien à compacter : la conversation est trop courte" });
        return;
      }
      // v2.4 : UN SEUL ack, À LA FIN (avec le compact). L'ack « started »
      // intermédiaire a été retiré : socket.io n'accepte qu'un ack par
      // requête (le second appel, même id, est ignoré par le client) —
      // la compaction automatique de sendMessage repose sur cet ack final.
      try {
        const history = messages.map((m) => ({ role: m.role, content: m.content }));
        const summary = await connector.summarize(history);
        const untilMessageId = messages[messages.length - 1].id;
        store.setSetting(
          compactKey(conversationId),
          JSON.stringify({
            summary,
            at: new Date().toISOString(),
            untilMessageId,
            summarizedCount: messages.length,
          })
        );
        const compact = compactInfoWire(conversationId);
        io.emit("conversation:compacted", { conversationId, compact });
        if (typeof cb === "function") cb({ ok: true, compact, done: true });
      } catch (err) {
        console.warn(
          "[hermes-chat] compaction impossible :",
          err instanceof Error ? err.message : err
        );
        if (typeof cb === "function") {
          cb({
            ok: false,
            error: `Compaction impossible : ${err instanceof Error ? err.message : "erreur inconnue"}`,
          });
        }
        socket.emit("stream:error", {
          conversationId,
          error: `Compaction impossible : ${err instanceof Error ? err.message : "erreur inconnue"}`,
        });
      }
    }
  );

  socket.on("disconnect", () => {
    console.log(`[hermes-chat] client déconnecté : ${socket.id}`);
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
    httpServer.listen(PORT, () => {
      console.log(`[hermes-chat] service démarré sur le port ${PORT} — mode : ${connector.mode}`);
      filesServer.listen(FILES_PORT, () => {
        console.log(`[hermes-chat] service des pièces jointes démarré sur le port ${FILES_PORT}`);
      });
      if (connector.mode === "demo") {
        console.log(
          `[hermes-chat] HERMES_GATEWAY_URL non configurée ou injoignable → moteur de démo intégré`
        );
      }
      // Audit passe 3, F-04 : sans jeton, socket.io (CORS *) et le 3004 sont
      // ouverts à toute origine — acceptable en dev local ONLY.
      if (!SERVICE_TOKEN) {
        console.warn(
          `[hermes-chat] ⚠ HERMES_SERVICE_TOKEN non défini : service accessible depuis TOUTE origine (mode dev). Définir ce jeton pour tout usage exposé.`
        );
      }
    });
  })
  .catch((err) => {
    console.error("[hermes-chat] échec d'initialisation du connecteur :", err);
    httpServer.listen(PORT, () => {
      console.log(`[hermes-chat] service démarré sur le port ${PORT} — mode : ${connector.mode}`);
      filesServer.listen(FILES_PORT, () => {
        console.log(`[hermes-chat] service des pièces jointes démarré sur le port ${FILES_PORT}`);
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
