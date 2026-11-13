// Page publique de partage (F-13) — lecture seule, accessible sans session.
// Le client fetch le snapshot figé servi par le mini-service (3004) via la
// passerelle Caddy (XTransformPort). Aucune donnée interne ne circule : la
// vue publique ne contient que le titre, les messages et les noms de pièces
// jointes. Un lien révoqué affiche un message sobre et un lien vers l'app.
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye, FileText, Share2 } from "lucide-react";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { serviceUrl } from "@/lib/service";
import type { SharedConversationData } from "@/lib/chat-types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: SharedConversationData }
  | { status: "gone"; reason: "revoked" | "notfound" }
  | { status: "error" };

export function SharedConversationView({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const url = serviceUrl(`/share/${encodeURIComponent(token)}/data.json`);
    fetch(url)
      .then(async (res) => {
        if (res.status === 410) return { __revoked: true } as const;
        if (res.status === 404) return { __notfound: true } as const;
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as SharedConversationData;
      })
      .then((payload) => {
        if (cancelled) return;
        if ("__revoked" in payload) setState({ status: "gone", reason: "revoked" });
        else if ("__notfound" in payload) setState({ status: "gone", reason: "notfound" });
        else setState({ status: "ready", data: payload });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.status === "loading") {
    return (
      <Shell>
        <div className="py-24 text-center text-[13px] text-muted-foreground">
          Chargement de la conversation partagée…
        </div>
      </Shell>
    );
  }

  if (state.status === "gone") {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 py-24 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Share2 className="size-5" strokeWidth={2} />
          </span>
          <h1 className="text-[17px] font-bold tracking-tight">
            {state.reason === "revoked"
              ? "Ce lien de partage a été révoqué"
              : "Lien de partage introuvable"}
          </h1>
          <p className="max-w-[380px] text-[13px] leading-relaxed text-muted-foreground">
            {state.reason === "revoked"
              ? "L'auteur de la conversation a retiré l'accès public. Les messages ne sont plus consultables."
              : "Ce lien n'existe pas ou a expiré. Vérifiez l'adresse reçue."}
          </p>
          <Link
            href="/"
            className="mt-2 inline-flex items-center gap-2 rounded-[10px] border border-border px-4 py-2 text-[12.5px] font-semibold text-foreground transition-colors hover:bg-muted"
          >
            <ArrowLeft className="size-[14px]" strokeWidth={2.2} />
            Ouvrir Hermes Web
          </Link>
        </div>
      </Shell>
    );
  }

  if (state.status === "error") {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <h1 className="text-[17px] font-bold tracking-tight">
            Impossible de charger le partage
          </h1>
          <p className="max-w-[380px] text-[13px] leading-relaxed text-muted-foreground">
            Le service Hermes est injoignable. Réessayez dans un instant.
          </p>
        </div>
      </Shell>
    );
  }

  const { data } = state;
  return (
    <Shell>
      <article>
        <header className="mb-7 border-b border-border/70 pb-5">
          <h1 className="text-[21px] font-bold leading-tight tracking-tight">
            {data.title}
          </h1>
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Eye className="size-[13px]" strokeWidth={2} />
            Lecture seule · {data.messageCount} message(s) · partagé le{" "}
            {new Date(data.sharedAt).toLocaleString("fr-FR")}
          </p>
        </header>

        <div className="flex flex-col gap-5">
          {data.messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "share-msg-user" : "share-msg-bot"}>
              <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {m.role === "user" ? "Vous" : "Hermes"}
                {m.model ? (
                  <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
                    · {m.model}
                  </span>
                ) : null}
              </div>
              {m.role === "assistant" ? (
                <MarkdownContent content={m.content} />
              ) : (
                <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed">
                  {m.content}
                </p>
              )}
              {m.attachments?.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.attachments.map((a, j) => (
                    <span
                      key={j}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      <FileText className="size-[11px]" strokeWidth={2} />
                      {a.name}
                      <span className="text-muted-foreground/60">({a.kind})</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <footer className="mt-10 border-t border-border/70 pt-4 text-center text-[11.5px] text-muted-foreground">
          Conversation partagée depuis{" "}
          <Link href="/" className="font-semibold text-hermes hover:underline">
            Hermes Web
          </Link>
          <button
            type="button"
            className="ml-3 inline-flex cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-0.5 font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              const url = serviceUrl(`/share/${encodeURIComponent(token)}/image.png`);
              window.open(url, "_blank", "noopener");
            }}
          >
            <Share2 className="size-[11px]" strokeWidth={2.2} />
            Exporter en image (PNG)
          </button>
        </footer>
      </article>
    </Shell>
  );
}

/** Coquille commune : barre sobre + zone centrée lisible. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="border-b border-border/60 bg-card/60">
        <div className="mx-auto flex h-13 max-w-3xl items-center gap-2 px-4 py-2.5">
          <Link href="/" className="flex items-center gap-2 text-[13px] font-semibold">
            <span className="flex size-[22px] items-center justify-center rounded-[7px] bg-hermes/10 text-hermes">
              <Share2 className="size-[12px]" strokeWidth={2.2} />
            </span>
            Hermes Web
          </Link>
          <span className="ml-auto text-[11px] font-medium text-muted-foreground">
            conversation partagée
          </span>
        </div>
      </div>
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </div>
  );
}
