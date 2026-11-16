// Sonde de l'ajout unifié (registry:install — v2.6). Contrat testé contre
// un vrai mini-service :
//   (1) un nom de service connu (« tavily ») crée un fournisseur kind=service ;
//   (2) un nom de fournisseur LLM connu (« openrouter ») crée kind=llm ;
//   (3) un doublon propose la fiche existante (message « déjà configuré ») ;
//   (4) une adresse GitHub importe un dépôt (résolution réelle : branche, tête) ;
//   (5) une adresse https et une commande de lancement deviennent des serveurs MCP ;
//   (6) un nom inconnu renvoie une erreur explicite ;
//   (7) rien ne traîne : chaque ligne créée est retirée ensuite.
import { Socket, io } from "socket.io-client";

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(ok ? "  OK  " : "  ÉCHEC", label);
  if (!ok) failures++;
};
const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));

const socket: Socket = io("http://127.0.0.1:3003", { transports: ["websocket"] });

interface Res {
  what?: string;
  provider?: { id: string; name: string; kind: string };
  extension?: { id: string; name: string; kind: string; source?: string; channel?: string; commit?: string };
  error?: string;
}
const install = (source: string): Promise<Res> =>
  new Promise((r) => socket.emit("registry:install", { source }, (res: Res) => r(res)));
const providersList = (): Promise<{ providers?: Array<{ id: string; name: string; kind: string }> }> =>
  new Promise((r) => socket.emit("providers:list", (res) => r(res)));
const removeProvider = (id: string): Promise<unknown> =>
  new Promise((r) => socket.emit("providers:remove", { id }, (res) => r(res)));
const removeExtension = (id: string): Promise<unknown> =>
  new Promise((r) => socket.emit("extensions:remove", { id }, (res) => r(res)));

socket.on("connect", async () => {
  console.log("connecté au mini-service");
  const createdProviders: string[] = [];
  const createdExtensions: string[] = [];

  // (1) Service connu → fournisseur kind=service
  const tavily = await install("tavily");
  check(
    tavily.what === "provider" && tavily.provider?.kind === "service" && tavily.provider?.name === "Tavily",
    `« tavily » → fournisseur service (reçu : ${JSON.stringify(tavily.what)}/${tavily.provider?.kind ?? tavily.error})`
  );
  if (tavily.provider) createdProviders.push(tavily.provider.id);

  // (2) Fournisseur LLM connu → kind=llm
  const openrouter = await install("openrouter");
  check(
    openrouter.what === "provider" && openrouter.provider?.kind === "llm",
    `« openrouter » → fournisseur llm (reçu : ${openrouter.provider?.kind ?? openrouter.error})`
  );
  if (openrouter.provider) createdProviders.push(openrouter.provider.id);

  // (3) Doublon : message qui renvoie à la fiche
  const dup = await install("tavily");
  check(
    !dup.what && (dup.error ?? "").includes("déjà configuré"),
    `doublon « tavily » → erreur « déjà configuré » (${dup.error ?? "aucune"})`
  );

  // (4) Dépôt GitHub → extension repo résolue réellement
  const repo = await install("https://github.com/octocat/Hello-World");
  check(
    repo.what === "repo" &&
      repo.extension?.kind === "repo" &&
      repo.extension.source === "octocat/Hello-World" &&
      !!repo.extension.commit,
    `dépôt GitHub → extension repo résolue (reçu : ${repo.what}/${repo.error ?? repo.extension?.source ?? "?"})`
  );
  if (repo.extension) createdExtensions.push(repo.extension.id);

  // (5a) Adresse https → serveur MCP
  const mcpUrl = await install("https://mcp.example.com/sse");
  check(
    mcpUrl.what === "mcp" && mcpUrl.extension?.kind === "mcp",
    `https → serveur MCP (reçu : ${mcpUrl.what}/${mcpUrl.error ?? "?"})`
  );
  if (mcpUrl.extension) createdExtensions.push(mcpUrl.extension.id);

  // (5b) Commande de lancement → serveur MCP
  const mcpCmd = await install("npx -y @modelcontextprotocol/server-filesystem /tmp");
  check(
    mcpCmd.what === "mcp" && mcpCmd.extension?.kind === "mcp",
    `commande npx → serveur MCP (reçu : ${mcpCmd.what}/${mcpCmd.error ?? "?"})`
  );
  if (mcpCmd.extension) createdExtensions.push(mcpCmd.extension.id);

  // (6) Nom inconnu → erreur explicite
  const unknown = await install("service-totalement-inconnu-xyz");
  check(
    !unknown.what && (unknown.error ?? "").includes("Introuvable"),
    `nom inconnu → erreur explicite (${unknown.error ?? "aucune"})`
  );

  // (7) Nettoyage : plus aucune trace des lignes créées par la sonde.
  for (const id of createdProviders) await removeProvider(id);
  for (const id of createdExtensions) await removeExtension(id);
  await timeout(400);
  const after = await providersList();
  const leftover = (after.providers ?? []).filter(
    (p) => p.name === "Tavily" || p.name === "OpenRouter"
  );
  check(leftover.length === 0, "nettoyage : aucune ligne de sonde laissée en base");

  socket.close();
  console.log(failures === 0 ? "SUCCÈS — sonde registry:install validée" : `ÉCHEC — ${failures} vérification(s)`);
  process.exit(failures === 0 ? 0 : 1);
});

socket.on("connect_error", (err) => {
  console.error("connexion impossible au mini-service :", err.message);
  process.exit(1);
});
