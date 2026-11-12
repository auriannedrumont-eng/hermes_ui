// Sélecteur de modèle façon ChatGPT : liste déroulante (en-tête ou composer)
"use client";

import { Check, ChevronDown, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ModelOption } from "@/lib/chat-types";

interface ModelPickerProps {
  models: ModelOption[];
  selectedModel: string | null;
  source: "gateway" | "catalogue" | null;
  mode: "gateway" | "demo" | null;
  disabled?: boolean;
  /** Variante compacte (dans le composer). */
  compact?: boolean;
  onSelect: (id: string) => void;
}

export function ModelPicker({
  models,
  selectedModel,
  source,
  mode,
  disabled,
  compact = false,
  onSelect,
}: ModelPickerProps) {
  const list = Array.isArray(models) ? models : [];
  const current = list.find((m) => m.id === selectedModel) ?? null;
  const label = current?.label ?? "Modèle";
  const busy = disabled || list.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          disabled={busy}
          className={
            compact
              ? "h-8 gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              : "h-9 gap-1.5 rounded-xl px-2.5 text-[13.5px] font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          }
          aria-label={`Modèle sélectionné : ${label}. Changer de modèle`}
        >
          {compact ? <Sparkles className="h-3.5 w-3.5 shrink-0 text-hermes" /> : null}
          <span className="max-w-40 truncate sm:max-w-none">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compact ? "start" : "center"} className="w-72">
        <DropdownMenuLabel className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-hermes" />
          Choisir un modèle
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-80 overflow-y-auto p-1">
          {list.map((m) => {
            const isSelected = m.id === selectedModel;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onSelect(m.id)}
                role="menuitemradio"
                aria-checked={isSelected}
                className={`flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors ${
                  isSelected ? "bg-muted/70" : "hover:bg-muted/50"
                }`}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {isSelected ? (
                    <Check className="h-4 w-4 text-hermes" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-medium">{m.label}</span>
                    {m.badge ? (
                      <span
                        className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium ${
                          m.badge === "Défaut"
                            ? "bg-muted text-muted-foreground"
                            : "bg-hermes/10 text-hermes"
                        }`}
                      >
                        {m.badge === "Flagship" ? <Zap className="h-2.5 w-2.5" /> : null}
                        {m.badge}
                      </span>
                    ) : null}
                  </span>
                  {m.description ? (
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                      {m.description}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block text-[10.5px] text-muted-foreground/70">
                    {m.provider}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <p className="px-3 py-2 text-[11px] leading-snug text-muted-foreground">
          {source === "gateway" && mode === "gateway"
            ? "Modèles exposés par la gateway Hermes connectée."
            : "Catalogue Hermes (Nous Research). Connectez HERMES_GATEWAY_URL pour servir ces modèles via l'agent."}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ModelPicker;
