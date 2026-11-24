#!/usr/bin/env python3
"""Vague 4 — « Store jetable » : isoler bun:sqlite derrière un driver.

bun:sqlite n'existe que sous Bun ; pour couvrir RÉELLEMENT le store (machine
de versions F-14, CRUD/modes) dans Vitest, les MÊMES builders doivent tourner
sous Node. Le driver (db-driver.ts, fichier neuf) expose l'exact sous-ensemble
db utilisé par le code de production ; store.ts et schema.ts basculent dessus
(corps de méthodes des builders VERBATIM — ce script ne touche AUCUNE méthode).
uploads.ts : import.meta.dir → dirname(fileURLToPath(import.meta.url)) pour que
la chaîne d'import se charge sous les deux runtimes (sémantique identique sous
Bun). vitest.config.ts : store-messages.ts entre dans la liste de couverture.

Coupes ANCRÉES : toutes les bornes sont vérifiées AVANT toute écriture.
"""

STORE = "/home/z/my-project/hermes_ui/mini-services/hermes-chat/store.ts"
SCHEMA = "/home/z/my-project/hermes_ui/mini-services/hermes-chat/schema.ts"
UPLOADS = "/home/z/my-project/hermes_ui/mini-services/hermes-chat/uploads.ts"
ARTIFACTS = "/home/z/my-project/hermes_ui/mini-services/hermes-chat/artifacts.ts"
VITEST = "/home/z/my-project/hermes_ui/mini-services/hermes-chat/vitest.config.ts"

files = {}
for path in (STORE, SCHEMA, UPLOADS, ARTIFACTS, VITEST):
    with open(path) as f:
        files[path] = f.read().split("\n")

def L(path, n):
    return files[path][n - 1]

checks = [
    # store.ts — le seul import valeur de bun:sqlite du dépôt
    (STORE, 9,  'import { Database } from "bun:sqlite";'),
    (STORE, 10, 'import { mkdirSync } from "node:fs";'),
    (STORE, 11, 'import { dirname, join } from "node:path";'),
    (STORE, 33, "const DB_PATH ="),
    (STORE, 34, "  process.env.HERMES_CHAT_DB ??"),
    (STORE, 35, '  join(import.meta.dir, "..", "..", "db", "hermes-chat.sqlite");'),
    (STORE, 223, "  db: Database;"),
    (STORE, 230, "  constructor() {"),
    (STORE, 231, "    mkdirSync(dirname(DB_PATH), { recursive: true });"),
    (STORE, 232, "    this.db = new Database(DB_PATH, { create: true });"),
    (STORE, 233, "    // Schéma + PRAGMA + migrations douces : cf. schema.ts (découpage 2026-11)."),
    (STORE, 234, "    applySchema(this.db);"),
    (STORE, 235, "  }"),
    # schema.ts — import type + deux signatures
    (SCHEMA, 5,  'import type { Database } from "bun:sqlite";'),
    (SCHEMA, 10, "export function applySchema(db: Database): void {"),
    (SCHEMA, 241, "function softAlter(db: Database, table: string, column: string): void {"),
    # uploads.ts — portabilité du chemin (aucun corps de méthode touché)
    (UPLOADS, 4, 'import { join, resolve, dirname } from "node:path";'),
    (UPLOADS, 5, 'import type { Attachment, AttachmentKind } from "./types";'),
    (UPLOADS, 7, 'const UPLOADS_DIR = join(import.meta.dir, "..", "..", "db", "uploads");'),
    # artifacts.ts — idem : top-level constant dans la chaîne d'import des tests
    (ARTIFACTS, 4, 'import { existsSync, statSync } from "node:fs";'),
    (ARTIFACTS, 5, 'import type { Artifact, ArtifactKind } from "./types";'),
    (ARTIFACTS, 8, '// ── Dossiers des fichiers dérivés (PNG / PDF), servis par le port 3004 ──'),
    (ARTIFACTS, 9, 'import { join } from "node:path";'),
    (ARTIFACTS, 10, 'export const ARTIFACTS_DIR = join(import.meta.dir, "..", "..", "db", "artifacts");'),
    # vitest.config.ts — le store entre dans la couverture mesurable
    (VITEST, 5, "// purs testables sous Node (les stores exigent bun:sqlite, hors Vitest)."),
    (VITEST, 15, '      include: ["modes.ts", "prompts.ts", "models.ts", "hermes-connector.ts", "webchat/fiches.ts", "webchat/paths.ts", "shared/chat-protocol.ts"],'),
]
bad = [(p, n) for p, n, want in checks if L(p, n) != want]
if bad:
    raise SystemExit(
        "ANCHOR MISMATCH at "
        + "; ".join(f"{p.split('/')[-1]}:{n}={L(p, n)!r} (attendu {dict((n, w) for pp, n, w in checks if pp == p)[n]!r})" for p, n in bad)
    )

def replace(path, a, b, new_lines):
    lines = files[path]
    lines[a - 1 : b] = new_lines

# ── store.ts ──────────────────────────────────────────────────────────────
# (du bas vers le haut pour garder les numéros valides)
replace(STORE, 230, 235, [
    "  constructor() {",
    "    this.db = openDatabase(DB_PATH);",
    "    // Schéma + PRAGMA + migrations douces : cf. schema.ts (découpage 2026-11).",
    "    applySchema(this.db);",
    "  }",
])
replace(STORE, 223, 223, [
    "  db: ChatDatabase;",
])
replace(STORE, 33, 35, [
    "// Portabilité (vague 4, Store jetable) : dirname(fileURLToPath(import.meta.url))",
    "// vaut import.meta.dir sous Bun et reste correct sous Node (Vitest) — le",
    "// module doit pouvoir se charger sous les deux runtimes.",
    "const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));",
    "const DB_PATH =",
    '  process.env.HERMES_CHAT_DB ??',
    '  join(SERVICE_DIR, "..", "..", "db", "hermes-chat.sqlite");',
])
replace(STORE, 9, 11, [
    'import { openDatabase, type ChatDatabase } from "./db-driver";',
    'import { fileURLToPath } from "node:url";',
    'import { dirname, join } from "node:path";',
])

# ── schema.ts ─────────────────────────────────────────────────────────────
replace(SCHEMA, 241, 241, [
    "function softAlter(db: ChatDatabase, table: string, column: string): void {",
])
replace(SCHEMA, 10, 10, [
    "export function applySchema(db: ChatDatabase): void {",
])
replace(SCHEMA, 5, 5, [
    'import type { ChatDatabase } from "./db-driver";',
])

# ── uploads.ts ────────────────────────────────────────────────────────────
replace(UPLOADS, 7, 7, [
    "const UPLOADS_DIR = join(dirname(fileURLToPath(import.meta.url)), \"..\", \"..\", \"db\", \"uploads\");",
])
replace(UPLOADS, 4, 4, [
    'import { join, resolve, dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
])

# ── artifacts.ts ──────────────────────────────────────────────────────────
replace(ARTIFACTS, 10, 10, [
    'export const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "artifacts");',
])
replace(ARTIFACTS, 9, 9, [
    'import { join, dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
])

# ── vitest.config.ts ──────────────────────────────────────────────────────
replace(VITEST, 15, 15, [
    '      include: ["modes.ts", "prompts.ts", "models.ts", "hermes-connector.ts", "webchat/fiches.ts", "webchat/paths.ts", "shared/chat-protocol.ts", "store-messages.ts"],',
])
replace(VITEST, 5, 5, [
    "// purs testables sous Node — depuis la vague 4 (« Store jetable »), les",
    "// builders du store y tournent aussi (node:sqlite :memory:, via db-driver).",
])

for path in (STORE, SCHEMA, UPLOADS, ARTIFACTS, VITEST):
    with open(path, "w") as f:
        f.write("\n".join(files[path]))

print(f"OK — 5 fichiers réécrits (store {len(files[STORE])} lignes, schema {len(files[SCHEMA])}, uploads {len(files[UPLOADS])}, artifacts {len(files[ARTIFACTS])}, vitest {len(files[VITEST])})")
