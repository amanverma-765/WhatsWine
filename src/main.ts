import { app, BrowserWindow, WebContentsView, session, shell, Tray, Menu } from 'electron';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import started from 'electron-squirrel-startup';
import { appIcon } from './icon';
import { installSoundPlayer } from './sound';
import { registerMainWindow, registerHybridView, showMainWindow } from './window';
import { installBridges } from './bridge/registry';
import { WA_ORIGIN, WA_HOST_ORIGIN, WA_BG, cleanUserAgent } from './waConfig';
import { createCallView, hideCallLayer, logoutCallLayer, isCallViewReparented } from './callView';
import { watchCallStatus, openCallLinkingWindow } from './callOnboarding';

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

// SharedArrayBuffer is needed by the call window's WASM voip stack and is
// harmless for the hybrid window. AudioServiceSandbox causes the OS mic to be
// unreachable under PulseAudio/PipeWire on Linux (getUserMedia returns a silent
// zeros track instead of failing — electron#23792). Apply both unconditionally.
// WebRTCPipeWireCapturer routes screen capture through the xdg-desktop-portal PipeWire
// screencast on Wayland (doc 41 §363). A second appendSwitch('enable-features', …) would
// replace, not merge — so keep both features in one comma list.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer,WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
// Use the native Wayland backend when running under a Wayland compositor, X11 otherwise.
// Without this Electron runs as an X11 client under XWayland, where GNOME/KDE block X11
// screen capture → getDisplayMedia returns black frames. `auto` matches Chrome's default.
// ponytail: `auto` is the documented safe value; gate behind an env var only if it regresses
// existing window rendering on some compositor.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

function buildUrl(): string {
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

// Whether a calling device is currently linked (starts false — same tray item as unlinked).
// Drives the single conditional calling tray item; updated by watchCallStatus.
let callingLinked = false;

// One calling entry, conditional on link state (consistent Link/Unlink wording). The call layer
// is never shown as a surface; "Link" only shows the device's QR screen to enable/re-enable calling.
function callingTrayItem(): Electron.MenuItemConstructorOptions {
  return callingLinked
    ? { label: 'Unlink calling device', click: () => { logoutCallLayer().catch(() => undefined); } }
    : { label: 'Link calling device', click: () => { if (mainWindow) openCallLinkingWindow(mainWindow).catch(() => undefined); } };
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // Show WhatsApp must also drop the call layer — otherwise it stays painted
      // on top and raising the window reveals nothing new.
      { label: 'Show WhatsApp', click: () => { hideCallLayer(); showWindow(); } },
      callingTrayItem(),
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
}

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip('WhatsApp');
  refreshTrayMenu();
  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else { hideCallLayer(); showWindow(); }
  });
}

const createWindow = () => {
  const userAgent = cleanUserAgent(session.defaultSession.getUserAgent());
  session.defaultSession.setUserAgent(userAgent);

  // The hybrid shell sends a per-request version header (doc 31 §3.5).
  // X-WA-WebView2-Version is a windows-hybrid signal; it must only reach the
  // default session (hybrid window). The call window uses its own partition.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    if (details.url.startsWith(WA_ORIGIN)) {
      details.requestHeaders['X-WA-WebView2-Version'] = WEBVIEW2_VERSION;
    }
    cb({ requestHeaders: details.requestHeaders });
  });

  // WhatsApp needs notifications (native toasts) and clipboard write access.
  // Media (mic/camera) is not needed for the hybrid window — calling goes through
  // the separate call window partition.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'notifications' ||
      permission === 'media' ||
      permission === 'clipboard-sanitized-write',
    );
  });
  // CRITICAL: WA Web rolls back a successful login if it can't make storage persistent
  // ("aquire-persistent-storage-denied"). The Windows client force-grants it; mirror that
  // so navigator.storage.persist() succeeds and the session sticks. Gate to WA origin only.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    return origin === WA_HOST_ORIGIN;
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    icon: appIcon(),
    backgroundColor: WA_BG,   // shown behind the views before first paint
  });

  registerMainWindow(mainWindow);

  // Single-window layering: the hybrid chat view fills the window as the base
  // layer; the call view (created warm-but-hidden below) stacks on top and is
  // shown only during a call. Each view is its own WebContents with its own
  // session — the hybrid keeps the preload + native bridges; the call layer is
  // plain web on its own partition.
  const hybridView = new WebContentsView({
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
  mainWindow.contentView.addChildView(hybridView);

  const wc = hybridView.webContents;
  registerHybridView(wc);   // so notification clicks can open chats in the primary window

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

  // Open external links / window.open targets in the OS browser, never in-app.
  // The hybrid window never needs in-app WA popouts (that's the call window's job).
  // Never let the top frame navigate off web.whatsapp.com — the permission grants
  // are origin-gated to WA, so a foreign page here would be in-app phishing.
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Keep the native-context query string on every top-level (re)navigation to the WA
  // root, mirroring AlwaysUseArgumentsForDocumentRequested (doc 31 §3.5).
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
  wc.on('will-navigate', reassertParams);
  wc.on('will-redirect', reassertParams);

  wc.on('page-title-updated', (_e, title) => updateUnread(title));

  // Inject the WhatsApp notification-tone player into the WA page on every load
  // (idempotent self-guard). The native SystemIntegrations.playTone bridge triggers
  // it from the main process (src/sound.ts).
  wc.on('dom-ready', () => { installSoundPlayer(wc); });

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

  wc.loadURL(buildUrl(), { userAgent });

  // Stack the warm-but-hidden call layer on top, then keep both views sized to
  // the window's content area on every resize/maximize.
  const win = mainWindow;
  const callView = createCallView(win);
  const layout = () => {
    const { width, height } = win.getContentBounds();
    hybridView.setBounds({ x: 0, y: 0, width, height });
    // While the link window borrows the call view, ITS resize handler owns the bounds —
    // setBounds is parent-relative, so sizing to the main window would blow up the QR.
    if (!isCallViewReparented()) callView.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on('resize', layout);

  // Live calling-device status banner (Enable prompt when unlinked, connect/reconnect/offline
  // status when linked) — self-waits for the hybrid login. Skipped under the headless smokes.
  if (!process.env.HYBRID_SMOKE && !process.env.M0_SMOKE) {
    watchCallStatus(win, wc, (status) => {
      if (status === 'loading') return;   // unknown — keep the current tray item
      const linked = status !== 'unlinked';
      if (linked !== callingLinked) { callingLinked = linked; refreshTrayMenu(); }
    }).catch(() => undefined);
  }

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
  installBridges();
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
