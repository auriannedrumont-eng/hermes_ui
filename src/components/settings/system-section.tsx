// Section « Système » du volet Paramètres v4 (v2.4) — versions, connexion à
// l'agent Hermes (gateway), journaux. Sondes RÉELLES uniquement : révision git
// du déploiement, état du binaire chrome-headless, place des profils de rendu
// (mesurée sur le système de fichiers), sonde WebSocket de la gateway. Les
// réglages du MOTEUR (mises à jour, exécution des commandes, journaux)
// restent verrouillés « gateway » — jamais simulés.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pastille } from "@/components/settings/bits";
import { getSocket } from "@/lib/socket";
import type { GatewayMode } from "@/lib/chat-types";

interface SystemSectionProps {
  mode: GatewayMode | null;
  /** Fournisseurs LLM actionnables (v2.4) — pastille « moteur local » honnête. */
  engineProviders?: string[] | null;
  serverVersion: string | null;
  /** Révision git du déploiement (null = installation sans git). */
  appRevision: string | null;
  chromeHeadless: "present" | "absent" | null;
  gatewayUrl: string | null;
  /** Jeton de gateway enregistré côté service (jamais la valeur). */
  gatewayTokenSet?: boolean;
  /** Branche/débranche la gateway (URL vide = débranchement). */
  onConnectGateway?: (
    url: string,
    token?: string
  ) => Promise<{ ok: boolean; error?: string }>;
}

interface RenderCacheStats {
  count: number;
  bytes: number;
  removed?: number;
  kept?: number;
}

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return "0 o";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/** Verdict de la mise à jour = marqueur terminal de la DERNIÈRE ligne non
 *  vide du journal (les lanceurs écrivent « MAJ OK » / « MAJ ERREUR » —
 *  une « ATTENTION » au milieu du déroulé ne termine rien). */
function majVerdict(text: string): null | "ok" | "erreur" {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  if (last.includes("MAJ ERREUR")) return "erreur";
  if (last.includes("MAJ OK")) return "ok";
  return null;
}

/** Dernière ligne non vide du journal — contexte du chien de garde : une
 *  attente après « consultation de GitHub » est normale (fenêtre de connexion
 *  Git Credential Manager la première fois), elle ne prouve pas un lanceur
 *  mort. */
function majDerniereLigne(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

export function SystemSection({
  mode,
  engineProviders = null,
  serverVersion,
  appRevision,
  chromeHeadless,
  gatewayUrl,
  gatewayTokenSet = false,
  onConnectGateway,
}: SystemSectionProps) {
  const [stats, setStats] = useState<RenderCacheStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  // ── Formulaire de connexion de la gateway (URL + jeton facultatif) ──
  const [urlDraft, setUrlDraft] = useState(gatewayUrl ?? "");
  const [tokenDraft, setTokenDraft] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectedFlash, setConnectedFlash] = useState(false);
  // ── Mise à jour depuis l'interface — demande + JOURNAL LIVE ────────
  // Le lanceur raconte chaque étape dans desktop/runtime/maj.log ; le
  // service relit ce journal et le relaie (system:update-log /
  // system:update-log:changed) : la carte affiche le déroulé en direct,
  // avec un verdict franc à la fin — plus d'attente aveugle.
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  /** Journal connu (null = pas de mise à jour en cours). */
  const [majLog, setMajLog] = useState<string | null>(null);
  /** Verdict du journal : marqueur terminal de la dernière ligne. */
  const [majDone, setMajDone] = useState<null | "ok" | "erreur">(null);
  /** Aucune étape nouvelle depuis 45 s : le lanceur ne réagit probablement pas. */
  const [majStale, setMajStale] = useState(false);
  /** Socket coupé pendant la mise à jour (le lanceur relance la pile). */
  const [majReconnect, setMajReconnect] = useState(false);
  const consoleRef = useRef<HTMLPreElement | null>(null);
  const majLastChangeRef = useRef(0);
  const majActif = majLog !== null && majDone === null;
  // Chien de garde contextualisé : la dernière étape connue du journal.
  const majAttendGitHub =
    majLog !== null && majDerniereLigne(majLog).includes("GitHub");
  // La mise à jour a remplacé le script du lanceur LUI-MÊME (Windows l'écrit
  // sans accents « lanceur lui-meme », Linux l'écrit accentué) : il tourne
  // encore avec l'ancien code jusqu'à sa relance — sans elle, la prochaine
  // demande de mise à jour serait muette.
  const majLanceurPerime = majLog !== null && majLog.includes("lanceur lui-m");

  const majFetch = useCallback(() => {
    getSocket().emit(
      "system:update-log",
      (res: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
        if (!res?.exists || typeof res.text !== "string") return;
        majLastChangeRef.current = Date.now();
        setMajStale(false);
        setMajReconnect(false);
        setMajLog(res.text);
        setMajDone(majVerdict(res.text));
      }
    );
  }, []);

  const updateNow = () => {
    if (updating || majActif) return;
    setUpdating(true);
    setUpdateError(null);
    setMajDone(null);
    getSocket().emit(
      "system:update-request",
      (res: { ok?: boolean; error?: string } = {}) => {
        setUpdating(false);
        if (res?.ok) {
          // Le service a écrit la première ligne du journal avant l'ack :
          // on la tire aussitôt — la suite arrive par le relais en direct.
          majFetch();
        } else {
          setUpdateError(res?.error ?? "Échec du dépôt de la demande de mise à jour");
        }
      }
    );
  };

  // Suivi live pendant une mise à jour : relais du journal + reprise après
  // la coupure (le lanceur arrête ce service pour le relancer — socket.io
  // se reconnecte seul) + détection d'un lanceur muet (trop ancien pour
  // connaître le drapeau : aucune étape n'apparaît).
  useEffect(() => {
    if (!majActif) return;
    const socket = getSocket();
    const onChange = (snap: { text?: string } = {}) => {
      if (typeof snap?.text !== "string") return;
      majLastChangeRef.current = Date.now();
      setMajStale(false);
      setMajLog(snap.text);
      setMajDone(majVerdict(snap.text));
    };
    const onConnect = () => majFetch();
    const onDisconnect = () => setMajReconnect(true);
    socket.on("system:update-log:changed", onChange);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    const timer = setInterval(() => {
      if (Date.now() - majLastChangeRef.current > 45_000) setMajStale(true);
    }, 5_000);
    return () => {
      socket.off("system:update-log:changed", onChange);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      clearInterval(timer);
    };
  }, [majActif, majFetch]);

  // Reprise au montage : un F5 pendant la mise à jour ne doit pas faire
  // perdre la console — le journal persiste côté service ; on le relit s'il
  // est récent et sans verdict (sinon il s'agit d'un vieil essai terminé).
  useEffect(() => {
    getSocket().emit(
      "system:update-log",
      (res: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
        if (!res?.exists || typeof res.text !== "string" || !res.text.trim()) return;
        const fresh =
          typeof res.mtimeMs === "number" &&
          Date.now() - res.mtimeMs < 10 * 60_000;
        if (majVerdict(res.text) === null && fresh) {
          majLastChangeRef.current = Date.now();
          setMajLog(res.text);
        }
      }
    );
  }, []);

  // Console : toujours coller en bas (le déroulé se lit de haut en bas).
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [majLog]);

  // Resynchronise le champ si l'URL change côté service (hello rediffusé) —
  // ajustement d'état pendant le rendu (motif React officiel) : un effet
  // appelant setState synchronement est interdit par la règle react-hooks.
  const [lastGatewayUrl, setLastGatewayUrl] = useState<string | null>(null);
  if ((gatewayUrl ?? "") !== (lastGatewayUrl ?? "")) {
    setLastGatewayUrl(gatewayUrl ?? "");
    setUrlDraft(gatewayUrl ?? "");
  }

  const load = useCallback(() => {
    getSocket().emit(
      "system:renderCache",
      (res: RenderCacheStats = { count: 0, bytes: 0 }) => setStats(res)
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const clear = () => {
    setClearing(true);
    setCleared(null);
    getSocket().emit("system:clearRenderCache", (res: RenderCacheStats = { count: 0, bytes: 0 }) => {
      setStats(res);
      setClearing(false);
      setCleared(
        `${res.removed ?? 0} profil${(res.removed ?? 0) > 1 ? "s" : ""} supprimé${(res.removed ?? 0) > 1 ? "s" : ""}${
          res.kept ? `, ${res.kept} en cours d'utilisation` : ""
        }`
      );
    });
  };

  const local = mode !== "gateway";
  // « local » : sans agent lancé, seules les clés fournisseurs actives
  // répondent (réel) ; sinon état « agent non détecté » — rien n'est simulé.
  const poolActive = (engineProviders?.length ?? 0) > 0;

  const submitGateway = async (url: string) => {
    if (!onConnectGateway || connecting) return;
    setConnecting(true);
    setConnectError(null);
    const res = await onConnectGateway(url, tokenDraft.trim() || undefined);
    setConnecting(false);
    if (res.ok) {
      setTokenDraft("");
      setConnectedFlash(true);
      setTimeout(() => setConnectedFlash(false), 4000);
    } else {
      setConnectError(res.error ?? "Échec de la connexion");
    }
  };

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Système</h1>
      <p className="mt-1 mb-2 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Versions, exécution des commandes, journaux.
      </p>

      {/* ── Interface & service — sondes réelles ─────────────────────── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-1">
        <div className="flex items-center gap-3 py-[11px]">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Service</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Le mini-service qui répond derrière cette interface.
            </div>
          </div>
          <span className="flex-none text-[12.5px] font-medium tabular-nums text-muted-foreground">
            {serverVersion ? `v${serverVersion}` : "—"}
          </span>
        </div>
        <div className="flex items-center gap-3 border-t border-border/60 py-[11px]">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Révision de l&apos;interface</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              {appRevision
                ? "Révision git du déploiement installé sur cette machine."
                : "Installation sans git (archive téléversée) — la révision ne peut pas être lue."}
            </div>
          </div>
          <span className="flex-none font-mono text-[12.5px] font-medium tabular-nums text-muted-foreground">
            {appRevision ?? "inconnue"}
          </span>
        </div>
        <div className="flex items-center gap-3 border-t border-border/60 py-[11px]">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Moteur</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              {local
                ? poolActive
                  ? `Agent non lancé — les réponses partent sur l'API de vos fournisseurs (clés actives : ${engineProviders!.join(", ")}).`
                  : "Agent Hermes non détecté — lancez l'agent (connexion automatique) ou ajoutez une clé fournisseur (Fournisseurs)."
                : "Agent Hermes connecté — les réponses viennent de l'agent réel (outils inclus)."}
            </div>
          </div>
          {local ? (
            poolActive ? (
              <Pastille tone="ok" label="clés" className="flex-none" />
            ) : (
              <Pastille tone="off" label="non détecté" className="flex-none" />
            )
          ) : (
            <Pastille tone="ok" label="agent" className="flex-none" />
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border/60 py-[11px]">
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold">Rendu (chrome-headless)</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Vignettes des artefacts, PDF et images des conversations partagées.
            </div>
          </div>
          <Pastille
            tone={chromeHeadless === "absent" ? "err" : "ok"}
            label={chromeHeadless === "absent" ? "introuvable" : "présent"}
            className="flex-none"
          />
        </div>
      </div>

      {/* ── Mise à jour de l'interface — demande + console en direct ── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold">
              Mise à jour de l&apos;interface
            </div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Récupère la dernière version depuis GitHub, reconstruit si besoin et relance
              la pile — sans fermer fenêtres ni onglet.
            </div>
          </div>
          {majDone === "ok" ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex h-8 flex-none cursor-pointer items-center justify-center rounded-md bg-hermes px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90"
            >
              Recharger la page
            </button>
          ) : (
            <button
              type="button"
              onClick={updateNow}
              disabled={updating || majActif}
              className="inline-flex h-8 flex-none cursor-pointer items-center justify-center rounded-md bg-hermes px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {updating ? "Dépôt…" : majActif ? "Mise à jour en cours…" : "Mettre à jour"}
            </button>
          )}
        </div>

        {majLog !== null ? (
          <div className="mt-2">
            <pre
              ref={consoleRef}
              aria-label="Journal de la mise à jour en direct"
              className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
            >
              {majLog}
            </pre>
            {majDone === "ok" ? (
              <>
                <p className="mt-2 flex items-start gap-1.5 text-[11px] font-medium text-success" role="status">
                  <Check className="mt-0.5 size-[13px] flex-none" strokeWidth={2.5} />
                  <span>
                    Mise à jour terminée — rechargez la page pour charger la nouvelle
                    interface.
                  </span>
                </p>
                {majLanceurPerime ? (
                  <p className="mt-1.5 text-[11px] font-medium text-warning" role="status">
                    Le lanceur lui-même a été mis à jour mais tourne encore avec
                    l&apos;ancien code : fermez sa fenêtre puis relancez Hermes-Web.bat
                    une fois — sans cela, la PROCHAINE mise à jour s&apos;exécutera en
                    silence (console vide).
                  </p>
                ) : null}
              </>
            ) : majDone === "erreur" ? (
              <p className="mt-2 text-[11px] font-medium text-destructive" role="alert">
                Échec de la mise à jour — le détail complet est dans la fenêtre du lanceur.
                Après correction, redemandez «&nbsp;Mettre à jour&nbsp;».
              </p>
            ) : majReconnect ? (
              <p className="mt-2 text-[11px] text-muted-foreground" role="status">
                Services relancés par la mise à jour — reconnexion en cours…
              </p>
            ) : majStale ? (
              majAttendGitHub ? (
                <p className="mt-2 text-[11px] font-medium text-warning" role="alert">
                  Le lanceur consulte GitHub depuis 45&nbsp;s — une fenêtre de connexion
                  GitHub est peut-être ouverte (la première fois seulement) : répondez-y
                  pour laisser la mise à jour continuer. Pas de fenêtre&nbsp;? Fermez la
                  fenêtre du lanceur, relancez Hermes-Web.bat, puis redemandez la mise à
                  jour ici.
                </p>
              ) : (
                <p className="mt-2 text-[11px] font-medium text-warning" role="alert">
                  Le lanceur ne réagit pas (aucune étape nouvelle depuis 45&nbsp;s) — il
                  date probablement d&apos;avant cette fonction. La mise à jour a peut-être
                  quand même abouti : attendez une minute puis rechargez la page (F5).
                  Sinon, fermez la fenêtre du lanceur puis relancez Hermes-Web.bat —
                  désormais la relance remplace un lanceur périmé même s&apos;il tourne
                  encore — et redemandez la mise à jour ici.
                </p>
              )
            ) : (
              <p className="mt-2 text-[11px] text-muted-foreground" role="status">
                Mise à jour en cours — les étapes apparaissent ici en direct (1 à 2 min,
                davantage si reconstruction).
              </p>
            )}
          </div>
        ) : updateError ? (
          <p className="mt-2 text-[11px] font-medium text-destructive" role="alert">
            {updateError}
          </p>
        ) : (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Fonctionne quand la pile est lancée par le lanceur bureau (Hermes-Web.bat ou
            hermes-ui.sh) : la demande est ramassée au cycle de surveillance suivant (15&nbsp;s),
            et chaque étape s&apos;affiche ici en direct jusqu&apos;au verdict final.
          </p>
        )}
      </div>

      {/* ── Connexion à l'agent Hermes (gateway) — sonde WebSocket réelle ── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold">
              Connexion à l&apos;agent Hermes
            </div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Branchez la gateway de l&apos;agent réel — ses outils (terminal,
              fichiers, web) et ses modèles deviennent ceux de l&apos;interface.
            </div>
          </div>
          {mode === "gateway" ? (
            <Pastille tone="ok" label="connectée" className="flex-none" />
          ) : (
            <Pastille tone="off" label="non branchée" className="flex-none" />
          )}
        </div>
        <div className="mt-2.5 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="grid gap-1">
            <span className="text-[11px] text-muted-foreground">
              URL — facultative (connexion automatique par défaut)
            </span>
            <input
              type="text"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitGateway(urlDraft.trim());
              }}
              placeholder="auto : ws://127.0.0.1:9120/api/ws"
              aria-label="URL de la gateway Hermes — vide pour la connexion automatique"
              className="h-9 rounded-sm border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-hermes/60"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] text-muted-foreground">
              Jeton {gatewayTokenSet ? "(enregistré — laisser vide pour conserver)" : "(facultatif)"}
            </span>
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitGateway(urlDraft.trim());
              }}
              placeholder={gatewayTokenSet ? "••••••••" : "ticket de session"}
              aria-label="Jeton de la gateway Hermes"
              className="h-9 rounded-sm border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-hermes/60"
            />
          </label>
          <div className="flex gap-1.5 sm:pb-px">
            <button
              type="button"
              onClick={() => void submitGateway(urlDraft.trim())}
              disabled={connecting || !onConnectGateway}
              className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-hermes px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {connecting ? "Connexion…" : "Connecter"}
            </button>
            {gatewayUrl ? (
              <button
                type="button"
                onClick={() => void submitGateway("")}
                disabled={connecting || !onConnectGateway}
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Débrancher
              </button>
            ) : null}
          </div>
        </div>
        {connectError ? (
          <p className="mt-2 text-[11px] font-medium text-destructive" role="alert">
            {connectError}
          </p>
        ) : connectedFlash ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-success">
            <Check className="size-[13px] flex-none" strokeWidth={2.5} />
            {mode === "gateway"
              ? "Agent connecté — Hermes répond."
              : "Enregistré — l'agent n'a pas répondu, re-sonde automatique à chaque message."}
          </p>
        ) : (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Rien à configurer : lancer l'agent Hermes suffit (défaut
            ws://127.0.0.1:9120/api/ws). Ce champ ne sert qu'aux installations
            spéciales (port ou machine différents).
          </p>
        )}
      </div>

      {/* ── Profils de rendu — sonde réelle + purge ───────────────────── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold">Profils de rendu</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Régénérés à chaque rendu, purgés aussi à chaque démarrage du service.
            </div>
          </div>
          <span className="flex-none text-[12.5px] font-medium tabular-nums text-muted-foreground">
            {stats ? `${stats.count} · ${fmtBytes(stats.bytes)}` : "…"}
          </span>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {cleared ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-success">
              <Check className="size-[13px] flex-none" strokeWidth={2.5} />
              <span className="truncate">{cleared}</span>
            </span>
          ) : (
            <span className="min-w-0 text-[11px] text-muted-foreground">
              Libère de la place si les documents s&apos;accumulent.
            </span>
          )}
          <button
            type="button"
            onClick={clear}
            disabled={clearing || !stats || stats.count === 0}
            className="inline-flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-destructive"
          >
            <Trash2 className="size-[13px]" strokeWidth={2} />
            {clearing ? "Nettoyage…" : "Nettoyer maintenant"}
          </button>
        </div>
      </div>

      {/* ── Moteur Hermes — verrouillé « gateway », jamais simulé ─────── */}
      <div className="mt-4">
        <h2 className="text-[14px] font-semibold tracking-tight">Moteur Hermes</h2>
        <div className={cn("mt-2 rounded-xl border border-dashed border-border px-4 py-1")}>
          {[
            {
              name: "Version & mises à jour",
              desc: "version installée, canal, sauvegarde avant mise à jour",
            },
            {
              name: "Exécution des commandes",
              desc: "sur votre machine, conteneur isolé ou machine distante ; durée max, réseau isolé",
            },
            {
              name: "Journaux & télémétrie",
              desc: "journalisation détaillée, ce qui sort de votre machine",
            },
          ].map((it, i) => (
            <div
              key={it.name}
              className={cn(
                "flex items-center gap-3 py-[11px]",
                i > 0 && "border-t border-border/60"
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold">{it.name}</div>
                <div className="mt-px text-[11px] leading-snug text-muted-foreground">
                  {it.desc}
                </div>
              </div>
              <Pastille tone="off" label="gateway" className="flex-none" />
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          Ces réglages pilotent le moteur réel : ils s&apos;activeront au branchement de
          la gateway (FORK.md §4). Rien n&apos;est simulé en attendant.
        </p>
      </div>
    </section>
  );
}
