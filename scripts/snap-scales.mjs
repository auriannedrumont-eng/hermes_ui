// Snap mécanique des échelles déclarées (audit passe 2 C3, passe 3 P5-P7).
// Chaque règle est appliquée à tous les fichiers src/**/*.{ts,tsx} et comptée.
// Exclusions : artifact-panel.tsx + artifact-card.tsx pour la migration des
// couleurs brutes (surface diff GitHub-dark fixe + carte TINT — exception
// documentée dans globals.css).
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const counts = {};
const COLOR_EXCLUDED = new Set([
  "artifact-panel.tsx",
  "artifact-card.tsx",
]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return extname(p) === ".tsx" || extname(p) === ".ts" ? [p] : [];
  });
}

function rule(label, fn, files) {
  let n = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const out = fn(src, f);
    if (out !== src) {
      n += countFor(label, src, out, f);
      writeFileSync(f, out);
    }
  }
  counts[label] = (counts[label] ?? 0) + n;
}

// Comptage générique : nombre de correspondances du motif dans l'ancien texte.
const pending = new Map(); // label -> regex source
function countFor(label, src, out) {
  const re = pending.get(label);
  if (!re) return 0;
  return (src.match(re) ?? []).length;
}

const files = walk(ROOT).filter((f) => !f.includes("/app/api/"));

// ── 1. Texte : 7 crans (11 · 12.5 · 14 · 15 · 17 · 19 · 26) ─────────────
const TEXT = [
  ["texte 9.5/10/10.5/11.5 → 11", /text-\[(?:9\.5|10|10\.5|11\.5)px\]/g, "text-[11px]"],
  ["texte 12/13 → 12.5", /text-\[(?:12|13)px\]/g, "text-[12.5px]"],
  ["texte 13.5/14.5 → 14", /text-\[(?:13\.5|14\.5)px\]/g, "text-[14px]"],
  ["texte 15.5 → 15", /text-\[15\.5px\]/g, "text-[15px]"],
  ["texte 21/26 → 19", /text-\[(?:21|26)px\]/g, "text-[19px]"],
  ["texte 30 → 26", /text-\[30px\]/g, "text-[26px]"],
];
for (const [label, re, to] of TEXT) {
  pending.set(label, re);
  rule(label, (src) => src.replace(re, to), files);
}

// ── 2. Rayons : tokens sm 8 / md 10 / lg 12 / xl 14 / 2xl 22 ────────────
const RADIUS = [
  ["rayon [7px] → sm", /rounded-\[7px\]/g, "rounded-sm"],
  ["rayon [8px] → sm", /rounded-\[8px\]/g, "rounded-sm"],
  ["rayon [9px] → md", /rounded-\[9px\]/g, "rounded-md"],
  ["rayon [10px] → md", /rounded-\[10px\]/g, "rounded-md"],
  ["rayon [11px] → md", /rounded-\[11px\]/g, "rounded-md"],
  ["rayon [12px] → lg", /rounded-\[12px\]/g, "rounded-lg"],
  ["rayon [13px] → lg", /rounded-\[13px\]/g, "rounded-lg"],
  ["rayon [14px] → xl", /rounded-\[14px\]/g, "rounded-xl"],
  ["rayon [15-17px] → xl", /rounded-\[(?:15|16|17)px\]/g, "rounded-xl"],
  ["rayon [18px+] → 2xl", /rounded-\[(?:18|2[0-9]|3[0-9])px\]/g, "rounded-2xl"],
];
for (const [label, re, to] of RADIUS) {
  pending.set(label, re);
  rule(label, (src) => src.replace(re, to), files);
}

// ── 3. Hauteurs de contrôle : h-6/h-7 micro, h-8/h-9 Button ─────────────
const HEIGHTS = [
  ["h-[26px] → h-6", /h-\[26px\]/g, "h-6"],
  ["h-[28px] → h-7", /h-\[28px\]/g, "h-7"],
  ["h-[30px] → h-8", /h-\[30px\]/g, "h-8"],
  ["h-[31px] → h-8", /h-\[31px\]/g, "h-8"],
  ["h-[32px] → h-8", /h-\[32px\]/g, "h-8"],
  ["h-[34px] → h-9", /h-\[34px\]/g, "h-9"],
];
for (const [label, re, to] of HEIGHTS) {
  pending.set(label, re);
  rule(label, (src) => src.replace(re, to), files);
}

// ── 4. Gaps : 5 → 1 (4), 6 → 1.5 (6), 7 → 2 (8) ─────────────────────────
const GAPS = [
  ["gap 5 → gap-1", /gap-\[5px\]/g, "gap-1"],
  ["gap 6 → gap-1.5", /gap-\[6px\]/g, "gap-1.5"],
  ["gap 7 → gap-2", /gap-\[7px\]/g, "gap-2"],
];
for (const [label, re, to] of GAPS) {
  pending.set(label, re);
  rule(label, (src) => src.replace(re, to), files);
}

// ── 5. Opacité désactivée : 40 unique ───────────────────────────────────
{
  const re = /disabled:opacity-(?:30|45|50|60)\b/g;
  pending.set("opacité désactivée → 40", re);
  rule("opacité désactivée → 40", (src) => src.replace(re, "disabled:opacity-40"), files);
}

// ── 6. Popovers jumeaux : 354 → 352 ─────────────────────────────────────
{
  const re = /w-\[354px\]/g;
  pending.set("popover 354 → 352", re);
  rule("popover 354 → 352", (src) => src.replace(re, "w-[352px]"), files);
}

// ── 7. Trait d'icône : 2 par défaut · 2.5 en accent (4.5 Ring légitime) ─
{
  const re = /strokeWidth=(?:"(?:1\.[0-9]+|2\.[1-46-9])"|\{(?:1\.[0-9]+|2\.[1-46-9])\})/g;
  pending.set("strokeWidth → 2", re);
  rule("strokeWidth → 2", (src) => src.replace(re, "strokeWidth={2}"), files);
}

// ── 8. Palette brute → tokens d'état AA (sauf surface diff + TINT) ──────
const colorFiles = files.filter((f) => !COLOR_EXCLUDED.has(f.split("/").pop()));
function migrateColors(src) {
  let s = src;
  s = s.replace(/\b(?:(?:bg|border|text|ring|via|from|to|fill|stroke|outline|ring-offset)-)(?:amber|emerald|red)-[0-9]+(?:\/[0-9]+)?\b/g, (m) => {
    if (m.startsWith("fill-") || m.startsWith("stroke-")) {
      const token = m.includes("amber") ? "warning" : m.includes("emerald") ? "success" : "destructive";
      return m.slice(0, m.indexOf("-") + 1) + token;
    }
    const kind = m.startsWith("bg-") ? "bg" : m.startsWith("border-") ? "border"
      : m.startsWith("ring-") ? "ring" : m.startsWith("text-") ? "text" : m.slice(0, m.indexOf("-"));
    const alpha = m.includes("/") ? `/${m.split("/")[1]}` : "";
    const token = m.includes("amber") ? "warning" : m.includes("emerald") ? "success" : "destructive";
    return `${kind}-${token}${alpha}`;
  });
  // Paire light/dark redondante : "text-warning dark:text-warning" → "text-warning"
  s = s.replace(/((?:bg|border|ring)-(?:warning|success|destructive)(?:\/[0-9]+)?) dark:\1\b/g, "$1");
  s = s.replace(/(text-(?:warning|success|destructive)) dark:\1\b/g, "$1");
  return s;
}
{
  const re = /\b(?:bg|border|text|ring|via|from|to)-(?:amber|emerald|red)-[0-9]+(?:\/[0-9]+)?\b/g;
  pending.set("palette brute → tokens", re);
  let n = 0;
  for (const f of colorFiles) {
    const src = readFileSync(f, "utf8");
    const out = migrateColors(src);
    if (out !== src) {
      n += (src.match(re) ?? []).length;
      writeFileSync(f, out);
    }
  }
  counts["palette brute → tokens"] = n;
}

// ── 9. Libellés d'accent : text-hermes → text-hermes-text (AA) ──────────
{
  const re = /(?<![-\w])text-hermes(?![-\w])/g;
  pending.set("libellés text-hermes → hermes-text", re);
  rule("libellés text-hermes → hermes-text", (src) => src.replace(re, "text-hermes-text"), files);
}

// ── 10. Damier hsl(oklch()) invalide → var(--muted) nu (C8.4) ───────────
{
  const re = /hsl\(var\(--muted\)\)/g;
  pending.set("damier hsl(oklch()) → muted", re);
  rule("damier hsl(oklch()) → muted", (src) => src.replace(re, "var(--muted)"), files);
}

// ── 11. var(--amber, #d97706) fantôme → token --warning (C8.3) ──────────
{
  const re = /var\(--amber,\s*#d97706\)/g;
  pending.set("var(--amber,...) → --warning", re);
  rule("var(--amber,...) → --warning", (src) => src.replace(re, "var(--warning)"), files);
}

console.log("Snap terminé :");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(40)} ${v}`);
