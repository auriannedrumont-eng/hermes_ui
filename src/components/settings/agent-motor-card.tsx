"use client";

// Carte « Hermes » (v3 — v0.5.1), maquette validée
// design/maquette-systeme-v3.html : LA carte du moteur, même grammaire
// que la carte application (system-section.tsx). Ce qui change par
// rapport à la v0.4.1 : plus de lignes techniques en tableau (version
// installée / dernière release / dernier contact / liaison) — la version
// ne vit plus que dans le fil, en une phrase ; l'historique (ex carnet
// de bord) devient un repli de LA carte ; le « filet de sécurité » et
// la « liste des changements » ne sont plus des panneaux, ils sont des
// moments du fil ; le repli « autre poste » reste un lien discret qui
// ouvre l'étape guidée.
//
// v0.5.1 (revue) : la mécanique du fil vient de fil-live.tsx (partagée
// avec la carte application — plus de duplication). Quatre correctifs :
// (1) le battement lastSeen/onAny est RETIRÉ — il re-rendait la carte à
// chaque événement socket pour une valeur qui n'était plus affichée ;
// (2) garde de fraîcheur 10 min au montage : un verdict d'hier ne
// ressuscite plus le fil « Terminé » (même garde que la carte
// application, sauf opération en cours connue du service) ;
// (3) le bouton « Revérifier » est de nouveau présent quand Hermes
// n'est pas détecté (le fil y renvoie — régression v0.5.0) ;
// (4) les liens du fil sont de vrais éléments actionnables au clavier
// (des <a href> avec preventDefault, focusables — plus de <a> muets).
//
// Ce que la v3 conserve précieusement du v0.4 : le contrôle des sens,
// la détection « problème depuis la mise à jour » (rouge + retour
// arrière), le message prêt à copier, la fenêtre de confirmation 3
// promesses, et la SURCOUCHE — mise à jour et retour utilisent les
// commandes officielles de Hermes. L'interface demande, raconte et
// vérifie — Hermes agit.
//
// NB : l'étape guidée « autre poste » affiche adresse + code d'accès
// mais ne câble pas encore l'action de liaison (aucun envoi sans
// validation — comportement inchangé depuis v0.4.1, le branchement
// gateway:set reste à faire, cf. FORK.md §9).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Pastille } from "@/components/settings/bits";
import { ConfirmDestructiveDialog } from "@/components/shared/confirm-destructive-dialog";
import {
  type FilLigne,
  heureVersMs,
  jalonsHtml,
  parseFil,
  traduireLigneMotor,
  useTick,
  verdictMotor,
} from "@/components/settings/fil-live";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getSocket } from "@/lib/socket";
import type {
  AgentRelease,
  MotorState,
  MotorJournalEntry as JournalWire,
} from "@/lib/chat-types";

export interface AgentMotorCardProps {
  /** État RÉEL de la socket vers le service — la pastille « connecté »
   *  suit ce flux (un seul flux, aucune requête dédiée). */
  connected?: boolean;
  /** Navigation vers la page Stockage (lien « documents générés »). */
  onNavigateStorage?: () => void;
}

const hf = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const df = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const JALONS_MAJ = ["Demande envoyée", "Sauvegarde", "Mise à jour", "Contrôle"];
const JALONS_RETOUR = ["Demande envoyée", "Arrêt", "Retour aux fichiers", "Contrôle"];

export function AgentMotorCard({ connected = true, onNavigateStorage }: AgentMotorCardProps) {
  const { toast } = useToast();
  const [state, setState] = useState<MotorState | null>(null);
  const [journal, setJournal] = useState<JournalWire[]>([]);
  const [log, setLog] = useState<string | null>(null);
  const [logAt, setLogAt] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Lot audit 2026-11-21 : états pending + chien de garde des demandes
  // (avant : « Revérifier » sans aucun retour, erreurs en window.alert).
  const [checking, setChecking] = useState(false);
  const [requesting, setRequesting] = useState(false);

  /** Applique un snapshot du journal d'opération (toujours réel — appelé
   *  par le relais en direct ou après une demande explicite). */
  const appliqueLog = useCallback((snap: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
    if (!snap?.exists || typeof snap.text !== "string" || !snap.text.trim()) return;
    setLog(snap.text);
    if (typeof snap.mtimeMs === "number" && snap.mtimeMs > 0) setLogAt(snap.mtimeMs);
  }, []);

  useEffect(() => {
    const socket = getSocket();
    socket.emit(
      "agent:motor-state",
      (res: (MotorState & { journal?: JournalWire[] }) | { installed?: string | null; journal?: JournalWire[] } = {}) => {
        const st = res as MotorState;
        setState(st);
        setJournal(res.journal ?? []);
        // Le fil de l'opération au (re)montage : vécu si une opération est
        // EN COURS (le service la connaît en mémoire) ou si le journal est
        // frais (< 10 min) — sinon un verdict d'hier ne doit pas
        // ressusciter « Terminé » (v0.5.1, même garde que la carte
        // application ; l'âge porte sur mtimeMs, horloge du service A-2).
        socket.emit("agent:update-log", (r: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
          if (!r?.exists || typeof r.text !== "string" || !r.text.trim()) return;
          const frais =
            typeof r.mtimeMs === "number" &&
            Date.now() - r.mtimeMs < 10 * 60_000;
          if (st.op || frais) appliqueLog(r);
        });
      }
    );
    const onState = (s: MotorState) => {
      setState(s);
      socket.emit("agent:journal", (r: { journal?: JournalWire[] } = {}) =>
        setJournal(r.journal ?? [])
      );
    };
    // Le relais ne diffuse que sur changement réel (signature service) :
    // toute ligne reçue ici est vivante.
    const onLog = (snap: { text?: string; mtimeMs?: number } = {}) => {
      appliqueLog({ exists: true, ...snap });
    };
    socket.on("agent:motor-changed", onState);
    socket.on("agent:update-log:changed", onLog);
    return () => {
      socket.off("agent:motor-changed", onState);
      socket.off("agent:update-log:changed", onLog);
    };
  }, [appliqueLog]);

  const op = state?.op ?? null;
  const installed = state?.installed ?? null;
  const release: AgentRelease | null = state?.release ?? null;
  const previous = state?.previousVersion ?? null;
  const control = state?.lastControl ?? null;
  // Lot audit : « vérifiée aujourd'hui à … » n'est plus affirmé quelle que
  // soit l'ancienneté — le libellé porte la vraie date si ce n'est pas
  // aujourd'hui (checkedAt est persisté côté service).
  const verifieLabel = useMemo(() => {
    if (!state?.checkedAt) return null;
    const d = new Date(state.checkedAt);
    if (Number.isNaN(d.getTime())) return null;
    const heure = hf.format(d);
    const memeJour = new Date().toDateString() === d.toDateString();
    return memeJour
      ? `vérifiée aujourd'hui à ${heure}`
      : `vérifiée le ${df.format(d)}`;
  }, [state?.checkedAt]);
  /** État moteur reçu au moins une fois — distingue « chargement » de
   *  « Hermes non détecté » (v0.5.1 : le bouton Revérifier suit). */
  const stateConnu = state !== null;

  /** Mise à jour récente (< 24 h) vue par l'interface : distingue « Hermes
   *  n'est pas lancé » (neutre) de « ça a cassé depuis la mise à jour »
   *  (rouge + retour arrière) — le carnet fait foi. */
  const majRecente = journal.some(
    (e) =>
      e.type === "maj" &&
      e.resultat !== "echec" &&
      Date.now() - new Date(e.at).getTime() < 24 * 3600_000
  );
  const pbDetecte =
    !!control && !control.ok && !!control.versionLue && majRecente && !op;

  // ── Pastille (liaison coupée > opération > problème > dispo > état) ──
  const tone: "ok" | "warn" | "err" | "off" | "busy" =
    !connected
      ? "off"
      : op
        ? "busy"
        : pbDetecte
          ? "err"
          : release
            ? "warn"
            : installed
              ? "ok"
              : "off";
  const etatLabel =
    !connected
      ? "Reconnexion en cours"
      : op?.kind === "update"
        ? "Mise à jour en cours…"
        : op?.kind === "rollback"
          ? "Retour en cours…"
          : pbDetecte
            ? "Hermes ne répond plus"
            : release
              ? "Mise à jour disponible"
              : installed
                ? "À jour"
                : "Hermes non détecté";

  /** Lot audit : chien de garde générique — une demande jamais acquittée
   *  toast au bout de 8 s au lieu de laisser l'utilisateur sans réponse. */
  const demander = useCallback(
    (
      event: string,
      payload: Record<string, unknown> | undefined,
      onRes: (res: { ok?: boolean; error?: string } | null) => void
    ) => {
      const garde = window.setTimeout(() => onRes(null), 8_000);
      getSocket().emit(event, payload, (res: { ok?: boolean; error?: string } = {}) => {
        window.clearTimeout(garde);
        onRes(res ?? {});
      });
    },
    []
  );

  const requestUpdate = () => {
    if (requesting) return;
    setRequesting(true);
    demander("agent:update-request", undefined, (res) => {
      setRequesting(false);
      if (res === null) {
        toast({ title: "Demande non transmise", description: "Le service n'a pas répondu (8 s).", variant: "destructive" });
      } else if (!res.ok && res.error) {
        // window.alert remplacé par le système de toasts (cohérence volet).
        toast({ title: "Mise à jour impossible", description: res.error, variant: "destructive" });
      }
      // L'opération vient d'être demandée : son journal est vivant.
      getSocket().emit("agent:update-log", (r: { exists?: boolean; text?: string; mtimeMs?: number } = {}) =>
        appliqueLog(r)
      );
    });
  };
  const requestRollback = () => {
    setConfirmOpen(false);
    if (requesting) return;
    setRequesting(true);
    demander("agent:rollback-request", undefined, (res) => {
      setRequesting(false);
      if (res === null) {
        toast({ title: "Demande non transmise", description: "Le service n'a pas répondu (8 s).", variant: "destructive" });
      } else if (!res.ok && res.error) {
        toast({ title: "Retour arrière impossible", description: res.error, variant: "destructive" });
      }
      getSocket().emit("agent:update-log", (r: { exists?: boolean; text?: string; mtimeMs?: number } = {}) =>
        appliqueLog(r)
      );
    });
  };
  const requestCheck = () => {
    if (checking) return;
    setChecking(true);
    demander("agent:check-request", undefined, (res) => {
      setChecking(false);
      if (res === null) {
        toast({ title: "Vérification impossible", description: "Le service n'a pas répondu (8 s).", variant: "destructive" });
      } else if (res.ok) {
        toast({ title: "Vérification lancée", duration: 2500 });
      } else if (res.error) {
        toast({ title: "Vérification impossible", description: res.error, variant: "destructive" });
      }
    });
  };

  /** Message à transmettre (copier-coller) si le contrôle échoue. */
  const messageATransmettre = pbDetecte
    ? [
        "Message préparé pour la personne qui adapte l'interface :",
        `— moteur Hermes : ${control?.versionLue ?? "?"} (mise à jour récente vue par l'interface)`,
        `— liaison gateway : ${control?.liaison === "ok" ? "fonctionne" : "en échec"}`,
        `— liste des modèles : ${control?.modeles === "ok" ? "fonctionne" : "en échec"}`,
        `— détail : ${control?.detail ?? "-"}`,
        previous ? `— retour arrière vers ${previous} : disponible` : "-",
      ].join("\n")
    : "";
  const copierMessage = async () => {
    try {
      await navigator.clipboard.writeText(messageATransmettre);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Lot audit : échec de copie = retour visible, plus un clic mort.
      setCopied(false);
      toast({
        title: "Copie impossible",
        description: "Sélectionnez le texte du message et copiez-le à la main.",
        variant: "destructive",
      });
    }
  };

  // ── Fil de l'opération en cours ─────────────────────────────────────
  const verdict = log !== null ? verdictMotor(log) : null;
  const fil = useMemo(() => (log !== null ? parseFil(log, traduireLigneMotor) : []), [log]);
  const jalonCourant = useMemo(() => {
    if (verdict === "ok") return -1;
    let max = 0;
    for (const l of fil) if (l.jalon > max) max = l.jalon;
    return max;
  }, [fil, verdict]);

  const tick = useTick(!!op);
  const ageLigne = (l: FilLigne): string | null => {
    if (!l.heure) return null;
    const age = Math.max(1, Math.round((tick - heureVersMs(l.heure)) / 1000));
    // Lot audit : format FR — plus de « il y a 600 s » au bout d'une minute.
    if (age < 60) return `il y a ${age} s`;
    return `il y a ${Math.floor(age / 60)} min`;
  };

  // Notes de version : les 3 premières entrées (aperçu borné maquette),
  // tout le reste au repli — jamais un mur.
  const notesToutes = (release?.notes ?? "")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const notesApercu = notesToutes.slice(0, 3);
  const notesReste = notesToutes.length - notesApercu.length;

  return (
    <>
      {/* ══ CARTE 2 — HERMES ═══════════════════════════════════════════ */}
      <section
        aria-labelledby="t-motor"
        className="rounded-xl border border-border bg-card px-4 py-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3.5 gap-y-2 max-[560px]:flex-col max-[560px]:items-stretch">
          <div className="min-w-[200px] flex-1">
            <h2 id="t-motor" className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
              Hermes <Pastille tone={tone} label={etatLabel} />
            </h2>

            {/* LE fil : une phrase par état — la version ne vit qu'ici. */}
            <p className="fil mt-1 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
              {!connected ? (
                <>Le programme Hermes n&apos;est plus joignable. Rien n&apos;est perdu — la reconnexion est automatique.</>
              ) : op?.kind === "update" ? (
                <>Hermes s&apos;occupe de sa propre mise à jour — le déroulé vit ci-dessous, rien à faire.</>
              ) : op?.kind === "rollback" ? (
                <>Retour vers la version d&apos;avant — procédure officielle de Hermes, déroulé ci-dessous.</>
              ) : pbDetecte ? (
                <>
                  Depuis la mise à jour, l&apos;application n&apos;arrive plus à joindre Hermes.
                  <b>Vos conversations et vos documents sont intacts.</b>
                </>
              ) : release ? (
                <>
                  Hermes <b>{release.tag}</b> est disponible (vous avez la <b>{installed ?? "version actuelle"}</b>).
                  La version actuelle est mise de côté avant tout changement&nbsp;: le retour
                  arrière restera possible.
                </>
              ) : installed ? (
                <>
                  Version <b>{installed}</b>{verifieLabel ? `, ${verifieLabel}` : ""}.
                  {previous ? (
                    <>
                      {" "}La version d&apos;avant (<b>{previous}</b>) reste en réserve&nbsp;:{" "}
                      <Button
                        type="button"
                        variant="link"
                        onClick={() => setConfirmOpen(true)}
                        className="h-auto px-0 py-0 font-semibold text-hermes-text underline-offset-2 hover:underline"
                      >
                        revenir en arrière
                      </Button> si besoin.
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  Hermes n&apos;est pas encore installé dans le dossier de l&apos;application —
                  relancez l&apos;interface : sa copie s&apos;installera toute seule (réseau requis
                  une fois), puis «&nbsp;Revérifier&nbsp;». Ou <Button
                    type="button"
                    variant="link"
                    onClick={() => setAdvOpen(true)}
                    className="h-auto px-0 py-0 font-semibold text-hermes-text underline-offset-2 hover:underline"
                  >il est installé sur un autre poste</Button>.
                </>
              )}
            </p>
          </div>

          {/* Lot audit : classe Tailwind corrompue réparée (voir system-section). */}
          <div className="flex flex-none flex-wrap items-center gap-2 max-[560px]:min-w-[130px] max-[560px]:flex-1 max-[560px]:text-center">
            {pbDetecte && previous ? (
              <Button
                type="button"
                variant="primary"
                onClick={() => setConfirmOpen(true)}
                className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Revenir à la version d&apos;avant
              </Button>
            ) : release && !op ? (
              <Button
                type="button"
                variant="primary"
                onClick={requestUpdate}
                disabled={requesting}
                className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {requesting ? "Demande…" : "Mettre Hermes à jour"}
              </Button>
            ) : null}
            {/* v0.5.1 : « Revérifier » de retour quand Hermes n'est pas
                détecté (le fil y renvoie) — régression v0.5.0.
                Lot audit : état pending + retour visible. */}
            {pbDetecte || (!op && (installed || !connected || (stateConnu && !installed))) ? (
              <Button
                type="button"
                variant="outline"
                onClick={requestCheck}
                disabled={!!op || checking}
                className="h-8 cursor-pointer rounded-lg border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text disabled:cursor-wait disabled:opacity-40"
              >
                {checking ? "Vérification…" : "Revérifier"}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Aperçu des changements (état disponible) : 3 lignes + repli +
            marqueur « touche l'interface ». Arbitrage v3 : cet aperçu
            n'existe que pour Hermes — l'application n'a pas de notes de
            version publiées (elle se compare en révisions brutes). */}
        {release && !op ? (
          <div className="mt-3">
            {release.touchesInterface ? (
              <p
                className="mb-2 flex items-start gap-1.5 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-[12px] font-medium text-warning"
                role="alert"
              >
                <span aria-hidden>⚠</span>
                <span>Cette version touche la liaison avec l&apos;application — un contrôle automatique suivra la mise à jour.</span>
              </p>
            ) : null}
            {notesApercu.length > 0 ? (
              <div className="max-h-[132px] overflow-hidden rounded-lg border border-border px-3 py-2.5 text-[12px] text-muted-foreground">
                <p className="mb-1.5 text-[12.5px] font-semibold text-foreground">
                  Ce qui change dans {release.name ?? release.tag}
                </p>
                {notesApercu.map((l, i) => (
                  <p key={i} className="mb-1 truncate">· {l}</p>
                ))}
                {notesReste > 0 || release.url ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-3">
                    {notesReste > 0 ? (
                      <Button
                        type="button"
                        variant="link"
                        onClick={() => setNotesOpen((v) => !v)}
                        className="h-auto px-0 py-0 text-[12px] font-semibold text-hermes-text hover:underline"
                      >
                        {notesOpen ? "Réduire la liste" : `Toute la liste (+${notesReste})`}
                      </Button>
                    ) : null}
                    {release.url ? (
                      <a
                        href={release.url}
                        target="_blank"
                        rel="noreferrer"
                        className="h-auto px-0 py-0 text-[12px] font-semibold text-hermes-text hover:underline"
                      >
                        Voir sur GitHub →
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {notesOpen ? (
                  <div className="mt-1.5 max-h-40 overflow-y-auto border-t border-border pt-1.5">
                    {notesToutes.slice(3).map((l, i) => (
                      <p key={i} className="mb-1 truncate">· {l}</p>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-[11.5px] text-muted-foreground">(pas de liste publiée)</p>
            )}
          </div>
        ) : null}

        {/* Scénario problème : deux façons de s'en sortir (maquette) —
            retour arrière d'abord (procédure officielle), message prêt
            à copier ensuite. */}
        {pbDetecte && !op ? (
          <div className="mt-3 rounded-lg border border-border px-3.5 py-3">
            <p className="text-[13px] font-bold">Deux façons de s&apos;en sortir</p>
            <p className="mt-0.5 mb-2 text-[12px] leading-relaxed text-muted-foreground">
              La plus simple d&apos;abord — le retour arrière utilise la procédure
              officielle de Hermes et ne touche à rien d&apos;autre.
            </p>
            {!previous ? (
              <p className="text-[12px] text-muted-foreground">
                (La version d&apos;avant n&apos;est plus en réserve — «&nbsp;Revérifier&nbsp;»
                pour retenter la liaison.)
              </p>
            ) : null}
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Si vous préférez décrire le problème à la personne qui maintient
              l&apos;application&nbsp;:{" "}
              <Button
                type="button"
                variant="link"
                onClick={() => setDiagOpen((v) => !v)}
                className="h-auto cursor-pointer px-0 py-0 font-semibold text-hermes-text hover:underline"
              >
                préparer un message prêt à copier
              </Button>.
            </p>
            {diagOpen ? (
              <div className="mt-2">
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {messageATransmettre}
                </pre>
                <Button
                  type="button"
                  variant="link"
                  onClick={copierMessage}
                  className="mt-1.5 inline-flex h-auto cursor-pointer items-center gap-1.5 px-0 py-0 text-[11.5px] font-semibold text-hermes-text hover:underline"
                >
                  {copied ? <Check className="size-[13px]" strokeWidth={2.5} /> : <Copy className="size-[13px]" strokeWidth={2.5} />}
                  {copied ? "Copié" : "Copier le message"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Opération en cours (ou verdict frais) : le fil live. */}
        {(op || (log !== null && verdict !== null)) && log !== null ? (
          <div className="mt-3 overflow-hidden rounded-[10px] border border-border">
            {op ? (
              <div className="flex flex-wrap items-center gap-2.5 px-3.5 pb-0.5 pt-2.5">
                {jalonsHtml(op.kind === "update" ? JALONS_MAJ : JALONS_RETOUR, jalonCourant)}
              </div>
            ) : null}
            <div className="mt-2 border-t border-border bg-background px-3.5 pb-3 pt-2.5">
              <div className="flex flex-col gap-1">
                {fil.slice(-6).map((l, i, arr) => (
                  <p
                    key={i}
                    className={
                      "flex items-baseline gap-2.5 text-[12.5px] " +
                      (l.classe === "cur" || (l.classe === "" && i === arr.length - 1 && op)
                        ? "text-foreground before:inline-block before:size-[6px] before:flex-none before:rounded-full before:bg-hermes before:align-[1px] before:animate-pulse before:content-['']"
                        : l.classe === "ok"
                          ? "text-foreground before:mr-0 before:font-bold before:text-success before:content-['✓']"
                          : l.classe === "ko"
                            ? "text-foreground before:mr-0 before:font-bold before:text-destructive before:content-['✕']"
                            : "text-muted-foreground")
                    }
                  >
                    {l.heure ? (
                      <span className="flex-none font-mono text-[10.5px] tabular-nums text-muted-foreground opacity-80">
                        {l.heure}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1">{l.texte}</span>
                    {op && i === arr.length - 1 && l.heure ? (
                      <span className="flex-none text-[11px] text-muted-foreground">{ageLigne(l)}</span>
                    ) : null}
                  </p>
                ))}
              </div>
              {!op && verdict === "ok" ? (
                <p className="mt-2 text-[11.5px] text-muted-foreground">
                  Terminé — l&apos;historique ci-dessous garde la trace complète.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Le repli « autre poste » : lien discret, étape guidée (v3 —
            plus de formulaire fantôme : rien n'est envoyé sans validation). */}
        {!op && !pbDetecte ? (
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAdvOpen((v) => !v)}
              aria-expanded={advOpen}
              className="mt-2 inline-flex cursor-pointer items-center gap-1.5 py-1 text-[12px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={"size-[11px] transition-transform " + (advOpen ? "rotate-180" : "")}
                strokeWidth={3}
              />
              Hermes est installé sur un autre poste
            </Button>
            {advOpen ? (
              <div className="mt-1.5 rounded-[10px] border border-dashed border-border px-4 py-3.5">
                <p className="text-[13px] font-bold">Le relier à cette application</p>
                <p className="mb-3 mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                  Si Hermes tourne sur un autre ordinateur que celui-ci, indiquez
                  ici son adresse et son code d&apos;accès. Rien ne change avant que
                  vous validiez.
                </p>
                <label className="mt-2.5 block">
                  <span className="mb-1 block text-[11.5px] font-semibold text-muted-foreground">Adresse du moteur</span>
                  <Input
                    type="text"
                    placeholder="https://adresse-du-poste"
                    className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus-visible:border-hermes/60"
                  />
                </label>
                <label className="mt-2.5 block">
                  <span className="mb-1 block text-[11.5px] font-semibold text-muted-foreground">Code d&apos;accès</span>
                  <Input
                    type="password"
                    placeholder="••••••••"
                    className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus-visible:border-hermes/60"
                  />
                </label>
              </div>
            ) : null}
          </>
        ) : null}

        {/* Historique (ex carnet de bord) : repli de LA carte — plus de
            carte séparée, plus de redite. <details> natif : l'état ouvert
            vit dans le DOM, pas dans React. */}
        <details className="mt-2 group">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 py-1 text-[12px] font-semibold text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-[11px] transition-transform group-open:rotate-180" strokeWidth={3} />
            Historique · {journal.length} étape{journal.length > 1 ? "s" : ""}
          </summary>
          <div className="mt-1.5 rounded-[10px] border border-dashed border-border px-4 py-2">
            {journal.length === 0 ? (
              <p className="py-1 text-[12.5px] text-muted-foreground">
                Rien pour l&apos;instant — l&apos;historique se remplit à la première vérification.
              </p>
            ) : (
              <>
                {journal.slice(0, 8).map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-3.5 gap-y-0.5 border-b border-border py-1.5 last:border-b-0"
                  >
                    <span className="flex-none font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {df.format(new Date(e.at))}
                    </span>
                    <span className="min-w-0 flex-1 text-[12.5px]">
                      {e.label}
                      {e.version ? <b className="ml-1.5 font-mono text-[11px] tabular-nums">v{e.version}</b> : null}
                    </span>
                    <span
                      className={
                        "flex-none text-[11px] font-semibold " +
                        (e.resultat === "ok" ? "text-success" : e.resultat === "echec" ? "text-destructive" : "text-muted-foreground")
                      }
                    >
                      {e.resultat === "ok" ? "✓" : e.resultat === "echec" ? "✕" : "·"}
                    </span>
                  </div>
                ))}
                {/* Lot audit : l'en-tête annonçait N étapes mais n'en montrait
                    que 8 — le compte est maintenant honnête. */}
                {journal.length > 8 ? (
                  <p className="pt-1.5 text-[11px] text-muted-foreground">
                    Les 8 plus récentes sont affichées sur {journal.length}.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </details>

        {/* Lien documents générés : un lien du fil, pas un bouton en pied
            de carte (v3 : les détails sont des liens, pas des panneaux). */}
        {onNavigateStorage && installed ? (
          <Button
            type="button"
            variant="link"
            onClick={onNavigateStorage}
            className="mt-1 h-auto px-0 py-0 text-[12px] font-semibold text-hermes-text hover:underline"
          >
            Documents générés par Hermes →
          </Button>
        ) : null}
      </section>

      {/* Fenêtre de confirmation du retour arrière (3 promesses, v0.4).
          Lot audit : le dialog Radix du repo (ConfirmDestructiveDialog)
          remplace la modal maison — piège de focus réel, Escape, focus
          rendu à la fermeture (l'ancienne div role="dialog" laissait Tab
          atteindre la carte sous-jacente). */}
      <ConfirmDestructiveDialog
        open={confirmOpen && !!previous}
        onOpenChange={setConfirmOpen}
        title={`Revenir à Hermes ${previous ?? ""} ?`}
        description={
          <span className="block space-y-2">
            <span className="block">
              Hermes revient à la version <b>{previous}</b>, celle d&apos;avant la mise à jour. Le problème disparaît.
            </span>
            <span className="block">
              Vos fichiers, vos conversations et vos réglages <b>ne sont pas touchés</b>.
            </span>
            <span className="block">
              L&apos;interface se re-teste toute seule à la fin (jusqu&apos;à 2&nbsp;minutes). Vous pourrez re-tenter la mise à jour plus tard.
            </span>
          </span>
        }
        confirmLabel={previous ? `Oui, revenir à Hermes ${previous}` : "Confirmer"}
        onConfirm={requestRollback}
      />
    </>
  );
}
