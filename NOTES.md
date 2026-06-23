# call-2window — implementation notes

One **WhatsWine window with two stacked `WebContentsView` layers**, giving real WASM-backed
WhatsApp calling alongside the native-bridge hybrid chat:

- **Hybrid chat** (base layer, always visible) — `web.whatsapp.com/?windows=1`, preload + native
  `chrome.webview.hostObjects.*` bridges, default session. Its VoIP engine is stubbed (no Linux
  native IVoip), so it cannot place/take calls itself.
- **Call layer** (top layer, **kept hidden in the background**) — plain `web.whatsapp.com` on its
  own `persist:wa-call` session partition, **no preload**, logged in as a SEPARATE linked device.
  Plain web means the bundle's own WASM voip stack (pjsip/opus/WebRTC) is available. Kept warm with
  `backgroundThrottling: false` so the first call has no cold start.

Both layers are children of one `BrowserWindow` (`mainWindow.contentView`), sized to the window on
resize. The window's own root webContents is blank — both views render on top.

## Files
| File | Purpose |
|---|---|
| `src/callView.ts` | The call layer: WebContentsView + session/permissions, per-window COOP/COEP rewrite, calling shims, **outgoing-call hand-off** (`placeCall`), popout handling, opener-side guard. |
| `src/waConfig.ts` | Shared `WA_ORIGIN` / `WA_HOST_ORIGIN` / `cleanUserAgent()`. |
| `src/main.ts` | Hosts the two layers in one window; tray **Calling** / **Show WhatsApp**; resize layout. |
| `src/bridge/impl/voip.ts` | VoIP bridge stubs; incoming-call toast; `startCall` → `placeCall`. |
| `src/sound.ts` | Message-notification tone (plays into the hybrid view's webContents). |

`src/callWindow.ts` and `src/ringtone.ts` were removed (former separate-window approach + synthetic
ringtone).

## Enabling calling (doc 43 §4, §6)
The call layer needs to be plain-web, cross-origin isolated, and have the calling AB-props on:

1. **Cross-origin isolation — per-window COOP split** (`onHeadersReceived` on `callSession`):
   - **main call view → `same-origin-allow-popups`**: not isolated, but keeps `window.opener`
     intact so the call popout opens correctly.
   - **call popout → `same-origin`**: isolated, so the WASM engine runs in it.
   - COEP `require-corp` for both (`WA_COEP=credentialless` escape hatch).
   > Forcing `same-origin` on the *main* view blanks the popout — doc 43 §4 caveat, learned the hard way.
2. **AB-prop force** (`CALL_SHIMS_JS`): wraps the **bound** `WAWebABProps.getABPropConfigValue`
   directly (NOT `setGetABPropConfigValueImpl`, which recurses) and forces `enable_web_calling`,
   `enable_web_group_calling`, `web_calling_download_voip`, `web_calling_init_voip`,
   `web_calling_auto_popout_video`. Also patches `navigator.permissions.query` mic/cam → `granted`.

## Outgoing call — hand-off to the popout
On a hybrid call click, `VoipBridge.startCall` → `placeCall(peerJid, useVideo)` runs JS in the
**hidden** call layer (no reload), using WhatsApp's own modules:
1. open the chat by jid — `WAWebWidFactory.createWid(jid)` → `WAWebVoipActionRequestOpenChat.requestOpenChat(wid)` (works for `@lid` and phone peers, same account); retried until WA's modules have booted (cold start);
2. click the chat-header call button — `aria-label` `Voice call`/`Video call`, fallback `optionId="voice-call"/"video-call"`; retried each tick until a call is active;
3. once `WAWebCallCollection.activeCall` is set → `WAWebVoipUiManager.openVoipUiPopoutWindow()`.

Injected with `executeJavaScript(js, /*userGesture*/ true)` so the bundle's `window.open` isn't
popup-blocked. The overlay is shown **only if the hand-off fails** (fallback). `@lid` peers with no
number still work (jid-based); groups / numberless peers fall back to surfacing the layer.

## The popout window
- Opened by WhatsApp via `openVoipUiPopoutWindow()` (`window.open` to a real same-origin URL → gets
  the `same-origin` isolation headers). Our `setWindowOpenHandler` allows same-origin WA popouts and
  **sizes them to cover the main window** (`win.getBounds()`), keeping the system frame (movable /
  maximizable). It is the visible call surface.
- **Auto-close on call end (event-driven):** the popout subscribes to
  `WAWebCallCollection.on('change:activeCall')` and closes when the active call goes away
  (hang up / reject). A one-shot ~25s timer closes a popout that never connects (blank). _Decision A:
  closes right after WhatsApp's own brief "Call ended" screen — not before._
- **Closing / moving the call out → end it:** an opener-side guard in the call layer watches
  `WAWebVoipPopoutWindowState.getIsCallActiveInPopoutWindow()`; if a call was in the popout and then
  leaves it (system close, WA's "Back to chat", picture-in-picture), it clicks WhatsApp's own
  **End call** control — so a call can never keep running invisibly in the hidden layer.

## Calling UX (switching / incoming)
- Tray **Calling** shows the call layer; **Show WhatsApp** / tray-icon click drops it back to chat;
  **Esc** while the call layer is focused returns to chat.
- **Incoming call:** the hybrid VoIP bridge gets the offer → desktop toast ("… is calling. Answer
  here."), raises the window, and shows the call layer (which rings natively as a real device). No
  synthetic ringtone.

## Env flags
| Flag | Effect |
|---|---|
| `WA_CALL_DIAG=1` | Logs `[call-diag]` caps/gating + `[wwine-call]` hand-off trace + forwards call view / popout console (`[call-popout] state {url,coi,SAB}`). |
| `WA_COEP=credentialless` | Loosen the call layer's COEP if a cross-origin subresource breaks under `require-corp`. |
| `WA_BRIDGE_DEBUG=1` | Hybrid bridge tracing; also forwards the call view/popout console. |

---

## Loose ends & known flaws

### Fragility (the big one)
- **The whole outgoing-call flow remote-controls a second WhatsApp Web device.** It depends on WA
  internal **module names** (`WAWebWidFactory`, `WAWebVoipActionRequestOpenChat`, `WAWebCallCollection`,
  `WAWebVoipUiManager`, `WAWebVoipPopoutWindowState`, `WAWebABProps`) and **DOM aria-labels**. A
  WhatsApp bundle update can rename any of these and silently break calling. All are marked
  `ponytail:` in code. There is **no automated test** — every regression surfaces only at runtime.
- **Localized selectors.** The call-start (`/voice call/i`, `/video call/i`) and the End-call
  (`/end call|leave call|hang up/i`) matches are **English-only**. On a non-English WhatsApp Web the
  call-button has the locale-independent `optionId` fallback, but **End call has no such fallback** —
  the opener-guard hangup and would break in other languages.

### Incoming calls
- **Incoming calls still use the overlay, not the direct popout.** You answer in the shown call
  layer; the popout-direct flow is outgoing-only. (Could be unified with `openVoipUiPopoutWindow()`
  on answer, as a follow-up.)
- Incoming ring depends on the call layer being **paired and warm**. If it isn't paired, you only get
  the desktop toast, no ring.

### Account / pairing constraints
- **Two linked devices required** (hybrid + call layer = two QR pairings). WhatsApp's linked-device
  limit applies.
- **Hand-off assumes the SAME account** on both (so the peer jid resolves in the call layer). With
  two *different* accounts the contact won't exist in the call layer and the hand-off fails to the
  overlay.
- **Server eligibility still gates the actual call** (`NackCallerNotEnabled` 403) if the account /
  region isn't enabled for WhatsApp web calling. Forcing AB-props only surfaces the UI + engine.
- **Group calls / numberless peers**: `startGroupCall` just surfaces the call layer (no auto-dial).

### Behavioural rough edges
- **Persistent-storage denied on the call layer.** The call layer logs
  `aquire-persistent-storage-denied`; only the hybrid window gets the CDP
  `Browser.setPermission persistent-storage` grant. It currently works via the permission-check
  handler, but WhatsApp can roll back a login when storage isn't persistent — untested over long runs.
- **Opener-side guard still polls** every 500ms (`getIsCallActiveInPopoutWindow`). Could be converted
  to events (`WAWebVoipUiPopoutWindowEventEmitter` + `change:activeCall`) but wasn't.
- **Cold-start window is ~30s.** First call right after boot retries until WA's modules load; if boot
  takes longer than ~30s the hand-off times out and falls back to the overlay.
- **Popout size is set once** at creation from `win.getBounds()`. If the main window is moved/resized
  afterward, the popout doesn't follow.
- **Hidden-layer layout assumption.** The auto-click relies on WhatsApp laying out the chat/call
  button while the call layer is hidden. It works today; if Chromium ever defers layout for a hidden
  `WebContentsView`, the click would fail (→ fallback overlay).
- **`web_calling_auto_popout_video` + explicit `openVoipUiPopoutWindow()`** could both try to pop out
  a video call; appears idempotent but not deeply verified.

### Documentation
- `PORTING.md` still lists VoIP under "known hard edges," which is now partly outdated for this branch.

## Verified
| Check | Result |
|---|---|
| `npx tsc --noEmit` / `npm run lint` | ✅ |
| `HYBRID_SMOKE=1` (SQL round-trip through the layered hybrid view) | ✅ PASS |
| `WA_CALL_DIAG=1` boot — `crossOriginIsolated:true`, gating green, pjsip/opus/OpenH264 engine init | ✅ |
| Live outgoing call (`@lid`, same account): hand-off → popout covers window → ends on reject/hangup | ✅ confirmed |
