// Section « Système » — v3 (v0.5.0), maquette validée
// design/maquette-systeme-v3.html : DEUX cartes, une par programme
// (« L'application » / « Hermes »), une seule grammaire. Principes de la
// maquette : une seule question (« tout va bien, et sinon que faire ? »),
// zéro accordéon ouvert au repos, pas de redondance (la version ne vit
// que dans le fil), zéro jargon (plus de « révision git », « lanceur »,
// « drapeau »), et pendant une mise à jour la carte devient un FIL en
// 4 jalons qui respire (« il y a 3 s ») avec garde-fou 30 s.
//
// Cette carte = l'application. La carte Hermes vit dans
// agent-motor-card.tsx (même grammaire).
//
// Arbitrages validés par l'utilisatrice (audit §3.3) : l'application
// n'affiche NI l'aperçu des changements (pas de releases GitHub côté
// hermes_ui — le service compare des révisions brutes) NI la « version
// d'avant » en réserve (aucun retour arrière exécutable : le lanceur
// n'en a pas). Ces deux promesses restent celles d'Hermes, qui les tient.
// En échange, le fil application dit ce que le lanceur fait VRAIMENT :
// les modifications locales sont mises de côté (dossier de sauvegarde),
// jamais perdues.
//
// Mécanismes conservés des v0.2-0.4 : vérification au service
// (hello.update + system:update-state, 6 h), drapeau ramassé par le
// lanceur (≤ 15 s), relais du journal en direct, verdict à marqueur
// (A-1), garde anti double-demande (B-2), re-vérification silencieuse
// après « MAJ OK » (B-6). Sondes RÉELLES uniquement, jamais simulées.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pastille } from "@/components/settings/bits";
import { AgentMotorCard } from "@/components/settings/agent-motor-card";
import { getSocket } from "@/lib/socket";

interface SystemSectionProps {
  /** État RÉEL de la socket vers le service — la carte Hermes suit ce flux. */
  connected?: boolean;
  /** Révision disponible (null = à jour) : prop du panneau, même valeur
   *  que le point orange sur l'engrenage. */
  updateAvailable?: string | null;
  /** Révision git du déploiement (hello.appRevision) — conservée dans le
   *  contrat du panneau ; la v3 ne l'affiche plus (zéro jargon : plus de
   *  « révision git » à l'écran, l'heure de vérification suffit). */
  appRevision?: string | null;
  /** Navigation vers la page Stockage. */
  onNavigateStorage?: () => void;
}

// ── Le parseur du journal (A-1) : ligne brute → phrase humaine ────────────
// Un seul endroit traduit le journal technique du lanceur. Tolérant par
// construction : verdict = dernière ligne QUI PORTE un marqueur, mapping
// par mots-clés insensible à la casse/accents des deux lanceurs (ps1/sh)
// et du service. Toute ligne inconnue reste affichée (brute, sans
// horodatage dupliqué) — le fil ne ment jamais par omission.

export interface FilLigne {
  /** Heure locale de la ligne, parsée du préfixe [HH:MM:SS] (null si absent). */
  heure: string | null;
  /** Phrase humaine (ou ligne brute si non reconnue). */
  texte: string;
  /** Jalon 0-3 atteint par cette ligne (-1 = pas de progression). */
  jalon: number;
  /** Classe d'affichage : ligne courante / succès / échec / normale. */
  classe: "cur" | "ok" | "ko" | "";
}

/** Verdict : dernière ligne QUI PORTE un marqueur terminal (A-1). */
function majVerdict(text: string): null | "ok" | "erreur" {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("MAJ ERREUR")) return "erreur";
    if (lines[i].includes("MAJ OK")) return "ok";
  }
  return null;
}

/** Dernière ligne non vide — contexte du garde-fou. */
function majDerniereLigne(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

/** Traduction d'une ligne du journal en phrase humaine + jalon.
 *  Jalons : 0 Demande envoyée · 1 Téléchargement · 2 Installation ·
 *  3 Vérification. Mots-clés tirés des phrases RÉELLES des lanceurs
 *  (desktop/hermes-ui.ps1 + .sh — vérifiés au moment de la v3). */
function traduireLigne(brute: string): FilLigne {
  // Préfixe horodaté : le service et les deux lanceurs écrivent [HH:MM:SS].
  const m = brute.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
  const heure = m?.[1] ?? null;
  const texte = m?.[2] ?? brute;
  const t = texte.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // — Verdicts et incidents (avant tout : ils portent la couleur) —
  if (texte.includes("MAJ OK")) {
    return { heure, texte: "C'est terminé — la nouvelle version est installée. Rechargez la page pour la découvrir.", jalon: 3, classe: "ok" };
  }
  if (texte.includes("MAJ ERREUR")) {
    return { heure, texte: "La mise à jour n'a pas abouti. Rien n'a changé — l'application actuelle continue de fonctionner. Le détail est dans la fenêtre « Hermes Web ».", jalon: -1, classe: "ko" };
  }
  if (t.startsWith("attention")) {
    return { heure, texte, jalon: -1, classe: "ko" };
  }
  if (t.includes("deja a jour")) {
    return { heure, texte: "Finalement, tout était déjà à jour — quelqu'un a mis à jour entre-temps. Rien à faire.", jalon: 3, classe: "ok" };
  }
  if (t.includes("github injoignable")) {
    return { heure, texte: "GitHub est injoignable (connexion ?). La version actuelle est conservée — vous pourrez réessayer.", jalon: -1, classe: "ko" };
  }
  if (t.includes("non appliquee") && t.includes("version locale conservee")) {
    return { heure, texte: "La nouvelle version n'a pas pu être appliquée — la version locale est conservée.", jalon: -1, classe: "ko" };
  }
  if (t.startsWith("remarque")) {
    // Le lanceur lui-même a été mis à jour : conseil de relance, une fois.
    return { heure, texte: "Une dernière chose : le petit programme qui installe les mises à jour a lui-même changé. Fermez sa fenêtre puis relancez « Hermes Web » une seule fois — les prochaines mises à jour s'afficheront en direct.", jalon: -1, classe: "" };
  }

  // — Jalon 0 : Demande envoyée —
  if (t.includes("demande deposee") || t.includes("maj debut") || t.includes("arret des services")) {
    return { heure, texte: "Demande envoyée — arrêt en douceur de l'application (une dizaine de secondes)…", jalon: 0, classe: "" };
  }

  // — Jalon 1 : Téléchargement —
  if (t.includes("consultation de github")) {
    return { heure, texte: "Recherche de la nouvelle version…", jalon: 1, classe: "" };
  }
  if (t.includes("fusion directe impossible")) {
    return { heure, texte: "Vos modifications locales sont mises de côté (sauvegardées, pas perdues), puis la nouvelle version est récupérée…", jalon: 1, classe: "" };
  }
  if (t.includes("version github appliquee") || t.includes("mise a jour appliquee")) {
    return { heure, texte: "Nouvelle version récupérée.", jalon: 1, classe: "" };
  }
  if (t.includes("pas de branche distante")) {
    return { heure, texte: "Pas de dépôt distant configuré — la version locale est conservée.", jalon: -1, classe: "ko" };
  }

  // — Jalon 2 : Installation —
  if (t.includes("reconstruction") || t.includes("construction de l'interface") || t.includes("code de l'interface modifie")) {
    return { heure, texte: "Le code de l'application a changé — reconstruction (1 à 3 minutes, c'est le plus long)…", jalon: 2, classe: "" };
  }
  if (t.includes("services arretes") || t.includes("relance des services")) {
    return { heure, texte: "Redémarrage de l'application (la connexion coupe une dizaine de secondes, c'est normal)…", jalon: 2, classe: "" };
  }

  // Ligne technique non traduite : on la garde brute — honnêteté d'abord.
  return { heure, texte, jalon: -1, classe: "" };
}

/** Journal complet → lignes du fil. Chaque ligne garde son jalon maximal
 *  atteint à cet endroit du récit (les jalons ne reculent jamais dans
 *  l'affichage — le fil raconte une progression). */
function parseMajJournal(text: string): FilLigne[] {
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

// ── Le « il y a N s » qui vit : horloge du fil ───────────────────────────
// L'âge des lignes est calculé sur l'horloge du NAVIGATEUR à partir du
// préfixe [HH:MM:SS] local des lanceurs (même machine en usage desktop —
// écart négligeable ; l'audit A-2 note le cas « autre poste »). Le
// garde-fou, lui, s'appuie sur mtimeMs (horloge du service, fiable).

function useTick(actif: boolean): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!actif) return;
    const id = setInterval(() => setN((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [actif]);
  return Date.now();
}

/** [HH:MM:SS] du jour → timestamp (ms). Si l'heure est « dans le
 *  futur » de plus de 30 s, c'est qu'elle date d'hier (maj à minuit). */
function heureVersMs(heure: string): number {
  const [h, m, s] = heure.split(":").map(Number);
  const now = new Date();
  const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();
  if (ts > now.getTime() + 30_000) return ts - 86_400_000;
  return ts;
}

export function SystemSection({
  connected = true,
  updateAvailable = null,
  appRevision: _appRevision = null,
  onNavigateStorage,
}: SystemSectionProps) {
  // ── État de vérification (à jour / disponible / erreur) ───────────────
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
            ? new Date(res.checkedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
            : new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
        );
        if (res.available && res.available !== (res.installed ?? undefined)) {
          setMajEtat("disponible");
        } else {
          setMajEtat("ajour");
        }
      }
    );
  }, []);

  // Vérification à l'OUVERTURE de la page (spec §3.1 — deux déclencheurs
  // seulement : l'ouverture et le bouton). hello.update / le prop du
  // panneau peuvent précéder la réponse (état affiché immédiatement),
  // mais c'est ce coup de sonde qui fait foi. La sonde est un système
  // externe : l'ack met à jour l'état, pas le corps de l'effet.
  useEffect(() => {
    getSocket().emit("system:update-check", (res: { installed?: string | null; available?: string | null; checkedAt?: string | null; error?: string } = {}) => {
      if (res?.error) {
        setMajEtat("erreur");
        setMajMotif(res.error);
        return;
      }
      setMajVerifie(
        res.checkedAt
          ? new Date(res.checkedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
          : new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
      );
      if (res.available && res.available !== (res.installed ?? undefined)) {
        setMajEtat("disponible");
      } else {
        setMajEtat("ajour");
      }
    });
  }, []);

  // Synchro pendant le rendu (pattern officiel React — le prop peut
  // arriver après le montage via hello rediffusé, ou être déjà là).
  const [dernierUpdateDispo, setDernierUpdateDispo] = useState<string | null>(updateAvailable);
  if (updateAvailable !== dernierUpdateDispo) {
    setDernierUpdateDispo(updateAvailable);
    if (updateAvailable) {
      setMajEtat("disponible");
      setMajVerifie(new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }));
    }
  }

  // ── La mise à jour en cours : journal + fil + garde-fou ───────────────
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  /** Journal connu (null = pas de journal reçu). */
  const [majLog, setMajLog] = useState<string | null>(null);
  /** mtimeMs du dernier snapshot reçu (horloge du service). */
  const [majLogAt, setMajLogAt] = useState(0);
  const [majDone, setMajDone] = useState<null | "ok" | "erreur">(null);
  /** Aucune nouvelle depuis 30 s (garde-fou maquette). */
  const [majStale, setMajStale] = useState(false);
  const [majReconnect, setMajReconnect] = useState(false);
  const majLastChangeRef = useRef(0);

  const majActif = majLog !== null && majDone === null;
  const majAttendGitHub = majActif && majDerniereLigne(majLog ?? "").toLowerCase().includes("github");

  const majFetch = useCallback(() => {
    getSocket().emit(
      "system:update-log",
      (res: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
        if (!res?.exists || typeof res.text !== "string") return;
        // Battement sur l'ÂGE DU JOURNAL (mtimeMs, horloge du service),
        // pas sur l'instant de réception : relire un journal inchangé
        // (reconnexion, rattrapage) ne doit JAMAIS ressusciter le fil —
        // sinon le garde-fou 30 s ne se déclencherait pas (constat QA v3).
        const at =
          typeof res.mtimeMs === "number" && res.mtimeMs > 0 ? res.mtimeMs : Date.now();
        majLastChangeRef.current = at;
        setMajStale(false);
        setMajReconnect(false);
        setMajLog(res.text);
        setMajLogAt(at);
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
      (res: { ok?: boolean; alreadyRunning?: boolean; error?: string } = {}) => {
        setUpdating(false);
        if (res?.ok) {
          // B-2 : demande déjà en vol (autre client, double-clic) — on
          // suit le journal existant au lieu de repartir d'une page blanche.
          majFetch();
        } else {
          setUpdateError(res?.error ?? "Échec du dépôt de la demande de mise à jour");
        }
      }
    );
  };

  // B-6 : verdict « MAJ OK » reçu → re-vérification silencieuse. Le
  // service ne re-sonde GitHub qu'au démarrage puis toutes les 6 h :
  // sans ce coup de sonde, la carte resterait « disponible » jusqu'à la
  // prochaine sonde alors que la nouvelle version est installée.
  const majDoneRef = useRef<null | "ok" | "erreur">(null);
  useEffect(() => {
    if (majDone === "ok" && majDoneRef.current !== "ok") {
      getSocket().emit(
        "system:update-check",
        (res: { installed?: string | null; available?: string | null; checkedAt?: string | null; error?: string } = {}) => {
          if (res?.error) return; // silencieux : le fil reste sur son verdict
          setMajVerifie(
            res.checkedAt
              ? new Date(res.checkedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
              : new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
          );
          setMajEtat(res.available && res.available !== (res.installed ?? undefined) ? "disponible" : "ajour");
        }
      );
    }
    majDoneRef.current = majDone;
  }, [majDone]);

  // Suivi live : relais du journal + reprise à la reconnexion. Abonnement
  // PERMANENT pendant que la section est montée : le relais ne diffuse
  // que sur changement réel (signature mtimeMs:len côté service), donc
  // écouter coûte rien — et c'est le seul moyen de rattraper une maj
  // démarrée depuis une AUTRE fenêtre alors qu'aucun journal n'existait
  // à notre montage (constat QA v3 : exists:false au montage laissait
  // majSurveille éteint à jamais).
  useEffect(() => {
    const socket = getSocket();
    const onChange = (snap: { text?: string; mtimeMs?: number } = {}) => {
      if (typeof snap?.text !== "string") return;
      // Le relais ne diffuse QUE sur changement réel (signature service) :
      // ici, l'instant de réception EST le battement du journal.
      majLastChangeRef.current = Date.now();
      setMajStale(false);
      setMajLog(snap.text);
      if (typeof snap.mtimeMs === "number" && snap.mtimeMs > 0) setMajLogAt(snap.mtimeMs);
      setMajDone(majVerdict(snap.text));
    };
    const onConnect = () => majFetch();
    const onDisconnect = () => setMajReconnect(true);
    socket.on("system:update-log:changed", onChange);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("system:update-log:changed", onChange);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [majFetch]);

  // Garde-fou maquette : aucune nouvelle depuis 30 s → on le DIT.
  // Seuil à 45 s pour les phases GitHub (réseau) et relance (reconstruction
  // longue) — sinon le fil crierait au loup pendant les étapes lentes.
  // NB : la sonde de silence ne s'arme qu'une fois le fil réellement vécu
  // (majActif), pas sur la simple existence d'un journal périmé.
  useEffect(() => {
    if (!majActif) return;
    const timer = setInterval(() => {
      const seuil = majAttendGitHub ? 45_000 : 30_000;
      if (Date.now() - majLastChangeRef.current > seuil) setMajStale(true);
    }, 5_000);
    return () => clearInterval(timer);
  }, [majActif, majAttendGitHub]);

  // Reprise au montage : un F5 pendant la mise à jour ne perd pas le fil.
  // Le snapshot est toujours chargé (l'abonnement permanent au relais fait
  // le reste). Le fil n'est VÉCU que si le journal est frais (10 min, âge
  // sur mtimeMs — horloge du service, audit A-2) ; un verdict présent dans
  // un journal frais reste affiché (maj qui vient de finir pendant qu'on
  // ouvrait la page — maquette : « Terminé à HH:MM »).
  useEffect(() => {
    getSocket().emit(
      "system:update-log",
      (res: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
        if (!res?.exists || typeof res.text !== "string" || !res.text.trim()) return;
        const fresh =
          typeof res.mtimeMs === "number" &&
          Date.now() - res.mtimeMs < 10 * 60_000;
        if (fresh) {
          // Battement sur l'âge réel du journal (mtimeMs) — même règle
          // que majFetch : un journal ancien reste ancien, même relu.
          const at =
            typeof res.mtimeMs === "number" && res.mtimeMs > 0 ? res.mtimeMs : Date.now();
          majLastChangeRef.current = at;
          setMajLog(res.text);
          setMajLogAt(at);
          setMajDone(majVerdict(res.text));
        }
      }
    );
  }, []);

  // Le fil vit : re-render chaque seconde pendant l'opération.
  const tick = useTick(majActif);

  // Le fil dérivé du journal (mémoïsé — parseur pur).
  const fil = useMemo(() => (majLog !== null ? parseMajJournal(majLog) : []), [majLog]);
  /** Jalon courant : le max atteint par les lignes, sauf si verdict final. */
  const jalonCourant = useMemo(() => {
    if (majDone === "ok") return -1; // tout coché
    let max = 0;
    for (const l of fil) if (l.jalon > max) max = l.jalon;
    return max;
  }, [fil, majDone]);

  /** Âge d'une ligne du fil (« il y a N s »), sur son préfixe horodaté. */
  const ageLigne = (l: FilLigne): string | null => {
    if (!l.heure) return null;
    const age = Math.max(1, Math.round((tick - heureVersMs(l.heure)) / 1000));
    return `il y a ${age} s`;
  };
  /** Âge du journal entier : mtimeMs (horloge du service, audit A-2). */
  const ageJournal = majLogAt > 0 ? Math.max(1, Math.round((tick - majLogAt) / 1000)) : null;

  // ── Rendu des jalons (grammaire maquette : demande → téléchargement →
  //    installation → vérification) ─────────────────────────────────────
  const JALONS = ["Demande envoyée", "Téléchargement", "Installation", "Vérification"];
  const jalonsHtml = (cur: number) => {
    const elts: React.ReactNode[] = [];
    JALONS.forEach((label, i) => {
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

  // ── La pastille de la carte application ─────────────────────────────
  const appTone: "ok" | "warn" | "err" | "off" | "busy" =
    majDone === "ok"
      ? "ok"
      : majActif
        ? "busy"
        : majEtat === "disponible"
          ? "warn"
          : majEtat === "erreur"
            ? "err"
            : majEtat === "ajour"
              ? "ok"
              : "busy";
  const appLabel =
    majDone === "ok"
      ? "Mise à jour installée"
      : majActif
        ? "Mise à jour en cours…"
        : majEtat === "disponible"
          ? "Mise à jour disponible"
          : majEtat === "erreur"
            ? "Vérification impossible"
            : majEtat === "ajour"
              ? "À jour"
              : "Vérification…";

  return (
    <section aria-label="Système" className="mx-auto w-full max-w-[880px]">
      <h1 className="text-[19px] font-bold tracking-tight">Système</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Deux programmes travaillent pour vous&nbsp;: cette application, et Hermes.
        Chacun se met à jour en un clic, et vous dit tout, en direct.
      </p>

      <div className="space-y-3">
        {/* ══ CARTE 1 — L'APPLICATION ════════════════════════════════════ */}
        <section
          aria-labelledby="t-app"
          className="rounded-xl border border-border bg-card px-4 py-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-x-3.5 gap-y-2 max-[560px]:flex-col max-[560px]:items-stretch">
            <div className="min-w-[200px] flex-1">
              <h2 id="t-app" className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
                L&apos;application <Pastille tone={appTone} label={appLabel} />
              </h2>
              <p className="fil mt-1 max-w-[500px] text-[12.5px] leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
                {majDone === "ok" ? (
                  <>
                    Terminé à <b>{majVerifie ?? new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</b> —
                    rechargez la page pour découvrir la nouvelle version. Vos conversations et
                    réglages sont intacts.
                  </>
                ) : majActif ? (
                  <>Pas besoin d&apos;attendre ici&nbsp;: tout se fait tout seul.</>
                ) : majEtat === "disponible" ? (
                  <>
                    Une nouvelle version est prête. Un clic, et tout se fait tout seul
                    (1 à 2 minutes, davantage si l&apos;application doit être reconstruite —
                    c&apos;est annoncé dans le fil).
                  </>
                ) : majEtat === "erreur" ? (
                  <>
                    Impossible de vérifier les mises à jour ({majMotif ?? "cause inconnue"}).
                    Vérifiez votre connexion internet, puis réessayez.
                  </>
                ) : majEtat === "ajour" ? (
                  <>
                    Dernière vérification&nbsp;: aujourd&apos;hui à <b>{majVerifie ?? "—"}</b>. Votre
                    version est la plus récente.
                  </>
                ) : (
                  <>Vérification de la disponibilité d&apos;une nouvelle version…</>
                )}
              </p>
            </div>

            <div className="flex flex-none flex-wrap items-center gap-2 max-[560px]:stretch max-[560px]:*:
              max-[560px]:min-w-[130px] max-[560px]:flex-1 max-[560px]:text-center">
              {majDone === "ok" ? (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
                >
                  Recharger la page
                </button>
              ) : majActif ? null : majEtat === "disponible" ? (
                <button
                  type="button"
                  onClick={updateNow}
                  disabled={updating}
                  className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {updating ? "Envoi…" : "Mettre à jour"}
                </button>
              ) : majEtat === "erreur" ? (
                <button
                  type="button"
                  onClick={checkUpdates}
                  className="h-8 cursor-pointer rounded-lg border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
                >
                  Réessayer
                </button>
              ) : majEtat === "ajour" ? (
                <button
                  type="button"
                  onClick={checkUpdates}
                  className="h-8 cursor-pointer rounded-lg border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
                >
                  Vérifier maintenant
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="h-8 cursor-not-allowed rounded-lg bg-hermes px-3.5 text-[12.5px] font-semibold text-hermes-foreground opacity-40"
                >
                  Vérification…
                </button>
              )}
            </div>
          </div>

          {/* Le fil live — LE cœur de la v3 : jalons + phrases horodatées
              qui respirent + garde-fou « aucune nouvelle depuis 30 s ». */}
          {majActif || majDone !== null ? (
            <div className="mt-3 overflow-hidden rounded-[10px] border border-border">
              <div className="flex flex-wrap items-center gap-2.5 px-3.5 pb-0.5 pt-2.5">
                {jalonsHtml(jalonCourant)}
              </div>
              <div className="mt-2 border-t border-border bg-background px-3.5 pb-3 pt-2.5">
                {/* Les dernières lignes du fil (les 6 plus récentes — le
                    début reste dans la fenêtre « Hermes Web » si besoin). */}
                <div className="flex flex-col gap-1">
                  {fil.slice(-6).map((l, i, arr) => (
                    <p
                      key={i}
                      className={
                        "flex items-baseline gap-2.5 text-[12.5px] " +
                        (l.classe === "cur" || (l.classe === "" && i === arr.length - 1 && majDone === null)
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
                      {majDone === null && i === arr.length - 1 && l.heure ? (
                        <span className="flex-none text-[11px] text-muted-foreground">{ageLigne(l)}</span>
                      ) : null}
                    </p>
                  ))}
                </div>

                {/* Reconnexion : la pile relance par la mise à jour. */}
                {majReconnect && majDone === null ? (
                  <p className="mt-2 text-[11.5px] text-muted-foreground" role="status">
                    La connexion coupe et revient — c&apos;est prévu pendant le redémarrage.
                  </p>
                ) : null}

                {/* Garde-fou maquette : le silence, dit honnêtement. */}
                {majStale && majDone === null ? (
                  <div
                    role="alert"
                    className="mt-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-[12px] font-medium leading-relaxed text-warning"
                  >
                    Aucune nouvelle depuis {majAttendGitHub ? "45" : "30"} secondes
                    {ageJournal ? ` (dernière écriture il y a ${ageJournal} s)` : ""}. Ce n&apos;est
                    probablement rien — certaines étapes sont longues. Mais si rien ne bouge
                    d&apos;ici une minute&nbsp;: regardez si la fenêtre «&nbsp;Hermes Web&nbsp;»
                    (le petit programme qui installe les mises à jour) attend une réponse de
                    votre part.
                  </div>
                ) : null}

                {majDone === null && !majStale && !majReconnect ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    Le déroulé complet vit dans la fenêtre «&nbsp;Hermes Web&nbsp;» — ici, l&apos;essentiel en direct.
                  </p>
                ) : null}
              </div>
            </div>
          ) : majEtat === "disponible" ? (
            /* État disponible sans journal : ce que le lanceur fera. */
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              La mise à jour est installée par le petit programme «&nbsp;Hermes Web&nbsp;» qui a
              lancé l&apos;application&nbsp;: il prend la demande dans les 15&nbsp;secondes, met tout
              à jour, puis relance tout seul. Si vous aviez modifié des fichiers de
              l&apos;application, ils sont mis de côté dans une sauvegarde datée — jamais perdus.
            </p>
          ) : null}

          {updateError ? (
            <p className="mt-2 text-[11.5px] font-medium text-destructive" role="alert">
              {updateError}
            </p>
          ) : null}
        </section>

        {/* ══ CARTE 2 — HERMES (le moteur) ═══════════════════════════════
            Même grammaire que la carte application — agent-motor-card. */}
        <AgentMotorCard connected={connected} onNavigateStorage={onNavigateStorage} />
      </div>
    </section>
  );
}
