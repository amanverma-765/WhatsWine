// Engine window: a hidden plain-web BrowserWindow hosting WhatsApp's WASM voip
// stack as a headless media core, bridged to the hybrid window's VoipBridge.
//
// Enabled by WA_ENGINE_MODE=1. NOT active in CALL_MODE (mutually exclusive).
//
// ─── Method 3 spike architecture ────────────────────────────────────────────
//   Hybrid main window (windows=1, native bridges, hybrid session)
//       ↕  IPC  (wa-engine:*)
//   Engine window (plain web, persist:wa-engine, separate linked-device login)
//       — hosts WhatsApp's WASM voip stack (pjsip/opus/WebRTC)
//       — receives Signal-decrypted offer payloads forwarded from VoipBridge
//       — emits outbound signaling intercepted here and relayed back to hybrid
//
// ─── IPC contract ────────────────────────────────────────────────────────────
//   main → engine:
//     'wa-engine:push-offer'      EngineOfferPayload    incoming call offer
//     'wa-engine:push-signaling'  EngineSignalingPayload  mid-call update
//     'wa-engine:push-ack'        EngineAckPayload        accept/nack
//   engine → main:
//     'wa-engine:ready'           {hooked: string[]}    WASM stack wired up
//     'wa-engine:probe-result'    ProbeResult           module reachability diagnostic
//     'wa-engine:outbound-signaling'  method + args     engine outbound to relay
//
// ─── Hard limitation (socket/signaling-unification problem) ──────────────────
//   The engine window runs its own WA WebSocket (a SEPARATE device session).
//   Outbound signaling emitted by the WASM stack targets the engine's own socket,
//   not the hybrid window's socket. This spike intercepts at the named callback
//   surface (handleSignalingXmpp etc.) but cannot redirect the underlying transport.
//   See NOTES.md §Blockers for a full analysis.

import { BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';

const WA_ORIGIN = 'https://web.whatsapp.com/';
const WA_HOST_ORIGIN = new URL(WA_ORIGIN).origin;

// ─── Payload types ────────────────────────────────────────────────────────────

export interface EngineOfferPayload {
  xmlNodeBase64: string;
  msgPlatform: string;
  msgVersion: string;
  msgE: string;
  msgT: string;
  msgOffline: boolean;
  isOfferNotContact: boolean;
  peerJid: string;
}

export interface EngineSignalingPayload {
  xmlNodeBase64: string;
  extraArgs: unknown[];
}

export interface EngineAckPayload {
  xmlNodeBase64: string;
  ackInfoError: unknown;
  ackInfoType: unknown;
  peerJid: string;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let engineWindow: BrowserWindow | null = null;
let ipcInstalled = false;

// Relay registered by voip.ts: engine outbound-signaling → hybrid sharedTw bus.
// Set via setOutboundRelay() before createEngineWindow() is called.
let outboundRelay: ((method: string, args: unknown[]) => void) | null = null;

export function setOutboundRelay(fn: (method: string, args: unknown[]) => void): void {
  outboundRelay = fn;
}

// ─── Push API (called by voip.ts bridge methods) ──────────────────────────────

export function pushOfferToEngine(payload: EngineOfferPayload): void {
  if (!engineWindow) return;   // engine not enabled — silently skip
  engineSend('wa-engine:push-offer', payload);
}

export function pushSignalingToEngine(payload: EngineSignalingPayload): void {
  if (!engineWindow) return;
  engineSend('wa-engine:push-signaling', payload);
}

export function pushAckToEngine(payload: EngineAckPayload): void {
  if (!engineWindow) return;
  engineSend('wa-engine:push-ack', payload);
}

function engineSend(channel: string, payload: unknown): void {
  if (engineWindow && !engineWindow.isDestroyed()) {
    engineWindow.webContents.send(channel, payload);
  } else {
    console.warn('[engine] send on', channel, '— engine window destroyed or not ready');
  }
}

// ─── Call shims ───────────────────────────────────────────────────────────────
// Identical to CALL_MODE shims in main.ts. Duplicated to avoid importing from
// main.ts (circular dep risk). ponytail: extract to src/call-shims.ts to share.

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

// ─── Window creation ──────────────────────────────────────────────────────────

export function createEngineWindow(): void {
  if (engineWindow) return;
  installEngineIpc();

  // Own session partition — isolated login state (separate linked device).
  // The user must scan a second QR to pair the engine window as a new device.
  const engineSession = session.fromPartition('persist:wa-engine');

  // Strip Electron tokens from the UA so WhatsApp serves the plain-web bundle
  const rawUa = engineSession.getUserAgent();
  const userAgent = rawUa
    .replace(/ Electron\/[^ ]+/, '')
    .replace(new RegExp(' WhatsWine/[^ ]+'), '');
  engineSession.setUserAgent(userAgent);

  // Media + notification permissions on the engine partition
  engineSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'notifications' ||
      permission === 'media' ||
      permission === 'clipboard-sanitized-write',
    );
  });
  engineSession.setDevicePermissionHandler(() => true);
  engineSession.setPermissionCheckHandler((_wc, permission, origin) => {
    if (['media', 'microphone', 'camera', 'speaker-selection'].includes(permission)) return true;
    return origin === WA_HOST_ORIGIN;
  });

  engineWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,          // headless — never shown unless WA_ENGINE_SHOW=1
    skipTaskbar: true,
    title: 'WhatsWine Engine (hidden)',
    webPreferences: {
      preload: path.join(__dirname, 'engine-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:wa-engine',
    },
  });

  if (process.env.WA_ENGINE_SHOW) {
    engineWindow.show();
    console.log('[engine] WA_ENGINE_SHOW: engine window visible for debugging');
  }

  const wc = engineWindow.webContents;

  // Force-grant persistent storage (same belt-and-suspenders pattern as main window)
  try {
    wc.debugger.attach('1.3');
    wc.debugger
      .sendCommand('Browser.setPermission', {
        permission: { name: 'persistent-storage' },
        setting: 'granted',
        origin: WA_ORIGIN,
      })
      .catch((e: unknown) => console.error('[engine] persistent-storage grant failed:', e))
      .finally(() => { try { wc.debugger.detach(); } catch { /* already detached */ } });
  } catch (e) {
    console.error('[engine] debugger attach failed:', e);
  }

  // Install call shims on every load so the WASM voip engine initializes
  wc.on('dom-ready', () => {
    wc.executeJavaScript(CALL_SHIMS_JS).catch(() => undefined);
  });

  wc.on('did-finish-load', () => {
    console.log('[engine] loaded:', wc.getURL());
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[engine] did-fail-load:', code, desc, url);
  });

  if (process.env.WA_BRIDGE_DEBUG) {
    wc.on('console-message', (_e, level, message) => {
      if (level >= 1) console.log(`[engine-console:${level}] ${message}`.slice(0, 1200));
    });
  }

  // Block all popups — headless core has no UI
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Hide instead of close to keep the session alive
  engineWindow.on('close', (e) => {
    e.preventDefault();
    engineWindow?.hide();
  });

  // Plain web URL — no ?windows=1, so the bundle uses its WASM voip stack
  engineWindow.loadURL(WA_ORIGIN, { userAgent });

  console.log('[engine] hidden engine window created');
  console.log('[engine] IMPORTANT: must be paired as a SEPARATE linked device');
  console.log('[engine] Set WA_ENGINE_SHOW=1 to reveal the window and scan its QR');
}

// ─── IPC handlers (engine → main) ────────────────────────────────────────────

function installEngineIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;

  // WASM voip stack initialized and outbound surface intercepted in engine preload
  ipcMain.on('wa-engine:ready', (_e, info: unknown) => {
    console.log('[engine] WASM voip stack ready:', JSON.stringify(info));
  });

  // Module probe: confirms whether WAWebVoipStackInterfaceWeb is loadable in
  // plain-web mode. Expected: ok=true with the list of exposed methods.
  // (Not loadable under ?windows=1 hybrid — that's the WASM-in-hybrid impossibility
  // that motivated this two-window architecture.)
  ipcMain.on('wa-engine:probe-result', (_e, result: unknown) => {
    console.log('[engine] probe result:', JSON.stringify(result));
  });

  // Engine outbound signaling → relay to hybrid page's sharedTw ToWeb bus.
  // This is the path that would close the loop IF socket-unification were solved.
  // The hybrid page's VoipBridge.subscribe sink receives these callbacks and
  // drives its own signaling transport (the hybrid socket).
  ipcMain.on('wa-engine:outbound-signaling', (_e, method: string, args: unknown[]) => {
    if (process.env.WA_BRIDGE_DEBUG) {
      console.log('[engine] outbound-signaling relay:', method, JSON.stringify(args).slice(0, 300));
    }
    if (outboundRelay) {
      outboundRelay(method, args);
    } else {
      console.warn('[engine] outbound-signaling:', method, '— relay not registered');
    }
  });
}
