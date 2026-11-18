// Recherche web (F-09/F-12) — consomme le porte-clés « Clés de services »
// du volet Paramètres (Tavily, Exa). Best effort : une recherche échouée ne
// fait JAMAIS échouer le tour — l'événement outil l'affiche honnêtement dans
// la bulle, le modèle répond alors sans contexte web.
// Les résultats numérotés sont injectés dans les instructions du tour (mode
// sans agent : pool de clés) ; en gateway, la recherche est gérée par
// l'agent Hermes lui-même (le service n'injecte rien).
import type { KeyRow, ProviderRow, Store } from "./store";
import { pickActiveKey, providerCapabilities } from "./providers";
import type { ProviderStrategy, WebSource } from "./types";

export type { WebSource };

export interface WebSearchOutcome {
  sources?: WebSource[];
  provider?: string;
  error?: string;
}

interface SearchSpec {
  base: string;
  style: "tavily" | "exa";
  label: string;
}

const SEARCH_SPECS: Record<string, SearchSpec> = {
  Tavily: { base: "https://api.tavily.com", style: "tavily", label: "Tavily" },
  Exa: { base: "https://api.exa.com", style: "exa", label: "Exa" },
};

/** https requis, ou http strictement local (même règle que le reste). */
function safeBase(base: string): boolean {
  try {
    const u = new URL(base);
    const local =
      u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    return u.protocol === "https:" || (u.protocol === "http:" && local);
  } catch {
    return false;
  }
}

function pickKey(store: Store, row: ProviderRow): KeyRow | null {
  const keys = store.listKeyRows(row.id).map((k) => ({
    id: k.id,
    status: k.status as "untested" | "ok" | "error" | "exhausted",
    position: k.position,
    usedCount: k.used_count,
    raw: k,
  }));
  const picked = pickActiveKey(row.id, row.strategy as ProviderStrategy, keys);
  return picked ? picked.raw : null;
}

/** Fournisseur de recherche actionnable (Tavily ou Exa, clé disponible). */
export function findSearchProvider(
  store: Store,
): { row: ProviderRow; key: KeyRow; base: string; style: "tavily" | "exa"; label: string } | null {
  for (const row of store.listProviderRows()) {
    if (row.kind !== "service") continue;
    const caps = providerCapabilities(row.name, row.base_url);
    if (!caps) continue;
    const spec = SEARCH_SPECS[caps.name];
    if (!spec) continue;
    const overridden =
      row.base_url && /^https?:\/\//i.test(row.base_url)
        ? row.base_url.replace(/\/+$/, "")
        : null;
    const base = overridden && safeBase(overridden) ? overridden : spec.base;
    const key = pickKey(store, row);
    if (!key) continue; // Tavily/Exa exigent une clé
    return { row, key, base, style: spec.style, label: spec.label };
  }
  return null;
}

const MAX_RESULTS = 5;
const SNIPPET_CHARS = 280;

function toSources(
  results: Array<{ title?: unknown; url?: unknown; content?: unknown; text?: unknown }>,
): WebSource[] {
  const out: WebSource[] = [];
  for (const r of results) {
    const url = typeof r.url === "string" ? r.url : "";
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : url;
    const raw = typeof r.content === "string" ? r.content : typeof r.text === "string" ? r.text : "";
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      n: out.length + 1,
      title,
      url,
      snippet: raw.trim().slice(0, SNIPPET_CHARS),
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** Recherche web via la première clé Tavily/Exa disponible. */
export async function runWebSearch(store: Store, query: string): Promise<WebSearchOutcome> {
  const provider = findSearchProvider(store);
  if (!provider) {
    return {
      error:
        "aucune clé Tavily/Exa disponible — ajoutez-en une dans Paramètres → Clés de services",
    };
  }
  const q = query.trim().slice(0, 400);
  if (!q) return { error: "requête vide" };
  try {
    let res: Response;
    if (provider.style === "tavily") {
      res = await fetch(`${provider.base}/search`, { redirect: "error",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.key.secret}`,
        },
        body: JSON.stringify({ query: q, max_results: MAX_RESULTS }),
        signal: AbortSignal.timeout(9000),
      });
    } else {
      res = await fetch(`${provider.base}/search`, { redirect: "error",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": provider.key.secret,
        },
        body: JSON.stringify({ query: q, numResults: MAX_RESULTS }),
        signal: AbortSignal.timeout(9000),
      });
    }
    if (res.status === 401 || res.status === 403) {
      return { error: `${provider.label} : clé refusée (HTTP ${res.status})` };
    }
    if (res.status === 429) {
      return { error: `${provider.label} : limite atteinte (HTTP 429)` };
    }
    if (!res.ok) {
      return { error: `${provider.label} a répondu HTTP ${res.status}` };
    }
    const json = (await res.json()) as { results?: unknown };
    const results = Array.isArray(json?.results) ? (json.results as any[]) : [];
    const sources = toSources(results);
    if (sources.length === 0) return { error: `${provider.label} : aucun résultat exploitable` };
    return { sources, provider: provider.label };
  } catch {
    return { error: `${provider.label} injoignable (délai dépassé)` };
  }
}

/** Section injectée dans les instructions du tour (moteur local). */
export function webSearchSection(sources: WebSource[]): string {
  const lines = sources.map(
    (s) => `[${s.n}] ${s.title} — ${s.url}\nExtrait : ${s.snippet}`,
  );
  return (
    `\n\n[Résultats de recherche web du ${new Date().toLocaleDateString("fr-FR")}]\n` +
    lines.join("\n\n") +
    "\nUtilise ces résultats s'ils sont pertinents, et cite les sources utilisées sous la forme [n] en fin de phrase."
  );
}
