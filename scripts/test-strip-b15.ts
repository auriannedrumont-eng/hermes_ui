// Test ciblé B15 : stripArtifactBlocks ne doit plus avaler le texte
// situé entre un bloc de code normal et un bloc artefact suivant.
import { stripArtifactBlocks } from "../src/lib/artifact-utils";

const entree = [
  "Voici un extrait :",
  "```ts",
  "const a = 1;",
  "```",
  "Texte entre les deux blocs qui doit rester visible.",
  "```html file=\"rapport.html\"",
  "<p>doc</p>",
  "```",
  "Conclusion.",
].join("\n");

const sortie = stripArtifactBlocks(entree);
let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "OK  " : "ECHEC"} ${label}`);
  if (!ok) failures++;
};
check("extrait ts conservé", sortie.includes("```ts"));
check("contenu du bloc normal conservé", sortie.includes("const a = 1;"));
check("texte intermédiaire conservé", sortie.includes("Texte entre les deux blocs"));
check("bloc artefact retiré", !sortie.includes("<p>doc</p>"));
check("conclusion conservée", sortie.includes("Conclusion."));
// Bloc artefact en stream (non fermé) toujours retiré.
const enVol = stripArtifactBlocks("Avant\n```html file=\"x.html\"\n<p>en cours</p>");
check("artefact ouvert retiré", !enVol.includes("en cours") && enVol.includes("Avant"));
// Bloc normal non fermé : rien ne doit être avalé après lui.
const nonFermé = stripArtifactBlocks("Intro\n```ts\nconst b = 2;\nSuite du texte");
check("bloc normal non fermé + suite", nonFermé.includes("const b = 2;") && nonFermé.includes("Suite du texte"));
process.exit(failures === 0 ? 0 : 1);
