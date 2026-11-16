// Pilote d'un chat IA web — un processus par tour, UNE ligne JSON sur stdout
// (contrat de la spec §4) :
//   { ok, site, mode, url, text?, files?: [{name, bytes}], elapsed_s, error }
// Code de sortie 0 si ok, non nul sinon. Tout le journal va sur stderr.
//
// Paramètres : --site <zai|aistudio|gemini-app>, --mode <answer|build>,
// --prompt "…" | --prompt-file <chemin>, --out <dossier> (build),
// --port <9222>, --timeout <240 s>, --profile <user-data-dir>,
// --browser <chemin>, --idle-min <minutes du veilleur>.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CdpPage, closeTarget, findTab, listTargets, newTab, sleep } from "./cdp";
import { ensureBrowser, launchWatchdog, touchActivity } from "./browser";
import { DriverLock, type LockInfo } from "./lock";
import { writeGuarded } from "./paths";
import { FICHES, type WebchatMode, type WebchatSiteId } from "./fiches";
import { runAiStudio, runGeminiApp, runZai, type FlowCtx, type FlowResult } from "./flows";

interface Args {
  site: WebchatSiteId;
  mode: WebchatMode;
  prompt: string;
  out: string | null;
  port: number;
  timeoutS: number;
  profile: string;
  browser: string | null;
  idleMin: number;
}

function argOf(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function parseArgs(): Args | { error: string } {
  const site = (argOf("--site") ?? "") as WebchatSiteId;
  if (!FICHES[site]) return { error: `site inconnu : « ${site} » (attendus : zai, aistudio, gemini-app)` };
  const mode = (argOf("--mode") ?? "answer") as WebchatMode;
  const fiche = FICHES[site];
  if (!fiche.modes.includes(mode)) {
    return { error: `mode « ${mode} » non exposé par ${site} (modes : ${fiche.modes.join(", ")})` };
  }
  let prompt = argOf("--prompt");
  const promptFile = argOf("--prompt-file");
  if (promptFile) {
    try {
      prompt = readFileSync(promptFile, "utf-8");
    } catch (err) {
      return { error: `consigne illisible (${promptFile}) : ${err instanceof Error ? err.message : "erreur"}` };
    }
  }
  if (!prompt || !prompt.trim()) return { error: "consigne manquante (--prompt ou --prompt-file)" };
  const modeArg = mode;
  const outArg = argOf("--out");
  if (modeArg === "build" && (!outArg || !outArg.trim())) {
    return { error: "mode build : --out <dossier de sortie> est requis" };
  }
  return {
    site,
    mode,
    prompt: prompt.trim(),
    out: outArg ? resolve(outArg) : null,
    port: Number(argOf("--port") ?? 9222) || 9222,
    timeoutS: Number(argOf("--timeout") ?? 240) || 240,
    profile: argOf("--profile") ?? join(process.cwd(), "webchat-profile"),
    browser: argOf("--browser"),
    idleMin: Number(argOf("--idle-min") ?? 5) || 5,
  };
}

/** Journal vers stderr uniquement — stdout garde le contrat (1 ligne JSON). */
const step = (msg: string) => console.error(`[webchat:${(argOf("--site") ?? "?")}] ${msg}`);

async function main(): Promise<number> {
  const started = Date.now();
  const parsed = parseArgs();
  if ("error" in parsed) {
    console.log(JSON.stringify({ ok: false, error: parsed.error, elapsed_s: 0 }));
    return 2;
  }
  const args = parsed;
  const fiche = FICHES[args.site];
  const finish = (payload: Record<string, unknown>, code: number): number => {
    console.log(
      JSON.stringify({ elapsed_s: Math.round((Date.now() - started) / 100) / 10, ...payload })
    );
    return code;
  };

  // 0. Un site non vérifié est INDISPONIBLE, pas cassé (spec §6).
  if (!fiche.verifie) {
    return finish(
      {
        ok: false,
        site: args.site,
        mode: args.mode,
        error:
          `${fiche.label} est indisponible : ses sélecteurs n'ont pas encore été ` +
          `relevés sur la page vivante (fiche verifie=false).`,
      },
      1
    );
  }

  // 1. Verrou mono-pilote — sortie propre en nommant le titulaire (§7.4).
  //    Une erreur disque (dossier/profil inaccessible…) jette : échec JSON
  //    franc, jamais un crash sans ligne de contrat sur stdout.
  const lockPath = join(args.profile, "hermes-pilot.lock");
  const lock = new DriverLock(lockPath);
  let holder: LockInfo | null = null;
  try {
    holder = lock.acquire(args.site, args.mode);
  } catch (err) {
    return finish(
      {
        ok: false,
        site: args.site,
        mode: args.mode,
        error: err instanceof Error ? err.message : String(err),
      },
      1
    );
  }
  if (holder) {
    return finish(
      {
        ok: false,
        site: args.site,
        mode: args.mode,
        error:
          `verrou mono-pilote tenu par un autre pilote (pid ${holder.pid}, site ` +
          `${holder.site}/${holder.mode}, démarré ${holder.startedAt}) — réessayez une fois le tour terminé.`,
      },
      1
    );
  }

  const heartbeat = () => {
    lock.touch();
    touchActivity(args.profile);
  };

  let page: CdpPage | null = null;
  let targetId: string | null = null;
  try {
    // 2. Le navigateur du profil tourne ; le lancer sinon (et armer le veilleur).
    const ensured = await ensureBrowser({
      port: args.port,
      profileDir: args.profile,
      browserPath: args.browser ?? undefined,
    });
    if (!ensured.up) {
      throw new Error(ensured.error ?? "navigateur de pilotage indisponible");
    }
    launchWatchdog(args.profile, args.idleMin);
    heartbeat();

    // 3. Onglet du site : le retrouver, ou le créer ; n'en garder qu'un
    //    (hygiène : about:blank et doublons fermés par /json/close).
    let targets = await listTargets(args.port);
    for (const t of targets) {
      if ((t.url ?? "") === "about:blank") await closeTarget(args.port, t.id);
    }
    const siteTabs = targets.filter((t) => (t.url ?? "").includes(fiche.onglet_match));
    for (const t of siteTabs.slice(1)) await closeTarget(args.port, t.id);
    targets = await listTargets(args.port);
    let tab = findTab(targets, fiche.onglet_match);
    if (!tab) {
      tab = await newTab(args.port, "about:blank");
    }
    if (!tab?.webSocketDebuggerUrl) {
      throw new Error(`onglet ${fiche.label} introuvable et impossible à créer`);
    }
    targetId = tab.id;
    page = await CdpPage.connect(tab.webSocketDebuggerUrl);
    await page.send("Page.enable");
    heartbeat();

    // 4. URL d'accueil (z.ai : l'ACCUEIL vaut nouvelle tâche — jamais « New
    //    Chat » ; AI Studio : son flux gère lui-même la discussion neuve).
    if (args.site !== "aistudio") {
      await page.navigate(fiche.url_accueil);
    }

    const ctx: FlowCtx = {
      page,
      fiche,
      mode: args.mode,
      prompt: args.prompt,
      timeoutMs: args.timeoutS * 1000,
      onStep: step,
      onHeartbeat: heartbeat,
    };
    const flow: FlowResult =
      args.site === "zai"
        ? await runZai(ctx)
        : args.site === "aistudio"
          ? await runAiStudio(ctx)
          : await runGeminiApp(ctx);

    // 9/10. Récupération — la garde de chemin vérifie CHAQUE destination :
    // un nom venu du réseau qui sortirait du dossier est refusé et rapporté.
    if (args.mode === "build") {
      const { written, refused } = writeGuarded(args.out!, flow.files ?? []);
      if (written.length === 0) {
        const why = refused[0]?.reason ?? "aucun fichier écrit";
        throw new Error(`aucun fichier écrit — ${why}`);
      }
      for (const r of refused) step(`REFUSÉ ${r.name} : ${r.reason}`);
      return finish(
        {
          ok: true,
          site: args.site,
          mode: args.mode,
          url: flow.url,
          files: written.map((w) => ({ name: w.name, bytes: w.bytes })),
          ...(refused.length ? { refused: refused.map((r) => ({ name: r.name, reason: r.reason })) } : {}),
          error: null,
        },
        0
      );
    }
    return finish(
      { ok: true, site: args.site, mode: args.mode, url: flow.url, text: flow.text, error: null },
      0
    );
  } catch (err) {
    // Échec franc : ok:false + message qui dit quoi faire (jamais de succès
    // silencieux, jamais de texte tronqué présenté comme complet).
    return finish(
      {
        ok: false,
        site: args.site,
        mode: args.mode,
        error: err instanceof Error ? err.message : String(err),
      },
      1
    );
  } finally {
    // 11. Libérer le verrou, nettoyer les onglets (about:blank sortants).
    page?.close();
    if (targetId && args.mode === "answer") {
      // L'onglet du site reste ouvert (histoires de session) — seuls les
      // about:blank vides créés pour la navigation sont refermés.
      try {
        const targets = await listTargets(args.port);
        const siteTabs = targets.filter((t) => (t.url ?? "").includes(fiche.onglet_match));
        if (siteTabs.length > 1) {
          for (const t of siteTabs.slice(1)) await closeTarget(args.port, t.id);
        }
      } catch {
        /* hygiène au mieux */
      }
    }
    lock.release();
  }
}

process.on("unhandledRejection", (err) => {
  console.error("[webchat] rejet non géré :", err instanceof Error ? err.message : err);
});

const code = await main();
process.exit(code);
