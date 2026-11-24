// Store JETABLE (vague 4 — cf. FORK.md §9 du 2026-11-25) : la MÊME façade
// Store que le service utilise (mêmes builders store-*.ts, corps des
// méthodes VERBATIM, posés au prototype), mais sur une base SQLite EN
// MÉMOIRE. Sous Vitest (Node), le driver bascule sur node:sqlite :memory: —
// le vrai moteur SQLite exécute les vraies requêtes des builders ;
// bun:sqlite, indisponible sous Node, est isolé derrière db-driver.ts.
// Objectif : première couverture RÉELLE du store (machine de versions F-14,
// CRUD/modes) dans la mesure crapper.
import { openDatabase, type ChatDatabase } from "./db-driver";
import { applySchema } from "./schema";
import { buildSettings } from "./store-settings";
import { buildArtifacts } from "./store-artifacts";
import { buildMessages } from "./store-messages";
import { buildStorage } from "./store-storage";
import type { Store } from "./store";

/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging --
   usage délibéré, même recette que Store (cf. store.ts) : les méthodes des
   builders gagnent leurs signatures sur MemoryStore via le merging,
   l'implémentation est posée au prototype en pied de fichier. */
/* eslint-disable-next-line @typescript-eslint/no-empty-object-type --
   interface vide VOLONTAIRE : elle porte la surface Store sur la classe
   MemoryStore (declaration merging, comme sur Store). */
export interface MemoryStore extends Store {}

export class MemoryStore {
  db: ChatDatabase;

  constructor() {
    this.db = openDatabase(":memory:");
    applySchema(this.db);
  }

  /** Fermeture propre (Vitest beforeEach/afterEach). */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* déjà fermée */
    }
  }
}

Object.assign(
  MemoryStore.prototype,
  buildSettings(),
  buildArtifacts(),
  buildMessages(),
  buildStorage(),
);
