# 93. Open-Questions Resolution Report

This report consolidates the verdicts from a dedicated investigation pass over every open question
left in docs 00–92. The pass combined fresh `strings -n 6` / `objdump -p` / raw-byte scans over the
shipped native binaries in `decompiled_source/x64/` (chiefly `WhatsAppNative.dll` and
`WhatsAppRust.dll`), whole-tree `grep` over the decompiled C# and the minified
`waweb-source-bundle/`, and direct re-reads of cited source lines. The headline outcome is that the
native binaries — initially opaque to Ghidra (both dumps empty/PyGhidra-errored) — were
resolved by **provenance evidence** (symbols, import tables, source-path strings, vendored-crate
lists), and a later `radare2` pass (doc 96) recovered instruction-level evidence for the key crypto
primitives (X25519 ladder constant, SHA-512 IV table, `Sqlite::Open` codec callees), so the native
DLLs are no longer the blocking unknown. What stays unresolvable falls into
four buckets (native disassembly, live wire capture, server/account access, bundle de-minification),
enumerated at the end.

**Totals: RESOLVED 83 / PARTIAL 39 / CANNOT 11.**

## 1. Headline cross-cutting facts resolved this pass

- **`WhatsAppRust.dll` = Meta `wamedia` media libraries** (NOT crypto/protocol). Rust source-path
  strings leak `xplat\whatsapp\wamedia\rust\libwamediastreams-rs` (h264/h265, opus, ogg, flac,
  vorbis, theora, speex, qcelp, mp3 parsers), `mp4operations\libmp4operations-rs` (mp4
  mux/demux/repair/forensics/editor), `libwamediadetection-rs`, `libwamediacommon-rs` (ffi/file
  handling). Vendored crates are `binrw`, `hashbrown`, `memchr`, `rustc-demangle`, `spin` —
  **zero crypto/signal/noise crates** (toolchain 1.93.1). It has no WinRT `ActivatableClass` entry
  because it is FFI-linked in-proc — `objdump -p WhatsAppNative.dll` lists `DLL Name:
  WhatsAppRust.dll` in its import table.
- **`WhatsAppNative.dll` = Google WebRTC + openh264 + Opus + native Curve25519 + SFrame + PJSIP.**
  Confirmed by symbols: `webrtc::` (AEC3, AGC, NetEq, `AudioDecoderOpusImpl`, `PushResampler`),
  `facebook::rtc::RSCodec`, openh264 (`activate_openh264_ltr`, `OpenH264 Encoder:
  WelsCreateSVCEncoder failed`), Opus (`__IOpusAudioSourceFactory`), native WinRT
  `Curve25519@WhatsAppNative` / `__Curve25519ActivationFactory`, SFrame call-media E2EE
  (`sframe_cipher_suite`, `wa_sframe_cipher_aes_impl.cc`), and a PJSIP/`wacall foundation` VoIP
  engine (`pjlib`, `pjmedia/audio/conference.cc`).
- **VoIP SRTP suites are real and per-hop:** `AES_CM_128_HMAC_SHA1_80` and `AES_CM_128_HMAC_SHA1_32`,
  alongside HBH-SRTP / SFU / congestion-control symbols. Call-media E2EE is a **distinct** SFrame
  layer over the transport SRTP — not double-SRTP.
- **`msquic.dll` is NOT the chat/VoIP socket.** No consuming symbol appears in `WhatsAppNative`
  strings; the "quic" hits are `quickhd` (a video-quality feature). msquic is shipped almost
  certainly as a WebView2/Edge HTTP3 dependency.
- **Native crypto in `WhatsAppNative.dll` is statically linked; `bcrypt.dll` supplies RNG only.**
  The `WhatsAppNative` import table pulls from `bcrypt.dll` **only** `BCryptGenRandom` +
  `BCryptOpenAlgorithmProvider` + `BCryptCloseAlgorithmProvider` — there is **no**
  `BCryptEncrypt`/`PBKDF2`/`HashData`, so AES/HMAC/SHA/KDF are statically linked inside the native
  DLL (SHA-1/256/512 all statically present), not CNG-backed (corrects the round-1 "native crypto =
  CNG/bcrypt" overstatement; doc 92, doc 96 §6). Media transcode additionally pulls Windows Media
  Foundation (`MFPlat.DLL`, `MFReadWrite.dll`). Distinct stack: the **managed** C# `AesGcmProvider`
  (Noise transport frames) *is* CNG/WinRT-backed — keep that statement separate from the native DLL.
- **SQLite is statically linked inside `WhatsAppNative.dll`** (`sqlite_sequence`,
  `sqlite_rename_test`, the WinRT `sqlite3_temp_directory` build note). The C# WAL/secure_delete
  pragmas are confirmed. At-rest encryption is a **custom AES+HMAC page codec, NOT stock SQLCipher** —
  there is no `cipher_version` / `kdf_iter` / `sqlite3_key` PRAGMA banner anywhere; pages are 4096
  bytes with a 16-byte per-DB salt and a raw 32-byte key, and `Sqlite::Open` (`0x1807326d9`)
  delegates to internal codec callees (doc 94, doc 96). The exact AES mode/HMAC variant is unread but
  moot for the port.

## 2. Per-document resolution table

| Doc | Resolved | Partial | Cannot |
|-----|----------|---------|--------|
| 00 — Architecture Overview | 3 | 4 | 1 |
| 01 — Build / Packaging / Platform | 1 | 0 | 0 |
| 10 — Connection / Transport | 4 | 2 | 1 |
| 11 — Noise Handshake | 2 | 4 | 0 |
| 12 — Binary Node Encoding | 5 | 1 | 0 |
| 13 — Smax Framework & Codegen | 5 | 1 | 0 |
| 14 — XMPP Stanza Layer / IQ | 8 | 1 | 0 |
| 15 — Message Send Pipeline | 3 | 3 | 0 |
| 16 — Message Receive / Offline | 1 | 0 | 0 |
| 17 — Stanza Families Catalog | 3 | 2 | 1 |
| 20 — Signal Protocol / E2E | 2 | 0 | 0 |
| 21 — Authentication / Pairing | 1 | 1 | 0 |
| 30 — App Shell / Lifecycle | 8 | 1 | 3 |
| 31 — WebView2 Host / Bridge | 10 | 5 | 0 |
| 32 — Local Storage / SQLite | 4 | 3 | 2 |
| 33 — Protobuf Type Catalog | 4 | 2 | 2 |
| 40 — Media Pipeline | 1 | 1 | 0 |
| 41 — VoIP Calling | 5 | 3 | 0 |
| 42 — Notifications / Push | 5 | 2 | 0 |
| 90 — Linux/Electron Roadmap | 0 | 0 | 1 |
| 91 — Protocol Constants | 5 | 1 | 0 |
| 92 — Native Modules Map | 0 | 1 | 0 |
| **Total** | **83** | **39** | **11** |

## 3. Remaining unresolved items, bucketed by the artifact that would resolve them

The following items carry a `[CANNOT RESOLVE STATICALLY]` verdict. They are grouped by what would be
needed to close them. (Many `[PARTIAL]` items also have a residual native/wire/server half; those are
not repeated here unless their core is a CANNOT.) **Note:** the later `radare2` pass (doc 96) resolved
the *cores* of two items that were CANNOT in the round-1 grouping below — the native Curve25519 scheme
and the SQLite codec family — leaving only a moot instruction-level residual; those entries are
retained here in residual-only form for traceability, not as open blockers.

### A. Needs PyGhidra / Capstone disassembly of WhatsAppNative.dll (or Rust)

- **00 §Item 5** — Process/thread topology of the WebView2 child processes (runtime property of the
  external Edge runtime; the app only calls `CreateWithOptionsAsync` — needs a live process-tree
  capture, not static artifacts; see also bucket B).
- **30 Q1** — Native `WhatsAppNativeInit.Setup()` body (pure WinRT ABI thunk;
  `objdump -p` exposes only `DllGetActivationFactory`; managed purpose known, instruction body
  opaque).
- **30 Q8** — Native `WamGlobalBuffer` ring-buffer body, native call sites, and the
  `OnRotateRequested(isSending)` semantics / `Encoding.Default`-vs-UTF-8 asymmetry.
- **32 §Native cipher/KDF** — The codec *family* is resolved: a **custom AES+HMAC page codec, NOT
  stock SQLCipher** (no `cipher_version`/`kdf_iter`/`sqlite3_key` banner; 4096-byte pages + 16-byte
  per-DB salt + raw 32-byte key; `Sqlite::Open` at `0x1807326d9` delegates to internal codec callees —
  doc 94 / doc 96). Only the exact per-page callback body (AES CTR-vs-CBC, HMAC variant) is unread,
  and it is moot for the port (no codec replication needed; the renderer port inherits the plaintext
  IndexedDB source of truth).
- **32 §Contact notification-hash** — Real keyed/truncated hash algorithm
  (`GetNotificationHash` is a `NOTIFICATION_HASH_<jid>` stub in this build); needs a production
  non-debug build, native disasm, or a live usync capture.
- **90 Item 1 / 00 §curve, 10 §curve, 11, 15, 20, 91 §curve** — The **Curve25519 signature scheme is
  now native-confirmed as X25519 ECDH + XEdDSA signing** (doc 96): a `radare2` pass found the X25519
  Montgomery-ladder constant `a24 = 121665` (`0x0001DB41`) and the SHA-512 IV table
  (`K[0]=0x428a2f98d728ae22`) statically present, with the `Curve25519::{Derive,Sign,Verify,
  GenKeyPair}` symbols on the same X25519 class — upgrading the prior by-interop inference to
  byte-evidenced, so this is **RESOLVED** (docs 11/15/20/91). `@signalapp/libsignal-client` is
  bit-compatible — no porting blocker. The *only* residual is the instruction-level `Sign` body
  (clamping/deterministic-nonce), which is unread but **moot for the port**.

### B. Needs live wire capture / live network

- **00 §Item 5** — WebView2 child-process count/lifetime (live process-tree capture).
- **10 §ChunkedHttpSocket** — Whether the port-80 `c.whatsapp.net` path still succeeds against
  current production, and whether `c.whatsapp.net` resolves today (live DNS / port-80 connect).
- **33 §SyncDMutationStatus** — Active-vs-Applied transition semantics and row-purge timing; driver
  lives in the JS layer, needs a live SQLite capture across a patch cycle (or bundle de-minification,
  bucket D).
- **33 §LTHash patch-merge / MAC-verify loop** — Absent from C#; the additive/subtractive LTHash
  verify loop runs in the Web layer (corroborated by `PatchDebugData`/WAM telemetry names), needs a
  live capture or bundle de-minification (bucket D).

### C. Needs server-side / account access

- **17 Q3** — The canonical `.smax` schema spec source and any fields codegen dropped. No `*.smax`
  spec file ships in the dump (only the runtime `WhatsApp.Networking.Smax` directory). Only WhatsApp's
  build-tree `.smax` source would resolve it. (Also touches bucket D for the JS-side schema mirror.)
- **30 Q10** — Composition root of the time-spent / unified-session subsystem. No
  `new TimeSpentManager(`/`new UnifiedSessionManager(` anywhere in the decompile; wiring lives in a
  model-layer partial not present in these artifacts — needs that partial or a runtime call-stack.

### D. Needs full bundle de-minification

- **33 §SyncDMutationStatus** and **33 §LTHash loop** — both ultimately require de-minified
  `waweb-source-bundle` control flow to read the Web-layer SyncD/LTHash logic (also listed under
  bucket B since a live capture is an alternative path).

> Note on the remaining `[PARTIAL]` items: most have already been advanced from a prior CANNOT and now
> have a confirmed managed/JS half plus a residual native or live half (e.g. native Curve25519 flavor,
> WAM producer set, te2 inner byte offsets, AbProps live server values, IQ-timeout MAX_RETRY config
> value, Opus PTT native transcoder profile). They are tracked per-doc and are not repeated as CANNOT
> here because each has a resolved component.

## 4. Method note

No item was upgraded without first-hand evidence captured this pass. Where the prior docs leaned on
"Ghidra empty," those verdicts were re-grounded in concrete `strings`/`objdump`/raw-byte findings.
Where a prior doc over-claimed a CANNOT that the JS bundle or managed surface actually answered (e.g.
PTT Opus params, tc-token TTL = 604800 s, `-RegisterForBGTaskServer` COM wiring, native
`WhatsAppRust` role), the verdict was corrected to RESOLVED/PARTIAL with the supporting citation
folded into the relevant doc body.

## 6. Final pass — live-appdata + cross-reference resolution

An earlier cross-reference round (Baileys / whatsmeow / sigalor reveng / waweb-unmin) **failed before
its findings were applied**. This final pass **re-runs that cross-reference corpus together with new
first-hand evidence** from three sources captured this session: a **live appdata dump** of an
installed client (`research/appdata/`), the **decoded WebView2 IndexedDB** (plaintext, via
`dfindexeddb` — written up in [94. Live AppData Forensics](./94-live-appdata-forensics.md) and
[95. WebView IndexedDB Schema](./95-webview-indexeddb-schema.md)), and a fresh round of native
**imports / strings / byte-scan** over `WhatsAppNative.dll` and `WhatsAppRust.dll`. Provenance labels
used below: `[native-binary]`, `[decompiled-C#]`, `[live-appdata]`, `[bundle]`, `[protocol-cross-ref]`.

**Final-pass totals: UPGRADED 4, still-PARTIAL 31, still-CANNOT 8.**

### Headline upgrades / corroborations

- **Native at-rest cipher chain + custom 4096-byte page codec (docs 32 / 92 / 96)** `[live-appdata]`
  `[decompiled-C#]` `[native-binary]`. 7 DBs are page-encrypted, each an exact multiple of 4096 bytes
  with a random 16-byte salt prefix and no `SQLite format 3\0` magic — a **custom AES+HMAC page codec,
  NOT stock SQLCipher** (no `cipher_version`/`kdf_iter`/`sqlite3_key` markers; `Sqlite::Open` at
  `0x1807326d9` delegates to internal codec callees — doc 96). Key chain traced:
  `session.db` ← DPAPI `Protect("LOCAL=user", StaticKeyBytes16)` (`ProtectionUtils.cs:18`);
  `nativeSettings.db` ← AES-CBC-PKCS7 with `PBKDF2-SHA256(ClientKey, salt=SystemIdForPublisher,
  10000, 32)` (`LoginSessionManager.cs:169-170`, `EncryptionUtils.cs`); data DBs ←
  `LegacyDbSecret=SecureRandomBytes(32)` stored in `nativeSettings.db`
  (`LoginSessionManager.cs:97-98`). Machine-bound → **not offline-decryptable**. Page geometry
  verified on disk (`session.db`/`nativeSettings.db`/`abprops.db` each exactly 4096 bytes; high-entropy
  16-byte prefixes `2fd7b74e…`/`40875b30…`/`e7ac0f60…`).
- **bcrypt = RNG-only; crypto is statically linked (doc 92)** `[native-binary]`. `WhatsAppNative.dll`
  imports from `bcrypt.dll` **only** `BCryptGenRandom` + `BCryptOpenAlgorithmProvider` +
  `BCryptCloseAlgorithmProvider` — **no** `BCryptEncrypt`/`PBKDF2`/`HashData`. This **corrects the
  round-1 "CNG-backed" claim**: AES/HMAC/SHA/KDF are statically linked (BoringSSL-from-WebRTC likely).
  Dynamic deps additionally include `WhatsAppRust.dll` (wamedia), MFPlat/MFReadWrite, WS2_32.
- **IndexedDB is plaintext and authoritative — full schema (docs 20 / 21 / 31 / 32 / 33)**
  `[live-appdata]`. 13 databases decoded. `signal-storage` = identity/signal-meta/prekey/session/
  signed-prekey/baseKey/senderkey stores (libsignal; doc 20). `model-storage` = **103 stores** incl.
  chat/message/contact/participant, `pending-mutations`/`collection-version`/`sync-actions`/
  `sync-keys`/`encrypted-mutations`/`syncd-logs` (SyncD; doc 33), `lid-pn-mapping`/
  `lid-display-name-mapping`/`lid-chat-state` (LID; doc 21), `orphan-tc-token`/`acs-tokens`/
  `direct-connection-keys`. `wawc_db_enc` = keys + `fts_hmac_keys`. The native page-encrypted DBs
  (custom AES+HMAC codec, not stock SQLCipher; doc 96) are a
  **cache/mirror**; the cryptographic source of truth is plaintext in the WebView IndexedDB, so a
  renderer-hosted port inherits it and need not replicate the native scheme.
- **SyncD app-state collections live (doc 33)** `[live-appdata]`: `critical_block`,
  `critical_unblock_low`, `regular`, `regular_high`, `regular_low`.
- **LTHash algorithm (doc 33)** `[protocol-cross-ref]`: WAPatchIntegrity, HKDF info
  `"WhatsApp Patch Integrity"`, 128-byte state, pointwise 16-bit little-endian add/subtract, each
  mutation HKDF-SHA256-expanded to 128 B (whatsmeow `appstate/lthash/lthash.go`, mirrored by Baileys
  `Utils/lt-hash.ts`). → RESOLVED.
- **tc-token / cstoken (doc 21)** `[protocol-cross-ref]`: `HMAC-SHA256(NCTSalt,
  recipientLID.ToNonAD())` (whatsmeow `cstoken.go`). → RESOLVED.
- **Curve25519 = X25519 + XEdDSA — NATIVE-CONFIRMED (docs 11 / 20 / 21 / 91 / 96)** `[native-binary]`.
  A `radare2` pass on `WhatsAppNative.dll` (doc 96) found the **X25519 Montgomery-ladder constant
  `a24 = 121665`** (`0x0001DB41`, 3 hits incl. the adjacent field-constant table) + **SHA-512**
  statically present (`K[0]=0x428a2f98d728ae22`) + the `Curve25519::{Derive,Sign,Verify,GenKeyPair}`
  symbols on the same X25519 class ⇒ X25519 ECDH + XEdDSA signing — upgrading the prior by-interop
  inference to **byte-evidenced**. `@signalapp/libsignal-client` is bit-compatible; **no porting
  blocker**. Only the instruction-level `Sign` body (clamping/nonce) is unread — moot for the port.
- **Port-80 `c.whatsapp.net` dead (doc 10 / 90)** `[protocol-cross-ref]`/live-network: control
  `http://example.com:80` = HTTP 200, `c.whatsapp.net:80` timed out, `:443` mismatched parked Fastly
  cert (`15.197.206.217`). → RESOLVED-DEAD.
- **Time-spent composition root (doc 30 Q10)** `[decompiled-C#]`: `UnifiedSessionManager` ctor
  `UnifiedSessionManager.cs:40`; `TimeSpentManager` ctor `TimeSpentManager.cs:51`;
  `IServerTimeProvider` impl `ClocksMonitor.cs`. No `new` call-site → CANNOT downgraded to PARTIAL.

### Per-doc upgrades applied this pass

- **Doc 12 — Item 6 (native AES-GCM backing): PARTIAL → RESOLVED.** AEAD contract fully pinned
  (AES-256-GCM, 12-byte BE per-direction nonce, 16-byte tag appended, empty AAD post-handshake;
  `AesGcmProvider.cs:11 TagSize=16`). The only residual is OS-internal NIST GCM math inside Windows
  CNG `bcryptprimitives.dll` — not WhatsApp code, not in the dump, irrelevant to a port.
- **Doc 31 — Q14 (WAM native-buffer producers): PARTIAL → RESOLVED.** Source-root inventory of
  `WhatsAppNative.dll` returns only VoIP/RTC roots; VoIP (WebRTC/wacall Fieldstats) is the **sole**
  native WAM producer. `WhatsAppRust.dll` has zero WAM strings. Only the server's semantic field
  dictionary stays open (Baileys cross-ref is best proxy).
- **Doc 33 — SyncDMutationStatus transition semantics: CANNOT → PARTIAL.** Prior "web engine exports
  no status enum" was falsified: web `SyncActionState = ["Success","Malformed","Orphan",
  "Unsupported","Skipped","Failed"]` is persisted as a per-row `actionState` column on IndexedDB
  `SyncActionStore`, recovering the native enum semantics by interop. Native-only `Active=4` and the
  native byte map remain un-disassembled, so it stays PARTIAL.
- **Doc 90 — Item 9 (port-80 chat path): under-claim fixed → RESOLVED-DEAD.** Server-acceptance was
  wrongly tagged CANNOT; live network + cross-ref resolve it dead. Guidance changed to **drop** the
  port-80 ChunkedHttpSocket fallback entirely.

Numerous other per-doc entries were **re-confirmed without an upgrade** (verdict held) and several
carried **forensic corrections** to over-/under-claims surfaced this pass — notably: `msquic.dll`
exports **two** symbols (`MsQuicClose` ord 1, `MsQuicOpenVersion` ord 2), not one (doc 01);
`WinRTAdapter.dll` export-table RVAs `DllGetActivationFactory=0x180001b30`/`DllCanUnloadNow=
0x180001a60`, with the internal `0x180183b44`/`cmp edx,1` claim demoted to needs-disassembly (doc 01);
`WhatsAppNative.dll` symbol table is **"no symbols"** (zero entries), not 7 (doc 16); the SHA-512 IV
table **is** present big-endian at `0xa1c000` (doc 21 — earlier "0×" claim only scanned the LE form);
the WebRTC build-path string identifies **media** static-linkage, not proof the Curve25519 crypto is
BoringSSL (doc 91); and the te2 blob is a plain 18-byte IPv6 `addr(16)‖port(2)` form, not a
warp-framed variant (doc 41).

### Final residual hard-CANNOT (after this pass)

The irreducible set, all requiring a tool/capture **outside the static dump**:

- **Exact native DB page-codec mode** (AES CTR-vs-CBC, HMAC variant) inside `WhatsAppNative.dll` — a
  `radare2` pass (doc 96) located `Sqlite::Open` (`0x1807326d9`) and confirmed a **custom codec, not
  stock SQLCipher**, delegating to internal callees (`0x1808c29e0` …); only the per-page callback body
  is unread. Moot for the port (no codec replication needed; doc 94 §4).
- **Exact native Curve25519 `Sign` instruction body** (clamping, deterministic-nonce) — the **scheme
  is now native-confirmed** (X25519 + XEdDSA via `radare2`, doc 96); only the instruction-level body
  is unread. Moot for the port (`@signalapp/libsignal-client` is bit-compatible).
- **Offline decryption of the native DBs** — machine-bound (DPAPI master key +
  `GetSystemIdForPublisher`), structurally not offline-decryptable.
- Plus the previously-bucketed CANNOTs whose closing artifact is a live wire capture, an ALPHA/
  production build, the upstream `.smax` source, or server/account access (contact notification-hash,
  AbProps live per-user values, WebView2 child-process topology, `.smax` spec grammar, Positron writer
  version, `RegisterForBGTaskServer` host runtime).
