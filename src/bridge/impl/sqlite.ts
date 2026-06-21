// SQLiteBridge — the bundle owns the schema/queries of the main message DB
// (genericStorage.db) and drives it through one host object. The WIRE form is a
// single JSON string in / JSON string out — the bundle calls
// `executeSqlite(JSON.stringify(queries))` and does `JSON.parse(result)` (verified
// in the waweb bundle's FTS client). `queries` decodes to string[][] (each inner
// array = [sql, ...params]); the result is SqliteResult[]. The field names
// (LastInsertedRowId/RowsAffected/Rows/ColumnNames/Error) are load-bearing.
// Windows uses a custom AES+HMAC page codec; we use a fresh better-sqlite3 store
// (synchronous — perfect for the WebView2 sync proxy).

import type { BridgeFactory } from '../types';

interface SqliteResult {
  LastInsertedRowId: number;
  RowsAffected: number;
  Rows: unknown[][];
  ColumnNames: string[];
  Error: string | null;
}

// better-sqlite3 rejects JS booleans; map them to ints. Everything else
// (number/string/Buffer/null/bigint) binds directly.
const bindable = (p: unknown): unknown => (typeof p === 'boolean' ? (p ? 1 : 0) : p);

function run(db: import('better-sqlite3').Database, cmds: unknown[][]): SqliteResult[] {
  return cmds.map((cmd): SqliteResult => {
    const [sql, ...params] = cmd as [string, ...unknown[]];
    try {
      const stmt = db.prepare(sql);
      const args = params.map(bindable);
      if (stmt.reader) {
        const rows = stmt.raw().all(...args) as unknown[][];
        const cols = stmt.columns().map((c) => c.name);
        return { LastInsertedRowId: 0, RowsAffected: 0, Rows: rows, ColumnNames: cols, Error: null };
      }
      const info = stmt.run(...args);
      return {
        LastInsertedRowId: Number(info.lastInsertRowid),
        RowsAffected: info.changes,
        Rows: [],
        ColumnNames: [],
        Error: null,
      };
    } catch (e) {
      return { LastInsertedRowId: 0, RowsAffected: 0, Rows: [], ColumnNames: [], Error: String((e as Error)?.message ?? e) };
    }
  });
}

export const bridges: Record<string, BridgeFactory> = {
  // JS-projected method names are camelCase (CsWinRT lowercases the first letter
  // of the C# `ExecuteSqlite`). Accepts the real JSON-string form AND a raw
  // string[][] (used by the smoke); echoes back the matching shape.
  SQLiteBridge: (ctx) => {
    const exec = (input: unknown) => {
      const isStr = typeof input === 'string';
      let cmds: unknown = isStr ? safeParse(input as string) : input;
      if (!Array.isArray(cmds)) cmds = [];
      const results = run(ctx.nativeDb(), cmds as unknown[][]);
      return isStr ? JSON.stringify(results) : results;
    };
    return {
      executeSqlite: exec,
      executeSqliteAsync: async (input: unknown) => exec(input),
    };
  },
};

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return []; }
}
