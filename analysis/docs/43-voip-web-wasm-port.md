# 43 — VoIP via the Web/WASM engine (Linux Electron port)

> Target: **WhatsApp Web BETA** bundle (captured 2026-06-22 from the live, logged-in app's
> on-disk cache → `research/waweb-latest/`, 86 chunks; cross-checked against the beautified
> `research/waweb-unmin/`). This doc is the *web/WASM* counterpart to doc 41 (which covers the
> **native Windows** VoIP engine). It answers one question: **can our Electron shell run real
> WhatsApp calls by using WhatsApp Web's own in-browser WASM calling engine, instead of the
> native `IVoip` engine we cannot reimplement?**
>
> Evidence is reverse-engineered from minified JS; line/offset cites are to the captured chunks.
> Findings were produced by four parallel deep-analysis passes (gating, WASM bring-up, signaling,
> media) plus direct verification of live HTTP headers. Where a fact is inferred rather than
> directly quotable (e.g. lines inside the lazy, un-captured `call.wasm` glue chunk), it is marked
> **[inferred]**.

---

## 1. Verdict (TL;DR)

**Portable: YES on the client side — with one architectural pivot and one irreducible unknown.**

- The WhatsApp Web bundle ships a **complete WASM VoIP codec/media engine** (the same code Meta uses
  for web calling). It relies on the browser only for **standard WebRTC transport** (a full
  `RTCPeerConnection` — ICE/DTLS/SCTP — carrying one unreliable `RTCDataChannel`) plus capture
  (`getUserMedia`, `AudioWorklet`, `MediaStreamTrackProcessor`, WebCodecs) and `SharedArrayBuffer` —
  **all Chromium-standard and present in Electron on Linux**. **We do not need to reimplement
  WhatsApp's native media stack** (the months-long path in doc 41 §5).
- **The pivot:** the WASM engine is *mutually exclusive* with our `?windows=1` windows-hybrid mode.
  The bundle hard-refuses to load `call.wasm` when it thinks it is on Windows
  (`if (WAWebEnvironment.isWindows) return Promise.reject("…WASM should not be loaded on Windows Hybrid")`).
  To use the WASM engine we must run the WhatsApp session as **plain web** (`isWindows === false`),
  which means **giving up the native host-object bridge layer for that session**.
- **The irreducible unknown:** **server-side calling eligibility**. Client config can surface the
  call UI and boot the engine, but WhatsApp's servers must accept the call signaling and allocate
  relays for the account. If the account/region is not in the calling rollout server-side, calls
  fail at signaling and **no client change can fix that**. This is settle-able only by a live test
  (§7 T3).

So: **build the plain-web calling path (all client-side, achievable), then run the decisive live
test.** If the server accepts, calls work. If not, we are blocked until the account is in the
rollout — not a code problem.

> Honest note on scope vs. the original ask ("make our *windows-hybrid* app run the WASM engine"):
> that exact framing is **impossible** — you cannot be windows-hybrid and load the WASM engine in
> the same page. The realistic answer is "run the call session as plain web." See §3 and §6.

---

## 2. How web VoIP actually works (the WASM path), with evidence

### 2.1 Stack selection — native vs WASM is a *load-time* binding, no fallback

`WAWebVoipInit` calls `WAWebVoipStackInterface.getVoipStackInterface()` and branches on `a.type`
(`research/waweb-unmin/jEpDguw_pz8.js:3724,3733-3737`): `"web"` → WASM path, `"windows"` → native
path. The concrete impl is chosen by a cross-resource alias `cr:22885`
(`a5gdgRhdCri.js:4820` → `require("cr:22885").createWAWebVoipStackInterface()`), bound by the
loader to one of:

- **Native:** `WAWebVoipStackInterfaceWindows` (`a5gdgRhdCri.js:5144`, export `:5356`); guard
  `:5151` `if (!isWindows) throw "…non-Windows environment"`; every method is
  `WAWebWindowsHybridBridgeFactory.getWindowsBridge()?.voip?.<m>(…)`.
- **WASM:** `WAWebVoipStackInterfaceWeb` (`DXbR99V6DKN.js:3108`, export `:3925`); guard `:3123`
  `if (!isVoipDownloadEnabled()) throw …`.

The selection happens **before** any host-object check and there is **no runtime native→WASM
fallback**. In hybrid mode a missing/stub `VoipBridge` makes every native call a silent
`?.`-no-op (`a5gdgRhdCri.js:5154-5356`) — exactly our current "calls vanish" symptom; it never
falls through to WASM. `this.voip` is set only if **both** `hostObjects.VoipBridge` and
`VoipSignalingBridge` exist (`TSxMupG…js:186076-186078`).

### 2.2 Engine bring-up — `call.wasm`, Emscripten pthreads, main thread

- Entry: `WAWebVoipWebBridgeApi.initializeVoipWasm` (`long_e3bc82f9f645.js:~1079981`):
  `if (WAWebEnvironment.isWindows) return Promise.reject("VoipWebBridgeApi: WASM should not be loaded on Windows Hybrid"); if (!isVoipDownloadEnabled()) return reject(); return WAWebVoipWebLoadable.requireVoip();`
- `requireVoip()` (cached/retriable singleton, `long_e3bc82f9f645.js:~1071726`) →
  `WAWebVoipWebWasmVariantLoader.loadVoipWasmVariant()` (`:~1068771`) →
  `JSResourceForInteraction("WAWebVoipWebWasmLoader").__setRef("WAWebVoipWebWasmVariantLoader").load()`
  then `factory(config)`. Variants: `prod-nonlab` (default), `prod-lab`, `prod-labvideo`; AB prop
  `web_voip_load_wasm_variant`; lab path via `cr:12201.tryLoadLabVariant`.
- **The real engine binary + Emscripten glue are a lazy code-split chunk that is NOT in our 86-file
  capture** (it only fetches on an actual call). `web.call.wasm` in the captured files is an **ODS
  metric prefix** (`WAWebODS.incr("web.call.wasm_crash")`), *not* the asset URL. The only `.wasm`
  literals captured (`crypto_utils_v2.wasm`, `dgwcppbridge.wasm`, `WAMozjpegWasm.wasm`) are
  **unrelated** subsystems (VOPRF tokens, data-gateway transport, JPEG). **[inferred]** the engine
  is an Emscripten `-pthread` build (shared `WebAssembly.Memory`) — evidenced by
  `WAWebVoipThreadPoolManager` driving `Module.PThread.allocateUnusedWorker/loadWasmModuleToWorker`
  and `Module.GROWABLE_HEAP_U8()` (`TYrFWAfpU1x.js:~88039`).
- **Execution context = MAIN THREAD.** `frontendSendAndReceive` is an in-process synchronous
  dynamic-router call (`WADynamicRouterAsync`, `long_c69fc112397c.js`), not a cross-thread hop;
  VoIP handlers are registered main-thread by `setFrontendHandlers` in `launchSocket`
  (`jfiYnIUDsGS.js:1460503`). The engine then spawns its own Emscripten pthread Workers (SCTP/P2P)
  and needs main-thread-only APIs (`AudioContext`/WebCodecs). The dedicated backend `Worker` carries
  only the DB/sync set, not VoIP.
- Worker handoff (older builds, `research/waweb-unmin/DXbR99V6DKN.js:2230`): `MessageChannel` +
  `worker.postMessage({jsWorkerCmd:"startVoipRpc", rpcPort}, [port])`; folded into the
  `WorkerMessagePort`/pthread path in the latest bundle. DCThread gated by
  `enable_web_voip_proxy_and_sctp_workers` (id 26012, default **true**) + an RTCDataChannel-transfer
  probe.

### 2.3 Signaling & call lifecycle — owned entirely by the shared JS layer

Both stacks reuse the **same** JS signaling modules, so this is identical whether native or WASM:

- **Outbound** (`WAWebVoipSendSignalingXmpp`, `TYrFWAfpU1x.js:205126`): the engine emits an inner
  WAP node; JS wraps it in `<call to id>`, and for `offer`/`enc_rekey` applies **Signal `<enc>`
  encryption per-device** (`WAWebSignal.Cipher.encryptSignalProto`, `<device-identity>` appended for
  pkmsg, fan-out one `<enc>` per peer device), then transmits on the **Noise socket** via
  `WADeprecatedSendIq.deprecatedSendStanzaAndReturnAck` → `sendSmaxStanza`. Server ack is fed back
  via `stack.handleIncomingSignalingAck(...)`.
- **Inbound** (`WAWebHandleVoipCall*`, `WAWebVoipValidateAndDecryptEnc` `long_9949cf719ca8.js:342001`):
  JS parses the `call` stanza, **Signal-decrypts `<enc>` to the cleartext call key in JS**
  (`decryptSignalProto` + PKCS7 unpad, `enc.unsafeSetNodeContent(plain)`), serializes the node
  (`serializeVoipWapNode`) and calls `stack.handleIncomingSignalingOffer(...)` into the engine.
- **State machine:** `WAWebVoipWaCallEnums.CallState` (`long_c69fc112397c.js:8933462`):
  `None:0 Calling:1 PreacceptReceived:2 ReceivedCall:3 AcceptSent:4 AcceptReceived:5 CallActive:6 …`;
  plus `VoipEvent`, `CallResult`, `EndCallReason`, `WAWebVoipSignalingEnums.TYPE` (the `<call>` child
  tags: offer/accept/reject/terminate/transport/relay_latency/enc_rekey/…).

**Implication for the port:** transport + Signal-E2E of call signaling is **already done by the
bundle**; our shell must not interfere with the socket. This is reusable as-is.

### 2.4 Media transport — standard WebRTC transport carries a datagram pipe; WASM owns the codecs

> Correction (adversarial review): an earlier draft said "browser WebRTC is not used." That is
> **wrong**. The browser runs a **full, standard `RTCPeerConnection`** (ICE + DTLS + SCTP); it
> simply carries **no media tracks**. The WASM layers SRTP/SFrame/RTP/codecs on top of the byte
> pipe.

- `new RTCPeerConnection({iceServers:[stun:… from the server-pushed relay list]})`
  (`a5gdgRhdCri.js:792, 4587-4590`); real `createOffer/createAnswer/setLocalDescription` with SDP
  munging (`replaceIceCredentials`/`replaceDtlsFingerprint`/`a=setup:passive`, `:614, 684-695`).
- One `createDataChannel("wa-web-p2p", {negotiated:true, id:0, ordered:false, maxRetransmits:0, priority:"high"})`
  = unreliable, UDP-like; `binaryType="arraybuffer"`. **No `addTrack`/`addTransceiver`/`ontrack`** →
  zero media tracks on the PeerConnection.
- The live `RTCDataChannel` is **transferred into the worker**
  (`postMessage({jsWorkerCmd:"transferDataChannel", channel, …}, [channel])`); the WASM runs
  **SRTP + SFrame + RTP + codecs + jitter** over a `SharedArrayBuffer` ring (`initSctpRingBuffer`).
- Alt relay leg: **WebTransport** (QUIC, `gkx("21938")` / `enable_web_voip_webtransport`).

**Correct framing of the "non-standard SRTP" concern:** the worry was that WhatsApp's
SRTP-over-`te2` scheme must interoperate with Chromium's WebRTC *media* stack. It does **not** — the
browser provides only standard ICE/DTLS/SCTP transport, and WhatsApp's SRTP runs *inside* the WASM
on top of that pipe. So there is **no SRTP/WebRTC interop problem** — but browser WebRTC
(`RTCPeerConnection`/ICE/DTLS) **is required and is used** for transport. All of it is
Chromium-standard and present in Electron on Linux, so this is satisfiable, not fatal.

### 2.5 Media capture — standard web APIs (Linux-friendly)

`WAWebMediaCapture` / `WAWebVoipAcquireMediaStream` (`SjCAw3j6…js`): `getUserMedia` for mic
(`{audio:{echoCancellation,noiseSuppression,autoGainControl,sampleRate,channelCount}}`, 3-tier
exact/ideal/none retry) and camera (`{video:{width/height/frameRate ideal}}`); `getDisplayMedia`
for screen share; `enumerateDevices` + `devicechange`; permission via `navigator.permissions.query`.
Capture → WASM via AudioWorklet SAB ring (`voip-shared-buffer-capture-processor`) and
`MediaStreamTrackProcessor`→worker→WASM NV12 (WebCodecs). **All available in Electron/Chromium.**

> The Windows path instead uses host-injected **virtual capture drivers**
> (`cr:17277`/`cr:5905`, `enable_web_voip_virtual_audio/video_capture_driver`) that are never
> `__d`-defined in the bundle. These are the native capture hooks we don't have; in plain-web mode
> the bundle takes the standard `getUserMedia` path automatically, so **we must NOT present as
> Windows for the media path** (another reason the call surface must be plain-web).

### 2.6 Gating — what turns calling on (web)

`WAWebVoipGatingUtils` (`research/waweb-unmin/TSxMupG…js:7210-7297`):

| Predicate | Logic |
|---|---|
| `isCallingEnabled` | `isWindows ? true : getABProp("enable_web_calling")` (id 15461, default **false**) |
| `isGroupCallingEnabled` | `isWindows ? true : (isCallingEnabled() && getABProp("enable_web_group_calling"))` (id 20924, default false) |
| `isVoipDownloadEnabled` | `isWindows ? true : (!isUnsupportedBrowser && (enable_web_calling \|\| web_calling_download_voip))` |
| `isVoipInitEnabled` | `isWindows ? true : (isVoipDownloadEnabled() && (enable_web_calling \|\| web_calling_init_voip[default true]))` |
| `getUnsupportedBrowserReason` | non-null (calling blocked) if missing `SharedArrayBuffer`/`Atomics`/`RTCPeerConnection`, or `isBrokenVoipWasm`; else null |
| `isUnsupportedBrowserForWebCalling` | `getUnsupportedBrowserReason() != null` |

Call button (`WAWebCallButtons`, `1TRly7sRB8I.js`): renders when
`isCallingEnabled() && !isUnsupportedBrowserForWebCalling() && useWAWebVoipCanStartCall(chat)`,
with a `BETA` upsell/NUX layer (`WAWebVoipBetaCallingUpsell`, `enable_web_calling_beta_upsell`).

**To enable on web:** `enable_web_calling = true` (+ `enable_web_group_calling` for group);
`web_calling_init_voip` and `enable_web_voip_proxy_and_sctp_workers` already default true.

---

## 3. The blocker: windows-hybrid ⊥ WASM (the `isWindows` switch)

`WAWebEnvironment.isWindows ⇔ gkx("4112")` (`research/waweb-unmin/ib_X_SIg…js:7377-7398`);
`isWeb === !isWindows`; subplatform string `"win_hybrid"`. The gate value is injected by the
server/bootstrap config, keyed off the request (our `?windows=1`). It is a **single global** — the
VoIP stack selection cannot be decoupled from the rest of the app's hybrid identity. Therefore:

- **Hybrid (`isWindows` true):** native stack selected; `call.wasm` refused; our stub `VoipBridge`
  drops calls. Calling impossible without reimplementing the native engine (doc 41 §5 — out of
  scope, months of work).
- **Plain web (`isWindows` false):** WASM stack selected; engine loads; calling possible
  (subject to flags + cross-origin isolation + server eligibility).

Signaling/stack-selection happens in whatever session processes the socket — i.e. the main window.
A "hybrid main + plain-web call popout" split does **not** work, because an outbound call initiated
from the hybrid main window routes to the (dead) native stack, and an inbound offer is processed by
the hybrid main window's stack too. **The whole WhatsApp session must be plain-web for calls.**

---

## 4. Cross-origin isolation — already 90% solved by WhatsApp's infra

The WASM engine hard-requires `SharedArrayBuffer` + `Atomics` (gate `getUnsupportedBrowserReason`),
which requires the page to be `crossOriginIsolated` (COOP `same-origin` + COEP `require-corp`).
Live header check (2026-06-22):

- `web.whatsapp.com` already serves **`cross-origin-embedder-policy: require-corp`** and
  `cross-origin-opener-policy: same-origin-**allow-popups**`.
- All CDN chunks (`static.whatsapp.net`) serve **`cross-origin-resource-policy: cross-origin`** +
  `access-control-allow-origin: *` → **COEP `require-corp` does NOT break subresources** (WA's CDN
  is COEP-ready; the app already runs under COEP in production).

So the **only gap** is COOP: `same-origin-allow-popups` does not enable `crossOriginIsolated`. The
stricter COOP `same-origin` is applied to the **call popout** (the "[sw] popout" path). Caveat from
the adversarial review: the exact COOP/COEP **header-injection code was not found in the captured
chunks** — it is either in the un-captured service-worker file or set as a server response header
(the live COEP header above confirms server-set COEP), so the precise mechanism is
**[verify empirically]**. For our Electron app the clean, self-sufficient fix is direct: **force
COOP `same-origin`** on the top-level WA document via `session.webRequest.onHeadersReceived` (COEP
`require-corp` is already served). Because WA's CDN is CORP-tagged, first-party subresources are safe
under COEP; **if any non-WA cross-origin subresource breaks, switch to COEP `credentialless`**
(Chromium/Electron-supported). Risk to verify: COOP `same-origin` (vs allow-popups) could affect
WA's popup/login flows — test login + any popout (§7 T4).

---

## 5. Feasibility matrix

| Requirement | Status | Notes |
|---|---|---|
| Self-contained WASM engine exists | ✅ | lazy `WAWebVoipWebWasmLoader` chunk; runs main-thread + pthread workers |
| Media transport: standard `RTCPeerConnection` (ICE/DTLS/SCTP) → unreliable DataChannel/WebTransport | ✅ | Chromium-standard WebRTC transport (no media tracks); WASM layers SRTP/codecs on top |
| Media capture (getUserMedia/AudioWorklet/MSTP/WebCodecs) | ✅ | standard web APIs on Linux; avoid Windows virtual-driver path |
| `SharedArrayBuffer` / cross-origin isolation | ✅ achievable | COEP already served + CDN COEP-ready; force COOP `same-origin` (or popout SW) |
| Signaling + Signal-E2E of call stanzas | ✅ | owned by the bundle; we don't touch it |
| Run session as plain web (`isWindows=false`) | ⚠️ pivot | drop `?windows=1`; abandons native host-object bridges for that session |
| `enable_web_calling` true | ⚠️ | no `AbPropsBridge` in web mode → server-pushed (beta cohort) or client-monkeypatched |
| **Server-side calling eligibility** | ❓ **gating unknown** | the real wall: `NackCallerNotEnabled: 403` on the offer (`b1yokg…js:5031,5089`) + server-pushed relay allocation (`cachedRelayListData` `a5gdgRhdCri.js:4515-4522`, `RelayBindsFailed`). Only a live call test settles it; **not client-fixable** |

---

## 6. Implementation plan (plain-web route) — concrete, file-by-file

> All paths under `whatsapp-desktop/`. The plan keeps the existing app intact and adds a
> **calling/plain-web mode** behind a flag, so we don't destroy the hybrid work while testing.

### Phase 0 — Decision gate (do first, ~0 code)
Run §7 **T1–T2** in the *current* app pointed at plain web to learn, before building anything,
whether (a) `crossOriginIsolated` can be made true and (b) the call button appears (i.e. whether
the account is server-eligible). If T3 (a real connect) later fails and is server-gated, **stop** —
no amount of client code helps.

### Phase 1 — Plain-web mode toggle  (`src/main.ts`)
1. `buildUrl()`: gate the windows-hybrid query params behind a mode flag. Add
   `const CALL_MODE = process.env.WA_CALL_MODE === '1';` In `CALL_MODE`, load
   `WA_ORIGIN` **without** `windows/windowsBuild/windowsBuildType/osBuild` (plain web) so
   `WAWebEnvironment.isWindows` is false and the WASM stack is selected.
2. `createWindow()` / `installBridges()`: in `CALL_MODE`, **do not** install the host-object bridge
   layer (it's unused and irrelevant in web mode) — skip `installBridges()`; keep
   `installDownloadRouting` (still valuable) and the persistent-storage grant (still needed so login
   sticks — that fix is mode-independent).
3. Keep `setPermissionRequestHandler` allowing `media` (mic/cam) — already present.

### Phase 2 — Cross-origin isolation  (`src/main.ts`)
4. Add `session.defaultSession.webRequest.onHeadersReceived` for the top-level WA document
   (`details.resourceType === 'mainFrame'` and URL on `WA_HOST_ORIGIN`): set
   `cross-origin-opener-policy: same-origin` (leave the served `cross-origin-embedder-policy:
   require-corp` as-is; add it if absent). This makes `crossOriginIsolated === true`.
   - Do **not** blanket-rewrite COEP on subresources — the CDN already sends CRP `cross-origin`.
   - Verify login QR + any popout still work under COOP `same-origin` (§7 T4). If a popup flow
     breaks, narrow COOP to only the call popout window instead.

### Phase 3 — Force the calling flags (only if T2 shows no call button)  (`src/preload.ts` or injected)
5. If the beta account does **not** already have `enable_web_calling` server-pushed, inject a
   main-world hook that overrides the AB-prop reads for the calling keys. The bundle resolves
   modules via its FB module system; from the page main world, hook
   `WAWebABProps.getABPropConfigValue` so it returns `true` for
   `{enable_web_calling, enable_web_group_calling}` and defers to the original otherwise.
   - **Clean hook point (confirmed):** the module exposes
     `WAWebABProps.setGetABPropConfigValueImpl(fn)` (`n6o0-NaJTww.js:13548-13565`) — wrap the
     existing impl and force-`true` the two calling keys, deferring everything else. This is the
     supported override seam rather than patching the getter directly.
   - This is **version-fragile** (depends on reaching the module) and is a *client feature-flag
     override*, not a server unlock — it only surfaces the UI/engine; it cannot grant server-side
     eligibility.
   - Prefer skipping this entirely if T2 already shows the button (account is in the cohort).

### Phase 4 — Shell parity for plain-web (optional polish)
6. Re-wire at the Electron level what the hybrid bridges used to do but that web mode handles
   itself or needs shell help: downloads (keep `installDownloadRouting`), notifications (web
   `Notification` already shows natively via Electron + our handler), tray/badge (already
   title-based). SQLite/Contacts/AbProps native bridges are simply unused in web mode.

### Phase 5 — Capture the engine for offline study (optional)
7. With calling live, the lazy `WAWebVoipWebWasmLoader` chunk + `call.wasm` will load; capture their
   `static.whatsapp.net` URLs from the cache (same method as `research/waweb-latest`) for archival —
   not required to run calls (the live app fetches them itself).

---

## 7. Empirical go/no-go tests (ordered; cheapest first)

Run against the app pointed at **plain web** (no `?windows=1`). DevTools console.

- **T1 — cross-origin isolation:** `crossOriginIsolated` and `typeof SharedArrayBuffer` and
  `typeof Atomics`. Expect `true`/`"function"`/`"object"`. If `crossOriginIsolated` is false →
  apply Phase 2 (force COOP `same-origin`) and re-check. *Gate: SAB available.*
- **T2 — call UI / client gating:** open a 1:1 chat; does the **call button** render? (Equivalent:
  it means `isCallingEnabled() && !isUnsupportedBrowserForWebCalling()` are both satisfied.) If not,
  the account lacks `enable_web_calling` server-side → apply Phase 3 and re-check. *Gate: client
  calling enabled.*
- **T3 — the decisive test (server eligibility):** place a call to another device/account. Watch:
  (a) the lazy voip chunk fetch in Network; (b) worker spawn + `RTCDataChannel` `wa-web-p2p`
  created; (c) a `<call><offer>` stanza goes out on the socket; (d) **the other side actually rings
  and the call connects.** If (a)-(c) happen but (d) never does → **server-gated; blocked, not
  client-fixable.**
  - **Cheaper precursor (no media/second device needed):** instrument the offer-NACK path and watch
    for **`NackCallerNotEnabled` (403)** on the offer, and whether a relay list is pushed
    (`cachedRelayListData` non-null) vs `RelayBindsFailed`. A 403 NACK or absent relay list ⇒
    server cohort gate ⇒ stop. This converts the whole project's go/no-go into a single log line.
  *Gate: server accepts calls.*
- **T4 — regression:** confirm login persists and no WA popup flow breaks under forced COOP
  `same-origin`.

---

## 8. Risks & open questions

1. **Server-side eligibility (highest):** the rollout gates calling server-side via
   `NackCallerNotEnabled (403)` on the call offer and server-controlled relay allocation
   (`cachedRelayListData`/`RelayBindsFailed`). Client patches force the UI/engine but **cannot**
   reach these; T3 (precursor) is the only way to know. Not client-fixable.
2. **Plain-web pivot cost:** abandons the native host-object bridges for the call session. If the
   product wants both native integrations *and* calls, they are mutually exclusive in one session.
3. **COOP `same-origin` side-effects:** may affect WA popup/login flows; mitigate by scoping to the
   call popout if needed (T4).
4. **Client flag override fragility:** Phase 3's `getABPropConfigValue` hook is version-coupled to
   the bundle; avoid if the account is already in the cohort.
5. **`call.wasm` glue not captured:** the engine's exact `WebAssembly.Memory({shared:true})` /
   `locateFile` lines live in the lazy chunk; the SAB requirement itself is firmly proven by the
   browser-capability gate, but the glue internals are **[inferred]** until captured via §6 Phase 5.
6. **Bundle drift:** all module offsets are for the 2026-06-22 beta capture; expect churn.

---

## 9. Empirical results (2026-06-22 — this implementation)

Implemented behind `WA_CALL_MODE` (`whatsapp-desktop/src/main.ts` + new `src/calling.ts`): plain-web
load (no `?windows=1`), forced COOP `same-origin` via `onHeadersReceived`, skip native bridges, and
an injected diagnostics/force probe. T1 run in a throwaway, logged-out profile
(`WA_CALL_MODE=1 WA_CALL_SMOKE=1 WA_USERDATA=/tmp/… npm start`) reported:

```
caps   {crossOriginIsolated:true, SharedArrayBuffer:"function", Atomics:"object",
        RTCPeerConnection:"function", WebTransport:"function"}
gating {isWindows:false, isWeb:true, subPlatform:"web",
        callingEnabled:false, unsupportedReason:null, voipDownloadEnabled:false}
```

Verified facts (previously "[verify empirically]"):
- **Cross-origin isolation works** — forcing COOP `same-origin` (COEP `require-corp` already served)
  yields `crossOriginIsolated:true` and a usable `SharedArrayBuffer`/`Atomics`. The hardest infra
  requirement is satisfied; no subresource breakage observed at the QR/login stage.
- **Plain-web pivot works** — dropping `?windows=1` gives `isWindows:false` / `subPlatform:"web"`,
  so the loader binds the **WASM** voip stack (confirms §3 / the critic's GK-4112 question).
- **Browser-capability gate passes** — `getUnsupportedBrowserReason() === null`: the WASM engine is
  not blocked by caps in Electron-on-Linux.
- `callingEnabled:false` is expected for a logged-out throwaway profile (no server-pushed flags). A
  second run with `WA_FORCE_CALLING=1` confirmed the override seam works:
  `forced calling AB props ON` → `callingEnabled:true, groupCallingEnabled:true,
  voipDownloadEnabled:true` (so the WASM engine will be allowed to download/init). The real beta
  account may also have these server-set.

**Still pending (needs the logged-in beta account in `WA_CALL_MODE`):** T2 (call button appears) and
the decisive **T3** (a real call connects, vs `NackCallerNotEnabled 403`) — the server-eligibility
gate, the only remaining unknown.

---

## 10. Bottom line

We can run real WhatsApp calls in the Linux Electron app **by letting the bundle's own WASM engine
run in plain-web mode** — every browser capability it needs is present, the hard SRTP/relay media
work stays inside the WASM (no reimplementation), and cross-origin isolation is achievable because
WhatsApp already ships COEP-ready infrastructure. The cost is dropping windows-hybrid for the call
session, and the one thing we cannot control or verify from code is **server-side calling
eligibility** — which the live test in §7 T3 settles definitively before any further investment.

---

## 11. windows-hybrid + WASM voip in ONE session — ATTEMPTED, EMPIRICALLY FALSIFIED (§3 stands)

A re-read suggested the combination might be achievable by main-world patching (force the Web stack +
neuter the one `isWindows` WASM-reject), keeping `?windows=1` for the native bridges. It was
implemented behind a default-on `installHybridVoipRebind` and **tested live + by smoke. It does not
work.** §3's original "impossible" verdict is correct. The code was reverted.

**The decisive fact (measured, 2026-06-22):** in a `?windows=1` session the WASM voip stack module
`WAWebVoipStackInterfaceWeb` **cannot be loaded by any client-side mechanism.** Live (logged-in,
during real call attempts) and via an isolated loader probe (logged-out), every path fails:

```
window.require("WAWebVoipStackInterfaceWeb")              -> "Requiring unknown module" (not registered)
window.requireLazy(["WAWebVoipStackInterfaceWeb"], cb)    -> TIMEOUT (callback never fires; no fetch)
window.importNamespace("WAWebVoipStackInterfaceWeb")      -> null
JSResourceForInteraction("WAWebVoipStackInterfaceWeb").load() -> TIMEOUT
```

So the rebind built the WEB stack → fell back to the native stub → `[VoipBridge] startCall (stub)` →
calls do nothing.

**Why the earlier reasoning was wrong:** `createWAWebVoipStackInterface` appears in chunks present in
the windows session's HTTP cache, which I read as "the Web impl ships and is loadable." It is not. The
`cr:22885` alias is resolved at the **server/bootstrap module-manifest** level (no in-bundle
`__d` provider — only the consumer `a5gdgRhdCri.js:4820` references it), and in the `?windows=1`
variant the manifest maps the `WAWebVoipStackInterfaceImpl` resource → the **native** chunk only. The
Web impl is simply not in the windows session's loadable module graph; "in the cache" ≠ "in the
manifest / `__d`-registered". The native-vs-WASM split is therefore a **bundle-variant** decision
(driven by `?windows=1` ⇒ gkx 4112), not merely a runtime `isWindows` branch — confirming §3.

What *was* confirmed working in hybrid mode (harmless, but insufficient on their own): forcing COOP
`same-origin` yields `crossOriginIsolated:true` while `isWindows:true`, and the native SQLite bridge
still round-trips — i.e. cross-origin isolation and the bridges can coexist. Only the engine itself is
unreachable.

**Consequence — the modes are mutually exclusive in one page:**
- **plain web** (`isWindows=false`, no `?windows=1`): WASM voip stack loads → calls work (§9), but the
  native host-object bridges are unused.
- **windows hybrid** (`?windows=1`): native bridges work, but the WASM voip stack is not loadable → no
  calls (native voip needs the real `IVoip` engine, doc 41 §5, out of scope).

The only way to have both is **two linked sessions** (a hybrid main window + a separate plain-web
window/linked-device dedicated to calls) — two logins, two device slots, and call routing lands on one
device; awkward and unreliable, not a seamless single-app experience. Otherwise it is a product choice
between native integration (hybrid) and working calls (plain web, `WA_CALL_MODE`).
