// Handlers « providers-extensions » — extraits d'index.ts (découpage 2026-11, FORK.md §10).
// Pose ses socket.on(...) via register*(socket) ; les identifiants libres
// (ctx.store, ctx.io, ctx.connector, helpers du tour, vues wire) viennent du contexte
// partagé handlers/context.ts — câblé une fois par index.ts.
import type { Socket } from "socket.io";
import { ctx } from "./context";
import {
  checkKeySecret,
  checkProviderBaseUrl,
  isMcpLaunchSource,
  isProviderStrategy,
  resolveExplicitBaseUrl,
  sameAsCanonicalBaseUrl,
} from "../providers-validate";

// registerProvidersExtensionsHandlers ne pose plus 21 socket.on() dans un
// seul corps : quatre sous-registres thématiques, appelés dans l'ordre
// d'origine du fichier. Corps des handlers VERBATIM — seules les accolades
// d'encadrement changent.

function registerSessionCatalogHandlers(socket: Socket) {

socket.on("hello", (cb?: (info: unknown) => void) => {
  if (typeof cb === "function") cb(ctx.helloPayload());
});

socket.on("models:list", async (cb?: (data: unknown) => void) => {
  try {
    const result = await ctx.connector.listModels();
    // Fournisseur « Chats IA web » (spec pilotage) : à part, toujours
    // proposé — il ne dépend ni de la gateway ni des clés fournisseurs.
    const models = [...(result.models ?? []), ...ctx.webchatModelOptions()];
    if (typeof cb === "function") cb({ ...result, models });
  } catch {
    // Le moteur ne répond pas : catalogue honnête + groupe webchat — le
    // modèle PAR DÉFAUT reste un modèle du catalogue (jamais un webchat).
    const fallback = ctx.catalogModelsResult();
    if (typeof cb === "function")
      cb({
        models: [...fallback.models, ...ctx.webchatModelOptions()],
        defaultModel: fallback.defaultModel,
        source: "catalogue",
      });
  }
});

}

function registerAttachmentsAudioHandlers(socket: Socket) {

socket.on(
  "attachments:upload",
  async (
    payload: { name?: string; mime?: string; dataBase64?: string },
    cb?: (data: unknown) => void
  ) => {
    try {
      const name = (payload?.name ?? "fichier").trim();
      const mime = (payload?.mime ?? "application/octet-stream").trim();
      const dataBase64 = payload?.dataBase64;
      if (typeof dataBase64 !== "string" || !dataBase64) throw new Error("Contenu manquant");
      const attachment = ctx.saveAttachment(name, mime, dataBase64);
      // Transcription automatique des pièces jointes audio (best effort)
      if (attachment.kind === "audio") {
        try {
          const transcript = await ctx.transcribeAudioBase64(dataBase64, attachment.mime);
          if (transcript) attachment.transcript = transcript;
        } catch (err) {
          console.warn(
            `[hermes-chat] transcription impossible pour ${attachment.name}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      console.log(
        `[hermes-chat] pièce jointe enregistrée : ${attachment.name} (${attachment.mime}, ${attachment.size} o)`
      );
      if (typeof cb === "function") cb({ attachment });
    } catch (err) {
      if (typeof cb === "function")
        cb({ error: err instanceof Error ? err.message : "Échec de l'envoi du fichier" });
    }
  }
);


// Dictée vocale : audio base64 -> texte (ASR)
socket.on(
  "audio:transcribe",
  async (
    payload: { dataBase64?: string; mime?: string },
    cb?: (data: unknown) => void
  ) => {
    try {
      if (typeof payload?.dataBase64 !== "string" || !payload.dataBase64) {
        throw new Error("Audio manquant");
      }
      const text = await ctx.transcribeAudioBase64(payload.dataBase64, payload?.mime ?? "");
      if (typeof cb === "function") cb({ text });
    } catch (err) {
      if (typeof cb === "function")
        cb({ error: err instanceof Error ? err.message : "Échec de la transcription" });
    }
  }
);


}

function registerProvidersHandlers(socket: Socket) {

// ── Fournisseurs & clés (Paramètres v2.2) ──────────────────────────

socket.on("providers:list", (cb?: (data: unknown) => void) => {
  if (typeof cb === "function") cb({ providers: ctx.providersWire() });
});

// Catalogue des fournisseurs connus (sélecteur d'ajout, v2.5) — z.ai y
// figure DEUX fois : API standard (paiement au jeton) et GLM Coding
// Plan (abonnement), deux portefeuilles étanches.
socket.on("providers:catalog", (cb?: (data: unknown) => void) => {
  if (typeof cb === "function") cb({ catalog: ctx.knownProviderCatalog() });
});

socket.on(
  "providers:add",
  (
    payload: { name?: string; kind?: string; baseUrl?: string },
    cb?: (data: unknown) => void
  ) => {
    const raw = (payload?.name ?? "").trim();
    // Revue P1-P7 : le kind demandé est contrôlé — une valeur inconnue est
    // REFUSÉE au lieu d'être silencieusement convertie en "llm".
    if (
      payload?.kind !== undefined &&
      payload.kind !== "llm" &&
      payload.kind !== "service"
    ) {
      if (typeof cb === "function")
        cb({ error: "kind invalide — « llm » ou « service » attendu" });
      return;
    }
    let kind = payload?.kind === "service" ? "service" : "llm";
    if (!raw) {
      if (typeof cb === "function") cb({ error: "Nom ou adresse requis" });
      return;
    }
    const resolved = ctx.resolveKnownProvider(raw);
    if (!resolved) {
      if (typeof cb === "function")
        cb({ error: "Fournisseur non reconnu — collez son adresse (https://…)" });
      return;
    }
    // Revue P1-P7 : pour un fournisseur CONNU, le CATALOGUE fait foi — le
    // kind demandé ne peut pas contredire sa nature (tavily demandé en
    // « llm » restait bloqué au mauvais type et ne répondait jamais).
    if ("known" in resolved) {
      const cat = ctx
        .knownProviderCatalog()
        .find((c) => c.name === resolved.known.name);
      if (cat?.kind) kind = cat.kind;
    }
    // Un fournisseur connu n'est pas dupliqué
    const canonicalName = "known" in resolved ? resolved.known.name : resolved.custom.name;
    const existing = ctx.store
      .listProviderRows()
      .find((p) => p.name.toLowerCase() === canonicalName.toLowerCase() && p.kind === kind);
    if (existing) {
      if (typeof cb === "function") cb({ error: `${canonicalName} est déjà dans la liste` });
      return;
    }
    let baseUrl =
      "known" in resolved
        ? (resolved.known.defaultBaseUrl ?? null)
        : resolved.custom.baseUrl;
    // Adresse explicite fournie : elle gagne sur l'adresse canonique
    // (surcharger un fournisseur connu — passerelle d'entreprise, tests,
    // bascule z.ai vers la surface coding). v2.5 : une adresse avec chemin
    // est la base COMPLÈTE ; une origine seule remplace l'hôte du canon.
    // https requis, ou http strictement local (même règle que le test de clé).
    // Vague 4 : la règle vit dans providers-validate.ts (une seule vérité,
    // testée) — l'override reste SILENCIEUX (invalide → canonique conservée).
    const explicit = (payload?.baseUrl ?? "").trim();
    baseUrl = resolveExplicitBaseUrl(explicit, baseUrl);
    // Champ d'adresse non modifié (pré-rempli par le sélecteur à l'identique
    // du canon) : stocker null — l'adresse canonique reste la référence et
    // les surfaces de TEST propres à certains fournisseurs (opencode) sont
    // préservées.
    const canonicalDefault =
      "known" in resolved ? (resolved.known.defaultBaseUrl ?? null) : null;
    if (sameAsCanonicalBaseUrl(baseUrl, canonicalDefault)) {
      baseUrl = null;
    }
    const row = ctx.store.createProvider({ name: canonicalName, kind, baseUrl });
    if (typeof cb === "function") cb({ provider: ctx.providerWire(row, []) });
    ctx.broadcastProviders();
  }
);


socket.on("providers:remove", (payload: { id?: string }, cb?: (data: unknown) => void) => {
  const id = payload?.id;
  if (!id || !ctx.store.getProviderRow(id)) {
    if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
    return;
  }
  ctx.store.deleteProvider(id);
  if (typeof cb === "function") cb({ ok: true });
  ctx.broadcastProviders();
});

socket.on(
  "providers:set-strategy",
  (
    payload: { id?: string; strategy?: string },
    cb?: (data: unknown) => void
  ) => {
    const id = payload?.id;
    const strategy = payload?.strategy;
    // Vague 4 : la liste des stratégies vit dans providers-validate.ts (testée).
    if (!id || !strategy || !isProviderStrategy(strategy)) {
      if (typeof cb === "function") cb({ error: "Paramètres invalides" });
      return;
    }
    const row = ctx.store.setProviderStrategy(id, strategy);
    if (!row) {
      if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ provider: ctx.providerWire(row, ctx.store.listKeyRows(id)) });
    ctx.broadcastProviders();
  }
);


// Adresse (endpoint) éditable, v2.5 — champ visible à l'ajout d'une clé
// et dans les réglages avancés de la carte. Chaîne vide = retour à
// l'adresse canonique du fournisseur. Mêmes règles de sécurité que le
// test de clé : https requis, http strictement local admis.
socket.on(
  "providers:set-base",
  (
    payload: { id?: string; baseUrl?: string },
    cb?: (data: unknown) => void
  ) => {
    const id = payload?.id;
    const row = id ? ctx.store.getProviderRow(id) : null;
    if (!id || !row) {
      if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
      return;
    }
    const raw = (payload?.baseUrl ?? "").trim();
    if (!raw) {
      const updated = ctx.store.setProviderBaseUrl(id, null);
      if (typeof cb === "function")
        cb({ provider: updated ? ctx.providerWire(updated, ctx.store.listKeyRows(id)) : null });
      ctx.broadcastProviders();
      return;
    }
    // Vague 4 : la validation https / http-local vit dans
    // providers-validate.ts (une seule vérité, testée) — les trois refus
    // gardent leurs messages d'origine, la valeur stockée aussi (slashes
    // finaux supprimés).
    const check = checkProviderBaseUrl(raw);
    if (!check.ok) {
      if (typeof cb === "function") cb({ error: check.error });
      return;
    }
    const updated = ctx.store.setProviderBaseUrl(id, check.url);
    if (typeof cb === "function")
      cb({ provider: updated ? ctx.providerWire(updated, ctx.store.listKeyRows(id)) : null });
    ctx.broadcastProviders();
  }
);


socket.on(
  "providers:add-key",
  (
    payload: { providerId?: string; label?: string; secret?: string },
    cb?: (data: unknown) => void
  ) => {
    const providerId = payload?.providerId;
    const label = (payload?.label ?? "").trim() || "Clé";
    const secret = (payload?.secret ?? "").trim();
    const provider = providerId ? ctx.store.getProviderRow(providerId) : null;
    if (!providerId || !provider) {
      if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
      return;
    }
    // Vague 4 : la borne vit dans providers-validate.ts (testée) —
    // message d'erreur verbatim.
    const secretError = checkKeySecret(secret);
    if (secretError) {
      if (typeof cb === "function") cb({ error: secretError });
      return;
    }
    // Lot audit 2026-11-21 : déduplication — la même clé collée deux fois
    // créait deux lignes indépendantes (double comptage pour `least_used`,
    // clé épuisée retentée par `fill_first`).
    const duplicate = ctx.store
      .listKeyRows(providerId)
      .some((k) => k.secret === secret);
    if (duplicate) {
      if (typeof cb === "function")
        cb({ error: "Cette clé existe déjà sur ce fournisseur — ajoutez un autre secret." });
      return;
    }
    const row = ctx.store.createProviderKey(providerId, label, secret, ctx.maskSecret(secret));
    console.log(
      `[hermes-chat] clé ajoutée pour ${provider.name} : « ${label} » (${row.masked})`
    );
    if (typeof cb === "function") cb({ key: ctx.toKeyView(row) });
    ctx.broadcastProviders();
  }
);


socket.on("providers:remove-key", (payload: { keyId?: string }, cb?: (data: unknown) => void) => {
  const keyId = payload?.keyId;
  if (!keyId || !ctx.store.getKeyRow(keyId)) {
    if (typeof cb === "function") cb({ error: "Clé introuvable" });
    return;
  }
  ctx.store.deleteProviderKey(keyId);
  if (typeof cb === "function") cb({ ok: true });
  ctx.broadcastProviders();
});

// « Tester » = appel minimal RÉEL exécuté par le service (liste des
// modèles, ou requête minimale pour les services d'API) — réseau inclus.
socket.on(
  "providers:test-key",
  async (payload: { keyId?: string }, cb?: (data: unknown) => void) => {
    const key = payload?.keyId ? ctx.store.getKeyRow(payload.keyId) : null;
    if (!key) {
      if (typeof cb === "function") cb({ error: "Clé introuvable" });
      return;
    }
    const provider = ctx.store.getProviderRow(key.provider_id);
    if (!provider) {
      if (typeof cb === "function") cb({ error: "Fournisseur introuvable" });
      return;
    }
    try {
      const result = await ctx.testProviderKey(provider.name, provider.base_url, key.secret);
      // v2.5 — z.ai : la clé a répondu sur l'AUTRE portefeuille (clé
      // Coding Plan au format standard, p. ex.) : le fournisseur est
      // basculé sur la surface qui l'accepte — le prochain tour et le
      // prochain test parleront à la bonne adresse sans intervention.
      const migrated =
        result.migrateBaseUrl && result.migrateBaseUrl !== (provider.base_url ?? "")
          ? ctx.store.setProviderBaseUrl(provider.id, result.migrateBaseUrl)
          : null;
      if (migrated) {
        console.log(
          `[hermes-chat] ${provider.name} : endpoint basculé vers ${migrated.base_url} (clé « ${key.label} »)`
        );
      }
      const updated = ctx.store.setKeyStatus(key.id, result.status, result.statusLabel);
      console.log(
        `[hermes-chat] test ${provider.name}/${key.label} → ${result.status} (${result.statusLabel})`
      );
      if (typeof cb === "function")
        cb({
          ok: true,
          key: updated ? ctx.toKeyView(updated) : null,
          detail: result.detail ?? null,
          provider: ctx.providerWire(migrated ?? provider, ctx.store.listKeyRows(provider.id)),
        });
      ctx.broadcastProviders();
    } catch (err) {
      if (typeof cb === "function")
        cb({ error: err instanceof Error ? err.message : "Test impossible" });
    }
  }
);


}

// ── Extensions : dépôts importés + serveurs MCP ───────────────────

/** Lot audit 2026-11-21 : déduplication — coller deux fois la même source
 *  (dépôt GitHub, adresse https, commande) créait deux lignes indépendantes
 *  et donc une double installation au redémarrage. owner/repo est comparé
 *  insensible à la casse (GitHub). */
function findExtensionBySource(
  store: { listExtensionRows(): { kind: string; source: string | null }[] },
  kind: "repo" | "mcp",
  source: string
): boolean {
  return store
    .listExtensionRows()
    .some((e) => e.kind === kind && (e.source ?? "").toLowerCase() === source.toLowerCase());
}

function registerExtensionsHandlers(socket: Socket) {

socket.on("extensions:list", (cb?: (data: unknown) => void) => {
  if (typeof cb === "function") cb({ extensions: ctx.extensionsWire() });
});

// Import d'un dépôt GitHub : résolution réelle (infos, branche, tête)
socket.on(
  "extensions:add",
  async (
    payload: { kind?: string; source?: string; channel?: string },
    cb?: (data: unknown) => void
  ) => {
    const kind = payload?.kind === "mcp" ? "mcp" : "repo";
    const source = (payload?.source ?? "").trim();
    if (!source) {
      if (typeof cb === "function") cb({ error: "Source requise" });
      return;
    }
    if (kind === "mcp") {
      if (findExtensionBySource(ctx.store, kind, source)) {
        if (typeof cb === "function") cb({ error: "Ce serveur est déjà ajouté." });
        return;
      }
      const row = ctx.store.createExtension({
        name: source.slice(0, 80),
        kind,
        description: "serveur ajouté",
        source,
      });
      if (typeof cb === "function") cb({ extension: ctx.extensionWire(row) });
      ctx.broadcastExtensions();
      return;
    }
    const ref = ctx.parseRepoInput(source);
    if (!ref) {
      if (typeof cb === "function")
        cb({ error: "Adresse de dépôt invalide (https://github.com/owner/repo)" });
      return;
    }
    if (findExtensionBySource(ctx.store, "repo", `${ref.owner}/${ref.repo}`)) {
      if (typeof cb === "function") cb({ error: "Ce dépôt est déjà importé." });
      return;
    }
    try {
      const snap = await ctx.fetchRepoSnapshot(ref, payload?.channel ?? null);
      const row = ctx.store.createExtension({
        name: snap.name,
        kind,
        description: snap.description,
        source: `${ref.owner}/${ref.repo}`,
        channel: snap.defaultBranch,
        commit: snap.headSha,
        version: snap.versionLabel,
      });
      console.log(
        `[hermes-chat] extension importée : ${row.source} @ ${row.channel} (${row.version})`
      );
      if (typeof cb === "function")
        cb({ extension: ctx.extensionWire(row), commits: snap.commits });
      ctx.broadcastExtensions();
    } catch (err) {
      if (typeof cb === "function")
        cb({ error: err instanceof Error ? err.message : "Import impossible" });
    }
  }
);


// Ajout UNIFIÉ (v2.6) — un seul champ « nom ou adresse » : le service
// décide tout seul ce que l'entrée devient.
//   dépôt GitHub (URL, owner/repo, git@…) → extension « repo », résolue
//     réellement (infos, branche, tête) ;
//   adresse https → serveur MCP ;
//   commande de lancement (npx/uvx/node/…) → serveur MCP ;
//   nom connu (tavily, exa…) → fournisseur, créé avec la clé du catalogue
//     (service → fiche « Clés de services », llm → « Fournisseurs ») ; la
//     clé API s'ajoute ensuite sur la fiche, jamais à l'installation.
socket.on(
  "registry:install",
  async (payload: { source?: string }, cb?: (data: unknown) => void) => {
    const raw = (payload?.source ?? "").trim();
    if (!raw) {
      if (typeof cb === "function") cb({ error: "Tapez un nom ou collez une adresse." });
      return;
    }

    // 1. Dépôt GitHub ?
    const repoRef = ctx.parseRepoInput(raw);
    if (repoRef) {
      if (findExtensionBySource(ctx.store, "repo", `${repoRef.owner}/${repoRef.repo}`)) {
        if (typeof cb === "function") cb({ error: "Ce dépôt est déjà importé." });
        return;
      }
      try {
        const snap = await ctx.fetchRepoSnapshot(repoRef, null);
        const row = ctx.store.createExtension({
          name: snap.name,
          kind: "repo",
          description: snap.description,
          source: `${repoRef.owner}/${repoRef.repo}`,
          channel: snap.defaultBranch,
          commit: snap.headSha,
          version: snap.versionLabel,
        });
        console.log(
          `[hermes-chat] registry: dépôt installé : ${row.source} @ ${row.channel} (${row.version})`
        );
        if (typeof cb === "function")
          cb({ what: "repo", extension: ctx.extensionWire(row), commits: snap.commits });
        ctx.broadcastExtensions();
      } catch (err) {
        if (typeof cb === "function")
          cb({ error: err instanceof Error ? err.message : "Import impossible" });
      }
      return;
    }

    // 2. Adresse https → serveur MCP. 3. Commande de lancement → MCP aussi.
    // Vague 4 : classification adresse https / commande de lancement dans
    // providers-validate.ts (testée par Vitest) — regex verbatim.
    if (isMcpLaunchSource(raw)) {
      if (findExtensionBySource(ctx.store, "mcp", raw)) {
        if (typeof cb === "function") cb({ error: "Ce serveur est déjà ajouté." });
        return;
      }
      const row = ctx.store.createExtension({
        name: raw.slice(0, 80),
        kind: "mcp",
        description: "serveur ajouté",
        source: raw,
      });
      if (typeof cb === "function") cb({ what: "mcp", extension: ctx.extensionWire(row) });
      ctx.broadcastExtensions();
      return;
    }

    // 4. Nom connu → fournisseur (kind porté par le catalogue).
    const resolved = ctx.resolveKnownProvider(raw);
    if (resolved && "known" in resolved) {
      const known = resolved.known;
      const existing = ctx.store
        .listProviderRows()
        .find(
          (p) =>
            p.name.toLowerCase() === known.name.toLowerCase() && p.kind === known.kind
        );
      if (existing) {
        if (typeof cb === "function")
          cb({
            error:
              known.kind === "service"
                ? `${known.name} est déjà configuré — sa clé s'ajoute sur sa fiche dans « Clés de services ».`
                : `${known.name} figure déjà dans « Fournisseurs ».`,
          });
        return;
      }
      const row = ctx.store.createProvider({
        name: known.name,
        kind: known.kind,
        baseUrl: known.defaultBaseUrl ?? null,
      });
      console.log(`[hermes-chat] registry: fournisseur installé : ${row.name} (${row.kind})`);
      if (typeof cb === "function")
        cb({ what: "provider", provider: ctx.providerWire(row, []) });
      ctx.broadcastProviders();
      return;
    }

    if (typeof cb === "function")
      cb({
        error:
          "Introuvable — tapez un nom connu (tavily, exa…) ou collez une adresse GitHub / https.",
      });
  }
);


socket.on(
  "extensions:toggle",
  (payload: { id?: string; enabled?: boolean }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id) {
      if (typeof cb === "function") cb({ error: "id requis" });
      return;
    }
    // `applied` n'est PAS touché : le footer compte les écarts et le
    // redémarrage du service prendra le nouvel état en compte.
    const row = ctx.store.updateExtensionRow(id, { enabled: !!payload?.enabled });
    if (!row) {
      if (typeof cb === "function") cb({ error: "Extension introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ extension: ctx.extensionWire(row) });
    ctx.broadcastExtensions();
  }
);


socket.on("extensions:remove", (payload: { id?: string }, cb?: (data: unknown) => void) => {
  const id = payload?.id;
  if (!id || !ctx.store.getExtensionRow(id)) {
    if (typeof cb === "function") cb({ error: "Extension introuvable" });
    return;
  }
  ctx.store.deleteExtension(id);
  if (typeof cb === "function") cb({ ok: true });
  ctx.broadcastExtensions();
});

socket.on(
  "extensions:pin",
  (payload: { id?: string; pinned?: boolean }, cb?: (data: unknown) => void) => {
    const id = payload?.id;
    if (!id) {
      if (typeof cb === "function") cb({ error: "id requis" });
      return;
    }
    const row = ctx.store.updateExtensionRow(id, { pinned: !!payload?.pinned });
    if (!row) {
      if (typeof cb === "function") cb({ error: "Extension introuvable" });
      return;
    }
    if (typeof cb === "function") cb({ extension: ctx.extensionWire(row) });
    ctx.broadcastExtensions();
  }
);


// « Vérifier » : diff réel local ↔ distant via l'API GitHub.
socket.on(
  "extensions:check",
  async (payload: { id?: string }, cb?: (data: unknown) => void) => {
    const row = payload?.id ? ctx.store.getExtensionRow(payload.id) : null;
    if (!row) {
      if (typeof cb === "function") cb({ error: "Extension introuvable" });
      return;
    }
    if (row.kind !== "repo" || !row.source) {
      if (typeof cb === "function") cb({ error: "Rien à vérifier pour ce type d'extension" });
      return;
    }
    if (row.pinned) {
      if (typeof cb === "function")
        cb({ ok: true, skipped: true, extension: ctx.extensionWire(row) });
      return;
    }
    const ref = ctx.parseRepoInput(row.source);
    if (!ref) {
      if (typeof cb === "function") cb({ error: "Source de dépôt invalide" });
      return;
    }
    try {
      const snap = await ctx.fetchRepoSnapshot(ref, row.channel);
      const changed = snap.headSha !== row.commit;
      const updated = ctx.store.updateExtensionRow(row.id, {
        update_available: changed ? snap.versionLabel : null,
        last_checked_at: new Date().toISOString(),
      })!;
      if (typeof cb === "function")
        cb({ ok: true, extension: ctx.extensionWire(updated), commits: snap.commits, changed });
      ctx.broadcastExtensions();
    } catch (err) {
      if (typeof cb === "function")
        cb({ error: err instanceof Error ? err.message : "Vérification impossible" });
    }
  }
);


// « Mettre à jour » : suit le commit distant (le rapatriement effectif
// et le relancement du composant relèvent du moteur, post-gateway).
socket.on(
  "extensions:update",
  async (payload: { id?: string }, cb?: (data: unknown) => void) => {
    const row = payload?.id ? ctx.store.getExtensionRow(payload.id) : null;
    if (!row) {
      if (typeof cb === "function") cb({ error: "Extension introuvable" });
      return;
    }
    if (row.kind !== "repo" || !row.source) {
      if (typeof cb === "function") cb({ error: "Cette extension ne se met pas à jour" });
      return;
    }
    const ref = ctx.parseRepoInput(row.source);
    if (!ref) {
      if (typeof cb === "function") cb({ error: "Source de dépôt invalide" });
      return;
    }
    try {
      const snap = await ctx.fetchRepoSnapshot(ref, row.channel);
      const updated = ctx.store.updateExtensionRow(row.id, {
        commit: snap.headSha,
        version: snap.versionLabel,
        update_available: null,
        last_checked_at: new Date().toISOString(),
      })!;
      console.log(
        `[hermes-chat] extension mise à jour : ${updated.source} → ${updated.version}`
      );
      if (typeof cb === "function")
        cb({ extension: ctx.extensionWire(updated), commits: snap.commits });
      ctx.broadcastExtensions();
    } catch (err) {
      if (typeof cb === "function")
        cb({ error: err instanceof Error ? err.message : "Mise à jour impossible" });
    }
  }
);

}

export function registerProvidersExtensionsHandlers(socket: Socket) {
  registerSessionCatalogHandlers(socket);
  registerAttachmentsAudioHandlers(socket);
  registerProvidersHandlers(socket);
  registerExtensionsHandlers(socket);
}
