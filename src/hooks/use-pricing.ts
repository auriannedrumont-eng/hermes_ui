// Tarifs des modèles — état partagé (F-21).
// Un seul abonnement socket pour toute l'app (les bulles n'ouvrent pas
// chacune leur requête) : chargement initial + suivi `settings:changed`,
// re-render des composants abonnés.
//
// Lot audit 2026-11-21 : `usePricingState` expose `loaded`/`error` (lecture
// avec chien de garde) — la section Modèles interdit toute écriture tant
// que la map serveur n'a pas été lue, sinon l'ajout ou la suppression d'un
// tarif pendant le chargement écrasait TOUS les tarifs existants par une
// map ne contenant que la nouvelle entrée (perte silencieuse).
"use client";

import { useEffect, useState } from "react";
import { emitAck } from "@/lib/emit-ack";
import { getSocket } from "@/lib/socket";
import { PRICING_KEY, parsePricing, type PricingMap } from "@/lib/pricing";

let current: PricingMap = {};
let started = false;
let loaded = false;
let errored = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function publish(raw: string | null | undefined): void {
  current = parsePricing(raw);
  loaded = true;
  errored = false;
  notify();
}

function markError(): void {
  errored = true;
  notify();
}

function load(): void {
  void emitAck<{ value?: string | null }>("settings:get", { key: PRICING_KEY }).then(
    (res) => {
      if (res === null) {
        markError();
        return;
      }
      publish(res.value ?? null);
    }
  );
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  const socket = getSocket();
  if (socket.connected) load();
  socket.on("connect", load);
  socket.on("settings:changed", (p: { key?: string; value?: string | null } = {}) => {
    if (p?.key !== PRICING_KEY) return;
    publish(p.value ?? null);
  });
}

/** Tarifs déclarés (volet Paramètres → Modèles), suivis en direct. */
export function useModelPricing(): PricingMap {
  const [value, setValue] = useState<PricingMap>(current);
  useEffect(() => {
    ensureStarted();
    // notify() ne passe pas d'argument : le listener relit le `current`
    // du module (toujours à jour au moment de l'appel).
    const listener = () => setValue(current);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}

/** État de lecture des tarifs : `loaded` (map serveur reçue — prérequis
 *  pour écrire) et `error` (service muet). */
export function usePricingState(): { loaded: boolean; error: boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    ensureStarted();
    // Lot audit : voir use-profiles — monté pendant la coupure = erreur
    // immédiate (pas de « Chargement… » éternel sans requête émise).
    if (!getSocket().connected && !loaded) markError();
    const listener = () => bump((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { loaded, error: errored };
}
