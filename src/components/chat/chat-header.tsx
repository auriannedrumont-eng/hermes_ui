// En-tête : fil d'Ariane (dossier › sous-dossier › conversation, F-59),
// export, partage public, statut, thème
"use client";

import { useMemo, useState } from "react";
import {
  Check,
  Copy,
  Download,
  FileJson,
  FileText,
  Link2,
  Moon,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkle,
  Sun,
  Unlink,
  WifiOff,
  Wrench,
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
import { ConfirmDestructiveDialog } from "@/components/shared/confirm-destructive-dialog";
import type { ConversationMeta, GatewayMode, Project, ShareView } from "@/lib/chat-types";

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
  /** F-59 : dossiers courants — fil d'Ariane (dossier › sous-dossier › conv). */
  projects?: Project[];
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
  /** F-61 : masquage de la sidebar bureau — fourni uniquement par le bureau ;
   *  absent sur mobile (le bouton Sheet suffit). */
  sidebarHidden?: boolean;
  onToggleSidebar?: () => void;
}

export function ChatHeader({
  activeConversation,
  projects = [],
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
  sidebarHidden = false,
  onToggleSidebar,
}: ChatHeaderProps) {
  // Copie du lien : feedback inline « Lien copié » (toast inutile ici)
  const [copied, setCopied] = useState(false);
  // Garde de destruction (C5.1) : la révocation du lien public se confirme.
  const [revokeOpen, setRevokeOpen] = useState(false);

  // F-59 : fil d'Ariane — le dossier (et son parent, un seul niveau) de la
  // conversation affichée ; null = « Sans dossier ».
  const crumb = useMemo(() => {
    const pid = activeConversation?.projectId ?? null;
    if (!pid) return null;
    const folder = projects.find((p) => p.id === pid);
    if (!folder) return null;
    const parent = folder.parentId
      ? projects.find((p) => p.id === folder.parentId) ?? null
      : null;
    return { parent, folder };
  }, [activeConversation?.projectId, projects]);
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

      {/* F-61 : masquage de la sidebar (bureau) — la même icône réaffiche ;
          distinct du bouton mobile (Sheet) qui reste md:hidden. */}
      {onToggleSidebar ? (
        <Button
          variant="ghost"
          size="icon"
          className="hidden h-9 w-9 rounded-xl md:flex"
          onClick={onToggleSidebar}
          aria-label={sidebarHidden ? "Afficher la sidebar" : "Masquer la sidebar"}
        >
          {sidebarHidden ? (
            <PanelLeftOpen className="h-4.5 w-4.5" />
          ) : (
            <PanelLeftClose className="h-4.5 w-4.5" />
          )}
        </Button>
      ) : null}

      {/* Titre de la conversation + fil d'Ariane (F-59) */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        {activeConversation ? (
          <p className="flex min-w-0 items-center gap-1 text-[14px]">
            {crumb ? (
              <>
                {crumb.parent ? (
                  <>
                    <span className="hidden min-w-0 max-w-28 truncate text-[12.5px] text-muted-foreground min-[520px]:inline">
                      {crumb.parent.name}
                    </span>
                    {/* Revue P1-P7 : le chevron suit le seuil du NOM — caché
                        sous 520 px, sinon chevron orphelin quand le parent
                        est masqué. */}
                    <span className="hidden shrink-0 text-muted-foreground min-[520px]:inline" aria-hidden="true">
                      ›
                    </span>
                  </>
                ) : null}
                <span className="hidden min-w-0 max-w-32 truncate text-[12.5px] text-muted-foreground min-[420px]:inline">
                  {crumb.folder.name}
                </span>
                {/* Revue P1-P7 : même règle à 420 px — plus de chevron
                    orphelin quand le nom du dossier est masqué. */}
                <span className="hidden shrink-0 text-muted-foreground min-[420px]:inline" aria-hidden="true">
                  ›
                </span>
              </>
            ) : (
              <span className="hidden shrink-0 text-[12.5px] text-muted-foreground min-[420px]:inline">
                Sans dossier ›
              </span>
            )}
            <span className="truncate font-medium">{activeConversation.title}</span>
          </p>
        ) : (
          <p className="truncate text-[14px] font-medium">Hermes</p>
        )}
        {/* Prompt système (F-11) : la pastille est l'entrée unique de
            l'éditeur (C7 — le bouton d'en-tête jumeau est retiré). Tiera
            quand un prompt est actif, invite en pointillés sinon. */}
        {onOpenPrompt ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenPrompt}
                  aria-label={
                    hasPrompt
                      ? "Prompt système actif — éditer"
                      : "Définir le prompt système"
                  }
                  className={cn(
                    "inline-flex size-[22px] cursor-pointer items-center justify-center rounded-sm transition-colors",
                    hasPrompt
                      ? "bg-hermes/10 text-hermes-text hover:bg-hermes/20"
                      : "border border-dashed border-border text-muted-foreground hover:border-hermes/40 hover:text-foreground"
                  )}
                >
                  <Sparkle className="size-[12px]" strokeWidth={2} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {hasPrompt
                  ? "Prompt système actif sur cette conversation — cliquez pour l'éditer"
                  : "Aucun prompt système — cliquez pour le définir"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>


      {mode === "gateway" && connected ? (
        <span className="hidden items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          Gateway
        </span>
      ) : null}
      {!connected ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex h-8 items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 text-[11px] font-medium text-warning">
                <WifiOff className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Hors ligne</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>Connexion au service perdue — reconnexion…</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}

      {/* Dépannage (F-31) : ouvre le pont de diagnostic — visible en un clic,
          plus besoin de toucher à l'adresse du navigateur. */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
              aria-label="Dépannage — voir ce qui se passe"
              onClick={() => window.dispatchEvent(new Event("hermes:debug-open"))}
            >
              <Wrench className="h-4.5 w-4.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Dépannage — si ça bloque, cliquez puis « Copier le diagnostic »
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

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
                  ? "text-hermes-text hover:text-hermes-text"
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
                    <Check className="h-3.5 w-3.5 text-success" />
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
                  onSelect={() => setRevokeOpen(true)}
                  className="text-destructive focus:text-destructive dark:focus:text-destructive"
                >
                  <Unlink className="h-3.5 w-3.5" />
                  Révoquer le lien
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onClick={() => void onShareCreate()}>
                <Link2 className="h-3.5 w-3.5" />
                Créer un lien public
                <span className="ml-auto text-[11px] text-muted-foreground">
                  figé à la création
                </span>
              </DropdownMenuItem>
            )}
            {share ? (
              <p className="px-2 pt-1.5 pb-0.5 text-[11px] leading-relaxed text-muted-foreground">
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
      <ConfirmDestructiveDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title="Révoquer le lien public ?"
        description="La page partagée cessera de fonctionner immédiatement. La conversation reste intacte côté local."
        confirmLabel="Révoquer le lien"
        onConfirm={() => {
          onShareRevoke();
          setRevokeOpen(false);
        }}
      />
    </header>
  );
}
