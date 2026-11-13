// Mémoire utilisateur (F-18) — carte de la section Hermes du volet v4 :
// consultable, éditable, effaçable. Notes persistées côté service sous
// `hermes.memory.notes`, actives tant que `hermes.memory.enabled` vaut 1
// (fallback : absentes = actives). La mémoire est injectée dans les
// instructions du tour par le service (démo) — le client n'assemble rien.
"use client";

import { useEffect, useState } from "react";
import { Brain, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pastille } from "@/components/settings/bits";
import type { MemoryState } from "@/lib/chat-types";

interface MemoryCardProps {
  state: MemoryState | null;
  onSetEnabled: (enabled: boolean) => Promise<boolean>;
  onSetAuto: (autoLearn: boolean) => Promise<boolean>;
  onSaveNotes: (value: string) => Promise<boolean>;
}

export function MemoryCard({
  state,
  onSetEnabled,
  onSetAuto,
  onSaveNotes,
}: MemoryCardProps) {
  // Brouillon local, initialisé paresseusement (le service est un système
  // externe) — suit la valeur du service au premier chargement / broadcast.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initialisation paresseuse du brouillon (système externe)
    if (draft === null) setDraft(state?.notes ?? "");
  }, [state?.notes]);

  const notesValue = draft ?? state?.notes ?? "";
  const maxChars = state?.maxChars ?? 12_000;
  const remaining = maxChars - notesValue.length;
  const dirty = draft !== null && draft.trim() !== (state?.notes ?? "").trim();
  const enabled = state?.enabled ?? true;
  const autoLearn = state?.autoLearn ?? false;

  const saveNotes = async () => {
    setSaving(true);
    const ok = await onSaveNotes(notesValue.trim());
    setSaving(false);
    if (ok) setDraft(notesValue.trim());
  };

  const erase = async () => {
    setSaving(true);
    const ok = await onSaveNotes("");
    setSaving(false);
    if (ok) setDraft("");
  };

  return (
    <div
      className={cn(
        "rounded-[14px] border px-4 py-3 transition-colors",
        enabled ? "border-border" : "border-border/60 opacity-70"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold">
            <Brain className="size-[14px] text-hermes" strokeWidth={2.2} />
            Mémoire
          </div>
          <div className="mt-px text-[12px] leading-snug text-muted-foreground">
            Ce qu&apos;Hermes retient de vous, réutilisé à chaque conversation.
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Pastille
            tone={
              !enabled
                ? "off"
                : notesValue.trim()
                  ? "ok"
                  : "warn"
            }
            label={
              !enabled
                ? "désactivée"
                : notesValue.trim()
                  ? "active"
                  : "vide"
            }
          />
          {/* Interrupteur activer/désactiver */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={enabled ? "Désactiver la mémoire" : "Activer la mémoire"}
            title={enabled ? "Désactiver la mémoire" : "Activer la mémoire"}
            onClick={() => void onSetEnabled(!enabled)}
            className={cn(
              "relative h-[22px] w-[38px] cursor-pointer rounded-full transition-colors",
              enabled ? "bg-hermes" : "bg-muted"
            )}
          >
            <span
              className={cn(
                "absolute top-[2px] size-[18px] rounded-full bg-white shadow-sm transition-all",
                enabled ? "left-[18px]" : "left-[2px]"
              )}
            />
          </button>
        </div>
      </div>

      {/* Apprentissage automatique : réglage moteur (gateway), honnête en démo */}
      <label className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-[10px] border border-border/70 bg-muted/30 px-3 py-2">
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium">
            Apprentissage automatique
          </span>
          <span className="mt-px block text-[11px] leading-snug text-muted-foreground">
            Laisser Hermes enrichir la mémoire au fil des échanges (nécessite
            le moteur réel).
          </span>
        </span>
        <input
          type="checkbox"
          checked={autoLearn}
          disabled={!enabled}
          onChange={(e) => void onSetAuto(e.target.checked)}
          className="size-[15px] flex-none accent-[var(--hermes)]"
        />
      </label>

      <textarea
        value={notesValue}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Contenu de la mémoire"
        placeholder="Ex. : Je m'appelle… Je préfère… Mon projet actuel est…"
        spellCheck={false}
        disabled={!enabled}
        className="mt-2.5 min-h-[96px] w-full resize-y rounded-[10px] border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70 focus-visible:border-hermes/60 focus-visible:ring-2 focus-visible:ring-hermes/30 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void erase()}
            disabled={!enabled || !notesValue.trim() || saving}
            title="Effacer tout le contenu de la mémoire"
            className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[9px] px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-red-400"
          >
            <Trash2 className="size-[13px]" strokeWidth={2} />
            Effacer
          </button>
          <span
            className={cn(
              "text-[10.5px] tabular-nums text-muted-foreground",
              remaining < 0 && "font-semibold text-red-600 dark:text-red-400"
            )}
          >
            {notesValue.length.toLocaleString("fr-FR")} /{" "}
            {maxChars.toLocaleString("fr-FR")}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void saveNotes()}
          disabled={!enabled || !dirty || remaining < 0 || saving}
          className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[9px] bg-hermes px-3 text-[12px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check className="size-[13px]" strokeWidth={2.5} />
          Enregistrer · prochain tour
        </button>
      </div>
    </div>
  );
}
