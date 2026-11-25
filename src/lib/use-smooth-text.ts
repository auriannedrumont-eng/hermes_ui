"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Révélation douce du stream (25/11) — le correctif « ça coupe sur des
 * mots puis ça reprend d'un coup ». Le moteur réel livre le texte par
 * RAFALES (pauses outils/réflexion de plusieurs secondes, puis gros
 * morceaux d'un coup) et la coalescence du store (200 ms) s'ajoute :
 * le rendu brut avance par sauts. Ce hook révèle la cible EN CONTINU :
 * une boucle rAF rattrape le texte arrivé à vitesse adaptative (retard
 * rattrapé en ~1 s, pas bornés 3–64 caractères par frame), et les
 * écritures d'état sont throttlées (~60 ms, sauf gros retard) pour que
 * le re-parse markdown du stream reste borné. La cible reste la vérité
 * (append-only) : à la clôture (`active` faux) le texte complet est
 * rendu tel quel — la bulle persistée prend le relais.
 */
export function useSmoothText(target: string, active: boolean): string {
  // Longueur révélée (la cible ne fait que croître pendant un tour ; un
  // nouveau tour = nouveau messageId = nouvelle instance = remise à zéro).
  const [revealed, setRevealed] = useState(0);
  const revealedRef = useRef(0);
  const targetRef = useRef(target);

  // La cible de vérité, toujours fraîche pour la boucle (sync hors rendu).
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let lastPaint = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const t = targetRef.current;
      const cur = Math.min(revealedRef.current, t.length);
      if (t.length <= cur) return;
      const behind = t.length - cur;
      // Throttle ~60 ms sauf gros retard : le re-parse markdown reste
      // borné sans jamais laisser traîner le rattrapage.
      if (behind < 240 && now - lastPaint < 60) return;
      lastPaint = now;
      revealedRef.current = Math.min(t.length, cur + Math.max(3, Math.min(64, Math.ceil(behind / 60))));
      setRevealed(revealedRef.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (!active) return target;
  return target.slice(0, Math.min(revealed, target.length));
}
