#!/usr/bin/env python3
"""Vague 3 — découpage de buildMessages (methods-bag) en cinq builders
domaine, fusionnés par spread. Corps des méthodes VERBATIM — seules les
accolades d'encadrement changent ; ThisType<Store> conserve le `this`."""

PATH = "/home/z/my-project/repos/hermes_ui/mini-services/hermes-chat/store-messages.ts"

with open(PATH) as f:
    lines = f.read().split("\n")

def L(n):
    return lines[n - 1]

checks = {
    124: "export function buildMessages(): StoreMessagesMethods & ThisType<Store> {",
    125: "  return {",
    126: "    // ── Projets : rangement des conversations ─────────────────────────",
    254: "    listConversations(): ConversationMeta[] {",
    472: "    getMessages(conversationId: string): ChatMessage[] {",
    564: "    /** F-14 — nombre de versions d'un groupe (1 si inconnu). */",
    961: "    /** Duplique une conversation jusqu'à un message donné (branche / fork). */",
    1098: "  };",
    1099: "}",
}
bad = [n for n, want in checks.items() if L(n) != want]
if bad:
    raise SystemExit(f"ANCHOR MISMATCH at {bad}: " +
                     "; ".join(f"{n}={L(n)!r} (attendu {checks[n]!r})" for n in bad[:6]))

TT = " & ThisType<Store> {"

def replace(a, b, new_lines):
    lines[a - 1:b] = new_lines

# Tail : l'orchestrateur de fusion
replace(1098, 1099, [
    "  };",
    "}",
    "",
    "export function buildMessages(): StoreMessagesMethods & ThisType<Store> {",
    "  return {",
    "    ...buildProjectMethods(),",
    "    ...buildConversationMethods(),",
    "    ...buildMessagesCoreMethods(),",
    "    ...buildMessageVersionsMethods(),",
    "    ...buildForkSearchMethods(),",
    "  };",
    "}",
])

# D open (fin de C2) : fork/search/attachments
replace(961, 960, [
    "  };",
    "}",
    "",
    "// ── Branches (fork), recherche plein-texte, pièces jointes du fil ──────",
    "function buildForkSearchMethods(): Pick<",
    "  StoreMessagesMethods,",
    '  "forkConversation" | "searchMessages" | "conversationAttachments"',
    ">" + TT,
    "  return {",
])

# C2 open (fin de C1) : versions F-14, maintenance et édition du fil
replace(564, 563, [
    "  };",
    "}",
    "",
    "// ── Versions du fil (F-14), maintenance et édition des messages ───────",
    "function buildMessageVersionsMethods(): Pick<",
    "  StoreMessagesMethods,",
    '  "countVersions" | "supersedeTrailingAssistant" | "setMessageVersion" |',
    '  "restoreLatestVersion" | "restoreVersionById" | "getMessage" |',
    '  "deleteMessage" | "purgeInactiveVersionsOf" | "deleteTrailingAssistant" |',
    '  "editUserMessageAndTruncate"',
    ">" + TT,
    "  return {",
])

# C1 open (fin de B) : messages cœur
replace(472, 471, [
    "  };",
    "}",
    "",
    "// ── Messages cœur : fil vivant + ajout ────────────────────────────────",
    "function buildMessagesCoreMethods(): Pick<",
    "  StoreMessagesMethods,",
    '  "getMessages" | "appendMessage"',
    ">" + TT,
    "  return {",
])

# B open (fin de A) : conversations
replace(254, 253, [
    "  };",
    "}",
    "",
    "// ── Conversations : CRUD, modes (F-30), sessions moteur, épinglage ────",
    "function buildConversationMethods(): Pick<",
    "  StoreMessagesMethods,",
    '  "listConversations" | "createConversation" | "deleteConversation" |',
    '  "renameConversation" | "getConversation" | "getConversationModeState" |',
    '  "setConversationMode" | "getConversationMotorSession" |',
    '  "setConversationMotorSession" | "setPinned" | "touchConversation"',
    ">" + TT,
    "  return {",
])

# A open : le signature buildMessages devient buildProjectMethods
replace(124, 126, [
    "// buildMessages n'est plus un sac de 30 méthodes dans UNE fonction : cinq",
    "// builders domaine, fusionnés par spread (vague 3). Corps des méthodes",
    "// VERBATIM — ThisType<Store> conserve le `this` typé de chaque builder.",
    "function buildProjectMethods(): Pick<",
    "  StoreMessagesMethods,",
    '  "listProjects" | "getProject" | "createProject" | "renameProject" |',
    '  "deleteProject" | "setProjectDiskPath" | "setProjectArchived" |',
    '  "reorderProjects" | "moveConversation"',
    ">" + TT,
    "  return {",
    "    // ── Projets : rangement des conversations ─────────────────────────",
])


with open(PATH, "w") as f:
    f.write("\n".join(lines))

print(f"OK — store-messages.ts réécrit : {len(lines)} lignes")
