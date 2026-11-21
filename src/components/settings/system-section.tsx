// Section « Système » — v0.4.1 : DEUX GROUPES nommés (maquette de
// référence design/maquette-systeme-v2.html, validée par l'utilisatrice).
// Groupe « L'interface » : carte « Mise à jour de l'interface »
// (ex carte « Mise à jour », mécanisme v0.2.1/v0.3.3 conservé : pastille
// d'état, jalons Vérifiée → Téléchargée → Installée, journal live du
// lanceur, verdict « MAJ OK / MAJ ERREUR », chien de garde 45 s) + filet
// de sécurité interface (retour manuel documenté — révision d'avant).
// Groupe « Le moteur » : carte unique « Moteur Hermes » (agent-motor-card,
// fusion v0.4.1 des anciennes cartes « Agent » et « Moteur » — le même
// programme, un seul nom).
// v0.3.3 : l'état vient du SERVICE (hello.update + system:update-state —
// vérification au démarrage puis toutes les 6 h), la page n'est plus le
// seul déclencheur ; bouton « Mettre à jour » (drapeau au lanceur) grisé
// « À jour » quand il n'y a rien à faire. Sondes RÉELLES uniquement,
// jamais simulées.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Pastille } from "@/components/settings/bits";
import { AgentMotorCard } from "@/components/settings/agent-motor-card";
import { getSocket } from "@/lib/socket";

interface SystemSectionProps {
  /** État RÉEL de la socket vers le service — la pastille « connecté » de
   *  la carte Moteur suit ce flux (un seul flux, aucune requête). */
  connected?: boolean;
  /** v0.3.3 — révision disponible (null = à jour) : prop du panneau,
   *  même valeur que le point orange sur l'engrenage. */
  updateAvailable?: string | null;
  /** Révision git du déploiement (sonde hello.appRevision — filet de
   *  sécurité interface : la révision d'avant reste documentée). */
  appRevision?: string | null;
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
  updateAvailable = null,
  appRevision = null,
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
  const [majMotif, setMajMotif] = useState<string | null>(null);
  const majAJour = majEtat === "ajour";

  const checkUpdates = useCallback(() => {
    setMajEtat("inconnu");
    setMajMotif(null);
    getSocket().emit(
      "system:update-check",
      (res: { installed?: string | null; available?: string | null; checkedAt?: string | null; error?: string } = {}) => {
        if (res?.error) {
          setMajEtat("erreur");
          setMajMotif(res.error);
          return;
        }
        setMajVerifie(
          res.checkedAt
            ? new Date(res.checkedAt).toLocaleTimeString("fr-FR")
            : new Date().toLocaleTimeString("fr-FR")
        );
        if (res.available && res.available !== (res.installed ?? undefined)) {
          setMajEtat("disponible");
        } else {
          setMajEtat("ajour");
        }
      }
    );
  }, []);

  // Vérification à l'ouverture de la page (spec §3.1) + à la demande.
  // v0.3.3 : l'état vivant du service (hello.update / system:update-state,
  // vérifié au démarrage + 6 h) précède la réponse — si le service vient
  // d'annoncer « disponible », la carte l'affiche immédiatement.
  // Synchro pendant le rendu (ajustement d'état officiel React, pas un
  // effet — évite les rendus en cascade signalés par la règle
  // react-hooks/set-state-in-effect) : le prop peut arriver après le
  // montage (hello rediffusé) comme être déjà là au premier rendu.
  const [dernierUpdateDispo, setDernierUpdateDispo] = useState<string | null>(updateAvailable);
  if (updateAvailable !== dernierUpdateDispo) {
    setDernierUpdateDispo(updateAvailable);
    if (updateAvailable) {
      setMajEtat("disponible");
      setMajVerifie(new Date().toLocaleTimeString("fr-FR"));
    }
  }

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

  /** Révision installée, lue à la vérification (filet de sécurité —
   *  c'est la révision que « git checkout » restaurera si besoin). */
  const [majInstallee, setMajInstallee] = useState<string | null>(null);
  useEffect(() => {
    getSocket().emit(
      "system:update-check",
      (res: { installed?: string | null } = {}) => {
        if (res?.installed) setMajInstallee(res.installed);
      }
    );
  }, []);

  return (
    <section aria-label="Système" className="mx-auto w-full max-w-[880px]">
      <h1 className="text-[19px] font-bold tracking-tight">Système</h1>
      <p className="mt-1 mb-4 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Mise à jour de l&apos;application et du moteur Hermes qui travaille pour vous.
      </p>

      <div className="space-y-3">
        {/* ── Groupe « L'interface » — cette application (maquette v2) ── */}
        <p className="pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          L&apos;interface <span className="font-medium normal-case tracking-normal opacity-85">— cette application (hermes_ui)</span>
        </p>

        {/* ── Carte : Mise à jour de l'interface (action principale) ── */}
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
                Mise à jour de l&apos;interface{" "}
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
                  ? "Vérification de la disponibilité d'une nouvelle version…"
                  : majEtat === "ajour"
                    ? <>
                        Votre version de l&apos;application est la plus récente — rien à installer.
                        {majVerifie ? ` Vérifié à ${majVerifie}.` : ""}
                      </>
                    : majEtat === "disponible"
                      ? <>
                          Une nouvelle version de l&apos;application est prête à être installée. Le bouton
                          «&nbsp;Mettre à jour&nbsp;» télécharge et installe tout&nbsp;: l&apos;application
                          redémarre ensuite toute seule (1&nbsp;à&nbsp;2&nbsp;minutes).
                        </>
                      : <>
                          Impossible de vérifier les mises à jour ({majMotif ?? "cause inconnue"}).
                          Vérifiez votre connexion internet, puis réessayez.
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
              La mise à jour est installée par le petit programme qui a lancé Hermes
              (icône « Hermes Web ») : il prendra la demande dans les 15&nbsp;secondes,
              mettra tout à jour, puis relancera Hermes tout seul.
            </p>
          )}
        </div>

        {/* ── Filet de sécurité — interface (retour manuel documenté) ── */}
        <div className="rounded-xl border border-border bg-muted px-4 py-3">
          <div className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
            Filet de sécurité — interface{" "}
            <Pastille tone="off" label="retour manuel" />
          </div>
          <p className="mt-0.5 max-w-[560px] text-[12.5px] leading-relaxed text-muted-foreground">
            {majInstallee || appRevision ? (
              <>
                La révision d&apos;avant <b className="font-mono text-[11.5px]">{majInstallee ?? appRevision}</b> reste
                toujours connue. Le retour arrière de l&apos;interface n&apos;est pas encore un
                bouton&nbsp;: il se fait dans le dossier de l&apos;application — «&nbsp;git checkout{" "}
                {majInstallee ?? appRevision}
                &nbsp;», puis relancez Hermes-Web. Vos conversations et vos réglages ne
                sont pas touchés.
              </>
            ) : (
              <>
                Le retour arrière de l&apos;interface se fait dans le dossier de
                l&apos;application («&nbsp;git checkout&nbsp;» vers une révision passée, puis
                relancez Hermes-Web). Vos conversations et vos réglages ne sont pas
                touchés. La révision en cours s&apos;affichera ici dès la première
                vérification.
              </>
            )}
          </p>
        </div>

        {/* ── Groupe « Le moteur » — le programme Hermes (maquette v2) ── */}
        <p className="pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Le moteur <span className="font-medium normal-case tracking-normal opacity-85">— le programme Hermes</span>
        </p>

        {/* v0.4.1 : carte unique Moteur Hermes — fusion des anciennes
            cartes « Agent » (liaison) et « Moteur » (maintenance). */}
        <AgentMotorCard connected={connected} onNavigateStorage={onNavigateStorage} />
      </div>
    </section>
  );
}
