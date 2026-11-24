#!/usr/bin/env python3
"""Vague 3 — extraction du CRUD conversations depuis use-hermes-chat.ts
vers use-conversations.ts. Coupes ancrées, corps déplacés VERBATIM."""

PATH = "/home/z/my-project/repos/hermes_ui/src/hooks/use-hermes-chat.ts"

with open(PATH) as f:
    lines = f.read().split("\n")

def L(n):
    return lines[n - 1]

checks = {
    16: 'import { useChatSocketEvents } from "@/hooks/use-chat-socket-events";',
    448: "  // --- Actions ---",
    449: "  const newConversation = useCallback(",
    509: "  );",
    511: "  const openConversation = useCallback(",
    623: "  );",
    625: "  // Reprise après coupure (voir onConnect) : le handler de reconnexion",
    631: "  const deleteConversation = useCallback((id: string) => {",
    635: "  const renameConversation = useCallback((id: string, title: string) => {",
    644: "  }, []);",
    646: "  /** Envoie un fichier au service (base64) et renvoie la pièce jointe enregistrée. */",
    989: "  /** Épingle / détache une conversation. */",
    1014: "  );",
    1051: "  }, []);",
    1053: "  /** Transcrit un audio base64 en texte (dictée vocale). */",
    1071: "  /** Déplace une conversation vers un projet (null = « Sans projet »). */",
    1087: "  }, []);",
    1089: "  // ── Compaction & nouvelle session (chantier « Composer v2 ») ──────────",
}
bad = [n for n, want in checks.items() if L(n) != want]
if bad:
    raise SystemExit(f"ANCHOR MISMATCH at {bad}: " +
                     "; ".join(f"{n}={L(n)!r} (attendu {checks[n]!r})" for n in bad[:6]))

def replace(a, b, new_lines):
    lines[a - 1:b] = new_lines

# R4 : moveConversation quitte le hook (1071-1088, doc incluse + blanc final)
replace(1071, 1088, [])

# R3 : togglePin + forkConversation + searchMessages quittent le hook (989-1052)
replace(989, 1052, [])

# R2c : deleteConversation + renameConversation quittent le hook (630-644)
replace(630, 644, [])

# R2b : openConversation quitte le hook (511-624, blanc final inclus)
replace(511, 624, [])

# R2a : l'appel useConversations remplace newConversation (448-510)
replace(448, 510, [
    "  // --- Actions ---",
    "  // CRUD conversations extrait dans use-conversations.ts (vague 3) —",
    "  // appelé ici : il consomme les setters du stream et du panneau, déjà",
    "  // créés plus haut. Corps des callbacks verbatim de l'autre côté.",
    "  const {",
    "    newConversation,",
    "    openConversation,",
    "    deleteConversation,",
    "    renameConversation,",
    "    togglePin,",
    "    forkConversation,",
    "    searchMessages,",
    "    moveConversation,",
    "  } = useConversations({",
    "    toast,",
    "    creatingRef,",
    "    pendingModeRef,",
    "    activeIdRef,",
    "    loadingForRef,",
    "    conversations,",
    "    setConversations,",
    "    setActiveId,",
    "    setMessages,",
    "    setLoadingHistory,",
    "    setTurnError,",
    "    setCompactInfo,",
    "    setCompacting,",
    "    setPendingMode,",
    "    resetStreams,",
    "    setStreamsRecord,",
    "    setModeFlowLive,",
    "    bumpActivity,",
    "    setPanelOpen,",
    "    setPanelArtifactId,",
    "    panelKeyRef,",
    "    setArtifacts,",
    "    setStreamingArtifacts,",
    "    fetchArtifacts,",
    "  });",
    "",
])

# R1 : import du nouveau hook (après use-chat-socket-events)
replace(16, 16, [
    'import { useChatSocketEvents } from "@/hooks/use-chat-socket-events";',
    'import { useConversations } from "@/hooks/use-conversations";',
])

with open(PATH, "w") as f:
    f.write("\n".join(lines))

print(f"OK — use-hermes-chat.ts réécrit : {len(lines)} lignes")
