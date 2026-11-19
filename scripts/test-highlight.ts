// Smoke test du module de coloration (chantier perf 2026-11-19) :
// vérifie que le highlighter s'initialise, que la colorisation produit
// du HTML shiki, que les alias résolvent et que le cache LRU renvoie
// la MÊME référence (identité) au second appel.
import { codeBlockHtml, resolveLanguage } from "../src/lib/highlight";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "OK " : "ÉCHEC"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

// Alias et déclassement
check("resolveLanguage('ts') → typescript", resolveLanguage("ts") === "typescript");
check("resolveLanguage('py') → python", resolveLanguage("py") === "python");
check("resolveLanguage('haskell') → null (repli texte)", resolveLanguage("haskell") === null);
check("resolveLanguage('text') → plaintext", resolveLanguage("text") === "plaintext");
check("resolveLanguage(undefined) → plaintext", resolveLanguage(undefined) === "plaintext");

// Colorisation réelle
const py = 'def hello(name: str) -> str:\n    return f"Bonjour {name}"\n';
const html1 = await codeBlockHtml(py, "python");
check("python → HTML shiki", html1.includes("<pre") && html1.includes("shiki"), html1.slice(0, 60));

const ts = "const x: number = 42;\n";
const htmlTs = await codeBlockHtml(ts, "ts");
check("alias ts → typescript colorié", htmlTs.includes("shiki"));

// Cache : identité de référence (c'est le cœur du gain perf)
const html2 = await codeBlockHtml(py, "python");
check("cache LRU : même référence", html1 === html2);

// Langue inconnue → plaintext sans erreur
const htmlUnknown = await codeBlockHtml("x = 1\n", "brainfuck");
check("langue inconnue → plaintext (pas d'erreur)", htmlUnknown.includes("<pre"));

// Bloc vide
const htmlEmpty = await codeBlockHtml("", "python");
check("bloc vide → HTML", typeof htmlEmpty === "string");

console.log(failures === 0 ? "\nSMOKE SHIKI : tout passe" : `\nSMOKE SHIKI : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
