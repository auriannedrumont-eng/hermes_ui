#!/usr/bin/env python3
"""Vague 4 — cible D : use-hermes-chat.ts (CC 166) — uploads/transcription
vers use-attachments-wiring.ts, actions de tour vers use-turn-actions.ts.
Corps des callbacks VERBATIM (copiés à l'identique dans les deux nouveaux
hooks) ; deps typées ; tableaux de deps COMPLETS de l'autre côté, même
convention que use-conversations.ts (vague 3). L'API publique du hook ne
change pas : la page n'est pas touchée.

Coupes ANCRÉES — toutes les bornes vérifiées AVANT toute écriture, remplacements
strictement du bas vers le haut (aucun décalage)."""

PATH = "/home/z/my-project/hermes_ui/src/hooks/use-hermes-chat.ts"

with open(PATH) as f:
    lines = f.read().split("\n")

def L(n):
    return lines[n - 1]

checks = {
    17: 'import { useConversations } from "@/hooks/use-conversations";',
    51: "const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 Mo, aligné sur le service",
    53: "function fileToBase64(file: File): Promise<string> {",
    63: "}",
    308: "  /** Retrouve l'id d'un modèle depuis le libellé d'une réponse",
    314: "  const modelIdFromLabel = useCallback(",
    321: "  );",
    322: "",
    323: "",
    324: "  // (Vigie de silence F-31 : vit dans use-chat-stream.ts.)",
    495: "  /** Envoie un fichier au service (base64) et renvoie la pièce jointe enregistrée. */",
    496: "  const uploadAttachment = useCallback(async (file: File): Promise<Attachment | null> => {",
    519: "  }, []);",
    520: "",
    521: "  /** v2.4 — déclenche la compaction et attend l'ack FINAL du service",
    526: "  const autoCompactBeforeSend = useCallback(",
    571: "    [toast]",
    572: "  );",
    573: "",
    574: "  const sendMessage = useCallback(",
    681: "    [newConversation, streaming, autoCompactBeforeSend]",
    682: "  );",
    684: "  const stopGeneration = useCallback(() => {",
    690: "  }, []);",
    692: "  /** Régénère la dernière réponse (relance le tour depuis le dernier message utilisateur). */",
    695: "  const regenerate = useCallback(",
    749: "    [openConversation, streaming, messages, modelIdFromLabel]",
    750: "  );",
    752: '  /** F-14 — affiche la version `index` d\'une réponse multi-versions. La',
    755: "  const setMessageVersion = useCallback(",
    767: "    [openConversation, streaming]",
    768: "  );",
    770: "  /** Réessai après erreur (F-04) : relance le tour depuis le dernier message utilisateur. */",
    771: "  const retryAfterError = useCallback(() => {",
    774: "  }, [regenerate]);",
    776: "  /** Modifie un message utilisateur et relance le tour depuis ce point. */",
    777: "  const editMessage = useCallback(",
    814: "    [openConversation, streaming]",
    815: "  );",
    817: "  /** Supprime un message individuel. */",
    818: "  const deleteMessage = useCallback(",
    835: "    [openConversation]",
    836: "  );",
    838: "  /** Transcrit un audio base64 en texte (dictée vocale). */",
    839: "  const transcribeAudio = useCallback(",
    851: "    []",
    852: "  );",
    854: "  // (actions projets : vit dans use-projects.ts)",
    856: '  // ── Compaction & nouvelle session (chantier « Composer v2 ») ──────────',
    858: "  /** Lance la compaction de la conversation active (résumé en tête de session). */",
    859: "  const compactConversation = useCallback(() => {",
    890: "  }, [streaming, toast]);",
    891: "",
    892: "  /** Ouvre une conversation vierge, dans le projet de la conversation active. */",
    893: "  const startNewSession = useCallback(async (): Promise<string | null> => {",
}
bad = [n for n, want in checks.items() if L(n) != want]
if bad:
    raise SystemExit(f"ANCHOR MISMATCH at {bad}: " +
                     "; ".join(f"{n}={L(n)!r} (attendu {checks[n]!r})" for n in bad[:8]))

def replace(a, b, new_lines):
    lines[a - 1 : b] = new_lines

# ── Remplacements STRICTEMENT du bas vers le haut ─────────────────────────

# 6. compactConversation quitte le hook (858-890, doc incluse)
replace(858, 890, [])

# 5. transcribeAudio quitte le hook (838-852, doc incluse)
replace(838, 852, [])

# 4. setMessageVersion + retryAfterError + editMessage + deleteMessage
#    quittent le hook (752-836, docs incluses + blanc final 837 conservé)
replace(752, 836, [])

# 3. regenerate quitte le hook (692-750, docs incluses ; le blanc 751 devient
#    la séparation avec la suite)
replace(692, 751, [])

# 2. sendMessage + stopGeneration quittent le hook (574-690, docs incluses)
replace(574, 690, [])

# 1c. autoCompactBeforeSend quitte le hook (521-573, doc incluse + blanc 573
#     conservé dans la coupe suivante — on enlève 521-572)
replace(521, 572, [])

# 1b. uploadAttachment remplacé par les deux déstructurations (495-519)
replace(495, 520, [
    "  // Pièces jointes extraites dans use-attachments-wiring.ts (vague 4) —",
    "  // upload base64 + transcription, corps des callbacks verbatim de",
    "  // l'autre côté. Tableau de deps complété (setter à identité stable).",
    "  const { uploadAttachment, transcribeAudio } = useAttachmentsWiring({",
    "    setUploadingCount,",
    "  });",
    "",
    "  // ── Actions de tour extraites dans use-turn-actions.ts (vague 4) ──────",
    "  // Compaction (v2.4 + manuelle), envoi, arrêt, régénération, navigation",
    "  // de versions (F-14), réessai après erreur, édition, suppression — corps",
    "  // des callbacks verbatim de l'autre côté. Les deps traversent la",
    "  // frontière du hook : tableaux de deps COMPLETS (setters useState et",
    "  // refs à identité stable — fréquence de mémoisation inchangée), même",
    "  // convention que use-conversations.ts (vague 3).",
    "  const {",
    "    sendMessage,",
    "    stopGeneration,",
    "    regenerate,",
    "    setMessageVersion,",
    "    retryAfterError,",
    "    editMessage,",
    "    deleteMessage,",
    "    compactConversation,",
    "  } = useTurnActions({",
    "    toast,",
    "    streaming,",
    "    setTurnError,",
    "    compactingRef,",
    "    setCompacting,",
    "    activeIdRef,",
    "    contextBaseRef,",
    "    messages,",
    "    setMessages,",
    "    newConversation,",
    "    openConversation,",
    "    models,",
    "    selectedModelRef,",
    "    effortRef,",
    "    permissionsRef,",
    "    expertRef,",
    "    webSearchRef,",
    "  });",
])

# 1a. modelIdFromLabel quitte le hook (308-323 : doc + fn + deux blancs)
replace(308, 322, [])

# 0b. MAX_ATTACHMENT_BYTES + fileToBase64 migrent dans use-attachments-wiring
replace(51, 63, [])

# 0a. imports des deux nouveaux hooks
replace(17, 17, [
    'import { useConversations } from "@/hooks/use-conversations";',
    'import { useAttachmentsWiring } from "@/hooks/use-attachments-wiring";',
    'import { useTurnActions } from "@/hooks/use-turn-actions";',
])

with open(PATH, "w") as f:
    f.write("\n".join(lines))

print(f"OK — use-hermes-chat.ts réécrit : {len(lines)} lignes")
