// QA scénario « problème » (v3) : état rouge AUTHENTIQUE de la carte
// Hermes, par le VRAI service. Ingrédients :
//  - binaire `hermes` factice : --version → 4.3.0 (versionLue lisible),
//    toute autre commande → exit 1 ;
//  - gateway 9120 éteinte : le contrôle (agent:check-request) échoue
//    honnêtement (« la gateway ne répond pas ») ;
//  - carnet : maj réussie récente (< 24 h) + previousVersion 4.2.1 —
//    c'est la conjonction « maj récente + contrôle échoué + version
//    lisible » qui allume l'état rouge (logique v0.4, inchangée).
// Le carnet et le filet sont posés DANS LA BASE du service QA (la même
// que le service lira au démarrage) via le Store du service.
// Usage : bun run scripts/qa-v3-pb-scenario.ts   (POSER la base)
//         puis relancer le service avec HERMES_AGENT_BIN=/tmp/qa-v3-pb/hermes
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/qa-v3-pb";
const DB = join(ROOT, "hermes-chat.sqlite");

mkdirSync(ROOT, { recursive: true });

// 1. Binaire factice.
writeFileSync(
  join(ROOT, "hermes"),
  `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "hermes-agent 4.3.0"
  exit 0
fi
exit 1
`,
  "utf-8"
);
chmodSync(join(ROOT, "hermes"), 0o755);

// 2. Base : carnet (maj réussie récente) + filet previousVersion.
process.env.HERMES_CHAT_DB = DB;
process.env.HERMES_AGENT_BIN = join(ROOT, "hermes");
const { Store } = await import("../mini-services/hermes-chat/store");
const M = await import("../mini-services/hermes-chat/agent-motor");

const store = new Store();
// Carnet : d'abord la version d'avant (il y a 2 h), puis la maj réussie
// (il y a 1 h) — le carnet est une liste bornée, journalAppend empile.
const ilYA = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
// On vide puis on empile dans l'ordre chronologique.
store.setSetting(M.AGENT_JOURNAL_KEY, JSON.stringify([]));
const { journalAppend } = M as unknown as {
  journalAppend: (s: { setSetting: (k: string, v: string) => void; getSetting: (k: string) => string | null }, e: unknown) => void;
};
journalAppend(store, {
  id: "qa-v3-1",
  at: ilYA(2),
  type: "version",
  label: "Vérification — tout est à jour",
  resultat: "ok",
});
journalAppend(store, {
  id: "qa-v3-2",
  at: ilYA(1),
  type: "maj",
  label: "Mise à jour du moteur Hermes",
  version: "4.3.0",
  resultat: "ok",
  detail: "4.2.1 → 4.3.0",
});
store.setSetting(M.AGENT_PREVIOUS_KEY, "4.2.1");
store.setSetting(M.AGENT_INSTALLED_KEY, "4.3.0");

console.log("Base QA posée :", DB);
console.log("Binaire factice :", join(ROOT, "hermes"), "(--version → 4.3.0)");
console.log("Relancer le service ainsi :");
console.log(
  `  cd mini-services/hermes-chat && HERMES_CHAT_DB=${DB} HERMES_AGENT_BIN=${join(ROOT, "hermes")} bun run index.ts`
);
process.exit(0);
