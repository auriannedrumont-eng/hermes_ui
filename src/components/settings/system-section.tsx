"use client";

// Section « Système » — v3 (v0.5.1), maquette validée
// design/maquette-systeme-v3.html : DEUX cartes, une par programme
// (« L'application » / « Hermes »), une seule grammaire. Principes de la
// maquette : une seule question (« tout va bien, et sinon que faire ? »),
// zéro accordéon ouvert au repos, pas de redondance (la version ne vit
// que dans le fil), zéro jargon (plus de « révision git », « lanceur »,
// « drapeau »), et pendant une mise à jour la carte devient un FIL en
// 4 jalons qui respire (« il y a 3 s ») avec garde-fou 30 s.
//
// v0.5.1 (revue) : toute la mécanique du fil vit désormais dans
// fil-live.tsx (parseur, verdict, horloge, jalons) — partagée avec la
// carte Hermes au lieu d'être dupliquée. La sonde system:update-check
// n'existe plus qu'EN UN SEUL EXEMPLAIRE (prodeMajCheck) : le montage, le
// bouton et la re-vérification B-6 l'appellent tous. « Terminé à HH:MM »
// utilise l'heure du VERDICT du journal (la ligne « MAJ OK »), pas celle
// d'une vérification précédente — il ne peut plus mentir si la re-sonde
// échoue.
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pastille } from "@/components/settings/bits";
import { AgentMotorCard } from "@/components/settings/agent-motor-card";
import { SanteCard } from "@/components/settings/sante-card";
import {
  type FilLigne,
  derniereLigne,
  heureVersMs,
  jalonsHtml,
  parseFil,
  traduireLigneApp,
  useTick,
  verdictApp,
} from "@/components/settings/fil-live";
import { Button } from "@/components/ui/button";
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
  /** Revue 95 : branchement d'une gateway distante (repli « autre poste »
   *  de la carte Hermes) — câblé depuis SettingsPanel (gateway:set). */
  onConnectGateway?: (
    url: string,
    token?: string
  ) => Promise<{ ok: boolean; error?: string }>;
}

/** Réponse de system:update-check (contrat du service). */
interface UpdateCheckRes {
  installed?: string | null;
  available?: string | null;
  checkedAt?: string | null;
  error?: string;
}

const JALONS = ["Demande envoyée", "Téléchargement", "Installation", "Vérification"];

// ── Découpage en feuilles (chantier CRAP vague 7 UI, 2026-11-24) ────────
// Le composant SystemSection (CC 102 au crapper) est démonté : deux
// feuilles appelées dans l'ordre du rendu, corps déplacés VERBATIM (aucune
// ligne de JSX ni de handler modifiée — les closures deviennent des props
// typées du même nom), par chirurgie ancrée (ce script, versionné) :
//   SystemEnteteApp — l'en-tête de la carte application : ton et libellé de
//                     la pastille dérivés (appTone/appLabel), phrase d'état,
//                     actions (Recharger / Mettre à jour / Réessayer /
//                     Vérifier maintenant / Vérification…) ;
//   SystemFilApp    — le fil live de la carte application (LE cœur de la
//                     v3) : jalons, phrases horodatées qui respirent,
//                     reconnexion, garde-fou « aucune nouvelle depuis
//                     30 s ».
// Tout l'état reste dans l'orchestrateur (SystemSection) : sonde unique
// prodeMajCheck, journal MAJ (appliqueJournal, majFetch), updateNow, effets
// de relais / garde-fou / reprise, fil dérivé et ses âges. Les callbacks
// (updateNow, prodeMajCheck, ageLigne) descendent en props. Structure DOM
// inchangée (mêmes nœuds dans le même ordre) ; props publiques de
// SystemSection inchangées. SystemFilApp (enfant racine = un ternaire JSX)
// est enveloppée dans un fragment — aucun nœud DOM ajouté.

/** Feuille 1 — l'en-tête de la carte application : ton et libellé de la
 *  pastille dérivés de l'état MAJ (appTone/appLabel, §maquette v3), phrase
 *  d'état, actions. Corps déplacé VERBATIM de l'orchestrateur (chantier
 *  CRAP vague 7 UI, 2026-11-24) ; la sonde prodeMajCheck et updateNow
 *  restent au parent et descendent en props. */
interface SystemEnteteAppProps {
  majDone: null | "ok" | "erreur";
  majActif: boolean;
  majEtat: "inconnu" | "ajour" | "disponible" | "erreur";
  majMotif: string | null;
  majVerifieLabel: string | null;
  majFinA: string | null;
  updating: boolean;
  updateNow: () => void;
  prodeMajCheck: (silencieux?: boolean) => void;
}

function SystemEnteteApp({
  majDone,
  majActif,
  majEtat,
  majMotif,
  majVerifieLabel,
  majFinA,
  updating,
  updateNow,
  prodeMajCheck,
}: SystemEnteteAppProps) {
  // ── La pastille de la carte application ─────────────────────
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
          <div className="flex flex-wrap items-start justify-between gap-x-3.5 gap-y-2 max-[560px]:flex-col max-[560px]:items-stretch">
            <div className="min-w-[200px] flex-1">
              <h2 id="t-app" className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
                L&apos;application <Pastille tone={appTone} label={appLabel} />
              </h2>
              <p className="fil mt-1 max-w-[500px] text-[12.5px] leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
                {majDone === "ok" ? (
                  <>
                    Terminé à <b>{majFinA ?? majVerifieLabel ?? "—"}</b> —
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
                    Dernière vérification&nbsp;: {majVerifieLabel ?? "à une heure inconnue"}. Votre
                    version est la plus récente.
                  </>
                ) : (
                  <>Vérification de la disponibilité d&apos;une nouvelle version…</>
                )}
              </p>
            </div>

            {/* Lot audit : classe Tailwind corrompue réparée —
                « max-[560px]:stretch » et « max-[560px]:*: » (variante
                inachevée, retour à la ligne dans la chaîne) n'existaient pas ;
                l'intention responsive < 560 px est rétablie. */}
            <div className="flex flex-none flex-wrap items-center gap-2 max-[560px]:min-w-[130px] max-[560px]:flex-1 max-[560px]:text-center">
              {majDone === "ok" ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => window.location.reload()}
                  className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
                >
                  Recharger la page
                </Button>
              ) : majActif ? null : majEtat === "disponible" ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={updateNow}
                  disabled={updating}
                  className="h-8 cursor-pointer rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {updating ? "Envoi…" : "Mettre à jour"}
                </Button>
              ) : majEtat === "erreur" ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => prodeMajCheck()}
                  className="h-8 cursor-pointer rounded-lg border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
                >
                  Réessayer
                </Button>
              ) : majEtat === "ajour" ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => prodeMajCheck()}
                  className="h-8 cursor-pointer rounded-lg border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
                >
                  Vérifier maintenant
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  disabled
                  className="h-8 cursor-not-allowed rounded-lg bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground opacity-40"
                >
                  Vérification…
                </Button>
              )}
            </div>
          </div>
  );
}

/** Feuille 2 — le fil live de la carte application (LE cœur de la v3) :
 *  jalons, phrases horodatées qui respirent, reconnexion, garde-fou
 *  « aucune nouvelle depuis 30 s ». Corps déplacé VERBATIM de
 *  l'orchestrateur (chantier CRAP vague 7 UI, 2026-11-24) ; le fil dérivé
 *  (parseFil), jalonCourant et les âges restent calculés au parent. */
interface SystemFilAppProps {
  majActif: boolean;
  majDone: null | "ok" | "erreur";
  majEtat: "inconnu" | "ajour" | "disponible" | "erreur";
  fil: FilLigne[];
  jalonCourant: number;
  majReconnect: boolean;
  majStale: boolean;
  majAttendGitHub: boolean;
  ageJournal: number | null;
  ageLigne: (l: FilLigne) => string | null;
}

function SystemFilApp({
  majActif,
  majDone,
  majEtat,
  fil,
  jalonCourant,
  majReconnect,
  majStale,
  majAttendGitHub,
  ageJournal,
  ageLigne,
}: SystemFilAppProps) {
  return (
    <>
          {majActif || majDone !== null ? (
            <div className="mt-3 overflow-hidden rounded-[10px] border border-border">
              <div className="flex flex-wrap items-center gap-2.5 px-3.5 pb-0.5 pt-2.5">
                {jalonsHtml(JALONS, jalonCourant)}
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
                        <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground opacity-80">
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
                  <p className="mt-2 text-[11px] text-muted-foreground" role="status">
                    La connexion coupe et revient — c&apos;est prévu pendant le redémarrage.
                  </p>
                ) : null}

                {/* Garde-fou maquette : le silence, dit honnêtement. */}
                {majStale && majDone === null ? (
                  <div
                    role="alert"
                    className="mt-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-[12.5px] font-medium leading-relaxed text-warning"
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
            <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
              La mise à jour est installée par le petit programme «&nbsp;Hermes Web&nbsp;» qui a
              lancé l&apos;application&nbsp;: il prend la demande dans les 15&nbsp;secondes, met tout
              à jour, puis relance tout seul. Si vous aviez modifié des fichiers de
              l&apos;application, ils sont mis de côté dans une sauvegarde datée — jamais perdus.
            </p>
          ) : null}
    </>
  );
}

export function SystemSection({
  connected = true,
  updateAvailable = null,
  appRevision: _appRevision = null,
  onNavigateStorage,
  onConnectGateway,
}: SystemSectionProps) {
  // ── État de vérification (à jour / disponible / erreur) ───────────────
  const [majEtat, setMajEtat] = useState<"inconnu" | "ajour" | "disponible" | "erreur">("inconnu");
  /** Instant de la dernière vérification RÉUSSIE (ISO — le libellé « aujourd'hui »
   *  n'est plus affiché que si c'est vrai). */
  const [majVerifieAt, setMajVerifieAt] = useState<string | null>(null);
  const [majMotif, setMajMotif] = useState<string | null>(null);
  const majAJour = majEtat === "ajour";

  const majVerifieLabel = useMemo(() => {
    if (!majVerifieAt) return null;
    const d = new Date(majVerifieAt);
    if (Number.isNaN(d.getTime())) return null;
    const heure = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    const memeJour = new Date().toDateString() === d.toDateString();
    return memeJour
      ? `aujourd'hui à ${heure}`
      : `le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} à ${heure}`;
  }, [majVerifieAt]);

  // LA sonde (v0.5.1 : un seul exemplaire — montage, bouton, B-6). Le
  // service re-sonde vraiment GitHub (refreshUpdateState) et répond
  // honnêtement : à jour / disponible / erreur. Le reset d'état part au
  // microtask suivant (queueMicrotask) : jamais de setState synchrone
  // dans le corps d'un effet (react-hooks/set-state-in-effect).
  // Lot audit 2026-11-21 : chien de garde 8 s — service muet, le bouton ne
  // reste plus figé sur « Vérification… » pour toujours (constat visuel).
  const prodeMajCheck = useCallback((silencieux = false) => {
    if (!silencieux) {
      queueMicrotask(() => {
        setMajEtat("inconnu");
        setMajMotif(null);
      });
    }
    const garde = window.setTimeout(() => {
      if (silencieux) return;
      setMajEtat("erreur");
      setMajMotif("Le service n'a pas répondu (8 s) — réessayez une fois la connexion rétablie.");
    }, 8_000);
    getSocket().emit("system:update-check", (res: UpdateCheckRes = {}) => {
      window.clearTimeout(garde);
      if (res?.error) {
        if (!silencieux) {
          setMajEtat("erreur");
          setMajMotif(res.error);
        }
        return; // B-6 silencieux : le fil reste sur son verdict
      }
      setMajVerifieAt(res.checkedAt ?? new Date().toISOString());
      setMajEtat(res.available && res.available !== (res.installed ?? undefined) ? "disponible" : "ajour");
    });
  }, []);

  // Vérification à l'OUVERTURE de la page (spec §3.1 — deux déclencheurs
  // seulement : l'ouverture et le bouton). hello.update / le prop du
  // panneau peuvent précéder la réponse (état affiché immédiatement),
  // mais c'est ce coup de sonde qui fait foi.
  useEffect(() => {
    prodeMajCheck();
  }, [prodeMajCheck]);

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
  /** Heure du VERDICT (v0.5.1) : l'horodatage de la dernière ligne du
   *  journal — jamais celui d'une vérification précédente. */
  const [majFinA, setMajFinA] = useState<string | null>(null);
  const majLastChangeRef = useRef(0);

  const majActif = majLog !== null && majDone === null;

  // Synchro pendant le rendu (pattern officiel React — le prop peut
  // arriver après le montage via hello rediffusé, ou être déjà là).
  // Lot audit : la synchro fonctionne aussi dans l'autre sens —
  // `updateAvailable` repassant à null fait sortir de « disponible »
  // (mise à jour faite depuis une autre fenêtre), au lieu d'y rester
  // collé pour toujours. (Placé APRÈS les déclarations majActif/majDone.)
  const [dernierUpdateDispo, setDernierUpdateDispo] = useState<string | null>(updateAvailable);
  if (updateAvailable !== dernierUpdateDispo) {
    setDernierUpdateDispo(updateAvailable);
    if (updateAvailable) {
      setMajEtat("disponible");
      setMajVerifieAt(new Date().toISOString());
    } else if (!majActif && majDone === null) {
      setMajEtat((e) => (e === "disponible" ? "ajour" : e));
    }
  }
  const majAttendGitHub = majActif && derniereLigne(majLog ?? "").toLowerCase().includes("github");

  /** Applique un snapshot du journal : battement sur l'ÂGE DU JOURNAL
   *  (mtimeMs, horloge du service), pas sur l'instant de réception —
   *  relire un journal inchangé (reconnexion, rattrapage) ne doit
   *  JAMAIS ressusciter le fil (garde-fou, constat QA v3). */
  const appliqueJournal = useCallback((text: string, mtimeMs?: number) => {
    const at = typeof mtimeMs === "number" && mtimeMs > 0 ? mtimeMs : Date.now();
    majLastChangeRef.current = at;
    setMajStale(false);
    setMajReconnect(false);
    setMajLog(text);
    setMajLogAt(at);
    const verdict = verdictApp(text);
    setMajDone(verdict);
    if (verdict !== null) {
      const lignes = text.split("\n").filter((l) => l.trim().length > 0);
      const m = lignes[lignes.length - 1].match(/^\[(\d{2}:\d{2}:\d{2})\]/);
      setMajFinA(m?.[1] ?? null);
    }
  }, []);

  const majFetch = useCallback(() => {
    getSocket().emit(
      "system:update-log",
      (res: { exists?: boolean; text?: string; mtimeMs?: number } = {}) => {
        if (!res?.exists || typeof res.text !== "string") return;
        appliqueJournal(res.text, res.mtimeMs);
      }
    );
  }, [appliqueJournal]);

  const updateNow = () => {
    if (updating || majActif) return;
    setUpdating(true);
    setUpdateError(null);
    setMajDone(null);
    // Lot audit : chien de garde — service muet, « Envoi… » ne reste plus
    // bloqué pour toujours.
    const garde = window.setTimeout(() => {
      setUpdating(false);
      setUpdateError("Le service n'a pas répondu (8 s) — réessayez une fois la connexion rétablie.");
    }, 8_000);
    getSocket().emit(
      "system:update-request",
      (res: { ok?: boolean; alreadyRunning?: boolean; error?: string } = {}) => {
        window.clearTimeout(garde);
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
    if (majDone === "ok" && majDoneRef.current !== "ok") prodeMajCheck(true);
    majDoneRef.current = majDone;
  }, [majDone, prodeMajCheck]);

  // Suivi live : relais du journal + reprise à la reconnexion. Abonnement
  // PERMANENT pendant que la section est montée : le relais ne diffuse
  // que sur changement réel (signature mtimeMs:len côté service), donc
  // écouter coûte rien — et c'est le seul moyen de rattraper une maj
  // démarrée depuis une AUTRE fenêtre alors qu'aucun journal n'existait
  // à notre montage (constat QA v3 : exists:false au montage laissait
  // l'abonnement éteint à jamais).
  useEffect(() => {
    const socket = getSocket();
    const onChange = (snap: { text?: string; mtimeMs?: number } = {}) => {
      if (typeof snap?.text !== "string") return;
      // Le relais ne diffuse QUE sur changement réel (signature service) :
      // ici, l'instant de réception EST le battement du journal.
      appliqueJournal(snap.text, snap.mtimeMs);
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
  }, [majFetch, appliqueJournal]);

  // Garde-fou maquette : aucune nouvelle depuis 30 s → on le DIT.
  // Seuil à 45 s pour les phases GitHub (réseau) — sinon le fil crierait
  // au loup pendant les étapes lentes.
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
  // Le fil n'est VÉCU que si le journal est frais (10 min, âge sur
  // mtimeMs — horloge du service, audit A-2) ; un verdict présent dans
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
        if (fresh) appliqueJournal(res.text, res.mtimeMs);
      }
    );
  }, [appliqueJournal]);

  // Le fil vit : re-render chaque seconde pendant l'opération.
  const tick = useTick(majActif);

  // Le fil dérivé du journal (mémoïsé — parseur pur).
  const fil = useMemo(() => (majLog !== null ? parseFil(majLog, traduireLigneApp) : []), [majLog]);
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
          <SystemEnteteApp
            majDone={majDone}
            majActif={majActif}
            majEtat={majEtat}
            majMotif={majMotif}
            majVerifieLabel={majVerifieLabel}
            majFinA={majFinA}
            updating={updating}
            updateNow={updateNow}
            prodeMajCheck={prodeMajCheck}
          />

          {/* Le fil live — LE cœur de la v3 : jalons + phrases horodatées
              qui respirent + garde-fou « aucune nouvelle depuis 30 s ». */}
          <SystemFilApp
            majActif={majActif}
            majDone={majDone}
            majEtat={majEtat}
            fil={fil}
            jalonCourant={jalonCourant}
            majReconnect={majReconnect}
            majStale={majStale}
            majAttendGitHub={majAttendGitHub}
            ageJournal={ageJournal}
            ageLigne={ageLigne}
          />


          {updateError ? (
            <p className="mt-2 text-[11px] font-medium text-destructive" role="alert">
              {updateError}
            </p>
          ) : null}
        </section>

        {/* ══ CARTE 2 — HERMES (le moteur) ═══════════════════════════════
            Même grammaire que la carte application — agent-motor-card. */}
        <AgentMotorCard connected={connected} onNavigateStorage={onNavigateStorage} onConnectGateway={onConnectGateway} />
        {/* Refonte (68) : le manifeste du dernier démarrage — la même
            vérité que la fenêtre du lanceur (prérequis ✓/✗, agent, verdict).
            N'existe qu'une fois qu'un lanceur à jour a écrit sante.json. */}
        <SanteCard />
      </div>
    </section>
  );
}
