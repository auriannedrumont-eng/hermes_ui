// Vérification WCAG des couples de tokens (passe 3 P3, méthode oklch → sRGB → contraste).
// Usage : bun scripts/contrast.mjs — affiche chaque couple et son ratio, échoue sous AA.
const PAIRS = [
  // [nom, fg, bg] — valeurs identiques à globals.css (clair puis sombre)
  ["foreground / background (clair)", [0.19, 0.004, 60], [0.988, 0.002, 80]],
  ["muted-foreground / background (clair)", [0.51, 0.01, 60], [0.988, 0.002, 80]],
  ["hermes-foreground / hermes-strong (clair, bouton primaire)", [0.99, 0.002, 80], [0.55, 0.16, 42]],
  ["hermes-text / card (clair, libellés d'accent)", [0.55, 0.16, 42], [1, 0, 0]],
  ["warning / background (clair)", [0.55, 0.12, 62], [0.988, 0.002, 80]],
  ["success / background (clair)", [0.52, 0.115, 163], [0.988, 0.002, 80]],
  ["destructive / background (clair)", [0.577, 0.245, 27.325], [0.988, 0.002, 80]],
  ["warning-foreground / warning (clair)", [0.99, 0.002, 80], [0.55, 0.12, 62]],
  ["foreground / background (sombre)", [0.93, 0.003, 80], [0.19, 0.003, 60]],
  ["muted-foreground / background (sombre)", [0.69, 0.006, 70], [0.19, 0.003, 60]],
  ["hermes-foreground / hermes-strong (sombre, bouton primaire)", [0.16, 0.01, 45], [0.72, 0.16, 48]],
  ["hermes-text / card (sombre, libellés d'accent)", [0.72, 0.16, 48], [0.235, 0.003, 60]],
  ["warning / background (sombre)", [0.75, 0.14, 70], [0.19, 0.003, 60]],
  ["success / background (sombre)", [0.765, 0.13, 163], [0.19, 0.003, 60]],
  ["destructive / background (sombre)", [0.704, 0.191, 22.216], [0.19, 0.003, 60]],
  ["warning-foreground / warning (sombre)", [0.16, 0.01, 45], [0.75, 0.14, 70]],
];

// oklch → sRGB (méthode CSS Color 4), puis luminance relative WCAG.
function oklchToSrgb([l, c, hDeg]) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  let r = +4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  let g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  let bl = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;
  const enc = (v) => {
    const cl = Math.min(Math.max(v, 0), 1);
    return cl <= 0.0031308 ? 12.92 * cl : 1.055 * cl ** (1 / 2.4) - 0.055;
  };
  return [enc(r), enc(g), enc(bl)];
}
function relLum([r, g, b]) {
  // WCAG linéarise les valeurs sRGB encodées (formule propre à WCAG 2.x).
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(fg, bg) {
  const l1 = relLum(oklchToSrgb(fg));
  const l2 = relLum(oklchToSrgb(bg));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

let fail = 0;
for (const [name, fg, bg] of PAIRS) {
  const r = ratio(fg, bg);
  const ok = r >= 4.5;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${r.toFixed(2).padStart(5)}  ${name}`);
}
console.log(fail === 0 ? "\nTous les couples ≥ 4,5:1 (AA texte)" : `\n${fail} couple(s) sous AA !`);
process.exit(fail === 0 ? 0 : 1);
