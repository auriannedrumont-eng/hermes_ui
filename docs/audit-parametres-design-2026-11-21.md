# Audit design — Page « Paramètres » (hermes_ui)

**Date** : 21 novembre 2026 · **Dépôt** : `auriannedrumont-eng/hermes_ui` @ `e51adcb`
**Référence design** : `design/maquette-parametres-v5.html` (la maquette fait foi, cf. `AGENTS.md`) + tokens `src/app/globals.css` (oklch, thèmes clair/sombre).

**Méthode** :
1. extraction des specs de la maquette v5 (rail, padding, contrôles, états) et comparaison ligne à ligne avec l'implémentation ;
2. exécution réelle (`bun dev`, `localhost:3000`) : les 11 sections parcourues en **thème sombre ET clair** (desktop 1280 px) + mobile 375 px ;
3. **ratios de contraste WCAG calculés par script** (`scripts/contraste_hermes.py`, conversion oklch → sRGB, compositing alpha comme le navigateur) sur les tokens exacts des deux thèmes — aucune estimation à l'œil ;
4. relecture CSS/Tailwind des composants du volet (classes corrompues, tokens contournés).

---

## 1. Synthèse

La structure générale du volet est **fidèle à la maquette v5** : rail 208 px / panneau 860 px, padding horizontal 34 px, padding bas 70 px, titres de section 19 px/700, sous-titres 12,5 px max-520 px, lignes de réglage à séparateurs avec libellé 14 px + description 12,5 px, segmentés actifs `bg-card + hermes-text`, états vides en bordure pointillée, pastilles-point comme seule langue d'état. La refonte shadcn n'a pas détruit le langage visuel.

Mais il y a **deux vraies blessures de design**, toutes deux mesurées :

- **Le haut du volet est comprimé** : la maquette prévoit une bande d'en-tête de 52 px + 26 px de marge avant le titre ; l'implémentation livre 0 px de marge haute — le titre colle au bord supérieur et le bouton ✕ flotte sur le contenu (chevauchement réel du rail sur mobile).
- **La ligne « dim » (`opacity-55`) échoue au contraste dans les deux thèmes** (2,27 et 2,77 au lieu de 4,5) et les boutons primaires oranges échouent en thème clair (3,64). Le contrôle le plus visible du volet — le switch — a une piste quasi invisible en thème clair (1,29).

| Sévérité | Nombre | Phares |
|---|---|---|
| Majeur | 6 | Padding haut 0 px vs 26 px + ✕ flottant · ligne dim < 3:1 (2 thèmes) · boutons primaires 3,64 en clair · état actif du rail sans l'accent hermès (token `--hermes-soft` disparu) · classes Tailwind corrompues ×2 fichiers · mobile : écrasement des lignes + ✕ sur le rail |
| Mineur | 10 | Logo d'en-tête du rail réduit et dégradé · filet du pied de rail manquant · slider 12–34 vs 12–30 · sémantique d'état incohérente (orange/gris pour des états « en cours ») · pistes de contrôles < 3:1 · divers |

---

## 2. Écarts de conformité vs maquette v5 (la maquette fait foi)

### 2.1 Majeur — Le haut du volet est comprimé, le ✕ flotte sur le contenu
- Maquette : `.main-head` = bande de **52 px** avec filet bas, bouton ✕ borné (30×32 px, bordure, survol destructif) ; puis `.main-scroll` avec **26 px de marge haute** avant le titre.
- Implémentation : `settings-panel.tsx:391,395` — le conteneur passe `pt-4 → min-[1100px]:pt-0` et le scroll `pt-2 → min-[1100px]:pt-0` : **0 px de marge haute sur desktop** (constaté : le titre « Interface » colle au bord supérieur du volet, à ~8 px). Le ✕ est celui du Sheet shadcn (`sheet.tsx:75`, `absolute top-4 right-4`, fantôme sans bordure), posé **par-dessus** la zone de contenu.
- Conséquences : la respiration prévue par la maquette a disparu ; à 1100-1200 px de large le ✕ frôle la fin des sous-titres longs ; **sur mobile il chevauche le rail horizontal** (constaté : ✕ superposé au libellé « Modes de chat » à 375 px, cf. §5).

### 2.2 Majeur — L'état actif du rail a perdu l'accent hermès (token `--hermes-soft` disparu)
- Maquette : `.rn.on { background: var(--hermes-soft); color: var(--hermes-text) }` — l'entrée active est **teintée hermès**, c'est la signature de la maquette.
- Implémentation : `settings-panel.tsx:359` — `active && "bg-muted font-semibold text-foreground"` : l'entrée active est un simple gris. Et le token **`--hermes-soft` n'existe plus nulle part** (absent de `globals.css`, aucune occurrence dans `src/`) : la chaîne design → code est rompue, plus personne ne peut rétablir l'état de la maquette sans recréer le token.
- Constat visuel : rail actif gris dans les deux thèmes, aucune différenciation de marque entre l'entrée active et un simple survol.

### 2.3 Mineur — En-tête du rail dégradé
- Maquette : logo **26 px, carré plein `--hermes`** avec icône `--hermes-foreground`, titre **14 px/700**.
- Implémentation (`settings-panel.tsx:341-344`) : logo **22 px fantôme** (`bg-hermes/10 text-hermes-text`), titre **12,5 px/600**. Le pavage de marque de la maquette est affaibli en pastille pâle (visiblement plus petit et plus pâle que la maquette, constaté).

### 2.4 Mineur — Pied de rail sans filet
- Maquette : `.rail-foot { border-top: 1px solid var(--border); padding: 12px 10px 2px }` — la version du service est isolée par un filet.
- Implémentation (`settings-panel.tsx:385`) : `mt-auto px-2 pt-2` **sans border-top** — la ligne « service vX » flotte sans séparation (invisible hors ligne de surcroît, cf. rapport fiabilité §4).

### 2.5 Mineur — Slider « Largeur de la sidebar » : bornes divergentes
- Maquette ligne 448 : `min=12 max=30` ; implémentation `interface-section.tsx:129-130` : `min={12} max={34}`. La valeur affichée « 19 % » et le style de valeur (`hermes-text`, aligné à droite) sont conformes — seules les bornes ont divergé silencieusement.

### 2.6 Conformités vérifiées (à ne pas casser)
Rail 208 px ✓ · panneau 860 px ✓ · `px-[34px]`/`pb-[70px]` desktop ✓ · h1 19 px/700 ✓ · sous-titres 12,5 px/520 px ✓ · lignes : gap 28 px, séparateur bas sauf dernière ✓ · segmenté actif `bg-card + text-hermes-text + shadow` ✓ (`segmented.tsx:58`) · slider valeur orange tabulaire ✓ · états vides pointillés (2 occurrences `dashed` dans la maquette aussi) ✓ · pastilles-point 7-8 px ✓ · dimensions du switch 32×18, pouce 16 px ✓ (`switch.tsx:16-24`).

---

## 3. Contrastes WCAG — calculés sur les tokens exacts

Script : `scripts/contraste_hermes.py` (oklch → sRGB linéaire, luminance relative, compositing gamma comme le navigateur). Seuils : texte 4,5:1 ; composants d'interface 3:1 (WCAG 1.4.11).

### 3.1 Majeur — Ligne « dim » : échec dans les deux thèmes
`opacity-55` appliqué à des lignes de réglage entières (« Dossiers repliés » quand 0 projet) :

| Cas | Ratio | Requis | Verdict |
|---|---|---|---|
| muted-foreground à 55 % sur background (clair) | **2,27** | 4,5 | ✗ |
| muted-foreground à 55 % sur card (sombre) | **2,77** | 4,5 | ✗ |

Un texte de 12,5 px à 2,3-2,8:1 est illisible en basse vision ou plein soleil ; en thème clair la ligne disparaît quasiment (constaté : la ligne « Dossiers repliés » est évanescente sur la capture claire). La maquette ne prévoit **aucun état « dim »** pour une ligne de réglage — c'est une invention d'implémentation qui, en plus d'échouer au contraste, brouille le langage d'états (elle ressemble à un contrôle cassé/désactivé sans l'être).

### 3.2 Majeur — Boutons primaires : échec AA en thème clair
`--hermes-foreground` (blanc cassé) sur `--hermes` (orange 0.63) :

| Thème | Ratio | Verdict |
|---|---|---|
| Clair | **3,64** | ✗ (4,5 requis pour du texte 12,5-14 px) |
| Sombre | 7,42 | ✓ |

Tous les boutons pleins oranges du volet (« Ajouter », « Enregistrer · prochain tour », « Ouvrir le navigateur », « Réessayer »…) portent un texte sous le seuil AA en thème clair. C'est l'échec le plus répandu du volet côté clair.

### 3.3 Majeur — Piste du switch OFF invisible en thème clair
Piste `bg-input` = `oklch(0.915 0.004 75)` sur card blanc :

| Cas | Ratio | Requis (UI 1.4.11) | Verdict |
|---|---|---|---|
| Piste switch OFF, clair | **1,29** | 3,0 | ✗ |
| Piste switch OFF, sombre (blanc 15 % sur card) | **1,35** | 3,0 | ✗ |

En clair, le switch OFF se réduit à un cercle blanc posé sur du blanc (constaté : quasi invisible sur « Dossiers repliés » ; seul `shadow-xs` le trahit). La maquette prévoit `border: 1px solid` explicite et une piste `var(--border)` **avec pouce contrasté** ; l'implémentation shadcn a `border-transparent`. Même cause pour les bordures d'inputs/selects (`--input` blanc 10-15 % dans les deux thèmes : ~1,3-1,5:1) — la frontière des champs de saisie ne satisfait pas 1.4.11 non plus.

### 3.4 Conformités vérifiées
muted-foreground 5,57/6,01 ✓ · hermes-text sur background 5,03/7,06 ✓ · chip `hermes/10` 4,52/5,47 ✓ (juste, à surveiller) · pastilles warning/success > 5:1 ✓.

---

## 4. Erreurs CSS/Tailwind brutes

| # | Sévérité | Défaut | Preuve |
|---|---|---|---|
| 1 | Majeur | **Classe Tailwind corrompue** (édition écrasée) : `max-[560px]:stretch` (utilitaire inexistant — voulu `items-stretch` ?), `max-[560px]:*:` (variante inachevée, rien après `*:`), et retour à la ligne à l'intérieur de la chaîne. Copiée à l'identique dans deux fichiers → l'intention responsive < 560 px (boutons pleine largeur centrés) est silencieusement perdue. | `system-section.tsx:375-376`, `agent-motor-card.tsx:331-332` |
| 2 | Mineur | Aucune couleur hex codée en dur dans `settings/` ✓ (tout passe par les tokens) — bon point vérifié. | grep `#[0-9a-f]` : 0 occurrence |
| 3 | Mineur | Imports morts et `SettingRow` dupliqué en deux exemplaires dont un jamais rendu (cf. rapport fiabilité §3.11) — côté design, cela signifie qu'il **n'existe pas de source unique** pour la ligne de réglage : corriger le responsive mobile (§5) demandera de toucher chaque section séparément. | `settings-panel.tsx:171-200`, `interface-section.tsx:37-66` |

---

## 5. Mobile (375 px) — rappel des défauts design (déjà consignés dans l'audit fiabilité)

1. **Écrasement des lignes de réglage** : `SettingRow` met le texte en `flex-1 min-w-0` face à un contrôle `flex-none` ; à 375 px la description se comprime en colonne d'un mot par ligne (« Le modèle des nouvelles conversations — » sur 8 lignes) pendant que le Select garde ~250 px. Constaté sur Interface, Modèles, Modes. La maquette n'a pas de variante mobile pour `.row` (`.rc` devrait passer sous le texte, pas à côté écrasé).
2. **✕ superposé au rail horizontal** (cf. §2.1) — collision directe avec le dernier libellé visible.
3. Le rail défilant lui-même fonctionne (flex-row + overflow-x-auto ✓), mais aucun des 11 libellés n'est abrégé : la moitié du rail est hors écran sans indice de scroll (pas de fondu/ombre de débordement).

---

## 6. Sémantique des états — incohérences constatées

| # | Défaut | Preuve |
|---|---|---|
| 1 | **Deux états « en cours » de couleurs différentes** : « Vérification… » (mise à jour app) en **orange warning**, « Reconnexion en cours » (moteur) en **gris muted** — la même famille sémantique (en attente) porte deux langues de couleur. La maquette définit `warn` pour un problème, `off` pour le neutre : les deux devraient être neutres, ou toutes deux warning. | captures sombre/clair section Système ; `system-section.tsx` |
| 2 | « ● vide » (mémoire) en **orange warning** : un état vide est neutre (`.off` dans la maquette), pas un avertissement — l'orange « vide » alarma à tort au premier ouvert. | `memory-card.tsx` |
| 3 | La pastille-point (7 px) est la « seule langue d'état » (v2.6) mais les textes de statut gardent des graisses/couleurs libres : « sans clé » orange 11px/700 vs « inactives » gris 11px/600 vs « arrêté » gris — trois poids pour une même famille. | captures Outils / Hermes / Chats web |

---

## 7. Plan de correction design (priorisé)

1. **Restaurer le haut du volet** : rétablir 26 px de marge haute desktop (`min-[1100px]:pt-[26px]`) et donner au ✕ un ancrage sûr — soit la bande d'en-tête 52 px de la maquette, soit à minima un padding-right réservé au rail mobile sous le ✕.
2. **Réparer la ligne dim** : supprimer `opacity-55` (état jamais prévu par la maquette) ou au minimum monter à `opacity-70` + texte explicatif ; dans tous les cas ne jamais l'appliquer à une description 12,5 px (2,3:1 mesuré).
3. **Recréer le token `--hermes-soft`** (ex. `oklch(0.63 0.17 42 / 12%)`) et remettre l'état actif du rail en `bg-[--hermes-soft] text-hermes-text` conformément à la maquette ; réajuster logo d'en-tête (26 px plein) et titre (14 px).
4. **Contrastes** : thème clair — assombrir `--hermes` côté boutons ou passer les labels primaires sur `--hermes-strong` (0.55) qui donne > 4,5 ; donner une piste OFF visible au switch (bordure ou piste `--muted-foreground/40`) et une bordure lisible aux inputs.
5. **Corriger les deux classes Tailwind corrompues** (retirer `max-[560px]:stretch` et `max-[560px]:*:`, compléter l'intention responsive).
6. **Uniformiser la sémantique d'état** : gris pour « en cours »/« vide », orange uniquement pour « à compléter/problème ».
7. **Mobile** : passer `.row`-like en pile (texte puis contrôle) sous ~430 px et traiter `SettingRow` comme un composant unique (voir rapport fiabilité, §3.11 code mort).

---

*Mesures de contraste reproductibles : `python3 scripts/contraste_hermes.py` (script persisté dans le workspace d'audit). Les captures citées ont été prises en thèmes clair et sombre sur `localhost:3000` avec le service mini-chat arrêté ; aucun défaut listé n'en dépend.*
