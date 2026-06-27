// "Enable calling" onboarding.  The call-layer view (persist:wa-call, callView.ts) is a
// SEPARATE linked device that rings + runs the WASM voip engine, but it is created hidden
// and the "never leak the web UI" rework removed every path that made it visible — so its
// QR link screen was never shown and the device was never linked (calling silently dead on
// a fresh install).  This module is the deliberate, one-time link step: it borrows the warm
// call view into a dedicated "Link calling device" window, shows ONLY its QR screen, and
// hides it the instant login completes (#pane-side appears) so the call/chat surface never
// leaks into the main window.  The partition persists the link, so it's one-time + self-
// healing (phone unlinks → next launch re-prompts).
//
// No back-edge into main.ts — main.ts imports US (keeps the bridge import chain acyclic).

import { BrowserWindow, Notification, dialog } from 'electron';
import { getCallView } from './callView';
import { appIcon } from './icon';

type BannerSpec = { bg: string; text: string; button?: string; autoHideMs?: number };

// One green and one amber; ✓ confirmation auto-hides, problems persist.
const GREEN = '#1DA851';
const AMBER = '#b7791f';
const BANNER_SPECS: Record<string, BannerSpec | null> = {
  unlinked: { bg: GREEN, text: 'Enable calling to make & receive calls', button: 'Enable' },
  connecting: { bg: AMBER, text: 'Calling device reconnecting…' },
  offline: { bg: AMBER, text: 'Calling device offline' },
  conflict: { bg: AMBER, text: 'Calling is active on another device' },
  connected: { bg: GREEN, text: '✓ Calling connected', autoHideMs: 3000 },
  loading: null,
};

// Logged-in signal: WA Web renders the chat-list pane (#pane-side) only once linked. Same
// main-process-polls-call-view shape as callView.ts's READ_ACTIVE poll.
// ponytail: DOM signal, same drift class as the existing call automation; if it drifts the
// link window just won't auto-close (closeable by hand) — never leaks the chat surface.
const LOGGED_IN_JS = `(() => { try { return !!document.querySelector('#pane-side'); } catch (e) { return false; } })()`;

const BANNER_JS = `(() => {
  if (document.getElementById('__wwineLinkBanner')) return;
  const b = document.createElement('div');
  b.id = '__wwineLinkBanner';
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#202c33;color:#e9edef;font:13px system-ui,sans-serif;line-height:1.4;padding:10px 14px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.45)';
  b.textContent = 'Link your calling device \\u2014 on your phone open WhatsApp \\u25B8 Linked Devices \\u25B8 Link a device, then scan this code. Close this window to cancel.';
  document.documentElement.appendChild(b);
})()`;

const REMOVE_BANNER_JS = `(() => { const b = document.getElementById('__wwineLinkBanner'); if (b) b.remove(); })()`;

// ── Calling-device connection status ─────────────────────────────────────────────────────────
// Read WA's OWN authoritative connection state from the (hidden) call view, the same signal that
// drives WhatsApp's own "Connecting…/Computer not connected" banner:
//   WAWebStreamModel.Stream.mode  (StreamMode:  QR MAIN OFFLINE CONFLICT SYNCING …)
//   WAWebStreamModel.Stream.info  (StreamInfo:  NORMAL OFFLINE CONNECTING SYNCING RESUMING OPENING …)
// Both are $InternalEnum.Mirrored session values (read directly, like the bundle's Socket.state===).
// Fallback chain if Stream isn't ready yet: WAWebSocketModel.Socket.state/.stream, then #pane-side.
// Runs in the CALL view. The Enable-button action is read separately from the HYBRID page (that's
// where the banner + button live — different window object; conflating them was a real bug).
// ponytail: version-coupled to WAWebStreamModel.Stream (+ Socket fallback); a rename degrades to the
// #pane-side fallback (connected/unlinked only) — never crashes, never leaks the web UI.
const STATUS_JS = `(() => {
  const req = window.require;
  const mod = (n) => { try { return req && req(n); } catch (e) { return null; } };
  let status = 'loading';
  try {
    const SM = mod('WAWebStreamModel');
    const S = SM && SM.Stream;
    if (S && S.mode != null) {
      const mode = String(S.mode), info = String(S.info);
      if (mode === 'QR' || mode === 'PAIRING') status = 'unlinked';
      else if (mode === 'CONFLICT' || mode === 'PROXYBLOCK') status = 'conflict';
      else if (mode === 'OFFLINE' || info === 'OFFLINE') status = 'offline';
      else if (mode === 'MAIN') status = (info === 'NORMAL') ? 'connected' : 'connecting';
      else status = 'connecting';
    } else {
      const K = mod('WAWebSocketModel'), C = K && K.Socket;
      if (C && C.state != null) {
        const st = String(C.state), str = String(C.stream);
        if (st === 'UNPAIRED' || st === 'UNPAIRED_IDLE') status = 'unlinked';
        else if (st === 'CONFLICT') status = 'conflict';
        else if (st === 'CONNECTED' && str === 'CONNECTED') status = 'connected';
        else status = 'connecting';
      } else if (document.querySelector('#pane-side')) {
        status = 'connected';
      }
    }
  } catch (e) {}
  return status;
})()`;

// Create/update the single status banner in the HYBRID page from a JSON spec, or remove it when
// spec is null. The banner is fixed at the top; to PUSH WhatsApp's content down (not overlap it)
// it also offsets the stable React root #app by the bar height in lockstep — covering both a
// static (margin-top/height) and a fixed (top/height) #app layout, animated to match the slide.
// The bar is appended to <html> (outside React's <body>) so WA's SPA re-renders never wipe it.
// ponytail: 34px hard-coded to match the bar height; if the bar height changes, change both.
const applyBannerJs = (spec: BannerSpec | null): string => `(() => {
  const spec = ${JSON.stringify(spec)};
  const ID = '__wwineCallBar', SID = '__wwineBarStyle';
  const TRANS = 'transition:margin-top .35s ease,height .35s ease !important';
  const setOffset = (on) => {
    let s = document.getElementById(SID);
    if (on) {
      if (!s) { s = document.createElement('style'); s.id = SID; (document.head || document.documentElement).appendChild(s); }
      s.textContent = '#app{margin-top:34px !important;height:calc(100% - 34px) !important;box-sizing:border-box !important;' + TRANS + '}';
    } else if (s) {
      s.textContent = '#app{margin-top:0 !important;height:100% !important;' + TRANS + '}';
      setTimeout(() => { const x = document.getElementById(SID); if (x) x.remove(); }, 380);
    }
  };
  let bar = document.getElementById(ID);
  if (!spec) {
    setOffset(false);
    if (bar) { bar.style.transform = 'translateY(-100%)'; setTimeout(() => bar && bar.remove(), 350); }
    return;
  }
  setOffset(true);
  const fresh = !bar;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = ID;
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:34px;z-index:2147483647;color:#fff;font:13px/34px system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35);transform:translateY(-100%);transition:transform .35s ease';
    document.documentElement.appendChild(bar);
  }
  if (bar.dataset.spec === JSON.stringify(spec)) return;   // unchanged → no rebuild
  bar.dataset.spec = JSON.stringify(spec);
  bar.style.background = spec.bg;
  bar.textContent = spec.text;
  if (spec.button) {
    const btn = document.createElement('button');
    btn.textContent = spec.button;
    btn.style.cssText = 'position:absolute;right:8px;top:5px;height:24px;padding:0 14px;border:0;border-radius:12px;background:#fff;color:#075E54;font:600 12px system-ui,sans-serif;cursor:pointer';
    btn.onclick = () => { window.__wwineCallingAction = 'enable'; btn.disabled = true; btn.textContent = 'Opening…'; };
    bar.appendChild(btn);
  }
  if (fresh) requestAnimationFrame(() => { bar.style.transform = 'translateY(0)'; });
  else bar.style.transform = 'translateY(0)';
  if (spec.autoHideMs) setTimeout(() => {
    const b = document.getElementById(ID);
    if (b && b.dataset.spec === JSON.stringify(spec)) { setOffset(false); b.style.transform = 'translateY(-100%)'; setTimeout(() => b.remove(), 350); }
  }, spec.autoHideMs);
})()`;

/** True once the call-layer device is linked (chat list present). */
export async function callLoggedIn(): Promise<boolean> {
  const view = getCallView();
  if (!view || view.webContents.isDestroyed()) return false;
  return view.webContents.executeJavaScript(LOGGED_IN_JS).catch(() => false);
}

/** Resolve once `wc` shows the WA chat list, or false after `timeoutMs`. */
function waitLoggedIn(wc: Electron.WebContents, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      if (wc.isDestroyed()) { resolve(false); return; }
      const ok = await wc.executeJavaScript(LOGGED_IN_JS).catch(() => false);
      if (ok) { resolve(true); return; }
      if (Date.now() > deadline) { resolve(false); return; }
      setTimeout(tick, 2000);
    };
    tick();
  });
}

// True while the "Link calling device" window is open. Owned by openCallLinkingWindow; the status
// monitor reads it to dedupe Enable clicks and hide the hybrid banner while linking is in progress.
let linkingInProgress = false;

/**
 * Open the dedicated "Link calling device" window: reparent the warm call view into it, show
 * a fresh QR with an instruction banner, and auto-close on login. The call view is moved back
 * to `mainWindow` (hidden) on success OR cancel, so the warm voip session is never lost.
 */
export async function openCallLinkingWindow(mainWindow: BrowserWindow): Promise<void> {
  if (linkingInProgress) return;   // already open — ignore repeat Enable/tray clicks
  const view = getCallView();
  if (!view || view.webContents.isDestroyed()) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      message: 'Calling is unavailable',
      detail: 'The call engine has not started yet. Restart the app and try again.',
    });
    return;
  }
  // Already linked? Don't open a window that would just load the logged-in app and close again.
  // Single check is reliable here: both callers (tray, status-bar Enable) fire while the app is
  // warm, so the call view has long settled — unlinked returns false instantly.
  if (await callLoggedIn()) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'Calling is already enabled',
      detail: 'Your calling device is linked. You can make and receive calls.',
    });
    return;
  }
  linkingInProgress = true;
  const wc = view.webContents;

  const linkWin = new BrowserWindow({
    width: 520,
    height: 680,
    parent: mainWindow,
    title: 'Link calling device',
    autoHideMenuBar: true,
    icon: appIcon(),
    backgroundColor: '#111b21',
  });

  // Reparent the warm view into the link window and size it to the window.
  mainWindow.contentView.removeChildView(view);
  linkWin.contentView.addChildView(view);
  const layout = () => {
    const { width, height } = linkWin.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  linkWin.on('resize', layout);
  view.setVisible(true);

  const injectBanner = () => { wc.executeJavaScript(BANNER_JS).catch(() => undefined); };
  wc.on('did-finish-load', injectBanner);
  wc.reload();   // fresh QR — the view loaded at app startup, the code may have expired

  let done = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  const cleanup = (linked: boolean) => {
    if (done) return;
    done = true;
    linkingInProgress = false;
    if (poll) clearInterval(poll);
    wc.removeListener('did-finish-load', injectBanner);
    if (!wc.isDestroyed()) wc.executeJavaScript(REMOVE_BANNER_JS).catch(() => undefined);
    view.setVisible(false);
    // Move the warm view BACK to the main window (hidden) before the link window is destroyed.
    try { linkWin.contentView.removeChildView(view); } catch { /* already detached */ }
    mainWindow.contentView.addChildView(view);
    const { width, height } = mainWindow.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
    if (linked && Notification.isSupported()) {
      new Notification({ title: 'Calling enabled', body: 'Your calling device is linked.', icon: appIcon() }).show();
    }
  };

  poll = setInterval(async () => {
    if (wc.isDestroyed()) { cleanup(false); return; }
    const ok = await wc.executeJavaScript(LOGGED_IN_JS).catch(() => false);
    if (ok) { cleanup(true); if (!linkWin.isDestroyed()) linkWin.close(); }
  }, 800);

  // Closing the window (user cancel, or our own close() above) reparents the view back first.
  linkWin.on('close', () => cleanup(false));
}

/**
 * Persistent calling-device status monitor. After the main (hybrid) login, poll the hidden call
 * view's WA connection state (~1.5s) and drive a single status banner in the hybrid page:
 *   unlinked → green "Enable …" bar; connecting/offline/conflict → amber (persists);
 *   connected → green "✓ Calling connected" that auto-hides; loading/no-view → hidden.
 * Acts only on CHANGE (no flicker), but re-asserts a persistent banner if the node went missing
 * (SPA safety). The same poll reads the Enable-button click and opens the link window.
 */
export async function watchCallStatus(
  mainWindow: BrowserWindow,
  hybridWc: Electron.WebContents,
  onStatus?: (status: string) => void,
): Promise<void> {
  if (!(await waitLoggedIn(hybridWc, 120_000))) return;   // main never logged in this session
  let last: string | null = null;
  const apply = (spec: BannerSpec | null) => hybridWc.executeJavaScript(applyBannerJs(spec)).catch(() => undefined);
  const poll = setInterval(async () => {
    if (hybridWc.isDestroyed() || mainWindow.isDestroyed()) { clearInterval(poll); return; }

    // While the link window is open the call view is reparented and showing the QR — hide the
    // hybrid banner and leave status alone until it closes (then `last` forces a fresh banner).
    if (linkingInProgress) { if (last !== '__linking') { last = '__linking'; apply(null); } return; }

    // The Enable button lives in the HYBRID page, so read the action HERE (not from the call view).
    const action = await hybridWc.executeJavaScript("window.__wwineCallingAction || ''").catch(() => '');
    if (action === 'enable') {
      await hybridWc.executeJavaScript("window.__wwineCallingAction = ''").catch(() => undefined);
      openCallLinkingWindow(mainWindow).catch(() => undefined);
      return;   // subsequent ticks see linkingInProgress
    }

    const view = getCallView();
    const status = view && !view.webContents.isDestroyed()
      ? String(await view.webContents.executeJavaScript(STATUS_JS).catch(() => 'loading'))
      : 'loading';
    const spec = BANNER_SPECS[status] ?? null;
    if (status !== last) {
      last = status;
      apply(spec);
      onStatus?.(status);
    } else if (spec && !spec.autoHideMs) {
      apply(spec);   // re-assert persistent banner in case WA wiped the node
    }
  }, 1500);
}
