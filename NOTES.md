# Method 3 Spike — WASM Engine as Headless Media Core

## What was built

A scaffold that runs the hybrid main window (WhatsApp Web `?windows=1`, native bridges) alongside
a **hidden plain-web BrowserWindow** (partition `persist:wa-engine`) hosting WhatsApp's WASM voip
stack. Incoming call signaling from the hybrid window is forwarded to the engine window over IPC;
the engine's outbound-signaling surface is intercepted and relayed back to the hybrid page's ToWeb
bus. A module-reachability probe confirms whether `WAWebVoipStackInterfaceWeb` is accessible in
each window mode.

### New files

| File | Role |
|------|------|
| `src/engine-window.ts` | Creates & manages the hidden engine `BrowserWindow`; owns the IPC handlers (`wa-engine:*`); exposes `pushOfferToEngine`, `pushSignalingToEngine`, `pushAckToEngine`, and `setOutboundRelay` |
| `src/engine-preload.ts` | Preload for the engine window; probes `WAWebVoipStackInterfaceWeb` via `requireLazy`; intercepts the WASM stack's named outbound-signaling surface; feeds incoming offer/signaling payloads into the engine |

### Modified files

| File | Change |
|------|--------|
| `src/main.ts` | `ENGINE_MODE` constant; `WA_ENGINE_MODE` SAB + AudioSandbox switches; `createEngineWindow()` call in `app.on('ready')`; `WA_VOIP_PROBE` injection into the hybrid window |
| `src/bridge/impl/voip.ts` | Registers `setOutboundRelay` at module init; `handleIncomingSignalingOffer`, `handleIncomingSignalingMessage`, `handleIncomingSignalingAck` now also forward their payloads to the engine |
| `forge.config.ts` | Added `engine-preload.ts` as a second preload build entry → `.vite/build/engine-preload.js` |

---

## IPC contract

All channels use string names prefixed `wa-engine:`. Direction is relative to the main process.

| Channel | Direction | Payload | Purpose |
|---------|-----------|---------|---------|
| `wa-engine:push-offer` | main → engine | `EngineOfferPayload` | Forward Signal-decrypted incoming offer to WASM stack |
| `wa-engine:push-signaling` | main → engine | `EngineSignalingPayload` | Forward mid-call signaling update |
| `wa-engine:push-ack` | main → engine | `EngineAckPayload` | Forward accept / nack |
| `wa-engine:ready` | engine → main | `{hooked: string[], total: number}` | WASM stack initialized; outbound surface intercepted |
| `wa-engine:probe-result` | engine → main | `{ok, methods?, totalKeys?, why?}` | Module reachability diagnostic |
| `wa-engine:outbound-signaling` | engine → main | `(method: string, args: unknown[])` | Engine emitted a signaling callback; relay to hybrid sharedTw |

`EngineOfferPayload` mirrors the `handleIncomingSignalingOffer` signature exactly:
`{ xmlNodeBase64, msgPlatform, msgVersion, msgE, msgT, msgOffline, isOfferNotContact, peerJid }`.

---

## How to run

### Prerequisites

- A **logged-in hybrid session** in the default WhatsApp profile (the hybrid window)
- Electron sandbox setup: either `root:root 4755` on `chrome-sandbox` or `ELECTRON_DISABLE_SANDBOX=1`

### Engine mode (Method 3 spike)

```bash
WA_ENGINE_MODE=1 WA_BRIDGE_DEBUG=1 ELECTRON_DISABLE_SANDBOX=1 npm start
```

On first run the engine window is hidden. To reveal it and scan its QR code:

```bash
WA_ENGINE_MODE=1 WA_ENGINE_SHOW=1 WA_BRIDGE_DEBUG=1 ELECTRON_DISABLE_SANDBOX=1 npm start
```

You must **pair the engine window as a SEPARATE linked device** by scanning its own QR code with a
second WhatsApp account or by using your phone's "Linked Devices" on the same account (WhatsApp
now supports multiple linked desktop sessions). The engine window's session is isolated in
`persist:wa-engine`.

To trigger an incoming call, **call from a second account** to the account logged in to the hybrid
window. Watch the console for:

```
[engine] probe result: {"ok":true,"methods":[...],"totalKeys":N}   ← WASM module reachable
[engine] WASM voip stack ready: {"hooked":[...],"total":9}          ← outbound surface hooked
[engine] outbound-signaling relay: handleSignalingXmpp ...          ← engine emitting signaling
```

### Voip probe (confirm hybrid window can't load WASM module)

```bash
WA_VOIP_PROBE=1 WA_BRIDGE_DEBUG=1 ELECTRON_DISABLE_SANDBOX=1 npm start
```

Watch the console for `[wa-voip-probe]` lines ~3 s after the hybrid page loads. Expected output:

```json
{"method":"require","ok":false,"error":"..."}
{"method":"requireLazy","ok":false,...}           ← module absent from ?windows=1 manifest
{"method":"JSResourceForInteraction","ok":false,...}
```

If `requireLazy` returns `ok: true` with methods in the hybrid window, the bundle has changed and
the two-window architecture may no longer be necessary.

---

## What works (at the scaffold level)

- ✅ Hidden engine window created with `persist:wa-engine` partition, own session, SAB + audio switches
- ✅ Call shims installed (permission override, AB prop force) so the WASM engine initializes
- ✅ Engine preload probes `WAWebVoipStackInterfaceWeb` reachability via `requireLazy` on load
- ✅ Engine preload intercepts named outbound-signaling methods (`handleSignalingXmpp`, etc.)
- ✅ `handleIncomingSignalingOffer` in VoipBridge forwards offer payload to engine over IPC
- ✅ `handleIncomingSignalingMessage` and `handleIncomingSignalingAck` forwarded similarly
- ✅ Engine outbound-signaling relayed back to the hybrid page's `sharedTw` ToWeb bus
- ✅ `WA_VOIP_PROBE` injection into the hybrid window tests module reachability under `?windows=1`
- ✅ `npm run lint` clean, `tsc --noEmit` clean, `npm run package` build passes

---

## What is BLOCKED and why

### 1. Socket / signaling-unification (the core hard problem)

**What blocks it:** The engine window's WASM stack registers its own WhatsApp WebSocket when it
loads (a separate linked-device session with its own device JID, noise-protocol keys, and signal
session state). Outbound signaling from the WASM engine — the ICE candidates, DTLS fingerprints,
capability answers, etc. — is encoded and transmitted by the engine's OWN WebSocket (the engine
window's device session), NOT by the hybrid window's WebSocket.

The named-callback interception in `engine-preload.ts` captures the engine's high-level callback
surface (`handleSignalingXmpp` etc.) when the engine fires them BACK to its own JS context. But
those callbacks, in the plain-web page's normal flow, drive the page's own socket — they are
already DONE with transmission. Intercepting them after the fact and re-delivering them to the
hybrid window's subscribe sink means the hybrid window receives signaling output that was ALREADY
sent on the engine's device session.

The caller's client will receive duplicate or conflicting signaling from two device JIDs (the
hybrid session and the engine session) which will confuse WhatsApp's multi-device call routing.

**What fixing it requires:** Intercepting the engine's transport layer BEFORE it sends — patching
the WA bundle's socket-send path (the `WAWebSocketClient` or equivalent module) inside the engine
window to redirect outbound frames to the hybrid window's socket. This is deep inside the bundle,
changes every deploy, and is not exposed as a named surface. It would require:
- Injecting a `WebSocket` proxy early enough that the bundle's socket constructor uses the proxy
- Routing the proxy's `send()` calls to the hybrid window's socket via IPC
- This must happen before the bundle's noise-protocol handshake, so very early in page load

Even then, the two sessions have different noise-protocol keys and device JIDs, so the server may
still route the call to whichever device it thinks is active.

### 2. Dual-session device identity

The engine window MUST be paired as a second linked device. WhatsApp's multi-device protocol
assigns each linked device a unique device JID (e.g. `user@s.whatsapp.net:3`). The hybrid window
has device `:0` or `:1`; the engine window gets `:2` or `:3`. An incoming call offer is delivered
to all paired devices. When the hybrid window receives it (via `handleIncomingSignalingOffer`) and
forwards it to the engine, the engine attempts to answer on its OWN device identity — not the
hybrid window's identity. The caller sees a call from device `:3` answering when device `:1` got
the offer, which the server may reject.

The only clean fix is key-sharing: give the engine window the SAME noise-protocol identity and
Signal session state as the hybrid window (same device JID + keys). This would effectively
duplicate the device identity — almost certainly a protocol violation and a ban risk.

### 3. Media output routing

Assuming signaling unification were solved: the WASM engine opens mic/camera and renders audio in
the engine window (hidden, no visible UI). There is no mechanism to pipe the engine's audio output
to the hybrid window's UI, nor to show the call controls in the hybrid window while audio runs in
the engine window. The call UX would be invisible.

Partial mitigation: show the engine window (`WA_ENGINE_SHOW=1`) and let the user interact with it
directly for calls — essentially the same UX as CALL_MODE but with the hybrid window open in
parallel. This is architecturally equivalent to running two separate Electron windows (Method 1 or
2), not a true bridged integration.

---

## Honest viability verdict

**The two-window architecture is viable only as a UI-level separation (show both windows), not as
a transparent WASM-engine-in-the-background bridge.**

The named-callback relay layer built here (the IPC scaffold) works correctly as far as it goes.
But the socket/signaling-unification problem and the dual-device-identity problem are
protocol-level blockers, not implementation gaps. Solving them would require:
- Either: deeply patching the WA bundle's transport layer (fragile, deploy-coupled, high ban risk)
- Or: sharing cryptographic device-identity material across two Electron sessions (protocol
  violation)

The `WA_VOIP_PROBE` diagnostic (deliverable 5) is the most practically useful output of this spike:
run it to confirm whether the current deployed bundle still cannot load `WAWebVoipStackInterfaceWeb`
under `?windows=1`. If that check ever returns `ok: true`, the WASM stack has been made available
in the hybrid context and the whole two-window architecture becomes unnecessary.

The IPC scaffold, the engine-window session isolation, and the call-shim infrastructure are all
reusable if the protocol problems above are later resolved.
