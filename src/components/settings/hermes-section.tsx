// Section « Hermes » du volet Paramètres v4 — F-11 / F-19 / F-18 livrés :
// bibliothèque de presets de prompt système (éditeur intégré), instructions
// personnalisées globales, mémoire utilisateur (consultable, éditable,
// effaçable) et — v2.4 — conversations longues (résumé automatique avec
// seuil, fenêtre suivie). Les fichiers .md moteur et le comportement
// (initiatives) restent « à venir » — ils dépendent de la découverte moteur.
"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, MessagesSquare, Pencil, Sparkle, Trash2 } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { AddLine, Pastille } from "@/components/settings/bits";
import { MemoryCard } from "@/components/settings/memory-card";
import type { MemoryState, ModelOption, SystemPromptPreset } from "@/lib/chat-types";
import { onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import { contextWindowOf, formatK } from "@/lib/tokens";
import {
  COMPACT_THRESHOLD_MAX,
  COMPACT_THRESHOLD_MIN,
  clampCompactThreshold,
} from "@/lib/compaction";

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
  /** v2.4 — fenêtre du modèle sélectionné (carte Conversations longues). */
  models: ModelOption[];
  selectedModel: string | null;
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
    <div className="mt-2 rounded-lg border border-hermes/30 bg-hermes/5 p-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Nom du preset"
        aria-label="Nom du preset"
        className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12.5px] font-semibold outline-none focus-visible:border-hermes/60"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Instructions du preset…"
        aria-label="Instructions du preset"
        spellCheck={false}
        className="mt-2 min-h-[120px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none focus-visible:border-hermes/60"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 cursor-pointer items-center rounded-md px-3 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Annuler
        </button>
        <button
          type="button"
          onClick={() => onSubmit(title.trim(), content.trim())}
          disabled={!title.trim() || !content.trim()}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:bg-hermes-strong/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check className="size-3.5" strokeWidth={2.5} />
          {initial ? "Enregistrer" : "Créer"}
        </button>
      </div>
    </div>
  );
}

/** Carte « Conversations longues » (v2.4) — résumé automatique avec seuil.
 *  Le résumé lui-même est réel (événement conversation:compact existant) ;
 *  la décision appartient au client au moment d'envoyer (src/lib/compaction). */
function ConversationsLonguesCard({
  models,
  selectedModel,
}: {
  models: ModelOption[];
  selectedModel: string | null;
}) {
  // Réglages suivis en direct via le bus (même discipline que InterfacePane).
  const [rev, setRev] = useState(0);
  useEffect(() => onSettingsChanged(() => setRev((r) => r + 1)), []);

  const { auto, threshold } = useMemo(
    () => ({
      auto: readClientSetting<boolean>("hermes.compaction.auto") === true,
      threshold: clampCompactThreshold(
        readClientSetting<number>("hermes.compaction.threshold")
      ),
    }),
    [rev]
  );

  const model = models.find((m) => m.id === selectedModel) ?? null;
  const { windowTokens, estimated } = contextWindowOf(model);

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 transition-colors",
        auto ? "border-border" : "border-border/60"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold">
            <MessagesSquare className="size-[14px] text-hermes-text" strokeWidth={2} />
            Conversations longues
          </div>
          <div className="mt-px text-[12.5px] leading-snug text-muted-foreground">
            Quand la conversation approche de la limite, Hermes la résume et
            poursuit — rien n&apos;est coupé.
          </div>
        </div>
        {/* Interrupteur résumé automatique — le Switch Radix unique du repo */}
        <Switch
          checked={auto}
          onCheckedChange={(v) =>
            void writeClientSetting("hermes.compaction.auto", v)
          }
          aria-label={auto ? "Couper le résumé automatique" : "Activer le résumé automatique"}
        />
      </div>

      {/* Fenêtre du modèle : information suivie (jamais réglée à la main) */}
      <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium">Fenêtre du modèle</span>
          <span className="mt-px block text-[11px] leading-snug text-muted-foreground">
            Elle suit le modèle choisi (section Modèles) — détectée automatiquement,
            aucune valeur à régler à la main.
          </span>
        </span>
        <span className="flex-none text-[12.5px] font-semibold tabular-nums text-muted-foreground">
          {formatK(windowTokens)} jetons
          {estimated ? " (estimée)" : ""}
        </span>
      </div>

      {/* Seuil : visible seulement quand le résumé automatique est actif */}
      {auto ? (
        <div className="mt-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] font-medium">Seuil du résumé</span>
            <span className="text-[12.5px] font-semibold tabular-nums text-hermes-text">
              {threshold} %
            </span>
          </div>
          <Slider
            min={COMPACT_THRESHOLD_MIN}
            max={COMPACT_THRESHOLD_MAX}
            step={5}
            value={[threshold]}
            onValueChange={([v]) =>
              writeClientSetting(
                "hermes.compaction.threshold",
                clampCompactThreshold(v)
              )
            }
            aria-label="Seuil du résumé automatique"
            className="mt-3 w-full"
          />
          <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Déclenche le résumé à ce niveau de remplissage de la fenêtre. Plus
            haut : des conversations plus longues avant le résumé, au prix d&apos;un
            coût par message plus élevé.
          </div>
        </div>
      ) : null}

      <div className="mt-2 text-[11px] leading-snug text-muted-foreground">
        Vous pouvez aussi lancer le résumé à la main : jauge de contexte (anneau
        de la barre de saisie) → « Compacter ».
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
  models,
  selectedModel,
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
      <p className="mt-1 mb-5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Le comportement de l&apos;agent — instructions qui s&apos;ajoutent aux siennes.
      </p>

      {/* ── Instructions personnalisées (F-19) ───────────────────────── */}
      <div className="rounded-xl border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold">
              Instructions personnalisées
            </div>
            <div className="mt-px text-[12.5px] leading-snug text-muted-foreground">
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
          className="mt-2.5 min-h-[104px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70 focus-visible:border-hermes/60 focus-visible:ring-2 focus-visible:ring-hermes/30"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span
            className={cn(
              "text-[11px] tabular-nums text-muted-foreground",
              remaining < 0 &&
                "font-semibold text-destructive"
            )}
          >
            {instructionsValue.length.toLocaleString("fr-FR")} /{" "}
            {customMaxChars.toLocaleString("fr-FR")}
          </span>
          <button
            type="button"
            onClick={() => void saveInstructions()}
            disabled={!instructionsDirty || remaining < 0 || saving}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground shadow-sm transition-opacity hover:bg-hermes-strong/90 disabled:cursor-not-allowed disabled:opacity-40"
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

      {/* ── Conversations longues (v2.4) ──────────────────────────── */}
      <div className="mt-4">
        <ConversationsLonguesCard
          models={models}
          selectedModel={selectedModel}
        />
      </div>

      {/* ── Bibliothèque de presets (F-11) ───────────────────────────── */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold tracking-tight">
              Bibliothèque de prompts
            </h2>
            <p className="mt-px text-[12.5px] leading-snug text-muted-foreground">
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

        <div className="mt-2.5 rounded-xl border border-border px-4 py-1">
          {presets.length === 0 && !creating ? (
            <div className="py-4 text-center text-[12.5px] text-muted-foreground">
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
                      <span className="text-[12.5px] font-semibold">{p.title}</span>
                    </div>
                    <div className="mt-px line-clamp-2 text-[11px] leading-snug text-muted-foreground">
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
                        "flex size-[28px] cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
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
                      className="flex size-[28px] cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive dark:hover:text-destructive"
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
      <div className="mt-6 rounded-xl border border-dashed border-border px-4 py-1">
        {[
          {
            name: "Fichiers .md moteur",
            desc: "SOUL.md, AGENTS.md… — éditables ici, effet au rechargement du moteur",
          },
          {
            name: "Comportement du moteur",
            desc: "initiatives de fond, tâches planifiées, délégation, historique des sessions",
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
              <div className="text-[12.5px] font-semibold">{it.name}</div>
              <div className="mt-px text-[11px] leading-snug text-muted-foreground">
                {it.desc}
              </div>
            </div>
            <span className="flex-none rounded-full bg-warning/12 px-2 py-0.5 text-[11px] font-semibold text-warning">
              à venir
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <Sparkle className="mt-[2px] size-[13px] flex-none" strokeWidth={2} />
        Le prompt de chaque conversation vit dans son propre panneau (bouton
        «&nbsp;prompt&nbsp;» de l&apos;en-tête) ; les presets ci-dessus s&apos;y
        appliquent en un clic. Une fois la gateway branchée, ces réglages
        partiront dans <code className="rounded bg-muted px-1 font-mono text-[11px]">api_turn_v1.settings</code>.
      </p>
    </section>
  );
}
