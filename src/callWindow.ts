// Call window: a second BrowserWindow running plain web.whatsapp.com on its own
// Electron session partition ('persist:wa-call').  Logs in as a SEPARATE linked
// device from the hybrid window, giving real WASM-backed WhatsApp calling while
// the hybrid window's native bridges continue to work.
//
// Kept in its own module to avoid a circular-import chain:
//   main.ts → bridge/registry.ts → impl/voip.ts → callWindow.ts (no back-edge)

import { app, BrowserWindow, session, shell } from 'electron';
import { appIcon } from './icon';
import { WA_ORIGIN, WA_HOST_ORIGIN, cleanUserAgent } from './waConfig';

export const CALL_PARTITION = 'persist:wa-call';

// Page shims injected into the call window's main frame AND the call popout:
//  (1) Report mic/camera as granted — Electron auto-grants getUserMedia, but has
//      no address-bar permission UI for WA's pre-call permission check to point at.
//  (2) Force the web-calling AB props on so the call button renders (default is
//      server-gated off).  Version-coupled to the bundle's module system (doc 43 §6 Phase 3).
const CALL_SHIMS_JS = `(() => {
  if (window.__waCallShims) return;
  window.__waCallShims = true;
  if (navigator.permissions && navigator.permissions.query) {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && (d.name === 'microphone' || d.name === 'camera'))
      ? Promise.resolve({ state: 'granted', onchange: null, addEventListener(){}, removeEventListener(){} })
      : orig(d);
  }
  const req = window.requireLazy;
  if (!req) return;
  const FORCE = { enable_web_calling: true, enable_web_group_calling: true };
  let tries = 0;
  const tick = () => {
    try {
      req(['WAWebABProps'], (AB) => {
        if (!AB || typeof AB.setGetABPropConfigValueImpl !== 'function') { if (++tries < 30) setTimeout(tick, 1000); return; }
        let inHook = false;
        const orig = AB.getABPropConfigValue ? AB.getABPropConfigValue.bind(AB) : null;
        AB.setGetABPropConfigValueImpl((key) => {
          if (key in FORCE) return FORCE[key];
          if (inHook || !orig) return undefined;
          inHook = true; try { return orig(key); } finally { inHook = false; }
        });
      });
    } catch (e) { if (++tries < 30) setTimeout(tick, 1000); }
  };
  tick();
})()`;

function installCallShims(target: Electron.WebContents): void {
  target.on('dom-ready', () => { target.executeJavaScript(CALL_SHIMS_JS).catch(() => undefined); });
}

let callWindow: BrowserWindow | null = null;
let quitting = false;
app.on('before-quit', () => { quitting = true; });

/**
 * Raise the call window to the foreground if it already exists.
 * No-op when the window has not been created yet (user hasn't paired it).
 * Safe to call from any main-process module (e.g. voip.ts on incoming call).
 */
export function showCallWindow(): void {
  if (!callWindow || callWindow.isDestroyed()) return;
  if (callWindow.isMinimized()) callWindow.restore();
  callWindow.show();
  callWindow.focus();
  callWindow.moveTop();
}

/**
 * Create the call window (lazy) or bring it into focus if already open.
 * Called from the "Calling" tray menu item.
 */
export function createCallWindow(): void {
  if (callWindow && !callWindow.isDestroyed()) {
    showCallWindow();
    return;
  }

  const callSession = session.fromPartition(CALL_PARTITION);
  const userAgent = cleanUserAgent(callSession.getUserAgent());
  callSession.setUserAgent(userAgent);

  // All permission handlers are scoped to this partition's session, completely
  // independent of the default session used by the hybrid main window.
  callSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'notifications' ||
      permission === 'media' ||
      permission === 'clipboard-sanitized-write',
    );
  });
  // Let the call window enumerate and open mic/cam devices (getUserMedia with a
  // deviceId goes through this handler, separate from the request handler above).
  callSession.setDevicePermissionHandler(() => true);
  // Always allow media permissions: a `media` check uses requestingOrigin, which
  // can be empty/differ for capture frames/workers, and a denied check makes
  // getUserMedia return a silent track instead of a real mic (electron#23792).
  callSession.setPermissionCheckHandler((_wc, permission, origin) => {
    if (['media', 'microphone', 'camera', 'speaker-selection'].includes(permission)) return true;
    return origin === WA_HOST_ORIGIN;
  });

  callWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    icon: appIcon(),
    webPreferences: {
      // No preload: plain-web mode.  The call window must NOT receive the hybrid
      // bridge surface — giving it the preload would inject chrome.webview hostObjects
      // and make the bundle try windows-hybrid code paths (white screen / QR loop).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: callSession,
    },
  });

  const wc = callWindow.webContents;

  // Allow same-origin WA popouts (the call popout opened as window.open("[sw] popout")),
  // block and externalize everything else.  Don't override webPreferences for the
  // popout: an explicit set can spawn it in a fresh context, severing window.opener
  // (which the /call/popout frame needs).  Electron 42 defaults are already secure.
  wc.setWindowOpenHandler(({ url }) => {
    let sameOriginWa = false;
    try { sameOriginWa = new URL(url).origin === WA_HOST_ORIGIN; } catch { /* about:blank etc. */ }
    if (sameOriginWa || url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 480, height: 720, autoHideMenuBar: true } };
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  installCallShims(wc);

  wc.on('did-create-window', (win) => {
    // Give the call popout the same shims so its mic-permission gate clears and
    // the call button/engine work there too.
    installCallShims(win.webContents);
    // Auto-close the popout when the call ends.  WhatsApp doesn't reliably call
    // window.close() in Electron, so it lingers showing a dark dead call screen.
    // Its title is "WhatsApp call" during the call; once it reverts to the idle
    // "WhatsApp" title the call is over — close it.
    let wasCall = false;
    win.webContents.on('page-title-updated', (_e, title) => {
      if (/\bcall\b/i.test(title)) { wasCall = true; return; }
      if (wasCall && /^whatsapp\b/i.test(title) && !win.isDestroyed()) win.close();
    });
  });

  // Close button hides to tray rather than quitting (consistent with the hybrid window).
  callWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      callWindow?.hide();
    }
  });

  wc.on('did-finish-load', () => {
    console.log('[call-window] loaded:', wc.getURL());
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[call-window] did-fail-load:', code, desc, url);
  });

  callWindow.loadURL(WA_ORIGIN, { userAgent });
}
