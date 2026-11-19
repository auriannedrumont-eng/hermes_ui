// Singleton socket.io vers le mini-service hermes-chat (port 3003 via Caddy)
"use client";

import { io } from "socket.io-client";
import { SERVICE_TOKEN } from "@/lib/service";

let socket: ReturnType<typeof io> | null = null;

export function getSocket() {
  if (!socket) {
    // Never use PORT in the URL, always use XTransformPort
    // DO NOT change the path, it is used by Caddy to forward the request to the correct port
    socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      // Résilience de reconnexion : si la poignée de main websocket échoue
      // (intermédiaire qui casse les upgrades — proxy redémarré, réseau
      // corporate), engine.io essaie le transport SUIVANT de la liste dans
      // la MÊME tentative. Sans cette option, il réessayait websocket à
      // l'infini et ne se reconnectait jamais, même là où le polling passe.
      // Chaque tentative repart de la première entrée (tableau copié par
      // connexion) : les environnements où le polling est bloqué (CORS,
      // origine non boucle locale) ne changent pas de comportement.
      tryAllTransports: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 10000,
      // Jeton de service (revue 2026-11-13) : auth de la socket —
      // une page malveillante visitée ne peut pas se connecter sans lui.
      ...(SERVICE_TOKEN ? { auth: { token: SERVICE_TOKEN } } : {}),
    });
  }
  return socket;
}
