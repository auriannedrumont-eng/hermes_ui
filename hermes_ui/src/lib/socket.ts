// Socket unique du front — côté navigateur uniquement (v0.3.0).
"use client";

import { io, type Socket } from "socket.io-client";

declare global {
  var __hermesSocket: Socket | undefined;
}

/** Socket vers le service chat+stockage (3003). Instance unique par page. */
export function getSocket(): Socket {
  if (typeof window === "undefined") {
    throw new Error("getSocket() est réservé au navigateur");
  }
  if (!globalThis.__hermesSocket) {
    globalThis.__hermesSocket = io("http://localhost:3003", {
      transports: ["websocket"],
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
    });
  }
  return globalThis.__hermesSocket;
}
