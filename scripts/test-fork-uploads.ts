// Test de régression « fork de conversation et pièces jointes » — les uploads
// étaient PARTAGÉS entre l'originale et le fork (mêmes URLs /uploads/<id>.<ext>
// → mêmes fichiers disque) : la première suppression (originale ou fork)
// délinkait le fichier sous les pieds de l'autre branche (images/audio 404).
// Convention artefacts (copyArtifactsToFork) : le fork copie maintenant les
// fichiers sous un NOUVEL id — les deux branches sont indépendantes.
// Store monté EN PROCESSUS sur une base jetable (même schéma que
// test-lot2-store-integrity) ; les fichiers d'upload passent par
// saveAttachment (db/uploads est fixe dans le dépôt, les fichiers créés sont
// tous supprimés par les suppressions de conversation du scénario).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

// ── base jetable isolée : HERMES_CHAT_DB AVANT l'import du Store ─────────
const tmpDir = mkdtempSync(join(tmpdir(), "hermes-fork-up-"));
process.env.HERMES_CHAT_DB = join(tmpDir, "hermes-chat.sqlite");
mkdirSync(join(tmpDir, "db", "uploads"), { recursive: true });
function cleanupDb() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* déjà retiré */
  }
}

async function main() {
  const { Store } = await import("../mini-services/hermes-chat/store");
  const {
    saveAttachment,
    resolveUploadFile,
    deleteAttachmentFiles,
  } = await import("../mini-services/hermes-chat/uploads");
  const store = new Store();

  // Séquence EXACTE du handler conversations:delete (handlers/conversations.ts)
  // : les fichiers sont purgés PAR LE HANDLER (conversationAttachments →
  // deleteAttachmentFiles) avant store.deleteConversation — le test reproduit
  // cet enchaînement plutôt que d'appeler le store seul.
  function deleteConversationLikeHandler(id: string) {
    deleteAttachmentFiles(store.conversationAttachments(id));
    store.deleteConversation(id);
  }
  try {
    // PNG minimal (signature 8 octets + IHDR) — le contenu importe peu, seul
    // l'aller-retour disque compte.
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );

    console.log("[1] le fork COPIE les pièces jointes (nouvel id, nouveau fichier)");
    const conv = store.createConversation("fork-uploads");
    const att = saveAttachment("capture.png", "image/png", PNG.toString("base64"));
    const originPath = resolveUploadFile(att.url)!.filePath;
    check("pièce jointe d'origine écrite sur disque", existsSync(originPath), att.url);
    const msg = store.appendMessage({
      conversationId: conv.id,
      role: "user",
      content: "vois cette image",
      attachments: [att],
    });
    const forked = store.forkConversation(conv.id);
    check("fork créé", Boolean(forked), "forkConversation → null");
    const forkMsgs = store.getMessages(forked!.id);
    const forkAtt = forkMsgs[0]?.attachments?.[0];
    check("le message forké porte une pièce jointe", Boolean(forkAtt));
    check("id de pièce jointe DIFFÉRENT dans le fork", forkAtt!.id !== att.id, `${att.id} → ${forkAtt!.id}`);
    check("url DIFFÉRENTE dans le fork", forkAtt!.url !== att.url, forkAtt!.url);
    check("métadonnées conservées (nom, type, taille)", forkAtt!.name === att.name && forkAtt!.mime === att.mime && forkAtt!.size === att.size);
    const forkPath = resolveUploadFile(forkAtt!.url)!.filePath;
    check("le FICHIER du fork existe (copie physique)", existsSync(forkPath));
    check("l'original existe toujours", existsSync(originPath));

    console.log("[2] supprimer l'ORIGINALE ne casse pas le fork");
    deleteConversationLikeHandler(conv.id);
    check("fichier d'origine délinké", !existsSync(originPath));
    check("fichier du fork INTACT", existsSync(forkPath));
    check("le fichier du fork reste SERVABLE", resolveUploadFile(forkAtt!.url)?.mime === "image/png");

    console.log("[3] supprimer le fork purge bien SA copie");
    deleteConversationLikeHandler(forked!.id);
    check("fichier du fork délinké à son tour", !existsSync(forkPath));

    console.log("[4] source déjà absente : attachment forké tel quel (jamais pire)");
    const conv2 = store.createConversation("fork-uploads-fantome");
    const fantome = { ...att, id: "absent-12345678", url: "/uploads/absent-12345678.png" };
    store.appendMessage({ conversationId: conv2.id, role: "user", content: "fichier disparu", attachments: [fantome] });
    const forked2 = store.forkConversation(conv2.id)!;
    const f2 = store.getMessages(forked2.id)[0]?.attachments?.[0];
    check("attachment introuvable conservé SANS nouvelle copie", f2!.url === fantome.url, f2!.url);
    deleteConversationLikeHandler(conv2.id);
    deleteConversationLikeHandler(forked2.id);
  } finally {
    cleanupDb();
  }
  console.log(`\n${failures === 0 ? "TOUS LES TESTS PASSENT" : `${failures} ÉCHEC(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
