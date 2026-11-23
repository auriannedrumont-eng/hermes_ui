// Chantier « sessions natives » (74) — fondation : la sonde.
//
// La cible du chantier : rattacher chaque conversation de l'interface à
// une session nommée du moteur hermes-agent, par l'API REST OFFICIELLE du
// moteur (gateway/platforms/api_server.py : GET/POST /api/sessions,
// POST /api/sessions/{id}/chat, GET /api/sessions/{id}/messages,
// header X-Hermes-Session-Id annoncé dans les CORS).
//
// Pourquoi REST et pas le WebSocket natif : /api/ws est un protocole
// fermé (JSON-RPC + tickets + capabilities, tui_gateway/ws.py) et les
// clés de `api_turn_v1` forment un ensemble FERMÉ sans `session_id`
// (gateway/session_api_turn.py:60-65 : toute clé inconnue est refusée).
// Nommer une session par le WS exigerait de parler le protocole interne
// du Desktop — fragile entre versions amont. L'API REST, elle, expose
// des sessions nommées comme contrat public.
//
// CE tour ne pose QUE la sonde : elle ne fait que LIRE (GET).
// Aucune écriture côté moteur : la source de vérité reste la base locale
// tant que la bascule REST n'est pas construite et éprouvée contre un
// moteur réel. Le résultat va dans la trace, jamais dans la santé
// (une capacité absente ne doit pas alarmer).
import { trace } from "./trace";

const PROBE_TIMEOUT_MS = 4000;

export type MotorSessionsProbe = {
  /** GET /api/sessions a répondu 2xx avec du JSON lisible. */
  ok: boolean;
  /** Nombre de sessions renvoyées par le moteur (0 si inconnu). */
  sessions?: number;
  /** Code de motif bref pour la trace (jamais affiché à l'utilisateur). */
  reason?: string;
};

/** Sonde en lecture seule de la capacité « sessions natives » du moteur.
 *  Non bloquant, silencieux pour l'utilisateur : le résultat ne sert qu'à
 *  préparer la bascule REST et à tracer ce que le moteur installé accepte. */
export async function probeMotorSessions(
  gatewayHttpBase: string,
  token: string | null,
): Promise<MotorSessionsProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${gatewayHttpBase}/api/sessions`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      // 401/403/404 : le moteur installé ne publie pas cette API ou la clé
      // du lanceur ne couvre pas le serveur API. Capacité absente — pas
      // une erreur à remonter : le chat WS actuel reste le chemin complet.
      return { ok: false, reason: `http_${res.status}` };
    }
    const body: unknown = await res.json().catch(() => null);
    const list = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { sessions?: unknown[] }).sessions)
        ? (body as { sessions: unknown[] }).sessions
        : null;
    if (!list) return { ok: false, reason: "format_inattendu" };
    return { ok: true, sessions: list.length };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "reseau";
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Accroche de démarrage : trace une ligne sur la capacité détectée.
 *  Volontairement « fire and forget » — aucun chemin du service n'attend
 *  cette sonde, aucun échec ne peut ralentir ou casser le démarrage. */
export async function probeMotorSessionsOnce(
  connector: { gatewayUrl: string | null; gatewayToken: string | null },
  toHttpBase: (url: string) => string,
): Promise<void> {
  if (!connector.gatewayUrl) return;
  const result = await probeMotorSessions(toHttpBase(connector.gatewayUrl), connector.gatewayToken);
  if (result.ok) {
    trace(
      "motor-sessions",
      `capacité sessions natives détectée (${result.sessions ?? 0} session(s)) — colonne motor_session_id prête pour la bascule REST`,
    );
  } else {
    trace("motor-sessions", `sonde sessions sans réponse (${result.reason ?? "inconnu"}) — lecture seule, non bloquant`);
  }
}
