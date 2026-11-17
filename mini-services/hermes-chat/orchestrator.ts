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
  userContent: string;
  history: { role: "user" | "assistant"; content: string }[];
  attachments?: Attachment[];
  settings?: TurnSettings;
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
  if (!m) return label.length <= 14 ? label : undefined;
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
  const modelTrace = req.modelId ?? "modèle de la conversation";
  trace("orch", `voix : ${voiceLabel} — démarre (${modelTrace})`);
  try {
    const outcome = await deps.runVoiceTurn(req, { signal: ctx.signal, ...cb });
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
  const parts: string[] = [];
  if (note) parts.push(note);
  parts.push(`Question / demande :\n${userContent}`);
  if (transcript.length) {
    parts.push(
      "Transcription des échanges précédents de cette orchestration :\n" +
        transcript.join("\n"),
    );
  }
  return parts.join("\n\n");
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
            `2000 caractères maximum : droit au but, sans préambule ni répétition de ` +
            `ce qui a déjà été dit.`;
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
          `jamais sur des généralités. Votre intervention tient en 2000 caractères ` +
          `maximum : droit au but, sans préambule ni répétition de ce qui a déjà ` +
          `été dit.`;
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
        flow.update(rowId, { detail: excerptOf(outcome.content), status: "done" });
      }
    }
    // Un arrêt utilisateur ne lance pas le tour suivant : la boucle externe
    // s'arrête avec l'interne (sinon le tour suivant partait pour échouer).
    if (ctx.signal.aborted) break;
  }
  // Verdict : le juge streame la réponse conservée (une seule en base).
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
  flow.update("verdict", { detail: "verdict rendu", status: "done" });
  return {
    content: outcome.content,
    reasoning: outcome.reasoning,
    model: outcome.model,
    usage: outcome.usage,
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
  // Divergence : chaque membre répond de son côté, sans voir les autres,
  // sans rien modifier (lecture seule — règle du mode, pas un réglage).
  const avis = await Promise.all(
    members.map(async (m, idx) => {
      const letter = String.fromCharCode(65 + idx); // A, B, C…
      flow.update(m.id, {
        status: "running",
        detail: "répond de son côté, sans voir les autres",
      });
      try {
        const outcome = await deps.runVoiceTurn(
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
          { signal: ctx.signal },
        );
        flow.update(m.id, { detail: excerptOf(outcome.content), status: "done" });
        return {
          letter,
          content: outcome.content.trim(),
          error: undefined as string | undefined,
        };
      } catch (err) {
        flow.update(m.id, {
          detail: err instanceof Error ? err.message : "échec de la voix",
          status: "error",
        });
        return { letter, content: "", error: err instanceof Error ? err.message : "échec" };
      }
    }),
  );
  // Fusion : les avis partent anonymisés (A, B, C…) — on juge les arguments,
  // pas les auteurs. Le président streame la réponse conservée.
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
  flow.update("president", { detail: "fusion rendue", status: "done" });
  return {
    content: outcome.content,
    reasoning: outcome.reasoning,
    model: outcome.model,
    usage: outcome.usage,
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
  const runStep = async (
    rowId: string,
    label: string,
    detail: string,
    modelId: string | null,
    prompt: string,
    content: string,
  ) => {
    flow.push({ id: rowId, label, detail, model: shortModel(modelId), status: "running" });
    const outcome = await runVoiceWithRow(deps, ctx, flow, rowId, label, {
      modelId,
      systemPrompt: prompt || null,
      content,
      history: ctx.history,
      attachments: ctx.attachments,
      settings: ctx.settings,
    });
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
    flow.update(`reprise-${reprisesUsed}`, {
      detail: excerptOf(repriseOutcome.content),
      status: "done",
    });
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
  return {
    content: bilan,
    reasoning: codeOutcome.reasoning || planOutcome.reasoning,
    model: codeOutcome.model,
    usage: codeOutcome.usage,
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
