#!/usr/bin/env python3
"""Vague 4 — cible C : les validations d'URL/clés de
registerProvidersHandlers (CC 114) et registerExtensionsHandlers (CC 95)
quittent les corps des handlers pour providers-validate.ts (module pur,
testé par Vitest). Règle « https requis, http strictement local » — quatre
copies dans le dépôt (resolveKnownProvider, providers:add, providers:set-base,
testProviderKey) — vit désormais dans UNE fonction testée. Messages
d'erreur et bornes VERBATIM ; aucun changement du protocole socket."""

PE = "/home/z/my-project/hermes_ui/mini-services/hermes-chat/handlers/providers-extensions.ts"
PR = "/home/z/my-project/hermes_ui/mini-services/hermes-chat/providers.ts"

files = {}
for path in (PE, PR):
    with open(path) as f:
        files[path] = f.read().split("\n")

def L(path, n):
    return files[path][n - 1]

checks = [
    # providers-extensions.ts
    (PE, 6,   'import { ctx } from "./context";'),
    (PE, 164, "    let baseUrl ="),
    (PE, 165, '      "known" in resolved'),
    (PE, 166, "        ? (resolved.known.defaultBaseUrl ?? null)"),
    (PE, 167, "        : resolved.custom.baseUrl;"),
    (PE, 173, '    const explicit = (payload?.baseUrl ?? "").trim();'),
    (PE, 174, "    if (explicit && /^https?:\\/\\//i.test(explicit)) {"),
    (PE, 179, '        if (u.protocol === "https:" || (u.protocol === "http:" && local)) {'),
    (PE, 180, '          baseUrl = explicit.replace(/\\/+$/, "");'),
    (PE, 190, "    const canonicalDefault ="),
    (PE, 191, '      "known" in resolved ? (resolved.known.defaultBaseUrl ?? null) : null;'),
    (PE, 192, "    if ("),
    (PE, 196, "    ) {"),
    (PE, 197, "      baseUrl = null;"),
    (PE, 198, "    }"),
    (PE, 225, '    const ok = ["fill_first", "round_robin", "least_used"];'),
    (PE, 226, "    if (!id || !strategy || !ok.includes(strategy)) {"),
    (PE, 265, "    if (!/^https?:\\/\\//i.test(raw)) {"),
    (PE, 283, '    const updated = ctx.store.setProviderBaseUrl(id, raw.replace(/\\/+$/, ""));'),
    (PE, 305, "    if (secret.length < 8) {"),
    (PE, 308, "    }"),
    (PE, 528, "    if (/^https?:\\/\\//i.test(raw) || /^(npx|uvx|bunx|node|python3?|docker)\\b/i.test(raw)) {"),
    # providers.ts
    (PR, 19, '} from "./types";'),
    (PR, 320, "      const local ="),
    (PR, 321, '        u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";'),
    (PR, 322, '      if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;'),
    (PR, 662, "      const isLocalHost ="),
    (PR, 663, '        u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";'),
    (PR, 664, '      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost)) {'),
]
bad = [(p, n) for p, n, want in checks if L(p, n) != want]
if bad:
    raise SystemExit(
        "ANCHOR MISMATCH at "
        + "; ".join(f"{p.split('/')[-1]}:{n}={L(p, n)!r}" for p, n in bad[:8])
    )

def replace(path, a, b, new_lines):
    files[path][a - 1 : b] = new_lines

# ── providers.ts (du bas vers le haut) ────────────────────────────────────

# testProviderKey : la garde commune (commentaire d'origine conservé au-dessus)
replace(PR, 662, 664, [
    "      if (!isAllowedProviderUrl(u)) {",
])

# resolveKnownProvider : la même garde (commentaires « Lot audit passe 2 »
# 315-319 conservés au-dessus, note vague 4 ajoutée)
replace(PR, 320, 322, [
    "      // Vague 4 : la règle vit dans providers-validate.ts (une seule vérité).",
    "      if (!isAllowedProviderUrl(u)) return null;",
])

# import du module de validations
replace(PR, 19, 19, [
    '  } from "./types";',
    'import { isAllowedProviderUrl } from "./providers-validate";',
])

# ── providers-extensions.ts (du bas vers le haut) ─────────────────────────

# registry:install : classification adresse https / commande de lancement
replace(PE, 528, 528, [
    "    // Vague 4 : classification adresse https / commande de lancement dans",
    "    // providers-validate.ts (testée par Vitest) — regex verbatim.",
    "    if (isMcpLaunchSource(raw)) {",
])

# providers:add-key : longueur minimale du secret
replace(PE, 305, 308, [
    "    // Vague 4 : la borne vit dans providers-validate.ts (testée) —",
    "    // message d'erreur verbatim.",
    "    const secretError = checkKeySecret(secret);",
    "    if (secretError) {",
    '      if (typeof cb === "function") cb({ error: secretError });',
    "      return;",
    "    }",
])

# providers:set-base : les trois refus verbatim deviennent un appel au helper
replace(PE, 265, 283, [
    "    // Vague 4 : la validation https / http-local vit dans",
    "    // providers-validate.ts (une seule vérité, testée) — les trois refus",
    "    // gardent leurs messages d'origine, la valeur stockée aussi (slashes",
    "    // finaux supprimés).",
    "    const check = checkProviderBaseUrl(raw);",
    "    if (!check.ok) {",
    '      if (typeof cb === "function") cb({ error: check.error });',
    "      return;",
    "    }",
    "    const updated = ctx.store.setProviderBaseUrl(id, check.url);",
])

# providers:set-strategy : la liste des stratégies vivant dans le helper
replace(PE, 225, 226, [
    "    // Vague 4 : la liste des stratégies vit dans providers-validate.ts (testée).",
    "    if (!id || !strategy || !isProviderStrategy(strategy)) {",
])


# providers:add : override silencieux + nullification canonique
replace(PE, 164, 198, [
    "    let baseUrl =",
    '      "known" in resolved',
    "        ? (resolved.known.defaultBaseUrl ?? null)",
    "        : resolved.custom.baseUrl;",
    "    // Adresse explicite fournie : elle gagne sur l'adresse canonique",
    "    // (surcharger un fournisseur connu — passerelle d'entreprise, tests,",
    "    // bascule z.ai vers la surface coding). v2.5 : une adresse avec chemin",
    "    // est la base COMPLÈTE ; une origine seule remplace l'hôte du canon.",
    "    // https requis, ou http strictement local (même règle que le test de clé).",
    "    // Vague 4 : la règle vit dans providers-validate.ts (une seule vérité,",
    "    // testée) — l'override reste SILENCIEUX (invalide → canonique conservée).",
    '    const explicit = (payload?.baseUrl ?? "").trim();',
    "    baseUrl = resolveExplicitBaseUrl(explicit, baseUrl);",
    "    // Champ d'adresse non modifié (pré-rempli par le sélecteur à l'identique",
    "    // du canon) : stocker null — l'adresse canonique reste la référence et",
    "    // les surfaces de TEST propres à certains fournisseurs (opencode) sont",
    "    // préservées.",
    "    const canonicalDefault =",
    '      "known" in resolved ? (resolved.known.defaultBaseUrl ?? null) : null;',
    "    if (sameAsCanonicalBaseUrl(baseUrl, canonicalDefault)) {",
    "      baseUrl = null;",
    "    }",
])


# import du module de validations
replace(PE, 6, 6, [
    'import { ctx } from "./context";',
    'import {',
    "  checkKeySecret,",
    "  checkProviderBaseUrl,",
    "  isMcpLaunchSource,",
    "  isProviderStrategy,",
    "  resolveExplicitBaseUrl,",
    "  sameAsCanonicalBaseUrl,",
    '} from "../providers-validate";',
])

for path in (PE, PR):
    with open(path, "w") as f:
        f.write("\n".join(files[path]))

print(f"OK — providers-extensions.ts {len(files[PE])} lignes, providers.ts {len(files[PR])} lignes")
