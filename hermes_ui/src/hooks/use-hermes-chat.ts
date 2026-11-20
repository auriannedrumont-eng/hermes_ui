// Hook de connexion — l'état `connected` est LA source de la pastille
// Agent (§3.2 : un seul flux, aucune requête supplémentaire).
"use client";

import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";

export function useHermesChat() {
  const [connected, setConnected] = useState(false);
  const [lastSeen, setLastSeen] = useState<number | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => {
      setConnected(true);
      setLastSeen(Date.now());
    };
    const onDisconnect = () => setConnected(false);
    // Battement : chaque événement reçu rafraîchit le dernier contact.
    const onAny = () => setLastSeen(Date.now());
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.onAny(onAny);
    if (socket.connected) onConnect();
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.offAny(onAny);
    };
  }, []);

  return { connected, lastSeen };
}
