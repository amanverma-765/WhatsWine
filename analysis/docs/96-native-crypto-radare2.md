# 96. Native Crypto — radare2 Disassembly of `WhatsAppNative.dll`

> Closes the native-binary residuals left by docs 11/20/32/91/92 (Curve25519 signature scheme; SQLite page cipher; hash/crypto provenance). Method: `radare2`/`rabin2` on `decompiled_source/x64/WhatsAppNative.dll` (pei-x86-64) — byte-pattern scans for crypto constants (`/x`) + mining the binary's `.WAobs` function-name section (`izz`). No full `aaa` analysis was run (memory-bounded), so exact instruction-level codec internals remain open (§5); everything below is evidenced by constants + symbols.

## 1. Curve25519 — X25519 ECDH + XEdDSA signing (RESOLVED from binary)

The `Curve25519` WinRT class exposes four methods (from `.WAobs` symbols + error strings):
`Curve25519::Derive` (ECDH), `Curve25519::Sign`, `Curve25519::Verify`, `Curve25519::GenKeyPair`.

- **ECDH = X25519 (Montgomery ladder).** The ladder constant **`a24 = 121665` (`0x0001DB41`)** is present — `/x 41db0100` → 3 hits incl. two adjacent at `0x180a38b60`/`…b68` (the field-constant table). Montgomery-ladder `a24` is the X25519 fingerprint.
- **Signing = XEdDSA over Curve25519** (Signal's scheme), **not** separate Ed25519. Evidence: (a) `Sign`/`Verify` live on the *same* class that does X25519 `Derive` (XEdDSA signs with the X25519/Montgomery key; plain Ed25519 would use a distinct Edwards-key type); (b) **SHA-512 is statically present** — `SHA-512 K[0]=0x428a2f98d728ae22` → `/x 22ae28d7982f8a42` hit at `0x1808b969c` (XEdDSA hashes with SHA-512); (c) signatures are 64-byte (doc 21, JS `ensureSize(sig,64)`). This matches libsignal `xed25519_sign`/`curve25519_sign`.
- **Net:** the round-1/2 "scheme inferred / by-interop" verdict is upgraded to **native-confirmed: X25519 ECDH + XEdDSA(SHA-512) signatures.** A Linux port can use `@signalapp/libsignal-client` (XEdDSA) and be bit-compatible.

## 2. Hash & RNG primitives (resolves doc 92 crypto provenance)

| primitive | evidence | use |
|-----------|----------|-----|
| **SHA-1** | `K=0x5a827999` in a 20+ hit round-function run @ `0x1806b09xx` | HMAC-SHA1 (SRTP `AES_CM_128_HMAC_SHA1_*`; possibly DB-codec HMAC) |
| **SHA-256** | `K[0]=0x428a2f98` @ `0x1808b96a0` (adjacent to SHA-512 table) | general HMAC/HKDF |
| **SHA-512** | `K[0]` @ `0x1808b969c` | XEdDSA, HKDF |
| MD5 | none | — |
| RNG | imports `bcrypt.dll!BCryptGenRandom` only | random bytes |

**Correction to round-1:** `WhatsAppNative.dll` imports from `bcrypt.dll` **only** `BCryptGenRandom` + `Open/CloseAlgorithmProvider` (RNG) — **no** `BCryptEncrypt`/`DeriveKeyPBKDF2`/`HashData`. So all AES/HMAC/SHA/KDF is **statically linked** (BoringSSL-from-WebRTC is the likely provider). Earlier "crypto = Windows CNG/bcrypt" was an overstatement: CNG supplies only randomness.

## 3. SQLite at-rest cipher — custom AES+HMAC page codec (refines docs 32/92)

`.WAobs` exposes the SQLite surface: `Sqlite::Open`, `Sqlite::Checkpoint`, `Sqlite::PrepareStatement`, `SqlitePreparedStatement::{Bind,Step,Reset,GetColumn,GetColumnName,GetSql}`. The page encryption lives **inside `Sqlite::Open`** (which takes the `byte[] secret`).

- **It is NOT stock SQLCipher**: a scan for stock markers (`cipher_version`, `cipher_provider`, `kdf_iter`, `cipher_page_size`, `cipher_default`, `PRAGMA key`, `sqlcipher`) returns **nothing**. So it is a **custom page codec** compiled into the SQLite build.
- **Confirmed structure** (doc 94 §2): **4096-byte pages + a random 16-byte per-DB salt prefix**; key = the raw 32-byte secret (`session.db`: DPAPI-derived; data DBs: `LegacyDbSecret = SecureRandomBytes(32)`) — used directly (no passphrase PBKDF2, since it is already a random key).
- **`Sqlite::Open` disassembled** (entry at `0x1807326d9`, found via the `.WAobs` name xref): it parses the path, allocates, and **delegates key/codec setup to internal callees** (e.g. the indirect `0x1808c29e0` via the table at `0x1808d2340`); the page encrypt/decrypt is a registered codec callback, not inline in `Open`. Pinning the exact mode requires following those callees 2–4 levels deep (deferred — §5).
- **Primitives available:** AES + HMAC (SHA-1/256/512 all statically present). **Correction:** the string `AES-256 integer counter mode` is **libsrtp** (VoIP), not the DB codec — it sits among `cipher key`/`cipher salt`/`rtcp cipher`/`null cipher`/`running self-test for cipher` (libsrtp debug strings, doc 41 SRTP), so it must **not** be cited as the DB-codec mode. The DB codec's exact AES mode (CTR vs CBC) and HMAC variant are therefore **undetermined** by this pass.
- The earlier `kdf_iter` byte-scan (`256000`) was **inconclusive** (`00e80300` has 50+ matches — false positives), consistent with raw-key mode (no large iteration count).

## 4. Linux/Electron port mapping

- **Signatures/ECDH:** `@signalapp/libsignal-client` (`@noble/curves` `x25519` for ECDH; XEdDSA via libsignal) is byte-compatible with the native `Curve25519`.
- **DB codec:** do **not** reverse/replicate it — it is a Windows-only custom codec over a machine-bound key (doc 94). A port uses plain `better-sqlite3` (or `safeStorage`-keyed SQLCipher) and inherits the real key store from the WebView IndexedDB (docs 94/95).

## 5. Residual (only closeable by deeper disassembly — moot for the port)

- **Exact DB-codec internals**: AES mode (CTR vs CBC), HMAC variant, and per-page IV/MAC layout. `Sqlite::Open` IS now located and disassembled (`0x1807326d9`); it delegates to internal codec callees (`0x1808c29e0` et al.). Closing this needs following those callees to the per-page encrypt/decrypt callback (an `aaa` + multi-level `axt`/`pdf` trace through the stripped binary) — a real RE task, **deliberately stopped here** as it is irrelevant to the Linux port (which never replicates this codec; doc 94 §4). Re-entry point for anyone who needs it: `af @ 0x1808c29e0` then trace the function that consumes the 16-byte salt + 32-byte key per page.
- **`Curve25519::Sign` instruction-level body**: the XEdDSA verdict is from constants + class shape + interop; a function-body read would make it 100% byte-exact.

## 6. Cross-references
Upgrades: doc 11/20/91 (Curve25519 = X25519+XEdDSA, native-confirmed), doc 32 (custom AES+HMAC page codec, not stock SQLCipher), doc 92 (static crypto, bcrypt=RNG-only, SHA-1/256/512 present). Companion live-data: docs 94/95. Tooling: `radare2 5.x` (`/x`, `izz`) on `decompiled_source/x64/WhatsAppNative.dll`.
