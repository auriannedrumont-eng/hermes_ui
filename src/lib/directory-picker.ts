// Accès au sélecteur de dossiers WINDOWS natif (2026-11-25) — demande de
// l'utilisatrice : l'icône 📁↓ doit ouvrir le sélecteur de l'explorateur,
// pas un dialogue maison. L'API browser `window.showDirectoryPicker()`
// (File System Access, Chromium — Brave/Chrome/Edge) fait exactement cela :
// fenêtre native de Windows, navigation complète du disque, création de
// dossier incluse (bouton « Nouveau dossier » de la fenêtre système).
// Elle ne rend PAS de chemin : on obtient un handle (nom seul). Le chemin
// disque réel reste donc inconnu du navigateur — par sécurité du web.
// Sémantique adoptée : le dossier choisi est enregistré comme projet avec
// son NOM (sémantique de rangement, identique à un projet créé à la main) ;
// `diskPath` n'est pas transmis (le service n'accepte que des chemins
// réels existants, vérifiables — un handle n'en donne pas).
// Hors Chromium (Firefox/Safari) ou refuse de l'utilisateur : retour null,
// l'appelant garde son comportement de repli (dialogue maison).
"use client";

/** Handle renvoyé par le sélecteur natif (nom seul, pas de chemin). */
export interface PickedDirectory {
  name: string;
}

/** Ouvre le sélecteur de dossiers NATIF de l'OS. Résout null si l'API
 *  n'existe pas (navigateur non Chromium), si l'utilisateur annule
 *  (AbortError) ou refuse. Ne lève jamais : tout échec = null. */
export async function pickWindowsDirectory(): Promise<PickedDirectory | null> {
  if (typeof window === "undefined") return null;
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (options?: {
        mode?: "read" | "readwrite";
        id?: string;
      }) => Promise<{ kind: "directory"; name: string }>;
    }
  ).showDirectoryPicker;
  if (typeof picker !== "function") return null;
  try {
    const handle = await picker.call(window, { mode: "read", id: "hermes-dossier" });
    if (!handle?.name) return null;
    return { name: handle.name };
  } catch {
    // AbortError (annulation) ou refus : repli silencieux.
    return null;
  }
}
