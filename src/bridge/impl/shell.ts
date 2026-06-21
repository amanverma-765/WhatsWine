// Shell / miscellaneous bridges for the WhatsApp Windows-hybrid Electron port.
// Implements: AppActivationBridge, SharesheetBridge, ScalingControlBridge,
//             RateAppBridge, LinksPreviewBridge.
// Doc refs: bridge-catalog §AppActivation–LinksPreview, docs/30 §3.5, docs/31 §3.16.

import { shell, app } from 'electron';
import type { BridgeFactory, BridgeContext } from '../types';
import { toWeb } from '../eventtarget';

const APP_VERSION = app.getVersion();
const UA_HEADER = `WhatsApp/${APP_VERSION} W`;
const HEAD_CAP = 102_400;      // max chars of HTML to read (catalog §LinksPreviewBridge)
const FETCH_TIMEOUT_MS = 5_000; // 5 s budget per catalog

// ============================================================================
// AppActivationBridge  (catalog §AppActivationBridge, doc 30 §3.5)
// ToNative : subscribe(web) — Sync; replays buffered deeplinks on first call.
// ToWeb    : handleAppActivationViaProtocol(url: string)
// ============================================================================

// Module-level buffer so main.ts 'open-url'/'second-instance' handlers can push
// whatsapp:// deeplinks before the bundle has subscribed to this bridge.
const _deeplinkBuffer: string[] = [];

function appActivationBridge(): ReturnType<BridgeFactory> {
  const tw = toWeb();
  let flushed = false;

  return {
    subscribe(web?: unknown) {
      tw.subscribe(web);
      if (!flushed) {
        flushed = true;
        // Replay any deeplinks buffered before the bundle subscribed.
        for (const url of _deeplinkBuffer.splice(0)) {
          tw.call('handleAppActivationViaProtocol', url);
        }
      }
    },

    /**
     * Electron-only hook — not part of the Windows API surface.
     * main.ts calls bridge.__pushDeeplink(url) from the 'open-url' /
     * 'second-instance' handlers when a whatsapp:// activation arrives.
     */
    __pushDeeplink(url: unknown) {
      const link = String(url ?? '').trim();
      if (!link) return;
      if (flushed) {
        tw.call('handleAppActivationViaProtocol', link);
      } else {
        _deeplinkBuffer.push(link);
      }
    },
  };
}

// ============================================================================
// SharesheetBridge  (catalog §SharesheetBridge)
// ToNative : shareFile(mediaFileHash, suggestedFileName) — Async (IAsyncAction)
// ToWeb    : none
// ============================================================================

function sharesheetBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  return {
    /**
     * Hand a cached media file to the OS.
     * ponytail: Linux has no native sharesheet (xdg-portal share requires D-Bus
     *           plumbing out of scope here). Falls back to opening the file in the
     *           default app. The media-cache layer must have written the file at
     *           userDataDir/media/<mediaFileHash> before this is called.
     */
    async shareFile(mediaFileHash: unknown, suggestedFileName: unknown): Promise<void> {
      // ponytail: openPath instead of OS sharesheet
      const filePath = `${ctx.userDataDir}/media/${String(mediaFileHash ?? '')}`;
      const err = await shell.openPath(filePath);
      if (err) {
        ctx.log('SharesheetBridge.shareFile: openPath failed for', suggestedFileName, '—', err);
      }
    },
  };
}

// ============================================================================
// ScalingControlBridge  (catalog §ScalingControlBridge)
// ToNative : showScalingControl(zoomFactor) — Sync
//          : subscribe(web) — Sync
// ToWeb    : zoomIn() · zoomOut()
// ============================================================================

function scalingControlBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();
  let currentZoom = 1.0;

  return {
    subscribe: tw.subscribe,

    showScalingControl(zoomFactor: unknown) {
      // ponytail: Windows shows a native DPI scaling flyout — no direct Linux equivalent.
      // Store the factor the bundle reports so __getCurrentZoom() stays coherent.
      const z = Number(zoomFactor);
      if (Number.isFinite(z) && z > 0) currentZoom = z;
      ctx.log('ScalingControlBridge.showScalingControl zoomFactor=', currentZoom);
    },

    // Hooks for main.ts accelerator bindings (Ctrl+= / Ctrl+- / Ctrl+0).
    // Wire: bridge.__zoomIn() / bridge.__zoomOut() from globalShortcut or Menu.
    __zoomIn()  { tw.call('zoomIn'); },
    __zoomOut() { tw.call('zoomOut'); },
    __getCurrentZoom() { return currentZoom; },
  };
}

// ============================================================================
// RateAppBridge  (catalog §RateAppBridge)
// ToNative : getStoreProductForCurrentAppAsync() — Async (name + return)
//          : requestRateAndReviewAppAsync()       — Async (name + return)
// ToWeb    : none
// ============================================================================

function rateAppBridge(): ReturnType<BridgeFactory> {
  return {
    /**
     * ponytail: Microsoft Store APIs are Windows-only.
     * Returns an empty JSON object so the bundle's store-product guard passes cleanly.
     */
    async getStoreProductForCurrentAppAsync(): Promise<string> {
      return '{}';
    },

    /**
     * ponytail: no Store rating dialog on Linux.
     * Returns an empty JSON object; the bundle treats missing fields as "not rated".
     */
    async requestRateAndReviewAppAsync(): Promise<string> {
      return '{}';
    },
  };
}

// ============================================================================
// LinksPreviewBridge  (catalog §LinksPreviewBridge, doc 31 §3.16)
// ToNative : getPreviewAsync(link) — Async (name-suffix + IAsyncOperation<string>)
// ToWeb    : none
// Returns  : JSON string {title, description, thumbnail?}
//            | {title: host, description: link}  (HTML parse fail)
//            | ""                                 (hard fetch error)
// ============================================================================

function linksPreviewBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  return {
    async getPreviewAsync(link: unknown): Promise<string> {
      const url = String(link ?? '').trim();
      if (!url) return '';

      let hostname = url;
      try { hostname = new URL(url).hostname; } catch { /* non-parseable url */ }
      const fallback = JSON.stringify({ title: hostname, description: url });

      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': UA_HEADER },
        });
        if (!res.ok) return '';

        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('text/html')) return fallback;

        const html = await readHead(res, HEAD_CAP);
        const { title, description, imageUrl } = parseHeadMeta(html, url);
        if (!title && !description) return fallback;

        // ponytail: no sharp resize/center-crop; thumbnail is raw base64 of the image.
        //           The Windows implementation resized to ≤168 px and center-cropped to ≤140 px.
        let thumbnail: string | null = null;
        if (imageUrl) thumbnail = await fetchImageBase64(imageUrl, ctx);

        const preview: Record<string, unknown> = { title, description };
        if (thumbnail !== null) preview.thumbnail = thumbnail;
        return JSON.stringify(preview);
      } catch (err) {
        ctx.log('LinksPreviewBridge.getPreviewAsync error for', url, '—', err);
        return '';
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Link-preview helpers (module-private)
// ---------------------------------------------------------------------------

/** Stream-read up to maxChars characters from a Fetch Response body. */
async function readHead(res: Response, maxChars: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return text.slice(0, maxChars);
  }

  const dec = new TextDecoder();
  let buf = '';
  try {
    while (buf.length < maxChars) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      buf += dec.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return buf.slice(0, maxChars);
}

/** Extract OG / Twitter Card / standard meta from an HTML fragment. */
function parseHeadMeta(
  html: string,
  pageUrl: string,
): { title: string; description: string; imageUrl: string } {
  // Prefer <head> block; fall back to full fragment.
  const headOnly = html.match(/<head[\s\S]*?>([\s\S]*?)<\/head>/i)?.[1] ?? html;

  /** Return the `content` attribute of the first <meta> matching attr=val. */
  const metaContent = (attr: string, val: string): string => {
    // Two orderings: attr/val first, or content first.
    const r1 = new RegExp(
      `<meta[^>]+${attr}=["']${val}["'][^>]+content=["']([^"'<>]+)["']`, 'i',
    ).exec(headOnly)?.[1];
    if (r1) return r1.trim();
    return (
      new RegExp(
        `<meta[^>]+content=["']([^"'<>]+)["'][^>]+${attr}=["']${val}["']`, 'i',
      ).exec(headOnly)?.[1]?.trim() ?? ''
    );
  };

  const title =
    metaContent('property', 'og:title') ||
    metaContent('name', 'twitter:title') ||
    headOnly.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ||
    '';

  const description =
    metaContent('property', 'og:description') ||
    metaContent('name', 'twitter:description') ||
    metaContent('name', 'description');

  const rawImage =
    metaContent('property', 'og:image') ||
    metaContent('name', 'twitter:image') ||
    // Fallback: favicon from <link rel="icon">
    headOnly.match(
      /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"'<>]+)["']/i,
    )?.[1] ||
    headOnly.match(
      /<link[^>]+href=["']([^"'<>]+)["'][^>]+rel=["'](?:shortcut )?icon["']/i,
    )?.[1] ||
    '';

  let imageUrl = '';
  if (rawImage) {
    try { imageUrl = new URL(rawImage, pageUrl).href; } catch { imageUrl = rawImage; }
  }

  return { title, description, imageUrl };
}

/**
 * Fetch an image URL and return its bytes as a base64 string, or null on failure.
 * ponytail: no resize/crop — Windows resized to ≤168 px; we return the raw image.
 */
async function fetchImageBase64(imageUrl: string, ctx: BridgeContext): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': UA_HEADER },
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab).toString('base64');
  } catch (err) {
    ctx.log('LinksPreviewBridge: thumbnail fetch failed for', imageUrl, '—', err);
    return null;
  }
}

// ============================================================================
// Export
// ============================================================================

export const bridges: Record<string, BridgeFactory> = {
  AppActivationBridge:    ()    => appActivationBridge(),
  SharesheetBridge:       (ctx) => sharesheetBridge(ctx),
  ScalingControlBridge:   (ctx) => scalingControlBridge(ctx),
  RateAppBridge:          ()    => rateAppBridge(),
  LinksPreviewBridge:     (ctx) => linksPreviewBridge(ctx),
};
