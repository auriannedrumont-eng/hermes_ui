// Hook « prompt système & instructions personnalisées » — F-11 / F-19
// (FORK.md §7.7). Consomme le singleton socket du chat :
//  - prompt actif de la conversation ouverte (system-prompt:*) ;
//  - bibliothèque de presets réutilisables (system-prompts:*) ;
//  - instructions personnalisées globales (custom-instructions:*, F-19).
// Le registre des réglages n'est pas sollicité : ces valeurs vivent côté
// service (table `system_prompts` / réglage `hermes.instructions.custom`).
"use client";

import { useCallback, useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";
import { useToast } from "@/hooks/use-toast";
import type {
  ConversationPrompt,
  SystemPromptPreset,
} from "@/lib/chat-types";

/** Déclencheurs FR des toasts de sauvegarde (utilisés par les deux panneaux). */
const SAVED_TOAST = { title: "Prompt enregistré", duration: 2500 } as const;
const INSTRUCTIONS_TOAST = {
  title: "Instructions personnalisées enregistrées",
  duration: 2500,
} as const;

export function useSystemPrompts(activeConversationId: string | null) {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState<ConversationPrompt | null>(null);
  const [presets, setPresets] = useState<SystemPromptPreset[]>([]);
  const [customInstructions, setCustomInstructions] = useState<string | null>(
    null
  );
  /** Limite de caractères des instructions globales (renvoyée par le service). */
  const [customMaxChars, setCustomMaxChars] = useState<number>(4000);

  // Charge l'état à la connexion / au changement de conversation active.
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => {
      socket.emit("system-prompts:list", (res: { presets?: SystemPromptPreset[] } = {}) => {
        if (Array.isArray(res.presets)) setPresets(res.presets);
      });
      socket.emit(
        "custom-instructions:get",
        (res: { value?: string; maxChars?: number } = {}) => {
          if (typeof res.value === "string") setCustomInstructions(res.value);
          if (typeof res.maxChars === "number") setCustomMaxChars(res.maxChars);
        }
      );
    };
    if (socket.connected) refresh();
    socket.on("connect", refresh);
    return () => {
      socket.off("connect", refresh);
    };
  }, []);

  // Prompt de la conversation active : chargé au changement (ack), suivi par
  // bus. Le reset passe par la clé d'effet : la valeur chargée du précédent id
  // ne fuit jamais vers la nouvelle conversation (guarded par comparaison).
  // Lot 3 (audit L3-3) : sans conversation active, le prompt de la PRÉCÉDENTE
  // restait affiché — remise à null pendant le rendu (motif React officiel
  // « adjust state when a prop changes » ; un setState synchrones dans un
  // effet est interdit par la règle react-hooks).
  const [lastActiveId, setLastActiveId] = useState<string | null>(null);
  if ((activeConversationId ?? null) !== lastActiveId) {
    setLastActiveId(activeConversationId ?? null);
    if (!activeConversationId) setPrompt(null);
  }
  useEffect(() => {
    if (!activeConversationId) return;
    const socket = getSocket();
    socket.emit(
      "system-prompt:get",
      { conversationId: activeConversationId },
      (res: { prompt?: ConversationPrompt | null } = {}) => {
        setPrompt(res.prompt ?? null);
      }
    );
  }, [activeConversationId]);

  // Bus : prompt modifié depuis un autre client (broadcast du service).
  useEffect(() => {
    const socket = getSocket();
    const onPromptChanged = (p: {
      conversationId: string;
      prompt?: ConversationPrompt | null;
    }) => {
      if (p.conversationId === activeConversationId) {
        setPrompt(p.prompt ?? null);
      }
    };
    const onPresetsChanged = (p: { presets?: SystemPromptPreset[] } = {}) => {
      if (Array.isArray(p.presets)) setPresets(p.presets);
    };
    const onInstructionsChanged = (p: { value?: string } = {}) => {
      if (typeof p.value === "string") setCustomInstructions(p.value);
    };
    socket.on("system-prompt:changed", onPromptChanged);
    socket.on("system-prompts:changed", onPresetsChanged);
    socket.on("custom-instructions:changed", onInstructionsChanged);
    return () => {
      socket.off("system-prompt:changed", onPromptChanged);
      socket.off("system-prompts:changed", onPresetsChanged);
      socket.off("custom-instructions:changed", onInstructionsChanged);
    };
  }, [activeConversationId]);

  /** Définit le prompt de la conversation active (effet au prochain tour). */
  const savePrompt = useCallback(
    (
      content: string,
      presetTitle?: string | null
    ): Promise<ConversationPrompt | null> =>
      new Promise((resolve) => {
        const conversationId = activeConversationId;
        if (!conversationId) return resolve(null);
        getSocket().emit(
          "system-prompt:set",
          { conversationId, content, presetTitle: presetTitle ?? null },
          (res: { prompt?: ConversationPrompt; error?: string } = {}) => {
            if (res.prompt) {
              setPrompt(res.prompt);
              toast(SAVED_TOAST);
            } else if (res.error) {
              toast({ title: "Prompt refusé", description: res.error, variant: "destructive" });
            }
            resolve(res.prompt ?? null);
          }
        );
      }),
    [activeConversationId, toast]
  );

  /** Retire le prompt de la conversation active. */
  const clearPrompt = useCallback(
    (): Promise<boolean> =>
      new Promise((resolve) => {
        const conversationId = activeConversationId;
        if (!conversationId) return resolve(false);
        getSocket().emit(
          "system-prompt:clear",
          { conversationId },
          (res: { ok?: boolean; error?: string } = {}) => {
            if (res.ok) setPrompt(null);
            resolve(!!res.ok);
          }
        );
      }),
    [activeConversationId]
  );

  /** Crée un preset dans la bibliothèque (section Hermes du volet). */
  const createPreset = useCallback(
    (title: string, content: string): Promise<SystemPromptPreset | null> =>
      new Promise((resolve) => {
        getSocket().emit(
          "system-prompts:create",
          { title, content },
          (res: { preset?: SystemPromptPreset; error?: string } = {}) => {
            if (!res.preset && res.error) {
              toast({ title: "Preset refusé", description: res.error, variant: "destructive" });
            }
            resolve(res.preset ?? null);
          }
        );
      }),
    [toast]
  );

  /** Met à jour un preset existant. */
  const updatePreset = useCallback(
    (id: string, title: string, content: string): Promise<SystemPromptPreset | null> =>
      new Promise((resolve) => {
        getSocket().emit(
          "system-prompts:update",
          { id, title, content },
          (res: { preset?: SystemPromptPreset; error?: string } = {}) => {
            if (!res.preset && res.error) {
              toast({ title: "Preset refusé", description: res.error, variant: "destructive" });
            }
            resolve(res.preset ?? null);
          }
        );
      }),
    [toast]
  );

  /** Supprime un preset de la bibliothèque. */
  const deletePreset = useCallback(
    (id: string): Promise<boolean> =>
      new Promise((resolve) => {
        getSocket().emit(
          "system-prompts:delete",
          { id },
          (res: { ok?: boolean; error?: string } = {}) => {
            if (!res.ok && res.error) {
              toast({ title: "Suppression impossible", description: res.error, variant: "destructive" });
            }
            resolve(!!res.ok);
          }
        );
      }),
    [toast]
  );

  /** Enregistre les instructions personnalisées globales (F-19). */
  const saveCustomInstructions = useCallback(
    (value: string): Promise<boolean> =>
      new Promise((resolve) => {
        getSocket().emit(
          "custom-instructions:set",
          { value },
          (res: { ok?: boolean; error?: string } = {}) => {
            if (res.ok) {
              setCustomInstructions(value);
              toast(INSTRUCTIONS_TOAST);
            } else if (res.error) {
              toast({
                title: "Instructions refusées",
                description: res.error,
                variant: "destructive",
              });
            }
            resolve(!!res.ok);
          }
        );
      }),
    [toast]
  );

  return {
    prompt,
    presets,
    customInstructions,
    customMaxChars,
    savePrompt,
    clearPrompt,
    createPreset,
    updatePreset,
    deletePreset,
    saveCustomInstructions,
  };
}
