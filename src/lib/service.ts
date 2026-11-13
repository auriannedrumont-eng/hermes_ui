// Accès aux ressources du mini-service hermes-chat (via la gateway Caddy).
// Le port est passé en paramètre de requête XTransformPort — jamais dans le chemin.
"use client";

/** Port du service socket.io (chat, modèles, uploads). */
export const SERVICE_PORT = 3003;
/** Port du service HTTP des pièces jointes (socket.io avec path "/" intercepte tout). */
export const FILES_PORT = 3004;

/**
 * Jeton de service (revue 2026-11-13) : même jeton que HERMES_SERVICE_TOKEN
 * côté mini-service. Public par conception (le client tourne dans le
 * navigateur de l'utilisateur, qui peut de toute façon le lire) — le jeton
 * protège contre les AUTRES origines : une page malveillante visitée par
 * l'utilisateur ne peut pas inventer ce jeton ni le lire (CORS + pas de
 * cookie). Les liens de partage /share/... restent publics sans jeton.
 * Absent → mode dev sans authentification (comportement inchangé).
 */
export const SERVICE_TOKEN = process.env.NEXT_PUBLIC_SERVICE_TOKEN ?? null;

/**
 * URL complète d'une ressource servie par le mini-service.
 * `options.auth = false` produit une URL SANS jeton (audit passe 3, F-01) :
 * réservé aux contenus exportés/partageables (markdown…), qui ne doivent
 * jamais divulguer le jeton de service.
 */
export function serviceUrl(
  path: string,
  port: number = FILES_PORT,
  options: { auth?: boolean } = {}
): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  // Route de partage publique : PAS de jeton (le destinataire du lien n'a
  // pas de session — F-13). Toute autre route : jeton en query (?token=),
  // lisible par <img>/<iframe>/window.open qui ne peuvent pas mettre d'en-tête.
  const wantsAuth = options.auth !== false;
  const isShareRoute = clean.startsWith("/share/");
  const sep = clean.includes("?") ? "&" : "?";
  const auth =
    SERVICE_TOKEN && wantsAuth && !isShareRoute
      ? `&token=${encodeURIComponent(SERVICE_TOKEN)}`
      : "";
  return `${clean}${sep}XTransformPort=${port}${auth}`;
}

/** Init d'une requête fetch authentifiée vers le mini-service (Bearer). */
export function serviceFetchInit(): RequestInit {
  return SERVICE_TOKEN
    ? { headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }
    : {};
}
