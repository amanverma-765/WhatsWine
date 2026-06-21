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

import type { BridgeFactory, BridgeContext } from '../types';
import { toWeb } from '../eventtarget';

// Both VoipBridge and VoipSignalingBridge are backed by the same native object
// (VoipWinRTWebBridge).  Mirror that with a module-level shared ToWeb bus so
// either factory can fire callbacks through the same sink set.
// subscribe() is only exposed on VoipBridge (per IVoipBridgeToNative).
const sharedTw = toWeb();

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
      sharedTw.call('handleVoipReady');
    },

    // ── FUNCTIONAL: JID-resolution reply handlers ─────────────────────────
    // JS answers native's async requests (fired as ToWeb callbacks) for device
    // fan-out + PN↔LID conversion (VoipSignaling.cs:186-207, §3.11).
    // Without the engine nothing is awaiting these; log and discard.
    handleDeviceJidList: (peerJid: unknown, deviceJids: unknown) => {
      ctx.log('[VoipBridge] handleDeviceJidList', peerJid, deviceJids);
    },
    handlePhoneNumberJid: (...args: unknown[]) => {
      ctx.log('[VoipBridge] handlePhoneNumberJid', ...args);
    },
    handleLidJid: (...args: unknown[]) => {
      ctx.log('[VoipBridge] handleLidJid', ...args);
    },

    // ── FUNCTIONAL: handleSignOut ─────────────────────────────────────────
    // Called on logout to tear down any active call (VoipWebCore.cs, §3.9).
    // No active call possible without the engine; log only.
    handleSignOut: () => {
      ctx.log('[VoipBridge] handleSignOut — no active call (engine absent)');
    },

    // ── PONYTAIL STUB: relay / P2P transport preference ───────────────────
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    setHideMyIp: (hide: unknown) => {
      ctx.log('[VoipBridge] setHideMyIp (stub)', hide);
    },

    // ── PONYTAIL STUB: call overlay label ─────────────────────────────────
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    setChatNameAndIcon: (...args: unknown[]) => {
      ctx.log('[VoipBridge] setChatNameAndIcon (stub)', ...args);
    },

    // ── PONYTAIL STUBS: call control ──────────────────────────────────────
    // All require IVoip (ICE/SRTP/relay/codecs). Return void; log call site.

    // StartCall — 1:1 call with multi-device fan-out (VoipWebCore.cs:154-186, §3.9).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    startCall: (
      peerJid: unknown, _deviceJids: unknown, callId: unknown,
      useVideo: unknown, ...rest: unknown[]
    ) => {
      ctx.log('[VoipBridge] startCall (stub)', { peerJid, callId, useVideo }, rest.length, 'more args');
    },

    // EndCall — tear down active call (doc 41 §3.2).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    endCall: (callId: unknown, ...rest: unknown[]) => {
      ctx.log('[VoipBridge] endCall (stub)', callId, ...rest);
    },

    // RejectCallWithoutCallContext — reject before engine has call context.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    rejectCallWithoutCallContext: (...args: unknown[]) => {
      ctx.log('[VoipBridge] rejectCallWithoutCallContext (stub)', ...args);
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
    getDeviceCountAsync: async (deviceType: unknown) => {
      ctx.log('[VoipBridge] getDeviceCountAsync (stub)', deviceType);
      return 0;
    },
    requestObtainDevicePermissionAsync: async (deviceType: unknown) => {
      ctx.log('[VoipBridge] requestObtainDevicePermissionAsync (stub)', deviceType);
      return false;
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
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    handleIncomingSignalingOffer: (
      _xmlNodeBase64: unknown, msgPlatform: unknown, _msgVersion: unknown,
      _msgE: unknown, msgT: unknown, _msgOffline: unknown,
      _isOfferNotContact: unknown, peerJid: unknown,
    ) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingOffer (stub)', { peerJid, msgPlatform, msgT });
    },

    // HandleIncomingSignalingMessage — mid-call signaling (rekey, update, etc.).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    handleIncomingSignalingMessage: (_xmlNodeBase64: unknown, ...rest: unknown[]) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingMessage (stub)', rest.length, 'args');
    },

    // HandleIncomingSignalingAck — accept/nack of the call offer (VoipWebCore.cs:60-152).
    // VoipNativeAckInfo {error, type} — e.g. NackGroupCallMaximumLimit (§3.8).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    handleIncomingSignalingAck: (
      _xmlNodeBase64: unknown, ackInfoError: unknown, ackInfoType: unknown,
      peerJid: unknown,
    ) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingAck (stub)', { ackInfoError, ackInfoType, peerJid });
    },

    // HandleIncomingSignalingReceipt — delivery receipt for a signaling node.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    handleIncomingSignalingReceipt: (
      _xmlNodeBase64: unknown, peerJid: unknown,
    ) => {
      ctx.log('[VoipSignalingBridge] handleIncomingSignalingReceipt (stub)', peerJid);
    },

    // ResendOfferOnDecryptionFailure — engine asks JS to re-transmit encrypted
    // offer after Signal decryption failure (VoipCallbacks.cs:487-493, §3.8).
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    resendOfferOnDecryptionFailure: (peerJid: unknown, callId: unknown) => {
      ctx.log('[VoipSignalingBridge] resendOfferOnDecryptionFailure (stub)', { peerJid, callId });
    },

    // ResendEncRekeyRetry — engine asks JS to retry an encrypted rekey frame.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    resendEncRekeyRetry: (peerJid: unknown, retryCount: unknown) => {
      ctx.log('[VoipSignalingBridge] resendEncRekeyRetry (stub)', { peerJid, retryCount });
    },

    // NotifyDeviceIdentityChangedOrDeleted — Signal session invalidation event;
    // tells the engine to reset the per-device E2E session for peerJid.
    // ponytail: no Linux IVoip equivalent — bundle WebRTC handles media; native engine deferred.
    notifyDeviceIdentityChangedOrDeleted: (peerJid: unknown, isDeleted: unknown) => {
      ctx.log('[VoipSignalingBridge] notifyDeviceIdentityChangedOrDeleted (stub)', { peerJid, isDeleted });
    },

  };
}

export const bridges: Record<string, BridgeFactory> = {
  VoipBridge: voipBridgeFactory,
  VoipSignalingBridge: voipSignalingBridgeFactory,
};
