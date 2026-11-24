#!/usr/bin/env python3
"""Vague 4 — découpage de registerArtifactsSharesHandlers (CC 59) en trois
sous-registres thématiques CONTIGUS, appelés dans l'ordre d'origine.
Corps des handlers VERBATIM — seules les accolades d'encadrement changent
(même recette que conversations / providers-extensions / settings-system).
L'export public et l'ordre de pose des socket.on() sont inchangés."""

PATH = "/home/z/my-project/hermes_ui/mini-services/hermes-chat/handlers/artifacts-shares.ts"

with open(PATH) as f:
    lines = f.read().split("\n")

def L(n):
    return lines[n - 1]

checks = {
    8: "export function registerArtifactsSharesHandlers(socket: Socket) {",
    9: "",
    10: "// Toutes les versions d'une clé (sélecteur de version / diff du panneau)",
    46: "// ── Versionnage fichiers (F-26) : restaurer, étiqueter, épingler ─────",
    111: "// ── Partage public lecture seule (F-13) ───────────────────────────",
    175: ");",
    176: "",
    177: "}",
}
bad = [n for n, want in checks.items() if L(n) != want]
if bad:
    raise SystemExit(f"ANCHOR MISMATCH at {bad}: " +
                     "; ".join(f"{n}={L(n)!r} (attendu {checks[n]!r})" for n in bad[:6]))

def replace(a, b, new_lines):
    lines[a - 1:b] = new_lines

# (du bas vers le haut pour garder les numéros valides)

# 4. Tail : fin du sous-registre partage + l'orchestrateur d'origine
replace(177, 177, [
    "}",
    "",
    "/* Orchestrateur (audit CRAP 2026-11, vague 4) : l'export public et l'ordre",
    " * de pose des socket.on() sont inchangés — index.ts n'est pas touché. */",
    "export function registerArtifactsSharesHandlers(socket: Socket) {",
    "  registerArtifactViewHandlers(socket);",
    "  registerFileVersionHandlers(socket);",
    "  registerShareHandlers(socket);",
    "}",
])

# 3. Partage public lecture seule (F-13) : get, create, revoke
replace(111, 111, [
    "}",
    "",
    "/** Partage public lecture seule (F-13) : l'état actif de la conversation,",
    " *  la création du lien (snapshot FIGÉ au moment du partage) et la",
    " *  révocation (le snapshot et la conversation ne bougent pas). */",
    "function registerShareHandlers(socket: Socket) {",
    "// ── Partage public lecture seule (F-13) ───────────────────────────",
])

# 2. Versionnage fichiers (F-26) : restore, label, pin
replace(46, 46, [
    "}",
    "",
    "/** Versionnage fichiers (F-26) : restaurer une version antérieure — crée",
    " *  v(n+1) d'après vN, jamais d'écrasement —, étiqueter une version",
    " *  (double-clic dans le journal) et épingler (jamais purgée par le quota). */",
    "function registerFileVersionHandlers(socket: Socket) {",
    "// ── Versionnage fichiers (F-26) : restaurer, étiqueter, épingler ─────",
])

# 1. Tête : le monolithe devient le premier sous-registre (vue des artefacts)
replace(8, 9, [
    "// ── Découpage interne (audit CRAP 2026-11, vague 4) ───────────────────────",
    "// registerArtifactsSharesHandlers ne pose plus 7 socket.on() dans un seul",
    "// corps : trois sous-registres, un par domaine, chacun appelé dans l'ordre",
    "// source d'origine. Les blocs sont VERBATIM (aucune ligne de handler",
    "// modifiée) ; seuls les corps englobants changent — l'ordre de pose et les",
    "// identifiants ctx.* sont inchangés, le protocole socket est intouché.",
    "",
    "/** Vue des artefacts : toutes les versions d'une clé (sélecteur de version /",
    " *  diff du panneau) et relance du rendu d'un HTML en erreur (Réessayer). */",
    "function registerArtifactViewHandlers(socket: Socket) {",
])

with open(PATH, "w") as f:
    f.write("\n".join(lines))

print(f"OK — handlers/artifacts-shares.ts réécrit : {len(lines)} lignes")
