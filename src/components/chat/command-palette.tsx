// Palette de commandes (Cmd/Ctrl+K) : actions rapides, changement de modèle,
// ouverture de conversation et recherche plein-texte dans les messages.
"use client";

import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { useEffect, useMemo, useState } from "react";
import {
  Download,
  FileJson,
  FileText,
  GitBranch,
  MessageSquare,
  Mic,
  Moon,
  MessageSquarePlus,
  Pin,
  PinOff,
  Search,
  Square,
  Sparkles,
  Volume2,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import type {
  ConversationMeta,
  ModelOption,
  SearchHit,
} from "@/lib/chat-types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: ConversationMeta[];
  activeConversation: ConversationMeta | null;
  models: ModelOption[];
  selectedModel: string | null;
  isBusy: boolean;
  hasMessages: boolean;
  onNewConversation: () => void;
  onSelectModel: (id: string) => void;
  onOpenConversation: (id: string) => void;
  onTogglePin: (id: string) => void;
  onRegenerate: () => void;
  onStop: () => void;
  onExport: (format: "markdown" | "json" | "pdf") => void;
  onSearchMessages: (query: string) => Promise<SearchHit[]>;
}

export function CommandPalette({
  open,
  onOpenChange,
  conversations,
  activeConversation,
  models,
  selectedModel,
  isBusy,
  hasMessages,
  onNewConversation,
  onSelectModel,
  onOpenConversation,
  onTogglePin,
  onRegenerate,
  onStop,
  onExport,
  onSearchMessages,
}: CommandPaletteProps) {
  const { setTheme, resolvedTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  // Recherche plein-texte débouncée pendant la saisie
  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(async () => {
      if (!open || q.length < 2) {
        setHits([]);
        return;
      }
      try {
        setHits(await onSearchMessages(q));
      } catch {
        setHits([]);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, open, onSearchMessages]);

  const handleOpenChange = (o: boolean) => {
    if (!o) setQuery("");
    onOpenChange(o);
  };

  const ql = query.trim().toLowerCase();
  const filteredConversations = useMemo(
    () =>
      ql
        ? conversations.filter((c) => c.title.toLowerCase().includes(ql)).slice(0, 6)
        : conversations.slice(0, 6),
    [conversations, ql]
  );

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Tapez une commande ou recherchez…"
      />
      <CommandList>
        <CommandEmpty>Aucun résultat.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(onNewConversation)}>
            <MessageSquarePlus className="h-4 w-4" />
            Nouvelle conversation
            <CommandShortcut>Maj+Ctrl+O</CommandShortcut>
          </CommandItem>
          {isBusy ? (
            <CommandItem onSelect={() => run(onStop)}>
              <Square className="h-4 w-4" />
              Arrêter la génération
              <CommandShortcut>Échap</CommandShortcut>
            </CommandItem>
          ) : hasMessages ? (
            <CommandItem onSelect={() => run(onRegenerate)}>
              <Sparkles className="h-4 w-4" />
              Régénérer la dernière réponse
            </CommandItem>
          ) : null}
          {activeConversation ? (
            <CommandItem onSelect={() => run(() => onTogglePin(activeConversation.id))}>
              {activeConversation.pinned ? (
                <>
                  <PinOff className="h-4 w-4" />
                  Détacher la conversation
                </>
              ) : (
                <>
                  <Pin className="h-4 w-4" />
                  Épingler la conversation
                </>
              )}
            </CommandItem>
          ) : null}
          <CommandItem
            onSelect={() =>
              run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))
            }
          >
            <Moon className="h-4 w-4" />
            Basculer le thème clair/sombre
          </CommandItem>
        </CommandGroup>

        {activeConversation && hasMessages ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={`Exporter « ${activeConversation.title.slice(0, 34)} »`}>
              <CommandItem onSelect={() => run(() => onExport("markdown"))}>
                <Download className="h-4 w-4" />
                Exporter en Markdown
              </CommandItem>
              <CommandItem onSelect={() => run(() => onExport("json"))}>
                <FileJson className="h-4 w-4" />
                Exporter en JSON
              </CommandItem>
              <CommandItem onSelect={() => run(() => onExport("pdf"))}>
                <FileText className="h-4 w-4" />
                Exporter en PDF (impression)
              </CommandItem>
            </CommandGroup>
          </>
        ) : null}

        {models.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Modèle">
              {models.slice(0, 8).map((m) => (
                <CommandItem
                  key={m.id}
                  value={`modèle ${m.label} ${m.id}`}
                  onSelect={() => run(() => onSelectModel(m.id))}
                >
                  <Sparkles className="h-4 w-4" />
                  {m.label}
                  {m.id === selectedModel ? (
                    <span className="ml-auto text-[11px] text-hermes-text">actif</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {filteredConversations.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Conversations">
              {filteredConversations.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`conversation ${c.title}`}
                  onSelect={() => run(() => onOpenConversation(c.id))}
                >
                  <MessageSquare className="h-4 w-4" />
                  {c.pinned ? (
                    <Pin className="h-3 w-3 rotate-45 text-hermes-text" aria-label="Épinglée" />
                  ) : null}
                  <span className="truncate">{c.title}</span>
                  {c.id === activeConversation?.id ? (
                    <span className="ml-auto text-[11px] text-muted-foreground">ouverte</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {hits.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Dans les messages">
              {hits.slice(0, 8).map((hit) => (
                <CommandItem
                  key={hit.messageId}
                  value={`message ${hit.conversationTitle} ${hit.excerpt}`}
                  onSelect={() => run(() => onOpenConversation(hit.conversationId))}
                >
                  <Search className="h-4 w-4" />
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px]">
                      {hit.conversationTitle}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {hit.role === "user" ? "Vous : " : "Hermes : "}
                      {hit.excerpt}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />
        <CommandGroup heading="Aide">
          <CommandItem disabled>
            <Mic className="h-4 w-4" />
            Dicter : bouton micro du composer
          </CommandItem>
          <CommandItem disabled>
            <Volume2 className="h-4 w-4" />
            Écouter une réponse : bouton haut-parleur sous la réponse
          </CommandItem>
          <CommandItem disabled>
            <GitBranch className="h-4 w-4" />
            Créer une branche : bouton branche sous un message
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
