// Media host-object bridges for the WhatsApp-Windows-hybrid Electron port.
// Implements: MediaFilesBridge (catalog #16), MediaTranscodingBridge (#17), PicturesBridge (#18).
// Reference: docs/40-media-pipeline-upload-download.md;
//   bridge-catalog.md §MediaFilesBridge / §MediaTranscodingBridge / §PicturesBridge.

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { shell, dialog, clipboard, nativeImage, BrowserWindow } from 'electron';
import type { BridgeFactory, BridgeContext } from '../types';
import { toWeb } from '../eventtarget';

// ─── Shared utilities ─────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** SHA-256 of a file → base64 (mirrors WA's Utils.ComputeSha256Hash, doc 40 §3.2.4). */
function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('base64');
}

/** Lower-cased extension without leading dot (e.g. "mp4", "jpg"). */
function fileExt(filename: string): string {
  return (path.extname(String(filename)) || '').slice(1).toLowerCase();
}

/**
 * Weekly bucket name: "<year>-<weekOfYear 02d>".
 * Mirrors WA's GetTransfersFolder — weekOfYear = DayOfYear/7 + 1 (doc 40 §3.2.3).
 */
function weekBucket(): string {
  const now = new Date();
  const dayOfYear =
    Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86_400_000) + 1;
  const week = String(Math.floor(dayOfYear / 7) + 1).padStart(2, '0');
  return `${now.getFullYear()}-${week}`;
}

// ─── MediaFilesBridge ─────────────────────────────────────────────────────────
// doc 40 §3.2; catalog #16.
// All 9 methods are async-by-return-type (IAsyncOperation<T>/IAsyncAction) in WinRT
// despite having no *Async suffix.  The JS bundle awaits each one; returning a Promise
// is safe via Electron contextBridge even under defaultSyncProxy=true routing.

function mediaFilesBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const transfersRoot = path.join(ctx.userDataDir, 'transfers');
  ensureDir(transfersRoot);

  // Schema mirrors SqliteMediaFilesStorage.CompletedDownloads2 (doc 40 §3.2.6).
  // Keyed on (hash, ext) so the same content can be cached under multiple extensions.
  const cacheDb = () => {
    const db = ctx.nativeDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_cache (
        hash TEXT NOT NULL,
        ext  TEXT NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (hash, ext)
      );
      CREATE INDEX IF NOT EXISTS idx_media_cache_hash ON media_cache(hash);
    `);
    return db;
  };

  /** Look up a cached path; prunes stale DB rows when the file is missing. */
  function cachedPath(hash: string, ext: string): string | undefined {
    const row = cacheDb()
      .prepare('SELECT path FROM media_cache WHERE hash=? AND ext=?')
      .get(hash, ext) as { path: string } | undefined;
    if (!row) return undefined;
    if (!fs.existsSync(row.path)) {
      cacheDb().prepare('DELETE FROM media_cache WHERE hash=? AND ext=?').run(hash, ext);
      return undefined;
    }
    return row.path;
  }

  // Pending download promises: url → { resolve, reject }.
  // ponytail: resolved when the Electron session will-download handler completes (must be
  // wired in main.ts).  waitTillMediaDownloadCompletes falls back to DB polling if absent.
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

  return {
    /** True iff a hash-verified cached blob exists for this hash+ext pair. */
    isCachedMediaFileExist: async (mediaFileHash: unknown, suggestedFileName: unknown) => {
      try {
        const hash = String(mediaFileHash);
        const p = cachedPath(hash, fileExt(String(suggestedFileName)));
        return p != null && sha256File(p) === hash;
      } catch { return false; }
    },

    /** Hash-verify then open with the system default app. */
    tryOpenCachedMediaFileFile: async (mediaFileHash: unknown, suggestedFileName: unknown) => {
      try {
        const hash = String(mediaFileHash);
        const p = cachedPath(hash, fileExt(String(suggestedFileName)));
        if (!p || sha256File(p) !== hash) return false;
        await shell.openPath(p);
        return true;
      } catch { return false; }
    },

    /**
     * Register an expected download so the session will-download handler can route it.
     * Emits 'media:prepareDownload' → main.ts must intercept the download, write the file
     * to destDir, upsert media_cache, then resolve the pending promise.
     * ponytail: without session.on('will-download') wiring, falls back to DB polling below.
     */
    prepareForMediaFileSaving: async (
      url: unknown, suggestedFileName: unknown, mediaFileHash: unknown,
    ) => {
      const u = String(url);
      const destDir = path.join(transfersRoot, weekBucket());
      ensureDir(destDir);
      if (!pending.has(u)) {
        let res!: () => void;
        let rej!: (e: Error) => void;
        const p = new Promise<void>((resolve, reject) => { res = resolve; rej = reject; });
        pending.set(u, { resolve: res, reject: rej });
        void p; // keep alive until resolved
      }
      ctx.emit('media:prepareDownload', {
        url: u,
        suggestedFileName: String(suggestedFileName),
        mediaFileHash: String(mediaFileHash),
        destDir,
      });
    },

    /**
     * Await download completion by polling media_cache (500 ms ticks, 30 s deadline).
     * ponytail: for immediate resolution, wire main.ts to resolve pending[url] after the
     * will-download handler completes and upserts the cache row.
     */
    waitTillMediaDownloadCompletes: async (
      url: unknown, suggestedFileName: unknown, mediaFileHash: unknown,
    ) => {
      const hash = String(mediaFileHash);
      const ext  = fileExt(String(suggestedFileName));
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (cachedPath(hash, ext)) return;
        await new Promise<void>((r) => setTimeout(r, 500));
      }
      ctx.log('MediaFilesBridge.waitTillMediaDownloadCompletes: timed out for', String(url));
    },

    /** Show a native folder picker for bulk media saving.  Returns the chosen path or "". */
    selectFolderForBulkMediaSaving: async () => {
      try {
        const win = BrowserWindow.getFocusedWindow()
          ?? BrowserWindow.getAllWindows()[0]
          ?? null;
        if (!win) return '';
        const res = await dialog.showOpenDialog(win, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Select folder for saving media',
        });
        return res.canceled ? '' : (res.filePaths[0] ?? '');
      } catch { return ''; }
    },

    /**
     * Register a zip download + unarchive to targetFolder.
     * ponytail: unzip (adm-zip/yauzl) + session will-download wiring required in main.ts.
     */
    prepareForZipArchiveSavingAndUnarchiveToFolder: async (
      url: unknown, targetFolder: unknown, _archiveName: unknown, mediaFileHash: unknown,
    ) => {
      ctx.emit('media:prepareZipDownload', {
        url: String(url),
        targetFolder: String(targetFolder),
        mediaFileHash: String(mediaFileHash),
      });
    },

    /**
     * Post the transfers directory to the renderer.
     * ponytail: WebView2 PostWebMessageWithDirectory provides a FileSystemDirectoryHandle object;
     * Electron emits the path string instead — renderer-side JS must adapt.
     */
    requestFileSystemDirectoryHandle: async (directoryType: unknown) => {
      const dir = path.join(transfersRoot, weekBucket());
      ensureDir(dir);
      ctx.emit('media:directoryHandle', { directoryType: String(directoryType), path: dir });
    },

    /** Copy a single cached file to the clipboard. */
    tryCopyCachedMediaFile: async (mediaFileHash: unknown) => {
      try {
        const hash = String(mediaFileHash);
        const rows = cacheDb()
          .prepare('SELECT path, ext FROM media_cache WHERE hash=?')
          .all(hash) as { path: string; ext: string }[];
        const row = rows.find((r) => fs.existsSync(r.path));
        if (!row) return false;
        const imgExts = new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif']);
        if (imgExts.has(row.ext)) {
          clipboard.writeImage(nativeImage.createFromPath(row.path));
        } else {
          // ponytail: no native file-list clipboard on Linux; writes the path as plain text.
          clipboard.writeText(row.path);
        }
        return true;
      } catch { return false; }
    },

    /**
     * Copy multiple cached files to the clipboard.
     * ponytail: Electron clipboard has no multi-file support; copies the first available item.
     */
    tryCopyCachedMediaFiles: async (mediaFilesHash: unknown) => {
      try {
        const hashes: string[] = Array.isArray(mediaFilesHash)
          ? (mediaFilesHash as unknown[]).map(String)
          : [String(mediaFilesHash)];
        for (const hash of hashes) {
          const rows = cacheDb()
            .prepare('SELECT path, ext FROM media_cache WHERE hash=?')
            .all(hash) as { path: string; ext: string }[];
          const row = rows.find((r) => fs.existsSync(r.path));
          if (!row) continue;
          // ponytail: writing path as text (no multi-file clipboard on Linux).
          clipboard.writeText(row.path);
          return true;
        }
        return false;
      } catch { return false; }
    },
  };
}

// ─── MediaTranscodingBridge ───────────────────────────────────────────────────
// doc 40 §3.1; catalog #17.
// Windows zero-copies media via WebView2 CoreWebView2SharedBuffer: JS fills a shared
// memory region, native transcodes it in-place to a second region, then posts the
// result read-only to JS via PostSharedBufferToScript.
// ponytail: Electron has no shared-buffer IPC primitive.  We maintain server-side Buffer
// slots; JS cannot write into them, so transcode ops return false unless main.ts sets
// buf.sourcePath out-of-band (ctx.emit 'media:setBufferSource').
// Real transcoding (when sourcePath is available) uses the system `ffmpeg` binary.

/** One-time ffmpeg availability probe; cached for the process lifetime. */
let ffmpegOk: boolean | null = null;

async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegOk !== null) return ffmpegOk;
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => {
      const ok = !err;
      ffmpegOk = ok;
      resolve(ok);
    });
  });
}

interface SharedBuf {
  /** Always null — JS cannot populate a server-side Buffer over Electron IPC. */
  data: Buffer | null;
  /** Optional file-path workaround; set by main.ts out-of-band to enable real transcoding. */
  sourcePath?: string;
  canceller?: AbortController;
}

function mediaTranscodingBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();
  const tmpDir = path.join(ctx.userDataDir, 'transcode');
  ensureDir(tmpDir);
  const bufs = new Map<number, SharedBuf>();

  return {
    subscribe: tw.subscribe,

    /**
     * [Obsolete] Sync slot allocation.
     * ponytail: WebView2 CoreWebView2SharedBuffer not available in Electron; registers empty slot.
     */
    requestSharedBufferForTranscoding: (requestId: unknown, _bufferSize: unknown) => {
      bufs.set(Number(requestId), { data: null });
    },

    /**
     * Async slot allocation — always returns true; no buffer is posted to JS.
     * ponytail: without PostSharedBufferToScript (WebView2-only), JS cannot fill the source
     * buffer; transcode ops return false until main.ts sets buf.sourcePath out-of-band.
     */
    tryRequestSharedBufferForTranscodingAsync: async (requestId: unknown, _bufferSize: unknown) => {
      bufs.set(Number(requestId), { data: null });
      return true;
    },

    /**
     * Extract a preview JPEG frame from the source buffer via system ffmpeg.
     * ponytail: sync-routed slow op blocks renderer; revisit if janky.
     * Returns false if the source buffer has no associated sourcePath.
     */
    getVideoPreviewFrameFromSharedBuffer: async (sourceBufferId: unknown, resultBufferId: unknown) => {
      const src = bufs.get(Number(sourceBufferId));
      if (!src?.sourcePath) return false;
      if (!await hasFfmpeg()) return false;
      const sid = Number(sourceBufferId);
      const rid = Number(resultBufferId);
      const outPath = path.join(tmpDir, `frame_${rid}.jpg`);
      try {
        const ac = new AbortController();
        src.canceller = ac;
        await new Promise<void>((resolve, reject) => {
          execFile(
            'ffmpeg',
            ['-y', '-i', src.sourcePath!, '-vframes', '1', '-q:v', '2', outPath],
            { timeout: 30_000, signal: ac.signal },
            (err) => { if (err) reject(err); else resolve(); },
          );
        });
        if (!fs.existsSync(outPath)) return false;
        bufs.set(rid, { data: fs.readFileSync(outPath) });
        tw.call('onProgressChanged', { sourceBufferId: sid, percentage: 100 });
        return true;
      } catch { return false; }
      finally { try { fs.unlinkSync(outPath); } catch { /* temp file may already be gone */ } }
    },

    /**
     * Transcode source buffer → result buffer via system ffmpeg.
     * ponytail: sync-routed slow op blocks renderer; revisit if janky.
     * Profile: H.264 + AAC in MP4, longest edge ≤ 960 px.
     * Mirrors AddMaxEdgeTransform(960) from NativeTranscodeWrapper (doc 40 §3.1.4).
     * Uses system `ffmpeg` — NOT a bundled lib.
     */
    performVideoTranscodingFromSharedBuffer: async (
      sourceBufferId: unknown, resultBufferId: unknown, _maxResultSize: unknown,
    ) => {
      const src = bufs.get(Number(sourceBufferId));
      if (!src?.sourcePath) return false;
      if (!await hasFfmpeg()) return false;
      const sid = Number(sourceBufferId);
      const rid = Number(resultBufferId);
      const outPath = path.join(tmpDir, `transcode_${rid}.mp4`);
      try {
        const ac = new AbortController();
        src.canceller = ac;
        await new Promise<void>((resolve, reject) => {
          execFile(
            'ffmpeg',
            [
              '-y', '-i', src.sourcePath!,
              // Fit within 960×960 box, maintaining aspect ratio.
              // Mirrors AddMaxEdgeTransform(960) (doc 40 §3.1.4).
              '-vf', 'scale=960:960:force_original_aspect_ratio=decrease:flags=lanczos',
              '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
              '-c:a', 'aac', '-b:a', '128k',
              outPath,
            ],
            { timeout: 120_000, signal: ac.signal },
            (err) => { if (err) reject(err); else resolve(); },
          );
        });
        if (!fs.existsSync(outPath)) return false;
        bufs.set(rid, { data: fs.readFileSync(outPath) });
        tw.call('onProgressChanged', { sourceBufferId: sid, percentage: 100 });
        return true;
      } catch { return false; }
      finally { try { fs.unlinkSync(outPath); } catch { /* temp file may already be gone */ } }
    },

    /** Abort an in-flight transcode. */
    cancelVideoTranscoding: (sourceBufferId: unknown) => {
      bufs.get(Number(sourceBufferId))?.canceller?.abort();
    },

    /** Free a buffer slot. */
    releaseSharedBuffer: (bufferId: unknown) => {
      bufs.delete(Number(bufferId));
    },
  };
}

// ─── PicturesBridge ───────────────────────────────────────────────────────────
// doc 40 §3.5; catalog #18.
// JS pushes [{id, eurl}] picture-URL entries; we persist to disk and fire
// verifyPicture when a cached URL changes (mirrors PicturesManager.Check, doc 40 §3.5).

interface PicEntry { id: string; eurl: string; seenAt: number }

function picturesBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();
  const cacheDir = path.join(ctx.userDataDir, 'ContactPictures');
  const metaPath = path.join(cacheDir, 'meta.json');
  ensureDir(cacheDir);

  let meta: Record<string, PicEntry> = {};
  try {
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, PicEntry>;
    }
  } catch { meta = {}; }

  function saveMeta(): void {
    try { fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8'); } catch { /* ignore */ }
  }

  // JID normalisation mirrors PicturesManager (doc 40 §3.5).
  const normJid   = (id: string) => String(id).replace(/@c\.us$/,           '@s.whatsapp.net');
  const denormJid = (id: string) => String(id).replace(/@s\.whatsapp\.net$/, '@c.us');

  let subscribed = false;
  const queuedVerify: { eurl: string; id: string }[] = [];

  return {
    /** Register a ToWeb subscriber; flush any queued verifyPicture calls. */
    subscribe: (web?: unknown) => {
      tw.subscribe(web);
      subscribed = true;
      // Replay pending verify requests (mirrors PicturesManager.Subscribe, doc 40 §3.5).
      if (queuedVerify.length) {
        tw.call('verifyPicture', JSON.stringify(queuedVerify.splice(0)));
      }
    },

    /**
     * JS pushes [{id, eurl}] — upsert into the metadata store.
     * Fires verifyPicture for entries whose URL has changed so JS can refresh the avatar.
     */
    setProfilePictures: (jsonArray: unknown) => {
      try {
        const entries = JSON.parse(String(jsonArray)) as { id: string; eurl: string }[];
        const stale: { eurl: string; id: string }[] = [];
        for (const { id, eurl } of entries) {
          const nid = normJid(id);
          const existing = meta[nid];
          if (existing && existing.eurl !== eurl) {
            // URL changed — ask JS to re-verify (mirrors PicturesManager.Check, doc 40 §3.5).
            stale.push({ eurl, id: denormJid(nid) });
          }
          meta[nid] = { id: nid, eurl, seenAt: Date.now() };
        }
        saveMeta();
        if (stale.length) {
          const payload = JSON.stringify(stale);
          if (subscribed) {
            tw.call('verifyPicture', payload);
          } else {
            queuedVerify.push(...stale);
          }
        }
      } catch (e) {
        ctx.log('PicturesBridge.setProfilePictures error', e);
      }
    },
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const bridges: Record<string, BridgeFactory> = {
  MediaFilesBridge:       (ctx) => mediaFilesBridge(ctx),
  MediaTranscodingBridge: (ctx) => mediaTranscodingBridge(ctx),
  PicturesBridge:         (ctx) => picturesBridge(ctx),
};
