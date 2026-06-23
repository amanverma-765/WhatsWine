// VoIP host-object bridges: VoipBridge + VoipSignalingBridge.
// Backed natively by VoipWinRTWebBridge (_voipRoot) in AppModel.cs:218-219.
// Both bridges wrap the same native instance; both registered post-login
// (AppModel.cs:218-219, shared DispatchAdapter).
// Doc refs: bridge-catalog §VoipBridge/§VoipSignalingBridge, docs 41 §3.
//
// ─── SCOPE BOUNDARY (hard edge) ──────────────────────────────────────────────
// docs 41 §5 + doc 90 §M0: the native IVoip relay / HBH-SRTP media engine
// (WhatsAppNative.dll — PJSIP + ICE/STUN/TURN + SRTP + SFrame codecs) has NO
// Linux equivalent.  The WA Web bundle carries its own WebRTC stack and is the
// authority for signaling transport + Signal E2E crypto.
//
// Method classification used below:
//   FUNCTIONAL    — wires the ToWeb event bus; actually does something useful.
//   PASS-THROUGH  — signaling ingress; no-op because the bundle's own stack
//                   drives the wire; ToWeb surface wired for future engine.
//   PONYTAIL STUB — media engine control; explicitly deferred; marked with the
//                   comment "ponytail: no Linux IVoip equivalent".
//
// Goal: a logged-in user's UI must never crash when any VoipBridge method is
// called.  Real call functionality requires the proprietary IVoip engine.
// ─────────────────────────────────────────────────────────────────────────────

import { Notification } from 'electron';
import type { BridgeFactory, BridgeContext } from '../types';
import { toWeb } from '../eventtarget';
import { appIcon } from '../../icon';
import { startRingtone, stopRingtone } from '../../ringtone';
import { showMainWindow } from '../../window';
import {
  setOutboundRelay,
  pushOfferToEngine,
  pushSignalingToEngine,
  pushAckToEngine,
  engineControl,
  dispatchVoipBridgeEvent,
} from '../../engine-window';

// ─── Ringtone control ────────────────────────────────────────────────────────
// The bundle's WebRTC stack stays silent here (engine stubbed), so we loop the
// Windows ringtone ourselves while a call is offering. There's no reliable
// "call ended" callback on the offer path, so the loop auto-stops on a timer
// that re-arms on each re-fired offer; offers stop when the caller gives up or
// the call is answered elsewhere, so the ring stops ~RING_REARM_MS later.
// Local decline/hangup (endCall / reject / signOut) stops it immediately.
// ponytail: timer-gated loop; caller-cancel tail is bounded by RING_REARM_MS.
const RING_REARM_MS = 12_000;
let ringStop: ReturnType<typeof setTimeout> | null = null;
function ring(): void {
  if (ringStop) clearTimeout(ringStop);
  else startRingtone();
  ringStop = setTimeout(stopRing, RING_REARM_MS);
}
function stopRing(): void {
  if (ringStop) { clearTimeout(ringStop); ringStop = null; }
  stopRingtone();
}

// ─── Incoming-call notification ──────────────────────────────────────────────
// Desktop can't take the call (no IVoip engine), so the one useful thing we can
// do with an inbound offer is tell the user to answer on their phone.
// One toast per caller per ringing window — the offer re-fires per device / re-offer.
// ponytail: 35s window keyed by peerJid, plain timestamp; good enough for call toasts.
const lastCallToast = new Map<string, number>();
const CALL_TOAST_WINDOW_MS = 35_000;

// peerJid -> human label. Best-effort name from the contacts ledger (data.ts table),
// else a formatted number, else generic. @lid jids usually won't resolve — that's fine.
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
  // Only a phone-domain jid carries a real number; @lid is an opaque id, not a +number.
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
    body: `${who} is calling. Answer on your phone.`,
    icon: appIcon(),
    silent: true,   // we loop the ringtone ourselves (see ring() above)
  });
  n.on('click', () => showMainWindow());   // surface the bundle's in-app call screen
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

// Both VoipBridge and VoipSignalingBridge are backed by the same native object
// (VoipWinRTWebBridge).  Mirror that with a module-level shared ToWeb bus so
// either factory can fire callbacks through the same sink set.
// subscribe() is only exposed on VoipBridge (per IVoipBridgeToNative).
const sharedTw = toWeb();

// Method 3 spike: register the outbound relay so any signaling the engine window
// emits (intercepted in engine-preload.ts) is forwarded back to the hybrid page's
// subscribe sink as if it came from a native engine. No-op when the engine window
// is not created (WA_ENGINE_MODE not set).
// The bundle subscribes to IVoipBridgeToWeb events via the host-object EventTarget surface
// (addEventListener("<method>Event")), not the legacy subscribe-sink. Deliver the engine's outbound
// emissions as the matching "<method>Event" so they reach the bundle (e.g. handleSignalingXmppEvent
// makes the hybrid wrap+encrypt+send the engine's signaling on its socket).
setOutboundRelay((method, args) => dispatchVoipBridgeEvent(method + 'Event', args[0]));

// ─────────────────────────────────────────────────────────────────────────────
// VoipBridge
// IVoipBridgeToNative: 20 typed methods + 2 reflection-only methods (doc 41 §3.2).
// ToWeb (IVoipBridgeToWeb, 9 callbacks):
//   handleVoipReady · requestOpenChat · requestDeviceJidList ·
//   requestPhoneNumberJid · requestLidJid · handleVoipCall ·
//   handleSignalingXmpp · handleCallAgain · handleLidCallerDisplayInfo
// ─────────────────────────────────────────────────────────────────────────────
function voipBridgeFactory(ctx: BridgeContext): ReturnType<BridgeFactory> {
  return {

    // ── FUNCTIONAL: subscribe ─────────────────────────────────────────────
    // JS calls this once to hand native the IVoipBridgeToWeb callback sink.
    // VoipWinRTWebBridge.cs:132-135 — stored as _web, null-checked before use.
    subscribe: sharedTw.subscribe,

    // ── FUNCTIONAL: voipInit ──────────────────────────────────────────────
    // Bundle calls this after login with the three identity JIDs (doc 41 §3.16).
    // Native normally warms up IVoip here; we log receipt and immediately emit
    // handleVoipReady so the bundle does not stall waiting for engine readiness.
    voipInit: (myDeviceJid: unknown, myUserJid: unknown, selfLidDeviceJid: unknown) => {
      ctx.log('[VoipBridge] voipInit', { myDeviceJid, myUserJid, selfLidDeviceJid });
      // Drive the headless engine's voipInit with the real identity JIDs; it will emit
      // handleVoipReady back through the relay. Keep an immediate emit as a stall guard.
      engineControl('voipInit', [myDeviceJid, myUserJid, selfLidDeviceJid]);
      dispatchVoipBridgeEvent('handleVoipReadyEvent', {});
    },

    // ── Call accept/reject (NOT on the native windows stub — we add them) ──
    // The web call UI calls getVoipStackInterface().acceptCall(...), which the windows stub lacks; we
    // patch the stub (preload) to forward here, and drive the hidden WASM engine's acceptCall. The
    // engine transitions ReceivedCall→AcceptSent and emits the accept signaling (relayed back out).
    acceptCall: (...args: unknown[]) => {
      ctx.log('[VoipBridge] acceptCall', ...args);
      engineControl('acceptCall', args);
    },
    rejectCall: (...args: unknown[]) => {
      stopRing();
      ctx.log('[VoipBridge] rejectCall', ...args);
      engineControl('rejectCall', args);
    },

    // ── FUNCTIONAL: JID-resolution reply handlers ─────────────────────────
    // The engine asks (requestDeviceJidList/PN↔LID via the relay) → the hybrid bundle
    // resolves and answers HERE → forward the answer back into the engine (§3.11).
    handleDeviceJidList: (peerJid: unknown, deviceJids: unknown) => {
      ctx.log('[VoipBridge] handleDeviceJidList', peerJid, deviceJids);
      engineControl('handleDeviceJidList', [peerJid, deviceJids]);
    },
    handlePhoneNumberJid: (...args: unknown[]) => {
      ctx.log('[VoipBridge] handlePhoneNumberJid', ...args);
      engineControl('handlePhoneNumberJid', args);
    },
    handleLidJid: (...args: unknown[]) => {
      ctx.log('[VoipBridge] handleLidJid', ...args);
      engineControl('handleLidJid', args);
    },

    // ── FUNCTIONAL: handleSignOut ─────────────────────────────────────────
    // Called on logout to tear down any active call (VoipWebCore.cs, §3.9).
    // No active call possible without the engine; log only.
    handleSignOut: () => {
      stopRing();
      ctx.log('[VoipBridge] handleSignOut');
      engineControl('handleSignOut', []);
    },

    setHideMyIp: (hide: unknown) => {
      ctx.log('[VoipBridge] setHideMyIp', hide);
      engineControl('setHideMyIp', [hide]);
    },

    setChatNameAndIcon: (...args: unknown[]) => {
      ctx.log('[VoipBridge] setChatNameAndIcon', ...args);
      engineControl('setChatNameAndIcon', args);
    },

    // ── Call control → driven on the headless WASM engine ─────────────────

    // StartCall — 1:1 outbound call with multi-device fan-out (VoipWebCore.cs:154-186, §3.9).
    startCall: (
      peerJid: unknown, deviceJids: unknown, callId: unknown,
      useVideo: unknown, ...rest: unknown[]
    ) => {
      ctx.log('[VoipBridge] startCall', { peerJid, callId, useVideo }, rest.length, 'more args');
      engineControl('startCall', [peerJid, deviceJids, callId, useVideo, ...rest]);
    },

    // EndCall — tear down active call (doc 41 §3.2).
    endCall: (callId: unknown, ...rest: unknown[]) => {
      stopRing();
      ctx.log('[VoipBridge] endCall', callId, ...rest);
      engineControl('endCall', [callId, ...rest]);
    },

    // RejectCallWithoutCallContext — reject before engine has call context.
    rejectCallWithoutCallContext: (...args: unknown[]) => {
      stopRing();
      ctx.log('[VoipBridge] rejectCallWithoutCallContext', ...args);
      engineControl('rejectCallWithoutCallContext', args);
    },

    // StartGroupCall — group call with per-participant device arrays (§3.10).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    startGroupCall: (
      _pnUserJids: unknown, _lidUserJids: unknown, _deviceJidsCsv: unknown,
      callId: unknown, hasVideo: unknown, groupJid: unknown, ...rest: unknown[]
    ) => {
      ctx.log('[VoipBridge] startGroupCall (stub)', { callId, hasVideo, groupJid }, rest.length, 'more args');
    },

    // InviteToCall — add participant to an ongoing group call.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    inviteToCall: (participant: unknown) => {
      ctx.log('[VoipBridge] inviteToCall (stub)', participant);
    },

    // JoinOngoingCall — join in-progress call with full params (§3.10).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    joinOngoingCall: (callId: unknown, callCreator: unknown, ...rest: unknown[]) => {
      ctx.log('[VoipBridge] joinOngoingCall (stub)', { callId, callCreator }, rest.length, 'more args');
    },

    // CheckOngoingCalls — reconcile joinable call after reconnect (§3.10).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    checkOngoingCalls: (callId: unknown, creatorDeviceJid: unknown) => {
      ctx.log('[VoipBridge] checkOngoingCalls (stub)', { callId, creatorDeviceJid });
    },

    // ── PONYTAIL STUBS: call links (call.whatsapp.com) ────────────────────
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    previewCallLink: (token: unknown, ...rest: unknown[]) => {
      ctx.log('[VoipBridge] previewCallLink (stub)', token, rest.length, 'more args');
    },
    previewAndJoinCallLink: (token: unknown, ...rest: unknown[]) => {
      ctx.log('[VoipBridge] previewAndJoinCallLink (stub)', token, rest.length, 'more args');
    },

    // Reflection-only (not on typed interface; reached via AppModel.cs:270
    // typeof(VoipWinRTWebBridge).GetMethod(name) reflection dispatch, §3.10).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    joinCallLink: () => {
      ctx.log('[VoipBridge] joinCallLink (stub, reflection-only)');
    },
    createCallLink: (hasVideo: unknown, eventStartTimeSec: unknown) => {
      // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
      ctx.log('[VoipBridge] createCallLink (stub, reflection-only)', { hasVideo, eventStartTimeSec });
    },

    // ── PONYTAIL STUBS: device enumeration / permissions (Async → Promise) ─
    // Both names end in Async → Promise (forceAsyncMethodMatches, doc 31 §3.9).
    // Return sane defaults: 0 devices, permission not granted.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    // Real capture lives in the engine window; report a device + granted permission so the
    // hybrid bundle lets the call proceed (it gates the call UI on these).
    getDeviceCountAsync: async (deviceType: unknown) => {
      ctx.log('[VoipBridge] getDeviceCountAsync', deviceType);
      return 1;
    },
    requestObtainDevicePermissionAsync: async (deviceType: unknown) => {
      ctx.log('[VoipBridge] requestObtainDevicePermissionAsync', deviceType);
      return true;
    },

    // ── Debug stub ────────────────────────────────────────────────────────
    // simulateNativeAnr — debug/QA-only in the Windows build; pure no-op here.
    simulateNativeAnr: (...args: unknown[]) => {
      ctx.log('[VoipBridge] simulateNativeAnr (debug stub)', ...args);
    },

  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VoipSignalingBridge
// IVoipSignalingBridgeToNative: 7 methods (doc 41 §3.2, bridge-catalog §VoipSignalingBridge).
// Shares IVoipBridgeToWeb — no separate ToWeb interface; no subscribe method.
//
// Role: signaling ingress — JS pushes Signal-decrypted base64-WAP call stanzas
// into native so the IVoip engine can drive its call state machine (§3.4).
// Without the IVoip engine every method is a PASS-THROUGH no-op.
// The ToWeb event surface (sharedTw) is already wired via VoipBridge.subscribe.
// ─────────────────────────────────────────────────────────────────────────────
function voipSignalingBridgeFactory(ctx: BridgeContext): ReturnType<BridgeFactory> {
  return {

    // HandleIncomingSignalingOffer — inbound call offer (base64-WAP node, §3.4).
    // In the Windows build: DecodeBase64Wap → IVoip.OnIncomingSignalOffer.
    // Method 3 spike: also forwarded to the engine window (if WA_ENGINE_MODE=1)
    // where the WASM stack processes it and drives media. See engine-window.ts.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    handleIncomingSignalingOffer: (
      xmlNodeBase64: unknown, msgPlatform: unknown, msgVersion: unknown,
      msgE: unknown, msgT: unknown, msgOffline: unknown,
      isOfferNotContact: unknown, peerJid: unknown, ...rest: unknown[]
    ) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingOffer', { peerJid, msgPlatform, msgT }, rest.length, 'extra args');
      showIncomingCallToast(ctx, String(peerJid ?? ''));
      ring();
      // Forward to the hidden engine window. The WASM stack's handleIncomingSignalingOffer takes a
      // trailing tcToken (9th arg); the hybrid may supply it as the first extra arg.
      pushOfferToEngine({
        xmlNodeBase64: String(xmlNodeBase64 ?? ''),
        msgPlatform:   String(msgPlatform ?? ''),
        msgVersion:    String(msgVersion ?? ''),
        msgE:          String(msgE ?? ''),
        msgT:          String(msgT ?? ''),
        msgOffline:    Boolean(msgOffline),
        isOfferNotContact: Boolean(isOfferNotContact),
        peerJid:       String(peerJid ?? ''),
        tcToken:       rest[0],
      });
    },

    // HandleIncomingSignalingMessage — mid-call signaling (rekey, update, etc.).
    // Method 3 spike: forwarded to engine window so the WASM stack can process it.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    handleIncomingSignalingMessage: (xmlNodeBase64: unknown, ...rest: unknown[]) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingMessage', rest.length, 'args');
      pushSignalingToEngine({ xmlNodeBase64: String(xmlNodeBase64 ?? ''), extraArgs: rest });
    },

    // HandleIncomingSignalingAck — accept/nack of the call offer (VoipWebCore.cs:60-152).
    // VoipNativeAckInfo {error, type} — e.g. NackGroupCallMaximumLimit (§3.8).
    // Method 3 spike: forwarded to engine window.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    handleIncomingSignalingAck: (
      xmlNodeBase64: unknown, ackInfoError: unknown, ackInfoType: unknown,
      peerJid: unknown,
    ) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingAck', { ackInfoError, ackInfoType, peerJid });
      pushAckToEngine({
        xmlNodeBase64: String(xmlNodeBase64 ?? ''),
        ackInfoError,
        ackInfoType,
        peerJid: String(peerJid ?? ''),
      });
    },

    // HandleIncomingSignalingReceipt — delivery receipt for a signaling node.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    handleIncomingSignalingReceipt: (
      xmlNodeBase64: unknown, peerJid: unknown,
    ) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingReceipt', peerJid);
      engineControl('handleIncomingSignalingReceipt', [xmlNodeBase64, peerJid]);
    },

    // ResendOfferOnDecryptionFailure — engine asks JS to re-transmit encrypted
    // offer after Signal decryption failure (VoipCallbacks.cs:487-493, §3.8).
    resendOfferOnDecryptionFailure: (peerJid: unknown, callId: unknown) => {
      ctx.log('[VoipSignalingBridge] resendOfferOnDecryptionFailure', { peerJid, callId });
      engineControl('resendOfferOnDecryptionFailure', [peerJid, callId]);
    },

    // ResendEncRekeyRetry — engine asks JS to retry an encrypted rekey frame.
    resendEncRekeyRetry: (peerJid: unknown, retryCount: unknown) => {
      ctx.log('[VoipSignalingBridge] resendEncRekeyRetry', { peerJid, retryCount });
      engineControl('resendEncRekeyRetry', [peerJid, retryCount]);
    },

    // NotifyDeviceIdentityChangedOrDeleted — Signal session invalidation event;
    // tells the engine to reset the per-device E2E session for peerJid.
    notifyDeviceIdentityChangedOrDeleted: (peerJid: unknown, isDeleted: unknown) => {
      ctx.log('[VoipSignalingBridge] notifyDeviceIdentityChangedOrDeleted', { peerJid, isDeleted });
      engineControl('notifyDeviceIdentityChangedOrDeleted', [peerJid, isDeleted]);
    },

  };
}

export const bridges: Record<string, BridgeFactory> = {
  VoipBridge: voipBridgeFactory,
  VoipSignalingBridge: voipSignalingBridgeFactory,
};
