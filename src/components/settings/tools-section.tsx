// Section « Outils » du volet Paramètres v4 (v2.4) — ce qu'Hermes peut
// faire, outil par outil. Statuts RÉELS uniquement : « Web » suit les clés
// de services (même condition que la bascule du composer), la voix et la
// vision sont livrées, le reste est verrouillé « gateway » (moteur réel,
// FORK.md §4) — aucune donnée simulée.
"use client";

import { cn } from "@/lib/utils";
import { Pastille } from "@/components/settings/bits";
import type { PastilleTone } from "@/components/settings/bits";

interface ToolsSectionProps {
  /** Une clé Tavily/Exa active existe côté service (même calcul que le composer). */
  webSearchAvailable: boolean;
  /** Navigation interne du volet (les lignes renvoient vers la bonne section). */
  onNavigate: (section: string) => void;
}

interface ToolRow {
  name: string;
  desc: string;
  tone: PastilleTone;
  status: string;
  action?: { label: string; section: string };
}

function ToolGroup({
  title,
  rows,
  onNavigate,
}: {
  title: string;
  rows: ToolRow[];
  onNavigate: (section: string) => void;
}) {
  return (
    <div className="mt-4 first:mt-0">
      <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
      <div className="mt-2 rounded-[14px] border border-border px-4 py-1">
        {rows.map((it, i) => (
          <div
            key={it.name}
            className={cn(
              "flex items-center gap-3 py-[11px]",
              i > 0 && "border-t border-border/60"
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">{it.name}</div>
              <div className="mt-px text-[11.5px] leading-snug text-muted-foreground">
                {it.desc}
              </div>
            </div>
            {it.action ? (
              <button
                type="button"
                onClick={() => onNavigate(it.action!.section)}
                className="flex-none cursor-pointer rounded-[8px] px-2 py-1 text-[11.5px] font-semibold text-hermes transition-colors hover:bg-hermes/10"
              >
                {it.action.label}
              </button>
            ) : null}
            <Pastille tone={it.tone} label={it.status} className="flex-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ToolsSection({ webSearchAvailable, onNavigate }: ToolsSectionProps) {
  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Outils</h1>
      <p className="mt-1 mb-2 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
        Ce qu&apos;Hermes peut faire, outil par outil. Les changements
        s&apos;appliquent au prochain message.
      </p>

      <ToolGroup
        title="Recherche & lecture"
        onNavigate={onNavigate}
        rows={[
          {
            name: "Recherche web",
            desc: "Cherche sur le web (Tavily, Exa) et cite ses sources — bascule « Web » de la barre de saisie.",
            tone: webSearchAvailable ? "ok" : "warn",
            status: webSearchAvailable ? "prête" : "sans clé",
            action: { label: "Gérer les clés", section: "cles" },
          },
          {
            name: "Analyse d'images",
            desc: "Les modèles vision analysent les images jointes ; en cas d'erreur, le moteur réessaie automatiquement sur un modèle vision de la liste.",
            tone: "ok",
            status: "selon le modèle",
          },
          {
            name: "Navigateur",
            desc: "Ouvre des pages et en lit le contenu, comme un visiteur.",
            tone: "off",
            status: "gateway",
          },
          {
            name: "Recherche sur X",
            desc: "Publications de X (Twitter) — nécessite une clé xAI côté moteur.",
            tone: "off",
            status: "gateway",
          },
        ]}
      />

      <ToolGroup
        title="Création"
        onNavigate={onNavigate}
        rows={[
          {
            name: "Génération d'images",
            desc: "Crée des images à partir d'une description.",
            tone: "off",
            status: "gateway",
          },
          {
            name: "Génération vidéo",
            desc: "Crée de courtes vidéos à partir d'une description.",
            tone: "off",
            status: "gateway",
          },
          {
            name: "Voix — dictée et lecture",
            desc: "Dictée par le micro de la barre de saisie, lecture à voix haute sous chaque réponse (« Écouter »).",
            tone: "ok",
            status: "présent",
          },
        ]}
      />

      <ToolGroup
        title="Exécution & fichiers"
        onNavigate={onNavigate}
        rows={[
          {
            name: "Terminal & code",
            desc: "Exécute des commandes et du code dans un environnement isolé.",
            tone: "off",
            status: "gateway",
          },
          {
            name: "Fichiers de projet",
            desc: "Lit et écrit dans vos dossiers de projet.",
            tone: "off",
            status: "gateway",
          },
        ]}
      />

      <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
        Les outils marqués «&nbsp;gateway&nbsp;» s&apos;activeront au branchement du moteur
        réel (Hermes). Tout le reste est déjà livré — sans donnée simulée.
      </p>
    </section>
  );
}
