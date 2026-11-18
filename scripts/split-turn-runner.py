#!/usr/bin/env python3
"""Extraction atomique de turn-runner.ts depuis index.ts, en UNE passe :
1) cartographie les blocs top-level (commentaire inclus) par équilibre des accolades,
2) snapshot les contenus AVANT suppression,
3) supprime du bas vers le haut,
4) écrit turn-runner.ts (factory createTurnRunner) et patche index.ts (import + déstructuration).
Idempotent : refuse de tourner si le découpage est déjà appliqué."""
import sys

ROOT = "/home/z/my-project/hermes_ui/mini-services/hermes-chat"
INDEX = f"{ROOT}/index.ts"
TURN = f"{ROOT}/turn-runner.ts"

src = open(INDEX).read()
if "createTurnRunner" in src:
    print("découpage déjà appliqué — abandon")
    sys.exit(0)
lines = src.split("\n")

def idx(pat, start=0):
    for i in range(start, len(lines)):
        if pat in lines[i]:
            return i
    return -1

def find_block_end(start):
    """Fin de bloc top-level : première ligne '};' (ou '}') à profondeur 0."""
    depth = 0
    j = start
    while j < len(lines):
        l = lines[j]
        # ignore le contenu des chaînes pour la profondeur (approximation sûre :
        # les corps ne contiennent pas de gabarits non équilibrés)
        depth += l.count("{") - l.count("}")
        if depth <= 0 and l.strip() in ("};", "}"):
            return j
        j += 1
    return -1

def block_with_comments(anchor):
    """(début incluant commentaires, fin) pour une ancre top-level."""
    s = anchor
    while s > 0 and (lines[s - 1].strip().startswith(("//", "/**", "*")) or lines[s - 1].strip() == "*/"):
        s -= 1
    e = find_block_end(anchor)
    assert e > anchor, f"bloc introuvable pour {lines[anchor]}"
    return s, e

# ── Frontières (index 0-based) ────────────────────────────────────────────
i_running = idx("const running = new Map")
i_live = idx("// Tours en vol pour la RÉ-ATTACHE")
i_comp = idx("// ── Compaction : résumé conservé")
i_maj = idx("// ── Mise à jour depuis l'interface")
i_doc = idx("* Exécute un tour assistant complet") - 1
i_send = idx('"chat:send"', i_doc)
while not lines[i_send].strip().startswith("socket.on("):
    i_send -= 1

assert lines[i_doc].strip() == "/**"

# running : [i_running, i_live) — le commentaire « Tours en vol » ouvre le bloc suivant
b_running = (i_running, i_live - 1)
# live : [i_live, fin du bloc orchestratorDeps]
e_live = find_block_end(idx("const orchestratorDeps"))
b_live = (i_live, e_live)
# compact : [i_comp, i_maj - 1]
b_comp = (i_comp, i_maj - 1)
# turn : [i_doc, fermeture de runAssistantTurn = i_send - 2]
i_turn_end = i_send - 2
assert lines[i_turn_end].strip() == "};", repr(lines[i_turn_end])

# Snapshots AVANT suppression
seg_running = lines[b_running[0]:b_running[1] + 1]
seg_live = lines[b_live[0]:b_live[1] + 1]
seg_comp = lines[b_comp[0]:b_comp[1] + 1]
seg_turn = lines[i_doc:i_turn_end + 1]

# Contrôle d'équilibre (chaque segment doit avoir { == })
for name, seg in [("running", seg_running), ("live", seg_live), ("compact", seg_comp), ("turn", seg_turn)]:
    o = sum(l.count("{") for l in seg); c = sum(l.count("}") for l in seg)
    assert o == c, f"{name} déséquilibré : {o} ouvrantes / {c} fermantes"

# Suppression du bas vers le haut
for s, e in sorted([(i_doc, i_turn_end), (b_comp[0], b_comp[1]), (b_live[0], b_live[1]), (b_running[0], b_running[1])], key=lambda x: -x[0]):
    del lines[s:e + 1]

# ── turn-runner.ts ────────────────────────────────────────────────────────
turn_ded = "\n".join((l[2:] if l.startswith("  ") else l) for l in seg_turn)
header = '''// Tour assistant : moteur d'exécution — extrait d'index.ts (découpage
// 2026-11, cf. FORK.md §10). Contient runAssistantTurn, les registres des
// tours en vol (running, liveTurns, liveResync), les helpers de mode
// (comparaison A/B, orchestrateur, webchat) et la lecture/invalidation de
// la compaction. Dépendances passées par createTurnRunner : ce module ne
// fait aucun câblage réseau.
import type { Server } from "socket.io";
import type { Store } from "./store";
import type { HermesConnector } from "./hermes-connector";
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
'''
footer = '''
  return {
    runAssistantTurn,
    isRunning,
    abortRunning,
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
'''
body = "\n".join(seg_running) + "\n\n" + "\n".join(seg_live) + "\n\n" + "\n".join(seg_comp) + "\n\n" + turn_ded
open(TURN, "w").write(header + body + footer)

# ── index.ts : import + déstructuration ────────────────────────────────────
new_index = "\n".join(lines)
old_anchor = """const pool = createLlmPool(store);
connector.attachPool(pool);"""
assert new_index.count(old_anchor) == 1
new_index = new_index.replace(old_anchor, old_anchor + """

// Moteur de tour (découpage 2026-11, cf. FORK.md §10) : runAssistantTurn et
// ses registres vivent dans turn-runner.ts ; les helpers d'artefacts restent
// ici (partagés avec les handlers).
const {
  runAssistantTurn,
  isRunning,
  abortRunning,
  liveTurnsOf,
  validCompareIds,
  titleFrom,
  conversationModeState,
  comparePairFromMode,
  compactKey,
  readCompact,
  compactInfoWire,
  invalidateCompactIfNeeded,
} = createTurnRunner({
  store,
  connector,
  io,
  renderHtmlArtifact,
  enforceVersionQuota,
  attachArtifactCards,
});""", 1)
old_imp = 'import { Store, type ArtifactRow, type ExtensionRow, type KeyRow, type ProviderRow } from "./store";'
assert new_index.count(old_imp) == 1
new_index = new_index.replace(old_imp, old_imp + '\nimport { createTurnRunner } from "./turn-runner";', 1)
open(INDEX, "w").write(new_index)
print(f"turn-runner.ts : {len((header+body+footer).splitlines())} lignes")
print(f"index.ts : {len(new_index.splitlines())} lignes")
