// Émission socket avec chien de garde (lot audit 2026-11-21).
// Toutes les émissions « feu et oubli » du volet Paramètres attendaient un
// ack qui ne vient JAMAIS si la socket est coupée au moment du clic
// (socket.io met l'émission en file, le callback n'est jamais appelé) :
// les boutons restaient « en cours » pour toujours (Test…, Recherche…,
// Vérification…, Enregistrer). Cette enveloppe résout à `null` si le
// service n'acquitte pas dans le délai — l'appelant affiche alors une
// erreur et relâche son état pending. La promesse ne rejette jamais ; un
// ack sans argument est normalisé en `null` (évite les TypeError sur
// `res.error` quand le service répond vide).
"use client";

import { getSocket } from "@/lib/socket";

/** Délai au-delà duquel un ack est considéré perdu (même valeur que le
 *  chien de garde déjà en place dans storage-section, correctif C5/F1). */
export const ACK_TIMEOUT_MS = 8000;

/** Émet `event` avec `payload` et résout l'ack, ou `null` en cas de silence
 *  (délai dépassé) ou d'ack vide. `socket.emit` est appelé immédiatement :
 *  si la socket est déconnectée, socket.io met en file jusqu'à reconnexion,
 *  le chien de garde borne l'attente côté UI. */
export function emitAck<T>(
  event: string,
  payload: unknown,
  timeoutMs: number = ACK_TIMEOUT_MS
): Promise<T | null> {
  return new Promise((resolve) => {
    const socket = getSocket();
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    // ⚠ NE PAS émettre `(event, undefined, ack)` : le sérialiseur socket.io
    // transforme l'argument `undefined` en `null` sur le fil, et un handler
    // sans payload — `socket.on("ev", (cb?) => …)` — reçoit alors
    // `(null, ackFn)` : son paramètre vaut `null`, il n'appelle JAMAIS l'ack
    // (memory:get rendait « Mémoire non chargée » à chaque chargement, le
    // handler s'exécutait mais sa réponse n'avait pas de destinataire).
    // Payload absent ⇒ émettre `(event, ack)` — le handler reçoit l'ack en
    // premier argument. (Audit v0.5.2 suivi : reproduit par sonde directe.)
    if (payload === undefined) {
      socket.emit(event, (res: T) => finish((res ?? null) as T | null));
    } else {
      socket.emit(event, payload, (res: T) => finish((res ?? null) as T | null));
    }
  });
}
