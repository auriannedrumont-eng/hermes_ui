// Bibliothèque de prompts réutilisables (commandes slash dans le composer).
// Taper "/" dans la zone de saisie affiche la liste ; Entrée/Tab insère le prompt.

export interface PromptTemplate {
  slash: string;
  title: string;
  description: string;
  prompt: string;
}

export const PROMPT_LIBRARY: PromptTemplate[] = [
  {
    slash: "traduis",
    title: "Traduire un texte",
    description: "Traduit le texte suivant dans la langue demandée",
    prompt:
      "Traduis le texte suivant en respectant le ton et le registre. Indique la langue cible si elle n'est pas précisée (anglais par défaut) :\n\n",
  },
  {
    slash: "resume",
    title: "Résumer",
    description: "Résume un texte ou un document en points clés",
    prompt:
      "Résume le texte suivant en 5 points clés maximum, puis donne une phrase de conclusion :\n\n",
  },
  {
    slash: "corrige",
    title: "Corriger un texte",
    description: "Orthographe, grammaire et style",
    prompt:
      "Corrige l'orthographe, la grammaire et le style du texte suivant. Liste les corrections apportées :\n\n",
  },
  {
    slash: "code",
    title: "Écrire du code",
    description: "Génère un script avec explications",
    prompt:
      "Écris un script qui répond au besoin suivant, avec des commentaires clairs et une courte explication de son fonctionnement :\n\n",
  },
  {
    slash: "explique",
    title: "Expliquer",
    description: "Explication pédagogique d'un concept",
    prompt:
      "Explique le concept suivant de façon pédagogique : définition simple, analogie, puis détails techniques :\n\n",
  },
  {
    slash: "email",
    title: "Rédiger un email",
    description: "Email professionnel et courtois",
    prompt:
      "Rédige un email professionnel et courtois (objet + corps) pour la situation suivante :\n\n",
  },
  {
    slash: "brainstorm",
    title: "Brainstormer",
    description: "Génère des idées créatives",
    prompt:
      "Aide-moi à brainstormer sur le sujet suivant : propose 8 idées originales et concrètes, classées par originalité :\n\n",
  },
  {
    slash: "titre",
    title: "Proposer des titres",
    description: "Titres accrocheurs pour un document",
    prompt:
      "Propose 10 titres accrocheurs (courts, moyens, longs) pour le contenu suivant :\n\n",
  },
];

/** Filtre la bibliothèque selon le jeton slash en cours de saisie (ex. "/re"). */
export function filterPromptLibrary(token: string): PromptTemplate[] {
  const t = token.replace(/^\//, "").toLowerCase();
  if (!t) return PROMPT_LIBRARY;
  return PROMPT_LIBRARY.filter(
    (p) =>
      p.slash.startsWith(t) ||
      p.title.toLowerCase().includes(t) ||
      p.description.toLowerCase().includes(t)
  );
}
