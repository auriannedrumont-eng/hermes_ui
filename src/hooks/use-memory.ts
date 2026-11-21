// Mémoire utilisateur (F-18) — état côté client : chargement `memory:get`,
// suivi du bus `memory:changed`, actions (activer/désactiver, apprentissage
// automatique, notes). Miroir exact du contrat du mini-service ; aucune
// composition locale : le service assemble les instructions du tour.
//
// Lot audit 2026-11-21 : chien de garde (emitAck) sur tous les acks, champ
// `error` lu et TOASTÉ (avant : entièrement avalé), et les confirmations
// s'appliquent même si `state` est encore null (avant, la confirmation du
// service était jetée et l'interrupteur retombait visuellement).
"use client";

import { useCallback, useEffect, useState } from "react";
import { emitAck } from "@/lib/emit-ack";
import { getSocket } from "@/lib/socket";
import { useToast } from "@/hooks/use-toast";
import type { MemoryState } from "@/lib/chat-types";

/** Défauts affichés tant que le service n'a pas répondu — identiques à ceux
 *  du bus `memory:changed` (base du merge). */
const MEMORY_DEFAULTS: MemoryState = {
  enabled: true,
  autoLearn: false,
  notes: "",
  maxChars: 12_000,
};

export interface MemoryApi {
  state: MemoryState | null;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  setAuto: (autoLearn: boolean) => Promise<boolean>;
  saveNotes: (value: string) => Promise<boolean>;
}

export function useMemory(): MemoryApi {
  const { toast } = useToast();
  const [state, setState] = useState<MemoryState | null>(null);

  useEffect(() => {
    const socket = getSocket();
    // Le service répond à `memory:get` en quelques millisecondes (handler
    // synchrone, aucun chemin d'erreur) : un silence de 8 s ne peut venir
    // que d'une connexion coupée entre l'émission et l'ack. Or socket.io
    // garde la requête EN FILE et la sert à la reconnexion — le chargement
    // finit donc par réussir. Toaster systématiquement produisait une
    // fausse alerte (« Mémoire non chargée ») suivie d'une carte chargée
    // quelques secondes plus tard (scénario réel : page ouverte pendant un
    // redémarrage du service). D'où : silence si la socket est coupée au
    // moment du verdict (« connect » relance déjà load), et un dernier
    // essai silencieux avant de toaster le vrai échec (connecté + muet).
    const load = () => {
      void (async () => {
        const res = await emitAck<MemoryState>("memory:get", undefined);
        if (res && typeof res.notes === "string") {
          setState(res);
          return;
        }
        if (res === null && !getSocket().connected) return; // en file, servie à la reconnexion
        await new Promise((r) => setTimeout(r, 1200)); // laisse finir un ack en course
        const retry = await emitAck<MemoryState>("memory:get", undefined);
        if (retry && typeof retry.notes === "string") {
          setState(retry);
          return;
        }
        if (retry === null && !getSocket().connected) return;
        toast({
          title: "Mémoire non chargée",
          description: "Le service ne répond pas alors que la connexion est établie — réessayez.",
          variant: "destructive",
        });
      })();
    };
    const onChanged = (p: Partial<MemoryState>) => {
      setState((prev) => ({ ...(prev ?? MEMORY_DEFAULTS), ...p }));
    };
    socket.on("connect", load);
    socket.on("memory:changed", onChanged);
    if (socket.connected) load();
    return () => {
      socket.off("connect", load);
      socket.off("memory:changed", onChanged);
    };
  }, [toast]);

  const setEnabled = useCallback(
    (enabled: boolean): Promise<boolean> =>
      emitAck<{ ok?: boolean; error?: string }>("memory:set-enabled", { enabled }).then(
        (res) => {
          if (res === null) {
            toast({
              title: "Modification non enregistrée",
              description: "Le service n'a pas répondu (8 s).",
              variant: "destructive",
            });
            return false;
          }
          if (res.ok) {
            setState((prev) => ({ ...(prev ?? MEMORY_DEFAULTS), enabled }));
            return true;
          }
          toast({
            title: "Modification refusée",
            description: res.error ?? "Réponse inattendue du service.",
            variant: "destructive",
          });
          return false;
        }
      ),
    [toast]
  );

  const setAuto = useCallback(
    (autoLearn: boolean): Promise<boolean> =>
      emitAck<{ ok?: boolean; error?: string }>("memory:set-auto", { autoLearn }).then(
        (res) => {
          if (res === null) {
            toast({
              title: "Modification non enregistrée",
              description: "Le service n'a pas répondu (8 s).",
              variant: "destructive",
            });
            return false;
          }
          if (res.ok) {
            setState((prev) => ({ ...(prev ?? MEMORY_DEFAULTS), autoLearn }));
            return true;
          }
          toast({
            title: "Modification refusée",
            description: res.error ?? "Réponse inattendue du service.",
            variant: "destructive",
          });
          return false;
        }
      ),
    [toast]
  );

  const saveNotes = useCallback(
    (value: string): Promise<boolean> =>
      emitAck<{ ok?: boolean; value?: string; error?: string }>("memory:set-notes", {
        value,
      }).then((res) => {
        if (res === null) {
          toast({
            title: "Mémoire non enregistrée",
            description: "Le service n'a pas répondu (8 s).",
            variant: "destructive",
          });
          return false;
        }
        if (res.ok) {
          setState((prev) => ({
            ...(prev ?? MEMORY_DEFAULTS),
            notes: res.value ?? value,
          }));
          return true;
        }
        toast({
          title: "Mémoire non enregistrée",
          description: res.error ?? "Réponse inattendue du service.",
          variant: "destructive",
        });
        return false;
      }),
    [toast]
  );

  return { state, setEnabled, setAuto, saveNotes };
}
