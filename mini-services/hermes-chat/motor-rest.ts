// Chantier « sessions natives » (75) — la bascule REST.
//
// Contrat amont vérifié dans le code du moteur (gateway/platforms/api_server.py) :
//   • POST /api/sessions           — crée la ligne ; le CLIENT choisit l'id
//                                    (body « id »), 409 si déjà là (idempotent) ;
//   • POST /api/sessions/{id}/chat/stream — SSE : run.started, message.started,
//     assistant.delta{delta}, tool.progress{tool_name, delta|preview} (le
//     raisonnement), tool.started/completed/failed, assistant.commentary{text},
//     assistant.completed{content}, run.completed|run.failed|run.cancelled{usage},
//     error{message}. Le MOTEUR porte l'historique de SA session
//     (_conversation_history_for_session) : c'est lui la mémoire du tour.
//
// Sûreté de la bascule : ce module ne sait qu'échouer. L'appelant
// (hermes-connector) tente REST puis, sur toute erreur AVANT le premier
// delta, replie sur le WebSocket du même moteur — jamais un autre moteur.
// Les pièces jointes restent au WS (contrat multimodal REST non éprouvé).
import { trace } from "./trace";

const REST_TIMEOUT_MS = 180_000;
const REST_CONNECT_TIMEOUT_MS = 6_000;

/** Identifiant moteur déterministe d'une conversation interface :
 *  stable, sans caractère dangereux pour le chemin amont. */
export function motorSessionIdFor(conversationId: string): string {
  return `ui-${conversationId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export type RestTurnResult = {
  content: string;
  reasoning: string;
};

export type RestTurnCallbacks = {
  onDelta: (text: string) => void;
  onReasoning: (text: string) => void;
  onStatus: (status: string) => void;
  onToolEvent: (event: { name: string; status: "running" | "done" | "error"; detail?: string }) => void;
};

/** Crée la ligne session moteur (idempotent : 201 = créée, 409 = déjà là).
 *  Retourne true si la session est garante (créée ou déjà existante). */
export async function ensureMotorSession(
  httpBase: string,
  token: string | null,
  motorSessionId: string,
  title: string,
  systemPrompt: string | null,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_CONNECT_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetchImpl(`${httpBase}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        id: motorSessionId,
        title: title || null,
        ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
        source: "api_server",
      }),
      signal: controller.signal,
    });
    return res.ok || res.status === 409;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Liaison conversation interface → session moteur (75) : lit la base,
 *  crée la ligne moteur si absent (id déterministe, 201/409 idempotent),
 *  écrit la liaison. Jamais bloquant : tout échec → null (le tour partira
 *  au WebSocket, comme avant le chantier ; nouvelle tentative au tour
 *  suivant). */
export async function ensureConversationMotorLink(
  store: {
    getConversationMotorSession(id: string): string | null;
    setConversationMotorSession(id: string, motorSessionId: string): void;
    getConversation(id: string): { title?: string } | null;
  },
  httpBase: string,
  token: string | null,
  conversationId: string,
  systemPrompt: string | null,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const existing = store.getConversationMotorSession(conversationId);
  if (existing) return existing;
  const sessionId = motorSessionIdFor(conversationId);
  const title = store.getConversation(conversationId)?.title ?? "";
  const ok = await ensureMotorSession(httpBase, token, sessionId, title, systemPrompt, signal, fetchImpl);
  if (!ok) {
    trace("motor-rest", `liaison session moteur impossible (${sessionId}) — tour au WebSocket, nouvel essai au prochain tour`);
    return null;
  }
  store.setConversationMotorSession(conversationId, sessionId);
  return sessionId;
}

/** Analyse une réponse SSE amont et pilote les callbacks du tour.
 *  Lance une erreur tant que la réponse n'est pas un flux SSE exploitable
 *  (statut non-2xx, corps non lisible) — l'appelant replie alors sur le WS. */
export async function runRestTurn(
  httpBase: string,
  token: string | null,
  motorSessionId: string,
  body: { message: string; model?: string | null; system_message?: string | null },
  callbacks: RestTurnCallbacks,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<RestTurnResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });
  let content = "";
  let reasoning = "";
  let finalContent: string | null = null;
  let terminal: "completed" | "failed" | "cancelled" | null = null;
  try {
    const res = await fetchImpl(`${httpBase}/api/sessions/${encodeURIComponent(motorSessionId)}/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`rest_chat_http_${res.status}`);
    }
    callbacks.onStatus("Hermes (session native) travaille…");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) {
          handleEvent(parsed.name, parsed.data, {
            onDelta: (t) => {
              if (t) {
                content += t;
                callbacks.onDelta(t);
              }
            },
            onReasoning: (t) => {
              if (t) {
                reasoning += t;
                callbacks.onReasoning(t);
              }
            },
            onStatus: callbacks.onStatus,
            onToolEvent: callbacks.onToolEvent,
          }, (v) => { finalContent = v; }, (v) => { terminal = v; });
        }
        sep = buffer.indexOf("\n\n");
      }
    }
    // Fin de flux sans séparateur final (revue 95) : une dernière trame non
    // suivie de « \n\n » restait dans le buffer — son assistant.completed ou
    // son run.completed (le verdict `terminal`) était perdu et le tour
    // échouait en `rest_chat_stream_close_premature` alors que tout était
    // arrivé. Le résidu est consommé avant la sortie de boucle.
    if (buffer.trim()) {
      const parsed = parseSseFrame(buffer);
      if (parsed) {
        handleEvent(parsed.name, parsed.data, {
          onDelta: (t) => {
            if (t) {
              content += t;
              callbacks.onDelta(t);
            }
          },
          onReasoning: (t) => {
            if (t) {
              reasoning += t;
              callbacks.onReasoning(t);
            }
          },
          onStatus: callbacks.onStatus,
          onToolEvent: callbacks.onToolEvent,
        }, (v) => { finalContent = v; }, (v) => { terminal = v; });
      }
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onOuterAbort);
  }
  if (signal.aborted) {
    // Stop utilisateur : le partiel reçu est rendu (contrat index.ts).
    return { content, reasoning };
  }
  if (terminal !== "completed") {
    if (terminal === "failed") {
      throw new Error("rest_chat_run_failed");
    }
    throw new Error(`rest_chat_stream_close_${terminal ?? "premature"}`);
  }
  return { content: finalContent ?? content, reasoning };
}

type SseFrame = { name: string; data: Record<string, unknown> };

/** Une trame SSE « event: X\ndata: {json} » (l'ordre des lignes est libre,
 *  le data peut s'étaler sur plusieurs lignes « data: » concaténées). */
export function parseSseFrame(frame: string): SseFrame | null {
  let name = "";
  let dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    return { name: name || String((data as { event?: unknown }).event ?? ""), data };
  } catch {
    return null;
  }
}

function handleEvent(
  name: string,
  data: Record<string, unknown>,
  out: {
    onDelta: (t: string) => void;
    onReasoning: (t: string) => void;
    onStatus: (s: string) => void;
    onToolEvent: (e: { name: string; status: "running" | "done" | "error"; detail?: string }) => void;
  },
  setFinal: (v: string) => void,
  setTerminal: (v: "completed" | "failed" | "cancelled") => void,
): void {
  const asText = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (name) {
    case "run.started":
      out.onStatus("Hermes réfléchit (session native)…");
      break;
    case "assistant.delta":
      out.onDelta(asText(data.delta));
      break;
    case "tool.progress":
      // Le raisonnement amont arrive ici : tool_name « _thinking », delta texte.
      out.onReasoning(asText(data.delta) || asText(data.preview));
      break;
    case "tool.started":
      out.onToolEvent({ name: asText(data.tool_name) || "outil", status: "running", detail: asText(data.preview) });
      break;
    case "tool.completed":
      out.onToolEvent({ name: asText(data.tool_name) || "outil", status: "done", detail: asText(data.preview) });
      break;
    case "tool.failed":
      out.onToolEvent({ name: asText(data.tool_name) || "outil", status: "error", detail: asText(data.preview) });
      break;
    case "assistant.commentary":
      out.onStatus(asText(data.text));
      break;
    case "assistant.completed":
      if (asText(data.content)) setFinal(asText(data.content));
      break;
    case "run.completed":
      setTerminal("completed");
      break;
    case "run.cancelled":
      setTerminal("cancelled");
      break;
    case "run.failed":
    case "error":
      setTerminal("failed");
      break;
    default:
      trace("motor-rest", `événement SSE inconnu : ${name || "(sans nom)"}`);
  }
}
