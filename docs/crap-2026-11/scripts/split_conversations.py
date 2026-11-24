"""Découpe registerConversationsHandlers (955 lignes, CC 261) en 5 sous-registres contigus.

Chirurgie par plages de lignes avec vérification des bornes ; aucun bloc déplacé
hors de son ordre source, donc le comportement à l'enregistrement est identique.
"""
from pathlib import Path

F = Path("/home/z/my-project/repos/hermes_ui/mini-services/hermes-chat/handlers/conversations.ts")
lines = F.read_text(encoding="utf-8").splitlines(keepends=True)

def block(a: int, b: int) -> str:  # bornes 1-based inclusives
    return "".join(lines[a - 1 : b])

def expect(a: int, *ok_prefixes: str) -> None:
    content = lines[a - 1].rstrip("\n")
    assert any(content.startswith(p) for p in ok_prefixes), f"ligne {a} inattendue : {content!r}"

# ── vérifications de bornes ────────────────────────────────────────────────
expect(29, "export function registerConversationsHandlers")
expect(30, "")
expect(31, 'socket.on("conversations:list"')
expect(269, "", "});")
expect(270, "// ── Projets")
expect(424, "", "});")
expect(425, "socket.on(")
expect(701, "", "});")
expect(702, "socket.on(")
expect(918, "", "});")
expect(919, "// ── Compaction")
expect(983, "}")

header = block(1, 28)
A = block(31, 269)   # conversations:list/create/setMode/rename/delete/open/pin/fork/search + artifacts:list
B = block(270, 424)  # projects:list/create/rename/setArchived/delete/reorder + conversations:move
C = block(425, 701)  # chat:send + chat:regenerate
D = block(702, 918)  # message:edit/delete/setVersion + chat:stop
E = block(919, 982)  # conversation:compact

new = f"""{header}
// ── Découpage interne (audit CRAP 2026-11) ────────────────────────────────
// registerConversationsHandlers ne pose plus 24 socket.on() dans un seul
// corps : cinq sous-registres, un par domaine, chacun appelé dans l'ordre
// source d'origine. Les blocs sont VERBATIM (aucune ligne de handler modifiée) ;
// seuls les corps englobants changent. Le comportement à l'enregistrement,
// l'ordre de pose et les identifiants ctx.* sont inchangés.

/** Cycle de vie du fil : lister, créer, changer de mode, renommer, supprimer,
 *  ouvrir (avec historique + tour en vol), épingler, créer un fork, chercher,
 *  lister les artefacts d'une conversation. */
function registerConversationLifecycleHandlers(socket: Socket) {{
{A}}}

/** Projets & rangement : dossiers (créer/renommer/archiver/supprimer/réordonner,
 *  liaison disque bornée au HOME) et rangement d'une conversation dans un dossier. */
function registerProjectHandlers(socket: Socket) {{
{B}}}

/** Tours de chat : envoi et régénération (mode expert, recherche web,
 *  variantes de comparaison, versions). */
function registerTurnHandlers(socket: Socket) {{
{C}}}

/** Messages & contrôle du tour : édition, suppression, sélection de version,
 *  arrêt du tour en vol. */
function registerMessageAndStopHandlers(socket: Socket) {{
{D}}}

/** Compaction du contexte (chantier « Composer v2 »). */
function registerCompactionHandlers(socket: Socket) {{
{E}}}

/** Point d'entrée inchangé (câblé par index.ts) : pose les 24 socket.on du
 *  domaine conversations, dans l'ordre source d'origine. */
export function registerConversationsHandlers(socket: Socket) {{
  registerConversationLifecycleHandlers(socket);
  registerProjectHandlers(socket);
  registerTurnHandlers(socket);
  registerMessageAndStopHandlers(socket);
  registerCompactionHandlers(socket);
}}
"""

F.write_text(new, encoding="utf-8")
print(f"OK — {F} réécrit : {len(new.splitlines())} lignes (avant : {len(lines)})")
