// Fournisseurs & clés + Extensions — logique du chantier « Paramètres v2.2 ».
// Le mini-service est le SEUL détenteur des secrets : il les stocke, les
// masque pour le client et exécute lui-même les appels de test (réels,
// réseau inclus) — cf. FORK.md §7.4, décisions v2/v4.
//
// Rien ici ne touche au moteur de tours : en mode démo les clés servent à
// préparer la configuration (test, ordre, relai) ; le branchement effectif
// des pools sur les tours suivra la gateway (v2.3+).
import { spawnSync } from "node:child_process";
import type {
  ExtensionCommit,
  KeyStatus,
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
  tagline: string;
  kind: ProviderKind;
  keyless?: boolean;
  defaultBaseUrl?: string;
  test: {
    url: string;
    method: "GET" | "POST";
    auth: AuthStyle;
    body?: unknown;
    extraHeaders?: Record<string, string>;
  };
}

const KNOWN_PROVIDERS: KnownProvider[] = [
  {
    match: /z\.ai|zhipu|bigmodel|glm/i,
    name: "z.ai",
    tagline: "modèles GLM",
    kind: "llm",
    test: {
      url: "https://api.z.ai/api/paas/v4/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /openrouter/i,
    name: "OpenRouter",
    tagline: "des centaines de modèles sous un même compte",
    kind: "llm",
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
    tagline: "modèles Claude",
    kind: "llm",
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
    tagline: "modèles Mistral",
    kind: "llm",
    test: {
      url: "https://api.mistral.ai/v1/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /openai/i,
    name: "OpenAI",
    tagline: "modèles GPT",
    kind: "llm",
    test: {
      url: "https://api.openai.com/v1/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /deepseek/i,
    name: "DeepSeek",
    tagline: "modèles DeepSeek",
    kind: "llm",
    test: {
      url: "https://api.deepseek.com/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /groq/i,
    name: "Groq",
    tagline: "inférence très rapide",
    kind: "llm",
    test: {
      url: "https://api.groq.com/openai/v1/models",
      method: "GET",
      auth: "bearer",
    },
  },
  {
    match: /ollama/i,
    name: "Ollama",
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
    tagline: "vidéo et recherche sur X",
    kind: "service",
    test: { url: "https://api.x.ai/v1/models", method: "GET", auth: "bearer" },
  },
];

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
  // Adresse collée : fournisseur personnalisé (convention OpenAI-compatible)
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return { custom: { name: u.hostname, baseUrl: u.origin } };
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

/** Teste une clé : appel réseau réel, timeout court, résultat honnête. */
export async function testProviderKey(
  name: string,
  baseUrl: string | null | undefined,
  secret: string | null,
): Promise<KeyTestResult> {
  const caps = providerCapabilities(name, baseUrl);
  // Fournisseur personnalisé : convention /models avec Bearer
  const test = caps
    ? caps.test
    : baseUrl
      ? {
          url: `${baseUrl.replace(/\/+$/, "")}/models`,
          method: "GET" as const,
          auth: "bearer" as const,
        }
      : null;
  if (!test) {
    return {
      status: "error",
      statusLabel: "aucun test connu pour ce fournisseur",
    };
  }
  try {
    const res = await fetch(test.url, {
      method: test.method,
      headers: {
        ...(test.body ? { "Content-Type": "application/json" } : {}),
        ...(secret ? authHeaders(test.auth, secret) : {}),
        ...(test.extraHeaders ?? {}),
      },
      body: test.body ? JSON.stringify(test.body) : undefined,
      signal: AbortSignal.timeout(7000),
    });
    if (res.status === 200) {
      let models: number | null = null;
      try {
        models = countModels(await res.json());
      } catch {
        /* corps non JSON — pas grave */
      }
      return {
        status: "ok",
        statusLabel: models !== null ? `${models} modèles` : "connecté",
      };
    }
    if (res.status === 429)
      return { status: "exhausted", statusLabel: "limite atteinte" };
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
// Prêtes pour le moteur ; en démo elles sont exposées et testables mais
// les tours du LLM intégré ne les consomment pas (SDK du bac à sable).

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

function gitLsRemoteSnapshot(
  ref: RepoRef,
  branch?: string | null,
): RepoSnapshot | null {
  const url = `https://github.com/${ref.owner}/${ref.repo}.git`;
  const res = spawnSync("git", ["ls-remote", "--symref", url], {
    timeout: 12000,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" },
  });
  if (res.status !== 0 || !res.stdout) return null;
  let head = "";
  let defaultBranch = "";
  const tags: string[] = [];
  for (const line of res.stdout.split("\n")) {
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
export async function fetchRepoSnapshot(
  ref: RepoRef,
  branch?: string | null,
): Promise<RepoSnapshot> {
  try {
    const infoRes = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}`,
      {
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
      { headers: GH_HEADERS, signal: AbortSignal.timeout(9000) },
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
        {
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
    const snap = gitLsRemoteSnapshot(ref, branch);
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
