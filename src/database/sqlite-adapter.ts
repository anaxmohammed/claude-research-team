/**
 * SQLite Adapter - Provides compatibility between Bun's native SQLite and better-sqlite3
 *
 * Uses bun:sqlite when running under Bun, falls back to better-sqlite3 for Node.js
 */

export type SqliteDatabase = {
  pragma(pragma: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

export type SqliteStatement = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

// Detect if we're running under Bun
const isBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';

export async function openDatabase(path: string): Promise<SqliteDatabase> {
  if (isBun) {
    // Use Bun's native SQLite
    const { Database } = await import('bun:sqlite');
    return new Database(path) as unknown as SqliteDatabase;
  } else {
    // Fall back to better-sqlite3
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    return new BetterSqlite3(path) as unknown as SqliteDatabase;
  }
}

export function openDatabaseSync(path: string): SqliteDatabase {
  if (isBun) {
    // Use Bun's native SQLite (synchronous import via require)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite');
    return new Database(path) as unknown as SqliteDatabase;
  } else {
    // Fall back to better-sqlite3
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(path) as unknown as SqliteDatabase;
  }
}
