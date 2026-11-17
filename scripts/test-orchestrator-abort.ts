// Test de régression Lot 1 — gardes d'abort de l'orchestrateur (audit L1-6,
// correctif 1.6) : au Stop utilisateur, les étapes qui n'ont pas démarré ne
// partent plus — verdict du débat, président du conseil, étapes de l'auto.
// Avant le correctif, le verdict/président partaient après l'abort (tour
// mort-né qui courait quand même) et l'auto enchaînait plan/code/test.
//
// L'orchestrateur est appelé EN PROCESSUS avec un faux runVoiceTurn qui
// déclenche l'abort à un compteur d'appel précis — déterministe, sans délai :
//   1. débat : abort à la 1re voix du tour 2 → les 6 conseillers ont été
//      appelés, le JUGE ZÉRO fois, la promesse rejette (tour « stopped »)
//   2. conseil : abort à la 2e voix → les membres ont répondu/échoué, le
//      PRÉSIDENT ZÉRO fois, rejet
//   3. auto : abort au plan (2e appel) → le code et le test ZÉRO fois, rejet
import { runOrchestratedTurn, type OrchestratorContext, type OrchestratorDeps } from "../mini-services/hermes-chat/orchestrator";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function makeHarness(abortOnCall: number) {
  const controller = new AbortController();
  let calls = 0;
  const jugeCalls: string[] = [];
  const presidentCalls: string[] = [];
  const autoCodeOrTest: string[] = [];
  const deps: OrchestratorDeps = {
    async runVoiceTurn(req) {
      calls++;
      if (req.content.includes("Rendez le verdict")) jugeCalls.push(req.content);
      if (req.content.includes("Vous présidez un conseil")) presidentCalls.push(req.content);
      if (req.content.includes("applique le plan") || req.content.includes("la commande qui prouve"))
        autoCodeOrTest.push(req.content);
      if (calls === abortOnCall) controller.abort(new Error("Stop utilisateur (test)"));
      if (controller.signal.aborted) throw new Error("Stop utilisateur (test)");
      return { content: `OK ${req.content.slice(0, 40)}`, reasoning: "", model: "mock" };
    },
  };
  const flowRows: unknown[] = [];
  const ctx: OrchestratorContext = {
    conversationId: "c-test",
    messageId: "m-test",
    mode: "debate",
    config: { debateParallel: true },
    rounds: 3,
    voiceChars: 2000,
    userContent: "question de test",
    history: [],
    prompts: {},
    signal: controller.signal,
    onFlow: (rows) => flowRows.push(rows),
    onFinalDelta: () => {},
    onFinalStatus: () => {},
  };
  return { deps, ctx, counters: { get calls() { return calls; }, jugeCalls, presidentCalls, autoCodeOrTest } };
}

async function expectRejection(label: string, run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    check(label, false, "la promesse a résolu (aucun abort levé)");
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(label, true, `rejeté : ${msg}`);
    return msg;
  }
}

async function main() {
  console.log("[1] débat — Stop pendant le tour 2");
  {
    const h = makeHarness(4); // 1re voix du tour 2
    h.ctx.mode = "debate";
    await expectRejection("débat → tour rejeté à l'abort", () => runOrchestratedTurn(h.ctx, h.deps));
    check("les 6 conseillers (2 tours × 3 voix) ont été tentés", h.counters.calls === 6, `appels: ${h.counters.calls}`);
    check("le JUGE n'a JAMAIS été appelé après l'abort", h.counters.jugeCalls.length === 0,
      `appels juge: ${h.counters.jugeCalls.length}`);
  }

  console.log("[2] conseil — Stop pendant les membres");
  {
    // voicesFor : 2 membres par défaut (fallback = MIN quand config.members
    // est absent) + le président. L'abort tombe sur la 1re voix.
    const h = makeHarness(1);
    h.ctx.mode = "council";
    await expectRejection("conseil → tour rejeté à l'abort", () => runOrchestratedTurn(h.ctx, h.deps));
    check("le PRÉSIDENT n'a JAMAIS été appelé après l'abort", h.counters.presidentCalls.length === 0,
      `appels président: ${h.counters.presidentCalls.length}`);
    check("les membres ont répondu/échoué (2), puis plus RIEN", h.counters.calls === 2, `appels: ${h.counters.calls}`);
  }

  console.log("[3] auto — Stop pendant le plan");
  {
    const h = makeHarness(2); // 1re voix du cadrage ok, puis plan
    h.ctx.mode = "auto";
    await expectRejection("auto → tour rejeté à l'abort", () => runOrchestratedTurn(h.ctx, h.deps));
    check("le CODE et le TEST n'ont JAMAIS été appelés après l'abort",
      h.counters.autoCodeOrTest.length === 0, `appels code/test: ${h.counters.autoCodeOrTest.length}`);
    check("plus aucun appel LLM après l'abort", h.counters.calls === 2, `appels: ${h.counters.calls}`);
  }

  console.log(failures === 0 ? "\nAbort orchestrateur : 0 échec" : `\nAbort orchestrateur : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
