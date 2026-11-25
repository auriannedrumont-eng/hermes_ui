// Liste des messages + état vide (accueil façon ChatGPT) + bouton retour en bas
// + rangée d'erreur persistante du dernier tour (F-04 : Réessayer / Masquer).
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  Code2,
  FileText,
  GitBranch,
  KeyRound,
  Lightbulb,
  Mail,
  RefreshCw,
} from "lucide-react";
import { HermesLogo } from "@/components/chat/hermes-logo";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ModeFlowCard } from "@/components/chat/mode-flow";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { readClientSetting, onSettingsChanged } from "@/lib/settings";
import type { Artifact, ChatMessage, StreamingState } from "@/lib/chat-types";
import { useStreamsRecord } from "@/lib/stream-store";
import type { ConversationMode } from "@/lib/modes";

const SUGGESTIONS = [
  {
    icon: FileText,
    title: "Créer un rapport HTML",
    prompt:
      "Crée-moi une page HTML « rapport-ventes.html » : un rapport de ventes trimestriel soigné, avec cartes de KPI, tableau et graphique.",
  },
  {
    icon: Code2,
    title: "Écrire un script",
    prompt:
      "Écris un script Python qui surveille un dossier et archive les fichiers de plus de 30 jours dans une archive horodatée.",
  },
  {
    icon: Mail,
    title: "Rédiger un email",
    prompt:
      "Rédige un email professionnel et courtois pour reporter une réunion de vendredi à lundi prochain.",
  },
  {
    icon: Lightbulb,
    title: "Brainstormer un projet",
    prompt:
      "Aide-moi à brainstormer 5 idées d'applications pour un agent IA connecté à Telegram.",
  },
];

/** Cartes d'artefacts ancrées sur un message (dernière version par clé). */
// Perf 2026-11-19 — cache d'identité : la fonction reconstruisait un tableau
// à chaque rendu, ce qui donnait une prop `artifactCards` NOUVELLE aux bulles
// mémoïsées à chaque delta (memo cassé). Le résultat est référentiellement
// stable tant que la liste d'artefacts vivante et le fallback du message ne
// changent pas (WeakMap : la liste remplacée libère l'entrée).
const NO_CARDS: Artifact[] = [];
const cardsCache = new WeakMap<Artifact[], Map<string, { fallback: Artifact[] | undefined; result: Artifact[] }>>();

function cardsForMessage(
  messageId: string,
  artifacts: Artifact[],
  fallback?: Artifact[]
): Artifact[] {
  let byMessage = cardsCache.get(artifacts);
  if (!byMessage) {
    byMessage = new Map();
    cardsCache.set(artifacts, byMessage);
  }
  const cached = byMessage.get(messageId);
  if (cached && cached.fallback === fallback) return cached.result;
  const byKey = new Map<string, Artifact>();
  for (const a of artifacts) {
    if (a.anchorMessageId !== messageId) continue;
    const cur = byKey.get(a.key);
    if (
      !cur ||
      a.version > cur.version ||
      (a.version === cur.version && a.createdAt > cur.createdAt)
    ) {
      byKey.set(a.key, a);
    }
  }
  const result: Artifact[] =
    byKey.size > 0 ? [...byKey.values()] : (fallback ?? NO_CARDS);
  byMessage.set(messageId, { fallback, result });
  return result;
}

interface MessageListProps {
  messages: ChatMessage[];
  /** F-17 : tous les streams actifs (tour simple + variantes a/b).
   *  (Plus passé par la page : MessageList lit le stream-store — les deltas
   *  de 16 ms ne re-rendent plus le sommet. Kept pour compat externe.) */
  streams?: StreamingState[];
  loadingHistory: boolean;
  isBusy: boolean;
  /** Erreur persistante du dernier tour (F-04) — affichée sous le fil. */
  turnError: { messageId: string; error: string } | null;
  /** F-31 — notice de silence pendant un tour (aucun événement depuis 60 s). */
  stallNotice?: string | null;
  /** Toutes les versions d'artefacts de la conversation (état vivant). */
  artifacts: Artifact[];
  /** Contenu des artefacts en cours de génération, par clé. */
  artifactStreams: Record<string, string>;
  onSuggestion: (prompt: string) => void;
  onRegenerate: () => void;
  /** F-17 : régénérer UN côté de la dernière comparaison. */
  onRegenerateVariant: (variant: "a" | "b") => void;
  /** F-14 — basculer la version affichée d'une réponse multi-versions. */
  onSetVersion: (message: ChatMessage, index: number) => void;
  onRetryError: () => void;
  onDismissError: () => void;
  /** Loi « une seule voix » (24/11) : ouvre Paramètres depuis la carte
   *  « Hermes non connecté » (erreur [HERMES_OFFLINE] du tour). */
  onOpenSettings?: () => void;
  /** Bandeau d'avance (24/11) : mode moteur vu par le service — null tant
   *  que le hello n'est pas reçu (pas de faux avertissement au boot). */
  gatewayMode?: "gateway" | "local" | null;
  /** Revue 95 : fournisseurs actionnables du hello (ids, ex. zai, openrouter)
   *  — en mode local AVEC clés actives, le bandeau « non connecté » serait
   *  faux : les tours partiront sur ces clés. */
  engineProviders?: string[] | null;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onFork: (messageId: string) => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onRetryArtifact: (artifactId: string) => void;
  /** F-30 — mode de la conversation (chip « Comparer » sur les paires). */
  conversationMode?: ConversationMode;
  /** F-30 — déroulé vivant du tour multi-voix (modes orchestrés). */
  modeFlowLive?: { messageId: string; rows: NonNullable<ChatMessage["modeFlow"]> } | null;
  /** 2026-11-25 — base vide (aucune conversation) : l'accueil indique le
   *  premier pas (choisir un dossier dans la sidebar) au lieu des
   *  suggestions. Le verrou côté service bloque l'envoi sans dossier :
   *  l'écran le dit AVANT le clic. */
  baseVide?: boolean;
}

/** Une colonne de comparaison : réponse persistée et/ou stream en cours. */
interface CompareCell {
  message?: ChatMessage;
  stream?: StreamingState;
}

type Row =
  | { kind: "single"; message: ChatMessage }
  | { kind: "pair"; a?: CompareCell; b?: CompareCell };

/** Regroupe le fil en lignes : les réponses assistant portant une variante
 *  (F-17) forment une paire côte à côte ; tout le reste reste en Pleine largeur. */
function buildRows(messages: ChatMessage[], streams: StreamingState[]): Row[] {
  const rows: Row[] = [];
  let openPair: Extract<Row, { kind: "pair" }> | null = null;
  const closePair = () => {
    openPair = null;
  };
  for (const m of messages) {
    if (m.role === "assistant" && m.variant) {
      if (!openPair) {
        openPair = { kind: "pair" };
        rows.push(openPair);
      }
      const cell: CompareCell = { message: m };
      if (m.variant === "a" && !openPair.a) openPair.a = cell;
      else if (m.variant === "b" && !openPair.b) openPair.b = cell;
      else {
        // Deux réponses de la même variante d'affilée (régén. d'un côté
        // après rechargement) : nouvelle paire.
        openPair = { kind: "pair", ...(m.variant === "a" ? { a: cell } : { b: cell }) };
        rows.push(openPair);
      }
    } else {
      closePair();
      rows.push({ kind: "single", message: m });
    }
  }
  // Les streams de comparaison rejoignent la dernière paire (ou en ouvrent une).
  for (const st of streams) {
    if (!st.variant) continue;
    let pair = rows[rows.length - 1];
    if (!pair || pair.kind !== "pair") {
      pair = { kind: "pair" };
      rows.push(pair);
    }
    const cell: CompareCell = { stream: st };
    if (st.variant === "a" && !pair.a) pair.a = cell;
    else if (st.variant === "b" && !pair.b) pair.b = cell;
    else {
      rows.push({ kind: "pair", ...(st.variant === "a" ? { a: cell } : { b: cell }) });
    }
  }
  return rows;
}

export function MessageList({
  messages,
  streams,
  loadingHistory,
  isBusy,
  turnError,
  stallNotice,
  artifacts,
  artifactStreams,
  onSuggestion,
  onRegenerate,
  onRegenerateVariant,
  onSetVersion,
  onRetryError,
  onDismissError,
  onOpenSettings,
  gatewayMode = null,
  engineProviders = null,
  onEdit,
  onDelete,
  onFork,
  onOpenArtifact,
  onRetryArtifact,
  conversationMode = "chat",
  modeFlowLive = null,
  baseVide = false,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  /** Tour simple (sans variante) — la bulle de stream en bas de fil. */
  // Store de stream (bonus perf) : la page ne transporte plus les deltas.
  const storeStreams = useStreamsRecord();
  // Mémorisé (revue 95) : Object.values crée un NOUVEAU tableau à chaque
  // rendu — l'effet de suivi du bas, dépendant de [effectiveStreams],
  // repartait à chaque rendu même sans delta.
  const effectiveStreams = useMemo(
    () => streams ?? Object.values(storeStreams),
    [streams, storeStreams]
  );
  const streaming = effectiveStreams.find((st) => !st.variant) ?? null;
  // F-30 — réglages du déroulé (hermes.modes.showFlow / showModels) : lus
  // au rendu et suivis par le bus des réglages (idiome InterfacePane).
  const [flowRev, setFlowRev] = useState(0);
  const showFlow = useMemo(
    () => readClientSetting<boolean>("hermes.modes.showFlow") !== false,
    [flowRev]
  );
  const showFlowModels = useMemo(
    () => readClientSetting<boolean>("hermes.modes.showModels") !== false,
    [flowRev]
  );
  useEffect(() => onSettingsChanged(() => setFlowRev((r) => r + 1)), []);

  // Déroulé vivant : rendu dans la bulle du stream si elle existe déjà,
  // sinon tout seul en bas de fil (la première ligne suffit à l'ouvrir).
  const liveFlowStreaming =
    modeFlowLive && effectiveStreams.some((s) => s.messageId === modeFlowLive.messageId);
  const liveFlowPending = modeFlowLive && !liveFlowStreaming;

  // Perf 2026-11-19 — suivi du bas throttlé : l'ancien effet posait
  // scrollTop = scrollHeight à CHAQUE delta (~60 Hz), forçant un layout
  // complet du fil à chaque fois. Pendant un tour, le suivi passe par un
  // rAF au plus (une écriture par frame) ; l'arrivée d'un message persisté
  // (envoi, clôture du tour) reste un saut direct.
  const scrollFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    },
    []
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    // Message persisté (envoi utilisateur, clôture du tour) : saut direct.
    el.scrollTop = el.scrollHeight;
  }, [messages.length, loadingHistory]);

  // Deltas en vol : une écriture par frame au plus, jamais par delta.
  useEffect(() => {
    if (effectiveStreams.length === 0) return;
    if (!pinnedRef.current) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const el = scrollRef.current;
      if (!el || !pinnedRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
  }, [effectiveStreams]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    pinnedRef.current = nearBottom;
    setShowJump(!nearBottom && el.scrollHeight > el.clientHeight + 200);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Identifiant de la dernière réponse assistant (pour « Régénérer »)
  let lastAssistantId: string | null = null;
  for (const m of messages) {
    if (m.role === "assistant") lastAssistantId = m.id;
  }

  const isEmpty = !loadingHistory && messages.length === 0 && effectiveStreams.length === 0;
  // Bandeau d'avance (loi « une seule voix », 24/11) : affiché dès l'ouverture
  // quand le service n'est PAS branché à la gateway — l'utilisateur sait AVANT
  // d'envoyer un message que l'agent doit être lancé, plus jamais un tour qui
  // échoue en surprise.
  // Revue P1-P7 (B2) : l'exception « clés fournisseurs présentes » est
  // SUPPRIMÉE — le repli pool de clés n'existe plus (le connecteur renvoie
  // [HERMES_OFFLINE] sans gateway) : montrer le bandeau tant que la
  // gateway n'est pas branchée, même avec des clés locales configurées.
  const horsLigne = gatewayMode !== null && gatewayMode !== "gateway";

  return (
    <div className="relative min-h-0 flex-1">
      {horsLigne ? (
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-left transition-colors hover:bg-warning/15"
          title="Ouvrir Paramètres"
        >
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-warning" />
          <span className="truncate text-[12.5px] text-warning">
            Hermes n'est pas encore connecté — lancez l'agent (Hermes-Web.bat) ou vérifiez la liaison dans Paramètres.
          </span>
          <span className="ml-auto shrink-0 text-[11px] font-medium text-warning underline decoration-warning/40 underline-offset-2">
            Paramètres
          </span>
        </button>
      ) : null}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-label="Fil de conversation"
      >
        {isEmpty ? (
          <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center px-4 py-10">
            <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-hermes text-hermes-foreground">
              <HermesLogo className="h-9 w-9" />
            </span>
            <h1 className="text-center text-[19px] font-semibold tracking-tight sm:text-[19px]">
              Bonjour.
            </h1>
            <p className="mt-1.5 text-center text-[15px] text-muted-foreground">
              Comment puis-je vous aider aujourd&apos;hui ?
            </p>
            {baseVide ? (
              // 2026-11-25 — premier pas sur base vide : une seule ligne,
              // placée avant les suggestions (le verrou bloque l'envoi sans
              // dossier, l'écran le dit ici plutôt qu'en erreur).
              <p className="mt-3 text-center text-[12.5px] text-muted-foreground">
                Première fois ici&nbsp;? Choisissez d&apos;abord un dossier
                dans la colonne de gauche.
              </p>
            ) : null}
            <div className="mt-8 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.title}
                  onClick={() => onSuggestion(s.prompt)}
                  className="group flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-hermes/50 hover:shadow-sm"
                >
                  <s.icon className="mt-0.5 h-4.5 w-4.5 shrink-0 text-hermes-text" />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">
                      {s.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                      {s.prompt}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
            {loadingHistory ? (
              <div className="space-y-6" aria-label="Chargement de la conversation">
                <Skeleton className="ml-auto h-10 w-2/5 rounded-3xl" />
                <div className="flex gap-3">
                  <Skeleton className="h-7 w-7 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-4/5" />
                  </div>
                </div>
              </div>
            ) : null}
            {buildRows(messages, effectiveStreams).map((row, i) =>
              row.kind === "single" ? (
                <div key={row.message.id} className="group/msg">
                  <MessageBubble
                    message={row.message}
                    isBusy={isBusy}
                    isLastAssistant={row.message.id === lastAssistantId && effectiveStreams.length === 0}
                    onRegenerate={onRegenerate}
                    onSetVersion={onSetVersion}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onFork={onFork}
                    artifactCards={cardsForMessage(row.message.id, artifacts, row.message.artifacts)}
                    artifactStreams={artifactStreams}
                    onOpenArtifact={onOpenArtifact}
                    onRetryArtifact={onRetryArtifact}
                    showFlow={showFlow}
                    showFlowModels={showFlowModels}
                    fallbackMode={conversationMode}
                  />
                </div>
              ) : (
                <ComparePair
                  // (audit 2026-11-21) clé dérivée des ids des messages de la
                  // paire : une clé d'index remontait toutes les paires
                  // suivantes quand un message antérieur était supprimé/édité
                  // (perte de l'état éphémère des bulles, saut du scroll).
                  key={`${row.a?.message?.id ?? "a-"}-${row.b?.message?.id ?? "b-"}`}
                  pair={row}
                  isBusy={isBusy}
                  onRegenerateVariant={onRegenerateVariant}
                  onSetVersion={onSetVersion}
                  artifacts={artifacts}
                  artifactStreams={artifactStreams}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onFork={onFork}
                  onOpenArtifact={onOpenArtifact}
                  onRetryArtifact={onRetryArtifact}
                  showChip={conversationMode === "compare"}
                />
              )
            )}
            {streaming ? (
              <div className="group/msg">
                <MessageBubble
                  message={{
                    id: streaming.messageId,
                    conversationId: streaming.conversationId,
                    role: "assistant",
                    content: streaming.content,
                    createdAt: new Date().toISOString(),
                  }}
                  isStreaming
                  streamingContent={streaming.content}
                  streamingReasoning={streaming.reasoning}
                  streamingStatus={streaming.status}
                  streamingTools={streaming.toolEvents}
                  artifactCards={cardsForMessage(streaming.messageId, artifacts)}
                  artifactStreams={artifactStreams}
                  onOpenArtifact={onOpenArtifact}
                  onRetryArtifact={onRetryArtifact}
                  modeFlow={
                    liveFlowStreaming && showFlow ? (modeFlowLive?.rows ?? undefined) : undefined
                  }
                  showFlow={showFlow}
                  showFlowModels={showFlowModels}
                  fallbackMode={conversationMode}
                />
              </div>
            ) : null}

            {/* F-30 — déroulé vivant sans bulle encore (le verdict streame
                plus tard) : l'encart s'affiche seul, première ligne ouverte. */}
            {liveFlowPending && showFlow ? (
              <ModeFlowCard
                mode={conversationMode}
                summary=""
                rows={modeFlowLive?.rows ?? []}
                live
                showModels={showFlowModels}
              />
            ) : null}

            {/* F-31 — notice de silence : le tour n'émet plus rien depuis
                60 s. Non destructif — le tour peut encore aboutir (gardes
                côté service), mais l'attente est expliquée, pas muette. */}
            {stallNotice ? (
              <div
                role="status"
                className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2.5"
              >
                <Activity className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p className="min-w-0 flex-1 break-words text-[12.5px] text-warning">
                  {stallNotice}
                </p>
              </div>
            ) : null}

            {/* Erreur persistante du dernier tour (F-04) : le partiel éventuel
                est déjà dans le fil au-dessus — ici, la cause et la sortie.
                Loi « une seule voix » (24/11) : l'erreur [HERMES_OFFLINE]
                (gateway absente, plus de repli pool) affiche une carte
                dédiée qui renvoie vers Paramètres au lieu d'un échec brut. */}
            {effectiveStreams.length === 0 && turnError ? (
              turnError.error.includes("[HERMES_OFFLINE]") ? (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2.5"
                >
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-medium text-warning">
                      Hermes n'est pas encore connecté
                    </p>
                    <p className="mt-0.5 break-words text-[12.5px] text-muted-foreground">
                      Lancez l&apos;agent Hermes (l&apos;application le fait toute
                      seule si vous passez par Hermes-Web.bat). Tout se passe
                      dans Paramètres.
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {onOpenSettings ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={onOpenSettings}
                          className="h-7 rounded-lg px-2.5 text-[12.5px]"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          Configurer dans Paramètres
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={onRetryError}
                        disabled={isBusy}
                        className="h-7 rounded-lg px-2.5 text-[12.5px] text-muted-foreground"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Réessayer
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-destructive">
                    La génération a échoué
                  </p>
                  <p className="mt-0.5 break-words text-[12.5px] text-muted-foreground">
                    {turnError.error}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onRetryError}
                      disabled={isBusy}
                      className="h-7 rounded-lg px-2.5 text-[12.5px]"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Réessayer
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={onDismissError}
                      className="h-7 rounded-lg px-2.5 text-[12.5px] text-muted-foreground"
                    >
                      Masquer
                    </Button>
                  </div>
                </div>
              </div>
              )
            ) : null}
            <div className="h-2" />
          </div>
        )}
      </div>

      {/* Bouton retour en bas */}
      {showJump ? (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="Revenir au dernier message"
          className="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:text-foreground"
        >
          <ArrowDown className="h-4.5 w-4.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Paire de comparaison (F-17) : deux réponses côte à côte (desktop),
 *  empilées sous 768 px. Chaque côté garde ses actions et son modèle. */
function ComparePair({
  pair,
  isBusy,
  onRegenerateVariant,
  onSetVersion,
  artifacts,
  artifactStreams,
  onEdit,
  onDelete,
  onFork,
  onOpenArtifact,
  onRetryArtifact,
  showChip = false,
}: {
  pair: Extract<Row, { kind: "pair" }>;
  isBusy: boolean;
  onRegenerateVariant: (variant: "a" | "b") => void;
  onSetVersion: (message: ChatMessage, index: number) => void;
  artifacts: Artifact[];
  artifactStreams: Record<string, string>;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string) => void;
  onFork: (messageId: string) => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onRetryArtifact: (artifactId: string) => void;
  /** F-30 — conversation en mode Comparer : la chip le dit au-dessus. */
  showChip?: boolean;
}) {
  const slots: Array<{ variant: "a" | "b"; cell?: CompareCell }> = [
    { variant: "a", cell: pair.a },
    { variant: "b", cell: pair.b },
  ];
  return (
    <div className="min-w-0">
      {showChip ? (
        <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-full bg-hermes/10 px-2.5 py-0.5 text-[11px] font-bold text-hermes-text">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l2.9 6.26L21.5 9.3l-4.75 4.87L17.8 21 12 17.77 6.2 21l1.05-6.83L2.5 9.3l6.6-1.04z" />
          </svg>
          Comparer · 2 modèles en parallèle
        </span>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Réponses comparées">
      {slots.map(({ variant, cell }) => (
        <div
          key={variant}
          className="group/msg flex min-w-0 flex-col rounded-2xl border border-border/70 bg-card/40 p-2.5"
        >
          <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
            <span
              className={
                variant === "a"
                  ? "flex h-5 min-w-5 items-center justify-center rounded-md bg-hermes/15 px-1 text-[11px] font-bold text-hermes-text"
                  : "flex h-5 min-w-5 items-center justify-center rounded-md bg-primary/15 px-1 text-[11px] font-bold text-primary"
              }
              aria-label={`Modèle ${variant.toUpperCase()}`}
            >
              {variant.toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {cell?.message?.model ?? cell?.stream?.status ?? "Réponse…"}
            </span>
            <button
              type="button"
              title={`Régénérer la réponse ${variant.toUpperCase()}`}
              aria-label={`Régénérer la réponse ${variant.toUpperCase()}`}
              disabled={isBusy}
              onClick={() => onRegenerateVariant(variant)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          {cell?.message ? (
            <MessageBubble
              message={cell.message}
              isBusy={isBusy}
              isLastAssistant={false}
              onRegenerate={() => onRegenerateVariant(variant)}
              onSetVersion={onSetVersion}
              onEdit={onEdit}
              onDelete={onDelete}
              onFork={onFork}
              artifactCards={cardsForMessage(cell.message.id, artifacts, cell.message.artifacts)}
              artifactStreams={artifactStreams}
              onOpenArtifact={onOpenArtifact}
              onRetryArtifact={onRetryArtifact}
            />
          ) : cell?.stream ? (
            <MessageBubble
              message={{
                id: cell.stream.messageId,
                conversationId: cell.stream.conversationId,
                role: "assistant",
                content: cell.stream.content,
                createdAt: new Date().toISOString(),
                variant,
              }}
              onSetVersion={undefined}
              isStreaming
              streamingContent={cell.stream.content}
              streamingReasoning={cell.stream.reasoning}
              streamingStatus={cell.stream.status}
              streamingTools={cell.stream.toolEvents}
              artifactCards={cardsForMessage(cell.stream.messageId, artifacts)}
              artifactStreams={artifactStreams}
              onOpenArtifact={onOpenArtifact}
              onRetryArtifact={onRetryArtifact}
            />
          ) : (
            <div className="flex min-h-16 items-center justify-center rounded-xl border border-dashed border-border text-[12.5px] text-muted-foreground">
              Réponse en attente
            </div>
          )}
        </div>
      ))}
      </div>
    </div>
  );
}
