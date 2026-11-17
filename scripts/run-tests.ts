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
//                                         fin de course si elle l'a démarré)
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  // la pile de dev), et on stoppe le nôtre en fin de course.
  const e2eSelected = selected.filter((t) => e2e.includes(t));
  let sharedProc: ReturnType<typeof spawn> | null = null;
  if (e2eSelected.length > 0) {
    const alreadyUp = await waitHttp("http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling", 2);
    if (!alreadyUp) {
      console.log("\n• démarrage du mini-service partagé (3003/3004) pour la suite E2E…");
      sharedProc = spawn("bun", [join(ROOT, "mini-services", "hermes-chat", "index.ts")], {
        cwd: join(ROOT, "mini-services", "hermes-chat"),
        env: testEnv(),
        stdio: "ignore",
      });
      const up = await waitHttp("http://127.0.0.1:3003/socket.io/?EIO=4&transport=polling");
      if (!up) {
        sharedProc.kill();
        console.error("service E2E injoignable après démarrage — suite E2E annulée");
        for (const t of e2eSelected)
          results.push({ name: t.file.split("/").pop()!, status: "ÉCHEC", ms: 0, detail: "service indisponible" });
      }
    }
  }
  try {
    for (const t of selected) {
      results.push(await runOne(t.file, wantQaDom && !unit.includes(t) ? 600_000 : 300_000, t.fixture));
    }
  } finally {
    sharedProc?.kill();
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
