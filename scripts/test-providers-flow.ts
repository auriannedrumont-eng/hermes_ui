// Test E2E du chantier « Paramètres v2.2 » : fournisseurs & clés (porte-clés,
// test réel, stratégie) + extensions (import GitHub réel, vérifier, épingler,
// basculer, retirer). Les données créées sont nettoyées en fin de test.
import { io } from "socket.io-client";

const socket = io("http://localhost:3003", { transports: ["websocket"] });
let failures = 0;
const createdProviderIds: string[] = [];
const createdExtensionIds: string[] = [];

function log(s: string) {
  console.log("  " + s);
}

function check(label: string, ok: boolean, extra = "") {
  if (ok) log(`OK  ${label}${extra ? ` — ${extra}` : ""}`);
  else {
    failures++;
    log(`ÉCHEC  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function emit(event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (res: any) => resolve(res ?? {}));
    else socket.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}

async function main() {
  // ── Fournisseurs ─────────────────────────────────────────────────
  const list0 = await emit("providers:list");
  check("providers:list", Array.isArray(list0.providers), `${list0.providers.length} fournisseur(s)`);

  const zai = await emit("providers:add", { name: "z.ai", kind: "llm" });
  if (zai.provider) {
    createdProviderIds.push(zai.provider.id);
    check("providers:add z.ai (llm)", zai.provider.kind === "llm" && zai.provider.keyless === false);
  } else {
    check("providers:add z.ai (llm) — déjà présent ?", !zai.error, zai.error);
  }
  const dup = await emit("providers:add", { name: "z.ai", kind: "llm" });
  check("providers:add doublon refusé", !!dup.error, dup.error);

  const tavily = await emit("providers:add", { name: "Tavily", kind: "service" });
  if (tavily.provider) {
    createdProviderIds.push(tavily.provider.id);
    check("providers:add Tavily (service)", tavily.provider.kind === "service");
  } else {
    check("providers:add Tavily — déjà présent ?", !tavily.error, tavily.error);
  }

  const ollama = await emit("providers:add", { name: "Ollama", kind: "llm" });
  if (ollama.provider) {
    createdProviderIds.push(ollama.provider.id);
    check("providers:add Ollama (sans clé)", ollama.provider.keyless === true);
  } else {
    check("providers:add Ollama — déjà présent ?", !ollama.error, ollama.error);
  }

  const unknown = await emit("providers:add", { name: "inconnu-sans-adresse", kind: "llm" });
  check("providers:add inconnu refusé", !!unknown.error, unknown.error);

  const custom = await emit("providers:add", {
    name: "https://api.exemple.io/v1",
    kind: "llm",
  });
  if (custom.provider) {
    createdProviderIds.push(custom.provider.id);
    check(
      "providers:add adresse personnalisée",
      custom.provider.baseUrl === "https://api.exemple.io",
      `${custom.provider.name} · ${custom.provider.baseUrl}`
    );
  } else {
    check("providers:add adresse personnalisée — échec", false, custom.error);
  }

  // Clé : ajout, masquage, absence du secret dans les réponses
  const list1 = await emit("providers:list");
  const zaiView = list1.providers.find((p: any) => p.name === "z.ai");
  const FAKE = "sk-test-flux-0123456789abcdef";
  const key = await emit("providers:add-key", {
    providerId: zaiView?.id,
    label: "Test E2E",
    secret: FAKE,
  });
  check("providers:add-key", !!key.key?.masked, key.key?.masked);
  check("add-key renvoie la vue masquée, pas le secret", !JSON.stringify(key).includes(FAKE));

  const short = await emit("providers:add-key", {
    providerId: zaiView?.id,
    label: "Trop courte",
    secret: "abc",
  });
  check("providers:add-key trop courte refusée", !!short.error, short.error);

  const list2 = await emit("providers:list");
  check(
    "providers:list sans secret",
    !JSON.stringify(list2).includes(FAKE),
    "le secret ne circule plus après l'ajout"
  );

  // Test réel (réseau) : une fausse clé doit échouer honnêtement
  const test = await emit("providers:test-key", { keyId: key.key?.id });
  check(
    "providers:test-key (appel réel)",
    !!test.ok && test.key?.status === "error",
    `${test.key?.status} / ${test.key?.statusLabel}`
  );

  // Stratégie
  const strat = await emit("providers:set-strategy", {
    id: zaiView?.id,
    strategy: "round_robin",
  });
  check("providers:set-strategy round_robin", strat.provider?.strategy === "round_robin");
  const badStrat = await emit("providers:set-strategy", {
    id: zaiView?.id,
    strategy: "nimportequoi",
  });
  check("providers:set-strategy invalide refusé", !!badStrat.error, badStrat.error);

  // Suppression de clé
  const delKey = await emit("providers:remove-key", { keyId: key.key?.id });
  check("providers:remove-key", !!delKey.ok);

  // ── Extensions ───────────────────────────────────────────────────
  const ext0 = await emit("extensions:list");
  check("extensions:list", Array.isArray(ext0.extensions), `${ext0.extensions.length} extension(s)`);

  // Import réel d'un dépôt public GitHub
  const imp = await emit("extensions:add", {
    kind: "repo",
    source: "https://github.com/octocat/Hello-World",
  });
  if (imp.extension) {
    createdExtensionIds.push(imp.extension.id);
    check(
      "extensions:add dépôt GitHub (résolution réelle)",
      imp.extension.source === "octocat/Hello-World" && !!imp.extension.commit,
      `${imp.extension.name} @ ${imp.extension.channel} · ${imp.extension.version} · ${imp.extension.commit?.slice(0, 7)}`
    );
    check(
      "extensions:add renvoie les derniers commits",
      Array.isArray(imp.commits),
      imp.commits.length > 0
        ? imp.commits[0].message.slice(0, 50)
        : "repli protocole git (API GitHub au quota) — commits vides"
    );
  } else {
    check("extensions:add dépôt GitHub — échec", false, imp.error);
  }

  const badRepo = await emit("extensions:add", { kind: "repo", source: "pas-une-adresse" });
  check("extensions:add adresse invalide refusée", !!badRepo.error, badRepo.error);

  // Vérifier : à jour tout juste importé
  const chk = await emit("extensions:check", { id: imp.extension?.id });
  check(
    "extensions:check (à jour)",
    !!chk.ok && chk.extension?.updateAvailable == null && !chk.changed,
    `${chk.commits?.length ?? 0} commits rapatriés`
  );

  // Basculer : enabled ≠ applied (compteur « en attente »)
  const tog = await emit("extensions:toggle", { id: imp.extension?.id, enabled: false });
  check("extensions:toggle off", tog.extension?.enabled === false && tog.extension?.applied === true);
  const listExt = await emit("extensions:list");
  const pending = listExt.extensions.filter((e: any) => e.enabled !== e.applied).length;
  check("extensions:list — 1 en attente", pending === 1, `${pending} en attente`);

  // Épingler : la vérification est escamotée
  const pin = await emit("extensions:pin", { id: imp.extension?.id, pinned: true });
  check("extensions:pin", pin.extension?.pinned === true);
  const chkPinned = await emit("extensions:check", { id: imp.extension?.id });
  check("extensions:check épingle → sautée", !!chkPinned.skipped);
  await emit("extensions:pin", { id: imp.extension?.id, pinned: false });

  // Mettre à jour : suit la tête distante
  const upd = await emit("extensions:update", { id: imp.extension?.id });
  check(
    "extensions:update (suit la tête)",
    !!upd.extension && upd.extension.updateAvailable == null,
    `commit ${upd.extension?.commit?.slice(0, 7)} · version ${upd.extension?.version}`
  );

  // Serveur MCP
  const mcp = await emit("extensions:add", { kind: "mcp", source: "node serveur-math.js" });
  if (mcp.extension) {
    createdExtensionIds.push(mcp.extension.id);
    check("extensions:add serveur MCP", mcp.extension.kind === "mcp");
    const chkMcp = await emit("extensions:check", { id: mcp.extension.id });
    check("extensions:check MCP → rien à vérifier", !!chkMcp.error, chkMcp.error);
  } else {
    check("extensions:add serveur MCP — échec", false, mcp.error);
  }

  // ── Nettoyage (ne touche que ce que le test a créé) ─────────────
  for (const id of createdExtensionIds) await emit("extensions:remove", { id });
  for (const id of createdProviderIds) await emit("providers:remove", { id });
  const finalProviders = await emit("providers:list");
  const finalExtensions = await emit("extensions:list");
  check(
    "nettoyage fournisseurs",
    !finalProviders.providers.some((p: any) => createdProviderIds.includes(p.id))
  );
  check(
    "nettoyage extensions",
    !finalExtensions.extensions.some((e: any) => createdExtensionIds.includes(e.id))
  );

  console.log(
    failures === 0
      ? "\nTOUT EST OK — chantier Paramètres v2.2 (fournisseurs & extensions)"
      : `\n${failures} ÉCHEC(S)`
  );
  socket.close();
  process.exit(failures === 0 ? 0 : 1);
}

socket.on("connect", () => main().catch((err) => {
  console.error("Erreur du test :", err);
  process.exit(1);
}));
socket.on("connect_error", (err) => {
  console.error("Connexion impossible au service (port 3003) :", err.message);
  process.exit(1);
});
