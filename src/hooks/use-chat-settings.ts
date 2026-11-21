// Hook réglages du compositeur — extrait de use-hermes-chat.ts (découpage
// 2026-11, FORK.md §10) : modèles, effort, mode expert (F-22), autorisations,
// recherche web (F-09/F-12) et le bus hermes-ui:settings-changed. L'état et
// les refs vivent ici ; l'orchestrateur re-expose les mêmes identifiants.
// Les MODELS sont chargés par l'orchestrateur (fetchModels suit onConnect) :
// ce hook fournit l'état et les setters.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteClientSetting,
  onSettingsChanged,
  readClientSetting,
  writeClientSetting,
} from "@/lib/settings";
import type {
  ExpertSettings,
  ModelOption,
  ModelsResult,
  PermissionsMode,
} from "@/lib/chat-types";

const MODEL_SETTING_KEY = "hermes.model"; // registre des réglages (FORK.md §6)
const EFFORT_SETTING_KEY = "hermes.reasoning.effort";
const PERMISSIONS_SETTING_KEY = "hermes.permissions.mode";
// Mode expert (F-22) — registre des réglages (FORK.md §6)
const EXPERT_TEMPERATURE_KEY = "hermes.expert.temperature";
const EXPERT_MAX_TOKENS_KEY = "hermes.expert.maxTokens";
const EXPERT_SEED_KEY = "hermes.expert.seed";

export function useChatSettings() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsSource, setModelsSource] = useState<ModelsResult["source"] | null>(null);
  const [selectedModel, setSelectedModelState] = useState<string | null>(() =>
    readClientSetting<string | null>(MODEL_SETTING_KEY)
  );
  /** Effort de raisonnement (valeur brute du fournisseur, persisté). */
  const [effort, setEffortState] = useState<string | null>(() =>
    readClientSetting<string>(EFFORT_SETTING_KEY)
  );
  // ── Mode expert (F-22) : température, plafond de sortie, graine ─────
  /** Réglages expert persistés (champs absents = valeur par défaut). */
  const [expert, setExpertState] = useState<ExpertSettings>(() => {
    // Mode expert (F-22) : champs individuels, absents = défaut du fournisseur
    const savedTemperature = readClientSetting<number | null>(EXPERT_TEMPERATURE_KEY);
    const savedMaxTokens = readClientSetting<number | null>(EXPERT_MAX_TOKENS_KEY);
    const savedSeed = readClientSetting<number | null>(EXPERT_SEED_KEY);
    return {
      ...(savedTemperature !== null ? { temperature: savedTemperature } : {}),
      ...(savedMaxTokens !== null ? { maxTokens: savedMaxTokens } : {}),
      ...(savedSeed !== null ? { seed: savedSeed } : {}),
    };
  });
  /** Autorisations : reset sur « ask » à chaque session — jamais restauré. */
  const [permissionsMode, setPermissionsMode] = useState<PermissionsMode>("ask");
  /** F-09/F-12 — recherche web du tour (Tavily/Exa), persistée (hermes.tools.web). */
  const [webSearch, setWebSearchState] = useState<boolean>(
    () => readClientSetting<boolean>("hermes.tools.web") === true
  );
  const webSearchRef = useRef(webSearch);
  const selectedModelRef = useRef<string | null>(null);
  const effortRef = useRef<string | null>(null);
  const expertRef = useRef<ExpertSettings>({});
  const permissionsRef = useRef<PermissionsMode>("ask");

  // Synchronise les refs (lecture seule côté handlers d'événements)
  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    effortRef.current = effort;
  }, [effort]);

  useEffect(() => {
    expertRef.current = expert;
  }, [expert]);

  useEffect(() => {
    permissionsRef.current = permissionsMode;
  }, [permissionsMode]);

  useEffect(() => {
    webSearchRef.current = webSearch;
  }, [webSearch]);

  // Sélection persistée (registre des réglages, cf. FORK.md §6) : relue
  // paresseusement à l'initialisation (pas d'effet de relecture — les valeurs
  // du registre ne changent pas entre le montage et le premier rendu).
  // Les setters restent exposés : les effets ci-dessous (bus Paramètres)
  // et l'échelle d'effort écrivent par-dessus à la demande.

  // Autorisations : reset explicite sur « ask » à chaque session (spec) —
  // la persistance viendra plus tard de la page de paramètres.
  useEffect(() => {
    writeClientSetting(PERMISSIONS_SETTING_KEY, "ask");
  }, []);

  // ── Application immédiate : réglages modifiés depuis le sheet Paramètres ─
  // (modèle, effort, permissions — le bus hermes-ui:settings-changed, FORK.md §7.4)
  useEffect(() => {
    return onSettingsChanged(({ key, value }) => {
      if (key === MODEL_SETTING_KEY && typeof value === "string") {
        setSelectedModelState(value);
      } else if (key === EFFORT_SETTING_KEY && typeof value === "string") {
        setEffortState(value);
      } else if (key === PERMISSIONS_SETTING_KEY) {
        setPermissionsMode(value === "auto" ? "auto" : "ask");
      } else if (
        key === EXPERT_TEMPERATURE_KEY ||
        key === EXPERT_MAX_TOKENS_KEY ||
        key === EXPERT_SEED_KEY
      ) {
        // Mode expert (F-22) : chaque champ vit sa clé (null = retiré)
        setExpertState((prev) => {
          const next = { ...prev };
          if (key === EXPERT_TEMPERATURE_KEY)
            next.temperature = typeof value === "number" ? value : undefined;
          if (key === EXPERT_MAX_TOKENS_KEY)
            next.maxTokens = typeof value === "number" ? value : undefined;
          if (key === EXPERT_SEED_KEY)
            next.seed = typeof value === "number" ? value : undefined;
          return next;
        });
      } else if (key === "hermes.tools.web") {
        // v2.4 : appliqué par un profil — la bascule du composer suit en direct.
        setWebSearchState(value === true);
      }
    });
  }, []);

  const setSelectedModel = useCallback((id: string) => {
    setSelectedModelState(id);
    writeClientSetting(MODEL_SETTING_KEY, id);
  }, []);

  /** Effort de raisonnement : valeur brute du fournisseur, persistée. */
  const setEffort = useCallback((e: string) => {
    setEffortState(e);
    writeClientSetting(EFFORT_SETTING_KEY, e);
  }, []);

  /** Mode expert (F-22) : fusionne et persiste champ par champ (undefined
   *  = retiré : la clé localStorage est EFFACÉE — pas écrite à null, sinon
   *  Number(null) persisterait 0 et la valeur « reviendrait » au rechargement). */
  const setExpert = useCallback((patch: Partial<ExpertSettings>) => {
    setExpertState((prev) => {
      const next = { ...prev, ...patch };
      // Champ présent → écrit ; champ retiré → suppression de la clé
      // (retour au défaut du fournisseur à la relecture).
      const persist = (key: string, v: number | undefined) => {
        if (v === undefined) deleteClientSetting(key);
        else writeClientSetting(key, v);
      };
      persist(EXPERT_TEMPERATURE_KEY, next.temperature);
      persist(EXPERT_MAX_TOKENS_KEY, next.maxTokens);
      persist(EXPERT_SEED_KEY, next.seed);
      return next;
    });
  }, []);

  /** Autorisations : armement explicite — jamais silencieux. */
  const changePermissions = useCallback((mode: PermissionsMode) => {
    setPermissionsMode(mode);
    writeClientSetting(PERMISSIONS_SETTING_KEY, mode);
  }, []);

  // L'échelle d'effort est portée par le modèle : quand le modèle change et
  // que l'effort courant n'existe pas dans la nouvelle échelle, on retombe
  // sur le cran équivalent le plus proche (standard > medium > milieu).
  // Synchronisation au rendu (pas d'effet) : le cran résolu EST l'état dérivé.
  const effortForScale = useMemo(() => {
    if (!models.length || !selectedModel) return effort;
    const model = models.find((m) => m.id === selectedModel);
    if (!model) return effort;
    const scale = model.efforts?.length ? model.efforts : ["off", "low", "medium", "high", "max"];
    if (effort && scale.includes(effort)) return effort;
    return (
      scale.find((e) => e === "standard") ??
      scale.find((e) => e === "medium") ??
      scale[Math.floor((scale.length - 1) / 2)] ??
      effort
    );
  }, [models, selectedModel, effort]);
  // (audit 2026-11-21) La ref qui part dans chat:send / chat:regenerate /
  // message:edit suit TOUJOURS le cran résolu AFFICHÉ — jamais le brut
  // obsolète (l'UI montrait « medium », le tour partait avec « minimal »).
  useEffect(() => {
    effortRef.current = effortForScale;
  }, [effortForScale]);
  // Le cran résolu devient aussi l'état : motif React officiel « adjust
  // state on prop change » (re-render immédiat pendant le rendu, pas
  // d'effet — la ref, elle, est synchronisée par l'effet ci-dessus).
  const [effortResolvedFor, setEffortResolvedFor] = useState<string | null>(null);
  const effortSignature = `${selectedModel ?? ""}|${effort ?? ""}`;
  if (effortResolvedFor !== effortSignature) {
    setEffortResolvedFor(effortSignature);
    if (effortForScale !== effort && effortForScale != null) {
      setEffortState(effortForScale);
      writeClientSetting(EFFORT_SETTING_KEY, effortForScale);
    }
  }

  /** F-09/F-12 — bascule la recherche web du tour (persistée hermes.tools.web). */
  const toggleWebSearch = useCallback(() => {
    setWebSearchState((v) => {
      const next = !v;
      writeClientSetting("hermes.tools.web", next);
      return next;
    });
  }, []);

  return {
    models,
    setModels,
    modelsSource,
    setModelsSource,
    selectedModel,
    selectedModelRef,
    setSelectedModelState,
    effort: effortForScale,
    effortRef,
    expert,
    expertRef,
    permissionsMode,
    permissionsRef,
    webSearch,
    webSearchRef,
    setSelectedModel,
    setEffort,
    setExpert,
    changePermissions,
    toggleWebSearch,
  };
}
