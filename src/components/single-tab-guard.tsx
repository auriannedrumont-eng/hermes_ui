// Garde « un seul onglet » (2026-11-15) — demande de l'utilisatrice : « que
// le lanceur détecte si un onglet Hermes est déjà ouvert et qu'il ferme ou
// relance sur ce même onglet ». Un lanceur .bat/PowerShell n'a aucun droit
// sur les onglets d'un navigateur (isolation système) : la coordination se
// fait donc DANS la page, déclenchée par le lanceur qui rouvre l'adresse.
//
// Comportement :
//  1) chaque onglet écrit un battement de cœur dans localStorage (2 s) ;
//  2) un nouvel onglet qui trouve un principal vivant lui demande de se
//     rafraîchir (il charge ainsi la toute dernière version — les
//     conversations vivent dans la base, rien ne se perd), puis affiche un
//     bandeau discret et tente de se fermer tout seul ; si le navigateur
//     refuse de fermer une page ouverte par le système (protection normale),
//     le bandeau indique de la fermer à la main ;
//  3) si l'onglet principal disparaît, un onglet en attente prend le relais
//     (immédiatement : le principal écrit un battement mort en partant).
// Fenêtres installées en application (PWA, mode autonome) : volontairement
// hors du dispositif — elles se comportent comme des applications, pas
// comme des onglets. Stockage indisponible (navigation privée) : la garde
// se tait, l'application se comporte comme avant.
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const HEARTBEAT_KEY = "hermes.single.tab";
const DUP_SIGNAL_KEY = "hermes.dup.signal";
const CHANNEL_NAME = "hermes.single.tab";
const BEAT_MS = 2000; // battement de cœur de l'onglet principal
const STALE_MS = 7000; // au-delà, le principal est considéré parti
const RELOAD_DEBOUNCE_MS = 2500; // ignore les doubles signaux rapprochés

declare global {
  interface Window {
    __hermesTabRole?: "primary" | "duplicate";
    __hermesReloadCount?: number;
  }
}

type Heartbeat = { id: string; ts: number };

function isStandalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

function tabId(): string {
  try {
    let id = window.sessionStorage.getItem("hermes.tab.id");
    if (!id) {
      id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem("hermes.tab.id", id);
    }
    return id;
  } catch {
    return "t-anonyme";
  }
}

function readHeartbeat(): Heartbeat | null {
  try {
    const raw = window.localStorage.getItem(HEARTBEAT_KEY);
    if (!raw) return null;
    const beat = JSON.parse(raw) as Heartbeat;
    if (!beat || typeof beat.ts !== "number" || !beat.id) return null;
    return beat;
  } catch {
    return null;
  }
}

function writeHeartbeat(id: string, ts: number): void {
  try {
    window.localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({ id, ts }));
  } catch {
    /* stockage indisponible : la garde se tait */
  }
}

function otherIsPrimary(beat: Heartbeat | null, ownId: string): boolean {
  return !!beat && beat.id !== ownId && Date.now() - beat.ts < STALE_MS;
}

export function SingleTabGuard() {
  const [duplicate, setDuplicate] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [closeRefused, setCloseRefused] = useState(false);

  // Tentative de fermeture automatique du doublon : si la page est encore
  // là 1,5 s après l'appel, le navigateur a refusé (page ouverte par le
  // système, pas par un script) — le bandeau le dit honnêtement.
  useEffect(() => {
    if (!duplicate) return;
    const attempt = window.setTimeout(() => {
      try {
        window.close();
      } catch {
        /* refus silencieux */
      }
      window.setTimeout(() => setCloseRefused(true), 1500);
    }, 2000);
    return () => window.clearTimeout(attempt);
  }, [duplicate]);

  useEffect(() => {
    if (isStandalone()) return; // fenêtre PWA : pas un onglet, garde éteinte

    const ownId = tabId();
    let role: "primary" | "duplicate" = "primary";
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      channel = null; // navigateur sans BroadcastChannel : repli « storage »
    }

    let reloadCount = 0;
    let lastReloadAt = 0;
    try {
      reloadCount = Number(window.sessionStorage.getItem("hermes.reload.count") || 0) || 0;
      lastReloadAt = Number(window.sessionStorage.getItem("hermes.last.reload") || 0) || 0;
    } catch {
      reloadCount = 0;
      lastReloadAt = 0;
    }
    window.__hermesReloadCount = reloadCount;

    const claim = () => {
      role = "primary";
      window.__hermesTabRole = "primary";
      writeHeartbeat(ownId, Date.now());
      setDuplicate(false);
    };
    const standBy = () => {
      role = "duplicate";
      window.__hermesTabRole = "duplicate";
      setDuplicate(true);
      // demande à l'onglet EXISTANT de se rafraîchir (il charge la dernière
      // version) — par le canal dédié, et par la clé de repli dont
      // l'événement « storage » ne se déclenche que chez les autres onglets.
      try {
        channel?.postMessage({ type: "hermes-dup", from: ownId });
      } catch {
        /* canal absent */
      }
      try {
        window.localStorage.setItem(DUP_SIGNAL_KEY, JSON.stringify({ from: ownId, ts: Date.now() }));
      } catch {
        /* stockage indisponible */
      }
    };

    if (otherIsPrimary(readHeartbeat(), ownId)) standBy();
    else claim();

    const beat = window.setInterval(() => {
      if (role === "primary") {
        writeHeartbeat(ownId, Date.now());
        return;
      }
      if (otherIsPrimary(readHeartbeat(), ownId)) return; // principal vivant
      claim(); // le principal a disparu : on prend le relais
    }, BEAT_MS);

    const reloadPrimary = () => {
      if (Date.now() - lastReloadAt < RELOAD_DEBOUNCE_MS) return;
      lastReloadAt = Date.now();
      try {
        window.sessionStorage.setItem("hermes.last.reload", String(lastReloadAt));
        window.sessionStorage.setItem("hermes.reload.count", String(reloadCount + 1));
      } catch {
        /* tant pis pour la mémo du compte */
      }
      window.location.reload();
    };
    const onChannelMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (data?.type === "hermes-dup" && role === "primary") reloadPrimary();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === DUP_SIGNAL_KEY && role === "primary") reloadPrimary();
    };
    const onPageHide = () => {
      // battement mort : un onglet en attente prend le relais immédiatement
      // au lieu d'attendre l'expiration des 7 s.
      if (role === "primary") writeHeartbeat(ownId, 0);
    };
    channel?.addEventListener("message", onChannelMessage);
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.clearInterval(beat);
      try {
        channel?.removeEventListener("message", onChannelMessage);
        channel?.close();
      } catch {
        /* déjà fermé */
      }
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", onPageHide);
      onPageHide();
    };
  }, []);

  if (!duplicate || dismissed) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-xl">
        <h2 className="text-lg font-semibold">
          Hermes est déjà ouvert dans un autre onglet
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          L&apos;onglet existant a été actualisé — cette page n&apos;est plus
          utile.
          {closeRefused
            ? " Le navigateur refuse de la fermer tout seul : fermez-la à la main."
            : ""}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              try {
                window.close();
              } catch {
                /* refus */
              }
              window.setTimeout(() => setCloseRefused(true), 1200);
            }}
          >
            Fermer cette page
          </Button>
          <Button variant="ghost" onClick={() => setDismissed(true)}>
            Garder cette page ouverte
          </Button>
        </div>
      </div>
    </div>
  );
}
