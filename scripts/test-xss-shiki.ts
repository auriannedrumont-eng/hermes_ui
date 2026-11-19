// Vérification sécurité : shiki échappe-t-il le HTML hostile dans le code ?
// (constat "à vérifier" de la review — on tranche par l'expérience)
import { codeBlockHtml } from "../src/lib/highlight";

const hostile = [
  'const x = "<img src=x onerror=alert(1)>";',
  '<script>alert("XSS")</script>',
  'evil = `</code><img src=x onerror=alert(2)>`',
  'link = "[click](javascript:alert(3))"',
].join("\n");

const html = await codeBlockHtml(hostile, "javascript");

const checks = [
  ["<script> échappé", !html.includes("<script>alert")],
  ["onerror= brut absent (échappé en &lt;)", !html.includes("<img src=x onerror")],
  ["</code> injecté absent", !html.includes("</code><img")],
  ["HTML shiki produit", html.startsWith("<pre")],
];
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "OK " : "ÉCHEC"}  ${label}`);
  if (!ok) bad++;
}
// Montrer un extrait pour preuve
const idx = html.indexOf("script");
console.log("\nExtrait autour de 'script' :", JSON.stringify(html.slice(Math.max(0, idx - 40), idx + 40)));
process.exit(bad === 0 ? 0 : 1);
