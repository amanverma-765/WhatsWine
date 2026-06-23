# WhatsApp Windows — Reverse-Engineering & Porting Docs

This directory is the reverse-engineering reference for **Meta's modern native WhatsApp for Windows** (`WhatsApp.Root.exe`, full-trust WinUI 3 / Windows App SDK 1.6, package `5319275A.WhatsAppDesktop` v`2.2607.106.0`, x64). The client is a **hybrid**: the WhatsApp Web JavaScript bundle (`waweb-source-bundle/`, hashed `.js`) runs inside a **WebView2** and holds most UI and business logic, while **native C# + C++ + Rust** provide networking, the Noise transport, Signal/E2E crypto, SQLite storage, media transcoding, and VoIP. The two halves talk over **WinRTAdapter bridge host objects** (e.g. `SQLiteBridge`, `ClientKeyBridge`, `VoipBridge`, `MediaFilesBridge`, `WamBridge`) projected into JS. Every document is evidence-based: facts are cited as `path:LINE` relative to `decompiled_source/`, and anything not directly observed in code is marked **inferred**. The end goal these docs serve is a clean-room Linux/Electron reimplementation under `whatsapp-desktop/`.

## Recommended reading order

1. **Start with the map** — [00. Architecture Overview](./00-architecture-overview.md) for the big picture, then [92. Native Modules & Dependencies Map](./92-native-modules-dependencies-map.md) to see how the binaries fit together.
2. **Transport & wire format** — [10. Connection & Transport Lifecycle](./10-connection-transport-lifecycle.md) → [11. Noise Protocol Handshake](./11-noise-protocol-handshake.md) → [12. Binary Node Encoding & Token Dictionary](./12-binary-node-encoding-token-dictionary.md).
3. **Stanza framework** — [13. Smax Framework & Codegen](./13-smax-framework-and-codegen.md) → [14. XMPP Stanza Layer & IQ Correlation](./14-xmpp-stanza-layer-iq-correlation.md) → [17. Stanza Families Catalog](./17-stanza-families-catalog.md).
4. **Messaging** — [15. Message Send Pipeline](./15-message-send-pipeline.md) → [16. Message Receive & Offline Retrieval](./16-message-receive-offline-retrieval.md).
5. **Crypto & identity** — [20. Signal Protocol & E2E Encryption](./20-signal-protocol-e2e-encryption.md) → [21. Authentication & Companion Pairing](./21-authentication-companion-pairing.md).
6. **App shell & host integration** — [30. App Shell, Lifecycle & Process Model](./30-app-shell-lifecycle-process-model.md) → [31. WebView2 Host & Native-JS Bridge](./31-webview2-host-native-js-bridge.md) → [32. Local Storage: SQLite & Key Store](./32-local-storage-sqlite-keystore.md) → [33. Protobuf Type Catalog](./33-protobuf-type-catalog.md).
7. **Media, calling, push** — [40. Media Pipeline](./40-media-pipeline-upload-download.md) → [41. VoIP Calling](./41-voip-calling.md) → [42. Notifications & Push](./42-notifications-and-push.md).
8. **Build & port** — [01. Build, Packaging & Platform Integration](./01-build-packaging-platform-integration.md) → [90. Linux / Electron Porting Roadmap](./90-linux-electron-porting-roadmap.md).
9. **Keep open as appendices** — [91. Protocol Constants Reference](./91-protocol-constants-reference.md) for verbatim constants throughout; [92. Native Modules & Dependencies Map](./92-native-modules-dependencies-map.md), [93. Open-Questions Resolution Report](./93-open-questions-resolution.md), [94. Live AppData Forensics](./94-live-appdata-forensics.md), [95. WebView IndexedDB Schema](./95-webview-indexeddb-schema.md), and [96. Native Crypto — radare2 Disassembly](./96-native-crypto-radare2.md) as the evidence/forensics appendices, and [97. QA & Consistency Report](./97-qa-and-consistency-report.md) for the final QA sign-off.

## Document index

| # | Document | Description |
|---|----------|-------------|
| 00 | [Architecture Overview](./00-architecture-overview.md) | Top-level map of the native WinUI 3 + WebView2 hybrid client and how its subsystems connect. |
| 01 | [Build, Packaging & Platform Integration](./01-build-packaging-platform-integration.md) | MSIX packaging, AppxManifest, full-trust deployment, and Windows platform integration points. |
| 10 | [Connection & Transport Lifecycle](./10-connection-transport-lifecycle.md) | Socket connect, host selection (`s.whatsapp.net`), reconnect, and the overall transport state machine. |
| 11 | [Noise Protocol Handshake](./11-noise-protocol-handshake.md) | Noise XX/IK/XXfallback_25519_AESGCM_SHA256 handshake and per-frame AES-GCM encryption. |
| 12 | [Binary Node Encoding & Token Dictionary](./12-binary-node-encoding-token-dictionary.md) | FunXMPP binary wire format and the token dictionary that compresses the `ProtocolTreeNode` tree. |
| 13 | [Smax Framework & Codegen](./13-smax-framework-and-codegen.md) | The Smax stanza framework and its generated builders for typed request/response construction. |
| 14 | [XMPP Stanza Layer & IQ Correlation](./14-xmpp-stanza-layer-iq-correlation.md) | XMPP-like stanza routing, IQ request/response correlation, and message-handler dispatch. |
| 15 | [Message Send Pipeline](./15-message-send-pipeline.md) | End-to-end path of an outbound message from JS through native encrypt/encode to the wire. |
| 16 | [Message Receive & Offline Retrieval](./16-message-receive-offline-retrieval.md) | Inbound decode/decrypt path plus offline queue retrieval and acknowledgement. |
| 17 | [Stanza Families Catalog](./17-stanza-families-catalog.md) | Catalog of the `Smax.Generated.*` stanza families (Groups, Presence, Chatstate, PreKeys, Offline, …). |
| 20 | [Signal Protocol & E2E Encryption](./20-signal-protocol-e2e-encryption.md) | Signal/Axolotl double-ratchet, identity/prekey records, and sender keys for E2E messaging. |
| 21 | [Authentication & Companion Pairing](./21-authentication-companion-pairing.md) | Companion-device (multi-device) pairing, ADV identity, and the login/auth flow. |
| 30 | [App Shell, Lifecycle & Process Model](./30-app-shell-lifecycle-process-model.md) | The managed C# shell: process boot, single-instance, window/activation, suspend-resume, bridge wiring. |
| 31 | [WebView2 Host & Native-JS Bridge](./31-webview2-host-native-js-bridge.md) | WebView2 hosting and the WinRTAdapter bridge host objects projected into the JS runtime. |
| 32 | [Local Storage: SQLite & Key Store](./32-local-storage-sqlite-keystore.md) | SQLite-backed local storage via `SQLiteBridge` and the encrypted key/keystore layer. |
| 33 | [Protobuf Type Catalog](./33-protobuf-type-catalog.md) | Catalog of protobuf message types used across protocol, storage, and crypto layers. |
| 40 | [Media Pipeline: Upload, Download & Transcoding](./40-media-pipeline-upload-download.md) | Media hosts (`mmg.whatsapp.net`), upload/download, encryption, and transcoding pipeline. |
| 41 | [VoIP Calling](./41-voip-calling.md) | Call signaling stanzas, the VoIP engine, SRTP keying, and the VoIP bridge to JS. |
| 42 | [Notifications & Push](./42-notifications-and-push.md) | WNS push registration, token handling, and local toast/notification delivery. |
| 90 | [Linux / Electron Porting Roadmap](./90-linux-electron-porting-roadmap.md) | Strategy and phased roadmap for reimplementing the client on Linux/Electron. |
| 91 | [Protocol Constants Reference](./91-protocol-constants-reference.md) | Verbatim, cited dump of protocol constants used across all other documents. |
| 92 | [Native Modules & Dependencies Map](./92-native-modules-dependencies-map.md) | Inventory of native DLLs/modules (C#, C++, Rust) and their interdependencies. |
| 93 | [Open-Questions Resolution Report](./93-open-questions-resolution.md) | Consolidated resolution pass over every open question in docs 00–92 (RESOLVED 83 / PARTIAL 39 / CANNOT 11), with remaining unknowns bucketed by the artifact needed to close them; §6 adds the final live-appdata + cross-reference pass. |
| 94 | [Live AppData Forensics](./94-live-appdata-forensics.md) | On-disk forensics of an installed client's appdata: the 7 page-encrypted DBs (custom AES+HMAC 4096-byte-page codec, not stock SQLCipher), their machine-bound key chain, and the plaintext WebView2 cache layout. |
| 95 | [WebView IndexedDB Schema](./95-webview-indexeddb-schema.md) | Decoded (plaintext, via `dfindexeddb`) WebView2 IndexedDB: 13 databases incl. `signal-storage`, the 103-store `model-storage` (SyncD/LID), and `wawc_db_enc`. |
| 96 | [Native Crypto — radare2 Disassembly](./96-native-crypto-radare2.md) | radare2/rabin2 pass over `WhatsAppNative.dll`: byte-confirms Curve25519 = X25519 ECDH + XEdDSA (a24=121665, SHA-512), statically-linked AES/HMAC/SHA (bcrypt = RNG only), and the custom AES+HMAC SQLite page codec (not stock SQLCipher). |
| 97 | [QA & Consistency Report](./97-qa-and-consistency-report.md) | Final QA pass: per-doc stale-claim fixes propagating the canonical native-binary findings (doc 96), global cross-link/index check, and the internal-consistency sign-off. |

## Source map

All paths are relative to the repository root; reverse-engineering artifacts live under `decompiled_source/` (read-only, never edited).

| Area | Location | Contents |
|------|----------|----------|
| C# assemblies | `decompiled_source/decompiled/WhatsApp.*` | `Root`, `Networking`, `Protobuf`, `VoIP`, `Core`, `DataModels`, `Models`, `Design`, `RichTextFormatting`, `WebView2`, `AbProps`, plus `WhatsAppNativeProjection` (the JS bridge projection). |
| Native C++ | `decompiled_source/ghidra-output/WhatsAppNative-functions.txt` | Ghidra function dump for `WhatsAppNative.dll` (media transcode, SQLite glue). May be empty in some captures. |
| Native Rust | `decompiled_source/ghidra-output/WhatsAppRust-functions.txt` | Ghidra function dump for the Rust core (Curve25519 crypto, VoIP engine). |
| Ghidra projects | `decompiled_source/ghidra-project/` | Raw Ghidra projects/exports for native binaries. |
| App package | `decompiled_source/x64/AppxManifest.xml` | MSIX manifest: bridge host-object registry, capabilities, entry points; alongside `x64/*.dll`. |
| Web bundle | `decompiled_source/waweb-source-bundle/` | Minified WhatsApp Web JS bundle (hashed `.js`) that runs inside WebView2. |
| Android cross-ref | `decompiled_source/android/jadx_output/` | Decompiled Java for confirming protocol details; `android/` also has captured call stanzas (`incoming-offer-stanza.bin`, `decoded-offer-stanza.json`). |
| macOS cross-ref | `decompiled_source/macos/` | macOS app bundle/resources for cross-platform confirmation. |
| Port target | `whatsapp-desktop/` | Electron Forge + Vite + TypeScript scaffold — the clean-room reimplementation target (do not analyze as source). |

### Live evidence & cross-reference corpus

Docs 93 §6, 94, and 95 lean on a complementary corpus outside `decompiled_source/`, under `research/`:

- `research/appdata/` — a live appdata dump of an installed client (the 7 page-encrypted DBs using a custom AES+HMAC page codec — not stock SQLCipher — + the WebView2 `EBWebView` cache). See docs 94/96.
- `research/idb_schema.txt` (and the decoded IndexedDB records) — the plaintext WebView2 IndexedDB schema decoded with `dfindexeddb`: 13 databases, the 103-store `model-storage`, `signal-storage`, `wawc_db_enc`. See doc 95.
- `research/external/*` — interop cross-reference implementations (`Baileys` TS, `whatsmeow` Go, sigalor reveng, `whatsapp-msgstore-viewer`) used to resolve protocol facts (LTHash, tc-token, Curve25519 XEdDSA) by interop.
- `research/waweb-unmin/*.js` — the beautified WhatsApp Web bundle the native client hosts, read for Web-layer logic (SyncD, dictionary version, pairing builders).

## Glossary

- **Smax** — WhatsApp's internal stanza framework (`WhatsApp.Networking.Smax` + `WhatsApp.Smax.Generated.*`). Provides typed builders and parsers for IQ/stanza families (Groups, Presence, Chatstate, PreKeys, Offline, …) instead of hand-building XML/binary nodes.
- **ProtocolTreeNode** — The in-memory representation of an XMPP-like stanza: a tag, attribute map, and either child nodes or a byte payload. This tree is serialized to the FunXMPP binary wire format (see doc 12) before encryption.
- **Noise** — The Noise Protocol Framework used for the connection handshake and transport encryption. WhatsApp uses `Noise_XX`/`IK`/`XXfallback_25519_AESGCM_SHA256`: Curve25519 key agreement, AES-GCM frame cipher, SHA-256 hashing.
- **ADV** — "Associated Device" identity used in multi-device / companion pairing. The ADV signed identity binds a companion device's key to the primary account so linked devices can be authenticated.
- **JID** — Jabber ID, WhatsApp's addressing scheme for users, groups, and devices (e.g. `<number>@s.whatsapp.net`, `<group>@g.us`), inherited from its XMPP heritage.
- **prekey** — A one-time (or signed) Curve25519 public key published in advance, consumed by a peer to establish a Signal session asynchronously without the recipient being online (X3DH key agreement).
- **sender key** — The symmetric group-messaging key in the Signal Sender Key protocol. One sender key per member encrypts group messages once, avoiding per-recipient pairwise encryption for every group send.
- **WNS** — Windows Notification Service, Microsoft's push channel. WhatsApp registers a WNS channel/token to receive push notifications when the app is backgrounded or suspended (see doc 42).
