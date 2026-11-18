// Section « Fournisseurs » (LLM) et « Clés de services » du volet
// Paramètres v4 — porte-clés multi-clés, test réel exécuté par le service,
// stratégie d'ordre d'utilisation. Maquette de référence :
// design/maquette-parametres-v4.html (panes p-fournisseurs / p-cles).
//
// v2.5 — ajout par SÉLECTEUR (catalogue servi par le service : z.ai y
// compte deux portefeuilles étanches, API standard et GLM Coding Plan)
// et champ « endpoint » éditable, visible dès l'ajout d'une clé et dans
// les réglages avancés de chaque carte.
// v2.6 — « Clés de services » : plus de catalogue à parcourir, ajout par
// le champ unifié « nom ou adresse » (AddAnything) ; libellés « adresse »
// (le jargon « endpoint » ne sort plus dans l'interface). Le catalogue du
// sélecteur reste pour les fournisseurs de modèles (Fournisseurs).
//
// Sécurité : le secret est saisi une fois, envoyé au service, puis oublié
// côté client — l'UI ne rend que la vue masquée (sk-••••7f3a).
"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  Globe,
  Layers,
  Loader2,
  Lock,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  keyStatusLabel,
  providerCardStatus,
  type ProvidersApi,
} from "@/hooks/use-providers";
import type { ProviderKind, ProviderStrategy, ProviderView } from "@/lib/chat-types";
import { AddLine, Pastille } from "@/components/settings/bits";
import { AddAnything } from "@/components/settings/add-anything";
import { Segmented } from "@/components/shared/segmented";
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
    note?: string;
  }
> = {
  llm: {
    title: "Fournisseurs",
    sub: "Vos comptes d'accès aux modèles de langage. Plusieurs clés par fournisseur : quand l'une atteint sa limite, la suivante prend le relais.",
    addLabel: "Ajouter un fournisseur",
  },
  service: {
    title: "Clés de services",
    sub: "Recherche web, images, vidéo — chaque service demande sa propre clé. Plusieurs clés possibles par service.",
    addLabel: "Ajouter un service",
    note: "Les clés restent sur votre machine, dans Hermes — jamais dans le navigateur.",
  },
};

/** Valeur du sélecteur pour « Adresse personnalisée ». */
const CUSTOM_VALUE = "__custom__";

/** Endpoint effectif d'un fournisseur : adresse enregistrée, sinon adresse
 *  par défaut du catalogue — c'est ce que le moteur appellera vraiment. */
function effectiveBaseUrl(provider: ProviderView, api: ProvidersApi): string {
  return (
    provider.baseUrl ??
    api.catalog.find((c) => c.name === provider.name)?.defaultBaseUrl ??
    ""
  );
}

// ── Une carte fournisseur (porte-clés) ───────────────────────────────

function ProviderCard({ provider, api }: { provider: ProviderView; api: ProvidersApi }) {
  const { toast } = useToast();
  const [showAddKey, setShowAddKey] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [keyEndpoint, setKeyEndpoint] = useState("");
  const [addingKey, setAddingKey] = useState(false);
  const [showAdv, setShowAdv] = useState(false);
  const [advEndpoint, setAdvEndpoint] = useState("");
  const [savingBase, setSavingBase] = useState(false);
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const status = providerCardStatus(provider);
  const isLlm = provider.kind === "llm";
  const endpoint = effectiveBaseUrl(provider, api);
  const hasDefault = api.catalog.some((c) => c.name === provider.name);

  // Les champs endpoint suivent le fournisseur (bascule automatique z.ai
  // au test, édition depuis un autre champ) : ajustement d'état pendant le
  // rendu (motif React officiel) — un effet appelant setState synchronement
  // est interdit par la règle react-hooks/set-state-in-effect.
  const [prevEndpoint, setPrevEndpoint] = useState(endpoint);
  if (endpoint !== prevEndpoint) {
    setPrevEndpoint(endpoint);
    setKeyEndpoint(endpoint);
    setAdvEndpoint(endpoint);
  }

  const handleAddKey = async () => {
    if (!keySecret.trim() || addingKey) return;
    setAddingKey(true);
    try {
      // Endpoint modifié dans le formulaire de clé : enregistré AVANT la
      // clé — le test et les tours partiront sur la bonne adresse.
      const nextBase = keyEndpoint.trim();
      if (nextBase && nextBase !== endpoint) {
        const base = await api.setProviderBase(provider.id, nextBase);
        if (base.error) {
          toast({ title: "Adresse refusée", description: base.error, variant: "destructive" });
          return;
        }
      }
      const res = await api.addKey(provider.id, keyLabel.trim(), keySecret.trim());
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
    } finally {
      setAddingKey(false);
    }
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
      return;
    }
    // z.ai : le test a basculé le fournisseur sur le portefeuille qui
    // accepte la clé (clé Coding Plan ajoutée côté API standard, p. ex.).
    if (res.provider?.baseUrl && res.provider.baseUrl !== (provider.baseUrl ?? "")) {
      toast({
        title: "Adresse basculée automatiquement",
        description: `Votre clé répond sur l'autre portefeuille z.ai — ${provider.name} utilise maintenant ${res.provider.baseUrl}.`,
      });
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

  const handleSaveAdvEndpoint = async () => {
    if (savingBase) return;
    const next = advEndpoint.trim();
    if (!next || next === endpoint) return;
    setSavingBase(true);
    const res = await api.setProviderBase(provider.id, next);
    setSavingBase(false);
    if (res.error) {
      toast({ title: "Adresse refusée", description: res.error, variant: "destructive" });
      return;
    }
    toast({
      title: "Adresse enregistrée",
      description: res.provider?.baseUrl ?? `${provider.name} revient à son adresse par défaut.`,
    });
  };

  const handleResetEndpoint = async () => {
    if (savingBase) return;
    setSavingBase(true);
    const res = await api.setProviderBase(provider.id, "");
    setSavingBase(false);
    if (res.error) {
      toast({ title: "Réinitialisation impossible", description: res.error, variant: "destructive" });
      return;
    }
    toast({
      title: "Adresse par défaut rétablie",
      description: `${provider.name} revient à son adresse d'origine.`,
    });
  };

  const keyCount = provider.keys.length;

  return (
    <div className="mb-2.5 rounded-xl border border-border bg-card px-4 py-3.5">
      {/* En-tête : icône + nom + pastille + endpoint */}
      <div className="flex items-center gap-2.5">
        <span className="flex size-[30px] flex-none items-center justify-center rounded-md bg-muted">
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
          <span className="block truncate text-[12.5px] text-muted-foreground" title={endpoint || undefined}>
            {provider.keyless
              ? "sur votre machine — aucune clé nécessaire"
              : endpoint
                ? `${endpoint} · ${keyCount} clé${keyCount > 1 ? "s" : ""}`
                : `${keyCount} clé${keyCount > 1 ? "s" : ""}`}
          </span>
        </div>
        <button
          type="button"
          title={`Retirer ${provider.name}`}
          aria-label={`Retirer ${provider.name}`}
          onClick={handleRemoveProvider}
          className="flex size-[26px] flex-none cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-destructive"
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
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted-foreground">
                  {k.masked}
                </code>
                <Pastille tone={tone} label={label ?? undefined} />
                <button
                  type="button"
                  onClick={() => handleTest(k.id)}
                  disabled={testing.has(k.id)}
                  className="flex h-6 flex-none cursor-pointer items-center gap-1.5 rounded-sm border border-border px-2.5 text-[11px] font-semibold text-foreground transition-colors hover:border-hermes hover:text-hermes-text focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-wait disabled:opacity-40"
                >
                  {testing.has(k.id) ? (
                    <Loader2 className="size-[12px] animate-spin" strokeWidth={2} />
                  ) : null}
                  {testing.has(k.id) ? "Test…" : "Tester"}
                </button>
                <button
                  type="button"
                  title={`Supprimer la clé « ${k.label} »`}
                  aria-label={`Supprimer la clé « ${k.label} »`}
                  onClick={() => handleRemoveKey(k.id, k.label)}
                  className="flex size-[24px] flex-none cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-destructive"
                >
                  <Trash2 className="size-[12px]" strokeWidth={2} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* + Ajouter une clé — avec le détail éditable de l'endpoint */}
      {!provider.keyless ? (
        <>
          <div className="mt-2">
            <AddLine onClick={() => setShowAddKey((v) => !v)}>Ajouter une clé</AddLine>
          </div>
          {showAddKey ? (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={keyLabel}
                  onChange={(e) => setKeyLabel(e.target.value)}
                  placeholder="Étiquette (ex. Perso)"
                  aria-label="Étiquette de la clé"
                  className="h-8 w-[150px] rounded-md border border-border bg-background px-2.5 text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-hermes"
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
                  className="h-8 min-w-[160px] flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground/60 focus-visible:border-hermes"
                />
                <button
                  type="button"
                  onClick={handleAddKey}
                  disabled={!keySecret.trim() || addingKey}
                  className="h-8 cursor-pointer rounded-md bg-hermes px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {addingKey ? "Ajout…" : "Ajouter"}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="flex-none text-[11px] font-semibold text-muted-foreground">
                  Adresse
                </span>
                <input
                  value={keyEndpoint}
                  onChange={(e) => setKeyEndpoint(e.target.value)}
                  placeholder="https://…"
                  aria-label="Adresse utilisée pour ce fournisseur"
                  spellCheck={false}
                  className="h-8 min-w-[200px] flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-[11px] outline-none placeholder:font-sans placeholder:text-muted-foreground/60 focus-visible:border-hermes"
                />
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                Adresse où Hermes appelle {provider.name} — modifiable, enregistrée avec la clé.
              </p>
            </div>
          ) : null}
        </>
      ) : null}

      {/* Réglages avancés : endpoint + ordre d'utilisation des clés */}
      <button
        type="button"
        onClick={() => setShowAdv((v) => !v)}
        className="mt-2.5 inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-hermes"
      >
        <ChevronDown
          className={cn("size-[12px] transition-transform", showAdv && "rotate-180")}
          strokeWidth={2}
        />
        Réglages avancés
      </button>
      {showAdv ? (
        <div className="mt-2 rounded-md bg-muted/60 px-3 py-2.5">
          {/* Endpoint éditable */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] font-medium">
              Adresse
              <span className="block text-[11px] font-normal text-muted-foreground">
                où Hermes appelle ce fournisseur
              </span>
            </span>
            <div className="flex items-center gap-1.5">
              <input
                value={advEndpoint}
                onChange={(e) => setAdvEndpoint(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveAdvEndpoint();
                }}
                placeholder="https://…"
                aria-label="Adresse du fournisseur"
                spellCheck={false}
                className="h-8 w-[min(300px,100%)] rounded-md border border-border bg-background px-2.5 font-mono text-[11px] outline-none placeholder:font-sans placeholder:text-muted-foreground/60 focus-visible:border-hermes"
              />
              <button
                type="button"
                onClick={handleSaveAdvEndpoint}
                disabled={savingBase || !advEndpoint.trim() || advEndpoint.trim() === endpoint}
                className="h-8 cursor-pointer rounded-md bg-hermes px-2.5 text-[11px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-40"
              >
                {savingBase ? "…" : "Enregistrer"}
              </button>
              {hasDefault && provider.baseUrl ? (
                <button
                  type="button"
                  onClick={handleResetEndpoint}
                  disabled={savingBase}
                  title="Revenir à l'adresse par défaut"
                  aria-label="Revenir à l'adresse par défaut"
                  className="flex size-[30px] cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-hermes hover:text-hermes-text focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-wait disabled:opacity-40"
                >
                  <RotateCcw className="size-[13px]" strokeWidth={2} />
                </button>
              ) : null}
            </div>
          </div>

          {/* Ordre d'utilisation des clés (LLM) */}
          {isLlm && !provider.keyless ? (
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
              <span className="text-[12.5px] font-medium">
                Ordre d&apos;utilisation des clés
                <span className="block text-[11px] font-normal text-muted-foreground">
                  comment choisir la prochaine clé quand il faut changer
                </span>
              </span>
              {/* Le segmenté partagé du repo (audit C1.3) : radiogroup
                  accessible — flèches pour naviguer, tabindex roving. */}
              <Segmented
                ariaLabel="Ordre d'utilisation des clés"
                options={(Object.keys(STRATEGY_LABELS) as ProviderStrategy[]).map((s) => ({
                  value: s,
                  label: STRATEGY_LABELS[s].label,
                }))}
                value={provider.strategy}
                onChange={(v) => void handleStrategy(v as ProviderStrategy)}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Panneau d'ajout : liste à sélectionner (v2.5) ────────────────────

function AddProviderPanel({
  kind,
  api,
  onClose,
}: {
  kind: ProviderKind;
  api: ProvidersApi;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const entries = api.catalog.filter((c) => c.kind === kind);
  // « __pending__ » le temps que le catalogue arrive du service (socket).
  const [preset, setPreset] = useState<string>("__pending__");
  const [endpoint, setEndpoint] = useState<string>("");

  // Ajustement d'état pendant le rendu (motif React officiel) : à l'arrivée
  // du catalogue (prop), on sème la première entrée — un effet appelant
  // setState synchronement est interdit par la règle react-hooks.
  if (preset === "__pending__" && entries.length > 0) {
    setPreset(entries[0].name);
    setEndpoint(entries[0].defaultBaseUrl ?? "");
  }

  const presetValue =
    preset === "__pending__" ? (entries.length > 0 ? entries[0].name : CUSTOM_VALUE) : preset;
  const selected = entries.find((e) => e.name === presetValue) ?? null;
  const isCustom = presetValue === CUSTOM_VALUE;
  const [adding, setAdding] = useState(false);

  const pick = (value: string) => {
    setPreset(value);
    const e = entries.find((x) => x.name === value) ?? null;
    setEndpoint(e?.defaultBaseUrl ?? "");
  };

  const handleAdd = async () => {
    if (adding) return;
    const address = endpoint.trim();
    if (isCustom && !/^https?:\/\//i.test(address)) {
      toast({
        title: "Adresse requise",
        description: "Collez l'adresse complète du fournisseur (https://…).",
        variant: "destructive",
      });
      return;
    }
    setAdding(true);
    // Nom : valeur canonique du sélecteur, ou l'adresse collée (custom).
    // L'endpoint n'est envoyé que s'il diffère du défaut du fournisseur —
    // non modifié, le canon reste la référence.
    const name = isCustom ? address : presetValue;
    const sendBase =
      isCustom || (selected !== null && address !== (selected.defaultBaseUrl ?? ""))
        ? address
        : undefined;
    const res = await api.addProvider(name, kind, sendBase);
    setAdding(false);
    if (res.error) {
      toast({ title: "Ajout impossible", description: res.error, variant: "destructive" });
      return;
    }
    toast({
      title: `${res.provider?.name ?? name} ajouté`,
      description: kind === "llm" ? "Ajoutez maintenant votre clé." : "Ajoutez sa clé.",
    });
    onClose();
  };

  const zaiSelected = selected?.name === "z.ai" || selected?.name === "z.ai Coding Plan";

  return (
    <div className="mt-2.5 rounded-xl border border-border bg-card px-4 py-3.5">
      <label
        htmlFor="add-provider-select"
        className="block text-[11px] font-semibold text-muted-foreground"
      >
        {kind === "llm" ? "Fournisseur" : "Service"}
      </label>
      <select
        id="add-provider-select"
        value={presetValue}
        onChange={(e) => pick(e.target.value)}
        className="mt-1 h-9 w-full cursor-pointer rounded-md border border-border bg-background px-2.5 text-[12.5px] outline-none focus-visible:border-hermes"
      >
        {preset === "__pending__" ? <option value="">Chargement…</option> : null}
        <optgroup label={kind === "llm" ? "Fournisseurs connus" : "Services connus"}>
          {entries.map((e) => (
            <option key={e.name} value={e.name}>
              {e.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Autre">
          <option value={CUSTOM_VALUE}>Adresse personnalisée (https://…)</option>
        </optgroup>
      </select>

      {selected ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {selected.tagline}
        </p>
      ) : null}
      {zaiSelected ? (
        <p className="mt-1.5 rounded-md bg-muted/70 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          z.ai sépare l&apos;argent en deux portefeuilles étanches : l&apos;API standard se
          paie au jeton (solde rechargeable), le GLM Coding Plan est un abonnement avec ses
          propres clés. Une clé ne fonctionne que sur la surface où elle a été créée — en cas
          de doute, testez la clé : Hermes basculera automatiquement sur le bon portefeuille.
        </p>
      ) : null}

      <label
        htmlFor="add-provider-endpoint"
        className="mt-2.5 block text-[11px] font-semibold text-muted-foreground"
      >
        {isCustom ? "Adresse du fournisseur" : "Adresse"}
      </label>
      <input
        id="add-provider-endpoint"
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleAdd();
        }}
        placeholder="https://…"
        aria-label="Adresse du fournisseur"
        spellCheck={false}
        className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground/60 focus-visible:border-hermes"
      />
      {!isCustom ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Pré-remplie — modifiable (autre surface, proxy, serveur local).
        </p>
      ) : null}

      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-8 cursor-pointer rounded-md border border-border px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-hermes"
        >
          Annuler
        </button>
        <button
          type="button"
          onClick={handleAdd}
          disabled={adding || (isCustom && !/^https?:\/\//i.test(endpoint.trim()))}
          className="h-8 cursor-pointer rounded-md bg-hermes px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-40"
        >
          {adding ? "Ajout…" : "Ajouter"}
        </button>
      </div>
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
  const texts = TEXTS[kind];
  const [showAdd, setShowAdd] = useState(false);
  const list = api.providers.filter((p) => p.kind === kind);

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">{texts.title}</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        {texts.sub}
      </p>

      {list.map((p) => (
        <ProviderCard key={p.id} provider={p} api={api} />
      ))}
      {list.length === 0 ? (
        <p className="mb-4 rounded-xl border border-dashed border-border px-4 py-5 text-center text-[12.5px] text-muted-foreground">
          Aucun {kind === "llm" ? "fournisseur" : "service"} configuré pour l&apos;instant.
        </p>
      ) : null}

      <div className="mt-1">
        <AddLine onClick={() => setShowAdd((v) => !v)}>{texts.addLabel}</AddLine>
      </div>
      {showAdd ? (
        kind === "service" ? (
          // v2.6 — plus de catalogue à parcourir : le même champ unifié
          // « nom ou adresse » (un nom connu crée la fiche ici ; la clé
          // s'ajoute ensuite dessus).
          <div className="mt-2.5">
            <AddAnything
              api={api}
              autoFocus
              hint="Tapez un nom connu (ex. tavily) — la fiche apparaît ici, sa clé s'ajoute dessus."
            />
          </div>
        ) : (
          <AddProviderPanel kind={kind} api={api} onClose={() => setShowAdd(false)} />
        )
      ) : null}

      {texts.note ? (
        <p className="mt-5 flex items-start gap-2 text-[12.5px] leading-relaxed text-muted-foreground">
          <Lock className="mt-[1px] size-[13px] flex-none" strokeWidth={2} />
          {texts.note}
        </p>
      ) : null}
    </section>
  );
}
