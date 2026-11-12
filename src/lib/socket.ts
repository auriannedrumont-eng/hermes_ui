// Singleton socket.io vers le mini-service hermes-chat (port 3003 via Caddy)
"use client";

import { io } from "socket.io-client";

let socket: ReturnType<typeof io> | null = null;

export function getSocket() {
  if (!socket) {
    // Never use PORT in the URL, always use XTransformPort
    // DO NOT change the path, it is used by Caddy to forward the request to the correct port
    socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      timeout: 10000,
    });
  }
  return socket;
}
