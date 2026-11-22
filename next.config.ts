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
  // Inlinée à la compilation : chaque composant client voit la même
  // constante, aucune lecture de processus au runtime.
  env: {
    NEXT_PUBLIC_BUILD_REVISION: buildRevision(),
  },
};

export default nextConfig;
