// Service de chat Hermes Web — socket.io sur le port 3003
// Événements client -> serveur :
//   hello, conversations:list/create/rename/delete/open/pin/fork/search,
//   chat:send, chat:stop, chat:regenerate,
//   message:edit, message:delete,
//   models:list, attachments:upload, audio:transcribe,
//   artifacts:list, artifact:versions, artifact:retry
// Événements serveur -> client :
//   stream:start, stream:delta, stream:reasoning, stream:status, stream:tool,
//   stream:done, stream:error, message:appended, message:deleted,
//   conversations:created, conversations:pinned,
//   artifact:created, artifact:delta, artifact:updated
// HTTP (port 3004) :
//   GET /uploads/<id>.<ext>            — pièces jointes multimédia
//   GET /artifacts/<id>/raw|download|thumb|pdf
//   GET /artifacts/zip?ids=a,b,c       — archive de plusieurs artefacts
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Server } from "socket.io";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Store, type ArtifactRow } from "./store";
import { HermesConnector } from "./hermes-connector";
import { modelLabel } from "./models";
import { transcribeAudioBase64 } from "./asr";
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
import { chromeRenderer } from "./render";
import type { Artifact, Attachment, ChatMessage, ToolEvent } from "./types";

const PORT = 3003;
const FILES_PORT = 3004; // service HTTP dédié aux pièces jointes
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

// ── Service HTTP : pièces jointes + artefacts (port 3004) ────────────────
const filesServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== "GET" || !req.url) {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Méthode non autorisée");
    return;
  }
  const u = new URL(req.url, "http://localhost");

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

const store = new Store();
const connector = new HermesConnector();

// Tours en cours : conversationId -> AbortController
const running = new Map<string, AbortController>();

function titleFrom(text: string, attachments?: Attachment[]): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean) return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
  const first = attachments?.[0];
  if (first) return first.name.slice(0, 48);
  return "Nouvelle conversation";
}

function helloPayload() {
  return {
    app: "hermes-web",
    version: "1.1.0",
    mode: connector.mode,
    model: connector.model,
    gatewayUrl: connector.gatewayUrl,
  };
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
    running.get(id)?.abort();
    // Nettoyage disque des pièces jointes et des artefacts de la conversation
    const attachments = store.conversationAttachments(id);
    const artifactRows = store.deleteConversationArtifacts(id);
    deleteAttachmentFiles(attachments);
    deleteArtifactFiles(artifactRows);
    store.deleteConversation(id);
    if (typeof cb === "function") cb({ ok: true, id });
    socket.emit("conversations:deleted", { id });
  });

  socket.on("conversations:open", (payload: { id?: string }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id) return;
    const messages = store.getMessages(id);
    attachArtifactCards(id, messages);
    if (typeof cb === "function") cb({ conversationId: id, messages });
    else socket.emit("conversations:messages", { conversationId: id, messages });
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

  /**
   * Exécute un tour assistant complet : stream, événements d'outils,
   * raisonnement, persistance. Utilisé par chat:send, chat:regenerate
   * et message:edit. Le dernier message utilisateur du fil sert de contenu.
   */
  const runAssistantTurn = async (
    conversationId: string,
    opts: { content: string; attachments?: Attachment[]; modelId?: string | null }
  ) => {
    // Un seul tour actif par conversation
    running.get(conversationId)?.abort();
    const controller = new AbortController();
    running.set(conversationId, controller);

    // 0. Résout le modèle sélectionné (libellé d'affichage)
    const model = opts.modelId ? modelLabel(opts.modelId) || opts.modelId : null;
    const attachments = opts.attachments?.length ? opts.attachments : undefined;

    // 1. Prépare le tour assistant
    const messageId = crypto.randomUUID();
    socket.emit("stream:start", { conversationId, messageId, model });

    // Historique : tout ce qui précède le dernier message utilisateur
    const existing = store.getMessages(conversationId);
    let lastUserIdx = -1;
    for (let i = existing.length - 1; i >= 0; i--) {
      if (existing[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const history = existing
      .slice(0, lastUserIdx >= 0 ? lastUserIdx : existing.length)
      .slice(-MAX_HISTORY)
      .map((m: ChatMessage) => ({ role: m.role, content: m.content }));

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

    try {
      const result = await connector.runTurn(
        {
          content: opts.content,
          history,
          model,
          modelId: opts.modelId,
          attachments,
        },
        {
          signal: controller.signal,
          onDelta: (delta) => {
            contentAcc += delta;
            const now = Date.now();
            // Coalescence légère des deltas très rapprochés
            if (now - lastEmit > 16) {
              lastEmit = now;
              socket.emit("stream:delta", { conversationId, messageId, delta: contentAcc.slice(lastSent) });
              lastSent = contentAcc.length;
              // Naissance / progression des artefacts du tour
              tracker.update(contentAcc);
            }
          },
          onReasoning: (delta) => {
            reasoningAcc += delta;
            socket.emit("stream:reasoning", { conversationId, messageId, delta });
          },
          onStatus: (status) => {
            socket.emit("stream:status", { conversationId, messageId, status });
          },
          onToolEvent: (event) => {
            const toolEvent: ToolEvent = { ...event, at: new Date().toISOString() };
            toolEvents.push(toolEvent);
            socket.emit("stream:tool", { conversationId, messageId, event: toolEvent });
          },
        }
      );

      // Flush final du contenu restant
      contentAcc = result.content || contentAcc;
      reasoningAcc = result.reasoning || reasoningAcc;
      if (result.model) {
        usedModel = connector.mode === "demo" ? `${result.model} (démo)` : result.model;
      }
      if (lastSent < contentAcc.length) {
        socket.emit("stream:delta", {
          conversationId,
          messageId,
          delta: contentAcc.slice(lastSent),
        });
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
      };
      // Cartes d'artefacts ancrées sur ce message (celles créées par ce tour)
      attachArtifactCards(conversationId, [doneMessage]);
      socket.emit("stream:done", {
        conversationId,
        messageId,
        conversation,
        message: doneMessage,
      });
    } catch (err) {
      // Sauvegarde du partiel déjà reçu
      tracker.finalize(contentAcc, true);
      if (contentAcc || reasoningAcc) {
        store.appendMessage({
          id: messageId,
          conversationId,
          role: "assistant",
          content: contentAcc || "(interrompu)",
          reasoning: reasoningAcc || undefined,
          toolEvents: toolEvents.length ? toolEvents : undefined,
          model: usedModel,
        });
      }
      socket.emit("stream:error", {
        conversationId,
        messageId,
        error: err instanceof Error ? err.message : "Erreur inconnue du tour",
      });
    } finally {
      running.delete(conversationId);
    }
  };

  socket.on(
    "chat:send",
    async (payload: {
      conversationId?: string;
      content?: string;
      model?: string;
      attachments?: Attachment[];
    }) => {
      const conversationId = payload?.conversationId;
      const content = (payload?.content ?? "").trim();
      const attachments = Array.isArray(payload?.attachments)
        ? payload!.attachments!.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
        : [];
      if (!conversationId || (!content && attachments.length === 0)) return;

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

      // 2. Lance le tour assistant
      await runAssistantTurn(conversationId, {
        content,
        attachments: attachments.length ? attachments : undefined,
        modelId: payload?.model ?? null,
      });
    }
  );

  // Régénère la réponse : supprime les messages assistant en fin de fil
  // et relance un tour à partir du dernier message utilisateur.
  socket.on(
    "chat:regenerate",
    async (payload: { conversationId?: string; model?: string }, cb?: (data: unknown) => void) => {
      const conversationId = payload?.conversationId;
      if (!conversationId) return;
      const { lastUser, removedIds, removedAttachments } =
        store.deleteTrailingAssistant(conversationId);
      if (!lastUser) {
        if (typeof cb === "function") cb({ error: "Aucun message à régénérer" });
        return;
      }
      deleteAttachmentFiles(removedAttachments);
      if (removedIds.length) {
        socket.emit("messages:removed", { conversationId, messageIds: removedIds });
      }
      if (typeof cb === "function") cb({ ok: true });
      await runAssistantTurn(conversationId, {
        content: lastUser.content,
        attachments: lastUser.attachments,
        modelId: payload?.model ?? null,
      });
    }
  );

  // Modifie un message utilisateur et relance le tour depuis ce point
  socket.on(
    "message:edit",
    async (
      payload: { conversationId?: string; messageId?: string; content?: string; model?: string },
      cb?: (data: unknown) => void
    ) => {
      const conversationId = payload?.conversationId;
      const messageId = payload?.messageId;
      const content = (payload?.content ?? "").trim();
      if (!conversationId || !messageId || !content) {
        if (typeof cb === "function") cb({ error: "Paramètres manquants" });
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
      await runAssistantTurn(conversationId, {
        content,
        attachments: result.message.attachments,
        modelId: payload?.model ?? null,
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

  socket.on("chat:stop", (payload: { conversationId?: string }) => {
    const id = payload?.conversationId;
    if (!id) return;
    const controller = running.get(id);
    if (controller) {
      controller.abort();
      socket.emit("stream:status", { conversationId: id, messageId: null, status: "Génération interrompue" });
    }
  });

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

process.on("SIGTERM", () => {
  chromeRenderer.shutdown();
  httpServer.close(() => process.exit(0));
  filesServer.close();
});
process.on("SIGINT", () => {
  chromeRenderer.shutdown();
  httpServer.close(() => process.exit(0));
  filesServer.close();
});
