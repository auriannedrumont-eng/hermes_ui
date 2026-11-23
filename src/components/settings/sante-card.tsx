"use client";

// Carte « Dernier démarrage » (§10 refonte (68), loi « une seule vérité »).
// Le lanceur écrit un manifeste à chaque phase de son démarrage (prérequis
// ✓/✗, état de l'agent, maillons, verdict, cause d'échec éventuelle) ; le
// mini-service le relaie dans system:update-state — la fenêtre du lanceur
// et cet écran disent enfin la même chose, avec les mêmes mots. Manifeste
// absent (lanceur d'une version antérieure, ou premier boot jamais
// terminé) → la carte ne s'affiche pas : rien d'inventé.
import { useEffect, useState } from "react";
import { Pastille } from "@/components/settings/bits";
import { getSocket } from "@/lib/socket";

interface SantePrerequis {
  nom: string;
  ok: boolean;
  note: string;
}
interface SanteManifeste {
  horodatage: string;
  commit: string;
  pret: string;
  cause: string;
  prerequis: SantePrerequis[];
  agent: { etat: string; cause: string };
  maillons: { service: string; interface: string; passerelle: string; agent: string };
}

export function SanteCard() {
  const [manifeste, setManifeste] = useState<SanteManifeste | null>(null);
  useEffect(() => {
    const socket = getSocket();
    const onState = (payload: unknown) => {
      const m = (payload as { manifeste?: SanteManifeste | null })?.manifeste;
      if (m) setManifeste(m);
    };
    socket.on("system:update-state", onState);
    return () => {
      socket.off("system:update-state", onState);
    };
  }, []);
  if (!manifeste) return null;
  const echec = manifeste.pret === "echec";
  const pret = manifeste.pret === "pret";
  const tone = echec ? "err" : pret ? "ok" : "busy";
  const label = echec ? "interrompu" : pret ? "tout est allumé" : "en cours";
  const heure = (() => {
    const d = new Date(manifeste.horodatage);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  })();
  const maillonsActifs = Object.values(manifeste.maillons).filter((m) =>
    m.startsWith("répond")
  ).length;
  return (
    <section aria-labelledby="t-sante" className="rounded-xl border border-border bg-card px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3.5 gap-y-2">
        <h2 id="t-sante" className="flex flex-wrap items-center gap-2.5 text-[14px] font-bold">
          Dernier démarrage <Pastille tone={tone} label={label} />
        </h2>
        {heure ? (
          <p className="text-[11px] text-muted-foreground">aujourd&apos;hui à {heure}</p>
        ) : null}
      </div>
      {echec && manifeste.cause ? (
        <p className="mt-1.5 max-w-[540px] text-[12.5px] font-semibold leading-relaxed text-destructive">
          Le démarrage s&apos;est arrêté ici : {manifeste.cause}
        </p>
      ) : (
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          Ce que le lanceur a vérifié avant d&apos;allumer quoi que ce soit —
          la même liste que dans sa fenêtre.
        </p>
      )}
      {manifeste.prerequis?.length ? (
        <ul className="mt-2.5 space-y-1">
          {manifeste.prerequis.map((p, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px] leading-relaxed">
              <span
                className={p.ok ? "text-success" : "text-destructive"}
                aria-hidden="true"
              >
                {p.ok ? "✓" : "✗"}
              </span>
              <span>
                <span className="font-semibold">{p.nom}</span>
                {p.note ? (
                  <span className="text-muted-foreground"> — {p.note}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px]">
        <span className="text-muted-foreground">
          Agent Hermes&nbsp;:{" "}
          <span className={manifeste.agent.cause ? "text-warning" : "font-semibold text-foreground"}>
            {manifeste.agent.etat}
          </span>
          {manifeste.agent.cause ? (
            <span className="text-muted-foreground"> — {manifeste.agent.cause}</span>
          ) : null}
        </span>
        <span className="text-muted-foreground">
          Maillons répondu&nbsp;: {maillonsActifs}/4
        </span>
      </div>
    </section>
  );
}
