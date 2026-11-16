// Intégration côté service (spec §6) — les chats IA web sont un FOURNISSEUR
// DE MODÈLES À PART, identifiant stable `webchat`, pour que les autres écrans
// les distinguent d'un modèle du moteur. Un site non vérifié est indisponible
// (pas silencieusement cassé) ; les erreurs des pilotes remontent telles
// quelles ; ce que ces modèles ne savent PAS faire est dit dans l'interface.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelOption } from "../types";
import { FICHES, parseWebchatModelId, webchatModelId, type WebchatSiteId } from "./fiches";
import { isBrowserUp } from "./browser";
import { resolveUnder } from "./paths";

export const WEBCHAT_PROVIDER_LABEL = "Chats IA web";

/** Dossier de données du service (db/ du dépôt — même racine que artifacts). */
export const WEBCHAT_DATA_DIR = join(import.meta.dir, "..", "..", "..", "db");

// ── Réglages serveur (Paramètres → Chats web) ───────────────────────────

export interface WebchatSettingsReader {
  getSetting(key: string): string | null;
}

const KEY_PORT = "fork.webchat.port";
const KEY_TIMEOUT = "fork.webchat.timeoutS";
const KEY_OUT_DIR = "fork.webchat.outDir";
const KEY_PROFILE = "fork.webchat.profileDir";
const KEY_BROWSER = "fork.webchat.browserPath";
const KEY_IDLE = "fork.webchat.idleMin";

export const WEBCHAT_SETTING_DEFAULTS = {
  port: 9222,
  timeoutS: 240,
  idleMin: 5,
} as const;

export interface WebchatConfig {
  port: number;
  timeoutS: number;
  outDir: string;
  profileDir: string;
  browserPath: string;
  idleMin: number;
}

function num(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readWebchatConfig(store: WebchatSettingsReader): WebchatConfig {
  return {
    port: num(store.getSetting(KEY_PORT), WEBCHAT_SETTING_DEFAULTS.port),
    timeoutS: num(store.getSetting(KEY_TIMEOUT), WEBCHAT_SETTING_DEFAULTS.timeoutS),
    outDir: store.getSetting(KEY_OUT_DIR)?.trim() || join(WEBCHAT_DATA_DIR, "webchat-out"),
    profileDir: store.getSetting(KEY_PROFILE)?.trim() || join(WEBCHAT_DATA_DIR, "webchat-profile"),
    browserPath: store.getSetting(KEY_BROWSER)?.trim() || "",
    idleMin: num(store.getSetting(KEY_IDLE), WEBCHAT_SETTING_DEFAULTS.idleMin),
  };
}

// ── Options de modèles (fournisseur « Chats IA web ») ───────────────────
// Épuré : ni description ni pavé de limites ici — l'interface les dit une
// seule fois (bloc « Pilotage navigateur » du sélecteur, spec pilotage §6),
// pas répétés sur chaque ligne.

export function webchatModelOptions(): ModelOption[] {
  return Object.values(FICHES).map((fiche) => ({
    id: webchatModelId(fiche.id),
    label: fiche.label,
    provider: WEBCHAT_PROVIDER_LABEL,
    // Un site non vérifié : INDISPONIBLE, affiché comme tel.
    ...(fiche.verifie ? {} : { available: false } as Partial<ModelOption>),
    webchat: true,
  }));
}

export function isWebchatModel(id: string | null | undefined): boolean {
  return parseWebchatModelId(id) !== null;
}

/** Libellé d'affichage d'un modèle webchat (id inconnu → id brut). */
export function webchatModelLabel(id: string | null | undefined): string | null {
  const parsed = parseWebchatModelId(id);
  if (!parsed) return null;
  return FICHES[parsed.site].label;
}

// ── Exécution d'un tour webchat ─────────────────────────────────────────

export interface WebchatTurnCallbacks {
  onStatus?: (status: string) => void;
  onToolEvent?: (event: { name: string; status: "running" | "done" | "error"; detail?: string }) => void;
  signal?: AbortSignal;
}

export interface WebchatTurnResult {
  content: string;
  /** Fichiers écrits par le pilote (nom + taille + chemin sûr). */
  files?: { name: string; bytes: number; path: string }[];
  model: string;
  provider: string;
}

/** File d'attente sérielle : deux tours webchat (comparaison A/B) ne se
 *  disputent pas le verrou mono-pilote — le second démarre à la fin du
 *  premier, sans échec « verrou tenu ». */
let queue: Promise<unknown> = Promise.resolve();

interface DriverJson {
  ok: boolean;
  site?: string;
  mode?: string;
  url?: string;
  text?: string;
  files?: { name: string; bytes: number }[];
  refused?: { name: string; reason: string }[];
  error?: string | null;
  elapsed_s?: number;
}

/** Exécute un tour webchat en sous-processus (contrat : 1 ligne JSON stdout). */
export async function runWebchatTurn(opts: {
  modelId: string;
  prompt: string;
  store: WebchatSettingsReader;
  cb: WebchatTurnCallbacks;
}): Promise<WebchatTurnResult> {
  const parsed = parseWebchatModelId(opts.modelId);
  if (!parsed) throw new Error(`id de modèle webchat invalide : ${opts.modelId}`);
  const { site } = parsed;
  const fiche = FICHES[site];
  const config = readWebchatConfig(opts.store);

  // Site non vérifié : refus explicite AVANT de toucher au navigateur.
  if (!fiche.verifie) {
    throw new Error(
      `${fiche.label} est indisponible : ses sélecteurs n'ont pas encore été relevés ` +
        `(fiche verifie=false — voir Paramètres → Chats web).`
    );
  }

  const job = async (): Promise<WebchatTurnResult> => {
    opts.cb.onStatus?.(`Pilotage de ${fiche.label}…`);
    opts.cb.onToolEvent?.({
      name: `Chat web · ${fiche.label}`,
      status: "running",
      detail: `navigateur de pilotage sur le port ${config.port}`,
    });

    const driverPath = join(import.meta.dir, "driver.ts");
    // Pas de --mode : le pilote OBSERVE ce que le site produit (texte ou
    // fichiers) et rapporte l'un ou l'autre — fusion, une entrée par site.
    const args = [
      driverPath,
      "--site", site,
      "--prompt-file", await writePromptTemp(opts.prompt),
      "--port", String(config.port),
      "--timeout", String(config.timeoutS),
      "--profile", config.profileDir,
      "--idle-min", String(config.idleMin),
      "--out", config.outDir,
    ];
    if (config.browserPath) args.push("--browser", config.browserPath);

    const json = await spawnDriver(args, config.timeoutS * 1000 + 60_000, opts.cb.signal);
    if (!json.ok) {
      opts.cb.onToolEvent?.({
        name: `Chat web · ${fiche.label}`,
        status: "error",
        detail: json.error ?? "échec du pilote",
      });
      throw new Error(json.error ?? "échec du pilote webchat");
    }
    opts.cb.onToolEvent?.({
      name: `Chat web · ${fiche.label}`,
      status: "done",
      detail: json.files?.length
        ? `${json.files.length} fichier(s) écrit(s) dans ${config.outDir}`
        : `${Math.round(json.elapsed_s ?? 0)} s`,
    });

    if (json.files?.length) {
      const files: { name: string; bytes: number; path: string }[] = [];
      const refused = json.refused ?? [];
      for (const f of json.files) {
        // Re-contrôle côté service : le nom (venu du réseau) est résolu sous
        // le dossier de sortie avant toute lecture — jamais de confiance.
        const safe = resolveUnder(config.outDir, f.name);
        if (safe && existsSync(safe)) {
          files.push({ name: f.name, bytes: f.bytes, path: safe });
        }
      }
      const listing = files
        .map((f) => `- ${f.name} (${(f.bytes / 1024).toFixed(1)} Ko)`)
        .join("\n");
      const refusedNote = refused.length
        ? `\n\n${refused.length} nom(s) refusé(s) par la garde de chemin : ${refused
            .map((r) => r.name)
            .join(", ")}`
        : "";
      return {
        content:
          `${fiche.label} a produit **${files.length} fichier(s)** dans le dossier ` +
          `\`${config.outDir}\` :\n\n${listing || "(aucun)"}${refusedNote}`,
        files,
        model: webchatModelLabel(opts.modelId) ?? opts.modelId,
        provider: WEBCHAT_PROVIDER_LABEL,
      };
    }

    return {
      content: json.text ?? "",
      model: webchatModelLabel(opts.modelId) ?? opts.modelId,
      provider: WEBCHAT_PROVIDER_LABEL,
    };
  };

  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

/** Consigne passée par fichier (évite les limites de ligne de commande). */
async function writePromptTemp(prompt: string): Promise<string> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  // Premier tour après un clone : db/ n'existe pas encore — le créer
  // (même classe de bug que le verrou sur un profil frais).
  mkdirSync(WEBCHAT_DATA_DIR, { recursive: true });
  const path = join(WEBCHAT_DATA_DIR, "webchat-prompt.tmp");
  writeFileSync(path, prompt, "utf-8");
  return path;
}

/** Lance le pilote et extrait la ligne JSON de sortie (échec franc sinon). */
function spawnDriver(
  args: string[],
  killAfterMs: number,
  signal?: AbortSignal
): Promise<DriverJson> {
  return new Promise((resolveP, reject) => {
    let settled = false;
    let stdout = "";
    const child = spawn(process.execPath, args, {
      cwd: import.meta.dir,
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* déjà sorti */ }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("pilote webchat : dépassement du délai global"))),
      killAfterMs
    );
    const onAbort = () =>
      finish(() => reject(new Error("tour webchat annulé par l'utilisateur")));
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) => {
      if (settled) return;
      // La ligne JSON est la DERNIÈRE ligne non vide de stdout.
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && last.startsWith("{")) {
        try {
          const parsed = JSON.parse(last) as DriverJson;
          return finish(() => resolveP(parsed));
        } catch {
          /* retombe sur l'erreur explicite */
        }
      }
      finish(() =>
        reject(
          new Error(
            `pilote webchat : sortie sans JSON (code ${code ?? "?"}) — ` +
              `consultez le journal du service`
          )
        )
      );
    });
  });
}

/** Lit un fichier produit par un site web — chemin re-vérifié sous outDir. */
export function readWebchatFile(path: string, name: string, outDir: string): string | null {
  const safe = resolveUnder(outDir, name);
  if (!safe || resolve(safe) !== resolve(path) || !existsSync(safe)) return null;
  try {
    return readFileSync(safe, "utf-8");
  } catch {
    return null;
  }
}

// ── Sondes pour la page de paramètres ───────────────────────────────────

export interface WebchatSiteStatus {
  id: WebchatSiteId;
  label: string;
  verifie: boolean;
  modes: WebchatMode[];
  /** Le navigateur de pilotage répond-il sur le port configuré ? */
  browserUp: boolean;
}

export interface WebchatStatus {
  sites: WebchatSiteStatus[];
  config: {
    port: number;
    timeoutS: number;
    idleMin: number;
    outDir: string;
    profileDir: string;
    browserPath: string;
    /** Binaire navigateur trouvé (sinon ""). */
    browserFound: string;
    outDirExists: boolean;
  };
}

async function firstBrowserBinary(browserPath: string): Promise<string> {
  const { browserCandidates } = await import("./browser");
  for (const c of browserCandidates(browserPath || undefined)) {
    if (c && existsSync(c)) return c;
  }
  return "";
}

export async function webchatStatus(store: WebchatSettingsReader): Promise<WebchatStatus> {
  const config = readWebchatConfig(store);
  const up = await isBrowserUp(config.port);
  const sites = Object.values(FICHES).map((f) => ({
    id: f.id,
    label: f.label,
    verifie: f.verifie,
    modes: f.modes,
    browserUp: up,
  }));
  return {
    sites,
    config: {
      port: config.port,
      timeoutS: config.timeoutS,
      idleMin: config.idleMin,
      outDir: config.outDir,
      profileDir: config.profileDir,
      browserPath: config.browserPath,
      browserFound: await firstBrowserBinary(config.browserPath),
      outDirExists: existsSync(config.outDir) && statSync(config.outDir).isDirectory(),
    },
  };
}
