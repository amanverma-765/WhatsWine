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
import crypto from 'node:crypto';
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
  // Session dir is keyed once a ClientKey exists; default to a shared dir until then.
  const sessionsDir = path.join(userDataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

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
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();

  return {
    userDataDir,
    sessionsDir,
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
    emit(event, ...payload) {
      const set = listeners.get(event);
      if (set) for (const cb of set) cb(...payload);
    },
    log: (...a) => console.log('[bridge]', ...a),
  };
}

// Stable per-install id substituting the Windows `SystemIdForPublisher` salt
// (doc 32 §5): /etc/machine-id mixed with an app constant, else a random id.
export function installSalt(userDataDir: string): Buffer {
  let machineId = '';
  try { machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch { /* not linux */ }
  if (!machineId) {
    const f = path.join(userDataDir, '.install-id');
    try { machineId = fs.readFileSync(f, 'utf8').trim(); }
    catch { machineId = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(f, machineId, { mode: 0o600 }); }
  }
  return crypto.createHash('sha256').update('whatsapp-desktop:' + machineId).digest();
}
