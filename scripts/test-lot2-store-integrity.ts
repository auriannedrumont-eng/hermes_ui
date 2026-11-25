// Test de régression Lot 2 — intégrité SQLite & artefacts (audit L2-1, L2-2,
// L2-3) : suppression/édition de message purge les artefacts ancrés, le fork
// n'hérite plus des artefacts du futur et COPIE les fichiers dérivés, et la
// recherche plein-texte échappe bien % _ \ (le correctif précédent produisait
// le littéral « ${c} » et laissait % comme joker).
// Le store est monté EN PROCESSUS sur une base jetable : HERMES_CHAT_DB
// pointe vers un dossier temporaire AVANT l'import dynamique du Store — plus
// de déplacement physique de la base de développement (fragile : un crash au
// milieu laissait la base renommée en .test-lot2-backup).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACTS_DIR, artifactThumbPath } from "../mini-services/hermes-chat/artifacts";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

// ── base jetable isolée : HERMES_CHAT_DB AVANT l'import du Store ─────────
const tmpDir = mkdtempSync(join(tmpdir(), "hermes-lot2-"));
process.env.HERMES_CHAT_DB = join(tmpDir, "hermes-chat.sqlite");
function cleanupDb() {
  // Garde anti double-appel (finally + catch) : rmSync force ne râle pas.
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* déjà retiré */
  }
}

async function main() {
  const { Store } = await import("../mini-services/hermes-chat/store");
  let store: InstanceType<typeof Store> | null = null;
  try {
    store = new Store();

    console.log("[1] purge des artefacts à la suppression d'un message (L2-1)");
    const conv1 = store.createConversation("lot2-purge");
    const m1 = store.appendMessage({ conversationId: conv1.id, role: "user", content: "message un" });
    const m2 = store.appendMessage({ conversationId: conv1.id, role: "assistant", content: "message deux" });
    store.insertArtifact({
      conversationId: conv1.id,
      messageId: m2.id,
      key: "rapport.html",
      kind: "html",
      name: "rapport.html",
      mime: "text/html",
      content: "<h1>bonjour</h1>",
      status: "ready",
    });
    check("artefact ancré sur le message 2 présent", store.listConversationArtifacts(conv1.id).length === 1);
    store.deleteMessage(conv1.id, m2.id);
    const purged = store.deleteArtifactsOfMessages(conv1.id, [m2.id]);
    check("deleteArtifactsOfMessages renvoie la ligne purgée", purged.length === 1, `${purged.length} ligne(s)`);
    check("plus aucune ligne d'artefact orpheline",
      store.listConversationArtifacts(conv1.id).length === 0);

    console.log("[2] purge à l'édition/troncature (L2-1)");
    const conv2 = store.createConversation("lot2-edit");
    const e1 = store.appendMessage({ conversationId: conv2.id, role: "user", content: "question initiale" });
    const e2 = store.appendMessage({ conversationId: conv2.id, role: "assistant", content: "réponse 1" });
    const e3 = store.appendMessage({ conversationId: conv2.id, role: "assistant", content: "réponse 2" });
    store.insertArtifact({
      conversationId: conv2.id,
      messageId: e3.id,
      key: "schema.html",
      kind: "html",
      name: "schema.html",
      mime: "text/html",
      content: "<svg></svg>",
      status: "ready",
    });
    const edit = store.editUserMessageAndTruncate(conv2.id, e1.id, "question reformulée");
    check("troncature renvoie les ids supprimés", (edit?.removedIds.length ?? 0) === 2,
      `${edit?.removedIds.length ?? 0} id(s)`);
    const purged2 = store.deleteArtifactsOfMessages(conv2.id, edit!.removedIds);
    check("l'artefact du message tronqué est purgé", purged2.length === 1 &&
      store.listConversationArtifacts(conv2.id).length === 0);

    console.log("[3] fork : artefacts du futur filtrés, fichiers dérivés copiés (L2-2)");
    const conv3 = store.createConversation("lot2-fork");
    const f1 = store.appendMessage({ conversationId: conv3.id, role: "user", content: "q" });
    const f2 = store.appendMessage({ conversationId: conv3.id, role: "assistant", content: "r1" });
    const f3 = store.appendMessage({ conversationId: conv3.id, role: "user", content: "q2" });
    const f4 = store.appendMessage({ conversationId: conv3.id, role: "assistant", content: "r2" });
    const inBranch = store.insertArtifact({
      conversationId: conv3.id, messageId: f2.id, key: "branche.html", kind: "html",
      name: "branche.html", mime: "text/html", content: "<p>branche</p>", status: "ready",
    });
    const future = store.insertArtifact({
      conversationId: conv3.id, messageId: f4.id, key: "futur.html", kind: "html",
      name: "futur.html", mime: "text/html", content: "<p>futur</p>", status: "ready",
    });
    // Fichier dérivé « déjà rendu » sur l'artefact DANS la branche : le fork
    // doit en recevoir une copie sous SON id.
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const thumbSrc = artifactThumbPath(inBranch.id);
    writeFileSync(thumbSrc, "PNG-FAUX-POUR-TEST");
    const fork = store.forkConversation(conv3.id, f2.id);
    check("fork créé", Boolean(fork));
    const forkRows = store.listConversationArtifacts(fork!.id);
    check("le fork hérite de l'artefact DANS la branche", forkRows.length === 1,
      `${forkRows.length} ligne(s) — attendu 1`);
    check("l'artefact du FUTUR n'est pas copié", !forkRows.some((r) => r.key === "futur.html"));
    check("aucune ligne re-ancrée sur un id de message d'ORIGINE",
      forkRows.every((r) => r.message_id !== f2.id && r.message_id !== f4.id));
    const copied = forkRows[0] ? artifactThumbPath(forkRows[0].id) : null;
    check("la vignette PNG suit le NOUVEL id",
      Boolean(copied && existsSync(copied) && readFileSync(copied, "utf8") === "PNG-FAUX-POUR-TEST"));
    check("la vignette de l'ORIGINAL reste intacte",
      readFileSync(thumbSrc, "utf8") === "PNG-FAUX-POUR-TEST");
    rmSync(thumbSrc, { force: true });
    if (copied) rmSync(copied, { force: true });
    void future;

    console.log("[4] recherche : % _ \\ échappés (L2-3)");
    const conv4 = store.createConversation("lot2-like");
    store.appendMessage({ conversationId: conv4.id, role: "user", content: "100% de réussite" });
    store.appendMessage({ conversationId: conv4.id, role: "user", content: "100 de réussite" });
    store.appendMessage({ conversationId: conv4.id, role: "user", content: "a_b en pratique" });
    store.appendMessage({ conversationId: conv4.id, role: "user", content: "aXb en pratique" });
    const hitsPct = store.searchMessages("100%");
    check("« 100% » ne matche que le littéral (pas 100 sans %)",
      hitsPct.length === 1 && hitsPct[0].excerpt.includes("100% de réussite"),
      `${hitsPct.length} hit(s)`);
    const hitsUnderscore = store.searchMessages("a_b");
    check("« a_b » ne matche que le littéral (pas aXb)",
      hitsUnderscore.length === 1 && hitsUnderscore[0].excerpt.includes("a_b en pratique"),
      `${hitsUnderscore.length} hit(s)`);
    const hitsComma = store.searchMessages("aXb, mot");
    check("une virgule ne casse plus la requête", Array.isArray(hitsComma) && hitsComma.length === 0,
      `${hitsComma.length} hit(s)`);

    console.log("[5] sweep de démarrage des orphelins (L2-7)");
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const conv5 = store.createConversation("lot2-sweep");
    const live = store.insertArtifact({
      conversationId: conv5.id,
      messageId: "sweep-msg-1",
      key: "sweep.html",
      kind: "html",
      name: "sweep.html",
      mime: "text/html",
      content: "<p>vivant</p>",
      status: "ready",
    });
    writeFileSync(artifactThumbPath(live.id), "PNG-VIVANT");
    // (a) fichiers dérivés SANS ligne : crash entre l'écriture et le DELETE
    writeFileSync(join(ARTIFACTS_DIR, "orphelin-crash.png"), "PNG-ORPHELIN");
    writeFileSync(join(ARTIFACTS_DIR, "orphelin-crash.pdf"), "PDF-ORPHELIN");
    // (b) ligne SANS conversation : cascade manquée — DELETE direct, sans le
    //     nettoyage du domaine (le chemin que le sweep doit réparer)
    const deadConv = store.createConversation("lot2-morte");
    const dead = store.insertArtifact({
      conversationId: deadConv.id,
      messageId: "sweep-msg-2",
      key: "morte.html",
      kind: "html",
      name: "morte.html",
      mime: "text/html",
      content: "<p>morte</p>",
      status: "ready",
    });
    writeFileSync(artifactThumbPath(dead.id), "PNG-MORTE");
    store.db
      .query("DELETE FROM conversations WHERE id = ?")
      .run(deadConv.id);
    const swept = store.sweepOrphanArtifacts();
    check("le sweep voit 3 fichiers orphelins (2 crash + vignette morte)",
      swept.removedFiles.length === 3, JSON.stringify(swept.removedFiles));
    check("le sweep voit 1 ligne sans conversation",
      swept.removedRows.length === 1 && swept.removedRows[0] === dead.id,
      JSON.stringify(swept.removedRows));
    check("orphelin-crash.png supprimé", !existsSync(join(ARTIFACTS_DIR, "orphelin-crash.png")));
    check("orphelin-crash.pdf supprimé", !existsSync(join(ARTIFACTS_DIR, "orphelin-crash.pdf")));
    check("la ligne morte n'existe plus", store.listConversationArtifacts(deadConv.id).length === 0);
    check("la vignette de la ligne morte est partie", !existsSync(artifactThumbPath(dead.id)));
    check("l'artefact VIVANT est intact (ligne + fichier)",
      store.listConversationArtifacts(conv5.id).length === 1 &&
      existsSync(artifactThumbPath(live.id)) &&
      readFileSync(artifactThumbPath(live.id), "utf8") === "PNG-VIVANT");
    const swept2 = store.sweepOrphanArtifacts();
    check("idempotent : le 2e sweep ne touche à rien",
      swept2.removedFiles.length === 0 && swept2.removedRows.length === 0);
    rmSync(artifactThumbPath(live.id), { force: true });
    check("plus aucun fichier du test ne reste dans db/artifacts",
      !readdirSync(ARTIFACTS_DIR).some(
        (f) => f.includes("orphelin-crash") || f.includes(live.id) || f.includes(dead.id)
      ));
  } finally {
    store?.close();
    cleanupDb();
  }

  console.log(failures === 0 ? "\nIntégrité Lot 2 : 0 échec" : `\nIntégrité Lot 2 : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  cleanupDb();
  process.exit(1);
});
