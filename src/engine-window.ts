// Engine window: a HIDDEN, LOGGED-OUT plain-web BrowserWindow that hosts WhatsApp's
// WASM voip stack as a headless media/FSM core, bridged to the hybrid window's
// VoipBridge. The spike proved the stack loads + voipInits + drives a real offer
// while logged-out, so this window needs no QR pairing and no UI.
//
// Architecture (the relay-through-the-bridge-contract model):
//   hybrid window (?windows=1, native bridges) ──IPC──> engine window (plain web, WASM voip)
//   inbound:  VoipSignalingBridge.handleIncomingSignalingOffer → pushOfferToEngine → engine
//   control:  VoipBridge.voipInit/startCall/endCall/… → engineControl → engine stack method
//   outbound: engine's WAWebVoipSendSignalingXmpp + ToWeb callbacks → wa-engine:engine-out
//             → setOutboundRelay → hybrid page's subscribe sink → hybrid socket sends it
//   media:    mic/SRTP/relay live entirely inside this window.

import { BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';

const WA_ORIGIN = 'https://web.whatsapp.com/';
const WA_HOST_ORIGIN = new URL(WA_ORIGIN).origin;
// Ephemeral partition (no `persist:`) → always logged-out, nothing written to disk.
const ENGINE_PARTITION = 'wa-engine';

export interface EngineOfferPayload {
  xmlNodeBase64: string; msgPlatform: string; msgVersion: string; msgE: string;
  msgT: string; msgOffline: boolean; isOfferNotContact: boolean; peerJid: string;
}
export interface EngineSignalingPayload { xmlNodeBase64: string; extraArgs: unknown[]; }
export interface EngineAckPayload { xmlNodeBase64: string; ackInfoError: unknown; ackInfoType: unknown; peerJid: string; }

let engineWindow: BrowserWindow | null = null;
let ipcInstalled = false;

// Relay registered by voip.ts: engine outbound → hybrid sharedTw ToWeb bus.
let outboundRelay: ((method: string, args: unknown[]) => void) | null = null;
export function setOutboundRelay(fn: (method: string, args: unknown[]) => void): void { outboundRelay = fn; }

function engineSend(channel: string, ...payload: unknown[]): void {
  if (engineWindow && !engineWindow.isDestroyed()) engineWindow.webContents.send(channel, ...payload);
}

// ── Push API (called by voip.ts bridge methods) ──────────────────────────────
export function pushOfferToEngine(payload: EngineOfferPayload): void { engineSend('wa-engine:push-offer', payload); }
export function pushSignalingToEngine(payload: EngineSignalingPayload): void { engineSend('wa-engine:push-signaling', payload); }
export function pushAckToEngine(payload: EngineAckPayload): void { engineSend('wa-engine:push-ack', payload); }
// Generic control: drive any engine stack method (voipInit, startCall, acceptCall, endCall, setCallMute, handleDeviceJidList, …).
export function engineControl(method: string, args: unknown[]): void { engineSend('wa-engine:control', method, args); }
export function isEngineReady(): boolean { return engineWindow !== null && !engineWindow.isDestroyed(); }

// Same shims as CALL_MODE: grant mic/cam to the Permissions API + force web-calling
// AB props on so the WASM voip module is allowed to download/init.
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
    width: 900, height: 700,
    show: !!process.env.WA_ENGINE_SHOW,   // hidden by default; reveal only for debugging
    skipTaskbar: true,
    title: 'WhatsWine call engine',
    webPreferences: {
      preload: path.join(__dirname, 'engine-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: ENGINE_PARTITION,
    },
  });

  const wc = engineWindow.webContents;

  // WA checks navigator.storage.persist() at boot even in an ephemeral session.
  try {
    wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Browser.setPermission', { permission: { name: 'persistent-storage' }, setting: 'granted', origin: WA_ORIGIN })
      .catch((e: unknown) => console.error('[engine] persistent-storage grant failed:', e))
      .finally(() => { try { wc.debugger.detach(); } catch { /* detached */ } });
  } catch (e) { console.error('[engine] debugger attach failed:', e); }

  wc.on('dom-ready', () => { wc.executeJavaScript(CALL_SHIMS_JS).catch(() => undefined); });
  wc.on('did-fail-load', (_e, code, desc, url) => console.error('[engine] did-fail-load:', code, desc, url));
  if (process.env.WA_BRIDGE_DEBUG) {
    wc.on('console-message', (_e, level, message) => { if (level >= 1) console.log(`[engine-console:${level}] ${message}`.slice(0, 1200)); });
  }
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));   // headless core: no popups
  // Don't let close destroy it — hide and keep the session alive.
  engineWindow.on('close', (e) => { e.preventDefault(); engineWindow?.hide(); });

  engineWindow.loadURL(WA_ORIGIN, { userAgent });   // plain web → WASM voip stack
  console.log('[engine] hidden call-engine window created (logged-out, no pairing needed)');
}

function installEngineIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.on('wa-engine:ready', (_e, info: unknown) => console.log('[engine] WASM voip stack ready:', JSON.stringify(info)));
  ipcMain.on('wa-engine:log', (_e, msg: unknown) => { if (process.env.WA_BRIDGE_DEBUG) console.log('[engine]', msg); });

  // Engine → hybrid: relay every engine ToWeb emission into the hybrid page's subscribe sink.
  ipcMain.on('wa-engine:engine-out', (_e, method: string, args: unknown[]) => {
    if (process.env.WA_BRIDGE_DEBUG) console.log('[engine] out:', method, JSON.stringify(args).slice(0, 300));
    if (outboundRelay) outboundRelay(method, args);
    else console.warn('[engine] engine-out before relay registered:', method);
  });
}
