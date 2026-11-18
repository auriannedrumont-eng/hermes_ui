// Sélecteur de modes du compositeur (F-30) — la pastille qui décide comment
// le prochain message sera traité. Un seul décideur du traitement : premier
// contrôle du pied de la zone de message, aucun autre réglage de l'écran
// n'en décide (la maquette fait foi — design/maquette-modes.html).
//
// Le popover liste les 7 modes ; son pied change avec le mode : tours du
// débat (3–10), membres du conseil (2–5), reprises de l'auto (0–3) — bornes
// affichées et arrêtées à la saisie. Le panneau « qui travaille » liste les
// voix du mode actif — chacune peut avoir son propre modèle, ou suivre le
// modèle de la conversation (choix par conversation, relu par le service).
"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Cpu, Info, Minus, Plus, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { readClientSetting } from "@/lib/settings";
import { ModelChoiceList, modelLabelOf } from "@/components/shared/model-choice-list";
import type { ModelOption } from "@/lib/chat-types";
import {
  AUTO_RETRIES_MAX,
  AUTO_RETRIES_MIN,
  COUNCIL_MEMBERS_MAX,
  COUNCIL_MEMBERS_MIN,
  DEBATE_ROUNDS_MAX,
  DEBATE_ROUNDS_MIN,
  DEFAULT_VOICES,
  MODES,
  clampInt,
  mergedModeModel,
  mergedVoices,
  modeDef,
  modePillLabel,
  normalizeWebchatModelId,
  voicesFor,
  whoTextFor,
  type ConversationMode,
  type ModeConfig,
} from "@/lib/modes";

interface ModePickerProps {
  /** Mode effectif (conversation ouverte : valeur du service ; sinon réglage local). */
  mode: ConversationMode;
  /** Config par conversation (voix, tours, membres, reprises) — null = défauts. */
  config: ModeConfig | null;
  /** Catalogue vivant pour « qui travaille ». */
  models: ModelOption[];
  /** Change le mode (+ config) — socket conversations:setMode ou état local. */
  onSetMode: (mode: ConversationMode, config: ModeConfig) => void;
  disabled?: boolean;
}

/** Petit compteur borné — s'arrête à la limite, jamais de refus muet. */
function Stepper({
  value,
  min,
  max,
  maxLabel,
  onChange,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  maxLabel: string;
  onChange: (v: number) => void;
  ariaLabel: string;
}) {
  return (
    <span className="inline-flex items-center overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label={`Moins — ${ariaLabel}`}
        className="flex h-6.5 w-6.5 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-35"
      >
        <Minus className="h-3 w-3" />
      </button>
      <span className="flex h-6.5 min-w-[64px] items-center justify-center gap-1 border-x border-border text-[11px] font-bold tabular-nums">
        {value}
        <small className="font-medium text-[11px] text-muted-foreground">/ {maxLabel}</small>
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label={`Plus — ${ariaLabel}`}
        className="flex h-6.5 w-6.5 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-35"
      >
        <Plus className="h-3 w-3" />
      </button>
    </span>
  );
}

function SwitchMini({
  on,
  onToggle,
  ariaLabel,
}: {
  on: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        "relative h-[18px] w-8 flex-none rounded-full transition-colors",
        on ? "bg-hermes-strong" : "bg-border"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-card shadow transition-transform",
          on ? "translate-x-[16px]" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

/** Défauts des voix : registre hermes.modes.voices fusionné sur les défauts
 *  de la librairie (charge invalide = défauts — jamais d'écran cassé). Les
 *  ids webchat du format historique sont ramenés au format fusionné. */
function voicesDefaults(): Record<string, Record<string, string | null>> {
  let stored: Record<string, Record<string, string | null>> = {};
  try {
    const raw = readClientSetting<string>("hermes.modes.voices");
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") stored = parsed as typeof stored;
    }
  } catch {
    /* charge invalide */
  }
  const normSlot = (slot?: Record<string, string | null>) =>
    Object.fromEntries(
      Object.entries(slot ?? {}).map(([voiceId, id]) => [
        voiceId,
        typeof id === "string" ? normalizeWebchatModelId(id) : id,
      ])
    );
  return {
    debate: { ...DEFAULT_VOICES.debate, ...normSlot(stored.debate) },
    council: { ...DEFAULT_VOICES.council, ...normSlot(stored.council) },
    auto: { ...DEFAULT_VOICES.auto, ...normSlot(stored.auto) },
    compare: { ...DEFAULT_VOICES.compare, ...normSlot(stored.compare) },
  };
}

/** Défauts du modèle par mode (chat/plan/code) — registre client
 *  hermes.modes.models (page Paramètres). Charge invalide = défauts
 *  (tous suivent le modèle de la conversation). */
function modeModelDefaults(): Record<string, string | null> {
  let stored: Record<string, string | null> = {};
  try {
    const raw = readClientSetting<string>("hermes.modes.models");
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") stored = parsed as typeof stored;
    }
  } catch {
    /* charge invalide */
  }
  const norm = (id: string | null | undefined) =>
    typeof id === "string" ? normalizeWebchatModelId(id) : (id ?? null);
  return { chat: norm(stored.chat), plan: norm(stored.plan), code: norm(stored.code) };
}

export function ModePicker({
  mode,
  config,
  models,
  onSetMode,
  disabled,
}: ModePickerProps) {
  const [open, setOpen] = useState(false);
  const [voicesOpen, setVoicesOpen] = useState(false);
  /** Voix dont la liste de modèles est dépliée (une seule à la fois). */
  const [openVoice, setOpenVoice] = useState<string | null>(null);
  /** Liste du modèle du mode (chat/plan/code) dépliée. */
  const [modelOpen, setModelOpen] = useState(false);

  const def = modeDef(mode);
  const current = useMemo<ModeConfig>(() => {
    // Config effective : réglages par défaut du registre + config conversation
    return {
      rounds: clampInt(
        config?.rounds,
        DEBATE_ROUNDS_MIN,
        DEBATE_ROUNDS_MAX,
        clampInt(
          readClientSetting<number>("hermes.modes.debateRounds"),
          DEBATE_ROUNDS_MIN,
          DEBATE_ROUNDS_MAX,
          DEBATE_ROUNDS_MIN
        )
      ),
      members: clampInt(
        config?.members,
        COUNCIL_MEMBERS_MIN,
        COUNCIL_MEMBERS_MAX,
        clampInt(
          readClientSetting<number>("hermes.modes.councilMembers"),
          COUNCIL_MEMBERS_MIN,
          COUNCIL_MEMBERS_MAX,
          COUNCIL_MEMBERS_MIN
        )
      ),
      retries: clampInt(
        config?.retries,
        AUTO_RETRIES_MIN,
        AUTO_RETRIES_MAX,
        clampInt(
          readClientSetting<number>("hermes.modes.autoRetries"),
          AUTO_RETRIES_MIN,
          AUTO_RETRIES_MAX,
          2
        )
      ),
      autoDebate:
        config?.autoDebate ??
        (readClientSetting<boolean>("hermes.modes.autoDebate") !== false),
      voices: config?.voices,
      // Lot 3 (audit L3-1) : ces deux clés doivent suivre la config effective —
      // sans elles, chaque patch()/setVoiceModel()/switchTo() (spread de
      // current) EFFAÇAIT debateParallel et model : le toggle réaffichait
      // toujours « parallèle ON » et le modèle du mode repartait à null.
      debateParallel: config?.debateParallel,
      model: config?.model,
    };
  }, [config]);

  const voices = voicesFor(mode, current);
  const modelByVoice = mergedVoices(mode, config, voicesDefaults());
  const modelDefaults = modeModelDefaults();
  const modeModelId = mergedModeModel(mode, config, modelDefaults);
  const on = mode !== "chat";

  const patch = (updater: (c: ModeConfig) => ModeConfig) => {
    onSetMode(mode, updater({ ...current }));
  };

  const setVoiceModel = (voiceId: string, modelId: string | null) => {
    const voicesMap: ModeConfig["voices"] = {
      ...(config?.voices ?? {}),
      [mode]: {
        ...(config?.voices?.[mode] ?? {}),
        [voiceId]: modelId,
      },
    };
    onSetMode(mode, { ...current, voices: voicesMap });
  };

  /** Modèle du mode (chat/plan/code) — null = suit la conversation. */
  const setModeModel = (modelId: string | null) => {
    const model: ModeConfig["model"] = {
      ...(config?.model ?? {}),
      [mode]: modelId,
    };
    onSetMode(mode, { ...current, model });
  };

  /** Change de mode : les défauts de la page Paramètres rejoignent la
   *  conversation (les colonnes A/B, conseillers, membres, le modèle du mode
   *  partent avec eux). */
  const switchTo = (next: ConversationMode) => {
    const withVoices: ModeConfig = {
      ...current,
      voices: {
        ...(config?.voices ?? {}),
        [next]: mergedVoices(next, config, voicesDefaults()),
      },
      model: {
        ...(config?.model ?? {}),
        ...(config?.model?.[next] === undefined
          ? { [next]: modelDefaults[next] ?? null }
          : {}),
      },
    };
    onSetMode(next, withVoices);
    setVoicesOpen(modeDef(next).hasVoices);
    setOpenVoice(null);
    setModelOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setOpenVoice(null);
          setVoicesOpen(false);
          setModelOpen(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Mode de la conversation : ${def.label} — cliquez pour changer`}
          className={cn(
            "inline-flex h-8 max-w-[230px] flex-none items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-colors",
            "hover:bg-muted/60 hover:text-foreground disabled:opacity-40",
            on ? "bg-hermes/15 text-hermes-text hover:bg-hermes/25" : "text-muted-foreground"
          )}
        >
          <def.icon className="h-3.5 w-3.5 flex-none" />
          <span className="truncate">{modePillLabel(mode, config)}</span>
          <ChevronDown className="h-3 w-3 flex-none opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[430px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border-border p-0"
      >
        <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3 text-[11px] font-semibold text-muted-foreground">
          <def.icon className="h-3.5 w-3.5 text-hermes-text" />
          Mode du prochain message — propre à cette conversation
        </div>
        <div
          className="max-h-[290px] overflow-y-auto p-1.5"
          role="listbox"
          aria-label="Modes du compositeur"
        >
          {MODES.map((m) => {
            const sel = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={sel}
                onClick={() => switchTo(m.id)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors",
                  sel ? "bg-muted" : "hover:bg-muted/60"
                )}
              >
                <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center">
                  {sel ? (
                    <Check className="h-4 w-4 text-hermes-text" strokeWidth={2.5} />
                  ) : null}
                </span>
                <m.icon
                  className={cn(
                    "mt-0.5 h-4 w-4 flex-none",
                    sel ? "text-hermes-text" : "text-muted-foreground"
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold leading-tight">
                    {m.label}
                  </span>
                  <span className="mt-px block text-[11px] leading-snug text-muted-foreground">
                    {m.desc}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-border px-3 py-2.5">
          {/* Bornes du mode actif — arrêtées à la saisie, comme le service */}
          {mode === "debate" ? (
            <>
              <div className="flex items-center justify-between gap-3 py-1 text-[11px] font-semibold text-muted-foreground">
                <span>Tours du débat</span>
                <Stepper
                  value={current.rounds ?? DEBATE_ROUNDS_MIN}
                  min={DEBATE_ROUNDS_MIN}
                  max={DEBATE_ROUNDS_MAX}
                  maxLabel="10 max"
                  ariaLabel="tours du débat"
                  onChange={(v) => patch((c) => ({ ...c, rounds: v }))}
                />
              </div>
              <div className="flex items-center justify-between gap-3 py-1 text-[11px] font-semibold text-muted-foreground">
                <span>Voix du tour en parallèle (par défaut, rapide)</span>
                <SwitchMini
                  on={current.debateParallel !== false}
                  ariaLabel="Voix du tour en parallèle"
                  onToggle={() =>
                    patch((c) => ({ ...c, debateParallel: c.debateParallel === false }))
                  }
                />
              </div>
            </>
          ) : null}
          {mode === "council" ? (
            <div className="flex items-center justify-between gap-3 py-1 text-[11px] font-semibold text-muted-foreground">
              <span>Membres du conseil</span>
              <Stepper
                value={current.members ?? COUNCIL_MEMBERS_MIN}
                min={COUNCIL_MEMBERS_MIN}
                max={COUNCIL_MEMBERS_MAX}
                maxLabel="5 max"
                ariaLabel="membres du conseil"
                onChange={(v) => patch((c) => ({ ...c, members: v }))}
              />
            </div>
          ) : null}
          {mode === "auto" ? (
            <>
              <div className="flex items-center justify-between gap-3 py-1 text-[11px] font-semibold text-muted-foreground">
                <span>Reprises après échec</span>
                <Stepper
                  value={current.retries ?? 2}
                  min={AUTO_RETRIES_MIN}
                  max={AUTO_RETRIES_MAX}
                  maxLabel="3 max"
                  ariaLabel="reprises après échec"
                  onChange={(v) => patch((c) => ({ ...c, retries: v }))}
                />
              </div>
              <div className="flex items-center justify-between gap-3 py-1 text-[11px] font-semibold text-muted-foreground">
                <span>Débat préalable (cadrage avant d&apos;agir)</span>
                <SwitchMini
                  on={current.autoDebate !== false}
                  ariaLabel="Débat préalable"
                  onToggle={() => patch((c) => ({ ...c, autoDebate: c.autoDebate === false }))}
                />
              </div>
            </>
          ) : null}

          {/* Modèle du mode (chat/plan/code) — ce que le mode utilise par
              défaut dans cette conversation ; les modes à voix règlent leurs
              modèles voix par voix plus bas. */}
          {!def.hasVoices ? (
            <div className="mt-1.5">
              <div className="flex items-center gap-2 rounded-xl border border-dashed border-hermes/40 px-2.5 py-2 text-[11px] text-muted-foreground">
                <Cpu className="h-3.5 w-3.5 flex-none text-hermes-text" />
                <span className="min-w-0 flex-1 truncate">
                  {modeModelId ? (
                    <>
                      Modèle du mode —{" "}
                      <span className="font-semibold text-foreground">
                        {modelLabelOf(modeModelId, models)}
                      </span>
                    </>
                  ) : (
                    "Modèle du mode — celui de la conversation"
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setModelOpen((v) => !v)}
                  aria-expanded={modelOpen}
                  className="flex-none rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-muted"
                >
                  {modelOpen ? "Fermer" : "Choisir"}
                </button>
              </div>
              {modelOpen ? (
                <div className="mt-2 max-h-44 overflow-y-auto rounded-xl border border-border bg-card p-1">
                  <ModelChoiceList
                    models={models}
                    value={modeModelId}
                    onPick={(id) => {
                      setModeModel(id);
                      setModelOpen(false);
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* « Qui travaille » — une voix par acteur du mode, son modèle à part */}
          {def.hasVoices ? (
            <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-dashed border-hermes/40 px-2.5 py-2 text-[11px] text-muted-foreground">
              <Users className="h-3.5 w-3.5 flex-none text-hermes-text" />
              <span className="min-w-0 truncate">{whoTextFor(voices, modelByVoice)}</span>
              <button
                type="button"
                onClick={() => {
                  setVoicesOpen((v) => !v);
                  setOpenVoice(null);
                }}
                aria-expanded={voicesOpen}
                className="flex-none rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-muted"
              >
                {voicesOpen ? "Fermer" : "Voir"}
              </button>
            </div>
          ) : null}
          {def.hasVoices && voicesOpen ? (
            <div className="mt-2 overflow-hidden rounded-xl border border-border bg-background">
              {voices.map((v) => {
                const mid = modelByVoice[v.id] ?? null;
                const expanded = openVoice === v.id;
                return (
                  <div key={v.id} className="border-t border-border first:border-t-0">
                    <div className="flex items-center gap-2 px-2.5 py-1.5">
                      <span className="flex-none text-[12.5px] font-bold">{v.name}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {v.role}
                      </span>
                      <button
                        type="button"
                        onClick={() => setOpenVoice(expanded ? null : v.id)}
                        className={cn(
                          "inline-flex max-w-[175px] flex-none items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors",
                          mid
                            ? "border-hermes/35 bg-hermes/10 text-hermes-text"
                            : "border-border bg-card text-foreground hover:bg-muted"
                        )}
                        aria-expanded={expanded}
                        aria-label={`Modèle de ${v.name}`}
                      >
                        <span className="truncate">
                          {mid ? modelLabelOf(mid, models) : "Modèle de la conversation"}
                        </span>
                        <ChevronDown className="h-2.5 w-2.5 flex-none" />
                      </button>
                    </div>
                    {expanded ? (
                      <div className="max-h-44 overflow-y-auto border-t border-dashed border-border bg-card p-1">
                        <ModelChoiceList
                          models={models}
                          value={mid}
                          onPick={(id) => {
                            setVoiceModel(v.id, id);
                            setOpenVoice(null);
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          <p className="mt-2 flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 flex-none" />
            <span>{def.note}</span>
          </p>
        </div>
        <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          Le mode s&apos;applique au message qui suit — il reste propre à cette conversation,
          même en cours de discussion.
        </div>
      </PopoverContent>
    </Popover>
  );
}
