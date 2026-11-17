// Pont de dépannage (F-31) — le chemin entre l'interface et l'agent qui corrige.
//
// Ouvrir l'application avec ?debug=1 (ou dans le même onglet) affiche un
// panneau discret : état de la connexion socket, derniers événements reçus,
// et un bouton « Copier le diagnostic » qui assemble un rapport compact —
// état du service (commit, uptime, navigateur de pilotage webchat, journal
// tournant) + état du navigateur de l'utilisateur. Ce rapport se colle tel
// quel à l'agent : il répond à « où est-ce bloqué ? » sans accès au terminal.
//
// Le rapport ne contient JAMAIS le contenu des messages — que des durées,
// des états et des motifs d'échec. ?debug=1 mémorisé dans localStorage :
// le panneau reste disponible aux visites suivantes jusqu'à « Fermer ».
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy, RefreshCw, X } from "lucide-react";
import { getSocket } from "@/lib/socket";
import { FILES_PORT, serviceFetchInit, serviceUrl } from "@/lib/service";

const FLAG_KEY = "hermes.debug-bridge";
/** Nombre d'événements clients gardés à l'écran. */
const CLIENT_EVENTS_MAX = 40;

interface ClientEvent {
  t: number;
  name: string;
  summary: string;
}

/** Résumé une-ligne d'un événement socket (sans contenu de message). */
function summarize(name: string, args: unknown[]): string {
  const p = (args[0] ?? {}) as Record<string, unknown>;
  const conv = typeof p.conversationId === "string" ? p.conversationId.slice(0, 8) : "";
  switch (name) {
    case "stream:start":
      return `tour démarre (conv ${conv})`;
    case "stream:delta": {
      const n = typeof p.delta === "string" ? p.delta.length : 0;
      return `delta +${n} car.`;
    }
    case "stream:status":
      return typeof p.status === "string" ? `statut : ${p.status}` : "statut";
    case "stream:reasoning":
      return "raisonnement";
    case "stream:tool":
      return typeof p.name === "string" ? `outil : ${p.name}` : "outil";
    case "stream:done":
      return `tour terminé (conv ${conv})`;
    case "stream:error":
      return `ERREUR : ${String(p.error ?? "?").slice(0, 120)}`;
    case "mode:flow":
      return `déroulé mode (${Array.isArray(p.rows) ? p.rows.length : "?"} lignes)`;
    case "connect":
      return "socket connectée";
    case "disconnect":
      return "socket DÉCONNECTÉE";
    default:
      return "";
  }
}

export function DebugBridge() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<ClientEvent[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const eventsRef = useRef<ClientEvent[]>([]);

  // Ouverture : ?debug=1 dans l'URL (mémorisé) OU l'icône clé à molette de
  // l'en-tête (F-31bis — une vraie entrée visible, pas une adresse à bricoler).
  // Le panneau se referme avec « Fermer » et ne revient qu'au prochain appel.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("hermes:debug-open", onOpen);
    return () => window.removeEventListener("hermes:debug-open", onOpen);
  }, []);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get("debug") === "1") localStorage.setItem(FLAG_KEY, "1");
      if (localStorage.getItem(FLAG_KEY) === "1") setOpen(true);
    } catch {
      /* stockage indisponible : panneau simplement absent */
    }
  }, []);

  // Observation : chaque événement socket (dont connect/disconnect via onAny)
  // nourrit le journal local — la même vie que celle du service, côté client.
  useEffect(() => {
    if (!open) return;
    const socket = getSocket();
    const push = (name: string, summary: string) => {
      const next = [
        ...eventsRef.current,
        { t: Date.now(), name, summary: summary || `(${name})` },
      ].slice(-CLIENT_EVENTS_MAX);
      eventsRef.current = next;
      setEvents(next);
    };
    const onAny = (name: string, ...args: unknown[]) => push(name, summarize(name, args));
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.onAny(onAny);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    setConnected(socket.connected);
    return () => {
      socket.offAny(onAny);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [open]);

  const copyReport = useCallback(async () => {
    setBusy(true);
    setCopied(false);
    setReport(null);
    try {
      // 1) État côté service (commit, uptime, navigateur webchat, journal).
      let serverPart = "(service injoignable — il est probablement ARRÊTÉ)";
      try {
        // /diagnostics vit sur le service HTTP fichiers (3004), PAS sur le
        // service socket.io (3003) : celui-ci répond HTTP 400 « Bad Request »
        // à toute requête qui n'est pas une poignée de main socket.io.
        const res = await fetch(serviceUrl("/diagnostics", FILES_PORT), {
          ...serviceFetchInit(),
          cache: "no-store",
        });
        if (res.ok) {
          const json = (await res.json()) as unknown;
          serverPart = JSON.stringify(json, null, 2);
        } else {
          serverPart = `(service a répondu HTTP ${res.status})`;
        }
      } catch (err) {
        serverPart = `(service injoignable : ${err instanceof Error ? err.message : "?"})`;
      }
      // 2) État côté navigateur de l'utilisateur.
      const clientPart = {
        client: {
          url: window.location.href,
          at: new Date().toISOString(),
          userAgent: navigator.userAgent,
          socketConnected: getSocket().connected,
          events: eventsRef.current.map(
            (e) => `${new Date(e.t).toLocaleTimeString()} ${e.name} — ${e.summary}`,
          ),
        },
      };
      const full = `=== DIAGNOSTIC HERMES (${new Date().toLocaleString()}) ===\n\n[CLIENT]\n${JSON.stringify(clientPart, null, 2)}\n\n[SERVICE]\n${serverPart}`;
      setReport(full);
      try {
        await navigator.clipboard.writeText(full);
        setCopied(true);
      } catch {
        setCopied(false); // presse-papiers refusé : le rapport reste affiché
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const close = useCallback(() => {
    try {
      localStorage.removeItem(FLAG_KEY);
    } catch {
      /* rien à retirer */
    }
    setOpen(false);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed bottom-3 right-3 z-50 w-[min(26rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span
          className={
            "h-2 w-2 shrink-0 rounded-full " +
            (connected ? "bg-emerald-500" : "bg-destructive animate-pulse")
          }
          aria-hidden
        />
        <p className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          Pont de dépannage — {connected ? "service joint" : "service NON joint"}
        </p>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label={expanded ? "Replier" : "Déplier"}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={close}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Fermer le pont de dépannage"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded ? (
        <div className="max-h-72 overflow-auto px-3 py-2">
          <ul className="space-y-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {events.length === 0 ? (
              <li className="italic">(aucun événement reçu — la socket ne parle pas)</li>
            ) : (
              events.map((e, i) => (
                <li key={`${e.t}-${i}`} className="break-words">
                  <span className="text-foreground/60">
                    {new Date(e.t).toLocaleTimeString()}
                  </span>{" "}
                  <span className="text-foreground/90">{e.name}</span> — {e.summary}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 border-t px-3 py-2">
        <button
          onClick={copyReport}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          Copier le diagnostic
        </button>
        {copied ? (
          <span className="text-[12px] text-emerald-600">copié ✓ collez-le à l&apos;agent</span>
        ) : null}
      </div>
      {report && !copied ? (
        <div className="max-h-40 overflow-auto border-t px-3 py-2">
          <textarea
            readOnly
            value={report}
            onFocus={(e) => e.currentTarget.select()}
            className="h-28 w-full resize-y rounded-md border bg-muted/50 p-2 font-mono text-[10.5px]"
          />
        </div>
      ) : null}
    </div>
  );
}
