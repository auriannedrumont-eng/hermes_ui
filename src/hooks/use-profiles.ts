// Profils de réglages — état partagé (v2.4).
// Un seul abonnement socket pour toute l'app (le volet n'est pas le seul
// consommateur potentiel) : chargement initial + suivi `settings:changed`
// sur la clé serveur `hermes.profiles` (table settings côté service).
"use client";

import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";
import {
  PROFILES_STORAGE_KEY,
  parseProfiles,
  type ChatProfile,
} from "@/lib/profiles";

let current: ChatProfile[] = [];
let started = false;
const listeners = new Set<(p: ChatProfile[]) => void>();

function publish(raw: string | null | undefined): void {
  current = parseProfiles(raw);
  for (const l of listeners) l(current);
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  const socket = getSocket();
  const load = () =>
    socket.emit(
      "settings:get",
      { key: PROFILES_STORAGE_KEY },
      (res: { value?: string | null } = {}) => publish(res.value ?? null),
    );
  if (socket.connected) load();
  socket.on("connect", load);
  socket.on("settings:changed", (p: { key?: string; value?: string | null } = {}) => {
    if (p?.key !== PROFILES_STORAGE_KEY) return;
    publish(p.value ?? null);
  });
}

/** Profils enregistrés (volet Paramètres → Profils), suivis en direct. */
export function useChatProfiles(): ChatProfile[] {
  const [value, setValue] = useState<ChatProfile[]>(current);
  useEffect(() => {
    ensureStarted();
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
