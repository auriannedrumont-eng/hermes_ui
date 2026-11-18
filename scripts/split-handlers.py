#!/usr/bin/env python3
"""Extraction atomique des ~50 socket.on(...) d'index.ts vers handlers/ :
4 modules + 1 module de contexte partagé. Même stratégie sûre que
split-turn-runner : cartographie par équilibre des parenthèses, snapshots
AVANT suppression, suppression du bas vers le haut. Idempotent."""
import re
import os
import sys

ROOT = "/home/z/my-project/hermes_ui/mini-services/hermes-chat"
INDEX = f"{ROOT}/index.ts"
HANDLERS = f"{ROOT}/handlers"
os.makedirs(HANDLERS, exist_ok=True)

src = open(INDEX).read()
if "registerConversationsHandlers" in src:
    print("découpage déjà appliqué — abandon")
    sys.exit(0)
lines = src.split("\n")

# ── Cartographie des socket.on(...) ──────────────────────────────────────
ons = []  # (start, event, end_exclu) — end = ligne ");" incluse
i = 0
while i < len(lines):
    l = lines[i]
    if l.strip().startswith("socket.on("):
        rest = l.strip()[len("socket.on("):]
        if not rest.strip():
            rest = lines[i + 1].strip()
        m2 = re.match(r'"([^"]+)"', rest.strip())
        ev = m2.group(1) if m2 else "?"
        # fin : ligne ");" ramenant la profondeur des PARENTHÈSES à zéro
        j = i
        depth = 0
        while j < len(lines):
            depth += lines[j].count("(") - lines[j].count(")")
            if depth == 0 and lines[j].strip() == ");":
                break
            j += 1
        assert j < len(lines), f"fin introuvable pour {ev} (ligne {i+1})"
        ons.append((i, ev, j + 1))
        i = j + 1
    else:
        i += 1

GROUPS = {
    "conversations": [
        "conversations:list", "conversations:create", "conversations:setMode",
        "conversations:rename", "conversations:delete", "conversations:open",
        "conversations:pin", "conversations:fork", "conversations:search",
        "conversations:move", "projects:list", "projects:create",
        "projects:rename", "projects:delete", "projects:reorder",
        "message:edit", "message:delete", "message:setVersion",
        "chat:send", "chat:regenerate", "chat:stop", "conversation:compact",
    ],
    "artifacts-shares": [
        "artifacts:list", "artifact:versions", "artifact:retry",
        "artifact:restore", "artifact:label", "artifact:pin",
        "share:get", "share:create", "share:revoke",
    ],
    "providers-extensions": [
        "hello", "models:list", "attachments:upload", "audio:transcribe",
        "providers:list", "providers:catalog", "providers:add",
        "providers:remove", "providers:set-strategy", "providers:set-base",
        "providers:add-key", "providers:remove-key", "providers:test-key",
        "extensions:list", "extensions:add", "registry:install",
        "extensions:toggle", "extensions:remove", "extensions:pin",
        "extensions:check", "extensions:update",
    ],
    "settings-system": [
        "settings:get", "settings:set", "gateway:get", "gateway:set",
        "system:update-request", "system:update-log", "system:renderCache",
        "system:clearRenderCache", "webchat:status", "webchat:open",
        "webchat:close", "system-prompt:get", "system-prompt:set",
        "system-prompt:clear", "system-prompts:list",
        "system-prompts:create", "system-prompts:update",
        "system-prompts:delete", "custom-instructions:get",
        "custom-instructions:set", "memory:get", "memory:set-enabled",
        "memory:set-auto", "memory:set-notes",
    ],
}
KEEP = {"disconnect", "error"}  # cycle de vie socket : restent dans index.ts

covered = {ev for g in GROUPS.values() for ev in g}
all_mapped = {ev for _, ev, _ in ons}
missing = all_mapped - covered - KEEP
assert not missing, f"non couverts : {missing}"

# ── Snapshots AVANT suppression (commentaires précédents inclus) ──────────
per_group = {name: [] for name in GROUPS}
to_remove = []
for start, ev, end in ons:
    if ev in KEEP:
        continue
    target = None
    for gname, evs in GROUPS.items():
        if ev in evs:
            target = gname
            break
    assert target, ev
    s = start
    while s > 0 and (lines[s - 1].strip().startswith("//") or lines[s - 1].strip() == ""):
        s -= 1
    body = lines[s:end]
    per_group[target].append((ev, body))
    to_remove.append((s, end))

# Suppression du bas vers le haut
for s, e in sorted(to_remove, key=lambda x: -x[0]):
    del lines[s:e]
open(INDEX, "w").write("\n".join(lines))

# ── Écriture des 4 modules ────────────────────────────────────────────────
for gname, items in per_group.items():
    fname = {
        "conversations": "conversations.ts",
        "artifacts-shares": "artifacts-shares.ts",
        "providers-extensions": "providers-extensions.ts",
        "settings-system": "settings-system.ts",
    }[gname]
    out = []
    out.append(f"// Handlers « {gname} » — extraits d'index.ts (découpage 2026-11, FORK.md §10).")
    out.append("// Pose ses socket.on(...) via register*(socket) ; les identifiants libres")
    out.append("// (store, io, connector, helpers du tour, vues wire) viennent du contexte")
    out.append("// partagé handlers/context.ts — câblé une fois par index.ts.")
    out.append("import type { Socket } from \"socket.io\";")
    out.append("import { ctx } from \"./context\";")
    out.append("")
    fn = "register" + "".join(p.capitalize() for p in gname.replace("-", " ").split()) + "Handlers"
    out.append(f"export function {fn}(socket: Socket) {{")
    for ev, body in items:
        ded = [(l[2:] if l.startswith("  ") else l) for l in body]
        out.extend(ded)
        out.append("")
    out.append("}")
    open(f"{HANDLERS}/{fname}", "w").write("\n".join(out) + "\n")
    print(fname, ":", len(items), "handlers")

# Remplacement des identifiants libres par ctx.* dans chaque module
CTX_FIELDS = [
    "store", "io", "connector", "pool", "helloPayload",
    "providersWire", "extensionsWire", "broadcastProviders", "broadcastExtensions",
    "conversationPromptWire", "broadcastSystemPrompt", "broadcastSystemPrompts",
    "wireArtifact", "broadcastArtifact", "attachArtifactCards", "renderHtmlArtifact",
    "deleteArtifactFiles", "enforceVersionQuota",
    "compactInfoWire", "compactKey", "readCompact", "invalidateCompactIfNeeded",
    "titleFrom", "conversationModeState", "comparePairFromMode", "validCompareIds",
    "runAssistantTurn", "isRunning", "abortRunning", "liveTurnsOf",
    "resolveMode", "normalizeModeConfig", "rowToPreset", "sanitizeExpertSettings",
    "validatePromptText", "transcribeAudioBase64", "saveAttachment",
    "MAX_ATTACHMENTS_PER_MESSAGE", "MAX_PROMPT_CHARS", "MAX_CUSTOM_INSTRUCTIONS_CHARS",
    "MAX_MEMORY_CHARS", "CUSTOM_INSTRUCTIONS_KEY", "MEMORY_AUTO_KEY",
    "MEMORY_ENABLED_KEY", "MEMORY_NOTES_KEY", "GATEWAY_URL_KEY", "GATEWAY_TOKEN_KEY",
    "buildSnapshot", "generateShareToken", "rowToShareView",
    "toKeyView", "maskSecret", "resolveKnownProvider", "knownProviderCatalog",
    "parseRepoInput", "fetchRepoSnapshot", "testProviderKey",
    "modelLabel", "catalogModelsResult", "webchatModelOptions", "webchatModelLabel",
    "readWebchatConfig", "runWebchatTurn", "webchatStatus",
    "ensureBrowser", "killPilotBrowser", "launchWatchdog", "readPilotInfo",
    "touchActivity", "findTab", "listTargets", "newTab", "FICHES",
    "chromeProfileStats", "clearChromeProfiles", "trace",
    "majFlag", "majLog", "majLogSig", "majLogRead",
]
import glob
for path in glob.glob(f"{HANDLERS}/*.ts"):
    body = open(path).read()
    # remplacement par limite de mot, uniquement en dehors des chaînes simples :
    # approximation sûre ici — ces identifiants n'apparaissent pas en littéraux
    for f in CTX_FIELDS:
        body = re.sub(rf"(?<![.\w\"']){f}\b", f"ctx.{f}", body)
    # les self-références ctx.ctx.* n'existent pas ; on annule les rares
    # « socket.socket » éventuels (aucun) et « ctx.ctx »
    body = body.replace("ctx.ctx.", "ctx.")
    open(path, "w").write(body)

print("index.ts :", len(lines), "lignes")
