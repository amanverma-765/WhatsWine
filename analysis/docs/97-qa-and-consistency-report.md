# 97. QA & Consistency Report

> Final quality-assurance and consistency pass over the entire `docs/` corpus (00–96). This pass (a) propagated a set of **canonical native-binary corrections** — established this session by the open-questions resolution report ([93](./93-open-questions-resolution.md)) and the radare2 disassembly of `WhatsAppNative.dll` ([96](./96-native-crypto-radare2.md)) — into every per-doc body that still carried the older/weaker prose; (b) ran a global cross-link/index check; and (c) verified the README index lists every document. It is an audit artifact, not a mechanism doc.

## 1. Canonical corrections propagated

The following facts are the binding ground truth. Per-doc prose that contradicted them was fixed and re-cited to the doc that established the fact (mostly [96](./96-native-crypto-radare2.md), with [92](./92-native-modules-dependencies-map.md)/[94](./94-live-appdata-forensics.md)/[95](./95-webview-indexeddb-schema.md) where relevant).

1. **Curve25519 = X25519 ECDH + XEdDSA signing — NATIVE-CONFIRMED** via radare2 ([96](./96-native-crypto-radare2.md) §1). The X25519 Montgomery-ladder constant `a24 = 121665` (`0x0001DB41`) and SHA-512 (`K[0] = 0x428a2f98d728ae22`) are statically present, and the class exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}`. The scheme is **byte-evidenced**, not merely interop-inferred and not "Ghidra empty". Only the instruction-level `Sign` body (clamping/nonce) is unread, and that is **moot for the port** — `@signalapp/libsignal-client` is bit-compatible.
2. **Native crypto provider:** `WhatsAppNative.dll` imports from `bcrypt.dll` **only** `BCryptGenRandom` + `Open/CloseAlgorithmProvider` (RNG). There is **no** `BCryptEncrypt`/`DeriveKeyPBKDF2`/`HashData`. Native AES/HMAC/SHA/KDF is **statically linked** (SHA-1/256/512 all present). The earlier "native crypto = Windows CNG/bcrypt" framing was an overstatement. The **managed** C# `AesGcmProvider` (Noise transport frames) **does** use WinRT/CNG — a separate stack from native `WhatsAppNative.dll`; both statements are kept distinct.
3. **SQLite at-rest = custom AES+HMAC page codec, NOT stock SQLCipher.** No `cipher_version`/`kdf_iter`/`PRAGMA key` markers anywhere; 4096-byte pages + 16-byte per-DB salt + raw 32-byte key (used directly, no passphrase PBKDF2). `Sqlite::Open` (`0x1807326d9`) delegates to internal codec callees ([94](./94-live-appdata-forensics.md)/[96](./96-native-crypto-radare2.md)). Exact AES mode/HMAC variant remain unread (moot for the port).
4. **`msquic.dll` exports two symbols** (`MsQuicClose` ord 1, `MsQuicOpenVersion` ord 2), and is a **WebView2/Edge HTTP3 dependency, NOT the chat/VoIP socket**.
5. **`WhatsAppNative.dll` symbol/export table = "no symbols"** (zero exported FUNC entries). No doc may claim "7 symbols".
6. **te2 VoIP relay-endpoint blob = plain length-discriminated `addr(4|16) || port(2)`** (18-byte IPv6 / 6-byte IPv4), NOT a warp-framed variant; `faceb00c` is a placeholder mask inside the address, and warp is separate packet framing.
7. **`WhatsAppRust.dll` = Meta "wamedia" media libraries** (crates `binrw`/`hashbrown`/`memchr`/`spin` — zero crypto/Signal); media stream-parsing + mp4 ops only.
8. **Live appdata/IndexedDB ([94](./94-live-appdata-forensics.md)/[95](./95-webview-indexeddb-schema.md)):** the native DBs are a cache/mirror; the cryptographic source of truth is the **plaintext WebView IndexedDB** (13 DBs; `signal-storage` = 7 libsignal stores; `model-storage` = 103 stores incl. SyncD app-state + `lid-*` + orphan-tc-token; `wawc_db_enc` keys). The five SyncD collections are live: `critical_block`/`critical_unblock_low`/`regular`/`regular_high`/`regular_low`.

## 2. Per-doc fixes applied

Counts below are `(link fixes, stale-claim fixes)`. "Stale-claim" = prose contradicting §1 that was corrected and re-cited.

| Doc | Fixes | Summary of edits |
|-----|-------|------------------|
| 00-architecture-overview | (0, 10) | Intro caveat + §3.6/§4/§5.2/§6 rows reframed: Curve25519 native-confirmed; storage = custom AES+HMAC codec (not SQLCipher); msquic = WebView2 HTTP/3 with two exports; §6 item-1 verdict upgraded. |
| 01-build-packaging-platform-integration | (0, 4) | msquic one→two exports (resolved internal contradiction); WhatsAppNative SQLite→custom codec + static crypto; port-map curve25519/SQLCipher corrected; Ghidra-empty note superseded by radare2. |
| 10-connection-transport-lifecycle | (0, 7) | All 7 Curve25519 "interop-only / Ghidra-empty blocker" mentions → native-confirmed (a24+SHA-512+class), Sign body moot; §6 item-6 verdict upgraded. |
| 11-noise-protocol-handshake | (0, 7) | Header + §4 + §6 item-1: scheme byte-evidenced (a24 ladder + SHA-512), only Edwards constants absent at runtime; verdict "RESOLVED (native-binary) / PARTIAL-but-MOOT byte-impl". |
| 12-binary-node-encoding-token-dictionary | (0, 2) | §6 item 6 ×2: native SQLite codec "SQLCipher" → custom AES+HMAC, not stock SQLCipher. |
| 13-smax-framework-and-codegen | (0, 1) | §4 native-deps: removed "nothing to find / Ghidra empty / PyGhidra error" framing; provenance recovered via strings/objdump/radare2 (Native static crypto; Rust = wamedia). |
| 14-xmpp-stanza-layer-iq-correlation | (0, 4) | Intro + §4 ×2 + signature claim: native-confirmed crypto, "no exported symbols", WhatsAppRust=wamedia, custom codec not SQLCipher. |
| 15-message-send-pipeline | (0, 7) | §4/§6 Curve25519 native-confirmed (verdict PARTIAL→RESOLVED); four SQLCipher mentions → custom codec; WhatsAppRust enriched. |
| 16-message-receive-offline-retrieval | (0, 1) | §4 native curve25519 "inferred" → native-confirmed (doc 96 §1). |
| 17-stanza-families-catalog | (0, 0) | No contradicting claims; clean. |
| 20-signal-protocol-e2e-encryption | (0, 7) | §3.5/§3.7/§4/§5/§6: scheme native-confirmed, custom codec not SQLCipher; §6 Q1 verdict PARTIAL→RESOLVED (impl-flavor kept as open-but-moot). |
| 21-authentication-companion-pairing | (0, 4) | §4 Curve25519 native-confirmed + WhatsAppRust=wamedia; Ghidra caveat reframed; SQLite row → custom codec; §6 item-4 PARTIAL→RESOLVED. |
| 30-app-shell-lifecycle-process-model | (0, 5) | §4/Q1/Q3: Setup() body moot but scheme byte-evidenced; SQLCipher→custom codec throughout; Q1 [CANNOT] tag correctly retained for the literal Setup() body. |
| 31-webview2-host-native-js-bridge | (0, 3) | Header + §4 native-deps + port-map: removed "both Ghidra dumps empty", custom codec not SQLCipher; resolved internal contradiction with §6 Q1. |
| 32-local-storage-sqlite-keystore | (0, 9) | §1/§3.1/§3.7/§4/§5/§6: nine SQLCipher→custom-codec fixes; radare2 located `Sqlite::Open 0x1807326d9`; §6 item correctly kept [PARTIAL] (AES mode/HMAC genuinely unread). |
| 33-protobuf-type-catalog | (0, 1) | §6 Q7 native store "SQLCipher" → custom AES+HMAC codec, not stock SQLCipher. |
| 40-media-pipeline-upload-download | (0, 4) | Reframed "empty Ghidra export ⇒ PyGhidra-only" → radare2 readable (doc 96) in §4/§6 items 1 & 5; verdicts correctly kept [PARTIAL] (transcoder seed unread by doc 96). |
| 41-voip-calling | (0, 5) | Header + §4 Curve25519/native-crypto rows + te2 port-map: removed CNG overstatement, te2 byte layout decoded (resolved §5↔§6 contradiction). |
| 42-notifications-and-push | (1, 2) | "(see doc on VoIP)" → doc 41; two "both Ghidra dumps empty" framings reframed (subsystem genuinely pure C#/WinRT). |
| 90-linux-electron-porting-roadmap | (0, 9) | Curve25519, custom codec, te2 (verdict PARTIAL→RESOLVED), WhatsAppRust=wamedia, SyncD collections; removed contradictory "needs PyGhidra" closings. |
| 91-protocol-constants-reference | (0, 4) | §4 X25519/AES-GCM bullets + §6 item-2 (PARTIAL→RESOLVED): native-confirmed, "no exported FUNC entries", interop demoted to corroboration. |
| 92-native-modules-dependencies-map | (0, 10) | Header + §2/§3/§4/§5/§6: Curve25519 (§6 item-7 PARTIAL→RESOLVED) + custom codec across all SQLCipher mentions; te2/msquic/WhatsAppRust already correct. |
| 93-open-questions-resolution | (0, 7) | Intro + §1/§3/§6: bcrypt=RNG-only, custom codec not SQLCipher, Curve25519 RESOLVED; reconciled bucket-A header with now-RESOLVED prose verdicts. |
| 94-live-appdata-forensics | (0, 5) | §2/§3/§4/§5: "SQLCipher-style / real SQLCipher / PBKDF2 page key" → custom AES+HMAC codec; preserved the distinct managed `EncryptionUtils` PBKDF2 chain. |
| 95-webview-indexeddb-schema | (0, 1) | Internal-consistency fix: removed a double-counted `recent-stickers` store so the model-storage count matches the canonical 103. |
| 96-native-crypto-radare2 | — | Canonical source doc for §1; not edited. |

## 3. Verdict-tag changes

The corrections upgraded several `[PARTIAL]` open-question verdicts to `[RESOLVED]` where the native-binary evidence now closes the scheme: **00** §6-item-1, **10** §6-item-6, **15** §6 (native crypto), **20** §6-Q1, **21** §6-item-4, **41** §5/§6 te2, **90** §6-item-3 (te2), **91** §6-item-2, **92** §6-item-7. The implementation-flavor / instruction-level-body residuals (donna-vs-ref10 micro-flavor; exact AES mode/HMAC; the `Sign` clamping body) were retained as explicitly **open-but-moot-for-the-port** sub-points rather than forced to RESOLVED.

Verdicts **correctly retained** as `[PARTIAL]`/`[CANNOT RESOLVE STATICALLY]` because no correction addresses them: **30** Q1 (literal `Setup()` instruction body), **32** §6 (exact codec AES mode/HMAC), **40** §6 items 1 & 5 (native transcoder default bitrate/profile constant — not covered by doc 96), **42** §6 items 1 & 5, **90** §6 item-4 (IVoip engine body), and the **14**/**21** native-C# residuals (md-builder source presence; server-minted token bytes).

## 4. Global cross-link & index status

- **Cross-link check:** every `doc NN` / `docs/NN-` reference and every `./NN-*.md` relative link across `docs/*.md` was resolved against the file list. **Zero broken or dangling references.** The full set of referenced doc numbers (00, 01, 10–17, 20, 21, 30–33, 40–42, 90–96) all map to existing files. (Apparent `64` matches were false positives from "32/64-bit" text.)
- **Index completeness:** the README document table now lists **every** `*.md` (00–97). This pass added the previously-missing **96** row and the new **97** row, refreshed the reading order to include 92–97 as appendices, and corrected stale "7 SQLCipher" prose in the README index/source-map to "custom AES+HMAC page codec, not stock SQLCipher".
- **Reading order:** intact and sequential; appendices (91–97) flagged as keep-open references.

## 5. Remaining unresolved contradictions

**None.** Every per-doc QA pass reported either clean or self-fixed. All discovered contradictions (e.g. msquic one-vs-two exports in doc 01; te2 §5-vs-§6 in doc 41; the double-counted IndexedDB store in doc 95; bucket-A header vs RESOLVED prose in doc 93) were fixed in place. The only items still carrying open verdicts are genuine static-analysis residuals (§3), all explicitly scoped as **moot for the Linux/Electron port** and none of which contradict another doc.

## 6. Sign-off

The analysis is **internally consistent and complete** for its stated purpose (a clean-room Linux/Electron reimplementation reference). The canonical native-binary facts established by docs 93 and 96 are now propagated uniformly across all mechanism docs; no doc contradicts another; the README indexes every document with a working link and a one-line description; and every remaining open question is a non-blocking, port-moot instruction-level residual rather than an unknown that gates the reimplementation. The corpus can be treated as the authoritative protocol/behavior reference for the port.
