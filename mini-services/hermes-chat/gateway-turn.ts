// C5 (25/11, constats n°4 et n°5 du plan de correction) — Le COURS D'UN
// TOUR sur le canal persistant : abonnement au flux d'événements (sink
// de gateway-events.ts), garde d'inactivité (C4 — le tour vit tant
// qu'un événement arrive ; 240 s de silence clôturent avec cause ;
// les pongs ne comptent PAS, sinon un agent muet sur connexion vivante
// ne clôturerait jamais), abort utilisateur (partiel rendu + interrupt
// best-effort : l'ancien code fermait la socket pour arrêter le moteur,
// ici la socket VIT et session.interrupt fait le travail), mort de la
// connexion (fermeture sans fin annoncée = erreur, jamais un succès
// tronqué — Lot 1, audit L1-6), et la soumission prompt.submit avec la
// boucle interrupt-then-retry du contrat amont (4009 session busy le
// temps que running passe à false après une interruption).
// runGatewayTurn (hermes-connector.ts) ne garde que l'orchestration.
import type { TurnCallbacks, TurnRequest } from "./local-engine";
import type { TurnOutcome } from "./hermes-connector";
import type { GatewayWire } from "./gateway-wire";
import { TurnEventSink } from "./gateway-events";

/** Garde d'inactivité (C4) : silence événementiel maximal. */
const TURN_INACTIVITY_MS = 240_000;
const GUARD_TICK_MS = 5_000;
/** Fenêtre du retry busy (interrupt-then-retry amont). */
const BUSY_RETRY_MS = 1_500;
const BUSY_CODES = new Set([4009, 4091]);

export interface GatewayTurnHandle {
  sink: TurnEventSink;
  done: Promise<TurnOutcome>;
  /** Session liée à la soumission : l'abort pourra l'interrompre côté
   *  moteur (session.interrupt) au lieu de tuer la socket partagée. */
  bindSession(sessionId: string): void;
  /** Clôture administrée : désabonne TOUT (événements, mort, abort,
   *  garde) — la socket, elle, reste ouverte pour le tour suivant. */
  dispose(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isBusyRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string };
  return BUSY_CODES.has(Number(e?.code)) || /busy/i.test(String(e?.message ?? ""));
}

/** Soumission avec retry borné : une interruption d'un tour PRÉCÉDENT
 *  est asynchrone côté moteur — un submit immédiat peut tomber sur le
 *  « session busy » le temps que running passe à false. UNE seule
 *  réessai, jamais sur abort (rien ne part à un tour déjà arrêté). */
export async function submitTurnPrompt(
  wire: GatewayWire,
  signal: AbortSignal,
  params: Record<string, unknown>
): Promise<any> {
  try {
    // Journal 19 : le reçu d'admission (admission_id, status…) est RENDU —
    // le connecteur le retient pour solder une éventuelle exécution
    // « unknown » à la reconnexion après un crash moteur.
    return await wire.rpc("prompt.submit", params);
  } catch (err) {
    if (!isBusyRefusal(err) || signal.aborted) throw err;
    await sleep(BUSY_RETRY_MS);
    return await wire.rpc("prompt.submit", params);
  }
}

/** session_id obligatoire dans une réponse create/resume. */
export function requireSessionId(reply: any, method: string): string {
  const sid = reply?.session_id;
  if (typeof sid !== "string" || !sid) {
    throw new Error(`${method} : pas de session_id renvoyé`);
  }
  return sid;
}

/** Monte le tour sur le wire : la promesse `done` se règle sur
 *  message.complete / error / abort / mort de la connexion / garde
 *  d'inactivité. Le connecteur attend `done` puis appelle `dispose`. */
export function beginGatewayTurn(
  wire: GatewayWire,
  req: Pick<TurnRequest, "model">,
  cb: TurnCallbacks
): GatewayTurnHandle {
  const sink = new TurnEventSink(cb);
  const model = req.model || "hermes (gateway)";
  let settled = false;
  let sessionId: string | null = null;
  let inactivityTimer: ReturnType<typeof setInterval> | null = null;
  let lastActivity = Date.now();
  const disposers: Array<() => void> = [];

  const clearGuard = () => {
    if (inactivityTimer !== null) clearInterval(inactivityTimer);
    inactivityTimer = null;
  };

  const outcome = (): TurnOutcome => ({
    content: sink.content,
    reasoning: sink.reasoning,
    model,
    engine: "gateway",
  });

  const settle = (err?: Error) => {
    if (settled) return;
    settled = true;
    clearGuard();
    // Abort déjà posé au moment de la fin (ou de la mort) : le partiel
    // reçu est rendu — même contrat que le code d'origine.
    if (!err && cb.signal.aborted) {
      resolve(outcome());
      return;
    }
    if (err) reject(err);
    else resolve(outcome());
  };

  const { promise: done, resolve, reject } = promiseWithResolvers<TurnOutcome>();

  // Abort utilisateur : interrupt best-effort PUIS partiel rendu. La
  // socket n'est PAS touchée — elle vit pour le tour suivant.
  const onAbort = () => {
    if (sessionId !== null) {
      wire.notify("session.interrupt", { session_id: sessionId });
    }
    settle();
  };
  if (cb.signal.aborted) onAbort();
  else cb.signal.addEventListener("abort", onAbort, { once: true });
  disposers.push(() => cb.signal.removeEventListener("abort", onAbort));

  // Flux d'événements : chaque trame réarme la garde d'inactivité.
  disposers.push(
    wire.onEvent((params) => {
      if (cb.signal.aborted) {
        settle();
        return;
      }
      lastActivity = Date.now();
      const verdict = sink.handle(params);
      if (verdict === "complete") settle();
      else if (verdict === "error") settle(sink.error ?? new Error("Erreur gateway"));
    })
  );

  // Mort de la connexion : fermeture SANS fin annoncée = erreur, pas un
  // succès tronqué (L1-6). L'abort reste prioritaire (partiel rendu).
  disposers.push(
    wire.onDeath((reason) => {
      if (cb.signal.aborted) settle();
      else settle(new Error(`Connexion gateway fermée avant la fin du tour — ${reason}`));
    })
  );

  // Garde d'inactivité (C4) : lancée seulement si le tour n'est pas déjà
  // clôturé (abort synchrone pendant le montage — temporal dead zone
  // interdite, même loi que le code d'origine).
  if (!settled) {
    inactivityTimer = setInterval(() => {
      if (Date.now() - lastActivity >= TURN_INACTIVITY_MS) {
        settle(new Error("Aucune activité de l'agent depuis 4 minutes — tour clôturé (garde d'inactivité, C4)"));
      }
    }, GUARD_TICK_MS);
  }

  return {
    sink,
    done,
    bindSession(sid: string) {
      sessionId = sid;
    },
    dispose() {
      clearGuard();
      for (const dispose of disposers.splice(0)) dispose();
      // Outils restés « running » (complete perdu) : clos d'office —
      // aucun spinner ne survit à la clôture du tour.
      sink.closeOpenTools();
      // Garde anti-rejet-non-géré : si le wire meurt APRÈS un setup qui a
      // jeté (p. ex. coupure pendant la fenêtre busy-retry de
      // submitTurnPrompt), done se rejette sans personne pour l'attendre —
      // le marquage « traité » protège le service, les vrais awaiters
      // (return await turn.done) reçoivent toujours leur rejet.
      done.catch(() => {});
    },
  };
}

/** Promise.withResolvers (ES2024) local : le service cible ES2022. */
function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
