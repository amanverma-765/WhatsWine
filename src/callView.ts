// Call layer: a second WebContentsView running plain web.whatsapp.com on its own
// Electron session partition ('persist:wa-call'), STACKED ON TOP of the hybrid
// chat view inside the SAME BrowserWindow.  It logs in as a SEPARATE linked device
// from the hybrid view, giving real WASM-backed WhatsApp calling while the hybrid
// view's native bridges keep working.  Hidden until a call; shown as a full-window
// overlay on demand (tray "Calling", or auto-shown on an incoming/outgoing call).
//
// Single-window experiment: this replaces the former standalone call BrowserWindow.
// Kept in its own module to avoid a circular-import chain:
//   main.ts → bridge/registry.ts → impl/voip.ts → callView.ts (no back-edge)

import { BrowserWindow, WebContentsView, Notification, session, shell } from 'electron';
import { WA_ORIGIN, WA_HOST_ORIGIN, cleanUserAgent } from './waConfig';
import { appIcon } from './icon';
import { pickDisplaySource } from './screenPicker';

export const CALL_PARTITION = 'persist:wa-call';

// Page shims injected into the call view's main frame AND the call popout:
//  (1) Report mic/camera as granted — WA gates its pre-call check on
//      navigator.permissions.query (NOT getUserMedia); the shell already auto-grants
//      the real media request, so report query() granted too or WA shows a permission wall.
//  (2) Force the web-calling AB props ON so the call button renders and the WASM voip
//      engine downloads/initialises (default is server-gated off). doc 43 §6 Phase 3.
//      We wrap the BOUND original getABPropConfigValue DIRECTLY — NOT
//      setGetABPropConfigValueImpl, which the getter itself delegates into (re-entrancy:
//      every non-forced prop ends up undefined). Four flags are needed: the two
//      *_voip ones gate the lazy WASM chunk download/init, not just the button.
const CALL_SHIMS_JS = `(() => {
  if (window.__waCallShims) return;
  window.__waCallShims = true;
  try {
    const perms = navigator.permissions;
    if (perms && perms.query) {
      const orig = perms.query.bind(perms);
      perms.query = (d) => (d && (d.name === 'microphone' || d.name === 'camera'))
        ? Promise.resolve({ state: 'granted', onchange: null, addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return false; } })
        : orig(d);
    }
  } catch (e) { /* permissions patch best-effort */ }
  // Self-preview: WA's beta web calling UI never renders the sharer their own screen — that
  // self-view is native-only (IVoipRendering, doc 41 §337) with no web equivalent. Mirror the
  // already-granted getDisplayMedia stream into a small floating, draggable <video>: no second
  // capture, so no extra portal prompt and identical behaviour on X11/Wayland. The same stream
  // is handed back to WA untouched. ponytail: injected shim, same risk class as the AB-prop
  // shim above; if WA ever ships its own sharer preview, delete this block.
  try {
    const md = navigator.mediaDevices;
    if (md && md.getDisplayMedia && !md.__waPreviewWrapped) {
      const orig = md.getDisplayMedia.bind(md);
      const remove = () => { const el = document.getElementById('__wwineSelfPreview'); if (el) el.remove(); };
      const show = (stream) => {
        remove();
        const box = document.createElement('div');
        box.id = '__wwineSelfPreview';
        box.style.cssText = 'position:fixed;right:16px;bottom:16px;width:240px;z-index:2147483647;background:#0b141a;border:1px solid #2a3942;border-radius:8px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.5)';
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font:11px system-ui,sans-serif;color:#8696a0;padding:4px 8px;background:#202c33;cursor:move;user-select:none';
        const title = document.createElement('span');
        title.textContent = 'Your shared screen';
        const close = document.createElement('span');
        close.textContent = '\\u2715';
        close.style.cssText = 'cursor:pointer;padding:0 4px';
        close.onclick = remove;
        bar.appendChild(title); bar.appendChild(close);
        const vid = document.createElement('video');
        vid.autoplay = true; vid.muted = true; vid.playsInline = true;
        vid.style.cssText = 'display:block;width:100%;background:#000';
        vid.srcObject = stream;
        if (vid.play) vid.play().catch(() => undefined);
        box.appendChild(bar); box.appendChild(vid);
        document.body.appendChild(box);
        // Drag by the title bar (clamped loosely to the viewport).
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        bar.addEventListener('mousedown', (e) => {
          if (e.target === close) return;
          dragging = true; sx = e.clientX; sy = e.clientY;
          const r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
          box.style.right = 'auto'; box.style.bottom = 'auto'; box.style.left = ox + 'px'; box.style.top = oy + 'px';
          e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
          if (!dragging) return;
          box.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
          box.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
        });
        window.addEventListener('mouseup', () => { dragging = false; });
        const track = stream.getVideoTracks()[0];
        if (track) track.addEventListener('ended', remove);
      };
      md.getDisplayMedia = async (c) => { const s = await orig(c); try { show(s); } catch (e) { /* preview best-effort */ } return s; };
      md.__waPreviewWrapped = true;
    }
  } catch (e) { /* getDisplayMedia wrap best-effort */ }
  const req = window.require;
  const mod = (name) => { try { return req ? req(name) : null; } catch (e) { return null; } };
  const ON = { enable_web_calling: 1, enable_web_group_calling: 1, web_calling_download_voip: 1, web_calling_init_voip: 1, web_calling_auto_popout_video: 1 };
  const force = () => {
    const AB = mod('WAWebABProps');
    if (!AB || typeof AB.getABPropConfigValue !== 'function') return false;
    if (AB.__waForcePatched) return true;
    const orig = AB.getABPropConfigValue.bind(AB);
    const wrapped = (key) => ON[key] ? true : orig(key);
    try { AB.getABPropConfigValue = wrapped; } catch (e) { /* maybe non-writable */ }
    if (AB.getABPropConfigValue !== wrapped) {
      try { Object.defineProperty(AB, 'getABPropConfigValue', { value: wrapped, configurable: true, writable: true }); } catch (e2) { /* sealed */ }
    }
    if (AB.getABPropConfigValue !== wrapped) return false;
    AB.__waForcePatched = true;
    return true;
  };
  let n = 0;
  const timer = setInterval(() => { n++; if (force() || n > 30) clearInterval(timer); }, 1000);
})()`;

// Optional capability + gating probe (WA_CALL_DIAG=1). Logs why calling is/isn't
// available: crossOriginIsolated (WASM engine needs it) + the bundle's own gate verdicts.
const CALL_DIAG_JS = `(() => {
  if (window.__waCallDiag) return; window.__waCallDiag = true;
  const log = (m) => console.log('[call-diag] ' + m);
  log('caps ' + JSON.stringify({
    crossOriginIsolated: !!window.crossOriginIsolated,
    SharedArrayBuffer: typeof SharedArrayBuffer,
    Atomics: typeof Atomics,
    RTCPeerConnection: typeof RTCPeerConnection
  }));
  const req = window.require;
  const mod = (name) => { try { return req ? req(name) : null; } catch (e) { return null; } };
  let n = 0;
  const timer = setInterval(() => {
    n++;
    const gat = mod('WAWebVoipGatingUtils');
    if (gat) {
      try {
        log('gating ' + JSON.stringify({
          callingEnabled: gat.isCallingEnabled && gat.isCallingEnabled(),
          groupCallingEnabled: gat.isGroupCallingEnabled && gat.isGroupCallingEnabled(),
          unsupportedReason: gat.getUnsupportedBrowserReason && gat.getUnsupportedBrowserReason(),
          voipDownloadEnabled: gat.isVoipDownloadEnabled && gat.isVoipDownloadEnabled()
        }));
      } catch (e) { log('report error ' + e); }
      clearInterval(timer);
    } else if (n > 30) { clearInterval(timer); }
  }, 1000);
})()`;

function installCallShims(target: Electron.WebContents): void {
  target.on('dom-ready', () => {
    target.executeJavaScript(CALL_SHIMS_JS).catch(() => undefined);
    if (process.env.WA_CALL_DIAG) target.executeJavaScript(CALL_DIAG_JS).catch(() => undefined);
  });
}

// Drive the (already loaded, hidden) call view to start a call to peerJid and pop it
// straight out into WhatsApp's own call window — the popout is the visible call surface.
// Uses WhatsApp's own internal modules (no page reload), so it works for @lid AND phone
// peers on the same account:
//   1. open the chat by jid — WAWebWidFactory.createWid(jid) → WAWebVoipActionRequestOpenChat
//      .requestOpenChat(wid) (WhatsApp's own "open chat for voip" action);
//   2. click the chat-header voice/video call button (localized aria-label, with the
//      locale-independent optionId menu items as fallback);
//   3. once WAWebCallCollection.activeCall is set, the call has started — the always-on
//      auto-popout observer (CALL_OBSERVER_JS) pops it into WhatsApp's own call window.
// Resolves true once the call has started, false on timeout (caller shows a native toast).
// ponytail: version-coupled (module names + call-button selector), same risk class as the
// AB-prop shim; resolves false → caller toasts if any of it drifts. Upgrade path: drive the
// call via a native VoipBridge.startCall once a real Linux IVoip engine exists (doc 41 §5),
// retiring this DOM/module automation.
const startCallJs = (peerJid: string, useVideo: boolean): string => `(() => new Promise((resolve) => {
  const L = (m) => console.warn('[wwine-call] ' + m);
  const req = window.require;
  const mod = (name) => { try { return req ? req(name) : null; } catch (e) { L('require ' + name + ' threw: ' + e); return null; } };
  L('start jid=${peerJid} video=${useVideo} hasRequire=' + (typeof req));
  const rx = ${useVideo ? '/video call/i' : '/voice call/i'};
  const optId = ${useVideo ? "'video-call'" : "'voice-call'"};
  let n = 0;
  // Open the chat by jid. Retried each tick until WhatsApp's modules have booted (cold
  // start: window.require exists before WAWebWidFactory/RequestOpenChat are registered).
  const openChat = () => {
    const W = mod('WAWebWidFactory'), A = mod('WAWebVoipActionRequestOpenChat');
    if (!W || !A) return false;
    try { A.requestOpenChat(W.createWid(String(${JSON.stringify(peerJid)}))); L('requestOpenChat called'); return true; }
    catch (e) { L('openChat threw: ' + e); return false; }
  };
  // Click the VISIBLE, clickable call button (a non-latching retry — clicking again once a
  // call is starting is a harmless no-op). Matching the first label hit blindly used to grab
  // an invisible/non-button element and stall, so require visibility + button-ness.
  const clickCall = () => {
    const els = Array.from(document.querySelectorAll('[aria-label],[title],[optionId]'));
    const hit = els.find((b) => {
      if (b.offsetParent === null) return false;   // not visible
      const al = b.getAttribute('aria-label') || '', ti = b.getAttribute('title') || '';
      if (!(b.getAttribute('optionId') === optId || rx.test(al) || rx.test(ti))) return false;
      return b.tagName === 'BUTTON' || b.getAttribute('role') === 'button' || !!b.closest('[role="button"],button');
    });
    if (hit) {
      const target = hit.closest('[role="button"],button') || hit;
      L('clicked call button: ' + (hit.getAttribute('aria-label') || hit.getAttribute('optionId')));
      target.click();
      return true;
    }
    return false;
  };
  const activeCall = () => { const c = mod('WAWebCallCollection'); return c && c.activeCall; };
  let opened = false;
  const timer = setInterval(() => {
    n++;
    if (activeCall()) {
      clearInterval(timer);
      // Call started — the always-on auto-popout observer (CALL_OBSERVER_JS) pops it out.
      // Don't pop out here too, or outgoing + observer could double window.open. But the
      // observer can only pop out if WAWebVoipUiManager exists, so gate the resolve on it:
      // missing module → resolve false so placeCall toasts, instead of a call stuck
      // invisibly in the hidden layer with no feedback (restores the pre-observer signal).
      const canPopout = !!mod('WAWebVoipUiManager');
      L('activeCall present → call started; canPopout=' + canPopout);
      resolve(canPopout);
      return;
    }
    if (!opened) opened = openChat();   // retry open-chat until WA modules have booted
    else clickCall();                    // chat open → keep clicking call until active
    if (n > 75) { L('timeout: opened=' + opened + ' activeCall never appeared'); clearInterval(timer); resolve(false); }
  }, 400);
}))()`;

// Single opener-side observer on the (hidden) call view. WhatsApp's call UI must ALWAYS
// live in its own popout window and NEVER as a visible web surface. One 500ms tick reads
// WAWebCallCollection.activeCall + popout state once and enforces both halves of that:
//   • active but not yet in the popout  → openVoipUiPopoutWindow() (covers outgoing after
//     placeCall AND live incoming, which the call-layer linked device rings on its own);
//   • active, was in the popout, now left it (Back-to-chat / PiP / popout closed) → end the
//     call (click WA's own End control) so it can't run invisibly in the hidden layer.
// ponytail: version-coupled to these WA module names (same risk class as the AB-prop shim);
// if a name drifts the popout just doesn't open — it never falls back to the web UI.
// Upgrade path: subscribe to WAWebCallCollection's change event instead of polling once a
// stable event hook is available.
const CALL_OBSERVER_JS = `(() => {
  if (window.__wwineCallObserver) return; window.__wwineCallObserver = true;
  const req = window.require;
  const mod = (n) => { try { return req && req(n); } catch (e) { return null; } };
  const endCall = () => {
    const rx = /\\b(end call|leave call|hang up)\\b/i;
    const els = Array.from(document.querySelectorAll('[aria-label],[title]'));
    const hit = els.find((b) => b.offsetParent !== null
      && (rx.test(b.getAttribute('aria-label') || '') || rx.test(b.getAttribute('title') || '')));
    if (hit) { (hit.closest('[role="button"],button') || hit).click(); return true; }
    return false;
  };
  let wasInPopout = false, popping = false;
  setInterval(() => {
    const C = mod('WAWebCallCollection'), U = mod('WAWebVoipUiManager'), P = mod('WAWebVoipPopoutWindowState');
    if (!C || !P || !P.getIsCallActiveInPopoutWindow) return;
    if (!C.activeCall) { wasInPopout = false; popping = false; return; }   // no call → reset latches
    const inPopout = !!P.getIsCallActiveInPopoutWindow();
    const opening  = !!(P.getIsPopoutWindowOpening && P.getIsPopoutWindowOpening());
    if (inPopout) { wasInPopout = true; popping = false; return; }         // where we want it
    if (opening)  { popping = false; return; }                            // popout creating — wait
    if (wasInPopout) {   // call was popped out and has now left the popout → end it
      wasInPopout = false;
      console.warn('[wwine-call] call left popout window → ending call');
      endCall();
      return;
    }
    if (popping || !U || !U.openVoipUiPopoutWindow) return;                // requested, or can't pop
    popping = true;
    console.warn('[wwine-call] activeCall not in popout → opening popout');
    try { U.openVoipUiPopoutWindow(); } catch (e) { console.warn('[wwine-call] auto-popout threw: ' + e); popping = false; }
  }, 500);
})()`;

let callView: WebContentsView | null = null;

/** The warm call-layer view (or null before creation). Exposed so the call-onboarding
 *  flow can temporarily reparent it into a dedicated "Link calling device" window to show
 *  its QR, then move it back. It is the only webContents on the `persist:wa-call` partition,
 *  so linking it there links the partition the popout/observer use. */
export function getCallView(): WebContentsView | null {
  return callView;
}

// Truly unlink the call-layer device. WA's "Log out" menu calls require('WAWebSocketModel')
// .Socket.logout(), which runs a SLOW async chain: await a multi-device sentinel patch (≤~20s) →
// WAWebUnpairDeviceJob.unpairDevice() sends the `iq xmlns=md remove-companion-device` to
// s.whatsapp.net (the real removal that drops it from the phone's Linked Devices) → stopComms →
// clear creds → reload to QR. The earlier code force-wiped storage + reloaded after 3s, which
// killed the socket BEFORE the unpair IQ was acked — so it logged out locally but the device
// stayed linked on the account. Fix: explicitly AWAIT unpairDevice (guaranteeing the server
// removal completes), THEN call Socket.logout() for the local teardown, and never reload/wipe
// ourselves — WA reloads the view to QR on its own. A local storage wipe can't unlink server-side,
// so there is intentionally no wipe fallback here.
// ponytail: version-coupled to WAWebUnpairDeviceJob.unpairDevice + WAWebSocketModel.Socket.logout
// (same drift class as the rest of the call automation); a rename surfaces as unpair=err in the log.
const UNPAIR_LOGOUT_JS = `(async () => {
  const req = window.require;
  if (!req) return 'no-require';
  let reason;
  try { reason = req('WAWebLogoutReasonConstants').LogoutReason.UserInitiated; } catch (e) {}
  let unpair = 'skipped';
  try {
    const J = req('WAWebUnpairDeviceJob');
    if (J && typeof J.unpairDevice === 'function') { const r = await J.unpairDevice(reason); unpair = 'status:' + (r && r.status); }
    else unpair = 'no-module';
  } catch (e) { unpair = 'err:' + e; }
  let local = 'skipped';
  try {
    const S = req('WAWebSocketModel');
    if (S && S.Socket && typeof S.Socket.logout === 'function') { S.Socket.logout(reason); local = 'logout'; }
    else local = 'no-module';
  } catch (e) { local = 'err:' + e; }
  return 'unpair=' + unpair + ' local=' + local;
})()`;

/** Truly unlink the call-layer device (server-side remove-companion-device + local teardown) when
 *  the user logs out of the main hybrid window, so calling doesn't stay linked behind a logged-out
 *  app. Awaits the unpair so the IQ completes before WA tears the socket down; WA reloads the view
 *  to QR itself — we never wipe/reload (that was interrupting the unpair). */
export async function logoutCallLayer(): Promise<void> {
  if (!callView || callView.webContents.isDestroyed()) return;
  const status = await callView.webContents.executeJavaScript(UNPAIR_LOGOUT_JS).catch((e) => 'eval-failed:' + e);
  console.warn('[wwine] call-layer logout →', status);
}

// Native toast shown when an outgoing-call hand-off to the popout fails. This REPLACES
// the old green-washed web-overlay fallback: a failed call must never surface the full
// web.whatsapp.com UI. Calls only ever live in WhatsApp's own popout window now.
export function notifyCallFailed(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: 'Call failed',
    body: "Couldn't start the call. Try again.",
    icon: appIcon(),
  }).show();
}

/** Defensive: keep the call layer hidden. The layer is only the popout host + call
 *  automation engine — never a visible surface. Used when the popout window closes. */
export function hideCallLayer(): void {
  if (!callView) return;
  callView.setVisible(false);
}

/**
 * Outgoing-call hand-off: drive the (already loaded, hidden) call layer to open the
 * contact by jid, start the call, and pop it out into WhatsApp's own call window — which
 * becomes the visible call surface. The overlay is shown only if the hand-off fails.
 * Works for @lid and phone peers on the same account. Called from voip.ts when the user
 * hits the (stubbed) call button in the hybrid chat. No-op until the layer exists.
 */
export function placeCall(peerJid: string, useVideo: boolean): void {
  if (!callView) return;
  const wc = callView.webContents;
  // Keep the call layer in the BACKGROUND (never shown): the automation (open chat → start
  // call → pop out) runs in the hidden view, and WhatsApp's popout window is the only visible
  // call surface. React lays out the chat + call button even while the view is hidden, so the
  // jid-open + click still work. userGesture=true so the bundle's window.open isn't blocked.
  // On failure show a native toast — never the web overlay (which would leak the web UI).
  wc.executeJavaScript(startCallJs(peerJid, useVideo), true)
    .then((popped) => { if (!popped) notifyCallFailed(); })
    .catch(() => notifyCallFailed());
}

/**
 * Create the call layer once — warm but hidden — stacked on top of `win`.
 * Returns the view so the host can keep it sized to the window.
 * Called from main.ts at window creation; safe to call again (returns existing).
 */
export function createCallView(win: BrowserWindow): WebContentsView {
  if (callView) return callView;

  const callSession = session.fromPartition(CALL_PARTITION);
  const userAgent = cleanUserAgent(callSession.getUserAgent());
  callSession.setUserAgent(userAgent);

  // All permission handlers are scoped to this partition's session, completely
  // independent of the default session used by the hybrid view.
  callSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'notifications' ||
      permission === 'media' ||
      permission === 'display-capture' ||   // getDisplayMedia (screen share); source picked below
      permission === 'clipboard-sanitized-write',
    );
  });
  // Let the call view enumerate and open mic/cam devices (getUserMedia with a
  // deviceId goes through this handler, separate from the request handler above).
  callSession.setDevicePermissionHandler(() => true);
  // Always allow media permissions: a `media` check uses requestingOrigin, which
  // can be empty/differ for capture frames/workers, and a denied check makes
  // getUserMedia return a silent track instead of a real mic (electron#23792).
  callSession.setPermissionCheckHandler((_wc, permission, origin) => {
    if (['media', 'microphone', 'camera', 'speaker-selection'].includes(permission)) return true;
    return origin === WA_HOST_ORIGIN;
  });
  // Screen share: WhatsApp's WASM voip engine calls navigator.mediaDevices.getDisplayMedia
  // (doc 43 §2.5). Electron returns nothing unless we supply a source — useSystemPicker is
  // macOS-15-only, so on Linux we enumerate + let the user pick (X11) or pass the lone
  // PipeWire placeholder through to the Wayland portal. Covers the call popout too: it
  // inherits this session. Cancel → deny (getDisplayMedia rejects; the call keeps running).
  callSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const source = await pickDisplaySource(win);
    callback(source ? { video: source } : { video: undefined });
  }, { useSystemPicker: true });

  callView = new WebContentsView({
    webPreferences: {
      // No preload: plain-web mode.  The call view must NOT receive the hybrid
      // bridge surface — giving it the preload would inject chrome.webview hostObjects
      // and make the bundle try windows-hybrid code paths (white screen / QR loop).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: callSession,
      // Keep the WASM voip stack warm while the layer is hidden, so the first
      // call doesn't pay a page-load + login + WebRTC cold start.
      backgroundThrottling: false,
    },
  });

  const wc = callView.webContents;

  // Cross-origin isolation for the WASM voip engine (needs SharedArrayBuffer + Atomics →
  // crossOriginIsolated). WA serves COOP `same-origin-allow-popups` (does NOT isolate).
  // We split per-webContents, mirroring WhatsApp's native design (doc 43 §4):
  //  • Main view → `same-origin-allow-popups`: NOT isolated, but keeps window.opener intact
  //    so it can open the call popout. Forcing `same-origin` here breaks that popup flow and
  //    leaves the popout blank (doc 43 §4 caveat — exactly what we hit).
  //  • Call popout → `same-origin`: isolated, so the WASM voip engine runs in it.
  // COEP `require-corp` for both (WA_COEP=credentialless escape hatch). Scoped to THIS session.
  const coep = process.env.WA_COEP || 'require-corp';
  callSession.webRequest.onHeadersReceived((details, cb) => {
    if (details.resourceType === 'mainFrame' && details.url.startsWith(WA_ORIGIN)) {
      const h = details.responseHeaders ?? {};
      for (const k of Object.keys(h)) {
        const lk = k.toLowerCase();
        if (lk === 'cross-origin-opener-policy' || lk === 'cross-origin-embedder-policy') delete h[k];
      }
      const isMainView = details.webContents?.id === wc.id;
      h['cross-origin-opener-policy'] = [isMainView ? 'same-origin-allow-popups' : 'same-origin'];
      h['cross-origin-embedder-policy'] = [coep];
      cb({ responseHeaders: h });
      return;
    }
    cb({});
  });

  // Allow same-origin WA popouts (the call popout opened as window.open("[sw] popout")) —
  // WhatsApp renders the active call in this popout, so it must open. Block and
  // externalize everything else. Don't override webPreferences for the popout: an
  // explicit set can spawn it in a fresh context, severing window.opener (which the
  // /call/popout frame needs). Electron 42 defaults are already secure.
  wc.setWindowOpenHandler(({ url }) => {
    let sameOriginWa = false;
    try { sameOriginWa = new URL(url).origin === WA_HOST_ORIGIN; } catch { /* about:blank etc. */ }
    if (sameOriginWa || url === 'about:blank' || url === '') {
      // Size the call popout to cover the main window (WhatsApp's own default popout is
      // small; we want a full call window). Keep the system frame so it can be moved /
      // maximized; closing it ends the call (hooked in did-create-window below), so it can
      // never be closed while leaving an invisible call running in the hidden call layer.
      const b = win.getBounds();
      return { action: 'allow', overrideBrowserWindowOptions: { x: b.x, y: b.y, width: b.width, height: b.height, autoHideMenuBar: true, parent: win } };
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  installCallShims(wc);

  wc.on('did-create-window', (popout) => {
    // Give the call popout the same shims (mic-permission + AB-prop force) so the call
    // button/engine work there too.
    installCallShims(popout.webContents);
    // Diagnose the popout when WA_CALL_DIAG: log its URL + crossOriginIsolated and forward
    // its console — a blank popout is almost always "not crossOriginIsolated" (WASM voip
    // can't init) or a load failure, and this surfaces which.
    if (process.env.WA_CALL_DIAG || process.env.WA_BRIDGE_DEBUG) {
      popout.webContents.on('console-message', (_e, level, message) => {
        if (level >= 1 || message.startsWith('[call-diag]')) console.log(`[call-popout-console] ${message}`.slice(0, 1000));
      });
      popout.webContents.on('did-finish-load', () => {
        popout.webContents.executeJavaScript('JSON.stringify({url:location.href,coi:!!window.crossOriginIsolated,SAB:typeof SharedArrayBuffer})')
          .then((s) => console.log('[call-popout] state', s)).catch(() => undefined);
      });
      popout.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[call-popout] did-fail-load:', code, desc, url));
    }
    // Auto-close the popout when the call ends. Call state is OPENER-owned: the WA bundle's
    // WAWebCallCollection is per-window, and this popout gets a FRESH instance whose activeCall
    // is NEVER set (verified in the decompiled bundle). So watch the OPENER's (wc's) activeCall
    // from the main process — the old popout-side check read a permanently-empty collection and
    // force-closed every call at ~25s (the auto-reject bug).
    const READ_ACTIVE = `(() => { try { return !!window.require('WAWebCallCollection').activeCall; } catch (e) { return false; } })()`;
    let sawActive = false;
    const openedAt = Date.now();
    const poll = setInterval(async () => {
      if (popout.isDestroyed()) { clearInterval(poll); return; }
      const active = await wc.executeJavaScript(READ_ACTIVE).catch(() => sawActive);
      if (active) { sawActive = true; return; }
      if (sawActive) { clearInterval(poll); popout.close(); }                          // call ended → close
      else if (Date.now() - openedAt > 25000) { clearInterval(poll); popout.close(); } // never connected → blank cleanup
    }, 1000);
    // Whenever the popout goes away, stop polling and make sure the overlay isn't left showing.
    // Ending the call when the popout is closed/moved is handled by the opener-side guard
    // (CALL_OBSERVER_JS): it ends any call that leaves the popout window.
    popout.on('closed', () => { clearInterval(poll); hideCallLayer(); });
  });

  // Esc returns to the chat. Fires only while the call layer has focus (which it does
  // when shown). WA's own call UI may also use Esc — accepted; this just leaves the layer.
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') hideCallLayer();
  });

  // Auto-return to chat when a call rendered INLINE in the call view ends. The main
  // title carries " call" during a call; on the revert to idle "WhatsApp" we hide the
  // layer. Transition-gated (wasCall), so a manual open with no call never auto-hides.
  let wasCallMain = false;
  wc.on('page-title-updated', (_e, title) => {
    if (/\bcall\b/i.test(title)) { wasCallMain = true; return; }
    if (wasCallMain && /^whatsapp\b/i.test(title)) { wasCallMain = false; hideCallLayer(); }
  });

  wc.on('did-finish-load', () => {
    console.log('[call-view] loaded:', wc.getURL());
    // Pop out any active call (outgoing + incoming) and end any that leaves its popout.
    wc.executeJavaScript(CALL_OBSERVER_JS).catch(() => undefined);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => { console.error('[call-view] did-fail-load:', code, desc, url); });
  // Surface the call view's console (incl. the [call-diag] probe) when diagnosing —
  // main.ts only forwards the hybrid view's console.
  if (process.env.WA_CALL_DIAG || process.env.WA_BRIDGE_DEBUG) {
    wc.on('console-message', (_e, level, message) => {
      if (level >= 1 || message.startsWith('[call-diag]')) console.log(`[call-view-console] ${message}`.slice(0, 1000));
    });
  }

  // Added after the hybrid view → on top in the z-order. Hidden until a call.
  win.contentView.addChildView(callView);
  callView.setVisible(false);
  wc.loadURL(WA_ORIGIN, { userAgent });
  return callView;
}
