// Tour assistant : moteur d'exécution — extrait d'index.ts (découpage
// 2026-11, cf. FORK.md §10). Contient runAssistantTurn, les registres des
// tours en vol (running, liveTurns, liveResync), les helpers de mode
// (comparaison A/B, orchestrateur, webchat) et la lecture/invalidation de
// la compaction. Dépendances passées par createTurnRunner : ce module ne
// fait aucun câblage réseau.
import type { Server } from "socket.io";
import type { Store } from "./store";
import { toHttpBase, type HermesConnector } from "./hermes-connector";
import { ensureConversationMotorLink } from "./motor-rest";
import { runWebSearch, webSearchSection, type WebSource } from "./web-search";
import { modelLabel, DEFAULT_MODEL_ID } from "./models";
import {
  MODE_LABELS,
  modeModel,
  resolveMode,
  resolveModePrompt,
  resolveVoiceChars,
  modePromptSection,
  voiceModel,
  type ConversationMode,
  type ModeConfig,
} from "./modes";
import { runOrchestratedTurn, type OrchestratorDeps, type OrchestratorPrompts } from "./orchestrator";
import {
  CUSTOM_INSTRUCTIONS_KEY,
  MEMORY_ENABLED_KEY,
  MEMORY_NOTES_KEY,
  MEMORY_AUTO_KEY,
  composeLocalSystemPrompt,
} from "./prompts";
import { LOCAL_BASE_PROMPT } from "./local-engine";
import {
  isWebchatModel,
  readWebchatConfig,
  readWebchatFile,
  runWebchatTurn,
  webchatModelLabel,
} from "./webchat/engine";
import { trace } from "./trace";
import { ArtifactTracker } from "./artifacts";
import type {
  Artifact,
  Attachment,
  ChatMessage,
  CompactInfo,
  ModeFlowRow,
  ToolEvent,
  TurnSettings,
} from "./types";

export const MAX_HISTORY = 30;

export interface TurnRunnerDeps {
  store: Store;
  connector: HermesConnector;
  io: Server;
  /** Pipeline de rendu d'un artefact HTML (PNG plein page puis PDF). */
  renderHtmlArtifact: (row: import("./store").ArtifactRow) => Promise<void>;
  /** F-26 : quota du journal de versions + purge des fichiers dérivés. */
  enforceVersionQuota: (conversationId: string, keys: Iterable<string>) => void;
  /** Attache les cartes d'artefacts aux messages d'une conversation. */
  attachArtifactCards: (conversationId: string, messages: ChatMessage[]) => void;
}

export function createTurnRunner({
  store,
  connector,
  io,
  renderHtmlArtifact,
  enforceVersionQuota,
  attachArtifactCards,
}: TurnRunnerDeps) {
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

/** Interrompt TOUS les tours en vol, toutes conversations confondues.
 *  Loi « jamais bloqué » (2026-11-22) : avant une relance (mise à jour,
 *  redémarrage demandé), le lanceur dépose le drapeau d'arrêt propre —
 *  le service clôt alors chaque tour EN VOL (partiel persisté + événement
 *  terminal stream:done/stream:error) au lieu de mourir dans l'œuf et de
 *  laisser l'écran du client collé sur « Envoi… » sans fin. */
function abortAllRunning(): void {
  for (const controller of running.values()) controller.abort();
}

/** Un tour quelconque est-il en vol (toutes conversations confondues) ?
 *  Loi « le diagnostic dit le présent » (2026-11-22) : la phrase « un tour
 *  en vol restera sans réponse » n'est tracée à la déconnexion que si c'est
 *  VRAI — l'ancien message sortait à CHAQUE déconnexion et faisait passer
 *  une simple coupure pour une réponse perdue (diagnostic du 2026-11-22). */
function hasLiveTurns(): boolean {
  return running.size > 0 || liveTurns.size > 0;
}


// Tours en vol pour la RÉ-ATTACHE : quand le client quitte une conversation
// dont le tour continue puis y revient, son état de stream local est perdu
// (stream:start ne se reproduira pas, deltas sans entrée ignorés) et le
// message assistant n'est pas encore persisté — il ne l'est qu'à la clôture
// du tour. conversations:open renvoie donc ces tours avec leur contenu
// accumulé : le client re-sème son état de stream SANS trou, les deltas
// suivants s'y raccordent (contenu au retour = préfixe exact du final).
interface LiveTurnWire {
  conversationId: string;
  messageId: string;
  /** Variante de comparaison (F-17) — absent = tour simple. */
  variant?: "a" | "b";
  content: string;
  reasoning: string;
  status: string | null;
  toolEvents: ToolEvent[];
  /** F-30 : déroulé multi-voix en vol (débat/conseil/auto) — liste complète
   *  des lignes à chaque émission (le client remplace son état en bloc). */
  modeFlow?: import("./types").ModeFlowRow[];
}
const liveTurns = new Map<string, LiveTurnWire>();

// Réalignement de la position d'émission : après un re-semis client, les
// deltas suivants ne doivent porter que la croissance postérieure au
// snapshot (sinon la queue coalescée non encore émise serait dupliquée —
// elle est déjà dans le contenu re-semé).
const liveResync = new Map<string, () => void>();

/** Instantané des tours en vol de cette conversation (simple + variantes
 *  a/b) : contenu accumulé copié, puis position d'émission alignée sur ce
 *  contenu — les deltas suivants raccordent le client sans trou ni doublon. */
function liveTurnsOf(conversationId: string): LiveTurnWire[] {
  const snapshot: LiveTurnWire[] = [];
  for (const k of [conversationId, `${conversationId}:a`, `${conversationId}:b`]) {
    const t = liveTurns.get(k);
    if (!t) continue;
    snapshot.push({
      ...t,
      toolEvents: [...t.toolEvents],
      ...(t.modeFlow ? { modeFlow: [...t.modeFlow] } : {}),
    });
    liveResync.get(k)?.();
  }
  return snapshot;
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

/** Instructions complètes du tour (moteur local) : base + F-18 (si active) + F-19 + F-11. */
function localSystemPrompt(conversationId: string): string {
  return composeLocalSystemPrompt({
    base: LOCAL_BASE_PROMPT,
    memoryNotes: store.getSettingBool(MEMORY_ENABLED_KEY, true)
      ? store.getSetting(MEMORY_NOTES_KEY)
      : null,
    customInstructions: store.getSetting(CUSTOM_INSTRUCTIONS_KEY),
    conversationPrompt: store.getConversationPrompt(conversationId)?.content ?? null,
  });
}

// ── Modes du compositeur (F-30) — le service fait foi, relu à chaque envoi ──

/** État du mode d'une conversation : mode résolu (inconnu → chat), tours
 *  du débat et config (voix → modèles, membres, reprises). */
function conversationModeState(conversationId: string): {
  mode: ConversationMode;
  rounds: number | null;
  config: ModeConfig | null;
} {
  const state = store.getConversationModeState(conversationId);
  return {
    mode: resolveMode(state.mode),
    rounds: state.rounds,
    config: state.config,
  };
}

/** Section « mode » du systemPrompt (chat/plan/code) — recomposée à chaque
 *  envoi : une consigne modifiée s'applique au prochain message, sans
 *  redémarrage. Retourne "" pour les modes orchestrés (consignes par voix).
 */
function modeSystemPromptSection(
  conversationId: string,
  modeState: { mode: ConversationMode; rounds: number | null; config: ModeConfig | null },
): string {
  const mode = modeState.mode;
  if (mode === "debate" || mode === "council" || mode === "auto") return ""; // orchestrateur
  const key = `${mode}.main`;
  const text = resolveModePrompt(store, key);
  if (!text) return "";
  return modePromptSection(MODE_LABELS[mode], text);
}

/** Résout les consignes des voix d'un mode orchestré au moment du tour
 *  (placeholders {angle} {tours} {membres} {reprises} remplacés ici). */
function resolveOrchestratorPrompts(
  mode: ConversationMode,
  rounds: number | null,
  config: ModeConfig | null,
): OrchestratorPrompts {
  const varsBase = {
    tours: Math.round(rounds ?? 3),
    membres: Math.round(config?.members ?? 3),
  };
  if (mode === "debate") {
    return {
      // {angle} reste intact ici : remplacé par l'orchestrateur, voix par voix
      conseiller:
        resolveModePrompt(store, "debate.conseiller", varsBase) ?? "",
      juge: resolveModePrompt(store, "debate.juge", varsBase) ?? "",
    };
  }
  if (mode === "council") {
    return {
      membre: resolveModePrompt(store, "council.membre") ?? "",
      president:
        resolveModePrompt(store, "council.president", varsBase) ?? "",
    };
  }
  return {
    debat: resolveModePrompt(store, "auto.debat") ?? "",
    plan: resolveModePrompt(store, "auto.plan") ?? "",
    code: resolveModePrompt(store, "auto.code") ?? "",
    test: resolveModePrompt(store, "auto.test") ?? "",
    // {reprises} reste intact : remplacé par l'orchestrateur à chaque reprise
    reprise: resolveModePrompt(store, "auto.reprise") ?? "",
  };
}

/** Paire A/B du mode Comparer : voix de la config par conversation,
 *  repli catalogue (A = flagship, B = défaut). Le mécanisme interne
 *  (deux tours parallèles, variantes a|b) ne change pas.
 *  C-08 : les DEUX côtés doivent toujours être DISTINCTS — l'ancien
 *  repli `[a ?? DEFAULT, b ?? (a ? "hermes-4-405b" : "hermes-4-70b")]`
 *  renvoyait ["hermes-4-70b", "hermes-4-70b"] quand aucune voix n'était
 *  configurée : « comparer » un modèle avec lui-même n'a aucun sens. */
function comparePairFromMode(modeState: {
  config: ModeConfig | null;
}): [string, string] {
  const a = voiceModel("compare", modeState.config, "a");
  const b = voiceModel("compare", modeState.config, "b");
  if (a && b && a !== b) return [a, b];
  if (a && b === a) return [a, DEFAULT_MODEL_ID === a ? "hermes-4-405b" : DEFAULT_MODEL_ID];
  // A sans B (ou rien) : B prend le flagship s'il est libre, sinon le défaut —
  // toujours différent de A.
  const fallbackB =
    a === "hermes-4-405b" || !a ? "hermes-4-405b" : "hermes-4-405b" === a ? "hermes-4-70b" : "hermes-4-405b";
  const chosenA = a ?? DEFAULT_MODEL_ID;
  return [chosenA, chosenA === fallbackB ? "hermes-4-70b" : fallbackB];
}

/** Blocs ``` file réinjectés pour les fichiers produits par un tour webchat
 *  (le site a posé ses artefacts) — le suivi d'artefacts existant les
 *  transforme en cartes versionnées (une carte par fichier, aperçu et
 *  journal inclus). */
function webchatFileBlocks(
  files: { name: string; bytes: number; path: string }[] | undefined,
): string {
  if (!files?.length) return "";
  const wcConfig = readWebchatConfig(store);
  let extra = "";
  for (const f of files) {
    const fileContent = readWebchatFile(f.path, f.name, wcConfig.outDir);
    if (fileContent !== null) {
      const ext = f.name.includes(".") ? f.name.split(".").pop()! : "txt";
      extra += `\n\n\`\`\`${ext} file="${f.name}"\n${fileContent}\n\`\`\``;
    }
  }
  return extra;
}

/** Dépendances de l'orchestrateur : un tour de voix passe par le connecteur
 *  (gateway ou pool de clés) SANS streamer vers le chat — capture silencieuse.
 *  F-30b : une voix peut aussi tourner sur un chat IA web (webchat:<site>)
 *  — le pilote navigateur du site prend le relais ; pas de streaming, la
 *  réponse arrive en un bloc, les statuts du pilote sont affichés honnêtement.
 *  La file du pilote sérialise les voix webchat (un seul navigateur). */
const orchestratorDeps: OrchestratorDeps = {
  runVoiceTurn: async (req, cb) => {
    if (req.modelId && isWebchatModel(req.modelId)) {
      const wc = await runWebchatTurn({
        modelId: req.modelId,
        // Pas de systemPrompt chez un site web : la consigne de la voix est
        // prépendée au message (l'ordre de lecture reste le bon).
        prompt: req.systemPrompt
          ? `${req.systemPrompt}\n\n${req.content}`
          : req.content,
        store,
        cb: { signal: cb.signal, onStatus: (status) => cb.onStatus?.(status) },
      });
      return {
        content: wc.content + webchatFileBlocks(wc.files),
        reasoning: "",
        model: wc.model,
      };
    }
    return connector.runTurn(
      {
        content: req.content,
        history: req.history,
        modelId: req.modelId,
        model: req.modelId ? modelLabel(req.modelId) : null,
        attachments: req.attachments,
        settings: req.settings,
        systemPrompt: req.systemPrompt,
      },
      {
        signal: cb.signal,
        onDelta: (delta) => cb.onDelta?.(delta),
        onReasoning: () => {},
        onStatus: (status) => cb.onStatus?.(status),
        onToolEvent: () => {},
      },
    );
  },
};

// ── Compaction : résumé conservé en tête de session ────────────────────
// Stocké dans la table settings (aucune migration SQLite) sous la clé
// `compact:<conversationId>` — l'affichage de la conversation reste intact,
// seul ce qui part au modèle change (résumé + messages postérieurs).

function compactKey(conversationId: string): string {
  return `compact:${conversationId}`;
}

/** D-02.4 : invalide le résumé de compaction si un message COUVERT par le
 *  résumé est édité ou supprimé — sinon le tour suivant envoyait le résumé
 *  PUIS de nouveau, en clair, les messages déjà résumés (jusqu'à
 *  untilMessageId introuvable → untilIdx = -1 → tout le fil partait en
 *  double contexte). L'invalidation est honnête : la conversation repart
 *  en contexte complet, la prochaine compaction la re-résumera. */
function invalidateCompactIfNeeded(conversationId: string, removedIds: string[]): void {
  const compact = readCompact(conversationId);
  if (!compact) return;
  if (removedIds.includes(compact.untilMessageId)) {
    store.setSetting(compactKey(conversationId), "");
  }
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
    /** F-09/F-12 : recherche web du tour (clés Tavily/Exa, moteur local). */
    webSearch?: boolean;
    /** Variante de comparaison (F-17) : ce tour n'occupe que SON côté. */
    variant?: "a" | "b";
    /** F-14 : groupe de version — ce tour est une NOUVELLE version de la
     *  réponse qu'il remplace (l'ancienne est conservée, inactive). */
    versionGroup?: string;
  }
) => {
  const variant = opts.variant;
  // ── F-30 : le mode de la conversation est relu ICI, à chaque envoi —
  // le service fait foi, jamais l'écran. Comparer devient un mode : deux
  // tours parallèles (variantes a/b, mécanisme F-17 inchangé) avec les
  // modèles des voix A/B ; débat, conseil et auto passent par l'orchestrateur.
  const modeState = conversationModeState(conversationId);
  if (!variant && modeState.mode === "compare") {
    const [idA, idB] = comparePairFromMode(modeState);
    await Promise.all([
      runAssistantTurn(conversationId, { ...opts, modelId: idA, variant: "a" }),
      runAssistantTurn(conversationId, { ...opts, modelId: idB, variant: "b" }),
    ]);
    return;
  }
  const orchestrated =
    !variant &&
    (modeState.mode === "debate" || modeState.mode === "council" || modeState.mode === "auto");
  // F-30b : modèle du mode (chat/plan/code) — l'assignment du mode remplace
  // le modèle de la conversation, moteur OU chat IA web. Les modes multi-acteurs
  // ne l'utilisent pas : chaque voix garde son propre choix (variantes A/B,
  // conseillers, membres, étapes) et l'orchestrateur route déjà le webchat.
  const turnModelId = !variant && !orchestrated
    ? modeModel(modeState.config, modeState.mode) ?? opts.modelId ?? null
    : opts.modelId ?? null;
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
  const model = turnModelId
    ? modelLabel(turnModelId) || webchatModelLabel(turnModelId) || turnModelId
    : null;
  const attachments = opts.attachments?.length ? opts.attachments : undefined;

  // 1. Prépare le tour assistant
  const messageId = crypto.randomUUID();
  io.emit("stream:start", {
    conversationId,
    messageId,
    model,
    ...(variant ? { variant } : {}),
  });
  // Ré-attache : le tour se déclare dans le registre dès son départ —
  // liveSync maintient l'instantané au fil des deltas (cf. LiveTurnWire).
  liveTurns.set(turnKey, {
    conversationId,
    messageId,
    variant,
    content: "",
    reasoning: "",
    status: "Hermes réfléchit…",
    toolEvents: [],
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
  // F-30 : étiquette du mode et déroulé du tour multi-voix (remplis par
  // l'orchestrateur — absents pour un tour simple ou une comparaison).
  let modeTagOut: string | undefined = undefined;
  let modeFlowOut: import("./types").ModeFlowRow[] | undefined = undefined;

  // Ré-attache : maintient l'instantané du tour en vol (contenu/reasoning
  // accumulés + patch optionnel). No-op si un tour plus récent a déjà
  // repris la clé (même garde que running.delete dans le finally).
  const liveSync = (patch?: Partial<Pick<LiveTurnWire, "status" | "toolEvents" | "modeFlow">>) => {
    const cur = liveTurns.get(turnKey);
    if (!cur || cur.messageId !== messageId) return;
    liveTurns.set(turnKey, {
      ...cur,
      content: contentAcc,
      reasoning: reasoningAcc,
      ...(patch ?? {}),
    });
  };
  liveResync.set(turnKey, () => {
    lastSent = contentAcc.length;
  });
  // Clôture du tour dans le registre de ré-attache : même garde
  // d'identité que running.delete — un tour plus récent qui aurait repris
  // la clé ne doit pas être retiré par le finally de l'ancien.
  const liveClose = () => {
    const cur = liveTurns.get(turnKey);
    if (cur?.messageId === messageId) {
      liveTurns.delete(turnKey);
      liveResync.delete(turnKey);
    }
  };

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
    io.emit("stream:tool", {
      conversationId,
      messageId,
      event: toolEvent,
      ...(variant ? { variant } : {}),
    });
    liveSync({ toolEvents: [...toolEvents] });
  };
  // C-07 : le bouton Web n'est plus silencieusement ignoré en mode
  // orchestré — la recherche tourne AVANT l'orchestration et ses sources
  // partent dans le prompt système de CHAQUE voix (webSearchSection du
  // contexte), comme pour un tour simple.
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

  // ── F-30 : consigne du mode — ajoutée au systemPrompt du tour, recomposée
  // à chaque envoi (aucune consigne fantôme possible). Comparer : la consigne
  // commune part sur CHAQUE colonne (variantes a/b — même texte des deux côtés).
  // Débat/conseil/auto : consignes par voix, portées par l'orchestrateur.
  const modeSection = orchestrated
    ? ""
    : modeSystemPromptSection(conversationId, modeState);

  trace(
    "turn",
    `tour démarré — conv ${conversationId.slice(0, 8)}, mode ${orchestrated ? modeState.mode : "chat"}` +
      `, modèle ${opts.modelId ?? "défaut"}${opts.variant ? `, variante ${opts.variant}` : ""}`
  );
  try {
    let result: {
      content: string;
      reasoning: string;
      model: string;
      engine?: "pool" | "gateway";
      provider?: string;
      usage?: import("./llm-pool").TurnUsage;
    };
    if (orchestrated) {
      // ── Débat / Conseil / Auto : l'orchestrateur enchaîne les voix et
      // NE CONSERVE qu'une réponse (verdict / fusion / bilan). Le déroulé
      // vit dans la conversation : chaque ligne est poussée en direct via
      // `mode:flow`, puis persistée avec la réponse (mode_flow).
      const flowEmit = (rows: import("./types").ModeFlowRow[]) => {
        // Ré-attache : le déroulé vivant fait partie de l'état du tour —
        // sans lui, le bloc multi-voix disparaît au retour dans la
        // conversation jusqu'au prochain mode:flow (ou à la clôture).
        liveSync({ modeFlow: rows });
        io.emit("mode:flow", { conversationId, messageId, rows });
      };
      const outcome = await runOrchestratedTurn(
        {
          conversationId,
          messageId,
          mode: modeState.mode as "debate" | "council" | "auto",
          config: modeState.config,
          rounds: modeState.rounds,
          voiceChars: resolveVoiceChars(store),
          // C-07 : le modèle choisi dans le compositeur devient le
          // « modèle de la conversation » des voix sans modèle propre.
          modelId: opts.modelId ?? null,
          // C-07 : instructions locales composées (base + mémoire F-18 +
          // instructions F-19 + prompt de conversation F-11) — chaque
          // voix les reçoit au-dessus de sa consigne de rôle.
          localSystemPrompt: connector.mode === "local"
            ? localSystemPrompt(conversationId)
            : (store.getConversationPrompt(conversationId)?.content ?? null),
          // C-07/F-09 : sources web du tour (si le bouton Web est actif).
          webSearchSection: webSources ? webSearchSection(webSources) : null,
          userContent: opts.content,
          history,
          attachments,
          settings: opts.settings,
          prompts: resolveOrchestratorPrompts(
            modeState.mode,
            modeState.rounds,
            modeState.config,
          ),
          signal: controller.signal,
          onFlow: flowEmit,
          onFinalDelta: (delta) => {
            contentAcc += delta;
            liveSync();
            const now = Date.now();
            if (now - lastEmit > 16) {
              lastEmit = now;
              io.emit("stream:delta", {
                conversationId,
                messageId,
                delta: contentAcc.slice(lastSent),
                ...(variant ? { variant } : {}),
              });
              lastSent = contentAcc.length;
              tracker.update(contentAcc);
            }
          },
          onFinalStatus: (status) => {
            liveSync({ status });
            io.emit("stream:status", {
              conversationId,
              messageId,
              status,
              ...(variant ? { variant } : {}),
            });
          },
        },
        orchestratorDeps,
      );
      modeTagOut = outcome.tag;
      modeFlowOut = outcome.rows;
      trace("turn", `tour orchestré terminé — ${outcome.tag}`);
      result = {
        content: outcome.content,
        reasoning: outcome.reasoning,
        model: outcome.model,
        usage: outcome.usage,
      };
    } else if (turnModelId && isWebchatModel(turnModelId)) {
      // ── Fournisseur « chats IA web » — le tour ne part pas sur un moteur
      // LLM mais sur le pilote navigateur du site (spec « Piloter des chats
      // IA web », §4/§6). Réponse en un bloc : le statut explique où on en
      // est (navigateur, envoi, génération), jamais de streaming factice.
      // F-30 : la consigne du mode est prépendée au message — un site web n'a
      // pas de systemPrompt, l'ordre de lecture reste le bon.
      const wc = await runWebchatTurn({
        modelId: turnModelId,
        prompt: modeSection
          ? `${modeSection}\n\n${opts.content}`
          : opts.content,
        store,
        cb: {
          signal: controller.signal,
          onStatus: (status) => {
            liveSync({ status });
            io.emit("stream:status", {
              conversationId,
              messageId,
              status,
              ...(variant ? { variant } : {}),
            });
          },
          onToolEvent: (event) => emitTool(event),
        },
      });
      // Fichiers produits par le site : réinjectés en blocs nommés — le
      // suivi d'artefacts existant les transforme en cartes versionnées
      // (une carte par fichier, aperçu et journal de versions inclus).
      result = {
        content: wc.content + webchatFileBlocks(wc.files),
        reasoning: "",
        model: wc.model,
        provider: wc.provider,
      };
    } else {
      // Bascule sessions natives (75) : lie la conversation à une session
      // moteur (id déterministe `ui-<conversationId>`, création idempotente
      // 201/409) puis passe l'identifiant — le tour gateway tente alors le
      // chemin REST (le moteur porte l'historique de SA session) et replie
      // sur le WebSocket à la moindre erreur avant premier delta. Jamais
      // bloquant : échec de liaison → null → WS inchangé, comme avant.
      // (93) : la liaison n'est tentée que si le moteur ANNONCE le contrat
      // sessions natives — sinon aucun POST voué au 405 d'un listener qui
      // ne l'expose pas (le webapp 9120 n'a que le GET), aucune trace
      // d'échec pour un chemin qui n'existe pas.
      const motorSessionId =
        connector.mode === "gateway" &&
        connector.gatewayUrl &&
        (await connector.hasRestContract())
          ? await ensureConversationMotorLink(
              store,
              toHttpBase(connector.gatewayUrl),
              connector.gatewayToken,
              conversationId,
              // Le prompt de conversation gateway (même expression que le
              // tour) : posé à la création de la session, renvoyé à jour
              // dans le body de chaque tour REST (system_message).
              store.getConversationPrompt(conversationId)?.content ?? null,
              controller.signal,
            )
          : null;
      result = await connector.runTurn(
      {
        content: opts.content,
        history,
        model,
        modelId: turnModelId,
        attachments,
        motorSessionId,
        // Réglages du tour : effort/permissions du composer + mémoire
        // utilisateur (F-18) — les notes ne partent que si la mémoire est
        // active (mode gateway ; en local elles vivent dans systemPrompt).
        settings: {
          ...opts.settings,
          memoryNotes:
            store.getSettingBool(MEMORY_ENABLED_KEY, true)
              ? (store.getSetting(MEMORY_NOTES_KEY) ?? "").trim() || undefined
              : undefined,
          memoryAutoLearn: store.getSettingBool(MEMORY_AUTO_KEY, false),
        },
        // Instructions système du tour (F-11/F-19) : composées par le
        // service sans agent (pool de clés) ; en mode gateway, le prompt de
        // conversation part seul (la gateway garde ses instructions de base).
        // F-12 : les résultats de recherche web sont ajoutés en fin de
        // prompt système du tour local (pool).
        // F-30 : la consigne du mode (chat/plan/code) est ajoutée dans les
        // deux cas — recomposée à chaque envoi, jamais stockée fantôme.
        systemPrompt:
          connector.mode === "local"
            ? localSystemPrompt(conversationId) +
              (modeSection ? `\n\n${modeSection}` : "") +
              (webSources ? webSearchSection(webSources) : "")
            : (() => {
                const conv = store.getConversationPrompt(conversationId)?.content ?? null;
                const withMode = conv || modeSection
                  ? [conv ?? "", modeSection].filter(Boolean).join("\n\n")
                  : null;
                return withMode || null;
              })(),
      },
      {
        signal: controller.signal,
        onDelta: (delta) => {
          contentAcc += delta;
          liveSync();
          const now = Date.now();
          // Coalescence légère des deltas très rapprochés
          if (now - lastEmit > 16) {
            lastEmit = now;
            io.emit("stream:delta", {
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
          liveSync();
          io.emit("stream:reasoning", {
            conversationId,
            messageId,
            delta,
            ...(variant ? { variant } : {}),
          });
        },
        onStatus: (status) => {
          liveSync({ status });
          io.emit("stream:status", {
            conversationId,
            messageId,
            status,
            ...(variant ? { variant } : {}),
          });
        },
        onToolEvent: (event) => emitTool(event),
      }
      );
    }

    // Flush final du contenu restant
    contentAcc = result.content || contentAcc;
    reasoningAcc = result.reasoning || reasoningAcc;
    liveSync();
    if (result.model) {
      usedModel =
        result.engine === "pool" && result.provider
          ? `${result.model} · ${result.provider}`
          : result.model;
    }
    if (lastSent < contentAcc.length) {
      io.emit("stream:delta", {
        conversationId,
        messageId,
        delta: contentAcc.slice(lastSent),
        ...(variant ? { variant } : {}),
      });
    }

    // Arrêt utilisateur (chat:stop) : le connecteur revient avec le partiel —
    // ce n'est pas une erreur, le tour se clôt normalement avec le marqueur.
    const stopped = controller.signal.aborted;

    // Le tour touche à sa fin : il quitte le registre de ré-attache AVANT
    // tout événement terminal — un conversations:open pendant la clôture ne
    // doit pas ré-attacher un tour déjà clos.
    liveClose();

    // Arrêt avant le premier jeton : rien à conserver, pas de bulle vide
    if (stopped && !contentAcc && !reasoningAcc && toolEvents.length === 0) {
      // F-14 : régénération stoppée avant le premier jeton — l'ancienne
      // réponse, passée à version_active = 0 par supersedeTrailingAssistant
      // AVANT le tour, est réactivée au lieu de disparaître définitivement
      // du fil (aucune nouvelle version n'a été insérée).
      if (opts.versionGroup) {
        store.restoreLatestVersion(conversationId, opts.versionGroup);
        const refreshed = store.getMessages(conversationId);
        attachArtifactCards(conversationId, refreshed);
        io.emit("messages:refreshed", { conversationId, messages: refreshed });
      }
      const conversation = store.touchConversation(conversationId) ?? undefined;
      io.emit("stream:done", {
        conversationId,
        messageId,
        conversation,
        stopped: true,
        ...(variant ? { variant } : {}),
      });
      return;
    }

    // Clôture du suivi des artefacts (persistance définitive) + quota (F-26)
    const finalizedRows = tracker.finalize(contentAcc, false);
    enforceVersionQuota(conversationId, new Set(finalizedRows.map((r) => r.key)));

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
      modeTag: modeTagOut,
      modeFlow: modeFlowOut,
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
      modeTag: modeTagOut,
      modeFlow: modeFlowOut,
      usage: result.usage,
      sources: webSources,
      ...(opts.versionGroup
        ? { versions: { group: opts.versionGroup, index: versionIndex ?? 1, count: versionIndex ?? 1 } }
        : {}),
    };
    // Cartes d'artefacts ancrées sur ce message (celles créées par ce tour)
    attachArtifactCards(conversationId, [doneMessage]);
    io.emit("stream:done", {
      conversationId,
      messageId,
      conversation,
      message: doneMessage,
      stopped,
      ...(variant ? { variant } : {}),
    });
  } catch (err) {
    // Échec/arrêt : le tour quitte le registre de ré-attache avant les
    // événements terminaux (même garde d'identité qu'en fin de try).
    liveClose();
    // Sauvegarde du partiel déjà reçu (quota F-26 appliqué aussi aux tours interrompus)
    const finalizedRows = tracker.finalize(contentAcc, true);
    enforceVersionQuota(conversationId, new Set(finalizedRows.map((r) => r.key)));
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
      io.emit("stream:done", {
        conversationId,
        messageId,
        conversation,
        message: partial ?? undefined,
        stopped: true,
        ...(variant ? { variant } : {}),
      });
    } else {
      // F-14 : tour régénéré en échec avant le premier jeton — même
      // restauration que l'arrêt à vide : sans elle, toutes les versions
      // du groupe restaient à version_active = 0 et la réponse disparaissait
      // définitivement du fil.
      if (!partial && opts.versionGroup) {
        store.restoreLatestVersion(conversationId, opts.versionGroup);
        const refreshed = store.getMessages(conversationId);
        attachArtifactCards(conversationId, refreshed);
        io.emit("messages:refreshed", { conversationId, messages: refreshed });
      }
      // Erreur réelle : le partiel persisté part avec l'événement — le client
      // l'affiche dans le fil et propose « Réessayer » (F-04).
      trace(
        "error",
        `tour en échec : ${err instanceof Error ? err.message : "erreur inconnue"}`
      );
      const conversation = contentAcc || reasoningAcc
        ? store.touchConversation(conversationId) ?? undefined
        : undefined;
      if (partial) attachArtifactCards(conversationId, [partial]);
      io.emit("stream:error", {
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
    // Filet du registre de ré-attache : si aucun chemin terminal n'a
    // retiré l'entrée, le finally reste l'ultime propriétaire du nettoyage.
    liveClose();
  }
};

// (audit 2026-11-21) Filet global du tour. La phase de PRÉPARATION
// (lectures SQLite, compaction, consigne de mode) est HORS du try/finally
// interne : une exception là laissait running/liveTurns remplis — isRunning
// restait vrai (plus aucun envoi possible sur la conversation) et
// conversations:open ré-attachait un tour mort. Pire : la promesse remontait
// au handler chat:send sans catch → rejection non gérée → le process pouvait
// mourir. Le wrapper purge les registres, émet un stream:error (le client
// déroule son spinner) et AVALE l'erreur — même contrat que le catch interne.
// Sans risque pour un tour remplaçant : aucun nouveau tour ne peut démarrer
// tant que la clé est occupée (isRunning refuse chat:send/regenerate).
const runAssistantTurnGuarded = async (
  conversationId: string,
  opts: Parameters<typeof runAssistantTurn>[1]
) => {
  const turnKey = opts.variant ? `${conversationId}:${opts.variant}` : conversationId;
  try {
    return await runAssistantTurn(conversationId, opts);
  } catch (err) {
    if (running.has(turnKey)) running.delete(turnKey);
    liveTurns.delete(turnKey);
    console.error(
      `[hermes-chat] tour en échec (phase préparation) : ${err instanceof Error ? err.message : "erreur inconnue"}`
    );
    io.emit("stream:error", {
      conversationId,
      error: err instanceof Error ? err.message : "Erreur inconnue du tour",
      ...(opts.variant ? { variant: opts.variant } : {}),
    });
    // Contrat = Promise<void> (aucun appelant ne lit le résultat — la
    // persistance et les événements terminaux ont déjà été émis, ou ne
    // peuvent pas l'être : c'est la phase préparation qui a échoué).
    return;
  }
};
  return {
    runAssistantTurn: runAssistantTurnGuarded,
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
  };
}
