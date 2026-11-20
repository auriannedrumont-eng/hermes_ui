// Types minimaux de bun:sqlite pour tsc (le runtime Bun les fournit nativement).
declare module "bun:sqlite" {
  export interface SqliteStatement<V = unknown, R = unknown> {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): R | null;
    all(...params: unknown[]): R[];
  }
  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean });
    query<R = unknown, V = unknown>(sql: string): SqliteStatement<V, R>;
    exec(sql: string): this;
    pragma(source: string): unknown;
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
    close(): void;
  }
}
