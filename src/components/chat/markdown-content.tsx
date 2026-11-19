// Rendu Markdown façon ChatGPT : blocs de code colorés avec copie, tableaux, liens.
// Perf 2026-11-19 : blocs de code migrés de react-syntax-highlighter (Prism
// complet, re-tokenisé à chaque re-rendu) vers shiki (src/lib/highlight.ts) ;
// MarkdownContent mémoïsé — pendant un tour, seules les bulles dont le
// contenu change re-rendent, et un bloc de code n'est JAMAIS re-tokenisé
// (cache LRU par contenu, cf. useHighlightedCode).
// Revue 2026-11-19, M-2 (P) : prop `plain` — pendant le STREAMING, les blocs
// de code sont rendus en texte brut (même motif que LiveSourceView du panneau
// d'artefacts). Avant, chaque rafraîchissement coalescé (200 ms) re-tokenisait
// TOUT le bloc en croissance via shiki (coût quadratique sur le tour) et
// polluait le cache LRU de préfixes morts. La colorisation arrive à la
// clôture du tour, quand le contenu devient immuable.
"use client";

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import {
  useHighlightedCode,
  CODE_CONTAINER_STYLE,
  CODE_FONT_FAMILY,
} from "@/lib/highlight";

function CodeBlock({
  lang,
  code,
  plain,
}: {
  lang?: string;
  code: string;
  plain?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard indisponible */
    }
  };

  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-zinc-700/60 bg-[#0d1117]">
      <div className="flex items-center justify-between border-b border-zinc-700/60 bg-[#161b22] px-3.5 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-zinc-400">
          {lang ?? "texte"}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-700/50 hover:text-zinc-200"
          aria-label="Copier le code"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copié" : "Copier"}
        </button>
      </div>
      {/* `plain` (streaming) : texte brut, jamais shiki — le bloc croît à
          chaque rafraîchissement, le coloriser coûterait quadratiquement.
          Même visuel que le repli de première initialisation. */}
      {plain ? (
        <pre
          style={{ ...CODE_CONTAINER_STYLE, fontFamily: CODE_FONT_FAMILY }}
          className="overflow-x-auto p-[0.85rem_1rem]"
        >
          <code>{code}</code>
        </pre>
      ) : (
        // shiki rend un <pre><code> colorié ; le temps du premier rendu
        // (highlighter en initialisation), le texte brut sur le même fond
        // sombre — flash invisible en pratique.
        <HighlightedCode code={code} lang={lang} />
      )}
    </div>
  );
}

/** Bloc colorisé shiki avec repli texte brut. Mémoïsé : un bloc affiché
 *  deux fois (versions d'une réponse, partage) ne re-colorise jamais. */
const HighlightedCode = memo(function HighlightedCode({
  code,
  lang,
}: {
  code: string;
  lang?: string;
}) {
  const html = useHighlightedCode(code, lang);
  if (!html) {
    return (
      <pre
        style={{ ...CODE_CONTAINER_STYLE, fontFamily: CODE_FONT_FAMILY }}
        className="overflow-x-auto p-[0.85rem_1rem]"
      >
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <div
      className="shiki-host overflow-x-auto [&_pre]:!my-0 [&_pre]:!py-[0.85rem] [&_pre]:px-[1rem] [&_pre]:!bg-transparent [&_code]:!font-[var(--font-geist-mono),ui-monospace,monospace]"
      style={CODE_CONTAINER_STYLE}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export const MarkdownContent = memo(function MarkdownContent({
  content,
  plain = false,
}: {
  content: string;
  /** M-2 : blocs de code en texte brut (streaming) — pas de shiki. */
  plain?: boolean;
}) {
  return (
    <div className="text-[15px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: (props) => {
            const { className, children } = props as {
              className?: string;
              children?: React.ReactNode;
            };
            const text = String(children ?? "");
            const match = /language-(\w+)/.exec(className ?? "");
            if (!match && !text.includes("\n")) {
              return (
                <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[12.5px]">
                  {children}
                </code>
              );
            }
            return <CodeBlock lang={match?.[1]} code={text} plain={plain} />;
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-hermes-text underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border">
              <table className="w-full text-[14px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b bg-muted px-3 py-2 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b px-3 py-2 align-top">{children}</td>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
          ),
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 text-xl font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-hermes pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-border" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
