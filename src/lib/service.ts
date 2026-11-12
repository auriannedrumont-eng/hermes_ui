// Accès aux ressources du mini-service hermes-chat (via la gateway Caddy).
// Le port est passé en paramètre de requête XTransformPort — jamais dans le chemin.
"use client";

/** Port du service socket.io (chat, modèles, uploads). */
export const SERVICE_PORT = 3003;
/** Port du service HTTP des pièces jointes (socket.io avec path "/" intercepte tout). */
export const FILES_PORT = 3004;

/** URL complète d'une ressource servie par le mini-service. */
export function serviceUrl(
  path: string,
  port: number = FILES_PORT
): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${clean}${clean.includes("?") ? "&" : "?"}XTransformPort=${port}`;
}
