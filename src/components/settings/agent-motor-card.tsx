"use client";

// Carte « Moteur Hermes » (v0.4.1) — maquette validée
// design/maquette-systeme-v2.html : LA carte du moteur, fusion des
// anciennes cartes « Agent Hermes » (v0.3.3 : liaison) et « Moteur
// Hermes » (v0.4.0 : maintenance) — c'est le même programme, un seul
// nom désormais. Porte donc : pastille d'état (connecté / mise à jour
// disponible / problème / opération), lignes de liaison (dernier
// contact, liaison) ET de version, mise à jour avec liste des
// changements et marqueur « touche l'interface », contrôle automatique
// (test des sens), repli « Moteur sur un autre poste », bouton
// « Documents générés → ». Suivent le filet de sécurité (retour
// arrière vers la version précédente, fenêtre de confirmation) et le
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
// Types du fil : référentiel partagé front ↔ back (B-4, audit v3) — fini
// le miroir à la main, la divergence entre les deux versions des interfaces
// sera visible dans UN fichier (shared/chat-protocol.ts).
import type {
  AgentRelease,
  MotorControl,
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

/** Verdict du journal d'opération (marqueurs terminaux écrits par le
 *  service). A-1 (audit v3) : dernière ligne QUI PORTE UN MARQUEUR, pas
 *  dernière ligne tout court — robuste même si une ligne d'information
 *  suivait le verdict. */
function logVerdict(text: string): null | "ok" | "erreur" {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/RETOUR ERREUR|MOTEUR MAJ ERREUR/.test(lines[i])) return "erreur";
    if (/RETOUR OK|RETOUR EFFECTUÉ|MOTEUR MAJ OK|CONTRÔLE OK/.test(lines[i])) return "ok";
  }
  return null;
}

export function AgentMotorCard({ connected = true, onNavigateStorage }: AgentMotorCardProps) {
  const [state, setState] = useState<MotorState | null>(null);
  const [journal, setJournal] = useState<JournalWire[]>([]);
  const [log, setLog] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  // ── Liaison (ex carte « Agent Hermes » v0.3.3, §3.2) : sonde réelle
  //    unique — le battement de TOUT événement socket rafraîchit
  //    « dernier contact », le canal est la socket elle-même. */
  const [lastSeen, setLastSeen] = useState<number>(Date.now());
  useEffect(() => {
    const onAny = () => setLastSeen(Date.now());
    const socket = getSocket();
    socket.onAny(onAny);
    return () => {
      socket.offAny(onAny);
    };
  }, []);

  // « Moteur sur un autre poste » (ex « Agent sur un autre poste ») :
  // replié par défaut, les champs restent locaux à la session.
  const [advOpen, setAdvOpen] = useState(false);

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

  // ── État d'affichage de la carte moteur fusionnée (maquette v2 :
  //    calme → dispo → en cours → ok | problème → retour ; la liaison
  //    coupée passe devant — sans moteur joignable, pas de maintenance).
  //    NB : « connecté » dit si l'INTERFACE parle au service local, qui
  //    relaie vers le moteur — c'est la liaison qu'on montre, pas un
  //    état du moteur en lui-même (honnêteté v0.4.0).
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
      {/* ── Carte Moteur Hermes — fusion v0.4.1 : liaison + version,
          mise à jour, contrôle, repli « autre poste » (maquette v2) ── */}
      <div className="rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
              Moteur Hermes <Pastille tone={tone} label={etatLabel} />
            </div>
            <div className="mt-0.5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
              {!connected ? (
                <>
                  Le programme Hermes n&apos;est plus joignable. Rien n&apos;est perdu —
                  la reconnexion est automatique et silencieuse.
                </>
              ) : op?.kind === "update" ? (
                <>Hermes s&apos;occupe de sa propre mise à jour — le déroulé apparaît ci-dessous, rien à faire.</>
              ) : op?.kind === "rollback" ? (
                <>Retour vers la version {previous ?? "précédente"} — procédure officielle de Hermes, déroulé ci-dessous.</>
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
                  Le programme Hermes qui tourne sur votre machine&nbsp;: il répond à vos
                  questions, exécute les outils et enregistre les documents que vous
                  générez. {checkedAt ? `Dernière vérification à ${checkedAt}.` : ""}
                </>
              ) : (
                <>
                  Le moteur Hermes n&apos;est pas détecté sur ce poste. Installez ou lancez
                  le moteur Hermes, puis «&nbsp;Revérifier&nbsp;».
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
            {onNavigateStorage ? (
              <button
                type="button"
                onClick={onNavigateStorage}
                className="h-8 cursor-pointer rounded-md border border-border bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
              >
                Documents générés →
              </button>
            ) : null}
          </div>
        </div>

        {/* Lignes : version installée / dernière release / liaison (fusion
            v0.4.1 — ex lignes de la carte Agent, sonde réelle unique : le
            battement du flux websocket, le canal est la socket elle-même). */}
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
          <div className="flex items-center justify-between gap-4 border-b border-border py-2">
            <span className="text-muted-foreground">Dernier contact</span>
            <b className="font-mono text-[11.5px] font-semibold tabular-nums">
              {connected ? `à ${hf.format(lastSeen)}` : "—"}
            </b>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <span className="text-muted-foreground">Liaison</span>
            <b className="font-mono text-[11.5px] font-semibold">
              {connected ? "locale, en continu" : "perdue, reconnexion…"}
            </b>
          </div>
        </div>

        {/* « Moteur sur un autre poste » (ex « Agent sur un autre poste »,
            v0.3.3) : replié par défaut, les champs restent locaux à la
            session — aucune donnée n'est envoyée sans action explicite. */}
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
          Moteur sur un autre poste
        </button>
        {advOpen ? (
          <div className="mt-1.5">
            <label className="mt-2.5 block">
              <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">Adresse du moteur</span>
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
              Si le moteur Hermes est installé sur un autre ordinateur que celui-ci&nbsp;:
              indiquez ici son adresse et son code d&apos;accès. Rien ne change avant que vous validiez.
            </p>
          </div>
        ) : null}

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
