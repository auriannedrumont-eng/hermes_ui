// Semis de recette : 2 projets + documents multi-versions (pour le parcours
// navigateur). Base dev, jamais en production.
import { Store } from "../mini-services/hermes-chat/store";
const store = new Store();
const p1 = store.createProject("Refonte site vitrine");
const c1 = store.createConversation("Brief + maquettes", p1.id);
const p2 = store.createProject("Veille concurrence");
const c2 = store.createConversation("Veille hebdo", p2.id);
const hors = store.createConversation("Documents isolés");
const mk = (convId: string, key: string, kind: string, name: string, content: string, pinned = false) => {
  const row = store.insertArtifact({ conversationId: convId, key, kind, name, mime: "text/markdown", content, status: "ready" });
  if (pinned) store.setArtifactPinned(row.id, true);
  return row;
};
mk(c1.id, "plan.md", "markdown", "plan-de-charge.md", "v1 du plan");
mk(c1.id, "plan.md", "markdown", "plan-de-charge.md", "v2 du plan");
mk(c1.id, "plan.md", "markdown", "plan-de-charge.md", "v3 du plan", true);
mk(c1.id, "maquettes.html", "html", "maquette-accueil.html", "<html>v1</html>");
mk(c1.id, "maquettes.html", "html", "maquette-accueil.html", "<html>v2 plus longue</html>");
mk(c2.id, "veille.md", "markdown", "rapport-veille.md", "semaine 1");
mk(c2.id, "veille.md", "markdown", "rapport-veille.md", "semaine 2");
mk(c2.id, "veille.md", "markdown", "rapport-veille.md", "semaine 3", true);
mk(hors.id, "notes.md", "markdown", "notes-reunion.md", "notes v1");
mk(hors.id, "notes.md", "markdown", "notes-reunion.md", "notes v2");
console.log("semis:", JSON.stringify({ projets: 2, conversations: 3, lignes: store.listStorageEntries().length }));
