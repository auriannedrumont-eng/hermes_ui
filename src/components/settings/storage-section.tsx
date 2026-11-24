"use client";

// Page Stockage — explorateur déclaratif des documents générés (v0.3.0).
// Spec §4 : liste intégrale sans pagination, groupement par projet côté
// client, déroulé DÉRIVÉ (jamais stocké), bandeau de résultats, undo 7 s.
// Correctifs de vérification intégrés :
//   C2 — écoute storage:changed (multi-fenêtres) ;
//   C3 — refetch SILENCIEUX après mutation (pas de squelette qui clignote) ;
//   C4 — bandeau « Aucun fichier ne correspond » + badges 22 px ;
//   C5 — chien de garde 8 s sur l'ack (service muet → erreur honnête) ;
//   F1 — chien de garde AUSSI au chargement initial ;
//   F2 — pas de double refetch : le broadcast de l'émetteur arrive APRÈS
//        l'ack ; une réinventaire silencieuse idempotente suffit ;
//   F4 — filtre type conservé même si la dernière ligne du type part.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { Pin, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getSocket } from "@/lib/socket";
import {
  STORAGE_UNDO_MS,
  formatArtifactBytes,
  isStorageCleanable,
} from "@/lib/chat-types";
import type {
  StorageEntry,
  StorageMutationResult,
  StorageMutationError,
  StorageUndoResult,
} from "@/lib/chat-types";

// ── Outillage local (i18n FR — §6 : tailles en octets, formatées à l'affichage) ──

/** Normalisation sans accents pour la recherche (spec §4.4). */
function norm(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const df = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

/** Chien de garde de l'inventaire — un seul endroit pour le texte FR. */
const STORAGE_WATCHDOG_MS = 8_000;

/** Date SQLite ("2026-11-20 12:34:56") → Date valide, TOUT navigateur :
 *  l'espace devient un « T », l'heure manquante vaut midi (le tri par date
 *  reste correct au sein d'un même jour ; le fuseau est neutre).
 *  Lot audit 2026-11-21 : le test de présence d'heure se fait sur la chaîne
 *  NORMALISÉE — l'ancien code testait la chaîne originale et produisait
 *  « …T12:34:56T12:00:00 » (Invalid Date → toutes les dates devenaient
 *  aujourd'hui dès qu'une ligne arrivait en "YYYY-MM-DD HH:MM:SS"). */
function parseDate(iso: string): Date {
  const hasTime = /\d{2}:\d{2}/.test(iso);
  const normalized =
    /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.replace(" ", "T") + (hasTime ? "" : "T12:00:00") : iso;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

type SortKey = "taille" | "date" | "nom";

/** Ordre d'affichage d'un groupe : tri courant (défaut : taille §4.4). */
function sortEntries(entries: StorageEntry[], tri: SortKey): StorageEntry[] {
  return entries.slice().sort((a, b) => {
    if (tri === "taille") return b.size - a.size;
    if (tri === "date") return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.version - a.version;
    // Tri nominal : comparaison « fr » TOLÉRANTE (deux noms proches se
    // départagent ensuite par numéro de version décroissant).
    return (a.name ?? "").localeCompare(b.name ?? "", "fr") || b.version - a.version;
  });
}

interface ProjectGroup {
  id: string | null;
  name: string;
  hors: boolean;
  entries: StorageEntry[];
  bytes: number;
  cleanableBytes: number;
}

/** Groupement client (§4.1) : liste plate → groupes par projet,
 *  « Hors projet » TOUJOURS en dernier, ordre stable par insertion. */
function groupByProject(entries: StorageEntry[]): ProjectGroup[] {
  const order: (string | null)[] = [];
  const byId = new Map<string, ProjectGroup>();
  let hors: ProjectGroup | null = null;
  for (const e of entries) {
    if (e.projectId === null) {
      if (!hors) hors = { id: null, name: "Hors projet", hors: true, entries: [], bytes: 0, cleanableBytes: 0 };
      push(hors, e);
      continue;
    }
    let g = byId.get(e.projectId);
    if (!g) {
      g = { id: e.projectId, name: e.projectName, hors: false, entries: [], bytes: 0, cleanableBytes: 0 };
      byId.set(e.projectId, g);
      order.push(e.projectId);
    }
    push(g, e);
  }
  // « Hors projet » TOUJOURS en dernier ; l'ordre des projets suit la
  // première rencontre dans l'inventaire (stable d'un chargement à l'autre).
  const groups = order.map((id) => byId.get(id as string)!);
  if (hors) groups.push(hors);
  return groups;

  function push(g: ProjectGroup, e: StorageEntry): void {
    g.entries.push(e);
    g.bytes += e.size;
  }
}

/** Clé de verrou TOUJOURS non nulle (lot audit passe 2) : « Hors projet » a
 *  id === null et l'état busy vaut aussi null au repos — un verrou posé sur
 *  g.id serait donc pris en permanence pour ce groupe (bouton « Nettoyer »
 *  figé sur « Nettoyage… », désactivé, insensible au clic). */
function groupKey(g: ProjectGroup): string {
  return g.id ?? "__hors";
}

/** Dernière version par document — badges + refus de suppression. */
function maxByDocOf(entries: StorageEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.conversationId}\u0000${e.key}`;
    const cur = m.get(k) ?? 0;
    if (e.version > cur) m.set(k, e.version);
  }
  return m;
}

// ── Composants ────────────────────────────────────────────────────────────

function KindBadge({ kind }: { kind: string }) {
  const label =
    { html: "HTML", svg: "SVG", image: "IMG", markdown: "MD", code: "CODE", csv: "CSV", json: "JSON", pdf: "PDF" }[
      kind
    ] ?? kind.toUpperCase().slice(0, 4);
  return (
    <span className="grid h-[22px] w-[34px] flex-none place-items-center rounded-[4px] bg-muted text-[8.5px] font-bold tracking-[0.03em] text-muted-foreground">
      {label}
    </span>
  );
}

function VersionTag({ entry, isLast }: { entry: StorageEntry; isLast: boolean }) {
  return (
    <span
      className={cn(
        "flex-none rounded-full px-[7px] py-px text-[9.5px] font-bold",
        isLast ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
      )}
    >
      v{entry.version}
    </span>
  );
}

// ── Page (§4) ─────────────────────────────────────────────────────────────

// ── Découpage en feuilles (chantier CRAP vague 7 UI, 2026-11-24) ────────
// Le composant StorageSection (CC 105 au crapper) est démonté : cinq
// feuilles appelées dans l'ordre du rendu, corps déplacés VERBATIM (aucune
// ligne de JSX ni de handler modifiée — les closures deviennent des props
// typées du même nom), par chirurgie ancrée (ce script, versionné) :
//   StorageCompteurs     — le bandeau des compteurs globaux (§4.1) ;
//   StorageBarreFiltres  — la barre recherche / tri / filtres par type (§4.1) ;
//   StorageBandeau       — le bandeau de résultats du filtrage (§2.2, C4) ;
//   StorageGroupe        — un groupe projet : déroulé dérivé, en-tête
//                          (compteurs + « Nettoyer » en place), lignes
//                          triées, projet vidé (§2.2, §4.2) ;
//   StorageToasts        — les bandeaux d'annulation « Annuler » 7 s (§4.5).
// Tout l'état reste dans l'orchestrateur (StorageSection) : inventaire,
// filtres, verrou busy, freedTotal, toasts, demandes d'inventaire et
// mutations socket. La ref inputRef reste à l'orchestrateur et descend en
// props (convention RefObject du repo, cf. composer.tsx). Structure DOM
// inchangée (mêmes nœuds dans le même ordre) ; props publiques de
// StorageSection inchangées. Les feuilles à plusieurs enfants racine (un
// commentaire JSX compte comme un enfant) sont enveloppées dans un
// fragment — aucun nœud DOM ajouté.

/** Feuille 1 — le bandeau des compteurs globaux (§4.1). Corps déplacé
 *  VERBATIM de l'orchestrateur (chantier CRAP vague 7 UI, 2026-11-24). */
interface StorageCompteursProps {
  loading: boolean;
  error: string | null;
  totaux: { docs: number; bytes: number; cleanable: number };
  freedTotal: { n: number; bytes: number };
}

function StorageCompteurs({ loading, error, totaux, freedTotal }: StorageCompteursProps) {
  return (
    <>
      {/* Compteurs globaux (§4.1 — pas de « Tout nettoyer » global : le
          nettoyage reste une action par projet) */}
      <div className="mt-4 rounded-xl border border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold">Documents générés</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              {loading
                ? "Chargement de l'inventaire…"
                : error
                  ? "Inventaire indisponible."
                  : `${totaux.docs} versions · ${formatArtifactBytes(totaux.bytes)} au total · dont ${formatArtifactBytes(totaux.cleanable)} récupérables par nettoyage`}
            </div>
          </div>
          {freedTotal.n > 0 ? (
            <span className="flex-none text-[11px] font-semibold text-success" role="status">
              ✓ {freedTotal.n} fichiers supprimés · {formatArtifactBytes(freedTotal.bytes)} libérés (mesuré)
            </span>
          ) : (
            <span className="max-w-[300px] flex-none text-[11px] leading-snug text-muted-foreground">
              Le nettoyage s&apos;applique projet par projet ; chaque suppression est annulable
              pendant {STORAGE_UNDO_MS / 1000} secondes.
            </span>
          )}
        </div>
      </div>
    </>
  );
}

/** Feuille 2 — la barre recherche / tri / filtres par type (§4.1). Corps
 *  déplacé VERBATIM de l'orchestrateur (chantier CRAP vague 7 UI,
 *  2026-11-24) ; la ref du champ de recherche reste au parent et descend
 *  en props (convention RefObject du repo). */
interface StorageBarreFiltresProps {
  inputRef: RefObject<HTMLInputElement | null>;
  recherche: string;
  setRecherche: Dispatch<SetStateAction<string>>;
  tri: SortKey;
  setTri: Dispatch<SetStateAction<SortKey>>;
  types: string[];
  type: string;
  setType: Dispatch<SetStateAction<string>>;
  setProjetOuvert: Dispatch<SetStateAction<string | null>>;
}

function StorageBarreFiltres({
  inputRef,
  recherche,
  setRecherche,
  tri,
  setTri,
  types,
  type,
  setType,
  setProjetOuvert,
}: StorageBarreFiltresProps) {
  return (
    <>
        {/* Barre recherche / tri / filtres (§4.1) */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 pt-2.5">
          <div className="flex min-w-[170px] flex-1 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-muted-foreground focus-within:border-hermes/60">
            <Search className="size-[13px] flex-none" strokeWidth={2} />
            <Input
              ref={inputRef}
              type="search"
              value={recherche}
              onChange={(e) => {
                setRecherche(e.target.value);
                // Fin de filtrage par champ vidé (§4.2 : retour au repli).
                if (e.target.value.trim() === "" && type === "Tous") setProjetOuvert(null);
              }}
              placeholder="Rechercher un fichier…"
              aria-label="Rechercher un fichier par nom"
              className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[12.5px] text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 md:text-[12.5px]"
            />
            {recherche !== "" ? (
              <Button
                type="button"
                variant="link"
                onClick={() => {
                  setRecherche("");
                  if (type === "Tous") setProjetOuvert(null);
                  inputRef.current?.focus();
                }}
                className="h-auto flex-none px-0 py-0 text-[11.5px] font-semibold text-hermes-text hover:underline"
              >
                effacer
              </Button>
            ) : null}
          </div>
          <select
            value={tri}
            onChange={(e) => setTri(e.target.value as SortKey)}
            aria-label="Trier les versions"
            className="h-[34px] flex-none cursor-pointer rounded-md border border-border bg-card px-2 text-[12px] font-semibold text-foreground outline-none focus-visible:border-hermes/60"
          >
            <option value="taille">Tri : taille</option>
            <option value="date">Tri : date</option>
            <option value="nom">Tri : nom</option>
          </select>
          <div role="group" aria-label="Filtrer par type" className="flex w-full flex-wrap gap-1 pb-2.5 pt-1">
            {types.map((t) => (
              <Button
                key={t}
                type="button"
                variant="ghost"
                onClick={() => {
                  setType(t);
                  // Fin de filtrage par retour au type « Tous » (§4.2).
                  if (t === "Tous" && recherche.trim() === "") setProjetOuvert(null);
                }}
                aria-pressed={type === t}
                className={cn(
                  "cursor-pointer rounded-full border px-[11px] py-[3px] text-[11px] font-semibold transition-colors",
                  type === t
                    ? "border-transparent bg-hermes/10 text-hermes-text"
                    : "border-border bg-card text-muted-foreground hover:border-hermes/50 hover:text-hermes-text"
                )}
              >
                {t}
              </Button>
            ))}
          </div>
        </div>
    </>
  );
}

/** Feuille 3 — le bandeau de résultats du filtrage (§2.2 : affiché pendant
 *  TOUT le filtrage, compteurs et bouton d'effacement identiques au cas
 *  vide, C4). Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP
 *  vague 7 UI, 2026-11-24) ; finFiltrage reste calculée au parent. */
interface StorageBandeauProps {
  filtrageActif: boolean;
  loading: boolean;
  error: string | null;
  entries: StorageEntry[] | null;
  qNorm: string;
  type: string;
  finFiltrage: (focus: HTMLElement | null) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

function StorageBandeau({
  filtrageActif,
  loading,
  error,
  entries,
  qNorm,
  type,
  finFiltrage,
  inputRef,
}: StorageBandeauProps) {
  return (
    <>
        {/* Bandeau de résultats (§2.2 : affiché pendant TOUT le filtrage —
            compteurs et bouton d'effacement identiques au cas vide, C4) */}
        {filtrageActif && !loading && !error ? (
          (() => {
            const nb = (entries ?? []).filter(
              (e) =>
                (qNorm === "" || norm(e.name).includes(qNorm)) &&
                (type === "Tous" || e.kind.toUpperCase() === type)
            ).length;
            return (
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3.5 py-2 text-[11.5px] text-muted-foreground">
                {nb > 0 ? (
                  <span>
                    <b className="text-foreground">{nb}</b> fichiers correspondent
                  </span>
                ) : (
                  <span>Aucun fichier ne correspond</span>
                )}
                <Button
                  type="button"
                  variant="link"
                  // Lot audit : le focus retourne au champ de recherche —
                  // l'ancienne cible (le bouton « effacer les filtres »
                  // lui-même) se démontait juste après : focus perdu.
                  onClick={() => finFiltrage(inputRef.current)}
                  className="h-auto px-0 py-0 font-semibold text-hermes-text hover:underline"
                >
                  effacer les filtres
                </Button>
              </div>
            );
          })()
        ) : null}
    </>
  );
}

/** Feuille 4 — un groupe projet : dérivation du déroulé (§4.2 — jamais
 *  stocké), en-tête (compteurs + « Nettoyer » en place, replié §2.2),
 *  lignes triées, projet vidé. Corps déplacé VERBATIM de l'orchestrateur
 *  (chantier CRAP vague 7 UI, 2026-11-24) ; les callbacks de mutation
 *  (deleteVersion, cleanProject) et le verrou busy restent au parent et
 *  descendent en props. La clé de liste est posée sur l'appel. */
interface StorageGroupeProps {
  g: ProjectGroup;
  filtrageActif: boolean;
  projetOuvert: string | null;
  setProjetOuvert: Dispatch<SetStateAction<string | null>>;
  resultatsDe: (g: ProjectGroup) => StorageEntry[];
  tri: SortKey;
  maxByDoc: Map<string, number>;
  busy: string | null;
  deleteVersion: (e: StorageEntry) => void;
  cleanProject: (g: ProjectGroup) => void;
}

function StorageGroupe({
  g,
  filtrageActif,
  projetOuvert,
  setProjetOuvert,
  resultatsDe,
  tri,
  maxByDoc,
  busy,
  deleteVersion,
  cleanProject,
}: StorageGroupeProps) {
                // Dérivation du déroulé (§4.2 — jamais stocké). Le lien
                // profond porte un NOM de projet (?projet=…) : la
                // comparaison accepte id OU nom (F3), le clic interne
                // utilise toujours l'id.
                const res = filtrageActif ? resultatsDe(g) : null;
                const deroule =
                  filtrageActif ? (res?.length ?? 0) > 0
                  : g.id !== null && (projetOuvert === g.id || projetOuvert === g.name);
                const masque = filtrageActif && (res?.length ?? 0) === 0;
                const visibles = filtrageActif ? res! : g.entries;
                return (
                  <section
                    key={g.id ?? "__hors"}
                    className={cn("border-t border-border first:border-t-0", masque && "hidden")}
                    aria-label={"Projet " + g.name}
                  >
                    {/* En-tête : compteurs + Nettoyer en place, fonctionne
                        replié (§2.2 « nettoyer sans déplier »).
                        Lot audit : le déroulé est un VRAI <button> (le
                        conteneur role="button" avec un <button> Nettoyer
                        imbriqué violait ARIA : descendants interactifs
                        interdits). */}
                    <div
                      className={cn(
                        "flex w-full flex-wrap items-center gap-2.5 px-3 py-2",
                        !filtrageActif && "hover:bg-muted"
                      )}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        tabIndex={filtrageActif ? -1 : 0}
                        aria-expanded={deroule}
                        aria-disabled={filtrageActif ? true : undefined}
                        aria-label={`${g.name} — ${g.entries.length} documents, ${formatArtifactBytes(g.bytes)}`}
                        onClick={() => {
                          // Repliage manuel IGNORÉ pendant un filtrage actif (§2.2).
                          if (filtrageActif) return;
                          // Accordéon exclusif par construction.
                          setProjetOuvert((p) => (p === g.id ? null : g.id));
                        }}
                        className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-2.5 rounded-sm px-0 py-0 text-left hover:bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-hermes"
                      >
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px] font-bold",
                            g.hors && "font-semibold text-muted-foreground"
                          )}
                        >
                          {g.name}
                        </span>
                        <span className="flex-none text-[11.5px] whitespace-nowrap text-muted-foreground tabular-nums">
                          {g.entries.length}
                          {g.entries.length > 1 ? " documents" : " document"} · {formatArtifactBytes(g.bytes)}
                        </span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          // « Nettoyer » ne déplie JAMAIS le groupe (§2.2).
                          cleanProject(g);
                        }}
                        disabled={busy === groupKey(g)}
                        className="flex-none rounded-sm border border-border bg-card px-2.5 py-[5px] text-[11px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text disabled:cursor-wait disabled:opacity-40"
                      >
                        {busy === groupKey(g) ? "Nettoyage…" : "Nettoyer"}
                      </Button>
                    </div>

                    {/* Lignes du groupe — déroulé dérivé (animation : rangées
                        de grille, jamais de mesure JS — §6 ; motion-safe) */}
                    <div
                      className={cn(
                        "grid transition-[grid-template-rows] duration-150 motion-reduce:transition-none",
                        deroule ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                      )}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <div className="pb-2.5 pl-[22px] pr-1.5">
                          {sortEntries(visibles, tri).map((e) => {
                            const estDerniere = e.version === maxByDoc.get(`${e.conversationId}\u0000${e.key}`);
                            // La version épinglée n'est jamais supprimable :
                            // bouton désactivé + titre explicatif (§2.2), le
                            // service refuse aussi (409) même si l'UI échoue.
                            const bloquee = e.pinned;
                            return (
                              <div
                                key={e.id}
                                className="flex items-center gap-2 rounded-sm px-1.5 py-1.5 text-[12px] hover:bg-muted"
                              >
                                <KindBadge kind={e.kind} />
                                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                  <span className="truncate font-medium">{e.name}</span>
                                  <VersionTag entry={e} isLast={!!estDerniere} />
                                  {bloquee ? (
                                    <span className="flex flex-none text-warning" title="Version épinglée — non supprimable">
                                      <Pin className="size-[11px]" strokeWidth={2} />
                                    </span>
                                  ) : null}
                                </span>
                                <span className="flex-none text-[11.5px] whitespace-nowrap text-muted-foreground tabular-nums">
                                  {formatArtifactBytes(e.size)} · {df.format(parseDate(e.createdAt))}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  onClick={() => deleteVersion(e)}
                                  disabled={bloquee || busy === e.id}
                                  title={
                                    bloquee
                                      ? "Version épinglée — non supprimable"
                                      : `Supprimer ${e.name} v${e.version}`
                                  }
                                  aria-label={
                                    bloquee
                                      ? `${e.name} v${e.version} — version épinglée, non supprimable`
                                      : `Supprimer ${e.name} v${e.version}`
                                  }
                                  className="grid size-6 flex-none place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                                >
                                  <Trash2 className="size-[13px]" strokeWidth={2} />
                                </Button>
                              </div>
                            );
                          })}
                          {/* Projet vidé : en-tête conservé (§2.2), message honnête */}
                          {visibles.length === 0 && !filtrageActif ? (
                            <div className="px-1.5 py-2 text-center text-[12px] text-muted-foreground">
                              Aucune version — ce projet a été entièrement nettoyé.
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </section>
                );
}

/** Feuille 5 — les bandeaux d'annulation (§4.5 — toasts « Annuler » 7 s).
 *  Corps déplacé VERBATIM de l'orchestrateur (chantier CRAP vague 7 UI,
 *  2026-11-24) ; le tableau des toasts et undo restent à l'orchestrateur. */
interface StorageToastsProps {
  toasts: Array<{
    key: number;
    title: string;
    description: string;
    tone: "ok" | "err" | "warn";
    undo?: { token: string; bytes: number; n: number };
    expireAt: number;
  }>;
  undo: (token: string, bytes: number, n: number) => void;
}

function StorageToasts({ toasts, undo }: StorageToastsProps) {
  return (
    <>
      {/* Bandeaux d'annulation (§4.5 — toasts « Annuler » 7 s) */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.key}
            className={cn(
              "pointer-events-auto flex max-w-[520px] flex-wrap items-center gap-3 rounded-xl border px-4 py-2.5 shadow-lg",
              t.tone === "ok" && "border-border bg-card text-foreground",
              t.tone === "err" && "border-destructive/40 bg-destructive/10 text-foreground",
              t.tone === "warn" && "border-warning/40 bg-warning/10 text-foreground"
            )}
            role={t.tone === "ok" ? "status" : "alert"}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold">{t.title}</div>
              <div className="text-[11.5px] leading-snug text-muted-foreground">{t.description}</div>
            </div>
            {t.undo ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void undo(t.undo!.token, t.undo!.bytes, t.undo!.n)}
                disabled={Date.now() >= t.expireAt}
                title={Date.now() >= t.expireAt ? "Fenêtre d'annulation expirée" : undefined}
                className="flex-none rounded-md border border-border bg-background px-3 py-1.5 text-[12px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text disabled:cursor-not-allowed disabled:opacity-40"
              >
                Annuler
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

export function StorageSection({ initialProject }: { initialProject?: string | null }) {
  const [entries, setEntries] = useState<StorageEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recherche, setRecherche] = useState("");
  const [type, setType] = useState("Tous");
  const [tri, setTri] = useState<SortKey>("taille");
  const [projetOuvert, setProjetOuvert] = useState<string | null>(initialProject ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [freedTotal, setFreedTotal] = useState<{ n: number; bytes: number }>({ n: 0, bytes: 0 });
  const [toasts, setToasts] = useState<
    Array<{
      key: number;
      title: string;
      description: string;
      tone: "ok" | "err" | "warn";
      undo?: { token: string; bytes: number; n: number };
      expireAt: number;
    }>
  >([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Anti-fuite : un ack qui arrive après le démontage ne setState pas.
  const mountedRef = useRef(true);
  const toastSeq = useRef(0);
  // Lot audit : compteur de requêtes — le chien de garde d'une requête A
  // traîarde n'affiche plus l'erreur si une requête B (broadcast, réessai)
  // a déjà répondu entre-temps.
  const reqSeqRef = useRef(0);
  // Lot audit : re-render à l'expiration d'un toast « Annuler » — le bouton
  // se désactive à la SECONDE où le jeton service meurt (7,0 s), plus
  // d'action proposée alors qu'elle va échouer.
  const [, setExpiryTick] = useState(0);

  /** Ajoute un toast d'annulation (durée = fenêtre + marge d'affichage). */
  const pushToast = useCallback(
    (t: Omit<(typeof toasts)[number], "key" | "expireAt">) => {
      const key = ++toastSeq.current;
      const expireAt = Date.now() + STORAGE_UNDO_MS;
      setToasts((prev) => [...prev.slice(-2), { ...t, key, expireAt }]);
      // À l'expiration : le bouton « Annuler » se désactive (re-render),
      // le bandeau reste 1,5 s de plus pour être lu.
      window.setTimeout(() => setExpiryTick((v) => v + 1), STORAGE_UNDO_MS);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.key !== key));
      }, STORAGE_UNDO_MS + 1500);
    },
    []
  );

  /**
   * Demande l'inventaire. `silencieux` : rafraîchissement APRÈS une mutation
   * ou un broadcast storage:changed — les données restent visibles pendant
   * l'échange (§4.3 « réinterrogé en préservant l'état » ; C3).
   * Chien de garde 8 s dans TOUS les cas (C5 + F1) : un service muet
   * aboutit à l'écran d'erreur, jamais à un chargement éternel.
   */
  const demandeInventaire = useCallback((silencieux: boolean) => {
    const seq = ++reqSeqRef.current;
    const garde = window.setTimeout(() => {
      if (!mountedRef.current || seq !== reqSeqRef.current) return;
      setLoading(false);
      setError(
        `Le service n'a pas répondu (${STORAGE_WATCHDOG_MS / 1000} s).`
      );
    }, STORAGE_WATCHDOG_MS);
    getSocket().emit(
      "storage:list",
      (res: { entries?: StorageEntry[] } | { error?: string } = {}) => {
        window.clearTimeout(garde);
        if (!mountedRef.current || seq !== reqSeqRef.current) return;
        setLoading(false);
        if ("entries" in res && Array.isArray(res.entries)) {
          setEntries(res.entries);
          setError(null);
        } else {
          setError("L'inventaire n'a pas pu être lu — un outil de nettoyage n'affiche jamais de données périmées.");
          if (!silencieux) setEntries(null);
        }
      }
    );
  }, []);

  /** Réessayer (écran d'erreur) : rechargement complet avec squelette. */
  const fetchEntries = useCallback(() => demandeInventaire(false), [demandeInventaire]);

  // Chargement à l'entrée sur la page (§4.3 : à CHAQUE entrée, sans cache
  // entre visites) + écoute storage:changed (C2 — multi-fenêtres : une
  // mutation faite depuis une AUTRE fenêtre diffuse l'événement ; cette
  // fenêtre se réinventaire SILENCIEUSEMENT ; F2 : le broadcast revient
  // AUSSI à l'émetteur — la réinventaire idempotente l'absorbe sans
  // double clignotement, sans squelette).
  useEffect(() => {
    mountedRef.current = true;
    demandeInventaire(false);
    const onStorageChanged = () => demandeInventaire(true);
    getSocket().on("storage:changed", onStorageChanged);
    return () => {
      mountedRef.current = false;
      getSocket().off("storage:changed", onStorageChanged);
    };
  }, [demandeInventaire]);

  // ── Déballage des filtres (§4.2 : les trois déclencheurs confondus) ────
  const filtrageActif = recherche.trim() !== "" || type !== "Tous";
  const qNorm = norm(recherche.trim());
  // F4 — les chips reflètent les types PRÉSENTS à l'inventaire (Tous
  // toujours) : un filtre pressé reste affiché même si sa dernière ligne
  // vient de partir (l'utilisateur voit le bandeau « Aucun », pas une
  // puce qui disparaît sous son doigt).
  const types = useMemo(() => {
    const kinds = new Set<string>((entries ?? []).map((e) => e.kind.toUpperCase()));
    return ["Tous", ...Array.from(kinds).sort()];
  }, [entries]);

  const groupes = useMemo(() => groupByProject(entries ?? []), [entries]);
  const maxByDoc = useMemo(() => maxByDocOf(entries ?? []), [entries]);

  /** Résultats d'un groupe sous le filtre courant (§4.2). */
  const resultatsDe = useCallback(
    (g: ProjectGroup) =>
      g.entries.filter(
        (e) => (qNorm === "" || norm(e.name).includes(qNorm)) && (type === "Tous" || e.kind.toUpperCase() === type)
      ),
    [qNorm, type]
  );

  // ── Compteurs globaux (en-tête de page — §4.1) ─────────────────────────
  const totaux = useMemo(() => {
    let bytes = 0;
    let cleanable = 0;
    for (const g of groupes) {
      bytes += g.bytes;
      const maxDoc = maxByDoc;
      cleanable += g.entries
        .filter((e) => isStorageCleanable(e, maxDoc.get(`${e.conversationId}\u0000${e.key}`) ?? 0))
        .reduce((s, e) => s + e.size, 0);
    }
    return { docs: (entries ?? []).length, bytes, cleanable };
  }, [groupes, entries, maxByDoc]);

  /** Fin de filtrage : retour au repli + focus au déclencheur (§4.4). */
  const finFiltrage = (focus: HTMLElement | null) => {
    setRecherche("");
    setType("Tous");
    setProjetOuvert(null);
    if (focus) focus.focus();
  };

  // ── Opérations destructrices (§4.5) ─────────────────────────────────────
  // Chaque suppression ouvre un bandeau « Annuler » de 7 s (jeton du
  // service) ; le volume annoncé est le delta MESURÉ renvoyé par l'opération.

  const undo = useCallback(
    (token: string, bytes: number, n: number) => {
      getSocket().emit(
        "storage:undo",
        { token },
        (res: StorageUndoResult | StorageMutationError = {} as StorageMutationError) => {
          if (!mountedRef.current) return;
          if ("ok" in res && res.ok) {
            setFreedTotal((t) => ({ n: t.n - n, bytes: t.bytes - bytes }));
            pushToast({
              title: "Annulation faite",
              description: n + " version" + (n > 1 ? "s" : "") + " restaurée" + (n > 1 ? "s" : "") + ".",
              tone: "ok",
            });
          } else {
            // Lot audit : ne plus annoncer « fenêtre expirée » pour TOUT
            // échec — seul l'échec d'expiration a ce message.
            const expired =
              "error" in res && /expir/i.test(res.error ?? "");
            pushToast({
              title: expired
                ? "Fenêtre d'annulation expirée"
                : "Annulation impossible",
              description: expired
                ? `Les ${STORAGE_UNDO_MS / 1000} secondes sont passées — la suppression est définitive.`
                : "error" in res && res.error
                  ? res.error
                  : "La suppression reste en place.",
              tone: "warn",
            });
          }
        }
      );
    },
    [pushToast]
  );

  const deleteVersion = (e: StorageEntry) => {
    // Revue P1-P7 : verrou GLOBAL — l'ancien test (busy === e.id) autorisait
    // deux suppressions parallèles sur deux lignes, et l'ack de la première
    // libérait le verrou pendant que la seconde volait encore.
    if (busy) return;
    setBusy(e.id);
    // Chien de garde : sans ack, le bouton restait en échec silencieux et
    // la ligne re-supprimable en double-clic.
    const garde = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setBusy(null);
      pushToast({
        title: "Le service n'a pas répondu",
        description: `Suppression non confirmée (${STORAGE_WATCHDOG_MS / 1000} s) — réessayez.`,
        tone: "warn",
      });
    }, STORAGE_WATCHDOG_MS);
    getSocket().emit(
      "storage:deleteVersion",
      { id: e.id },
      (res: StorageMutationResult | StorageMutationError = {} as StorageMutationError) => {
        window.clearTimeout(garde);
        if (!mountedRef.current) return;
        setBusy(null);
        if ("ok" in res && res.ok) {
          setFreedTotal((t) => ({ n: t.n + res.removed, bytes: t.bytes + res.bytesFreed }));
          pushToast({
            title: "« " + e.name + " » (v" + e.version + ") supprimée",
            description:
              formatArtifactBytes(res.bytesFreed) +
              " libérés — annulable pendant " + STORAGE_UNDO_MS / 1000 + " secondes.",
            tone: "ok",
            undo: res.undoToken ? { token: res.undoToken, bytes: res.bytesFreed, n: res.removed } : undefined,
          });
          // Le refetch silencieux suit l'ack (C3) ; le broadcast
          // storage:changed déclenchera une réinventaire idempotente (F2).
        } else {
          // Échec par ligne : message ciblé, ligne conservée, compteurs
          // intacts (§4.5 — jamais de demi-suppression comptée comme succès).
          pushToast({
            title:
              "code" in res && res.code === "pinned"
                ? "Version épinglée — la suppression est refusée."
                : "Échec de la suppression",
            description:
              "error" in res && res.error ? res.error : "La ligne est conservée, rien n'a été décompté.",
            tone: "err",
          });
        }
      }
    );
  };

  const cleanProject = (g: ProjectGroup) => {
    const k = groupKey(g);
    // Revue P1-P7 : même verrou global que deleteVersion — une seule
    // mutation de stockage à la fois, quel que soit le groupe.
    if (busy) return;
    setBusy(k);
    // Lot audit : chien de garde — « Nettoyage… » ne reste plus figé pour
    // toujours si le service n'acquitte pas.
    const garde = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setBusy(null);
      pushToast({
        title: "Le service n'a pas répondu",
        description: `Nettoyage non confirmé (${STORAGE_WATCHDOG_MS / 1000} s) — réessayez.`,
        tone: "warn",
      });
    }, STORAGE_WATCHDOG_MS);
    getSocket().emit(
      "storage:cleanProject",
      { projectId: g.id },
      (res: StorageMutationResult | StorageMutationError = {} as StorageMutationError) => {
        window.clearTimeout(garde);
        if (!mountedRef.current) return;
        setBusy(null);
        if ("ok" in res && res.ok) {
          if (res.removed === 0) {
            pushToast({
              title: "Rien à nettoyer dans « " + g.name + " »",
              description: "Les dernières versions de chaque document sont conservées — seules les versions dépassées partent.",
              tone: "ok",
            });
            return;
          }
          setFreedTotal((t) => ({ n: t.n + res.removed, bytes: t.bytes + res.bytesFreed }));
          pushToast({
            title: res.removed + " versions supprimées dans « " + g.name + " »",
            description:
              formatArtifactBytes(res.bytesFreed) +
              " libérés (mesuré) — annulable pendant " + STORAGE_UNDO_MS / 1000 + " secondes.",
            tone: "ok",
            undo: res.undoToken ? { token: res.undoToken, bytes: res.bytesFreed, n: res.removed } : undefined,
          });
        } else {
          pushToast({
            title: "Le nettoyage de « " + g.name + " » a échoué.",
            description: "error" in res && res.error ? res.error : "Aucune ligne n'a été touchée.",
            tone: "err",
          });
        }
      }
    );
  };

  // ── Rendu ────────────────────────────────────────────────────────────────
  return (
    <section aria-label="Stockage des documents générés" className="mx-auto w-full max-w-[880px]">
      <h1 className="text-[19px] font-bold tracking-tight">Stockage</h1>
      <p className="mt-1 mb-2 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Tous les documents générés par vos conversations, groupés par projet.
        Les versions dépassées peuvent être nettoyées ; les documents épinglés
        sont toujours conservés.
      </p>

      <StorageCompteurs
        loading={loading}
        error={error}
        totaux={totaux}
        freedTotal={freedTotal}
      />

      {/* Explorateur (liste intégrale : aucune pagination — §2.3) */}
      <div className="mt-3 overflow-hidden rounded-xl border border-border">
        <StorageBarreFiltres
          inputRef={inputRef}
          recherche={recherche}
          setRecherche={setRecherche}
          tri={tri}
          setTri={setTri}
          types={types}
          type={type}
          setType={setType}
          setProjetOuvert={setProjetOuvert}
        />

        <StorageBandeau
          filtrageActif={filtrageActif}
          loading={loading}
          error={error}
          entries={entries}
          qNorm={qNorm}
          type={type}
          finFiltrage={finFiltrage}
          inputRef={inputRef}
        />

        {/* Corps : squelette (§4.3), erreur avec Réessayer, ou groupes */}
        <div>
          {loading ? (
            <div className="px-3 pb-3.5 pt-1" aria-label="Chargement en cours" role="status">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="mt-2 h-[34px] animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : error ? (
            <div className="px-5 py-8 text-center" role="alert">
              <div className="text-[13.5px] font-semibold">Impossible de charger le stockage</div>
              <div className="mx-auto mt-1.5 max-w-[420px] text-[12.5px] leading-relaxed text-muted-foreground">
                {error} Rien n&apos;est mis en cache : réessayez quand le service répond.
              </div>
              <Button
                type="button"
                variant="primary"
                onClick={() => fetchEntries()}
                className="mt-4 inline-flex h-8 cursor-pointer items-center justify-center rounded-md bg-hermes-strong px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90"
              >
                Réessayer
              </Button>
            </div>
          ) : (
            <div>
              {groupes.map((g) => (
                <StorageGroupe
                  key={g.id ?? "__hors"}
                  g={g}
                  filtrageActif={filtrageActif}
                  projetOuvert={projetOuvert}
                  setProjetOuvert={setProjetOuvert}
                  resultatsDe={resultatsDe}
                  tri={tri}
                  maxByDoc={maxByDoc}
                  busy={busy}
                  deleteVersion={deleteVersion}
                  cleanProject={cleanProject}
                />
              ))}
              {/* Inventaire vide (aucun document du tout) */}
              {groupes.length === 0 ? (
                <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground">
                  Aucun document généré pour l&apos;instant — les fichiers produits par vos
                  conversations apparaîtront ici, groupés par projet.
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <StorageToasts toasts={toasts} undo={undo} />

    </section>
  );
}
