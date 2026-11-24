// Driver SQLite abstrait (vague 4 — « Store jetable », cf. FORK.md §9 du
// 2026-11-25) : bun:sqlite n'existe que sous Bun ; la couverture RÉELLE du
// store exige de faire tourner les MÊMES builders (store-*.ts, corps
// VERBATIM) sous Node, dans Vitest. Le driver expose l'exact sous-ensemble
// de l'API utilisé par le code de production : query/prepare → statement
// (get/all/run), exec, transaction, close. Sous Bun : bun:sqlite natif (le
// service, inchangé). Sous Node : node:sqlite (DatabaseSync) — le MÊME
// moteur SQLite, sur une base :memory: pour les tests.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database as BunDatabase } from "bun:sqlite";
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** Paramètres de requête — le superset de bun:sqlite (SQLQueryBindings) :
 *  les corps VERBATIM du store lient des chaînes, des nombres et des null,
 *  et castent explicitement certains tableaux avec « boolean » (cf.
 *  store-settings extensions:update). L'adaptateur Node normalise
 *  boolean/Date/undefined pour reproduire la liaison bun (true→1, false→0). */
export type SqlParam =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Date
  | Uint8Array;

/** Un statement préparé : les trois consommations que le code de production
 *  fait de la db — get/all (sans cast parfois : retour large), run (SA valeur
 *  de retour est consommée : r.changes, cf. store-settings). */
export interface ChatStatement {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any --
     bun:sqlite renvoie any ici ; les corps du store lisent des propriétés
     sans cast systématique — garder au moins aussi large pour ne pas toucher
     aux corps (invariant VERBATIM). */
  get(...params: SqlParam[]): any;
  all(...params: SqlParam[]): any[];
  run(...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
}

/** La façade db consommée par les builders (ThisType<Store>) et par
 *  schema.ts — l'exact sous-ensemble du Database de bun:sqlite réellement
 *  utilisé (query/get/all/run, transaction, exec, close). */
export interface ChatDatabase {
  query(sql: string): ChatStatement;
  prepare(sql: string): ChatStatement;
  exec(sql: string): void;
  transaction<TFn>(fn: TFn): TFn;
  close(): void;
}

const requireSqlite = createRequire(import.meta.url);

function ensureDir(path: string): void {
  if (path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true });
}

/** Bun : le driver natif du service, inchangé. */
function openBunDatabase(path: string): ChatDatabase {
  ensureDir(path);
  const { Database } = requireSqlite("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(path, { create: true }) as BunDatabase;
  return {
    query: (sql) => db.query(sql) as unknown as ChatStatement,
    prepare: (sql) => db.prepare(sql) as unknown as ChatStatement,
    exec: (sql) => db.exec(sql),
    transaction: <TFn>(fn: TFn) => db.transaction(fn as never) as TFn,
    close: () => db.close(),
  };
}

/** Node : node:sqlite (le même moteur SQLite, embarqué dans Node ≥ 22.5).
 *  Les différences bun:sqlite absorbées ici :
 *  - pas de db.query() → alias de prepare (avec cache de statements) ;
 *  - pas de db.transaction() → BEGIN/COMMIT à la main, et IMBRICATION par
 *    SAVEPOINT/RELEASE — bun:sqlite fait la même chose en interne (cf.
 *    forkConversation : « transaction imbriquée = savepoint chez
 *    bun:sqlite ») ;
 *  - .get() renvoie undefined (et non null) à vide — tous les appelants du
 *    store testent la vérité (« if (!r) »), le comportement observé est
 *    identique. */
function openNodeDatabase(path: string): ChatDatabase {
  ensureDir(path);
  const { DatabaseSync } = requireSqlite("node:sqlite") as typeof import("node:sqlite");
  const raw: DatabaseSync = new DatabaseSync(path);
  const cache = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const wrap = (sql: string): ChatStatement => {
    const s = statement(sql);
    const bind = (params: SqlParam[]): unknown[] =>
      params.map((p) => {
        if (p === undefined) return null;
        if (typeof p === "boolean") return p ? 1 : 0; // sémantique bun:sqlite
        if (p instanceof Date) return p.toISOString();
        return p;
      });
    return {
      get: (...params) => s.get(...(bind(params) as never[])),
      all: (...params) => s.all(...(bind(params) as never[])) as unknown[],
      run: (...params) => {
        const r = s.run(...(bind(params) as never[]));
        return {
          changes: Number(r.changes),
          lastInsertRowid: r.lastInsertRowid,
        };
      },
    };
  };
  let depth = 0;
  return {
    query: wrap,
    prepare: wrap,
    exec: (sql) => raw.exec(sql),
    transaction: <TFn>(fn: TFn) => {
      const txn = (...args: unknown[]): unknown => {
        const top = depth === 0;
        const savepoint = `hermes_sp_${depth}`;
        raw.exec(top ? "BEGIN" : `SAVEPOINT ${savepoint}`);
        depth++;
        try {
          const r = (fn as (...a: unknown[]) => unknown)(...args);
          raw.exec(top ? "COMMIT" : `RELEASE ${savepoint}`);
          return r;
        } catch (err) {
          try {
            raw.exec(top ? "ROLLBACK" : `ROLLBACK TO ${savepoint}`);
          } catch {
            /* transaction déjà roulée */
          }
          throw err;
        } finally {
          depth--;
        }
      };
      return txn as TFn;
    },
    close: () => raw.close(),
  };
}

/** Ouvre la connexion du service (fichier, sous Bun) ou la base de test
 *  (« :memory: », sous Node/Vitest). Le schéma est appliqué par l'appelant
 *  (applySchema), comme avant — point d'entrée inchangé. */
export function openDatabase(path: string): ChatDatabase {
  if (typeof Bun !== "undefined") return openBunDatabase(path);
  return openNodeDatabase(path);
}
