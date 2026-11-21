"use client";

// Le fil live, partagé par les deux cartes de la section Système (v0.5.1).
// La v0.5.0 revendiquait « une seule grammaire » mais dupliquait la
// mécanique (~120 lignes) dans system-section.tsx et agent-motor-card.tsx,
// et les parseurs du journal n'étaient testés nulle part. Ce module est LE
// seul endroit de la mécanique : horloge vivante (« il y a N s »), jalons
// qui ne reculent jamais, rendu des jalons, verdicts à marqueur (A-1) et
// les deux traducteurs (application / moteur). Module PUR (aucune socket,
// aucun état global) : testable directement par scripts/test-fil-live.ts.
//
// Conventions du fil (maquette v3) : une phrase humaine par ligne, l'heure
// locale du préfixe [HH:MM:SS] des lanceurs, un jalon 0-3 (-1 = info), une
// classe d'affichage (cur/ok/ko/""). Toute ligne inconnue reste affichée
// brute — le fil ne ment jamais par omission.

import { useEffect, useState } from "react";

export interface FilLigne {
  /** Heure locale de la ligne, parsée du préfixe [HH:MM:SS] (null si absent). */
  heure: string | null;
  /** Phrase humaine (ou ligne brute si non reconnue). */
  texte: string;
  /** Jalon 0-3 atteint par cette ligne (-1 = pas de progression). */
  jalon: number;
  /** Classe d'affichage : ligne courante / succès / échec / normale. */
  classe: "cur" | "ok" | "ko" | "";
}

/** Normalisation de comparaison : minuscule + accents retirés (NFD) —
 *  les lanceurs Windows écrivent parfois sans accents (ps1), le sh avec. */
export function sansAccents(texte: string): string {
  return texte.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Préfixe horodaté : le service et les deux lanceurs écrivent [HH:MM:SS]. */
export function splitHeure(brute: string): { heure: string | null; texte: string } {
  const m = brute.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
  return { heure: m?.[1] ?? null, texte: m?.[2] ?? brute };
}

// ── Verdicts à marqueur (A-1) ─────────────────────────────────────────────
// Dernière ligne QUI PORTE un marqueur terminal — robuste même si une ligne
// suit le verdict. Les marqueurs sont ceux des producteurs réels :
// lanceurs .sh/.ps1 (« MAJ OK » / « MAJ ERREUR ») et agent-motor.ts
// (« MOTEUR MAJ OK » / « RETOUR OK » / « CONTRÔLE OK »…).

/** Verdict du journal de l'APPLICATION (maj.log des lanceurs). */
export function verdictApp(text: string): null | "ok" | "erreur" {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("MAJ ERREUR")) return "erreur";
    if (lines[i].includes("MAJ OK")) return "ok";
  }
  return null;
}

/** Verdict du journal du MOTEUR (journal d'opération agent-motor.ts). */
export function verdictMotor(text: string): null | "ok" | "erreur" {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/RETOUR ERREUR|MOTEUR MAJ ERREUR/.test(lines[i])) return "erreur";
    if (/RETOUR OK|RETOUR EFFECTUÉ|MOTEUR MAJ OK|CONTRÔLE OK/.test(lines[i])) return "ok";
  }
  return null;
}

/** Dernière ligne non vide — contexte du garde-fou (« GitHub » ?). */
export function derniereLigne(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

// ── Traducteurs : ligne brute → phrase humaine + jalon ────────────────────
// Mots-clés tirés des phrases RÉELLES des producteurs (desktop/hermes-ui.ps1
// + .sh et mini-services/hermes-chat/agent-motor.ts — vérifiés v0.5.0 et
// couverts par scripts/test-fil-live.ts). Ordre : verdicts et incidents
// d'abord (ils portent la couleur), puis les jalons dans l'ordre du récit.
//
// v0.5.1 (revue) : la règle « non appliquée — version locale conservée »
// était placée APRÈS startsWith("attention") qui capture la même ligne —
// branche morte, l'incident s'affichait brut. Elle précède maintenant la
// règle « attention », et les deux ATTENTION connus (maj non appliquée,
// reconstruction échouée → mode développement) sont traduits.

/** Traduction d'une ligne du journal de l'APPLICATION.
 *  Jalons : 0 Demande envoyée · 1 Téléchargement · 2 Installation ·
 *  3 Vérification. */
export function traduireLigneApp(brute: string): FilLigne {
  const { heure, texte } = splitHeure(brute);
  const t = sansAccents(texte);

  // — Verdicts et incidents (avant tout : ils portent la couleur) —
  if (texte.includes("MAJ OK")) {
    return { heure, texte: "C'est terminé — la nouvelle version est installée. Rechargez la page pour la découvrir.", jalon: 3, classe: "ok" };
  }
  if (texte.includes("MAJ ERREUR")) {
    return { heure, texte: "La mise à jour n'a pas abouti. Rien n'a changé — l'application actuelle continue de fonctionner. Le détail est dans la fenêtre « Hermes Web ».", jalon: -1, classe: "ko" };
  }
  // v0.5.1 : AVANT la règle « attention » (la ligne réelle commence par
  // « ATTENTION - … ») — sinon jamais atteinte.
  if (t.includes("non appliquee") && t.includes("version locale conservee")) {
    return { heure, texte: "La nouvelle version n'a pas pu être appliquée (des fichiers locaux étaient modifiés) — la version locale est conservée, rien n'a changé.", jalon: -1, classe: "ko" };
  }
  if (t.includes("reconstruction echouee") || t.includes("build de production echoue")) {
    // Incident non terminal : le lanceur continue et termine en MAJ OK —
    // l'application démarre en mode développement (dégradé, pas cassé).
    return { heure, texte: "La reconstruction n'a pas abouti — l'application démarrera en mode développement (tout fonctionne, un peu moins vite).", jalon: 2, classe: "" };
  }
  if (t.startsWith("attention")) {
    return { heure, texte, jalon: -1, classe: "ko" };
  }
  if (t.includes("deja a jour")) {
    return { heure, texte: "Finalement, tout était déjà à jour — quelqu'un a mis à jour entre-temps. Rien à faire.", jalon: 3, classe: "ok" };
  }
  if (t.includes("github injoignable")) {
    return { heure, texte: "GitHub est injoignable (connexion ?). La version actuelle est conservée — vous pourrez réessayer.", jalon: -1, classe: "ko" };
  }
  if (t.startsWith("remarque")) {
    // Le lanceur lui-même a été mis à jour : conseil de relance, une fois.
    return { heure, texte: "Une dernière chose : le petit programme qui installe les mises à jour a lui-même changé. Fermez sa fenêtre puis relancez « Hermes Web » une seule fois — les prochaines mises à jour s'afficheront en direct.", jalon: -1, classe: "" };
  }

  // — Jalon 0 : Demande envoyée —
  if (t.includes("demande deposee") || t.includes("maj debut") || t.includes("arret des services")) {
    return { heure, texte: "Demande envoyée — arrêt en douceur de l'application (une dizaine de secondes)…", jalon: 0, classe: "" };
  }

  // — Jalon 1 : Téléchargement —
  if (t.includes("consultation de github")) {
    return { heure, texte: "Recherche de la nouvelle version…", jalon: 1, classe: "" };
  }
  if (t.includes("fusion directe impossible")) {
    return { heure, texte: "Vos modifications locales sont mises de côté (sauvegardées, pas perdues), puis la nouvelle version est récupérée…", jalon: 1, classe: "" };
  }
  if (t.includes("version github appliquee") || t.includes("mise a jour appliquee")) {
    return { heure, texte: "Nouvelle version récupérée.", jalon: 1, classe: "" };
  }
  if (t.includes("pas de branche distante")) {
    return { heure, texte: "Pas de dépôt distant configuré — la version locale est conservée.", jalon: -1, classe: "ko" };
  }

  // — Jalon 2 : Installation —
  if (t.includes("reconstruction") || t.includes("construction de l'interface") || t.includes("code de l'interface modifie")) {
    return { heure, texte: "Le code de l'application a changé — reconstruction (1 à 3 minutes, c'est le plus long)…", jalon: 2, classe: "" };
  }
  if (t.includes("services arretes") || t.includes("relance des services")) {
    return { heure, texte: "Redémarrage de l'application (la connexion coupe une dizaine de secondes, c'est normal)…", jalon: 2, classe: "" };
  }

  // Ligne technique non traduite : on la garde brute — honnêteté d'abord.
  return { heure, texte, jalon: -1, classe: "" };
}

/** Traduction d'une ligne du journal du MOTEUR (phrases réelles de
 *  agent-motor.ts). Jalons : 0 demande · 1 sauvegarde/arrêt · 2 mise à
 *  jour · 3 contrôle (-1 = info). */
export function traduireLigneMotor(brute: string): FilLigne {
  const { heure, texte } = splitHeure(brute);
  const t = sansAccents(texte);

  if (texte.includes("MOTEUR MAJ OK")) {
    return { heure, texte: "Hermes a installé la nouvelle version — contrôle de la liaison en cours (jusqu'à 2 minutes)…", jalon: 3, classe: "" };
  }
  if (texte.includes("MOTEUR MAJ ERREUR")) {
    return { heure, texte: "La mise à jour de Hermes n'a pas abouti. Rien n'a changé — la version installée continue de tourner.", jalon: -1, classe: "ko" };
  }
  if (/RETOUR OK|RETOUR EFFECTU/.test(texte)) {
    return { heure, texte: "Le retour arrière est terminé — Hermes est revenu à la version d'avant.", jalon: 3, classe: "ok" };
  }
  if (texte.includes("RETOUR ERREUR")) {
    return { heure, texte: "Le retour arrière n'a pas abouti — rien n'a été cassé, l'état actuel est conservé.", jalon: -1, classe: "ko" };
  }
  if (texte.includes("CONTRÔLE OK")) {
    return { heure, texte: "Contrôle réussi — l'application parle bien à Hermes.", jalon: 3, classe: "ok" };
  }
  if (texte.includes("CONTRÔLE ÉCHOUÉ") || t.includes("controle echoue")) {
    return { heure, texte: "Le contrôle a échoué — un retour arrière est proposé dans la carte.", jalon: 3, classe: "ko" };
  }
  if (t.includes("mise a jour du moteur hermes demandee")) {
    return { heure, texte: "Mise à jour demandée — la version actuelle est d'abord mise de côté (sauvegarde complète).", jalon: 0, classe: "" };
  }
  if (t.includes("retour arriere demande")) {
    return { heure, texte: "Retour arrière demandé — procédure officielle de Hermes, étape par étape.", jalon: 0, classe: "" };
  }
  if (t.includes("etape 1/3")) {
    return { heure, texte: "Arrêt en douceur de Hermes (ses travaux sont sauvegardés)…", jalon: 1, classe: "" };
  }
  if (t.includes("etape 2/3")) {
    return { heure, texte: "Retour aux fichiers de la version précédente…", jalon: 2, classe: "" };
  }
  if (t.includes("etape 3/3")) {
    return { heure, texte: "Relancez Hermes comme d'habitude — le contrôle suivra tout seul (jusqu'à 2 minutes).", jalon: 3, classe: "" };
  }
  if (t.startsWith("$ ")) {
    // Ligne de commande : le détail technique, discret mais présent.
    return { heure, texte, jalon: -1, classe: "" };
  }
  if (t.includes("commande introuvable") || t.includes("arrete :")) {
    return { heure, texte, jalon: -1, classe: "ko" };
  }
  return { heure, texte, jalon: -1, classe: "" };
}

/** Journal complet → lignes du fil. Chaque ligne garde son jalon maximal
 *  atteint à cet endroit du récit (les jalons ne reculent jamais dans
 *  l'affichage — le fil raconte une progression). */
export function parseFil(text: string, traduire: (brute: string) => FilLigne): FilLigne[] {
  const lignes = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(traduire);
  let max = -1;
  return lignes.map((l) => {
    if (l.jalon > max) max = l.jalon;
    return { ...l, jalon: l.jalon >= 0 ? max : l.jalon };
  });
}

// ── L'horloge du fil : le « il y a N s » qui vit ──────────────────────────
// L'âge des lignes est calculé sur l'horloge du NAVIGATEUR à partir du
// préfixe [HH:MM:SS] local des lanceurs (même machine en usage desktop —
// écart négligeable ; l'audit A-2 note le cas « autre poste »). Le
// garde-fou, lui, s'appuie sur mtimeMs (horloge du service, fiable).

/** Re-render chaque seconde pendant que `actif` — l'âge respire. */
export function useTick(actif: boolean): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!actif) return;
    const id = setInterval(() => setN((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [actif]);
  return Date.now();
}

/** [HH:MM:SS] du jour → timestamp (ms). Si l'heure est « dans le
 *  futur » de plus de 30 s, c'est qu'elle date d'hier (maj à minuit). */
export function heureVersMs(heure: string): number {
  const [h, m, s] = heure.split(":").map(Number);
  const now = new Date();
  const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();
  if (ts > now.getTime() + 30_000) return ts - 86_400_000;
  return ts;
}

// ── Rendu des jalons (grammaire maquette : la barre qui avance) ───────────

/** Barre de jalons : coches vertes derrière le jalon courant, point qui
 *  pulse dessus, cur === -1 = tout coché (verdict). */
export function jalonsHtml(labels: string[], cur: number): React.ReactNode[] {
  const elts: React.ReactNode[] = [];
  labels.forEach((label, i) => {
    const done = cur === -1 || i < cur;
    const now = i === cur;
    if (i > 0) {
      elts.push(
        <span
          key={`sep-${i}`}
          aria-hidden
          className={"h-0.5 flex-none rounded " + (done ? "w-[22px] bg-success" : "w-[22px] bg-border")}
        />
      );
    }
    elts.push(
      <span
        key={`jalon-${i}`}
        className={
          "inline-flex items-center gap-1.5 text-[11.5px] font-semibold " +
          (done ? "text-foreground" : now ? "text-hermes-text" : "text-muted-foreground")
        }
      >
        <i
          aria-hidden
          className={
            "grid size-[17px] flex-none place-items-center rounded-full border-2 text-[9px] font-bold text-white " +
            (done ? "border-success bg-success" : now ? "animate-pulse border-hermes" : "border-border")
          }
        >
          {done ? "✓" : ""}
        </i>
        {label}
      </span>
    );
  });
  return elts;
}
