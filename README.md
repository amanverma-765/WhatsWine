# WhatsWine

**Unofficial WhatsApp desktop client for Linux** — an Electron shell over WhatsApp Web's
Windows-hybrid bundle.

WhatsWine is not a `web.whatsapp.com` wrapper. It reproduces the architecture of **Meta's native
WhatsApp for Windows**: a thin native shell that hosts the real WhatsApp Web JS bundle and exposes
OS capabilities to it through `window.chrome.webview.hostObjects.<Name>` bridges. The Windows client
does this with WebView2; WhatsWine does it with Electron — giving you a native-feeling Linux client
(tray, badge, native notifications, local SQLite persistence) running the genuine WhatsApp Web code.

> ⚠️ Unofficial. Not affiliated with or endorsed by WhatsApp/Meta. Use at your own risk.

## Status

✅ **Reaches a working logged-in client.** Verified end-to-end on a real account: loads in hybrid
mode → renders the QR → pairs → **login sticks** → syncs contacts, profile pictures, and chats, with
native SQLite persistence. 29 native host-object bridges are registered.

## Features

- Real WhatsApp Web bundle, in WhatsApp's own native hybrid mode (`?windows=1`) — not a browser tab.
- Native SQLite persistence via `better-sqlite3` (WAL + secure-delete).
- Login secrets stored through Electron `safeStorage` (a DPAPI substitute).
- System tray with show/hide and unread badge driven off the tab title.
- Native desktop notifications, notification tones, and an incoming-call ringtone.
- **1:1 voice & video calling** — real WASM-backed WhatsApp calling via a hidden second
  linked device (the call layer), with calls living in WhatsApp's own popout window:
  outgoing hand-off from the chat's call button, incoming auto-popout, screen share with
  an in-app source picker and a draggable self-preview, one-time "Enable calling" onboarding
  with a live status banner, and automatic unlink on logout.
- Single-instance (second launch focuses the existing window) and close-to-tray.
- Signal-protocol key verification backed by `@signalapp/libsignal-client` (XEdDSA).
- Packaged as a `.deb` with bundled native modules and a proper desktop entry.

### Not working / stubbed

These have no clean Linux equivalent and are documented, not accidental:

- **Group calling** — the hybrid bridge has no dialable group hand-off; a group call
  attempt shows a native "Call failed" toast. (1:1 calling works — see Features.)
- **Native `IVoip` media engine** — proprietary (relay + HBH-SRTP); the hybrid view's own
  call path stays stubbed. Irrelevant in practice: calls are delivered through the plain-web
  call layer's WASM voip stack instead.
- **Media transcoding** — relies on the WebView2 shared-buffer frame API (the bundle has a WASM fallback).
- **WNS push** and **DPAPI machine-binding** — substituted with `safeStorage` / OS file ACLs.

See [`PORTING.md`](./PORTING.md) for the full per-bridge real-vs-stub breakdown.

## Install

Download a release `.deb`, or build one yourself (below):

```bash
sudo dpkg -i whatswine_*.deb
```

## Build from source

Requires Node 22 (`.nvmrc`) and the usual native-build toolchain (`build-essential`, `python3`).

```bash
npm install
npm run make:linux        # clean .deb build -> out/make/deb/x64/
```

## Development

```bash
npm start                                  # dev run
npm run dev                                 # same, with ELECTRON_DISABLE_SANDBOX=1
WA_BRIDGE_DEBUG=1 npm start                 # trace every bridge call + page console + websockets
npm run lint                                # eslint

# Headless seam self-check: drives a SQL round-trip through the real bridge and
# prints a single PASS/FAIL line (the closest thing to an e2e test).
HYBRID_SMOKE=1 ELECTRON_DISABLE_SANDBOX=1 npm start
```

**Sandbox note:** Electron's `chrome-sandbox` must be owned `root:root` with mode `4755`. If it
isn't, export `ELECTRON_DISABLE_SANDBOX=1` for dev runs — but keep `sandbox: true` in the code.

There is no unit-test framework. `WA_BRIDGE_DEBUG=1` is the primary debugging tool: it traces every
host-object call and **warns on any missing bridge/method**, which is what silently stalls the bundle
(e.g. a not-found on the QR/registration path).

## Architecture

Three Electron pieces wrap one remote page:

| Piece | File(s) | Role |
|---|---|---|
| **Hybrid host** | `src/main.ts` | Loads `web.whatsapp.com/?windows=1&windowsBuild=…` so the bundle runs its `win_hybrid` paths. Owns window, tray, badge, single-instance, user-agent cleanup, force-granted persistent storage, sound/ringtone injection. |
| **Bridge proxy** | `src/preload.ts` | Rebuilds `chrome.webview.hostObjects.<Name>` as a Proxy in the page's main world; routes sync vs `*Async` calls over IPC. |
| **Bridge backend** | `src/bridge/` | `registry.ts` dispatches IPC to bridge implementations in `impl/*.ts`, auto-discovered via Vite `import.meta.glob`. `services.ts` provides native SQLite + the secret store. |

Each `src/bridge/impl/*.ts` exports `bridges: Record<jsName, factory>`. Methods ending in `Async`
become promises on the JS side; everything else is a blocking sync call. Function arguments are revived
into native→JS callbacks (the `*BridgeToWeb` / `Subscribe` surface).

The `analysis/` directory holds the reverse-engineering reference (`docs/00`–`97`) the port was built
from, plus IndexedDB forensics scripts. The decompiled sources it cites are **not** vendored here.

For the deep dive — including the fidelity invariants that look like bugs but are load-bearing (the
integer `windowsBuild`, the forced persistent-storage grant, the JSON-string SQLite wire format) — read
[`PORTING.md`](./PORTING.md) and [`CLAUDE.md`](./CLAUDE.md).

## Tech stack

Electron 42 · electron-forge + Vite · TypeScript · better-sqlite3 · @signalapp/libsignal-client ·
@noble/curves + @noble/hashes.

## License

MIT
