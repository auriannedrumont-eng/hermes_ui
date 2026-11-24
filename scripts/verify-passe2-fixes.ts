// Vérification ciblée des correctifs « passe 2 » — base SQLite isolée.
// 1. supersedeTrailingAssistant : garde lastUser (aucune écriture sans
//    message utilisateur), transaction, capture activeByGroup (v1 affichée).
// 2. restoreVersionById : restaure la version précise, pas la plus récente.
// 3. restoreLatestVersion : comportement historique inchangé (repli).
// 4. resolveKnownProvider : garde https/loopback (http non local → null).
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.HERMES_CHAT_DB = join(
  mkdtempSync(join(tmpdir(), "hermes-passe2-")),
  "test.sqlite"
);

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  if (ok) console.log(`  OK   ${label}${extra ? " — " + extra : ""}`);
  else {
    failures++;
    console.log(`  ECHEC ${label}${extra ? " — " + extra : ""}`);
  }
}

const { Store } = await import("../mini-services/hermes-chat/store");
const { resolveKnownProvider } = await import("../mini-services/hermes-chat/providers");

const store = new Store();

// ── Préparation : une conversation, un message utilisateur, 2 versions ──
const conv = store.createConversation("passe 2");
const conversationId = conv.id;
store.appendMessage({ conversationId, role: "user", content: "bonjour", id: "u1" });
const v1 = store.appendMessage({
  conversationId, role: "assistant", content: "reponse v1",
  id: "a1", versionGroup: "g1", versionIndex: 1, versionActive: 1,
});
const v2 = store.appendMessage({
  conversationId, role: "assistant", content: "reponse v2",
  id: "a2", versionGroup: "g1", versionIndex: 2, versionActive: 1,
});
void v1; void v2;
// L'utilisateur AFFICHE v1 (bascule ‹ 1/2 ›) : v1 active, v2 inactive.
store.setMessageVersion(conversationId, "g1", 1);

console.log("\n1. supersedeTrailingAssistant — version affichée capturée");
const res = store.supersedeTrailingAssistant(conversationId);
check("lastUser trouvé", res.lastUser?.id === "u1");
// getMessages ne renvoie que la version ACTIVE par groupe (v1 ici) : la
// boucle ne peut superséder qu'elle — comportement identique à l'original.
check("1 réponse supersédée (la version active)", res.supersededIds.length === 1 && res.supersededIds[0] === "a1", JSON.stringify(res.supersededIds));
check("groupe capturé = g1", res.groups.plain === "g1");
check(
  "activeByGroup[g1] = v1 (affichée), PAS v2",
  res.activeByGroup["g1"]?.id === "a1" && res.activeByGroup["g1"]?.index === 1,
  JSON.stringify(res.activeByGroup["g1"])
);
const afterSupersede = store.getMessages(conversationId);
check(
  "plus aucune version active après supersession",
  afterSupersede.every((m) => m.role !== "assistant"),
  `${afterSupersede.length} message(s) restant(s)`
);

console.log("\n2. restoreVersionById — restaure v1 (affichée), pas v2");
store.restoreVersionById(conversationId, "a1");
const restored = store.getMessages(conversationId);
const activeRow = restored.find((m) => m.role === "assistant");
check("la version active est v1 (a1)", activeRow?.id === "a1", activeRow?.content ?? "");
// v2 reste inactive : une seule version active par groupe.
const inactiveV2 = !restored.some((m) => m.id === "a2");
check("v2 reste inactive", inactiveV2);

console.log("\n3. restoreLatestVersion — repli historique intact");
// v2 active, supersession, puis restauration par le repli → v2 revient.
store.setMessageVersion(conversationId, "g1", 2);
store.supersedeTrailingAssistant(conversationId);
store.restoreLatestVersion(conversationId, "g1");
const restoredLatest = store.getMessages(conversationId).find((m) => m.role === "assistant");
check("le repli restaure la plus récente (v2)", restoredLatest?.id === "a2");

console.log("\n4. supersedeTrailingAssistant — garde sans message utilisateur");
const conv2 = store.createConversation("sans utilisateur").id;
store.appendMessage({ conversationId: conv2, role: "assistant", content: "orphan", id: "o1" });
const res2 = store.supersedeTrailingAssistant(conv2);
check("lastUser null", res2.lastUser === null);
check("rien n'est supersédé", res2.supersededIds.length === 0);
check("aucun groupe", Object.keys(res2.groups).length === 0);
const conv2Msgs = store.getMessages(conv2);
check("la base n'a PAS été modifiée", conv2Msgs.length === 1 && conv2Msgs[0].id === "o1");

console.log("\n5. resolveKnownProvider — garde https/loopback");
const httpExt = resolveKnownProvider("http://intranet.example.com/v1");
check("http non local refusé (null)", httpExt === null);
const httpLocal = resolveKnownProvider("http://localhost:11434");
check("http loopback accepté", httpLocal !== null && "custom" in httpLocal, JSON.stringify(httpLocal));
const httpLoopIp = resolveKnownProvider("http://127.0.0.1:8080/api");
check("http 127.0.0.1 accepté", httpLoopIp !== null && "custom" in httpLoopIp);
const httpsExt = resolveKnownProvider("https://api.example.com/v1");
check("https accepté", httpsExt !== null && "custom" in httpsExt);
const known = resolveKnownProvider("ollama");
check("fournisseur connu inchangé", known !== null && "known" in known);
const junk = resolveKnownProvider("juste un nom inconnu");
check("nom non reconnu → null", junk === null);

console.log(failures === 0 ? "\nTOUS LES TESTS PASSENT" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
