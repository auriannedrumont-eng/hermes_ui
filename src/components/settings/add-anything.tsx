// Ajout unifié (v2.6) — UN seul champ pour tout ce qu'on ajoute à Hermes :
// un nom connu (« tavily ») ou une adresse (dépôt GitHub, serveur https,
// commande de lancement). Le service résout et installe seul
// (registry:install) ; la clé d'API, si le service en demande une, se
// règle ensuite sur sa fiche dans les Paramètres — pas pendant l'ajout.
"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { ProvidersApi } from "@/hooks/use-providers";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AddAnything({
  api,
  hint,
  autoFocus = false,
}: {
  api: ProvidersApi;
  /** Ligne d'aide sous le champ (courte — le résolveur fait le reste). */
  hint?: string;
  autoFocus?: boolean;
}) {
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const install = async () => {
    const source = value.trim();
    if (!source || busy) return;
    setBusy(true);
    const res = await api.installAnything(source);
    setBusy(false);
    // res === null : le service n'a pas acquitté (chien de garde 8 s) —
    // l'ancien code lisait `res.error` sur un ack vide (TypeError silencieux)
    // ou restait « Recherche… » pour toujours si la socket était coupée.
    if (res === null) {
      toast({
        title: "Ajout impossible",
        description:
          "Le service n'a pas répondu (8 s) — l'installation n'a peut-être pas abouti, réessayez une fois la connexion rétablie.",
        variant: "destructive",
      });
      return;
    }
    if (res.error) {
      toast({ title: "Ajout impossible", description: res.error, variant: "destructive" });
      return;
    }
    setValue("");
    if (res.what === "repo" && res.extension) {
      toast({
        title: `${res.extension.name} installé`,
        description: `Dépôt ${res.extension.source} — pris en compte au prochain redémarrage.`,
      });
    } else if (res.what === "mcp") {
      toast({
        title: "Serveur ajouté",
        description: "Activé au prochain redémarrage — les sessions en cours seront prévenues.",
      });
    } else if (res.what === "provider" && res.provider) {
      const where =
        res.provider.kind === "service" ? "Clés de services" : "Fournisseurs";
      toast({
        title: `${res.provider.name} ajouté`,
        description:
          res.provider.kind === "service"
            ? `Sa fiche vous attend dans « ${where} » — sa clé d'API s'ajoute là, si le service en demande une.`
            : `Sa fiche vous attend dans « ${where} » — sa clé s'ajoute là.`,
      });
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void install();
            }
          }}
          placeholder="Nom (ex. tavily) ou adresse (github.com/…, https://…)"
          aria-label="Nom ou adresse du service, du serveur ou du dépôt à ajouter"
          autoFocus={autoFocus}
          spellCheck={false}
          className="h-9 min-w-[200px] flex-1 rounded-md border border-border bg-background px-3 text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-hermes"
        />
        <Button
          type="button"
          variant="primary"
          onClick={() => void install()}
          disabled={!value.trim() || busy}
          className="flex h-9 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-hermes disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-[12px] animate-spin" strokeWidth={2} /> : null}
          {busy ? "Recherche…" : "Ajouter"}
        </Button>
      </div>
      {hint ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
