// Section « Profils » du volet Paramètres v4 (v2.4) — des préréglages
// complets (modèle, effort, permissions, recherche web, mode expert)
// applicables en un clic. La LISTE vit côté service (settings,
// hermes.profiles) ; l'application passe par le bus de réglages client
// (effet immédiat, sans dépendance moteur) — FORK.md §7.4.
"use client";

import { useEffect, useState } from "react";
import { Check, Copy, PlusCircle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AddLine, Pastille } from "@/components/settings/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSocket } from "@/lib/socket";
import { deleteClientSetting, onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import { useChatProfiles } from "@/hooks/use-profiles";
import {
  applyProfile,
  captureCurrentValues,
  profileSummary,
  serializeProfiles,
  type ChatProfile,
} from "@/lib/profiles";

const APPLIED_KEY = "hermes.profiles.applied";

export function ProfilesSection() {
  const profiles = useChatProfiles();
  // Id du profil appliqué — clé client interne, suivie en direct via le bus.
  const [appliedId, setAppliedId] = useState<string | null>(() =>
    readClientSetting<string | null>(APPLIED_KEY)
  );
  useEffect(
    () =>
      onSettingsChanged(({ key, value }) => {
        if (key === APPLIED_KEY) setAppliedId(typeof value === "string" ? value : null);
      }),
    []
  );

  // Création : nom + capture des réglages courants au moment du clic.
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  /** Persiste la nouvelle liste (ack + broadcast settings:changed → onglets). */
  const persist = (list: ChatProfile[]) => {
    getSocket().emit(
      "settings:set",
      { key: "hermes.profiles", value: serializeProfiles(list) },
      () => {}
    );
  };

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const profile: ChatProfile = {
      id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: trimmed.slice(0, 60),
      createdAt: new Date().toISOString(),
      values: captureCurrentValues(),
    };
    persist([...profiles, profile]);
    setName("");
    setCreating(false);
    setFlash(`Profil « ${profile.name} » créé à partir des réglages actuels.`);
  };

  const duplicate = (p: ChatProfile) => {
    const copy: ChatProfile = {
      ...p,
      id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: `${p.name} (copie)`.slice(0, 60),
      createdAt: new Date().toISOString(),
    };
    persist([...profiles, copy]);
  };

  const remove = (p: ChatProfile) => {
    persist(profiles.filter((x) => x.id !== p.id));
    if (appliedId === p.id) deleteClientSetting(APPLIED_KEY);
  };

  const apply = (p: ChatProfile) => {
    applyProfile(p);
    writeClientSetting(APPLIED_KEY, p.id);
    setFlash(`Profil « ${p.name} » appliqué — effet au prochain tour.`);
  };

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Profils</h1>
      <p className="mt-1 mb-5 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Des préréglages complets — modèle, effort, permissions, recherche web —
        applicables en un clic.
      </p>

      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold tracking-tight">Vos profils</h2>
          <p className="mt-px text-[12.5px] leading-snug text-muted-foreground">
            «&nbsp;Créer&nbsp;» capture les réglages actuels ; «&nbsp;Appliquer&nbsp;» les
            remet en place instantanément.
          </p>
        </div>
        <AddLine
          onClick={() => {
            setCreating((v) => !v);
            setName("");
          }}
          className="flex-none"
        >
          Créer un profil
        </AddLine>
      </div>

      {flash ? (
        <div className="mt-2.5 flex items-center gap-2 rounded-md border border-success/30 bg-success/8 px-3 py-2 text-[12.5px] font-medium text-success">
          <Check className="size-[13px] flex-none" strokeWidth={2.5} />
          <span className="min-w-0 flex-1">{flash}</span>
        </div>
      ) : null}

      {creating ? (
        <div className="mt-2.5 rounded-lg border border-hermes/30 bg-hermes/5 p-3">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  create();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setCreating(false);
                  setName("");
                }
              }}
              maxLength={60}
              placeholder="Nom du profil (ex. « Rédaction rapide », « Analyse approfondie »)"
              aria-label="Nom du profil"
              autoFocus
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-[12.5px] font-semibold outline-none focus-visible:border-hermes/60"
            />
            <span className="hidden flex-none text-[11px] tabular-nums text-muted-foreground sm:block">
              {name.length}/60
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="min-w-0 text-[11px] leading-snug text-muted-foreground">
              Sera capturé : {profileSummary({ id: "", name: "", createdAt: "", values: captureCurrentValues() })}
            </span>
            <div className="flex flex-none items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setName("");
                }}
                className="inline-flex h-8 cursor-pointer items-center rounded-md px-3 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Annuler
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={create}
                disabled={!name.trim()}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:bg-hermes-strong/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PlusCircle className="size-3.5" strokeWidth={2.5} />
                Créer
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-2.5 rounded-xl border border-border px-4 py-1">
        {profiles.length === 0 && !creating ? (
          <div className="py-4 text-center text-[12.5px] text-muted-foreground">
            Aucun profil — réglez le chat comme vous l&apos;aimez, puis «&nbsp;Créer un
            profil&nbsp;» pour le garder sous la main.
          </div>
        ) : null}
        {profiles.map((p, i) => {
          const applied = appliedId === p.id;
          return (
            <div
              key={p.id}
              className={cn(
                "border-border py-[11px]",
                i > 0 && "border-t",
                applied && "bg-hermes/5"
              )}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-semibold">{p.name}</span>
                    {applied ? (
                      <Pastille tone="ok" label="appliqué" />
                    ) : null}
                  </div>
                  <div className="mt-px line-clamp-1 text-[11px] leading-snug text-muted-foreground">
                    {profileSummary(p)}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-1">
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => apply(p)}
                    title="Appliquer ce profil maintenant"
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm bg-hermes-strong px-2.5 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:bg-hermes-strong/90"
                  >
                    Appliquer
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    title="Dupliquer"
                    aria-label={`Dupliquer ${p.name}`}
                    onClick={() => duplicate(p)}
                    className="flex size-[28px] cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Copy className="size-[13px]" strokeWidth={2} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    title="Supprimer"
                    aria-label={`Supprimer ${p.name}`}
                    onClick={() => remove(p)}
                    className="flex size-[28px] cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive dark:hover:text-destructive"
                  >
                    <Trash2 className="size-[13px]" strokeWidth={2} />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
