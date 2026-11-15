// Section « Skills » du volet Paramètres v4 (v2.4) — état vide honnête.
// Les skills sont fournis par le MOTEUR Hermes (procédures découvertes au
// branchement) : rien n'est simulé en démo. En attendant, les liens croisés
// pointent vers ce qui existe déjà (presets de prompt, dépôts importés).
"use client";

import { ArrowRight, Sparkles } from "lucide-react";

interface SkillsSectionProps {
  onNavigate: (section: string) => void;
}

function CrossLink({
  label,
  desc,
  section,
  onNavigate,
}: {
  label: string;
  desc: string;
  section: string;
  onNavigate: (section: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(section)}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-left transition-colors hover:border-hermes/40 hover:bg-hermes/5"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold">{label}</span>
        <span className="mt-px block text-[11px] leading-snug text-muted-foreground">
          {desc}
        </span>
      </span>
      <ArrowRight className="size-4 flex-none text-muted-foreground" strokeWidth={2} />
    </button>
  );
}

export function SkillsSection({ onNavigate }: SkillsSectionProps) {
  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Skills</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Des procédures réutilisables, cherchables, éditables dans ce volet.
      </p>

      <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
        <Sparkles className="mx-auto size-5 text-muted-foreground/70" strokeWidth={2} />
        <div className="mt-2 text-[12.5px] font-semibold">Aucun skill pour l&apos;instant</div>
        <div className="mx-auto mt-1 max-w-[400px] text-[11px] leading-relaxed text-muted-foreground">
          Les skills sont des procédures du moteur Hermes. Ils apparaîtront ici
          — avec leur source et leur dernière vérification — au branchement de
          la gateway. Rien n&apos;est simulé en attendant.
        </div>
      </div>

      <div className="mt-5 space-y-2">
        <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          En attendant
        </div>
        <CrossLink
          label="Presets de prompt"
          desc="Des instructions prêtes à appliquer à une conversation — le rôle le plus proche d'un skill aujourd'hui."
          section="hermes"
          onNavigate={onNavigate}
        />
        <CrossLink
          label="Dépôts importés"
          desc="Vos imports GitHub seront détectés comme sources de skills au branchement — gérez-les déjà dans Extensions."
          section="extensions"
          onNavigate={onNavigate}
        />
      </div>
    </section>
  );
}
