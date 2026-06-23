# call-2window — implementation notes

## What changed

### New files
| File | Purpose |
|---|---|
| `src/waConfig.ts` | Shared constants (`WA_ORIGIN`, `WA_HOST_ORIGIN`) and `cleanUserAgent()` helper, extracted to avoid a circular import between `main.ts` and `callWindow.ts` via the bridge glob chain |
| `src/callWindow.ts` | Self-contained call-window module: creates/focuses a second `BrowserWindow` on the `persist:wa-call` Electron session partition with its own permission handlers, call shims, popout allow-list, and popout auto-close logic |

### Modified files
| File | Change |
|---|---|
| `src/main.ts` | Removed `CALL_MODE` env-var branching entirely (main window is always hybrid). Applied `SharedArrayBuffer` / `AudioServiceSandbox` CLI switches unconditionally. Added `registerMainWindow()` call after window creation. Added **"Calling"** tray menu item that lazily calls `createCallWindow()`. Imports `WA_ORIGIN`, `WA_HOST_ORIGIN`, `cleanUserAgent` from `waConfig.ts`. |
| `src/window.ts` | Added `registerMainWindow(w)` so `showMainWindow()` unambiguously targets the hybrid window even when the call window also exists. Falls back to `getAllWindows().find()` if called before registration. |
| `src/bridge/impl/voip.ts` | Imports `showCallWindow` from `callWindow.ts`; calls it inside `showIncomingCallToast` so an incoming hybrid-bridge signal also raises the call window (no-op if the user hasn't opened it yet). |

## Architecture

```
App start
  └─ createWindow()  →  hybrid BrowserWindow (default session, preload, ?windows=1)
                         └─ installBridges() — native bridges including VoipSignalingBridge
  └─ createTray()    →  "Calling" menu item → createCallWindow() [lazy]
                         └─ second BrowserWindow (persist:wa-call partition, NO preload)
                              ├─ plain web.whatsapp.com (WASM voip stack)
                              ├─ own permission handlers (mic/cam always granted)
                              ├─ CALL_SHIMS_JS (navigator.permissions + AB-prop force)
                              └─ popout allow-list + title-based popout auto-close

Incoming call (hybrid bridge fires VoipSignalingBridge.handleIncomingSignalingOffer)
  ├─ toast notification (existing)
  ├─ ring sound (existing)
  ├─ showMainWindow() — raise hybrid window
  └─ showCallWindow() — raise call window if already open (new)
```

## How to run and test

### Requirements
- Two separate WhatsApp accounts (or the same account on two linked devices — one for the hybrid window, one for the call window)

### Dev run
```bash
# Option 1 — with sandbox (needs chrome-sandbox setuid):
npm start

# Option 2 — no sandbox (dev only):
npm run dev
# or
ELECTRON_DISABLE_SANDBOX=1 npm start
```

### Pairing the call window
1. App opens the **hybrid window** as usual — scan QR with phone / link device as before.
2. Right-click the tray icon → **Calling** — the call window opens.
3. In the call window, scan a **second QR code** with a different WhatsApp account (or "Link a Device" from the same account on a second device).
4. Once paired, the call window runs plain `web.whatsapp.com` with WASM calling enabled. Make/receive calls from there.

> **Two QR pairings are required** — hybrid and call window are independent linked devices.

### Incoming call flow
When the hybrid-bridge device receives a call offer, the app:
- Shows a desktop toast
- Rings the Windows ringtone
- Raises both the hybrid window *and* the call window (so you can answer on the call window's WASM engine)

### Debug flags (unchanged from upstream)
```bash
WA_BRIDGE_DEBUG=1 npm start           # trace every bridge call
HYBRID_SMOKE=1 ELECTRON_DISABLE_SANDBOX=1 npm start  # SQL round-trip self-check
```

## Verified

| Check | Result |
|---|---|
| `npm run lint` | ✅ exit 0, no warnings |
| `npx tsc --noEmit` | ✅ exit 0, no errors |
| `npm run package` | ✅ exit 0, Vite bundle + forge packaging complete |
| Manual GUI + calling | ⏳ **Needs user live test** (requires display + two QR pairings) |

## Risks and limitations

1. **Two QR pairings**: the call window is a fully separate linked device. The user must pair it separately. WhatsApp limits linked devices; if the account is at the limit, pairing will be refused by WhatsApp's servers.

2. **COOP/COEP for SharedArrayBuffer**: the call window relies on WhatsApp serving its own `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers to make the page `crossOriginIsolated` (required for WASM SharedArrayBuffer). We do *not* force these headers from the shell — forcing COOP severs `window.opener` in the call popout. If WhatsApp stops serving COOP, the WASM voip stack will stop working.

3. **AB-prop shim is version-coupled**: the `WAWebABProps.setGetABPropConfigValueImpl` hook that forces `enable_web_calling: true` is tied to the bundle's module system. A WhatsApp bundle update could rename the module or the method. If the call button disappears, this shim needs updating (doc 43 §6 Phase 3).

4. **popout auto-close heuristic**: the call popout is auto-closed when its title reverts from `"WhatsApp call"` to `"WhatsApp"`. This is a title-string heuristic; a bundle localization change could break it.

5. **`persist:wa-call` partition lives in the same userData dir** as the hybrid session. Deleting app data clears both. The call window session is not affected by the hybrid window's `?windows=1` params or native bridge calls.

6. **No CDP persistent-storage grant for the call window**: the hybrid window gets `Browser.setPermission persistent-storage granted` via CDP. The call window gets it via the `setPermissionCheckHandler` on its session (origin-gated). This should be sufficient but hasn't been live-tested against WA's storage-persist check.
