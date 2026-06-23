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

import { BrowserWindow, WebContentsView, session, shell } from 'electron';
import { WA_ORIGIN, WA_HOST_ORIGIN, cleanUserAgent } from './waConfig';

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
//   3. once WAWebCallCollection.activeCall is set, call WAWebVoipUiManager
//      .openVoipUiPopoutWindow() (no args; reads activeCall itself) — selector-free.
// Resolves true once the popout is triggered, false on timeout (caller shows the overlay).
// ponytail: version-coupled (module names + call-button selector), same risk class as the
// AB-prop shim; falls back to the overlay if any of it drifts.
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
      const m = mod('WAWebVoipUiManager');
      L('activeCall present, popout via UiManager=' + !!m);
      try { m && m.openVoipUiPopoutWindow(); resolve(!!m); } catch (e) { L('popout threw: ' + e); resolve(false); }
      return;
    }
    if (!opened) opened = openChat();   // retry open-chat until WA modules have booted
    else clickCall();                    // chat open → keep clicking call until active
    if (n > 75) { L('timeout: opened=' + opened + ' activeCall never appeared'); clearInterval(timer); resolve(false); }
  }, 400);
}))()`;

// Opener-side guard installed on the call view: the call must only ever live in its
// popout window. WhatsApp's WAWebVoipPopoutWindowState.getIsCallActiveInPopoutWindow()
// tells whether the active call is in the popout. If a call was in the popout and then
// LEAVES it — user clicks "Back to chat" / picture-in-picture, or closes the popout
// window — we end the call (click WhatsApp's own End call control) instead of letting it
// run invisibly in the hidden call layer. Gated so it doesn't fire during pre-popout setup.
const CALL_GUARD_JS = `(() => {
  if (window.__wwineCallGuard) return; window.__wwineCallGuard = true;
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
  let wasInPopout = false;
  setInterval(() => {
    const C = mod('WAWebCallCollection'), P = mod('WAWebVoipPopoutWindowState');
    if (!C || !P || !P.getIsCallActiveInPopoutWindow) return;
    const active = !!C.activeCall;
    const inPopout = !!P.getIsCallActiveInPopoutWindow();
    if (!active) { wasInPopout = false; return; }
    if (inPopout) { wasInPopout = true; return; }
    if (wasInPopout) {   // call was popped out and has now left the popout → end it
      wasInPopout = false;
      console.warn('[wwine-call] call left popout window → ending call');
      endCall();
    }
  }, 500);
})()`;

let callView: WebContentsView | null = null;

/** Show the call layer as a full-window overlay over the chat. No-op until created. */
export function showCallLayer(): void {
  callView?.setVisible(true);
}

/** Hide the call layer, revealing the hybrid chat view beneath. */
export function hideCallLayer(): void {
  callView?.setVisible(false);
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
  // Only surface the overlay if the hand-off fails, so the click isn't a dead no-op.
  wc.executeJavaScript(startCallJs(peerJid, useVideo), true)
    .then((popped) => { if (!popped) showCallLayer(); })
    .catch(() => showCallLayer());
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
    // Auto-close the popout when the call ends/rejects, so a dead call screen never lingers.
    // Event-driven (no state polling): subscribe to WhatsApp's own CallCollection
    // 'change:activeCall' — it fires the moment the active call goes away (hang up / reject)
    // → close the window. A single grace-timeout closes a popout that never gets a call (blank).
    popout.webContents.on('did-finish-load', () => {
      popout.webContents.executeJavaScript(`(() => {
        const req = window.require;
        const get = () => { try { return req && req('WAWebCallCollection'); } catch (e) { return null; } };
        const close = () => { try { window.close(); } catch (e) {} };
        let attached = false, n = 0;
        const attach = setInterval(() => {
          const C = get(); n++;
          if (C && C.on) { attached = true; clearInterval(attach); C.on('change:activeCall', () => { if (!C.activeCall) close(); }); }
          else if (n > 30) clearInterval(attach);   // give up wiring after ~12s
        }, 400);
        // Blank-popout guard: nothing connected within ~25s → close. One-shot, not a poll.
        setTimeout(() => { const C = get(); if (!C || !C.activeCall) close(); }, 25000);
      })()`).catch(() => undefined);
    });
    // Whenever the popout goes away, make sure the overlay isn't left showing. Ending the
    // call when the popout is closed/moved is handled by the opener-side watcher (installed
    // on the call view in createCallView): it ends any call that leaves the popout window.
    popout.on('closed', () => hideCallLayer());
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
    wc.executeJavaScript(CALL_GUARD_JS).catch(() => undefined);   // end any call that leaves its popout
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
