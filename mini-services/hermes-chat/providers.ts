// Fournisseurs & clés + Extensions — logique du chantier « Paramètres v2.2 ».
// Le mini-service est le SEUL détenteur des secrets : il les stocke, les
// masque pour le client et exécute lui-même les appels de test (réels,
// réseau inclus) — cf. FORK.md §7.4, décisions v2/v4.
//
// Rien ici ne touche au moteur de tours : en moteur local les clés servent à
// préparer la configuration (test, ordre, relai) ; le branchement effectif
// des pools sur les tours suivra la gateway (v2.3+).
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCb);
import type {
  ExtensionCommit,
  KeyStatus,
  ProviderCatalogEntry,
  ProviderKind,
  ProviderStrategy,
  ProviderKeyView,
} from "./types";

// ── Catalogue des fournisseurs connus ─────────────────────────────────
// `match` s'applique au nom saisi par l'utilisatrice (ou à l'adresse) ;
// `test` décrit l'appel minimal réellement exécuté par « Tester ».

type AuthStyle = "bearer" | "x-api-key" | "key-prefix" | "none";

interface KnownProvider {
  match: RegExp;
  name: string;
  /** Libellé court du sélecteur d'ajout (v2.5) — défaut : name. */
  label?: string;
  tagline: string;
  kind: ProviderKind;
  keyless?: boolean;
  defaultBaseUrl?: string;
  /** Base du TEST quand elle diffère de la base d'appel (opencode : la
   *  liste des modèles vit sur /inference/v1, les tours sur /inference/openai/v1). */
  testBase?: string;
  test: {
    url: string;
    method: "GET" | "POST";
    auth: AuthStyle;
    body?: unknown;
    extraHeaders?: Record<string, string>;
  };
}

const KNOWN_PROVIDERS: KnownProvider[] = [
  // ── z.ai : DEUX portefeuilles étanches (v2.5) ────────────────────────
  // z.ai sépare l'argent en deux : l'API standard se paie au jeton (solde
  // rechargeable), le GLM Coding Plan est un abonnement avec SES PROPRES
  // clés. Une clé ne fonctionne que sur la surface où elle a été créée —
  // même format hexadécimal, portefeuilles différents (matrice croisée
  // 429/200 observée avec les clés réelles, 2026-11-15). Cette entrée
  // DOIT rester AVANT l'entrée « z.ai » générique : les deux regex
  // reconnaissent « z.ai », l'ordre du catalogue tranche.
  {
    match: /coding\s*plan|z\.ai\s*[-–—]?\s*coding/i,
    name: "z.ai Coding Plan",
    label: "z.ai — GLM Coding Plan (abonnement)",
    tagline: "clés créées dans la section « Coding Plan » du tableau de bord z.ai",
    kind: "llm",
    defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    test: {
      url: "https://api.z.ai/api/coding/paas/v4/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /z\.ai|zhipu|bigmodel|glm/i,
    name: "z.ai",
    label: "z.ai — API standard (paiement au jeton)",
    tagline: "modèles GLM — clés de la section « API Keys », solde rechargeable",
    kind: "llm",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    test: {
      url: "https://api.z.ai/api/paas/v4/models",
      method: "GET",
      auth: "bearer",
    },
  },
  // NB : AVANT l'entrée OpenAI — l'adresse d'opencode contient « openai »
  // (https://opencode.ai/inference/openai/v1) et doit être reconnue comme
  // opencode, pas comme OpenAI. Console opencode : des dizaines de modèles
  // (Claude, GPT, Gemini, GLM…) sous une même clé ; surface OpenAI-compatible
  // pour les tours, liste des modèles sur /inference/v1/models (vérifié).
  {
    match: /opencode/i,
    name: "opencode",
    label: "opencode — dizaines de modèles sous une seule clé",
    tagline: "des dizaines de modèles sous un seul compte (Console opencode)",
    kind: "llm",
    defaultBaseUrl: "https://opencode.ai/inference/openai/v1",
    testBase: "https://opencode.ai/inference/v1",
    test: {
      url: "https://opencode.ai/inference/v1/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /openrouter/i,
    name: "OpenRouter",
    label: "OpenRouter — des centaines de modèles",
    tagline: "des centaines de modèles sous un même compte",
    kind: "llm",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    // /models est public : on interroge /key, qui exige la clé.
    test: {
      url: "https://openrouter.ai/api/v1/key",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /anthropic|claude/i,
    name: "Anthropic",
    label: "Anthropic — modèles Claude",
    tagline: "modèles Claude",
    kind: "llm",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    test: {
      url: "https://api.anthropic.com/v1/models",
      method: "GET",
      auth: "x-api-key",
      extraHeaders: { "anthropic-version": "2023-06-01" },
    },
  },
  {
    match: /mistral/i,
    name: "Mistral",
    label: "Mistral — modèles Mistral",
    tagline: "modèles Mistral",
    kind: "llm",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    test: {
      url: "https://api.mistral.ai/v1/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /openai/i,
    name: "OpenAI",
    label: "OpenAI — modèles GPT",
    tagline: "modèles GPT",
    kind: "llm",
    defaultBaseUrl: "https://api.openai.com/v1",
    test: {
      url: "https://api.openai.com/v1/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /deepseek/i,
    name: "DeepSeek",
    label: "DeepSeek — modèles DeepSeek",
    tagline: "modèles DeepSeek",
    kind: "llm",
    defaultBaseUrl: "https://api.deepseek.com",
    test: {
      url: "https://api.deepseek.com/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /groq/i,
    name: "Groq",
    label: "Groq — réponses très rapides",
    tagline: "inférence très rapide",
    kind: "llm",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    test: {
      url: "https://api.groq.com/openai/v1/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /ollama/i,
    name: "Ollama",
    label: "Ollama — sur votre machine, sans clé",
    tagline: "sur votre machine — aucune clé nécessaire",
    kind: "llm",
    keyless: true,
    defaultBaseUrl: "http://localhost:11434",
    test: {
      url: "http://localhost:11434/api/tags",
      method: "GET",
      auth: "none",
    },
  },
  // ── Services d'API hébergés (recherche, images, vidéo…) ─────────────
  {
    match: /tavily/i,
    name: "Tavily",
    label: "Tavily — recherche web",
    tagline: "recherche web",
    kind: "service",
    test: {
      url: "https://api.tavily.com/search",
      method: "POST",
      auth: "bearer",
      body: { query: "hermes", max_results: 1 },
    },
  },
  {
    match: /\bexa\b/i,
    name: "Exa",
    label: "Exa — recherche web",
    tagline: "recherche web",
    kind: "service",
    test: {
      url: "https://api.exa.com/search",
      method: "POST",
      auth: "x-api-key",
      body: { query: "hermes", numResults: 1 },
    },
  },
  {
    match: /\bfal\b|fal\.ai|fal_ai/i,
    name: "FAL.ai",
    label: "FAL.ai — images et vidéo",
    tagline: "images et vidéo",
    kind: "service",
    test: {
      url: "https://rest.alpha.fal.ai/tokens",
      method: "GET",
      auth: "key-prefix",
    },
  },
  {
    match: /xai|grok/i,
    name: "xAI",
    label: "xAI — vidéo et recherche sur X",
    tagline: "vidéo et recherche sur X",
    kind: "service",
    test: { url: "https://api.x.ai/v1/models", method: "GET", auth: "bearer" },
  },
];

// ── Clés z.ai : deux familles, deux surfaces ─────────────────────────
// z.ai distribue deux sortes de secrets (docs.z.ai/devpack — Tool
// Integration) :
//  • clé API (format xxxxxxxx.yyyyyyyy) : ouvre la surface standard
//    https://api.z.ai/api/paas/v4 (OpenAI-compatible) ;
//  • clé « GLM Coding Plan » (abonnement, jeton JWT « eyJ… » utilisé dans
//    Claude Code, opencode, Cline…) : n'ouvre QUE les surfaces « coding »
//    (https://api.z.ai/api/coding/paas/v4). Testée sur la mauvaise surface,
//    une clé valide est refusée (401 « token expired or incorrect ») —
//    d'où le routage ci-dessous.
// v2.5 — le format ne dit PAS tout : des clés Coding Plan existent aussi
// au format xxxxxxxx.yyyyyyyy (constaté 2026-11-15 : une telle clé reçoit
// 429 « solde insuffisant » sur la surface standard et 200 OK sur la
// surface coding — les deux portefeuilles sont étanches, seule la section
// de création de la clé décide). Le JWT reste un indice (routage direct,
// sans aller-retour), mais la vérité se décide au TEST : testProviderKey
// essaie l'autre surface et propose la bascule (migrateBaseUrl).
export const ZAI_STANDARD_BASE = "https://api.z.ai/api/paas/v4";
export const ZAI_CODING_BASE = "https://api.z.ai/api/coding/paas/v4";

export function looksLikeZaiJwt(secret: string): boolean {
  const s = secret.trim();
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/.test(s);
}

/** Applique une adresse explicite (champ « endpoint » éditable, v2.5) :
 *  • identique à l'adresse par défaut du fournisseur → aucun effet (le
 *    champ n'a pas été modifié — pré-rempli par le sélecteur) ;
 *  • avec CHEMIN (https://host/chemin) → base COMPLÈTE, utilisée telle
 *    quelle : c'est le détail éditable demandé — basculer un fournisseur
 *    z.ai vers la surface coding, pointer un proxy précis… ;
 *  • origine seule (https://host) → seul l'hôte du canon est remplacé
 *    (proxy, auto-hébergé) — le chemin canonique fait partie du contrat.
 *  `canonicalUrl` est l'adresse de référence du contexte (test ou appel). */
export function applyExplicitBase(
  defaultBaseUrl: string,
  canonicalUrl: string,
  explicit: string,
): string {
  const canon = canonicalUrl.replace(/\/+$/, "");
  const ex = (explicit ?? "").trim().replace(/\/+$/, "");
  if (!ex || ex === defaultBaseUrl.replace(/\/+$/, "")) return canon;
  try {
    const e = new URL(ex);
    const path = e.pathname.replace(/\/+$/, "");
    if (path && path !== "/") return ex;
    return `${e.origin}${new URL(canon).pathname}`;
  } catch {
    return canon;
  }
}

/** Résout un nom ou une adresse saisie contre le catalogue. */
export function resolveKnownProvider(
  input: string,
):
  | { known: KnownProvider }
  | { custom: { name: string; baseUrl: string } }
  | null {
  const raw = input.trim();
  if (!raw) return null;
  const known = KNOWN_PROVIDERS.find((p) => p.match.test(raw));
  if (known) return { known };
  // Adresse collée : fournisseur personnalisé (convention OpenAI-compatible).
  // Le chemin collé fait partie de l'adresse (vLLM/LM Studio servent /v1,
  // certains proxies un préfixe) — ne garder que l'origine faisait appel au
  // moteur à la racine au lieu de l'adresse saisie.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      // Lot audit passe 2 : même garde que le test de clé (testProviderKey)
      // et que providers:add — https requis, http admis UNIQUEMENT sur la
      // boucle locale. Sans elle, une adresse http:// collée dans le champ
      // NOM créait le fournisseur en base en contournant la garde de
      // providers:add (qui ne filtre que le champ baseUrl explicite).
      const local =
        u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
      return { custom: { name: u.hostname, baseUrl: raw.replace(/\/+$/, "") } };
    } catch {
      return null;
    }
  }
  return null;
}

/** Capacités d'un fournisseur enregistré (par nom ou adresse de base). */
export function providerCapabilities(
  name: string,
  baseUrl?: string | null,
): KnownProvider | null {
  const target = `${name} ${baseUrl ?? ""}`;
  return KNOWN_PROVIDERS.find((p) => p.match.test(target)) ?? null;
}

/** Catalogue des fournisseurs connus, pour le sélecteur d'ajout (v2.5).
 *  `name` est la valeur canonique à renvoyer telle quelle à providers:add. */
export function knownProviderCatalog(): ProviderCatalogEntry[] {
  return KNOWN_PROVIDERS.map((p) => ({
    name: p.name,
    label: p.label ?? p.name,
    tagline: p.tagline,
    kind: p.kind,
    defaultBaseUrl: p.defaultBaseUrl ?? null,
    keyless: Boolean(p.keyless),
  }));
}

// ── Masquage (le secret ne quitte jamais le service) ─────────────────

export function maskSecret(secret: string): string {
  const s = secret.trim();
  if (s.length <= 8) return `${s.slice(0, 2)}••••`;
  return `${s.slice(0, 3)}••••••••${s.slice(-4)}`;
}

// ── Test réel d'une clé (appel minimal, exécuté par le service) ───────

export interface KeyTestResult {
  status: KeyStatus;
  statusLabel: string;
  detail?: string;
  /** z.ai (v2.5) : surface qui accepte réellement la clé — le fournisseur
   *  est basculé dessus par l'appelant (index.ts, providers:test-key). */
  migrateBaseUrl?: string;
}

function authHeaders(auth: AuthStyle, secret: string): Record<string, string> {
  switch (auth) {
    case "bearer":
      return { Authorization: `Bearer ${secret}` };
    case "x-api-key":
      return { "x-api-key": secret };
    case "key-prefix":
      return { Authorization: `Key ${secret}` };
    default:
      return {};
  }
}

/** Compte les modèles d'une réponse OpenAI-compatible (best effort). */
function countModels(json: unknown): number | null {
  if (Array.isArray(json)) return json.length;
  if (json && typeof json === "object") {
    const j = json as Record<string, unknown>;
    if (Array.isArray(j.data)) return j.data.length;
    if (Array.isArray(j.models)) return j.models.length;
    if (Array.isArray(j.results)) return j.results.length;
  }
  return null;
}

/** « 1 modèle », « 3 modèles » — l'accord français se voit sur la carte. */
function frModels(n: number): string {
  return `${n} modèle${n > 1 ? "s" : ""}`;
}

/** Extraits les identifiants de modèles d'une réponse /models. */
function modelIds(json: unknown): string[] {
  const arr = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? ((json as any).data ?? (json as any).models ?? (json as any).results)
      : null;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((m) => (m && typeof m === "object" ? String((m as any).id ?? "") : ""))
    .filter(Boolean);
}

/** Lit un corps d'erreur en texte court (best effort, jamais jetant). */
async function readBodySnippet(res: Response): Promise<string> {
  try {
    const raw = await res.text();
    return raw.slice(0, 300) || "(corps vide)";
  } catch {
    return "(corps vide)";
  }
}

/**
 * Traduit la RAISON d'une limite (corps réels observés en production) :
 *  • z.ai code 1113 « Insufficient balance or no resource package » → le
 *    compte n'a pas de crédit : aucune génération possible, recharger ;
 *  • opencode « FreeUsageLimitError » → quota gratuit épuisé : les modèles
 *    gratuits ne tournent que dans l'application opencode, l'API demande
 *    l'abonnement OpenCode Go ;
 *  • « Too many requests / rate limit » → simple limite de débit, réessayer.
 * Sinon le message d'origine accompagne l'erreur telle quelle (honnêteté :
 * c'est le fournisseur qui parle). `short` sert d'étiquette sur la carte clé.
 * Partagée entre le test de clé (ici) et le moteur de tours (llm-pool.ts).
 */
export function explainQuotaError(detail: string): {
  kind: "balance" | "free_limit" | "rate" | null;
  long: string;
  short: string;
} {
  if (/insufficient balance|no resource package/i.test(detail))
    return {
      kind: "balance",
      long: "solde insuffisant : rechargez le compte chez le fournisseur",
      short: "solde insuffisant (recharge requise)",
    };
  if (/free usage limit/i.test(detail))
    return {
      kind: "free_limit",
      long: "quota gratuit épuisé : un abonnement payant du fournisseur est nécessaire",
      short: "quota gratuit épuisé",
    };
  if (/too many requests|rate limit/i.test(detail))
    return {
      kind: "rate",
      long: "trop de requêtes à la minute : réessayez dans un instant",
      short: "trop de requêtes (réessayez)",
    };
  if (!detail || detail === "(corps vide)")
    return { kind: null, long: "", short: "limite atteinte" };
  return { kind: null, long: detail, short: detail.slice(0, 80) };
}

/**
 * Test approfondi z.ai / opencode : la liste des modèles RÉUSSIT même quand
 * le compte ne peut pas générer le moindre jeton — solde nul chez z.ai
 * (code 1113, observé : la clé est valide, c'est le compte qui est vide) et
 * quota gratuit épuisé chez opencode (FreeUsageLimitError). Une
 * mini-génération (1 jeton, modèle flash/gratuit de préférence) révèle la
 * vérité dès le bouton « Tester » — coût sur un compte sain : dérisoire.
 * Renvoie null quand le résultat est imprévu (on garde alors le verdict de
 * la liste des modèles, déjà acquis) ou que le réseau l'a empêché.
 */
async function probeGeneration(
  url: string,
  secret: string,
  model: string,
  okLabel: string,
): Promise<KeyTestResult | null> {
  try {
    const res = await fetch(url, { redirect: "error",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      // Piège z.ai : un 200 peut porter une erreur dans le corps.
      let j: unknown = null;
      try {
        j = await res.json();
      } catch {
        /* corps non JSON : un 200 de chat reste un 200 */
      }
      const err = (j as any)?.error;
      if (err) {
        const detail = typeof err === "string" ? err : JSON.stringify(err);
        const why = explainQuotaError(detail);
        if (why.kind) return { status: "exhausted", statusLabel: `clé valide — ${why.short}` };
        return null;
      }
      return { status: "ok", statusLabel: okLabel };
    }
    if (res.status === 429) {
      const detail = await readBodySnippet(res);
      const why = explainQuotaError(detail);
      if (why.kind === "balance")
        return {
          status: "exhausted",
          statusLabel: "clé valide — solde insuffisant, rechargez le compte",
          detail,
        };
      if (why.kind === "free_limit")
        return {
          status: "exhausted",
          statusLabel: "clé valide — quota gratuit épuisé (abonnement requis)",
          detail,
        };
      return {
        status: "exhausted",
        statusLabel: why.short || "limite atteinte à l'usage",
        detail,
      };
    }
    if (res.status === 401 || res.status === 403)
      return { status: "error", statusLabel: "clé refusée à l'usage" };
    return null; // imprévu (404, 500…) : verdict de la liste conservé
  } catch {
    return null; // réseau/délai : la liste a déjà prouvé la joignabilité
  }
}

/** Teste UNE surface z.ai (standard ou coding, v2.5) : liste des modèles
 *  puis mini-génération — la vérité sur le portefeuille (solde rechargeable
 *  ou abonnement). `networkFailure` distingue « la surface a répondu non »
 *  (on peut tenter l'autre portefeuille) de « le réseau n'a pas répondu »
 *  (inutile d'insister). */
async function testZaiSurface(
  base: string,
  secret: string | null,
): Promise<{ result: KeyTestResult; networkFailure: boolean }> {
  const planLabel = /\/api\/coding\//.test(base) ? " (Coding Plan)" : "";
  try {
    const res = await fetch(`${base}/models`, { redirect: "error",
      method: "GET",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(7000),
    });
    if (res.status === 200) {
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* corps non JSON — pas grave */
      }
      // Piège z.ai : un 200 peut porter l'erreur d'authentification dans
      // le corps ({"code":401,"success":false} observé) — pas de garantie.
      if (
        json &&
        typeof json === "object" &&
        !Array.isArray(json) &&
        !Array.isArray((json as any).data) &&
        !Array.isArray((json as any).models) &&
        ((json as any).success === false ||
          (typeof (json as any).code === "number" && (json as any).code !== 0))
      ) {
        const code = (json as any).code;
        return {
          result: {
            status: "error",
            statusLabel:
              code === 1001 || code === 401 ? "clé refusée" : `réponse inattendue (code ${code})`,
          },
          networkFailure: false,
        };
      }
      const ids = modelIds(json);
      const n = countModels(json);
      // La liste réussit même sur un compte incapable de générer (solde
      // nul, quota épuisé) : la mini-génération dit la vérité.
      if (secret && ids.length > 0) {
        // Modèle le moins cher de préférence (flash) — coût dérisoire.
        const model = ids.find((m) => /flash/i.test(m)) ?? ids[0];
        const probed = await probeGeneration(`${base}/chat/completions`, secret, model, "");
        if (probed) {
          if (probed.status === "ok")
            return {
              result: {
                status: "ok",
                statusLabel: `${frModels(n ?? ids.length)}${planLabel} — compte actif`,
              },
              networkFailure: false,
            };
          return { result: probed, networkFailure: false };
        }
      }
      return {
        result: { status: "ok", statusLabel: `${frModels(n ?? ids.length)}${planLabel}` },
        networkFailure: false,
      };
    }
    if (res.status === 429) {
      // La raison du 429 se lit dans le corps (solde nul, quota épuisé,
      // débit…) : « limite atteinte » seul est trompeur.
      const detail = await readBodySnippet(res);
      const why = explainQuotaError(detail);
      return {
        result: {
          status: "exhausted",
          statusLabel: why.kind ? why.short : "limite atteinte",
          detail: why.kind ? detail : undefined,
        },
        networkFailure: false,
      };
    }
    if (res.status === 401 || res.status === 403)
      return { result: { status: "error", statusLabel: "clé refusée" }, networkFailure: false };
    return {
      result: { status: "error", statusLabel: `réponse inattendue (HTTP ${res.status})` },
      networkFailure: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: {
        status: "error",
        statusLabel: /timeout|abort/i.test(msg)
          ? "service injoignable (délai dépassé)"
          : "service injoignable",
      },
      networkFailure: true,
    };
  }
}

/** Teste une clé : appel réseau réel, timeout court, résultat honnête.
 *  v2.5 — z.ai : les deux portefeuilles (API standard / GLM Coding Plan)
 *  sont étanches ; le test essaie la surface attendue puis, si la clé y
 *  est refusée (401/403/429), l'AUTRE surface — quand elle répond, le
 *  fournisseur est basculé dessus (migrateBaseUrl) et le libellé le dit. */
export async function testProviderKey(
  name: string,
  baseUrl: string | null | undefined,
  secret: string | null,
): Promise<KeyTestResult> {
  const caps = providerCapabilities(name, baseUrl);
  // Audit passe 3, F-06 : la baseUrl vient du client — le test de clé
  // n'interroge que https, ou http strictement local (Ollama et compagnie).
  // Interdit : http vers le réseau — le test ne doit pas servir de sonde.
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      const isLocalHost =
        u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost)) {
        return {
          status: "error",
          statusLabel: "adresse refusée : https requis (http admis sur localhost uniquement)",
        };
      }
    } catch {
      return { status: "error", statusLabel: "adresse de base invalide" };
    }
  }
  const zaiJwt = Boolean(caps?.name === "z.ai" && secret && looksLikeZaiJwt(secret));
  // Test canonique du fournisseur, ou convention /models (fournisseur
  // personnalisé — adresse collée).
  let testUrl: string | null = caps ? caps.test.url : null;
  if (!testUrl && baseUrl) {
    testUrl = `${baseUrl.replace(/\/+$/, "")}/models`;
  }
  if (!testUrl) {
    return {
      status: "error",
      statusLabel: "aucun test connu pour ce fournisseur",
    };
  }
  // Adresse explicite (champ « endpoint » éditable, v2.5) :
  //  • fournisseur LLM connu avec base d'appel — règle complète : adresse
  //    inchangée = canon ; avec chemin = base COMPLÈTE ; origine seule =
  //    hôte du canon (applyExplicitBase). Le test interroge ce que le
  //    moteur utilisera réellement ;
  //  • services et cas sans base d'appel — règle d'origine : seule
  //    l'origine du test canonique est remplacée, le chemin est conservé.
  if (baseUrl && caps && caps.kind === "llm" && caps.defaultBaseUrl) {
    const canonicalTestBase = caps.testBase ?? caps.defaultBaseUrl;
    const suffix = caps.test.url.startsWith(canonicalTestBase)
      ? caps.test.url.slice(canonicalTestBase.length)
      : "/models";
    testUrl = `${applyExplicitBase(caps.defaultBaseUrl, canonicalTestBase, baseUrl)}${suffix}`;
  } else if (baseUrl && caps) {
    try {
      const tb = new URL(testUrl);
      const ob = new URL(baseUrl);
      if (tb.origin !== ob.origin) {
        testUrl = `${ob.origin}${tb.pathname}`;
      }
    } catch {
      /* baseUrl invalide : déjà signalé ci-dessus */
    }
  }
  // z.ai : deux portefeuilles étanches — le test décide de la surface.
  // Les surfaces sont dérivées de la MÊME origine que le test (adresse
  // explicite / proxy respecté — la clé ne fuit jamais vers api.z.ai).
  if (caps && (caps.name === "z.ai" || caps.name === "z.ai Coding Plan")) {
    let zaiOrigin = "https://api.z.ai";
    try {
      zaiOrigin = new URL(testUrl).origin;
    } catch {
      /* testUrl déjà construit valide */
    }
    // Les clés Coding Plan « eyJ… » ne parlent qu'à la surface coding :
    // la tester en premier évite l'aller-retour (routage d'origine v2.4).
    const codingFirst = zaiJwt || testUrl.includes("/coding/");
    const primaryBase = codingFirst
      ? `${zaiOrigin}/api/coding/paas/v4`
      : `${zaiOrigin}/api/paas/v4`;
    const secondaryBase = codingFirst
      ? `${zaiOrigin}/api/paas/v4`
      : `${zaiOrigin}/api/coding/paas/v4`;
    const primary = await testZaiSurface(primaryBase, secret);
    if (primary.result.status === "ok") return primary.result;
    // Clé refusée ou à sec sur la surface attendue (le serveur a répondu) :
    // l'AUTRE portefeuille répond peut-être — cas réel des clés Coding
    // Plan au format standard (429 « solde insuffisant » d'un côté, 200 de
    // l'autre, 2026-11-15). Les jetons JWT, eux, ne fonctionnent que sur
    // la surface coding : inutile de tenter la standard.
    if (!zaiJwt && !primary.networkFailure) {
      const secondary = await testZaiSurface(secondaryBase, secret);
      if (secondary.result.status === "ok") {
        // Le libellé (« N modèles (Coding Plan) — compte actif ») reste
        // court pour la pastille ; la bascule elle-même est annoncée par
        // l'interface (toast) et visible sur la carte (nouvelle adresse).
        return {
          ...secondary.result,
          migrateBaseUrl: secondaryBase,
        };
      }
    }
    return primary.result;
  }
  try {
    const res = await fetch(testUrl, { redirect: "error",
      method: caps?.test.method ?? "GET",
      headers: {
        ...(caps?.test.body ? { "Content-Type": "application/json" } : {}),
        ...(secret ? authHeaders(caps?.test.auth ?? "bearer", secret) : {}),
        ...(caps?.test.extraHeaders ?? {}),
      },
      body: caps?.test.body ? JSON.stringify(caps.test.body) : undefined,
      signal: AbortSignal.timeout(7000),
    });
    if (res.status === 200) {
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* corps non JSON — pas grave */
      }
      // Piège z.ai : certaines surfaces renvoient l'erreur d'authentification
      // dans un corps JSON HTTP 200 ({"code":401,"success":false} observé sur
      // la surface Anthropic) — un 200 n'est PAS une garantie de réussite.
      if (
        json &&
        typeof json === "object" &&
        !Array.isArray(json) &&
        !Array.isArray((json as any).data) &&
        !Array.isArray((json as any).models) &&
        ((json as any).success === false ||
          (typeof (json as any).code === "number" && (json as any).code !== 0))
      ) {
        const code = (json as any).code;
        return {
          status: "error",
          statusLabel:
            code === 1001 || code === 401 ? "clé refusée" : `réponse inattendue (code ${code})`,
        };
      }
      const models = countModels(json);
      // Test approfondi opencode : la liste des modèles réussit même sur
      // un compte incapable de générer (quota gratuit épuisé — cas réel) ;
      // la mini-génération dit la vérité, cf. probeGeneration. La base du
      // probe suit l'endpoint effectif (canonique ou édité).
      // (z.ai est traité plus haut, surface par portefeuille.)
      const ids = modelIds(json);
      if (caps && secret && ids.length > 0 && caps.name === "opencode" && caps.defaultBaseUrl) {
        const probeBase = baseUrl
          ? applyExplicitBase(caps.defaultBaseUrl, caps.defaultBaseUrl, baseUrl)
          : caps.defaultBaseUrl;
        // Modèle gratuit de préférence (free / pickle : prix 0 chez eux).
        const model = ids.find((m) => /free|pickle/i.test(m)) ?? ids[0];
        const probed = await probeGeneration(
          `${probeBase}/chat/completions`,
          secret,
          model,
          `${frModels(models ?? ids.length)} — compte actif`,
        );
        if (probed) return probed;
      }
      return {
        status: "ok",
        statusLabel: models !== null ? frModels(models) : "connecté",
      };
    }
    if (res.status === 429) {
      // La raison du 429 se lit dans le corps (solde nul, quota épuisé,
      // débit…) : « limite atteinte » seul est trompeur.
      const detail = await readBodySnippet(res);
      const why = explainQuotaError(detail);
      return {
        status: "exhausted",
        statusLabel: why.kind ? why.short : "limite atteinte",
        detail: why.kind ? detail : undefined,
      };
    }
    if (res.status === 401 || res.status === 403)
      return { status: "error", statusLabel: "clé refusée" };
    return {
      status: "error",
      statusLabel: `réponse inattendue (HTTP ${res.status})`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timeout|abort/i.test(msg))
      return {
        status: "error",
        statusLabel: "service injoignable (délai dépassé)",
      };
    return { status: "error", statusLabel: "service injoignable" };
  }
}

// ── Stratégies de porte-clés (pools d'identifiants) ───────────────────
// Prêtes pour le moteur ; en local elles sont exposées et testables mais
// les tours sans agent ne les consomment pas (uniquement le porte-clés).

// Curseur de rotation (round_robin) par fournisseur, en mémoire.
const rrCursor = new Map<string, number>();

export function pickActiveKey<
  T extends {
    id: string;
    status: KeyStatus;
    position: number;
    usedCount: number;
  },
>(providerId: string, strategy: ProviderStrategy, keys: T[]): T | null {
  const available = keys.filter(
    (k) => k.status === "ok" || k.status === "untested",
  );
  if (available.length === 0) return null;
  if (strategy === "fill_first") {
    return available.sort((a, b) => a.position - b.position)[0];
  }
  if (strategy === "round_robin") {
    const cursor = rrCursor.get(providerId) ?? 0;
    const ordered = available.sort((a, b) => a.position - b.position);
    const picked = ordered[cursor % ordered.length];
    rrCursor.set(providerId, cursor + 1);
    return picked;
  }
  // least_used : la moins utilisée, à égalité la première en priorité
  return available.sort(
    (a, b) => a.usedCount - b.usedCount || a.position - b.position,
  )[0];
}

// ── GitHub : imports de dépôts (connecteurs / Extensions) ─────────────

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Analyse « https://github.com/owner/repo », « owner/repo », « git@… ». */
export function parseRepoInput(input: string): RepoRef | null {
  const raw = input.trim();
  if (!raw) return null;
  const https =
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      raw,
    );
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(raw);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(raw);
  if (short) return { owner: short[1], repo: short[2] };
  return null;
}

const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "hermes-web-ui",
  // Jeton optionnel (quota GitHub x80) — p. ex. GITHUB_TOKEN=ghp_… dans le .env
  // du mini-service.
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

export interface RepoSnapshot {
  name: string;
  description: string | null;
  defaultBranch: string;
  headSha: string;
  /** Dernier tag publié (ex. « v0.9.2 »), sinon sha court. */
  versionLabel: string;
  commits: ExtensionCommit[];
}

// ── Repli protocole git (quota API épuisé ou API indisponible) ────────
// `git ls-remote --symref` donne la branche par défaut, la tête et les
// tags sans consommer de quota — sans description ni commits (API seule).

function compareTags(a: string, b: string): number {
  const na = a
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const nb = b
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  return b.localeCompare(a);
}

async function gitLsRemoteSnapshot(
  ref: RepoRef,
  branch?: string | null,
): Promise<RepoSnapshot | null> {
  const url = `https://github.com/${ref.owner}/${ref.repo}.git`;
  // Lot 2 (audit L2-9) : spawnSync gelait l'event loop jusqu'à 12 s par appel
  // (×3 en débat parallèle) — execFile async à la place ; « -- » sépare les
  // options de l'URL (durcissement gratuit, l'URL vient des refs internes).
  let stdout: string;
  try {
    const res = await execFile("git", ["ls-remote", "--symref", "--", url], {
      timeout: 12000,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" },
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch {
    // binaire absent, code non nul, timeout — repli git indisponible
    return null;
  }
  if (!stdout) return null;
  let head = "";
  let defaultBranch = "";
  const tags: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ref: ")) {
      const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(trimmed);
      if (m) defaultBranch = m[1];
      continue;
    }
    const m = /^([0-9a-f]{40})\t(.+)$/.exec(trimmed);
    if (!m) continue;
    const [, sha, refName] = m;
    if (refName === "HEAD" || refName === `refs/heads/${branch}`) head = sha;
    const t = /^refs\/tags\/(.+)$/.exec(refName);
    if (t && !t[1].endsWith("^{}")) tags.push(t[1]);
  }
  if (!head) return null;
  tags.sort(compareTags);
  return {
    name: ref.repo,
    description: null,
    defaultBranch: branch || defaultBranch || "main",
    headSha: head,
    versionLabel: tags[0] ?? head.slice(0, 7),
    commits: [],
  };
}

/** Résout un dépôt GitHub : infos, branche par défaut, tête et derniers commits.
 *  Repli automatique sur le protocole git si l'API est injoignable ou quota-
 *  épuisée (sans description ni liste de commits). */
// Cache TTL du snapshot (Lot 2, audit L2-9) : le registre relit le dépôt à
// chaque ouverture/rafraîchissement — chaque relecture enchaîne 2-3 appels
// GitHub (+ repli git). Un cache court évite de marteler l'API (limites de
// débit) et rend la réouverture instantanée.
const SNAPSHOT_TTL_MS = 60_000;
const snapshotCache = new Map<string, { at: number; snap: RepoSnapshot }>();

export async function fetchRepoSnapshot(
  ref: RepoRef,
  branch?: string | null,
): Promise<RepoSnapshot> {
  const key = `${ref.owner}/${ref.repo}@${branch ?? ""}`;
  const hit = snapshotCache.get(key);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.snap;
  const snap = await fetchRepoSnapshotUncached(ref, branch);
  snapshotCache.set(key, { at: Date.now(), snap });
  return snap;
}

async function fetchRepoSnapshotUncached(
  ref: RepoRef,
  branch?: string | null,
): Promise<RepoSnapshot> {
  try {
    const infoRes = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}`,
      { redirect: "error",
        headers: GH_HEADERS,
        signal: AbortSignal.timeout(9000),
      },
    );
    if (infoRes.status === 404) throw new Error("Dépôt introuvable sur GitHub");
    if (infoRes.status === 403)
      throw new Error("Limite d'appels GitHub atteinte");
    if (!infoRes.ok) throw new Error(`GitHub a répondu HTTP ${infoRes.status}`);
    const info = (await infoRes.json()) as {
      name: string;
      description: string | null;
      default_branch: string;
    };

    const channel = branch || info.default_branch || "main";
    const commitsRes = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits?sha=${encodeURIComponent(channel)}&per_page=6`,
      // Lot audit passe 2 : redirect: "error" comme sur /repos et /tags —
      // une 302 (redirection) ne doit jamais être suivie en silence.
      { redirect: "error",
        headers: GH_HEADERS,
        signal: AbortSignal.timeout(9000),
      },
    );
    if (!commitsRes.ok)
      throw new Error(`Commits indisponibles (HTTP ${commitsRes.status})`);
    const commitsRaw = (await commitsRes.json()) as Array<{
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
    }>;
    const commits: ExtensionCommit[] = commitsRaw.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split("\n")[0],
      author: c.commit.author?.name ?? "",
      date: c.commit.author?.date ?? "",
    }));
    const headSha = commits[0]?.sha ?? "";

    // Dernier tag pour l'affichage de version (best effort)
    let versionLabel = headSha.slice(0, 7);
    try {
      const tagsRes = await fetch(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/tags?per_page=1`,
        { redirect: "error",
          headers: GH_HEADERS,
          signal: AbortSignal.timeout(6000),
        },
      );
      if (tagsRes.ok) {
        const tags = (await tagsRes.json()) as Array<{
          name: string;
          commit: { sha: string };
        }>;
        if (tags[0]) versionLabel = tags[0].name;
      }
    } catch {
      /* tag indisponible : sha court */
    }

    return {
      name: info.name,
      description: info.description,
      defaultBranch: channel,
      headSha,
      versionLabel,
      commits,
    };
  } catch (err) {
    // Repli protocole git : au moins la branche, la tête et le dernier tag.
    const snap = await gitLsRemoteSnapshot(ref, branch);
    if (snap) return snap;
    throw err;
  }
}

// ── Vue client d'une clé (sans le secret) ─────────────────────────────

export interface KeyRowLike {
  id: string;
  label: string;
  masked: string;
  status: string;
  status_label: string | null;
  last_tested_at: string | null;
}

export function toKeyView(r: KeyRowLike): ProviderKeyView {
  return {
    id: r.id,
    label: r.label,
    masked: r.masked,
    status: r.status as KeyStatus,
    statusLabel: r.status_label ?? null,
    lastTestedAt: r.last_tested_at ?? null,
  };
}
