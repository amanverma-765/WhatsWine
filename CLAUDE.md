# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WhatsWine is an Electron shell that ports the **Meta native WhatsApp for Windows** hybrid
architecture to Linux — **not** a `web.whatsapp.com` wrapper. The Windows client is a thin
native shell that hosts the WhatsApp Web JS bundle in WebView2 and exposes native capabilities
as `window.chrome.webview.hostObjects.<Name>` bridges. This port reproduces that seam on Electron.

`PORTING.md` is the authoritative architecture doc — read it first. `analysis/docs/` (`00`–`97`)
is the reverse-engineering reference the port was built from; `path:LINE` citations there point at
an external `decompiled_source/` tree not vendored in this repo.

## Commands

```bash
npm start                                  # dev run (electron-forge)
npm run dev                                 # same, ELECTRON_DISABLE_SANDBOX=1
WA_BRIDGE_DEBUG=1 npm start                 # trace every bridge call + console + websockets
HYBRID_SMOKE=1 ELECTRON_DISABLE_SANDBOX=1 npm start   # headless seam self-check (SQL round-trip, PASS/FAIL line)
npm run lint                                # eslint .ts/.tsx
npm run make:linux                          # host build: deb+rpm+zip+AppImage (makers gated on dpkg/rpmbuild/mksquashfs)
npm run make:linux:portable                 # RELEASE build in an ubuntu:22.04 docker builder (glibc 2.35 floor) → out/make-portable/
npm run release                             # dispatch + watch the on-demand GitHub release workflow (needs gh auth)
```

Packaging (all channels container-verified), CI release flow, and the glibc/native-module
portability story live in `PACKAGING.md`. Never publish host builds — portable only.

There is no test framework. `HYBRID_SMOKE=1` is the end-to-end check: it drives a SQL command
through the real bridge (preload Proxy → IPC → registry → better-sqlite3) and prints PASS/FAIL.
Type-checking is `tsc --noEmit` only (Vite/esbuild emit the actual bundles).

Linux dev note: Electron's `chrome-sandbox` must be `root:root 4755`, else export
`ELECTRON_DISABLE_SANDBOX=1` (dev only — keep `sandbox: true` in code).

## Architecture

Three processes around one remote page:

1. **Main** (`src/main.ts`) — loads `web.whatsapp.com/?windows=1&windowsBuild=…` so the bundle takes
   its `win_hybrid` code paths. Owns the window, tray, badge, single-instance, user-agent cleanup,
   persistent-storage grant, and notification/ring sound injection.
2. **Preload** (`src/preload.ts`) — rebuilds `chrome.webview.hostObjects.<Name>` as a Proxy in the
   page's main world, routing sync vs `*Async` calls over IPC.
3. **Bridge backend** (`src/bridge/`) — `registry.ts` is the IPC dispatch; `impl/*.ts` are the bridge
   implementations, auto-discovered via Vite `import.meta.glob` (parallel authors never edit a shared
   registry). `services.ts` provides the native sqlite + `safeStorage` secret store; `types.ts` defines
   `BridgeContext`/`BridgeFactory`.

Each `impl/*.ts` exports `bridges: Record<jsName, factory>`. A method whose name ends in `Async`
is a promise on the JS side; everything else is a blocking sync call. Function args are revived into
native→JS callbacks (the `*BridgeToWeb` / `Subscribe` surface). See `PORTING.md` for the per-module
real-vs-stub table.

## Fidelity invariants (each was a real traced bug — do not "fix" casually)

- **`windowsBuild` must be a single integer** (`src/main.ts` `WINDOWS_BUILD`). The bundle does
  `Number(windowsBuild)` as a UINT32; a dotted version → `NaN` → login fails → socket 1006 → QR spins forever.
- **Persistent storage must be force-granted** (CDP `Browser.setPermission` + permission handlers).
  WA Web rolls back a successful login if `navigator.storage.persist()` is denied.
- **`SQLiteBridge.executeSqlite` is JSON-string in / JSON-string out**, not array-in/array-out.
  Result field names (`LastInsertedRowId`/`RowsAffected`/`Rows`/`ColumnNames`/`Error`) are load-bearing.
- The top frame is pinned to the WA origin and the native query string is re-asserted on every
  navigation; permission grants are origin-gated to WA. Don't loosen these — they prevent in-app phishing.

## Known hard edges (documented, not oversights)

VoIP media engine, MediaTranscoding (WebView2 shared-buffer frame API), media save byte-channel, and
WNS push have no clean Linux equivalent — substituted or stubbed. See `PORTING.md` "Known hard edges".
Note: 1:1 calling nevertheless WORKS — delivered by the call layer (`src/callView.ts`, a hidden second
linked device on `persist:wa-call` whose WASM voip stack carries the media, popped out into WhatsApp's
own call window). Group calling is unsupported (toast). Open calling issues: `CALL_REVIEW_TODO.md`.

## Conventions

- Native modules (`better-sqlite3`, `@signalapp/libsignal-client`) are kept external from the asar; their
  runtime closure is hand-listed in `forge.config.ts` `packageAfterCopy` — add to it if a native dep gains a runtime dep.
- `// ponytail:` comments mark deliberate simplifications with their upgrade path.
- `any` on bridge methods is intentional: they're dynamically dispatched and validated at the IPC boundary.
