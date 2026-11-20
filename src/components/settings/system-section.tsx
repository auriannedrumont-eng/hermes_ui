// Section « Système » — v0.3.2 : DEUX cartes conformes à la maquette de
// référence design/… (hermes-systeme-stockage.html, partie Système).
// Carte 1 « Mise à jour » : pastille d'état dans le titre (Vérification… /
// À jour / Mise à jour disponible / Erreur), jalons Vérifiée → Téléchargée
// → Installée, journal live du lanceur (maj.log via system:update-log +
// relais system:update-log:changed, verdict « MAJ OK / MAJ ERREUR »,
// chien de garde 45 s). Mécanisme réel conservé : drapeau au lanceur,
// vérification à l'ouverture (spec §3.1) et à la demande, bouton grisé
// « À jour » quand il n'y a rien à récupérer.
// Carte 2 « Agent Hermes » : pastille d'état, lignes techniques (version du
// service, dernier battement, canal), bloc « Installation spéciale »
// repliable (adresse + code d'accès). L'état vient de la socket (flux
// unique §3.2), aucun sondage ; sondes RÉELLES uniquement, jamais simulées.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Pastille } from "@/components/settings/bits";
import { getSocket } from "@/lib/socket";

interface SystemSectionProps {
  /** État RÉEL de la socket vers le service — la pastille « connecté » de
   *  la carte Agent suit ce flux (§3.2 : un seul flux, aucune requête). */
  connected?: boolean;
  serverVersion: string | null;
  /** Navigation vers la page Stockage (lien « documents générés »). */
  onNavigateStorage?: () => void;
}

/** Verdict de la mise à jour = marqueur terminal de la DERNIÈRE ligne non
 *  vide du journal (les lanceurs écrivent « MAJ OK » / « MAJ ERREUR »). */
function majVerdict(text: string): null | "ok" | "erreur" {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  if (last.includes("MAJ ERREUR")) return "erreur";
  if (last.includes("MAJ OK")) return "ok";
  return null;
}

/** Dernière ligne non vide du journal — contexte du chien de garde. */
function majDerniereLigne(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

export function SystemSection({
  connected = true,
  serverVersion,
  onNavigateStorage,
}: SystemSectionProps) {
  // ── Carte Mise à jour : demande + journal live du lanceur ──────────
  // (mécanisme v0.2.1 conservé : le lanceur ramasse le drapeau, raconte
  // chaque étape dans maj.log, le service relaie en direct.)
  // v0.3.1 : vérification à l'OUVERTURE (spec §3.1 — deux déclencheurs
  // seulement : l'ouverture et le bouton) : le service compare la révision
  // installée à la pointe GitHub. Bouton grisé « À jour » quand il n'y a
  // rien à récupérer.
  const [majEtat, setMajEtat] = useState<"inconnu" | "ajour" | "disponible" | "erreur">("inconnu");
  const [majVerifie, setMajVerifie] = useState<string | null>(null);
  const [majDist, setMajDist] = useState<string | null>(null);
  const [majMotif, setMajMotif] = useState<string | null>(null);
  const majAJour = majEtat === "ajour";

  const checkUpdates = useCallback(() => {
    setMajEtat("inconnu");
    setMajMotif(null);
    getSocket().emit(
      "system:update-check",
      (res: { installed?: string | null; available?: string | null; error?: string } = {}) => {
        if (res?.error) {
          setMajEtat("erreur");
          setMajMotif(res.error);
          return;
        }
        setMajVerifie(new Date().toLocaleTimeString("fr-FR"));
        if (res.available && res.available !== (res.installed ?? undefined)) {
          setMajEtat("disponible");
          setMajDist(res.available);
        } else {
          setMajEtat("ajour");
        }
      }
    );
  }, []);

  // Vérification à l'ouverture de la page (spec §3.1) + à la demande.
  useEffect(() => {
    checkUpdates();
  }, [checkUpdates]);

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
  const majAttendGitHub =
    majLog !== null && majDerniereLigne(majLog).includes("GitHub");
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
          majFetch();
        } else {
          setUpdateError(res?.error ?? "Échec du dépôt de la demande de mise à jour");
        }
      }
    );
  };

  // Suivi live pendant une mise à jour : relais du journal + reprise après
  // la coupure + détection d'un lanceur muet (trop ancien : aucune étape).
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
  // perdre la console — le journal persiste côté service.
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

  // Console : toujours coller en bas.
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [majLog]);

  // ── Carte Agent : état de la socket (flux unique — §3.2) ────────────
  const hf = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const [lastSeen, setLastSeen] = useState<number>(Date.now());
  useEffect(() => {
    const onAny = () => setLastSeen(Date.now());
    const socket = getSocket();
    socket.onAny(onAny);
    return () => {
      socket.offAny(onAny);
    };
  }, []);

  // « Installation spéciale » (maquette) : repliée par défaut.
  const [advOpen, setAdvOpen] = useState(false);

  return (
    <section aria-label="Système" className="mx-auto w-full max-w-[880px]">
      <h1 className="text-[19px] font-bold tracking-tight">Système</h1>
      <p className="mt-1 mb-4 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Mise à jour du service et état de l&apos;agent local.
      </p>

      <div className="space-y-3">
        {/* ── Carte 1 : Mise à jour (action principale — spec §3.1) ────── */}
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
                Mise à jour{" "}
                {majEtat === "inconnu" ? (
                  <Pastille tone="busy" label="Vérification…" />
                ) : majEtat === "ajour" ? (
                  <Pastille tone="ok" label="À jour" />
                ) : majEtat === "disponible" ? (
                  <Pastille tone="warn" label="Mise à jour disponible" />
                ) : (
                  <Pastille tone="err" label="Erreur" />
                )}
              </div>
              <div className="mt-0.5 max-w-[500px] text-[12.5px] leading-relaxed text-muted-foreground">
                {majEtat === "inconnu"
                  ? "Interrogation du dépôt de mise à jour…"
                  : majEtat === "ajour"
                    ? <>
                        Vous utilisez <b className="font-semibold text-foreground">Hermes {serverVersion}</b>, la dernière version publiée.
                        {majVerifie ? ` Dernière vérification : ${majVerifie}.` : ""}
                      </>
                    : majEtat === "disponible"
                      ? <>
                          Hermes <b className="font-semibold text-foreground">{majDist}</b> est disponible. Version installée : {serverVersion}.
                        </>
                      : <>
                          La vérification a échoué : {majMotif ?? "cause inconnue."} Version installée :{" "}
                          <b className="font-semibold text-foreground">{serverVersion}</b>.
                        </>}
              </div>
            </div>
            <div className="flex flex-none flex-wrap items-center gap-2">
              {majEtat === "ajour" && majDone !== "ok" ? (
                <button
                  type="button"
                  onClick={checkUpdates}
                  className="h-8 cursor-pointer rounded-md border border-border bg-card px-3 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
                >
                  Vérifier à nouveau
                </button>
              ) : null}
              {majEtat === "erreur" ? (
                <button
                  type="button"
                  onClick={checkUpdates}
                  className="h-8 cursor-pointer rounded-md border border-border bg-card px-3 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
                >
                  Réessayer
                </button>
              ) : null}
              {majDone === "ok" ? (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="h-8 cursor-pointer rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
                >
                  Recharger la page
                </button>
              ) : majEtat === "inconnu" ? (
                <button
                  type="button"
                  disabled
                  className="h-8 flex-none cursor-not-allowed rounded-md bg-hermes px-3 text-[12px] font-semibold text-hermes-foreground opacity-40"
                >
                  Vérification…
                </button>
              ) : (
                <button
                  type="button"
                  onClick={updateNow}
                  disabled={updating || majActif || majAJour}
                  title={majAJour ? "Aucune mise à jour disponible" : undefined}
                  className="h-8 flex-none cursor-pointer rounded-md bg-hermes-strong px-3 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {updating
                    ? "Dépôt…"
                    : majActif
                      ? "Mise à jour en cours…"
                      : majAJour
                        ? "À jour"
                        : majEtat === "disponible"
                          ? "Mettre à jour"
                          : "Réessayer"}
                </button>
              )}
            </div>
          </div>

          {/* Jalons : Vérifiée → Téléchargée → Installée (maquette —
              exécutée par le lanceur ; ici l'étape atteinte est dérivée
              de l'état réel : vérification aboutie / journal vivant /
              verdict MAJ OK). */}
          <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
            {(() => {
              const verifiee = majEtat !== "inconnu" || majDone !== null;
              const telechargee = majDone === "ok";
              const installlee = majDone === "ok";
              const jalon = (done: boolean, now: boolean, label: string) => (
                <span
                  className={
                    "inline-flex items-center gap-1.5 text-[12px] font-semibold " +
                    (done ? "text-foreground" : now ? "text-hermes-text" : "text-muted-foreground")
                  }
                >
                  <i
                    aria-hidden
                    className={
                      "grid size-[17px] flex-none place-items-center rounded-full border-2 text-[9px] text-white " +
                      (done ? "border-success bg-success" : now ? "border-hermes" : "border-border")
                    }
                  >
                    {done ? "✓" : ""}
                  </i>
                  {label}
                </span>
              );
              const sep = (done: boolean) => (
                <span aria-hidden className={"h-0.5 w-[26px] flex-none rounded " + (done ? "bg-success" : "bg-border")} />
              );
              return (
                <>
                  {jalon(verifiee, majEtat === "inconnu", "Vérifiée")}
                  {sep(telechargee)}
                  {jalon(telechargee, majActif, "Téléchargée")}
                  {sep(installlee)}
                  {jalon(installlee, false, "Installée")}
                </>
              );
            })()}
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
                <p className="mt-2 flex items-start gap-1.5 text-[11px] font-medium text-success" role="status">
                  <Check className="mt-0.5 size-[13px] flex-none" strokeWidth={2.5} />
                  <span>
                    Mise à jour terminée — rechargez la page pour charger la nouvelle
                    interface.
                  </span>
                </p>
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
                    GitHub est peut-être ouverte : répondez-y pour laisser la mise à jour
                    continuer.
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] font-medium text-warning" role="alert">
                    Le lanceur ne réagit pas (aucune étape nouvelle depuis 45&nbsp;s) — il
                    date probablement d&apos;avant cette fonction. La mise à jour a peut-être
                    quand même abouti : attendez une minute puis rechargez la page (F5).
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
              hermes-ui.sh) : la demande est ramassée au cycle de surveillance suivant (15&nbsp;s).
            </p>
          )}
        </div>

        {/* ── Carte 2 : Agent Hermes (état + lignes techniques — §3.2) ── */}
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
                Agent Hermes{" "}
                {connected ? (
                  <Pastille tone="ok" label="Connecté" />
                ) : (
                  <Pastille tone="off" label="Reconnexion en cours" />
                )}
              </div>
              <div className="mt-0.5 max-w-[500px] text-[12.5px] leading-relaxed text-muted-foreground">
                {connected
                  ? "Processus local qui exécute les outils et gère les documents générés. Son état provient du flux websocket : source unique, sans sondage de l'interface."
                  : "Canal coupé — reconnexion automatique en cours (temporisation croissante, silencieuse)."}
              </div>
            </div>
            <div className="flex flex-none items-center gap-2">
              <button
                type="button"
                onClick={onNavigateStorage}
                className="h-8 cursor-pointer rounded-md border border-border bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
              >
                Documents générés →
              </button>
            </div>
          </div>

          {/* Lignes techniques (maquette) : sonde réelle unique — la
              version vient du hello du service, le battement du flux
              websocket, le canal est la socket elle-même. */}
          <div className="mt-1 text-[12.5px]">
            <div className="flex items-center justify-between gap-4 border-b border-border py-2">
              <span className="text-muted-foreground">Version du service</span>
              <b className="font-mono text-[11.5px] font-semibold tabular-nums">
                {connected ? (serverVersion ? `v${serverVersion}` : "—") : "—"}
              </b>
            </div>
            <div className="flex items-center justify-between gap-4 border-b border-border py-2">
              <span className="text-muted-foreground">Dernier battement reçu</span>
              <b className="font-mono text-[11.5px] font-semibold tabular-nums">
                {connected ? `à ${hf.format(lastSeen)}` : "—"}
              </b>
            </div>
            <div className="flex items-center justify-between gap-4 py-2">
              <span className="text-muted-foreground">Canal</span>
              <b className="font-mono text-[11.5px] font-semibold">socket.io — flux poussé</b>
            </div>
          </div>

          {/* Installation spéciale (maquette) : repliée par défaut, les
              champs restent locaux à la session — aucune donnée n'est
              envoyée sans action explicite de l'utilisateur. */}
          <button
            type="button"
            onClick={() => setAdvOpen((v) => !v)}
            aria-expanded={advOpen}
            className="mt-1 inline-flex cursor-pointer items-center gap-1.5 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={"size-[12px] transition-transform " + (advOpen ? "rotate-180" : "")}
              strokeWidth={2.5}
            />
            Installation spéciale
          </button>
          {advOpen ? (
            <div className="mt-1.5">
              <label className="mt-2.5 block">
                <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">Adresse de l&apos;agent</span>
                <input
                  type="text"
                  placeholder="http://127.0.0.1:8765"
                  className="h-9 w-full rounded-md border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus-visible:border-hermes/60"
                />
              </label>
              <label className="mt-2.5 block">
                <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">Code d&apos;accès</span>
                <input
                  type="password"
                  placeholder="••••••••"
                  className="h-9 w-full rounded-md border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus-visible:border-hermes/60"
                />
              </label>
              <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
                Pour une installation de l&apos;agent sur un autre poste : cette connexion remplace le canal local
                seulement après validation explicite.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
