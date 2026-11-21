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
    const load = () => {
      void emitAck<MemoryState>("memory:get", undefined).then((res) => {
        if (res === null) {
          toast({
            title: "Mémoire non chargée",
            description: "Le service n'a pas répondu (8 s) — réessayez à la reconnexion.",
            variant: "destructive",
          });
          return;
        }
        if (res && typeof res.notes === "string") setState(res);
      });
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
