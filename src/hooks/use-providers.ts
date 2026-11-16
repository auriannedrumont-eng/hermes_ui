// Fournisseurs & clés + Extensions — état et actions du chantier
// « Paramètres v2.2 » (FORK.md §7.4). Consomme le même singleton socket
// que le hook de chat ; les secrets ne circulent que du client vers le
// service (une fois, à l'ajout) — jamais dans l'autre sens.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import type {
  ExtensionCommit,
  ExtensionView,
  KeyStatus,
  ProviderCatalogEntry,
  ProviderKeyView,
  ProviderKind,
  ProviderStrategy,
  ProviderView,
} from "@/lib/chat-types";

interface EmitResult<T> {
  ok?: boolean;
  error?: string;
  skipped?: boolean;
  changed?: boolean;
  detail?: string | null;
  extension?: T;
  commits?: ExtensionCommit[];
}

/** Résultat de l'ajout unifié (registry:install) — le service décide ce
 *  que l'entrée devient : dépôt, serveur MCP ou fournisseur. */
export interface InstallResult {
  what?: "repo" | "mcp" | "provider";
  extension?: ExtensionView;
  provider?: ProviderView;
  commits?: ExtensionCommit[];
  error?: string;
}

export function useProviders() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [extensions, setExtensions] = useState<ExtensionView[]>([]);
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    const refresh = () => {
      socket.emit("providers:list", (res: { providers?: ProviderView[] } = {}) => {
        if (Array.isArray(res.providers)) setProviders(res.providers);
      });
      socket.emit("providers:catalog", (res: { catalog?: ProviderCatalogEntry[] } = {}) => {
        if (Array.isArray(res.catalog)) setCatalog(res.catalog);
      });
      socket.emit("extensions:list", (res: { extensions?: ExtensionView[] } = {}) => {
        if (Array.isArray(res.extensions)) setExtensions(res.extensions);
      });
    };
    if (socket.connected) refresh();
    socket.on("connect", refresh);
    const onProviders = (res: { providers?: ProviderView[] } = {}) => {
      if (Array.isArray(res.providers)) setProviders(res.providers);
    };
    const onExtensions = (res: { extensions?: ExtensionView[] } = {}) => {
      if (Array.isArray(res.extensions)) setExtensions(res.extensions);
    };
    socket.on("providers:changed", onProviders);
    socket.on("extensions:changed", onExtensions);
    return () => {
      socket.off("connect", refresh);
      socket.off("providers:changed", onProviders);
      socket.off("extensions:changed", onExtensions);
    };
  }, []);

  /** Émet un événement et renvoie la réponse du service (toujours résolue). */
  const emit = useCallback(
    <T,>(event: string, payload: unknown): Promise<T> =>
      new Promise<T>((resolve) => {
        const socket = socketRef.current ?? getSocket();
        socketRef.current = socket;
        socket.emit(event, payload, (res: T) => resolve(res));
      }),
    []
  );

  const refresh = useCallback(() => {
    const socket = socketRef.current ?? getSocket();
    socket.emit("providers:list", (res: { providers?: ProviderView[] } = {}) => {
      if (Array.isArray(res.providers)) setProviders(res.providers);
    });
    socket.emit("providers:catalog", (res: { catalog?: ProviderCatalogEntry[] } = {}) => {
      if (Array.isArray(res.catalog)) setCatalog(res.catalog);
    });
    socket.emit("extensions:list", (res: { extensions?: ExtensionView[] } = {}) => {
      if (Array.isArray(res.extensions)) setExtensions(res.extensions);
    });
  }, []);

  // ── Fournisseurs & clés ───────────────────────────────────────────

  /** Ajoute un fournisseur — `name` vient du sélecteur (valeur canonique
   *  du catalogue) ou une adresse https ; `baseUrl` n'est envoyé que si
   *  le champ « endpoint » a été rempli/modifié. */
  const addProvider = useCallback(
    (name: string, kind: ProviderKind, baseUrl?: string) =>
      emit<{ provider?: ProviderView; error?: string }>("providers:add", {
        name,
        kind,
        ...(baseUrl ? { baseUrl } : {}),
      }),
    [emit]
  );

  const removeProvider = useCallback(
    (id: string) => emit<{ ok?: boolean; error?: string }>("providers:remove", { id }),
    [emit]
  );

  const setStrategy = useCallback(
    (id: string, strategy: ProviderStrategy) =>
      emit<{ provider?: ProviderView; error?: string }>("providers:set-strategy", {
        id,
        strategy,
      }),
    [emit]
  );

  /** Adresse (endpoint) éditable, v2.5 — chaîne vide = retour au canon. */
  const setProviderBase = useCallback(
    (id: string, baseUrl: string) =>
      emit<{ provider?: ProviderView; error?: string }>("providers:set-base", {
        id,
        baseUrl,
      }),
    [emit]
  );

  const addKey = useCallback(
    (providerId: string, label: string, secret: string) =>
      emit<{ key?: ProviderKeyView; error?: string }>("providers:add-key", {
        providerId,
        label,
        secret,
      }),
    [emit]
  );

  const removeKey = useCallback(
    (keyId: string) => emit<{ ok?: boolean; error?: string }>("providers:remove-key", { keyId }),
    [emit]
  );

  const testKey = useCallback(
    (keyId: string) =>
      emit<{
        ok?: boolean;
        key?: ProviderKeyView | null;
        provider?: ProviderView | null;
        error?: string;
      }>("providers:test-key", { keyId }),
    [emit]
  );

  // ── Extensions ────────────────────────────────────────────────────

  const addExtension = useCallback(
    (kind: "repo" | "mcp", source: string, channel?: string | null) =>
      emit<EmitResult<ExtensionView>>("extensions:add", { kind, source, channel }),
    [emit]
  );

  /** Ajout unifié (v2.6) : un nom (« tavily ») ou une adresse (dépôt
   *  GitHub, serveur https, commande de lancement) — le service résout et
   *  installe seul ; la clé API s'ajoute ensuite sur la fiche. */
  const installAnything = useCallback(
    (source: string) => emit<InstallResult>("registry:install", { source }),
    [emit]
  );

  const toggleExtension = useCallback(
    (id: string, enabled: boolean) =>
      emit<{ extension?: ExtensionView; error?: string }>("extensions:toggle", { id, enabled }),
    [emit]
  );

  const removeExtension = useCallback(
    (id: string) => emit<{ ok?: boolean; error?: string }>("extensions:remove", { id }),
    [emit]
  );

  const pinExtension = useCallback(
    (id: string, pinned: boolean) =>
      emit<{ extension?: ExtensionView; error?: string }>("extensions:pin", { id, pinned }),
    [emit]
  );

  const checkExtension = useCallback(
    (id: string) => emit<EmitResult<ExtensionView>>("extensions:check", { id }),
    [emit]
  );

  const updateExtension = useCallback(
    (id: string) => emit<EmitResult<ExtensionView>>("extensions:update", { id }),
    [emit]
  );

  /** Modifications non encore appliquées (footer du volet, v4). */
  const pendingEngineCount = useMemo(
    () => extensions.filter((e) => e.enabled !== e.applied).length,
    [extensions]
  );

  return {
    providers,
    catalog,
    extensions,
    pendingEngineCount,
    refresh,
    addProvider,
    removeProvider,
    setStrategy,
    setProviderBase,
    addKey,
    removeKey,
    testKey,
    addExtension,
    installAnything,
    toggleExtension,
    removeExtension,
    pinExtension,
    checkExtension,
    updateExtension,
  };
}

export type ProvidersApi = ReturnType<typeof useProviders>;

/** Statut dérivé d'une carte fournisseur (pastille v4). */
export function providerCardStatus(p: ProviderView): {
  tone: "ok" | "warn" | "err" | "off";
  label?: string;
} {
  if (p.keyless) return { tone: "off" };
  if (p.keys.length === 0) return { tone: "off" };
  if (p.keys.some((k) => k.status === "exhausted")) return { tone: "err", label: "à réparer" };
  if (p.keys.every((k) => k.status === "ok")) return { tone: "ok" };
  if (p.keys.some((k) => k.status === "ok")) return { tone: "ok" };
  if (p.keys.some((k) => k.status === "error")) return { tone: "err", label: "à réparer" };
  return { tone: "warn", label: "à tester" };
}

/** Libellé FR du statut d'une clé. */
export function keyStatusLabel(status: KeyStatus, statusLabel?: string | null): string | null {
  if (status === "untested") return "à tester";
  return statusLabel ?? null;
}
