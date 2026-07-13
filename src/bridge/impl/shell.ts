// Shell / miscellaneous bridges for the WhatsApp Windows-hybrid Electron port.
// Implements: AppActivationBridge, SharesheetBridge, ScalingControlBridge,
//             RateAppBridge, LinksPreviewBridge.
// Doc refs: bridge-catalog §AppActivation–LinksPreview, docs/30 §3.5, docs/31 §3.16.

import { shell, app } from 'electron';
import path from 'node:path';
import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';
import type { BridgeFactory, BridgeContext } from '../types';
import { toWeb } from '../eventtarget';

const APP_VERSION = app.getVersion();
const UA_HEADER = `WhatsApp/${APP_VERSION} W`;
const HEAD_CAP = 102_400;        // max chars of HTML to read (catalog §LinksPreviewBridge)
const FETCH_TIMEOUT_MS = 5_000;  // 5 s budget per catalog
const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // cap preview-image fetch to avoid memory-exhaustion DoS

// ============================================================================
// AppActivationBridge  (catalog §AppActivationBridge, doc 30 §3.5)
// ToNative : subscribe(web) — Sync.
// ToWeb    : handleAppActivationViaProtocol(url: string)
// ============================================================================

function appActivationBridge(): ReturnType<BridgeFactory> {
  // The bundle subscribes for whatsapp:// deeplink delivery.
  // ponytail: no deeplink source is wired (no setAsDefaultProtocolClient / 'open-url'
  // handler in main.ts), so this only needs to accept the subscription. To add
  // deeplinks later, call tw.call('handleAppActivationViaProtocol', url) from main.ts.
  const tw = toWeb();
  return { subscribe: tw.subscribe };
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
      // path.basename strips any ../ or absolute path the (untrusted) page supplies,
      // and the containment check keeps the open inside userDataDir/media.
      const mediaDir = path.join(ctx.userDataDir, 'media');
      const filePath = path.join(mediaDir, path.basename(String(mediaFileHash ?? '')));
      if (!filePath.startsWith(mediaDir + path.sep)) return;
      const err = await shell.openPath(filePath);
      if (err) {
        ctx.log('SharesheetBridge.shareFile: openPath failed for', suggestedFileName, '—', err);
      }
    },
  };
}

// ============================================================================
// ScalingControlBridge  (catalog §ScalingControlBridge)
// ToNative : showScalingControl(zoomFactor) — Sync · subscribe(web) — Sync
// ToWeb    : zoomIn() · zoomOut()
// ============================================================================

function scalingControlBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();
  return {
    subscribe: tw.subscribe,
    showScalingControl(zoomFactor: unknown) {
      // ponytail: Windows shows a native DPI scaling flyout — no Linux equivalent; just log.
      ctx.log('ScalingControlBridge.showScalingControl zoomFactor=', Number(zoomFactor));
    },
  };
}

// ============================================================================
// RateAppBridge  (catalog §RateAppBridge)
// ToNative : getStoreProductForCurrentAppAsync() — Async
//          : requestRateAndReviewAppAsync()       — Async
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
// ToNative : getPreviewAsync(link) — Async (IAsyncOperation<string>)
// ToWeb    : none
// Returns  : JSON string {title, description, thumbnail?}
//            | {title: host, description: link}  (HTML parse fail)
//            | ""                                 (hard fetch error / blocked)
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
        const res = await safeFetch(url, { 'User-Agent': UA_HEADER });
        if (!res || !res.ok) return '';

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

/** True for loopback/private/link-local/metadata addresses we must never fetch. */
function isBlockedIp(ip: string): boolean {
  if (net.isIP(ip) === 0) return false;
  // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1) to its IPv4 form so the v4 rules apply.
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const a = v4 ?? ip;
  return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a)
    || a === '::1' || /^f[cd]/i.test(a) || /^fe80/i.test(a);
}

/**
 * SSRF-guarded fetch for preview content. The link/og:image come from arbitrary
 * third parties via the page, so before each hop we resolve the host and refuse
 * non-http(s) schemes and private/loopback/link-local/metadata targets. Redirects
 * are followed manually (redirect:'manual') so a public host can't 302 into an
 * internal address. Returns null when blocked, unresolvable, or over the hop limit.
 */
async function safeFetch(raw: string, headers: Record<string, string>): Promise<Response | null> {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

    // Resolve EVERY address and reject if any is private/loopback/metadata, then PIN the
    // socket to the vetted IP. Node's fetch (undici) otherwise re-resolves DNS at connect
    // time — a separate lookup from this one — so a check-then-connect gap let an attacker
    // controlling the hostname's DNS return a public IP here and a private one to the socket
    // (DNS rebinding). Pinning closes that gap: the address we validated is the one connected.
    let addrs: LookupAddress[];
    try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { return null; }
    if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) return null;
    const pinned = addrs[0];
    // ponytail: one short-lived Agent per hop; not explicitly closed — the response body is
    // read after safeFetch returns, and undici reclaims idle sockets on its keep-alive timeout.
    const dispatcher = new Agent({
      connect: { lookup: (_h, _o, cb) => cb(null, [{ address: pinned.address, family: pinned.family }]) },
    });

    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers,
      redirect: 'manual',
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      try { url = new URL(loc, url).href; } catch { return null; }
      continue;
    }
    return res;
  }
  return null; // too many redirects
}

/** Read a response body, aborting past `cap` bytes; null if it exceeds the cap. */
async function readBytesCapped(res: Response, cap: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > cap) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

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
 * Fetch an image URL (SSRF-guarded, size-capped) and return its bytes as base64,
 * or null on failure.
 * ponytail: no resize/crop — Windows resized to ≤168 px; we return the raw image.
 */
async function fetchImageBase64(imageUrl: string, ctx: BridgeContext): Promise<string | null> {
  try {
    const res = await safeFetch(imageUrl, { 'User-Agent': UA_HEADER });
    if (!res || !res.ok) return null;
    const bytes = await readBytesCapped(res, MAX_IMAGE_BYTES);
    return bytes ? bytes.toString('base64') : null;
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
