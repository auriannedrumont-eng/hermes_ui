// Coloration syntaxique partagée — chantier performances 2026-11-19.
// Remplace react-syntax-highlighter (Prism complet ~600 Ko embarqué,
// re-tokenisé à chaque re-rendu) par shiki : grammaires TextMate de VS Code,
// chargées à la demande pour une liste curatée de langues, rendu HTML
// mémoïsable par codeBlockHtml() — le HTML colorisé est un cache LRU, la
// vue React ne fait que l'injecter.
// Thème : vsc-dark-plus à l'identique de l'ancien rendu (parité stricte,
// décision « pas de thème double clair/sombre » — cf. FORK.md §9).
"use client";

import { useEffect, useState } from "react";
import { createHighlighter, type Highlighter } from "shiki";

/** Langues chargées au premier besoin (identifiants shiki). Le reste
 *  déclasse proprement en texte brut via resolveLanguage(). */
const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "python",
  "bash",
  "shellscript",
  "html",
  "css",
  "sql",
  "markdown",
  "yaml",
  "dockerfile",
  "diff",
  "xml",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "plaintext",
] as const;

/** Alias de clôtures markdown / kinds d'artefacts → identifiant shiki. */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  shell: "shellscript",
  yml: "yaml",
  md: "markdown",
  svg: "xml", // pas de grammaire shiki dédiée : XML couvre le SVG
  "c++": "cpp",
  "c#": "csharp",
  text: "plaintext",
  txt: "plaintext",
  plaintext: "plaintext",
  code: "plaintext",
};

/** Résout une langue saisie par le LLM / le service en identifiant shiki
 *  chargé, ou null → texte brut (l'ancien comportement dégradait
 *  silencieusement aussi : parité). */
export function resolveLanguage(lang?: string | null): string | null {
  if (!lang) return "plaintext";
  const raw = lang.toLowerCase().trim();
  const aliased = ALIASES[raw] ?? raw;
  return (LANGS as readonly string[]).includes(aliased) ? aliased : null;
}

/** Faux langage : coloration « aucune » — shiki le rend en texte brut. */
const PLAIN = "plaintext";

// ── Highlighter singleton (initialisation unique, en vol partagée) ──────

let highlighterPromise: Promise<Highlighter> | null = null;

/** Thème VS Code Dark+ — nom canonique shiki : « dark-plus » (shiki 4
 *  n'expose plus les thèmes par nom à createHighlighter, mais comme objet
 *  de bundledThemes). */
const THEME = "dark-plus" as const;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [THEME],
    langs: [...LANGS],
  });
  return highlighterPromise;
}

// ── Cache LRU du HTML colorisé ───────────────────────────────────────────
// Un bloc de code ne change jamais une fois affiché (le flux streaming
// n'utilise PAS ce chemin : la vue live est en texte brut — cf.
// artifact-panel / message-bubble). Clé = langue + contenu ; les conversations
// longues ne gonflent pas la mémoire : borné à 80 entrées.

const HTML_CACHE_MAX = 80;
const htmlCache = new Map<string, string>();

function cacheKey(lang: string, code: string): string {
  return `${lang}\u0000${code}`;
}

/** Colorise un bloc (synchrone après warm-up, promesse sinon). */
export async function codeBlockHtml(code: string, lang?: string | null): Promise<string> {
  const resolved = resolveLanguage(lang) ?? PLAIN;
  const key = cacheKey(resolved, code);
  const cached = htmlCache.get(key);
  if (cached !== undefined) {
    // LRU : rafraîchir la position (get ne le fait pas sur Map).
    htmlCache.delete(key);
    htmlCache.set(key, cached);
    return cached;
  }
  const highlighter = await getHighlighter();
  const html = highlighter.codeToHtml(code, {
    lang: resolved,
    theme: THEME,
  });
  if (htmlCache.size >= HTML_CACHE_MAX) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  htmlCache.set(key, html);
  return html;
}

/** CSS inline du conteneur shiki — mêmes valeurs que l'ancien
 *  SyntaxHighlighter (fond #0d1117, 12.5px, geist-mono). Le HTML shiki
 *  embarque son propre background : on le neutralise ici pour garder la
 *  main sur le conteneur (arrondis, bordures, marge). */
export const CODE_CONTAINER_STYLE: React.CSSProperties = {
  margin: 0,
  background: "#0d1117",
  fontSize: "12.5px",
  lineHeight: 1.65,
};

export const CODE_FONT_FAMILY = "var(--font-geist-mono), ui-monospace, monospace";

// ── Hook React : HTML colorisé ou null pendant le premier rendu ─────────

/**
 * Rendu colorisé d'un bloc immuable. Retourne null tant que le highlighter
 * n'est pas prêt : l'appelant affiche alors le texte brut sur le même fond
 * sombre (flash invisible en pratique).
 */
export function useHighlightedCode(code: string, lang?: string | null): string | null {
  // Initialisation paresseuse + « adjust state during render » (motif React
  // officiel, convention §60 du repo — pas de setState direct dans l'effet) :
  // si le HTML est déjà en cache, il est visible dès CE rendu.
  const key = cacheKey(resolveLanguage(lang) ?? PLAIN, code);
  const [html, setHtml] = useState<string | null>(() => htmlCache.get(key) ?? null);
  const [renderedKey, setRenderedKey] = useState<string>(key);
  if (renderedKey !== key) {
    // Nouveau bloc (contenu ou langue changés) : repart du cache connu…
    setRenderedKey(key);
    setHtml(htmlCache.get(key) ?? null);
  }

  useEffect(() => {
    let cancelled = false;
    const currentKey = cacheKey(resolveLanguage(lang) ?? PLAIN, code);
    if (htmlCache.has(currentKey)) return; // déjà rendu depuis le cache
    codeBlockHtml(code, lang)
      .then((h) => {
        if (!cancelled) setHtml(h);
      })
      .catch(() => {
        /* colorisation impossible : l'appelant garde le texte brut */
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return html;
}
