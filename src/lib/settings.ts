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
      "Réglage du tour entre 0 (déterministe) et 1 (créatif) — le moteur démo " +
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
