// Vues par type d'artefact + cache du source — extraits de
// artifact-panel.tsx (découpage 2026-11, FORK.md §10). Rendus PURS par type :
// code (coloration + numéros + wrap), diff ligne à ligne, tableau CSV, JSON,
// image/SVG avec zoom. Le cache borné et useArtifactSource (C-02) suivent :
// le panneau et la visionneuse plein écran partagent le même module.
"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Loader2, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Artifact } from "@/lib/chat-types";
import { artifactUrl, diffLines, parseCsv } from "@/lib/artifact-utils";
import { serviceFetchInit } from "@/lib/service";
import { useHighlightedCode, CODE_CONTAINER_STYLE, CODE_FONT_FAMILY } from "@/lib/highlight";

// ── Chargement du source (cache module partagé panneau / visionneuse) ───

// Cache borné (Lot 5, audit) : une conversation longue remplissait la carte
// sans limite ; les ÉCHECS de fetch ne sont plus mis en cache — un source
// qui a raté peut être rechargé (redimensionnement, retour d'onglet…).
const SOURCE_CACHE_MAX = 50;
const sourceCache = new Map<string, string>();

function cacheSource(id: string, text: string | null): void {
  if (text === null) {
    sourceCache.delete(id);
    return;
  }
  if (sourceCache.size >= SOURCE_CACHE_MAX && !sourceCache.has(id)) {
    const oldest = sourceCache.keys().next().value;
    if (oldest !== undefined) sourceCache.delete(oldest);
  }
  sourceCache.set(id, text);
}

export function useArtifactSource(artifact: Artifact | null): string | null {
  const [, forceRender] = useState(0);
  const artifactId = artifact?.id ?? null;
  const rawUrl = artifact?.rawUrl ?? null;
  const binaryKind = artifact?.kind === "image" || artifact?.kind === "pdf";
  // Un artefact en génération/rendering a un contenu vide ou PARTIEL en
  // base : le fetcher tant qu'il n'est pas "ready" reviendrait à figer le
  // cache sur une chaîne vide/tronquée (C-02) — et purge l'éventuel cache
  // obsolète au passage.
  const ready = artifact?.status === "ready" || artifact?.status === "error";
  const fetchable = Boolean(artifactId && rawUrl && !binaryKind && ready);

  useEffect(() => {
    if (!artifactId) return;
    if (!ready) {
      // Règle C-02 : purge du cache tant que l'artefact n'est pas terminé —
      // l'id reste stable entre artifact:created et artifact:updated, un
      // cache précoce masquerait le contenu final jusqu'au rechargement.
      cacheSource(artifactId, null);
      return;
    }
    if (!rawUrl || binaryKind) return;
    if (sourceCache.has(artifactId)) return;
    let cancelled = false;
    fetch(artifactUrl(rawUrl), serviceFetchInit())
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        cacheSource(artifactId, text);
        if (!cancelled) forceRender((n) => n + 1);
      })
      .catch(() => {
        cacheSource(artifactId, null); // pas de cache d'échec : recharge possible
        if (!cancelled) forceRender((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, rawUrl, binaryKind, ready, fetchable]);

  // null = absent ou en erreur (rechargeable) ; "" = source vide lu avec succès.
  if (!artifactId) return null;
  const cached = sourceCache.get(artifactId);
  return cached === undefined ? null : cached;
}

// ── Vues par type ────────────────────────────────────────────────────────

// Perf 2026-11-19 : CodeView migré de react-syntax-highlighter (Prism) vers
// shiki (src/lib/highlight.ts). Numéros de ligne en colonne CSS côté
// conteneur (plus de <span> par ligne générés par la lib). Mémoïsé : changer
// d'onglet ou re-rendre le panneau ne re-colorise jamais un source inchangé.
export const CodeView = memo(function CodeView({
  source,
  language,
  showLineNumbers = true,
  wrap = false,
  maxHeight,
}: {
  source: string;
  language?: string;
  showLineNumbers?: boolean;
  wrap?: boolean;
  maxHeight?: string;
}) {
  const code = source.replace(/\n$/, "");
  const html = useHighlightedCode(code, language);
  const lineCount = useMemo(() => code.split("\n").length, [code]);

  // Repli texte brut (premier rendu, grammaire absente) : mêmes couleurs,
  // mêmes numéros — la colonne CSS ci-dessous est partagée par les deux états.
  const gutter = showLineNumbers ? (
    <div
      aria-hidden="true"
      className="shrink-0 select-none border-r border-zinc-800 bg-[#161b22] px-2 py-[0.85rem] text-right text-zinc-600"
      style={{ fontFamily: CODE_FONT_FAMILY, fontSize: "12.5px", lineHeight: "1.65" }}
    >
      {Array.from({ length: lineCount }, (_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  ) : null;

  return (
    <div
      className="flex min-h-full"
      style={{ ...CODE_CONTAINER_STYLE, ...(maxHeight ? { maxHeight } : {}) }}
    >
      {gutter}
      {html ? (
        <div
          className={`min-w-0 flex-1 overflow-x-auto [&_pre]:!my-0 [&_pre]:!py-[0.85rem] [&_pre]:px-[1rem] [&_pre]:!bg-transparent [&_code]:!font-[var(--font-geist-mono),ui-monospace,monospace] ${
            wrap ? "[&_pre]:!whitespace-pre-wrap [&_pre]:!break-words" : ""
          }`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          className={`min-w-0 flex-1 overflow-x-auto py-[0.85rem] pl-[1rem] ${
            wrap ? "whitespace-pre-wrap break-words" : ""
          }`}
          style={{ fontFamily: CODE_FONT_FAMILY }}
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
});

export function DiffView({ oldSource, newSource }: { oldSource: string; newSource: string }) {
  const rows = useMemo(() => diffLines(oldSource, newSource), [oldSource, newSource]);
  const stats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const r of rows) {
      if (r.type === "add") add++;
      if (r.type === "del") del++;
    }
    return { add, del };
  }, [rows]);
  return (
    <div className="font-mono text-[12.5px] leading-relaxed">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-700/60 bg-[#161b22] px-3 py-1.5 text-[11px] text-zinc-400">
        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-400">
          +{stats.add}
        </span>
        <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-red-400">
          −{stats.del}
        </span>
        <span className="ml-auto">comparaison ligne à ligne</span>
      </div>
      <div className="overflow-x-auto bg-[#0d1117]">
        {rows.map((r, i) => (
          <div
            key={i}
            className={`flex ${
              r.type === "add"
                ? "bg-emerald-500/10"
                : r.type === "del"
                  ? "bg-red-500/10"
                  : ""
            }`}
          >
            <span className="w-10 shrink-0 select-none px-1 text-right text-zinc-600">
              {r.oldLine ?? ""}
            </span>
            <span className="w-10 shrink-0 select-none border-r border-zinc-800 pr-1 text-right text-zinc-600">
              {r.newLine ?? ""}
            </span>
            <span
              className={`w-5 shrink-0 select-none text-center ${
                r.type === "add"
                  ? "text-emerald-400"
                  : r.type === "del"
                    ? "text-red-400"
                    : "text-zinc-700"
              }`}
            >
              {r.type === "add" ? "+" : r.type === "del" ? "−" : " "}
            </span>
            <pre
              className={`flex-1 whitespace-pre-wrap px-2 ${
                r.type === "same" ? "text-zinc-300" : r.type === "add" ? "text-emerald-200" : "text-red-200"
              }`}
            >
              {r.text || " "}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CsvTableView({ source }: { source: string }) {
  const rows = useMemo(() => parseCsv(source), [source]);
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">CSV vide.</p>;
  const [head, ...body] = rows;
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {head.map((c, i) => (
              <th
                key={i}
                className="border-b px-3 py-2 text-left font-semibold whitespace-nowrap"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className={ri % 2 ? "bg-muted/30" : ""}>
              {head.map((_, ci) => (
                <td key={ci} className="border-b px-3 py-1.5 align-top whitespace-nowrap">
                  {r[ci] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JsonView({ source }: { source: string }) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      return source;
    }
  }, [source]);
  return <CodeView source={pretty} language="json" />;
}

/** Source en cours de génération : TEXTE BRUT volontaire (perf 2026-11-19).
 *  L'ancien rendu colorisé re-tokenisait tout le fichier à chaque delta
 *  (~60 Hz, coût quadratique sur les gros artefacts) ; la colorisation
 *  n'arrive qu'à l'état « ready » via CodeView. Mémoïsé sur le contenu :
 *  les re-rendus du panneau (statut, barre) ne re-rendent pas le texte. */
export const LiveSourceView = memo(function LiveSourceView({
  source,
}: {
  source: string;
}) {
  return (
    <pre
      className="whitespace-pre-wrap break-words p-[0.85rem_1rem] text-zinc-300"
      style={{
        margin: 0,
        background: "#0d1117",
        fontSize: "12.5px",
        lineHeight: 1.65,
        minHeight: "100%",
        fontFamily: CODE_FONT_FAMILY,
      }}
    >
      <code>{source}</code>
    </pre>
  );
});

/** Image / aperçu PNG avec zoom (ajuster ↔ 100 %) et déplacement au scroll. */
export function ImageView({
  src,
  alt,
  isGenerating,
  statusLabel,
}: {
  src: string;
  alt: string;
  isGenerating?: boolean;
  statusLabel?: string;
}) {
  const [fit, setFit] = useState(true);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        <Button
          variant="secondary"
          size="icon"
          className="h-7 w-7 rounded-lg shadow-sm"
          onClick={() => setFit((f) => !f)}
          aria-label={fit ? "Taille réelle" : "Ajuster à la largeur"}
          title={fit ? "Taille réelle (100 %)" : "Ajuster à la largeur"}
        >
          {fit ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
        {isGenerating ? (
          <div className="flex h-full min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-hermes-text" />
            {statusLabel ?? "Rendu de l'aperçu (Chrome)…"}
          </div>
        ) : (
          <img
            src={src}
            alt={alt}
            className={fit ? "w-full" : "w-max"}
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}
