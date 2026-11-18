#!/usr/bin/env python3
"""Découpe store.ts par domaine : les MÉTHODES migrent vers store-messages.ts,
store-artifacts.ts, store-settings.ts sous forme de mixins fusionnés au
prototype de Store (Object.assign). `this.db` reste valide : les méthodes
restent des méthodes de Store, définies dans un autre fichier.
API publique inchangée : Store, ArtifactRow, KeyRow, ProviderRow, ExtensionRow,
ProjectRow restent exportés par store.ts (ré-export des types déplacés)."""
import sys

ROOT = "/home/z/my-project/hermes_ui/mini-services/hermes-chat"
SRC = f"{ROOT}/store.ts"

src = open(SRC).read()
if "buildStoreSettings" in src:
    print("découpage déjà appliqué — abandon")
    sys.exit(0)
lines = src.split("\n")

def idx(pat, start=0):
    for i in range(start, len(lines)):
        if pat in lines[i]:
            return i
    return -1

# Frontières de sections (0-based)
ORDER = [
    (idx("// ── Prompt système & presets (F-11 / F-19)"), "settings"),
    (idx("// ── Partage public lecture seule (F-13, FORK.md §7.8)"), "settings"),
    (idx("// ── Artefacts ─"), "artifacts"),
    (idx("// ── Projets : rangement des conversations"), "messages"),
    (idx("// ── Réglages serveur (cf. FORK.md §6)"), "settings"),
    (idx("listConversations(): ConversationMeta[]"), "messages"),
    (idx("// ── Modes du compositeur (F-30)"), "messages"),
    (idx("getMessages(conversationId: string): ChatMessage[]"), "messages"),
    (idx("// ── Fournisseurs & clés (Paramètres v2.2)"), "settings"),
    (idx("// ── Extensions : dépôts importés + serveurs MCP"), "settings"),
    (idx("conversationAttachments(conversationId: string): Attachment[]"), "messages"),
    (idx("// ── Checkpoint WAL (dette revue 2026-11-13)"), None),
]
for s, lab in ORDER:
    assert s is not None and s >= 0, f"section introuvable : {lab}"

bounds = []
for k, (s, lab) in enumerate(ORDER):
    e = ORDER[k + 1][0] if k + 1 < len(ORDER) else len(lines)
    while lines[e - 1].strip() == "":
        e -= 1
    bounds.append((s, e, lab))

# Snapshots AVANT suppression
snaps = {"settings": [], "artifacts": [], "messages": []}
for s, e, lab in bounds:
    if lab is None:
        continue
    snaps[lab].append(lines[s:e])

# Contrôle d'équilibre des accolades par section
for name, segs in snaps.items():
    flat = "\n".join("\n".join(s) for s in segs)
    o, c = flat.count("{"), flat.count("}")
    assert o == c, f"{name} déséquilibré : {o} / {c}"

# Suppression du bas vers le haut
for s, e, _ in sorted([b for b in bounds if b[2]], key=lambda x: -x[0]):
    del lines[s:e]

remaining = "\n".join(lines)

# ── Écriture des 3 modules ────────────────────────────────────────────────
def strip_private_kw(body):
    """`private nextArtifactVersion(...)` → `nextArtifactVersion(...)` :
    les propriétés d'objet mixin n'ont pas de visibilité."""
    return [l.replace("  private ", "  ") for l in body]

def dedent_as_object(seg_lines):
    """Méthodes de classe (indent 2) → propriétés d'objet (indent 4) :
    +2 espaces pour les lignes de code, commentaires inclus."""
    out = []
    for l in seg_lines:
        if l.strip() == "":
            out.append("")
        elif l.startswith("    "):
            out.append("  " + l)  # corps déjà indenté de 4 → 6
        elif l.startswith("  "):
            out.append("    " + l[2:])  # signature à 2 → 4
        else:
            out.append("    " + l)
    return out

def module(path, comment, imports, bodies):
    out = [f"// {comment} — extrait de store.ts (découpage 2026-11, FORK.md §10).",
           "// Mixin plat de méthodes (this = instance Store) fusionné au prototype",
           "// par Object.assign(Store.prototype, build*()) dans store.ts : l'API",
           "// publique de Store est inchangée."]
    out.extend(imports)
    out.append("")
    fn = "build" + path.replace("store-", "").replace(".ts", "").capitalize()
    out.append(f"export function {fn}() {{")
    out.append("  return {")
    for seg in bodies:
        seg = strip_private_kw(seg)
        body = dedent_as_object(seg)
        # virgule après la fermeture de CHAQUE méthode : la dernière ligne
        # non vide du segment se termine par "}" → "},"
        # virgule après CHAQUE fermeture de méthode : ligne '    }' isolée
        for k2, l2 in enumerate(body):
            if l2.rstrip() == "    }":
                body[k2] = "    },"
        out.extend(body)
        out.append("")
    # retire la dernière ligne vide avant la fermeture
    while out[-1] == "":
        out.pop()
    # la dernière virgule traîne → on la retire
    k = len(out) - 1
    while out[k].strip() == "":
        k -= 1
    if out[k].rstrip().endswith("},"):
        out[k] = out[k].rstrip()[:-1]
    out.append("  };")
    out.append("}")
    open(f"{ROOT}/{path}", "w").write("\n".join(out) + "\n")
    print(path, ":", sum(len(s) for s in bodies), "lignes de méthodes")

module("store-settings.ts",
       "Store — domaine réglages : prompts système/presets (F-11/F-19), partages (F-13), réglages serveur, fournisseurs & clés (Paramètres v2.2), extensions",
       [
         'import type { ShareRow } from "./shares";',
         'import type { SystemPromptRow } from "./prompts";',
       ],
       snaps["settings"])

module("store-artifacts.ts",
       "Store — domaine artefacts : journal des versions F-26, lignes d'artefacts, restauration, quota",
       [
         'import { artifactPdfPath, artifactThumbPath } from "./artifacts";',
         'import { MAX_PINNED, MAX_VERSIONS, isIdenticalReissue, restoreLabel, restoredStatus, selectPurgeable } from "./versions";',
         'import type { ArtifactRow } from "./store";',
       ],
       snaps["artifacts"])

module("store-messages.ts",
       "Store — domaine conversations & messages : projets, conversations, modes F-30, messages, versions F-14, recherche, pièces jointes",
       [
         'import { copyFileSync, existsSync } from "node:fs";',
         'import { resolveMode } from "./modes";',
         'import type { ConversationMode, ModeConfig } from "./modes";',
         'import { normalizeWebchatModelId } from "./webchat/fiches";',
         'import type { ModeFlowRow, Artifact, Attachment, ChatMessage, ConversationMeta, Project, Role, SearchHit, ToolEvent } from "./types";',
         'import type { ArtifactRow, ProjectRow } from "./store";',
       ],
       snaps["messages"])

# ── store.ts : classe réduite + fusion des mixins + ré-exports ─────────────
new_store = remaining
# remplace l'entête du fichier (imports d'origine) par la version à jour
old_head_end = idx("const DB_PATH =")
head = '''// Persistance SQLite (bun:sqlite) : conversations + messages + artefacts
// Le chemin est surchargeable par HERMES_CHAT_DB (tests d'intégration —
// sinon la base de dev du service).
// Découpage 2026-11 (FORK.md §10) : schéma dans schema.ts ; méthodes par
// domaine dans store-messages.ts / store-artifacts.ts / store-settings.ts,
// fusionnées au prototype ci-dessous. L'API publique (Store, types de
// lignes) est inchangée — les tests importent Store depuis ./store.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { applySchema } from "./schema";
import { buildStoreSettings } from "./store-settings";
import { buildStoreArtifacts } from "./store-artifacts";
import { buildStoreMessages } from "./store-messages";

'''
new_store = head + "\n".join(new_store.split("\n")[old_head_end:])

# Insère la fusion juste après la fermeture de la classe Store
anchor = "const CHECKPOINT_INTERVAL_MS"
fusion = '''// Fusion des mixins par domaine (découpage 2026-11) : les méthodes restent
// des méthodes de Store (this.db), définies par domaine dans store-*.ts.
Object.assign(Store.prototype, buildStoreSettings());
Object.assign(Store.prototype, buildStoreArtifacts());
Object.assign(Store.prototype, buildStoreMessages());

'''
new_store = new_store.replace(anchor, fusion + anchor, 1)

open(SRC, "w").write(new_store)
print("store.ts :", len(new_store.split(chr(10))), "lignes (avec fusion + ré-exports)")
