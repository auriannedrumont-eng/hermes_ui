// Handlers « settings-system » — extraits d'index.ts (découpage 2026-11, FORK.md §10).
// Pose ses socket.on(...) via register*(socket) ; les identifiants libres
// (ctx.store, ctx.io, ctx.connector, helpers du tour, vues wire) viennent du contexte
// partagé handlers/context.ts — câblé une fois par index.ts.
import type { Socket } from "socket.io";
import { ctx } from "./context";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Vérification de mise à jour (carte Système — v0.3.0) ─────────────────
// La révision installée est lue DIRECTEMENT dans .git (HEAD, puis la ref
// résolue — même logique que readAppRevision d'index.ts, sans dépendre du
// binaire git : le service doit répondre même sur une installation sans
// git au PATH). La pointe de la branche principale vient de l'API publique
// GitHub (aucune authentification : le dépôt est le canal de dépôt).
const GITHUB_REPO = "auriannedrumont-eng/hermes_ui";

/** Révision git installée (7 caractères) — null si .git illisible. */
function readInstalledRevision(): string | null {
  try {
    let gitDir = join(import.meta.dir, "..", "..", "..", ".git");
    // Worktree git : .git est un fichier « gitdir: … » — le suivre.
    try {
      const link = readFileSync(gitDir, "utf8").trim();
      const m = link.match(/^gitdir:\s*(\S+)/);
      if (m) gitDir = m[1];
    } catch {
      /* .git standard (dossier) — rien à suivre */
    }
    let head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!/^ref:\s*(\S+)/.test(head)) {
      return /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 7) : null;
    }
    const ref = head.match(/^ref:\s*(\S+)/)![1];
    try {
      return readFileSync(join(gitDir, ref), "utf8").trim().slice(0, 7) || null;
    } catch {
      // Référence compactée (packed-refs).
      const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
      const sha = line?.split(" ")[0] ?? "";
      return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : null;
    }
  } catch {
    return null;
  }
}

/** Pointe de main sur GitHub (7 caractères) — null si injoignable.
 *  Sonde via le point info/refs du protocole git (github.com, SANS l'API
 *  api.github.com) : l'API publique est largement rate-limitée (60 req/h
 *  par IP, épuisées dès qu'une même IP partage plusieurs utilisateurs —
 *  constaté en bac à sable : « available » retournait null par erreur) ;
 *  info/refs sert le même SHA sans quota et sans authentification. */
/** Base de l'URL de sonde — github.com en production ; variable réservée
 *  aux tests (HERMES_UPDATE_TEST_URL) : stub local qui sert le même format
 *  pkt-line, pour prouver la détection « version future » sans réseau. */
function updateProbeBase(): string {
  return process.env.HERMES_UPDATE_TEST_URL ?? "https://github.com";
}

async function fetchRemoteRevision(): Promise<string | null> {
  const base = updateProbeBase();
  const urls = [
    `${base}/${GITHUB_REPO}.git/info/refs?service=git-upload-pack`,
    `https://api.github.com/repos/${GITHUB_REPO}/commits/main`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      // info/refs : pkt-lines « 001e# service=git-upload-pack… » puis
      // « 003f<sha> HEAD\x00caps… » — commence par un en-tête hexa (jamais
      // par '{') ; API JSON : { "sha": "…" }.
      let sha = "";
      if (!text.trimStart().startsWith("{")) {
        const m = text.match(/([0-9a-f]{40})\s+HEAD/m);
        sha = m?.[1] ?? "";
      } else {
        try {
          sha = ((await JSON.parse(text)) as { sha?: string }).sha ?? "";
        } catch {
          sha = "";
        }
      }
      if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 7);
    } catch {
      /* essai suivant */
    }
  }
  return null;
}

/** État de mise à jour connu du service — LA source unique diffusée aux
 *  clients (hello + system:update-state) et lue par la carte Système.
 *  Le service ne dépend plus de l'ouverture de la page pour vérifier :
 *  vérification au démarrage puis toutes les 6 h (v0.3.3, demande
 *  utilisatrice : « je ne suis informé d'aucune mise à jour disponible »). */
interface UpdateState {
  installed: string | null;
  available: string | null;
  checkedAt: string | null;
  error: string | null;
}
let updateState: UpdateState = {
  installed: null,
  available: null,
  checkedAt: null,
  error: null,
};

/** Exécute la vérification, met à jour l'état partagé et le diffuse. */
async function refreshUpdateState(): Promise<void> {
  const installed = readInstalledRevision();
  try {
    const remote = await fetchRemoteRevision();
    updateState = {
      installed,
      available: remote !== null && remote !== installed ? remote : null,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch {
    // Hors ligne / dépôt injoignable : erreur honnête, jamais un état figé.
    updateState = { installed, available: null, checkedAt: null, error: "Dépôt GitHub injoignable." };
  }
  try {
    ctx.io.emit("system:update-state", { ...updateState });
  } catch {
    /* io pas encore prêt au tout premier appel (démarrage) */
  }
}

/** Verdict de la carte Mise à jour : à jour / disponible / erreur. */
async function checkUpdate(cb?: (data: unknown) => void): Promise<void> {
  await refreshUpdateState();
  if (typeof cb === "function") cb({ ...updateState });
}

/** Lance la vérification périodique (démarrage + 6 h). Appelé par index.ts. */
export function startUpdateWatchdog(): void {
  void refreshUpdateState();
  setInterval(() => void refreshUpdateState(), 6 * 60 * 60 * 1000).unref?.();
}

/** État courant — lu par helloPayload (index.ts). */
export function currentUpdateState(): UpdateState {
  return updateState;
}

export function registerSettingsSystemHandlers(socket: Socket) {

// ── Réglages serveur (persistés, cf. FORK.md §6) ────────────────────

socket.on(
  "settings:get",
  (payload: { key?: string }, cb?: (data: unknown) => void) => {
    const key = String(payload?.key ?? "").trim();
    if (!key) {
      // (audit 2026-11-21) La vue liste ne doit JAMAIS exposer les clés
      // secrètes : hermes.gateway.token est le jeton Bearer de la gateway,
      // stocké en clair en base et volontairement masqué partout ailleurs
      // (gateway:get ne renvoie que tokenSet). Sans ce filtre, tout client
      // socket récupérait le jeton intact via la liste.
      const settings = ctx.store
        .listSettings()
        .filter((s) => s.key !== ctx.GATEWAY_TOKEN_KEY);
      if (typeof cb === "function") cb({ settings });
      return;
    }
    // (audit 2026-11-21) Lecture directe de la clé secrète interdite :
    // seul l'indicateur « défini ou non » sort, jamais la valeur.
    if (key === ctx.GATEWAY_TOKEN_KEY) {
      if (typeof cb === "function")
        cb({
          key,
          value: null,
          tokenSet: Boolean((ctx.store.getSetting(key) ?? "").trim()),
        });
      return;
    }
    if (typeof cb === "function") cb({ key, value: ctx.store.getSetting(key) });
  }
);


socket.on(
  "settings:set",
  (payload: { key?: string; value?: string }, cb?: (data: unknown) => void) => {
    const key = String(payload?.key ?? "").trim();
    // (audit 2026-11-21) payload réseau : value non-chaîne (objet, nombre)
    // levait dans le binding bun:sqlite et tuait le process — garde explicite.
    const value = typeof payload?.value === "string" ? payload.value : "";
    if (!key) {
      if (typeof cb === "function") cb({ error: "key requise" });
      return;
    }
    // (audit 2026-11-21) Le jeton gateway ne s'écrit QUE via gateway:set
    // (qui valide et notifie le connecteur) — pas en écrivant direct la clé.
    if (key === ctx.GATEWAY_TOKEN_KEY) {
      if (typeof cb === "function")
        cb({ error: "clé réservée — passer par gateway:set" });
      return;
    }
    ctx.store.setSetting(key, value);
    if (typeof cb === "function") cb({ ok: true, key, value });
    ctx.io.emit("settings:changed", { key, value });
  }
);


// ── Gateway Hermes (Paramètres → Système) : brancher l'agent réel ───
// URL ws:// ou http(s):// (le /api/ws est ajouté au besoin côté connecteur)
// + jeton facultatif. Chaîne vide = débranchement. Persisté dans settings :
// survit aux redémarrages ; l'URL saisie PRIME sur HERMES_GATEWAY_URL.
socket.on("gateway:get", (cb?: (data: unknown) => void) => {
  if (typeof cb === "function")
    cb({
      url: ctx.connector.gatewayUrl,
      tokenSet: Boolean(ctx.connector.gatewayToken),
      mode: ctx.connector.mode,
    });
});

socket.on(
  "gateway:set",
  async (
    payload: { url?: unknown; token?: unknown },
    cb?: (data: unknown) => void
  ) => {
    const done = (res: Record<string, unknown>) => {
      if (typeof cb === "function") cb(res);
    };
    const url = typeof payload?.url === "string" ? payload.url.trim() : "";
    if (url && !/^(ws|wss|http|https):\/\//i.test(url)) {
      done({ ok: false, error: "URL invalide — attendu ws://… ou http(s)://…" });
      return;
    }
    // S-02 (SSRF) : la gateway n'est branchable que sur le poste local ou
    // une origine https explicite — jamais http:// vers le réseau local
    // (metadata, box, intranet), même si l'utilisateur copie-colle une
    // telle URL. ws:// reste permis uniquement en loopback.
    if (url) {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        const isLoopback =
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "::1" ||
          host === "[::1]";
        const schemeOk =
          parsed.protocol === "https:" ||
          (parsed.protocol === "wss:" && host !== "localhost") ||
          isLoopback;
        if (!schemeOk) {
          done({
            ok: false,
            error:
              "URL refusée : la gateway distante doit être en https:// ou wss:// (http:// et ws:// ne sont permis que sur ce poste)",
          });
          return;
        }
      } catch {
        done({ ok: false, error: "URL illisible" });
        return;
      }
    }
    const token = typeof payload?.token === "string" ? payload.token : undefined;
    try {
      // S-02 : lire l'ancienne URL AVANT d'écrire la nouvelle — l'ancien code
      // comparait à la ligne fraîchement écrite, donc urlChanged valait
      // toujours false et le jeton persisté n'était jamais effacé quand
      // l'URL changeait sans nouveau jeton.
      const previousSavedUrl = (ctx.store.getSetting(ctx.GATEWAY_URL_KEY) ?? "").trim();
      const urlChanged = Boolean(url && url !== previousSavedUrl);
      const mode = await ctx.connector.setGateway(url || null, token);
      ctx.store.setSetting(ctx.GATEWAY_URL_KEY, url);
      // S-02 : si l'URL a changé sans nouveau jeton, setGateway a effacé le
      // jeton en mémoire — la ligne persistée suit (pas de jeton fantôme
      // qui repartirait vers la nouvelle destination au redémarrage).
      // F-02.3 : un jeton saisi POUR le défaut automatique (URL vide) est
      // persisté aussi — il survit au redémarrage du service.
      if (token !== undefined) ctx.store.setSetting(ctx.GATEWAY_TOKEN_KEY, token.trim());
      else if (urlChanged || !url) ctx.store.setSetting(ctx.GATEWAY_TOKEN_KEY, "");
      console.log(
        `[hermes-chat] gateway ${url ? `"${url}"` : "débranchée"} → mode : ${mode}`
      );
      // Statut + modèles suivent en direct (même idiome que le porte-clés)
      ctx.io.emit("hello", ctx.helloPayload());
      ctx.io.emit("models:changed", {});
      done({
        ok: true,
        mode,
        url: ctx.connector.gatewayUrl,
        tokenSet: Boolean(ctx.connector.gatewayToken),
      });
    } catch (err) {
      done({
        ok: false,
        error: err instanceof Error ? err.message : "Échec de la sonde gateway",
      });
    }
  }
);


// ── Mise à jour depuis l'interface : demande + JOURNAL LIVE ────────────
// Dépose un drapeau que le lanceur (desktop/hermes-ui.ps1 | .sh — boucle
// de surveillance) ramasse : arrêt propre, mise à jour GitHub,
// reconstruction si besoin, relance SANS réouvrir le navigateur. Le
// lanceur raconte chaque étape dans desktop/runtime/maj.log (marqueurs
// terminaux « MAJ OK » / « MAJ ERREUR ») — le service RELAIT ce journal
// en direct (system:update-log:changed) : l'utilisateur voit le déroulé
// au lieu de croiser les doigts. Sans lanceur vivant (ou lanceur trop
// ancien pour connaître le drapeau), rien ne bouge : l'interface le
// détecte et l'affiche — le prochain démarrage efface le drapeau.
socket.on("system:update-request", (cb?: (data: unknown) => void) => {
  const done = (res: Record<string, unknown>) => {
    if (typeof cb === "function") cb(res);
  };
  try {
    // B-2 (audit v3) : une demande déjà en vol (drapeau posé, pas encore
    // ramassé par le lanceur — cycle ≤ 15 s) ne doit PAS reprendre d'une
    // page blanche : un second clic, un second client, un double-clic —
    // le journal en cours raconte déjà une mise à jour, on ne l'écrase pas.
    // On répond « déjà en cours » : l'interface affiche le journal existant
    // au lieu d'un faux départ.
    if (existsSync(ctx.majFlag)) {
      done({ ok: true, alreadyRunning: true });
      return;
    }
    mkdirSync(join(ctx.majFlag, ".."), { recursive: true });
    writeFileSync(ctx.majFlag, String(Date.now()), "utf-8");
    // Le journal démarre ICI : une demande neuve repart d'une page blanche,
    // et l'interface a aussitôt quelque chose à afficher (ligne d'attente).
    const stamp = new Date().toLocaleTimeString("fr-FR", { hour12: false });
    writeFileSync(ctx.majLog, `[${stamp}] Demande déposée depuis l'interface — attente du lanceur (cycle de surveillance ≤ 15 s)…\n`, "utf-8");
    ctx.majLogSig = "";
    console.log("[hermes-chat] mise à jour demandée depuis l'interface (drapeau posé, journal démarré)");
    done({ ok: true });
  } catch (err) {
    done({
      ok: false,
      error: err instanceof Error ? err.message : "drapeau de mise à jour non posé",
    });
  }
});
// Lecture à la demande (montage du panneau, reconnexion socket après que
// le lanceur a relancé la pile).
socket.on("system:update-log", (cb?: (data: unknown) => void) => {
  if (typeof cb === "function") cb(ctx.majLogRead());
});
// (Le relais en direct system:update-log:changed vit au niveau du module —
// un seul intervalle pour tout le service, cf. déclaration ci-dessus.)

// ── Système (v2.4) : profils de rendu Chrome — sonde réelle ─────────
// Le cache des rendus, ce sont les profils « hermes-chrome-* » du tmp :
// régénérés à chaque rendu, purgés au démarrage du service. Jamais de
// données simulées — count/bytes viennent du système de fichiers.
socket.on("system:renderCache", (cb?: (data: unknown) => void) => {
  if (typeof cb === "function") cb({ ...ctx.chromeProfileStats() });
});

socket.on("system:clearRenderCache", (cb?: (data: unknown) => void) => {
  const { removed, kept } = ctx.clearChromeProfiles();
  if (typeof cb === "function")
    cb({ ...ctx.chromeProfileStats(), removed, kept });
});

// ── Chats IA web (fournisseur webchat) : sondes et navigateur de pilotage ──
// Le profil est DÉDIÉ à l'application : l'utilisateur se connecte aux sites
// UNE fois, à la main (bouton « Ouvrir le navigateur ») — le code ne saisit
// ni ne stocke jamais un identifiant. Fermeture : veilleur d'inactivité ou
// bouton « Fermer » — toujours vérifiée par la chaîne --user-data-dir du
// profil applicatif (le navigateur personnel n'est jamais visé).
socket.on("webchat:status", async (cb?: (data: unknown) => void) => {
  if (typeof cb === "function") cb(await ctx.webchatStatus(ctx.store));
});

socket.on(
  "webchat:open",
  async (payload: { site?: string }, cb?: (data: unknown) => void) => {
    try {
      const config = ctx.readWebchatConfig(ctx.store);
      const fiche = payload?.site && ctx.FICHES[payload.site as keyof typeof ctx.FICHES]
        ? ctx.FICHES[payload.site as keyof typeof ctx.FICHES]
        : null;
      const ensured = await ctx.ensureBrowser({
        port: config.port,
        profileDir: config.profileDir,
        browserPath: config.browserPath || undefined,
      });
      if (!ensured.up) {
        if (typeof cb === "function") cb({ error: ensured.error ?? "navigateur indisponible" });
        return;
      }
      // Onglet du site demandé (ou simple onglet vide pour se connecter).
      const targets = await ctx.listTargets(config.port);
      const existing = fiche ? ctx.findTab(targets, fiche.onglet_match) : null;
      if (!existing) {
        await ctx.newTab(config.port, fiche?.url_accueil ?? "about:blank");
      }
      ctx.touchActivity(config.profileDir);
      ctx.launchWatchdog(config.profileDir, config.idleMin);
      if (typeof cb === "function")
        cb({
          ok: true,
          pid: ensured.pid ?? ctx.readPilotInfo(config.profileDir)?.pid ?? null,
          port: config.port,
        });
    } catch (err) {
      if (typeof cb === "function")
        cb({ error: err instanceof Error ? err.message : "ouverture impossible" });
    }
  }
);


socket.on("webchat:close", async (cb?: (data: unknown) => void) => {
  const config = ctx.readWebchatConfig(ctx.store);
  const info = ctx.readPilotInfo(config.profileDir);
  if (!info || info.pid <= 0) {
    if (typeof cb === "function") cb({ ok: true, closed: false });
    return;
  }
  const closed = await ctx.killPilotBrowser(info.pid, config.profileDir);
  if (typeof cb === "function") cb({ ok: true, closed });
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
    if (typeof cb === "function") cb({ prompt: ctx.conversationPromptWire(id) });
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
    const invalid = ctx.validatePromptText(content, ctx.MAX_PROMPT_CHARS);
    if (invalid) {
      if (typeof cb === "function") cb({ error: invalid });
      return;
    }
    ctx.store.setConversationPrompt(
      id,
      content,
      payload?.presetTitle ? String(payload.presetTitle).slice(0, 80) : null
    );
    if (typeof cb === "function") cb({ prompt: ctx.conversationPromptWire(id) });
    ctx.broadcastSystemPrompt(id);
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
    ctx.store.clearConversationPrompt(id);
    if (typeof cb === "function") cb({ ok: true, prompt: null });
    ctx.broadcastSystemPrompt(id);
  }
);


// Bibliothèque de presets réutilisables (section Hermes du volet)
socket.on("system-prompts:list", (cb?: (data: unknown) => void) => {
  if (typeof cb === "function")
    cb({ presets: ctx.store.listPromptPresets().map(ctx.rowToPreset) });
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
    const invalid = ctx.validatePromptText(content, ctx.MAX_PROMPT_CHARS);
    if (invalid) {
      if (typeof cb === "function") cb({ error: invalid });
      return;
    }
    const row = ctx.store.createPromptPreset(title.slice(0, 80), content);
    if (typeof cb === "function") cb({ preset: ctx.rowToPreset(row) });
    ctx.broadcastSystemPrompts();
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
    const invalid = ctx.validatePromptText(content, ctx.MAX_PROMPT_CHARS);
    if (invalid) {
      if (typeof cb === "function") cb({ error: invalid });
      return;
    }
    const row = ctx.store.updatePromptPreset(id, title.slice(0, 80), content);
    if (!row) {
      if (typeof cb === "function") cb({ error: "Preset introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ preset: ctx.rowToPreset(row) });
    ctx.broadcastSystemPrompts();
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
    const ok = ctx.store.deletePromptPreset(id);
    if (!ok) {
      if (typeof cb === "function") cb({ error: "Preset introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ ok: true });
    ctx.broadcastSystemPrompts();
  }
);


// Instructions personnalisées globales (F-19) — registre serveur §6
socket.on(
  "custom-instructions:get",
  (cb?: (data: unknown) => void) => {
    if (typeof cb === "function")
      cb({
        value: ctx.store.getSetting(ctx.CUSTOM_INSTRUCTIONS_KEY) ?? "",
        maxChars: ctx.MAX_CUSTOM_INSTRUCTIONS_CHARS,
      });
  }
);


socket.on(
  "custom-instructions:set",
  (payload: { value?: string }, cb?: (data: unknown) => void) => {
    const value = (payload?.value ?? "").trim();
    if (value.length > ctx.MAX_CUSTOM_INSTRUCTIONS_CHARS) {
      if (typeof cb === "function")
        cb({
          error: `Trop long (max ${ctx.MAX_CUSTOM_INSTRUCTIONS_CHARS.toLocaleString("fr-FR")} caractères)`,
        });
      return;
    }
    ctx.store.setSetting(ctx.CUSTOM_INSTRUCTIONS_KEY, value);
    if (typeof cb === "function") cb({ ok: true, value });
    ctx.io.emit("custom-instructions:changed", { value });
  }
);


// ── Mémoire utilisateur (F-18) — consultable, éditable, effaçable ───
// Notes persistantes injectées dans les instructions du tour tant que la
// mémoire est active. Jamais un mot-clé magique : la composition reste
// le fait du service (prompts.ts), le client n'assemble rien.

// Robuste à l'arité du client : l'ack est le DERNIER argument fonction —
// un client qui émettrait un payload superflu (ex. undefined sérialisé en
// null) ne doit pas casser la réponse (cf. emit-ack.ts, piège du fil).
socket.on("memory:get", (...args: unknown[]) => {
  const cb = args.find((a) => typeof a === "function") as
    | ((data: unknown) => void)
    | undefined;
  if (typeof cb === "function")
    cb({
      enabled: ctx.store.getSettingBool(ctx.MEMORY_ENABLED_KEY, true),
      autoLearn: ctx.store.getSettingBool(ctx.MEMORY_AUTO_KEY, false),
      notes: ctx.store.getSetting(ctx.MEMORY_NOTES_KEY) ?? "",
      maxChars: ctx.MAX_MEMORY_CHARS,
    });
});

socket.on(
  "memory:set-enabled",
  (payload: { enabled?: boolean }, cb?: (data: unknown) => void) => {
    const enabled = payload?.enabled === true;
    ctx.store.setSettingBool(ctx.MEMORY_ENABLED_KEY, enabled);
    if (typeof cb === "function") cb({ ok: true, enabled });
    ctx.io.emit("memory:changed", { enabled });
  }
);


socket.on(
  "memory:set-auto",
  (payload: { autoLearn?: boolean }, cb?: (data: unknown) => void) => {
    const autoLearn = payload?.autoLearn === true;
    ctx.store.setSettingBool(ctx.MEMORY_AUTO_KEY, autoLearn);
    if (typeof cb === "function") cb({ ok: true, autoLearn });
    ctx.io.emit("memory:changed", { autoLearn });
  }
);


// ── Carte Mise à jour du volet Système (v0.3.0, spec §3.1) ──────────
// Vraie vérification : la révision installée (HEAD lu dans .git, sans
// dépendre du binaire git) est comparée à la pointe de main sur GitHub.
// v0.3.3 : l'état est partagé (refreshUpdateState) — le service vérifie
// de lui-même (démarrage + 6 h) et diffuse system:update-state ; le
// client sans page Système ouverte est informé (point sur l'engrenage,
// toast une fois par session). Réponse honnête : à jour / disponible /
// erreur — jamais de « Vérification… » éternel côté interface.
socket.on("system:update-check", (cb?: (data: unknown) => void) => {
  void checkUpdate(cb);
});

socket.on(
  "memory:set-notes",
  (payload: { value?: string }, cb?: (data: unknown) => void) => {
    const value = (payload?.value ?? "").trim();
    if (value.length > ctx.MAX_MEMORY_CHARS) {
      if (typeof cb === "function")
        cb({
          error: `Trop long (max ${ctx.MAX_MEMORY_CHARS.toLocaleString("fr-FR")} caractères)`,
        });
      return;
    }
    ctx.store.setSetting(ctx.MEMORY_NOTES_KEY, value);
    if (typeof cb === "function") cb({ ok: true, value });
    ctx.io.emit("memory:changed", { notes: value });
  }
);

}
