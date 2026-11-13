// Route publique de partage (F-13) — /shared/<token>, lecture seule.
// Page serveur minimale : le composant client fetch le snapshot figé du
// mini-service. Accessible sans session, jamais indexée (robots noindex).
import type { Metadata } from "next";
import { SharedConversationView } from "@/components/shared/shared-conversation-view";

export const metadata: Metadata = {
  title: "Conversation partagée — Hermes Web",
  robots: { index: false, follow: false },
};

export default async function SharedConversationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <SharedConversationView token={token} />;
}
