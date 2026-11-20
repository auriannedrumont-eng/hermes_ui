"use client";

// Volet Système — 2 cartes : Mise à jour + Agent Hermes (v0.3.0, spec §3).
// Correctif C1 intégré : la pastille « connecté » de la carte Agent suit
// l'état RÉEL de la socket (prop `connected` du panneau, elle-même du hook
// use-hermes-chat — un seul flux, aucune requête supplémentaire).
import { useCallback, useEffect, useState } from "react";
import { Pastille } from "@/components/settings/bits";
import { getSocket } from "@/lib/socket";

export interface SystemSectionProps {
  /** État RÉEL de la socket vers le service — la pastille « connecté »
   *  de la carte Agent suit ce flux (§3.2). */
  connected?: boolean;
  /** Version installée affichée par la carte Mise à jour. */
  serverVersion?: string | null;
  /** Navigation vers la page Stockage (lien « documents générés »). */
  onNavigateStorage?: () => void;
}

/** Journal de mise à jour du lanceur (relais du fichier journal). */
export function SystemSection({
  connected = true,
  serverVersion = "0.3.0",
  onNavigateStorage,
}: SystemSectionProps) {
  // ── Carte Mise à jour : demande + journal live du lanceur ──────────────
  const [majEtat, setMajEtat] = useState<"inconnu" | "ajour" | "disponible" | "erreur">("inconnu");
  const [majVerifie, setMajVerifie] = useState<string | null>(null);
  const [majDist, setMajDist] = useState<string | null>(null);
  const [majMotif, setMajMotif] = useState<string | null>(null);

  const checkUpdates = useCallback(() => {
    setMajEtat("inconnu");
    setMajMotif(null);
    getSocket().emit(
      "system:update-check",
      (res: { installed?: string; available?: string | null; error?: string } = {}) => {
        if (res?.error) {
          setMajEtat("erreur");
          setMajMotif(res.error);
          return;
        }
        setMajVerifie(new Date().toLocaleTimeString("fr-FR"));
        if (res.available && res.available !== serverVersion) {
          setMajEtat("disponible");
          setMajDist(res.available);
        } else {
          setMajEtat("ajour");
        }
      }
    );
  }, [serverVersion]);

  // Vérification à l'ouverture de la page (spec §3.1) + à la demande.
  useEffect(() => {
    checkUpdates();
  }, [checkUpdates]);

  // ── Carte Agent : état de la socket (flux unique — §3.2) ────────────────
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

  const majChips = {
    inconnu: <Pastille tone="busy">Vérification…</Pastille>,
    ajour: <Pastille tone="ok">À jour</Pastille>,
    disponible: <Pastille tone="warn">Mise à jour disponible</Pastille>,
    erreur: <Pastille tone="err">Erreur</Pastille>,
  }[majEtat];

  const majSub =
    majEtat === "inconnu"
      ? "Interrogation du dépôt de mise à jour…"
      : majEtat === "ajour"
        ? `Vous utilisez Hermes ${serverVersion}, la dernière version publiée.` +
          (majVerifie ? ` Dernière vérification : ${majVerifie}.` : "")
        : majEtat === "disponible"
          ? `Hermes ${majDist} est disponible. Version installée : ${serverVersion}.`
          : `La vérification a échoué : ${majMotif ?? "cause inconnue."} Version installée : ${serverVersion}.`;

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
        {/* ── Zone 1 : Mise à jour (action principale de la page) ────────── */}
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">{majChips}</div>
              <div className="mt-px text-[11.5px] leading-snug text-muted-foreground">{majSub}</div>
            </div>
            <div className="flex flex-none gap-2">
              {majEtat === "ajour" ? (
                <button
                  type="button"
                  onClick={checkUpdates}
                  className="h-8 cursor-pointer rounded-md border border-border bg-card px-3 text-[12px] font-semibold text-foreground transition-colors hover:border-hermes/60 hover:text-hermes-text"
                >
                  Vérifier à nouveau
                </button>
              ) : null}
              {majEtat === "erreur" ? (
                <button
                  type="button"
                  onClick={checkUpdates}
                  className="h-8 cursor-pointer rounded-md bg-hermes px-3 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90"
                >
                  Réessayer
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* ── Zone 2 : Agent Hermes (une ligne d'état ; l'exception au repli) ── */}
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">
                Agent Hermes{" "}
                {connected ? <Pastille tone="ok">Connecté</Pastille> : <Pastille tone="off">Reconnexion en cours</Pastille>}
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
