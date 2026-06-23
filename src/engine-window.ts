// Call window (dual-window approach — see analysis/docs/99). A SEPARATE, VISIBLE plain-web
// WhatsApp window that is its OWN logged-in web device (own QR, scanned once; login persists).
// A real web-identity session = the server ships the web voip bundle, so calls work in WhatsApp's
// own native web call UI (ring/accept/mute/video/end) with real PJSIP/Opus media — none of which
// the ?windows=1 hybrid can do. The hybrid stays the main chat window; this window handles calls.
//
// No bridging into the hybrid: the engine is a plain WhatsApp Web client. The only hook is
// raiseCallWindow(), which the hybrid's VoipSignalingBridge calls to surface this window when a
// call comes in.

import { BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';

const WA_ORIGIN = 'https://web.whatsapp.com/';
const WA_HOST_ORIGIN = new URL(WA_ORIGIN).origin;
// Persistent partition → its own logged-in web device, login survives restarts (one-time QR).
const ENGINE_PARTITION = 'persist:wa-engine';

let engineWindow: BrowserWindow | null = null;
let ipcInstalled = false;

export function isEngineReady(): boolean { return engineWindow !== null && !engineWindow.isDestroyed(); }

// Surface the call window (called by the hybrid on an incoming offer so the user doesn't miss it).
export function raiseCallWindow(): void {
  if (!engineWindow || engineWindow.isDestroyed()) return;
  if (engineWindow.isMinimized()) engineWindow.restore();
  engineWindow.show();
  engineWindow.focus();
}

// Grant mic/cam to the Permissions API + force web-calling AB props on so the voip module inits.
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

export function createEngineWindow(): void {
  if (engineWindow) return;
  installEngineIpc();

  // Its OWN session (not the hybrid's defaultSession), so the server sees a plain web client and
  // serves the web voip bundle. Configure it independently — defaultSession's config doesn't apply.
  const engineSession = session.fromPartition(ENGINE_PARTITION);
  const userAgent = engineSession.getUserAgent()
    .replace(/ Electron\/[^ ]+/, '').replace(/ WhatsWine\/[^ ]+/, '');
  engineSession.setUserAgent(userAgent);

  engineSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'notifications' || permission === 'media' || permission === 'clipboard-sanitized-write'));
  engineSession.setDevicePermissionHandler(() => true);
  engineSession.setPermissionCheckHandler((_wc, permission, origin) =>
    ['media', 'microphone', 'camera', 'speaker-selection'].includes(permission) || origin === WA_HOST_ORIGIN);

  engineWindow = new BrowserWindow({
    width: 1000, height: 760,
    show: false,
    title: 'WhatsWine — Calls',
    webPreferences: {
      preload: path.join(__dirname, 'engine-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: ENGINE_PARTITION,
      backgroundThrottling: false,
    },
  });

  // Visible: this is the user's call window (QR on first run, then WhatsApp's native call UI).
  engineWindow.show();

  const wc = engineWindow.webContents;
  wc.on('did-finish-load', () => console.log('[call-window] page loaded:', wc.getURL()));

  // WA checks navigator.storage.persist() at boot.
  try {
    wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Browser.setPermission', { permission: { name: 'persistent-storage' }, setting: 'granted', origin: WA_ORIGIN })
      .catch((e: unknown) => console.error('[call-window] persistent-storage grant failed:', e))
      .finally(() => { try { wc.debugger.detach(); } catch { /* detached */ } });
  } catch (e) { console.error('[call-window] debugger attach failed:', e); }

  wc.on('dom-ready', () => { wc.executeJavaScript(CALL_SHIMS_JS).catch(() => undefined); });
  wc.on('did-fail-load', (_e, code, desc, url) => console.error('[call-window] did-fail-load:', code, desc, url));
  if (process.env.WA_BRIDGE_DEBUG) {
    wc.on('console-message', (_e, level, message) => { if (level >= 1) console.log(`[call-window-console:${level}] ${message}`.slice(0, 1200)); });
  }
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Don't destroy on close — hide and keep the session/login alive.
  engineWindow.on('close', (e) => { e.preventDefault(); engineWindow?.hide(); });

  engineWindow.loadURL(WA_ORIGIN, { userAgent });   // plain web → web voip bundle
  console.log('[call-window] created (own persistent web session; scan its QR once)');
}

function installEngineIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  ipcMain.on('wa-engine:log', (_e, msg: unknown) => { if (process.env.WA_BRIDGE_DEBUG) console.log('[call-window]', msg); });
}
