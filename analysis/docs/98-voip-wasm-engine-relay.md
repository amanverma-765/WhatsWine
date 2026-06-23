# 98 — VoIP WASM engine relay (Option B): concrete source findings

Goal: make 1:1 calls work **inside** the `?windows=1` hybrid window by running WhatsApp's own
plain-web **WASM voip engine** in a hidden, logged-out second window and bridging it to the hybrid
through the native VoIP bridge contract.

All citations below are from the **real decompiled bundle** at
`/home/ark/Dev/projects/Webstorm/whatsapp/decompiled_source/waweb-source-bundle/` (not the analysis
summaries). Minified, so quotes are the exact substrings found. The two load-bearing files:

- `a5gdgRhdCri.js` — the voip **interface layer**: `WAWebVoipStackInterfaceImpl` (singleton),
  `WAWebVoipStackInterfaceWindows` (the `?windows=1` native stub), `WAWebVoipHandleNativeCallEvent`
  wiring.
- `DXbR99V6DKN.js` — the **`cr:22885` WASM shim**: `createWAWebVoipStackInterface`, the
  `window.WhatsAppVoipWasmCallbacks` table, `onCallEvent`, and the `handleIncomingSignaling*` methods.

> **Bundle drift warning.** The deployed bundle changed since the original spikes (mid-2026). Two
> things moved together: (a) `WAWebVoipStackInterfaceWeb` no longer resolves directly via
> `requireLazy`; (b) `handleIncomingSignalingOffer`/`Message` now require a **node wrapper** first
> arg, where the spike fed base64. Treat any spike result older than this doc as possibly stale.

---

## 1. Loading the stack (logged-out)

### 1.1 The factory takes NO delegate
`WAWebVoipStackInterfaceImpl` builds a process-wide singleton with **no arguments**:

```js
// a5gdgRhdCri.js:32  __d("WAWebVoipStackInterfaceImpl",["cr:22885","nullthrows"], ...)
var s = n("cr:22885"), u = s.createWAWebVoipStackInterface, c = null;
function d(){ return c==null && m(), nullthrows(c) }   // getVoipStackInterfaceImpl
function m(){ c = u() }                                 // <-- createWAWebVoipStackInterface() — NO ARGS
```

**Consequence:** there is no constructor delegate to inject. Passing one (the old Proxy-delegate
approach) does nothing. Engine→JS callbacks travel through a **global table**, see §2.

### 1.2 `createWAWebVoipStackInterface()` body (the WASM shim)
```js
// DXbR99V6DKN.js  (cr:22885)
function w(){
  if(!WAWebVoipGatingUtils.isVoipDownloadEnabled())
    throw err("createWAWebVoipStackInterface: VoIP download is not enabled");
  var t = {
    onVoipReady: WAWebNoop,
    onCallEvent: WAWebNoop,                                   // <-- engine→JS event sink (default noop)
    initCaptureDriverJS: WAWebVoipAudioCaptureAndPlayback.initCaptureDriverJS,
    startCaptureJS:      WAWebVoipAudioCaptureAndPlayback.startCaptureJS,
    stopCaptureJS:       WAWebVoipAudioCaptureAndPlayback.stopCaptureJS,
  };
  window.WhatsAppVoipWasmCallbacks = t;                       // <-- GLOBAL callback table
  window.WhatsAppVoipWasmWorkerCompatibleCallbacks = WAWebVoipStackInterfaceWebCallbacks.createWorkerCompatibleCallbacks();
  if (WAWebABProps.getABPropConfigValue("enable_web_voip_proxy_and_sctp_workers") === true)
    return WAWebVoipStackInterfaceWorkerProxy.createWorkerProxyStackInterface();   // worker variant
  var w = WAWebBackendApi.frontendSendAndReceive("initializeVoipWasm");            // boot the WASM
  return { type:"web", parsers: WAWebVoipJsonParsersWeb, voipInit, /* ...all stack methods... */ };
}
```

### 1.3 Module resolution (the boot-wall fix)
- `requireLazy(['WAWebVoipStackInterfaceWeb'])` **hangs** in the current bundle — that chunk isn't
  fetched by name. `requireLazy(['WAWebVoipStackInterface'])` (the **dispatcher**) resolves and, as a
  side effect, **pulls the Web chunk**; after that the concrete name resolves too (observed:
  `ALT result: Web=true dispatcher=true`).
- Gating: `isVoipDownloadEnabled === enable_web_calling || web_calling_download_voip`. A logged-out
  session has no server flag, so force it: `WAWebABProps.setGetABPropConfigValueImpl(key => FORCE[key] ?? orig(key))`.
  Live-verified working: `GATING {isCallingEnabled:true, isVoipDownloadEnabled:true}`.
- Confirmed live: stack instantiates logged-out, `type:"web"` (the WASM impl, not the windows stub),
  full method surface present (`voipInit`, `handleIncomingSignaling{Offer,Message,Ack,Receipt}`,
  `acceptCall`, `rejectCall`, `endCall`, `startCall`, `setCallMute`, `handleDeviceJidList`,
  `resendOfferOnDecryptionFailure`, `resendEncRekeyRetry`, `notifyDeviceIdentityChangedOrDeleted`, …).

### 1.4 `voipInit`
The web `voipInit` is async, declared `function*(t,n,a)` — its body `var i = yield w;` waits on the
`initializeVoipWasm` promise, then `initVoipStorageAndMLCache(i)`, video-renderer init, etc. The
proven spike called **`voipInit()` with no args** and it did not throw. The hybrid's *forwarded*
`voipInit` args carry native-callback interfaces that **IPC serialization strips**, which crashes the
stack (`TypeError: e.node is not a function` was a red herring there — see §4). **The engine must
self-init with a bare `voipInit()` and ignore the hybrid's forwarded one.**

---

## 2. Engine→JS events: the relay seam

### 2.1 `onCallEvent` is the single chokepoint
```js
// DXbR99V6DKN.js — window.WhatsAppVoipWasmCallbacks.onCallEvent
onCallEvent: function(t){
  var n = t.eventDataJson, r = t.eventType, a = t.userData;
  var i = WAWebVoipWaCallEnums.CallEvent.cast(r);
  if (i == null){ /* log invalid */ return; }
  // log unless SpeakerStatusChanged
  WAWebVoipHandleNativeCallEvent.handleWAWebVoipNativeCallEvent(i, n).catch(/* warn */);
}
```

So **every** engine→UI event is `{eventType, eventDataJson, userData}` and is dispatched through one
function: **`WAWebVoipHandleNativeCallEvent.handleWAWebVoipNativeCallEvent(eventTypeEnum, eventDataJson)`**.

### 2.2 The same function is the native→web entry in `?windows=1`
In the hybrid (windows) build, the native voip engine delivers events to the web layer via the same
`handleWAWebVoipNativeCallEvent(e, r)` (confirmed call shape in `a5gdgRhdCri.js`). **The WASM engine's
`onCallEvent` payload is byte-for-byte what the hybrid's native path already consumes.** That is the
relay seam.

### 2.3 Why double-processing is safe
The `WAWebVoipHandleNativeCallEvent*` sub-handlers gate their heavy work on `t.type === "web"`:

```js
// a5gdgRhdCri.js — representative handlers
handleP2PTransportUpdate:  if(t.type==="web"){ parseP2PTransportUpdateData → WAWebVoipP2PConnectionManager.handleRemoteCredentials/handleRemoteCandidate }
handleCallEnding:          parse → frontendFireAndForget("generateCallLogFrom…")    // + endCall on web
handleCallRejectReceived:  if(n.type==="web"){ … endCall(…) }
handleWaitingRoomStateChanged / handleCallGridRankingChanged: frontendFireAndForget(...)  // UI only
```

- In the **engine** (`type:"web"`): the original `onCallEvent` runs → the media/transport branches
  (P2P, parsers, `getCallInfo`) execute **where the media actually lives**. Keep calling the original.
- In the **hybrid** (`type:"windows"`): replaying the event runs **only the UI/frontend branches**
  (the `type==="web"` guards skip the media work the native side would've done). That is exactly what
  makes the call **ring** without the hybrid trying to own media.

### 2.4 Relay design (concrete)
1. **Engine preload**: after the stack is ready, wrap `window.WhatsAppVoipWasmCallbacks.onCallEvent`:
   call the original (media), then relay `{eventType, eventDataJson}` out over IPC. Also override
   `onVoipReady` to relay.
2. **Main**: forward the relayed event to the hybrid window.
3. **Hybrid side** (small injected hook in the hybrid's main world): on receipt,
   `requireLazy(['WAWebVoipHandleNativeCallEvent','WAWebVoipWaCallEnums'], (H,E) =>
   H.handleWAWebVoipNativeCallEvent(E.CallEvent.cast(eventType), eventDataJson))`.
   This bypasses needing to reverse the exact `VoipBridge.subscribe` ToWeb contract — we drive the
   dispatcher the native path would've driven.

### 2.5 Incoming-call event
`WAWebVoipWaCallEnums.CallEvent` includes `CallOffer` (and the call-state machine name `ReceivedCall`).
The `CallOffer` event is the one that creates the incoming-call store entry / rings. (Exact enum
integer: resolve at runtime via `CallEvent.getName`/`cast`; do not hardcode the number — bundle-coupled.)

---

## 3. The `?windows=1` stub — what the hybrid forwards to us

`WAWebVoipStackInterfaceWindows` (`a5gdgRhdCri.js:42`, `type:"windows"`) forwards **every** stack
method to `getWindowsBridge().voip.<method>(...)` — i.e. straight into **our** `VoipBridge`:

```js
voipInit:        function(t,n,r){ getWindowsBridge().voip.voipInit(t,n,r) }
setHideMyIp:     function(t){ getWindowsBridge().voip.setHideMyIp(t) }
setChatNameAndIcon:function(t,n,r){ … }
handleWebViewReady:function(){ … }   // windows-only method, no web equivalent
handleSignOut:   function(){ … }
startCall:       function(t,…){ … }
startGroupCall:  function(t,…){ … }
// …acceptCall, rejectCall, endCall, handleIncomingSignaling*, setCallMute, handleDeviceJidList, …
```

So the hybrid bundle is already trying to drive a "native" voip through our bridge. We forward those
calls to the engine (control direction), and relay the engine's `onCallEvent` back (event direction).
`handleWebViewReady`/`setChatNameAndIcon` are windows-only — safe to stub/no-op on the engine.

---

## 4. Inbound signaling: the `e.node()` fix (CRITICAL)

Both handlers in the WASM shim take a **node wrapper** (object exposing `.node()`), NOT base64:

```js
// DXbR99V6DKN.js
handleIncomingSignalingOffer: function*(e,n,a,i,l,s,u,c,d){          // 9 args
  var m = yield t; WAWebBweMLModelManager.initBweMLModelsForCall(m);
  var p = e.node();                                                  // <-- FIRST ARG MUST HAVE .node()
  var _ = WABase64.encodeB64(WAWap.encodeStanza(p));
  yield P("handleIncomingSignalingOffer", {b64Stanza:_, msgPlatform:n, msgVersion:a,
          msgEStr:String(i), msgTStr:String(l), msgOffline:s, isOfferNotContact:u, peerJid:c, tcToken:d});
}
// args: (nodeWrapper, msgPlatform, msgVersion, msgE, msgT, msgOffline, isOfferNotContact, peerJid, tcToken)

handleIncomingSignalingMessage: function*(e,t,n,a,i,l,s,u){          // 8 args
  var c = e.node();                                                  // <-- SAME
  var d = WABase64.encodeB64(WAWap.encodeStanza(c));
  yield P("handleIncomingSignalingMessage", {b64Stanza:d, msgPlatform:t, msgVersion:n,
          msgEStr:String(a), msgTStr:String(i), msgOffline:l, peerJid:s, tcToken:u});
}
// args: (nodeWrapper, msgPlatform, msgVersion, msgE, msgT, msgOffline, peerJid, tcToken)
```

The real web call site builds the wrapper from the socket stanza and decrypts in place:

```js
// UBSny…JTk.js  (web signaling-receive path)
function*(t,r){
  var i = yield Promise.all([
    WAWebVoipValidateAndDecryptEnc.validateAndDecryptEnc(r, t),      // r = parsed stanza wrapper
    WAWebVoipStackInterface.getVoipStackInterface(),
  ]);
  // ... on E2EProcessResult.SUCCESS:
  c.handleIncomingSignalingMessage(r, t.peer_platform, t.peer_app_version, t.e, t.t,
                                   t.is_offline ?? false, t.peer_jid.toString());
}
```

**Why our base64 crashes:** the hybrid in `?windows=1` serializes the node to base64 to cross the
native bridge, so `VoipSignalingBridge.handleIncomingSignalingMessage` receives `xmlNodeBase64`
(string). We forward the string; the WASM stack does `"…".node()` → `TypeError: e.node is not a
function`.

**The fix:** in the engine, before calling the stack, wrap base64 in a minimal node wrapper. The
handlers only ever call `.node()` then `encodeStanza` — nothing else on the wrapper — so:

```js
// engine side, with WAWap + WABase64 required
const wrap = (b64) => { const node = WAWap.decodeStanza(WABase64.decodeB64(b64)); return { node: () => node }; };
stack.handleIncomingSignalingOffer(wrap(b64), msgPlatform, msgVersion, msgE, msgT, msgOffline, isOfferNotContact, peerJid, tcToken);
```

(`WAWap` lives in `ttCyYQuBxs5.js`; it exposes `encodeStanza` and `decodeStanza`. `WABase64` exposes
`encodeB64`/`decodeB64`.) The decode→re-encode round-trips back to our original b64Stanza, so the
WASM worker receives exactly the bytes it expects.

> Note the arg lists grew vs. our current bridge: offer now has a trailing **`tcToken`** (9 args),
> message has trailing **`peerJid, tcToken`** (8 args). Forward `tcToken` if the hybrid provides it
> (it is fetched via `frontendSendAndReceive("getTcToken",{wid:peer_jid})` on the web path; on the
> hybrid path it may arrive as an extra bridge arg — log `rest` to confirm).

---

## 5. Outbound signaling (engine → hybrid socket)

The engine emits outbound stanzas by calling the module function:

```
WAWebVoipSendSignalingXmpp.sendWAWebVoipSignalingXmpp({ peerJid, callId, xmlPayload })
```

Observed live (roundtrip): `xmlPayload` is a **byte map** `{0:n,1:n,…}` (serialized Uint8Array).
We patch this module function in the engine, convert `xmlPayload` → base64, and relay
`handleSignalingXmpp({peerJid, callId, xmlPayloadBase64, shouldEncrypt})` to the hybrid, which wraps
it in `<call>`, **Signal-encrypts with the logged-in session's keys**, and sends on its socket.

- The engine outputs the **plaintext inner node**; encryption happens hybrid-side. The engine never
  needs its own login for outbound. (Inbound offer is already Signal-decrypted by the hybrid's shared
  web layer before `handleIncomingSignalingOffer`, so no inbound key bridging — `keyCallbacks:[]`.)
- `shouldEncrypt`: true for offer/enc_rekey node types. We can't cheaply read the tag from the byte
  map, so default true; revisit if rekey/ack need false.

---

## 6. State / what's proven vs open

**Proven live (this codebase):**
- Engine loads the real WASM stack logged-out via the dispatcher; `type:"web"`; gating forced true.
- `voipInit()` self-init (no args) does not crash.
- Real incoming offers reach the engine over the bridge.

**Implemented, needs the §4 + §2 fixes to validate:**
- Inbound: wrap base64 → node wrapper before `handleIncomingSignaling*` (fixes `e.node`).
- Events: intercept `onCallEvent`, relay to hybrid, replay via `handleWAWebVoipNativeCallEvent` (makes
  it ring).
- Outbound: `WAWebVoipSendSignalingXmpp` patch → `handleSignalingXmpp` relay (already wired).

**Open questions:**
1. Exact `CallEvent` integer for `CallOffer` — resolve at runtime, don't hardcode.
2. `tcToken` plumbing through the bridge (offer 9th arg / message 8th arg).
3. Accept path: which bridge method fires when the user clicks Accept in the hybrid UI → must reach
   `engine.acceptCall(...)`. Native `IVoipBridgeToNative` has no `acceptCall`; observe with
   `WA_BRIDGE_DEBUG=1`.
4. Media/SRTP actually connecting when the engine is driven externally (Phase B).

**Key module/file index:**
| Symbol | File |
|---|---|
| `createWAWebVoipStackInterface`, `onCallEvent`, `handleIncomingSignaling*`, `window.WhatsAppVoipWasmCallbacks` | `DXbR99V6DKN.js` (cr:22885) |
| `WAWebVoipStackInterfaceImpl` / `getVoipStackInterfaceImpl`, `WAWebVoipStackInterfaceWindows`, `WAWebVoipHandleNativeCallEvent*` | `a5gdgRhdCri.js` |
| Web signaling-receive call sites (`validateAndDecryptEnc` → `handleIncomingSignalingMessage`) | `UBSny…JTk.js` |
| `WAWap` (`encodeStanza`/`decodeStanza`) | `ttCyYQuBxs5.js` |
