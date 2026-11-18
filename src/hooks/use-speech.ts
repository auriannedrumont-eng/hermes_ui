// Lecture vocale des réponses — extrait de message-bubble.tsx (découpage
// 2026-11, FORK.md §10). Les deux hooks (lecture simple et lecture continue
// pendant le stream) partageaient le même moteur : ils vivent désormais
// ensemble, réutilisables par d'autres vues.
// F-01 (conservé) : le cleanup au démontage ne coupe la file QUE si CETTE
// bulle parlait — l'ancien cleanup inconditionnel coupait la lecture d'une
// autre bulle au démontage (transition streaming→persisté, changement de
// version, suppression).
"use client";

import { useEffect, useRef, useState } from "react";

/** Nettoyage du markdown pour la lecture : blocs de code remplacés,
 *  marqueurs retirés, espaces normalisés (préfixe stable : le texte nettoyé
 *  ne fait que croître au fil des deltas — la lecture continue s'y appuie). */
export function speechPlain(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " bloc de code ")
    .replace(/[#*_`>|~\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lecture vocale d'une réponse (synthèse vocale du navigateur). */
export function useSpeech(content: string) {
  const [speaking, setSpeaking] = useState(false);
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  // F-01 : ne couper QUE si CETTE bulle parlait — l'ancien cleanup
  // inconditionnel coupait la lecture d'une autre bulle au démontage
  // (transition streaming→persisté, changement de version, suppression).
  const speakingRef = useRef(false);
  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);
  useEffect(() => {
    return () => {
      if (
        speakingRef.current &&
        typeof window !== "undefined" &&
        "speechSynthesis" in window
      ) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const toggle = () => {
    if (!supported) return;
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const plain = speechPlain(content);
    const utterance = new SpeechSynthesisUtterance(plain.slice(0, 4000));
    utterance.lang = "fr-FR";
    utterance.rate = 1.02;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  return { supported, speaking, toggle };
}

/** F-16 — lecture continue pendant le stream : parle les phrases complètes
 *  au fil de l'eau (file native speechSynthesis), s'arrête au clic ou au
 *  démontage. Les très courtes phrases sont ignorées (bruit), les blocs de
 *  code lus comme « bloc de code », mêmes règles de nettoyage que useSpeech. */
export function useContinuousSpeech(content: string, active: boolean) {
  const supported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  const [speaking, setSpeaking] = useState(false);
  const spokenCountRef = useRef(0);
  const spokenCharsRef = useRef(0);
  // F-01 : idem useSpeech — le cleanup au démontage ne coupe la file que si
  // CETTE bulle était en train de parler. La bulle de streaming qui devient
  // la bulle persistée (stream:done) démontait l'ancienne et coupait NET la
  // lecture continue avant la fin des phrases mises en file.
  const speakingRef = useRef(false);
  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);
  // Arrêt propre au démontage de la bulle
  useEffect(() => {
    return () => {
      if (
        speakingRef.current &&
        typeof window !== "undefined" &&
        "speechSynthesis" in window
      ) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // Alimentation au fil du stream : uniquement pendant la lecture. Les
  // phrases déjà énoncées ne sont jamais rejouées (spokenCount avance),
  // une coupure n'annule que la file en attente.
  useEffect(() => {
    if (!active || !supported || !speaking) return;
    const synth = window.speechSynthesis;
    // Nettoyage du markdown (idem useSpeech) — la propriété de préfixe est
    // préservée : le texte nettoyé ne fait que croître au fil des deltas.
    const plain = speechPlain(content);
    if (!plain) return;
    // Phrases complètes uniquement (terminées par . ! ? …), courtes ignorées
    const sentences = plain
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 20);
    const fresh = sentences.slice(spokenCountRef.current);
    for (const s of fresh) {
      // Garde-fou : jamais plus de 4 000 caractères lus par réponse
      if (spokenCharsRef.current >= 4000) break;
      const utterance = new SpeechSynthesisUtterance(
        s.slice(0, 4000 - spokenCharsRef.current)
      );
      utterance.lang = "fr-FR";
      utterance.rate = 1.02;
      spokenCharsRef.current += s.length;
      synth.speak(utterance);
    }
    spokenCountRef.current = sentences.length;
  }, [content, active, supported, speaking]);

  const toggle = () => {
    if (!supported) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    // Activation : l'effet ci-dessus alimente la file au contenu courant
    // (les phrases complètes déjà présentes partent d'un coup, puis le
    // stream nourrit la file delta après delta).
    setSpeaking(true);
  };

  return { supported, speaking, toggle };
}
