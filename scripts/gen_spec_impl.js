/* ============================================================
   Hermes — Document d'implémentation « Volet Système & page Stockage »
   Génère download/hermes-specification-systeme-stockage.docx
   Recette de couverture : R1 (design-system.md) · Palette GO-1
   Scène : report (profil A) · Architecture 3 sections (couverture / sommaire / corps)
   ============================================================ */
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, PageNumber, NumberFormat, AlignmentType, HeadingLevel,
  WidthType, BorderStyle, ShadingType, SectionType, TableOfContents,
  LevelFormat, TableLayoutType, PageOrientation,
} = require("docx");
const fs = require("fs");

/* — Palette GO-1 (Graphite Orange — PRD / proposition) — */
const PAL = {
  bg: "1A2330", accent: "D4875A", primary: "1A2330", body: "000000", secondary: "5A6470",
  cover: { titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F", footerColor: "687078" },
  table: { headerBg: "D4875A", headerText: "FFFFFF", innerLine: "DDD0C8", surface: "F8F0EB" },
};
const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

/* ============ Fonctions de couverture (design-system.md) ============ */
function splitTitleLines(title, charsPerLine) {
  if (title.length <= charsPerLine) return [title];
  const breakAfter = new Set([..."，。、；：！？", ..."的与和及之在于为", ..."-_—–·/", ..." \t"]);
  const lines = [];
  let remaining = title;
  while (remaining.length > charsPerLine) {
    let breakAt = -1;
    for (let i = charsPerLine; i >= Math.floor(charsPerLine * 0.6); i--) {
      if (i < remaining.length && breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      const limit = Math.min(remaining.length, Math.ceil(charsPerLine * 1.3));
      for (let i = charsPerLine + 1; i < limit; i++) {
        if (breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
      }
    }
    if (breakAt === -1) {
      breakAt = charsPerLine;
      const prevChar = remaining[breakAt - 1], nextChar = remaining[breakAt];
      if (prevChar && nextChar && !breakAfter.has(prevChar) && !breakAfter.has(nextChar) &&
          /[\u4e00-\u9fff]/.test(prevChar) && /[\u4e00-\u9fff]/.test(nextChar)) breakAt -= 1;
    }
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  if (lines.length > 1 && lines[lines.length - 1].length <= 2) {
    const last = lines.pop();
    lines[lines.length - 1] += last;
  }
  return lines;
}
function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  const charWidth = (pt) => pt * 20;
  const charsPerLine = (pt) => Math.floor(maxWidthTwips / charWidth(pt));
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    const cpl = charsPerLine(titlePt);
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = splitTitleLines(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) {
    lines = splitTitleLines(title, charsPerLine(minPt));
    titlePt = minPt;
  }
  return { titlePt, titleLines: lines };
}
function calcCoverSpacing(params) {
  const { titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false,
    metaLineCount = 0, fixedHeight = 800, pageHeight = 16838, marginTop = 0, marginBottom = 0 } = params;
  const SAFETY = 1200;
  const usableHeight = pageHeight - marginTop - marginBottom - SAFETY;
  const titleHeight = titleLineCount * (titlePt * 23 + 200);
  const subtitleHeight = hasSubtitle ? (12 * 23 + 600) : 0;
  const englishLabelHeight = hasEnglishLabel ? (9 * 23 + 600) : 0;
  const metaHeight = metaLineCount * (10 * 23 + 100);
  const implicitParaHeight = 3 * 300;
  const contentHeight = titleHeight + subtitleHeight + englishLabelHeight + metaHeight + fixedHeight + implicitParaHeight;
  const safeRemaining = Math.max(usableHeight - contentHeight, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  const midSpacing = Math.max(safeRemaining - topSpacing - bottomSpacing, 0);
  return { topSpacing, midSpacing, bottomSpacing };
}
/* Recette R1 : paragraphe pur, aligné à gauche, zéro table imbriquée */
function buildCoverR1(config) {
  const P = config.palette;
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 32, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400,
  });
  const accentLeft = { style: BorderStyle.SINGLE, size: 8, color: P.accent, space: 12 };
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      indent: { left: padL, right: padR }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent, space: 8 } },
      children: [new TextRun({ text: config.englishLabel.split("").join("  "),
        size: 18, color: P.accent, font: { ascii: "Calibri", eastAsia: "SimHei" }, characterSpacing: 40 })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      indent: { left: padL },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [new TextRun({ text: titleLines[i], size: titleSize, bold: true,
        color: P.titleColor, font: { eastAsia: "SimHei", ascii: "Arial" } })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      indent: { left: padL }, spacing: { after: 800 },
      children: [new TextRun({ text: config.subtitle, size: 24, color: P.subtitleColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      indent: { left: padL + 200 }, spacing: { after: 80 },
      border: { left: accentLeft },
      children: [new TextRun({ text: line, size: 24, color: P.metaColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    indent: { left: padL, right: padR },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: P.accent, space: 8 } },
    spacing: { before: 200 },
    children: [
      new TextRun({ text: config.footerLeft || "", size: 16, color: P.footerColor, font: { ascii: "Arial" } }),
      new TextRun({ text: "                                        " }),
      new TextRun({ text: config.footerRight || "", size: 16, color: P.footerColor, font: { ascii: "Arial" } }),
    ],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: P.bg }, borders: noBorders,
        children,
      })],
    })],
  })];
}

/* ============ Typographie (profil A, document latin) ============ */
const F_BODY = { ascii: "Times New Roman", eastAsia: "SimSun" };
const F_HEAD = { ascii: "Times New Roman", eastAsia: "SimHei" };

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    keepNext: true,
    spacing: { before: 360, after: 160, line: 312 },
    children: [new TextRun({ text, bold: true, size: 32, color: PAL.primary, font: F_HEAD })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    spacing: { before: 260, after: 120, line: 312 },
    children: [new TextRun({ text, bold: true, size: 30, color: PAL.primary, font: F_HEAD })],
  });
}
/* Corps : justifié (usage français), sans retrait de première ligne (script latin) */
function p(runsOrText, opts = {}) {
  const runs = typeof runsOrText === "string"
    ? [new TextRun({ text: runsOrText, size: 24, color: PAL.body, font: F_BODY })]
    : runsOrText.map(r => new TextRun({ text: r.t, bold: !!r.b, italics: !!r.i,
        size: r.size || 24, color: r.color || PAL.body, font: F_BODY }));
  return new Paragraph({
    alignment: opts.align || AlignmentType.JUSTIFIED,
    spacing: { line: 312, after: opts.after != null ? opts.after : 120 },
    keepNext: !!opts.keepNext,
    children: runs,
  });
}
/* Liste numérotée / puces : alignées à gauche, un point par ligne */
function numItem(reference, runs) {
  return new Paragraph({
    numbering: { reference, level: 0 },
    alignment: AlignmentType.LEFT,
    spacing: { line: 312, after: 80 },
    children: runs.map(r => new TextRun({ text: r.t, bold: !!r.b, size: 24, color: PAL.body, font: F_BODY })),
  });
}
function bullet(runs) {
  return new Paragraph({
    bullet: { level: 0 },
    alignment: AlignmentType.LEFT,
    spacing: { line: 312, after: 80 },
    children: runs.map(r => new TextRun({ text: r.t, bold: !!r.b, size: 24, color: PAL.body, font: F_BODY })),
  });
}
/* Tableaux « horizontal-only » (style affaires, jetons GO-1) */
function tcap(text) {
  return new Paragraph({
    keepNext: true, alignment: AlignmentType.LEFT,
    spacing: { before: 160, after: 80, line: 312 },
    children: [new TextRun({ text, bold: true, size: 21, color: PAL.secondary, font: F_BODY })],
  });
}
function cellPara(content, opts = {}) {
  const parts = Array.isArray(content) ? content : [content];
  return parts.map(txt => new Paragraph({
    alignment: opts.align || AlignmentType.LEFT,
    spacing: { line: 312 },
    children: [new TextRun({ text: txt, bold: !!opts.bold, size: 20,
      color: opts.color || PAL.body, font: F_BODY })],
  }));
}
function tbl(headers, rows, widths) {
  const headerRow = new TableRow({
    tableHeader: true, cantSplit: true,
    children: headers.map((text, i) => new TableCell({
      children: cellPara(text, { bold: true, color: PAL.table.headerText }),
      shading: { type: ShadingType.CLEAR, fill: PAL.table.headerBg },
      margins: { top: 60, bottom: 60, left: 120, right: 120 },
      width: { size: widths[i], type: WidthType.PERCENTAGE },
    })),
  });
  const dataRows = rows.map((r, ri) => new TableRow({
    cantSplit: true,
    children: r.map((cell, i) => new TableCell({
      children: cellPara(cell.text != null ? cell.text : cell, { bold: !!cell.bold }),
      shading: ri % 2 === 0
        ? { type: ShadingType.CLEAR, fill: "FFFFFF" }
        : { type: ShadingType.CLEAR, fill: PAL.table.surface },
      margins: { top: 60, bottom: 60, left: 120, right: 120 },
      width: { size: widths[i], type: WidthType.PERCENTAGE },
    })),
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: PAL.accent },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: PAL.accent },
      left: NB, right: NB,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: PAL.table.innerLine },
      insideVertical: NB,
    },
    rows: [headerRow, ...dataRows],
  });
}

/* ============ Jeu de démonstration : agrégats calculés ============ */
/* Transcription fidèle de XDATA (maquette) — le script vérifie les totaux
   contre les valeurs observées au navigateur (79 versions · 150,1 Mo · P1 31/61,5/28,1). */
const XDATA = [
  { name: "Refonte site vitrine", docs: [
    { n: "plan-de-charge.pdf", k: "PDF", pin: true, v: [[1, 2.1], [2, 3.8], [3, 12.4]] },
    { n: "benchmark-concurrents.xlsx", k: "XLSX", v: [[1, 5.4], [2, 5.9]] },
    { n: "maquette-accueil.html", k: "HTML", v: [[1, 1.2], [2, 4.1]] },
    { n: "maquette-tarifs.html", k: "HTML", v: [[1, 0.9], [2, 1.6], [3, 2.8], [4, 3.8]] },
    { n: "logo-v2.png", k: "PNG", v: [[1, 0.4], [2, 0.7], [3, 1.0], [4, 1.3], [5, 1.7], [6, 2.2]] },
    { n: "plan-sitemap.pdf", k: "PDF", v: [[1, 1.4]] },
    { n: "copywriting-guides.md", k: "MD", v: [[1, 0.1], [2, 0.1], [3, 0.1], [4, 0.2], [5, 0.2], [6, 0.2], [7, 0.3], [8, 0.3], [9, 0.3]] },
    { n: "notes-reunion-7-nov.md", k: "MD", v: [[1, 0.1]] },
    { n: "moodboard.png", k: "PNG", v: [[1, 1.1], [2, 2.6], [3, 3.2]] },
  ] },
  { name: "Veille concurrence", docs: [
    { n: "rapport-veille-semaine-43.pdf", k: "PDF", v: [[1, 6.1]] },
    { n: "rapport-veille-semaine-44.pdf", k: "PDF", v: [[1, 6.4]] },
    { n: "rapport-veille-semaine-45.pdf", k: "PDF", v: [[1, 6.6]] },
    { n: "rapport-veille-semaine-46.pdf", k: "PDF", pin: true, v: [[1, 8.7]] },
    { n: "alertes-concurrents.xlsx", k: "XLSX", v: [[1, 4.8], [2, 5.5], [3, 6.2]] },
    { n: "captures-prix-tarifs.pdf", k: "PDF", v: [[1, 3.1], [2, 4.4]] },
    { n: "tableau-comparatif.html", k: "HTML", v: [[1, 1.2], [2, 1.9]] },
    { n: "revue-presse.md", k: "MD", v: [[1, 0.1], [2, 0.1], [3, 0.2], [4, 0.2], [5, 0.2]] },
  ] },
  { name: "Budget 2027", docs: [
    { n: "previsionnel.xlsx", k: "XLSX", pin: true, v: [[1, 0.9], [2, 1.0], [3, 1.1], [4, 1.3], [5, 1.5], [6, 1.8], [7, 2.1], [8, 2.4], [9, 2.8]] },
    { n: "synthese-direction.pdf", k: "PDF", v: [[1, 1.2], [2, 1.7]] },
    { n: "courbes-evolution.png", k: "PNG", v: [[1, 0.5], [2, 0.6], [3, 0.7], [4, 0.9]] },
    { n: "notes-hypotheses.md", k: "MD", v: [[1, 0.1], [2, 0.1], [3, 0.2]] },
  ] },
  { name: "Hors projet", hors: true, docs: [
    { n: "export-conversation-15-nov.pdf", k: "PDF", v: [[1, 3.3]] },
    { n: "data-ventes-2025.xlsx", k: "XLSX", v: [[1, 2.5]] },
    { n: "screenshot-tableau.png", k: "PNG", v: [[1, 0.6], [2, 1.1]] },
    { n: "brouillon-article.html", k: "HTML", v: [[1, 0.4], [2, 0.5], [3, 0.5], [4, 0.6], [5, 0.7], [6, 0.7], [7, 0.8]] },
    { n: "resume-reunion.md", k: "MD", v: [[1, 0.1], [2, 0.1]] },
    { n: "modele-mail-relance.md", k: "MD", v: [[1, 0.1]] },
  ] },
];
/* Règle canonique : nettoyable = !épinglée ET version < dernière version du même document */
function aggregate(data) {
  return data.map(prj => {
    let rows = 0, total = 0, clean = 0;
    prj.docs.forEach(doc => {
      const maxV = Math.max(...doc.v.map(x => x[0]));
      doc.v.forEach(([v, mb]) => {
        rows += 1; total += mb;
        if (!(doc.pin && v === maxV) && v < maxV) clean += mb;
      });
    });
    const r1 = x => Math.round(x * 10) / 10;
    return { name: prj.name, rows, total: r1(total), clean: r1(clean) };
  });
}
const AGG = aggregate(XDATA);
const fr = v => String(v.toFixed(1)).replace(".", ",");
const TOT = {
  rows: AGG.reduce((s, a) => s + a.rows, 0),
  total: Math.round(AGG.reduce((s, a) => s + a.total, 0) * 10) / 10,
  clean: Math.round(AGG.reduce((s, a) => s + a.clean, 0) * 10) / 10,
};
console.log("Agrégats jeu de démo :", AGG.map(a => `${a.name}=${a.rows}/${a.total}/${a.clean}`).join(" | "),
  `TOTAL=${TOT.rows}/${TOT.total}/${TOT.clean}`);
/* Garde-fous : valeurs vérifiées au navigateur pendant la revue de maquette */
if (TOT.rows !== 79 || Math.abs(TOT.total - 150.1) > 0.05 || Math.abs(TOT.clean - 62.7) > 0.05
  || AGG[0].rows !== 31 || Math.abs(AGG[0].total - 61.5) > 0.05 || Math.abs(AGG[0].clean - 28.1) > 0.05) {
  console.error("ÉCHEC : agrégats incohérents avec la maquette vérifiée.");
  process.exit(1);
}

/* ============ Contenu ============ */
const body = [];

/* — 1. Résumé exécutif — */
body.push(h1("1. Résumé exécutif"));
body.push(p("Ce document spécifie l'implémentation, dans l'interface Hermes, des écrans validés en maquette : le volet Paramètres · Système allégé, réduit aux cartes « Mise à jour » et « Agent Hermes », et une page « Stockage » dédiée qui accueille l'explorateur de documents générés. La maquette parametres-systeme, revue comportement par comportement et vérifiée au navigateur (état initial, exclusivité de l'accordéon, filtrage, nettoyage sans dépliage, suppression à l'unité, rendu à 375 px), sert de référence contractuelle : les comportements listés au chapitre 2 doivent être portés à l'identique dans le produit."));
body.push(p("La décision structurante est l'éclatement : la section « Rangement » disparaît des Paramètres au profit d'une page dédiée, avec une entrée de navigation propre au même niveau. Chaque page charge alors uniquement ses données — ouvrir les Paramètres n'interroge plus la table des artifacts — et le nettoyage de masse gagne un contexte d'action approprié. Le présent document couvre les machines à états des deux cartes, le modèle d'état déclaratif de l'explorateur, les contrats d'interface avec l'agent, les exigences d'accessibilité et une matrice de recette de vingt-trois cas dérivée directement des vérifications effectuées sur la maquette."));
body.push(p("Trois arbitrages sont actés et détaillés au chapitre 8 : retour systématique au repli par défaut à la fin d'un filtrage, accordéon exclusif en consultation manuelle, et absence de « Tout nettoyer » global en version 1. Deux questions restent ouvertes — le calcul du volume récupérable en présence d'un stockage dédupliqué, et la disposition fine des deux cartes — chacune assortie d'une recommandation."));

/* — 2. Périmètre et décisions structurantes — */
body.push(h1("2. Périmètre et décisions structurantes"));
body.push(h2("2.1 Éclatement en deux pages"));
body.push(p("Jusqu'à la version 0.2.1, l'onglet Système des Paramètres concentre trois sujets hétérogènes : la mise à jour du service, l'état de l'agent local et le rangement des documents générés. La revue de maquette a validé la séparation de ces préoccupations. La page Paramètres · Système conserve les deux cartes techniques ; l'explorateur de documents déménage dans une page « Stockage », dotée d'une entrée de navigation dédiée au même niveau que Paramètres. Une page dédiée appelle une entrée dédiée : la reléguer en sous-onglet des Paramètres contredirait la décision initiale."));
body.push(p("Les bénéfices attendus sont concrets. Le chargement est différencié : la table des artifacts n'est lue qu'à l'entrée sur la page Stockage, ce qui répond directement au constat d'activité résiduelle des volets restés ouverts — moins de choses se passent sur une page qu'on a oubliée d'afficher. Le volet Paramètres, raccourci, se limite à deux cartes lisibles. Enfin, l'action de nettoyage de masse s'exerce dans un contexte qui lui est propre, sans mélanger préoccupations techniques et gestion de l'espace disque. Les compteurs de stockage ne sont pas dupliqués dans les Paramètres ; au besoin, un lien discret « Gérer le stockage » y renverra vers la page dédiée."));
body.push(h2("2.2 Comportements validés en maquette — référence contractuelle"));
body.push(p("Les comportements suivants ont été implémentés dans la maquette puis vérifiés un à un au navigateur, y compris sur l'état replié initial, les trois déclencheurs de fin de filtrage, le nettoyage sans dépliage, la protection des documents épinglés et le rendu à 375 px. Ils constituent la référence : toute divergence constatée dans l'implémentation réelle est une régression à corriger avant livraison.", { keepNext: true }));
[
  [{ t: "Repli par défaut — ", b: true }, { t: "à l'ouverture de la page Stockage, tous les groupes projet sont repliés ; chaque en-tête reste auto-suffisant (nombre de versions, occupation, volume récupérable, bouton « Nettoyer »)." }],
  [{ t: "Accordéon exclusif — ", b: true }, { t: "un seul groupe ouvert à la fois ; ouvrir un projet referme le précédent ; re-cliquer le groupe ouvert referme tout." }],
  [{ t: "Filtrage depuis l'état replié — ", b: true }, { t: "une recherche ou un filtre de type déroule automatiquement les groupes contenant des résultats et masque les autres ; plusieurs groupes peuvent alors être déroulés (vue résultats)." }],
  [{ t: "Repliage manuel suspendu — ", b: true }, { t: "pendant un filtrage actif, l'utilisateur ne peut pas refermer un groupe : il ferait disparaître des résultats sans s'en rendre compte." }],
  [{ t: "Compteur de résultats — ", b: true }, { t: "« N fichiers correspondent — effacer les filtres » reste affiché pendant toute la durée du filtrage." }],
  [{ t: "Fin de filtrage — ", b: true }, { t: "bouton « effacer les filtres », champ vidé manuellement ou retour au type « Tous » : les trois chemins ramènent au repli par défaut complet." }],
  [{ t: "Nettoyer sans déplier — ", b: true }, { t: "le bouton « Nettoyer » d'un en-tête replié fonctionne sans ouvrir le groupe ; les compteurs de l'en-tête se mettent à jour en place." }],
  [{ t: "Suppression à l'unité — ", b: true }, { t: "la corbeille d'une version exige le groupe déplié ; la suppression ne referme pas le groupe ; la version épinglée de chaque document n'est pas supprimable (bouton désactivé, message explicatif)." }],
  [{ t: "Tri silencieux — ", b: true }, { t: "le tri (taille, date, nom) s'applique même groupes repliés ; il est visible à la prochaine ouverture." }],
  [{ t: "Projet vidé — ", b: true }, { t: "un projet arrivé à zéro version garde son en-tête « 0 document · 0,0 Mo », bouton « Nettoyer » désactivé." }],
  [{ t: "Liste intégrale — ", b: true }, { t: "aucune découpe en pages ni hauteur plafonnée : un groupe déplié montre toutes ses versions." }],
].forEach(runs => body.push(numItem("comportements", runs)));
body.push(p("Le chapitre 4 reformule ces comportements sous forme déclarative — mieux adaptée à une implémentation maintenue que les appels impératifs de la maquette — et précise les règles de chargement propres à la page dédiée.", { after: 160 }));
body.push(h2("2.3 Hors périmètre de cette version"));
body.push(p("Sont explicitement exclus de la version 1 et ne doivent pas surgir en cours de développement :"));
[
  [{ t: "l'épinglage et le détachement de documents, qui appartiennent au contexte des conversations ;" }],
  [{ t: "le masquage des projets vides (décision produit ultérieure, question ouverte n° 3) ;" }],
  [{ t: "la veille automatique des mises à jour (vérification à l'ouverture et à la demande seulement) ;" }],
  [{ t: "l'action « Tout nettoyer » globale (arbitrage du chapitre 8) ;" }],
  [{ t: "la persistance de l'état d'ouverture des groupes d'une session à l'autre ;" }],
  [{ t: "toute pagination de la liste — le rendu intégral est un engagement produit." }],
].forEach(runs => body.push(bullet(runs)));

/* — 3. Page Paramètres · Système — */
body.push(h1("3. Page Paramètres · Système"));
body.push(p("La page allégée porte deux cartes, chacune décrite par une petite machine à états : c'est le bon niveau de spécification pour des composants dont la complexité est précisément la gestion des états. Les deux suivent une règle commune : aucune n'émet de requête périodique tant qu'elle est affichée."));
body.push(h2("3.1 Carte Mise à jour"));
body.push(p("La vérification des mises à jour obéit à deux déclencheurs seulement : l'ouverture de la page et le bouton « Vérifier à nouveau ». Aucun minuteur résidant — c'est précisément le motif d'occupation processeur à l'arrêt constaté sur les pages oubliées ouvertes. La requête vers le dépôt est conditionnelle (ETag / If-None-Match) : une réponse « rien de neuf » coûte quelques octets. La version installée reste toujours affichée, y compris en état d'erreur : la carte n'est jamais vide. L'état « prêt à installer » verrouille les autres actions tant que l'installation n'a pas été lancée ou annulée."));
body.push(tcap("Tableau 1 — Machine à états de la carte Mise à jour"));
body.push(tbl(
  ["État", "Signalement à l'écran", "Actions disponibles"],
  [
    ["inconnu", "Vérification en cours au premier affichage", "— (attente, avec délai d'expiration vers « erreur »)"],
    ["à jour", "Version installée et date de dernière vérification", "Vérifier à nouveau"],
    ["disponible", "Nouvelle version et journal des modifications", "Télécharger"],
    ["téléchargement", "Progression du transfert", "Annuler"],
    ["prêt", "Paquet installé, en attente de relance ; actions verrouillées", "Installer et redémarrer · Annuler"],
    ["erreur", "Cause (hors ligne, dépôt injoignable) ; version installée visible", "Réessayer"],
  ],
  [16, 50, 34]
));
body.push(p("L'état « erreur » n'est jamais terminal : le bouton « Réessayer » relance la vérification complète, et le basculement depuis n'importe quel état reste possible. À l'issue d'une installation réussie, la carte revient à « à jour » avec la nouvelle version.", { after: 160 }));
body.push(h2("3.2 Carte Agent Hermes"));
body.push(p("La source de vérité de cette carte est l'état de la websocket de l'agent : un seul flux, aucune requête supplémentaire. Les reconnexions automatiques sont à temporisation exponentielle et silencieuses — la carte ne doit pas clignoter « déconnecté » à chaque micro-coupure réseau. L'action « Redémarrer l'agent » transite par « démarrage » puis « connecté », avec un délai d'attente maximal au-delà duquel la carte passe en « erreur » : jamais d'attente infinie."));
body.push(tcap("Tableau 2 — Machine à états de la carte Agent Hermes"));
body.push(tbl(
  ["État", "Signalement à l'écran", "Actions disponibles"],
  [
    ["démarrage", "Connexion en cours (lancement ou redémarrage demandé)", "— (délai max, puis « erreur »)"],
    ["connecté", "Version de l'agent et horaire du dernier battement reçu", "Redémarrer · Voir les journaux"],
    ["déconnecté", "Reconnexion automatique en cours (silencieuse)", "Redémarrer"],
    ["erreur", "Motif de l'échec et prochaine tentative", "Réessayer · Voir les journaux"],
  ],
  [16, 50, 34]
));
body.push(p("Les réglages avancés (installation spéciale : adresse de l'agent, code d'accès) restent dans le replié « Installation spéciale » tel que dessiné en maquette. Ils ne s'activent qu'à la demande et n'interagissent pas avec la machine à états tant que « Connecter » n'est pas pressé.", { after: 160 }));
body.push(h2("3.3 Règles transverses de la page"));
body.push(p("Aucune requête périodique n'est émise par une page simplement affichée : les rafraîchissements sont liés à des événements — ouverture de la page, mutation de données, action explicite de l'utilisateur. Avec deux cartes seulement, la page respire : disposition en pleine largeur ou en deux colonnes égales, à trancher par une maquette rapide (question ouverte n° 2, non bloquante). Aucune donnée de stockage n'apparaît ici ; la compétence « espace disque » appartient à la page Stockage."));

/* — 4. Page Stockage — */
body.push(h1("4. Page Stockage"));
body.push(h2("4.1 Structure de la page et comportements"));
body.push(p("L'en-tête de la page affiche les compteurs globaux : nombre de versions, occupation totale, volume récupérable. Conformément à l'arbitrage du chapitre 8, aucune action « Tout nettoyer » globale n'y figure : le nettoyage reste une action par projet, délibérément moins exposée. La barre recherche / filtre de type / tri constitue l'en-tête fonctionnel de la page, portée par le défilement naturel de la page entière — plus besoin d'un mécanisme d'accrochage borné à un conteneur. Les comportements de l'explorateur sont ceux du chapitre 2.2, contractualisés sans modification."));
body.push(h2("4.2 Modèle d'état déclaratif"));
body.push(p("La maquette pilote l'interface par appels impératifs (ouvrir et fermer les groupes un à un). L'implémentation réelle modélise la même chose de façon déclarative, avec quatre variables d'état et des règles de dérivation — structure plus simple à tester, où l'exclusivité et le retour au repli tombent par construction."));
body.push(tcap("Tableau 3 — Variables d'état de l'explorateur"));
body.push(tbl(
  ["Variable", "Valeurs", "Rôle"],
  [
    ["projetOuvert", "identifiant de projet, ou null", "Unique groupe déroulé en consultation manuelle ; null = tout replié"],
    ["recherche", "chaîne normalisée (accents repliés)", "Filtrage par nom de fichier"],
    ["type", "« Tous » ou un type (PDF, XLSX…)", "Filtrage par type de document"],
    ["tri", "taille · date · nom", "Ordre d'affichage des versions dans chaque groupe"],
  ],
  [22, 32, 46]
));
body.push(p([
  { t: "L'état déroulé de chaque groupe est ensuite " },
  { t: "dérivé", b: true },
  { t: ", jamais stocké : sans filtrage actif, un projet est déroulé si et seulement si projetOuvert le désigne ; avec un filtrage actif, un projet est déroulé s'il contient des résultats et masqué sinon. Trois règles de transition complètent le modèle. Premièrement, l'ouverture manuelle s'écrit projetOuvert = p (l'exclusivité est structurelle : ouvrir un projet ferme le précédent par construction) et le re-clic du groupe ouvert s'écrit projetOuvert = null. Deuxièmement, à la transition filtrage actif vers filtrage inactif — quel que soit le déclencheur — projetOuvert est remis à null : le retour au repli par défaut découle de la règle et non d'une boucle de fermeture. Troisièmement, le repliage manuel est ignoré pendant un filtrage actif." },
]));
body.push(p("Dernière règle, invisible en maquette mais critique en production : tout rechargement des données préserve l'état de l'interface. Après une suppression ou un nettoyage, la liste est réinterrogée — le groupe ouvert doit rester ouvert, la recherche et le tri en cours. Un rechargement naïf qui replierait tout ferait perdre à l'utilisateur le contexte de son action au moment précis où il agit."));
body.push(h2("4.3 Chargement, erreurs et lien profond"));
body.push(p("Les artifacts sont récupérés à chaque entrée sur la page, sans cache entre visites : un outil de nettoyage qui afficherait des mégaoctets déjà libérés perdrait toute confiance. Pendant la récupération, la page montre un squelette (silhouettes de lignes) ; en cas d'absence de réponse de l'agent, un message d'erreur avec bouton « Réessayer ». Après chaque mutation, la liste est réinterrogée en préservant l'état (règle ci-dessus) ; une version générée par une conversation pendant que la page est ouverte sera donc visible au rechargement suivant — suffisant en version 1, un flux poussé serait surdimensionné. Le lien profond « ?projet=Nom » ouvre la page directement sur le groupe concerné, déplié : c'est le seul cas d'ouverture dépliée, par conception, pour permettre à un message (« votre stockage déborde, ouvrez le projet X ») d'atterrir au bon endroit. L'état de l'interface n'est pas persisté : quitter la page ramène au repli par défaut."));
body.push(h2("4.4 Rendu et performance"));
body.push(p("Le rendu intégral des listes est garanti par défaut — la promesse « totalement déroulable » est un engagement produit, pas une option. Garde-fou : au-delà d'environ cinq cents versions dans un même projet, la construction des lignes est différée à la première ouverture du groupe et chaque ligne reçoit la propriété de visibilité de contenu automatique ; la liste reste intégralement déroulée, seule la construction est paresseuse. La recherche normalise la saisie (repli des accents, insensible à la casse) avec un léger délai d'anticipation de 100 à 150 millisecondes. Les tailles transitent en octets depuis l'agent et ne sont formatées (mégaoctets, séparateur décimal français) qu'à l'affichage ; aucun arrondi n'entre dans un calcul."));
body.push(h2("4.5 Opérations destructrices"));
body.push(p("Chaque opération destructive — suppression d'une version ou nettoyage d'un projet — renvoie un jeton d'annulation valable sept secondes, matérialisé par un bouton « Annuler » dans le bandeau de confirmation. La suppression physique intervient à l'expiration de la fenêtre ou au démarrage suivant (mécanique identique à la purge des fichiers temporaires de rendu déjà prévue). Les volumes « libérés » affichés après coup sont mesurés — delta réel renvoyé par l'opération — et non l'estimation d'avant, qui ne sert qu'à l'écran de confirmation. Un échec de suppression de fichier est traité par ligne : bandeau d'erreur ciblé, ligne conservée, jamais de demi-suppression comptée comme succès. Un nettoyage long désactive son bouton et affiche l'avancement dans l'en-tête du groupe, sans boîte de dialogue modale pour une action réversible."));

/* — 5. Contrats d'interface — */
body.push(h1("5. Contrats d'interface avec l'agent"));
body.push(h2("5.1 Points d'entrée"));
body.push(p("Le contrat reste volontairement mince : une lecture d'inventaire, trois opérations sur les artifacts, la vérification de mise à jour. L'état de l'agent transite par la websocket existante, sans point d'entrée nouveau."));
body.push(tcap("Tableau 4 — Points d'entrée concernés"));
body.push(tbl(
  ["Interface", "Rôle", "Réponse et règles"],
  [
    ["GET /api/artifacts", "Inventaire complet des versions", "Liste plate : identifiant, projet, nom, type, version, octets, date, épingle ; le client groupe et agrège"],
    ["DELETE /api/artifacts/{id}/v/{n}", "Suppression d'une version", "204 ; 409 si version épinglée ; 404 si absente ; renvoie un jeton d'annulation"],
    ["POST /api/artifacts/clean", "Nettoyage d'un projet", "{supprimés, octetsLibérés} ; idempotent ; renvoie un jeton d'annulation"],
    ["POST /api/artifacts/undo/{jeton}", "Annulation dans la fenêtre de 7 s", "204 ; 410 si la fenêtre est expirée"],
    ["GET /api/updates/check", "Vérification de mise à jour", "Réponse conditionnelle ETag / If-None-Match ; 304 si inchangé"],
    ["/api/ws (existant)", "État de l'agent (battements, version)", "Flux unique ; aucune requête supplémentaire pour la carte Agent"],
  ],
  [28, 26, 46]
));
body.push(p("La lecture est plate et le regroupement par projet relève du client : le serveur reste simple, l'interface riche — c'est le modèle validé en maquette, tenable à l'échelle locale (centaines de versions, pas des millions).", { after: 160 }));
body.push(h2("5.2 Définition canonique du « nettoyable »"));
body.push(p([
  { t: "C'est le point le plus risqué du portage. La définition fait foi : " },
  { t: "une version est nettoyable si elle n'est pas épinglée et si son numéro est strictement inférieur au plus grand numéro de version du même document", b: true },
  { t: ". La dernière version se calcule par document, par numéro de version — jamais par projet, jamais par date. Cette formule doit être écrite une fois, partagée entre l'agent et l'interface (constante commune ou calcul serveur), et testée des deux côtés sur les jeux limites : document à version unique (rien de nettoyable), document épinglé, document à dix versions. Un serveur qui implémenterait « tout sauf le dernier dépôt » ou « tout sauf la plus récente par date » produirait des écrans de confirmation mensongers." },
]));
body.push(h2("5.3 Honnêteté des compteurs"));
body.push(p("Si le stockage des artifacts est adressé par contenu (déduplication par hachis), additionner les tailles de versions surévalue le récupérable : des versions successives d'un même document partagent naturellement leurs blocs. Le volume réellement libérable doit alors être calculé par l'agent — taille des fichiers qui disparaîtraient, blocs partagés déduits — et non sommé naïvement côté interface. Tant que la question n'est pas tranchée (question ouverte n° 1), l'écran de confirmation présente un ordre de grandeur et le bilan après coup affiche le delta mesuré, seul chiffre exact."));
body.push(h2("5.4 Sécurité des opérations"));
body.push(p("Les noms de fichiers proviennent de conversations : aucune opération ne doit les traiter comme des chemins. La suppression s'adresse à un identifiant d'artifact et un numéro de version, jamais à un chemin de fichier — le point d'entrée ne doit pas devenir une passerelle de suppression arbitraire (traversée de répertoire). Les paramètres sont bornés et validés côté agent, le refus d'une version épinglée (409) est appliqué par le serveur même si l'interface désactive déjà le bouton, et les opérations sont confinées au répertoire des artifacts."));

/* — 6. Accessibilité — */
body.push(h1("6. Accessibilité, responsive et internationalisation"));
body.push(p("Chaque en-tête de groupe porte le rôle bouton, une référence aria-expanded sincère et une liaison aria-controls vers sa liste ; l'activation au clavier (Entrée, Espace) est équivalente au clic. Après un retour au repli déclenché par l'effacement des filtres, le focus reste sur l'élément qui l'a déclenché : aucune perte de repère. L'animation d'ouverture des groupes dure 150 à 200 millisecondes, réalisée par une transition sur les rangées de grille (sans mesure de hauteur en JavaScript) et désactivée lorsque le système demande la réduction des animations."));
body.push(p("La page reste utilisable à 375 pixels de largeur sans aucun défilement horizontal : compteurs globaux repliés en affichage compact, barre de recherche et filtres empilés, en-têtes de groupe sur deux lignes si nécessaire. Les tableaux éventuels vivent dans des conteneurs à défilement propre. Toutes les chaînes affichées sont centralisées (aucun texte codé dans les composants) ; dates, nombres et volumes sont formatés par les API d'internationalisation en français, les tailles transitant toujours en octets entre l'agent et l'interface."));

/* — 7. Matrice de recette — */
body.push(h1("7. Matrice de recette"));
body.push(p("Les comportements vérifiés en maquette deviennent tels quels des cas de recette ; s'y ajoutent les cas impossibles en maquette (rechargement, annulation, échecs réseau). La colonne « portée » indique le niveau minimal de vérification : interface (UI), contrat d'agent (API) ou bout en bout (E2E)."));
body.push(tcap("Tableau 5 — Cas de recette"));
body.push(tbl(
  ["N°", "Comportement attendu", "Portée"],
  [
    ["T01", "Ouverture de Stockage : groupes repliés, aria-expanded à faux, compteurs globaux exacts", "UI"],
    ["T02", "Clic sur un en-tête replié : seul ce groupe se déroule", "UI"],
    ["T03", "Groupe A ouvert, clic sur B : A refermé, B déroulé (exclusivité)", "UI"],
    ["T04", "Re-clic sur le groupe ouvert : retour au repli complet", "UI"],
    ["T05", "Recherche depuis l'état replié : groupes à résultats déroulés, autres masqués", "UI"],
    ["T06", "Pendant filtrage : repliage manuel ignoré ; compteur « N fichiers correspondent » affiché", "UI"],
    ["T07", "Fin de filtrage par le bouton : retour au repli complet", "UI"],
    ["T08", "Fin de filtrage par champ vidé manuellement : idem", "UI"],
    ["T09", "Fin de filtrage par retour au type « Tous » : idem", "UI"],
    ["T10", "Nettoyer sur groupe replié : aucun dépliage ; compteurs d'en-tête mis à jour en place", "E2E"],
    ["T11", "Suppression d'une version : le groupe reste ouvert ; compteurs recalculés", "E2E"],
    ["T12", "Version épinglée : corbeille désactivée (UI) et suppression refusée 409 (API)", "API"],
    ["T13", "Définition du nettoyable identique UI / agent sur les jeux limites (version unique, épinglé, dix versions)", "API"],
    ["T14", "Jeton d'annulation : restauration exacte dans la fenêtre de 7 s ; refus 410 après", "E2E"],
    ["T15", "Volumes « libérés » affichés : delta mesuré par l'agent, égal au réel", "E2E"],
    ["T16", "Échec de suppression d'un fichier : message ciblé, ligne conservée, compteurs non décrémentés", "E2E"],
    ["T17", "Ouverture de Paramètres : aucune requête d'artifacts émise", "E2E"],
    ["T18", "Retour sur Stockage : rechargement systématique de l'inventaire (pas de cache)", "E2E"],
    ["T19", "Rechargement après mutation : projet ouvert, recherche et tri préservés", "UI"],
    ["T20", "Carte Mise à jour : parcours des six états ; erreur récupérable ; verrouillage en « prêt »", "UI"],
    ["T21", "Carte Agent : reconnexion silencieuse sans clignotement ; délai max du redémarrage aboutissant en « erreur »", "UI"],
    ["T22", "Lien profond « ?projet= » : page ouverte sur le groupe désigné, déplié", "E2E"],
    ["T23", "Transverses : 375 px sans débordement ; navigation clavier complète ; animations réduites si demandé", "E2E"],
  ],
  [8, 74, 18]
));

/* — 8. Décisions et questions ouvertes — */
body.push(h1("8. Décisions arbitrées et questions ouvertes"));
body.push(h2("8.1 Décisions actées"));
body.push(p("Les arbitrages suivants sont acquis et ne rouvrent pas de débat en cours de développement ; ils figurent ici pour mémoire et traçabilité.", { keepNext: true }));
body.push(tcap("Tableau 6 — Décisions actées"));
body.push(tbl(
  ["Sujet", "Choix retenu", "Motif"],
  [
    ["Repli des groupes", "Repliés par défaut à l'ouverture", "Écran d'entrée compact ; en-têtes auto-suffisants"],
    ["Fin de filtrage", "Retour au repli complet, trois déclencheurs confondus", "Règle unique, prévisible, mémorisable"],
    ["Consultation manuelle", "Accordéon exclusif (un seul groupe ouvert)", "Décision produit du 19 novembre 2026"],
    ["Vue résultats", "Plusieurs groupes déroulés pendant un filtrage", "Afficher des résultats n'est pas naviguer"],
    ["État d'interface", "Non persisté d'une session à l'autre", "Sobriété ; réouverture sur le repli par défaut"],
    ["Nettoyage global", "Pas d'action « Tout nettoyer » en v1", "L'action la plus destructive reste au niveau projet"],
    ["Documents épinglés", "Non supprimables, côté interface et côté agent (409)", "L'épingle appartient à la conversation"],
    ["Veille de mise à jour", "Aucune en v1 (ouverture + demande)", "Pas de boucle résidante sur page affichée"],
  ],
  [24, 38, 38]
));
body.push(h2("8.2 Questions ouvertes"));
body.push(p("Quatre points restent à trancher ; chacun porte une recommandation pour ne pas bloquer le démarrage du développement.", { keepNext: true }));
body.push(tcap("Tableau 7 — Questions ouvertes et recommandations"));
body.push(tbl(
  ["Sujet", "Recommandation", "Arbitre"],
  [
    ["Stockage dédupliqué ?", "Volume récupérable calculé par l'agent, blocs partagés déduits", "Architecture"],
    ["Disposition des deux cartes", "Maquette rapide comparant pleine largeur et deux colonnes", "Produit · Design"],
    ["Projets vides", "Conserver les en-têtes visibles en v1 ; masquage à évaluer à l'usage", "Produit"],
    ["Seuil de rendu différé (500 versions)", "Conserver, ajuster au premier retour terrain", "Développement"],
  ],
  [30, 46, 24]
));
body.push(p("Une fois ces quatre points tranchés, le chemin est dégagé : maquette rapide de la page Paramètres allégée, puis développement dans l'ordre cartes — page Stockage — contrats d'agent, la matrice du chapitre 7 servant de critère d'acceptation."));

/* — Annexe A — */
body.push(h1("Annexe A — Jeu de démonstration de la maquette"));
body.push(p("Le tableau ci-dessous agrège le jeu de démonstration de la maquette selon le même moteur de règles. Ces valeurs ont servi de référence pendant la revue : 79 versions et 150,1 Mo au total, dont 28,1 Mo récupérables pour « Refonte site vitrine » — toute implémentation branchée sur ce jeu doit reproduire ces compteurs à l'identique.", { keepNext: true }));
body.push(tcap("Tableau 8 — Agrégats du jeu de démonstration (valeurs de référence)"));
body.push(tbl(
  ["Projet", "Versions", "Occupation", "Récupérables"],
  [
    ...AGG.map(a => [a.name, String(a.rows), fr(a.total) + " Mo", fr(a.clean) + " Mo"]),
    [{ text: "Total", bold: true }, { text: String(TOT.rows), bold: true }, { text: fr(TOT.total) + " Mo", bold: true }, { text: fr(TOT.clean) + " Mo", bold: true }],
  ],
  [40, 18, 21, 21]
));
body.push(p("Le projet « Hors projet » reçoit les documents générés hors conversation rattachée et suit les mêmes règles que les projets nommés. Les documents épinglés (rapport de veille semaine 46, prévisionnel 2027, plan de charge) illustrent la protection : leur dernière version n'est jamais nettoyable depuis la page Stockage."));

/* ============ Assemblage ============ */
const pgSize = { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: F_BODY, size: 24, color: PAL.body },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: F_HEAD, size: 32, bold: true, color: PAL.primary },
        paragraph: { spacing: { before: 360, after: 160, line: 312 } },
      },
      heading2: {
        run: { font: F_HEAD, size: 30, bold: true, color: PAL.primary },
        paragraph: { spacing: { before: 260, after: 120, line: 312 } },
      },
    },
  },
  numbering: {
    config: [{
      reference: "comportements",
      levels: [{
        level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      }],
    }],
  },
  sections: [
    { /* Section 1 — couverture, marge 0, aucun pied de page */
      properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: buildCoverR1({
        title: "Volet Système et page Stockage",
        subtitle: "Spécification d'implémentation validée en maquette — Hermes 0.2.1 vers 0.3.0",
        englishLabel: "DOCUMENT D'IMPLEMENTATION",
        metaLines: [
          "Périmètre : Paramètres · Système et page Stockage",
          "Référence : maquette validée — comportements vérifiés",
          "Base : interface Hermes 0.2.1 · cible 0.3.0",
          "19 novembre 2026",
        ],
        footerLeft: "Hermes — Interface",
        footerRight: "Novembre 2026",
        palette: { bg: PAL.bg, accent: PAL.accent, ...PAL.cover },
      }),
    },
    { /* Section 2 — sommaire, sans numérotation affichée */
      properties: { type: SectionType.NEXT_PAGE, page: { size: pgSize, margin: pgMargin } },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER, spacing: { before: 480, after: 360 },
          children: [new TextRun({ text: "Sommaire", bold: true, size: 32, font: F_HEAD, color: PAL.primary })],
        }),
        new TableOfContents("Sommaire", { hyperlink: true, headingStyleRange: "1-2" }),
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({
            text: "Nota : ce sommaire est généré par champ. Après modification du document, cliquez droit sur le sommaire puis « Mettre à jour les champs » pour actualiser la pagination.",
            italics: true, size: 18, color: "888888", font: F_BODY,
          })],
        }),
      ],
    },
    { /* Section 3 — corps, pagination arabe repartant à 1 */
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "Hermes — Spécification d'implémentation · Système et Stockage", size: 18, color: "808080", font: F_BODY })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080", font: F_BODY })],
          })],
        }),
      },
      children: body,
    },
  ],
});

Packer.toBuffer(doc).then(buf => {
  const out = "/home/z/my-project/download/hermes-specification-systeme-stockage.docx";
  fs.writeFileSync(out, buf);
  console.log("Écrit :", out, "(" + buf.length + " octets)");
});
