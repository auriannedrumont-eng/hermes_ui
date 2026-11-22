// Handlers « conversations » — extraits d'index.ts (découpage 2026-11, FORK.md §10).
// Pose ses socket.on(...) via register*(socket) ; les identifiants libres
// (ctx.store, ctx.io, ctx.connector, helpers du tour, vues wire) viennent du contexte
// partagé handlers/context.ts — câblé une fois par index.ts.
import type { Socket } from "socket.io";
import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import { ctx } from "./context";
import type { Attachment, TurnSettings } from "../types";
import type { ModeConfig } from "../modes";

/** F-59 (J5) : valide un chemin de liaison disque — dossier EXISTANT, borné
 *  au HOME de l'utilisateur (realpath suit les liens symboliques AVANT la
 *  vérification), jamais de chemin arbitraire (plan D4, sémantique minimale). */
function validDiskPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const home = realpathSync(homedir());
    const target = realpathSync(raw);
    if (target !== home && !target.startsWith(home + sep)) return null;
    if (!statSync(target).isDirectory()) return null;
    return target;
  } catch {
    return null;
  }
}

export function registerConversationsHandlers(socket: Socket) {

socket.on("conversations:list", (cb?: (data: unknown) => void) => {
  const conversations = ctx.store.listConversations();
  if (typeof cb === "function") cb({ conversations });
  else socket.emit("conversations:list", { conversations });
});

socket.on(
  "conversations:create",
  (
    payload:
      | { projectId?: string | null; mode?: string; modeConfig?: unknown }
      | ((data: unknown) => void),
    maybeCb?: (data: unknown) => void
  ) => {
    // Compat : emit("conversations:create", cb) sans payload
    const cb = typeof payload === "function" ? payload : maybeCb;
    const src = payload && typeof payload === "object" ? payload : {};
    const projectId = src.projectId ?? null;
    // F-30 : le mode des nouvelles conversations part du client (réglage
    // hermes.modes.defaultMode) — résolu et borné ici (valeur inconnue → chat).
    const mode = ctx.resolveMode(src.mode);
    const modeConfig = ctx.normalizeModeConfig(src.modeConfig);
    const rounds = mode === "debate" ? (modeConfig.rounds ?? null) : null;
    const conversation = ctx.store.createConversation(
      "Nouvelle conversation",
      projectId,
      mode === "chat" ? undefined : mode,
      rounds,
      Object.keys(modeConfig).length ? modeConfig : null,
    );
    if (typeof cb === "function") {
      cb({ conversation });
      // Autres onglets/sessions : le créateur a son ack — les fenêtres
      // restées ouvertes suivent (socket.emit n'atteignait que l'émetteur).
      socket.broadcast.emit("conversations:created", { conversation });
    } else ctx.io.emit("conversations:created", { conversation });
  }
);


// ── Modes du compositeur (F-30) : change le mode d'une conversation ──
// Le client ne décide pas du traitement : il demande, le service résout
// (valeur inconnue → chat), borne les nombres et persiste. Diffusé à
// toutes les sessions — deux fenêtres suivent le même mode en direct.
socket.on(
  "conversations:setMode",
  (
    payload: {
      conversationId?: string;
      mode?: string;
      config?: unknown;
    },
    cb?: (data: unknown) => void
  ) => {
    const conversationId = payload?.conversationId;
    if (!conversationId) {
      if (typeof cb === "function") cb({ error: "conversationId requis" });
      return;
    }
    const mode = ctx.resolveMode(payload?.mode);
    const config = ctx.normalizeModeConfig(payload?.config);
    const rounds = mode === "debate" ? (config.rounds ?? null) : null;
    const conversation = ctx.store.setConversationMode(
      conversationId,
      mode,
      rounds,
      Object.keys(config).length ? config : null,
    );
    if (!conversation) {
      if (typeof cb === "function") cb({ error: "Conversation introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ ok: true, conversation });
    ctx.io.emit("conversations:mode", {
      conversationId,
      mode,
      rounds,
      config,
      conversation,
    });
  }
);


socket.on("conversations:rename", (payload: { id?: string; title?: string }, cb?: (data: unknown) => void) => {
  const id = payload?.id;
  // (audit 2026-11-21) payload réseau : title peut arriver non-chaîne
  // (client bogué) — .trim() sur un nombre levait un TypeError qui tuait
  // le process (socket.io n'isole pas les listeners).
  const title = String(payload?.title ?? "").trim();
  if (!id || !title) {
    if (typeof cb === "function") cb({ error: "id et title requis" });
    return;
  }
  const conversation = ctx.store.renameConversation(id, title.slice(0, 120));
  if (typeof cb === "function") cb({ conversation });
  // F-14 (broadcast) : io.emit — le renommage doit atteindre les autres
  // onglets/sessions, pas seulement la socket qui l'a demandé.
  if (conversation) ctx.io.emit("conversations:renamed", { conversation });
});

socket.on("conversations:delete", (payload: { id?: string }, cb?: (data: unknown) => void) => {
  const id = payload?.id;
  if (!id) {
    if (typeof cb === "function") cb({ error: "id requis" });
    return;
  }
  // Garde (Lot 2, audit L2-4) : refuser pendant un tour en vol — un abort
  // suivi d'une suppression laissait le finally du tour réécrire ses lignes
  // dans une conversation déjà supprimée (données orphelines recréées).
  // Refus propre identique aux autres mutations (F-02) : l'utilisateur
  // arrête le tour, puis supprime.
  if (ctx.isRunning(id)) {
    if (typeof cb === "function")
      cb({ error: "Un tour est en cours dans cette conversation — arrêtez-le avant de la supprimer" });
    return;
  }
  // Nettoyage disque des pièces jointes et des artefacts de la conversation
  const attachments = ctx.store.conversationAttachments(id);
  const artifactRows = ctx.store.deleteConversationArtifacts(id);
  ctx.deleteAttachmentFiles(attachments);
  ctx.deleteArtifactFiles(artifactRows);
  // Les liens de partage deviennent 410 Gone (snapshot conservé en base)
  ctx.store.revokeSharesOfConversation(id);
  ctx.store.deleteConversation(id);
  if (typeof cb === "function") cb({ ok: true, id });
  // F-14 (broadcast) : la suppression doit atteindre toutes les sessions.
  ctx.io.emit("conversations:deleted", { id });
});

socket.on("conversations:open", (payload: { id?: string }, cb?: (data: unknown) => void) => {
  const id = payload?.id;
  // (audit 2026-11-21) id absent → ack d'erreur, jamais un return nu :
  // le client restait sinon suspendu sur son spinner d'historique.
  if (!id) {
    if (typeof cb === "function") cb({ error: "conversationId requis" });
    return;
  }
  const messages = ctx.store.getMessages(id);
  ctx.attachArtifactCards(id, messages);
  const compact = ctx.compactInfoWire(id);
  // Ré-attache : les tours en vol de cette conversation (contenu accumulé
  // inclus) partent avec le snapshot — le client qui revit la conversation
  // pendant une génération raccroche le fil au lieu de voir un tour mort.
  const live = ctx.liveTurnsOf(id);
  if (typeof cb === "function") cb({ conversationId: id, messages, compact, live });
  else socket.emit("conversations:messages", { conversationId: id, messages, compact, live });
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
    const rows = ctx.store.listConversationArtifacts(id);
    const artifacts = rows.map((r) => ctx.wireArtifact(id, r.key, r));
    if (typeof cb === "function") cb({ artifacts });
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
    const conversation = ctx.store.setPinned(id, !!payload?.pinned);
    if (!conversation) {
      if (typeof cb === "function") cb({ error: "Conversation introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ conversation });
    // F-14 (broadcast) : l'épingle doit atteindre toutes les sessions.
    ctx.io.emit("conversations:pinned", { conversation });
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
    const forked = ctx.store.forkConversation(conversationId, payload?.fromMessageId);
    if (!forked) {
      if (typeof cb === "function") cb({ error: "Conversation introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ conversation: forked });
    // F-14 (broadcast) : l'émetteur a son ack et ouvre la branche via
    // conversations:open — les autres onglets suivent via broadcast.
    socket.broadcast.emit("conversations:created", { conversation: forked });
  }
);


// Recherche plein-texte dans le contenu des messages
socket.on(
  "conversations:search",
  (payload: { query?: string }, cb?: (data: unknown) => void) => {
    const q = (payload?.query ?? "").trim();
    const results = q.length >= 2 ? ctx.store.searchMessages(q) : [];
    if (typeof cb === "function") cb({ results });
  }
);


// ── Projets : rangement des conversations par projet (fork) ───────────

socket.on("projects:list", (cb?: (data: unknown) => void) => {
  const projects = ctx.store.listProjects();
  if (typeof cb === "function") cb({ projects });
  else socket.emit("projects:list", { projects });
});

socket.on(
  "projects:create",
  (
    payload: { name?: string; parentId?: string | null; diskPath?: string | null },
    cb?: (data: unknown) => void
  ) => {
    const name = (payload?.name ?? "").trim();
    if (!name) {
      if (typeof cb === "function") cb({ error: "name requis" });
      return;
    }
    // F-59 : parenté explicite — le parent doit exister et être racine
    // (un seul niveau d'imbrication, cas limite plan §6).
    let parentId: string | null = null;
    if (payload?.parentId) {
      const parent = ctx.store.getProject(payload.parentId);
      if (!parent) {
        if (typeof cb === "function") cb({ error: "Dossier parent introuvable" });
        return;
      }
      if (parent.parentId) {
        if (typeof cb === "function") {
          cb({ error: "Un sous-dossier ne peut pas contenir de dossier (un seul niveau)" });
        }
        return;
      }
      parentId = parent.id;
    }
    // F-59 (J5) : liaison disque optionnelle — validée côté service (HOME).
    let diskPath: string | null = null;
    if (payload?.diskPath) {
      diskPath = validDiskPath(payload.diskPath);
      if (!diskPath) {
        if (typeof cb === "function") {
          cb({ error: "Chemin de disque invalide (dossier utilisateur uniquement)" });
        }
        return;
      }
    }
    const project = ctx.store.createProject(name, parentId, diskPath);
    if (typeof cb === "function") cb({ project });
    ctx.io.emit("projects:created", { project });
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
    const project = ctx.store.renameProject(id, name);
    if (!project) {
      if (typeof cb === "function") cb({ error: "Projet introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ project });
    ctx.io.emit("projects:renamed", { project });
  }
);

// F-60 : archive (ou désarchive) un dossier — la propagation au sous-arbre
// vit dans le store ; le broadcast `projects:updated` porte le projet cible
// (les sous-dossiers changent aussi : le front reçoit le drapeau via le
// refetch des listes actives ou lit le projet retourné).
socket.on(
  "projects:setArchived",
  (payload: { id?: string; archived?: boolean }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id || typeof payload?.archived !== "boolean") {
      if (typeof cb === "function") cb({ error: "id et archived requis" });
      return;
    }
    const project = ctx.store.setProjectArchived(id, payload.archived);
    if (!project) {
      if (typeof cb === "function") cb({ error: "Dossier introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ project, projects: ctx.store.listProjects() });
    ctx.io.emit("projects:updated", { project, projects: ctx.store.listProjects() });
  }
);


// Supprime un projet : les conversations (du dossier et de ses sous-dossiers,
// F-59) retombent dans « Sans projet », les sous-dossiers sont promus racine.
// Le broadcast emporte la liste complète à jour : le front remplace sa liste
// en un seul événement (pas de cascade côté client).
socket.on("projects:delete", (payload: { id?: string }, cb?: (data: unknown) => void) => {
  const id = payload?.id;
  if (!id) {
    if (typeof cb === "function") cb({ error: "id requis" });
    return;
  }
  if (!ctx.store.getProject(id)) {
    if (typeof cb === "function") cb({ error: "Dossier introuvable" });
    return;
  }
  ctx.store.deleteProject(id);
  const projects = ctx.store.listProjects();
  if (typeof cb === "function") cb({ ok: true, id, projects });
  ctx.io.emit("projects:deleted", { id, projects });
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
    const projects = ctx.store.reorderProjects(ids);
    if (typeof cb === "function") cb({ projects });
    ctx.io.emit("projects:reordered", { projects });
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
    const conversation = ctx.store.moveConversation(id, payload?.projectId ?? null);
    if (!conversation) {
      if (typeof cb === "function")
        cb({ error: "Conversation ou projet introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ conversation });
    ctx.io.emit("conversations:moved", { conversation });
  }
);



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
    const compareIds = ctx.validCompareIds(payload?.compare);
    const attachments = Array.isArray(payload?.attachments)
      ? payload!.attachments!.slice(0, ctx.MAX_ATTACHMENTS_PER_MESSAGE)
      : [];
    if (!conversationId || (!content && attachments.length === 0)) {
      if (typeof cb === "function") cb({ error: "Paramètres manquants" });
      return;
    }

    // Ack (revue 2026-11-13) : un tour en vol sur CETTE conversation → refus
    // PROPRE avec accusé d'erreur, au lieu d'aborter silencieusement le
    // tour en cours et d'entrelacer deux streams sur le même fil. Le
    // client reste maître : il peut arrêter (chat:stop) puis renvoyer.
    if (ctx.isRunning(conversationId)) {
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
    const existing = ctx.store.getMessages(conversationId);
    const isFirstUserMessage = !existing.some((m) => m.role === "user");
    const userMessage = ctx.store.appendMessage({
      conversationId,
      role: "user",
      content,
      attachments: attachments.length ? attachments : undefined,
    });
    ctx.store.touchConversation(
      conversationId,
      isFirstUserMessage ? ctx.titleFrom(content, attachments) : undefined
    );
    // Notifie le client (remplace le message optimiste par l'id réel)
    ctx.io.emit("message:appended", { conversationId, message: userMessage });

    // 2. Lance le tour assistant (réglages additifs du chantier Composer v2).
    //    Ack positif AVANT le lancement : le tour tourne en arrière-plan,
    //    les streams suivent par les événements stream:*.
    if (typeof cb === "function")
      cb({ ok: true, message: userMessage, ...(compareIds ? { compare: true } : {}) });
    const turnSettings: TurnSettings = {
      reasoningEffort: payload?.effort || undefined,
      permissionsMode: payload?.permissionsMode || undefined,
      ...ctx.sanitizeExpertSettings(payload),
    };
    // F-30 — Mode Plan : le moteur est prié de se mettre en mode plan au
    // PREMIER tour (tenté une fois, refus non bloquant) — la consigne écrite
    // du mode reste la garantie dans tous les cas.
    const modeForPlan = ctx.conversationModeState(conversationId);
    if (modeForPlan.mode === "plan" && isFirstUserMessage) {
      turnSettings.planMode = true;
    }
    // F-17 : comparaison — deux tours parallèles, un par modèle. Le
    // message utilisateur est unique ; chaque réponse assistant porte
    // sa variante (a/b) et son modèle.
    if (compareIds) {
      await Promise.all([
        ctx.runAssistantTurn(conversationId, {
          content,
          attachments: attachments.length ? attachments : undefined,
          modelId: compareIds[0],
          settings: turnSettings,
          variant: "a",
        }),
        ctx.runAssistantTurn(conversationId, {
          content,
          attachments: attachments.length ? attachments : undefined,
          modelId: compareIds[1],
          settings: turnSettings,
          variant: "b",
        }),
      ]);
      return;
    }
    await ctx.runAssistantTurn(conversationId, {
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
    // (audit 2026-11-21) id absent → ack d'erreur, jamais un return nu :
    // la promesse côté client restait pendante pour toujours.
    if (!conversationId) {
      if (typeof cb === "function") cb({ error: "conversationId requis" });
      return;
    }
    // Garde (audit passe 3, F-02) : refuser pendant un tour en vol — la
    // troncature ci-dessous supprimerait le message que le tour rédige,
    // puis le tour aborté le ré-insérerait (message fantôme + streams
    // entrelacés). Même refus propre que chat:send (a et b compris).
    if (ctx.isRunning(conversationId)) {
      if (typeof cb === "function")
        cb({ error: "Un tour est déjà en cours dans cette conversation" });
      return;
    }
    const compareIds = ctx.validCompareIds(payload?.compare);
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
      ctx.store.supersedeTrailingAssistant(conversationId, variant);
    if (!lastUser) {
      // (audit 2026-11-21) supersedeTrailingAssistant a DÉJÀ passé les
      // réponses en version_active = 0 avant de découvrir l'absence de
      // message utilisateur (ex. supprimé via message:delete). Sans
      // restauration, les réponses du fil disparaissaient en base sans
      // messages:refreshed ni chemin de retour — au rechargement, fil vide.
      const touchedGroups = [...new Set(Object.values(groups).filter(Boolean))];
      for (const g of touchedGroups) ctx.store.restoreLatestVersion(conversationId, g as string);
      if (touchedGroups.length) {
        const refreshed = ctx.store.getMessages(conversationId);
        ctx.attachArtifactCards(conversationId, refreshed);
        ctx.io.emit("messages:refreshed", { conversationId, messages: refreshed });
      }
      if (typeof cb === "function") cb({ error: "Aucun message à régénérer" });
      return;
    }
    if (supersededIds.length) {
      ctx.io.emit("messages:superseded", { conversationId, messageIds: supersededIds });
    }
    if (typeof cb === "function") cb({ ok: true });
    const turnSettings = {
      reasoningEffort: payload?.effort || undefined,
      permissionsMode: payload?.permissionsMode || undefined,
      ...ctx.sanitizeExpertSettings(payload),
    };
    // C-08 : régénération en mode Comparer SANS paire explicite (le client
    // n'envoie plus compare depuis F-30 — le service fait foi). On relit
    // les voix A/B du mode de la conversation et les groupes de versions
    // par VARIANTE : groups.plain vaut undefined quand les réponses
    // précédentes portent variant a/b — le sélecteur ‹ 1/2 › n'apparaissait
    // jamais (F-14 perdu).
    if (!compareIds && !variant && ctx.conversationModeState(conversationId).mode === "compare") {
      const [idA, idB] = ctx.comparePairFromMode(
        ctx.conversationModeState(conversationId) as { config: ModeConfig | null },
      );
      await Promise.all([
        ctx.runAssistantTurn(conversationId, {
          content: lastUser.content,
          attachments: lastUser.attachments,
          modelId: idA,
          settings: turnSettings,
          variant: "a",
          versionGroup: groups.a,
        }),
        ctx.runAssistantTurn(conversationId, {
          content: lastUser.content,
          attachments: lastUser.attachments,
          modelId: idB,
          settings: turnSettings,
          variant: "b",
          versionGroup: groups.b,
        }),
      ]);
      return;
    }
    if (compareIds) {
      await Promise.all([
        ctx.runAssistantTurn(conversationId, {
          content: lastUser.content,
          attachments: lastUser.attachments,
          modelId: compareIds[0],
          settings: turnSettings,
          variant: "a",
          versionGroup: groups.a,
        }),
        ctx.runAssistantTurn(conversationId, {
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
    await ctx.runAssistantTurn(conversationId, {
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
    const compareIds = ctx.validCompareIds(payload?.compare);
    if (!conversationId || !messageId || !content) {
      if (typeof cb === "function") cb({ error: "Paramètres manquants" });
      return;
    }
    // Garde (audit passe 3, F-02) : même refus que chat:send et
    // chat:regenerate — la troncature ne doit pas courir sous un tour
    // en vol, au risque d'un message fantôme ré-inséré après coup.
    if (ctx.isRunning(conversationId)) {
      if (typeof cb === "function")
        cb({ error: "Un tour est déjà en cours dans cette conversation" });
      return;
    }
    if (payload?.compare !== undefined && !compareIds) {
      if (typeof cb === "function")
        cb({ error: "Comparaison : deux modèles distincts sont requis" });
      return;
    }
    const result = ctx.store.editUserMessageAndTruncate(conversationId, messageId, content);
    if (!result) {
      if (typeof cb === "function") cb({ error: "Message introuvable ou non modifiable" });
      return;
    }
    ctx.deleteAttachmentFiles(result.removedAttachments);
    // Lot 2 (audit L2-1) : la troncature (édition + messages suivants)
    // emporte les artefacts ancrés sur les messages supprimés.
    ctx.deleteArtifactFiles(ctx.store.deleteArtifactsOfMessages(conversationId, result.removedIds));
    // D-02.4 : un message résumé édité → le résumé ne décrit plus le fil :
    // invalidation (le contexte repart complet, la compaction suivante
    // re-résumera honnêtement).
    ctx.invalidateCompactIfNeeded(conversationId, [
      ...result.removedIds,
      messageId,
    ]);
    // D-02.4 (broadcast) : quand le résumé vient d'être invalidé, les autres
    // sessions (et la jauge locale) ne l'apprenaient pas — on diffuse l'état
    // de compaction à jour (null = contexte repart complet).
    ctx.io.emit("conversation:compacted", {
      conversationId,
      compact: ctx.compactInfoWire(conversationId),
    });
    if (typeof cb === "function")
      cb({ ok: true, message: result.message, removedIds: result.removedIds });
    ctx.io.emit("message:updated", {
      conversationId,
      message: result.message,
      removedIds: result.removedIds,
    });
    const turnSettings = {
      reasoningEffort: payload?.effort || undefined,
      permissionsMode: payload?.permissionsMode || undefined,
      ...ctx.sanitizeExpertSettings(payload),
    };
    if (compareIds) {
      // F-17 : l'édition tronque tout ce qui suit (les deux variantes)
      // puis relance la comparaison sur le texte modifié.
      await Promise.all([
        ctx.runAssistantTurn(conversationId, {
          content,
          attachments: result.message.attachments,
          modelId: compareIds[0],
          settings: turnSettings,
          variant: "a",
        }),
        ctx.runAssistantTurn(conversationId, {
          content,
          attachments: result.message.attachments,
          modelId: compareIds[1],
          settings: turnSettings,
          variant: "b",
        }),
      ]);
      return;
    }
    await ctx.runAssistantTurn(conversationId, {
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
    // F-14 (garde) : même refus propre que les autres mutations — la
    // suppression sous un tour en vol laissait le finally du tour
    // réinscrire sa réponse dans un fil amputé.
    if (ctx.isRunning(conversationId)) {
      if (typeof cb === "function")
        cb({ error: "Un tour est déjà en cours dans cette conversation" });
      return;
    }
    const removed = ctx.store.deleteMessage(conversationId, messageId);
    if (!removed) {
      if (typeof cb === "function") cb({ error: "Message introuvable" });
      return;
    }
    // Lot 2 (audit L2-1) : les artefacts ancrés sur ce message ne doivent
    // pas survivre à sa suppression (lignes + fichiers dérivés).
    ctx.deleteArtifactFiles(ctx.store.deleteArtifactsOfMessages(conversationId, [messageId]));
    ctx.deleteAttachmentFiles(removed.attachments ?? []);
    // D-02.4 : le résumé de compaction ne doit pas survivre au message
    // qui borne sa couverture (untilMessageId).
    ctx.invalidateCompactIfNeeded(conversationId, [messageId]);
    if (typeof cb === "function") cb({ ok: true, messageId });
    // D-01 : si la version supprimée appartenait à un groupe F-14, la
    // version précédente a été PROMUE en base — mais message:deleted
    // retirait le message de l'écran au lieu de le remplacer par sa
    // version promue : la réponse disparaissait du fil jusqu'au prochain
    // rechargement. On rediffuse le fil complet (avec ses cartes
    // d'artefacts re-attachées) via messages:refreshed — le même
    // événement que message:setVersion ; message:deleted reste émis pour
    // les clients qui nettoient un état local (tours optimistes…).
    const refreshed = ctx.store.getMessages(conversationId);
    ctx.attachArtifactCards(conversationId, refreshed);
    // F-14 (compaction) : compactInfoWire (vue wire, pas le résumé brut de
    // readCompact) et TOUJOURS présent — même null quand le résumé vient
    // d'être invalidé, sinon le client garde sa jauge périmée.
    const compact = ctx.compactInfoWire(conversationId);
    ctx.io.emit("messages:refreshed", {
      conversationId,
      messages: refreshed,
      compact: compact ?? null,
    });
    ctx.io.emit("message:deleted", { conversationId, messageId });
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
    if (ctx.isRunning(conversationId)) {
      if (typeof cb === "function")
        cb({ error: "Un tour est en cours — attendez la fin de la génération" });
      return;
    }
    const messages = ctx.store.setMessageVersion(conversationId, group, index);
    if (!messages) {
      if (typeof cb === "function") cb({ error: "Version introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ ok: true });
    // F-14 : les cartes d'artefacts doivent suivre le fil rediffusé — sans
    // l'attachement, TOUTES les cartes de la conversation disparaissaient
    // de l'écran dès qu'on naviguait entre ‹ 1/2 ›.
    ctx.attachArtifactCards(conversationId, messages);
    ctx.io.emit("messages:refreshed", { conversationId, messages });
  }
);


socket.on("chat:stop", (payload: { conversationId?: string }, cb?: (data: unknown) => void) => {
  const id = payload?.conversationId;
  if (!id) {
    if (typeof cb === "function") cb({ error: "id requis" });
    return;
  }
  // F-17 : stop coupe le tour simple ET les deux côtés d'une comparaison.
  // Lot 3 (audit L3-5) : ack posé — le client ferme sa promesse, l'état
  // « interrompu » reste porté par stream:status / stream:done.
  const had = ctx.isRunning(id);
  ctx.abortRunning(id);
  if (had) {
    ctx.io.emit("stream:status", { conversationId: id, messageId: null, status: "Génération interrompue" });
  }
  if (typeof cb === "function") cb({ ok: true, stopped: had });
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
    if (ctx.isRunning(conversationId)) {
      if (typeof cb === "function") cb({ error: "Un tour est en cours — attendez la fin de la génération" });
      return;
    }
    const messages = ctx.store.getMessages(conversationId);
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
      const summary = await ctx.connector.summarize(history);
      const untilMessageId = messages[messages.length - 1].id;
      ctx.store.setSetting(
        ctx.compactKey(conversationId),
        JSON.stringify({
          summary,
          at: new Date().toISOString(),
          untilMessageId,
          summarizedCount: messages.length,
        })
      );
      const compact = ctx.compactInfoWire(conversationId);
      ctx.io.emit("conversation:compacted", { conversationId, compact });
      if (typeof cb === "function") cb({ ok: true, compact, done: true });
    } catch (err) {
      console.warn(
        "[hermes-chat] compaction impossible :",
        err instanceof Error ? err.message : err
      );
      // L'ack négatif suffit — le client l'affiche déjà proprement. Pas de
      // stream:error ici : cette alerte persistante propose « Réessayer »
      // qui RÉGÉNÈRE la dernière réponse assistant (comportement absurde
      // pour un échec de compaction).
      if (typeof cb === "function") {
        cb({
          ok: false,
          error: `Compaction impossible : ${err instanceof Error ? err.message : "erreur inconnue"}`,
        });
      }
    }
  }
);

}
