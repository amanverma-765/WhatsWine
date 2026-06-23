import { app, BrowserWindow, session, shell, Tray, Menu } from 'electron';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import started from 'electron-squirrel-startup';
import { appIcon } from './icon';
import { installSoundPlayer } from './sound';
import { installRingtone } from './ringtone';
import { showMainWindow } from './window';
import { installBridges } from './bridge/registry';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Windows-HYBRID port (docs 90 §M0, 31 §3.5): load the real WA Web bundle from
// the SAME remote origin the native client uses, but with the native-context
// query string so the bundle takes its `win_hybrid` code paths and calls our
// `window.chrome.webview.hostObjects.*` native bridges (installed in
// src/bridge/). `windows=1` is load-bearing — without it the bundle stays in
// plain web mode and never touches the bridges.
const WA_ORIGIN = 'https://web.whatsapp.com/';
const WA_HOST_ORIGIN = new URL(WA_ORIGIN).origin;   // 'https://web.whatsapp.com'

// The bundle reads `windowsBuild` as `quaternary: Number(windowsBuild)` of the
// ClientPayload UserAgent.appVersion (UINT32) — so it MUST be a single integer,
// NOT a dotted version. Number('2.2623.103.0')===NaN throws "must be an int" and
// the login socket closes 1006 (QR never loads). The web app's primary/secondary/
// tertiary come from the served bundle; quaternary is just the Windows build tag.
// ponytail: bump WINDOWS_BUILD if WA ever server-gates an old hybrid build.
const WINDOWS_BUILD = '2623103';          // -> appVersion.quaternary (uint32); WhatsApp Windows 2.2623.103.0
const HYBRID_BUILD_TYPE = 'Production';
const OS_BUILD = '22631';
// A real WebView2/Edge version string for the request header (not parsed as int).
const WEBVIEW2_VERSION = '120.0.2210.144';

// CALL MODE (WA_CALL_MODE=1): run the session as PLAIN WEB (no windows params) so the bundle binds
// its own in-browser WASM voip stack and real WhatsApp calling works (doc 43). This is a SEPARATE
// mode from the native hybrid app: the two are mutually exclusive in one session (the WASM voip
// stack isn't loadable under ?windows=1), so call mode skips the native host-object bridges and
// runs from its own profile (effectively a separate linked device).
const CALL_MODE = process.env.WA_CALL_MODE === '1';

if (CALL_MODE) {
  app.setPath('userData', path.join(app.getPath('appData'), 'whatswine-call'));
  // SharedArrayBuffer safety net for the WASM voip gate. We do NOT force COOP ourselves — WhatsApp
  // serves the COOP/COEP that makes the page crossOriginIsolated, and forcing it from the shell
  // severs the call popout's window.opener so the popout renders blank (doc 43 §4).
  app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
  // Linux: the Chromium audio-service sandbox often can't reach PulseAudio/PipeWire, so the OS mic
  // never opens and getUserMedia hands back a silent zeros track instead of failing (electron#23792).
  app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
}

function buildUrl(): string {
  if (CALL_MODE) return WA_ORIGIN;   // plain web => WAWebEnvironment.isWindows === false => WASM voip stack
  const p = new URLSearchParams({
    windows: '1',
    windowsBuild: WINDOWS_BUILD,
    windowsBuildType: HYBRID_BUILD_TYPE,
    bridgeError: '1',
    launchContext: 'unknown',
    osBuild: OS_BUILD,
  });
  return `${WA_ORIGIN}?${p.toString()}`;
}

// WhatsApp Web rejects/deprecates unknown user agents; drop the `Electron` token
// and the app-name token (e.g. "WhatsWine/1.0.0") so it sees a vanilla Chrome
// (keeping the real Chromium version). Built from app.getName() so a productName
// rename can't reintroduce the "update your browser" page.
const cleanUserAgent = (ua: string) =>
  ua.replace(/ Electron\/[^ ]+/, '').replace(new RegExp(` ${app.getName()}/[^ ]+`), '');

// Page shims for call mode, injected into the main window AND the call popout:
//  (1) Report mic/camera as granted — Electron auto-grants getUserMedia, but has no address-bar
//      permission UI for WhatsApp's pre-call permission check to point at.
//  (2) Force the web-calling AB props on so the call button renders (default is server-gated off).
//      Best-effort and version-coupled to the bundle's module system (doc 43 §6 Phase 3).
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

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Single-instance: a second launch focuses the existing window instead of opening a copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => showWindow());

const showWindow = showMainWindow;

// Unread badge + tray tooltip from the tab title ("(N) WhatsApp"). No bridge needed.
function updateUnread(title: string) {
  const m = title.match(/\((\d+)\)/);
  const count = m ? Number(m[1]) : 0;
  app.setBadgeCount(count);
  tray?.setToolTip(count > 0 ? `WhatsApp — ${count} unread` : 'WhatsApp');
}

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip('WhatsApp');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show WhatsApp', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showWindow();
  });
}

const createWindow = () => {
  const userAgent = cleanUserAgent(session.defaultSession.getUserAgent());
  session.defaultSession.setUserAgent(userAgent);

  // The hybrid shell sends a per-request version header (doc 31 §3.5). Not in call mode —
  // X-WA-WebView2-Version is a windows-hybrid signal, and sending it makes WA serve the hybrid
  // bundle into the plain-web page (white screen).
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    if (!CALL_MODE && details.url.startsWith(WA_ORIGIN)) {
      details.requestHeaders['X-WA-WebView2-Version'] = WEBVIEW2_VERSION;
    }
    cb({ requestHeaders: details.requestHeaders });
  });

  // WhatsApp needs notifications (native toasts) + media (mic/camera for voice/video calls).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'notifications' ||
      permission === 'media' ||
      permission === 'clipboard-sanitized-write',
    );
  });
  if (CALL_MODE) {
    // Let the call window open mic/cam devices (getUserMedia with a deviceId goes through this,
    // separate from the request handler above).
    session.defaultSession.setDevicePermissionHandler(() => true);
  }
  // CRITICAL: WA Web rolls back a successful login if it can't make storage persistent
  // ("aquire-persistent-storage-denied"). The Windows client force-grants it; mirror that so
  // navigator.storage.persist() succeeds and the session sticks. Gate to the WA origin only.
  // In call mode also always allow media: a `media` check uses requestingOrigin, which can be
  // empty/differ for the capture frame/worker, and a denied check makes getUserMedia return a
  // silent track (electron#23792).
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    if (CALL_MODE && ['media', 'microphone', 'camera', 'speaker-selection'].includes(permission)) return true;
    return origin === WA_HOST_ORIGIN;
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Remote content: keep it walled off from Node/Electron internals. The bridge
      // surface is injected into the page's main world from preload via the
      // contextBridge — isolation stays on.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const wc = mainWindow.webContents;

  // Force-grant persistent storage via CDP, exactly like the Windows client's
  // ForcePersistentStoragePermission (doc 31 §3.3) — belt-and-suspenders with the
  // permission-check handler above. Without it WA Web rolls back login.
  try {
    wc.debugger.attach('1.3');
    wc.debugger
      .sendCommand('Browser.setPermission', {
        permission: { name: 'persistent-storage' },
        setting: 'granted',
        origin: WA_ORIGIN,
      })
      .catch((e) => console.error('[hybrid] persistent-storage grant failed:', e))
      // One-shot grant — don't leave the CDP session attached for the window's life.
      .finally(() => { try { wc.debugger.detach(); } catch { /* already detached */ } });
  } catch (e) {
    console.error('[hybrid] debugger attach failed:', e);
  }

  // Surface the bundle's own console + uncaught errors + socket attempts when
  // diagnosing — a stuck QR usually logs why. Gated so production stays quiet.
  if (process.env.WA_BRIDGE_DEBUG || process.env.HYBRID_SMOKE) {
    wc.on('console-message', (_e, level, message) => {
      if (level >= 1) console.log(`[wa-console:${level}] ${message}`.slice(0, 1000));
    });
    wc.on('dom-ready', () => {
      wc.executeJavaScript(`(() => {
        if (window.__waDiag) return; window.__waDiag = [];
        const push = (s) => { window.__waDiag.push(String(s).slice(0,600)); };
        window.addEventListener('error', e => push('ONERROR ' + (e.error && e.error.stack || e.message)));
        window.addEventListener('unhandledrejection', e => push('REJECT ' + (e.reason && e.reason.stack || e.reason)));
        const OW = window.WebSocket;
        window.WebSocket = function(url, p){ push('WS-OPEN ' + url); const w = new OW(url, p);
          w.addEventListener('error', () => push('WS-ERROR ' + url));
          w.addEventListener('close', e => push('WS-CLOSE ' + url + ' code=' + e.code)); return w; };
        window.WebSocket.prototype = OW.prototype;
      })()`).catch(() => undefined);
    });
  }

  // Open external links / window.open targets in the OS browser, never in-app — EXCEPT the call
  // popout, which WhatsApp opens as a same-origin window.open ("[sw] popout"). In call mode, allow
  // same-origin WA popups in-app so the call window can open; deny + externalize everything else.
  // Don't override webPreferences for the popout: an explicit set can spawn it in a fresh context,
  // severing window.opener (which /call/popout needs). Electron 42 defaults are already secure.
  wc.setWindowOpenHandler(({ url }) => {
    let sameOriginWa = false;
    try { sameOriginWa = new URL(url).origin === WA_HOST_ORIGIN; } catch { /* about:blank etc. */ }
    if (CALL_MODE && (sameOriginWa || url === 'about:blank' || url === '')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 480, height: 720, autoHideMenuBar: true } };
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Keep the native-context query string on every top-level (re)navigation to the WA root,
  // mirroring AlwaysUseArgumentsForDocumentRequested (doc 31 §3.5). Skipped in call mode:
  // buildUrl() has no `windows` param there, so this would reload forever.
  const reassertParams = (e: { url: string; preventDefault: () => void }) => {
    try {
      const u = new URL(e.url);
      // Never let the top frame navigate off web.whatsapp.com — the permission grants
      // are origin-gated to WA, so a foreign page here would be in-app phishing.
      // External links already open in the OS browser via setWindowOpenHandler.
      if (u.origin !== WA_HOST_ORIGIN) { e.preventDefault(); return; }
      if (u.pathname === '/' && !u.searchParams.has('windows')) {
        e.preventDefault();
        wc.loadURL(buildUrl(), { userAgent });
      }
    } catch { /* ignore non-URL navigations */ }
  };
  if (!CALL_MODE) {
    wc.on('will-navigate', reassertParams);
    wc.on('will-redirect', reassertParams);
  }

  wc.on('page-title-updated', (_e, title) => updateUnread(title));

  // Inject the WhatsApp notification-tone player into the WA page on every load
  // (idempotent self-guard). The native SystemIntegrations.playTone bridge triggers
  // it from the main process (src/sound.ts).
  wc.on('dom-ready', () => { installSoundPlayer(wc); installRingtone(wc); });

  if (CALL_MODE) {
    installCallShims(wc);
    wc.on('did-create-window', (win) => {
      // The call popout is a separate webContents (allowed above) — give it the same shims so its
      // mic-permission gate clears and the call button/engine work there too.
      installCallShims(win.webContents);
      // Auto-close the popout when the call ends. WhatsApp doesn't reliably window.close() it in
      // Electron, so it lingers showing a dark dead call screen. Its title is "WhatsApp call"
      // during the call; once it reverts to the idle "WhatsApp" title, the call is over — close it.
      let wasCall = false;
      win.webContents.on('page-title-updated', (_e, title) => {
        if (/\bcall\b/i.test(title)) { wasCall = true; return; }
        if (wasCall && /^whatsapp\b/i.test(title) && !win.isDestroyed()) win.close();
      });
    });
  }

  // Close button hides to tray instead of quitting (real quit via tray / before-quit).
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  wc.on('did-finish-load', () => {
    console.log('[hybrid] loaded:', wc.getURL(), '| title:', JSON.stringify(wc.getTitle()));
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[hybrid] did-fail-load:', code, desc, url);
  });

  mainWindow.loadURL(buildUrl(), { userAgent });

  if (process.env.HYBRID_SMOKE) runHybridSmoke(wc);
  else if (process.env.M0_SMOKE) runWebSmoke(wc);
};

// Verify the seam end-to-end: the page sees hostObjects, and a SQL command
// round-trips through the real SQLiteBridge (preload Proxy -> IPC -> registry ->
// better-sqlite3). Logs a single PASS/FAIL line + screenshot, then quits.
function runHybridSmoke(wc: Electron.WebContents) {
  wc.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const res = await wc.executeJavaScript(`(async () => {
          const ho = window.chrome && window.chrome.webview && window.chrome.webview.hostObjects;
          if (!ho) return { ok:false, why:'no hostObjects' };
          const sql = ho.SQLiteBridge;
          await sql.executeSqliteAsync([['DROP TABLE IF EXISTS t']]);
          await sql.executeSqliteAsync([['CREATE TABLE t(x)']]);
          await sql.executeSqliteAsync([['INSERT INTO t(x) VALUES (?)', 42]]);
          const r = await sql.executeSqliteAsync([['SELECT x FROM t']]);
          const syncProbe = window.chrome.webview.hostObjects.sync.DebugFeaturesBridge.isDebugBuild();
          return { ok:true, cols:r[0].ColumnNames, rows:r[0].Rows, syncProbe };
        })()`);
        const img = await wc.capturePage();
        writeFileSync(process.env.HYBRID_SHOT ?? '/tmp/hybrid_shot.png', img.toPNG());
        const pass = res && res.ok && JSON.stringify(res.rows) === '[[42]]';
        console.log(`[hybrid] SMOKE ${pass ? 'PASS' : 'FAIL'} |`, JSON.stringify(res), '| tray:', !!tray);
      } catch (e) {
        console.error('[hybrid] SMOKE FAIL:', e);
      }
      isQuitting = true;
      app.quit();
    }, Number(process.env.HYBRID_SMOKE_MS ?? 12000));
  });
}

function runWebSmoke(wc: Electron.WebContents) {
  wc.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await wc.capturePage();
        writeFileSync(process.env.M0_SHOT ?? '/tmp/m0_shot.png', img.toPNG());
        const diag = await wc.executeJavaScript('JSON.stringify(window.__waDiag || [])').catch(() => '[]');
        console.log('[hybrid] DIAG', diag);
        console.log('[hybrid] web smoke ok | tray:', !!tray, '| title:', wc.getTitle());
      } catch (e) {
        console.error('[hybrid] screenshot failed:', e);
      }
      isQuitting = true;
      app.quit();
    }, Number(process.env.M0_SMOKE_MS ?? 12000));
  });
}

app.on('before-quit', () => { isQuitting = true; });

app.on('ready', () => {
  // Call mode is plain-web, so the native host-object bridges are unused — skip them (doc 43 §6).
  if (!CALL_MODE) installBridges();
  createWindow();
  createTray();
});

// With a tray the app keeps running when the window is hidden; quit only on explicit Quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    showWindow();
  }
});
