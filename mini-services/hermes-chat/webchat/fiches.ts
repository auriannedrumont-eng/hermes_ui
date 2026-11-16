// Fiches de sélecteurs des chats IA web (spec « Piloter des chats IA web
// depuis l'interface Hermes », §3) — les sélecteurs vivent en DONNÉES, pas
// dans la logique : une refonte d'un site doit être une correction de fiche,
// jamais une réécriture du pilote.
//
// Le champ `verifie` dit si les sélecteurs ont été constatés sur la page
// vivante. Un site dont verifie=false est INDISPONIBLE dans l'interface —
// pas silencieusement cassé (spec §6).

export type WebchatSiteId = "zai" | "aistudio" | "gemini-app";
export type WebchatMode = "answer" | "build";

/** Fiche de sélecteurs d'un site — miroir du JSON de la spec §3. */
export interface SiteFiche {
  id: WebchatSiteId;
  /** Sélecteurs constatés sur la page vivante (false = à relever). */
  verifie: boolean;
  /** Nom humain du site (interface). */
  label: string;
  url_accueil: string;
  /** Chaîne retrouvée dans l'URL d'un onglet existant du site. */
  onglet_match: string;
  /** Modes exposés par le site — answer (texte) et/ou build (fichiers). */
  modes: WebchatMode[];
  sel_compositeur: string;
  /** Expression JS : « le compositeur est prêt ». */
  compositeur_pret: string;
  sel_envoyer: string;
  sel_reponse: string;
  /** Signal « en cours de génération ». */
  en_cours: string;
  /** Signal « les artefacts sont posés » (z.ai). */
  fini_artefacts?: string;
  sel_fichiers?: string;
  /** Préfixe d'API de stockage à mémoriser par le crochet fetch (z.ai). */
  api_stockage?: string;
  /** Sélecteurs du sélecteur de modèle (AI Studio). */
  selecteur_modele?: {
    carte: string;
    sous_titre: string;
    palette: string;
    item: string;
    item_sous_titre: string;
    recherche: string;
  };
  /** Slug du modèle à sélectionner (AI Studio) — null = modèle courant. */
  modele?: string | null;
  /** Regex du bandeau de consentement (AI Studio). */
  bandeau_consentement?: string;
  /** Sélecteurs de bruit à retirer avant lecture du texte. */
  bruit_reponse?: string[];
  /** Nettoyages textuels complémentaires (conservés en données). */
  notes?: string[];
}

export const FICHES: Record<WebchatSiteId, SiteFiche> = {
  zai: {
    id: "zai",
    verifie: true,
    label: "z.ai",
    url_accueil: "https://chat.z.ai/",
    onglet_match: "z.ai",
    modes: ["answer", "build"],
    sel_compositeur: "textarea",
    compositeur_pret:
      "document.querySelectorAll('textarea').length === 1 && !!document.getElementById('send-message-button')",
    sel_envoyer: "#send-message-button",
    sel_reponse: ".chat-assistant || dernier [class*=\"markdown\"]",
    en_cours: "document.body.innerText contient « Thinking... »",
    fini_artefacts: "document.body.innerText contient « All files in task »",
    sel_fichiers: "button[title=\"Download file\"]",
    api_stockage: "/api/v1/storage/",
    notes: [
      "L'accueil vaut nouvelle tâche en mode agent : NE PAS cliquer « New Chat » (conversation sans outils, réponse vide côté serveur).",
      "Le bouton de téléchargement ouvre un dialogue natif : neutraliser HTMLAnchorElement.prototype.click avant.",
      "Un crochet de flux injecté (Page.addScriptToEvaluateOnNewDocument après Page.enable) meurt avec la connexion CDP qui l'a posé : ne jamais s'en servir comme signal de fin.",
    ],
  },

  aistudio: {
    id: "aistudio",
    verifie: true,
    label: "Google AI Studio",
    url_accueil: "https://aistudio.google.com/prompts/new_chat",
    onglet_match: "aistudio.google.com",
    modes: ["answer"],
    sel_compositeur: "textarea",
    compositeur_pret:
      "document.querySelectorAll('textarea').length === 1 && !!document.querySelector('button.ctrl-enter-submits')",
    sel_envoyer: "button.ctrl-enter-submits",
    sel_reponse: "dernier .model-prompt-container",
    en_cours:
      "le bouton d'envoi contient un enfant dont le texte vaut « Stop » ou « progress_activity »",
    selecteur_modele: {
      carte: "button.model-selector-card",
      sous_titre: "span.subtitle, .model-subtitle",
      palette: ".cdk-overlay-pane",
      item: "button.content-button",
      item_sous_titre: ".model-subtitle",
      recherche: "input[type=text]",
    },
    modele: "gemini-4-argon",
    bandeau_consentement: "/j'?ai compris|got it|i understand|accept/i",
    bruit_reponse: [
      ".turn-information",
      ".author-label",
      ".timestamp",
      "ms-turn-information",
    ],
    notes: [
      "Remplir le champ de recherche de la palette PAR LE SETTER NATIF (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set) puis dispatch d'un Event('input') : une affectation .value directe ne réveille pas le framework.",
      "Après le clic sur un modèle, relire le sous-titre : si le slug n'a pas changé, échec explicite avec la liste des modèles présents.",
      "Discussion neuve : about:blank, puis l'URL d'accueil, puis vérifier que le nombre de tours vaut 0 ; sinon Page.reload avec ignoreCache.",
      "Les blocs de code doivent être sortis par le textContent du <pre> et réinjectés après coup en triples backticks : innerText écrase leurs en-têtes et peut perdre les sauts de ligne.",
    ],
  },

  "gemini-app": {
    id: "gemini-app",
    verifie: false,
    label: "gemini.google.com",
    url_accueil: "https://gemini.google.com/app",
    onglet_match: "gemini.google.com",
    modes: ["answer"],
    sel_compositeur: "",
    compositeur_pret: "",
    sel_envoyer: "",
    sel_reponse: "",
    notes: [
      "SÉLECTEURS À RELEVER : aucun n'a été constaté. Le compositeur n'est probablement pas un textarea mais une zone éditable riche.",
      "Signal de fin : disparition du bouton d'arrêt (aria-label du type « Stop response ») puis texte stable sur 3 relevés.",
      "Tant que verifie=false, ce site doit apparaître comme INDISPONIBLE dans l'interface, pas comme cassé.",
    ],
  },
};

/** Identifiant de modèle webchat : webchat:<site>:<mode>. */
export function webchatModelId(site: WebchatSiteId, mode: WebchatMode): string {
  return `webchat:${site}:${mode}`;
}

/** Décode un id de modèle webchat (null si ce n'en est pas un, ou si le mode
 *  n'est pas EXPOSÉ par la fiche du site — aistudio n'a pas de build). */
export function parseWebchatModelId(
  id: string | null | undefined
): { site: WebchatSiteId; mode: WebchatMode } | null {
  if (!id || !id.startsWith("webchat:")) return null;
  const parts = id.split(":");
  if (parts.length !== 3) return null;
  const site = parts[1] as WebchatSiteId;
  const mode = parts[2] as WebchatMode;
  const fiche = FICHES[site];
  if (!fiche) return null;
  if (mode !== "answer" && mode !== "build") return null;
  if (!fiche.modes.includes(mode)) return null;
  return { site, mode };
}

/** Libellé humain d'un mode (interface — la différence doit être visible). */
export function modeLabel(mode: WebchatMode): string {
  return mode === "build" ? "Fichiers" : "Réponse";
}
