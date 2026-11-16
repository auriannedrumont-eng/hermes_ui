// Registre des réglages — source de vérité unique (cf. FORK.md §6).
// Deux espaces de noms : « hermes » (agent amont) et « fork » (cette interface).
// Portée client  : localStorage préfixé « hermes-ui: ».
// Portée serveur : table SQLite `settings` du mini-service (settings:get/set).
//
// Règle d'or : toute fonctionnalité déclare ses réglages ICI dès sa création ;
// jamais de localStorage ad hoc dispersé dans les composants. La future page de
// paramètres se contentera de rendre ces deux registres en deux sections.

export type SettingScope = "client" | "server";

// ── Application immédiate (page de paramètres, FORK.md §7.4) ────────────
// `writeClientSetting()` émet cet événement sur `window` après chaque écriture
// réussie ; les consommateurs (page, sidebar, composer, hook de chat)
// s'y abonnent pour s'appliquer sans rechargement.
export const SETTINGS_CHANGED_EVENT = "hermes-ui:settings-changed";

export interface SettingsChangedDetail {
  key: string;
  value: unknown;
}

/** Écoute les changements de réglages client (retour : fonction de nettoyage). */
export function onSettingsChanged(
  cb: (detail: SettingsChangedDetail) => void
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<SettingsChangedDetail>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, handler);
}

export interface SettingDef {
  /** Clé complète "<namespace>.<clef>" — le préfixe définit l'appartenance. */
  key: string;
  type: "string" | "number" | "boolean" | "enum";
  default: unknown;
  /** Libellé FR (future page de paramètres). */
  label: string;
  description?: string;
  scope: SettingScope;
  /** Regroupement dans la future page (« Projets », « Interface »…). */
  category: string;
  /** Valeurs admises pour type "enum". */
  options?: string[];
  requiresRestart?: boolean;
  /** Anciennes clés localStorage migrées automatiquement vers key. */
  legacyKeys?: string[];
}

// ── Réglages de l'agent Hermes (amont) ─────────────────────────────────
export const HERMES_SETTINGS: SettingDef[] = [
  {
    key: "hermes.model",
    type: "string",
    default: null,
    label: "Modèle du chat",
    description: "Modèle utilisé pour les nouveaux tours de chat.",
    scope: "client",
    category: "Agent Hermes",
    legacyKeys: ["hermes.selectedModel"],
  },
  {
    key: "hermes.models.favorites",
    type: "string",
    default: "[]",
    label: "Modèles favoris",
    description: "Ids des modèles épinglés en tête du sélecteur (JSON).",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.reasoning.effort",
    type: "string",
    default: "medium",
    label: "Effort de raisonnement",
    description:
      "Valeur brute de l'échelle du fournisseur (ignorée sans dommage si non supportée).",
    scope: "client",
    category: "Agent Hermes",
  },
  // ── Mode expert (F-22) — température, plafond de sortie, graine ────
  {
    key: "hermes.expert.temperature",
    type: "number",
    default: null,
    label: "Température",
    description:
      "Réglage du tour entre 0 (déterministe) et 1 (créatif) — le fournisseur " +
      "rejette au-delà. Absente = valeur par défaut du fournisseur.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.expert.maxTokens",
    type: "number",
    default: null,
    label: "Plafond de jetons de réponse",
    description:
      "Coupe la réponse au-delà du plafond (1 à 8192 jetons). Absent = pas de plafond.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.expert.seed",
    type: "number",
    default: null,
    label: "Graine",
    description:
      "Reproductibilité des tirages (entier 32 bits). Absente = tirage libre.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.permissions.mode",
    type: "enum",
    options: ["ask", "auto"],
    default: "ask",
    label: "Permissions d'actions",
    description:
      "Demander : chaque commande sensible demande confirmation. " +
      "Auto : approbation automatique — remis sur « Demander » à chaque session.",
    scope: "client",
    category: "Agent Hermes",
  },
  // ── Conversations longues (v2.4) : résumé automatique avant le tour ──
  {
    key: "hermes.compaction.auto",
    type: "boolean",
    default: false,
    label: "Résumé automatique",
    description:
      "Quand la conversation approche de la limite de la fenêtre, Hermes la " +
      "résume et poursuit — rien n'est coupé.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.compaction.threshold",
    type: "number",
    default: 80,
    label: "Seuil du résumé",
    description:
      "Déclenche le résumé à ce niveau de remplissage de la fenêtre (50 à 95 %). " +
      "Plus haut : des conversations plus longues avant le résumé, au prix d'un " +
      "coût par message plus élevé.",
    scope: "client",
    category: "Agent Hermes",
  },
  // ── Clés internes du hook — au registre pour être réellement persistées ──
  // Correctif v2.4 : hermes.tools.web (F-09) et hermes.compare.models (F-17)
  // étaient écrits via writeClientSetting, qui ignore silencieusement les clés
  // hors registre — la persistance documentée ne fonctionnait pas (réglages
  // perdus au rechargement). Aucune ligne d'interface ne les liste (pannes
  // du volet hardcoded, cf. InterfacePane).
  {
    key: "hermes.tools.web",
    type: "boolean",
    default: false,
    label: "Recherche web du tour",
    description:
      "Bascule « Web » du composer — les résultats Tavily/Exa sont injectés " +
      "dans le contexte du tour (interne, F-09/F-12).",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.compare.models",
    type: "string",
    default: "[]",
    label: "Paire de comparaison",
    description: "Paire [a, b] mémorisée du mode comparaison (interne, F-17).",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.profiles.applied",
    type: "string",
    default: null,
    label: "Profil appliqué",
    description: "Id du dernier profil appliqué en un clic (interne, v2.4).",
    scope: "client",
    category: "Agent Hermes",
  },
  // ── Modes du compositeur (F-30) — réglages PAR DÉFAUT, applicables aux
  // nouvelles conversations ; chaque conversation garde son propre mode et
  // ses modèles (conversations.mode côté service). La consigne éditable des
  // modes vit CÔTÉ SERVICE (clé hermes.modes.prompts de la table settings —
  // lisons par settings:get/set dans la section « Modes de chat »).
  {
    key: "hermes.modes.defaultMode",
    type: "enum",
    options: ["chat", "plan", "code", "compare", "debate", "council", "auto"],
    default: "chat",
    label: "Mode des nouvelles conversations",
    description:
      "Le mode de démarrage d'une nouvelle conversation — Chat pour parler simplement.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.modes.debateRounds",
    type: "number",
    default: 3,
    label: "Tours du débat",
    description: "3 à 10 — le compteur s'arrête ici comme dans le menu du sélecteur.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.modes.councilMembers",
    type: "number",
    default: 3,
    label: "Membres du conseil",
    description: "2 à 5 — anonymisés A, B, C… dans la conversation.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.modes.autoRetries",
    type: "number",
    default: 2,
    label: "Reprises de l'auto",
    description: "0 à 3 — en cas d'échec, on corrige la vraie cause, jamais une rustine.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.modes.autoDebate",
    type: "boolean",
    default: true,
    label: "Débat préalable de l'auto",
    description: "Cadrage avant d'agir — désactivable pour les tâches évidentes.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.modes.showFlow",
    type: "boolean",
    default: true,
    label: "Déroulé dans la conversation",
    description:
      "Tours du débat, membres du conseil, étapes de l'auto s'affichent dans la conversation, au-dessus de la réponse.",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.modes.showModels",
    type: "boolean",
    default: true,
    label: "Modèles dans le déroulé",
    description:
      "Chaque voix affiche son modèle ; désactivé, les modèles ne restent visibles que dans « qui travaille ».",
    scope: "client",
    category: "Agent Hermes",
  },
  {
    key: "hermes.modes.voices",
    type: "string",
    default: "{}",
    label: "Modèles par défaut des voix",
    description:
      "Un modèle par voix (conseillers, membres, étapes, colonnes A/B) — JSON ; interne, édité dans la section Modes de chat.",
    scope: "client",
    category: "Agent Hermes",
  },
];

// ── Réglages propres au fork ───────────────────────────────────────────
export const FORK_SETTINGS: SettingDef[] = [
  {
    key: "fork.ui.sidebar.width",
    type: "number",
    default: 19,
    label: "Largeur de la sidebar",
    description: "Pourcentage de la largeur d'écran (12 à 34).",
    scope: "client",
    category: "Interface",
    legacyKeys: ["hermes.sidebarSize"],
  },
  {
    key: "fork.projects.sort",
    type: "enum",
    options: ["updated", "created", "title"],
    default: "updated",
    label: "Tri des projets",
    description: "Ordre des conversations à l'intérieur d'un projet.",
    scope: "client",
    category: "Projets",
  },
  {
    key: "fork.projects.collapsed",
    type: "string",
    default: "[]",
    label: "Dossiers de projet repliés",
    description:
      "Replie tous les dossiers de projet dans la sidebar (réglage par dossier " +
      "conservé en mémoire).",
    scope: "client",
    category: "Projets",
  },
  {
    key: "fork.context.gauge",
    type: "boolean",
    default: true,
    label: "Jauge de contexte",
    description: "L'anneau dans le composer — usage de la fenêtre (k et %).",
    scope: "client",
    category: "Interface",
  },
  {
    key: "fork.ui.showReasoning",
    type: "boolean",
    default: true,
    label: "Afficher le raisonnement",
    description:
      "Montre le cheminement du modèle au-dessus de chaque réponse " +
      "(les tours déjà affichés suivent le réglage).",
    scope: "client",
    category: "Interface",
  },
];

const PREFIX = "hermes-ui:";
const REGISTRY = new Map<string, SettingDef>(
  [...HERMES_SETTINGS, ...FORK_SETTINGS].map((d) => [d.key, d])
);

export function getSettingDef(key: string): SettingDef | undefined {
  return REGISTRY.get(key);
}

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(def: SettingDef, raw: string): unknown {
  switch (def.type) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : def.default;
    }
    case "boolean":
      return raw === "true";
    case "enum":
      return def.options?.includes(raw) ? raw : def.default;
    default:
      return raw;
  }
}

/** Lit un réglage client (valeur du registre si absent ou invalide). */
export function readClientSetting<T = unknown>(key: string): T {
  const def = REGISTRY.get(key);
  if (!def || def.scope !== "client") return undefined as T;
  const raw =
    readRaw(PREFIX + key) ??
    (def.legacyKeys ?? []).reduce<string | null>(
      (acc, k) => acc ?? readRaw(k),
      null
    );
  return (raw === null ? def.default : parse(def, raw)) as T;
}

/** Écrit un réglage client (silencieusement ignoré si hors registre ou invalide). */
export function writeClientSetting(key: string, value: unknown): void {
  const def = REGISTRY.get(key);
  if (!def || def.scope !== "client") return;
  let stored: string;
  switch (def.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      stored = String(n);
      break;
    }
    case "boolean":
      stored = value ? "true" : "false";
      break;
    case "enum": {
      const v = String(value);
      if (!def.options?.includes(v)) return;
      stored = v;
      break;
    }
    default:
      stored = String(value ?? "");
  }
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + key, stored);
    // Nettoyage des anciennes clés une fois migrées
    for (const k of def.legacyKeys ?? []) window.localStorage.removeItem(k);
  } catch {
    /* stockage indisponible */
    return;
  }
  // Application immédiate (page de paramètres, FORK.md §7.4).
  window.dispatchEvent(
    new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, {
      detail: { key, value: parse(def, stored) },
    })
  );
}

/** Efface un réglage client : la clé redevient absente (retour au défaut
 *  du registre à la relecture). Sans ceci, « vider » un champ numérique
 *  persisterait 0 — Number(null) — au lieu de le retirer (bug F-22). */
export function deleteClientSetting(key: string): void {
  const def = REGISTRY.get(key);
  if (!def || def.scope !== "client") return;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREFIX + key);
    // Nettoyage des anciennes clés une fois migrées
    for (const k of def.legacyKeys ?? []) window.localStorage.removeItem(k);
  } catch {
    /* stockage indisponible */
    return;
  }
  // Même bus d'application immédiate, avec null = valeur par défaut.
  window.dispatchEvent(
    new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, {
      detail: { key, value: null },
    })
  );
}
