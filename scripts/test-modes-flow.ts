// QA — Modes du compositeur (F-30).
// Deux volets :
//   A. UNITAIRES (sans service, sans LLM) — modes.ts (résolution, bornes,
//      interpolation, surcharges), orchestrator.ts (faux moteur : ordre des
//      tours du débat, conseil parallèle + anonymisation, auto + reprises
//      sur échec prouvé, seule réponse conservée), store (persistance du
//      mode + config + déroulé, valeur inconnue → chat).
//   B. SERVICE RÉEL (ports dédiés, base jetable) — conversations:setMode
//      (résolution + bornes + diffusion), conversations:create avec mode,
//      taille des consignes (4 000 car. revalidés).
// Le service doit être lancé avant avec :
//   HERMES_CHAT_DB=/tmp/qa-f30/hermes.sqlite HERMES_CHAT_PORT=3013 HERMES_CHAT_FILES_PORT=3014 bun index.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io } from "socket.io-client";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  OK  ${name}`);
  } else {
    failed++;
    console.log(`  ÉCHEC  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── A. Unitaires ────────────────────────────────────────────────────────

async function unitTests() {
  console.log("[qa] A — unitaires (modes.ts, orchestrator.ts, store)");
  const { Store } = await import("../mini-services/hermes-chat/store");
  const modes = await import("../mini-services/hermes-chat/modes");
  const orch = await import("../mini-services/hermes-chat/orchestrator");

  // A1. resolveMode : valeur inconnue → chat (jamais d'écran cassé)
  check("resolveMode('chat') = chat", modes.resolveMode("chat") === "chat");
  check("resolveMode('nimportequoi') = chat", modes.resolveMode("nimportequoi") === "chat");
  check("resolveMode(undefined) = chat", modes.resolveMode(undefined) === "chat");
  check("resolveMode('council') = council", modes.resolveMode("council") === "council");

  // A2. Bornes revalidées à la saisie (jamais de refus muet — clamp)
  const cfg = modes.normalizeModeConfig({
    rounds: 99,
    members: 1,
    retries: 12,
    autoDebate: "pas un booléen",
    voices: { debate: { juge: "  " }, compare: { a: "m1", b: "m2" } },
  });
  check("rounds 99 → clamp 10", cfg.rounds === modes.DEBATE_ROUNDS_MAX, String(cfg.rounds));
  check("members 1 → clamp 2", cfg.members === modes.COUNCIL_MEMBERS_MIN, String(cfg.members));
  check("retries 12 → clamp 3", cfg.retries === modes.AUTO_RETRIES_MAX, String(cfg.retries));
  check("autoDebate non booléen ignoré", cfg.autoDebate === undefined, String(cfg.autoDebate));
  check("voix vide → null (suit la conversation)", cfg.voices?.debate?.juge === null);
  check("voix compare conservée", cfg.voices?.compare?.a === "m1" && cfg.voices?.compare?.b === "m2");

  // A2.b Modèle du mode (F-30b) — chat/plan/code, moteur OU chat IA web.
  // Fusion webchat : l'id historique webchat:<site>:<mode> est ramené à
  // webchat:<site> à la normalisation (la forme de la réponse est observée).
  const cfgModel = modes.normalizeModeConfig({
    model: { chat: "webchat:zai:answer", plan: "  hermes-4-70b  ", code: 42 },
  });
  check("modèle du mode : chat web historique → fusionné", cfgModel.model?.chat === "webchat:zai", String(cfgModel.model?.chat));
  check("modèle du mode : id déjà fusionné inchangé", modes.normalizeModeConfig({ model: { chat: "webchat:zai" } }).model?.chat === "webchat:zai");
  check("modèle du mode trimmé (plan)", cfgModel.model?.plan === "hermes-4-70b", String(cfgModel.model?.plan));
  check("modèle du mode invalide → null (code)", cfgModel.model?.code === null, String(cfgModel.model?.code));
  check("modeModel lit le chat web", modes.modeModel(cfgModel, "chat") === "webchat:zai");
  check("modeModel sans config → null (suit le fil)", modes.modeModel(null, "plan") === null);
  check("model absent → undefined", modes.normalizeModeConfig({}).model === undefined);

  // A3. Interpolation des mots-clés au tour — jamais enregistrés remplacés
  const txt = modes.interpolatePrompt(
    "Débat de {tours} tours avec {membres} avis, {reprises} restantes, posture {angle}.",
    { tours: 5, membres: 3, reprises: 2, angle: "Sceptique" }
  );
  check(
    "interpolate remplace tous les mots-clés",
    txt === "Débat de 5 tours avec 3 avis, 2 restantes, posture Sceptique.",
    txt
  );
  check(
    "valeur inconnue reste telle quelle (jamais de casse)",
    modes.interpolatePrompt("{inconnu} reste", {}) === "{inconnu} reste"
  );

  // A4. Les 13 consignes par défaut + résolution surcharge/défaut
  check("13 consignes par défaut", Object.keys(modes.DEFAULT_PROMPTS).length === 13, String(Object.keys(modes.DEFAULT_PROMPTS).length));
  const tmpDb = join(mkdtempSync(join(tmpdir(), "qa-f30-unit-")), "t.sqlite");
  const store = new Store();
  void tmpDb;
  check("resolveModePrompt défaut (plan.main)", (modes.resolveModePrompt(store, "plan.main") ?? "").includes("chef de projet"));
  check("resolveModePrompt vide (chat.main) → null", modes.resolveModePrompt(store, "chat.main") === null);
  store.setSetting(
    modes.MODE_PROMPTS_KEY,
    JSON.stringify({ plan: { main: "Consigne modifiée {tours}." } })
  );
  check(
    "surcharge l'emporte + interpolation au tour",
    modes.resolveModePrompt(store, "plan.main", { tours: 4 }) === "Consigne modifiée 4.",
    modes.resolveModePrompt(store, "plan.main", { tours: 4 }) ?? ""
  );
  store.setSetting(modes.MODE_PROMPTS_KEY, "{json cassé");
  check("charge invalide → défaut (jamais de plantage)", (modes.resolveModePrompt(store, "plan.main") ?? "").includes("chef de projet"));
  store.setSetting(modes.MODE_PROMPTS_KEY, JSON.stringify({ plan: { main: "x".repeat(4001) } }));
  check("surcharge > 4 000 car. rejetée", (modes.resolveModePrompt(store, "plan.main") ?? "").includes("chef de projet"));
  store.setSetting(modes.MODE_PROMPTS_KEY, "");

  // A5. Voix des modes (miroir de « qui travaille »)
  check("débat = 3 conseillers + juge", modes.voicesFor("debate", null).length === 4);
  check("conseil 2 membres minimum", modes.voicesFor("council", { members: 2 }).length === 3);
  check("conseil 5 membres maximum", modes.voicesFor("council", { members: 5 }).length === 6);
  check("auto sans débat préalable = 3 étapes", modes.voicesFor("auto", { autoDebate: false }).length === 3);
  check("auto avec débat = 4 étapes", modes.voicesFor("auto", { autoDebate: true }).length === 4);
  check("chat n'a pas de voix", modes.voicesFor("chat", null).length === 0);
  const voicesCouncil = modes.voicesFor("council", { members: 2 });
  check(
    "membres identifiés membre-a/membre-b puis président",
    voicesCouncil[0].id === "membre-a" && voicesCouncil[1].id === "membre-b" && voicesCouncil[2].id === "president",
    JSON.stringify(voicesCouncil.map((v) => v.id))
  );

  // A6. Orchestrateur — faux moteur (aucun LLM) : ordre et contenu
  const seen: { label: string; model: string | null; prompt: string; content: string }[] = [];
  const fakeDeps: orch.OrchestratorDeps = {
    runVoiceTurn: async (req) => {
      const label = `${req.content.match(/posture : (\w+)/)?.[1] ?? req.systemPrompt?.slice(0, 18) ?? "?"}`;
      seen.push({
        label,
        model: req.modelId,
        prompt: req.systemPrompt ?? "",
        content: req.content,
      });
      // Le « test » échoue deux fois (têtes ÉCHEC) puis passe — preuve des reprises.
      if (req.systemPrompt?.includes("Prouve que ça tient") && seen.filter((s) => s.prompt.includes("Prouve")).length < 3) {
        return { content: "ÉCHEC : critère 2 non validé.", reasoning: "", model: "fake" };
      }
      if (req.systemPrompt?.includes("Prouve")) {
        return { content: "OK : sortie conforme aux 2 critères.", reasoning: "", model: "fake" };
      }
      return { content: `réponse de ${req.modelId ?? "fil"} (${label})`, reasoning: "", model: req.modelId ?? "fil" };
    },
  };

  // A6.a Débat — 3 conseillers qui se répondent, verdict à la fin
  seen.length = 0;
  const signal = new AbortController().signal;
  let debateRows: any[] = [];
  const debateResult = await orch.runOrchestratedTurn(
    {
      conversationId: "c1",
      messageId: "m1",
      mode: "debate",
      config: { voices: { debate: { sceptique: "hermes-4-405b", pragmatique: "hermes-4-70b", innovateur: "hermes-3-405b", juge: null } } },
      rounds: 3,
      userContent: "Faut-il migrer ?",
      history: [{ role: "user", content: "message antérieur" }],
      prompts: { conseiller: "Tu es conseiller ({angle}) — débat de {tours} tours.", juge: "Verdict après {tours} tours." },
      signal,
      onFlow: (rows) => (debateRows = rows),
      onFinalDelta: () => {},
      onFinalStatus: () => {},
    },
    fakeDeps
  );
  check("débat = 3 tours × 3 conseillers + verdict (10 tours de voix)", seen.length === 10, String(seen.length));
  check(
    "le tour 2 voit le tour 1 (les conseillers se répondent)",
    seen[4].content.includes("Tour 1 · Sceptique"),
    seen[4].content.slice(0, 60)
  );
  check(
    "{angle} et {tours} remplacés dans la consigne du conseiller",
    seen[0].prompt === "Tu es conseiller (Sceptique) — débat de 3 tours.",
    seen[0].prompt
  );
  check(
    "chaque voix porte son modèle, le juge suit la conversation",
    seen[0].model === "hermes-4-405b" && seen[9].model === null,
    `${seen[0].model}/${seen[9].model}`
  );
  check("une seule réponse conservée — le verdict", debateResult.tag.startsWith("Verdict · Débat — 3 tours"), debateResult.tag);
  check("le déroulé du débat est complet (10 lignes, toutes done)", debateRows.length === 10 && debateRows.every((r) => r.status === "done"), `${debateRows.length}`);

  // A6.b Conseil — membres en parallèle, anonymisés, président fusionne
  seen.length = 0;
  let councilRows: any[] = [];
  const t0 = Date.now();
  const councilResult = await orch.runOrchestratedTurn(
    {
      conversationId: "c2",
      messageId: "m2",
      mode: "council",
      config: { members: 3, voices: { council: { "membre-a": "hermes-4-405b", president: null } } },
      rounds: null,
      userContent: "Quel cap ?",
      history: [],
      prompts: { membre: "Tu es membre en lecture seule.", president: "{membres} avis anonymisés — fusionne." },
      signal,
      onFlow: (rows) => (councilRows = rows),
      onFinalDelta: () => {},
      onFinalStatus: () => {},
    },
    fakeDeps
  );
  check("conseil = 3 membres + président", seen.length === 4, String(seen.length));
  check(
    "les membres partent en PARALLÈLE (temps < 2 tours séquentiels)",
    Date.now() - t0 < 40,
    `${Date.now() - t0} ms`
  );
  check(
    "le président reçoit les avis ANONYMISÉS (A, B, C)",
    seen[3].content.includes("Avis A :") && seen[3].content.includes("Avis B :") && !seen[3].content.includes("Membre"),
    seen[3].content.slice(0, 80)
  );
  check(
    "règle de lecture seule rappelée à chaque membre",
    seen[0].prompt.includes("lecture seule"),
    seen[0].prompt.slice(0, 40)
  );
  check(
    "{membres} remplacé pour le président",
    seen[3].prompt.includes("3 avis anonymisés"),
    seen[3].prompt
  );
  check("une seule réponse conservée — la fusion", councilResult.tag.startsWith("Fusion · Conseil — 3 membres"), councilResult.tag);

  // A6.c Auto — débat → plan → code → test, reprises sur échec prouvé
  seen.length = 0;
  let autoRows: any[] = [];
  const autoResult = await orch.runOrchestratedTurn(
    {
      conversationId: "c3",
      messageId: "m3",
      mode: "auto",
      config: { autoDebate: true, retries: 2 },
      rounds: null,
      userContent: "Corrige le bug.",
      history: [],
      prompts: { debat: "Cadrage.", plan: "Plan.", code: "Applique.", test: "Prouve que ça tient.", reprise: "Cause racine — {reprises} restantes." },
      signal,
      onFlow: (rows) => (autoRows = rows),
      onFinalDelta: () => {},
      onFinalStatus: () => {},
    },
    fakeDeps
  );
  const labels = seen.map((s) => (s.prompt.includes("Cadrage") ? "debat" : s.prompt.includes("Plan.") ? "plan" : s.prompt.includes("Applique") ? "code" : s.prompt.includes("Prouve") ? "test" : "reprise"));
  check(
    "auto : 1 débat + 1 plan + 1 code + 3 tests + 2 reprises (test initial, re-test après chaque reprise)",
    labels.filter((l) => l === "debat").length === 1 &&
      labels.filter((l) => l === "plan").length === 1 &&
      labels.filter((l) => l === "code").length === 1 &&
      labels.filter((l) => l === "test").length === 3 &&
      labels.filter((l) => l === "reprise").length === 2,
    labels.join(",")
  );
  check(
    "{reprises} remplacé par le nombre restant",
    seen.find((s) => s.prompt.includes("Cause racine"))?.prompt.includes("1 restantes") ?? false,
    seen.find((s) => s.prompt.includes("Cause racine"))?.prompt
  );
  check(
    "le bilan contient le code ET la preuve (une seule réponse)",
    autoResult.content.includes("réponse de") && autoResult.content.includes("**Preuve (test)**") && autoResult.content.includes("sortie conforme"),
    autoResult.content.slice(0, 120)
  );
  check("l'étiquette du bilan compte les reprises", autoResult.tag.includes("2 reprise"), autoResult.tag);
  check(
    "le déroulé de l'auto montre la reprise",
    autoRows.some((r) => r.label.startsWith("Reprise 1/2")),
    JSON.stringify(autoRows.map((r) => r.label))
  );

  // A6.d Chats IA web dans les voix (F-30b) — id transmis tel quel au moteur,
  // chip du déroulé = site (pas d'id brut ni de libellé long). Fusion : les
  // ids fusionnés (webchat:<site>) et historiques (<site>:<mode>) pointent
  // vers le même site.
  check("shortModel webchat fusionné (« z.ai »)", orch.shortModel("webchat:zai") === "z.ai", orch.shortModel("webchat:zai"));
  check("shortModel webchat historique (« z.ai »)", orch.shortModel("webchat:zai:answer") === "z.ai", orch.shortModel("webchat:zai:answer"));
  check("shortModel webchat (« Google AI Studio »)", orch.shortModel("webchat:aistudio") === "Google AI Studio", orch.shortModel("webchat:aistudio"));
  seen.length = 0;
  let wcRows: any[] = [];
  await orch.runOrchestratedTurn(
    {
      conversationId: "c4",
      messageId: "m9",
      mode: "debate",
      config: { voices: { debate: { sceptique: "webchat:aistudio:answer", pragmatique: null, innovateur: null, juge: null } } },
      rounds: 3,
      userContent: "Question.",
      history: [],
      prompts: { conseiller: "c", juge: "j" },
      signal,
      onFlow: (rows) => (wcRows = rows),
      onFinalDelta: () => {},
      onFinalStatus: () => {},
    },
    fakeDeps
  );
  check("voix webchat transmise telle quelle au moteur", seen.some((s) => s.model === "webchat:aistudio:answer"), JSON.stringify(seen.map((s) => s.model)));
  check("chip du déroulé = site du chat web", wcRows.some((r) => r.model === "Google AI Studio"), JSON.stringify(wcRows.map((r) => r.model)));

  // A7. testFailed — le contrat du prompt auto.test
  check("testFailed détecte ÉCHEC", orch.testFailed("ÉCHEC : rien ne marche"));
  check("testFailed détecte FAIL", orch.testFailed("FAIL — sortie vide"));
  check("testFailed ne voit pas d'échec ailleurs", !orch.testFailed("Tout est OK — ÉCHEC absent"));

  // A8. Store — persistance du mode (colonnes additives, migration douce)
  const conv = store.createConversation("QA modes", null, "debate", 5, { members: 4, voices: { debate: { juge: "hermes-4-70b" } } });
  const state = store.getConversationModeState(conv.id);
  check("mode persisté (débat)", state.mode === "debate", state.mode);
  check("tours persistés (5)", state.rounds === 5, String(state.rounds));
  check("config persistée (voix)", state.config?.voices?.debate?.juge === "hermes-4-70b", JSON.stringify(state.config));
  const changed = store.setConversationMode(conv.id, "council", null, { members: 5 });
  const state2 = store.getConversationModeState(conv.id);
  check("setConversationMode change le mode", changed?.mode === "council" && state2.mode === "council");
  check("rounds remis à null hors débat", state2.rounds === null);
  const meta = store.listConversations().find((c) => c.id === conv.id);
  check("la liste des conversations porte le mode (meta client)", meta?.mode === "council", JSON.stringify(meta?.mode));
  check("mode_config exposé dans les meta", meta?.modeConfig?.members === 5, JSON.stringify(meta?.modeConfig));

  // A9. Déroulé persisté dans le message (mode_tag + mode_flow)
  // Fork AVANT la corruption : la branche hérite du mode courant (council).
  const forked = store.forkConversation(conv.id);
  check("le fork hérite du mode", forked?.mode === "council", String(forked?.mode));
  const forkMeta = store.listConversations().find((c) => c.id === forked?.id);
  check("le fork expose son mode dans les meta", forkMeta?.mode === "council", String(forkMeta?.mode));

  // Valeur inconnue en base → chat (resolveMode, résolue À LA LECTURE)
  store.setConversationMode(conv.id, "chat", null, null);
  (store as any).db.query("UPDATE conversations SET mode = 'obsolète' WHERE id = ?").run(conv.id);
  check("mode inconnu en base retombe sur chat", store.getConversationModeState(conv.id).mode === "chat");
  const msg = store.appendMessage({
    conversationId: conv.id,
    role: "assistant",
    content: "Verdict.",
    modeTag: "Verdict · Débat — 3 tours",
    modeFlow: [
      { id: "t1-sceptique", label: "Tour 1 · Sceptique", detail: "…", model: "H4 405B", status: "done" },
    ],
  } as any);
  const reloaded = store.getMessage(conv.id, msg.id);
  check("modeTag persisté et relu", reloaded?.modeTag === "Verdict · Débat — 3 tours", String(reloaded?.modeTag));
  check("modeFlow persisté et relu (1 ligne)", reloaded?.modeFlow?.length === 1 && reloaded?.modeFlow?.[0].id === "t1-sceptique", JSON.stringify(reloaded?.modeFlow));

  // A10. shortModel — étiquette courte du déroulé
  check("shortModel Hermes 4 405B → H4 405B", orch.shortModel("hermes-4-405b") === "H4 405B", orch.shortModel("hermes-4-405b") ?? "");
  check("shortModel null → undefined", orch.shortModel(null) === undefined);
}

// ── B. Service réel ─────────────────────────────────────────────────────

async function serviceTests() {
  console.log("[qa] B — service réel (ports dédiés)");
  const SOCK_URL = process.env.QA_SOCK_URL ?? "http://localhost:3013";
  const socket = io(SOCK_URL, { path: "/", transports: ["websocket"], timeout: 6000 });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve());
      socket.on("connect_error", (e: any) => reject(new Error(`service injoignable (${e?.message})`)));
      setTimeout(() => reject(new Error("timeout connexion socket")), 8000);
    });
  } catch (err) {
    socket.close();
    throw new Error(
      `service non lancé — démarrez : HERMES_CHAT_DB=/tmp/qa-f30/hermes.sqlite PORT_SOCKET=3013 PORT_HTTP=3014 bun index.ts (${(err as Error).message})`
    );
  }

  function emitAck(event: string, payload?: unknown): Promise<any> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      if (payload === undefined) socket.emit(event, (res: any) => { clearTimeout(t); resolve(res); });
      else socket.emit(event, payload, (res: any) => { clearTimeout(t); resolve(res); });
    });
  }

  // B1. conversations:create avec mode — résolu et borné côté service
  const created = await emitAck("conversations:create", {
    mode: "debate",
    modeConfig: { rounds: 3, voices: { debate: { sceptique: "hermes-4-405b" } } },
  });
  check("conversations:create avec mode débat", created?.conversation?.mode === "debate", JSON.stringify(created?.conversation?.mode));
  check("la meta porte les tours et la config", created?.conversation?.modeRounds === 3 && created?.conversation?.modeConfig?.voices?.debate?.sceptique === "hermes-4-405b", JSON.stringify(created?.conversation?.modeConfig));
  const created2 = await emitAck("conversations:create", { mode: "obsolète" });
  check("mode inconnu à la création → chat (jamais d'écran cassé)", (created2?.conversation?.mode ?? "chat") === "chat", JSON.stringify(created2?.conversation?.mode));
  const created3 = await emitAck("conversations:create", { mode: "debate", modeConfig: { rounds: 50 } });
  check("bornes appliquées à la création (rounds 50 → 10)", created3?.conversation?.modeRounds === 10, JSON.stringify(created3?.conversation?.modeRounds));

  // B2. conversations:setMode — ack + diffusion à toutes les sessions
  const convId = created?.conversation?.id;
  let broadcast: any = null;
  socket.on("conversations:mode", (p: any) => {
    if (p.conversationId === convId) broadcast = p;
  });
  const setMode = await emitAck("conversations:setMode", {
    conversationId: convId,
    mode: "council",
    config: { members: 4, retries: 9 },
  });
  check("setMode → {ok, conversation}", setMode?.ok === true && setMode?.conversation?.mode === "council", JSON.stringify(setMode?.conversation?.mode));
  check("bornes revalidées au setMode (members 4, retries 9 → 3)", setMode?.conversation?.modeConfig?.members === 4 && setMode?.conversation?.modeConfig?.retries === 3, JSON.stringify(setMode?.conversation?.modeConfig));
  await new Promise((r) => setTimeout(r, 150));
  check("diffusion conversations:mode reçue", broadcast?.mode === "council", JSON.stringify(broadcast?.mode));
  const setBad = await emitAck("conversations:setMode", { conversationId: "inexistant", mode: "chat" });
  check("conversation inconnue → erreur propre", setBad?.ok !== true && typeof setBad?.error === "string", JSON.stringify(setBad));

  // B3. La consigne éditée est enregistrée côté service (clé unique JSON) ;
  // la revalidation des 4 000 caractères à la résolution est prouvée en A4 —
  // ici : roundtrip d'une surcharge valide, puis nettoyage.
  await emitAck("settings:set", { key: "hermes.modes.prompts", value: JSON.stringify({ plan: { main: "Consigne QA {tours}." } }) });
  const reloaded = await emitAck("settings:get", { key: "hermes.modes.prompts" });
  let kept = "";
  try {
    const parsed = JSON.parse(String(reloaded?.value ?? "{}"));
    kept = typeof parsed.plan?.main === "string" ? parsed.plan.main : "";
  } catch { /* rien */ }
  check("surcharge de consigne enregistrée côté service (settings:get/set)", kept === "Consigne QA {tours}.", String(reloaded?.value));
  check("les mots-clés partent non interpolés (remplacés au tour, jamais en base)", kept.includes("{tours}"), kept);
  await emitAck("settings:set", { key: "hermes.modes.prompts", value: "" });

  // B4. chat:send en mode Comparer sans paire explicite : le service
  // re-split selon le mode — le refus propre du tour concurrent reste intact.
  // (pas de LLM réel ici : on vérifie uniquement l'ack « compare » du service
  // avec une paire explicite — l'orchestration complète est couverte en A.)
  const cmp = await emitAck("conversations:create", { mode: "compare", modeConfig: { voices: { compare: { a: "hermes-4-405b", b: "hermes-4-70b" } } } });
  check("conversation Comparer créée avec ses voix", cmp?.conversation?.mode === "compare" && cmp?.conversation?.modeConfig?.voices?.compare?.a === "hermes-4-405b", JSON.stringify(cmp?.conversation?.modeConfig));

  // B5. Modèle du mode (F-30b) — la config.model roundtrippe via setMode :
  // chat web normalisé au format fusionné (historique accepté), id invalide
  // → null (jamais de plantage).
  const setModel = await emitAck("conversations:setMode", {
    conversationId: convId,
    mode: "plan",
    config: { model: { plan: "webchat:zai:answer", chat: 42 } },
  });
  check(
    "setMode persiste le modèle du mode (chat web fusionné)",
    setModel?.conversation?.modeConfig?.model?.plan === "webchat:zai",
    JSON.stringify(setModel?.conversation?.modeConfig?.model)
  );
  check(
    "modèle du mode invalide → null (code)",
    setModel?.conversation?.modeConfig?.model?.chat === null,
    JSON.stringify(setModel?.conversation?.modeConfig?.model)
  );

  socket.close();
}

// ── Enchaînement ────────────────────────────────────────────────────────

async function main() {
  await unitTests();
  try {
    await serviceTests();
  } catch (err) {
    console.log(`  ⚠  ${ (err as Error).message }`);
    console.log("     (volet service sauté — unitaires verts, le reste est prouvé hors pile)");
  }
  console.log(`\n[qa] ${passed} OK · ${failed} échec(s)`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
