"use client";

// Cartes « Moteur Hermes » (v0.4.0) — maquette validée
// download/maquette-systeme-rollback.html : mise à jour du moteur avec
// liste des changements et marqueur « touche l'interface », contrôle
// automatique après la mise à jour (test des sens), filet de sécurité
// (retour arrière vers la version précédente, fenêtre de confirmation),
// carnet de bord (chaque étape notée, prête à transmettre).
//
// SURCOUCHE : la mise à jour et le retour utilisent les commandes
// officielles de Hermes (hermes update --backup ; arrêt gateway + retour
// aux fichiers). L'interface demande, raconte et vérifie — Hermes agit.
// Types du fil en miroir du service (agent-motor.ts) sans l'importer
// (module serveur : node:child_process).

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { Pastille } from "@/components/settings/bits";
import { getSocket } from "@/lib/socket";

interface AgentRelease {
  tag: string;
  name: string | null;
  notes: string;
  url: string | null;
  publishedAt: string | null;
  touchesInterface: boolean;
}
interface MotorControl {
  at: string;
  ok: boolean;
  liaison: "ok" | "echec";
  modeles: "ok" | "echec";
  versionLue: string | null;
  detail: string;
}
interface MotorStateWire {
  installed: string | null;
  release: AgentRelease | null;
  checkedAt: string | null;
  error: string | null;
  op: { kind: "update" | "rollback"; startedAt: string } | null;
  lastControl: MotorControl | null;
  previousVersion: string | null;
  agentDir: string | null;
}
interface JournalWire {
  id: string;
  at: string;
  type: "version" | "maj" | "controle" | "retour";
  label: string;
  version?: string | null;
  resultat: "ok" | "echec" | "info";
  detail?: string;
}

const hf = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const df = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Verdict du journal d'opération (marqueurs terminaux écrits par le service). */
function logVerdict(text: string): null | "ok" | "erreur" {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  if (/RETOUR ERREUR|MOTEUR MAJ ERREUR/.test(last)) return "erreur";
  if (/RETOUR OK|RETOUR EFFECTUÉ|MOTEUR MAJ OK|CONTRÔLE OK/.test(last)) return "ok";
  return null;
}

export function AgentMotorCard() {
  const [state, setState] = useState<MotorStateWire | null>(null);
  const [journal, setJournal] = useState<JournalWire[]>([]);
  const [log, setLog] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const fetchLog = useCallback(() => {
    getSocket().emit(
      "agent:update-log",
      (res: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
        if (!res?.exists || typeof res.text !== "string" || !res.text.trim()) return;
        setLog(res.text);
      }
    );
  }, []);

  useEffect(() => {
    const socket = getSocket();
    socket.emit(
      "agent:motor-state",
      (res: { installed?: string | null; journal?: JournalWire[] } = {}) => {
        setState(res as MotorStateWire);
        setJournal(res.journal ?? []);
      }
    );
    fetchLog();
    const onState = (s: MotorStateWire) => {
      setState(s);
      socket.emit("agent:journal", (r: { journal?: JournalWire[] } = {}) =>
        setJournal(r.journal ?? [])
      );
    };
    const onLog = (snap: { text?: string } = {}) => {
      if (typeof snap?.text === "string") setLog(snap.text);
    };
    socket.on("agent:motor-changed", onState);
    socket.on("agent:update-log:changed", onLog);
    return () => {
      socket.off("agent:motor-changed", onState);
      socket.off("agent:update-log:changed", onLog);
    };
  }, [fetchLog]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

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
  const release = state?.release ?? null;
  const previous = state?.previousVersion ?? null;
  const control = state?.lastControl ?? null;
  const checkedAt = state?.checkedAt ? hf.format(new Date(state.checkedAt)) : null;
  /** Une mise à jour récente (< 24 h) vue par l'interface : sert à distinguer
   *  « l'agent n'est pas lancé » (neutre) de « ça a cassé depuis la mise à
   *  jour » (rouge + retour arrière) — le carnet fait foi. */
  const majRecente = journal.some(
    (e) =>
      e.type === "maj" &&
      e.resultat !== "echec" &&
      Date.now() - new Date(e.at).getTime() < 24 * 3600_000
  );
  const pbDetecte =
    !!control && !control.ok && !!control.versionLue && majRecente && !op;
  const agentAbsent = !!control && !control.ok && !control.versionLue && !op;

  // ── État d'affichage de la carte moteur (maquette : calme → dispo →
  //    en cours → contrôle → ok | problème → retour) ──────────────────────
  const tone: "ok" | "warn" | "err" | "off" | "busy" =
    op
      ? "busy"
      : pbDetecte
        ? "err"
        : release
          ? "warn"
          : installed
            ? "ok"
            : "off";
  const etatLabel =
    op?.kind === "update"
      ? "Mise à jour en cours…"
      : op?.kind === "rollback"
        ? "Retour en cours…"
        : pbDetecte
          ? "Problème détecté"
          : release
            ? "Mise à jour disponible"
            : installed
              ? "À jour"
              : "Moteur non détecté";

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

  // Jalons d'après le journal (op en cours) — mêmes idiomes que la carte
  // Mise à jour de l'application.
  const logLines = (log ?? "").split("\n").filter((l) => l.trim());
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
  const sepJalon = (done: boolean) => (
    <span aria-hidden className={"h-0.5 w-[26px] flex-none rounded " + (done ? "bg-success" : "bg-border")} />
  );
  const majJalons = () => {
    const fin = logVerdict(log ?? "") !== null;
    const controle = logLines.some((l) => /contrôle/i.test(l));
    const relance = logLines.some((l) => /MOTEUR MAJ OK/i.test(l));
    return (
      <>
        {jalon(true, false, "Demande déposée")}
        {sepJalon(true)}
        {jalon(relance, !relance && !fin, "Mise à jour")}
        {sepJalon(relance)}
        {jalon(fin && !!logVerdict(log ?? ""), controle, "Contrôle")}
      </>
    );
  };
  const retourJalons = () => {
    const fin = logVerdict(log ?? "") !== null;
    const fichiers = logLines.some((l) => /étape 2\/3/i.test(l));
    const relance = logLines.some((l) => /étape 3\/3/i.test(l));
    return (
      <>
        {jalon(fichiers, !fichiers, "Arrêt de la gateway")}
        {sepJalon(fichiers)}
        {jalon(relance, fichiers && !relance, "Retour aux fichiers")}
        {sepJalon(relance)}
        {jalon(fin, relance && !fin, "Contrôle")}
      </>
    );
  };

  const badge = (r: JournalWire["resultat"]) =>
    r === "ok"
      ? "bg-success/10 text-success"
      : r === "echec"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  const badgeLabel = (r: JournalWire["resultat"]) =>
    r === "ok" ? "réussi" : r === "echec" ? "en échec" : "noté";

  const notesLines = (release?.notes ?? "")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(0, notesOpen ? 40 : 5);

  return (
    <>
      {/* ── Carte 3 : Moteur Hermes — version, mise à jour, contrôle ──── */}
      <div className="rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
              Moteur Hermes <Pastille tone={tone} label={etatLabel} />
            </div>
            <div className="mt-0.5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
              {op ? (
                op.kind === "update" ? (
                  <>Hermes s&apos;occupe de sa propre mise à jour — le déroulé apparaît ci-dessous, rien à faire.</>
                ) : (
                  <>Retour vers la version {previous ?? "précédente"} — procédure officielle de Hermes, déroulé ci-dessous.</>
                )
              ) : pbDetecte ? (
                <>
                  Depuis la mise à jour, l&apos;interface n&apos;arrive plus à parler au moteur
                  ({control?.detail ?? "liaison en échec"}). Vos documents et conversations
                  sont intacts. Un retour arrière est proposé ci-dessous.
                </>
              ) : release ? (
                <>
                  Une nouvelle version du moteur Hermes est disponible. Voici ce qui
                  change&nbsp;:
                </>
              ) : installed ? (
                <>
                  Le moteur qui travaille pour vous. {checkedAt ? `Dernière vérification à ${checkedAt}.` : ""}
                </>
              ) : (
                <>
                  Le moteur Hermes n&apos;est pas détecté sur ce poste. Installez ou lancez
                  l&apos;agent Hermes, puis «&nbsp;Revérifier&nbsp;».
                </>
              )}
            </div>
          </div>
          <div className="flex flex-none flex-wrap items-center gap-2">
            {release && !op ? (
              <button
                type="button"
                onClick={requestUpdate}
                className="h-8 cursor-pointer rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Mettre Hermes à jour
              </button>
            ) : null}
            {pbDetecte || agentAbsent || (!op && installed) ? (
              <button
                type="button"
                onClick={requestCheck}
                disabled={!!op}
                className="h-8 cursor-pointer rounded-md border border-border bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                Revérifier
              </button>
            ) : null}
          </div>
        </div>

        {/* Lignes : version installée / dernière release */}
        <div className="mt-1 text-[12.5px]">
          <div className="flex items-center justify-between gap-4 border-b border-border py-2">
            <span className="text-muted-foreground">Version installée</span>
            <b className="font-mono text-[11.5px] font-semibold tabular-nums">
              {installed ? `v${installed}` : "—"}
            </b>
          </div>
          {release ? (
            <div className="flex items-center justify-between gap-4 border-b border-border py-2">
              <span className="text-muted-foreground">Dernière version publiée</span>
              <b className="font-mono text-[11.5px] font-semibold tabular-words text-hermes-text">
                v{release.tag}
              </b>
            </div>
          ) : null}
        </div>

        {/* Liste des changements (état « disponible ») + marqueur interface */}
        {release && !op ? (
          <div className="mt-2.5">
            {release.touchesInterface ? (
              <p className="mb-2 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11.5px] font-medium text-warning" role="alert">
                <span aria-hidden>⚠</span>
                <span>
                  Cette mise à jour touche des éléments utilisés par l&apos;interface
                  (liaison, protocole). Un contrôle automatique suivra la mise à jour&nbsp;:
                  si quelque chose casse, le retour arrière sera proposé.
                </span>
              </p>
            ) : null}
            <div className="rounded-md border border-border">
              <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {notesLines.join("\n") || "(pas de liste publiée)"}
              </pre>
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setNotesOpen((v) => !v)}
                className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown className={"size-[12px] transition-transform " + (notesOpen ? "rotate-180" : "")} strokeWidth={2.5} />
                {notesOpen ? "Réduire la liste" : "Toute la liste"}
              </button>
              {release.url ? (
                <a
                  href={release.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] font-semibold text-hermes-text hover:underline"
                >
                  Voir sur GitHub
                </a>
              ) : null}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Pendant la mise à jour, la version actuelle
              {installed ? ` (v${installed})` : ""} est gardée en mémoire&nbsp;: vous pourrez
              revenir en arrière à tout moment.
            </p>
          </div>
        ) : null}

        {/* Problème détecté : retour arrière + message à transmettre */}
        {pbDetecte && !op ? (
          <div className="mt-2.5">
            {previous ? (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="h-8 cursor-pointer rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Revenir à Hermes {previous ? `v${previous}` : ""}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setDiagOpen((v) => !v)}
              className="ml-2 inline-flex cursor-pointer items-center gap-1 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown className={"size-[12px] transition-transform " + (diagOpen ? "rotate-180" : "")} strokeWidth={2.5} />
              Voir le message à transmettre
            </button>
            {diagOpen ? (
              <div className="mt-1.5">
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {messageATransmettre}
                </pre>
                <button
                  type="button"
                  onClick={copierMessage}
                  className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-hermes-text hover:underline"
                >
                  {copied ? <Check className="size-[13px]" strokeWidth={2.5} /> : <Copy className="size-[13px]" strokeWidth={2.5} />}
                  {copied ? "Copié" : "Copier le message"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Opération en cours : jalons + journal en direct */}
        {op && log !== null ? (
          <div className="mt-2.5">
            <div className="flex flex-wrap items-center gap-2.5" role="status">
              {op.kind === "update" ? majJalons() : retourJalons()}
            </div>
            <pre
              ref={logRef}
              aria-label="Journal de l'opération en direct"
              className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
            >
              {log}
            </pre>
          </div>
        ) : null}
        {/* Après opération : journal conservé tant que le verdict est frais */}
        {!op && log !== null && logVerdict(log) !== null ? (
          <div className="mt-2.5">
            <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {log}
            </pre>
          </div>
        ) : null}
      </div>

      {/* ── Carte 4 : Filet de sécurité — retour arrière ───────────────── */}
      <div className="rounded-xl border border-border bg-muted px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
              Filet de sécurité{" "}
              {op ? (
                <Pastille tone="busy" label={op.kind === "update" ? "Sauvegarde en cours…" : "Retour en cours…"} />
              ) : previous ? (
                <Pastille tone="ok" label="prêt" />
              ) : (
                <Pastille tone="off" label="veille" />
              )}
            </div>
            <div className="mt-0.5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
              {op?.kind === "rollback" ? (
                <>Quelques dizaines de secondes. Vos fichiers et vos réglages ne sont pas touchés.</>
              ) : op?.kind === "update" ? (
                <>La version actuelle est en train d&apos;être mise de côté par Hermes (sauvegarde complète avant la mise à jour).</>
              ) : previous ? (
                <>
                  La version <b className="text-foreground">v{previous}</b> est gardée en mémoire. Si la
                  nouvelle version ne convient pas, revenez en arrière en un clic&nbsp;— et
                  re-tentez la mise à jour plus tard si vous voulez.
                </>
              ) : (
                <>
                  À la prochaine mise à jour vue par l&apos;interface, la version précédente
                  sera gardée en mémoire pour permettre un retour arrière.
                </>
              )}
            </div>
          </div>
          {previous && !op ? (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="h-8 flex-none cursor-pointer rounded-md border border-border bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
            >
              Revenir à Hermes v{previous}
            </button>
          ) : null}
        </div>
      </div>

      {/* ── Carte 5 : Carnet de bord ───────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
          Carnet de bord
        </div>
        <p className="mt-0.5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
          L&apos;interface note chaque étape&nbsp;: version repérée, mise à jour, contrôle,
          retour arrière. Le jour où quelque chose casse, l&apos;histoire complète est là,
          prête à transmettre.
        </p>
        <div className="mt-1 text-[12.5px]">
          {journal.length === 0 ? (
            <p className="py-2 text-muted-foreground">Rien pour l&apos;instant — le carnet se remplit à la première vérification.</p>
          ) : (
            journal.slice(0, 8).map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-2 last:border-b-0">
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{df.format(new Date(e.at))}</span>
                <span className="min-w-0 flex-1">
                  {e.label}
                  {e.version ? <b className="ml-1.5 font-mono text-[11px] tabular-nums">v{e.version}</b> : null}
                </span>
                <span className={"rounded-full px-2.5 py-0.5 text-[10.5px] font-bold " + badge(e.resultat)}>
                  {badgeLabel(e.resultat)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Fenêtre de confirmation du retour arrière ─────────────────── */}
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
              Revenir à Hermes v{previous}&nbsp;?
            </p>
            <ul className="mt-3.5 flex list-none flex-col gap-2.5">
              <li className="flex items-start gap-2.5 text-[12.5px] leading-relaxed">
                <span aria-hidden className="mt-1 inline-block size-[7px] flex-none rounded-full bg-hermes" />
                Hermes revient à la version <b>v{previous}</b>, celle d&apos;avant la mise à jour. Le problème disparaît.
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
              Le retour utilise la procédure officielle de Hermes. L&apos;interface demande
              et vérifie — Hermes agit.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmOpen(false)}
                className="h-8 cursor-pointer rounded-md border border-border bg-card px-3 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={requestRollback}
                className="h-8 cursor-pointer rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Oui, revenir à Hermes v{previous}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
