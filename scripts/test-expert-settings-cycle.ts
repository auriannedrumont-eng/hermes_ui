// Test B1 (revue 2026-11-13) : cycle complet du mode expert — écriture d'une
// valeur, vidage du champ, RELECTURE après « rechargement » (localStorage
// simulé). Avant correctif : le vidage persistait "0" (Number(null)) et la
// valeur revenait comme 0 au rechargement. Après correctif : la clé est
// effacée, la relecture renvoie le défaut du registre (null).
import { readClientSetting, writeClientSetting, deleteClientSetting } from "../src/lib/settings";

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

const KEYS = ["hermes.expert.temperature", "hermes.expert.maxTokens", "hermes.expert.seed"];
let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

// 1. Écriture normale
writeClientSetting("hermes.expert.temperature", 0.7);
check("écriture 0.7 lisible", readClientSetting<number | null>("hermes.expert.temperature") === 0.7);
check("brut stocké = \"0.7\"", store.get("hermes-ui:hermes.expert.temperature") === "0.7");

// 2. Le VIEUX comportement (write null) pour démontrer le bug
writeClientSetting("hermes.expert.seed", null as any);
check("BUG historique : write(null) stocke \"0\"", store.get("hermes-ui:hermes.expert.seed") === "0");

// 3. Le correctif : deleteClientSetting efface
deleteClientSetting("hermes.expert.seed");
check("delete retire la clé", store.get("hermes-ui:hermes.expert.seed") === undefined);
check("relecture après delete = défaut null", readClientSetting<number | null>("hermes.expert.seed") === null);

// 4. Même logique que setExpert corrigé : présent → write, absent → delete
const persist = (key: string, v: number | undefined) => {
  if (v === undefined) deleteClientSetting(key);
  else writeClientSetting(key, v);
};
persist("hermes.expert.maxTokens", 512);
check("persist 512 stocké", readClientSetting<number | null>("hermes.expert.maxTokens") === 512);
persist("hermes.expert.maxTokens", undefined);
check("persist undefined → clé absente", readClientSetting<number | null>("hermes.expert.maxTokens") === null);

// 5. Les trois clés expert sont dans le registre (effaçables sans exception,
//    et la clé brute disparaît bien du stockage)
for (const k of KEYS) {
  writeClientSetting(k, 5);
  deleteClientSetting(k);
  check(`${k} effaçable (clé brute retirée)`, store.get(`hermes-ui:${k}`) === undefined);
}

// 6. Clé inconnue : silencieux, pas d'exception
deleteClientSetting("clé.inconnue");
check("clé inconnue : sans exception", true);

console.log(failures === 0 ? "\nB1 : 0 échec — correctif validé" : `\nB1 : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
