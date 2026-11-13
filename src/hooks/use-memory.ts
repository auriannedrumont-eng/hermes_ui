// Mémoire utilisateur (F-18) — état côté client : chargement `memory:get`,
// suivi du bus `memory:changed`, actions (activer/désactiver, apprentissage
// automatique, notes). Miroir exact du contrat du mini-service ; aucune
// composition locale : le service assemble les instructions du tour.
"use client";

import { useCallback, useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";
import type { MemoryState } from "@/lib/chat-types";

export interface MemoryApi {
  state: MemoryState | null;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  setAuto: (autoLearn: boolean) => Promise<boolean>;
  saveNotes: (value: string) => Promise<boolean>;
}

export function useMemory(): MemoryApi {
  const [state, setState] = useState<MemoryState | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const load = () => {
      socket.emit("memory:get", (res: MemoryState = {} as MemoryState) => {
        if (res && typeof res.notes === "string") setState(res);
      });
    };
    const onChanged = (p: Partial<MemoryState>) => {
      setState((prev) => {
        const base: MemoryState =
          prev ?? { enabled: true, autoLearn: false, notes: "", maxChars: 12_000 };
        return { ...base, ...p };
      });
    };
    socket.on("connect", load);
    socket.on("memory:changed", onChanged);
    if (socket.connected) load();
    return () => {
      socket.off("connect", load);
      socket.off("memory:changed", onChanged);
    };
  }, []);

  const setEnabled = useCallback((enabled: boolean): Promise<boolean> => {
    return new Promise((resolve) => {
      getSocket().emit("memory:set-enabled", { enabled }, (res: { ok?: boolean } = {}) => {
        if (res.ok) setState((prev) => (prev ? { ...prev, enabled } : prev));
        resolve(!!res.ok);
      });
    });
  }, []);

  const setAuto = useCallback((autoLearn: boolean): Promise<boolean> => {
    return new Promise((resolve) => {
      getSocket().emit("memory:set-auto", { autoLearn }, (res: { ok?: boolean } = {}) => {
        if (res.ok) setState((prev) => (prev ? { ...prev, autoLearn } : prev));
        resolve(!!res.ok);
      });
    });
  }, []);

  const saveNotes = useCallback((value: string): Promise<boolean> => {
    return new Promise((resolve) => {
      getSocket().emit(
        "memory:set-notes",
        { value },
        (res: { ok?: boolean; value?: string; error?: string } = {}) => {
          if (res.ok) setState((prev) => (prev ? { ...prev, notes: res.value ?? value } : prev));
          resolve(!!res.ok);
        }
      );
    });
  }, []);

  return { state, setEnabled, setAuto, saveNotes };
}
