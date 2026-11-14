// Tarifs des modèles — état partagé (F-21).
// Un seul abonnement socket pour toute l'app (les bulles n'ouvrent pas
// chacune leur requête) : chargement initial + suivi `settings:changed`,
// re-render des composants abonnés.
"use client";

import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";
import { PRICING_KEY, parsePricing, type PricingMap } from "@/lib/pricing";

let current: PricingMap = {};
let started = false;
const listeners = new Set<(p: PricingMap) => void>();

function publish(raw: string | null | undefined): void {
  current = parsePricing(raw);
  for (const l of listeners) l(current);
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  const socket = getSocket();
  const load = () =>
    socket.emit(
      "settings:get",
      { key: PRICING_KEY },
      (res: { value?: string | null } = {}) => publish(res.value ?? null),
    );
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
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
