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

/**
 * Wraps a Bun SQLite database to provide better-sqlite3 compatible API
 */
interface BunStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
}

interface BunDatabase {
  query(sql: string): BunStatement;
  exec(sql: string): void;
  close(): void;
}

function wrapBunDatabase(bunDb: unknown): SqliteDatabase {
  const db = bunDb as BunDatabase;

  return {
    pragma(pragmaStr: string): unknown {
      // Bun uses query() instead of pragma()
      const stmt = db.query(`PRAGMA ${pragmaStr}`);

      // Some pragmas return multiple rows (table_info, index_list, etc.)
      // Others return a single value (journal_mode, etc.)
      if (pragmaStr.includes('table_info') || pragmaStr.includes('index_list') || pragmaStr.includes('index_info')) {
        return stmt.all();
      }

      const result = stmt.get();
      // Return first value for simple pragmas like "journal_mode = WAL"
      if (result && typeof result === 'object') {
        const values = Object.values(result);
        return values.length === 1 ? values[0] : result;
      }
      return result;
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const stmt = db.query(sql);
      return {
        run(...params: unknown[]) {
          return stmt.run(...params);
        },
        get(...params: unknown[]) {
          return stmt.get(...params);
        },
        all(...params: unknown[]) {
          return stmt.all(...params);
        },
      };
    },
    close(): void {
      db.close();
    },
  };
}

export async function openDatabase(path: string): Promise<SqliteDatabase> {
  if (isBun) {
    // Use Bun's native SQLite
    const { Database } = await import('bun:sqlite');
    return wrapBunDatabase(new Database(path));
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
    return wrapBunDatabase(new Database(path));
  } else {
    // Fall back to better-sqlite3
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3');
    return new BetterSqlite3(path) as unknown as SqliteDatabase;
  }
}
