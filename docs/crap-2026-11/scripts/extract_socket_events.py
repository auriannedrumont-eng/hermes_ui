"""Extrait le grand useEffect de use-hermes-chat.ts (406-869) vers use-chat-socket-events.ts.

Le corps du useEffect est copié VERBATIM (indentation identique : 4 espaces, car le
useEffect reste niché à 2 espaces dans le hook extrait). Le tableau de dépendances
est conservé à l'identique ; les identifiants capturés arrivent par un objet deps
déstructuré en tête de hook, donc aucun renommage dans le corps.
"""
from pathlib import Path

HOOK = Path("/home/z/my-project/repos/hermes_ui/src/hooks/use-hermes-chat.ts")
NEW = Path("/home/z/my-project/repos/hermes_ui/src/hooks/use-chat-socket-events.ts")

lines = HOOK.read_text(encoding="utf-8").splitlines(keepends=True)

def chk(n: int, prefix: str) -> None:
    assert lines[n - 1].startswith(prefix), f"L{n} inattendue : {lines[n-1]!r}"

chk(406, "  useEffect(() => {")
chk(869, "  }, [refreshConversations, fetchProjects, fetchModels, fetchArtifacts]);")

span_inside = "".join(lines[406 : 868])  # corps interne du useEffect (407-868)
dep_array = "}, [refreshConversations, fetchProjects, fetchModels, fetchArtifacts]);"

NEW.write_text(f'''// Écoute des événements socket du chat — extrait de use-hermes-chat.ts
// (audit CRAP 2026-11 : le useEffect de câblage faisait 462 lignes et portait
// l'essentiel de la complexité du hook principal, CC 287).
// Corps des handlers VERBATIM ; les identifiants capturés arrivent par deps,
// déstructurés en tête — aucune autre modification. Le tableau de dépendances
// du useEffect est conservé à l'identique (mêmes identités, mêmes ré-abonnements).
"use client";

import {{ useEffect }} from "react";
import type {{ Dispatch, RefObject, SetStateAction }} from "react";
import {{ getSocket }} from "@/lib/socket";
import {{ streamStore }} from "@/lib/stream-store";
import {{ BUILD_REVISION }} from "@/lib/build-revision";
import {{ useProjects }} from "@/hooks/use-projects";
import {{ useChatStream }} from "@/hooks/use-chat-stream";
import {{ useArtifactsPanel }} from "@/hooks/use-artifacts-panel";
import {{ useToast }} from "@/hooks/use-toast";
import type {{
  Artifact,
  ChatMessage,
  CompactInfo,
  ConversationMeta,
  Project,
  ServerHello,
  UpdateCheckResult,
}} from "@/lib/chat-types";

type ProjectsApi = ReturnType<typeof useProjects>;
type StreamApi = ReturnType<typeof useChatStream>;
type ArtifactsApi = ReturnType<typeof useArtifactsPanel>;
type ToastFn = ReturnType<typeof useToast>["toast"];

/** Dépendances du câblage socket : tout identifiant du hook principal utilisé
 *  par les handlers, passé tel quel (identités conservées). */
export type ChatSocketEventsDeps = {{
  // ── Projets (useProjects) + miroir ref ─────────────────────────────────
  setProjects: ProjectsApi["setProjects"];
  fetchProjects: ProjectsApi["fetchProjects"];
  projectsRef: RefObject<Project[]>;
  // ── État direct du hook principal ──────────────────────────────────────
  setConnected: Dispatch<SetStateAction<boolean>>;
  setServerInfo: Dispatch<SetStateAction<ServerHello | null>>;
  setUpdateState: Dispatch<SetStateAction<UpdateCheckResult | null>>;
  setScreenOutdated: Dispatch<SetStateAction<string | null>>;
  setConversations: Dispatch<SetStateAction<ConversationMeta[]>>;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setCompactInfo: Dispatch<SetStateAction<CompactInfo | null>>;
  setCompacting: Dispatch<SetStateAction<boolean>>;
  // ── Refs du hook principal ─────────────────────────────────────────────
  activeIdRef: RefObject<string | null>;
  updateToastShownRef: RefObject<boolean>;
  screenOutdatedRef: RefObject<string | null>;
  screenOutdatedDismissedRef: RefObject<string | null>;
  wasDisconnectedRef: RefObject<boolean>;
  resyncConversationRef: RefObject<(id: string) => void>;
  // ── Rappels du hook principal ──────────────────────────────────────────
  fetchModels: () => void;
  refreshConversations: () => void;
  openConversation: (id: string) => void;
  toast: ToastFn;
}} & Pick<
  StreamApi,
  | "setTurnError"
  | "resetStreams"
  | "bumpActivity"
  | "onStreamStart"
  | "onStreamDelta"
  | "onStreamReasoning"
  | "onStreamStatus"
  | "onStreamTool"
  | "onStreamDone"
  | "onStreamError"
  | "onModeFlow"
> &
  Pick<
    ArtifactsApi,
    | "setArtifacts"
    | "setStreamingArtifacts"
    | "setPanelOpen"
    | "setPanelArtifactId"
    | "panelKeyRef"
    | "fetchArtifacts"
  >;

export function useChatSocketEvents(deps: ChatSocketEventsDeps) {{
  const {{
    setProjects,
    fetchProjects,
    projectsRef,
    setConnected,
    setServerInfo,
    setUpdateState,
    setScreenOutdated,
    setConversations,
    setActiveId,
    setMessages,
    setCompactInfo,
    setCompacting,
    activeIdRef,
    updateToastShownRef,
    screenOutdatedRef,
    screenOutdatedDismissedRef,
    wasDisconnectedRef,
    resyncConversationRef,
    fetchModels,
    refreshConversations,
    openConversation,
    toast,
    setTurnError,
    resetStreams,
    bumpActivity,
    onStreamStart,
    onStreamDelta,
    onStreamReasoning,
    onStreamStatus,
    onStreamTool,
    onStreamDone,
    onStreamError,
    onModeFlow,
    setArtifacts,
    setStreamingArtifacts,
    setPanelOpen,
    setPanelArtifactId,
    panelKeyRef,
    fetchArtifacts,
  }} = deps;

  useEffect(() => {{
{span_inside}  {dep_array}
}}
''', encoding="utf-8")

# ── remplacement dans le hook principal ────────────────────────────────────
call_block = """  useChatSocketEvents({
    setProjects,
    fetchProjects,
    projectsRef,
    setConnected,
    setServerInfo,
    setUpdateState,
    setScreenOutdated,
    setConversations,
    setActiveId,
    setMessages,
    setCompactInfo,
    setCompacting,
    activeIdRef,
    updateToastShownRef,
    screenOutdatedRef,
    screenOutdatedDismissedRef,
    wasDisconnectedRef,
    resyncConversationRef,
    fetchModels,
    refreshConversations,
    openConversation,
    toast,
    setTurnError,
    resetStreams,
    bumpActivity,
    onStreamStart,
    onStreamDelta,
    onStreamReasoning,
    onStreamStatus,
    onStreamTool,
    onStreamDone,
    onStreamError,
    onModeFlow,
    setArtifacts,
    setStreamingArtifacts,
    setPanelOpen,
    setPanelArtifactId,
    panelKeyRef,
    fetchArtifacts,
  });
"""
new_hook = "".join(lines[:405]) + call_block + "".join(lines[869:])

# import du nouveau hook, juste après l'import useChatStream
marker = 'import { useChatStream } from "@/hooks/use-chat-stream";\n'
assert marker in new_hook
new_hook = new_hook.replace(marker, marker + 'import { useChatSocketEvents } from "@/hooks/use-chat-socket-events";\n', 1)

HOOK.write_text(new_hook, encoding="utf-8")
print(f"hook réécrit : {len(new_hook.splitlines())} lignes (avant {len(lines)})")
print(f"nouveau fichier : {len(NEW.read_text().splitlines())} lignes")
