// Section « Fournisseurs » (LLM) et « Clés de services » du volet
// Paramètres v4 — porte-clés multi-clés, test réel exécuté par le service,
// stratégie d'ordre d'utilisation. Maquette de référence :
// design/maquette-parametres-v4.html (panes p-fournisseurs / p-cles).
//
// Sécurité : le secret est saisi une fois, envoyé au service, puis oublié
// côté client — l'UI ne rend que la vue masquée (sk-••••7f3a).
"use client";

import { useState } from "react";
import {
  ChevronDown,
  Globe,
  Layers,
  Loader2,
  Lock,
  Trash2,
} from "lucide-react";
import {
  keyStatusLabel,
  providerCardStatus,
  type ProvidersApi,
} from "@/hooks/use-providers";
import type { ProviderKind, ProviderStrategy, ProviderView } from "@/lib/chat-types";
import { AddLine, Pastille } from "@/components/settings/bits";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const STRATEGY_LABELS: Record<ProviderStrategy, { label: string; sub?: string }> = {
  fill_first: { label: "Première disponible" },
  round_robin: { label: "Tournante", sub: "changement à chaque tour" },
  least_used: { label: "La moins utilisée" },
};

const TEXTS: Record<
  ProviderKind,
  {
    title: string;
    sub: string;
    addLabel: string;
    addHint: string;
    addPlaceholder: string;
    note?: string;
  }
> = {
  llm: {
    title: "Fournisseurs",
    sub: "Vos comptes d'accès aux modèles de langage. Plusieurs clés par fournisseur : quand l'une atteint sa limite, la suivante prend le relais.",
    addLabel: "Ajouter un fournisseur",
    addHint:
      "Fournisseurs connus : z.ai (clé API ou abonnement GLM Coding Plan), opencode, OpenRouter (avec des modèles gratuits « :free »), Anthropic, Mistral, Ollama… Pour les autres, collez leur adresse.",
    addPlaceholder: "Nom ou adresse du fournisseur",
  },
  service: {
    title: "Clés de services",
    sub: "Recherche web, images, vidéo — chaque service demande sa propre clé. Plusieurs clés possibles par service.",
    addLabel: "Ajouter un service",
    addHint: "Tavily, Exa, FAL.ai… ou n'importe quelle adresse d'API.",
    addPlaceholder: "Nom du service ou adresse",
    note: "Les clés restent sur votre machine, dans Hermes — jamais dans le navigateur.",
  },
};

// ── Une carte fournisseur (porte-clés) ───────────────────────────────

function ProviderCard({ provider, api }: { provider: ProviderView; api: ProvidersApi }) {
  const { toast } = useToast();
  const [showAddKey, setShowAddKey] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [addingKey, setAddingKey] = useState(false);
  const [showAdv, setShowAdv] = useState(false);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const status = providerCardStatus(provider);
  const isLlm = provider.kind === "llm";

  const handleAddKey = async () => {
    if (!keySecret.trim() || addingKey) return;
    setAddingKey(true);
    const res = await api.addKey(provider.id, keyLabel.trim(), keySecret.trim());
    setAddingKey(false);
    if (res.error) {
      toast({ title: "Clé refusée", description: res.error, variant: "destructive" });
      return;
    }
    setKeyLabel("");
    setKeySecret("");
    setShowAddKey(false);
    toast({
      title: "Clé ajoutée",
      description: `« ${res.key?.label ?? keyLabel} » — pensez à la tester.`,
    });
  };

  const handleTest = async (keyId: string) => {
    if (testing.has(keyId)) return;
    setTesting((s) => new Set(s).add(keyId));
    const res = await api.testKey(keyId);
    setTesting((s) => {
      const next = new Set(s);
      next.delete(keyId);
      return next;
    });
    if (res.error) {
      toast({ title: "Test impossible", description: res.error, variant: "destructive" });
    }
  };

  const handleRemoveKey = async (keyId: string, label: string) => {
    const res = await api.removeKey(keyId);
    if (res.error) {
      toast({ title: "Suppression impossible", description: res.error, variant: "destructive" });
      return;
    }
    toast({ title: "Clé supprimée", description: `« ${label} » a été retirée du porte-clés.` });
  };

  const handleRemoveProvider = async () => {
    const res = await api.removeProvider(provider.id);
    if (res.error) {
      toast({ title: "Suppression impossible", description: res.error, variant: "destructive" });
      return;
    }
    toast({ title: `${provider.name} retiré`, description: "Ses clés ont été supprimées avec lui." });
  };

  const handleStrategy = async (strategy: ProviderStrategy) => {
    const res = await api.setStrategy(provider.id, strategy);
    if (res.error) {
      toast({ title: "Réglage impossible", description: res.error, variant: "destructive" });
    }
  };

  return (
    <div className="mb-2.5 rounded-[14px] border border-border bg-card px-4 py-3.5">
      {/* En-tête : icône + nom + pastille + tagline */}
      <div className="flex items-center gap-2.5">
        <span className="flex size-[30px] flex-none items-center justify-center rounded-[10px] bg-muted">
          {isLlm ? (
            <Layers className="size-[15px]" strokeWidth={2} />
          ) : (
            <Globe className="size-[15px]" strokeWidth={2} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <b className="text-[14px] font-semibold tracking-tight">{provider.name}</b>
            <Pastille tone={status.tone} label={status.label} />
          </div>
          <span className="block truncate text-[12px] text-muted-foreground">
            {provider.keyless
              ? "sur votre machine — aucune clé nécessaire"
              : provider.baseUrl
                ? `${provider.baseUrl} · ${provider.keys.length} clé${provider.keys.length > 1 ? "s" : ""}`
                : `${provider.keys.length} clé${provider.keys.length > 1 ? "s" : ""}`}
          </span>
        </div>
        <button
          type="button"
          title={`Retirer ${provider.name}`}
          aria-label={`Retirer ${provider.name}`}
          onClick={handleRemoveProvider}
          className="flex size-[26px] flex-none cursor-pointer items-center justify-center rounded-[8px] text-muted-foreground/70 transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-2 focus-visible:outline-red-500"
        >
          <Trash2 className="size-[13px]" strokeWidth={2} />
        </button>
      </div>

      {/* Porte-clés */}
      {provider.keys.length > 0 ? (
        <div className="mt-2.5">
          {provider.keys.map((k, i) => {
            const tone =
              k.status === "ok" ? "ok" : k.status === "untested" ? "warn" : "err";
            const label = keyStatusLabel(k.status, k.statusLabel);
            return (
              <div
                key={k.id}
                className={cn(
                  "flex items-center gap-2.5 py-[7px]",
                  i > 0 && "border-t border-border"
                )}
              >
                <span className="w-[86px] flex-none truncate text-[12.5px] font-medium">
                  {k.label}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
                  {k.masked}
                </code>
                <Pastille tone={tone} label={label ?? undefined} />
                <button
                  type="button"
                  onClick={() => handleTest(k.id)}
                  disabled={testing.has(k.id)}
                  className="flex h-[26px] flex-none cursor-pointer items-center gap-1.5 rounded-[8px] border border-border px-2.5 text-[11.5px] font-semibold text-foreground transition-colors hover:border-hermes hover:text-hermes focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-wait disabled:opacity-60"
                >
                  {testing.has(k.id) ? (
                    <Loader2 className="size-[12px] animate-spin" strokeWidth={2.2} />
                  ) : null}
                  {testing.has(k.id) ? "Test…" : "Tester"}
                </button>
                <button
                  type="button"
                  title={`Supprimer la clé « ${k.label} »`}
                  aria-label={`Supprimer la clé « ${k.label} »`}
                  onClick={() => handleRemoveKey(k.id, k.label)}
                  className="flex size-[24px] flex-none cursor-pointer items-center justify-center rounded-[7px] text-muted-foreground/60 transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-2 focus-visible:outline-red-500"
                >
                  <Trash2 className="size-[12px]" strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* + Ajouter une clé */}
      {!provider.keyless ? (
        <>
          <div className="mt-2">
            <AddLine onClick={() => setShowAddKey((v) => !v)}>Ajouter une clé</AddLine>
          </div>
          {showAddKey ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={keyLabel}
                onChange={(e) => setKeyLabel(e.target.value)}
                placeholder="Étiquette (ex. Perso)"
                aria-label="Étiquette de la clé"
                className="h-[32px] w-[150px] rounded-[9px] border border-border bg-background px-2.5 text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-hermes"
              />
              <input
                type="password"
                value={keySecret}
                onChange={(e) => setKeySecret(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAddKey();
                }}
                placeholder="Clé (sk-…)"
                aria-label="Valeur de la clé"
                className="h-[32px] min-w-[160px] flex-1 rounded-[9px] border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground/60 focus-visible:border-hermes"
              />
              <button
                type="button"
                onClick={handleAddKey}
                disabled={!keySecret.trim() || addingKey}
                className="h-[32px] cursor-pointer rounded-[9px] bg-hermes px-3 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-50"
              >
                {addingKey ? "Ajout…" : "Ajouter"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Réglages avancés : ordre d'utilisation des clés (LLM) */}
      {isLlm && !provider.keyless ? (
        <>
          <button
            type="button"
            onClick={() => setShowAdv((v) => !v)}
            className="mt-2.5 inline-flex cursor-pointer items-center gap-1 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-hermes"
          >
            <ChevronDown
              className={cn("size-[12px] transition-transform", showAdv && "rotate-180")}
              strokeWidth={2.2}
            />
            Réglages avancés
          </button>
          {showAdv ? (
            <div className="mt-2 rounded-[10px] bg-muted/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-medium">
                  Ordre d&apos;utilisation des clés
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    comment choisir la prochaine clé quand il faut changer
                  </span>
                </span>
                <div
                  role="radiogroup"
                  aria-label="Ordre d'utilisation des clés"
                  className="flex flex-none gap-0.5 rounded-[9px] bg-background p-[2.5px]"
                >
                  {(Object.keys(STRATEGY_LABELS) as ProviderStrategy[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={provider.strategy === s}
                      title={STRATEGY_LABELS[s].sub}
                      onClick={() => handleStrategy(s)}
                      className={cn(
                        "cursor-pointer rounded-[7px] px-[9px] py-[5px] text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground",
                        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-hermes",
                        provider.strategy === s && "bg-card font-semibold text-hermes shadow-sm"
                      )}
                    >
                      {STRATEGY_LABELS[s].label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ── Le panneau (Fournisseurs ou Clés de services) ────────────────────

export function ProvidersSection({
  kind,
  api,
}: {
  kind: ProviderKind;
  api: ProvidersApi;
}) {
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const texts = TEXTS[kind];
  const list = api.providers.filter((p) => p.kind === kind);

  const handleAdd = async () => {
    if (!name.trim() || adding) return;
    setAdding(true);
    const res = await api.addProvider(name.trim(), kind);
    setAdding(false);
    if (res.error) {
      toast({ title: "Ajout impossible", description: res.error, variant: "destructive" });
      return;
    }
    setName("");
    setShowAdd(false);
    toast({
      title: `${res.provider?.name ?? name} ajouté`,
      description: kind === "llm" ? "Ajoutez une première clé." : "Ajoutez sa clé.",
    });
  };

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">{texts.title}</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[13px] leading-relaxed text-muted-foreground">
        {texts.sub}
      </p>

      {list.map((p) => (
        <ProviderCard key={p.id} provider={p} api={api} />
      ))}
      {list.length === 0 ? (
        <p className="mb-4 rounded-[14px] border border-dashed border-border px-4 py-5 text-center text-[12.5px] text-muted-foreground">
          Aucun {kind === "llm" ? "fournisseur" : "service"} configuré pour l&apos;instant.
        </p>
      ) : null}

      <div className="mt-1">
        <AddLine onClick={() => setShowAdd((v) => !v)}>{texts.addLabel}</AddLine>
      </div>
      {showAdd ? (
        <div className="mt-2.5 rounded-[14px] border border-border bg-card px-4 py-3.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
            }}
            placeholder={texts.addPlaceholder}
            aria-label={texts.addPlaceholder}
            className="h-[34px] w-full rounded-[9px] border border-border bg-background px-3 text-[13px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-hermes"
          />
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            {texts.addHint}
          </p>
          <div className="mt-2.5 flex justify-end">
            <button
              type="button"
              onClick={handleAdd}
              disabled={!name.trim() || adding}
              className="h-[31px] cursor-pointer rounded-[9px] bg-hermes px-3.5 text-[12px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-50"
            >
              {adding ? "Ajout…" : "Ajouter"}
            </button>
          </div>
        </div>
      ) : null}

      {texts.note ? (
        <p className="mt-5 flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
          <Lock className="mt-[1px] size-[13px] flex-none" strokeWidth={2} />
          {texts.note}
        </p>
      ) : null}
    </section>
  );
}
