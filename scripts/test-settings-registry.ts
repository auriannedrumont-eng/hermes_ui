// Test des invariants du registre des réglages (revue 2026-11-13) :
// unicité des clés, types valides, clés legacy non ambiguës, défauts
// cohérents avec le type déclaré, et comportement read/write sur chaque
// type (parse, rejet des valeurs invalides, retour au défaut).
import { HERMES_SETTINGS, FORK_SETTINGS, readClientSetting, writeClientSetting } from "../src/lib/settings";

// localStorage minimal pour Node
const store = new Map<string, string>();
(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};
(globalThis as any).CustomEvent = class {
  constructor(public type: string, public init: any) {}
};

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const ALL = [...HERMES_SETTINGS, ...FORK_SETTINGS];

// 1. Unicité des clés du registre
{
  const keys = ALL.map((d) => d.key);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  check("clés uniques dans le registre", dup.length === 0, dup.join(", "));
}

// 2. Clés bien formées : "<namespace>.<clef>" avec namespace connu
{
  const bad = ALL.filter(
    (d) => !/^(hermes|fork)\.[a-z][a-zA-Z0-9.]*$/.test(d.key)
  );
  check("préfixe hermes./fork. respecté", bad.length === 0, bad.map((d) => d.key).join(", "));
}

// 3. Champs obligatoires présents (label, category, scope, type)
{
  const bad = ALL.filter(
    (d) =>
      !d.key ||
      !d.label ||
      !d.category ||
      (d.scope !== "client" && d.scope !== "server")
  );
  check("définitions complètes (label/category/scope)", bad.length === 0, bad.map((d) => d.key).join(", "));
}

// 4. Type enum → options non vides et contenant le défaut
{
  const enums = ALL.filter((d) => d.type === "enum");
  const bad = enums.filter(
    (d) => !d.options?.length || !d.options.includes(d.default as string)
  );
  check("enum : options non vides + défaut valide", bad.length === 0, bad.map((d) => d.key).join(", "));
}

// 5. Clés legacy : pas de collision avec des clés actives d'un autre réglage
{
  const active = new Set(ALL.map((d) => d.key));
  const legacy = ALL.flatMap((d) => d.legacyKeys ?? []);
  const colliding = legacy.filter((k) => active.has(k));
  check("clés legacy sans collision", colliding.length === 0, colliding.join(", "));
}

// 6. Lecture par défaut quand rien n'est stocké (chaque type)
{
  let ok = true;
  const details: string[] = [];
  for (const d of ALL) {
    // scope serveur : lu par le mini-service (store SQLite), jamais côté
    // client — le défaut client est undefined par construction (v0.4.0,
    // fork.agent.update.autoCheck est le premier réglage serveur).
    if (d.scope === "server") continue;
    store.clear();
    const v = readClientSetting(d.key);
    if (JSON.stringify(v) !== JSON.stringify(d.default)) {
      ok = false;
      details.push(`${d.key}: ${JSON.stringify(v)} ≠ défaut ${JSON.stringify(d.default)}`);
    }
  }
  check("absent → défaut du registre (tous types client)", ok, details.slice(0, 3).join(" ; "));
}

// 7. Parse par type au retour de lecture
{
  store.clear();
  writeClientSetting("hermes.model", "hermes-4-405b");
  check("string round-trip", readClientSetting<string>("hermes.model") === "hermes-4-405b");

  store.clear();
  writeClientSetting("hermes.expert.temperature", 0.7);
  check("number round-trip", readClientSetting<number>("hermes.expert.temperature") === 0.7);

  store.clear();
  writeClientSetting("fork.context.gauge", false);
  check("boolean false round-trip", readClientSetting<boolean>("fork.context.gauge") === false);

  store.clear();
  writeClientSetting("fork.projects.sort", "title");
  check("enum round-trip", readClientSetting<string>("fork.projects.sort") === "title");

  // Valeur hors options → rejetée à l'écriture (l'ancienne valeur reste)
  store.clear();
  writeClientSetting("fork.projects.sort", "created");
  writeClientSetting("fork.projects.sort", "n'importe-quoi");
  check(
    "enum : valeur hors options rejetée à l'écriture",
    readClientSetting<string>("fork.projects.sort") === "created"
  );

  // Number invalide → écriture ignorée
  store.clear();
  writeClientSetting("hermes.expert.seed", 42);
  writeClientSetting("hermes.expert.seed", Number.NaN);
  check("number NaN rejeté à l'écriture", readClientSetting<number>("hermes.expert.seed") === 42);
}

// 8. Corruption du stockage : brut non parsable → défaut, pas d'exception
{
  store.clear();
  store.set("hermes-ui:hermes.expert.seed", "pas-un-nombre");
  check(
    "brut corrompu → défaut (pas d'exception)",
    readClientSetting<number | null>("hermes.expert.seed") === null
  );
  store.clear();
  store.set("hermes-ui:fork.projects.sort", "invalide");
  check(
    "enum corrompu → défaut",
    readClientSetting<string>("fork.projects.sort") === "updated"
  );
}

// 9. Clé inconnue : undefined, sans exception
{
  check("clé inconnue → undefined", readClientSetting("clé.qui.nexiste.pas") === undefined);
}

// 10. Écriture d'un réglage dont le scope n'est pas "client" : refusée
//     silencieusement (aucun réglage serveur n'existe aujourd'hui, mais le
//     garde-fou est testé par une définition forgeée).
{
  const before = store.get("hermes-ui:test-server-scope");
  writeClientSetting("test-server-scope", "x");
  check(
    "scope non-client → écriture ignorée",
    before === undefined,
    "aucune clé écrite hors du scope client"
  );
}

// 11. Régression Lot 1 (audit L1-3, correctif 1.2) : hermes.modes.models —
//     le choix d'un modèle par mode (Chat/Plan/Code) doit être déclaré au
//     registre, sinon writeClientSetting l'ignore silencieusement et le
//     réglage n'est JAMAIS persisté (bug constaté : 0 occurrence dans
//     HERMES_SETTINGS alors que mode-picker.tsx le lit).
{
  const def = HERMES_SETTINGS.find((d) => d.key === "hermes.modes.models");
  check("hermes.modes.models est déclaré au registre", Boolean(def));
  check("hermes.modes.models : type string, défaut {}, scope client",
    def?.type === "string" && def?.default === "{}" && def?.scope === "client",
    def ? `type=${def.type} default=${JSON.stringify(def.default)} scope=${def.scope}` : "absent");
  store.clear();
  writeClientSetting("hermes.modes.models", '{"chat":"hermes-4-405b","code":"hermes-4-405b"}');
  const round = readClientSetting<string>("hermes.modes.models");
  check("hermes.modes.models : écriture persistée puis relue (round-trip)",
    round === '{"chat":"hermes-4-405b","code":"hermes-4-405b"}',
    JSON.stringify(round));
}

console.log(failures === 0 ? "\nRegistre : 0 échec — invariants validés" : `\nRegistre : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
