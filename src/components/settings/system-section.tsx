// Section « Système » — v0.3.0 : DEUX cartes (spec §3), allégée.
// Carte 1 « Mise à jour » : conserve le mécanisme réel éprouvé du v0.2.1
//   (drapeau au lanceur + journal live system:update-log:changed + verdict
//   « MAJ OK / MAJ ERREUR » + chien de garde 45 s) — la demande de mise à
//   jour reste celle du lanceur, avec le déroulé en direct.
// Carte 2 « Agent Hermes » : l'état vient de la socket (flux unique §3.2),
//   aucun sondage ; version du service et dernier battement affichés.
// La gestion de l'espace disque a déménagé : page « Stockage » dédiée
//   (entrée au même niveau dans le rail — spec §2.1). Sondes RÉELLES
//   uniquement, jamais simulées.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
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

  return (
    <section aria-label="Système" className="mx-auto w-full max-w-[880px]">
      <h1 className="text-[19px] font-bold tracking-tight">Système</h1>
      <p className="mt-1 mb-4 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Mise à jour du service et état de l&apos;agent local. La gestion de l&apos;espace disque
        a déménagé :{" "}
        <button
          type="button"
          onClick={onNavigateStorage}
          className="font-semibold text-hermes-text hover:underline"
        >
          elle dispose de sa propre page « Stockage »
        </button>
        .
      </p>

      <div className="space-y-3">
        {/* ── Carte 1 : Mise à jour (action principale — spec §3.1) ────── */}
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">Mise à jour</div>
              <div className="mt-px text-[11.5px] leading-snug text-muted-foreground">
                Récupère la dernière version depuis GitHub, reconstruit si besoin et
                relance la pile — sans fermer fenêtres ni onglet.
                {serverVersion ? ` Version installée : ${serverVersion}.` : ""}
              </div>
            </div>
            {majDone === "ok" ? (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="h-8 flex-none cursor-pointer rounded-md bg-hermes px-3 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Recharger la page
              </button>
            ) : (
              <button
                type="button"
                onClick={updateNow}
                disabled={updating || majActif}
                className="h-8 flex-none cursor-pointer rounded-md bg-hermes px-3 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
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

        {/* ── Carte 2 : Agent Hermes (une ligne d'état — spec §3.2) ────── */}
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">
                Agent Hermes{" "}
                {connected ? (
                  <Pastille tone="ok" label="Connecté" className="ml-1" />
                ) : (
                  <Pastille tone="off" label="Reconnexion en cours" className="ml-1" />
                )}
              </div>
              <div className="mt-px text-[11.5px] leading-snug text-muted-foreground">
                {connected
                  ? `Processus local qui exécute les outils et gère les documents générés. Son état provient du flux websocket : source unique, sans sondage de l'interface. Dernier battement : à ${hf.format(lastSeen)}.`
                  : "Canal coupé — reconnexion automatique en cours (temporisation croissante, silencieuse)."}
              </div>
            </div>
            <button
              type="button"
              onClick={onNavigateStorage}
              className="h-8 flex-none cursor-pointer rounded-md border border-border bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
            >
              Documents générés →
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
