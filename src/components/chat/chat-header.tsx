// En-tête : titre de conversation, export, statut de connexion, thème
"use client";

import { Download, FileJson, FileText, Moon, PanelLeft, Sun, WifiOff } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ConversationMeta, GatewayMode } from "@/lib/chat-types";

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label="Basculer entre thème clair et sombre"
    >
      <Sun className="h-4.5 w-4.5 hidden dark:block" />
      <Moon className="h-4.5 w-4.5 dark:hidden" />
    </Button>
  );
}

export type ExportFormat = "markdown" | "json" | "pdf";

interface ChatHeaderProps {
  activeConversation: ConversationMeta | null;
  mode: GatewayMode | null;
  connected: boolean;
  hasMessages: boolean;
  onExport: (format: ExportFormat) => void;
  onOpenSidebar: () => void;
}

export function ChatHeader({
  activeConversation,
  mode,
  connected,
  hasMessages,
  onExport,
  onOpenSidebar,
}: ChatHeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-xl md:hidden"
        onClick={onOpenSidebar}
        aria-label="Ouvrir le menu"
      >
        <PanelLeft className="h-4.5 w-4.5" />
      </Button>

      {/* Titre de la conversation */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        <p className="truncate text-[14px] font-medium">
          {activeConversation ? activeConversation.title : "Hermes"}
        </p>
      </div>

      {mode === "gateway" && connected ? (
        <span className="hidden items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11.5px] font-medium text-emerald-600 dark:text-emerald-400 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Gateway
        </span>
      ) : null}
      {!connected ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex h-8 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 text-[11.5px] font-medium text-amber-600 dark:text-amber-400">
                <WifiOff className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Hors ligne</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>Connexion au service perdue — reconnexion…</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}

      {/* Export de la conversation */}
      {activeConversation && hasMessages ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
              aria-label="Exporter la conversation"
            >
              <Download className="h-4.5 w-4.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Exporter la conversation</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onExport("markdown")}>
              <FileText className="h-3.5 w-3.5" />
              Markdown (.md)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("json")}>
              <FileJson className="h-3.5 w-3.5" />
              JSON (.json)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onExport("pdf")}>
              <Download className="h-3.5 w-3.5" />
              PDF (impression)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <ThemeToggle />
    </header>
  );
}
