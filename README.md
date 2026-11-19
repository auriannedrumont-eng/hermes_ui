# hermes_ui

Interface web de chat pour l'agent Hermes (Nous Research), avec rangement des
conversations par projets et artefacts versionnés.

> Fork maintenu par auriannedrumont-eng.
> **[DEMARRAGE.md](DEMARRAGE.md)** : doc d'entrée pour toute session (carte,
> conventions, règles de contexte LLM). Synthèse de l'état : **[docs/ETAT.md](docs/ETAT.md)**.
> Documentation technique complète : **[FORK.md](FORK.md)** (à consulter par
> section — architecture, conventions, feuille de route, passation).

## Deux modes

- **Gateway** (défaut automatique `ws://127.0.0.1:9120/api/ws`) : connexion à un
  agent Hermes réel via le protocole `api_turn_v1` — lancer l'agent suffit,
  rien à saisir (variables `HERMES_GATEWAY_URL` et `HERMES_GATEWAY_TOKEN`).
- **Moteur local** : pool de clés fournisseurs (Paramètres → Fournisseurs &
  clés) — vrais modèles, réelles réponses. Sans agent ni clé, l'erreur est
  claire : « Agent Hermes non détecté… » (le mode Démo simulé a été retiré,
  cf. FORK.md §40).

## Démarrage rapide

```bash
# Frontend Next.js (port 3000)
bun install
bun dev

# Mini-service socket.io (port 3003) — indispensable au chat
cd mini-services/hermes-chat
bun install
bun run dev
```

Le rendu des artefacts HTML passe par un pipeline `chrome-headless-shell`
(voir le `README.md` du mini-service). Caddy (facultatif) sert de reverse
proxy : port 81 vers localhost:3000 (cf. `Caddyfile`).

## Fonctionnalités du fork

- Conversations rangées **par projet** : groupes repliables, glisser-déposer,
  largeur de sidebar fluide, section « Sans projet ».
- **Artefacts versionnés** dans les conversations : rendu code / Markdown /
  CSV / JSON / SVG / PDF, captures PNG et PDF vectoriel, diff entre versions.
- **Page de paramètres** (phase 1) : sheet 460 px glissant depuis la droite —
  réglages client des deux registres, tooltips « ? », application immédiate
  sans rechargement (bus `hermes-ui:settings-changed`).
- Registre de réglages séparé `hermes.*` (amont) / `fork.*` (fork).

Détails, tests manuels et conventions : voir **[FORK.md](FORK.md)**.
