// Profils de réglages (v2.4) — lib pure partagée par le volet Paramètres.
// Un profil capture un lot de réglages client (modèle, effort, permissions,
// recherche web, mode expert) pour les réappliquer en un clic. Effet
// immédiat via le bus `hermes-ui:settings-changed` (FORK.md §7.4) : aucune
// dépendance moteur — c'est la même mécanique que le volet Interface.
// La LISTE vit côté service (table settings, clé hermes.profiles) pour
// suivre l'utilisatrice d'une session à l'autre ; les VALEURS capturées
// restent des réglages client du registre (§6).
import {
  readClientSetting,
  writeClientSetting,
  deleteClientSetting,
} from "@/lib/settings";

/** Clés capturées par un profil — toutes au registre client (§6). */
export const PROFILE_CAPTURE_KEYS = [
  "hermes.model",
  "hermes.reasoning.effort",
  "hermes.permissions.mode",
  "hermes.tools.web",
  "hermes.expert.temperature",
  "hermes.expert.maxTokens",
  "hermes.expert.seed",
] as const;

export type ProfileKey = (typeof PROFILE_CAPTURE_KEYS)[number];

export interface ChatProfile {
  id: string;
  name: string;
  createdAt: string;
  /** Valeurs capturées — absentes = « suivre le défaut du registre ». */
  values: Partial<Record<ProfileKey, unknown>>;
}

/** Clé de la table settings (serveur) où vit la liste. */
export const PROFILES_STORAGE_KEY = "hermes.profiles";

const KEY_LABELS: Record<ProfileKey, string> = {
  "hermes.model": "modèle",
  "hermes.reasoning.effort": "effort",
  "hermes.permissions.mode": "permissions",
  "hermes.tools.web": "web",
  "hermes.expert.temperature": "température",
  "hermes.expert.maxTokens": "plafond",
  "hermes.expert.seed": "graine",
};

/** Parse défensif (null si corrompu) — même discipline que parsePricing. */
export function parseProfiles(raw: string | null | undefined): ChatProfile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ChatProfile[] = [];
    for (const p of parsed) {
      if (
        p &&
        typeof p === "object" &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        p.values &&
        typeof p.values === "object"
      ) {
        // Ne garder que les clés connues (un réglage retiré du registre ne
        // doit jamais ressusciter par un vieux profil).
        const values: ChatProfile["values"] = {};
        for (const k of PROFILE_CAPTURE_KEYS) {
          if (k in (p.values as object)) values[k] = (p.values as Record<string, unknown>)[k];
        }
        out.push({
          id: p.id,
          name: p.name,
          createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
          values,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeProfiles(list: ChatProfile[]): string {
  return JSON.stringify(list);
}

/** Capture les réglages courants (une valeur null = clé absente = défaut). */
export function captureCurrentValues(): ChatProfile["values"] {
  const values: ChatProfile["values"] = {};
  for (const key of PROFILE_CAPTURE_KEYS) {
    const v = readClientSetting<unknown>(key);
    if (v !== undefined && v !== null) values[key] = v;
  }
  return values;
}

/** Applique un profil : chaque clé écrite (ou retirée → défaut du registre).
 *  Déclenche le bus → le hook et l'interface suivent en direct. */
export function applyProfile(profile: ChatProfile): void {
  for (const key of PROFILE_CAPTURE_KEYS) {
    if (key in profile.values) {
      const v = profile.values[key];
      if (v === null || v === undefined) deleteClientSetting(key);
      else writeClientSetting(key, v);
    } else {
      deleteClientSetting(key);
    }
  }
}

/** Résumé en langage clair sous le nom du profil (une ligne, sans jargon). */
export function profileSummary(p: ChatProfile): string {
  const parts: string[] = [];
  const model = p.values["hermes.model"];
  if (typeof model === "string" && model) parts.push(model);
  const effort = p.values["hermes.reasoning.effort"];
  if (typeof effort === "string" && effort) parts.push(`effort ${effort}`);
  const perms = p.values["hermes.permissions.mode"];
  parts.push(perms === "auto" ? "approbation auto" : "approbation à la demande");
  parts.push(p.values["hermes.tools.web"] ? "web activé" : "web coupé");
  const expert = PROFILE_CAPTURE_KEYS.filter(
    (k) => k.startsWith("hermes.expert.") && p.values[k] != null
  ).length;
  if (expert > 0) parts.push(`expert ×${expert}`);
  return parts.join(" · ") || "réglages par défaut";
}

/** Libellé court d'une clé (édition d'un profil dupliqué, diagnostique). */
export function profileKeyLabel(key: ProfileKey): string {
  return KEY_LABELS[key];
}
