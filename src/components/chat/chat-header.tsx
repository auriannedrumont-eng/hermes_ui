// En-tête : titre de conversation, export, partage public, statut, thème
"use client";

import { useState } from "react";
import {
  Check,
  Copy,
  Download,
  FileJson,
  FileText,
  Link2,
  Moon,
  PanelLeft,
  Sparkle,
  Sun,
  Unlink,
  WifiOff,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { ConversationMeta, GatewayMode, ShareView } from "@/lib/chat-types";

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
  /** Prompt système actif sur cette conversation (F-11). */
  hasPrompt?: boolean;
  onOpenPrompt?: () => void;
  /** Partage actif de la conversation (F-13) — null si aucun. */
  share: ShareView | null;
  onShareCreate: () => Promise<ShareView | null>;
  onShareRevoke: () => void;
  onExport: (format: ExportFormat) => void;
  onOpenSidebar: () => void;
}

export function ChatHeader({
  activeConversation,
  mode,
  connected,
  hasMessages,
  hasPrompt = false,
  onOpenPrompt,
  share,
  onShareCreate,
  onShareRevoke,
  onExport,
  onOpenSidebar,
}: ChatHeaderProps) {
  // Copie du lien : feedback inline « Lien copié » (toast inutile ici)
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/shared/${share.token}`
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard indisponible (contexte non sécurisé) */
    }
  };
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
        {/* Prompt système actif (F-11) : pastille cliquable près du titre */}
        {hasPrompt && onOpenPrompt ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenPrompt}
                  aria-label="Prompt système de la conversation"
                  className="inline-flex size-[22px] cursor-pointer items-center justify-center rounded-[7px] bg-hermes/10 text-hermes transition-colors hover:bg-hermes/20"
                >
                  <Sparkle className="size-[12px]" strokeWidth={2.2} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                Prompt système actif sur cette conversation — cliquez pour l&apos;éditer
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>

      {/* Prompt système (F-11) : bouton d'accès à l'éditeur */}
      {onOpenPrompt ? (
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-8 rounded-xl px-2.5 text-[12px] font-medium gap-1.5",
            hasPrompt
              ? "text-hermes hover:text-hermes"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={onOpenPrompt}
          aria-label="Prompt système de la conversation"
        >
          <Sparkle className="h-3.5 w-3.5" strokeWidth={2.2} />
          <span className="hidden sm:inline">prompt</span>
        </Button>
      ) : null}

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

      {/* Partage public lecture seule (F-13) */}
      {activeConversation && hasMessages ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-9 w-9 rounded-xl",
                share
                  ? "text-hermes hover:text-hermes"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-label="Partager la conversation"
            >
              <Link2 className={cn("h-4.5 w-4.5", share && "fill-hermes/15")} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>
              {share ? "Lien public actif" : "Partager en lecture seule"}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {share ? (
              <>
                <DropdownMenuItem onClick={() => void copyLink()}>
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Lien copié !" : "Copier le lien"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    window.open(`/shared/${share.token}`, "_blank", "noopener")
                  }
                >
                  <Link2 className="h-3.5 w-3.5" />
                  Ouvrir la vue publique
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={onShareRevoke}
                  className="text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
                >
                  <Unlink className="h-3.5 w-3.5" />
                  Révoquer le lien
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onClick={() => void onShareCreate()}>
                <Link2 className="h-3.5 w-3.5" />
                Créer un lien public
                <span className="ml-auto text-[10px] text-muted-foreground">
                  figé à la création
                </span>
              </DropdownMenuItem>
            )}
            {share ? (
              <p className="px-2 pt-1.5 pb-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
                {share.messageCount} message(s) · créé le{" "}
                {new Date(share.createdAt).toLocaleDateString("fr-FR")} — le
                contenu est un instantané : la conversation peut continuer sans
                changer le lien.
              </p>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
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
