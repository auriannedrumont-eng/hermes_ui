// Arrêt propre des tours en vol (loi « jamais bloqué », 2026-11-22).
// Avant une relance du service (mise à jour, redémarrage demandé), le
// lanceur dépose le drapeau `arret-propre.flag` (même idiome que
// `maj-demandee.flag`) puis attend quelques secondes avant de tuer le
// process. À la lecture du drapeau, le service INTERROMPT chaque tour en
// vol : le connecteur rend son partiel, le tour se clôt normalement et
// chaque client reçoit un événement terminal (stream:done `stopped` ou
// stream:error) — plus aucun écran laissé collé sur « Envoi… » par une
// relance qui tuait les réponses dans l'œuf.
import { existsSync, rmSync } from "node:fs";

export interface DrainDeps {
  /** Chemin du drapeau écrit par le lanceur (desktop/runtime/arret-propre.flag). */
  flagPath: string;
  /** Interrompt tous les tours en vol (turn-runner.abortAllRunning). */
  abortAllRunning: () => void;
  /** Journal tournant du service (trace.ts). */
  trace: (category: string, message: string) => void;
  /** Clients à prévenir de l'arrêt (io.emit). */
  emit: (event: string, payload: Record<string, unknown>) => void;
}

const POLL_MS = 500;

/** Surveille le drapeau d'arrêt propre — un seul intervalle pour le process
 *  (posé une fois au démarrage, comme le relais du journal de mise à jour). */
export function startDrainWatchdog({ flagPath, abortAllRunning, trace, emit }: DrainDeps): void {
  const timer = setInterval(() => {
    let present = false;
    try {
      present = existsSync(flagPath);
    } catch {
      return; // disque momentanément illisible : au prochain tour de boucle
    }
    if (!present) return;
    try {
      rmSync(flagPath, { force: true });
    } catch {
      /* le lanceur le supprimera aussi — non bloquant */
    }
    trace("system", "drapeau d'arrêt propre : clôture des tours en vol avant relance");
    // Chaque client, quelle que soit la conversation affichée, sait que la
    // pile s'arrête — ses verrous d'écran se relâchent même si aucun tour
    // de SON côté n'était en vol (l'événement est aussi un signe de vie).
    emit("system:stopping", {
      reason: "relance demandée (mise à jour ou redémarrage)",
      at: new Date().toISOString(),
    });
    abortAllRunning();
  }, POLL_MS);
  // Ne retient jamais le process vivant pour ce seul intervalle.
  timer.unref?.();
}
