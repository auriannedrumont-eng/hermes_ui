// Graine QA « vue onglet + terminal » : base temporaire avec une conversation
// contenant un message assistant (toolEvents) et un artefact HTML prêt.
// À lancer avec HERMES_CHAT_DB pointant sur la base de la pile de test.
import { join, dirname } from "node:path";

if (!process.env.HERMES_CHAT_DB) {
  console.error("HERMES_CHAT_DB requis (base de la pile de test)");
  process.exit(1);
}
const { Store } = await import("../mini-services/hermes-chat/store");

const store = new Store();
const conv = store.createConversation("QA vue onglet + terminal");
const mid = `qa-msg-${Date.now()}`;
store.appendMessage({
  id: mid,
  conversationId: conv.id,
  role: "assistant",
  content:
    "Voici la page de test. Elle reste visible dans le fil avec sa carte, " +
    "et le panneau affiche le rendu complet.",
  toolEvents: [
    { name: "Terminal", status: "running", detail: "mkdir -p sortie && cd sortie", at: new Date(Date.now() - 90_000).toISOString() },
    { name: "Terminal", status: "done", detail: "dossier prêt (12 ms)", at: new Date(Date.now() - 80_000).toISOString() },
    { name: "Recherche web", status: "done", detail: "3 sources (tavily)", at: new Date(Date.now() - 60_000).toISOString() },
    { name: "Terminal", status: "error", detail: "pip install fictif → module introuvable", at: new Date(Date.now() - 30_000).toISOString() },
  ],
  model: "qa-model",
});
const html = `<!doctype html><html><head><meta charset="utf-8"><title>QA vue onglet</title><style>body{font-family:system-ui;padding:48px;background:#fdf8f3;color:#333}h1{color:#b3592a}</style></head><body><h1>Page rendue dans l'onglet</h1><p>Cette page s'ouvre via /view derrière un bac à sable CSP.</p><script>document.body.dataset.js = "vivant";</script></body></html>`;
const row = store.insertArtifact({
  conversationId: conv.id,
  messageId: mid,
  key: "page-qa.html",
  kind: "html",
  name: "page-qa.html",
  mime: "text/html",
  content: html,
  status: "ready",
});
console.log(`conversation=${conv.id} artifact=${row.id}`);
