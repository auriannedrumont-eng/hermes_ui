// Moteur Hermes — mise à jour, contrôle et retour arrière (v0.4.0).
//
// SURCOUCHE, pas substitution : Hermes gère son propre cycle de vie
// (github.com/NousResearch/hermes-agent). Ce module ne réinvente rien :
//  - version installée  : `hermes --version` (CLI officielle) ;
//  - version publiée    : releases GitHub publiques de hermes-agent ;
//  - mise à jour        : `hermes update --backup` (commande officielle,
//                         avec sauvegarde complète avant — filet renforcé) ;
//  - retour arrière     : la procédure officielle documentée (arrêt de la
//                         gateway, puis retour aux fichiers de la version
//                         précédente) — exécutée étape par étape, journal en
//                         direct, jamais en silence ;
//  - contrôle (« test des sens ») : l'interface vérifie SES points de
//    contact (liaison gateway, liste des modèles, version lisible) — elle
//    ne juge pas Hermes, elle constate qu'elle arrive toujours à lui parler.
//
// Le carnet de bord (fork.agent.journal) note chaque étape datée : version
// repérée, mise à jour installée, contrôle, retour arrière. La version
// précédente (fork.agent.previousVersion) est le « filet de sécurité » :
// c'est vers elle que propose le retour arrière.
//
// Environnement (tests/bac à sable) : HERMES_AGENT_BIN (binaire, défaut
// "hermes"), HERMES_AGENT_DIR (dossier d'installation — surcharge explicite ;
// sans elle, résolution RELATIVE uniquement, cf. resolveAgentDir : l'UNIQUE
// emplacement connu est la maison officielle hermes-agent/ DANS le dossier
// de l'interface — aucun filet ailleurs, décision (65)),
// HERMES_AGENT_RELEASES_URL (JSON releases/latest).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import type { Store } from "./store";
import type { HermesConnector } from "./hermes-connector";
// Types du fil : référentiel partagé front ↔ back (B-4, audit v3) — ce
// module les ré-exporte pour ses consommateurs internes et les tests ;
// la carte cliente les importe directement du shared.
import type {
  AgentRelease,
  MotorControl,
  MotorOp,
  MotorState,
  MotorJournalEntry,
} from "./shared/chat-protocol";

// Lu à l'USAGE (pas à l'import) : les tests posent leurs stubs d'env après
// le chargement du module — les valeurs restent ainsi toujours fraîches.
const releasesUrl = () =>
  process.env.HERMES_AGENT_RELEASES_URL ??
  "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest";
const agentBin = () => process.env.HERMES_AGENT_BIN ?? "hermes";
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const GATEWAY_STOP_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 4_000;

// ── Sondes de la passerelle (§9 (64)) — partagées avec agent-starter ────────
// Port lu à l'USAGE (convention du module) : surcharge d'environnement pour
// les tests, défaut 9120 comme le connecteur.
const gatewayPort = () => Number(process.env.HERMES_AGENT_GATEWAY_PORT ?? 9120);

/** Le port de la passerelle répond-il ? (TCP — un port WS suffit.) */
export function gatewayPortOpen(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: gatewayPort() });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Journal des opérations (maj / retour) — même dossier que la base. */
const motorLogPath = () =>
  process.env.HERMES_MOTOR_LOG ??
  join(import.meta.dir, "..", "..", "db", "agent-motor.log");

/** Plafond de lecture du journal (64 Ko, queue) — même garde que le relais
 *  du journal interface (index.ts) : un journal qui gonfle à chaque maj ne
 *  doit jamais alourdir un message socket (B-5, audit v3). */
const MOTOR_LOG_CAP = 65_536;

// ── Réglages persistés (registre : src/lib/settings.ts, §Système) ─────────
export const AGENT_JOURNAL_KEY = "fork.agent.journal";
export const AGENT_PREVIOUS_KEY = "fork.agent.previousVersion";
export const AGENT_INSTALLED_KEY = "fork.agent.installedVersion";
export const AGENT_AUTOCHECK_KEY = "fork.agent.update.autoCheck";

// ── Types du fil (carte « Moteur Hermes » du volet Système) ───────────────
// Déclarés dans shared/chat-protocol.ts (référentiel unique) — ré-exportés
// ici pour les tests et les imports internes du service.
export type { AgentRelease, MotorControl, MotorOp, MotorState, MotorJournalEntry };
/** Alias historique (tests et handlers) — le fil s'appelle JournalEntry. */
export type JournalEntry = MotorJournalEntry;

interface MotorDeps {
  store: Store;
  connector: HermesConnector;
  /** Diffusion socket (agent:motor-changed) — absent en test. */
  emit?: (event: string, payload: unknown) => void;
}

let motorState: MotorState = {
  installed: null,
  release: null,
  checkedAt: null,
  error: null,
  op: null,
  lastControl: null,
  previousVersion: null,
  agentDir: null,
  gatewayUrl: null,
};

export function getMotorState(): MotorState {
  return motorState;
}

function setState(patch: Partial<MotorState>, deps?: MotorDeps) {
  motorState = { ...motorState, ...patch };
  deps?.emit?.("agent:motor-changed", { ...motorState });
}

// ── Journal d'opération (lignes horodatées, marqueurs terminaux) ──────────
export function motorLogRead(): { exists: boolean; text: string; mtimeMs: number } {
  try {
    const buf = readFileSync(motorLogPath());
    // Plafond 64 Ko (queue) : un journal qui grossit à chaque maj ne doit
    // jamais gonfler un message socket (B-5, audit v3 — même garde que le
    // relais du journal interface dans index.ts).
    const text =
      buf.length > MOTOR_LOG_CAP
        ? buf.subarray(buf.length - MOTOR_LOG_CAP).toString("utf-8")
        : buf.toString("utf-8");
    return { exists: true, text, mtimeMs: statSync(motorLogPath()).mtimeMs };
  } catch {
    return { exists: false, text: "", mtimeMs: 0 };
  }
}

function logLine(deps: MotorDeps, line: string, reset = false): void {
  try {
    mkdirSync(join(motorLogPath(), ".."), { recursive: true });
    const stamp = new Date().toLocaleTimeString("fr-FR", { hour12: false });
    const text = `[${stamp}] ${line}\n`;
    if (reset) writeFileSync(motorLogPath(), text, "utf-8");
    else appendFileSync(motorLogPath(), text, "utf-8");
    deps.emit?.("agent:update-log:changed", motorLogRead());
  } catch {
    /* journal best effort */
  }
}

// ── Carnet de bord (liste bornée, JSON en réglage — pas de migration) ─────
export function journalAppend(store: Store, entry: Omit<JournalEntry, "id" | "at">): JournalEntry {
  const full: JournalEntry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry,
  };
  const list = journalList(store);
  list.unshift(full);
  store.setSetting(AGENT_JOURNAL_KEY, JSON.stringify(list.slice(0, 100)));
  return full;
}

export function journalList(store: Store): JournalEntry[] {
  const raw = store.getSetting(AGENT_JOURNAL_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
  } catch {
    return [];
  }
}

// ── Petites briques pures (testées partie A) ───────────────────────────────
/** Extrait une version « 1.2.3 » d'un texte (« v1.2.3 », « hermes 1.2.3 »…). */
export function parseVersion(text: string): string | null {
  const m = text.match(/v?(\d+(?:\.\d+){1,3})/i);
  return m ? m[1] : null;
}

/** Compare deux versions : > 0 si a > b, 0 si égales. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Points de contact de l'interface avec le moteur (la « fiche des besoins »). */
const CONTACT_KEYWORDS =
  /\b(gateway|websocket|api[/ _-]?ws|api_turn|run_api|model[/ _-]?options|protocol|breaking|incompatible|dashboard)\b/i;

export function releaseTouchesInterface(notes: string): boolean {
  return CONTACT_KEYWORDS.test(notes);
}

/** ws://…/api/ws → http://… (base REST de la gateway — même logique que
 *  toHttpBase du connecteur, recopiée pour ne pas éditer l'amont). */
function toHttpBase(url: string): string {
  let base = url.replace(/^ws/i, "http");
  if (base.endsWith("/api/ws")) base = base.slice(0, -"/api/ws".length);
  return base.replace(/\/$/, "");
}

// ── Exécution des commandes officielles ────────────────────────────────────
/** Lance une commande, journalise chaque ligne, résout au code de retour. */
function runLogged(
  deps: MotorDeps,
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; quiet?: boolean } = { timeoutMs: 30_000 }
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    if (!opts.quiet) logLine(deps, `$ ${cmd} ${args.join(" ")}`);
    let output = "";
    let settled = false;
    const child = spawn(cmd, args, {
      shell: process.platform === "win32",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* déjà parti */
      }
      // §9 (64) : une sonde quiet ne doit JAMAIS écrire dans le journal
      // d'opération — le « arrêté : plus de 4 s sans fin » vu chez
      // l'utilisatrice venait d'une sonde --version silencieuse qui y
      // fuyait au moment du timeout.
      if (!opts.quiet) logLine(deps, `(arrêté : plus de ${Math.round(opts.timeoutMs / 1000)} s sans fin)`);
      resolve({ code: -1, output });
    }, opts.timeoutMs);
    const feed = (buf: Buffer) => {
      const text = buf.toString("utf-8");
      output += text;
      for (const line of text.split(/\r?\n/)) {
        const clean = line.trim();
        if (clean && !opts.quiet) logLine(deps, clean);
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!opts.quiet) logLine(deps, `commande introuvable : ${err.message}`);
      resolve({ code: -1, output });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

/** `hermes --version` — cache court (les sondes répétées ne respawnent pas). */
let versionCache: { value: string | null; at: number } | null = null;
export async function hermesVersion(force = false): Promise<string | null> {
  if (!force && versionCache && Date.now() - versionCache.at < 60_000) {
    return versionCache.value;
  }
  const res = await runLogged(
    { store: null as unknown as Store, connector: null as unknown as HermesConnector },
    agentBin(),
    ["--version"],
    { timeoutMs: VERSION_TIMEOUT_MS, quiet: true }
  );
  const value = res.code === 0 ? parseVersion(res.output) : null;
  versionCache = { value, at: Date.now() };
  return value;
}

/** Dossier d'installation de l'agent (checkout git) — null si introuvable. */
/** Un dossier d'installation Hermes : checkout git (.git) OU la passerelle
 *  qu'aurait l'interface à lancer (gateway/run_api.py) — tolérant aux
 *  copies sans historique git (déplacement, archive décompressée). */
function isAgentDir(dir: string): boolean {
  try {
    return existsSync(join(dir, ".git")) || existsSync(join(dir, "gateway", "run_api.py"));
  } catch {
    return false;
  }
}

export function resolveAgentDir(): string | null {
  const candidates: string[] = [];
  if (process.env.HERMES_AGENT_DIR) candidates.push(process.env.HERMES_AGENT_DIR);
  // §9 (65), décision de l'utilisatrice : « seule source hermes agent dans
  // le dossier de mon interface » — la maison officielle
  // <racine interface>/hermes-agent est l'UNIQUE emplacement que la
  // résolution connaît (le lanceur y installe la copie fraîche officielle,
  // (63)). AUCUN filet : aucun dossier frère, aucun dossier système ni
  // dossier utilisateur caché — si la maison n'a pas d'installation valide,
  // la réponse est null et l'interface affiche son état honnête
  // (installation retentée au prochain démarrage). La surcharge explicite
  // HERMES_AGENT_DIR reste pour les tests et les bac à sable.
  const repoRoot = join(import.meta.dir, "..", "..");
  candidates.push(join(repoRoot, "hermes-agent"));
  for (const dir of candidates) {
    if (isAgentDir(dir)) return dir;
  }
  return null;
}

/** Dernière release publiée (GitHub public) — null si injoignable. */
let releaseCache: { value: AgentRelease | null; at: number } | null = null;
export async function fetchLatestRelease(force = false): Promise<AgentRelease | null> {
  if (!force && releaseCache && Date.now() - releaseCache.at < 15 * 60_000) {
    return releaseCache.value;
  }
  let value: AgentRelease | null = null;
  try {
    const res = await fetch(releasesUrl(), {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        tag_name?: string;
        name?: string;
        body?: string;
        html_url?: string;
        published_at?: string;
      };
      if (typeof data.tag_name === "string" && data.tag_name) {
        value = {
          tag: parseVersion(data.tag_name) ?? data.tag_name,
          name: typeof data.name === "string" ? data.name : null,
          notes: (typeof data.body === "string" ? data.body : "").slice(0, 4_000),
          url: typeof data.html_url === "string" ? data.html_url : null,
          publishedAt: typeof data.published_at === "string" ? data.published_at : null,
          touchesInterface: releaseTouchesInterface(typeof data.body === "string" ? data.body : ""),
        };
      }
    }
  } catch {
    /* hors ligne : valeur null honnête */
  }
  releaseCache = { value, at: Date.now() };
  return value;
}

// ── Vérification de l'état (version + release + dérive hors interface) ────
export async function refreshMotorStatus(deps: MotorDeps): Promise<MotorState> {
  const installed = await hermesVersion(true);
  const previousSaved = deps.store.getSetting(AGENT_PREVIOUS_KEY)?.trim() || null;
  const notedInstalled = deps.store.getSetting(AGENT_INSTALLED_KEY)?.trim() || null;
  // Dérive : la version a changé SANS passer par l'interface (l'utilisateur
  // a lancé `hermes update` lui-même, ou le bureau) — le carnet le note et
  // le filet de sécurité retient la version d'avant.
  if (installed && notedInstalled && installed !== notedInstalled) {
    deps.store.setSetting(AGENT_PREVIOUS_KEY, notedInstalled);
    journalAppend(deps.store, {
      type: "version",
      label: "Le moteur Hermes a changé de version",
      version: installed,
      resultat: "info",
      detail: `version notée avant : ${notedInstalled} — changée hors de l'interface`,
    });
    journalAppend(deps.store, {
      type: "version",
      label: "Nouvelle version notée",
      version: installed,
      resultat: "ok",
    });
  }
  if (installed && installed !== notedInstalled) {
    deps.store.setSetting(AGENT_INSTALLED_KEY, installed);
  }
  const release = await fetchLatestRelease();
  const available =
    release !== null &&
    installed !== null &&
    compareVersions(release.tag, installed) > 0;
  setState(
    {
      installed,
      release: available || !installed ? release : null,
      checkedAt: new Date().toISOString(),
      error: installed === null && release === null ? "Agent et GitHub injoignables." : null,
      previousVersion: previousSaved,
      agentDir: resolveAgentDir(),
      gatewayUrl: deps.connector.gatewayUrl,
    },
    deps
  );
  return motorState;
}

// ── Contrôle des sens : l'interface arrive-t-elle toujours à parler ? ──────
/** Sonde la gateway (REST /api/model/options — le vrai point de contact de
 *  l'interface) et relit la version. Aucun tour n'est lancé : rien n'est
 *  envoyé au modèle, aucun coût. */
export async function runSensesCheck(deps: MotorDeps): Promise<MotorControl> {
  const url = deps.connector.gatewayUrl;
  let liaison: "ok" | "echec" = "echec";
  let modeles: "ok" | "echec" = "echec";
  let detail = "la gateway ne répond pas";
  if (url) {
    try {
      const res = await fetch(`${toHttpBase(url)}/api/model/options?include_unconfigured=1`, {
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
        headers: deps.connector.gatewayToken
          ? { Authorization: `Bearer ${deps.connector.gatewayToken}` }
          : undefined,
      });
      if (res.ok) {
        const data = (await res.json()) as unknown;
        const count = Array.isArray((data as { models?: unknown[] })?.models)
          ? ((data as { models: unknown[] }).models.length as number)
          : 1;
        liaison = "ok";
        modeles = count > 0 ? "ok" : "echec";
        detail = count > 0 ? `gateway répond, ${count} modèle(s) visible(s)` : "gateway répond mais aucune liste de modèles";
      } else {
        detail = `la gateway répond mal (code ${res.status})`;
      }
    } catch (err) {
      detail = err instanceof Error ? `liaison impossible : ${err.message}` : "liaison impossible";
    }
  }
  const versionLue = await hermesVersion();
  const ok = liaison === "ok" && modeles === "ok";
  const control: MotorControl = {
    at: new Date().toISOString(),
    ok,
    liaison,
    modeles,
    versionLue,
    detail: `${detail} · version lue : ${versionLue ?? "inconnue"}`,
  };
  setState({ lastControl: control }, deps);
  journalAppend(deps.store, {
    type: "controle",
    label: "Contrôle automatique de l'interface",
    version: versionLue,
    resultat: ok ? "ok" : "echec",
    detail: control.detail,
  });
  return control;
}

// ── Mise à jour du moteur : `hermes update --backup` (officiel) ────────────
export async function startAgentUpdate(deps: MotorDeps): Promise<{ ok: boolean; error?: string }> {
  if (motorState.op) return { ok: false, error: "une opération est déjà en cours" };
  // §9 (64), capture du 23 : le programme officiel `hermes update` REFUSE de
  // se lancer tant que Hermes tourne (fichiers .pyd verrouillés) — et comme
  // l'interface allume l'agent toute seule (loi « tout simplement »), le
  // bouton échouait à coup sûr avec un refus en anglais brut. On refuse
  // NOUS-MÊMES, en français, AVANT de lancer quoi que ce soit : rien n'est
  // réservé, rien n'est lancé, et on n'arrête jamais l'agent de quelqu'un
  // (loi « tout simplement » : c'est à la personne de fermer Hermes).
  if (await gatewayPortOpen()) {
    logLine(
      deps,
      "MOTEUR MAJ REFUSÉ — Hermes est en marche : le programme officiel refuse de se mettre à jour tant qu'il tourne (fichiers verrouillés). Fermez l'application Hermes et les autres terminaux Hermes, puis refaites la mise à jour ici — rien n'a été modifié.",
      true
    );
    setState({ error: "Hermes est en marche — fermez-le (application de bureau, autres terminaux), puis relancez la mise à jour." }, deps);
    return {
      ok: false,
      error: "Hermes est en marche — fermez l'application Hermes (et les autres terminaux Hermes), puis relancez la mise à jour.",
    };
  }
  // (audit 2026-11-21) Réservation SYNCHRONE avant tout await : le test
  // ci-dessus puis `await hermesVersion(true)` (jusqu'à 4 s) laissaient une
  // fenêtre où deux déclenchements (deux onglets) passaient tous deux le
  // garde et lançaient deux `hermes update --backup` en parallèle sur la
  // même installation. Si la sonde échoue, on libère l'opération.
  setState({ op: { kind: "update", startedAt: new Date().toISOString() } }, deps);
  const before = await hermesVersion(true);
  if (!before) {
    setState({ op: null }, deps);
    return { ok: false, error: "commande hermes introuvable — le moteur Hermes n'est pas installé sur ce poste ?" };
  }
  logLine(deps, `mise à jour du moteur Hermes demandée depuis l'interface — version actuelle ${before}, gardée en mémoire pour un retour arrière`, true);
  const res = await runLogged(deps, agentBin(), ["update", "--backup"], { timeoutMs: UPDATE_TIMEOUT_MS });
  if (res.code !== 0) {
    // Ceinture et bretelles (§9 (64)) : si le programme officiel a refusé
    // malgré notre pré-sonde (Hermes relancé entre-temps), le verdict dit
    // LA raison en français au lieu d'un échec générique.
    const refusHermesActif = /force-venv|\.pyd\b|close the hermes desktop app/i.test(res.output);
    if (refusHermesActif) {
      logLine(deps, "MOTEUR MAJ REFUSÉ — Hermes est en marche : le programme officiel refuse de se mettre à jour tant qu'il tourne (il a été relancé entre-temps ?). Fermez-le (application de bureau, autres terminaux), puis refaites la mise à jour ici — rien n'a été modifié.");
      setState({ op: null, error: "Hermes est en marche — fermez-le, puis relancez la mise à jour." }, deps);
      journalAppend(deps.store, {
        type: "maj",
        label: "Mise à jour du moteur Hermes",
        version: before,
        resultat: "echec",
        detail: "refus du programme officiel : Hermes tourne déjà (fichiers verrouillés)",
      });
      return { ok: false, error: "Hermes est en marche — fermez-le, puis relancez la mise à jour." };
    }
    logLine(deps, "MOTEUR MAJ ERREUR — la mise à jour n'a pas abouti (détail ci-dessus). Rien n'a changé : la version installée continue de tourner.");
    setState({ op: null, error: "la mise à jour du moteur n'a pas abouti" }, deps);
    journalAppend(deps.store, {
      type: "maj",
      label: "Mise à jour du moteur Hermes",
      version: before,
      resultat: "echec",
      detail: "hermes update a échoué — journal détaillé dans le volet Système",
    });
    return { ok: false, error: "hermes update a échoué (voir le journal)" };
  }
  logLine(deps, "MOTEUR MAJ OK — mise à jour installée par Hermes. Contrôle de l'interface…");
  deps.store.setSetting(AGENT_PREVIOUS_KEY, before);
  const after = await hermesVersion(true);
  deps.store.setSetting(AGENT_INSTALLED_KEY, after ?? "");
  journalAppend(deps.store, {
    type: "maj",
    label: "Mise à jour du moteur Hermes",
    version: after ?? before,
    resultat: "info",
    detail: `${before} → ${after ?? "?"} — contrôle en cours`,
  });
  // La gateway relance après la mise à jour : quelques tentatives souples,
  // puis UNE entrée de carnet pour le verdict final — l'histoire complète
  // (maj installée, contrôle vert ou rouge) vit dans le carnet de bord.
  let control: MotorControl | null = null;
  for (let i = 0; i < 4; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5_000));
    control = await runSensesCheckSilent(deps);
    if (control.ok) break;
  }
  if (control) {
    journalAppend(deps.store, {
      type: "controle",
      label: "Contrôle automatique de l'interface",
      version: control.versionLue,
      resultat: control.ok ? "ok" : "echec",
      detail: control.detail,
    });
    logLine(
      deps,
      control.ok
        ? "CONTRÔLE OK — l'interface reçoit bien les infos du moteur."
        : `CONTRÔLE ÉCHOUÉ — ${control.detail}. Un retour arrière vers ${before} est proposé dans le volet Système.`
    );
  }
  setState({ op: null, installed: after ?? before, previousVersion: before }, deps);
  await refreshMotorStatus(deps);
  return { ok: true };
}

/** Contrôle sans double écriture au carnet (utilisé juste après une maj). */
async function runSensesCheckSilent(deps: MotorDeps): Promise<MotorControl> {
  const url = deps.connector.gatewayUrl;
  let liaison: "ok" | "echec" = "echec";
  let modeles: "ok" | "echec" = "echec";
  let detail = "la gateway ne répond pas";
  if (url) {
    try {
      const res = await fetch(`${toHttpBase(url)}/api/model/options?include_unconfigured=1`, {
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
      });
      if (res.ok) {
        liaison = "ok";
        modeles = "ok";
        detail = "gateway répond";
      } else detail = `code ${res.status}`;
    } catch (err) {
      detail = err instanceof Error ? err.message : "liaison impossible";
    }
  }
  const control: MotorControl = {
    at: new Date().toISOString(),
    ok: liaison === "ok" && modeles === "ok",
    liaison,
    modeles,
    versionLue: await hermesVersion(),
    detail: `${detail} · version lue : ${versionCache?.value ?? "inconnue"}`,
  };
  setState({ lastControl: control }, deps);
  return control;
}

// ── Retour arrière : la procédure OFFICIELLE, assistée et racontée ────────
// Doc hermes-agent (Checkpoints & rollback / Updating) :
//   1. `hermes gateway stop`
//   2. retour aux fichiers de la version précédente (checkout git du tag)
//   3. relance de l'agent — le contrôle de l'interface suit tout seul.
// Les données de l'interface (conversations, documents) ne sont PAS touchées.
export async function startAgentRollback(deps: MotorDeps): Promise<{ ok: boolean; error?: string }> {
  if (motorState.op) return { ok: false, error: "une opération est déjà en cours" };
  const previous = deps.store.getSetting(AGENT_PREVIOUS_KEY)?.trim() || null;
  if (!previous) {
    return {
      ok: false,
      error:
        "aucune version précédente connue — le retour arrière n'est proposé qu'après une mise à jour vue par l'interface",
    };
  }
  const dir = resolveAgentDir();
  setState({ op: { kind: "rollback", startedAt: new Date().toISOString() } }, deps);
  logLine(deps, `retour arrière demandé — procédure officielle de Hermes, retour vers la version ${previous}`, true);
  // Étape 1 : arrêt de la gateway (best effort — elle peut être déjà arrêtée).
  logLine(deps, "étape 1/3 — arrêt de la gateway Hermes…");
  await runLogged(deps, agentBin(), ["gateway", "stop"], {
    timeoutMs: GATEWAY_STOP_TIMEOUT_MS,
  });
  // Étape 2 : retour aux fichiers de la version précédente.
  logLine(deps, `étape 2/3 — retour aux fichiers de la version ${previous}…`);
  if (!dir) {
    logLine(
      deps,
      `RETOUR ERREUR — installation de Hermes introuvable (l'unique emplacement est hermes-agent DANS le dossier de l'application — elle sera installée au prochain démarrage si absente). Procédure manuelle officielle : dans le dossier de Hermes, « git checkout v${previous} » puis relancez l'agent.`,
    );
    setState({ op: null, error: "installation de Hermes introuvable" }, deps);
    journalAppend(deps.store, {
      type: "retour",
      label: "Retour arrière",
      version: previous,
      resultat: "echec",
      detail: "installation de Hermes introuvable",
    });
    return { ok: false, error: "installation de Hermes introuvable (voir le journal)" };
  }
  let checkoutOk = false;
  for (const tag of [`v${previous}`, previous]) {
    const res = await runLogged(deps, "git", ["-C", dir, "checkout", tag], { timeoutMs: 30_000 });
    if (res.code === 0) {
      checkoutOk = true;
      break;
    }
  }
  if (!checkoutOk) {
    logLine(
      deps,
      `RETOUR ERREUR — le retour aux fichiers de ${previous} a échoué (détail ci-dessus). Si la base de données de l'agent a été écrite par la version plus récente, Hermes refuse le retour : c'est sa protection officielle. Relancez alors la mise à jour, ou suivez la doc hermes-agent (« Updating & Uninstalling »).`,
    );
    setState({ op: null, error: "le retour aux fichiers de la version précédente a échoué" }, deps);
    journalAppend(deps.store, {
      type: "retour",
      label: "Retour arrière",
      version: previous,
      resultat: "echec",
      detail: "git checkout refusé ou en échec",
    });
    return { ok: false, error: "git checkout a échoué (voir le journal)" };
  }
  // Étape 3 : relance + contrôle. L'agent est lancé par l'utilisateur (ou
  // son lanceur) — l'interface re-sonde gentiment pendant deux minutes.
  logLine(deps, "étape 3/3 — relancez l'agent Hermes comme d'habitude : le contrôle suivra tout seul (jusqu'à 2 minutes).");
  const installedNow = await hermesVersion(true);
  deps.store.setSetting(AGENT_INSTALLED_KEY, installedNow ?? previous);
  deps.store.setSetting(AGENT_PREVIOUS_KEY, "");
  let control: MotorControl | null = null;
  for (let i = 0; i < 12; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 10_000));
    control = await runSensesCheckSilent(deps);
    if (control.ok) break;
  }
  const ok = control?.ok === true;
  logLine(
    deps,
    ok
      ? `RETOUR OK — Hermes est revenu à la version ${installedNow ?? previous}, l'interface reçoit de nouveau les infos.`
      : `RETOUR EFFECTUÉ (version ${installedNow ?? previous}) mais l'agent n'a pas répondu au contrôle — relancez l'agent, puis « Revérifier » dans le volet Système.`
  );
  journalAppend(deps.store, {
    type: "retour",
    label: "Retour arrière",
    version: installedNow ?? previous,
    resultat: ok ? "ok" : "info",
    detail: ok
      ? `retour vers ${previous} — contrôle réussi`
      : `retour vers ${previous} — l'agent n'a pas répondu au contrôle (relance nécessaire ?)`,
  });
  // Même entrée « contrôle » qu'après une mise à jour : le carnet raconte
  // l'opération ET le verdict des sens, séparément.
  if (control) {
    journalAppend(deps.store, {
      type: "controle",
      label: "Contrôle automatique de l'interface",
      version: control.versionLue,
      resultat: control.ok ? "ok" : "echec",
      detail: control.detail,
    });
  }
  setState({ op: null, installed: installedNow ?? previous, previousVersion: null }, deps);
  await refreshMotorStatus(deps);
  return { ok: true };
}

// ── Veille : vérifier au démarrage puis toutes les 6 h (comme la carte
//    Mise à jour de l'application) — désactivable au registre. ─────────────
export function startAgentMotorWatchdog(deps: MotorDeps): void {
  const run = () => {
    if (!deps.store.getSettingBool(AGENT_AUTOCHECK_KEY, true)) return;
    void refreshMotorStatus(deps).catch(() => {
      /* hors ligne : l'état d'erreur est déjà honnête */
    });
  };
  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref?.();
}
