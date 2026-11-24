// Contexte partagé des handlers — câblé UNE fois par index.ts au démarrage
// (découpage 2026-11, FORK.md §10). Chaque module handlers/*.ts lit ses
// dépendances (store, io, connector, helpers du tour, vues wire, constantes)
// via ce contexte : les handlers restent des fonctions pures « pose les
// socket.on », sans import direct du cycle de vie du service.
// Types et fonctions pures : importés et exposés directement dans le ctx.
import type { Server } from "socket.io";
import type { Store, ArtifactRow } from "../store";
import type { HermesConnector } from "../hermes-connector";
import type { Attachment, TurnSettings } from "../types";
import type { ModeConfig } from "../modes";
import { FICHES } from "../webchat/fiches";
import {
  CUSTOM_INSTRUCTIONS_KEY,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_MEMORY_CHARS,
  MAX_PROMPT_CHARS,
  MEMORY_AUTO_KEY,
  MEMORY_ENABLED_KEY,
  MEMORY_NOTES_KEY,
  rowToPreset,
  sanitizeExpertSettings,
  validatePromptText,
} from "../prompts";
import { resolveMode, normalizeModeConfig } from "../modes";
import { MAX_ATTACHMENTS_PER_MESSAGE, saveAttachment, deleteAttachmentFiles } from "../uploads";
import { transcribeAudioBase64 } from "../asr";
import { catalogModelsResult, modelLabel } from "../models";
import { webchatModelOptions, webchatModelLabel, webchatStatus } from "../webchat/engine";
import {
  fetchRepoSnapshot,
  knownProviderCatalog,
  maskSecret,
  parseRepoInput,
  resolveKnownProvider,
  testProviderKey,
  toKeyView,
} from "../providers";
import { buildSnapshot, generateShareToken, rowToShareView } from "../shares";
import { trace } from "../trace";
import { chromeProfileStats, clearChromeProfiles } from "../render";
import {
  ensureBrowser,
  killPilotBrowser,
  launchWatchdog,
  readPilotInfo,
  touchActivity,
} from "../webchat/browser";
import { findTab, listTargets, newTab } from "../webchat/cdp";
import { readWebchatConfig } from "../webchat/engine";

export interface HandlerContext {
  // Constantes pures
  FICHES: typeof FICHES;
  CUSTOM_INSTRUCTIONS_KEY: string;
  MAX_CUSTOM_INSTRUCTIONS_CHARS: number;
  MAX_MEMORY_CHARS: number;
  MAX_PROMPT_CHARS: number;
  MEMORY_AUTO_KEY: string;
  MEMORY_ENABLED_KEY: string;
  MEMORY_NOTES_KEY: string;
  MAX_ATTACHMENTS_PER_MESSAGE: number;
  GATEWAY_URL_KEY: string;
  GATEWAY_TOKEN_KEY: string;
  // Fonctions pures
  resolveMode: typeof resolveMode;
  normalizeModeConfig: typeof normalizeModeConfig;
  rowToPreset: typeof rowToPreset;
  sanitizeExpertSettings: typeof sanitizeExpertSettings;
  validatePromptText: typeof validatePromptText;
  saveAttachment: typeof saveAttachment;
  deleteAttachmentFiles: typeof deleteAttachmentFiles;
  transcribeAudioBase64: typeof transcribeAudioBase64;
  catalogModelsResult: typeof catalogModelsResult;
  modelLabel: typeof modelLabel;
  webchatModelOptions: typeof webchatModelOptions;
  webchatModelLabel: typeof webchatModelLabel;
  knownProviderCatalog: typeof knownProviderCatalog;
  resolveKnownProvider: typeof resolveKnownProvider;
  parseRepoInput: typeof parseRepoInput;
  fetchRepoSnapshot: typeof fetchRepoSnapshot;
  maskSecret: typeof maskSecret;
  testProviderKey: typeof testProviderKey;
  toKeyView: typeof toKeyView;
  buildSnapshot: typeof buildSnapshot;
  generateShareToken: typeof generateShareToken;
  rowToShareView: typeof rowToShareView;
  trace: typeof trace;
  chromeProfileStats: typeof chromeProfileStats;
  clearChromeProfiles: typeof clearChromeProfiles;
  ensureBrowser: typeof ensureBrowser;
  killPilotBrowser: typeof killPilotBrowser;
  launchWatchdog: typeof launchWatchdog;
  readPilotInfo: typeof readPilotInfo;
  touchActivity: typeof touchActivity;
  findTab: typeof findTab;
  listTargets: typeof listTargets;
  newTab: typeof newTab;
  webchatStatus: typeof webchatStatus;
  readWebchatConfig: typeof readWebchatConfig;
  // Instances du service (posées par bindHandlerContext)
  store: Store;
  io: Server;
  connector: HermesConnector;
  // Moteur de tour (turn-runner.ts)
  runAssistantTurn: (
    conversationId: string,
    opts: {
      content: string;
      attachments?: Attachment[];
      modelId?: string | null;
      settings?: TurnSettings;
      webSearch?: boolean;
      variant?: "a" | "b";
      versionGroup?: string;
      versionRestore?: { group: string; id: string } | null;
    },
  ) => Promise<void>;
  isRunning: (conversationId: string) => boolean;
  abortRunning: (conversationId: string) => void;
  liveTurnsOf: (conversationId: string) => unknown[];
  validCompareIds: (raw: unknown) => [string, string] | null;
  titleFrom: (text: string, attachments?: Attachment[]) => string;
  conversationModeState: (conversationId: string) => {
    mode: ReturnType<typeof resolveMode>;
    rounds: number | null;
    config: ModeConfig | null;
  };
  comparePairFromMode: (modeState: { config: ModeConfig | null }) => [string, string];
  // Compaction
  compactKey: (conversationId: string) => string;
  readCompact: (conversationId: string) => unknown;
  compactInfoWire: (conversationId: string) => unknown;
  invalidateCompactIfNeeded: (conversationId: string, removedIds: string[]) => void;
  // Artefacts
  wireArtifact: (conversationId: string, key: string, row: ArtifactRow) => unknown;
  broadcastArtifact: (conversationId: string, row: ArtifactRow) => void;
  attachArtifactCards: (conversationId: string, messages: import("../types").ChatMessage[], fullHistory?: boolean) => void;
  renderHtmlArtifact: (row: ArtifactRow) => Promise<void>;
  deleteArtifactFiles: (rows: ArtifactRow[]) => void;
  enforceVersionQuota: (conversationId: string, keys: Iterable<string>) => void;
  // Vues wire + broadcasts
  helloPayload: () => Record<string, unknown>;
  providersWire: () => unknown[];
  extensionsWire: () => unknown[];
  providerWire: (row: import("../store").ProviderRow, keys: import("../store").KeyRow[]) => unknown;
  extensionWire: (row: import("../store").ExtensionRow) => unknown;
  broadcastProviders: () => void;
  broadcastExtensions: () => void;
  conversationPromptWire: (conversationId: string) => unknown;
  broadcastSystemPrompt: (conversationId: string) => void;
  broadcastSystemPrompts: () => void;
  // Journal de mise à jour (relais du lanceur)
  majFlag: string;
  majLog: string;
  majLogRead: () => { exists: boolean; text: string; mtimeMs: number };
  majLogSig: string;
  // Réglages du tour (assainis par les handlers puis passés au runner)
  TurnSettings: TurnSettings;
}

/** Contexte vivant : posé par index.ts après l'initialisation du service.
 *  Les champs mutables (majLogSig) sont des accesseurs définis par bind. */
export const ctx: HandlerContext = {} as HandlerContext;

// Constantes pures et fonctions pures : disponibles dès le chargement,
// sans attendre le câblage (les handlers ne s'exécutent qu'après, de toute
// façon — les socket.on ne sont posés que sur connexion client).
Object.assign(ctx, {
  FICHES,
  CUSTOM_INSTRUCTIONS_KEY,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_MEMORY_CHARS,
  MAX_PROMPT_CHARS,
  MEMORY_AUTO_KEY,
  MEMORY_ENABLED_KEY,
  MEMORY_NOTES_KEY,
  MAX_ATTACHMENTS_PER_MESSAGE,
  GATEWAY_URL_KEY: "hermes.gateway.url",
  GATEWAY_TOKEN_KEY: "hermes.gateway.token",
  resolveMode,
  normalizeModeConfig,
  rowToPreset,
  sanitizeExpertSettings,
  validatePromptText,
  saveAttachment,
  deleteAttachmentFiles,
  transcribeAudioBase64,
  catalogModelsResult,
  modelLabel,
  webchatModelOptions,
  webchatModelLabel,
  knownProviderCatalog,
  resolveKnownProvider,
  parseRepoInput,
  fetchRepoSnapshot,
  maskSecret,
  testProviderKey,
  toKeyView,
  buildSnapshot,
  generateShareToken,
  rowToShareView,
  trace,
  chromeProfileStats,
  clearChromeProfiles,
  ensureBrowser,
  killPilotBrowser,
  launchWatchdog,
  readPilotInfo,
  touchActivity,
  findTab,
  listTargets,
  newTab,
  webchatStatus,
  readWebchatConfig,
});

/** Câble les dépendances construites par index.ts (appelé une fois). */
export function bindHandlerContext(deps: {
  store: Store;
  io: Server;
  connector: HermesConnector;
  majFlag: string;
  majLog: string;
  majLogRead: () => { exists: boolean; text: string; mtimeMs: number };
  majLogSig: () => string;
  setMajLogSig: (v: string) => void;
  turnRunner: {
    runAssistantTurn: (
    conversationId: string,
    opts: {
      content: string;
      attachments?: Attachment[];
      modelId?: string | null;
      settings?: TurnSettings;
      webSearch?: boolean;
      variant?: "a" | "b";
      versionGroup?: string;
      versionRestore?: { group: string; id: string } | null;
    },
  ) => Promise<void>;
    isRunning: (conversationId: string) => boolean;
    abortRunning: (conversationId: string) => void;
    liveTurnsOf: (conversationId: string) => unknown[];
    validCompareIds: (raw: unknown) => [string, string] | null;
    titleFrom: (text: string, attachments?: Attachment[]) => string;
    conversationModeState: (conversationId: string) => {
      mode: ReturnType<typeof resolveMode>;
      rounds: number | null;
      config: ModeConfig | null;
    };
    comparePairFromMode: (modeState: { config: ModeConfig | null }) => [string, string];
    compactKey: (conversationId: string) => string;
    readCompact: (conversationId: string) => unknown;
    compactInfoWire: (conversationId: string) => unknown;
    invalidateCompactIfNeeded: (conversationId: string, removedIds: string[]) => void;
  };
  artifacts: {
    wireArtifact: (conversationId: string, key: string, row: ArtifactRow) => unknown;
    broadcastArtifact: (conversationId: string, row: ArtifactRow) => void;
    attachArtifactCards: (conversationId: string, messages: import("../types").ChatMessage[], fullHistory?: boolean) => void;
    renderHtmlArtifact: (row: ArtifactRow) => Promise<void>;
    deleteArtifactFiles: (rows: ArtifactRow[]) => void;
    enforceVersionQuota: (conversationId: string, keys: Iterable<string>) => void;
  };
  views: {
    helloPayload: () => Record<string, unknown>;
    providersWire: () => unknown[];
    extensionsWire: () => unknown[];
    providerWire: (row: import("../store").ProviderRow, keys: import("../store").KeyRow[]) => unknown;
    extensionWire: (row: import("../store").ExtensionRow) => unknown;
    broadcastProviders: () => void;
    broadcastExtensions: () => void;
    conversationPromptWire: (conversationId: string) => unknown;
    broadcastSystemPrompt: (conversationId: string) => void;
    broadcastSystemPrompts: () => void;
  };
}): void {
  Object.assign(ctx, {
    store: deps.store,
    io: deps.io,
    connector: deps.connector,
    majFlag: deps.majFlag,
    majLog: deps.majLog,
    majLogRead: deps.majLogRead,
  });
  // majLogSig est mutable : le contexte expose un accesseur vivant
  Object.defineProperty(ctx, "majLogSig", {
    get: () => deps.majLogSig(),
    set: (v: string) => deps.setMajLogSig(v),
    configurable: true,
  });
  Object.assign(ctx, deps.turnRunner);
  Object.assign(ctx, deps.artifacts);
  Object.assign(ctx, deps.views);
}
