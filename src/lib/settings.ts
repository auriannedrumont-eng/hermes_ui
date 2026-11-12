// Registre des réglages — source de vérité unique (cf. FORK.md §6).
// Deux espaces de noms : « hermes » (agent amont) et « fork » (cette interface).
// Portée client  : localStorage préfixé « hermes-ui: ».
// Portée serveur : table SQLite `settings` du mini-service (settings:get/set).
//
// Règle d'or : toute fonctionnalité déclare ses réglages ICI dès sa création ;
// jamais de localStorage ad hoc dispersé dans les composants. La future page de
// paramètres se contentera de rendre ces deux registres en deux sections.

export type SettingScope = "client" | "server";

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
    label: "Modèle par défaut",
    description: "Modèle sélectionné pour les nouveaux tours de chat.",
    scope: "client",
    category: "Agent Hermes",
    legacyKeys: ["hermes.selectedModel"],
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
    label: "Tri des conversations",
    description: "Ordre des conversations à l'intérieur d'un projet.",
    scope: "client",
    category: "Projets",
  },
  {
    key: "fork.projects.collapsed",
    type: "string",
    default: "[]",
    label: "Projets repliés",
    description: "Identifiants des projets repliés dans la sidebar (JSON).",
    scope: "client",
    category: "Projets",
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
  }
}
