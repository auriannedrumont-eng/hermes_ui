# AGENTS.md — Règles de contexte pour les agents LLM (Claude Code, Cursor, etc.)

> Ce fichier dit à un agent **comment consommer ce repo sans exploser son contexte**
> (~66 000 lignes ≈ 800k tokens si on tout lit — inutile et nocif).

## Périmètre de lecture par défaut

| Dossier | Par défaut | Pourquoi |
| --- | --- | --- |
| `DEMARRAGE.md`, `docs/ETAT.md` | **Toujours en ouverture** | Carte + conventions + état, ~1 500 mots |
| `src/`, `mini-services/` | **À la demande** — chercher d'abord (`grep`, liste de fichiers), puis ouvrir uniquement les fichiers de la tâche | Une tâche touche 5-15 fichiers, pas 350 |
| `scripts/` | Non | ~90 scripts de test/QA manuels ; à ouvrir seulement si la tâche les concerne |
| `design/` | Non | Maquettes HTML lourdes ; seule `maquette-parametres-v5.html` fait foi — la consulter en ciblant le panneau voulu, jamais en entier |
| `desktop/`, `examples/`, `public/` | Non | Lanceur Windows, exemples, icônes |
| `bun.lock`, `*.lock`, `db/`, `download/`, `upload/` | Jamais | Aucune valeur pour le raisonnement |

## Règles

1. **Chercher avant de lire** : localiser par nom de fichier / `grep` sur les
   identifiants, puis n'ouvrir que les fichiers concernés.
2. **FORK.md** : ne pas le charger en entier. Les conventions utiles sont résumées
   dans `DEMARRAGE.md` ; ouvrir FORK.md seulement sur un point précis (§5
   conventions, §6 registre, §9 journal — et dans le journal, les 10 dernières
   entrées suffisent).
3. **Session fraîche par lot de travail** : ne pas empiler les tâches dans un même
   contexte ; compacter/résumer entre deux lots.
4. **Pas de collage brut** de logs, de sortie de terminal ou de dumps complets —
   un extrait plus le chemin du fichier.
5. **Respecter les conventions** résumées dans `DEMARRAGE.md` (nouvelles
   fonctionnalités = nouveaux fichiers, migrations SQLite additives, registre
   `src/lib/settings.ts` pour tout réglage, français pour l'UI et la doc, entrée
   datée au journal FORK.md §9 pour toute décision structurante).
6. **Tests** : les scripts `scripts/test-*-flow.ts` sont la QA de référence —
   lancer ceux du périmètre touché (`bun run scripts/test-…ts`), ne pas tout
   rejouer à chaque fois.
7. **Livrables documents en Markdown uniquement** (demande de l'utilisatrice,
   2026-11-21) : quand elle demande un document — audit, plan, review, rapport,
   synthèse — livrer **un fichier `.md`** (dans le repo sous `docs/`, ou en
   pièce jointe texte). **Jamais** de `.docx`, `.pdf` ou autre format binaire ;
   et **pas d'export `.png` pour les maquettes** non plus (les maquettes restent
   du HTML éditable dans `design/`).
