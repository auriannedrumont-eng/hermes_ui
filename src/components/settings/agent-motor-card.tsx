"use client";

// Carte « Hermes » (v3 — v0.5.0), maquette validée
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
// Ce que la v3 conserve précieusement du v0.4 : le contrôle des sens,
// la détection « problème depuis la mise à jour » (rouge + retour
// arrière), le message prêt à copier, la fenêtre de confirmation 3
// promesses, et la SURCOUCHE — mise à jour et retour utilisent les
// commandes officielles de Hermes. L'interface demande, raconte et
// vérifie — Hermes agit.
//
// Types du fil : référentiel partagé front ↔ back (B-4) via
// shared/chat-protocol.ts, réexporté par src/lib/chat-types.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Pastille } from "@/components/settings/bits";
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

/** Verdict du journal d'opération : dernière ligne QUI PORTE un marqueur
 *  terminal (A-1) — robuste même si une ligne suit le verdict. */
function logVerdict(text: string): null | "ok" | "erreur" {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/RETOUR ERREUR|MOTEUR MAJ ERREUR/.test(lines[i])) return "erreur";
    if (/RETOUR OK|RETOUR EFFECTUÉ|MOTEUR MAJ OK|CONTRÔLE OK/.test(lines[i])) return "ok";
  }
  return null;
}

// ── Fil de l'opération moteur : journal → phrases humaines ────────────────
// Mêmes idiomes que la carte application (une grammaire unique) : jalon
// courant dérivé des lignes, âge vivant, verdict à marqueur.

interface FilLigne {
  heure: string | null;
  texte: string;
  /** 0 demande · 1 sauvegarde · 2 mise à jour · 3 contrôle (-1 = info). */
  jalon: number;
  classe: "cur" | "ok" | "ko" | "";
}

/** Traduction d'une ligne du journal moteur (phrases réelles de
 *  agent-motor.ts, vérifiées au moment de la v3). */
function traduireLigne(brute: string): FilLigne {
  const m = brute.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
  const heure = m?.[1] ?? null;
  const texte = m?.[2] ?? brute;
  const t = texte.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  if (texte.includes("MOTEUR MAJ OK")) {
    return { heure, texte: "Hermes a installé la nouvelle version — contrôle de la liaison en cours (jusqu'à 2 minutes)…", jalon: 3, classe: "" };
  }
  if (texte.includes("MOTEUR MAJ ERREUR")) {
    return { heure, texte: "La mise à jour de Hermes n'a pas abouti. Rien n'a changé — la version installée continue de tourner.", jalon: -1, classe: "ko" };
  }
  if (/RETOUR OK|RETOUR EFFECTU/.test(texte)) {
    return { heure, texte: "Le retour arrière est terminé — Hermes est revenu à la version d'avant.", jalon: 3, classe: "ok" };
  }
  if (texte.includes("RETOUR ERREUR")) {
    return { heure, texte: "Le retour arrière n'a pas abouti — rien n'a été cassé, l'état actuel est conservé.", jalon: -1, classe: "ko" };
  }
  if (texte.includes("CONTRÔLE OK")) {
    return { heure, texte: "Contrôle réussi — l'application parle bien à Hermes.", jalon: 3, classe: "ok" };
  }
  if (texte.includes("CONTRÔLE ÉCHOUÉ") || t.includes("controle echoue")) {
    return { heure, texte: "Le contrôle a échoué — un retour arrière est proposé dans la carte.", jalon: 3, classe: "ko" };
  }
  if (t.includes("mise a jour du moteur hermes demandee")) {
    return { heure, texte: "Mise à jour demandée — la version actuelle est d'abord mise de côté (sauvegarde complète).", jalon: 0, classe: "" };
  }
  if (t.includes("retour arriere demande")) {
    return { heure, texte: "Retour arrière demandé — procédure officielle de Hermes, étape par étape.", jalon: 0, classe: "" };
  }
  if (t.includes("etape 1/3")) {
    return { heure, texte: "Arrêt en douceur de Hermes (ses travaux sont sauvegardés)…", jalon: 1, classe: "" };
  }
  if (t.includes("etape 2/3")) {
    return { heure, texte: "Retour aux fichiers de la version précédente…", jalon: 2, classe: "" };
  }
  if (t.includes("etape 3/3")) {
    return { heure, texte: "Relancez Hermes comme d'habitude — le contrôle suivra tout seul (jusqu'à 2 minutes).", jalon: 3, classe: "" };
  }
  if (t.startsWith("$ ")) {
    // Ligne de commande : le détail technique, discret mais présent.
    return { heure, texte, jalon: -1, classe: "" };
  }
  if (t.includes("commande introuvable") || t.includes("arrete :")) {
    return { heure, texte, jalon: -1, classe: "ko" };
  }
  return { heure, texte, jalon: -1, classe: "" };
}

function parseJournal(text: string): FilLigne[] {
  const lignes = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(traduireLigne);
  let max = -1;
  return lignes.map((l) => {
    if (l.jalon > max) max = l.jalon;
    return { ...l, jalon: l.jalon >= 0 ? max : l.jalon };
  });
}

function useTick(actif: boolean): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!actif) return;
    const id = setInterval(() => setN((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [actif]);
  return Date.now();
}

function heureVersMs(heure: string): number {
  const [h, m, s] = heure.split(":").map(Number);
  const now = new Date();
  const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();
  if (ts > now.getTime() + 30_000) return ts - 86_400_000;
  return ts;
}

export function AgentMotorCard({ connected = true, onNavigateStorage }: AgentMotorCardProps) {
  const [state, setState] = useState<MotorState | null>(null);
  const [journal, setJournal] = useState<JournalWire[]>([]);
  const [log, setLog] = useState<string | null>(null);
  const [logAt, setLogAt] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Dernier événement socket reçu (battement de vie — la pastille en
   *  dérive sa fraîcheur ; v3 : plus affiché en ligne dédiée). */
  const [lastSeen, setLastSeen] = useState<number>(Date.now());

  // Liaison : battement de tout événement socket — garde la pastille et le
  // fil « Reconnexion en cours » pilotés par le prop `connected` du panneau
  // (le battement existe côté hook global ; ici la pastille suit le flux).
  useEffect(() => {
    const onAny = () => setLastSeen(Date.now());
    const socket = getSocket();
    socket.onAny(onAny);
    return () => {
      socket.offAny(onAny);
    };
  }, []);

  const fetchLog = useCallback(() => {
    getSocket().emit(
      "agent:update-log",
      (res: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
        if (!res?.exists || typeof res.text !== "string" || !res.text.trim()) return;
        setLog(res.text);
        if (typeof res.mtimeMs === "number") setLogAt(res.mtimeMs);
      }
    );
  }, []);

  useEffect(() => {
    const socket = getSocket();
    socket.emit(
      "agent:motor-state",
      (res: { installed?: string | null; journal?: JournalWire[] } = {}) => {
        setState(res as MotorState);
        setJournal(res.journal ?? []);
      }
    );
    fetchLog();
    const onState = (s: MotorState) => {
      setState(s);
      socket.emit("agent:journal", (r: { journal?: JournalWire[] } = {}) =>
        setJournal(r.journal ?? [])
      );
    };
    const onLog = (snap: { text?: string; mtimeMs?: number } = {}) => {
      if (typeof snap?.text !== "string") return;
      setLog(snap.text);
      if (typeof snap.mtimeMs === "number") setLogAt(snap.mtimeMs);
    };
    socket.on("agent:motor-changed", onState);
    socket.on("agent:update-log:changed", onLog);
    return () => {
      socket.off("agent:motor-changed", onState);
      socket.off("agent:update-log:changed", onLog);
    };
  }, [fetchLog]);

  useEffect(() => {
    if (!confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmOpen]);

  const op = state?.op ?? null;
  const installed = state?.installed ?? null;
  const release: AgentRelease | null = state?.release ?? null;
  const previous = state?.previousVersion ?? null;
  const control = state?.lastControl ?? null;
  const checkedAt = state?.checkedAt ? hf.format(new Date(state.checkedAt)) : null;

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

  const requestUpdate = () => {
    getSocket().emit(
      "agent:update-request",
      (res: { ok?: boolean; error?: string } = {}) => {
        if (!res?.ok && res?.error) window.alert(res.error);
        fetchLog();
      }
    );
  };
  const requestRollback = () => {
    setConfirmOpen(false);
    getSocket().emit(
      "agent:rollback-request",
      (res: { ok?: boolean; error?: string } = {}) => {
        if (!res?.ok && res?.error) window.alert(res.error);
        fetchLog();
      }
    );
  };
  const requestCheck = () => {
    getSocket().emit("agent:check-request", () => {});
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
      /* presse-papier indisponible : le texte reste sélectionnable */
    }
  };

  // ── Fil de l'opération en cours ─────────────────────────────────────
  const verdict = log !== null ? logVerdict(log) : null;
  const fil = useMemo(() => (log !== null ? parseJournal(log) : []), [log]);
  const JALONS_MAJ = ["Demande envoyée", "Sauvegarde", "Mise à jour", "Contrôle"];
  const JALONS_RETOUR = ["Demande envoyée", "Arrêt", "Retour aux fichiers", "Contrôle"];
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
    return `il y a ${age} s`;
  };

  const jalonsHtml = (labels: string[], cur: number) => {
    const elts: React.ReactNode[] = [];
    labels.forEach((label, i) => {
      const done = cur === -1 || i < cur;
      const now = i === cur;
      if (i > 0) {
        elts.push(
          <span
            key={`sep-${i}`}
            aria-hidden
            className={"h-0.5 flex-none rounded " + (done ? "w-[22px] bg-success" : "w-[22px] bg-border")}
          />
        );
      }
      elts.push(
        <span
          key={`jalon-${i}`}
          className={
            "inline-flex items-center gap-1.5 text-[11.5px] font-semibold " +
            (done ? "text-foreground" : now ? "text-hermes-text" : "text-muted-foreground")
          }
        >
          <i
            aria-hidden
            className={
              "grid size-[17px] flex-none place-items-center rounded-full border-2 text-[9px] font-bold text-white " +
              (done ? "border-success bg-success" : now ? "animate-pulse border-hermes" : "border-border")
            }
          >
            {done ? "✓" : ""}
          </i>
          {label}
        </span>
      );
    });
    return elts;
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

            {/* LE fil : une phrase par état — la version n vit qu'ici. */}
            <p className="fil mt-1 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground [&_a]:font-semibold [&_a]:text-hermes-text [&_a]:cursor-pointer [&_b]:font-semibold [&_b]:text-foreground">
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
                  Version <b>{installed}</b>{checkedAt ? `, vérifiée aujourd'hui à ${checkedAt}` : ""}.
                  {previous ? (
                    <>
                      {" "}La version d&apos;avant (<b>{previous}</b>) reste en réserve&nbsp;:{" "}
                      <a onClick={() => setConfirmOpen(true)}>revenir en arrière</a> si besoin.
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  Hermes n&apos;est pas détecté sur ce poste. Lancez-le puis «&nbsp;Revérifier&nbsp;» —
                  ou <a onClick={() => setAdvOpen(true)}>il est installé sur un autre poste</a>.
                </>
              )}
            </p>
          </div>

          <div className="flex flex-none flex-wrap items-center gap-2 max-[560px]:stretch max-[560px]:*:
            max-[560px]:min-w-[130px] max-[560px]:flex-1 max-[560px]:text-center">
            {pbDetecte && previous ? (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Revenir à la version d&apos;avant
              </button>
            ) : release && !op ? (
              <button
                type="button"
                onClick={requestUpdate}
                className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Mettre Hermes à jour
              </button>
            ) : null}
            {pbDetecte || (!op && (installed || !connected)) ? (
              <button
                type="button"
                onClick={requestCheck}
                disabled={!!op}
                className="h-8 cursor-pointer rounded-lg border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                Revérifier
              </button>
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
                      <button
                        type="button"
                        onClick={() => setNotesOpen((v) => !v)}
                        className="text-[12px] font-semibold text-hermes-text hover:underline"
                      >
                        {notesOpen ? "Réduire la liste" : `Toute la liste (+${notesReste})`}
                      </button>
                    ) : null}
                    {release.url ? (
                      <a
                        href={release.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[12px] font-semibold text-hermes-text hover:underline"
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
              <a onClick={() => setDiagOpen((v) => !v)} className="cursor-pointer font-semibold text-hermes-text">
                préparer un message prêt à copier
              </a>.
            </p>
            {diagOpen ? (
              <div className="mt-2">
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {messageATransmettre}
                </pre>
                <button
                  type="button"
                  onClick={copierMessage}
                  className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] font-semibold text-hermes-text hover:underline"
                >
                  {copied ? <Check className="size-[13px]" strokeWidth={2.5} /> : <Copy className="size-[13px]" strokeWidth={2.5} />}
                  {copied ? "Copié" : "Copier le message"}
                </button>
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
            <button
              type="button"
              onClick={() => setAdvOpen((v) => !v)}
              aria-expanded={advOpen}
              className="mt-2 inline-flex cursor-pointer items-center gap-1.5 py-1 text-[12px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={"size-[11px] transition-transform " + (advOpen ? "rotate-180" : "")}
                strokeWidth={3}
              />
              Hermes est installé sur un autre poste
            </button>
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
                  <input
                    type="text"
                    placeholder="http://127.0.0.1:8765"
                    className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus-visible:border-hermes/60"
                  />
                </label>
                <label className="mt-2.5 block">
                  <span className="mb-1 block text-[11.5px] font-semibold text-muted-foreground">Code d&apos;accès</span>
                  <input
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
              journal.slice(0, 8).map((e) => (
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
              ))
            )}
          </div>
        </details>

        {/* Lien documents générés : un lien du fil, pas un bouton en pied
            de carte (v3 : les détails sont des liens, pas des panneaux). */}
        {onNavigateStorage && installed ? (
          <button
            type="button"
            onClick={onNavigateStorage}
            className="mt-1 text-[12px] font-semibold text-hermes-text hover:underline"
          >
            Documents générés par Hermes →
          </button>
        ) : null}
      </section>

      {/* Fenêtre de confirmation du retour arrière (3 promesses, v0.4). */}
      {confirmOpen && previous ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirmer le retour arrière"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmOpen(false);
          }}
        >
          <div className="w-full max-w-[460px] rounded-xl border border-border bg-card p-5 shadow-xl">
            <p className="text-[15.5px] font-bold tracking-tight">
              Revenir à Hermes {previous}&nbsp;?
            </p>
            <ul className="mt-3.5 flex list-none flex-col gap-2.5">
              <li className="flex items-start gap-2.5 text-[12.5px] leading-relaxed">
                <span aria-hidden className="mt-1 inline-block size-[7px] flex-none rounded-full bg-hermes" />
                Hermes revient à la version <b>{previous}</b>, celle d&apos;avant la mise à jour. Le problème disparaît.
              </li>
              <li className="flex items-start gap-2.5 text-[12.5px] leading-relaxed">
                <span aria-hidden className="mt-1 inline-block size-[7px] flex-none rounded-full bg-hermes" />
                Vos fichiers, vos conversations et vos réglages <b>ne sont pas touchés</b>.
              </li>
              <li className="flex items-start gap-2.5 text-[12.5px] leading-relaxed">
                <span aria-hidden className="mt-1 inline-block size-[7px] flex-none rounded-full bg-hermes" />
                L&apos;interface se re-teste toute seule à la fin (jusqu&apos;à 2&nbsp;minutes). Vous pourrez re-tenter la mise à jour plus tard.
              </li>
            </ul>
            <p className="mt-3.5 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
              Le retour utilise la procédure officielle de Hermes. L&apos;interface
              demande et vérifie — Hermes agit.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmOpen(false)}
                className="h-8 cursor-pointer rounded-lg border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={requestRollback}
                className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Oui, revenir à Hermes {previous}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
