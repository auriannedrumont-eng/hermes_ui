// Handlers « agent-motor » — carte Moteur Hermes du volet Système (v0.4.0).
// Surcouche : chaque action passe par les commandes OFFICIELLES de Hermes
// (hermes --version / hermes update --backup / procédure de retour) ; le
// service relaie l'état (agent:motor-changed), le journal en direct
// (agent:update-log:changed) et le carnet de bord (fork.agent.journal).
import type { Socket } from "socket.io";
import { ctx } from "./context";
import {
  getMotorState,
  refreshMotorStatus,
  runSensesCheck,
  startAgentUpdate,
  startAgentRollback,
  motorLogRead,
  journalList,
} from "../agent-motor";

export function registerAgentMotorHandlers(socket: Socket) {
  // Dépendances partagées : l'émission passe par io (broadcast à tous les
  // clients — même état pour tout le monde, comme system:update-state).
  const deps = () => ({
    store: ctx.store,
    connector: ctx.connector,
    emit: (event: string, payload: unknown) => {
      try {
        ctx.io.emit(event, payload);
      } catch {
        /* io absent au tout premier démarrage */
      }
    },
  });

  // État courant du moteur (version installée, release, opération, contrôle).
  // Si la dernière vérification date de plus de 15 min, on relance une
  // vraie sonde — la réponse honnête prime sur le cache.
  socket.on("agent:motor-state", async (cb?: (data: unknown) => void) => {
    const state = getMotorState();
    const stale =
      !state.checkedAt || Date.now() - new Date(state.checkedAt).getTime() > 15 * 60_000;
    if (stale && !state.op) {
      await refreshMotorStatus(deps()).catch(() => {
        /* hors ligne : l'état d'erreur est renvoyé tel quel */
      });
    }
    if (typeof cb === "function") cb({ ...getMotorState(), journal: journalList(ctx.store) });
  });

  // Journal d'opération (lecture à la demande — montage, reconnexion, F5).
  socket.on("agent:update-log", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function") cb(motorLogRead());
  });

  // Mise à jour du moteur : `hermes update --backup` (officiel, avec
  // sauvegarde) — journal en direct, contrôle automatique à la fin.
  socket.on("agent:update-request", async (cb?: (data: unknown) => void) => {
    const res = await startAgentUpdate(deps()).catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : "échec inattendu",
    }));
    if (typeof cb === "function") cb(res);
  });

  // Retour arrière : procédure officielle assistée (arrêt gateway, retour
  // aux fichiers de la version précédente, contrôle).
  socket.on("agent:rollback-request", async (cb?: (data: unknown) => void) => {
    const res = await startAgentRollback(deps()).catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : "échec inattendu",
    }));
    if (typeof cb === "function") cb(res);
  });

  // Contrôle des sens à la demande (bouton « Revérifier maintenant »).
  socket.on("agent:check-request", async (cb?: (data: unknown) => void) => {
    const control = await runSensesCheck(deps()).catch(() => null);
    if (typeof cb === "function") cb({ control, state: getMotorState() });
  });

  // Carnet de bord seul (léger — rafraîchi après chaque événement).
  socket.on("agent:journal", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function") cb({ journal: journalList(ctx.store) });
  });
}
