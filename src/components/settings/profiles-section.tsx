// Section « Profils » du volet Paramètres v4 (v2.4) — des préréglages
// complets (modèle, effort, permissions, recherche web, mode expert)
// applicables en un clic. La LISTE vit côté service (settings,
// hermes.profiles) ; l'application passe par le bus de réglages client
// (effet immédiat, sans dépendance moteur) — FORK.md §7.4.
//
// Lot audit 2026-11-21 : créer/dupliquer/supprimer sont des read-modify-write
// de la liste serveur — ils sont VERROUILLÉS tant que la liste n'a pas été
// lue (`loaded`, sinon on écrase tout avec un instantané vide), l'ack de
// `settings:set` est vérifié (toast destructif sinon), la suppression passe
// par ConfirmDestructiveDialog (garde unique du repo), et « Dupliquer » a un
// retour visible. Le bandeau flash est annoncé aux lecteurs d'écran.
"use client";

import { useEffect, useState } from "react";
import { Check, Copy, PlusCircle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AddLine, Pastille } from "@/components/settings/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDestructiveDialog } from "@/components/shared/confirm-destructive-dialog";
import { deleteClientSetting, onSettingsChanged, readClientSetting, writeClientSetting } from "@/lib/settings";
import { useChatProfiles } from "@/hooks/use-profiles";
import { emitAck } from "@/lib/emit-ack";
import { useToast } from "@/hooks/use-toast";
import {
  applyProfile,
  captureCurrentValues,
  profileSummary,
  serializeProfiles,
  type ChatProfile,
} from "@/lib/profiles";

const APPLIED_KEY = "hermes.profiles.applied";

export function ProfilesSection() {
  const { profiles, loaded, error } = useChatProfiles();
  const { toast } = useToast();
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
  const [saving, setSaving] = useState(false);
  // Suppression : garde destructive (aucun remove en un clic).
  const [pendingRemove, setPendingRemove] = useState<ChatProfile | null>(null);

  /** Persiste la nouvelle liste (ack vérifié + broadcast settings:changed).
   *  Retourne false en cas d'échec — l'appelant n'affiche PAS de succès. */
  const persist = async (list: ChatProfile[]): Promise<boolean> => {
    const res = await emitAck<{ ok?: boolean; error?: string }>("settings:set", {
      key: "hermes.profiles",
      value: serializeProfiles(list),
    });
    if (res === null) {
      toast({
        title: "Profils non enregistrés",
        description: "Le service n'a pas répondu (8 s). Réessayez une fois la connexion rétablie.",
        variant: "destructive",
      });
      return false;
    }
    if (res.error) {
      toast({ title: "Profils non enregistrés", description: res.error, variant: "destructive" });
      return false;
    }
    return true;
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || !loaded || saving) return;
    const profile: ChatProfile = {
      id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: trimmed.slice(0, 60),
      createdAt: new Date().toISOString(),
      values: captureCurrentValues(),
    };
    setSaving(true);
    const ok = await persist([...profiles, profile]);
    setSaving(false);
    if (!ok) return;
    setName("");
    setCreating(false);
    setFlash(`Profil « ${profile.name} » créé à partir des réglages actuels.`);
  };

  const duplicate = async (p: ChatProfile) => {
    if (!loaded || saving) return;
    const copy: ChatProfile = {
      ...p,
      id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: `${p.name} (copie)`.slice(0, 60),
      createdAt: new Date().toISOString(),
    };
    setSaving(true);
    const ok = await persist([...profiles, copy]);
    setSaving(false);
    if (ok) setFlash(`Profil dupliqué : « ${copy.name} ».`);
  };

  const remove = async (p: ChatProfile) => {
    if (!loaded || saving) return;
    setSaving(true);
    const ok = await persist(profiles.filter((x) => x.id !== p.id));
    setSaving(false);
    if (!ok) return;
    if (appliedId === p.id) deleteClientSetting(APPLIED_KEY);
    setFlash(`Profil « ${p.name} » supprimé.`);
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
        <div
          role="status"
          className="mt-2.5 flex items-center gap-2 rounded-md border border-success/30 bg-success/8 px-3 py-2 text-[12.5px] font-medium text-success"
        >
          <Check className="size-[13px] flex-none" strokeWidth={2.5} />
          <span className="min-w-0 flex-1">{flash}</span>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mt-2.5 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-[12.5px] font-medium text-warning"
        >
          Le service n&apos;a pas répondu — la liste des profils n&apos;est pas
          chargée. Les modifications sont bloquées pour ne rien écraser ;
          elles se débloquent dès la reconnexion.
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
                  void create();
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
                onClick={() => void create()}
                disabled={!name.trim() || saving || !loaded}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3 text-[12.5px] font-semibold text-hermes-foreground transition-opacity hover:bg-hermes-strong/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PlusCircle className="size-3.5" strokeWidth={2.5} />
                {saving ? "Création…" : "Créer"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-2.5 rounded-xl border border-border px-4 py-1">
        {!loaded && !error ? (
          <div className="py-4 text-center text-[12.5px] text-muted-foreground">
            Chargement des profils…
          </div>
        ) : null}
        {loaded && profiles.length === 0 && !creating ? (
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
                    onClick={() => void duplicate(p)}
                    disabled={saving}
                    className="flex size-[28px] cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Copy className="size-[13px]" strokeWidth={2} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    title="Supprimer"
                    aria-label={`Supprimer ${p.name}`}
                    onClick={() => setPendingRemove(p)}
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

      {/* Garde destructive — la suppression d'un profil est irréversible. */}
      <ConfirmDestructiveDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={`Supprimer « ${pendingRemove?.name ?? ""} » ?`}
        description="Le profil est retiré de la liste enregistrée. Cette action est irréversible — les réglages du chat ne sont pas modifiés."
        confirmLabel="Supprimer le profil"
        onConfirm={() => {
          const p = pendingRemove;
          setPendingRemove(null);
          if (p) void remove(p);
        }}
      />
    </section>
  );
}
