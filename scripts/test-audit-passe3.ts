// Tests de non-régression — audit passe 3 (13/11/2026), lots 1 à 3.
// Couvre en unitaire (sans réseau, sans service lancé) :
//   [F-01] exports sans jeton de service (serviceUrl auth:false)
//   [F-05] plafond explicite de transcription (MAX_TRANSCRIBE_BYTES)
//   [F-06] baseUrl fournisseur : https requis, http sur localhost uniquement
//   [F-10] partages révoqués : titre purgé + purge des lignes > 90 jours
//   [F-11] allowlist de colonnes dans updateExtensionRow
// (F-02/F-07 sont couverts par scripts/test-integration-fixes.ts sur le
// vrai service ; F-04/F-09 sont des logs/ordre d'arrêt vérifiés là-bas.)
//
// Les variables d'environnement sont posées AVANT les imports dynamiques :
// DB_PATH (store.ts) et SERVICE_TOKEN (service.ts) se figent à l'import.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, extra = "") {
  checks++;
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const TMP = mkdtempSync(join(tmpdir(), "hermes-audit3-"));

  // ── [F-01] Export sans jeton ────────────────────────────────────────
  console.log("\n[F-01] Exports sans jeton de service");
  {
    process.env.NEXT_PUBLIC_SERVICE_TOKEN = "jeton-secret-f01-XYZ";
    const { conversationToMarkdown } = await import("../src/lib/export.ts");
    const { serviceUrl } = await import("../src/lib/service.ts");

    const md = conversationToMarkdown(
      { id: "c1", title: "Conv audit" } as never,
      [
        {
          role: "user",
          content: "voici une note",
          attachments: [
            { id: "a1", name: "note.txt", mime: "text/plain", size: 12, kind: "file", url: "/uploads/abc123def456.txt" },
          ],
        },
        { role: "assistant", content: "reçu" },
      ] as never
    );
    check("markdown exporté SANS jeton", !md.includes("jeton-secret-f01-XYZ"));
    check(
      "lien de pièce jointe présent (chemin relatif)",
      md.includes("](/uploads/abc123def456.txt?") || md.includes("](/uploads/abc123def456.txt)"),
      md.split("\n").find((l: string) => l.includes("note.txt"))?.slice(0, 90) ?? ""
    );
    check(
      "serviceUrl par défaut garde le jeton (img/iframe)",
      serviceUrl("/uploads/x.png").includes("token=jeton-secret-f01-XYZ")
    );
    check(
      "serviceUrl({auth:false}) sans jeton",
      !serviceUrl("/uploads/x.png", undefined, { auth: false }).includes("token=")
    );
    check(
      "routes /share/ toujours publiques",
      !serviceUrl("/share/AbcDefGhij/data.json").includes("token=")
    );
  }

  // ── [F-05] Plafond de transcription ─────────────────────────────────
  console.log("\n[F-05] Plafond de transcription audio");
  {
    const { transcribeAudioBase64, MAX_TRANSCRIBE_BYTES } = await import(
      "../mini-services/hermes-chat/asr.ts"
    );
    check(
      "plafond exposé (20 Mo)",
      MAX_TRANSCRIBE_BYTES === 20 * 1024 * 1024,
      `${MAX_TRANSCRIBE_BYTES}`
    );
    // 21 Mo de pseudo-base64 → refus IMMÉDIAT (avant tout appel SDK/ffmpeg)
    const big = Buffer.alloc(MAX_TRANSCRIBE_BYTES + 1024).toString("base64");
    const t0 = Date.now();
    let err: unknown = null;
    try {
      await transcribeAudioBase64(big, "audio/mpeg");
    } catch (e) {
      err = e;
    }
    check(
      "audio > plafond → erreur claire (sans appel réseau)",
      err instanceof Error && /trop volumineux/i.test(err.message),
      err instanceof Error ? err.message.slice(0, 60) : String(err)
    );
    check("refus immédiat (< 500 ms)", Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  }

  // ── [F-06] baseUrl fournisseur contrôlé ─────────────────────────────
  console.log("\n[F-06] Test de clé : baseUrl contrôlée");
  {
    const { testProviderKey } = await import("../mini-services/hermes-chat/providers.ts");
    const refused = await testProviderKey("perso", "http://192.168.1.50:8080", "k");
    check(
      "http vers IP locale → REFUSÉ avant tout appel",
      refused.status === "error" && /refusée/i.test(refused.statusLabel),
      refused.statusLabel
    );
    const badScheme = await testProviderKey("perso", "ftp://example.com", "k");
    check(
      "schéma non http(s) → refusé",
      badScheme.status === "error" && /refusée|invalide/i.test(badScheme.statusLabel),
      badScheme.statusLabel
    );
    // https valide → passe le contrôle de schéma (échec réseau attendu :
    // le domaine n'existe pas, l'étiquette parle de joignabilité, pas de refus)
    const httpsProbe = await testProviderKey("perso", "https://fournisseur-inexistant-audit3.invalid", "k");
    check(
      "https → contrôle passé (échec réseau, pas refus de schéma)",
      httpsProbe.status === "error" && !/refusée/i.test(httpsProbe.statusLabel),
      httpsProbe.statusLabel
    );
  }

  // ── [F-10] Partages révoqués : titre purgé + purge > 90 j ───────────
  console.log("\n[F-10] Partages révoqués (unitaire, base temporaire)");
  {
    process.env.HERMES_CHAT_DB = join(TMP, "store-audit3.sqlite");
    const { Store } = await import("../mini-services/hermes-chat/store.ts");
    const store = new Store();
    const conv = store.createConversation("Conv partage", null);
    store.createShare(conv.id, "Titre secret", JSON.stringify({ m: ["secret"] }), 1, "tokA1234567890abcdef");
    store.createShare(conv.id, "Titre deux", JSON.stringify({ m: ["deux"] }), 1, "tokB1234567890abcdef");
    store.revokeShareByConversation(conv.id);
    const revoked = store.getShareByToken("tokB1234567890abcdef");
    check(
      "révocation purge le TITRE (en plus du snapshot)",
      revoked?.title === "",
      `title=${JSON.stringify(revoked?.title)}`
    );

    // Vieillit la 1re ligne de 100 jours, la 2e de 10 jours
    const db = (store as any).db;
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    const recent = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    db.query("UPDATE shares SET revoked_at = ? WHERE token = ?").run(old, "tokA1234567890abcdef");
    db.query("UPDATE shares SET revoked_at = ? WHERE token = ?").run(recent, "tokB1234567890abcdef");

    const purged = store.purgeAgedRevokedShares(90);
    check("purge supprime exactement la ligne > 90 j", purged === 1, `${purged}`);
    check(
      "ligne révoquée récente conservée (sémantique 410)",
      store.getShareByToken("tokB1234567890abcdef") !== null
    );
    check("ligne > 90 j disparue", store.getShareByToken("tokA1234567890abcdef") === null);
    store.close();
  }

  // ── [F-11] Allowlist de colonnes updateExtensionRow ─────────────────
  console.log("\n[F-11] Allowlist de colonnes extensions");
  {
    process.env.HERMES_CHAT_DB = join(TMP, "store-ext-audit3.sqlite");
    // ré-import d'un module frais : le DB_PATH du premier import est figé.
    // Le suffixe « ?ext=1 » force bun à recharger le module sous une seconde
    // clé de cache ; le spécifiant non littéral reste opaque pour tsc.
    const freshStoreSpecifier = "../mini-services/hermes-chat/store.ts?ext=1";
    const { Store } = await import(freshStoreSpecifier);
    const store = new Store();
    const ext = store.createExtension({ name: "ext test", kind: "repo", version: "1.0.0" });
    let noThrow = true;
    try {
      // clé inconnue : doit être IGNORÉE (pas d'UPDATE sur une colonne
      // inexistante), pas lever d'erreur SQL
      store.updateExtensionRow(ext.id, {
        version: "2.0.0",
        evil_column: "pwned",
      } as never);
    } catch {
      noThrow = false;
    }
    const after = store.getExtensionRow(ext.id);
    check("clé inconnue ignorée sans erreur SQL", noThrow);
    check(
      "colonne autorisée bien mise à jour",
      after?.version === "2.0.0",
      `version=${after?.version}`
    );
    store.close();
  }

  // ── Nettoyage ────────────────────────────────────────────────────────
  await wait(100);
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* WAL encore ouvert : sans conséquence (tmpdir OS) */
  }

  console.log(
    failures === 0
      ? `\nAudit passe 3 (unitaire) : ${checks}/${checks} — 0 échec`
      : `\nAudit passe 3 (unitaire) : ${checks - failures}/${checks} — ${failures} échec(s)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du harnais :", e);
  process.exit(1);
});
