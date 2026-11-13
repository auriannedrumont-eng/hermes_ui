// Section « Hermes » du volet Paramètres v4 — F-11 / F-19 / F-18 livrés :
// bibliothèque de presets de prompt système (éditeur intégré), instructions
// personnalisées globales et mémoire utilisateur (consultable, éditable,
// effaçable). Les autres chantiers Hermes (fichiers .md moteur, compaction)
// restent « à venir » en bas de section — ils dépendent de la découverte moteur.
"use client";

import { useEffect, useState } from "react";
import { Check, Pencil, Sparkle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AddLine, Pastille } from "@/components/settings/bits";
import { MemoryCard } from "@/components/settings/memory-card";
import type { MemoryState, SystemPromptPreset } from "@/lib/chat-types";

interface HermesSectionProps {
  presets: SystemPromptPreset[];
  customInstructions: string | null;
  customMaxChars: number;
  memory: MemoryState | null;
  onCreatePreset: (title: string, content: string) => Promise<SystemPromptPreset | null>;
  onUpdatePreset: (id: string, title: string, content: string) => Promise<SystemPromptPreset | null>;
  onDeletePreset: (id: string) => Promise<boolean>;
  onSaveCustomInstructions: (value: string) => Promise<boolean>;
  onSetMemoryEnabled: (enabled: boolean) => Promise<boolean>;
  onSetMemoryAuto: (autoLearn: boolean) => Promise<boolean>;
  onSaveMemoryNotes: (value: string) => Promise<boolean>;
}

/** Éditeur d'un preset (création ou modification) — ligne dépliable du volet. */
function PresetEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: { title: string; content: string } | null;
  onCancel: () => void;
  onSubmit: (title: string, content: string) => void;
}) {
  // État initialisé (jamais resynchronisé : l'éditeur vit le temps de son édition).
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");

  return (
    <div className="mt-2 rounded-[12px] border border-hermes/30 bg-hermes/5 p-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Nom du preset"
        aria-label="Nom du preset"
        className="h-8 w-full rounded-[9px] border border-border bg-background px-2.5 text-[12.5px] font-semibold outline-none focus-visible:border-hermes/60"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Instructions du preset…"
        aria-label="Instructions du preset"
        spellCheck={false}
        className="mt-2 min-h-[120px] w-full resize-y rounded-[9px] border border-border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus-visible:border-hermes/60"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 cursor-pointer items-center rounded-[9px] px-3 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Annuler
        </button>
        <button
          type="button"
          onClick={() => onSubmit(title.trim(), content.trim())}
          disabled={!title.trim() || !content.trim()}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] bg-hermes px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check className="size-3.5" strokeWidth={2.5} />
          {initial ? "Enregistrer" : "Créer"}
        </button>
      </div>
    </div>
  );
}

export function HermesSection({
  presets,
  customInstructions,
  customMaxChars,
  memory,
  onCreatePreset,
  onUpdatePreset,
  onDeletePreset,
  onSaveCustomInstructions,
  onSetMemoryEnabled,
  onSetMemoryAuto,
  onSaveMemoryNotes,
}: HermesSectionProps) {
  // Éditeur ouvert : preset existant (id) ou création (null)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ title: string; content: string } | null>(null);
  // Instructions globales : édition locale, sauvegarde explicite
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Suit la valeur du service (premier chargement / broadcast) : dérivation
  // cléée par l'état serveur, sans effet — draft démarre à null (« suit »).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initialisation paresseuse du brouillon (le service est un système externe)
    if (draft === null) setDraft(customInstructions ?? "");
  }, [customInstructions]);

  const instructionsValue = draft ?? customInstructions ?? "";
  const remaining = customMaxChars - instructionsValue.length;
  const instructionsDirty =
    draft !== null && draft.trim() !== (customInstructions ?? "").trim();

  const openEditor = (preset: SystemPromptPreset) => {
    setEditingId(preset.id);
    setEditing({ title: preset.title, content: preset.content });
    setCreating(false);
  };

  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    setEditingId(null);
  };

  const closeEditor = () => {
    setEditingId(null);
    setEditing(null);
    setCreating(false);
  };

  const submit = async (title: string, content: string) => {
    if (editingId) {
      const updated = await onUpdatePreset(editingId, title, content);
      if (updated) closeEditor();
    } else {
      const created = await onCreatePreset(title, content);
      if (created) closeEditor();
    }
  };

  const saveInstructions = async () => {
    setSaving(true);
    const ok = await onSaveCustomInstructions(instructionsValue.trim());
    setSaving(false);
    if (ok) setDraft(instructionsValue.trim());
  };

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Hermes</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
        Le comportement de l&apos;agent — instructions qui s&apos;ajoutent aux siennes.
      </p>

      {/* ── Instructions personnalisées (F-19) ───────────────────────── */}
      <div className="rounded-[14px] border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold">
              Instructions personnalisées
            </div>
            <div className="mt-px text-[12px] leading-snug text-muted-foreground">
              Vos préférences durables, appliquées à toutes les conversations.
            </div>
          </div>
          <Pastille
            tone={instructionsValue.trim() ? "ok" : "off"}
            label={instructionsValue.trim() ? "actives" : "inactives"}
            className="flex-none"
          />
        </div>
        <textarea
          value={instructionsValue}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Instructions personnalisées"
          placeholder="Ex. : Je préfère les réponses courtes et techniques. Je code en TypeScript. Utilise le vouvoiement…"
          spellCheck={false}
          className="mt-2.5 min-h-[104px] w-full resize-y rounded-[10px] border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70 focus-visible:border-hermes/60 focus-visible:ring-2 focus-visible:ring-hermes/30"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span
            className={cn(
              "text-[10.5px] tabular-nums text-muted-foreground",
              remaining < 0 &&
                "font-semibold text-red-600 dark:text-red-400"
            )}
          >
            {instructionsValue.length.toLocaleString("fr-FR")} /{" "}
            {customMaxChars.toLocaleString("fr-FR")}
          </span>
          <button
            type="button"
            onClick={() => void saveInstructions()}
            disabled={!instructionsDirty || remaining < 0 || saving}
            className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[9px] bg-hermes px-3 text-[12px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="size-[13px]" strokeWidth={2.5} />
            Enregistrer · prochain tour
          </button>
        </div>
      </div>

      {/* ── Mémoire utilisateur (F-18) ─────────────────────────────── */}
      <div className="mt-4">
        <MemoryCard
          state={memory}
          onSetEnabled={onSetMemoryEnabled}
          onSetAuto={onSetMemoryAuto}
          onSaveNotes={onSaveMemoryNotes}
        />
      </div>

      {/* ── Bibliothèque de presets (F-11) ───────────────────────────── */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold tracking-tight">
              Bibliothèque de prompts
            </h2>
            <p className="mt-px text-[12px] leading-snug text-muted-foreground">
              Des prompts prêts à appliquer à une conversation — bouton «&nbsp;prompt&nbsp;»
              de l&apos;en-tête.
            </p>
          </div>
          <AddLine onClick={openCreate} className="flex-none">
            Nouveau preset
          </AddLine>
        </div>

        {creating ? (
          <PresetEditor
            initial={null}
            onCancel={closeEditor}
            onSubmit={(t, c) => void submit(t, c)}
          />
        ) : null}

        <div className="mt-2.5 rounded-[14px] border border-border px-4 py-1">
          {presets.length === 0 && !creating ? (
            <div className="py-4 text-center text-[12px] text-muted-foreground">
              La bibliothèque est vide — créez un premier preset.
            </div>
          ) : null}
          {presets.map((p, idx) => {
            const isOpen = editingId === p.id;
            return (
              <div
                key={p.id}
                className={cn(
                  "border-border py-[11px]",
                  idx > 0 && "border-t"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold">{p.title}</span>
                    </div>
                    <div className="mt-px line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
                      {p.content}
                    </div>
                  </div>
                  <div className="flex flex-none items-center gap-1">
                    <button
                      type="button"
                      title="Modifier ce preset"
                      aria-label={`Modifier ${p.title}`}
                      onClick={() => (isOpen ? closeEditor() : openEditor(p))}
                      className={cn(
                        "flex size-[28px] cursor-pointer items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                        isOpen && "bg-muted text-foreground"
                      )}
                    >
                      <Pencil className="size-[13px]" strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      title="Supprimer ce preset"
                      aria-label={`Supprimer ${p.title}`}
                      onClick={() => void onDeletePreset(p.id)}
                      className="flex size-[28px] cursor-pointer items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                    >
                      <Trash2 className="size-[13px]" strokeWidth={2} />
                    </button>
                  </div>
                </div>
                {isOpen ? (
                  <PresetEditor
                    initial={{ title: p.title, content: p.content }}
                    onCancel={closeEditor}
                    onSubmit={(t, c) => void submit(t, c)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── À venir : le reste de la section Hermes ─────────────────── */}
      <div className="mt-6 rounded-[14px] border border-dashed border-border px-4 py-1">
        {[
          {
            name: "Fichiers .md",
            desc: "SOUL.md, AGENTS.md, AGENTS.override.md, CLAUDE.md — éditables",
          },
          {
            name: "Compaction & comportement",
            desc: "seuils de résumé, approbations d'écriture mémoire",
          },
        ].map((it, i) => (
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
            <span className="flex-none rounded-full bg-amber-500/12 px-2 py-0.5 text-[9.5px] font-semibold text-amber-600 dark:text-amber-500">
              à venir
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
        <Sparkle className="mt-[2px] size-[13px] flex-none" strokeWidth={2} />
        Le prompt de chaque conversation vit dans son propre panneau (bouton
        «&nbsp;prompt&nbsp;» de l&apos;en-tête) ; les presets ci-dessus s&apos;y
        appliquent en un clic. Une fois la gateway branchée, ces réglages
        partiront dans <code className="rounded bg-muted px-1 font-mono text-[10px]">api_turn_v1.settings</code>.
      </p>
    </section>
  );
}
