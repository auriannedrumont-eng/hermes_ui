# llm-review/ — Bundle de code pour review par un LLM

Ce dossier contient l'interface (UI) empaquetée pour être envoyée à un LLM
en vue d'une revue de code, sans embarquer le bruit du repo
(`bun.lock`, `scripts/`, `design/`, `desktop/`, `examples/`, `docs/` audits).

## Contenu

| Fichier | Usage | Périmètre |
| --- | --- | --- |
| `bundle_chat.txt` | Passe 1 — l'interface de chat elle-même | `components/chat`, `components/shared`, `app/`, hooks + lib associés, contrat gateway, design tokens |
| `bundle_settings.txt` | Passe 2 — les panneaux de paramètres | `components/settings` + hooks/lib associés, design tokens |
| `bundle_full.txt` | Gros contexte — tout le périmètre UI | union des deux passes |
| `review_prompt.md` | Prompt système à coller avant le code | contexte projet, attendus de la review, format de sortie |
| `hermes_ui_review.zip` | Fichiers séparés vérifiables | même périmètre + `MANIFEST.txt` |

## Mise à jour — IMPORTANT

**À chaque push sur `main`, l'agent LLM régénère le bundle et le pousse avec
les dernières modifications de l'interface.** Le bundle reflète donc toujours
l'état du `src/` au dernier commit ; il n'est jamais en retard sur le code
qu'il est censé faire relire. La régénération se fait avec le script
`scripts/build_review_bundles.py` (côté agent/bac à sable), les chiffres de
tokens du prompt sont recalculés au tokeniseur `tiktoken cl100k_base`, et le
commit d'origine est inscrit dans l'en-tête de chaque bundle.

## Conventions du repo utiles au relecteur

- Français pour l'UI et la doc, identifiants de code en anglais.
- Registre `src/lib/settings.ts` : tout réglage s'y déclare (R5).
- Nouvelles fonctionnalités = nouveaux fichiers ; éditions minimales de
  l'existant (R1, R4).
