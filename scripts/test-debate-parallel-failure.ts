// Test de régression Lot 4 (audit L4-5) — débat PARALLÈLE avec une voix en
// échec sur trois : le cas exact que la fuite de stallGuard (L1-4) aggravait —
// un seul 401 créait 3 flux fantômes d'un coup et pouvait faire mourir le
// débat entier. Contrat : UNE voix morte n'empêche PAS le débat de continuer
// (les autres voix du tour répondent, la transcription omet la morte, le juge
// rend quand même le verdict) ; SEULE la perte de TOUTES les voix d'un tour
// tue le débat (déjà couvert par le service). Le déroulé reste honnête : la
// ligne de la voix morte est en « error », jamais « en cours » sans fin.
import { runOrchestratedTurn, type OrchestratorContext, type OrchestratorDeps } from "../mini-services/hermes-chat/orchestrator";
import type { ModeFlowRow } from "../mini-services/hermes-chat/types";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const DEAD_VOICE = "pragmatique";
let calls = 0;
let jugeCalls = 0;
let jugeContent = "";
const deps: OrchestratorDeps = {
  async runVoiceTurn(req, cb) {
    calls++;
    if (req.content.includes("Rendez le verdict")) {
      jugeCalls++;
      jugeContent = req.content;
      return { content: "VERDICT DU JUGE (mock)", reasoning: "", model: "mock-juge" };
    }
    if (req.content.includes("posture : Pragmatique")) {
      // La voix morte : échec franc, comme un 401 du fournisseur.
      throw new Error("voix en panne simulée (HTTP 401)");
    }
    if (cb.signal.aborted) throw new Error("Stop utilisateur (test)");
    const angle = /posture : (\w+)/.exec(req.content)?.[1] ?? "voix";
    return { content: `Argument de ${angle}`, reasoning: "", model: "mock" };
  },
};

async function main() {
  process.on("unhandledRejection", (err) => {
    failures++;
    console.error("  ÉCHEC  rejet non géré pendant le débat :", err);
  });

  const flowRows: ModeFlowRow[] = [];
  const controller = new AbortController();
  const ctx: OrchestratorContext = {
    conversationId: "c-test",
    messageId: "m-verdict",
    mode: "debate",
    config: { debateParallel: true },
    rounds: 3,
    voiceChars: 2000,
    userContent: "faut-il migrer la base ?",
    history: [],
    prompts: {},
    signal: controller.signal,
    onFlow: (rows) => { flowRows.length = 0; flowRows.push(...rows); },
    onFinalDelta: () => {},
    onFinalStatus: () => {},
  };

  console.log("[1] le débat survit à une voix morte");
  let outcome: Awaited<ReturnType<typeof runOrchestratedTurn>> | null = null;
  try {
    outcome = await runOrchestratedTurn(ctx, deps);
  } catch (err) {
    check("le débat résout malgré 1 voix en échec sur 3", false,
      `rejeté : ${err instanceof Error ? err.message : err}`);
  }
  check("le débat résout malgré 1 voix en échec sur 3", Boolean(outcome));
  check("la réponse conservée est le VERDICT", outcome?.content === "VERDICT DU JUGE (mock)",
    outcome?.content.slice(0, 40));
  check("étiquette de mode posée", outcome?.tag === "Verdict · Débat — 3 tours", outcome?.tag);

  console.log("[2] le juge a vu les voix vivantes, pas la morte");
  check("le juge est appelé exactement une fois", jugeCalls === 1, `appels: ${jugeCalls}`);
  check("la transcription du juge contient les voix vivantes (ordre canonique)",
    jugeContent.includes("Argument de Sceptique") && jugeContent.includes("Argument de Innovateur"));
  check("la transcription du juge ne contient PAS la voix morte",
    !jugeContent.includes("voix en panne simulée"));

  console.log("[3] le déroulé est honnête");
  const dead = flowRows.filter((r) => r.label.includes("Pragmatique"));
  const alive = flowRows.filter((r) => r.label.includes("Sceptique"));
  const verdict = flowRows.find((r) => r.id === "verdict");
  check("chaque tour a une ligne pour la voix morte, en « error »",
    dead.length === 3 && dead.every((r) => r.status === "error"), `${dead.length} lignes`);
  check("chaque tour a une ligne pour la voix vivante, en « done »",
    alive.length === 3 && alive.every((r) => r.status === "done"), `${alive.length} lignes`);
  check("la ligne du verdict est « done »", verdict?.status === "done", verdict?.status);

  console.log("[4] volume d'appels");
  check("10 appels LLM (3 tours × 3 voix + verdict)", calls === 10, `appels: ${calls}`);

  console.log(failures === 0 ? "\nDébat parallèle dégradé : 0 échec" : `\nDébat parallèle dégradé : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
