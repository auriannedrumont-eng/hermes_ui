// Section « Modes de chat » du volet Paramètres (F-30) — les réglages PAR
// DÉFAUT des sept modes, une carte par mode dans l'ordre du sélecteur.
// La maquette fait foi : design/maquette-parametres-modes.html.
//
// Ce qui se règle ici :
// - le mode des nouvelles conversations, le déroulé affiché (et ses modèles) ;
// - les modèles par défaut des voix (conseillers, membres, étapes, A/B) —
//   registre client `hermes.modes.voices` ;
// - les 13 consignes — côté SERVICE (clé `hermes.modes.prompts` de la table
//   settings, lues à chaque envoi) : une édition s'applique au prochain
//   message de toutes les conversations, sans redémarrage ni migration.
//
// La page ne règle que les défauts : le sélecteur de la zone de message et
// le panneau « qui travaille » restent maîtres dans chaque conversation.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Code2,
  Columns2,
  Layers,
  MessagesSquare,
  ScrollText,
  Users,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InfoTip } from "@/components/shared/info-tip";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { emitAck } from "@/lib/emit-ack";
import { useToast } from "@/hooks/use-toast";
import {
  onSettingsChanged,
  readClientSetting,
  writeClientSetting,
} from "@/lib/settings";
import {
  ModelChoiceList,
  modelLabelOf,
} from "@/components/shared/model-choice-list";
import type { ModelOption } from "@/lib/chat-types";
import {
  AUTO_RETRIES_MAX,
  AUTO_RETRIES_MIN,
  COUNCIL_MEMBERS_MAX,
  COUNCIL_MEMBERS_MIN,
  DEBATE_ROUNDS_MAX,
  DEBATE_ROUNDS_MIN,
  DEFAULT_PROMPTS,
  DEFAULT_VOICES,
  MAX_MODE_PROMPT_CHARS,
  MODES,
  VOICE_CHARS_DEFAULT,
  VOICE_CHARS_KEY,
  VOICE_CHARS_MAX,
  VOICE_CHARS_MIN,
  VOICE_CHARS_STEP,
  clampInt,
  normalizeWebchatModelId,
  type ConversationMode,
} from "@/lib/modes";

// ── Consignes côté service (table settings — settings:get/set) ─────────
// Lot audit 2026-11-21 : toutes les lectures/écritures passent par emitAck
// (chien de garde 8 s). Avant : socket coupée → promesse jamais résolue,
// `promptsLoaded` faux pour toujours (13 textareas morts sans explication),
// et les échecs de sauvegarde étaient avalés (`void save…` sans test).

function getServerPrompts(): Promise<Record<string, string> | null> {
  return emitAck<{ value?: unknown }>("settings:get", {
    key: "hermes.modes.prompts",
  }).then((res) => {
    if (res === null) return null;
    const raw = res.value;
    if (!raw || typeof raw !== "string") return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? flattenPrompts(parsed) : {};
    } catch {
      return {};
    }
  });
}

function flattenPrompts(parsed: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [mode, map] of Object.entries(parsed)) {
    if (!map || typeof map !== "object") continue;
    for (const [voice, text] of Object.entries(map as Record<string, unknown>)) {
      if (typeof text === "string") out[`${mode}.${voice}`] = text;
    }
  }
  return out;
}

function saveServerPrompts(flat: Record<string, string>): Promise<boolean> {
  // Replie en { mode: { voix: texte } } — la clé exacte attendue par le service.
  const nested: Record<string, Record<string, string>> = {};
  for (const [key, text] of Object.entries(flat)) {
    const [mode, voice] = key.split(".");
    if (!mode || !voice) continue;
    (nested[mode] ??= {})[voice] = text;
  }
  return emitAck<{ ok?: boolean }>("settings:set", {
    key: "hermes.modes.prompts",
    value: JSON.stringify(nested),
  }).then((res) => res?.ok === true);
}

// ── Longueur des interventions (F-58) — côté service, relu à chaque tour ──

function getServerVoiceChars(): Promise<number | null> {
  return emitAck<{ value?: unknown }>("settings:get", { key: VOICE_CHARS_KEY }).then(
    (res) => {
      if (res === null) return null;
      // (audit 2026-11-21) clé jamais enregistrée → valeur null/absente :
      // Number(null) vaut 0, fini, donc le clamp renvoyait 500 au lieu du
      // défaut 2000 (le compteur mentait et un clic « + » changeait
      // silencieusement le comportement réel du service).
      if (res.value == null || res.value === "") return VOICE_CHARS_DEFAULT;
      const n = Number(res.value);
      if (!Number.isFinite(n)) return VOICE_CHARS_DEFAULT;
      // Bornes + alignement au pas (500) : une valeur stockée hors grille
      // (2200) ne faisait plus « sauter » de 700 au premier clic −.
      const stepped = Math.round(n / VOICE_CHARS_STEP) * VOICE_CHARS_STEP;
      return Math.min(VOICE_CHARS_MAX, Math.max(VOICE_CHARS_MIN, stepped));
    }
  );
}

function saveServerVoiceChars(v: number): Promise<boolean> {
  return emitAck<{ ok?: boolean }>("settings:set", {
    key: VOICE_CHARS_KEY,
    value: String(v),
  }).then((res) => res?.ok === true);
}

// ── Briques de la page ─────────────────────────────────────────────────

/** Une carte par mode — la structure rend les sections visibles. */
function ModeCard({
  icon: Icon,
  title,
  sub,
  children,
}: {
  icon: typeof Code2;
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-border bg-muted/40">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex size-[30px] flex-none items-center justify-center rounded-lg border border-hermes/25 bg-card text-hermes-text">
          <Icon className="size-[15px]" />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-bold leading-tight tracking-tight">{title}</div>
          <div className="mt-px text-[11px] leading-snug text-muted-foreground">{sub}</div>
        </div>
      </div>
      <div className="px-4 pb-2 pt-1">{children}</div>
    </section>
  );
}

/** Une ligne de réglage : libellé + description à gauche, contrôle à droite. */
function Row({
  label,
  desc,
  tip,
  children,
  fixed,
}: {
  label: string;
  desc: string;
  tip?: string;
  children?: React.ReactNode;
  /** Valeur non réglable (règle du mode, pas un réglage). */
  fixed?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-7 gap-y-2 border-b border-border/70 py-3 last:border-b-0">
      <div className="min-w-0 max-w-[420px] flex-1">
        <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
          {label}
          {tip ? <InfoTip>{tip}</InfoTip> : null}
        </div>
        <div className="mt-px text-[11px] leading-snug text-muted-foreground">{desc}</div>
      </div>
      <div className="flex-none">{fixed ? (
        <span className="text-[12.5px] font-semibold text-hermes-text">{fixed}</span>
      ) : (
        children
      )}</div>
    </div>
  );
}

/** Petit compteur borné — s'arrête à la limite, comme dans le sélecteur. */
function Stepper({
  value,
  min,
  max,
  maxLabel,
  step = 1,
  onChange,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  maxLabel: string;
  /** Pas entre deux clics — 1 par défaut (bornes ramenées au multiple). */
  step?: number;
  onChange: (v: number) => void;
  ariaLabel: string;
}) {
  const clampStep = (v: number) =>
    Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <span className="inline-flex items-center overflow-hidden rounded-lg border border-border bg-card">
      <Button
        type="button"
        variant="ghost"
        onClick={() => onChange(clampStep(value - step))}
        disabled={value <= min}
        aria-label={`Moins — ${ariaLabel}`}
        className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35"
      >
        −
      </Button>
      <span className="flex h-7 min-w-[68px] items-center justify-center gap-1 border-x border-border text-[12.5px] font-bold tabular-nums">
        {value}
        <small className="text-[11px] font-medium text-muted-foreground">/ {maxLabel}</small>
      </span>
      <Button
        type="button"
        variant="ghost"
        onClick={() => onChange(clampStep(value + step))}
        disabled={value >= max}
        aria-label={`Plus — ${ariaLabel}`}
        className="flex h-7 w-7 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35"
      >
        +
      </Button>
    </span>
  );
}

/** Une voix avec son modèle — « qui travaille » version Paramètres.
 *  F-30b : la liste porte les modèles du moteur ET les chats IA web. */
function VoiceRow({
  name,
  role,
  model,
  models,
  onChange,
}: {
  name: string;
  role: string;
  model: string | null;
  models: ModelOption[];
  onChange: (modelId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = modelLabelOf(model ?? "", models);
  return (
    <div className="border-t border-border/70 first:border-t-0">
      <div className="flex items-center gap-2 py-2">
        <span className="flex-none text-[12.5px] font-bold">{name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{role}</span>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "inline-flex max-w-[190px] flex-none items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors",
            model
              ? "border-hermes/35 bg-hermes/10 text-hermes-text"
              : "border-border bg-card text-foreground hover:bg-muted"
          )}
        >
          <span className="truncate">{model ? label : "Modèle de la conversation"}</span>
          <ChevronDown className="h-2.5 w-2.5 flex-none" />
        </Button>
      </div>
      {open ? (
        <div className="mb-1.5 max-h-52 overflow-y-auto rounded-xl border border-dashed border-border bg-background p-1">
          <ModelChoiceList
            models={models}
            value={model}
            onPick={(id) => {
              onChange(id);
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Modèle du mode (chat/plan/code) — le défaut des nouvelles conversations,
 *  modèle du moteur OU chat IA web ; sans choix, celui de la conversation. */
function ModeModelRow({
  model,
  models,
  onChange,
}: {
  model: string | null;
  models: ModelOption[];
  onChange: (modelId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "inline-flex max-w-[260px] items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
          model
            ? "border-hermes/35 bg-hermes/10 text-hermes-text"
            : "border-border bg-card text-foreground hover:bg-muted"
        )}
      >
        <span className="truncate">
          {model ? modelLabelOf(model, models) : "Modèle de la conversation"}
        </span>
        <ChevronDown className="h-2.5 w-2.5 flex-none" />
      </Button>
      {open ? (
        <div className="mt-1.5 max-h-52 overflow-y-auto rounded-xl border border-dashed border-border bg-background p-1">
          <ModelChoiceList
            models={models}
            value={model}
            onPick={(id) => {
              onChange(id);
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

const PLACEHOLDER_HINTS: Record<string, { key: string; title: string }[]> = {
  "debate.conseiller": [
    { key: "{angle}", title: "Insère {angle} — remplacé par la posture du conseiller (Sceptique, Pragmatique, Innovateur)" },
    { key: "{tours}", title: "Insère {tours} — remplacé par le nombre de tours du débat" },
  ],
  "debate.juge": [
    { key: "{tours}", title: "Insère {tours} — remplacé par le nombre de tours du débat" },
  ],
  "council.president": [
    { key: "{membres}", title: "Insère {membres} — remplacé par le nombre de membres du conseil" },
  ],
  "auto.reprise": [
    { key: "{reprises}", title: "Insère {reprises} — remplacé par le nombre de reprises restantes" },
  ],
};

/** Éditeur d'une consigne — compteur, réinitialisation un par un, mots-clés. */
function PromptCard({
  promptKey,
  value,
  onChange,
  onReset,
  dirty,
  hint,
  ready = true,
}: {
  promptKey: string;
  value: string;
  onChange: (text: string) => void;
  onReset: () => void;
  dirty: boolean;
  hint?: React.ReactNode;
  /** M-7 : false tant que les surcharges serveur ne sont pas chargées —
   *  une sauvegarde partie avant le chargement aurait écrasé les surcharges
   *  des autres modes encore inconnues de l'écran. */
  ready?: boolean;
}) {
  const meta = MODE_PROMPT_META[promptKey] ?? { title: promptKey, used: "" };
  const taRef = useRef<HTMLTextAreaElement>(null);
  const chips = PLACEHOLDER_HINTS[promptKey] ?? [];
  return (
    <div className="mb-3 mt-1 rounded-xl border border-border bg-card px-3.5 py-3">
      <div className="mb-1.5">
        <div className="text-[12.5px] font-semibold">{meta.title}</div>
        <div className="mt-px text-[11px] text-muted-foreground">{meta.used}</div>
      </div>
      <Textarea
        ref={taRef}
        value={value}
        rows={3}
        maxLength={MAX_MODE_PROMPT_CHARS}
        disabled={!ready}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_MODE_PROMPT_CHARS))}
        placeholder={
          promptKey === "chat.main" || promptKey === "compare.main"
            ? "Laisser vide — rien n'est ajouté. Écrire ici une consigne courte si besoin."
            : undefined
        }
        aria-label={meta.title}
        className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[12.5px] leading-relaxed focus:outline-hermes"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        {chips.map((c) => (
          <Button
            key={c.key}
            type="button"
            variant="ghost"
            title={c.title}
            aria-label={c.title}
            onClick={() => {
              const ta = taRef.current;
              if (!ta) return;
              const pos = ta.selectionStart ?? value.length;
              const next = value.slice(0, pos) + c.key + value.slice(pos);
              onChange(next.slice(0, MAX_MODE_PROMPT_CHARS));
              requestAnimationFrame(() => {
                ta.focus();
                ta.selectionStart = ta.selectionEnd = pos + c.key.length;
              });
            }}
            className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted"
          >
            {c.key}
          </Button>
        ))}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {value.length.toLocaleString("fr-FR")} / {MAX_MODE_PROMPT_CHARS.toLocaleString("fr-FR")}
        </span>
        {dirty ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onReset}
            className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-semibold text-foreground hover:bg-muted"
          >
            Réinitialiser
          </Button>
        ) : null}
      </div>
      {hint ? (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

const MODE_PROMPT_META: Record<string, { title: string; used: string }> = {
  "chat.main": { title: "Consigne du mode Chat", used: "ajoutée à chaque message, telle quelle — optionnelle" },
  "plan.main": { title: "Consigne du mode Plan", used: "appliquée à chaque message d'une conversation en mode Plan" },
  "code.main": { title: "Consigne du mode Code", used: "appliquée à chaque message d'une conversation en mode Code" },
  "debate.conseiller": { title: "Conseiller", used: "utilisée par chaque conseiller — Sceptique · Pragmatique · Innovateur" },
  "debate.juge": { title: "Juge", used: "utilisée au tour du verdict — une seule fois par débat" },
  "council.membre": { title: "Membre", used: "utilisée par chaque membre, en parallèle et sans se connaître" },
  "council.president": { title: "Président", used: "utilisée après la collecte anonymisée A, B, C…" },
  "auto.debat": { title: "Débat", used: "étape de cadrage — si Débat préalable est activé" },
  "auto.plan": { title: "Plan", used: "étape de planification" },
  "auto.code": { title: "Code", used: "étape de modification" },
  "auto.test": { title: "Test", used: "étape de preuve" },
  "auto.reprise": { title: "Reprise", used: "après un échec prouvé — 0 à 3 fois, selon le réglage de la conversation" },
  "compare.main": { title: "Consigne commune", used: "ajoutée aux deux colonnes si renseignée — sinon le message part tel quel" },
};

const PROMPTS_BY_MODE: Record<ConversationMode, string[]> = {
  chat: ["chat.main"],
  plan: ["plan.main"],
  code: ["code.main"],
  compare: ["compare.main"],
  debate: ["debate.conseiller", "debate.juge"],
  council: ["council.membre", "council.president"],
  auto: ["auto.debat", "auto.plan", "auto.code", "auto.test", "auto.reprise"],
};

const MODE_META: Record<
  ConversationMode,
  { icon: typeof Code2; title: string; sub: string }
> = {
  chat: { icon: MessagesSquare, title: "Chat", sub: "la conversation simple — rien d'ajouté par défaut" },
  plan: { icon: ScrollText, title: "Plan", sub: "un plan d'étapes d'abord — rien n'est modifié avant votre accord" },
  code: { icon: Code2, title: "Code", sub: "lire avant de changer — chaque changement est prouvé" },
  compare: { icon: Columns2, title: "Comparer", sub: "le même message à deux modèles, côte à côte" },
  debate: { icon: MessagesSquare, title: "Débat", sub: "3 conseillers dialoguent, un juge tranche" },
  council: { icon: Users, title: "Conseil", sub: "membres en parallèle · lecture seule · président fusionne" },
  auto: { icon: Workflow, title: "Auto", sub: "débat → plan → code → test · sans confirmation" },
};

// ── La section ─────────────────────────────────────────────────────────

export function ModesSection({
  models,
  connected = true,
}: {
  models: ModelOption[];
  /** État socket transmis par le panneau racine — une section « consignes »
   *  tout juste lue doit pouvoir dire POURQUOI elle est en attente. */
  connected?: boolean;
}) {
  const { toast } = useToast();
  const [rev, setRev] = useState(0);
  /** Surcharges des consignes côté service (chargées à l'ouverture). */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  // Lot audit 2026-11-21 : lecture jamais acquittée (service muet) —
  // avant, 13 textareas restaient désactivés sans la moindre explication.
  const [promptsError, setPromptsError] = useState(false);
  // M-7 (revue 2026-11-19) : true dès la première édition locale — le
  // chargement serveur tardif ne doit pas écraser une saisie en cours.
  const promptsTouchedRef = useRef(false);
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  const loadPrompts = useCallback(() => {
    setPromptsError(false);
    void getServerPrompts().then((ov) => {
      if (ov === null) {
        setPromptsError(true);
        return;
      }
      // M-7 (revue 2026-11-19) : une saisie commencée AVANT l'arrivée du
      // chargement ne doit pas être écrasée par l'état serveur (la frappe
      // disparaissait). Le chargement n'installe ses valeurs que si aucune
      // édition locale n'a eu lieu entre-temps ; l'utilisateur repart
      // sinon de sa saisie, la sauvegarde débouncée fera converger le
      // service.
      if (!promptsTouchedRef.current) setOverrides(ov);
      setPromptsLoaded(true);
    });
  }, []);

  useEffect(() => {
    loadPrompts();
    return undefined;
  }, [loadPrompts]);

  /** Toast destructif commun aux échecs de sauvegarde (ack false ou
   *  chien de garde) — avant, l'UI affichait la valeur éditée comme si
   *  elle était enregistrée. */
  const reportSaveFailure = useCallback(
    (title: string) => {
      toast({
        title,
        description:
          "Le service n'a pas répondu — réessayez une fois la connexion rétablie.",
        variant: "destructive",
      });
    },
    [toast]
  );

  // Réglages client (défauts) — revus à chaque écriture du bus
  useEffect(() => onSettingsChanged(() => setRev((r) => r + 1)), []);
  const defaults = useMemo(() => {
    let voices: Record<string, Record<string, string | null>> = {};
    let modeModels: Record<string, string | null> = {};
    try {
      const raw = readClientSetting<string>("hermes.modes.voices");
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object")
          voices = parsed as typeof voices;
      }
      const rawModels = readClientSetting<string>("hermes.modes.models");
      if (rawModels) {
        const parsed = JSON.parse(rawModels) as unknown;
        if (parsed && typeof parsed === "object") {
          for (const [modeKey, id] of Object.entries(parsed as Record<string, unknown>)) {
            // Lot audit : rejeter ce qui n'est ni string ni null (JSON
            // corrompu s'affichait brut dans une pastille de modèle).
            if (typeof id === "string") {
              modeModels[modeKey] = normalizeWebchatModelId(id);
            } else if (id === null) {
              modeModels[modeKey] = null;
            }
          }
        }
      }
    } catch {
      /* charge invalide */
    }
    return {
      defaultMode: readClientSetting<ConversationMode>("hermes.modes.defaultMode"),
      rounds: clampInt(
        readClientSetting<number>("hermes.modes.debateRounds"),
        DEBATE_ROUNDS_MIN,
        DEBATE_ROUNDS_MAX,
        DEBATE_ROUNDS_MIN
      ),
      members: clampInt(
        readClientSetting<number>("hermes.modes.councilMembers"),
        COUNCIL_MEMBERS_MIN,
        COUNCIL_MEMBERS_MAX,
        COUNCIL_MEMBERS_MIN
      ),
      retries: clampInt(
        readClientSetting<number>("hermes.modes.autoRetries"),
        AUTO_RETRIES_MIN,
        AUTO_RETRIES_MAX,
        2
      ),
      autoDebate: readClientSetting<boolean>("hermes.modes.autoDebate") !== false,
      showFlow: readClientSetting<boolean>("hermes.modes.showFlow") !== false,
      showModels: readClientSetting<boolean>("hermes.modes.showModels") !== false,
      voices,
      modeModels,
    };
  }, [rev]);

  const mergedVoicesFor = useCallback(
    (mode: ConversationMode): Record<string, string | null> => ({
      ...(DEFAULT_VOICES[mode] ?? {}),
      ...(defaults.voices[mode] ?? {}),
    }),
    [defaults.voices]
  );

  const setVoices = (mode: ConversationMode, voiceId: string, modelId: string | null) => {
    const next = {
      ...defaults.voices,
      [mode]: {
        ...(defaults.voices[mode] ?? {}),
        [voiceId]: modelId,
      },
    };
    writeClientSetting("hermes.modes.voices", JSON.stringify(next));
  };

  /** Modèle par défaut d'un mode sans voix (chat/plan/code) — registre
   *  hermes.modes.models : le défaut rejoint chaque nouvelle conversation
   *  qui passe sur ce mode. */
  const setModeModelDefault = (mode: ConversationMode, modelId: string | null) => {
    const next = { ...defaults.modeModels, [mode]: modelId };
    writeClientSetting("hermes.modes.models", JSON.stringify(next));
  };

  /** Débounce de la sauvegarde des consignes (300 ms) : chaque frappe dans
   *  un textarea posait une écriture SQLite + un broadcast settings:changed
   *  sur la socket (200 frappes = 200 écritures). */
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Record<string, string> | null>(null);
  const flushPendingPrompts = useCallback(() => {
    const pending = pendingSaveRef.current;
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    pendingSaveRef.current = null;
    if (pending) {
      void saveServerPrompts(pending).then((ok) => {
        if (!ok) reportSaveFailure("Consignes non enregistrées");
      });
    }
  }, [reportSaveFailure]);
  const debouncedSavePrompts = useCallback(
    (next: Record<string, string>) => {
      pendingSaveRef.current = next;
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = setTimeout(() => {
        saveDebounceRef.current = null;
        pendingSaveRef.current = null;
        void saveServerPrompts(next).then((ok) => {
          if (!ok) reportSaveFailure("Consignes non enregistrées");
        });
      }, 300);
    },
    [reportSaveFailure]
  );
  useEffect(
    () => () => {
      // Lot audit 2026-11-21 : FLUSH (et non clearTimeout) au démontage —
      // changer de section ou fermer le volet dans les 300 ms suivant une
      // frappe détruisait le minuteur AU LIEU de sauvegarder : la dernière
      // édition était perdue sans avertissement.
      flushPendingPrompts();
    },
    [flushPendingPrompts]
  );

  /** Édite une consigne : clamp 4 000, ajout/retrait de la surcharge —
   *  l'état suit à la frappe, la sauvegarde serveur est débouncée
   *  (effet au prochain message). */
  const editPrompt = (key: string, text: string) => {
    // M-7 : toute édition marque la saisie locale — le chargement serveur
    // encore en vol ne devra pas écraser ces valeurs à son arrivée.
    promptsTouchedRef.current = true;
    const clean = text.slice(0, MAX_MODE_PROMPT_CHARS);
    const next = { ...overridesRef.current };
    if (clean === DEFAULT_PROMPTS[key]) delete next[key];
    else next[key] = clean;
    setOverrides(next);
    debouncedSavePrompts(next);
  };

  const resetPrompt = async (key: string) => {
    const next = { ...overridesRef.current };
    delete next[key];
    setOverrides(next);
    // Revue P1-P7 : on ANNULE la sauvegarde débouncée en attente —
    // l'ancien flushPendingPrompts() lançait l'ANCIEN état en parallèle du
    // reset : deux écritures concurrentes, et la plus ancienne pouvait
    // arriver dernière et ressusciter l'override que le reset supprimait.
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    pendingSaveRef.current = null;
    const ok = await saveServerPrompts(next);
    if (!ok) {
      reportSaveFailure("Consignes non enregistrées");
      return;
    }
  };

  // F-58 — longueur visée des interventions du débat : lue au montage,
  // réécrite à chaque clic du pas ; le service relit la valeur À CHAQUE
  // TOUR — effet immédiat, même en plein débat, sans redémarrage.
  const [voiceChars, setVoiceChars] = useState(VOICE_CHARS_DEFAULT);
  useEffect(() => {
    getServerVoiceChars().then((v) => {
      if (v !== null) setVoiceChars(v);
    });
  }, []);
  const saveVoiceChars = async (v: number) => {
    setVoiceChars(v);
    const ok = await saveServerVoiceChars(v);
    if (!ok) reportSaveFailure("Longueur des interventions non enregistrée");
  };

  const promptValue = (key: string) => overrides[key] ?? DEFAULT_PROMPTS[key] ?? "";
  const promptDirty = (key: string) => overrides[key] !== undefined;

  const voices = {
    debate: mergedVoicesFor("debate"),
    council: mergedVoicesFor("council"),
    auto: mergedVoicesFor("auto"),
    compare: mergedVoicesFor("compare"),
  };

  const debateVoices = [
    { id: "sceptique", name: "Sceptique", role: "cherche ce qui casse" },
    { id: "pragmatique", name: "Pragmatique", role: "pèse le coût réel" },
    { id: "innovateur", name: "Innovateur", role: "cherche l'angle neuf" },
    { id: "juge", name: "Juge", role: "compare les tours, rend le verdict" },
  ];
  const memberLetters = ["A", "B", "C", "D", "E"].slice(0, defaults.members);
  const councilVoices = [
    ...memberLetters.map((L) => ({
      id: `membre-${L.toLowerCase()}`,
      name: `Membre ${L}`,
      role: "lecture seule — ne voit pas les autres",
    })),
    { id: "president", name: "Président", role: "compare les avis anonymisés, fusionne" },
  ];
  const autoVoices = [
    ...(defaults.autoDebate
      ? [{ id: "debat", name: "Débat", role: "cadrage préalable — 3 tours" }]
      : []),
    { id: "plan", name: "Plan", role: "chef de projet — étapes" },
    { id: "code", name: "Code", role: "constructeur — applique" },
    { id: "test", name: "Test", role: "testeur — prouve" },
  ];

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Modes de chat</h1>
      <p className="mt-1 mb-3 max-w-[560px] text-[12.5px] leading-relaxed text-muted-foreground">
        Une carte par mode, dans l&apos;ordre du sélecteur : réglages, voix et
        modèles, puis les consignes — ce que le mode ajoute à chaque message.
        Une conversation peut toujours changer ces réglages depuis la zone de
        message : c&apos;est elle qui décide du traitement du prochain message.
      </p>

      {/* Lot audit : service muet = explication visible + réessai — avant,
          les 13 zones restaient désactivées sans spinner ni raison. */}
      {!promptsLoaded && (promptsError || !connected) ? (
        <div
          role="alert"
          className="mt-1 mb-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-[12.5px] font-medium text-warning"
        >
          <span className="min-w-0 flex-1">
            Le service n&apos;est pas joignable — les consignes enregistrées ne
            sont pas chargées. Les zones d&apos;édition restent fermées pour ne
            rien écraser ; elles s&apos;ouvriront dès le chargement.
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={loadPrompts}
            className="h-7 flex-none cursor-pointer rounded-md border border-warning/50 px-3 text-[11px] font-semibold text-warning hover:bg-warning/10"
          >
            Réessayer
          </Button>
        </div>
      ) : null}

      {/* ── Général — ce que toute nouvelle conversation utilise ──────── */}
      <ModeCard icon={Layers} title="Général" sub="ce que toute nouvelle conversation utilise">
        <Row
          label="Mode des nouvelles conversations"
          desc="Le mode de démarrage d'une nouvelle conversation — Chat pour parler simplement."
        >
          <Select
            value={defaults.defaultMode}
            onValueChange={(v) => writeClientSetting("hermes.modes.defaultMode", v)}
          >
            <SelectTrigger
              aria-label="Mode des nouvelles conversations"
              className="h-8 w-[190px] rounded-lg bg-card px-3 text-[12.5px] font-medium hover:border-hermes"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label} — {m.desc}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="Déroulé dans la conversation"
          desc="Tours du débat, membres du conseil, étapes de l'auto s'affichent dans la conversation, au-dessus de la réponse."
        >
          <Switch
            aria-label="Déroulé dans la conversation"
            checked={defaults.showFlow}
            onCheckedChange={(on) => writeClientSetting("hermes.modes.showFlow", on)}
          />
        </Row>
        <Row
          label="Modèles dans le déroulé"
          desc="Chaque voix affiche son modèle ; désactivé, les modèles ne restent visibles que dans « qui travaille »."
        >
          <Switch
            aria-label="Modèles dans le déroulé"
            checked={defaults.showModels}
            onCheckedChange={(on) => writeClientSetting("hermes.modes.showModels", on)}
          />
        </Row>
      </ModeCard>

      {/* ── Chat ─────────────────────────────────────────────────────── */}
      <ModeCard {...MODE_META.chat}>
        <Row
          label="Modèle du mode"
          desc="Ce que Chat utilise par défaut — modèle du moteur ou chat IA web ; sans choix, celui de la conversation."
        >
          <ModeModelRow
            model={defaults.modeModels.chat ?? null}
            models={models}
            onChange={(mid) => setModeModelDefault("chat", mid)}
          />
        </Row>
        <PromptCard
          ready={promptsLoaded}
promptKey="chat.main"
          value={promptValue("chat.main")}
          dirty={promptDirty("chat.main")}
          onChange={(t) => void editPrompt("chat.main", t)}
          onReset={() => void resetPrompt("chat.main")}
        />
      </ModeCard>

      {/* ── Plan ─────────────────────────────────────────────────────── */}
      <ModeCard {...MODE_META.plan}>
        <Row
          label="Modèle du mode"
          desc="Ce que Plan utilise par défaut — modèle du moteur ou chat IA web ; sans choix, celui de la conversation."
        >
          <ModeModelRow
            model={defaults.modeModels.plan ?? null}
            models={models}
            onChange={(mid) => setModeModelDefault("plan", mid)}
          />
        </Row>
        <PromptCard
          ready={promptsLoaded}
promptKey="plan.main"
          value={promptValue("plan.main")}
          dirty={promptDirty("plan.main")}
          onChange={(t) => void editPrompt("plan.main", t)}
          onReset={() => void resetPrompt("plan.main")}
          hint="Au premier message, le moteur est aussi prié de se mettre en mode plan — s'il ne sait pas, le message part quand même : cette consigne reste la garantie."
        />
      </ModeCard>

      {/* ── Code ─────────────────────────────────────────────────────── */}
      <ModeCard {...MODE_META.code}>
        <Row
          label="Modèle du mode"
          desc="Ce que Code utilise par défaut — modèle du moteur ou chat IA web ; sans choix, celui de la conversation."
        >
          <ModeModelRow
            model={defaults.modeModels.code ?? null}
            models={models}
            onChange={(mid) => setModeModelDefault("code", mid)}
          />
        </Row>
        <PromptCard
          ready={promptsLoaded}
promptKey="code.main"
          value={promptValue("code.main")}
          dirty={promptDirty("code.main")}
          onChange={(t) => void editPrompt("code.main", t)}
          onReset={() => void resetPrompt("code.main")}
        />
      </ModeCard>

      {/* ── Comparer ─────────────────────────────────────────────────── */}
      <ModeCard {...MODE_META.compare}>
        <Row
          label="Modèles A et B"
          desc="Le défaut des nouvelles conversations — chacune ajuste ensuite ses deux colonnes dans « qui travaille »."
        />
        <div className="mb-2 rounded-xl border border-border bg-background px-3 py-1">
          {[
            { id: "a", name: "Voix A", role: "première colonne" },
            { id: "b", name: "Voix B", role: "seconde colonne" },
          ].map((v) => (
            <VoiceRow
              key={v.id}
              name={v.name}
              role={v.role}
              model={voices.compare[v.id] ?? null}
              models={models}
              onChange={(mid) => setVoices("compare", v.id, mid)}
            />
          ))}
        </div>
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Consigne
        </div>
        <PromptCard
          ready={promptsLoaded}
promptKey="compare.main"
          value={promptValue("compare.main")}
          dirty={promptDirty("compare.main")}
          onChange={(t) => void editPrompt("compare.main", t)}
          onReset={() => void resetPrompt("compare.main")}
          hint="Contrairement au débat et au conseil, Comparer n'a qu'une consigne — les deux colonnes reçoivent exactement le même texte : la différence doit venir des modèles (A/B), pas des instructions."
        />
      </ModeCard>

      {/* ── Débat ────────────────────────────────────────────────────── */}
      <ModeCard {...MODE_META.debate}>
        <Row
          label="Tours par défaut"
          desc="3 à 10 — le compteur s'arrête ici comme dans le menu du sélecteur."
        >
          <Stepper
            value={defaults.rounds}
            min={DEBATE_ROUNDS_MIN}
            max={DEBATE_ROUNDS_MAX}
            maxLabel={`${DEBATE_ROUNDS_MAX} max`}
            ariaLabel="tours du débat"
            onChange={(v) => writeClientSetting("hermes.modes.debateRounds", v)}
          />
        </Row>
        <Row
          label="Longueur des interventions"
          desc="500 à 8000 caractères par voix — relu à chaque tour : effet immédiat, même en plein débat. Plus court = débat plus rapide et plus lisible."
          tip="La consigne part dans la note de chaque voix (« Votre intervention tient en N caractères maximum ») ; le juge n'est pas borné. 2000 est un bon équilibre — au-delà de 4000, les tours redeviennent très longs."
        >
          <Stepper
            value={voiceChars}
            min={VOICE_CHARS_MIN}
            max={VOICE_CHARS_MAX}
            step={VOICE_CHARS_STEP}
            maxLabel={String(VOICE_CHARS_MAX)}
            ariaLabel="longueur des interventions"
            onChange={(v) => void saveVoiceChars(v)}
          />
        </Row>
        <Row
          label="Angles des conseillers"
          desc="Trois postures fixes — le débat n'invente pas ses conseillers."
          tip="Sceptique cherche ce qui casse, pragmatique pèse le coût réel, innovateur cherche l'angle neuf — trois postures pour contredire sur des faits."
          fixed="Sceptique · Pragmatique · Innovateur"
        />
        <Row
          label="Modèles des voix — débat"
          desc="Un modèle par conseiller et pour le juge ; sans choix, celui de la conversation."
        />
        <div className="mb-2 rounded-xl border border-border bg-background px-3 py-1">
          {debateVoices.map((v) => (
            <VoiceRow
              key={v.id}
              name={v.name}
              role={v.role}
              model={voices.debate[v.id] ?? null}
              models={models}
              onChange={(mid) => setVoices("debate", v.id, mid)}
            />
          ))}
        </div>
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Consignes — une par voix
        </div>
        <PromptCard
          ready={promptsLoaded}
promptKey="debate.conseiller"
          value={promptValue("debate.conseiller")}
          dirty={promptDirty("debate.conseiller")}
          onChange={(t) => void editPrompt("debate.conseiller", t)}
          onReset={() => void resetPrompt("debate.conseiller")}
        />
        <PromptCard
          ready={promptsLoaded}
promptKey="debate.juge"
          value={promptValue("debate.juge")}
          dirty={promptDirty("debate.juge")}
          onChange={(t) => void editPrompt("debate.juge", t)}
          onReset={() => void resetPrompt("debate.juge")}
        />
      </ModeCard>

      {/* ── Conseil ──────────────────────────────────────────────────── */}
      <ModeCard {...MODE_META.council}>
        <Row
          label="Membres par défaut"
          desc="2 à 5 — anonymisés A, B, C… dans la conversation."
        >
          <Stepper
            value={defaults.members}
            min={COUNCIL_MEMBERS_MIN}
            max={COUNCIL_MEMBERS_MAX}
            maxLabel={`${COUNCIL_MEMBERS_MAX} max`}
            ariaLabel="membres du conseil"
            onChange={(v) => writeClientSetting("hermes.modes.councilMembers", v)}
          />
        </Row>
        <Row
          label="Lecture seule"
          desc="Les membres répondent sans pouvoir rien modifier."
          tip="Ce n'est pas un réglage : c'est la règle du conseil. Les membres ne peuvent rien écrire ni exécuter — seul le président rédige la réponse finale."
          fixed="toujours en place"
        />
        <Row
          label="Modèles des voix — conseil"
          desc="Un modèle par membre et pour le président ; sans choix, celui de la conversation."
        />
        <div className="mb-2 rounded-xl border border-border bg-background px-3 py-1">
          {councilVoices.map((v) => (
            <VoiceRow
              key={v.id}
              name={v.name}
              role={v.role}
              model={voices.council[v.id] ?? null}
              models={models}
              onChange={(mid) => setVoices("council", v.id, mid)}
            />
          ))}
        </div>
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Consignes — une par rôle
        </div>
        <PromptCard
          ready={promptsLoaded}
promptKey="council.membre"
          value={promptValue("council.membre")}
          dirty={promptDirty("council.membre")}
          onChange={(t) => void editPrompt("council.membre", t)}
          onReset={() => void resetPrompt("council.membre")}
        />
        <PromptCard
          ready={promptsLoaded}
promptKey="council.president"
          value={promptValue("council.president")}
          dirty={promptDirty("council.president")}
          onChange={(t) => void editPrompt("council.president", t)}
          onReset={() => void resetPrompt("council.president")}
        />
      </ModeCard>

      {/* ── Auto ─────────────────────────────────────────────────────── */}
      <ModeCard {...MODE_META.auto}>
        <Row
          label="Débat préalable"
          desc="Cadrage avant d'agir — désactivable pour les tâches évidentes."
        >
          <Switch
            aria-label="Débat préalable"
            checked={defaults.autoDebate}
            onCheckedChange={(on) => writeClientSetting("hermes.modes.autoDebate", on)}
          />
        </Row>
        <Row
          label="Reprises après échec"
          desc="0 à 3 — on corrige la vraie cause, jamais une rustine."
        >
          <Stepper
            value={defaults.retries}
            min={AUTO_RETRIES_MIN}
            max={AUTO_RETRIES_MAX}
            maxLabel={`${AUTO_RETRIES_MAX} max`}
            ariaLabel="reprises après échec"
            onChange={(v) => writeClientSetting("hermes.modes.autoRetries", v)}
          />
        </Row>
        <Row
          label="Modèles des étapes"
          desc="Un modèle par étape ; sans choix, celui de la conversation."
        />
        <div className="mb-2 rounded-xl border border-border bg-background px-3 py-1">
          {autoVoices.map((v) => (
            <VoiceRow
              key={v.id}
              name={v.name}
              role={v.role}
              model={voices.auto[v.id] ?? null}
              models={models}
              onChange={(mid) => setVoices("auto", v.id, mid)}
            />
          ))}
        </div>
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Consignes — une par étape
        </div>
        {PROMPTS_BY_MODE.auto.map((key) => (
          <PromptCard
            key={key}
            ready={promptsLoaded}
            promptKey={key}
            value={promptValue(key)}
            dirty={promptDirty(key)}
            onChange={(t) => void editPrompt(key, t)}
            onReset={() => void resetPrompt(key)}
            hint={
              key === "auto.reprise"
                ? "La vraie cause est obligatoire — jamais de rustine posée au hasard : c'est la règle du mode, pas un réglage. Cette consigne encadre chaque reprise, pas la chaîne entière."
                : undefined
            }
          />
        ))}
      </ModeCard>

      <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <Check className="mt-0.5 h-3 w-3 flex-none" />
        Les consignes sont enregistrées côté service et relues à chaque envoi :
        une modification s&apos;applique au prochain message de toutes les
        conversations — sans redémarrage. Les mots-clés {"{angle}"} {"{tours}"}{" "}
        {"{membres}"} {"{reprises}"} sont remplacés au moment de l&apos;envoi,
        jamais enregistrés déjà remplacés. Les limites affichées (3–10 tours,
        2–5 membres, 0–3 reprises, 4 000 caractères) sont revalidées par le
        service.
      </p>
    </section>
  );
}
