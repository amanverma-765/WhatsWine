# Path B — Feasibility Spike: WASM Voip Stack as Headless Media Core

> **Status:** Probe harness built. Verdicts for U1 and U2 depend on the user running it.
> Fill in the **Feasibility** section after running the smoke command below.

---

## What this spike answers

**U1** — Does `WAWebVoipStackInterfaceWeb` (the WASM voip stack module) _load_ in a plain-web
Electron context **without a logged-in WhatsApp session** (no QR scan)?

**U2** — Once obtained, what is the stack's API surface, and what does it _demand_ when fed a
synthetic inbound offer via `handleIncomingSignalingOffer`? Does it work with externally-supplied
data, or does it hard-depend on an active session / socket / key store?

These two unknowns determine whether the headless-media-core architecture (a separate plain-web
window hosting the WASM engine, with signaling forwarded over IPC from the hybrid main window) is
worth building out.

---

## Run commands

### 1. Logged-out smoke (cheapest U1 test — no QR, headless, auto-quit)

```bash
WA_PATHB=1 WA_PATHB_SMOKE=1 WA_BRIDGE_DEBUG=1 ELECTRON_DISABLE_SANDBOX=1 npm start 2>&1 | tee /tmp/pathb-smoke.log
```

- `WA_PATHB=1` — activates Path B mode: creates only the ephemeral probe window, skips the hybrid
  main window and native bridges.
- `WA_PATHB_SMOKE=1` — headless run; the app quits automatically 1 s after the probe result
  arrives, or after a 22 s hard-fallback timeout.
- `WA_BRIDGE_DEBUG=1` — not strictly required but pipes the WA page console to stdout (all
  `[path-b]` lines, plus bundle errors). Strongly recommended so you see probe output.
- `ELECTRON_DISABLE_SANDBOX=1` — required on most Linux dev setups where
  `chrome-sandbox` is not `root:root 4755`.

The probe fires automatically after the page loads (~4 s settle). Total runtime: 16–22 s.

### 2. Interactive (with QR — logs stay open, window visible)

```bash
WA_PATHB=1 WA_BRIDGE_DEBUG=1 ELECTRON_DISABLE_SANDBOX=1 npm start
```

The probe window is shown. You can optionally scan the QR to log in and then re-run the probe
from the DevTools console:

```js
// Re-trigger Path B probe manually (after login, to compare pre- vs post-login results)
window.__waEngineIpc  // should be defined by the preload
```

*(The probe fires automatically 4 s after page load even without a QR scan.)*

### 3. Logged-in comparison (if U1 is negative pre-login)

If U1 fails pre-login (module not in the bundle manifest for a cold ephemeral session), try a
session that has previously loaded the WA page:

```bash
WA_PATHB=1 WA_PATHB_SMOKE=1 WA_BRIDGE_DEBUG=1 ELECTRON_DISABLE_SANDBOX=1 npm start
```

*(The ephemeral partition `partition:wa-pathb` is always fresh — to retain state across runs,
temporarily change `PATHB_PARTITION` in `engine-window.ts` to `'persist:wa-pathb'`.)*

---

## What each `[path-b]` log line means

All lines are prefixed `[path-b]` and printed as `TAG JSON_PAYLOAD`.

| Tag | Meaning |
|-----|---------|
| `PROBE-START` | Probe began executing in the page's main world |
| `CAPS` | Browser capability snapshot: `crossOriginIsolated`, `SharedArrayBuffer`, `RTCPeerConnection`, `WebTransport`, `Atomics` |
| `GATING` | VoIP gating flags from `WAWebVoipGatingUtils`: `isCallingEnabled`, `isVoipDownloadEnabled`, `isVoipInitEnabled`, `unsupportedReason` |
| `U1c` | Result of synchronous `window.require('cr:22885').createWAWebVoipStackInterface()` — the bundle-manifest alias. `ok:true` means the WASM factory is callable. `error:"Requiring unknown module"` means the alias is not in this session's manifest. |
| `U1a` | Result of `requireLazy(['WAWebVoipStackInterfaceWeb'], cb)` with a 12 s timeout. `fired:true, ok:true` = module registered and resolved. `result:"TIMEOUT-12s"` = callback never fired (module absent from manifest). |
| `U1b` | Result of `requireLazy(['WAWebVoipStackInterface']).getVoipStackInterface()`. `type:"web"` = WASM stack selected. `type:"windows"` = native stub selected (should not happen in plain-web). |
| `STACK-OBTAINED` | Which U1 path obtained the stack reference (`U1a`, `U1b`, `U1c`, or `none`). |
| `API-SURFACE` | Full method list with arity if a stack was obtained. `totalKeys` = number of own keys. `methods` = function keys (name + arity). `nonFns` = non-function keys (constants, type tags). |
| `U2-INIT` | Whether `stackRef.voipInit()` exists and whether it threw. Some WASM stacks require explicit init before accepting offers. |
| `U2-OFFER` | Call to `handleIncomingSignalingOffer` with a 3-byte garbage WAP node + placeholder args. `threw:false` = the engine accepted the call without immediately throwing. `threw:true, error:...` = the engine threw synchronously (look at the error to understand the dependency). |
| `U2-CALLBACK-FIRED` | A ToWeb callback fired during or after the synthetic offer. `method` is the callback name (e.g. `requestDeviceJidList` = engine is trying to resolve device JIDs; `handleSignalingXmpp` = engine produced outbound signaling). |
| `U2-CALLBACKS-SUMMARY` | All callbacks that fired in the 2 s window after `handleIncomingSignalingOffer`. |
| `PROBE-DONE` | Final summary: `u1Loadable:true/false`, `via:"U1a"/"U1b"/"U1c"/"none"`, `u2:{...}`. |
| `RESULT (from preload)` | Same summary echoed from the main process after receiving `wa-engine:pathb-result` IPC. |
| `[pathb-page]` prefix | WA bundle console messages forwarded from the renderer (not from the probe itself). Look here for bundle errors, socket events, and `requireLazy` resolution traces. |

---

## How to read the U1 verdict

| U1a/U1b/U1c outcome | Interpretation |
|---------------------|----------------|
| Any `ok:true` | **U1 PASS** — the WASM stack module is loadable in plain-web, pre-login. The headless-core approach is viable at the module level. |
| All `TIMEOUT-12s` or `"Requiring unknown module"` | **U1 FAIL** — the module is not in the bundle manifest for this session. Possible causes: (a) requires a logged-in session to fetch the manifest, (b) requires `enable_web_calling` server flag to be pushed first, (c) ephemeral partition means no cached chunks. Try the logged-in variant (command 3 above). |
| `U1b fired:true, type:"windows"` | **U1 WRONG-STACK** — the module loaded but selected the native Windows stub, not the WASM impl. Should not happen without `?windows=1`; investigate `WAWebEnvironment.isWindows` in CAPS. |

## How to read the U2 verdict

| U2 outcome | Interpretation |
|------------|----------------|
| `threw:false` + callbacks fired | **U2 PROMISING** — engine accepted the call and is making demands (key derivation, device JID lookup). The API surface is live and externally-drivable. |
| `threw:false` + no callbacks | **U2 SILENT** — engine accepted but did nothing. Either the garbage WAP node was silently discarded or init is required first. Check `U2-INIT`. |
| `threw:true, error:"...WAP..."` | Engine is parsing WAP and rejects garbage — expected. Means the ingestion path works; a real WAP-encoded offer would go further. |
| `threw:true, error:"...session..."` or `"...key..."` | Engine hard-depends on an active session/key store. Headless use requires supplying those dependencies externally. |
| `requestDeviceJidList` callback fired | Engine is live and asking for device fan-out information — strong positive signal. |
| `handleSignalingXmpp` callback fired | Engine produced outbound signaling — very strong positive signal (it thinks the call is progressing). |

---

## Feasibility (fill in after running)

```
Date run:
Command used:
Profile state (logged-out / logged-in):

CAPS:
  crossOriginIsolated: [ ]
  SharedArrayBuffer:   [ ]
  RTCPeerConnection:   [ ]

GATING (pre-login, with CALL_SHIMS forced):
  isCallingEnabled:       [ ]
  isVoipDownloadEnabled:  [ ]
  unsupportedReason:      [ ]

U1 verdict:
  U1c (cr:22885):                   PASS / FAIL / error: ___
  U1a (requireLazy direct):         PASS / TIMEOUT / error: ___
  U1b (getVoipStackInterface):      PASS / TIMEOUT / type: ___
  Stack obtained via:               ___
  totalKeys on stack:               ___
  Notable methods:                  ___

U2 verdict:
  voipInit:                         present / absent / threw: ___
  handleIncomingSignalingOffer:     present / absent
  offer threw:                      yes / no — error: ___
  callbacks fired:                  ___

Overall feasibility:
  [ ] GREEN  — stack loads pre-login, API is externally-drivable; proceed to Phase 1 build
  [ ] YELLOW — stack loads but requires logged-in session; investigate manifest gating
  [ ] RED    — stack not loadable in plain-web at all; headless-core approach is blocked
```

---

## Key facts from prior reverse-engineering (doc 43)

These are **predictions** from static analysis, not measured results of this probe:

- In `?windows=1` mode `WAWebVoipStackInterfaceWeb` is **empirically not loadable** — every path
  fails (confirmed live, 2026-06-22). This spike tests the **opposite**: plain-web, pre-login.
- `WAWebEnvironment.isWindows === false` in plain-web is **confirmed** (doc 43 §9).
- `crossOriginIsolated:true` is **confirmed** with forced COOP `same-origin` (doc 43 §9).
- `getUnsupportedBrowserReason() === null` is **confirmed** — Electron/Chromium on Linux passes
  the browser-capability gate (doc 43 §9).
- Whether the module manifest in an **ephemeral, logged-out** plain-web session includes
  `WAWebVoipStackInterfaceWeb` is **not yet measured** — that is the primary U1 question here.
- `enable_web_calling` defaults `false` server-side; the CALL_SHIMS override forces `true`
  client-side so `isVoipDownloadEnabled` is true regardless.
