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

// The bundle only ever drives its OWN store here. ATTACH/DETACH would let page SQL open a
// foreign SQLite database at any host path — reading other apps' data or creating/overwriting
// files outside userData — so reject them. Leading SQL comments are stripped before the keyword
// test; better-sqlite3 compiles one statement per prepare, so the guarded verb must be first.
const ATTACH_STMT = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*(?:\n|$)\s*)*(?:attach|detach)\b/i;

function run(db: import('better-sqlite3').Database, cmds: unknown[][]): SqliteResult[] {
  return cmds.map((cmd): SqliteResult => {
    const [sql, ...params] = cmd as [string, ...unknown[]];
    try {
      if (ATTACH_STMT.test(String(sql))) {
        return { LastInsertedRowId: 0, RowsAffected: 0, Rows: [], ColumnNames: [], Error: 'ATTACH/DETACH not permitted' };
      }
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

// ponytail self-check (WA_SQLITE_SELFCHECK=1): ATTACH/DETACH guard, no framework.
if (process.env.WA_SQLITE_SELFCHECK) {
  const blocked = [
    'ATTACH DATABASE \'/etc/x\' AS y',
    '  attach database ":memory:" as z',
    '/* c */ ATTACH DATABASE \'x\' AS y',
    '-- note\nDETACH DATABASE y',
    'DETACH y',
  ];
  const allowed = ['SELECT x FROM t', "INSERT INTO t(x) VALUES('attach me')", 'UPDATE t SET x=1'];
  for (const s of blocked) console.assert(ATTACH_STMT.test(s), `should block: ${s}`);
  for (const s of allowed) console.assert(!ATTACH_STMT.test(s), `should allow: ${s}`);
  console.log('[sqlite self-check] ok');
}
