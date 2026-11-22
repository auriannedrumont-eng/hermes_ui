// §9 (61) — révision git cuite dans ce bundle au moment du build
// (next.config.ts → NEXT_PUBLIC_BUILD_REVISION). use-hermes-chat la
// compare à appRevision du hello du service pour détecter « écran vieux »
// (onglet ouvert avant une mise à jour : la reconnexion socket automatique
// fait vivre l'ancien JavaScript comme si de rien n'était). Chaîne vide si
// le build n'a pas pu lire la révision : la comparaison est alors
// désactivée — jamais de bandeau sur une supposition.
export const BUILD_REVISION: string =
  process.env.NEXT_PUBLIC_BUILD_REVISION ?? "";
