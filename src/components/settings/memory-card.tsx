// Mémoire utilisateur (F-18) — carte de la section Hermes du volet v4 :
// consultable, éditable, effaçable. Notes persistées côté service sous
// `hermes.memory.notes`, actives tant que `hermes.memory.enabled` vaut 1
// (fallback : absentes = actives). La mémoire est injectée dans les
// instructions du tour par le service (moteur local) — le client n'assemble rien.
"use client";

import { useState } from "react";
import { Brain, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pastille } from "@/components/settings/bits";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDestructiveDialog } from "@/components/shared/confirm-destructive-dialog";
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
  // Lot 3 (audit L3-2) : brouillon matérialisé UNIQUEMENT sur frappe —
  // l'initialisation par effet figeait « "" » avant la réponse socket et la
  // valeur serveur n'était plus jamais suivie (effacement involontaire au
  // premier « Enregistrer »). draft === null = « suit la valeur du service ».
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Lot audit : verrou des bascules (clics rapides = émissions contradictoires).
  const [toggling, setToggling] = useState(false);

  const notesValue = draft ?? state?.notes ?? "";
  const maxChars = state?.maxChars ?? 12_000;
  const remaining = maxChars - notesValue.length;
  const dirty = draft !== null && draft.trim() !== (state?.notes ?? "").trim();
  const enabled = state?.enabled ?? true;
  const autoLearn = state?.autoLearn ?? false;

  const toggleEnabled = async (v: boolean) => {
    if (toggling) return;
    setToggling(true);
    await onSetEnabled(v);
    setToggling(false);
  };

  const toggleAuto = async (v: boolean) => {
    if (toggling) return;
    setToggling(true);
    await onSetAuto(v);
    setToggling(false);
  };

  const saveNotes = async () => {
    setSaving(true);
    const ok = await onSaveNotes(notesValue.trim());
    setSaving(false);
    if (ok) setDraft(null); // re-suit la valeur du service (confirmée)
  };

  const erase = async () => {
    setSaving(true);
    const ok = await onSaveNotes("");
    setSaving(false);
    if (ok) setDraft(null); // re-suit la valeur du service ("" confirmé)
  };

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 transition-colors",
        enabled ? "border-border" : "border-border/60 opacity-70"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <Brain className="size-[14px] text-hermes-text" strokeWidth={2} />
            Mémoire
          </div>
          <div className="mt-px text-[12.5px] leading-snug text-muted-foreground">
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
                  : // Audit design §6.2 : un état vide est NEUTRE (off),
                    // pas un avertissement — l'orange alarmait à tort.
                    "off"
            }
            label={
              !enabled
                ? "désactivée"
                : notesValue.trim()
                  ? "active"
                  : "vide"
            }
          />
          {/* Interrupteur activer/désactiver — le Switch Radix unique du repo */}
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void toggleEnabled(v)}
            disabled={toggling}
            aria-label={enabled ? "Désactiver la mémoire" : "Activer la mémoire"}
          />
        </div>
      </div>

      {/* Apprentissage automatique : préférence enregistrée — le contrat
          gateway ne porte pas de réglage d'apprentissage (audit 25/11) */}
      <Label
        htmlFor="memory-auto-learn"
        className="mt-3 flex cursor-pointer items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/30 px-3 py-2"
      >
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium">
            Apprentissage automatique
          </span>
          <span className="mt-px block text-[11px] leading-snug text-muted-foreground">
            Préférence enregistrée — l&apos;enrichissement automatique de la
            mémoire est piloté par la configuration de l&apos;agent Hermes
            (aucun réglage dans le contrat gateway).
          </span>
        </span>
        <Switch
          id="memory-auto-learn"
          checked={autoLearn}
          disabled={!enabled || toggling}
          onCheckedChange={(v) => void toggleAuto(v)}
          aria-label="Apprentissage automatique"
        />
      </Label>

      <Textarea
        value={notesValue}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Contenu de la mémoire"
        placeholder="Ex. : Je m'appelle… Je préfère… Mon projet actuel est…"
        spellCheck={false}
        disabled={!enabled}
        className="mt-2.5 min-h-[96px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70 focus-visible:border-hermes/60 focus-visible:ring-2 focus-visible:ring-hermes/30 disabled:cursor-not-allowed disabled:opacity-40"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ConfirmDestructiveDialog
            trigger={
              <Button
                type="button"
                variant="ghost"
                disabled={!enabled || !notesValue.trim() || saving}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-destructive"
              >
                <Trash2 className="size-[13px]" strokeWidth={2} />
                Effacer
              </Button>
            }
            title="Effacer tout le contenu de la mémoire ?"
            description="Toutes les notes mémorisées seront supprimées définitivement."
            confirmLabel="Effacer la mémoire"
            onConfirm={() => void erase()}
          />
          <span
            className={cn(
              "text-[11px] tabular-nums text-muted-foreground",
              remaining < 0 && "font-semibold text-destructive"
            )}
          >
            {notesValue.length.toLocaleString("fr-FR")} /{" "}
            {maxChars.toLocaleString("fr-FR")}
          </span>
        </div>
        <Button
          type="button"
          variant="primary"
          onClick={() => void saveNotes()}
          disabled={!enabled || !dirty || remaining < 0 || saving}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground shadow-sm transition-opacity hover:bg-hermes-strong/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check className="size-[13px]" strokeWidth={2.5} />
          Enregistrer · prochain tour
        </Button>
      </div>
    </div>
  );
}
