// VoIP host-object bridges: VoipBridge + VoipSignalingBridge.
//
// Dual-window calling (analysis/docs/99): calls are handled by a SEPARATE visible call window
// (src/engine-window.ts) — its own logged-in web device running WhatsApp's real web voip stack
// and native call UI. This hybrid window (?windows=1) can't host the voip stack at all, so these
// bridges do NOT drive calls; they exist only so the hybrid bundle never crashes when it calls a
// VoipBridge method, and to surface the call window on an incoming offer.
//
// ponytail: every method here is a safe stub. Real calling lives in the call window.

import { Notification } from 'electron';
import type { BridgeFactory, BridgeContext } from '../types';
import { toWeb } from '../eventtarget';
import { appIcon } from '../../icon';
import { raiseCallWindow } from '../../engine-window';

// ─── Incoming-call notification ──────────────────────────────────────────────
// One toast per caller per ringing window — the offer re-fires per device / re-offer.
// ponytail: 35s window keyed by peerJid, plain timestamp; good enough for call toasts.
const lastCallToast = new Map<string, number>();
const CALL_TOAST_WINDOW_MS = 35_000;

// peerJid -> human label from the contacts ledger (data.ts table), else a formatted number, else
// generic. @lid jids usually won't resolve — that's fine.
function callerLabel(ctx: BridgeContext, peerJid: string): string {
  try {
    const row = ctx.nativeDb()
      .prepare('SELECT json FROM contacts WHERE jid = ?')
      .get(peerJid) as { json: string } | undefined;
    if (row) {
      const c = JSON.parse(row.json);
      const name = c.name || c.shortName || c.pushname || c.pushName || c.notify || '';
      if (name) return name;
    }
  } catch { /* table may not exist yet / lid jid / malformed — fall through */ }
  const domain = String(peerJid).split('@')[1] ?? '';
  const local = String(peerJid).split('@')[0].split(':')[0];
  if (/^(s\.whatsapp\.net|c\.us)$/.test(domain) && /^\d+$/.test(local)) return `+${local}`;
  return 'Someone';
}

function showIncomingCallToast(ctx: BridgeContext, peerJid: string): void {
  if (!Notification.isSupported() || !peerJid) return;
  const now = Date.now();
  if (now - (lastCallToast.get(peerJid) ?? 0) < CALL_TOAST_WINDOW_MS) return;
  lastCallToast.set(peerJid, now);
  const who = callerLabel(ctx, peerJid);
  const n = new Notification({
    title: 'Incoming WhatsApp call',
    body: `${who} is calling — answer in the call window.`,
    icon: appIcon(),
    silent: true,   // the call window rings (WhatsApp's own ringtone)
  });
  n.on('click', () => raiseCallWindow());
  n.show();
}

// ponytail self-check (WA_VOIP_SELFCHECK=1): jid parse + dedup, no framework.
if (process.env.WA_VOIP_SELFCHECK) {
  const fmt = (jid: string) => {
    const domain = jid.split('@')[1] ?? '';
    const local = jid.split('@')[0].split(':')[0];
    return /^(s\.whatsapp\.net|c\.us)$/.test(domain) && /^\d+$/.test(local) ? `+${local}` : 'Someone';
  };
  console.assert(fmt('15551234567@s.whatsapp.net') === '+15551234567', 'pn jid -> +number');
  console.assert(fmt('15551234567:3@s.whatsapp.net') === '+15551234567', 'device jid -> +number');
  console.assert(fmt('99@lid') === 'Someone', 'lid jid -> Someone (opaque id, not a number)');
  const seen = new Map<string, number>();
  const t = 1_000_000;
  const dup = (j: string, now: number) => {
    if (now - (seen.get(j) ?? 0) < CALL_TOAST_WINDOW_MS) return false;
    seen.set(j, now); return true;
  };
  console.assert(dup('a@x', t) === true, 'first fires');
  console.assert(dup('a@x', t + 1_000) === false, 'repeat within window suppressed');
  console.assert(dup('a@x', t + CALL_TOAST_WINDOW_MS + 1) === true, 'fires again after window');
  console.log('[voip self-check] ok');
}

// Both bridges share one native object (VoipWinRTWebBridge); mirror that with a module-level
// ToWeb bus so either factory fires callbacks through the same subscriber set.
const sharedTw = toWeb();

// ─────────────────────────────────────────────────────────────────────────────
// VoipBridge — IVoipBridgeToNative. All methods are stubs (calls live in the call window).
// ─────────────────────────────────────────────────────────────────────────────
function voipBridgeFactory(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const stub = (name: string) => (...args: unknown[]) => ctx.log(`[VoipBridge] ${name} (stub)`, ...args);
  return {
    // The bundle hands native the IVoipBridgeToWeb sink here.
    subscribe: sharedTw.subscribe,

    // Called after login; emit handleVoipReady so the bundle doesn't stall waiting on the engine.
    voipInit: (myDeviceJid: unknown, myUserJid: unknown, selfLidDeviceJid: unknown) => {
      ctx.log('[VoipBridge] voipInit', { myDeviceJid, myUserJid, selfLidDeviceJid });
      sharedTw.call('handleVoipReady', {});
    },

    startCall: stub('startCall'),
    startGroupCall: stub('startGroupCall'),
    endCall: stub('endCall'),
    acceptCall: stub('acceptCall'),
    rejectCall: stub('rejectCall'),
    rejectCallWithoutCallContext: stub('rejectCallWithoutCallContext'),
    setCallMute: stub('setCallMute'),
    setHideMyIp: stub('setHideMyIp'),
    setChatNameAndIcon: stub('setChatNameAndIcon'),
    handleDeviceJidList: stub('handleDeviceJidList'),
    handlePhoneNumberJid: stub('handlePhoneNumberJid'),
    handleLidJid: stub('handleLidJid'),
    handleSignOut: stub('handleSignOut'),
    inviteToCall: stub('inviteToCall'),
    joinOngoingCall: stub('joinOngoingCall'),
    checkOngoingCalls: stub('checkOngoingCalls'),
    previewCallLink: stub('previewCallLink'),
    previewAndJoinCallLink: stub('previewAndJoinCallLink'),
    joinCallLink: stub('joinCallLink'),
    createCallLink: stub('createCallLink'),
    simulateNativeAnr: stub('simulateNativeAnr'),

    // Async (Async suffix → Promise): report a device + granted permission so the UI proceeds.
    getDeviceCountAsync: async () => 1,
    requestObtainDevicePermissionAsync: async () => true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VoipSignalingBridge — IVoipSignalingBridgeToNative. Signaling ingress; stubs, except an inbound
// offer surfaces the call window so the user answers there.
// ─────────────────────────────────────────────────────────────────────────────
function voipSignalingBridgeFactory(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const stub = (name: string) => (...args: unknown[]) => ctx.log(`[VoipSignalingBridge] ${name} (stub)`, ...args);
  return {
    handleIncomingSignalingOffer: (
      _xmlNodeBase64: unknown, msgPlatform: unknown, _msgVersion: unknown,
      _msgE: unknown, msgT: unknown, _msgOffline: unknown,
      _isOfferNotContact: unknown, peerJid: unknown, ...rest: unknown[]
    ) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingOffer', { peerJid, msgPlatform, msgT }, rest.length, 'extra args');
      showIncomingCallToast(ctx, String(peerJid ?? ''));
      raiseCallWindow();
    },
    handleIncomingSignalingMessage: stub('handleIncomingSignalingMessage'),
    handleIncomingSignalingAck: stub('handleIncomingSignalingAck'),
    handleIncomingSignalingReceipt: stub('handleIncomingSignalingReceipt'),
    resendOfferOnDecryptionFailure: stub('resendOfferOnDecryptionFailure'),
    resendEncRekeyRetry: stub('resendEncRekeyRetry'),
    notifyDeviceIdentityChangedOrDeleted: stub('notifyDeviceIdentityChangedOrDeleted'),
  };
}

export const bridges: Record<string, BridgeFactory> = {
  VoipBridge: voipBridgeFactory,
  VoipSignalingBridge: voipSignalingBridgeFactory,
};
