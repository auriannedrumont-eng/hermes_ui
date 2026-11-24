import type { NextConfig } from "next";
import { execSync } from "node:child_process";

// §9 (61) — révision git au moment du build, cuite dans le bundle client
// (NEXT_PUBLIC_BUILD_REVISION). L'interface la compare à appRevision du
// hello du service : divergence → bandeau « Recharger la page » (écran
// vieux : onglet ouvert avant une mise à jour, reconnexion socket
// automatique qui masque sinon totalement la nouvelle version).
// Échec silencieux (pas de git, pas de dépôt) : chaîne vide, comparaison
// désactivée côté client — jamais de bandeau sur une supposition.
function buildRevision(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : "";
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  /* Le type-check strict s'applique au build (P1 : les erreurs ne passent plus). */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  devIndicators: false,
  // Lot audit passe 2 : passerelle INTÉGRÉE sans Caddy. Le client transporte
  // le port cible dans la requête ?XTransformPort= (jamais dans le chemin —
  // cf. src/lib/service.ts et src/lib/socket.ts) ; README.md:45 et
  // DEMARRAGE.md:26 présentent Caddy comme FACULTATIF (`bun dev` + mini-
  // service), mais aucune règle ne relayait ces requêtes : l'application sur
  // :3000 était 100 % hors ligne sans Caddy. Ces rewrites reprennent le
  // filtrage du Caddyfile (SEULS 3003 socket.io et 3004 pièces jointes sont
  // joignables — toute autre valeur tombe sur l'interface Next). Réécritures
  // « afterFiles » par défaut : la page « / » reste rendue par Next, seuls les
  // chemins non servis par l'UI (socket.io, fichiers, artefacts, partage)
  // partent vers le mini-service. La query d'origine (token, EIO…) est
  // transmise telle quelle — la destination n'a pas de query propre.
  async rewrites() {
    return [
      {
        source: "/:path*",
        has: [{ type: "query", key: "XTransformPort", value: "3003" }],
        destination: "http://127.0.0.1:3003/:path*",
      },
      {
        source: "/:path*",
        has: [{ type: "query", key: "XTransformPort", value: "3004" }],
        destination: "http://127.0.0.1:3004/:path*",
      },
    ];
  },
  // Inlinée à la compilation : chaque composant client voit la même
  // constante, aucune lecture de processus au runtime.
  env: {
    NEXT_PUBLIC_BUILD_REVISION: buildRevision(),
  },
};

export default nextConfig;
