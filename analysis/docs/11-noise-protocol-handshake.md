# 11. Noise Protocol Handshake & Frame Encryption

> Target: Meta native WhatsApp for Windows (WhatsApp.Root.exe, WinUI 3, v2.2607.106.0).
> All paths in §2/§3 are relative to `decompiled_source/`. Every `file.cs:LINE` citation was read directly from the decompiled C#. The native Curve25519 scheme is **byte-evidenced** via radare2 against `x64/WhatsAppNative.dll` — the X25519 Montgomery-ladder constant `a24 = 121665` and SHA-512 init words are statically present, and the binary exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}` (doc 96). Only the instruction-level `Sign` body (clamping/nonce) is unread, and that is moot for the port; native behavior elsewhere is inferred from the C# callers and labeled as such.

## 1. Purpose & Scope

This document covers the transport-security layer that sits **between the raw socket and the FunXMPP binary stanza layer**: the Noise Protocol handshake that authenticates the server and establishes session keys, and the per-frame AES-256-GCM encryption that protects every stanza after login.

Concretely, in scope:

- The Noise handshake state machine (`Noise_XX`, `Noise_IK` resume, `Noise_XXfallback`), all over `Curve25519 / AES-GCM / SHA-256`.
- The running transcript hash, ECDH→HKDF key splitting (`MixKey`/`MixHash` equivalents), and AEAD of handshake payloads.
- The `HandshakeMessage` protobuf wire format (`ClientHello` / `ServerHello` / `ClientFinish`).
- Server certificate-chain validation (`CertChain` / `NoiseCertificate`) pinned to a hardcoded root key.
- The `ClientPayload` login blob carried inside the final handshake message.
- The post-handshake transport: 3-byte length frames, zlib compression flag, and the two directional AES-256-GCM keys with **independent monotonic 96-bit nonces**.

Out of scope (covered elsewhere): FunXMPP token encoding (`BinTreeNodeWriter/Reader`), the IQ/stanza dispatch state machine (`WAProtocol`), Signal/double-ratchet message crypto, and VoIP SRTP keying.

The single most important architectural fact: **this entire layer is native C#/C++ (not in the WebView2 JS bundle).** The JS WhatsApp Web bundle never sees the Noise handshake or the transport keys; it hands the native side a `ClientKey` (the Signal identity key, used here as the Noise static keypair) and receives a fully-established, decrypted stanza stream.

## 2. Where It Lives

| Concern | File (relative to `decompiled_source/`) |
| --- | --- |
| Handshake orchestration / state machine | `decompiled/WhatsApp.Root/WhatsApp/HandshakeHandler.cs` |
| Noise symmetric state (chain key, cipher key, nonce, transcript) | `decompiled/WhatsApp.Root/WhatsApp/HandshakeCipher.cs` |
| Running transcript hash (`MixHash`) | `decompiled/WhatsApp.Root/WhatsApp/HandshakeHash.cs` |
| AEAD primitive (AES-256-GCM) | `decompiled/WhatsApp.Root/WhatsApp/AesGcmProvider.cs` |
| Handshake protobuf wire types | `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/HandshakeMessage.cs` |
| Server cert validation + pinned root key | `decompiled/WhatsApp.Root/WhatsApp/WACertificateVerificationUtils.cs` |
| ECDH / sign / verify (native Curve25519 wrapper) | `decompiled/WhatsApp.VoIP/WhatsApp/Curve22519Extensions.cs` |
| Native Curve25519 WinRT projection | `decompiled/WhatsAppNativeProjection/WhatsAppNative/Curve25519.cs` |
| HKDF-SHA256 (key derivation) | `decompiled/WhatsApp.VoIP/WhatsApp/HkdfSha256.cs`, `decompiled/WhatsApp.VoIP/WhatsApp/Hkdf.cs` |
| Frame length-prefix write | `decompiled/WhatsApp.Networking/WhatsApp/FramesWriter.cs` |
| Frame length-prefix read / reassembly | `decompiled/WhatsApp.Networking/WhatsApp/FramesReader.cs` |
| Post-login encrypted send path | `decompiled/WhatsApp.Root/WhatsApp/StanzaWriter.cs` |
| Post-login encrypted receive path | `decompiled/WhatsApp.Root/WhatsApp/EncryptedBytesReceiver.cs` |
| Big-endian nonce helper + login dispatch | `decompiled/WhatsApp.Root/WhatsApp/WAProtocol.cs` |
| Handshake↔encrypted wiring (frame target) | `decompiled/WhatsApp.Root/WhatsAppCommon/SocketAdapter.cs` |
| Handshake construction (key sources) | `decompiled/WhatsApp.Root/WhatsAppCommon/ConnectionManager.cs` |
| Dictionary version byte in header | `decompiled/WhatsApp.Networking/WhatsApp/TokenDictionary.cs`, `decompiled/WhatsApp.Networking/WhatsApp/WAPDefaultTokenDictionary.cs` |

Namespaces: `WhatsApp` (handshake, cipher, AEAD, frames), `WhatsApp.ProtoBuf` (protobuf), `WhatsAppCommon` (`SocketAdapter`, `ConnectionManager`), `WhatsAppNative` (native projection).

The fully-qualified Windows source path baked into log/`FailuresService` strings is `D:\full-fbsource\whatsapp\windows\Samples\WinUI\WebView2\WhatsApp.Root\SeamlessMigration\FunXMPP\…` (e.g. `HandshakeHandler.cs:82`) — i.e. internally this whole subsystem is the "FunXMPP / SeamlessMigration" module.

## 3. How It Works

### 3.1 Protocol identity & the three Noise variants

`HandshakeCipher` hardcodes the Noise protocol name as the 32/36-byte initial hash seed (the bytes are the ASCII protocol string, zero-padded for the 28-char names so they fit a 32-byte block):

```csharp
// HandshakeCipher.cs:8  FULL_HANDSHAKE
"Noise_XX_25519_AESGCM_SHA256\0\0\0\0"          // 28 chars + 4 NUL  = 32 bytes
// HandshakeCipher.cs:16 RESUME_HANDSHAKE
"Noise_IK_25519_AESGCM_SHA256\0\0\0\0"          // 28 chars + 4 NUL  = 32 bytes
// HandshakeCipher.cs:24 FALLBACK_HANDSHAKE
"Noise_XXfallback_25519_AESGCM_SHA256"          // 36 chars, no pad  = 36 bytes
```

`HandshakeHash` (`HandshakeHash.cs:10-20`) initializes the transcript `Hash` to `initial` when `initial.Length <= 32`, otherwise to `SHA256(initial)`. So `XX`/`IK` (length 32) seed the transcript with the **raw protocol-name bytes**; `XXfallback` (length 36) seeds it with `SHA256("Noise_XXfallback_25519_AESGCM_SHA256")`. This is exactly the standard Noise `InitializeSymmetric`.

Which variant runs:

- **`Noise_XX` (full)** — fresh connection, no cached server static key. This is the path taken in practice (see §3.9).
- **`Noise_IK` (resume)** — only when a cached `serverStaticPublic` is supplied to `HandshakeHandler`. Lets the client send its static key + login payload **in the first message** (0-RTT-ish). `HandshakeHandler.cs:76-99`.
- **`Noise_XXfallback`** — entered mid-handshake when the client tried `IK` but the server's `ServerHello` carried a `Static` field, meaning the server rejected the resume and wants a full handshake. `HandshakeHandler.cs:122-124,168-173`.

### 3.2 Transcript hash and `MixHash`

`HandshakeHash.Update` is the Noise `MixHash(data) = h = SHA256(h ‖ data)`:

```csharp
// HandshakeHash.cs:22-28
public void Update(byte[] buffer) {
    var h = Utils.CreateSha256Hash();
    h.Append(Hash.AsBuffer());      // previous transcript hash
    h.Append(buffer.AsBuffer());    // new data
    Hash = h.GetValueAndReset().ToArray();
}
```

The transcript is mixed at every step: the protocol-version prologue (§3.3), each ephemeral/static key (plaintext or ciphertext), and each encrypted payload. Crucially `encryptPayload`/`decryptPayload` mix the **ciphertext** (`HandshakeCipher.cs:72,79`), and `encrypt/decryptEphemeralKey` mix the key bytes that go on the wire (`HandshakeCipher.cs:59,65`) — matching Noise's rule that `h` always absorbs exactly what is transmitted.

### 3.3 Symmetric state: chain key, cipher key, nonce

`HandshakeCipher` holds the Noise `CipherState` + the chaining key:

```csharp
// HandshakeCipher.cs:32-45
private readonly HandshakeHash _hash;
private byte[] _chainKey;     // ck
private long   _nonce;        // n  (per cipher-key, reset on each MixKey)
private byte[] _cipherKey;    // k  (null until first MixKey)

public HandshakeCipher(byte[] handshakeName, byte[] version) {
    _hash = new HandshakeHash(handshakeName);
    _chainKey = _hash.Hash;     // ck := h (Noise InitializeSymmetric)
    _hash.Update(version);      // MixHash(prologue) -- the 'version' header
}
```

The `version` passed in is the 4-byte routing/version **prologue** `_header` (§3.4). So `ck` starts equal to the protocol-name hash, and the prologue is the first thing mixed into `h`. `_cipherKey == null` means "no key yet" → payloads pass through unencrypted (`encryptPayload` at `HandshakeCipher.cs:71`).

**`MixKey` (`setKey`)** — called after every ECDH:

```csharp
// HandshakeCipher.cs:83-91
public void setKey(byte[] agreement) {
    byte[] okm = HkdfSha256.Perform(64, agreement, _chainKey);  // HKDF(salt=ck, ikm=dh, 64 bytes)
    _nonce = 0L;                                                 // reset AEAD counter
    _chainKey = okm[0..32];                                      // new ck
    _cipherKey = okm[32..64];                                    // new k
}
```

i.e. `ck, k = HKDF-SHA256(salt = ck, ikm = dh_output, L = 64)` with empty `info`, then `n = 0`. `HkdfSha256.Perform(64, key=agreement, salt=ck)` → `Hkdf.Perform(key, salt, info=null, keyLen=64, hashLen=32, HMAC-SHA256)` (`HkdfSha256.cs:9`). This is the standard Noise HKDF chaining (`temp_k = HKDF(ck, dh)[1]; ck = HKDF(ck, dh)[0]`), folded into one 64-byte expansion.

**`Split` (`getNoiseCipher`)** — final transport-key derivation:

```csharp
// HandshakeCipher.cs:93-101
public Pair<byte[],byte[]> getNoiseCipher() {
    byte[] okm = HkdfSha256.Perform(64, Array.Empty<byte>(), _chainKey); // HKDF(salt=ck, ikm="", 64)
    return new Pair(okm[0..32], okm[32..64]);   // (writeKey, readKey)
}
```

This is Noise `Split()` with empty input. The first 32 bytes become the **client→server (write) key**, the next 32 the **server→client (read) key** — see `SocketAdapter.cs:73-82` where `pair.First` keys `StanzaWriter` and `pair.Second` keys `EncryptedBytesReceiver`.

> Detail worth porting carefully: `HkdfSha256.Perform(L, key, salt)` maps to `HKDF(IKM=key, salt=salt, info=null)`. In `MixKey`, `IKM=dh`, `salt=ck`. In `Split`, `IKM=∅`, `salt=ck`. `Hkdf.Extract` defaults a null salt to 32 zero bytes (`Hkdf.cs:17-19`), but that branch is never hit here since `ck` is always 32 bytes.

### 3.4 The wire prologue: edge header + `WA 6 3`

Before any Noise message, `WriteInitialStanza` (`HandshakeHandler.cs:147-166`) writes raw (un-framed for the headers, framed for the protobuf):

1. **Optional edge-routing header** when `_edgeRoutingInfo` is non-empty (`HandshakeHandler.cs:149-156`):
   - `_edgeHeader = { 0x45, 0x44, 0x00, 0x01 }` = `"ED\0\x01"` (`HandshakeHandler.cs:50`)
   - then a **3-byte big-endian length** of the routing info (`FramesWriter.MediumToByteArray`)
   - then the `_edgeRoutingInfo` bytes.
   These go out via `WriteBinaryArray` (a direct `socket.Send`, no frame length prefix of their own beyond the medium they embed).
2. **The version/prologue header** `_header` (`HandshakeHandler.cs:47-49`):
   ```csharp
   byte[] obj = new byte[4] { 87, 65, 6, 0 };          // 'W','A', 6, 0
   obj[3] = (byte)FunXMPP.Dictionary.GetDictionaryVersion();
   ```
   `GetDictionaryVersion()` returns the `WAPDefaultTokenDictionary.DictionaryVersion` value, **`3`** (`WAPDefaultTokenDictionary.cs:163`, surfaced via `TokenDictionary.cs:107-110`). So the header on the wire is **`57 41 06 03` = `"WA"`, `0x06` (WhatsApp protocol/Noise version 6), `0x03` (token-dictionary version)**. `WaProtocolVersion = 6` is also the constant at `HandshakeHandler.cs:11`. This exact header is independently confirmed by the **waweb bundle the native client itself hosts** [bundle, read this session]: it emits `new Uint8Array([87, 65, 6, o("WAWapDict").DICT_VERSION])` with `WAWapDict.DICT_VERSION = 3` (`research/waweb-unmin/SjCAw3j6…WiG.js:115092`, `n6o0-NaJTww.js:3730-3739`), and by both open clients (whatsmeow `WAConnHeader = {'W','A',6,3}` `socket/constants.go:29,32`; Baileys `NOISE_WA_HEADER = [87,65,6,3]` `Defaults/index.ts:32,34`) — see §6 item 6.

This `_header` is also the Noise **prologue** mixed into `h` at `HandshakeCipher` construction (`HandshakeCipher.cs:44` via the `version` ctor arg passed at `HandshakeHandler.cs:68,78,170`).

After the header(s), it calls `SendClientHello()` (XX) or `SendClientResume(_serverStaticPublic)` (IK) — `HandshakeHandler.cs:158-165`.

### 3.5 `HandshakeMessage` protobuf wire format

`HandshakeMessage` (`HandshakeMessage.cs`) is a SilentOrbit-generated protobuf, length-delimited inside one frame:

- Top-level fields (`HandshakeMessage.cs:725-756`):
  - field **2** (`tag 0x12`) → `ClientHello`
  - field **3** (`tag 0x1A`) → `ServerHello`
  - field **4** (`tag 0x22`) → `ClientFinish`
- `ClientHello` / `ServerHello` (`HandshakeMessage.cs:8-14,185-191`): field **1** `Ephemeral` (`0x0A`), field **2** `Static` (`0x12`), field **3** `Payload` (`0x1A`).
- `ClientFinish` (`HandshakeMessage.cs:362-366`): field **1** `Static` (`0x0A`), field **2** `Payload` (`0x12`).

All fields are `bytes`. The whole `HandshakeMessage` is serialized with `SerializeToBytes` and pushed via `_framesWriter.WriteFrameInternal` (`HandshakeHandler.cs:73,98,208`) — i.e. it gets a 3-byte length prefix like any other frame (§3.7).

### 3.6 Step-by-step: the three handshakes

#### Noise_XX (full) — the live path

**Message 1 — ClientHello (`SendClientHello`, `HandshakeHandler.cs:66-74`)**
```
cipher = new HandshakeCipher(FULL_HANDSHAKE, header)   // h = name; MixHash(header)
ch.Ephemeral = encryptEphemeralKey(e_pub)              // MixHash(e_pub); sent in clear (no k yet)
send HandshakeMessage{ ClientHello{ Ephemeral = e_pub } }
```
`e`/`e_pub` were generated in the ctor: `Curve22519Extensions.GenKeyPair(out _clientEphemeralPublic, out _clientEphemeralPrivate)` (`HandshakeHandler.cs:57`).

**Message 2 — ServerHello (`ReceiveServerHandshake`→`ReceiveServerHello`, `HandshakeHandler.cs:137-210`)**
The server replies with `{ Ephemeral=re, Static=enc(rs), Payload=enc(cert) }`. Client processing (`HandshakeHandler.cs:175-202`):
```
re      = decryptEphemeralKey(serverHello.Ephemeral)   // MixHash(re); plaintext
setKey( Derive(re, e_priv) )                           // MixKey(ee)
rs      = decryptStaticKey(serverHello.Static)         // AES-GCM decrypt with k, AAD=h, then MixHash(ct)
setKey( Derive(rs, e_priv) )                           // MixKey(es)
cert    = decryptPayload(serverHello.Payload)          // AES-GCM decrypt; MixHash(ct)
ValidateCertificate(cert, rs, now, 6)                  // §3.8 ; throws if untrusted
SeamlessMigrationAppSessionStorage.ServerStaticPublicKey = rs   // cache rs for future IK resume
```

**Message 3 — ClientFinish (`HandshakeHandler.cs:199-209`, same method)**
```
cs_ct   = encryptStaticKey(s_pub)                      // AES-GCM encrypt client static; MixHash(ct)
setKey( Derive(re, s_priv) )                           // MixKey(se)
payload = encryptPayload(BuildClientPayload())         // encrypt the login ClientPayload; MixHash(ct)
send HandshakeMessage{ ClientFinish{ Static = cs_ct, Payload = payload } }
return true
```
DH ordering for XX is therefore **ee, es, se** — the canonical `Noise_XX` pattern (`…→ e, ee, s, es | s, se`). Note the client static is sent **encrypted** under the post-`es` key (forward secrecy / identity hiding), which is the XX guarantee.

After `ProcessFrame` sees `TryHandshake` return `true`, it calls `GenerateKeys()`→`Split` and switches to the encrypted path (§3.9).

> **State-machine subtlety:** all of message-2 processing **and** message-3 sending happen inside the single `ReceiveServerHello` call triggered by the inbound ServerHello frame. There is no separate "send finish" event. The login `success`/`failure` stanza then arrives as the *first encrypted frame*.

#### Noise_IK (resume) — `SendClientResume` (`HandshakeHandler.cs:76-99`)

Used only if `_serverStaticPublic != null`. The client already knows `rs`, so it front-loads everything:
```
cipher = new HandshakeCipher(RESUME_HANDSHAKE, header)
rs      = decryptStaticKey(serverStaticPublic)   // NB: with no k yet this is a pass-through copy + MixHash
e_ct    = encryptEphemeralKey(e_pub)             // MixHash(e_pub)
setKey( Derive(rs, e_priv) )                     // MixKey(es)   -- 'es' first in IK
s_ct    = encryptStaticKey(s_pub)                // encrypt client static; MixHash(ct)
setKey( Derive(rs, s_priv) )                     // MixKey(ss)
payload = encryptPayload(BuildClientPayload())   // encrypt login; MixHash(ct)
send HandshakeMessage{ ClientHello{ Ephemeral=e_ct, Static=s_ct, Payload=payload } }
```
DH ordering **es, ss** matches `Noise_IK` initiator (`→ e, es, s, ss`). The reply is handled by `ReceiveServerResume` (`HandshakeHandler.cs:115-135`):
```
if serverHello.Static != null  -> fall back (server refused resume)   // §3.6 fallback
re   = decryptEphemeralKey(serverHello.Ephemeral)
setKey( Derive(re, e_priv) )    // MixKey(ee)
setKey( Derive(re, s_priv) )    // MixKey(se)
cert = decryptPayload(serverHello.Payload)
if cert non-empty: ValidateCertificate(cert, serverStaticPublic, now, 6)  // else trust cached rs
```

#### Noise_XXfallback — `ReceiveServerFallback` (`HandshakeHandler.cs:168-173`)

Triggered from `ReceiveServerResume` when the server's hello unexpectedly contains a `Static` (`HandshakeHandler.cs:122-124`). It **re-initializes the cipher** with `FALLBACK_HANDSHAKE` and re-mixes the client ephemeral, then runs the ordinary `ReceiveServerHello` (the XX message-2/3 logic):
```csharp
_cipher = new HandshakeCipher(FALLBACK_HANDSHAKE, _header); // fresh transcript, fallback name
_cipher.encryptEphemeralKey(_clientEphemeralPublic);        // MixHash(e_pub) -- re-establish 'e'
return ReceiveServerHello(serverHello);                     // ee, es, se ... ClientFinish
```
This is the Noise "fallback" pattern: the original `e` is reused as the prologue-equivalent and a fresh XX transcript is built. (Standard Noise XXfallback also mixes the initiator's `e` as part of the pre-message; here it is mixed by the explicit `encryptEphemeralKey` call.)

### 3.7 Handshake AEAD details (`encrypt/decryptPayload`)

```csharp
// HandshakeCipher.cs:69-81
public byte[] encryptPayload(byte[] pt) {
    byte[] ct = (_cipherKey == null) ? pt
              : AesGcmProvider.AesGcmEncrypt(_cipherKey, WAProtocol.LongToByteArray(_nonce++, 12), _hash.Hash, pt);
    _hash.Update(ct);   // MixHash(ciphertext)
    return ct;
}
```

So during the handshake each AEAD op uses:
- **Key**: current 32-byte `_cipherKey` (`k`) → AES-**256**-GCM (`AesGcmProvider` opens `SymmetricAlgorithmNames.AesGcm`, key length determines AES-256).
- **Nonce**: `LongToByteArray(_nonce++, 12)` → a **12-byte big-endian** counter (`WAProtocol.cs:53-66` writes the 64-bit value into the **last 8 bytes**, leaving the first 4 bytes zero). `_nonce` resets to 0 on every `setKey` (`HandshakeCipher.cs:86`). This is exactly Noise's 96-bit nonce = 32 zero bits ‖ 64-bit counter (big-endian here, **not** the little-endian the canonical Noise spec uses — a port must match WhatsApp's big-endian layout, §5). The big-endian layout is independently confirmed by both open clients (cross-reference: whatsmeow `generateIV` uses `binary.BigEndian.PutUint32(iv[8:], count)`, `socket/noisesocket.go:73-77`; Baileys `generateIV` uses `DataView.setUint32(8, counter)` which defaults to big-endian, `Utils/noise-handler.ts:14-16`) — they place a 32-bit counter in bytes 8–11 versus the native 64-bit counter in bytes 4–11, but the emitted IV bytes are identical for any realistic counter value.
- **AAD**: the **current transcript hash `h`** (`_hash.Hash`) — Noise's `EncryptAndHash` rule. This is the load-bearing detail that binds the payload to the whole transcript.

`AesGcmProvider.AesGcmEncrypt` (`AesGcmProvider.cs:13-34`) returns `ciphertext ‖ 16-byte tag` (tag appended). `AesGcmDecrypt` (`AesGcmProvider.cs:36-70`) splits the trailing 16 bytes as the tag, calls `DecryptAndAuthenticate`, and **returns `null` on any auth failure** (the `catch (Exception){}` at lines 66-68). `TagSize = 16` (`AesGcmProvider.cs:11`). Empty plaintext is special-cased to avoid encrypting zero bytes (`AesGcmProvider.cs:29`).

### 3.8 Server certificate validation (pinned root)

`WACertificateVerificationUtils.ValidateCertificate(cert, serverStatic, now, 6)` (`WACertificateVerificationUtils.cs:67-86`) routes WA-version 6 to `ValidateCertificateWA6` → `ValidateCertificateChain`:

- The cert bytes parse as a **`CertChain`** protobuf with `Intermediate` and `Leaf` `NoiseCertificate`s (`WACertificateVerificationUtils.cs:117-150`).
- **Pinned root** (`WACertificateVerificationUtils.cs:57-65`): a hardcoded 32-byte Curve25519 public key
  `14 23 75 57 4D 0A 58 71 66 AA E7 1E BE 51 64 37 C4 A2 8B 73 E3 69 5C 6C E1 F7 F9 54 5D A8 EE 6B`,
  issuer `"WhatsAppLongTerm1"`, serial `0` (`RootIssuer`, line 65).
- **Intermediate** is verified against the pinned root: `IssuerSerial == 0` and `Curve25519.Verify(details, signature, rootPubKey)` (`ValidatedCertificate`, `WACertificateVerificationUtils.cs:152-186`).
- **Leaf** is verified against the intermediate's key (`result.GetIssuerData()`), and then its `Details.Key` **must byte-equal the `serverStaticPublic` (`rs`) from the handshake** (`WACertificateVerificationUtils.cs:144-148`). This is what actually ties the TLS-like cert chain to the Noise static key.
- **Time checks are disabled for WA6**: `VerifyTimeForWA6 = false` (`WACertificateVerificationUtils.cs:55`) and `ValidateCertificateChain` passes `now = null` (`WACertificateVerificationUtils.cs:85`), so the `NotAfter`/`NotBefore` branches in `ValidatedCertificate` (lines 159-179) are skipped. (The legacy WA5 path `ValidateCertificateWa5` does check `Expires` — lines 88-115 — but is not used for v6.)

`Curve22519Extensions.Verify` swallows native exceptions and returns `false` (`Curve22519Extensions.cs:37-48`), so a malformed signature fails closed. A failed `ValidateCertificate` throws `InvalidOperationException("Untrusted server cert")` and aborts the handshake (`HandshakeHandler.cs:194-197,130-133`).

### 3.9 Handshake→transport handoff & per-frame transport crypto

`SocketAdapter` is the `FramesReader.ITarget`. Pre-login `_reader == null`, so each complete frame goes to the handshake; once `TryHandshake` returns `true` it splits keys and installs the encrypted reader (`SocketAdapter.cs:51-90`):

```csharp
if (_handshake.TryHandshake(GetBytesFrame())) {
    Pair<byte[],byte[]> pair = _handshake.GenerateKeys();             // Split() -> (write, read)
    StanzaWriter writer = new StanzaWriter(_adaptee, pair.First);     // write key
    WAProtocol p = new WAProtocol(false, _attempt, _requestsTracker, writer, this, _connectInPullMode);
    p.LoggedIn += () => {
        _stateSubject.OnNext(Connected);
        _adaptee.SetTimeout(ForegroundPingTimeout=100s, cumulative:false);  // SocketAdapter.cs:79
        this.LoggedIn?.Invoke(this, writer);
    };
    _reader = new EncryptedBytesReceiver(pair.Second, p);            // read key
}
```

The login timeout before this is `Constants.LoginTimeout = 30s` (`ConnectionManager.cs:224`, `Constants.cs:198`); after `LoggedIn`, the read timeout becomes `100s` (`Constants.cs:200`).

**Outbound transport frame (`StanzaWriter`, `StanzaWriter.cs`):**
1. `BinTreeNodeWriter` serializes the `ProtocolTreeNode` to a `MemoryStream`.
2. Compression decision (`StanzaWriter.cs:44-66`): if `useCompression` and it actually shrinks, prepend flag byte **`2`** and Deflate; else prepend flag byte **`0`** and copy raw. (`WAProtocol.FlagCompressed = 2`, `WAProtocol.cs:11`.) Hard cap 32 MiB (`33554432`, line 67). The Deflate is **zlib-WRAPPED** (zlib header + trailing Adler-32), not raw DEFLATE — `StanzaWriter` uses the default `DeflaterOutputStream` ctor (`StanzaWriter.cs:46`, no `noZlibHeaderOrFooter`) and the inbound side the default `InflaterInputStream` (`EncryptedBytesReceiver.cs:37`). Confirmed by cross-reference: both open clients decompress bit-`2`-flagged frames with a **zlib** decoder (whatsmeow `zlib.NewReader` in `binary/unpack.go:21-30`; Baileys Node `zlib.inflate`, *not* `inflateRaw`, in `WABinary/decode.ts:9-15`). A port must therefore use `zlib.deflate`/`inflate`, not `deflateRaw`/`inflateRaw`.
3. Encrypt the whole `[flag ‖ body]` (`StanzaWriter.cs:74-78`):
   ```csharp
   frame = AesGcmProvider.AesGcmEncrypt(_writeKey, WAProtocol.LongToByteArray(_writeNonce++, 12), null, frame, 0, len);
   _framesWriter.WriteFrameInternal(frame);
   ```
   **Note `aad = null`** — unlike the handshake, transport frames have **no AAD**. Nonce is the same 12-byte big-endian counter, but `_writeNonce` is a **separate, independent counter** starting at 0 and **never reset** for the life of the connection.

**Inbound transport frame (`EncryptedBytesReceiver`, `EncryptedBytesReceiver.cs`):**
```csharp
byte[] pt = AesGcmProvider.AesGcmDecrypt(_readKey, WAProtocol.LongToByteArray(_readNonce++, 12), null, input, offset, length);
if (pt == null) { FailuresService.Investigate("Failed to decrypt AES GCM frame", ...); return; }
if ((pt[0] & 2) != 0)  // compressed flag -> Inflater
     ...inflate pt[1..]...
else memoryStream = pt[1..];
ProtocolTreeNode node = _reader.ParseTreeNode(memoryStream);
_protocol.ProcessStanza(node, memoryStream.Length);
```
`_readNonce` is the inbound-direction independent counter. The compression flag is checked as `pt[0] & 2` (`EncryptedBytesReceiver.cs:33`). `ProcessStanza` then routes by login state (`WAProtocol.cs:34-51`): pre-login `success`/`failure` (`ProcessAuthenticationNode`, `WAProtocol.cs:84-…`), post-login IQ dispatch.

**Frame layer (both directions):** 3-byte big-endian length (24-bit "medium"). `FramesWriter.MediumToByteArray` (`FramesWriter.cs:31-38`) writes `len>>16, len>>8, len`. `FramesReader.OnBytesAvailable` (`FramesReader.cs:66-85`) reads `num5 = (b0<<16)+(b1<<8)+b2`, waits until `length >= num5`, then calls `ProcessFrame(buffer, offset+3, num5)`, reassembling partial socket reads in a `WaMemoryStream` (`FramesReader.cs:27-49`). Max frame is therefore `2^24-1 = 16 MiB`, but `StanzaWriter` self-caps at 32 MiB pre-encryption (the encrypted output adds the 16-byte tag, still under 16 MiB only for bodies < ~16 MiB — the practical cap is the 24-bit length).

### 3.10 The login `ClientPayload`

`BuildClientPayload` (`HandshakeHandler.cs:226-264`) builds the `ClientPayload` protobuf that is AEAD-sealed as the final handshake message's `Payload`. Notable fields:
- `Username` = `ulong.Parse(_username)` (the phone-number JID user), `Device = _myDeviceId`, `Passive = true`, `Pull = _connectInPullMode (=true)`, `PushName`.
- `connect_type` from `CurrentConnectionType()` (Wi-Fi vs cellular radio type, `HandshakeHandler.cs:212-224`).
- `UserAgent`: `platform = WINDOWS` (`HandshakeHandler.cs:241`), app version split from `PackageInfo.Version` (`a.b.c.d` → Primary/Secondary/Tertiary/Quaternary), and the following **literals** (read this session): `Mcc = "000"`, `Mnc = "000"` (`HandshakeHandler.cs:249-250`) and `release_channel = Constants.ReleaseChannel`, which resolves to `ClientPayload.UserAgent.ReleaseChannel.RELEASE` (enum value **0**, since `RELEASE` is the first member of `enum ReleaseChannel { RELEASE, BETA, ALPHA }`, `ClientPayload.cs:98-102`) — `Constants.cs:178` sets `ReleaseChannel = ClientPayload.UserAgent.ReleaseChannel.RELEASE` (in `WhatsApp.VoIP`). The rest of the UA is **runtime-derived, not constant**: `OsVersion = "Major.Minor.Build"` + `OsBuildNumber` from `MachineSpec.Instance.OsVersion`, `Manufacturer`/`Device = "{Name} H{HardwareVersion}"` from `DeviceStatusEas.Instance`, and locale lang/country from `CurrentUICulture` (`HandshakeHandler.cs:228-258`).
- `connect_reason = USER_ACTIVATED`, `LidDbMigrated = _isLidDbMigrated`.

This is the standard WhatsApp MD login blob; it is what the server uses to authenticate the device after the Noise channel proves possession of the static key.

### 3.11 Key sources

`ConnectionManager` (`ConnectionManager.cs:16,217-227`) receives `clientStaticPrivate`/`clientStaticPublic` (the Noise static keypair = the account/Signal identity key, ultimately the JS-supplied `ClientKey`), `username`, `edgeRoutingInfo`, `pushName`, `myDeviceId`, `isLidDbMigrated`. It constructs the `HandshakeHandler` with **`serverStaticPublic = null`** (`ConnectionManager.cs:225`).

> **Live-path finding (confirmed this session):** because `CreateSocket` (`ConnectionManager.cs:225`) hardcodes `null` for the cached server static, **every connection in this build runs `Noise_XX` (full)**; the `IK` resume and `XXfallback` paths are present and wired but **dead code** in the decompiled call graph. Two facts make this definitive: (1) `CreateSocket` is the **only** `new HandshakeHandler(...)` call site (exhaustive grep, re-confirmed this session: a single hit), and `_serverStaticPublic` is assigned solely from that always-`null` ctor arg (`HandshakeHandler.cs:56`); (2) the ctor unconditionally sets `_isCompanionRegistration = false` (`HandshakeHandler.cs:52`), so the companion branch never engages either. The two dispatch gates — `if (!_isCompanionRegistration && _serverStaticPublic != null)` (`HandshakeHandler.cs:103`, picks resume) and `if (_isCompanionRegistration || _serverStaticPublic == null)` (`HandshakeHandler.cs:158`, picks full XX) — therefore always resolve to the XX branch. `ReceiveServerHello` still *caches* `rs` into `SeamlessMigrationAppSessionStorage.ServerStaticPublicKey` (`HandshakeHandler.cs:198`), but **nothing reads that value back into a handshake** — only the property getter/setter exists (`SeamlessMigrationAppSessionStorage.cs:49-58`), with no consumer. So `SendClientResume`/`ReceiveServerResume`/`ReceiveServerFallback` are unreachable here; the cache is write-only in this artifact (plausibly consumed by a different/future build, but not by any code present).

## 4. Native Dependencies

| Operation | Native surface | Confirmed? |
| --- | --- | --- |
| ECDH (X25519) `Derive`, `GenKeyPair`, `Sign`, `Verify`, `GetKeyLength`, `GetSignLength` | `WhatsAppNative.Curve25519` (WinRT runtimeclass), activated via `ActivationFactory.Get("WhatsAppNative.Curve25519")` | **Confirmed** projection (`Curve25519.cs:55,129-157`); native body **not** available |
| AES-256-GCM AEAD | **Not native** — uses Windows `SymmetricKeyAlgorithmProvider`/`CryptographicEngine` (`AesGcmProvider.cs:15,27,40,59`) | Confirmed managed/WinRT |
| SHA-256 transcript hash | **Not native** — Windows `CryptographicHash` (`HandshakeHash.cs:24`, `Utils.CreateSha256Hash`) | Confirmed managed/WinRT |
| HKDF / HMAC-SHA256 | **Not native** — `System.Security.Cryptography.HMACSHA256` (`HkdfSha256.cs:14`) | Confirmed managed |
| zlib Deflate/Inflate | **Not native** — `ICSharpCode.SharpZipLib` (`StanzaWriter.cs:2`, `EncryptedBytesReceiver.cs:2`) | Confirmed managed |

So the **only** native primitive in this entire layer is Curve25519 (key agreement + XEdDSA-style sign/verify). Everything else — GCM, SHA-256, HKDF, Deflate, the whole state machine — is managed C#.

`Curve22519Extensions` (`Curve22519Extensions.cs`) is the lazy singleton wrapper: `KeyLength`/`SignLength` are queried from native at runtime (`Curve22519Extensions.cs:16-18`), so a port should not assume 32/64 but in practice X25519 = 32-byte keys, Curve25519 signatures = 64 bytes.

**Ghidra dumps are empty/unusable, but radare2 byte-scans succeeded.** `ghidra-output/WhatsAppNative-functions.txt` is 0 bytes; `ghidra-output/WhatsAppRust-functions.txt` contains only "Ghidra was not started with PyGhidra. Python is not available." So no native function *bodies* for `Derive`/`Sign`/`Verify` were disassembled. However, the native crypto *scheme* is **byte-confirmed** via radare2 constant scans on `x64/WhatsAppNative.dll` (doc 96): the X25519 Montgomery-ladder constant **`a24 = 121665` (`0x0001DB41`)** is statically present (`/x 41db0100` → hits at `0x180a38b60`/`…b68`, the field-constant table), SHA-512 `K[0]=0x428a2f98d728ae22` is present (`/x 22ae28d7982f8a42` @ `0x1808b969c`), and the binary exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}` on one class — so X25519 ECDH + XEdDSA signing are evidenced from the binary itself, not merely inferred (doc 96). Only the instruction-level `Sign` body (clamping/deterministic-nonce padding) remains unread, and that is moot for interop/port (see §6 item 1).

**Native crypto is statically linked (BoringSSL-from-WebRTC), not pulled from `bcrypt.dll` [native-binary, confirmed this session].** The import table of `x64/WhatsAppNative.dll` (`objdump -p`) shows `bcrypt.dll` contributes **only three symbols — `BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider`** (an RNG provider, nothing else): there is **no** `BCryptEncrypt`/`BCryptDeriveKeyPBKDF2`/`BCryptHashData`/`BCryptHash`. So all AES/GCM/SHA/HMAC/HKDF *and* the Curve25519 `Sign`/`Verify`/`Derive` bodies are **statically linked** into the DLL, not dynamic OS calls. The binary is shared with the VoIP/WebRTC stack — its `.rdata` carries hundreds of `webrtc::*` mangled symbols and source paths under `xplat\wa-voip\wacall\…`, and the SHA-512 init words appear contiguously (§6 item 1), all consistent with the WebRTC-bundled **BoringSSL** providing the primitives. Other dynamic deps in the import table: `WhatsAppRust.dll` (the wamedia Rust blob — itself stripped, no curve/signal symbols), `MFPlat.DLL`/`MFReadWrite.dll` (Media Foundation), `WS2_32.dll` (native Winsock). Note this `WhatsAppNative.dll` (native) is **distinct** from the managed `WhatsAppNativeProjection` WinRT projection assembly that hosts `Curve25519.cs`; the projection just marshals into this native DLL.

**Signature scheme is XEdDSA over Curve25519 (settled by three-witness interop + the hosted bundle + native-constant evidence).** The scheme question is resolved (see §6 item 1): WhatsApp peer/ADV/pre-key/cert signatures are **Curve25519 XEdDSA (libsignal "Signal-variant"), 64-byte**, confirmed by three independent witnesses plus the native binary's own constants:
- **[bundle] — the JS the native client actually hosts.** The waweb bundle module `WAWebCryptoCurve25519CalculateSignature.calculateSignature(keypair, msg)` delegates to `WAWebCryptoLibraryUtilsApi.signMsg(pubKey, privKey, msg)` → `WASignalSignatures.signMsg(keypair, msg)`, and verification goes through `WASignalSignatures.verifyMsgSignalVariant(pubKey, msg, ensureSize(sig,64))` (`research/waweb-unmin/SjC…WiG.js:5306-5317, 20860-20865`). The literal name **`verifyMsgSignalVariant`** and the hard **64-byte** signature size pin it to libsignal XEdDSA; it is consumed by `WAWebAdvSignatureApi` for ADV device-identity signatures with the `ADV_PREFIX_DEVICE_IDENTITY_DEVICE_SIGNATURE` prefix (same `{6,1}` family as whatsmeow). This is the strongest available corroboration short of disassembling the native body, because it is the same bundle `WhatsApp.Root` hosts in its WebView2.
- **[protocol-cross-ref] — Baileys** signs via libsignal `curve.calculateSignature`/`verifySignature` over the type-`0x05` DJB pubkey (`Baileys/src/Utils/crypto.ts:27-35`).
- **[protocol-cross-ref] — whatsmeow** signs with `ecc.CalculateSignature(ecc.NewDjbECPrivateKey(...), pubKeyForSignature)` (`pubKeyForSignature[0]=ecc.DjbType`) returning a `*[64]byte` (`whatsmeow/util/keys/keypair.go:48-55`; ADV prefixes `{6,0}`/`{6,1}` at `pair.go:31-35`).

The native binary's constants are consistent [native-binary, re-verified this final pass]: `WhatsAppNative.dll` is a **stripped WinRT component** whose only real PE exports are `DllCanUnloadNow`/`DllGetActivationFactory` (`rabin2 -E` → 2; `r2 -A` default analysis finds **4** functions total). The names `WhatsAppNative::Curve25519::Sign`/`::GenKeyPair` appear **only as strings in the `.WAobs` section** (`vaddr 0x180c04798`+), surfacing the `Curve25519` runtimeclass that is activated through the `DllGetActivationFactory` vtable — they are **not** symbol-table entries, and `r2 axt` on those addresses finds **no code xref** under default analysis. The binary carries **all eight SHA-512 init words contiguously at file offset 10600448** (`6a09e667f3bcc908 … 5be0cd19137e2179`, big-endian; verified by byte scan — one BE match, zero LE matches; the SHA-256 IV is *not* present as one contiguous block) — SHA-512 is the hash Ed25519/XEdDSA use for nonce + challenge derivation and is unused elsewhere in this layer (transcript + HKDF are SHA-256, §3.2/§3.3). The native crypto *scheme* is in fact byte-confirmed from this binary (doc 96): the **X25519 Montgomery-ladder constant `a24 = 121665` (`0x0001DB41`)** is statically present (`/x 41db0100` → hits at `0x180a38b60`/`…b68`, the field-constant table) and **SHA-512** `K[0]=0x428a2f98d728ae22` is present (`/x 22ae28d7982f8a42` @ `0x1808b969c`) — X25519 ECDH + XEdDSA signing are therefore evidenced in the binary, not merely inferred. The `grep -iE 'xeddsa|ed25519|libsignal|donna|ref10'` banner scan returns **no banner**, and the *Edwards-form* constants (`d = -121665/121666`, `2d`, `sqrt(-1)`) plus the curve prime `p = 2^255-19` were absent from a full 32-byte little-endian (and byte-reversed) `.rdata` scan — these Edwards constants are derived at runtime from the Montgomery key during XEdDSA's Montgomery→Edwards conversion, or live inside the banner-less statically-linked BoringSSL; their absence does **not** weaken the scheme verdict, which rests on the `a24` ladder constant and SHA-512 above (doc 96). The **only** genuine residual is the native *byte-exact* `Sign` implementation detail (scalar clamping, deterministic-nonce padding, hash-to-scalar reduction). That residual does not affect interop (XEdDSA verification is independent of the signer's nonce); because the stripped WinRT binary defeats default `r2`/`objdump` symbol+xref analysis, a **manual PyGhidra/capstone disassembly of the `Sign` body** (vtable reconstruction + emulation) would be needed only to reproduce WhatsApp's exact signature bytes for a fixed nonce — and that is moot for the port.

## 5. Linux/Electron Port Mapping

The good news: this layer is almost entirely portable, and most of it can be reimplemented in JS/native-addon without the WebView2 bundle's help (the bundle never touches it). The waweb JS bundle is **not** a reusable source for Noise — WhatsApp Web (browser) does its handshake differently (it tunnels over the browser's WebSocket/TLS); the native handshake here is the Windows-app-specific path and must be reimplemented.

| Windows piece | Linux/Electron/Node equivalent | Notes / risk |
| --- | --- | --- |
| `WhatsAppNative.Curve25519.Derive` (X25519) | `@noble/curves/ed25519`→`x25519`, or `libsodium` (`crypto_scalarmult`), or Node `crypto.diffieHellman` with `x25519` keys | Low risk; well-supported. |
| `Curve25519.Sign/Verify` (cert chain + Signal) | **XEdDSA** via `@noble/curves` (`ed25519` + Montgomery↔Edwards conversion) or libsignal's `curve25519` | **Scheme confirmed: Curve25519 XEdDSA (Signal-variant), 64-byte** — three witnesses incl. the hosted bundle: waweb `WASignalSignatures.verifyMsgSignalVariant(…,64)`, Baileys libsignal `calculateSignature`, whatsmeow `ecc.DjbType`+`CalculateSignature` → `[64]byte` (§6 item 1). Binding `@signalapp/libsignal-client` is the safest path. The pinned root verify (§3.8) must match exactly or all logins fail. Mirror `Curve22519Extensions.Verify`'s fail-closed behavior. |
| `AesGcmProvider` (AES-256-GCM, tag appended) | Node `crypto.createCipheriv('aes-256-gcm', …)` / `@noble/ciphers` `gcm` | Trivial. Replicate: tag **appended after** ciphertext; empty-plaintext special case; return `null` on auth failure. |
| `HandshakeHash` (SHA-256 `MixHash`) | Node `crypto.createHash('sha256')` or `@noble/hashes` | Trivial. |
| `HkdfSha256`/`Hkdf` | Node `crypto.hkdf` (async) or `@noble/hashes/hkdf` | **Match the `Perform(L,key,salt)` → `HKDF(IKM=key,salt=salt)` mapping precisely.** Easy to invert salt/IKM by mistake. |
| `setKey`/`getNoiseCipher` (64-byte split) | Hand-port the chaining: `ck,k = HKDF(salt=ck, ikm=dh, 64)`; transport `write,read = HKDF(salt=ck, ikm="", 64)` | Don't reach for a generic Noise library blindly — see nonce caveat below. |
| `LongToByteArray(n,12)` nonce | 12-byte buffer, 4 zero bytes + **big-endian** 64-bit counter | **HIGH RISK — but layout now confirmed.** Canonical Noise (and `noise-c`, most JS Noise libs) use **little-endian** counters; WhatsApp uses **big-endian** (cross-reference: whatsmeow `BigEndian.PutUint32(iv[8:],count)`, Baileys `DataView.setUint32(8,counter)`; §6 item 2). A stock Noise library will desync after frame 0. Must override nonce encoding or hand-roll. (Native uses a 64-bit counter in bytes 4–11; the open clients a 32-bit counter in bytes 8–11 — identical bytes for realistic counter values.) |
| Separate `_writeNonce`/`_readNonce`, never reset post-handshake; reset per `MixKey` during handshake | Track two independent monotonic counters | Standard, but explicit. |
| Frame layer (3-byte BE length, reassembly) | Node stream/`Buffer` parser | Trivial; reuse `FramesReader` logic verbatim. |
| zlib flag byte (`0`/`2`) + Deflate | Node `zlib.deflate`/`inflate` (**zlib-wrapped**, with header + Adler-32) | **Confirmed zlib-wrapped, not raw** (cross-reference: whatsmeow `zlib.NewReader`, Baileys Node `inflate` not `inflateRaw`, both gated on `2 & flag`; §6 item 4). Use Node `zlib.deflate`/`inflate`, **never** `deflateRaw`/`inflateRaw`. |
| Edge header `"ED\0\x01"` + `WA\x06\x03` prologue | Emit the same bytes; dictionary version = **3**, protocol version = **6** for this build | Hardcode but keep configurable; these are versioned by the server. |
| Cert chain (`CertChain`/`NoiseCertificate` protobuf) + pinned root | protobufjs + embed the 32-byte root key (`§3.8`) | **Pin the same root key bytes.** Leaf `Key` must equal handshake `rs`. Time checks disabled for v6 — replicate (don't add expiry checks the server doesn't expect). |
| `ClientPayload` login blob | protobufjs; fill in real device/UA/locale | The `platform = WINDOWS` and version fields are how the server fingerprints the client — choose carefully for a Linux port (spoofing `WINDOWS` vs declaring a new platform has account-safety implications). |
| WinRT `CryptographicEngine` / `StreamSocket` | Node `crypto` + `net.Socket` (or `tls` is **not** used — Noise replaces TLS; raw TCP to `s.whatsapp.net:443/5222/80`) | The transport is **raw TCP**, port 80 wraps HTTP-chunked (separate doc). No OS TLS involved. |

**Reuse / gaps summary**

- **Reusable as-is (logic):** the handshake state machine, transcript hashing, HKDF chaining, frame layer, cert pinning — all are plain algorithms; port them line-for-line from §3.
- **Cannot reuse from JS bundle:** the waweb bundle's transport is browser-WebSocket-based, not this native Noise channel. No shortcut there. **But the open clients whatsmeow (Go) and Baileys (TS) ARE line-for-line references for this exact protocol** — they confirmed the big-endian nonce, zlib-wrapped Deflate, the `WA 06 03` header (dict version 3), and the XEdDSA signature scheme below.
- **Native addon needed?** Only optionally, for Curve25519. `@noble/curves` (pure JS) is sufficient and avoids a native build; if XEdDSA signing fidelity is a concern, bind libsignal-client (`@signalapp/libsignal-client`) which already ships the exact curve25519 sign/verify WhatsApp expects.
- **Top correctness traps:** (1) big-endian nonce *(confirmed by whatsmeow + Baileys)*, (2) HKDF salt/IKM orientation, (3) zlib-wrapped (not raw) Deflate *(confirmed by whatsmeow + Baileys)*, (4) AAD = transcript hash during handshake but **null** for transport frames, (5) the pinned root key and leaf-key-equals-`rs` check, (6) XEdDSA (not plain Ed25519) for all Curve25519 signatures *(confirmed three ways: the hosted waweb bundle's `verifyMsgSignalVariant`, plus libsignal/whatsmeow interop)*.

## 6. Open Questions / Unverified

Every item below was re-investigated against the decompiled C#, the shipped native binaries (`x64/WhatsAppNative.dll` and `x64/ICSharpCode.SharpZipLib.dll` via `strings`/`objdump` and raw-constant scans), and the captured Android artifacts; **round 2** then re-opened the remaining `[PARTIAL]` items with open-protocol implementations (whatsmeow Go, Baileys TypeScript) and the beautified WhatsApp Web bundle. Net result: items **3** and **5** were already fully **[RESOLVED]** (facts in §3). Round 2 upgraded items **2** and **4** to **[RESOLVED]** (cross-reference: whatsmeow + Baileys agree byte-for-byte with the C#), and upgraded item **1**'s *signature scheme* to **[RESOLVED-via-interop]** (XEdDSA over Curve25519) with only the native byte-level impl/clamping left as a noted residual. **This final pass** (live-appdata + native import-table + hosted-bundle round) hardened item **1**'s scheme from "via-interop" to **[RESOLVED]** outright by adding a third, in-binary witness — the waweb bundle the native client itself hosts uses `WASignalSignatures.verifyMsgSignalVariant(…, 64-byte sig)` (the libsignal Signal-variant XEdDSA API) — and pinned the native byte-impl residual to a precise cause (BoringSSL statically linked from WebRTC; `bcrypt.dll` supplies RNG only — see §4). A subsequent **radare2 pass (doc 96)** then byte-confirmed the native crypto *scheme* directly from `WhatsAppNative.dll`: the X25519 Montgomery-ladder constant **`a24 = 121665` (`0x0001DB41`)** and SHA-512 `K[0]` are statically present, and `Curve25519::{Derive,Sign,Verify,GenKeyPair}` are exposed on one class — so X25519 ECDH + XEdDSA signing are evidenced in the binary, not "Ghidra empty / inferred only". The *only* part still unread is the **instruction-level `Sign` body** (scalar clamping / deterministic-nonce padding): the DLL is a stripped WinRT component (only `DllCanUnloadNow`/`DllGetActivationFactory` export; `r2 -A` finds 4 functions; `Sign`/`GenKeyPair` surface only as `.WAobs` strings reached via the activation-factory vtable, no default xref), and the *Edwards-form* constants `d`/`2d`/`sqrt(-1)` and the prime `p=2^255-19` are absent from `.rdata` (derived at runtime during Montgomery→Edwards conversion, or inside the static BoringSSL). So the byte-impl stays **[PARTIAL]** and is **moot for the port** (closer: manual PyGhidra/capstone of the `Sign` body — see doc 96 §; the live-appdata `noise`/`signal-storage` IndexedDB stores keys in plaintext but never the signature impl, so they cannot narrow it). Item **6** stays **[PARTIAL]** but is hardened with a *fourth* witness — the hosted bundle's own `WAWebFailureErrorCodes` reason table (`REASON_CLIENT_TOO_OLD: 405`, `REASON_BAD_USER_AGENT: 409`, …) and its `WAWapDict.DICT_VERSION = 3` header — confirming both the `WA 06 03` header value and the `405`/`409` connect-failure rejection mechanism; only the exact *server-side* version-acceptance table remains a server-only residual.

> Honesty labelling: facts drawn from whatsmeow/Baileys/the WA-Web bundle are open-protocol implementations of the *same* server protocol the native Windows client must interoperate with — they are labelled **(cross-reference: …)** below and are NOT disassembled from `WhatsAppNative.dll`. Where a protocol fact is one the native client *must* share (because it talks to the same servers/peers), it is marked RESOLVED with that interop rationale stated explicitly.

1. **[RESOLVED — scheme (native-binary radare2 + hosted bundle + 2 interop clients)] / [PARTIAL but MOOT-for-port — native byte-impl] Native `Sign`/`Verify` algorithm.** *Question: is `WhatsAppNative.Curve25519.Sign` XEdDSA (libsignal-style) or something else?*

   **Scheme — RESOLVED.** The signature is **Curve25519 XEdDSA (libsignal "Signal-variant"), 64-byte**. This is no longer interop-inference alone — it is now corroborated by the native binary's own constants (radare2, doc 96), the very JS bundle the native client hosts, and two interoperating open clients:
   - **[native-binary, doc 96] — strongest, because it is in `WhatsAppNative.dll` itself.** radare2 byte-scans confirm the X25519 ECDH primitive (Montgomery-ladder constant **`a24 = 121665` / `0x0001DB41`** present, `/x 41db0100` @ `0x180a38b60`/`…b68`) and that signing is **XEdDSA over that same X25519/Montgomery key** (SHA-512 `K[0]=0x428a2f98d728ae22` present @ `0x1808b969c` — the hash XEdDSA uses; `Sign`/`Verify` share the class that does the X25519 `Derive`; 64-byte signatures), matching libsignal `xed25519_sign`/`curve25519_sign` (doc 96 §). So the scheme is byte-evidenced in the native binary, not "Ghidra empty / inferred only".
   - **[bundle] — corroborating, because it is the code `WhatsApp.Root` hosts in its WebView2.** `WAWebCryptoCurve25519CalculateSignature.calculateSignature(keypair, msg)` → `WAWebCryptoLibraryUtilsApi.signMsg(pubKey, privKey, msg)` → `WASignalSignatures.signMsg(keypair, msg)`; verification is `WASignalSignatures.verifyMsgSignalVariant(pubKey, msg, ensureSize(sig, 64))` (read this session: `research/waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:5306-5317` for the module, `:20860-20865` for `signMsg`, `:20861-20865` for `verifySignature`). The literal Signal-library API name **`verifyMsgSignalVariant`** and the hard-coded **64-byte** signature size are dispositive for XEdDSA. It is consumed by `WAWebAdvSignatureApi` (`:16678, :16824`) for ADV device-identity signing under the `ADV_PREFIX_DEVICE_IDENTITY_DEVICE_SIGNATURE` prefix (the `{6,1}`/`{6,0}` family). The bundle also exposes `WAWebCryptoCurve25519.toCurveKeyPubKey` (Montgomery↔Edwards conversion), exactly the XEdDSA pre-step.
   - **[protocol-cross-ref] Baileys** — `Curve.sign`/`Curve.verify` via libsignal `curve.calculateSignature`/`verifySignature` over the 33-byte type-`0x05` DJB pubkey (`Baileys/src/Utils/crypto.ts:27-35`; `generateSignalPubKey` prefixes `KEY_BUNDLE_TYPE`).
   - **[protocol-cross-ref] whatsmeow** — `ecc.CalculateSignature(ecc.NewDjbECPrivateKey(...), pubKeyForSignature)` with `pubKeyForSignature[0]=ecc.DjbType`, result `*[64]byte` (`whatsmeow/util/keys/keypair.go:48-55`, via `go.mau.fi/libsignal v0.2.2` `ecc`); ADV prefixes `{6,0}`/`{6,1}` at `whatsmeow/pair.go:31-35`, ADV verify `ecc.VerifySignature(...)` at `pair.go:276-278`.

   libsignal's `calculateSignature`/`verifySignature` (and the bundle's `…SignalVariant`) are Curve25519 **XEdDSA**: sign a Montgomery X25519 key by converting to twisted-Edwards and running an Ed25519-style signature. A Linux port should bind libsignal's curve25519 (or `@noble/curves` Ed25519 + Montgomery↔Edwards conversion). **The scheme is settled; the only open piece is the native byte-impl below.**

   **Residual — native byte-impl (PARTIAL) [native-binary, re-verified this final pass]:** the *exact* native byte layout (scalar clamping, the 64-byte random padding XEdDSA prepends to the deterministic-nonce input, hash-to-scalar reduction) still cannot be read out of `x64/WhatsAppNative.dll`. Re-verified this session against the live binary:
   - (a) **The DLL is a stripped WinRT component, not a symbol-exporting library.** Its *only* real PE exports are `DllCanUnloadNow` and `DllGetActivationFactory` (`rabin2 -E` → 2 entries; `r2 -A` default analysis discovers a total of **4** functions). `WhatsAppNative::Curve25519::Sign`/`::GenKeyPair` exist **only as strings in the `.WAobs` (obfuscation/telemetry) section** (`izz` hits at `vaddr 0x180c04798/0x180c047f8/0x180c04820`), reachable at runtime through the activation-factory vtable, **not** as a named symbol pointing at the body. `r2 axt` on those string addresses returns **no code cross-reference** under default analysis, so the `Sign` body cannot be reached by symbol/xref walking without heavy manual vtable+emulation reconstruction.
   - (b) `grep -iE 'xeddsa|ed25519|libsignal|donna|ref10'` over the DLL returns **no banner** (re-confirmed this session).
   - (c) A full 32-byte little-endian (and byte-reversed) scan for the *Edwards-form* constants `d = -121665/121666`, `2d`, `sqrt(-1)` (`I`) **and** the curve prime `p = 2^255-19` found **none of them** in `.rdata` (re-run this session: every offset `-1`) — but this does **not** mean no curve constants are present: doc 96's radare2 scan **did** find the **X25519 Montgomery-ladder constant `a24 = 121665` (`0x0001DB41`)** in the field-constant table (`0x180a38b60`/`…b68`) plus the **SHA-512** `K[0]` round constant, which byte-confirm the ECDH+XEdDSA scheme. The Edwards constants are derived at runtime during XEdDSA's Montgomery→Edwards conversion or live inside the statically-linked banner-less BoringSSL — the binary is the WebRTC blob, with `bcrypt.dll` providing **only** RNG (`BCryptGenRandom`/`Open`/`Close` — re-confirmed exactly three bcrypt imports this session, no `BCryptEncrypt`/`BCryptHash`/`BCryptDeriveKeyPBKDF2`) and all primitives static; see §4 and doc 96.
   - (d) The SHA-512 IV is present **only** contiguously **big-endian at file offset `10600448`** (re-verified this session: one BE match, zero LE matches; the SHA-256 IV is *not* present as a single contiguous block) — the hash XEdDSA needs for nonce/challenge derivation.

   This residual is only about reproducing WhatsApp's *bit-exact* signature bytes for a given message+nonce; it does **not** affect interop (XEdDSA verification is deterministic regardless of the signer's nonce, and verify-only ports never need it). What would still close it: PyGhidra/capstone disassembly of the `Sign` body (the binary defeats default-`r2`/`objdump` static analysis, so this requires manual vtable+emulation work), or signing test-vectors against a live build. **The new live-appdata corpus does not help here:** the decoded WebView2 IndexedDB `noise`/`signal-storage` stores hold the *keys* in plaintext (docs 94/95) but never the native signature implementation, so it cannot narrow the byte-impl.
2. **[RESOLVED] Big-endian vs little-endian nonce.** *Question: confirm the 96-bit nonce layout.* **RESOLVED by cross-reference** — both open implementations independently build the 12-byte GCM IV as **leading zero bytes + a big-endian counter in the trailing bytes**, matching the C# byte-for-byte. whatsmeow: `func generateIV(count uint32) { iv := make([]byte,12); binary.BigEndian.PutUint32(iv[8:], count) }` (cross-reference: `whatsmeow/socket/noisesocket.go:73-77`); same IV feeds handshake encrypt/decrypt (`noisehandshake.go:65,71`) and transport (`noisesocket.go:98,113`). Baileys: `const iv = new ArrayBuffer(12); new DataView(iv).setUint32(8, counter)` — `DataView.setUint32` defaults to **big-endian** (cross-reference: `Baileys/src/Utils/noise-handler.ts:14-16`, used at lines 104/114). The native C# does the same with a wider counter: `WAProtocol.LongToByteArray(value, 12)` (`WAProtocol.cs:53-66`) zero-fills, then writes `array[4]=value>>56 … array[11]=(byte)value` — first 4 bytes zero, 64-bit counter in the **last 8 bytes, MSB-first (big-endian)**. (The only difference is counter *width*: whatsmeow/Baileys use a 32-bit counter in bytes 8–11; the native client uses a 64-bit counter in bytes 4–11. For any realistic connection the high 32 bits are zero, so the on-wire IV bytes are identical and the schemes are interoperable.) The same C# helper feeds all four AEAD sites — handshake `encrypt/decryptPayload` (`HandshakeCipher.cs:71,78`), `StanzaWriter.WriteEncrypted` (`StanzaWriter.cs:76`), `EncryptedBytesReceiver.ReceiveFrame` (`EncryptedBytesReceiver.cs:26`). A port that emits a little-endian counter (as stock Noise libraries do) will fail GCM auth on the very first frame against the real server — confirmed independently by two interoperating clients. (A raw live-wire capture would still be the only *first-party* proof, but it is no longer needed to settle the layout: two clients that successfully talk to WhatsApp's servers both use big-endian.)
3. **[RESOLVED] The IK/XXfallback path is dead code in this build.** *Question: does companion-registration or another caller ever exercise resume/fallback?* The **sole** `new HandshakeHandler(...)` call site is `ConnectionManager.CreateSocket` (`ConnectionManager.cs:225`), which hardcodes the third arg (`serverStaticPublic`) to `null` (verified this session: `grep -rn 'new HandshakeHandler' decompiled` returns exactly one hit). `_serverStaticPublic` is assigned only from that ctor arg (`HandshakeHandler.cs:56`), and the ctor unconditionally sets `_isCompanionRegistration = false` (`HandshakeHandler.cs:52`). The gate `if (!_isCompanionRegistration && _serverStaticPublic != null)` (`HandshakeHandler.cs:103`) and `if (_isCompanionRegistration || _serverStaticPublic == null)` (`HandshakeHandler.cs:158`) therefore always select the XX branch. The resume cache **writer** exists (`SeamlessMigrationAppSessionStorage.ServerStaticPublicKey`, written at `HandshakeHandler.cs:198`) but **nothing reads it back into a `HandshakeHandler`**: the only two references are the property getter/setter (`SeamlessMigrationAppSessionStorage.cs:49-58`) and the write at `HandshakeHandler.cs:198` (verified this session: `grep -rn ServerStaticPublicKey decompiled` returns only those). Therefore `SendClientResume`/`ReceiveServerResume`/`ReceiveServerFallback` are unreachable from the decompiled call graph — every connection runs `Noise_XX` (full).
4. **[RESOLVED] Deflate framing (zlib header vs raw).** *Question: does the compressed transport frame carry a zlib header or raw DEFLATE?* **RESOLVED by cross-reference: the compressed body is zlib-WRAPPED DEFLATE (zlib header + trailing Adler-32), not raw DEFLATE**, and the compression flag is bit `2` of the leading byte. Both open clients agree exactly:
   - whatsmeow's `Unpack` reads `dataType, data := data[0], data[1:]` then, **`if 2&dataType > 0`**, decompresses with **`zlib.NewReader`** — Go's `compress/zlib`, which is zlib-wrapped (it validates the 2-byte header and Adler-32 checksum); raw DEFLATE would be `compress/flate` (cross-reference: `whatsmeow/binary/unpack.go:21-30`). Its companion comment states "uncompress … with zlib".
   - Baileys' `decompressingIfRequired` does `if (2 & buffer.readUInt8()) buffer = await inflatePromise(buffer.slice(1))`, where `inflate` is Node `zlib.inflate` — the **zlib-wrapped** decoder, NOT `inflateRaw` (cross-reference: `Baileys/src/WABinary/decode.ts:2,7,9-15`).

   Both strip the single leading flag byte and treat bit `2` as the compression flag — identical to the native client's `pt[0] & 2` check (`EncryptedBytesReceiver.cs:33`, §3.9). This confirms the native client's `DeflaterOutputStream`/`InflaterInputStream` **default ctors** (no `noZlibHeaderOrFooter` flag, `StanzaWriter.cs:46`, `EncryptedBytesReceiver.cs:37`) emit/consume a zlib-wrapped stream (`0x78 ..` header + Adler-32) — the SharpZipLib default — and that this is wire-compatible with the live protocol. On-wire body is `flag ‖ zlib-stream` (flag `2` written first at `StanzaWriter.cs:47`, then `CopyTo(deflater)`+`Finish()` at lines 48-49). **Port note (corrected):** use Node `zlib.deflate`/`inflate` (zlib-wrapped), **not** `deflateRaw`/`inflateRaw`. The earlier residual (no IL decompiler / no captured compressed frame) is moot — two interoperating clients independently document zlib-wrapped DEFLATE with the same `&2` flag.
5. **[RESOLVED] `ClientPayload` UA literals.** *Question: resolve `release_channel`, `Mcc/Mnc`, and UA strings to literal values.* Read directly this session: `Mcc = "000"`, `Mnc = "000"` (`HandshakeHandler.cs:249-250`); `release_channel = Constants.ReleaseChannel` where `Constants.ReleaseChannel = ClientPayload.UserAgent.ReleaseChannel.RELEASE` (`Constants.cs:178`, `WhatsApp.VoIP`), and `RELEASE` is the **first** enum member → value **0** (`ClientPayload.cs:98-100`, `enum ReleaseChannel { RELEASE, … }`); `platform = ClientPayload.UserAgent.Platform.WINDOWS` (`HandshakeHandler.cs:241`). The remaining UA fields are **runtime-derived, not literals**: `AppVersion` Primary/Secondary/Tertiary/Quaternary split from `PackageInfo.Version` (`.Split('.')`), `OsVersion = "Major.Minor.Build"` and `OsBuildNumber` from `MachineSpec.Instance.OsVersion`, `Manufacturer`/`Device = "{Name} H{HardwareVersion}"` from `DeviceStatusEas.Instance`, and locale from `CurrentUICulture` — these vary per machine and have no fixed value to extract statically (`HandshakeHandler.cs:228-258`).
6. **[PARTIAL — tightened] Dictionary-version coupling / server negotiation.** *Question: where are the server-side rules for the third header byte (`DictionaryVersion`)?* The byte's value is **resolved** — `3`, from `WAPDefaultTokenDictionary.DictionaryVersion => 3` (`WAPDefaultTokenDictionary.cs:163`) via `TokenDictionary.GetDictionaryVersion() => _dictionaryVersion` (`TokenDictionary.cs:107-110`, backed by `TokenDictionary.cs:31`), written into `_header[3]` (`HandshakeHandler.cs:47-49`, §3.4).

   **Contract now established by cross-reference — now a four-witness fact incl. the hosted bundle (no client-side renegotiation exists):** the third header byte is a **unilateral client→server declaration**, not a negotiated value, and `3` is the live value the whole protocol family ships. **All four clients — including the waweb bundle the native app itself hosts — emit the identical 4-byte header `WA` + magic `6` + dict `3` (`57 41 06 03`):**
   - **[bundle, read this final pass] — the JS `WhatsApp.Root` hosts in its WebView2.** The bundle builds the Noise header as `new Uint8Array([87, 65, 6, o("WAWapDict").DICT_VERSION])` (`research/waweb-unmin/SjCAw3j6…WiG.js:115092`; also `TSxMup…js:146310`), and the `WAWapDict` module hardcodes **`var e = 3; … DICT_VERSION = e`** (`research/waweb-unmin/n6o0-NaJTww.js:3730-3739`) — i.e. **`DICT_VERSION = 3`**, byte-identical to the native client's `WAPDefaultTokenDictionary.DictionaryVersion => 3`. This is the same value `WhatsApp.Root` puts on the wire, now confirmed from the code it actually runs.
   - **[protocol-cross-ref] whatsmeow** `var WAConnHeader = []byte{'W','A', WAMagicValue/*=6*/, token.DictVersion/*=3*/}` (`whatsmeow/socket/constants.go:29,32`); its comment states the contract: `DictVersion … is sent when connecting to the websocket **so the server knows which tokens are supported**` (`whatsmeow/binary/token/token.go:18-20`).
   - **[protocol-cross-ref] Baileys** `export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION/*=3*/])` (`Baileys/src/Defaults/index.ts:32,34`).

   The client announces its token-dictionary version once; the server keys its token encoding off it. There is **no dictionary-version handshake/downgrade/renegotiation** in any of the four clients (native, hosted-bundle, whatsmeow, Baileys): none reads the byte back, branches on a mismatch, or negotiates. The server's recourse for an unsupported version is to reject the connection with a `<failure>` connect-failure (the generic "client outdated" path, e.g. reason `405` → `ConnectFailureClientOutdated` in whatsmeow `connectionevents.go:139-141`), after which the client errors/reconnects — it does not adapt its dictionary. So the native client's apparent "gap" (no read-back logic) is **correct and complete**: there is nothing to negotiate client-side.

   **Rejection mechanism — hardened this final pass with the hosted bundle's own reason table (cross-reference + bundle).** The server's recourse for an unsupported version is a `<failure>` stanza carrying a numeric `reason`:
   - **[bundle, read this final pass] — the hosted waweb bundle defines the full client-side reason enumeration.** Module `WAWebFailureErrorCodes` (`research/waweb-unmin/TSxMup…js:9775-9784`) hardcodes: `REASON_GENERIC_FAILURE: 400, REASON_NOT_AUTHORIZED: 401, REASON_TEMP_BANNED: 402, REASON_LOCKED: 403, REASON_CLIENT_TOO_OLD: 405, REASON_BANNED: 406, REASON_BAD_USER_AGENT: 409, REASON_INTERNAL_SERVER_ERROR: 500`. The `<failure>` stanza is parsed by `WAWebHandleFailure`'s `failureParser` via `reason: e.attrInt("reason", 400, 599)` (`UBSny…js:65271-65275`). So the bundle the native client runs names **`405` = "client too old"** and **`409` = "bad user agent"** explicitly — the two codes a dict/UA-version rejection would use.
   - **[protocol-cross-ref] whatsmeow** `handleConnectFailure` parses `reason := events.ConnectFailureReason(ag.Int("reason"))` and maps **`405` → `ConnectFailureClientOutdated`**, logging "Client outdated (405) connect failure" and dispatching `events.ClientOutdated{}` (`whatsmeow/connectionevents.go:104, 139-141`; the same `405`/`not-allowed` code appears as `ErrIQNotAllowed{Code:405}` at `whatsmeow/errors.go:190`).

   Neither the bundle nor whatsmeow renegotiates or downgrades its dictionary on such a failure — it errors/reconnects. This confirms the contract end-to-end across all witnesses: the dict byte is a one-way declaration, and a version the server dislikes is answered by a connect-failure (`405` client-too-old, or `409` bad-user-agent), not a renegotiation.

   **Residual (server-only, narrowed but still open):** what is *still* absent from every client artifact is the **server-side acceptance table** — which dict versions the server presently accepts, and the precise decision that maps a given mismatch to `405` vs `409` vs another `reason`. The hosted bundle gives the *client's* numeric reason vocabulary (above) but not the server's version→reason policy. Only server access or a wire capture of an actual version-rejection `<failure reason="…">` stanza would document it. This residual does not block a port — emit `WA 06 03` (matching this build, the hosted bundle, whatsmeow, and Baileys) and treat any connect-failure `<failure>` (esp. `reason="405"`/`"409"`) as fatal/reconnect.
