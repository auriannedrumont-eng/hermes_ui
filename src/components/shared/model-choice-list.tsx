// Liste de choix d'un modèle — partagée par le sélecteur de modes (« qui
// travaille », modèle du mode) et la page Paramètres (voix, défauts).
// Deux groupes lisibles : les modèles du moteur, puis les chats IA web —
// Hermes pilote le navigateur du site (z.ai, AI Studio). Un site non vérifié
// est absent de la liste (indisponible), jamais proposé pour échouer après.
"use client";

import { cn } from "@/lib/utils";
import type { ModelOption } from "@/lib/chat-types";

/** Modèles du moteur (catalogue LLM) — le cœur historique. */
export function engineModels(models: ModelOption[]): ModelOption[] {
  return models.filter((m) => !m.webchat && m.available !== false);
}

/** Chats IA web disponibles (site vérifié) — pilote navigateur. */
export function webchatModels(models: ModelOption[]): ModelOption[] {
  return models.filter((m) => m.webchat && m.available !== false);
}

/** Libellé d'affichage d'un modèle choisi (id inconnu = id brut — honnête). */
export function modelLabelOf(id: string, models: ModelOption[]): string {
  return models.find((m) => m.id === id)?.label ?? id;
}

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "size-[7px] flex-none rounded-full border",
        on ? "border-hermes-strong bg-hermes-strong" : "border-border"
      )}
    />
  );
}

function Option({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] hover:bg-muted/60"
    >
      <Dot on={selected} />
      {children}
    </button>
  );
}

export function ModelChoiceList({
  models,
  value,
  onPick,
  noneLabel = "Modèle de la conversation",
}: {
  models: ModelOption[];
  /** Modèle actuellement choisi (null = l'option « sans choix »). */
  value: string | null;
  onPick: (id: string | null) => void;
  /** Libellé de l'option « sans choix » — le tour suit le modèle du fil. */
  noneLabel?: string;
}) {
  const engines = engineModels(models);
  const webs = webchatModels(models);
  return (
    <div role="listbox" aria-label="Choix du modèle">
      <Option selected={!value} onClick={() => onPick(null)}>
        <span className="font-semibold">{noneLabel}</span>
      </Option>
      {engines.map((m) => (
        <Option key={m.id} selected={value === m.id} onClick={() => onPick(m.id)}>
          <span className="font-semibold">{m.label}</span>
        </Option>
      ))}
      {webs.length ? (
        <>
          <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Chats IA web — pilotage navigateur
          </div>
          {webs.map((m) => (
            <Option key={m.id} selected={value === m.id} onClick={() => onPick(m.id)}>
              <span className="font-semibold">{m.label}</span>
            </Option>
          ))}
          <p className="px-2 pb-1 pt-1 text-[11px] leading-snug text-muted-foreground">
            Hermes ouvre le site dans son navigateur de pilotage et y pose le
            message — texte ou fichiers, le site répond selon la demande et
            Hermes ramène le résultat d&apos;un bloc, les tours s&apos;enchaînent
            l&apos;un après l&apos;autre.
          </p>
        </>
      ) : null}
    </div>
  );
}
