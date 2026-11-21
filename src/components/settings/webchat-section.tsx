// Section « Chats web » du volet Paramètres v4 — fournisseur « Chats IA web »
// (identifiant stable `webchat`, spec « Piloter des chats IA web »). Règles
// rendues ici plutôt que laissées à découvrir :
// - connexion des sites : une fois, À LA MAIN, dans le navigateur de pilotage
//   (profil dédié à l'application — jamais le navigateur personnel) ;
// - un site non vérifié (verifie=false) est INDISPONIBLE, pas cassé ;
// - les réglages servent les pilotes : port de débogage, plafond de
//   génération, veilleur, dossier de sortie du mode build, binaire navigateur.
// Statuts RÉELS uniquement : sonde du port CDP, binaire trouvé, dossier créé.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pastille } from "@/components/settings/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { emitAck } from "@/lib/emit-ack";
import { getSocket } from "@/lib/socket";

interface SiteStatus {
  id: string;
  label: string;
  verifie: boolean;
  modes: string[];
  browserUp: boolean;
}

interface WebchatStatusPayload {
  sites: SiteStatus[];
  config: {
    port: number;
    timeoutS: number;
    idleMin: number;
    outDir: string;
    profileDir: string;
    browserPath: string;
    browserFound: string;
    outDirExists: boolean;
  };
}

type ServerSettings = Partial<{
  "fork.webchat.port": number;
  "fork.webchat.timeoutS": number;
  "fork.webchat.idleMin": number;
  "fork.webchat.outDir": string;
  "fork.webchat.profileDir": string;
  "fork.webchat.browserPath": string;
}>;

const DEFAULTS = { port: 9222, timeoutS: 240, idleMin: 5 };

/** Lit une clé serveur (table settings — settings:get, avec chien de garde :
 *  null = le service n'a pas acquitté, JAMAIS confondu avec « clé absente »). */
function getServerSetting(key: string): Promise<{ value?: unknown } | null> {
  return emitAck<{ value?: unknown }>("settings:get", { key });
}

/** Écrit une clé serveur (settings:set — broadcast settings:changed).
 *  Chien de garde : false = pas d'ack (service muet). */
function setServerSetting(key: string, value: string | number): Promise<boolean> {
  return emitAck<{ ok?: boolean }>("settings:set", { key, value }).then(
    (res) => res?.ok === true
  );
}

export function WebchatSection() {
  const [status, setStatus] = useState<WebchatStatusPayload | null>(null);
  const [settings, setSettings] = useState<ServerSettings>({});
  const [drafts, setDrafts] = useState<ServerSettings>({});
  // Lot audit 2026-11-21 : la lecture était silencieuse — socket coupée à
  // l'ouverture, les champs affichaient les DÉFAUTS comme si c'étaient la
  // config réelle, et le premier « Enregistrer » réécrivait les 5 clés avec
  // ces défauts (perte de config). `settingsLoaded` / `loadError` verrouillent
  // l'enregistrement tant que la lecture n'est pas complète et honnête.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdv, setShowAdv] = useState(false);

  const load = useCallback(() => {
    getSocket().emit("webchat:status", (res: WebchatStatusPayload) => setStatus(res));
    const keys = [
      "fork.webchat.port",
      "fork.webchat.timeoutS",
      "fork.webchat.idleMin",
      "fork.webchat.outDir",
      "fork.webchat.profileDir",
      "fork.webchat.browserPath",
    ];
    // queueMicrotask : pas de setState synchrone dans le corps d'un effet
    // (règle react-hooks/set-state-in-effect, motif du repo).
    queueMicrotask(() => setSettingsLoaded(false));
    Promise.all(keys.map((k) => getServerSetting(k))).then((acks) => {
      if (acks.some((a) => a === null)) {
        // Au moins une clé jamais acquittée : on ne touche à RIEN — afficher
        // des valeurs par défaut inviterait à les enregistrer par-dessus la
        // config réelle.
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setSettingsLoaded(true);
      const next: ServerSettings = {};
      keys.forEach((k, i) => {
        (next as Record<string, unknown>)[k] = acks[i]?.value ?? null;
      });
      setSettings(next);
      setDrafts(next);
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (key: keyof ServerSettings, value: string | number | undefined) => {
    if (value === undefined) return;
    const ok = await setServerSetting(key, value);
    if (ok) {
      setSettings((s) => ({ ...s, [key]: value } as ServerSettings));
    }
    return ok;
  };

  // Lot audit 2026-11-21 : un seul flash final — avant, chaque clé posait
  // son propre « Enregistré… » et un échec en milieu de série laissait le
  // vert affiché EN MÊME TEMPS que l'erreur, sans dire quelle clé a échoué.
  const saveAll = async () => {
    if (!settingsLoaded) {
      setError(
        "La configuration n'a pas pu être lue côté service — enregistrement bloqué pour ne pas écraser les vraies valeurs par des défauts."
      );
      setTimeout(() => setError(null), 6000);
      return;
    }
    setSaving(true);
    // (audit 2026-11-21) clamp à l'enregistrement : les attributs min/max
    // HTML ne bloquent pas la frappe et le service n'exige que n > 0 — un
    // « 80 » en port CDP ou « 1 » en plafond partait en base et sabotait
    // silencieusement le prochain tour webchat. Les champs se corrigent
    // d'eux-mêmes (drafts) pour ne pas afficher une valeur non sauvegardée.
    const portClamp = Math.min(65535, Math.max(1024, Math.round(Number(port) || 0)));
    const timeoutClamp = Math.min(1800, Math.max(30, Math.round(Number(timeoutS) || 0)));
    const idleClamp = Math.min(60, Math.max(1, Math.round(Number(idleMin) || 0)));
    setDrafts((d) => ({
      ...d,
      "fork.webchat.port": portClamp,
      "fork.webchat.timeoutS": timeoutClamp,
      "fork.webchat.idleMin": idleClamp,
    }) as ServerSettings);
    const targets: Array<[keyof ServerSettings, string | number]> = [
      ["fork.webchat.port", portClamp],
      ["fork.webchat.timeoutS", timeoutClamp],
      ["fork.webchat.idleMin", idleClamp],
      ["fork.webchat.outDir", outDir.trim()],
      ["fork.webchat.browserPath", browserPath.trim()],
    ];
    const failed: string[] = [];
    for (const [key, value] of targets) {
      const ok = await save(key, value);
      if (!ok) failed.push(key);
    }
    setSaving(false);
    if (failed.length === 0) {
      setFlash("Enregistré — pris en compte au prochain tour webchat.");
      setTimeout(() => setFlash(null), 3500);
      getSocket().emit("webchat:status", (res: WebchatStatusPayload) => setStatus(res));
    } else {
      setError(
        `Échec de l'enregistrement pour ${failed.length} réglage(s) sur ${targets.length} — les autres sont enregistrés.`
      );
      setTimeout(() => setError(null), 6000);
      getSocket().emit("webchat:status", (res: WebchatStatusPayload) => setStatus(res));
    }
  };

  const openBrowser = async (site: string | null) => {
    setOpening(site ?? "x");
    setError(null);
    // Chien de garde : sans ack, `opening` restait non-null et les boutons
    // restaient désactivés pour toujours.
    const res = await emitAck<{ ok?: boolean; error?: string; pid?: number }>("webchat:open", {
      site: site ?? undefined,
    });
    setOpening(null);
    if (res === null) {
      setError("Le service n'a pas répondu (8 s) — navigateur non lancé.");
      setTimeout(() => setError(null), 6000);
    } else if (res.ok) {
      setFlash(
        res.pid
          ? `Navigateur de pilotage lancé (pid ${res.pid}) — connectez-vous aux sites à la main, une seule fois.`
          : "Navigateur de pilotage déjà lancé — connectez-vous aux sites à la main."
      );
      setTimeout(() => setFlash(null), 6000);
    } else {
      setError(res.error ?? "Ouverture impossible.");
      setTimeout(() => setError(null), 6000);
    }
    getSocket().emit("webchat:status", (s: WebchatStatusPayload) => setStatus(s));
  };

  const closeBrowser = async () => {
    const res = await emitAck<{ ok?: boolean; closed?: boolean }>("webchat:close", undefined);
    setFlash(
      res === null
        ? "Le service n'a pas répondu — l'état du navigateur est incertain."
        : res.closed
          ? "Navigateur de pilotage fermé."
          : "Le navigateur de pilotage n'était pas lancé."
    );
    setTimeout(() => setFlash(null), 3500);
    getSocket().emit("webchat:status", (s: WebchatStatusPayload) => setStatus(s));
  };

  const cfg = status?.config;
  // Tous les sites partagent le même navigateur de pilotage — la sonde du
  // port CDP est portée par chaque fiche, l'état réel vient d'elle.
  const browserUp = status?.sites.some((s) => s.browserUp) ?? false;
  const port = Number(drafts["fork.webchat.port"] ?? settings["fork.webchat.port"] ?? DEFAULTS.port);
  const timeoutS = Number(drafts["fork.webchat.timeoutS"] ?? settings["fork.webchat.timeoutS"] ?? DEFAULTS.timeoutS);
  const idleMin = Number(drafts["fork.webchat.idleMin"] ?? settings["fork.webchat.idleMin"] ?? DEFAULTS.idleMin);
  const outDir = String(drafts["fork.webchat.outDir"] ?? settings["fork.webchat.outDir"] ?? "");
  const browserPath = String(drafts["fork.webchat.browserPath"] ?? settings["fork.webchat.browserPath"] ?? "");

  const draftDirty =
    port !== Number(settings["fork.webchat.port"] ?? port) ||
    timeoutS !== Number(settings["fork.webchat.timeoutS"] ?? timeoutS) ||
    idleMin !== Number(settings["fork.webchat.idleMin"] ?? idleMin) ||
    outDir !== String(settings["fork.webchat.outDir"] ?? "") ||
    browserPath !== String(settings["fork.webchat.browserPath"] ?? "");

  return (
    <section>
      <h1 className="text-[19px] font-bold tracking-tight">Chats web</h1>
      <p className="mt-1 mb-2 max-w-[520px] text-[12.5px] leading-relaxed text-muted-foreground">
        Faire travailler des chats IA publics (z.ai, AI Studio…) dans leur vrai
        navigateur. Vous vous connectez une fois, à la main — rien n&apos;est
        saisi ni stocké par l&apos;interface.
      </p>

      {/* ── Sites — statut réel de chaque fiche ───────────────────────── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-1">
        {(status?.sites ?? []).map((s, i) => (
          <div
            key={s.id}
            className={cn("flex items-center gap-3 py-[11px]", i > 0 && "border-t border-border/60")}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold">{s.label}</div>
              <div className="mt-px text-[11px] leading-snug text-muted-foreground">
                {s.verifie
                  ? "Prêt — ouvert via le navigateur de pilotage ci-dessous."
                  : "Pas encore prêt."}
              </div>
            </div>
            {s.verifie ? (
              <Pastille tone="ok" label="vérifié" className="flex-none" />
            ) : (
              <Pastille tone="warn" label="indisponible" className="flex-none" />
            )}
          </div>
        ))}
        {!status ? (
          <div className="py-[11px] text-[12.5px] text-muted-foreground">Chargement des fiches…</div>
        ) : null}
      </div>

      {/* ── Navigateur de pilotage — connexion manuelle + veilleur ────── */}
      <div className="mt-4 rounded-xl border border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold">Navigateur de pilotage</div>
            <div className="mt-px text-[11px] leading-snug text-muted-foreground">
              Profil dédié à l&apos;application (jamais votre navigateur
              personnel). Il se ferme seul après {cfg?.idleMin ?? DEFAULTS.idleMin} min
              d&apos;inactivité — le pilote suivant le relance.
            </div>
          </div>
          {browserUp ? (
            <Pastille tone="ok" label={`actif · ${cfg?.port ?? "?"}`} className="flex-none" />
          ) : (
            <Pastille tone="off" label="arrêté" className="flex-none" />
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="primary"
            onClick={() => void openBrowser(null)}
            disabled={opening !== null}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md bg-hermes-strong px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ExternalLink className="size-[13px]" strokeWidth={2} />
            {opening !== null ? "Ouverture…" : "Ouvrir le navigateur"}
          </Button>
          {browserUp ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void closeBrowser()}
              className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-[13px]" strokeWidth={2} />
              Fermer
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {(status?.sites ?? []).filter((s) => s.verifie).map((s) => (
              <Button
                key={s.id}
                type="button"
                variant="outline"
                onClick={() => openBrowser(s.id)}
                disabled={opening !== null}
                className="inline-flex h-9 cursor-pointer items-center rounded-md border border-border px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Ouvrir {s.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Réglages avancés — repliés par défaut (v2.6) ──────────────── */}
      <div className="mt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setShowAdv((v) => !v)}
          aria-expanded={showAdv}
          className="inline-flex h-auto cursor-pointer items-center gap-1 px-0 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground focus-visible:outline-2 focus-visible:outline-hermes"
        >
          <ChevronDown
            className={cn("size-[12px] transition-transform", showAdv && "rotate-180")}
            strokeWidth={2}
          />
          Réglages avancés
        </Button>
        {loadError ? (
          <p className="mt-2 text-[11px] font-medium text-warning" role="alert">
            Le service n&apos;a pas répondu — la configuration enregistrée
            n&apos;est pas chargée. L&apos;enregistrement est bloqué pour ne pas
            écraser les vraies valeurs par des défauts.
          </p>
        ) : null}
        {showAdv ? (
          <div className="mt-2 rounded-xl border border-border px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[12.5px] font-semibold">Pilotes du navigateur</div>
              {draftDirty ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void saveAll()}
                  disabled={saving || !settingsLoaded}
                  className="inline-flex h-8 cursor-pointer items-center rounded-md bg-hermes-strong px-3 text-[12.5px] font-medium text-hermes-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? "Enregistrement…" : "Enregistrer"}
                </Button>
              ) : (
                <Pastille tone="off" label="à jour" className="flex-none" />
              )}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Navigateur{" "}
              {cfg?.browserFound ? (
                <code className="rounded bg-muted px-1 font-mono text-[11px]">{cfg.browserFound}</code>
              ) : (
                <span className="font-medium text-warning">introuvable — installez Chromium/Brave ou renseignez le chemin ci-dessous</span>
              )}
              {" · "}dossier de sortie{" "}
              <code className="rounded bg-muted px-1 font-mono text-[11px]">{cfg?.outDir ?? "…"}</code>
              {cfg && !cfg.outDirExists ? " (créé au premier tour build)" : ""}
            </p>
            <div className="mt-2.5 grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1">
            <span className="text-[11px] text-muted-foreground">Port de débogage</span>
            <Input
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, "fork.webchat.port": Number(e.target.value) || DEFAULTS.port }))
              }
              aria-label="Port de débogage du navigateur de pilotage"
              className="h-9 rounded-sm border border-border bg-background px-2 text-right font-mono text-[12.5px] tabular-nums outline-none focus-visible:border-hermes/60"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] text-muted-foreground">Plafond de génération (s)</span>
            <Input
              type="number"
              min={30}
              max={1800}
              value={timeoutS}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, "fork.webchat.timeoutS": Number(e.target.value) || DEFAULTS.timeoutS }))
              }
              aria-label="Plafond de génération en secondes"
              className="h-9 rounded-sm border border-border bg-background px-2 text-right font-mono text-[12.5px] tabular-nums outline-none focus-visible:border-hermes/60"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] text-muted-foreground">Veilleur (min d&apos;inactivité)</span>
            <Input
              type="number"
              min={1}
              max={60}
              value={idleMin}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, "fork.webchat.idleMin": Number(e.target.value) || DEFAULTS.idleMin }))
              }
              aria-label="Minutes d'inactivité avant fermeture du navigateur"
              className="h-9 rounded-sm border border-border bg-background px-2 text-right font-mono text-[12.5px] tabular-nums outline-none focus-visible:border-hermes/60"
            />
          </label>
          <label className="grid gap-1 sm:col-span-3">
            <span className="text-[11px] text-muted-foreground">
              Dossier de sortie du mode « Fichiers » (vide = défaut du service)
            </span>
            <Input
              type="text"
              value={outDir}
              placeholder="défaut : db/webchat-out du service"
              onChange={(e) =>
                setDrafts((d) => ({ ...d, "fork.webchat.outDir": e.target.value }))
              }
              aria-label="Dossier de sortie des fichiers du mode build"
              className="h-9 rounded-sm border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-hermes/60"
            />
          </label>
          <label className="grid gap-1 sm:col-span-3">
            <span className="text-[11px] text-muted-foreground">
              Chemin du navigateur (vide = détection automatique Chromium/Brave)
            </span>
            <Input
              type="text"
              value={browserPath}
              placeholder="défaut : détection automatique"
              onChange={(e) =>
                setDrafts((d) => ({ ...d, "fork.webchat.browserPath": e.target.value }))
              }
              aria-label="Chemin du binaire navigateur de pilotage"
              className="h-9 rounded-sm border border-border bg-background px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-hermes/60"
            />
          </label>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Le navigateur de pilotage est un profil dédié à l&apos;application —
          votre navigateur personnel n&apos;est jamais touché. Un plafond dépassé
          est un échec explicite, jamais une réponse tronquée.
        </p>
          </div>
        ) : null}
      </div>

      {flash ? (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] font-medium text-success" role="status">
          <Check className="size-[13px] flex-none" strokeWidth={2.5} />
          {flash}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-[11px] font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
