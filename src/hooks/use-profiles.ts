// Profils de réglages — état partagé (v2.4).
// Un seul abonnement socket pour toute l'app (le volet n'est pas le seul
// consommateur potentiel) : chargement initial + suivi `settings:changed`
// sur la clé serveur `hermes.profiles` (table settings côté service).
//
// Lot audit 2026-11-21 : `loaded`/`error` sont exposés pour que la section
// Profils interdise TOUTE écriture tant que la liste serveur n'a pas été
// lue — créer avant la réponse écrasait la liste complète avec un profil
// unique (read-modify-write sur un instantané vide). Le chargement porte
// un chien de garde (emitAck) : socket coupée → `error` au lieu d'un
// `[]` indistinguable d'une vraie liste vide.
"use client";

import { useEffect, useState } from "react";
import { emitAck } from "@/lib/emit-ack";
import { getSocket } from "@/lib/socket";
import {
  PROFILES_STORAGE_KEY,
  parseProfiles,
  type ChatProfile,
} from "@/lib/profiles";

let current: ChatProfile[] = [];
let started = false;
let loaded = false;
let errored = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function publish(raw: string | null | undefined): void {
  current = parseProfiles(raw);
  loaded = true;
  errored = false;
  notify();
}

function markError(): void {
  errored = true;
  notify();
}

function load(): void {
  void emitAck<{ value?: string | null }>("settings:get", {
    key: PROFILES_STORAGE_KEY,
  }).then((res) => {
    if (res === null) {
      markError();
      return;
    }
    publish(res.value ?? null);
  });
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  const socket = getSocket();
  if (socket.connected) load();
  socket.on("connect", load);
  socket.on("settings:changed", (p: { key?: string; value?: string | null } = {}) => {
    if (p?.key !== PROFILES_STORAGE_KEY) return;
    publish(p.value ?? null);
  });
}

/** Profils enregistrés (volet Paramètres → Profils), suivis en direct, avec
 *  les drapeaux de lecture : `loaded` (liste serveur reçue — prérequis pour
 *  écrire) et `error` (service muet, cf. chien de garde). */
export function useChatProfiles(): {
  profiles: ChatProfile[];
  loaded: boolean;
  error: boolean;
} {
  const [, bump] = useState(0);
  useEffect(() => {
    ensureStarted();
    // Lot audit : section montée PENDANT la coupure — aucune requête n'a
    // encore été émise (load() ne part que sur « connect ») : sans ce garde,
    // « Chargement des profils… » restait éternel sans jamais prévenir.
    // La reconnexion relance load() et efface l'erreur.
    if (!getSocket().connected && !loaded) markError();
    const listener = () => bump((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { profiles: current, loaded, error: errored };
}
