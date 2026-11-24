// Actions de tour extraites de use-hermes-chat.ts (audit CRAP 2026-11, vague 4) :
// compaction (v2.4 + manuelle), envoi, arrêt, régénération, navigation de
// versions (F-14), réessai après erreur, édition, suppression. Corps des
// callbacks VERBATIM — mêmes identités de dépendances ; les tableaux de deps
// sont COMPLETS (setters useState et refs à identité stable — fréquence de
// mémoisation inchangée), même convention que use-conversations.ts (vague 3).
// useHermesChat consomme par déstructuration : l'API publique du hook ne
// change pas, la page n'est pas touchée.
"use client";

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { getSocket } from "@/lib/socket";
import { readClientSetting } from "@/lib/settings";
import { shouldAutoCompact, clampCompactThreshold } from "@/lib/compaction";
import { estimateTokens, type ContextRow } from "@/lib/tokens";
import { useToast } from "@/hooks/use-toast";
import { useChatStream } from "@/hooks/use-chat-stream";
import { useChatSettings } from "@/hooks/use-chat-settings";
import { useConversations } from "@/hooks/use-conversations";
import type { Attachment, ChatMessage } from "@/lib/chat-types";

type StreamApi = ReturnType<typeof useChatStream>;
type ToastFn = ReturnType<typeof useToast>["toast"];
type ConversationsApi = ReturnType<typeof useConversations>;
type ChatSettingsApi = ReturnType<typeof useChatSettings>;

/** Dépendances des actions de tour : tout identifiant du hook principal
 *  utilisé par les callbacks, passé tel quel (identités conservées). */
export type TurnActionsDeps = {
  toast: ToastFn;
  streaming: StreamApi["streaming"];
  setTurnError: StreamApi["setTurnError"];
  compactingRef: RefObject<boolean>;
  setCompacting: Dispatch<SetStateAction<boolean>>;
  activeIdRef: RefObject<string | null>;
  contextBaseRef: RefObject<{
    rows: ContextRow[];
    historyCount: number;
    windowTokens: number;
  } | null>;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  newConversation: ConversationsApi["newConversation"];
  openConversation: ConversationsApi["openConversation"];
  models: ChatSettingsApi["models"];
  selectedModelRef: ChatSettingsApi["selectedModelRef"];
  effortRef: ChatSettingsApi["effortRef"];
  permissionsRef: ChatSettingsApi["permissionsRef"];
  expertRef: ChatSettingsApi["expertRef"];
  webSearchRef: ChatSettingsApi["webSearchRef"];
};

export function useTurnActions(deps: TurnActionsDeps) {
  const {
    toast,
    streaming,
    setTurnError,
    compactingRef,
    setCompacting,
    activeIdRef,
    contextBaseRef,
    messages,
    setMessages,
    newConversation,
    openConversation,
    models,
    selectedModelRef,
    effortRef,
    permissionsRef,
    expertRef,
    webSearchRef,
  } = deps;

  /** Retrouve l'id d'un modèle depuis le libellé d'une réponse
   *  (« glm-4.6 · z.ai » — v2.3 : le suffixe fournisseur est retiré).
   *  C-08 : le serveur stocke `${result.model} · ${result.provider}` où
   *  result.model est l'ID (ex. « big-pickle »), pas le label (« Big
   *  Pickle ») — la recherche par label seul échouait et retombait sur le
   *  modèle du compositeur au lieu de celui de la voix A/B. */
  const modelIdFromLabel = useCallback(
    (label?: string) => {
      if (!label) return null;
      const clean = label.replace(/\s*·\s*[^·]+$/, "");
      return models.find((m) => m.id === clean || m.label === clean)?.id ?? null;
    },
    [models]
  );

  /** v2.4 — déclenche la compaction et attend l'ack FINAL du service
   *  (contract v2.4 : {ok:true, compact, done} à la fin, {ok:false, error}
   *  en échec ; l'ack « started » initial est ignoré). Best effort : en cas
   *  d'échec ou de timeout (60 s), le tour part quand même — le service
   *  retombera sur l'historique récent (limite 30 entrées), comme avant. */
  const autoCompactBeforeSend = useCallback(
    (conversationId: string) =>
      new Promise<void>((resolve) => {
        const socket = getSocket();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          compactingRef.current = false;
          setCompacting(false);
          resolve();
        };
        const timer = setTimeout(() => {
          toast({
            title: "Résumé automatique lent",
            description: "Le tour part sans attendre la fin du résumé.",
          });
          finish();
        }, 60_000);
        compactingRef.current = true;
        setCompacting(true);
        socket.emit("conversation:compact", { conversationId }, (res: {
          ok?: boolean;
          done?: boolean;
          started?: boolean;
          error?: string;
        } = {}) => {
          if (res?.done) {
            // Pas de toast ici : le service diffuse déjà conversation:compacted,
            // dont onConversationCompacted affiche le toast avec le nombre
            // EXACT de messages résumés — l'ancien double toast racontait
            // deux fois la même histoire à l'utilisateur.
            finish();
          } else if (res && (res.ok === false || res.error)) {
            toast({
              title: "Résumé automatique impossible",
              description: res.error ?? "Le tour part sur l'historique récent.",
              variant: "destructive",
            });
            finish();
          }
          // started (ok:true) : la compaction tourne — on attend la fin.
        });
      }),
    [toast, compactingRef, setCompacting]
  );

  const sendMessage = useCallback(
    // Revue P1-P7 : retourne true quand l'envoi est ACCEPTÉ (le compositeur
    // ne vide le brouillon qu'alors) — false sur chaque refus (résumé en
    // cours, réponse en vol, échec de création de conversation).
    async (text: string, attachments: Attachment[] = []): Promise<boolean> => {
      const content = text.trim();
      if (!content && attachments.length === 0) return false;
      // Loi « jamais bloqué » (2026-11-22) : un envoi n'est JAMAIS avalé en
      // silence — l'ancien garde unique `return` jetait l'envoi sans un mot
      // quand un verrou (réponse en vol, résumé) restait collé : l'écran
      // paraissait mort (cas réel du 2026-11-22). Chaque blocage dit
      // pourquoi et donne l'issue en une phrase ; la vigie (use-chat-stream)
      // relâche de toute façon un verrou muet depuis plus de 6 min.
      if (compactingRef.current) {
        toast({
          title: "Résumé du contexte en cours",
          description: "Quelques secondes — réenvoyez juste après.",
        });
        return false;
      }
      if (streaming) {
        toast({
          title: "Hermes finit une réponse précédente",
          description:
            "Attendez la fin — ou appuyez sur le bouton rond « Arrêter » si rien ne bouge, puis renvoyez.",
        });
        return false;
      }

      let conversationId = activeIdRef.current;
      if (!conversationId) {
        conversationId = await newConversation();
        if (!conversationId) return false;
      }

      // Message utilisateur optimiste
      const optimistic: ChatMessage = {
        id: `local-${Date.now()}`,
        conversationId,
        role: "user",
        content,
        attachments: attachments.length ? attachments : undefined,
        model: selectedModelRef.current ?? undefined,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);

      const socket = getSocket();

      // v2.4 — conversations longues : résumé automatique avant le tour.
      // Même mesure que la jauge du composer (base du tour + brouillon) contre
      // la fenêtre du modèle. Le résumé part sur l'historique SANS ce message
      // (il n'est pas encore en base) — le service l'ajoutera après.
      const base = contextBaseRef.current;
      if (base) {
        const draftTokens = estimateTokens(content);
        const usedTokens =
          base.rows.reduce((acc, r) => acc + r.tokens, 0) + draftTokens;
        if (
          shouldAutoCompact({
            enabled:
              readClientSetting<boolean>("hermes.compaction.auto") === true,
            thresholdPct: clampCompactThreshold(
              readClientSetting<number>("hermes.compaction.threshold")
            ),
            windowTokens: base.windowTokens,
            usedTokens,
            messageCount: base.historyCount,
          })
        ) {
          await autoCompactBeforeSend(conversationId);
        }
      }

      // F-30 : le mode de la conversation (Comparer compris) est relu par le
      // SERVICE à chaque envoi — l'écran n'envoie plus de paire de comparaison.
      socket.emit(
        "chat:send",
        {
          conversationId,
          content,
          model: selectedModelRef.current ?? undefined,
          attachments: attachments.length ? attachments : undefined,
          effort: effortRef.current ?? undefined,
          permissionsMode: permissionsRef.current,
          ...expertRef.current,
          webSearch: webSearchRef.current,
        },
        // Ack (revue 2026-11-13) : refus propre si un tour est déjà en vol
        // sur cette conversation (le serveur n'entrelace plus deux streams).
        // Le message optimiste est retiré, une erreur claire s'affiche.
        // Revue P1-P7 : l'erreur n'écrit turnError que si SA conversation est
        // toujours active — l'utilisateur peut avoir changé de conversation
        // pendant l'envoi (ou pendant l'attente du résumé) : l'erreur de
        // convA n'écrase plus l'écran de convB.
        (res: { error?: string } | null) => {
          if (res?.error) {
            setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
            if (activeIdRef.current === conversationId) {
              setTurnError({ messageId: optimistic.id, error: res.error });
            }
          }
        }
      );
      // Accepté : le tour part — le compositeur peut vider le brouillon.
      return true;
    },
    [
      toast,
      compactingRef,
      streaming,
      activeIdRef,
      newConversation,
      setMessages,
      selectedModelRef,
      contextBaseRef,
      effortRef,
      permissionsRef,
      expertRef,
      webSearchRef,
      autoCompactBeforeSend,
      setTurnError,
    ]
  );

  const stopGeneration = useCallback(() => {
    if (!activeIdRef.current) return;
    // Lot 3 (audit L3-5) : le stop est désormais acquitté par le service —
    // l'état « interrompu » reste porté par stream:status/stream:done ; l'ack
    // ne fait que fermer la promesse (aucun toast en cas de succès).
    getSocket().emit("chat:stop", { conversationId: activeIdRef.current }, () => {});
  }, [activeIdRef]);

  /** Régénère la dernière réponse (relance le tour depuis le dernier message utilisateur). */
  /** F-17 : `variant` régénère UN côté d'une comparaison ; sans argument,
   *  en mode comparaison, les deux côtés sont relancés ; sinon tour simple. */
  const regenerate = useCallback(
    (rawVariant?: "a" | "b") => {
      // Garde : un branchement direct onClick={regenerate} transmet
      // l'événement React en premier argument — seul "a"/"b" compte.
      const variant = rawVariant === "a" || rawVariant === "b" ? rawVariant : undefined;
      const conversationId = activeIdRef.current;
      if (!conversationId || streaming) return;
      const base = {
        effort: effortRef.current ?? undefined,
        permissionsMode: permissionsRef.current,
        ...expertRef.current,
        webSearch: webSearchRef.current,
      };
      const resync = (res: { ok?: boolean; error?: string } | null) => {
        if (!res?.ok) openConversation(conversationId);
      };
      if (variant) {
        // Côté d'une comparaison (mode coupé ou session rechargée) :
        // retrouve le modèle de ce côté depuis le libellé de sa réponse.
        const last = [...messages].reverse().find((m) => m.variant === variant);
        const id = modelIdFromLabel(last?.model) ?? selectedModelRef.current ?? undefined;
        // F-17/F-14 : retirer la réponse assistant de CETTE variante située
        // APRÈS le dernier message utilisateur — l'ancienne boucle par la fin
        // butait sur la réponse de l'autre variante (b en fin de fil : la
        // réponse a restait affichée en doublon du tour relancé).
        setMessages((prev) => {
          let lastUserIdx = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "user") {
              lastUserIdx = i;
              break;
            }
          }
          return prev.filter(
            (m, idx) => !(idx > lastUserIdx && m.role === "assistant" && m.variant === variant)
          );
        });
        getSocket().emit("chat:regenerate", { conversationId, variant, model: id, ...base }, resync);
        return;
      }
      // Tour simple — le service relu le mode de la conversation : en mode
      // Comparer, les DEUX côtés repartent ensemble ; en mode orchestré, la
      // chaîne complète rejoue (une seule réponse conservée, comme à l'envoi).
      setMessages((prev) => {
        const next = [...prev];
        while (next.length > 0 && next[next.length - 1].role === "assistant") next.pop();
        return next;
      });
      getSocket().emit(
        "chat:regenerate",
        { conversationId, model: selectedModelRef.current ?? undefined, ...base },
        resync
      );
    },
    [
      activeIdRef,
      streaming,
      effortRef,
      permissionsRef,
      expertRef,
      webSearchRef,
      messages,
      modelIdFromLabel,
      selectedModelRef,
      setMessages,
      openConversation,
    ]
  );

  /** F-14 — affiche la version `index` d'une réponse multi-versions. La
   *  version choisie devient aussi celle envoyée au modèle au tour suivant ;
   *  le fil entier revient par `messages:refreshed` (y compris à l'émetteur). */
  const setMessageVersion = useCallback(
    (message: ChatMessage, index: number) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || !message.versions || streaming) return;
      getSocket().emit(
        "message:setVersion",
        { conversationId, group: message.versions.group, index },
        (res: { ok?: boolean; error?: string } | null) => {
          if (!res?.ok) openConversation(conversationId);
        }
      );
    },
    [activeIdRef, streaming, openConversation]
  );

  /** Réessai après erreur (F-04) : relance le tour depuis le dernier message utilisateur. */
  const retryAfterError = useCallback(() => {
    setTurnError(null);
    regenerate();
  }, [setTurnError, regenerate]);

  /** Modifie un message utilisateur et relance le tour depuis ce point. */
  const editMessage = useCallback(
    (messageId: string, content: string) => {
      const conversationId = activeIdRef.current;
      const clean = content.trim();
      if (!conversationId || !clean || streaming) return;
      const socket = getSocket();
      if (messageId.startsWith("local-")) {
        // Message pas encore synchronisé : resynchronise le fil
        openConversation(conversationId);
        return;
      }
      // Optimiste : met à jour le contenu et retire tout ce qui suit
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx < 0) return prev;
        return [...prev.slice(0, idx), { ...prev[idx], content: clean }];
      });
      socket.emit(
        "message:edit",
        {
          conversationId,
          messageId,
          content: clean,
          // F-30 : le mode de la conversation (Comparer compris) est relu par
          // le service — l'édition relance ce que le mode décide, sans paire
          // envoyée par l'écran.
          model: selectedModelRef.current ?? undefined,
          effort: effortRef.current ?? undefined,
          permissionsMode: permissionsRef.current,
          ...expertRef.current,
          webSearch: webSearchRef.current,
        },
        (res: { ok?: boolean; error?: string }) => {
          if (!res?.ok) openConversation(conversationId);
        }
      );
    },
    [
      activeIdRef,
      streaming,
      openConversation,
      setMessages,
      selectedModelRef,
      effortRef,
      permissionsRef,
      expertRef,
      webSearchRef,
    ]
  );

  /** Supprime un message individuel. */
  const deleteMessage = useCallback(
    (messageId: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId) return;
      if (messageId.startsWith("local-")) {
        openConversation(conversationId);
        return;
      }
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      getSocket().emit(
        "message:delete",
        { conversationId, messageId },
        (res: { ok?: boolean; error?: string }) => {
          if (!res?.ok) openConversation(conversationId);
        }
      );
    },
    [activeIdRef, openConversation, setMessages]
  );

  /** Lance la compaction de la conversation active (résumé en tête de session). */
  const compactConversation = useCallback(() => {
    const conversationId = activeIdRef.current;
    if (!conversationId || streaming) return;
    // Revue P1-P7 : le verrou compactingRef est posé par la compaction
    // MANUELLE aussi — l'autoCompact le posait, pas celle-ci : sendMessage
    // pouvait partir pendant un résumé manuel. Timeout 90 s : sur coupure
    // socket (ack jamais rendu), le spinner ne reste plus collé à vie.
    compactingRef.current = true;
    setCompacting(true);
    const garde = setTimeout(() => {
      compactingRef.current = false;
      setCompacting(false);
      toast({
        title: "Compaction lente",
        description: "Le service n'a pas confirmé le résumé — réessayez.",
        variant: "destructive",
      });
    }, 90_000);
    getSocket().emit(
      "conversation:compact",
      { conversationId },
      (res: { ok?: boolean; error?: string } = {}) => {
        if (!res?.ok) {
          clearTimeout(garde);
          compactingRef.current = false;
          setCompacting(false);
          toast({ title: "Compaction impossible", description: res?.error, variant: "destructive" });
        }
        // Succès : la confirmation arrive par conversation:compacted (broadcast)
      }
    );
  }, [activeIdRef, streaming, compactingRef, setCompacting, toast]);

  return {
    autoCompactBeforeSend,
    sendMessage,
    stopGeneration,
    regenerate,
    setMessageVersion,
    retryAfterError,
    editMessage,
    deleteMessage,
    compactConversation,
  };
}
