// Test de régression Lot 1 — gardes de source (audit L1-2 et L1-5) : deux
// correctifs d'une ligne fragile que la compilation ne détecte pas (le code
// compile même sans l'import — c'était le crash) et que la capture du fil
// d'une autre conversation ne révèle qu'à l'usage.
//   1. webchat/engine.ts importe `resolve` (sinon ReferenceError dès qu'un
//      site piloté produit des fichiers) et s'en sert pour borner le chemin ;
//   2. src/hooks/use-hermes-chat.ts : l'ack de conversations:open compare à
//      activeIdRef AVANT de couper le spinner (sinon navigation A→B→C rapide,
//      l'ack tardif de A écrase le fil de C) ;
//   3. chaque handler stream:*/mode:flow/artifact:* porte la garde
//      activeIdRef — les deltas d'une conversation en vol ne fuient pas dans
//      celle qu'on vient d'ouvrir.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

async function main() {
  console.log("[1] webchat/engine.ts : import resolve (L1-2)");
  const engine = read("mini-services/hermes-chat/webchat/engine.ts");
  check("resolve est importé depuis node:path",
    engine.includes(`import { join, resolve } from "node:path"`));
  check("le bornage du chemin utilise resolve(safe)/resolve(path)",
    /resolve\(safe\)\s*!==\s*resolve\(path\)/.test(engine));

  console.log("[2] use-hermes-chat.ts : ack conversations:open (L1-5)");
  const hook = read("src/hooks/use-hermes-chat.ts");
  const openIdx = hook.indexOf('"conversations:open"');
  check("l'ouverture de conversation émet conversations:open", openIdx >= 0);
  const ackWindow = hook.slice(openIdx, openIdx + 3600);
  // Fenêtre large : le corps de l'ack porte aussi le re-semis des tours en
  // vol (ré-attache « quitter puis revenir » : contenu accumulé + déroulé
  // multi-voix, ~2 000 car.) — l'invariant vérifié reste la POSITION
  // relative garde → coupure du spinner.
  const guardIdx = ackWindow.indexOf("id !== activeIdRef.current");
  const spinnerIdx = ackWindow.indexOf("setLoadingHistory(false)");
  check("l'ack porte la garde activeIdRef", guardIdx >= 0);
  check("la garde précède la coupure du spinner (l'ack tardif ne coupe pas le chargement de C)",
    guardIdx >= 0 && spinnerIdx >= 0 && guardIdx < spinnerIdx);
  const seedIdx = ackWindow.indexOf("res.live ?? []");
  check("le re-semis des tours en vol est dans l'ack, derrière la garde (l'ack tardif d'une autre conversation ne sème rien)",
    seedIdx > guardIdx && seedIdx < spinnerIdx);
  const flowIdx = ackWindow.indexOf("t.modeFlow?.length");
  check("le déroulé multi-voix (modeFlow) est ré-attaché dans l'ack, derrière la garde (le bloc des voix survit à quitter/ revenir)",
    flowIdx > guardIdx && flowIdx < spinnerIdx);

  console.log("[3] handlers stream:*/mode:flow/artifact:* : garde activeIdRef");
  // Découpage 2026-11 (FORK.md §10) : les handlers stream:*/mode:flow vivent
  // dans use-chat-stream.ts, les handlers conversationnels restent dans
  // l'orchestrateur — la garde activeIdRef est vérifiée là où le handler EST.
  const streamHook = read("src/hooks/use-chat-stream.ts");
  const guarded: { name: string; file: string }[] = [
    { name: "onStreamStart", file: "stream" },
    { name: "onStreamDelta", file: "stream" },
    { name: "onStreamReasoning", file: "stream" },
    { name: "onStreamStatus", file: "stream" },
    { name: "onStreamTool", file: "stream" },
    { name: "onStreamDone", file: "stream" },
    { name: "onStreamError", file: "stream" },
    { name: "onModeFlow", file: "stream" },
    { name: "onArtifactDelta", file: "hook" },
    { name: "onArtifactCreated", file: "hook" },
    { name: "onArtifactUpdated", file: "hook" },
    { name: "onMessageAppended", file: "hook" },
    { name: "onMessagesRemoved", file: "hook" },
    { name: "onMessagesSuperseded", file: "hook" },
    { name: "onMessagesRefreshed", file: "hook" },
  ];
  for (const { name: h, file } of guarded) {
    const target = file === "stream" ? streamHook : hook;
    const m = new RegExp(`const ${h} = \\((?:[^{]|\\{[^}]*\\})*\\)\\s*=>\\s*\\{`).exec(target);
    if (!m) {
      check(`handler ${h} présent`, false, "introuvable — signature changée ?");
      continue;
    }
    const end = target.indexOf("\n    };", m.index);
    const body = target.slice(m.index, end > 0 ? end : m.index + 2000);
    check(`handler ${h} filtre par activeIdRef`, body.includes("activeIdRef.current"));
  }

  console.log(failures === 0 ? "\nGardes de source : 0 échec" : `\nGardes de source : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
