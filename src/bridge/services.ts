// Shared services for the native bridges: paths, the native sqlite handle, and
// the at-rest secret store. The Windows client protects login secrets with DPAPI
// + a machine-bound page codec (doc 32/94 §5); on Linux we substitute Electron
// `safeStorage` (libsecret/KWallet). When no keyring is available (headless CI,
// minimal session) we fall back to base64 with a loud warning.
// ponytail: base64 fallback is a real at-rest downgrade vs DPAPI — gated, logged,
// upgrade path is a present keyring (safeStorage.isEncryptionAvailable()).

import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type DatabaseT from 'better-sqlite3';
import type { BridgeContext } from './types';

function readJson(file: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeJson(file: string, obj: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
}

export function buildContext(): BridgeContext {
  const userDataDir = app.getPath('userData');
  const secretsFile = path.join(userDataDir, 'secrets.json');
  const canEncrypt = (() => {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  })();
  if (!canEncrypt) {
    console.warn('[bridge] safeStorage unavailable — secret store falls back to base64 (at-rest DOWNGRADE).');
  }
  const enc = (v: string) =>
    canEncrypt ? safeStorage.encryptString(v).toString('base64') : Buffer.from(v, 'utf8').toString('base64');
  const dec = (b64: string) => {
    const buf = Buffer.from(b64, 'base64');
    return canEncrypt ? safeStorage.decryptString(buf) : buf.toString('utf8');
  };

  let db: DatabaseT.Database | null = null;

  return {
    userDataDir,
    nativeDb() {
      if (!db) {
        // require (not import) so a missing/ABI-mismatched native addon only fails
        // bridges that actually touch the DB, not app boot. ponytail.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Database = require('better-sqlite3') as typeof import('better-sqlite3');
        db = new Database(path.join(userDataDir, 'native.db'));
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        db.pragma('secure_delete = ON');
      }
      return db;
    },
    secretSet(key, value) {
      const all = readJson(secretsFile);
      all[key] = enc(value);
      writeJson(secretsFile, all);
    },
    secretGet(key) {
      const all = readJson(secretsFile);
      const v = all[key];
      if (v == null) return null;
      try { return dec(v); } catch { return null; }
    },
    secretDel(key) {
      const all = readJson(secretsFile);
      delete all[key];
      writeJson(secretsFile, all);
    },
    log: (...a) => console.log('[bridge]', ...a),
  };
}
