// Test E2E du versionnage fichiers (F-26) — journal des versions.
// Partie A (--part=a) : politique du journal sur une base isolée (dédoublonnage,
//            purge FIFO + épinglage, plafond d'épingles, restauration).
// Partie B (--part=b) : cycle complet par socket sur le service réel (étiqueter,
//            épingler, restaurer — ack + broadcast), sans tour LLM
//            (artefacts semés directement dans la base du service).
// Sans argument : lance A en sous-processus (base isolée) puis B (service réel).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Partie A : politique du journal (base isolée) ───────────────────────────
async function partA() {
  console.log("\nPartie A — politique du journal (base isolée)");
  process.env.HERMES_CHAT_DB = `/tmp/hermes-versions-test-${Date.now()}.sqlite`;
  const { Store } = await import("../mini-services/hermes-chat/store");
  const { MAX_VERSIONS, MAX_PINNED } = await import("../mini-services/hermes-chat/versions");
  const store = new Store();
  const convId = crypto.randomUUID();

  const mk = (content: string, status: string = "ready") =>
    store.insertArtifact({
      conversationId: convId,
      messageId: "m-" + Math.random().toString(36).slice(2, 8),
      key: "journal-test.md",
      kind: "markdown",
      name: "journal-test.md",
      mime: "text/markdown",
      content,
      status: status as any,
    });

  // 1. Naissance : v1
  const v1 = mk("# Version A");
  check("v1 créée", v1.version === 1);

  // 2. Dédoublonnage : ré-émission identique (ready) → PAS de nouvelle version
  const again = mk("# Version A");
  check("ré-émission identique → pas de version", again.version === 1 && again.id === v1.id);

  // 3. Contenu changé → v2
  const v2 = mk("# Version B");
  check("contenu changé → v2", v2.version === 2);

  // 4. Ré-émission identique de v2 → toujours v2
  check("ré-émission de v2 → pas de v3", mk("# Version B").version === 2);

  // 5. La version courante seule compte : revenir au contenu de v1 crée v3
  check("contenu de v1 réémis après v2 → v3", mk("# Version A").version === 3);

  // 6. Version en erreur : la même ré-émission crée une version (refaire)
  store.updateArtifact(store.listArtifactVersions(convId, "journal-test.md").at(-1)!.id, {
    status: "error",
    error: "Génération interrompue",
  });
  check("ré-émission après erreur → nouvelle version", mk("# Version A").version === 4);

  // 7. Restauration : crée v(n+1), libellé + marqueur, contenu copié
  const v1Row = store.listArtifactVersions(convId, "journal-test.md").find((r) => r.version === 1)!;
  const restored = store.restoreArtifactVersion(convId, "journal-test.md", 1)!;
  check(
    "restauration → v5 = copie de v1",
    restored.version === 5 &&
      restored.content === v1Row.content &&
      restored.restored_from === 1 &&
      restored.label === "Restauration de v1"
  );

  // 8. Épinglage + purge FIFO : épingles et courante survivent
  const versions = () => store.listArtifactVersions(convId, "journal-test.md");
  store.setArtifactPinned(v1Row.id, true);
  // Remplit jusqu'à 55 versions (contenus tous différents)
  for (let i = 0; i < 50; i++) mk(`# Contenu ${i} — ${Date.now()}-${Math.random()}`);
  check("55 versions au total", versions().length === 55);
  const purged = store.purgeArtifactVersions(convId, "journal-test.md");
  check(
    `purge FIFO → ${MAX_VERSIONS} versions restantes`,
    versions().length === MAX_VERSIONS && purged.length === 5
  );
  const after = versions();
  check(
    "v1 épinglée + version courante survivent",
    after.some((r) => r.id === v1Row.id) &&
      after.reduce((m, r) => Math.max(m, r.version), 0) === 55 &&
      !after.some((r) => purged.some((p) => p.id === r.id))
  );

  // 9. Plafond d'épingles : 10 max
  for (let i = 1; i < MAX_PINNED; i++) store.setArtifactPinned(after[i].id, true);
  const refuse = store.setArtifactPinned(after[MAX_PINNED + 2].id, true);
  check(
    `plafond ${MAX_PINNED} épingles refusé au-delà`,
    !!refuse.error &&
      versions().filter((r) => r.pinned).length === MAX_PINNED
  );
}

// ── Partie B : cycle complet par socket (service réel) ──────────────────────
function partB(): Promise<void> {
  console.log("\nPartie B — cycle socket (étiqueter, épingler, restaurer)");
  const socket = io("http://localhost:3003", { transports: ["websocket"] });
  const broadcasts: string[] = [];

  return new Promise((resolve) => {
    socket.on("artifact:updated", (p: any) => {
      broadcasts.push(`v${p.artifact?.version}:${p.artifact?.status ?? "?"}`);
    });
    const timer = setTimeout(() => {
      console.error("TIMEOUT partie B");
      done(1);
    }, 30000);
    const done = (code: number) => {
      clearTimeout(timer);
      socket.close();
      resolve();
      if (code) process.exit(code);
    };
    const finish = () => {
      console.log(`\nSUCCÈS — ${passed} contrôles verts${failed ? `, ${failed} ÉCHECS` : ""}`);
      done(failed ? 1 : 0);
    };

    socket.on("connect", () => {
      // Semis direct dans la base du service (même SQLite) — sans tour LLM.
      import("../mini-services/hermes-chat/store").then(({ Store }) => {
        const store = new Store();
        const created = store.createConversation("Test versionnage F-26");
        const convId = created.id;
        const msgId = "msg-" + crypto.randomUUID().slice(0, 8);
        store.appendMessage({ id: msgId, conversationId: convId, role: "user", content: "semis" });
        const mk = (content: string) =>
          store.insertArtifact({
            conversationId: convId,
            messageId: msgId,
            key: "maquette.html",
            kind: "html",
            name: "maquette.html",
            mime: "text/html",
            content,
            status: "ready",
          });
        const v1 = mk("<h1>Un</h1>");
        const v2 = mk("<h1>Deux</h1>");
        const v3 = mk("<h1>Trois</h1>");

        // 10. Journal lisible par le service (wire complet)
        socket.emit(
          "artifact:versions",
          { conversationId: convId, key: "maquette.html" },
          (res: any) => {
            check("journal servi : 3 versions wire", res.versions?.length === 3);
            check("wire sans contenu mais avec urls", !!res.versions?.[0]?.url && !("content" in (res.versions?.[0] ?? {})));

            // 11. Étiqueter v1 (ack + broadcast)
            socket.emit(
              "artifact:label",
              { artifactId: v1.id, label: "version client" },
              (res: any) => {
                check("étiquette posée (ack)", res.artifact?.label === "version client");
                // (la diffusion est vérifiée à la fin — elle arrive après l'ack)

                // 12. Épingler v1
                socket.emit(
                  "artifact:pin",
                  { artifactId: v1.id, pinned: true },
                  (res: any) => {
                    check("épinglée (ack)", res.artifact?.pinned === true);

                    // 13. Restaurer v1 → v4, marqueur + libellé auto
                    socket.emit(
                      "artifact:restore",
                      { conversationId: convId, key: "maquette.html", version: 1 },
                      (res: any) => {
                        check(
                          "restauration → v4 d'après v1",
                          res.artifact?.version === 4 &&
                            res.artifact?.restoredFrom === 1 &&
                            res.artifact?.label === "Restauration de v1"
                        );
                        // La copie est une NOUVELLE ligne : id propre, contenu copié
                        const v4 = store.getArtifactRow(res.artifact.id);
                        check(
                          "v4 nouvelle ligne au contenu de v1",
                          !!v4 && v4.id !== v1.id && v4.content === "<h1>Un</h1>"
                        );

                        // 14. Journal final : 4 versions
                        socket.emit(
                          "artifact:versions",
                          { conversationId: convId, key: "maquette.html" },
                          (res: any) => {
                            const vs = res.versions ?? [];
                            check("journal final : 4 versions", vs.length === 4);
                            // 15. Nettoyage : la conversation purge ses versions
                            socket.emit(
                              "conversations:delete",
                              { id: convId },
                              () => {
                                import("../mini-services/hermes-chat/store").then(
                                  ({ Store }) => {
                                    const left = new Store().listConversationArtifacts(convId);
                                    check("suppression → journal purgé", left.length === 0);
                                    // Diffusions (collectées pendant tout le cycle —
                                    // elles arrivent après les ack, on les vérifie à la fin)
                                    check(
                                      "étiquette + épinglage diffusés",
                                      broadcasts.filter((b) => b.startsWith("v1:")).length >= 2
                                    );
                                    check(
                                      "restauration diffusée (rendu html)",
                                      broadcasts.some((b) => b.startsWith("v4:"))
                                    );
                                    finish();
                                  }
                                );
                              }
                            );
                          }
                        );
                      }
                    );
                  }
                );
              }
            );
          }
        );
      });
    });

    socket.on("connect_error", (e: Error) => {
      console.error("connexion service impossible :", e.message);
      done(1);
    });
    setTimeout(() => {
      console.error("TIMEOUT partie B");
      done(1);
    }, 30000);
  });
}

(async () => {
  const part = process.argv.includes("--part=a") ? "a" : process.argv.includes("--part=b") ? "b" : null;
  if (part === "a") {
    try {
      await partA();
    } catch (e) {
      console.error("Partie A échouée :", e);
      process.exit(1);
    }
    process.exit(failed ? 1 : 0);
  }
  if (part === "b") {
    await partB();
    process.exit(0);
    return;
  }
  // Orchestration : A dans un sous-processus (env HERMES_CHAT_DB isolée,
  // le module store résout son chemin à l'import et le garde en cache).
  const proc = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--part=a"],
    { stdio: "inherit" }
  );
  if (proc.status !== 0) {
    console.error("\nPartie A en échec — arrêt.");
    process.exit(1);
  }
  await partB();
  process.exit(0);
})();
