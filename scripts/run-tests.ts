// Runner de tests (Lot 4, audit L4-1) : enchaîne les scripts/test-*.ts dans
// l'ordre, un processus bun isolé par test (un crash ne coupe pas la suite),
// et résume les résultats. Les modes :
//
//   bun scripts/run-tests.ts            → suite AUTONOME : les tests qui
//                                         n'exigent pas de service sur 3003
//                                         (fixtures auto-portées) — c'est la
//                                         suite de CI (npm test)
//   bun scripts/run-tests.ts --e2e      → la suite complète : démarre le
//                                         mini-service sur 3003/3004 si aucune
//                                         instance n'écoute déjà (le stoppe en
//                                         fin de course si elle l'a démarré),
//                                         avec un FAUX MOTEUR LLM local et une
//                                         base jetable (db-test-e2e). NB : les
//                                         tests qui vérifient le CONTENU des
//                                         réponses (mémoire citée, lettre du
//                                         prompt système, fichiers produits,
//                                         comparaisons a/b) exigent le VRAI
//                                         moteur (clés fournisseur ou agent) —
//                                         avec le faux moteur de base, ils
//                                         échouent chez eux, c'est attendu.
//   bun scripts/run-tests.ts --qa-dom   → chaîne les scripts/qa-*-dom.ts
//                                         (pile complète + navigateur requis,
//                                         hors CI)
//   bun scripts/run-tests.ts <filtre>   → ne lance que les tests dont le nom
//                                         contient <filtre> (toutes suites)
//
// Convention des tests : exit 0 = tout passe, exit 1 = échec, exit 42 = SKIP
// (précondition absente — ex. caddy indisponible : neutre, jamais un échec).
// Convention des fixtures : un test qui a besoin d'un service sur des ports
// dédiés le démarre LUI-MÊME ou le déclare ci-dessous (SERVICE_FIXTURES) ;
// les variables HERMES_* du shell courant sont retirées de l'env des tests
// pour qu'un jeton/port hérité ne change pas leur verdict.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { io } from "socket.io-client";

const ROOT = join(import.meta.dir, "..");
const SCRIPTS = join(ROOT, "scripts");

// Jeton fixe du test jeton (scripts/test-service-token.ts) — le runner
// démarre pour lui un service dédié sur 3303/3304 avec ce jeton.
const TOKEN_TEST_TOKEN = "test-token-JetonService-1234567890abcdef";

/** Fixtures de service : nom de fichier → service dédié à démarrer avant lui. */
const SERVICE_FIXTURES: Record<string, { port: number; filesPort: number; token?: string }> = {
  "test-service-token.ts": { port: 3303, filesPort: 3304, token: TOKEN_TEST_TOKEN },
};

interface Result {
  name: string;
  status: "OK" | "ÉCHEC" | "SKIP" | "TIMEOUT";
  ms: number;
  detail?: string;
}

function listTests(pattern: RegExp): string[] {
  if (!existsSync(SCRIPTS)) return [];
  return readdirSync(SCRIPTS)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => join(SCRIPTS, f));
}

/** Un test est E2E s'il cible la pile live : service sur 3003, interface sur
 *  3000, ou navigateur (playwright). Ces tests ne tournent qu'en --e2e / qa. */
function isE2E(file: string): boolean {
  try {
    const src = readFileSync(file, "utf8");
    return src.includes(":3003") || src.includes(":3000") || src.includes(`from "playwright"`);
  } catch {
    return false;
  }
}

function waitHttp(url: string, tries = 60): Promise<boolean> {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url);
        if (res.status < 600) return true;
      } catch {
        /* pas encore prêt */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })();
}

// ── Faux moteur LLM de la suite E2E (Lot 4) ──────────────────────────────
// Les tests E2E demandent des tours RÉELS : sans moteur (base neuve, aucune
// clé, pas d'agent), le service répond noEngineError et la suite entière
// échoue — elle ne tournait que sur le poste de l'autrice (clés/Ollama).
// Le runner démarre un serveur OpenAI-compatible local, le pré-déclare au
// service via providers:add + providers:add-key, et pointe le service sur
// une base jetable (db-test-e2e) : zéro pollution de la base de dev.
const E2E_MOCK_PORT = 4619;
const E2E_DB_DIR = join(ROOT, "db-test-e2e");
let e2eMockServer: ReturnType<typeof createServer> | null = null;

function startE2eMockLlm(): Promise<void> {
  return new Promise((resolve) => {
    e2eMockServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-e2e" }] }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/chat/completions") {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString()));
        req.on("end", () => {
          let stream = false;
          try { stream = Boolean(JSON.parse(raw || "{}").stream); } catch { /* non JSON */ }
          if (!stream) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              choices: [{ message: { content: "Résumé mock — sujet, décisions, artefacts, prochaines étapes." } }],
            }));
            return;
          }
          // SSE rythmé (~1,5 s) : les tours restent stoppables en vol
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          let i = 0;
          const timer = setInterval(() => {
            i++;
            if (i <= 12) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ` mot${i}` } }] })}\n\n`);
            else {
              clearInterval(timer);
              res.write("data: [DONE]\n\n");
              res.end();
            }
          }, 120);
          res.on("close", () => clearInterval(timer));
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    e2eMockServer.listen(E2E_MOCK_PORT, "127.0.0.1", () => resolve());
  });
}

/** Déclare le faux moteur au service E2E (socket éphémère, jeton absent). */
async function seedE2eProvider(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = io("http://127.0.0.1:3003", { transports: ["websocket"], timeout: 8000 });
    const done = (ok: boolean) => {
      socket.disconnect();
      resolve(ok);
    };
    const fail = setTimeout(() => done(false), 8000);
    socket.on("connect", async () => {
      const emit = (ev: string, payload: unknown) =>
        new Promise<any>((r) => socket.emit(ev, payload, (res: any) => r(res ?? {})));
      // Route fournisseur CONNU (« ollama ») + baseUrl explicite : le nom
      // devient « Ollama » — sans quoi le nom normalisé « 127.0.0.1 »
      // colisionnait avec les tests qui déclarent LEUR propre mock local
      // (test-cost-flow, test-pool-flow : « est déjà dans la liste »).
      const add = await emit("providers:add", {
        name: "ollama",
        kind: "llm",
        baseUrl: `http://127.0.0.1:${E2E_MOCK_PORT}`,
      });
      if (!add?.provider) {
        clearTimeout(fail);
        return done(false);
      }
      const key = await emit("providers:add-key", {
        providerId: add.provider.id,
        label: "E2E",
        secret: "sk-e2e-mock-0000000000",
      });
      clearTimeout(fail);
      done(Boolean(key?.key?.id));
    });
    socket.on("connect_error", () => {
      clearTimeout(fail);
      done(false);
    });
  });
}

/** Démarre un service de fixture et attend qu'il écoute. */
async function startFixture(cfg: { port: number; filesPort: number; token?: string }): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    "bun",
    [join(ROOT, "mini-services", "hermes-chat", "index.ts")],
    {
      cwd: join(ROOT, "mini-services", "hermes-chat"),
      env: {
        ...process.env,
        HERMES_CHAT_PORT: String(cfg.port),
        HERMES_CHAT_FILES_PORT: String(cfg.filesPort),
        ...(cfg.token ? { HERMES_SERVICE_TOKEN: cfg.token } : {}),
      },
      stdio: "ignore",
    },
  );
  const up = await waitHttp(`http://127.0.0.1:${cfg.port}/socket.io/?EIO=4&transport=polling`);
  if (!up) {
    child.kill();
    throw new Error(`fixture service (${cfg.port}) injoignable après démarrage`);
  }
  return child;
}

/** Env déterministe pour les tests : les réglages HERMES_* hérités du shell
 *  ne doivent pas influencer le verdict (jeton, ports, mode). */
function testEnv(): NodeJS.ProcessEnv {
  const { HERMES_CHAT_PORT, HERMES_CHAT_FILES_PORT, HERMES_SERVICE_TOKEN, NEXT_PUBLIC_SERVICE_TOKEN, ...rest } =
    process.env as Record<string, string | undefined>;
  return rest as NodeJS.ProcessEnv;
}

async function runOne(
  file: string,
  timeoutMs: number,
  fixture?: { port: number; filesPort: number; token?: string },
): Promise<Result> {
  const name = file.split("/").pop()!;
  const started = Date.now();
  console.log(`\n▶ ${name}`);
  let child: ReturnType<typeof spawn> | null = null;
  let fixtureProc: ReturnType<typeof spawn> | null = null;
  try {
    if (fixture) fixtureProc = await startFixture(fixture);
    child = spawn("bun", [file], {
      cwd: ROOT,
      env: testEnv(),
      stdio: "inherit",
      // detached : le kill vise le GROUPE — un test qui a démarré son propre
      // service ne le laisse pas orphelin derrière le timeout.
      detached: true,
    });
    const code = await new Promise<number | "TIMEOUT">((resolve) => {
      const t = setTimeout(() => {
        try {
          process.kill(-child!.pid!, "SIGTERM");
        } catch {
          child!.kill();
        }
        resolve("TIMEOUT");
      }, timeoutMs);
      child!.on("exit", (c) => {
        clearTimeout(t);
        resolve(c ?? 1);
      });
    });
    const ms = Date.now() - started;
    if (code === "TIMEOUT")
      return { name, status: "TIMEOUT", ms, detail: `${Math.round(timeoutMs / 1000)} s dépassées` };
    if (code === 0) return { name, status: "OK", ms };
    if (code === 42) return { name, status: "SKIP", ms };
    return { name, status: "ÉCHEC", ms, detail: `exit ${code}` };
  } catch (err) {
    return {
      name,
      status: "ÉCHEC",
      ms: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      process.kill(-child!.pid!, "SIGTERM");
    } catch {
      child?.kill();
    }
    fixtureProc?.kill();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wantE2E = args.includes("--e2e");
  const wantQaDom = args.includes("--qa-dom");
  const filter = args.find((a) => !a.startsWith("--"));

  const allTests = listTests(/^test-.*\.ts$/);
  const qaDomTests = wantQaDom ? listTests(/^qa-.*-dom\.ts$/) : [];
  if (allTests.length === 0 && qaDomTests.length === 0) {
    console.error("aucun test trouvé sous scripts/");
    process.exit(1);
  }

  const unit: { file: string; fixture?: (typeof SERVICE_FIXTURES)[string] }[] = [];
  const e2e: { file: string; fixture?: (typeof SERVICE_FIXTURES)[string] }[] = [];
  for (const f of allTests) {
    const entry = { file: f, fixture: SERVICE_FIXTURES[f.split("/").pop()!] };
    if (isE2E(f)) e2e.push(entry);
    else unit.push(entry);
  }

  let selected: { file: string; fixture?: (typeof SERVICE_FIXTURES)[string] }[] = [];
  if (wantQaDom) selected = selected.concat(qaDomTests.map((f) => ({ file: f })));
  if (!wantQaDom || filter) {
    // Mode normal (ou filtre explicite) : autonome par défaut, E2E seulement
    // si --e2e. Un filtre traverse les deux suites.
    selected = selected.concat(unit);
    if (wantE2E || filter) selected = selected.concat(e2e);
  }

  if (filter) selected = selected.filter((t) => t.file.includes(filter));
  if (selected.length === 0) {
    console.error("aucun test ne correspond aux critères");
    process.exit(1);
  }

  console.log(
    `Runner de tests — ${selected.length} test(s) : ` +
      `${selected.filter((t) => unit.includes(t)).length} autonome(s), ` +
      `${selected.filter((t) => e2e.includes(t)).length} E2E` +
      (wantQaDom ? `, ${qaDomTests.length} qa-dom` : ""),
  );

  const results: Result[] = [];
  // Suite E2E : UN seul service partagé par tous les tests — démarré si aucune
  // instance n'écoute déjà sur 3003 (dans ce cas on la laisse vivante : c'est
  // la pile de dev), et on stoppe le nôtre en fin de course. La sortie du
  // service est capturée pour diagnostiquer un démarrage raté.
  const e2eSelected = selected.filter((t) => e2e.includes(t));
  let sharedProc: ReturnType<typeof spawn> | null = null;
  let e2eRunnable = e2eSelected.length === 0; // rien à démarrer = rien à bloquer
  let sharedLog = "";
  if (e2eSelected.length > 0) {
    const alreadyUp = await waitHttp("http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling", 2);
    if (alreadyUp) {
      e2eRunnable = true; // instance de dev déjà en place : on s'y branche
    } else {
      console.log("\n• démarrage du mini-service partagé (3003/3004, faux moteur local) pour la suite E2E…");
      await startE2eMockLlm();
      // Base jetable de la suite E2E : les tests écrivent conversations/
      // artefacts sans jamais toucher la base de dev (db-test-e2e, ignoré
      // par git via /db-test-*/).
      rmSync(E2E_DB_DIR, { recursive: true, force: true });
      mkdirSync(E2E_DB_DIR, { recursive: true });
      sharedProc = spawn("bun", [join(ROOT, "mini-services", "hermes-chat", "index.ts")], {
        cwd: join(ROOT, "mini-services", "hermes-chat"),
        env: { ...testEnv(), HERMES_CHAT_DB: join(E2E_DB_DIR, "hermes-chat.sqlite") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const s of [sharedProc.stdout, sharedProc.stderr]) {
        s?.on("data", (d: Buffer) => {
          sharedLog += d.toString();
          if (sharedLog.length > 4000) sharedLog = sharedLog.slice(-4000);
        });
      }
      // Budget large (40 s comme les harnais des tests) : un poste froid ne
      // doit pas faire rater toute la suite.
      const up = await waitHttp("http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling", 160);
      if (up) {
        // Pré-seed du faux moteur : sans clé, chaque tour répondrait
        // noEngineError et la suite échouerait entière (Lot 4).
        e2eRunnable = await seedE2eProvider();
        if (!e2eRunnable) {
          sharedProc.kill();
          sharedProc = null;
          console.error("pré-seed du faux moteur E2E impossible — suite E2E annulée");
          for (const t of e2eSelected)
            results.push({ name: t.file.split("/").pop()!, status: "SKIP", ms: 0, detail: "faux moteur non déclaré" });
          e2eRunnable = false;
          e2eSelected.length = 0;
        }
      } else {
        sharedProc.kill();
        console.error(`service E2E injoignable après démarrage — suite E2E annulée\nsortie du service :\n${sharedLog.trim() || "(aucune)"}`);
        // Ne PAS exécuter les tests E2E sans service : ils seraient comptés
        // deux fois (échec virtuel + vraie exécution qui rate aussi). SKIP
        // neutre (précondition absente), le diagnostic est imprimé au-dessus.
        sharedProc = null;
        for (const t of e2eSelected)
          results.push({ name: t.file.split("/").pop()!, status: "SKIP", ms: 0, detail: "service partagé indisponible" });
        e2eRunnable = false;
        e2eSelected.length = 0; // marqués : la boucle ci-dessous ne les exécute plus
      }
    }
  }
  try {
    for (const t of selected) {
      if (e2e.includes(t) && !e2eRunnable) continue; // SKIP déjà compté
      results.push(await runOne(t.file, wantQaDom && !unit.includes(t) ? 600_000 : 300_000, t.fixture));
    }
  } finally {
    sharedProc?.kill();
    e2eMockServer?.close();
  }

  const failed = results.filter((r) => r.status === "ÉCHEC" || r.status === "TIMEOUT");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log("\n════════ Résumé ════════");
  for (const r of results) {
    const ms = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms} ms`;
    console.log(`${r.status.padEnd(7)}  ${r.name}  (${ms})${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(
    `\n${results.length - failed.length - skipped.length}/${results.length} passé(s), ` +
      `${skipped.length} ignoré(s), ${failed.length} échec(s)`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Erreur du runner :", err);
  process.exit(1);
});
