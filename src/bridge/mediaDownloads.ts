// Media download routing — the Electron analog of the Windows client's
// MediaDownloadManager (hooks CoreWebView2.DownloadStarting, doc 40 §3.2.2).
//
// WA Web saves media via a decrypted-blob anchor click (WAWebFileSaver:
// URL.createObjectURL(blob) -> <a download> -> click), which fires Electron's
// session 'will-download'. Just before the click the bundle calls
// MediaFilesBridge.prepareForMediaFileSaving(blobUrl, name, hash) to pre-arm, then
// awaits waitTillMediaDownloadCompletes. Without a handler Electron pops a Save
// dialog every time and nothing records the result. Here we:
//   - route every download silently to ~/Downloads/WhatsApp/<unique name>,
//   - record it in the private media_cache (so open / re-download checks work),
//   - resolve the pre-armed promise so the bundle's "saving…" completes.
// The decrypted bytes ride the DownloadItem, so the main process never fetches.

import { app } from 'electron';
import type { Session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type DatabaseT from 'better-sqlite3';

type DB = DatabaseT.Database;

export function downloadsDir(): string {
  const d = path.join(app.getPath('downloads'), 'WhatsApp');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const extOf = (name: string) => (path.extname(String(name)) || '').slice(1).toLowerCase();

// ── Shared private media cache (media_cache table in native.db) ────────────────
export function ensureCacheTable(db: DB): DB {
  db.exec(
    'CREATE TABLE IF NOT EXISTS media_cache (hash TEXT NOT NULL, ext TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (hash, ext));' +
    'CREATE INDEX IF NOT EXISTS idx_media_cache_hash ON media_cache(hash);',
  );
  return db;
}

export function recordCache(db: DB, hash: string, ext: string, absPath: string): void {
  ensureCacheTable(db)
    .prepare('INSERT INTO media_cache(hash,ext,path) VALUES(?,?,?) ON CONFLICT(hash,ext) DO UPDATE SET path=excluded.path')
    .run(hash, ext, absPath);
}

/** Cached absolute path for (hash, ext), or undefined; prunes stale rows. */
export function cachedPath(db: DB, hash: string, ext: string): string | undefined {
  const row = ensureCacheTable(db)
    .prepare('SELECT path FROM media_cache WHERE hash=? AND ext=?')
    .get(hash, ext) as { path: string } | undefined;
  if (!row) return undefined;
  if (!fs.existsSync(row.path)) {
    db.prepare('DELETE FROM media_cache WHERE hash=? AND ext=?').run(hash, ext);
    return undefined;
  }
  return row.path;
}

// ── Pre-arm + await coordination ───────────────────────────────────────────────
interface Expected { name: string; hash: string }
const expected = new Map<string, Expected>();                     // blobUrl -> {name, hash}
const pending = new Map<string, () => void>();                    // hash -> resolve
const completed = new Set<string>();                              // hash done before awaitDownload

export function expectDownload(blobUrl: string, name: string, hash: string): void {
  expected.set(blobUrl, { name, hash });
}

/** Resolves when the matching download finishes; 30s fallback so the bundle never hangs. */
export function awaitDownload(hash: string): Promise<void> {
  return new Promise((resolve) => {
    if (completed.delete(hash)) { resolve(); return; }
    const timer = setTimeout(() => { pending.delete(hash); resolve(); }, 30_000);
    pending.set(hash, () => { clearTimeout(timer); resolve(); });
  });
}

function markDone(hash: string): void {
  const r = pending.get(hash);
  if (r) { pending.delete(hash); r(); return; }
  // Completed before the bundle awaited; remember briefly so awaitDownload resolves fast.
  completed.add(hash);
  setTimeout(() => completed.delete(hash), 60_000);
}

function uniquePath(dir: string, name: string): string {
  const safe = (String(name).replace(/[/\\]/g, '_').trim()) || 'download';
  let p = path.join(dir, safe);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  for (let i = 1; ; i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

let installed = false;

/**
 * Route media downloads exactly like the Windows MediaDownloadManager (doc 40 §3.2.2):
 *  - EXPECTED  (the bundle pre-armed it via prepareForMediaFileSaving -> in `expected`):
 *    the auto-"Download" action. Route silently to ~/Downloads/WhatsApp, record in cache.
 *  - UNEXPECTED (not pre-armed -> the "Save As" button, external links): pop the native
 *    Save dialog so the user picks any folder/name. NOT calling setSavePath makes Electron
 *    show that dialog — calling it for everything was silently dumping numbered duplicates.
 */
export function installDownloadRouting(ses: Session, getDb: () => DB): void {
  if (installed) return;
  installed = true;
  ses.on('will-download', (_e, item) => {
    const url = item.getURL();
    const meta = expected.get(url);

    if (!meta) {
      // Unexpected: native Save-As picker, defaulting into the WhatsApp folder.
      item.setSaveDialogOptions({ defaultPath: path.join(downloadsDir(), item.getFilename() || 'download') });
      return;
    }

    const target = uniquePath(downloadsDir(), item.getFilename() || meta.name || 'download');
    item.setSavePath(target);                                    // synchronous -> no Save dialog
    item.once('done', (_ev, state) => {
      try {
        if (state === 'completed') {
          const saved = item.getSavePath() || target;
          recordCache(getDb(), meta.hash, extOf(saved), saved);
        }
      } catch { /* cache write best-effort */ }
      markDone(meta.hash);                                       // resolve even on fail/cancel
      expected.delete(url);
    });
  });
}
