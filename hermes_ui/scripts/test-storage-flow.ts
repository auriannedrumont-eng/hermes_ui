// Test E2E du domaine « stockage » (v0.3.0 — page Stockage du volet).
// Partie A (--part=a) : définition canonique du « nettoyable » sur une base
//            isolée (jeux limites de la spécification §5.2 : version unique,
//            document épinglé, dix versions ; idempotence du nettoyage ;
//            fenêtre d'annulation 7 s ; refus épinglée).
// Partie B (--part=b) : contrat socket complet contre le service réel :
//            storage:list (inventaire plat, projets résolus),
//            storage:deleteVersion (409 épinglée / 404 absente + jeton),
//            storage:cleanProject (delta MESURÉ, idempotent, jeton),
//            storage:undo (restauration exacte / 410 après expiration),
//            broadcast storage:changed après chaque mutation.
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

// ── Partie A : définition canonique du nettoyable (base isolée) ────────────
async function partA() {
  console.log("\nPartie A — définition canonique + fenêtres (base isolée)");
  process.env.HERMES_CHAT_DB = `/tmp/hermes-storage-test-${Date.now()}.sqlite`;
  const { Store } = await import("../mini-services/hermes-chat/store");
  const { openUndoWindow, consumeUndoWindow } = await import("../mini-services/hermes-chat/store-storage");
  const { STORAGE_UNDO_MS, isStorageCleanable } = await import(
    "../mini-services/hermes-chat/shared/chat-protocol"
  );

  const store = new Store();
  const conv = store.createConversation("Test stockage A");
  const convId = conv.id;
  const msgId = "m-" + Math.random().toString(36).slice(2, 8);

  const mk = (key: string, content: string, pinned = false) => {
    const row = store.insertArtifact({
      conversationId: convId,
      messageId: msgId,
      key,
      kind: "markdown",
      name: key,
      mime: "text/markdown",
      content,
      status: "ready",
    });
    if (pinned) store.setArtifactPinned(row.id, true);
    return row;
  };

  // T13a — document à version unique : rien de nettoyable.
  mk("unique.md", "seule version");
  const entries = store.listStorageEntries();
  const unique = entries.filter((e) => e.key === "unique.md");
  check(
    "T13 version unique → jamais nettoyable",
    unique.length === 1 && isStorageCleanable(unique[0], unique[0].version) === false
  );

  // T13b — dix versions : les 9 dépassées sont nettoyables, la courante non.
  for (let i = 1; i <= 10; i++) mk("journal.md", `# contenu ${i}`);
  const journal = store.listStorageEntries().filter((e) => e.key === "journal.md");
  const maxJ = journal.reduce((m, e) => Math.max(m, e.version), 0);
  check(
    "T13 dix versions → 9 nettoyables + la courante",
    journal.length === 10 &&
      journal.filter((e) => isStorageCleanable(e, maxJ)).length === 9 &&
      journal.every((e) => (e.version === maxJ ? !isStorageCleanable(e, maxJ) : true))
  );

  // T13c — document épinglé : la version épinglée n'est JAMAIS nettoyable,
  // même dépassée (l'épingle protège, pas seulement la dernière).
  const pinnedV1 = mk("epingle.md", "v1 du doc épinglé", true);
  mk("epingle.md", "v2 du doc");
  const ep = store.listStorageEntries().filter((e) => e.key === "epingle.md");
  const maxE = ep.reduce((m, e) => Math.max(m, e.version), 0);
  check(
    "T13 document épinglé → la v1 épinglée protégée",
    ep.length === 2 &&
      isStorageCleanable(ep.find((e) => e.version === 1)!, maxE) === false
  );

  // T12 (côté store) — suppression d'une version épinglée : refus franc.
  const refus = store.deleteStorageVersion(pinnedV1.id);
  check("T12 suppression épinglée → refus « pinned »", "refuse" in refus && refus.refuse === "pinned");
  const refusAbs = store.deleteStorageVersion("id-inconnu");
  check("T12 suppression absente → refus « notfound »", "refuse" in refusAbs && refusAbs.refuse === "notfound");

  // Nettoyage + delta mesuré (T15 côté store) : le projet de la
  // conversation (null = hors projet) → les 9 versions dépassées de
  // journal.md partent, v10 reste ; l'épinglée d'epingle.md et unique.md
  // (version unique) ne bougent pas.
  const t0 = store.listStorageEntries();
  const bytesAvant = t0.reduce((s, e) => s + e.size, 0);
  const doomed = store.cleanStorageProject(null);
  const t1 = store.listStorageEntries();
  check(
    "nettoyage hors projet : 9 versions dépassées de journal.md partent",
    doomed.length === 9 &&
      doomed.every((r) => r.key === "journal.md" && r.version < 10)
  );
  check(
    "unique.md + épinglée + courantes conservées",
    t1.length === t0.length - 9 &&
      t1.some((e) => e.key === "unique.md") &&
      t1.some((e) => e.key === "epingle.md" && e.version === 1) &&
      t1.some((e) => e.key === "epingle.md" && e.version === 2) &&
      t1.some((e) => e.key === "journal.md" && e.version === 10)
  );
  const bytesMesure = doomed.reduce((s, r) => s + r.size, 0);
  check(
    "T15 delta mesuré = octets des lignes parties",
    bytesAvant - bytesMesure === t1.reduce((s, e) => s + e.size, 0)
  );
  check("idempotent : second nettoyage ne trouve rien", store.cleanStorageProject(null).length === 0);

  // T14 — fenêtre d'annulation 7 s : restauration exacte, puis 410.
  // On part de la version courante restante (v10, non épinglée) : on la
  // supprime, on annule (elle revient), puis une seconde fenêtre est
  // laissée EXPIRER — le jeton doit être refusé.
  const restorable = t1.find((e) => e.key === "journal.md" && e.version === 10);
  const del = store.deleteStorageVersion(restorable!.id);
  if (!("row" in del)) {
    check("T14 suppression préalable", false);
  } else {
    const token = openUndoWindow([del.row]);
    const undo = consumeUndoWindow(token, store);
    check(
      "T14 annulation dans la fenêtre → exactement 1 restaurée",
      "restored" in undo && undo.restored.length === 1 && undo.restored[0].id === del.row.id
    );
    check(
      "ligne revenue à l'identique (taille comprise)",
      store.getArtifactRow(del.row.id)?.size === del.row.size
    );
    // Fenêtre expirée : une seconde fenêtre est laissée EXPIRER — le jeton
    // doit être refusé et rien de plus ne doit être réinséré (la ligne,
    // restaurée par la première annulation, est toujours là : c'est l'état
    // cohérent — l'expiration ne détruit rien, elle interdit le retour).
    const token2 = openUndoWindow([del.row]);
    await new Promise((r) => setTimeout(r, STORAGE_UNDO_MS + 300));
    const tardif = consumeUndoWindow(token2, store);
    check("T14 fenêtre expirée → refus « gone »", "refuse" in tardif && tardif.refuse === "gone");
    check(
      "l'expiration ne réinsère pas en double",
      store.listArtifactVersions(convId, "journal.md").filter((r) => r.id === del.row.id).length === 1
    );
  }

  // Agrégation du regroupement client : cohérence des compteurs (T01).
  const parProjet = new Map<string, number>();
  for (const e of store.listStorageEntries()) {
    const k = e.projectName;
    parProjet.set(k, (parProjet.get(k) ?? 0) + 1);
  }
  check(
    "inventaire groupable : « Hors projet » unique",
    parProjet.size === 1 && parProjet.get("Hors projet") === store.listStorageEntries().length
  );
}

// ── Partie B : contrat socket complet (service réel) ──────────────────────
function partB(): Promise<void> {
  console.log("\nPartie B — contrat socket storage:* (service réel)");
  const socket = io("http://localhost:3003", { transports: ["websocket"] });
  const broadcasts: string[] = [];

  return new Promise((resolve) => {
    socket.on("storage:changed", () => broadcasts.push("changed"));
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
      import("../mini-services/hermes-chat/store").then(({ Store }) => {
        // Semis direct dans la base du service (même SQLite), sans tour LLM :
        // un projet, une conversation dedans, un document 3 versions dont
        // la dernière épinglée — le scénario limite de la spécification.
        const store = new Store();
        const projet = store.createProject("Test stockage B");
        const conv = store.createConversation("Stockage B", projet.id);
        const convId = conv.id;
        const msgId = "msg-" + crypto.randomUUID().slice(0, 8);
        const mk = (content: string) =>
          store.insertArtifact({
            conversationId: convId,
            messageId: msgId,
            key: "rapport.md",
            kind: "markdown",
            name: "rapport.md",
            mime: "text/markdown",
            content,
            status: "ready",
          });
        const v1 = mk("un");
        const v2 = mk("deux");
        const v3 = mk("trois");
        store.setArtifactPinned(v3.id, true);

        // T-API — storage:list : liste plate, projets résolus.
        socket.emit("storage:list", {}, (res: any) => {
          const mine = (res.entries ?? []).filter((e: any) => e.conversationId === convId);
          check(
            "T-API storage:list — liste plate avec projet résolu",
            mine.length === 3 &&
              mine.every((e: any) => e.projectId === projet.id && e.projectName === "Test stockage B")
          );
          check(
            "T-API tailles en octets (jamais formatées)",
            mine.every((e: any) => Number.isInteger(e.size) && e.size > 0)
          );

          // T12 — suppression d'une version épinglée : refus 409 (code pinned).
          socket.emit(
            "storage:deleteVersion",
            { id: v3.id },
            (resPin: any) => {
              check(
                "T12 épinglée → refus code « pinned » (409)",
                resPin?.ok === false && resPin?.code === "pinned"
              );
              // La ligne est conservée : aucun décompte.
              check(
                "T12 ligne épinglée conservée",
                !!store.getArtifactRow(v3.id)
              );

              // T11/T14 — suppression d'une version libre + annulation.
              socket.emit(
                "storage:deleteVersion",
                { id: v2.id },
                (resDel: any) => {
                  check(
                    "suppression v2 → ok + delta mesuré + jeton",
                    resDel?.ok === true &&
                      resDel.removed === 1 &&
                      resDel.bytesFreed === v2.size &&
                      typeof resDel.undoToken === "string" &&
                      resDel.undoToken.length > 0
                  );
                  check("ligne v2 partie", !store.getArtifactRow(v2.id));

                  socket.emit(
                    "storage:undo",
                    { token: resDel.undoToken },
                    (resUndo: any) => {
                      check(
                        "T14 annulation → exactement 1 restaurée",
                        resUndo?.ok === true && resUndo.restored === 1
                      );
                      check(
                        "T14 v2 revenue à l'identique",
                        store.getArtifactRow(v2.id)?.size === v2.size
                      );

                      // T15 — nettoyage du projet : v1 part (dépassée non
                      // épinglée), v2 restaurée part aussi, v3 épinglée reste.
                      socket.emit(
                        "storage:cleanProject",
                        { projectId: projet.id },
                        (resClean: any) => {
                          check(
                            "T15 nettoyage → 2 versions, delta mesuré exact",
                            resClean?.ok === true &&
                              resClean.removed === 2 &&
                              resClean.bytesFreed === v1.size + v2.size
                          );
                          // T10 — idempotence : relance immédiate → vide.
                          socket.emit(
                            "storage:cleanProject",
                            { projectId: projet.id },
                            (res2: any) => {
                              check(
                                "T10 idempotence (second nettoyage vide)",
                                res2?.ok === true && res2.removed === 0 && res2.bytesFreed === 0
                              );
                              // 404 — version absente.
                              socket.emit(
                                "storage:deleteVersion",
                                { id: "inconnu" },
                                (res404: any) => {
                                  check(
                                    "404 absente → code « notfound »",
                                    res404?.ok === false && res404?.code === "notfound"
                                  );
                                  // 410 — la fenêtre doit être HONNÊTE : le
                                  // jeton de clean est encore VALABLE ici
                                  // (annulable dans les 7 s, spec §4.5) —
                                  // on le consomme, puis on rejoue le jeton
                                  // consommé : refus « gone ».
                                  socket.emit(
                                    "storage:undo",
                                    { token: resClean.undoToken },
                                    (resUndoClean: any) => {
                                      check(
                                        "T14 jeton de nettoyage annulable (restaure 2)",
                                        resUndoClean?.ok === true && resUndoClean.restored === 2
                                      );
                                      socket.emit(
                                        "storage:undo",
                                        { token: resClean.undoToken },
                                        (res410: any) => {
                                          check(
                                            "410 jeton consommé → code « gone »",
                                            res410?.ok === false && res410?.code === "gone"
                                          );
                                          // Nettoyage final : la conversation de test
                                          // part (avec ses artefacts et son projet).
                                          socket.emit("conversations:delete", { id: convId }, () => {
                                            store.deleteProject(projet.id);
                                            const reste = new Store().listStorageEntries().filter(
                                              (e: any) => e.conversationId === convId
                                            );
                                            check("nettoyage final : conversation de test purgée", reste.length === 0);
                                            check(
                                              "storage:changed diffusé après les mutations",
                                              broadcasts.length >= 3
                                            );
                                            finish();
                                          });
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
            }
          );
        });
      });
    });

    socket.on("connect_error", (e: Error) => {
      console.error("connexion service impossible :", e.message);
      done(1);
    });
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
  // Orchestration : A en sous-processus (env HERMES_CHAT_DB isolée, le module
  // store résout son chemin à l'import et le garde en cache) puis B.
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
