// En-tête de section de la sidebar (F-59, maquette v6 validée) : le titre
// porte les actions de sa section à droite — 📁↓ « dossier du disque » pour
// « Mes dossiers », « + » pour « Sans dossier ». Fichier neuf (R1).
"use client";

import type { ReactNode } from "react";

export function SidebarSectionHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-1 px-2 pt-2.5 pb-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      <span className="flex-1" aria-hidden="true" />
      {actions}
    </div>
  );
}
