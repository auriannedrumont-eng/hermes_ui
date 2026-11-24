#!/usr/bin/env python3
"""Vague 2 — refactor llm-pool.ts : extraction de createPoolCatalog +
départ de la mécanique de streaming vers llm-streams.ts.
Chaque coupe est ancrée : le script abort si une ligne témoin diffère."""

PATH = "/home/z/my-project/repos/hermes_ui/mini-services/hermes-chat/llm-pool.ts"

with open(PATH) as f:
    lines = f.read().split("\n")  # 0-indexed internally

def L(n):  # 1-indexed getter
    return lines[n - 1]

# ── Assertions (témoins, 1-indexed) ─────────────────────────────────────
checks = {
    16: "import {",
    17: "  LOCAL_BASE_PROMPT,",
    18: "  attachmentNote,",
    19: "  parseSseLine,",
    22: '} from "./local-engine";',
    27: "  explainQuotaError,",
    32: 'import { readAttachmentDataUrl } from "./uploads";',
    57: "interface StreamTraceEntry {",
    94: "interface LlmEndpoint {",
    245: "// ── Erreurs du pool ────────────────────────────────────────────────────",
    248: "class PoolAuthError extends Error {",
    257: "}",
    288: "async function readErrorBody(res: Response): Promise<string> {",
    302: "const rateLimitWhy = explainQuotaError;",
    310: "// ── Construction du pool ───────────────────────────────────────────────",
    312: "export function createLlmPool(store: Store): LlmPoolApi {",
    317: "  const activeStreamEntries = new Set<StreamTraceEntry>();",
    321: "  /** Lignes de clés adaptées au contrat de pickActiveKey (providers.ts). */",
    428: "  }",
    430: "  /** Contenu utilisateur du tour (texte + note des pièces jointes, ou",
    457: "  }",
    466: "  const TURN_STALL_TIMEOUT_MS = Math.max(",
    475: "  function stallGuard(signal: AbortSignal, stallMs: number, label: string, modelId: string) {",
    518: "  async function streamOpenAiTurn(",
    650: "  async function streamAnthropicTurn(",
    798: "  }",
    800: "  // ── runTurn : résolution fournisseur + porte-clés ────────────────────",
    861: "            ? await streamAnthropicTurn(turnEndpoint, secret, modelId, req, cb)",
    862: "            : await streamOpenAiTurn(turnEndpoint, secret, modelId, req, cb);",
    903: "  // ── listModels : listes vivantes des fournisseurs actifs ─────────────",
    905: "  async function listModels(): Promise<ModelsResult | null> {",
    914: "  }",
    915: "",
    916: "  // ── summarize : compaction via le pool (repli SDK sinon) ─────────────",
    996: "",
    997: "  function invalidate(): void {",
    999: "  }",
    1001: "  function activeProviderNames(): string[] {",
    1005: "  }",
    1007: "  /** Instantané des tours LLM en vol (F-31ter) — vide une fois le vol fini. */",
    1019: "  return { listModels, runTurn, summarize, invalidate, activeProviderNames, activeStreams };",
    1020: "}",
}
bad = [n for n, want in checks.items() if L(n) != want]
if bad:
    raise SystemExit(f"ANCHOR MISMATCH at lines {bad}: " +
                     "; ".join(f"{n}={L(n)!r} (attendu {checks[n]!r})" for n in bad[:6]))

# ── Blocs capturés (verbatim, avant toute coupe) ────────────────────────
blockA = lines[320:428]   # 321-428  keyCandidates → providerModels
blockLM = lines[902:914]  # 903-914  listModels (+ section comment)
blockAPN = lines[1000:1005]  # 1001-1005 activeProviderNames
blockINV = lines[996:999]  # 997-999  invalidate

# ── Éditions, du bas vers le haut ───────────────────────────────────────

def replace(a, b, new_lines):  # [a..b] 1-indexed inclusifs
    lines[a - 1:b] = new_lines

# R10 : invalidate + activeProviderNames quittent createLlmPool (997-1006)
replace(997, 1006, [])

# R9 : listModels quitte createLlmPool (903-915)
replace(903, 915, [])

# R8 : les deux appels de tour reçoivent la garde liée au pool
replace(861, 862, [
    "            ? await streamAnthropicTurn(stallGuard, turnEndpoint, secret, modelId, req, cb)",
    "            : await streamOpenAiTurn(stallGuard, turnEndpoint, secret, modelId, req, cb)",
])

# R7 : buildUserPayload + garde + deux tours streaming → llm-streams.ts (430-799)
replace(430, 799, [
    "",
    "  // buildUserPayload, la garde d'inactivité et les deux tours streaming",
    "  // (openai + anthropic) vivent dans llm-streams.ts depuis la vague 2 —",
    "  // la garde est liée au vivier local via stallGuardFor(activeStreamEntries).",
    "",
])

# R6 : createPoolCatalog (catalogue + porte-clés) puis nouveau createLlmPool
new_head = [
    "// ── Construction du pool ───────────────────────────────────────────────",
    "",
    "// Catalogue fournisseurs + porte-clés, extrait de createLlmPool (vague 2) :",
    "// cache des listes de modèles, résolution de clé par stratégie, listes",
    "// vivantes. Les tours (runTurn/summarize) restent dans createLlmPool et",
    "// consomment ce catalogue par déstructuration — corps inchangés.",
    "function createPoolCatalog(store: Store) {",
    "  // Cache des listes par fournisseur (vidé par invalidate()).",
    "  const modelsCache = new Map<string, ModelOption[] | null>();",
    "  // Adresses déjà signalées (évite les logs en boucle).",
    "  const warned = new Set<string>();",
    "",
] + blockA + [
    "",
] + blockLM + [
    "",
] + blockAPN + [
    "",
] + blockINV + [
    "",
    "  return { pickKey, activeLlmProviders, providerModels, listModels, activeProviderNames, invalidate };",
    "}",
    "",
    "export function createLlmPool(store: Store): LlmPoolApi {",
    "  const {",
    "    pickKey,",
    "    activeLlmProviders,",
    "    providerModels,",
    "    listModels,",
    "    activeProviderNames,",
    "    invalidate,",
    "  } = createPoolCatalog(store);",
    "  // Tours LLM en vol — rempli par stallGuard à chaque lancement, vidé en",
    "  // finally à chaque fin ; alimente la section pool de /diagnostics (F-31ter).",
    "  const activeStreamEntries = new Set<StreamTraceEntry>();",
    "  // Garde d'inactivité de ce pool, liée au vivier ci-dessus (llm-streams.ts) :",
    "  // la mécanique de streaming est extraite, la fabrique reçoit le suivi live.",
    "  const stallGuard = stallGuardFor(activeStreamEntries);",
]
replace(310, 429, new_head)

# R5 : readErrorBody + rateLimitWhy → llm-streams.ts (287-303)
replace(287, 303, [
    "// readErrorBody (message d'erreur lisible depuis un corps d'API) et",
    "// rateLimitWhy (traduction des 429 partagée avec providers.ts) suivent les",
    "// tours streaming dans llm-streams.ts depuis la vague 2.",
    "",
])

# R4 : PoolAuthError → llm-streams.ts (245-258)
replace(245, 258, [
    "// PoolAuthError — erreur d'authentification : la clé est déclassée puis une",
    "// autre est tentée — vit dans llm-streams.ts depuis la vague 2 (importé).",
    "",
])

# R3/R2 : deux interfaces partagées avec llm-streams.ts deviennent exportées
replace(94, 94, ["export interface LlmEndpoint {"])
replace(57, 57, ["export interface StreamTraceEntry {"])

# R1 : imports — retraits des identifiants partis en vague 2, ajout llm-streams
# (une seule opération : les lignes 16-32 se décalent entre elles sinon)
replace(16, 32, [
    'import type { TurnCallbacks, TurnRequest } from "./local-engine";',
    'import {',
    '  pickActiveKey,',
    '  providerCapabilities,',
    '  looksLikeZaiJwt,',
    '  applyExplicitBase,',
    '  ZAI_CODING_BASE,',
    '  ZAI_STANDARD_BASE,',
    '} from "./providers";',
    'import {',
    '  PoolAuthError,',
    '  stallGuardFor,',
    '  streamAnthropicTurn,',
    '  streamOpenAiTurn,',
    '} from "./llm-streams";',
])

with open(PATH, "w") as f:
    f.write("\n".join(lines))

print(f"OK — llm-pool.ts réécrit : {len(lines)} lignes")
