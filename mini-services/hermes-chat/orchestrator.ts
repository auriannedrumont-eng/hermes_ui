// Orchestrateur des modes multi-voix (F-30) — débat, conseil, auto.
//
// Un seul tour par conversation : l'orchestrateur enchaîne les voix (débat
// séquentiel qui se répond, conseil parallèle en lecture seule, auto de bout
// en bout avec reprises) et NE CONSERVE qu'une seule réponse — le verdict /
// la fusion / le bilan. Le déroulé vit dans la conversation : chaque étape
// est poussée en direct via onFlow (événement `mode:flow` côté index.ts),
// puis persistée avec la réponse finale (messages.mode_flow).
//
// Le déroulé s'affiche au-dessus de la réponse — pas dans un panneau à part.
// Les voix lisent le modèle choisi dans « qui travaille » (mode_config) ;
// sans choix, elles suivent le modèle de la conversation.
//
// Testabilité : runVoiceTurn est injecté (les QA passent un faux moteur —
// aucun LLM requis pour prouver l'ordre des tours, les reprises et les rows).
import { modelLabel } from "./models";
import { trace } from "./trace";
import { FICHES, parseWebchatModelId } from "./webchat/fiches";
import {
  COUNCIL_READ_ONLY_RULE,
  DEBATE_ROUNDS_MAX,
  DEBATE_ROUNDS_MIN,
  voicesFor,
} from "./modes";
import type {
  Attachment,
  ModeFlowRow,
  TurnSettings,
} from "./types";

export interface VoiceTurnRequest {
  /** Modèle de la voix (null = modèle de la conversation). */
  modelId: string | null;
  /** Consigne de la voix (résolue au tour — prompts des modes). */
  systemPrompt: string | null;
  /** Contenu envoyé à cette voix (question + transcription des tours passés). */
  content: string;
  /** Historique de la conversation (avant le message utilisateur courant). */
  history: { role: "user" | "assistant"; content: string }[];
  attachments?: Attachment[];
  settings?: TurnSettings;
}

export interface VoiceTurnOutcome {
  content: string;
  reasoning: string;
  model: string;
  usage?: { input?: number; output?: number; cost?: number };
}

/** Usage cumulé d'une orchestration (C-07/F-21) : le coût réel d'un tour
 *  multi-voix est la SOMME des 3 à 30 appels LLM intermédiaires — ne
 *  conserver que l'usage du dernier appel sous-comptait systématiquement. */
export function sumUsage(
  usages: ({ input?: number; output?: number; cost?: number } | undefined | null)[],
): { input?: number; output?: number; cost?: number } | undefined {
  let input = 0;
  let output = 0;
  let cost = 0;
  let any = false;
  for (const u of usages) {
    if (!u) continue;
    any = true;
    input += u.input ?? 0;
    output += u.output ?? 0;
    cost += u.cost ?? 0;
  }
  if (!any) return undefined;
  return { input, output, cost };
}

export interface OrchestratorDeps {
  /** Un tour d'une voix — jamais streamé vers le chat (capture silencieuse),
   *  SAUF le tour final dont les deltas partent dans la réponse conservée. */
  runVoiceTurn(
    req: VoiceTurnRequest,
    cb: {
      signal: AbortSignal;
      onDelta?: (delta: string) => void;
      onStatus?: (status: string) => void;
    },
  ): Promise<VoiceTurnOutcome>;
}

/** Consignes résolues au tour (placeholders remplacés) — index.ts les passe
 *  telles quelles ; une consigne vide = null (la voix répond sans consigne). */
export interface OrchestratorPrompts {
  conseiller?: string;
  juge?: string;
  membre?: string;
  president?: string;
  debat?: string;
  plan?: string;
  code?: string;
  test?: string;
  reprise?: string;
}

export interface OrchestratorContext {
  conversationId: string;
  /** Identifiant du message FINAL (verdict / fusion / bilan) — annoncé par
   *  stream:start avant l'orchestration ; le déroulé s'ancre dessus. */
  messageId: string;
  mode: "debate" | "council" | "auto";
  config: import("./modes").ModeConfig | null;
  /** Débat : tours (3–10). */
  rounds: number | null;
  /** Débat : longueur visée des interventions (caractères) — réglage du
   *  service (hermes.modes.voiceChars) relu à chaque tour, borné par
   *  resolveVoiceChars (500–8000, défaut 2000). */
  voiceChars: number;
  /** C-07 : modèle sélectionné dans le compositeur (le « modèle de la
   *  conversation »). Une voix sans modèle propre (modelId null) doit
   *  suivre CELUI-CI, pas le premier modèle du catalogue. */
  modelId?: string | null;
  userContent: string;
  history: { role: "user" | "assistant"; content: string }[];
  attachments?: Attachment[];
  settings?: TurnSettings;
  /** C-07 : instructions système locales composées (base + mémoire F-18 +
   *  instructions globales F-19 + prompt de conversation F-11) — chaque voix
   *  les reçoit AU-DESSUS de sa consigne de rôle. */
  localSystemPrompt?: string | null;
  /** C-07/F-09 : recherche web — même bouton actif, mêmes sources pour les
   *  modes orchestrés (injectées en fin de prompt système de chaque voix). */
  webSearchSection?: string | null;
  /** Consignes des voix (résolues au tour par index.ts). */
  prompts: OrchestratorPrompts;
  signal: AbortSignal;
  /** Poussée du déroulé en direct (rows complet, à chaque changement). */
  onFlow: (rows: ModeFlowRow[]) => void;
  /** Deltas du tour FINAL — streamés vers le chat comme la réponse conservée. */
  onFinalDelta: (delta: string) => void;
  onFinalStatus: (status: string) => void;
}

export interface OrchestratorResult {
  content: string;
  reasoning: string;
  model: string;
  usage?: { input?: number; output?: number; cost?: number };
  /** Étiquette du mode sur la réponse (« Verdict · Débat — 3 tours »). */
  tag: string;
  rows: ModeFlowRow[];
}

interface NamedVoice {
  id: string;
  name: string;
  model: string | null;
}

/** Extrait court d'une réponse de voix (une ligne, ~110 caractères). */
function excerptOf(content: string): string {
  const line = content
    .split(/\n+/)
    .map((l) => l.replace(/[#*`>]/g, "").trim())
    .find((l) => l.length > 12);
  const src = (line ?? content).replace(/\s+/g, " ").trim();
  return src.length > 110 ? `${src.slice(0, 110)}…` : src;
}

/** Étiquette courte « H4 405B » façon maquette (chip du déroulé). Un chat IA
 *  web est affiché par son site (« z.ai ») — une seule entrée par site :
 *  la forme de la réponse (texte ou fichiers) est observée, pas réglée. */
export function shortModel(modelId: string | null | undefined): string | undefined {
  if (!modelId) return undefined;
  const wc = parseWebchatModelId(modelId);
  if (wc) return FICHES[wc.site].label;
  const label = modelLabel(modelId);
  const m = /^(Hermes|GLM|GPT|Claude)\s+(.+)$/.exec(label);
  // F-30b : un modèle tiers au nom long reste affiché (tronqué) — l'ancien
  // `undefined` masquait la puce du modèle dans le déroulé.
  if (!m) return label.length <= 14 ? label : `${label.slice(0, 13).trimEnd()}…`;
  const sigle = m[1] === "Hermes" ? "H" : m[1] === "Claude" ? "CL" : m[1];
  return `${sigle}${m[2]}`;
}

class FlowRecorder {
  rows: ModeFlowRow[] = [];
  constructor(private onFlow: (rows: ModeFlowRow[]) => void) {}
  push(row: ModeFlowRow) {
    this.rows.push(row);
    this.onFlow([...this.rows]);
  }
  update(id: string, patch: Partial<ModeFlowRow>) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    Object.assign(row, patch);
    this.onFlow([...this.rows]);
  }
}

/** Le test marque l'échec en tête de réponse — contrat du prompt auto.test. */
export function testFailed(content: string): boolean {
  const head = content.trim().slice(0, 24).toUpperCase();
  return head.startsWith("ÉCHEC") || head.startsWith("ECHEC") || head.startsWith("FAIL");
}

/** Tour de voix avec déroulé honnête : sur échec, la ligne du tour passe en
 *  « error » avec le motif — rien ne reste « en cours » sans fin ni erreur
 *  (un débat restait bloqué sur sa première voix quand un tour mourait).
 *  L'erreur remonte contextualisée ; un arrêt utilisateur remonte tel quel —
 *  le service clôt alors le tour en « stopped ». */
async function runVoiceWithRow(
  deps: OrchestratorDeps,
  ctx: OrchestratorContext,
  flow: FlowRecorder,
  rowId: string,
  voiceLabel: string,
  req: VoiceTurnRequest,
  cb?: { onDelta?: (delta: string) => void; onStatus?: (status: string) => void },
): Promise<VoiceTurnOutcome> {
  const started = Date.now();
  // C-07 : trois enrichissements du tour de voix, composites ici pour ne
  // pas se répéter aux 20+ sites d'appel —
  //  1. modelId null = « modèle de la conversation » : on résout vers le
  //     modèle choisi dans le compositeur (pas le 1er du catalogue) ;
  //  2. les instructions locales composées (mémoire F-18, instructions
  //     globales F-19, prompt de conversation F-11) partent AU-DESSUS de la
  //     consigne de rôle de la voix ;
  //  3. les sources web du tour sont injectées en fin de prompt système.
  const resolvedModelId = req.modelId ?? ctx.modelId ?? null;
  const rolePrompt = req.systemPrompt ?? "";
  // F-30b : les instructions locales composées (mémoire F-18, instructions
  // globales F-19, prompt de conversation F-11 — ~2 100 caractères) ne
  // partent PAS vers un chat IA web : turn-runner les prépenderait au
  // message TAPÉ dans le navigateur du site piloté.
  const isWebchat = Boolean(resolvedModelId && resolvedModelId.startsWith("webchat:"));
  const localPrompt = isWebchat ? "" : (ctx.localSystemPrompt?.trim() ?? "");
  const webSection = ctx.webSearchSection?.trim() ?? "";
  const composedPrompt = [localPrompt, rolePrompt, webSection]
    .filter(Boolean)
    .join("\n\n") || null;
  const modelTrace = resolvedModelId ?? "modèle de la conversation";
  trace("orch", `voix : ${voiceLabel} — démarre (${modelTrace})`);
  try {
    const outcome = await deps.runVoiceTurn(
      {
        ...req,
        modelId: resolvedModelId,
        systemPrompt: composedPrompt,
      },
      { signal: ctx.signal, ...cb },
    );
    trace(
      "orch",
      `voix : ${voiceLabel} — terminée en ${Math.round((Date.now() - started) / 1000)} s ` +
        `(${outcome.content.trim().length} caractères)`,
    );
    return outcome;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace("error", `voix : ${voiceLabel} — échec après ${Math.round((Date.now() - started) / 1000)} s : ${msg}`);
    flow.update(rowId, {
      detail: ctx.signal.aborted ? "interrompu" : `échec : ${msg}`,
      status: "error",
    });
    throw ctx.signal.aborted ? err : new Error(`${voiceLabel} : ${msg}`);
  }
}

function voicePromptContent(
  userContent: string,
  transcript: string[],
  note?: string,
): string {
  // Ordre fixe « question → transcription → note » (revue 95/3.5) : la note,
  // SEULE partie qui change entre deux voix d'un même tour et entre deux
  // tours, arrive EN DERNIER — le message est croissant par la fin, le
  // préfixe (question + transcription déjà posée) reste stable d'un appel
  // LLM au suivant et le cache de prompt du fournisseur frappe jusqu'à la
  // transcription au lieu de casser dès le premier caractère. L'ancien
  // ordre (note en tête) réécrivait le début du message à chaque étape.
  // La gateway WS ne lisant que `content`, ce message unique lui transmet
  // toujours l'intégralité : aucun changement de comportement, juste
  // l'ordre des blocs (la note en fin = avantage de récence pour le modèle).
  const parts: string[] = [];
  parts.push(`Question / demande :\n${userContent}`);
  if (transcript.length) {
    parts.push(
      "Transcription des échanges précédents de cette orchestration :\n" +
        transcript.join("\n"),
    );
  }
  if (note) parts.push(note);
  return parts.join("\n\n");
}

/** Garde d'abort (Lot 1, audit L1-6) : au Stop utilisateur, les étapes qui
 *  n'ont pas encore démarré (verdict du débat, président du conseil, chaque
 *  étape de l'auto) ne partent plus — l'erreur remonte et le service clôt
 *  le tour en « stopped » avec le partiel déjà reçu. */
function ensureNotAborted(ctx: OrchestratorContext): void {
  if (!ctx.signal.aborted) return;
  throw ctx.signal.reason instanceof Error
    ? ctx.signal.reason
    : new Error("arrêt utilisateur — étape suivante annulée");
}

// ── Débat : les conseillers se répondent tour après tour, le juge tranche ──

async function runDebate(
  ctx: OrchestratorContext,
  deps: OrchestratorDeps,
  flow: FlowRecorder,
  conseillers: NamedVoice[],
  juge: NamedVoice,
  rounds: number,
): Promise<OrchestratorResult> {
  const transcript: string[] = [];
  // C-07/F-21 : usage cumulé de TOUTES les voix (tours + verdict) — le coût
  // réel du débat, pas seulement celui du dernier appel.
  const usages: ({ input?: number; output?: number; cost?: number } | undefined)[] = [];
  // « Voix du tour en parallèle » : les trois voix partent ENSEMBLE et chacune
  // ne voit que les tours PRÉCÉDENTS (les voix de son tour répondent en même
  // temps — elles seront lisibles au suivant). PAR DÉFAUT (F-57 : 61 minutes
  // pour un débat de 3 tours, c'est insoutenable) ; l'enchaîné — le seul où
  // chaque voix répond à celles qui précèdent — reste au tarif d'un
  // interrupteur dans la config du débat.
  const parallel = ctx.config?.debateParallel !== false;
  for (let r = 1; r <= rounds; r++) {
    if (ctx.signal.aborted) break;
    if (parallel) {
      // Les lignes apparaissent d'abord « en attente », chaque voix s'allume
      // à son départ — le déroulé montre qu'elles tournent de concert.
      for (const v of conseillers) {
        flow.push({
          id: `t${r}-${v.id}`,
          label: `Tour ${r} · ${v.name}`,
          detail: "part avec les autres voix du tour — voit les tours précédents",
          model: shortModel(v.model),
          status: "pending",
        });
      }
      const settled = await Promise.all(
        conseillers.map(async (v) => {
          const rowId = `t${r}-${v.id}`;
          flow.update(rowId, {
            status: "running",
            detail: "répond en même temps que les autres voix du tour",
          });
          const note =
            `Débat en ${rounds} tours — vous êtes au tour ${r}, posture : ${v.name}. ` +
            `Vous voyez les tours précédents ; les autres voix de votre tour répondent ` +
            `en même temps que vous : vous ne les lirez qu'au tour suivant. Contredisez ` +
            `sur des faits, jamais sur des généralités. Votre intervention tient en ` +
            `${ctx.voiceChars} caractères maximum : droit au but, sans préambule ni ` +
            `répétition de ce qui a déjà été dit.`;
          try {
            const outcome = await runVoiceWithRow(
              deps,
              ctx,
              flow,
              rowId,
              `Voix « ${v.name} » (tour ${r})`,
              {
                modelId: v.model,
                systemPrompt: (ctx.prompts.conseiller || "").replaceAll(
                  "{angle}",
                  v.name,
                ).replaceAll("{tours}", String(rounds)) || null,
                content: voicePromptContent(ctx.userContent, transcript, note),
                history: ctx.history,
                attachments: ctx.attachments,
                settings: ctx.settings,
              },
            );
            flow.update(rowId, { detail: excerptOf(outcome.content), status: "done" });
            usages.push(outcome.usage);
            return { v, outcome, error: undefined as string | undefined };
          } catch (err) {
            // La ligne est déjà marquée par runVoiceWithRow (« échec : … » ou
            // « interrompu ») — on collecte sans écraser.
            return { v, outcome: null, error: err instanceof Error ? err.message : "échec" };
          }
        }),
      );
      // Transcription dans l'ordre canonique des voix (pas l'ordre d'arrivée).
      let failures = 0;
      let firstError = "";
      for (const { v, outcome, error } of settled) {
        if (outcome) {
          transcript.push(`Tour ${r} · ${v.name} : ${outcome.content.trim()}`);
        } else {
          failures += 1;
          if (!firstError) firstError = error ?? "échec";
        }
      }
      // Toutes les voix du tour ont échoué (et ce n'est pas un arrêt
      // utilisateur) : le débat meurt franchement, comme en enchaîné.
      if (failures === conseillers.length && !ctx.signal.aborted) {
        throw new Error(firstError);
      }
    } else {
      for (const v of conseillers) {
        if (ctx.signal.aborted) break;
        const rowId = `t${r}-${v.id}`;
        flow.push({
          id: rowId,
          label: `Tour ${r} · ${v.name}`,
          detail: "répond aux arguments déjà posés",
          model: shortModel(v.model),
          status: "running",
        });
        const note =
          `Débat en ${rounds} tours — vous êtes au tour ${r}, posture : ${v.name}. ` +
          `Chaque tour voit ce qui a été dit avant : contredisez sur des faits, ` +
          `jamais sur des généralités. Votre intervention tient en ${ctx.voiceChars} ` +
          `caractères maximum : droit au but, sans préambule ni répétition de ce qui ` +
          `a déjà été dit.`;
        const outcome = await runVoiceWithRow(
          deps,
          ctx,
          flow,
          rowId,
          `Voix « ${v.name} » (tour ${r})`,
          {
            modelId: v.model,
            systemPrompt: (ctx.prompts.conseiller || "").replaceAll(
              "{angle}",
              v.name,
            ).replaceAll("{tours}", String(rounds)) || null,
            content: voicePromptContent(ctx.userContent, transcript, note),
            history: ctx.history,
            attachments: ctx.attachments,
            settings: ctx.settings,
          },
        );
        transcript.push(`Tour ${r} · ${v.name} : ${outcome.content.trim()}`);
        usages.push(outcome.usage);
        flow.update(rowId, { detail: excerptOf(outcome.content), status: "done" });
      }
    }
    // Un arrêt utilisateur ne lance pas le tour suivant : la boucle externe
    // s'arrête avec l'interne (sinon le tour suivant partait pour échouer).
    if (ctx.signal.aborted) break;
  }
  // Verdict : le juge streame la réponse conservée (une seule en base).
  // Garde d'abort : un Stop pendant les tours ne lance pas le verdict.
  ensureNotAborted(ctx);
  flow.push({
    id: "verdict",
    label: "Verdict",
    detail: "compare les tours, tranche une position",
    model: shortModel(juge.model),
    status: "running",
  });
  const outcome = await runVoiceWithRow(
    deps,
    ctx,
    flow,
    "verdict",
    "Verdict du débat",
    {
      modelId: juge.model,
      systemPrompt:
        (ctx.prompts.juge || "").replaceAll("{tours}", String(rounds)) || null,
      content: voicePromptContent(
        ctx.userContent,
        transcript,
        `Débat terminé après ${rounds} tours. Rendez le verdict : comparez les arguments réellement tenus, tranchez UNE position, dites ce que vous écartez et pourquoi.`,
      ),
      history: ctx.history,
      attachments: ctx.attachments,
      settings: ctx.settings,
    },
    { onDelta: ctx.onFinalDelta, onStatus: ctx.onFinalStatus },
  );
  usages.push(outcome.usage);
  flow.update("verdict", { detail: "verdict rendu", status: "done" });
  return {
    content: outcome.content,
    reasoning: outcome.reasoning,
    model: outcome.model,
    usage: sumUsage(usages),
    tag: `Verdict · Débat — ${rounds} tours`,
    rows: flow.rows,
  };
}

// ── Conseil : membres en parallèle, anonymisés, puis le président fusionne ──

async function runCouncil(
  ctx: OrchestratorContext,
  deps: OrchestratorDeps,
  flow: FlowRecorder,
  members: NamedVoice[],
  president: NamedVoice,
): Promise<OrchestratorResult> {
  // Annonce : les membres et le président apparaissent tout de suite
  // (« en attente »), puis chaque membre s'allume quand sa réponse part.
  for (const m of members) {
    flow.push({
      id: m.id,
      label: m.name,
      detail: "lecture seule — ne voit pas les autres",
      model: shortModel(m.model),
      status: "pending",
    });
  }
  flow.push({
    id: "president",
    label: "Président",
    detail: "compare les avis anonymisés, fusionne",
    model: shortModel(president.model),
    status: "pending",
  });
  // C-07/F-21 : usage cumulé de tous les membres + président.
  const usages: ({ input?: number; output?: number; cost?: number } | undefined)[] = [];
  // Divergence : chaque membre répond de son côté, sans voir les autres,
  // sans rien modifier (lecture seule — règle du mode, pas un réglage).
  // C-07 : passage par runVoiceWithRow — les membres reçoivent eux aussi le
  // modèle de la conversation (modelId null résolu), les instructions
  // locales composées et les sources web, comme toute voix orchestrée.
  const avis = await Promise.all(
    members.map(async (m, idx) => {
      const letter = String.fromCharCode(65 + idx); // A, B, C…
      flow.update(m.id, {
        status: "running",
        detail: "répond de son côté, sans voir les autres",
      });
      try {
        const outcome = await runVoiceWithRow(
          deps,
          ctx,
          flow,
          m.id,
          `Membre « ${m.name} »`,
          {
            modelId: m.model,
            systemPrompt: ctx.prompts.membre
              ? `${ctx.prompts.membre}\n\n${COUNCIL_READ_ONLY_RULE}`
              : COUNCIL_READ_ONLY_RULE,
            content: voicePromptContent(ctx.userContent, []),
            history: ctx.history,
            attachments: ctx.attachments,
            settings: ctx.settings,
          },
        );
        usages.push(outcome.usage);
        flow.update(m.id, { detail: excerptOf(outcome.content), status: "done" });
        return {
          letter,
          content: outcome.content.trim(),
          error: undefined as string | undefined,
        };
      } catch (err) {
        return { letter, content: "", error: err instanceof Error ? err.message : "échec" };
      }
    }),
  );
  // (audit 2026-11-21) Toutes les voix membres ont échoué → le conseil meurt
  // franchement, même garde que le débat : lancer quand même le président
  // avec « Voici leurs avis… » suivi de rien gaspillait un appel LLM et
  // produisait une fusion absurde sur une liste vide.
  const echecs = avis.filter((a) => !a.content && a.error);
  if (echecs.length === members.length && !ctx.signal.aborted) {
    throw new Error(echecs[0]?.error ?? "toutes les voix du conseil ont échoué");
  }
  // Fusion : les avis partent anonymisés (A, B, C…) — on juge les arguments,
  // pas les auteurs. Le président streame la réponse conservée.
  // Garde d'abort : un Stop pendant les membres ne lance pas le président.
  ensureNotAborted(ctx);
  flow.update("president", {
    status: "running",
    detail: "compare les avis anonymisés, fusionne",
  });
  const anonymes = avis
    .filter((a) => a.content)
    .map((a) => `Avis ${a.letter} :\n${a.content}`)
    .join("\n\n");
  const outcome = await runVoiceWithRow(
    deps,
    ctx,
    flow,
    "president",
    "Président du conseil",
    {
      modelId: president.model,
      systemPrompt: ctx.prompts.president
        ? ctx.prompts.president.replaceAll("{membres}", String(members.length))
        : null,
      content: voicePromptContent(
        ctx.userContent,
        [],
        `Vous présidez un conseil de ${members.length} voix. Voici leurs avis, anonymisés :\n\n${anonymes}`,
      ),
      history: ctx.history,
      attachments: ctx.attachments,
      settings: ctx.settings,
    },
    { onDelta: ctx.onFinalDelta, onStatus: ctx.onFinalStatus },
  );
  usages.push(outcome.usage);
  flow.update("president", { detail: "fusion rendue", status: "done" });
  return {
    content: outcome.content,
    reasoning: outcome.reasoning,
    model: outcome.model,
    usage: sumUsage(usages),
    tag: `Fusion · Conseil — ${members.length} membres`,
    rows: flow.rows,
  };
}

// ── Auto : débat (facultatif) → plan → code → test, reprises sur échec prouvé ──

async function runAuto(
  ctx: OrchestratorContext,
  deps: OrchestratorDeps,
  flow: FlowRecorder,
  modelOf: (voiceId: string) => string | null,
  withDebat: boolean,
  retries: number,
): Promise<OrchestratorResult> {
  const transcript: string[] = [];
  // C-07/F-21 : usage cumulé de toutes les étapes (débat, plan, code, test,
  // reprises) — le coût réel du mode Auto.
  const usages: ({ input?: number; output?: number; cost?: number } | undefined)[] = [];
  const runStep = async (
    rowId: string,
    label: string,
    detail: string,
    modelId: string | null,
    prompt: string,
    content: string,
  ) => {
    // Garde d'abort : un Stop entre deux étapes n'envoie pas la suivante.
    ensureNotAborted(ctx);
    flow.push({ id: rowId, label, detail, model: shortModel(modelId), status: "running" });
    const outcome = await runVoiceWithRow(deps, ctx, flow, rowId, label, {
      modelId,
      systemPrompt: prompt || null,
      content,
      history: ctx.history,
      attachments: ctx.attachments,
      settings: ctx.settings,
    });
    usages.push(outcome.usage);
    transcript.push(`${label} : ${outcome.content.trim()}`);
    flow.update(rowId, { detail: excerptOf(outcome.content), status: "done" });
    return outcome;
  };

  let stepNo = 0;
  if (withDebat) {
    stepNo += 1;
    await runStep(
      "debat",
      `${stepNo} · Débat`,
      "cadrage préalable avant d'agir",
      modelOf("debat"),
      ctx.prompts.debat ?? "",
      voicePromptContent(ctx.userContent, []),
    );
  }
  stepNo += 1;
  const planOutcome = await runStep(
    "plan",
    `${stepNo} · Plan`,
    "étapes numérotées, critère par étape",
    modelOf("plan"),
    ctx.prompts.plan ?? "",
    voicePromptContent(ctx.userContent, transcript),
  );
  stepNo += 1;
  const codeOutcome = await runStep(
    "code",
    `${stepNo} · Code`,
    "applique le plan, preuve par commande",
    modelOf("code"),
    ctx.prompts.code ?? "",
    voicePromptContent(ctx.userContent, transcript),
  );

  // Test : la preuve fait foi — un échec prouvé déclenche une reprise qui
  // corrige LA cause racine (jamais une rustine), puis repasse le test.
  stepNo += 1;
  // Garde d'abort : le test ne part pas si l'utilisateur a arrêté pendant
  // le code (la boucle de reprises ci-dessous vérifie déjà le signal).
  ensureNotAborted(ctx);
  const testLabel = `${stepNo} · Test`;
  flow.push({
    id: "test",
    label: testLabel,
    detail: "la commande qui prouve que ça marche",
    model: shortModel(modelOf("test")),
    status: "running",
  });
  const runTest = (content: string) =>
    runVoiceWithRow(deps, ctx, flow, "test", testLabel, {
      modelId: modelOf("test"),
      systemPrompt: ctx.prompts.test || null,
      content,
      history: ctx.history,
      attachments: ctx.attachments,
      settings: ctx.settings,
    }).then((o) => {
      usages.push(o.usage);
      return o;
    });
  let testOutcome = await runTest(voicePromptContent(ctx.userContent, transcript));
  let reprisesUsed = 0;
  while (testFailed(testOutcome.content) && reprisesUsed < retries && !ctx.signal.aborted) {
    reprisesUsed += 1;
    flow.update("test", { detail: "échec prouvé — reprise en cours", status: "running" });
    flow.push({
      id: `reprise-${reprisesUsed}`,
      label: `Reprise ${reprisesUsed}/${retries}`,
      detail: "corrige la vraie cause, jamais une rustine",
      status: "running",
    });
    const repriseOutcome = await runVoiceWithRow(
      deps,
      ctx,
      flow,
      `reprise-${reprisesUsed}`,
      `Reprise ${reprisesUsed}/${retries}`,
      {
        modelId: modelOf("code"),
        systemPrompt:
          (ctx.prompts.reprise || "").replaceAll(
            "{reprises}",
            String(retries - reprisesUsed),
          ) || null,
        content: voicePromptContent(
          ctx.userContent,
          [...transcript, `${testLabel} : ${testOutcome.content.trim()}`],
          `Le test échoue. Reprises restantes : ${retries - reprisesUsed}.`,
        ),
        history: ctx.history,
        attachments: ctx.attachments,
        settings: ctx.settings,
      },
    );
    transcript.push(`Reprise ${reprisesUsed} : ${repriseOutcome.content.trim()}`);
    usages.push(repriseOutcome.usage);
    flow.update(`reprise-${reprisesUsed}`, {
      detail: excerptOf(repriseOutcome.content),
      status: "done",
    });
    // Garde d'abort : un Stop pendant la reprise ne relance pas le test.
    ensureNotAborted(ctx);
    flow.update("test", { detail: "re-test après correction" });
    testOutcome = await runTest(voicePromptContent(ctx.userContent, transcript));
  }
  const passed = !testFailed(testOutcome.content);
  flow.update("test", {
    detail: passed ? "preuve passée" : "échec — écart laissé ouvert",
    status: passed ? "done" : "error",
  });
  flow.push({
    id: "reprises",
    label: "Reprises",
    detail:
      reprisesUsed > 0
        ? `${reprisesUsed} reprise(s) — cause racine corrigée à chaque fois`
        : "aucune nécessaire",
    status: reprisesUsed > 0 ? "done" : "pending",
  });

  // Le bilan : la modification conservée + la preuve. Une seule réponse
  // en base — la conversation reste propre à la lecture et au partage.
  const bilan = [
    codeOutcome.content.trim(),
    "",
    "---",
    "",
    `**Preuve (test)**`,
    "",
    testOutcome.content.trim(),
    reprisesUsed > 0
      ? `\n\n_Reprises : ${reprisesUsed} — la cause racine a été corrigée avant chaque re-test._`
      : "",
  ].join("\n");
  // C-07 : le bilan est construit d'un bloc (pas streamé par une étape) —
  // on le pousse néanmoins via onFinalDelta pour que le chat voie la
  // réponse s'écrire comme dans tout autre mode, et que le suivi
  // d'artefacts (blocs ``` file) s'applique aussi au mode Auto.
  if (ctx.onFinalDelta && bilan.length > 0) {
    // Pas de découpe : un seul delta honnête (le bilan est déjà là).
    ctx.onFinalDelta(bilan);
  }
  return {
    content: bilan,
    reasoning: codeOutcome.reasoning || planOutcome.reasoning,
    model: codeOutcome.model,
    usage: sumUsage(usages),
    tag: `Bilan · Auto${reprisesUsed ? ` — ${reprisesUsed} reprise(s)` : ""}`,
    rows: flow.rows,
  };
}

/** Point d'entrée : exécute le mode multi-voix et renvoie LA réponse conservée. */
export async function runOrchestratedTurn(
  ctx: OrchestratorContext,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  const flow = new FlowRecorder(ctx.onFlow);
  // Annonce : toutes les voix démarrent « en attente » — le déroulé est
  // visible dès le premier instant, chaque ligne s'allume à son tour.
  const voices: NamedVoice[] = voicesFor(ctx.mode, ctx.config).map((v) => ({
    id: v.id,
    name: v.name,
    model: ctx.config?.voices?.[ctx.mode]?.[v.id] ?? null,
  }));

  if (ctx.mode === "debate") {
    const rounds = Math.min(
      DEBATE_ROUNDS_MAX,
      Math.max(DEBATE_ROUNDS_MIN, ctx.rounds ?? 3),
    );
    const conseillers = voices.filter((v) => v.id !== "juge");
    const juge = voices.find((v) => v.id === "juge")!;
    return runDebate(ctx, deps, flow, conseillers, juge, rounds);
  }
  if (ctx.mode === "council") {
    const members = voices.filter((v) => v.id !== "president");
    const president = voices.find((v) => v.id === "president")!;
    return runCouncil(ctx, deps, flow, members, president);
  }
  if (ctx.mode === "auto") {
    return runAuto(
      ctx,
      deps,
      flow,
      (voiceId) => ctx.config?.voices?.auto?.[voiceId] ?? null,
      ctx.config?.autoDebate !== false,
      Math.max(0, Math.min(3, ctx.config?.retries ?? 2)),
    );
  }
  throw new Error(`Mode non orchestré : ${ctx.mode}`);
}
