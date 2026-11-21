// Panneau « Prompt système de la conversation » (F-11) — Sheet 460 px depuis
// la droite (même langue que l'ancien sheet Paramètres phase 1 : le chat reste
// visible, la conversation reste le chef d'orchestre). Édition libre ou
// application d'un preset de la bibliothèque ; l'effet est au prochain tour
// (le service recompose les instructions de base + F-19 + ce prompt).
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FileText, Sparkle, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ConversationPrompt, SystemPromptPreset } from "@/lib/chat-types";

const MAX_PROMPT_CHARS = 12_000;

interface SystemPromptPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prompt actif de la conversation (null si aucun). */
  prompt: ConversationPrompt | null;
  /** Bibliothèque de presets réutilisables. */
  presets: SystemPromptPreset[];
  conversationTitle: string | null;
  onSave: (content: string, presetTitle?: string | null) => void;
  onClear: () => void;
  /** Crée un preset depuis le contenu en cours d'édition (F-11). */
  onCreatePreset: (title: string, content: string) => Promise<SystemPromptPreset | null>;
}

export function SystemPromptPanel({
  open,
  onOpenChange,
  prompt,
  presets,
  conversationTitle,
  onSave,
  onClear,
  onCreatePreset,
}: SystemPromptPanelProps) {
  // Brouillon local : la sauvegarde est explicite (bouton Enregistrer).
  const [draft, setDraft] = useState("");
  const [presetTitle, setPresetTitle] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // À l'ouverture : repart du prompt enregistré (jamais du brouillon précédent).
  // Pattern « reset by key » : le corps du sheet est remonté à chaque ouverture
  // (key = timestamp d'ouverture), l'état d'édition repart de l'état serveur —
  // pas de resynchronisation par effet.
  // Lot 3 (audit L3-3) : le timestamp est REMIS À ZÉRO à la fermeture — sinon
  // la key ne change qu'une fois par vie de l'app et rouvrir sur une AUTRE
  // conversation rééditait le prompt de la première. La key embarque aussi la
  // conversation cible + l'horodatage du prompt serveur : si la cible change
  // pendant que le sheet est ouvert (sync socket), le corps remonte aussi.
  const openedAtRef = useRef<number>(0);
  if (open && openedAtRef.current === 0) {
    openedAtRef.current = Date.now();
  } else if (!open && openedAtRef.current !== 0) {
    openedAtRef.current = 0;
  }
  const body = (
    <PromptPanelBody
      key={`${openedAtRef.current}|${prompt?.conversationId ?? "none"}|${prompt?.updatedAt ?? ""}`}
      prompt={prompt}
      presets={presets}
      conversationTitle={conversationTitle}
      onSave={onSave}
      onClear={onClear}
      onCreatePreset={onCreatePreset}
    />
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        className="w-full gap-0 overflow-hidden bg-card p-0 shadow-2xl sm:max-w-none min-[640px]:w-[460px] min-[640px]:max-w-[460px] min-[640px]:rounded-l-[22px] min-[640px]:border-l min-[640px]:border-border data-[state=open]:duration-300"
      >
        <SheetTitle className="sr-only">
          Prompt système de la conversation
        </SheetTitle>
          {body}
      </SheetContent>
    </Sheet>
  );
}

/** Corps du sheet : en-tête, presets, zone d'édition, sauvegarde. */
function PromptPanelBody({
  prompt,
  presets,
  conversationTitle,
  onSave,
  onClear,
  onCreatePreset,
}: {
  prompt: ConversationPrompt | null;
  presets: SystemPromptPreset[];
  conversationTitle: string | null;
  onSave: (content: string, presetTitle?: string | null) => void;
  onClear: () => void;
  onCreatePreset: (title: string, content: string) => Promise<SystemPromptPreset | null>;
}) {
  // Brouillon initialisé depuis l'état serveur (remontée à l'ouverture).
  const [draft, setDraft] = useState(prompt?.content ?? "");
  const [presetTitle, setPresetTitle] = useState<string | null>(prompt?.presetTitle ?? null);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const remaining = MAX_PROMPT_CHARS - draft.length;

  /** Applique un preset au brouillon (le contenu fait foi, le titre suit). */
  const applyPreset = (p: SystemPromptPreset) => {
    setDraft(p.content);
    setPresetTitle(p.title);
    setDirty(true);
    textareaRef.current?.focus();
  };

  const canSave = dirty && draft.trim().length > 0 && remaining >= 0;

  const save = () => {
    onSave(draft.trim(), presetTitle);
    setDirty(false);
  };

  /** Sauvegarde le brouillon courant comme preset de la bibliothèque. */
  const saveAsPreset = async () => {
    const title = newPresetName.trim();
    if (!title || !draft.trim()) return;
    const created = await onCreatePreset(title, draft.trim());
    if (created) {
      setPresetTitle(created.title);
      setCreating(false);
      setNewPresetName("");
      setDirty(true); // le brouillon reste à enregistrer pour la conversation
    }
  };

  const activePresetId = useMemo(
    () => presets.find((p) => p.title === presetTitle)?.id ?? null,
    [presets, presetTitle]
  );

  return (
    <div className="flex h-app-full w-full flex-col overflow-hidden">
      {/* ── En-tête ─────────────────────────────────────────────── */}
      <div className="flex flex-none items-center gap-2.5 px-5 pt-5 min-[640px]:px-6">
        <span className="flex size-[26px] items-center justify-center rounded-sm bg-hermes/10 text-hermes-text">
          <Sparkle className="size-[14px]" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold tracking-tight">
            Prompt de la conversation
          </h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {conversationTitle ?? "Nouvelle conversation"}
          </p>
        </div>
      </div>

          {/* ── Corps ──────────────────────────────────────────────── */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pb-4 pt-4 min-[640px]:px-6">
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">
              Ces instructions s&apos;ajoutent à celles d&apos;Hermes pour{" "}
              <b className="font-semibold text-foreground">cette conversation</b>{" "}
              — elles prennent effet au prochain message. Les instructions
              personnalisées globales restent actives (section Hermes du volet).
            </p>

            {/* Presets applicables */}
            {presets.length > 0 ? (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Presets de la bibliothèque
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {presets.length}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {presets.map((p) => (
                    <Button
                      key={p.id}
                      type="button"
                      variant="ghost"
                      title={p.content.slice(0, 120)}
                      onClick={() => applyPreset(p)}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:border-hermes/60 hover:text-hermes-text focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-hermes",
                        activePresetId === p.id
                          ? "border-hermes/60 bg-hermes/10 text-hermes-text"
                          : "text-muted-foreground"
                      )}
                    >
                      {p.title}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Zone d'édition */}
            <div className="flex min-h-[220px] flex-1 flex-col">
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDirty(true);
                }}
                aria-label="Prompt système de la conversation"
                placeholder="Ex. : Tu réponds en une phrase, toujours en français, sans liste…"
                spellCheck={false}
                className="min-h-[220px] flex-1 resize-none rounded-lg border border-border bg-background px-3.5 py-3 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70 focus-visible:border-hermes/60 focus-visible:ring-2 focus-visible:ring-hermes/30"
              />
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {presetTitle ? (
                    <>
                      Basé sur le preset «&nbsp;{presetTitle}&nbsp;»
                    </>
                  ) : (
                    "Édition libre"
                  )}
                </span>
                <span
                  className={cn(
                    "tabular-nums",
                    remaining < 0
                      ? "font-semibold text-destructive"
                      : remaining < 800
                        ? "text-warning"
                        : undefined
                  )}
                >
                  {draft.length.toLocaleString("fr-FR")} /{" "}
                  {MAX_PROMPT_CHARS.toLocaleString("fr-FR")}
                </span>
              </div>
            </div>

            {/* Enregistrer comme preset */}
            {creating ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
                <Input
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="Nom du preset"
                  aria-label="Nom du nouveau preset"
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12.5px] outline-none focus-visible:border-hermes/60"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveAsPreset();
                    if (e.key === "Escape") setCreating(false);
                  }}
                />
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void saveAsPreset()}
                  disabled={!newPresetName.trim() || !draft.trim()}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:bg-hermes-strong/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Check className="size-3.5" strokeWidth={2.5} />
                  Créer
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setCreating(false)}
                  className="size-8 cursor-pointer rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Annuler la création"
                >
                  <X className="size-3.5 mx-auto" strokeWidth={2} />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreating(true)}
                disabled={!draft.trim()}
                className="inline-flex w-fit cursor-pointer items-center gap-2 text-[12.5px] font-semibold text-hermes-text transition-opacity hover:opacity-75 disabled:opacity-40"
              >
                <FileText className="size-[13px]" strokeWidth={2} />
                Enregistrer dans la bibliothèque…
              </Button>
            )}
          </div>

          {/* ── Pied : sauvegarde explicite ─────────────────────────── */}
          <div className="flex flex-none items-center justify-between gap-3 border-t border-border bg-background px-5 py-3 min-[640px]:px-6">
            {prompt ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onClear();
                  setDraft("");
                  setPresetTitle(null);
                  setDirty(false);
                }}
                className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-destructive dark:hover:text-destructive"
              >
                <Trash2 className="size-[13px]" strokeWidth={2} />
                Retirer
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {prompt === null ? "Aucun prompt actif" : ""}
              </span>
            )}
            <div className="flex items-center gap-2.5">
              {dirty ? (
                <span className="text-[11px] text-warning">
                  Non enregistré
                </span>
              ) : null}
              <Button
                type="button"
                variant="primary"
                onClick={save}
                disabled={!canSave}
                className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-hermes-strong px-4 text-[12.5px] font-semibold text-hermes-foreground shadow-sm transition-opacity hover:bg-hermes-strong/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check className="size-[14px]" strokeWidth={2.5} />
                Enregistrer · prochain tour
              </Button>
            </div>
          </div>
    </div>
  );
}
