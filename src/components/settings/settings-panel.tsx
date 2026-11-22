"use client";

// Volet « Paramètres » v4 — remplace le sheet 460 px de la phase 1.
// Design de référence : design/maquette-parametres-v4.html (la maquette
// fait foi) : volet gauche ~860 px ancré (plein écran < 1100 px),
// navigation par rail, pastilles comme seule langue d'état, descriptions
// simples sous les libellés.
//
// v2.6 — rail à 9 sections : Outils + Extensions + Skills fusionnées
// (« Outils & extensions », ajout unifié par nom ou adresse), listes
// limitées à ce qui est réellement installé (les fournisseurs de modèles
// gardent leur catalogue), statut du moteur affiché en pied de volet une
// seule fois.
//
// Sections livrées : Interface (registres client, effet immédiat),
// Modèles (catalogue vivant du service + tarifs), Fournisseurs / Clés de
// services (porte-clés, test réel), Chats web, Outils & extensions
// (ajout unifié), Hermes (presets + instructions + mémoire +
// conversations longues), Profils et Système (statuts et sondes réels,
// jamais simulés ; le moteur reste verrouillé « gateway »).
// ── Le volet ─────────────────────────────────────────────────────────
// Lot audit 2026-11-21 : nettoyage du code mort — les imports non utilisés
// (useTheme, getSocket, Select, Slider, Segmented, Switch,
// readClientSetting), le EFFORT_LABELS dupliqué (la source est dans
// models-section) et le SettingRow jamais rendu (chaque section a sa copie
// ; InterfacePane exporte celle de référence).

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Cpu,
  Globe,
  KeyRound,
  Layers,
  MessagesSquare,
  Monitor,
  Settings2,
  Sparkle,
  UserRound,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { InfoTip } from "@/components/shared/info-tip";
import { WebchatSection } from "@/components/settings/webchat-section";
import { ModesSection } from "@/components/settings/modes-section";
import {
  getSettingDef,
  onSettingsChanged,
  readClientSetting,
  writeClientSetting,
} from "@/lib/settings";
import {
  GENERIC_EFFORTS,
  type GatewayMode,
  type MemoryState,
  type ModelOption,
  type Project,
  type SystemPromptPreset,
} from "@/lib/chat-types";
import {
  PRICING_KEY,
  type PricingMap,
  parseModelLabel,
} from "@/lib/pricing";
import { useModelPricing } from "@/hooks/use-pricing";
import { getSocket } from "@/lib/socket";
import type { ProvidersApi } from "@/hooks/use-providers";
import { ProvidersSection } from "@/components/settings/providers-section";
import { HermesSection } from "@/components/settings/hermes-section";
import { ToolsExtensionsSection } from "@/components/settings/outils-extensions-section";
import { ProfilesSection } from "@/components/settings/profiles-section";
import { SystemSection } from "@/components/settings/system-section";
import { StorageSection } from "@/components/settings/storage-section";
import { InterfacePane } from "@/components/settings/interface-section";
import { ModelesPane } from "@/components/settings/models-section";
import { cn } from "@/lib/utils";

// ── Rail v2.7 (F-30) : « Modes de chat » rejoint le rail entre Modèles
// et Fournisseurs (ordre du maquette-parametres-modes.html) ; v0.3.0 a
// ajouté « Stockage » — le rail compte désormais 11 entrées.
const SECTIONS = [
  { id: "interface", icon: Monitor, label: "Interface" },
  { id: "modeles", icon: Cpu, label: "Modèles" },
  // Lot 5 (audit) : l'icône Layers était dupliquée (Modes / Fournisseurs) —
  // deux entrées visuellement identiques dans le sommaire du volet.
  { id: "modes", icon: MessagesSquare, label: "Modes de chat" },
  { id: "fournisseurs", icon: Layers, label: "Fournisseurs" },
  { id: "cles", icon: KeyRound, label: "Clés de services" },
  { id: "chatsweb", icon: Globe, label: "Chats web" },
  { id: "outils", icon: Wrench, label: "Outils & extensions" },
  { id: "hermes", icon: Sparkle, label: "Hermes" },
  { id: "profils", icon: UserRound, label: "Profils" },
  { id: "systeme", icon: Settings2, label: "Système" },
  // v0.3.0 : la gestion de l'espace disque déménage des Paramètres vers
  // une page dédiée « Stockage » — entrée au MÊME niveau que Système
  // (spec §2.1 : une page dédiée appelle une entrée dédiée, pas un sous-onglet).
  { id: "stockage", icon: Archive, label: "Stockage" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: GatewayMode | null;
  /** Fournisseurs LLM actionnables (v2.4) — pastille « clés actives » honnête. */
  engineProviders?: string[] | null;
  connected: boolean;
  /** Catalogue vivant (service) pour la ligne « Modèle de conversation ». */
  models: ModelOption[];
  /** Modèle sélectionné (état du hook, source de vérité côté chat). */
  selectedModel: string | null;
  projects: Project[];
  /** Fournisseurs & extensions (use-providers). */
  api: ProvidersApi;
  /** Prompt système & instructions (use-system-prompts, F-11/F-19). */
  promptsApi: {
    presets: SystemPromptPreset[];
    customInstructions: string | null;
    customMaxChars: number;
    createPreset: (title: string, content: string) => Promise<SystemPromptPreset | null>;
    updatePreset: (id: string, title: string, content: string) => Promise<SystemPromptPreset | null>;
    deletePreset: (id: string) => Promise<boolean>;
    saveCustomInstructions: (value: string) => Promise<boolean>;
  };
  /** Mémoire utilisateur (use-memory, F-18). */
  memoryApi: {
    state: MemoryState | null;
    setEnabled: (enabled: boolean) => Promise<boolean>;
    setAuto: (autoLearn: boolean) => Promise<boolean>;
    saveNotes: (value: string) => Promise<boolean>;
  };
  /** Version du service (hello) — pied du rail. */
  serverVersion?: string | null;
  /** v0.3.3 — révision disponible sur GitHub : badge orange sur
   *  l'onglet Système (l'utilisateur voit SANS ouvrir la section). */
  updateAvailable?: string | null;
  /** v2.4 (section Système) — sondes réelles du hello. */
  appRevision?: string | null;
  chromeHeadless?: "present" | "absent" | null;
  gatewayUrl?: string | null;
  /** F-02 : gateway réellement configurée (vs défaut automatique). */
  gatewayConfigured?: boolean;
  /** Jeton de gateway enregistré côté service (jamais la valeur). */
  gatewayTokenSet?: boolean;
  /** Branche/débranche la gateway (section Système). */
  onConnectGateway?: (
    url: string,
    token?: string
  ) => Promise<{ ok: boolean; error?: string }>;
  /** v2.4 (section Outils) — même calcul que la bascule « Web » du composer. */
  webSearchAvailable?: boolean;
}

// ── Une ligne de réglage : la référence est SettingRow dans
// interface-section.tsx (partagée avec Modèles) — la copie locale,
// jamais rendue, a été retirée (lot audit 2026-11-21).
// ── Le volet ─────────────────────────────────────────────────────────
export function SettingsPanel({
  open,
  onOpenChange,
  mode,
  engineProviders = null,
  connected,
  models,
  selectedModel,
  projects,
  api,
  promptsApi,
  memoryApi,
  serverVersion,
  updateAvailable = null,
  appRevision = null,
  chromeHeadless = null,
  gatewayUrl = null,
  gatewayConfigured = false,
  gatewayTokenSet = false,
  onConnectGateway,
  webSearchAvailable = false,
}: SettingsPanelProps) {
  const [section, setSection] = useState<SectionId>("interface");

  // Fermeture : la prochaine ouverture repart de la première section.
  const handleOpenChange = (next: boolean) => {
    if (!next) setSection("interface");
    onOpenChange(next);
  };

  // À l'ouverture : rafraîchit fournisseurs & extensions (données serveur).
  // Correctif 2026-11-19 (6), suite M-1 : la dépendance `api` re-déclenchait
  // l'effet à CHAQUE changement d'identité de l'objet — or les réponses du
  // service recréent les tableaux (nouvelles références, contenu identique)
  // à chaque refresh, donc `api` changeait à chaque réponse et le cycle
  // se réarmait seul : refresh → réponse → nouvel `api` → refresh… en boucle
  // infinie tant que le volet était ouvert (3 requêtes socket par cycle,
  // ~10 % CPU en continu, constat « ça monte dès qu'on touche un onglet »).
  // Seule la TRANSITION fermé→ouvert doit rafraîchir : `api` est une
  // référence stable (useMemo du hook, actions useCallback) et le volet lit
  // l'état courant par abonnement — il n'a pas besoin d'être re-déclenché.
  // (Le ref s'aligne dans un effet, jamais pendant le rendu — règle
  // react-hooks/refs.)
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  useEffect(() => {
    if (open) apiRef.current.refresh();
    // (deps volontairement sans `api` : cf. commentaire ci-dessus)
  }, [open]);

  const isLocal = connected && mode !== "gateway";
  // « local » : réponses réelles (clés fournisseurs) si au moins une clé est
  // active — sinon état « agent non détecté » (rien n'est simulé).
  const poolActive = (engineProviders?.length ?? 0) > 0;
  const extUpdate = api.extensions.some((e) => e.updateAvailable);

  // Navigation interne du volet (liens croisés des sections v2.4).
  const goto = (id: string) => {
    if (SECTIONS.some((s) => s.id === id)) setSection(id as SectionId);
  };

  const pane = () => {
    switch (section) {
      case "interface":
        return <InterfacePane projects={projects} />;
      case "modeles":
        return <ModelesPane models={models} selectedModel={selectedModel} />;
      case "modes":
        return <ModesSection models={models} connected={connected} />;
      case "fournisseurs":
        return <ProvidersSection kind="llm" api={api} />;
      case "cles":
        return <ProvidersSection kind="service" api={api} />;
      case "chatsweb":
        return <WebchatSection />;
      case "outils":
        return (
          <ToolsExtensionsSection
            webSearchAvailable={webSearchAvailable}
            onNavigate={goto}
            api={api}
          />
        );
      case "hermes":
        return (
          <HermesSection
            presets={promptsApi.presets}
            customInstructions={promptsApi.customInstructions}
            customMaxChars={promptsApi.customMaxChars}
            onCreatePreset={promptsApi.createPreset}
            onUpdatePreset={promptsApi.updatePreset}
            onDeletePreset={promptsApi.deletePreset}
            onSaveCustomInstructions={promptsApi.saveCustomInstructions}
            memory={memoryApi.state}
            onSetMemoryEnabled={memoryApi.setEnabled}
            onSetMemoryAuto={memoryApi.setAuto}
            onSaveMemoryNotes={memoryApi.saveNotes}
            models={models}
            selectedModel={selectedModel}
          />
        );
      case "profils":
        return <ProfilesSection />;
        case "systeme":
          return (
            <SystemSection
              connected={connected}
              appRevision={appRevision}
              updateAvailable={updateAvailable}
              onNavigateStorage={() => goto("stockage")}
            />
          );
      // v0.3.0 : page Stockage — explorateur des documents générés
      // (liste intégrale, groupement client, undo 7 s — spec §4).
      case "stockage":
        return <StorageSection />;
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="w-full gap-0 overflow-hidden bg-card p-0 shadow-2xl sm:max-w-none min-[1100px]:w-[860px] min-[1100px]:max-w-none min-[1100px]:flex-row min-[1100px]:rounded-r-[22px] min-[1100px]:border-r min-[1100px]:border-border data-[state=open]:duration-300"
      >
        <SheetTitle className="sr-only">Paramètres</SheetTitle>

          {/* ── Rail de sections ─────────────────────────────────────── */}
          <nav
            aria-label="Sections des paramètres"
            className="flex flex-none flex-col gap-2 border-border bg-background p-3 max-[1100px]:flex-row max-[1100px]:overflow-x-auto max-[1100px]:border-b max-[1100px]:pr-12 min-[1100px]:w-[208px] min-[1100px]:border-r"
          >
            <div className="flex items-center gap-2 px-1 pb-1 max-[1100px]:hidden">
              {/* Maquette : logo 26 px PLEIN --hermes, icône --hermes-foreground,
                  titre 14 px/700 (audit design §2.3 — la pastille pâle 22 px
                  affaiblissait le pavage de marque). */}
              <span className="flex size-[26px] items-center justify-center rounded-sm bg-hermes text-hermes-foreground">
                <Sparkle className="size-[14px]" strokeWidth={2} />
              </span>
              <b className="text-[14px] font-bold tracking-tight">Paramètres</b>
            </div>
            <div className="flex flex-col gap-0.5 max-[1100px]:flex-row max-[1100px]:gap-1">
              {SECTIONS.map(({ id, icon: Icon, label }) => {
                const active = id === section;
                return (
                  <Button
                    key={id}
                    type="button"
                    variant="ghost"
                    onClick={() => setSection(id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      // justify-start : le socle Button shadcn centre son
                      // contenu (justify-center) — sans override, le rail
                      // finissait avec des entrées centrées (et les libellés
                      // courts, type « Hermes » / « Profils », paraissaient
                      // indentés). La maquette .rn aligne à gauche.
                      "flex flex-none cursor-pointer items-center justify-start gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-hermes",
                      // Maquette .rn.on : l'entrée active est TEINTÉE hermès
                      // (--hermes-soft + hermes-text, 4,50/4,91:1 mesurés) —
                      // la signature du rail (audit design §2.2).
                      active && "bg-hermes-soft font-semibold text-hermes-text"
                    )}
                  >
                    <Icon className="size-[14px] flex-none" strokeWidth={2} />
                    <span className="whitespace-nowrap">{label}</span>
                {id === "outils" && extUpdate ? (
                  <i
                    className="ml-auto size-[7px] flex-none rounded-full bg-warning max-[1100px]:ml-1"
                    aria-label="Mise à jour disponible"
                  />
                ) : null}
                {/* v0.3.3 : une mise à jour de l'application elle-même est
                    disponible (vérifiée par le service, même volet fermé)
                    — badge orange sur « Système ». */}
                {id === "systeme" && updateAvailable ? (
                  <i
                    className="ml-auto size-[7px] flex-none rounded-full bg-warning max-[1100px]:ml-1"
                    aria-label="Mise à jour de l'application disponible"
                  />
                ) : null}
                  </Button>
                );
              })}
            </div>
            {/* Version du service — l'état du moteur est en pied de volet,
                une seule fois (v2.6 : doublon retiré). Maquette .rail-foot :
                isolée par un filet haut (audit design §2.4). */}
            <div className="mt-auto border-t border-border px-2 pt-3 text-[11px] whitespace-nowrap text-muted-foreground max-[1100px]:hidden">
              {serverVersion ? <span>service v{serverVersion}</span> : null}
            </div>
          </nav>

          {/* ── Contenu ──────────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col pt-4 min-[1100px]:pt-0">

            <div
              key={section}
              className="min-h-0 flex-1 animate-in fade-in overflow-y-auto overscroll-contain px-5 pt-2 pb-8 duration-150 min-[1100px]:px-[34px] min-[1100px]:pt-[26px] min-[1100px]:pb-[70px]"
            >
              {pane()}
            </div>

            {/* Pied : état du moteur + modifications en attente (v4) */}
            <div className="flex flex-none items-center gap-2.5 border-t border-border bg-background px-5 py-[9px] min-[1100px]:px-[34px]">
              {isLocal ? (
                poolActive ? (
                  <div className="group relative flex min-w-0 cursor-help items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="size-[7px] flex-none rounded-full bg-success" />
                    <span className="truncate">Hermes éteint · vos clés répondent</span>
                    <span className="pointer-events-none absolute bottom-full left-0 mb-2 w-max max-w-[260px] rounded-md bg-foreground px-[11px] py-2 text-left text-[11px] leading-relaxed text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                      Hermes est éteint : les réponses partent sur l&apos;API de vos
                      fournisseurs (clés actives : {engineProviders!.join(", ")}). Ajoutez ou
                      retirez des clés dans la section Fournisseurs.
                    </span>
                  </div>
                ) : (
                <div className="group relative flex min-w-0 cursor-help items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="size-[7px] flex-none rounded-full bg-muted-foreground/50" />
                  <span className="truncate">Hermes est éteint</span>
                  <span className="pointer-events-none absolute bottom-full left-0 mb-2 w-max max-w-[260px] rounded-md bg-foreground px-[11px] py-2 text-left text-[11px] leading-relaxed text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                    L&apos;application l&apos;allume toute seule si Hermes est installé ;
                    sinon lancez-le comme d&apos;habitude — la connexion est automatique.
                    Ou ajoutez la clé d&apos;un fournisseur (section Fournisseurs)
                    pour répondre sans Hermes.
                  </span>
                </div>
                )
              ) : (
                <span className="min-w-0" />
              )}
              {api.pendingEngineCount > 0 ? (
                <span
                  className="ml-auto flex h-6 flex-none items-center gap-1 rounded-full bg-hermes/10 px-2 text-[11px] font-semibold text-hermes-text"
                >
                  {api.pendingEngineCount} en attente
                  <InfoTip>Modifications moteur pas encore appliquées — pris en compte au prochain redémarrage du moteur.</InfoTip>
                </span>
              ) : null}
            </div>
          </div>
      </SheetContent>
    </Sheet>
  );
}
