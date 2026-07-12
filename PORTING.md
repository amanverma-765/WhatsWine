# whatswine — Windows-hybrid Linux/Electron port

This is a port of the **Meta native WhatsApp for Windows** hybrid architecture (docs
`90` §M0, `31`), **not** a plain `web.whatsapp.com` wrapper. The Windows client is a
thin native shell that hosts the WhatsApp Web JS bundle in WebView2 and exposes native
capabilities as `window.chrome.webview.hostObjects.<Name>` bridges. This port
reproduces that seam on Electron.

## Status: ✅ reaches a working logged-in client

Verified end-to-end on a real account (`…@s.whatsapp.net`): loads in hybrid mode →
renders the QR → pairs → **login sticks** → syncs contacts/profile-pictures/chats, with
`executeSqlite` persistence working. 29 host-object bridges registered.

## Architecture (the hybrid seam)

| Piece | File | What it does |
|---|---|---|
| Hybrid host | `src/main.ts` | Loads `web.whatsapp.com/?windows=1&windowsBuild=…&bridgeError=1&launchContext=…&osBuild=…` (the `win_hybrid` code paths) + `X-WA-WebView2-Version` header; force-grants persistent storage (CDP `Browser.setPermission`, mirroring `ForcePersistentStoragePermission`, doc 31 §3.3); tray/badge/notifications/single-instance. |
| Bridge Proxy | `src/preload.ts` | Rebuilds `chrome.webview.hostObjects.<Name>` as a Proxy in the page's **main world** via `executeInMainWorld`. Sync vs `*Async` routing, `ignoreMemberNotFoundError`, the promise-marker (sync calls can return a Promise, mirroring WinRT `IAsyncOperation`), `Subscribe(web)` callback objects kept in the main world, legacy comma-IPC shim. |
| Dispatch | `src/bridge/registry.ts` | `ipcMain` sync/async handlers; auto-discovers `impl/*.ts` via Vite glob; `WA_BRIDGE_DEBUG=1` traces every call + flags missing methods. |
| Services | `src/bridge/services.ts` | native sqlite (better-sqlite3, WAL/FULL/secure_delete), `safeStorage` secret store (DPAPI substitute), install-salt. |
| Callbacks | `src/bridge/eventtarget.ts` | `toWeb()` — the native→JS `*BridgeToWeb` surface. |

### Critical fidelity details (each was a real bug found by tracing)
1. **`windowsBuild` must be a single integer** — the bundle does `appVersion.quaternary = Number(windowsBuild)` (UINT32). A dotted version → `NaN` → login `ClientPayload` fails to encode → socket closes 1006 → QR spins forever.
2. **Persistent storage must be granted** — WA Web rolls back a successful login (`aquire-persistent-storage-denied`) if `navigator.storage.persist()` is denied. Granted via CDP + permission handlers.
3. **`SQLiteBridge.executeSqlite` is JSON-string in / JSON-string out** — the bundle calls `executeSqlite(JSON.stringify(queries))` and `JSON.parse(result)`, not array-in/array-out.
4. **JS method names are camelCase**; `Subscribe(web)` passes a callback *object* (not a function); `addEventListener` is a bundle probe meant to be member-not-found.

## Bridges (`src/bridge/impl/`)

| Module | Bridges | Real vs stub |
|---|---|---|
| `sqlite.ts` | SQLiteBridge | **Real** (better-sqlite3) |
| `keys.ts` | ClientKey, ServerEncKeySalt, Adv | **Real** (safeStorage; `verify`→libsignal XEdDSA) |
| `startup.ts` | Connection, NativeAppState, Preferences, SystemIntegrations (native toasts/badge), WebUpdate, BrowserExtensions, SeamlessMigration | **Real** (Electron primitives) |
| `data.ts` | Contacts/PopulatedContacts, Wam, AbProps, TcToken | **Real** (sqlite stores) / TcToken dormant |
| `media.ts` | MediaFiles, MediaTranscoding, Pictures | MediaFiles real (fs+dialog); **MediaTranscoding stub** (no WebView2 shared-buffer); Pictures real |
| `voip.ts` | Voip, VoipSignaling | Surface + signaling pass-through; hybrid media engine stub (no Linux IVoip) — **1:1 calls hand off to the call layer** (`callView.ts`, working); group calls unsupported (toast) |
| `shell.ts` | AppActivation, Sharesheet, ScalingControl, RateApp, LinksPreview | Real (LinksPreview = fetch+OG parse) |
| `core.ts` | DebugFeatures, TouchpadFix, `__legacy__` | thin/no-op |

## Known hard edges (no clean Linux equivalent — documented, not oversights)
- **VoIP media engine** (`IVoip` relay + HBH-SRTP) — proprietary; the hybrid view's own call
  path can't connect media. **Worked around, not fixed**: 1:1 calling is fully delivered by
  the call layer (`callView.ts` — a hidden second linked device running plain web.whatsapp.com,
  whose WASM voip stack carries the media; calls live in WhatsApp's own popout window; see
  `NOTES.md`). Group calling remains unsupported (no dialable hand-off — native toast).
- **MediaTranscoding** — WebView2 `PostSharedBuffer` frame API; the bundle has a WASM fallback.
- **Media save byte-channel**, **WNS push**, **DPAPI machine-binding** — substituted or stubbed (`safeStorage`, OS file ACLs).

## Run

```bash
npm start                                  # dev (window on your display)
WA_BRIDGE_DEBUG=1 npm start                # + trace every bridge call, console, websockets
HYBRID_SMOKE=1 ELECTRON_DISABLE_SANDBOX=1 npm start   # headless seam self-check (SQL round-trip)
npm run lint
```
Linux dev note: Electron's chrome-sandbox needs `chrome-sandbox` to be `root:root 4755`, else export `ELECTRON_DISABLE_SANDBOX=1` (dev only — keep `sandbox:true` in code).

## Next (post-login polish, evidence-driven via `WA_BRIDGE_DEBUG`)
Wire native media download (`session.will-download` → resolve `MediaFilesBridge` pending) and real notification reply actions (libnotify). VoIP strategy is decided and shipped: the call-layer linked device (bundle WebRTC/WASM) carries 1:1 calls; remaining calling work is tracked in `CALL_REVIEW_TODO.md` (A1 watchdog, A3 focus-steal).
