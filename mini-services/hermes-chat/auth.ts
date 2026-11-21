// Authentification du mini-service : jeton de service + gardes d'origine
// (boucle locale) — extraites d'index.ts (découpage 2026-11, cf. FORK.md).
// Jeton de service (revue 2026-11-13) : quand HERMES_SERVICE_TOKEN est défini,
// toute connexion socket.io et toute route HTTP du 3004 (sauf les liens de
// partage publics /share/...) doit le présenter — sinon le mini-service,
// exposé via Caddy, est lisible/écrivable par n'importe quelle page visitée
// par l'utilisateur (DNS rebinding compris). Absent → mode dev inchangé.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "http";

export const SERVICE_TOKEN = process.env.HERMES_SERVICE_TOKEN ?? null;

// (audit 2026-11-21) Mode sans jeton : signalé bruyamment au démarrage —
// la protection ne repose alors que sur la garde d'origine boucle locale.
// Si la passerelle est un jour exposée au-delà de la boucle locale (port
// régénéré ouvert, proxy ajouté), tout le 3004 (uploads, artefacts,
// /diagnostics) serait lisible sans jeton via de simples navigations.
if (!SERVICE_TOKEN) {
  console.warn(
    "[hermes-chat] HERMES_SERVICE_TOKEN absent — mode dev : authentification désactivée (protection = origine boucle locale uniquement)"
  );
}

// Garde d'origine (Lot 1, audit L1-1) : sans jeton, le service ne doit pas
// être joignable depuis une page web tierce (DNS rebinding compris) — seules
// les origines boucle locale de la propre machine de l'utilisateur passent.
// Pas d'en-tête Origin (curl, scripts QA, chargement <img>, lien de partage
// ouvert en navigation) → laissé passer : les navigateurs n'envoient Origin
// que sur les requêtes fetch/XHR, jamais sur les navigations et images.
export function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]"
  );
}

/** Autorisation HTTP : Authorization: Bearer <jeton> ou ?token=<jeton>. */
export function httpAuthorized(req: IncomingMessage, u: URL): boolean {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const q = u.searchParams.get("token");
  const presented =
    (typeof bearer === "string" && bearer) || (typeof q === "string" && q) || "";
  return timingSafeEqualStr(presented, SERVICE_TOKEN!);
}

// Jeton de service : refus AVANT tout gestionnaire — une socket non
// authentifiée ne reçoit aucun événement applicatif. La comparaison est
// en temps constant (fuite d'information par chronométrage sinon).
// Canal : payload auth de la socket ou en-tête Authorization (audit passe
// 3, F-07 — la query d'URL reste réservée aux liens HTTP img/iframe du
// 3004, elle ne doit pas finir dans des journaux de passerelle côté WS).
export function socketAuthorized(socket: {
  handshake: { auth?: unknown; headers?: Record<string, string | undefined> };
}): boolean {
  if (!SERVICE_TOKEN) return true; // mode dev : pas de jeton configuré
  const bearer = socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, "");
  const auth = socket.handshake.auth as { token?: unknown } | null;
  const presented =
    (typeof auth?.token === "string" && auth.token) ||
    (typeof bearer === "string" && bearer) ||
    "";
  return timingSafeEqualStr(presented, SERVICE_TOKEN);
}

/** Comparaison en temps constant de deux chaînes (anti-chronométrage).
 *  Travailler sur les buffers UTF-8 : deux chaînes de même longueur UTF-16
 *  peuvent avoir des longueurs d'octets différentes (et réciproquement), et
 *  timingSafeEqual rejette de toute façon des tailles inégales — l'ancien
 *  « amortissement » via timingSafeEqualImpl court-circuitait sans jamais
 *  appeler timingSafeEqual, révélant la différence de longueur. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    // Compare quand même pour uniformiser le temps, puis rejette
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
