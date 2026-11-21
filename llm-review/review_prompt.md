# Prompt de review — hermes_ui

Vous allez reviewer l'interface web de chat Hermes (fork auriannedrumont-eng).
Code : voir bundle joint (fichiers séparés par « FILE: <chemin> »).

## Contexte du projet (l'essentiel de DEMARRAGE.md)
- Fork d'une UI de chat pour l'agent Hermes (Nous Research) : Next.js 16 +
  React 19 + Tailwind 4 + shadcn/ui, mini-service socket.io (port 3003).
- Deux modes : Gateway (agent réel) / Local (pool de clés fournisseurs).
- Principes : la conversation est le chef d'orchestre ; les artefacts
  (code, md, csv, json, svg, pdf, png) sont des objets de première classe
  versionés dans la conversation ; conversations groupées par projets.
- Conventions : français pour l'UI et la doc ; registre src/lib/settings.ts
  pour tout réglage ; nouvelles fonctionnalités = nouveaux fichiers ;
  migrations SQLite additives ; entrée au journal FORK.md §9 pour décision
  structurante.

## Ce que je veux dans la review
1. **Architecture** : hiérarchie composants/hooks/lib, séparation des
   responsabilités, couplage entre chat et settings, taille et cohérence des
   fichiers (ex. use-hermes-chat.ts 62 Ko, modes-section.tsx 40 Ko —
   faut-il découper ?).
2. **État & streaming** : gestion du flux socket.io (stream-store,
   use-chat-stream), reprise après déconnexion, race conditions possibles.
3. **Accessibilité & UX** : navigation clavier, aria, focus, contraste
   (la marque terracotta a un contraste AA 5,05:1 à préserver).
4. **Conventions** : respect du registre settings.ts, du français UI,
   cohérence nommage fichiers/dossiers.
5. **Risques & dette** : composants trop gros, duplication, code mort,
   hooks avec dépendances manquantes, effets de bord.

## Format attendu
- Par thème (architecture / état / a11y / conventions / dette), avec
  fichier:ligne pour chaque point, sévérité (bloquant / majeur / mineur /
  suggestion), et une recommandation d'action concrète.
- Terminez par le top 5 des actions prioritaires.

## Chiffres du bundle (commit 4e4d656ca)
- bundle_full.txt : 254,829 tokens — interface complète.
- Contexte limité : bundle_chat.txt (171,941 tok) puis
  bundle_settings.txt (105,958 tok) en deux passes.
- Tokeniseur d'estimation : tiktoken cl100k_base (comptage réel).
