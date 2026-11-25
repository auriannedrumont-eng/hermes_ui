// Ticket HTTP natif (journal 19, validation sur moteur réel) : le moteur
// hermes-agent EXIGE un ticket à usage unique (but « native-http », TTL
// 30 s) dans l'en-tête « x-hermes-gateway-ticket » pour ses routes HTTP —
// sans lui, /api/model/options répond 401 {"detail":"Unauthorized"} et la
// liste des modèles repliait sur le catalogue local.
//
// Le ticket se minte sur le SOCKET DE CONTRÔLE du moteur
// ($HERMES_HOME/gateway.sock) — socket de domaine UNIX authentifiée par le
// pair (même utilisateur OS), UNE requête par connexion (protocole ligne
// JSON, « one JSON request line -> one JSON response line ») :
//   1. {"protocol":1,"verb":"identify","id":1}
//        → result{instance_id, hermes_home, served_profiles[{profile_id,home}], api_origin}
//   2. {"protocol":1,"id":N,"verb":"session-ticket",
//       params{profile_id, instance_id, purpose:"native-http"}}
//        → result{ticket, expires_in_seconds}
// (Même contrat que hermes_cli.gateway_client._session_ticket, sans
// exécuter python : le service compose le socket en direct.)
//
// Windows : le contrôle est un pipe nommé au chemin différent — hors
// périmètre de ce module, l'échec y est honnête (null) et l'appelant
// retombe sur son repli (catalogue), le mint python restant le chemin WS.
import { connect as netConnect, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CONTROL_TIMEOUT_MS = 4_000;

/** Une requête ligne → une réponse ligne sur une connexion fraîche. */
function askControl(socketPath: string, request: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const socket: Socket = netConnect(socketPath);
    const timer = setTimeout(
      () => settle(() => { socket.destroy(); reject(new Error("timeout du socket de contrôle")); }),
      CONTROL_TIMEOUT_MS,
    );
    let buf = "";
    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (d: Buffer) => {
      buf += d.toString("utf-8");
      const idx = buf.indexOf("\n");
      if (idx < 0) return; // réponse incomplète : on attend la fin de ligne
      const line = buf.slice(0, idx);
      settle(() => {
        socket.destroy();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error("réponse illisible du socket de contrôle"));
        }
      });
    });
    socket.on("error", (e: Error) => settle(() => reject(e)));
    socket.on("close", () => settle(() => reject(new Error("socket de contrôle fermé sans réponse"))));
  });
}

/** Ticket native-http minté sur le contrôle du moteur, ou null (moteur
 *  absent, socket muet, enveloppe refusée) — l'appelant décide du repli.
 *  Le ticket est À USAGE UNIQUE : un mint par requête HTTP. */
export async function mintNativeHttpTicket(
  home: string,
): Promise<{ ticket: string; apiOrigin: string | null } | null> {
  const socketPath = join(home, "gateway.sock");
  try {
    if (!existsSync(socketPath)) return null;
  } catch {
    return null;
  }
  try {
    const ident = await askControl(socketPath, { protocol: 1, verb: "identify", id: 1 });
    const ep = ident?.result;
    if (ident?.ok !== true || !ep || typeof ep.instance_id !== "string") return null;
    const served = Array.isArray(ep.served_profiles) ? ep.served_profiles : [];
    const profile =
      served.find((p: any) => p?.home === ep.hermes_home) ?? served[0] ?? null;
    const profileId = typeof profile?.profile_id === "string" ? profile.profile_id : null;
    if (!profileId) return null;
    const grant = await askControl(socketPath, {
      protocol: 1,
      id: 2,
      verb: "session-ticket",
      params: { profile_id: profileId, instance_id: ep.instance_id, purpose: "native-http" },
    });
    const ticket = grant?.result?.ticket ?? grant?.ticket;
    if (typeof ticket !== "string" || !ticket) return null;
    return {
      ticket,
      apiOrigin: typeof ep.api_origin === "string" ? ep.api_origin : null,
    };
  } catch {
    return null;
  }
}
