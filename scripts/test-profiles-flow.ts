// QA du chantier v2.4 « profils + système » (2026-11-14).
// Partie LIB (navigateur stubbé, même discipline que test-settings-registry) :
// parse/serialize, résumé, capture/applique avec retour au défaut, tolérance
// aux JSON corrompus et aux clés inconnues.
// Partie SERVICE (socket :3003) : aller-retour settings hermes.profiles +
// broadcast, événements system:renderCache/clearRenderCache, champs hello
// appRevision/chromeHeadless.
import { io } from "socket.io-client";

// ── Stub navigateur (avant l'import des libs clientes) ──────────────────
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

import {
  PROFILE_CAPTURE_KEYS,
  PROFILES_STORAGE_KEY,
  applyProfile,
  captureCurrentValues,
  parseProfiles,
  profileSummary,
  serializeProfiles,
  type ChatProfile,
} from "../src/lib/profiles";
import { readClientSetting } from "../src/lib/settings";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const socket = io("http://localhost:3003", { transports: ["websocket"] });
function emit(event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (res: any) => resolve(res ?? {}));
    else socket.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}
function waitEvent(name: string, timeoutMs = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`timeout en attendant ${name}`));
    }, timeoutMs);
    const handler = (p: any) => {
      clearTimeout(timer);
      socket.off(name, handler);
      resolve(p);
    };
    socket.on(name, handler);
  });
}

function libTests() {
  console.log("— LIB : parse / serialize —");
  check("JSON corrompu → liste vide", parseProfiles("{oops").length === 0);
  check("non-tableau → liste vide", parseProfiles('{"a":1}').length === 0);
  check("entrée sans id/name → ignorée", parseProfiles('[{"name":"x"}]').length === 0);
  const sample: ChatProfile[] = [
    {
      id: "p1",
      name: "Rédaction rapide",
      createdAt: new Date().toISOString(),
      values: {
        "hermes.model": "glm-4.6",
        "hermes.reasoning.effort": "low",
        "hermes.permissions.mode": "ask",
        "hermes.tools.web": true,
      },
    },
    {
      id: "p2",
      name: "Ancien",
      createdAt: new Date().toISOString(),
      // Une clé inconnue (rétirée du registre depuis) ne doit pas ressusciter
      values: { "hermes.model": "glm-4.6", "hermes.retired.key": 1 } as any,
    },
  ];
  const parsed = parseProfiles(serializeProfiles(sample));
  check("aller-retour serialize/parse", parsed.length === 2 && parsed[0].name === "Rédaction rapide");
  check("clé inconnue filtrée au parse", !("hermes.retired.key" in (parsed[1].values as object)));
  check("clé connue conservée", parsed[1].values["hermes.model"] === "glm-4.6");

  console.log("— LIB : capture / application —");
  // Pré-état : réglages hétérogènes. Sémantique : la capture enregistre les
  // valeurs EFFECTIVES — les clés à défaut non-nul (effort, permissions, web)
  // sont capturées avec leur défaut ; les clés à défaut null (modèle, expert)
  // sont omises quand absentes (appliquer un profil sans elles = retour au
  // défaut du registre).
  store.set("hermes-ui:hermes.model", "glm-4.6");
  store.set("hermes-ui:hermes.reasoning.effort", "high");
  store.delete("hermes-ui:hermes.tools.web");
  const captured = captureCurrentValues();
  check(
    "capture les valeurs effectives (défauts non-nuls inclus)",
    captured["hermes.model"] === "glm-4.6" &&
      captured["hermes.reasoning.effort"] === "high" &&
      captured["hermes.tools.web"] === false,
  );
  store.delete("hermes-ui:hermes.model");
  const capturedBare = captureCurrentValues();
  check(
    "clé à défaut null absente → omise de la capture",
    !("hermes.model" in capturedBare) && !("hermes.expert.seed" in capturedBare),
  );

  // Applique un profil : écrit les clés portées, remet les autres au défaut
  applyProfile(parsed[0]);
  check(
    "application écrit les clés du profil",
    readClientSetting<string>("hermes.model") === "glm-4.6" &&
      readClientSetting<string>("hermes.reasoning.effort") === "low" &&
      readClientSetting<boolean>("hermes.tools.web") === true
  );
  // Un profil sans clé expert : retour au défaut (clé supprimée, pas 0)
  store.set("hermes-ui:hermes.expert.temperature", "0.7");
  applyProfile(parsed[0]);
  check(
    "clé absente du profil → retour au défaut (pas 0)",
    store.get("hermes-ui:hermes.expert.temperature") === undefined &&
      readClientSetting<number>("hermes.expert.temperature") === null
  );

  console.log("— LIB : résumé en langage clair —");
  const s1 = profileSummary(parsed[0]);
  check(
    "résumé : modèle · effort · permissions · web",
    /glm-4\.6/.test(s1) && /effort low/.test(s1) && /web activé/.test(s1),
    s1
  );
  const empty: ChatProfile = { id: "e", name: "vide", createdAt: "", values: {} };
  check(
    "résumé d'un profil vide : reste informatif (jamais « défaut » mensonger)",
    /approbation à la demande/.test(profileSummary(empty)) && /web coupé/.test(profileSummary(empty)),
    profileSummary(empty),
  );
}

async function serviceTests() {
  console.log("— SERVICE : hermes.profiles (settings) —");
  const before = await emit("settings:get", { key: PROFILES_STORAGE_KEY });
  const list = [
    {
      id: "qa-1",
      name: "QA Profil",
      createdAt: new Date().toISOString(),
      values: { "hermes.model": "glm-4.6", "hermes.tools.web": false },
    },
  ];
  const waitBroadcast = waitEvent("settings:changed");
  const setRes = await emit("settings:set", {
    key: PROFILES_STORAGE_KEY,
    value: JSON.stringify(list),
  });
  check("settings:set accepté", setRes?.ok === true);
  const broad = await waitBroadcast;
  check(
    "broadcast settings:changed porte la clé",
    broad?.key === PROFILES_STORAGE_KEY && Array.isArray(JSON.parse(broad?.value ?? "[]")),
  );
  const after = await emit("settings:get", { key: PROFILES_STORAGE_KEY });
  check("aller-retour : la liste relue est identique", JSON.parse(after.value ?? "[]")[0]?.name === "QA Profil");
  // Restaure l'état d'avant (ou efface)
  await emit("settings:set", { key: PROFILES_STORAGE_KEY, value: before.value ?? "" });

  console.log("— SERVICE : système / rendu —");
  const stats = await emit("system:renderCache");
  check(
    "system:renderCache → { count, bytes }",
    typeof stats?.count === "number" && typeof stats?.bytes === "number",
    `count=${stats?.count} bytes=${stats?.bytes}`,
  );
  const cleared = await emit("system:clearRenderCache");
  check(
    "system:clearRenderCache → removed/kept + stats fraîches",
    typeof cleared?.removed === "number" && typeof cleared?.kept === "number" && cleared.count <= (stats.count ?? 0),
    `removed=${cleared?.removed} kept=${cleared?.kept}`,
  );

  console.log("— SERVICE : hello (sondes v2.4) —");
  const hello = await new Promise<any>((resolve) => socket.emit("hello", (res: any) => resolve(res ?? {})));
  check(
    "hello.appRevision : string 7 car. ou null (installation sans git)",
    hello.appRevision === null || (/^[0-9a-f]{7}$/.test(hello.appRevision) ? true : false),
    `appRevision=${hello.appRevision}`,
  );
  check(
    "hello.chromeHeadless : present|absent",
    hello.chromeHeadless === "present" || hello.chromeHeadless === "absent",
    `chromeHeadless=${hello.chromeHeadless}`,
  );
}

async function main() {
  await new Promise<void>((resolve) => {
    if (socket.connected) resolve();
    else socket.once("connect", () => resolve());
  });
  libTests();
  await serviceTests();
  socket.close();
  console.log(failures === 0 ? "TOUS OK — profils & système" : `${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERREUR:", e);
  process.exit(1);
});
