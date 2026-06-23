# Signal Protocol & End-to-End Encryption

> Target: Meta native WhatsApp for Windows (WhatsApp.Root.exe, WinUI 3 hybrid). All paths in §2–§4 are **relative to `decompiled_source/`** unless noted. Line cites are `path:LINE` and were read directly.

---

## 1. Purpose & Scope

This document covers the **Signal (Axolotl) end-to-end-encryption layer**: long-term identity keys, one-time / signed pre-keys (X3DH-style session setup), the double-ratchet session record, group "sender keys", pre-key upload/registration stanzas, and the curve/KDF primitives those mechanisms use.

**The single most important architectural finding (confirmed, not inferred):**

> In this native Windows client the Signal protocol is **NOT implemented in native C#**. The C# layer contains only **dead protobuf marshalling structs** for the persisted Signal state, a **generated-but-uncalled** Smax builder for the pre-key-upload IQ, and the **Curve25519 + HKDF primitives**. The live X3DH / double-ratchet / sender-key / message-encryption logic runs in the **WhatsApp Web JS bundle** inside WebView2 (`waweb-source-bundle/`), which talks to the native `Curve25519` WinRT object only indirectly. The native shell's *direct* cryptographic responsibilities here are limited to **(a)** companion-pairing signature verification (`AdvBridge.Verify`), **(b)** the Noise transport handshake (separate doc), **(c)** Noise certificate verification, and **(d)** VoIP SRTP key derivation.

Evidence for that claim is given throughout §3 and summarized in §3.7. The Noise *transport* handshake and the FunXMPP stanza wire format are documented separately (networking-core / smax-nodes docs); this doc only references them where Signal touches them.

---

## 2. Where It Lives

### 2.1 Persisted Signal state (protobuf structs — `WhatsApp.Protobuf`)
Namespace `WhatsApp.ProtoBuf`, dir `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/`:

| File | Type | Role |
|---|---|---|
| `IdentityKeyPairStructure.cs` | long-term identity keypair | `{PublicKey, PrivateKey}` |
| `PreKeyRecordStructure.cs` | one-time pre-key | `{Id, PublicKey, PrivateKey}` |
| `SignedPreKeyRecordStructure.cs` | signed pre-key | `{Id, PublicKey, PrivateKey, Signature, Timestamp}` |
| `RecordStructure.cs` | session record wrapper | `{CurrentSession, PreviousSessions[]}` |
| `SessionStructure.cs` | double-ratchet session | root/chain/message keys, pending X3DH state |
| `SenderKeyRecordStructure.cs` | group sender-key record | `{SenderKeyStates[]}` |
| `SenderKeyStateStructure.cs` | group sender-key state | sender chain key, signing key, cached msg keys |
| `KeyId.cs` | bare key id wrapper | `{Id}` |

These are **SilentOrbit**-generated protobuf parsers (`using SilentOrbit.ProtocolBuffers;`).

### 2.2 Pre-key registration stanza (Smax — `WhatsApp.Networking`)
- `decompiled/WhatsApp.Networking/WhatsApp.Smax.Generated.PreKeys.Outgoing/` — the `<iq xmlns="encrypt">` pre-key-upload builder (`SetRequest*.cs`, see §3.4).
- `decompiled/WhatsApp.Networking/WhatsApp.Smax.Generated.PreKeys.Incoming/` — the IQ-result / error parsers for that upload (`SetResponse*.cs`, `IQError*.cs`).

### 2.3 Crypto primitives
- `decompiled/WhatsApp.VoIP/WhatsApp/Curve22519Extensions.cs` — managed wrapper over native curve.
- `decompiled/WhatsAppNativeProjection/WhatsAppNative/Curve25519.cs` + `__ICurve25519PublicNonVirtuals.cs` + `ABI.WhatsAppNative/__ICurve25519PublicNonVirtualsMethods.cs` — the CsWinRT projection of the native `WhatsAppNative.Curve25519` runtimeclass.
- `decompiled/WhatsApp.VoIP/WhatsApp/Hkdf.cs` + `HkdfSha256.cs` — RFC-5869 HKDF-SHA256.
- `decompiled/WhatsApp.VoIP/WhatsApp.VoIP.VoIP.Temp/Axolotl.cs` — VoIP call-key derivation + CSPRNG.

### 2.4 Bridges to the JS Signal layer
- `decompiled/WhatsApp.Root/WhatsApp.Bridge/AdvBridgeAdapter.cs` — `AdvBridge.Verify` (curve signature verify for companion pairing).
- `decompiled/WhatsApp.Root/WhatsApp.Bridge/ClientKeyController.cs` — `ClientKeyBridge` (master account key in/out).
- `decompiled/WhatsApp.Root/WhatsApp.Bridge/ServerEncKeySaltController.cs` — `ServerEncKeySaltBridge`.

### 2.5 The actual Signal implementation (JS, not native)
- `waweb-source-bundle/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js` and `TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js` — minified bundles containing `SignedPreKey`, `SenderKeyDistributionMessage`, `chainKey`, `rootKey`, `WhisperText/WhisperGroup/WhisperMessage`, `pkmsg`/`msg`/`skmsg`, `deviceIdentity`, `hkdf` (see §3.7).

---

## 3. How It Works

### 3.1 Identity, pre-key, and signed-pre-key records (X3DH key material)

All three are flat protobuf messages. Field tags are recovered from the `WriteByte(tag)` calls in each `Serialize`.

**IdentityKeyPairStructure** — `IdentityKeyPairStructure.cs:8,10`
```
field 1 (tag 10, bytes) PublicKey      // Curve25519 public, 33 bytes on the wire (0x05 || X) in Signal
field 2 (tag 18, bytes) PrivateKey     // Curve25519 private, 32 bytes
```
Cites: tags at `IdentityKeyPairStructure.cs:141` (10) and `:146` (18).

**PreKeyRecordStructure** (one-time pre-key) — `PreKeyRecordStructure.cs:8,10,12`
```
field 1 (tag 8,  varint) Id            // uint
field 2 (tag 18, bytes)  PublicKey
field 3 (tag 26, bytes)  PrivateKey
```
Cites: `PreKeyRecordStructure.cs:152,157,162`.

**SignedPreKeyRecordStructure** — `SignedPreKeyRecordStructure.cs:8,10,12,14,16`
```
field 1 (tag 8,  varint)        Id
field 2 (tag 18, bytes)         PublicKey
field 3 (tag 26, bytes)         PrivateKey
field 4 (tag 34, bytes)         Signature      // XEdDSA sig over PublicKey, by the identity key
field 5 (tag 41, fixed64 LE)    Timestamp      // rotation time; read via BinaryReader.ReadUInt64, SignedPreKeyRecordStructure.cs:75
```
Cites: serialize tags `:178,183,188,193,198`. Note tag 41 = field 5, wire-type 1 (fixed64) → `binaryWriter.Write(ulong)` at `:199`. **`Signature` confirms the signed pre-key is curve-signed by the identity key** and is later verified with `Curve25519.Verify` (§3.5).

> **On-wire key encoding (verified in JS, both directions traced).** The `PublicKey` fields above are stored/serialized here as the **raw 32-byte** Curve25519 X-coordinate; the Signal **0x05 (DJB) type prefix** is added on serialize / stripped on parse by the JS libsignal layer, not by C#. In `SjCAw3…js` the **add-prefix** helper `h(e)` requires a 32-byte input and emits a 33-byte buffer — `function h(e){if(e.byteLength!==32) throw "Invalid key type"; var t=new Uint8Array(33); return t[0]=_, t.set(new Uint8Array(e),1), t.buffer}` — where `_` is the DJB key-type constant (5). The matching **strip-prefix** (decode) helper requires exactly 33 bytes and copies the tail into a fresh 32-byte array — `if(e.byteLength!==33) throw "Invalid key type"; var t=new Uint8Array(32); return t.set(new Uint8Array(e).subarray(1)), …` — i.e. it drops byte[0] (the 0x05). The keypair normalizer `g(e)` requires a 32-byte `pubKey` and runs it through `h()` to obtain the tagged form. The native curve is always fed the de-prefixed 32-byte key. This is why every C# `ValidateBinary(32,32)` in §3.4 sees 32 bytes while `<type>=0x05` carries the prefix separately, and it directly answers §6 Q2: **the JS adds 0x05 before `<identity>`/`<value>` serialization and strips it on parse.**

### 3.2 The session record (double ratchet) — `RecordStructure` + `SessionStructure`

**RecordStructure** — `RecordStructure.cs:9,11`
```
field 1 (tag 10) CurrentSession   : SessionStructure (length-delimited)
field 2 (tag 18) PreviousSessions : repeated SessionStructure   // archived for late/out-of-order msgs
```
Cite: `RecordStructure.cs:175` (tag 10), `:186` (tag 18). The "previous sessions" list is the standard Signal mechanism for decrypting messages that arrive after a session has been re-keyed.

**SessionStructure outer fields** — `SessionStructure.cs:1018-1042`, serialize tags `SessionStructure.cs:1342-1428`:
```
1  (tag 8,  varint) SessionVersion
2  (tag 18, bytes)  LocalIdentityPublic
3  (tag 26, bytes)  RemoteIdentityPublic
4  (tag 34, bytes)  RootKey                 // 32-byte double-ratchet root key
5  (tag 40, varint) PreviousCounter
6  (tag 50, msg)    SenderChain   : Chain
7  (tag 58, msg)    ReceiverChains: repeated Chain
8  (tag 66, msg)    PendingKeyExchange : PendingKeyExchange
9  (tag 74, msg)    PendingPreKey      : PendingPreKey
10 (tag 80, varint) RemoteRegistrationId
11 (tag 88, varint) LocalRegistrationId
12 (tag 96, bool)   NeedsRefresh
13 (tag 106,bytes)  AliceBaseKey            // X3DH base key (identifies the initiating handshake)
```
This is byte-for-byte the upstream libsignal `SessionStructure` schema. `RootKey` (field 4) is the ratchet root; `SenderChain`/`ReceiverChains` are the symmetric-ratchet chains; `AliceBaseKey` (field 13) ties the session to a specific X3DH run.

**`SessionStructure.Chain`** (one symmetric ratchet chain) — fields `SessionStructure.cs:365,367,369,371`, serialize tags `:551-577`:
```
field 1 (tag 10) SenderRatchetKey         (bytes, DH ratchet public)
field 2 (tag 18) SenderRatchetKeyPrivate  (bytes)
field 3 (tag 26) ChainKeyField : Chain.ChainKey
field 4 (tag 34) MessageKeys   : repeated Chain.MessageKey   // cached skipped-message keys
```

**`Chain.ChainKey`** — `SessionStructure.cs:13,15`, tags `:146`(8)/`:151`(18):
```
field 1 (tag 8)  Index   (varint)   // chain-key iteration counter
field 2 (tag 18) Key     (bytes)    // 32-byte chain key, ratcheted by HMAC
```

**`Chain.MessageKey`** (one derived per-message key) — `SessionStructure.cs:174,176,178,180`, tags `:329,334,339,344`:
```
field 1 (tag 8)  Index     (varint)
field 2 (tag 18) CipherKey (bytes)   // AES key for this message
field 3 (tag 26) MacKey    (bytes)   // HMAC key for this message
field 4 (tag 34) Iv        (bytes)   // AES-CBC IV  (Signal uses AES-CBC + HMAC-SHA256, not GCM, for message bodies)
```
The presence of separate `CipherKey`/`MacKey`/`Iv` (rather than a single AEAD key) confirms WhatsApp message bodies use the classic Signal **AES-256-CBC + HMAC-SHA256 (encrypt-then-MAC)** construction, distinct from the AES-GCM used on the Noise transport frames.

> **Confirmed in the JS bundle, down to the cipher invocation (no longer inferred).** `SjCAw3…js` carries the matching message-key protobuf spec **`{index:[1,UINT32], cipherKey:[2,BYTES], macKey:[3,BYTES], iv:[4,BYTES]}`** — byte-for-byte the C# `Chain.MessageKey` triple above. The per-message keys are derived by the standard Signal KDF, with the **literal call read from the bundle**: `…hkdf(new Uint8Array(e),null,"WhisperMessageKeys",80).then(function(e){return o("WASignalSessions").splitMsgKey(t,e)})` — i.e. HKDF-SHA256 of the message key, salt `null`, info `"WhisperMessageKeys"`, **80 output bytes**, then `splitMsgKey` slices them. `splitMsgKey` is the minified alias `C`→`b` in `TSx…js`; its split is confirmed by the `subarray(32,64)` boundary present in that module, consistent with **32 (AES-256 cipher key) ‖ 32 (HMAC-SHA256 MAC key) ‖ 16 (AES-CBC IV)**. The cipher invocation itself is read directly: `var a={name:"AES-CBC",iv:<iv>}; …getCrypto…importKey("raw",n,"AES-CBC",!1,[t])` (the IV binder is a minified local — `iv:r` at the encrypt site, `iv:t` at the decrypt site), and the MAC uses `{name:"HMAC", hash:"SHA-256"}`; the ciphertext object is the `{ivCiphertext, macKey, signature}` encrypt-then-MAC shape. So WhatsApp message bodies are **AES-256-CBC + HMAC-SHA256, info-string `"WhisperMessageKeys"`**, via WebCrypto `crypto.subtle` — exactly upstream libsignal. (See §6 Q4.)

**`SessionStructure.PendingKeyExchange`** — `SessionStructure.cs:602-614`, tags `:790-821`:
```
1 (8)  Sequence
2 (18) LocalBaseKey            3 (26) LocalBaseKeyPrivate
4 (34) LocalRatchetKey         5 (42) LocalRatchetKeyPrivate
7 (58) LocalIdentityKey        8 (66) LocalIdentityKeyPrivate
```
(Fields 6/9 are absent in this build's serializer.)

**`SessionStructure.PendingPreKey`** — `SessionStructure.cs:843,845,847`, tags `:987`(8)/`:992`(24)/`:997`(18):
```
field 1 (tag 8,  varint) PreKeyId
field 3 (tag 24, varint) SignedPreKeyId   // note: field 3 read as UInt64 then cast to int, SessionStructure.cs:993
field 2 (tag 18, bytes)  BaseKey
```
`PendingPreKey` is the un-acked X3DH state Alice keeps until Bob's first reply: it records *which* of Bob's one-time pre-key (`PreKeyId`) and signed pre-key (`SignedPreKeyId`) she consumed, plus her ephemeral `BaseKey`. This is exactly the data echoed in a Signal `PreKeyWhisperMessage` (`pkmsg`). The field-3-before-field-2 layout and the `int? SignedPreKeyId` (`SessionStructure.cs:845`, serialized as `WriteUInt64` at tag 24 — `:992-993`, read as `(int)ReadUInt64` — `:962`) vs `uint? PreKeyId` (tag 8 — `:843,959,987`) width asymmetry are **byte-for-byte upstream libsignal** (`pre_key_id=1`, `signed_pre_key_id=3`, `base_key=2`), faithfully reproduced from the binary — not a decompiler artifact (see §6 Q3).

### 3.3 Group encryption: Sender Keys — `SenderKeyRecordStructure` + `SenderKeyStateStructure`

WhatsApp encrypts group fan-out with the Signal **Sender Keys** scheme (one symmetric ratchet per sender per group, plus a per-sender signing key so recipients authenticate without pairwise sessions).

**SenderKeyRecordStructure** — `SenderKeyRecordStructure.cs:9`, tag `:145`(10):
```
field 1 (tag 10) SenderKeyStates : repeated SenderKeyStateStructure   // current + historical
```

**SenderKeyStateStructure** — fields `SenderKeyStateStructure.cs:492,494,496,498`, serialize tags `:701`(8)/`:706`(18)/`:715`(26)/`:726`(34):
```
field 1 (tag 8)  SenderKeyId          (varint)
field 2 (tag 18) SenderChainKeyField  : SenderChainKey
field 3 (tag 26) SenderSigningKeyField: SenderSigningKey
field 4 (tag 34) SenderMessageKeys    : repeated SenderMessageKey   // cached out-of-order keys
```

**`SenderChainKey`** — `SenderKeyStateStructure.cs:11,13`, tags `:144`(8)/`:149`(18):
```
field 1 (tag 8)  Iteration (varint)   field 2 (tag 18) Seed (bytes)   // ratchets via HMAC to derive per-message keys
```
**`SenderMessageKey`** — `SenderKeyStateStructure.cs:172,174`:
```
field 1 (tag 8)  Iteration (varint)   field 2 (tag 18) Seed (bytes)
```
**`SenderSigningKey`** — `SenderKeyStateStructure.cs:333,335`, tags `:466`(10)/`:471`(18):
```
field 1 (tag 10) Public  (bytes)      field 2 (tag 18) Private (bytes)   // Curve25519, signs each ciphertext (skmsg)
```
The `SenderSigningKey` keypair is what makes group messages authenticable: the sender signs each `skmsg` with `Private`, recipients verify with `Public` (distributed once via a `SenderKeyDistributionMessage`).

> **JS side confirmed (more than a string match).** `SjCAw3…js` carries the matching sender-key protobuf specs — `senderChainKey {iteration:[1,UINT32], seed:[2,BYTES]}` and `senderMessageKey {iteration:[1,UINT32], seed:[2,BYTES]}` (identical to §3.3) and the sender-key-state spec with `senderMessageKeys:[4, REPEATED|MESSAGE]`. The group cipher entrypoints are named: `WASignalGroupCipher.createSenderKeyDistributionProto`, `createSenderKeyDistributionMsg`, `WAWebCryptoLibrary.processSenderKeyDistributionMsg` / `decryptGroupSignalProto`, with `saveSenderKeySession`; the distribution payload is carried as proto field `senderKeyDistributionMessage` (`[2, TYPES.MESSAGE]` inside its container). A runtime guard `decryptEnc: Can not do skmsg for non group` proves `skmsg` is the group ciphertext `enc` type.
>
> **`<enc type>` dispatch resolved as a named string enum (not an integer table).** `TSx…js` defines `CiphertextType` as `$InternalEnum({Skmsg:"skmsg", Pkmsg:"pkmsg", Msg:"msg", Msmsg:"msmsg"})`, and the decrypt path in `SjCAw3…js` dispatches on it directly — `…c===CiphertextType.Pkmsg||c===CiphertextType.Msg? …(pairwise)… : (group/skmsg)…`. So the `<enc type=…>` attribute is one of the **string** values `pkmsg` (PreKeyWhisperMessage), `msg` (WhisperMessage), `skmsg` (group SenderKey message), or `msmsg`; there is no integer→name table to recover — the doc's earlier "integer mapping" assumption was wrong.
>
> **SKDM proto body recovered (was previously "still minified").** The 4-field `SenderKeyDistributionMessage` body is read directly in `TSxMupG…js`: **`{id:[1,UINT32], iteration:[2,UINT32], chainKey:[3,BYTES], signingKey:[4,BYTES]}`** — `id` (varint), `iteration` (varint), `chainKey` (bytes = the current `SenderChainKey.Seed`), `signingKey` (bytes = the `SenderSigningKey.Public`), matching upstream libsignal. It is carried inside its container as proto field `senderKeyDistributionMessage`, and the runtime guard `decryptEnc: Can not do skmsg for non group` (`SjCAw3…js`) confirms `skmsg` is the group ciphertext `enc` type. Only any *server-side numeric* re-encoding of the type (if one exists) is still unread (see §6 Q6).

### 3.4 Pre-key upload / registration stanza (`<iq xmlns="encrypt">`)

`WhatsApp.Smax.Generated.PreKeys.Outgoing/SetRequest.cs` builds the classic WhatsApp **"set keys"** registration IQ. From `SetRequest.cs:13-24`:

```
<iq type="set" id={idAttr} xmlns="encrypt" to="s.whatsapp.net">   (SetRequest.cs:13-17)
  <registration> 4 bytes  </registration>      // SetRequestRegistration.cs:14 ValidateBinary(4,4) — the 32-bit registration id
  <identity>     32 bytes </identity>           // SetRequestIdentity.cs:14   ValidateBinary(32,32) — Ed/Curve identity public
  <list> <key><id>3B</id><value>32B</value></key> ... </list>   // one-time pre-keys
  <skey>                                         // the signed pre-key
     <id>        3 bytes  </id>                  // SetRequestSkeyId
     <value>     32 bytes </value>               // SetRequestSkeyValue.cs:14   ValidateBinary(32,32)
     <signature> 64 bytes </signature>           // SetRequestSkeySignature.cs:14 ValidateBinary(64,64)
  </skey>
  <type>  0x05  </type>                          // SetRequestType.cs:14  single byte {5}
  {VerifiedNameMixin?}                            // optional, merged
</iq>
```

Per-element size validations (all via `SmaxStandardLibrary.ValidateBinary(min,max)`):
- `<registration>` = **4 bytes** — `SetRequestRegistration.cs:14`
- `<identity>` = **32 bytes** — `SetRequestIdentity.cs:14`
- one-time `<key><id>` = **3 bytes** (big-endian key id) — `SetRequestListKeyId.cs:14`
- one-time `<key><value>` = **32 bytes** — `SetRequestListKeyValue.cs:14`
- `<skey><value>` = **32 bytes** — `SetRequestSkeyValue.cs:14`
- `<skey><signature>` = **64 bytes** — `SetRequestSkeySignature.cs:14`
- `<type>` = constant byte `0x05` — `SetRequestType.cs:14` (the Signal `KEY_TYPE` / curve type marker)

`<list>` is assembled from repeated `<key>` children (`SetRequestList.cs`, `SetRequestListKey.cs:13`). The IQ goes to `s.whatsapp.net` typed as a `DomainJid` (`SetRequest.cs:17`).

**Crucial caveat (verified):** a repository-wide grep found **no caller** of `Smax.Generated.PreKeys.Outgoing` outside the generated directory itself:
```
grep -rln 'Smax.Generated.PreKeys' decompiled | grep -v '/WhatsApp.Smax.Generated.PreKeys'  →  (empty)
```
So in this client the pre-key upload IQ is **built and sent by the JS bundle**, not by this C# class. The generated C# builder is compiled-in but dead — it documents the exact wire schema the JS produces, which is why it is authoritative for the port even though it is not on the live path.

**The IQ-result / error ack schema (now line-read from `…PreKeys.Incoming/`).** `SetHandler.HandleResponse` (`SetHandler.cs:11-52`) demultiplexes the server reply into exactly four shapes, tried in order:
- **`SetResponseSuccess`** — `<iq type="result">` echoing the request `id` and `from=s.whatsapp.net`, carrying the `IQResultResponseMixin` (`type` pinned to `"result"`, `id`/`from` cross-checked against the request — `IQResultResponseMixin.cs:30-43`). No payload children: a bare ack. (`SetResponseSuccess.cs:21-35`)
- **`SetResponsePreKeySuccessVnameFailure`** — `<iq type="error">` with a required `<error>` child, used when the keys were accepted but the verified-name update failed. (`SetResponsePreKeySuccessVnameFailure.cs:24-42`)
- **`SetResponseRequestError`** — `<iq type="error">` whose `<error>` is a `SetIQError1MixinGroup`: either `not-acceptable` (`code=406`, optional `<field name reason>` child — `IQErrorNotAcceptableMixin.cs:30-42`, `IQErrorNotAcceptableMixinField.cs:27-35`) or a generic 4xx client fallback (`text` len 1–40, `code` 400–499 — `IQErrorFallbackClientMixin.cs:27-35`). (`SetResponseRequestError.cs:24-42`)
- **`SetResponseServerError`** — `<iq type="error">` whose `<error>` is a `SetIQError2MixinGroup`, e.g. `service-unavailable` (`code=503` — `IQErrorServiceUnavailableMixin.cs:27-35`) or a 5xx server fallback. (`SetResponseServerError.cs:24-42`)

Every error variant reuses `IQErrorResponseMixin` (`type` pinned to `"error"`, `id`/`from` cross-checked — `IQErrorResponseMixin.cs:30-43`). So the key-upload ack is field-precise: success is a payload-less `result` IQ; failures are `error` IQs whose numeric `code` (406/4xx/503/5xx) and `text` classify the rejection.

> **Verified line-read (closes §6 Q5).** `SetHandler.HandleResponse` (`SetHandler.cs:11-52`) tries the four `Create` parsers in the exact order listed and returns the first match. The success ack `IQResultResponseMixin` requires `type="result"` and **cross-references** the response `id` against the request `id` (`isReference:true`) and the response `from` against the request `to` (a `DomainJid`) — `IQResultResponseMixin.cs:30-44`; `SetResponseSuccess` itself adds **no payload children** (`SetResponseSuccess.cs:27-35`). The `not-acceptable` error pins `text="not-acceptable"`, `code=406`, with an optional `<field>` child — `IQErrorNotAcceptableMixin.cs:30-42`. These are now read field-by-field, not just enumerated.

### 3.5 Curve25519 / XEdDSA primitive (native, via WinRT)

`Curve22519Extensions` (`WhatsApp.VoIP/WhatsApp/Curve22519Extensions.cs`) is a lazy singleton over the native `WhatsAppNative.Curve25519` runtimeclass:
- `Instance` lazily activates `NativeInterfaces.CreateInstance<Curve25519>()` — `Curve22519Extensions.cs:14`.
- `GenKeyPair(out pub, out priv)` — allocates `GetKeyLength()`-sized buffers and calls native `GenKeyPair` — `:20-25`.
- `Derive(pub, priv)` → X25519 ECDH shared secret — `:27-30` (this is the DH used in X3DH and in the root-key ratchet).
- `Sign(message, signKey)` → curve (XEdDSA) signature — `:32-35`.
- `Verify(message, signature, signKey)` → bool; **all exceptions swallowed** and logged via `FailuresService.Investigate`, returning `false` — `:37-48`.

Underlying interface (`WhatsAppNativeProjection/WhatsAppNative/__ICurve25519PublicNonVirtuals.cs:12-22`):
```
void   GenKeyPair(byte[] pubOut, byte[] privOut)
byte[] Derive(byte[] PubKey, byte[] PrivKey)
byte[] Sign  (byte[] Message, byte[] SignKey)
bool   Verify(byte[] Message, byte[] Signature, byte[] SignKey)
int    GetKeyLength()   // queried at runtime (Curve22519Extensions.cs:16); Signal Curve25519 = 32
int    GetSignLength()  // queried at runtime (:18);                          XEdDSA sig      = 64
```
Native interface IID = **`68D7A737-E718-3D02-BB33-3A3F54594239`** (`__ICurve25519PublicNonVirtuals.cs:8`); the runtimeclass is activated by string `"WhatsAppNative.Curve25519"` (`Curve25519.cs:55`). The 32/64 sizes are not hard-coded in C#; they match the `ValidateBinary(32,32)`/`(64,64)` checks on `<identity>`, `<skey><value>`, `<skey><signature>` in §3.4, which is consistent evidence that the native curve is standard Signal Curve25519 + 64-byte XEdDSA.

> **Native provenance, from binary inspection of `x64/WhatsAppNative.dll` (advances §6 Q1).** The DLL exposes the WinRT class symbols `WhatsAppNative::Curve25519::GenKeyPair` / `::Sign` and the WinRT factory `__Curve25519ActivationFactory@WhatsAppNative` (decorated names via `strings -n 6 | grep -i curve25519`), confirming the class is implemented natively in this binary (and `objdump -T` shows **0 C-exported functions** — the class is reached only through the WinRT activation factory, not a flat export, so the `Sign` body is internal). **Randomness backing is the only crypto WhatsAppNative imports dynamically, and it is RNG-only [native-binary, re-read this pass]:** the PE import table (`objdump -p`) lists *exactly three* `bcrypt.dll` entries — `BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider` — and **no** `BCryptEncrypt` / `BCryptDecrypt` / `BCryptHashData` / `BCryptDeriveKeyPBKDF2` / `BCryptCreateHash`, and **no** `ncrypt.dll` / `crypt32.dll` / `advapi32` crypto import at all. (Round-1's "Windows CNG `bcrypt.dll`" backing was therefore an **overstatement** — bcrypt provides RNG only.) The consequence: the AES/HMAC/SHA-256/KDF *and the Curve25519/XEdDSA field arithmetic* are **statically linked** into `WhatsAppNative.dll`, not provided by CNG — most plausibly BoringSSL-from-WebRTC, given the binary's WebRTC/Media-Foundation dependency set (`MFPlat.DLL`, `MFReadWrite.dll`, `d3d11`/`d2d1`/`dxgi`, `WS2_32`) and the sibling `WhatsAppRust.dll` (wamedia) which itself imports only `ProcessPrng` from `bcryptprimitives.dll` (again RNG-only). The **signature algorithm is XEdDSA-over-Curve25519** — now **native-confirmed from the binary itself** via radare2 (doc 96 §1): the X25519 Montgomery-ladder constant `a24=121665` (`0x0001DB41`) and the XEdDSA hash **SHA-512** (`K[0]=0x428a2f98d728ae22`) are statically present, and the `Curve25519` class exposes `Derive`/`Sign`/`Verify`/`GenKeyPair` — so the scheme is **byte-evidenced, not merely by-interop**. This is also corroborated by the wire-compatible JS bundle (`WASignalSignatures.signMsg` / `verifyMsgSignalVariant`, 64-byte `WASignalOther.ensureSize`, and the `WACryptoEd25519` Ed25519 point ops + Curve25519 clamping `e[0]&=248,e[31]&=127,e[31]|=64`; see §6 Q1) which the native client must interoperate with, and **independently by two open WA-protocol clients** (cross-reference, not native-binary read): whatsmeow `util/keys/keypair.go:48-55` signs the 0x05-prefixed 33-byte pubkey via `ecc.CalculateSignature` (`go.mau.fi/libsignal v0.2.2`) returning a `*[64]byte`, with identical clamping `priv[0]&=248; priv[31]&=127; priv[31]|=64` (`:35-37`); and Baileys `Utils/crypto.ts:26-35` calls `libsignal/src/curve` `calculateSignature`/`verifySignature` on the `KEY_BUNDLE_TYPE`(0x05)-prefixed key. What remains **unread** is only the *instruction-level `Sign` body* (clamping/nonce-construction details) and the upstream source lineage (donna vs ref10 vs fe25519) — `strings` finds no library markers and `objdump -t` exports no curve-internal symbols because the crypto is statically linked. That residual is **moot for the port** (the renderer-hosted JS bundle does all signing; the native `Sign` is never invoked by an Electron port — doc 96 §5, docs 94/95). The X25519+XEdDSA **scheme** itself is no longer inferred: it is native-confirmed by the `a24`/SHA-512 constants and the class method set (doc 96 §1).

**Where the native curve is *actually* called from C# (only 3 sites, grep-confirmed):**
1. `AdvBridgeAdapter.Verify` — companion-pairing signature verification (§3.6).
2. `WhatsApp/HandshakeHandler.cs` — Noise transport handshake (separate doc).
3. `WhatsApp/WACertificateVerificationUtils.cs` — Noise server-certificate verification.

It is **never** called from C# to drive X3DH or per-message Signal encryption — that lives in JS (§3.7).

### 3.6 Companion-device pairing signature (`AdvBridge.Verify`)

`AdvBridgeAdapter` (`WhatsApp.Bridge/AdvBridgeAdapter.cs`) is the host object `WinRTAdapter.IAdvBridgeToNative`. Its only method, `Verify(messageBase64, signatureBase64, signKeyBase64)`:
- hops to a serial `ConcurrentQueueDispatcher` (`:14,23`),
- base64-decodes the three args (`:26-28`),
- returns `Curve22519Extensions.Instance.Verify(message, signature, signKey)` (`:29`), swallowing exceptions → `false` (`:31-35`).

So during multi-device (ADV) pairing the JS bundle does all the account-signature-key generation, QR/ref handling, and `deviceIdentity` construction, and calls back into native **only** to verify a curve signature. This mirrors the inventory note: native's sole ADV responsibility is curve verification.

### 3.7 Why the Signal engine is in JS, not native (evidence)

1. **Zero external references to every Signal struct.** Grep over all of `decompiled/`, excluding the protobuf dir itself:
   ```
   SessionStructure -> 0   IdentityKeyPairStructure -> 0   PreKeyRecordStructure -> 0
   SignedPreKeyRecordStructure -> 0   SenderKeyStateStructure -> 0
   SenderKeyRecordStructure -> 0   RecordStructure -> 0      (external files)
   ```
   No C# code constructs, persists, or reads these. They are pure dead marshalling library code in the native shell.
2. **Pre-key upload builder has no native caller** (§3.4).
3. **The JS bundle contains the Signal vocabulary.** In `SjCAw3...js`: `pkmsg` (×5), `"msg"` (×4), `skmsg` (×1), `deviceIdentity` (×12), `signedPreKey` (×9), `senderKeyDistributionMessage` (×6), `key-index-list`, `enc type`; plus `chainKey`, `rootKey`, `hkdf`, and `WhisperText`/`WhisperGroup`/`WhisperMessage`. These are the Signal wire-message types (`pkmsg`=PreKeyWhisperMessage, `msg`=WhisperMessage, `skmsg`=SenderKey message) and ratchet internals — present in JS, absent (as live code) in C#.
4. **The only native crypto on the E2E path** is the `Curve25519` WinRT object (consumed indirectly: JS computes X3DH/ratchet itself; native curve is reached from C# only for ADV verify, Noise, and cert verify) and HKDF (used by VoIP, §3.8). Message-body AES-CBC+HMAC happens in JS (the `CipherKey`/`MacKey`/`Iv` triple in §3.2 is the JS ratchet's output schema).
5. **The live on-disk state proves the JS layer owns the Signal store [live-appdata, docs 94/95].** A decoded dump of the running client's WebView2 IndexedDB (`LocalCache/EBWebView/Default/IndexedDB/https_web.whatsapp.com_*.leveldb`, plaintext Chromium LevelDB) contains a dedicated **`signal-storage`** database whose object stores are exactly the libsignal set this doc reverse-engineered from the dead C# structs: `identity-store` (↔ `IdentityKeyPairStructure`, §3.1), `prekey-store` (↔ `PreKeyRecordStructure`), `signed-prekey-store` (↔ `SignedPreKeyRecordStructure`), `session-store` (↔ `RecordStructure`/`SessionStructure`, §3.2), `senderkey-store` (↔ `SenderKeyRecordStructure`, §3.3), plus `signal-meta-store` (registration id, next-prekey ids) and `baseKey-store`. Group sender-key state and the Noise static keypair (= the `ClientKey`, §3.9) also persist here. The native at-rest DBs use a **custom AES+HMAC page codec — not stock SQLCipher** (4096-byte pages + 16-byte per-DB salt + raw 32-byte key, no `cipher_version`/`kdf_iter`/`PRAGMA key` markers; docs 94/96) and are only a machine-bound *cache/mirror* of this plaintext store. This is direct on-disk confirmation — not inference — that the C# Signal structs are dead marshalling code and the live engine + state are JS-side.

### 3.8 HKDF and the one Signal-adjacent native KDF use (VoIP)

`Hkdf` (`WhatsApp.VoIP/WhatsApp/Hkdf.cs`) is a hand-rolled RFC-5869:
- `Extract(ikm, salt)`: `salt ??= zeros[hashLen]`; `PRK = HMAC(salt, ikm)` — `Hkdf.cs:15-22`.
- `Expand(prk, info, len)`: `T(0)=∅`; `T(n)=HMAC(PRK, T(n-1) || info || n)` with single-byte counter starting at **1**, until `len` bytes — `Hkdf.cs:24-44`.
- `HkdfSha256.Perform(keyLen, key, salt, info)` wires `HMACSHA256`, `hashLen=32` — `HkdfSha256.cs:7-16`.

This KDF is **not** used for Signal message keys in C# (those are derived in JS). Its only first-party use here is VoIP SRTP/P2P key derivation, `Axolotl.CallKeysFromCipherKeyV2` (`Axolotl.cs:10-17`): `HKDF-SHA256(cipherKey, salt=null→zeros, info=UTF8(jid)) → 46 bytes`, split `[0..30)`=SRTP block, `[30..46)`=16-byte P2P key. Random nonces come from `CryptographicBuffer.GenerateRandom` (`Axolotl.cs:25`), re-exported as `EncryptionUtils.SecureRandomBytes` (`WhatsApp.Encryption/EncryptionUtils.cs:18-20`). `VoipCallbacks` also exposes the raw HKDF to native via `ComputeHkdfSha256` (`VoipCallbacks.cs:332-337`) and a secure-SSRC derivation `HKDF(callId, salt=ssrcTag, info=identifier)[0..4]` (`VoipCallbacks.cs:253-258`). These are documented here only to show the native KDF exists and is reusable, but they belong to the VoIP doc, not the Signal message path.

### 3.9 Account-key bridges (what the JS Signal layer persists natively)

The JS Signal layer hands its **account master key** and **server-enc-key salt** down for at-rest persistence:
- `ClientKeyController` (`WhatsApp.Bridge/ClientKeyController.cs`): `SetClientKey(base64)` → `Convert.FromBase64String` → `LoginSessionManager.Login(key)` (`:21-25`); `GetClientKey()` returns base64 of the stored key (`:48-56`); `ClearClientKey()` logs out and **restarts the app** (`:32-46`). This `ClientKey` is the secret from which the per-session SQLite DB secret is derived (storage doc).
- `ServerEncKeySaltController` (`WhatsApp.Bridge/ServerEncKeySaltController.cs`): symmetric `Set/Get/Clear` for `ServerEncKeySalt` (`:18-47`).

Neither controller does any Signal math; they are opaque-blob in/out across the WinRT boundary. The Signal private keys themselves (identity/pre-key/session) never cross this bridge — they live in the JS-owned `genericStorage.db` (storage doc), encrypted at rest with a key derived from `ClientKey`.

---

## 4. Native Dependencies

| Capability | Native component | Confirmed? |
|---|---|---|
| Curve25519 ECDH (`Derive`), keygen, XEdDSA `Sign`/`Verify` | `WhatsAppNative.Curve25519` (C++/Rust in `WhatsAppNative.dll`), projected via `WhatsAppNativeProjection/WhatsAppNative/Curve25519.cs`; IID `68D7A737-E718-3D02-BB33-3A3F54594239`. **Crypto is statically linked** — `WhatsAppNative.dll` imports from `bcrypt.dll` *only* the RNG triplet (`BCryptGenRandom` + Open/CloseAlgorithmProvider) and has no `ncrypt`/`crypt32` import, so AES/HMAC/SHA + the curve field-arithmetic are compiled in (BoringSSL-from-WebRTC most likely). | **Confirmed** the C# projection + the 3 C# call sites exist; **algorithm = X25519 ECDH + XEdDSA-over-Curve25519, NATIVE-CONFIRMED** via radare2 (doc 96 §1) — the Montgomery-ladder constant `a24=121665` (`0x0001DB41`) and XEdDSA's SHA-512 (`K[0]=0x428a2f98d728ae22`) are statically present and the class exposes `Derive`/`Sign`/`Verify`/`GenKeyPair`; also corroborated by interop (JS bundle + whatsmeow + Baileys, §6 Q1). The only unread residual is the *instruction-level `Sign` body* / upstream curve **lineage** (donna vs ref10 vs fe25519), hidden by static linking — and that is **moot for the port** (doc 96 §5). |
| HMAC-SHA256 / HKDF | Managed (`System.Security.Cryptography.HMACSHA256`) in `HkdfSha256.cs` — **no native dep** | **Confirmed** managed. |
| Per-message AES-CBC + HMAC (Signal message bodies) | **JS bundle** (WebAssembly/JS libsignal in `waweb-source-bundle`) | **Confirmed** the logic is in JS (§3.7); the precise JS crypto backend (subtlecrypto vs wasm) was not disassembled. |
| X3DH, double ratchet, sender keys, prekey gen/upload/fetch, message enc/dec | **JS bundle** | **Confirmed** (§3.7). |
| Random | `CryptographicBuffer.GenerateRandom` (WinRT CNG CSPRNG) | **Confirmed** `Axolotl.cs:25`. |
| Companion signature verify | native curve via `AdvBridge.Verify` | **Confirmed** `AdvBridgeAdapter.cs:29`. |

**Net:** the only native E2E primitive the port must reproduce is **Curve25519 + XEdDSA** (and a CSPRNG). Everything else Signal is either managed (HKDF) or already JS.

---

## 5. Linux/Electron Port Mapping

The big lever: **the Signal engine is already JS and runs unmodified in any Chromium.** A faithful port can load the same `waweb-source-bundle` in an Electron `BrowserWindow`/`<webview>` and only needs to re-provide the small set of native host objects the JS calls. For the Signal layer specifically:

| Windows piece | Electron/Node equivalent | Notes / risk |
|---|---|---|
| `WhatsAppNative.Curve25519` (`Derive`/`Sign`/`Verify`/`GenKeyPair`) used by `AdvBridge.Verify`, Noise, cert-verify | `@noble/curves` (`x25519` for `Derive`, `ed25519`/XEdDSA for sign/verify) **or** libsignal's `curve25519` via WASM; or Node `crypto.diffieHellman` with `x25519` keys. For XEdDSA specifically, use `@signalapp/libsignal-client` (ships the exact `Curve.calculateSignature`/`verifySignature`). | XEdDSA ≠ plain Ed25519; do **not** substitute tweetnacl Ed25519 for `Sign`. Match the native 64-byte XEdDSA or verification of WhatsApp-server-signed material will fail. Prefer `@signalapp/libsignal-client` to guarantee bit-compat. |
| `AdvBridge.Verify` host object | Expose an Electron `ipcMain`/`contextBridge` method `adv.verify(msgB64,sigB64,keyB64)` that calls the curve verify above and returns bool. | Trivial; preserve base64 in/out and the swallow-exception→false semantics (`AdvBridgeAdapter.cs:31-35`). |
| `ClientKeyController` / `ServerEncKeySaltController` host objects | Two `contextBridge` methods backed by an encrypted key-value store (e.g. `better-sqlite3` + Electron `safeStorage` for the master key, replacing DPAPI). | The `ClientKey` is the root from which the message-DB secret is derived — protect with `safeStorage`/libsecret, not plaintext. `ClearClientKey` must trigger an app relaunch (`ClientKeyController.cs:44`). |
| Signal persisted state (`SessionStructure`, `SenderKeyRecordStructure`, pre-keys, identity) | **No port needed** — JS already serializes/stores these (in `genericStorage.db`). If you instead build a *native* client, use `@signalapp/libsignal-client` whose `SessionRecord`/`SenderKeyRecord`/`PreKeyRecord` use the **identical** protobuf schema documented in §3.1–§3.3. | The field tags in §3 are upstream-libsignal-compatible, so libsignal-client can read/write the same blobs. |
| Pre-key upload IQ `<iq xmlns="encrypt">` (§3.4) | **No port needed** if reusing the JS bundle (JS builds & sends it). If reimplementing networking natively, build the stanza with the exact sizes in §3.4 and send over the Noise channel. | The 4/32/3/32/32/64-byte field sizes and `<type>=0x05` are load-bearing; the server rejects malformed key uploads. |
| `Hkdf`/`HkdfSha256` | Node `crypto.hkdf`/`hkdfSync` with `sha256`, or `@noble/hashes/hkdf`. | RFC-5869 standard; salt defaults to 32 zero bytes (`Hkdf.cs:19`). Direct 1:1. |
| `CryptographicBuffer.GenerateRandom` | `crypto.randomBytes` / `webcrypto.getRandomValues`. | Direct. |
| Native Curve bodies | n/a | **Not a blocker:** the scheme is native-confirmed as X25519+XEdDSA (doc 96 §1), and `@signalapp/libsignal-client` is bit-compatible. Only the instruction-level `Sign` body / curve lineage is unread (static-linked), which is **moot for the port** — use the known-good libsignal curve impl and validate against real server responses. |

**Reuse-from-JS summary:** for the Signal/E2E layer, the Electron port's native surface shrinks to ~4 tiny host methods (`AdvBridge.verify`, `ClientKey.set/get/clear`, `ServerEncKeySalt.set/get/clear`) plus an encrypted blob store. The cryptographically delicate part (X3DH/ratchet/sender-keys/message AEAD) is carried entirely by the unmodified web bundle, dramatically de-risking the port — provided the curve host object is XEdDSA-exact.

**Primary risks/gaps:**
- XEdDSA exactness (above) — the #1 correctness risk.
- The web bundle expects `window.chrome.webview.hostObjects.<Name>` shape; Electron must emulate that object surface (async-returning, base64 string args) for `AdvBridge`/`ClientKeyBridge`/`ServerEncKeySaltBridge`, or shim the bundle's bridge accessor.
- At-rest protection of `ClientKey`/identity DB: replacing DPAPI ("LOCAL=user") with `safeStorage`/libsecret changes the trust boundary on Linux (libsecret may be unencrypted under some keyrings).

---

## 6. Open Questions / Unverified

Every item below was **re-investigated** against the C# dump, the `waweb-source-bundle` JS, the shipped native binary (`x64/WhatsAppNative.dll`), the open WA-protocol implementations whatsmeow (Go, `go.mau.fi/libsignal`) and Baileys (TS, `libsignal/src/curve`), and — in this final pass — a **re-read of the native PE import table** plus the **live appdata / decoded IndexedDB** forensics (docs 94/95); each carries a bold verdict tag, the concrete finding, and its provenance label. The original question text is preserved so the reader sees what was asked. The signature **algorithm variant (XEdDSA) is triple-corroborated** — the wire-compatible JS bundle plus two independent open clients all sign the 0x05-prefixed key via libsignal `calculateSignature` to a 64-byte signature with identical Curve25519 clamping. This final pass adds two native-binary facts and one live-data fact to Q1 without changing its open status: (a) **correction** — round-1's "Windows CNG `bcrypt.dll`" *crypto* backing was an overstatement; bcrypt is imported **RNG-only**, so the AES/HMAC/SHA/KDF **and** the curve field-arithmetic are **statically linked** (likely BoringSSL-from-WebRTC), which *narrows* but does not name the lineage; (b) **moot-for-port** — per docs 94/95 the authoritative Signal store is plaintext in the WebView IndexedDB and the JS bundle does all signing, so a renderer-hosted port never invokes the native `Sign`. A subsequent radare2 pass (doc 96 §1) then **native-confirmed the scheme directly from the binary** — the X25519 Montgomery-ladder constant `a24=121665` (`0x0001DB41`) and XEdDSA's SHA-512 (`K[0]=0x428a2f98d728ae22`) are statically present and `Curve25519` exposes `Derive`/`Sign`/`Verify`/`GenKeyPair` — so the X25519+XEdDSA scheme is no longer "by-interop" but byte-evidenced. The only piece that remains un-disambiguable without a full function-body read is the native DLL's **internal curve implementation flavor** (donna/ref10/fe25519), which the open clients cannot reveal and which static-linking hides (no library symbols); that residual is **moot for the port** (the JS bundle does all signing — docs 94/95/96), so Q1's *scheme* is now **RESOLVED** with only the lineage sub-point left open.

1. **[RESOLVED (scheme) / native-confirmed] — Algorithm *scheme* is X25519 ECDH + XEdDSA-over-Curve25519, NATIVE-CONFIRMED from the binary (doc 96 §1); only the native curve *implementation flavor* (donna/ref10/fe25519) stays unread, hidden by static linking, and is moot for the port. Final pass also corrected the round-1 bcrypt-backing claim and showed the curve crypto is statically linked.** *Question:* Whether the native `Curve25519.Sign` is XEdDSA (almost certainly, given 64-byte sigs + Signal compat) vs raw Ed25519, and which curve25519 implementation is used. *Finding (two separable sub-questions):*
   - **Algorithm scheme — NATIVE-CONFIRMED (doc 96 §1), and corroborated by interop (JS bundle + two open impls).** radare2 on `WhatsAppNative.dll` finds the X25519 Montgomery-ladder constant `a24=121665` (`0x0001DB41`) and XEdDSA's SHA-512 (`K[0]=0x428a2f98d728ae22`) statically present, with the `Curve25519` class exposing `Derive`/`Sign`/`Verify`/`GenKeyPair` — so the *scheme* is byte-evidenced, **not merely by-interop**. It is **XEdDSA-over-Curve25519, not raw Ed25519**. This is independently consistent with the readable web bundle (the native and JS clients are interoperable Signal endpoints producing wire-compatible signatures): The bundle's `WASignalSignatures` module exposes `signMsg` (sign) and `verifyMsgSignalVariant` (verify) — the "SignalVariant" naming is the tell — invoked across `TSxMupG…js` and `SjCAw3…js` (5× `verifyMsgSignalVariant`, plus `signSenderKeyMessage`). Every signature is forced to **64 bytes** via `o("WASignalOther").ensureSize(r,64)` / `ensureSize(n,64)` (verbatim in `SjCAw3…js` and `TSxMupG…js`). The signing/verifying is backed by a `WACryptoEd25519` module performing **Ed25519 point ops** — `pack` / `unpack` / `unpackneg` and Curve25519 **scalar clamping** `e[0]&=248,e[31]&=127,e[31]|=64` (verbatim in `RyXLfAa…js`), plus the Ed25519 key-(de)compression guard `Compressed Ed25519 key is not 32 bytes` (`TSxMupG…js`). Clamped Curve25519 keys fed through Ed25519 point ops producing a 64-byte signature is the textbook **XEdDSA** construction (raw Ed25519 uses independent Ed25519 keys, not clamped Curve25519 keys). The §5/Linux-mapping (line 333) names the corresponding libsignal `Curve.calculateSignature`/`verifySignature` the port should use.
     **Round-2 cross-reference — two independent open WA-protocol clients confirm the identical scheme** (label: open-impl corroboration, NOT a native-binary read; the native client must interoperate, so its `Sign` is XEdDSA *by interop*):
       - *whatsmeow (Go)* — `research/external/whatsmeow/util/keys/keypair.go:48-55`: `Sign` builds a **33-byte** `pubKeyForSignature` with `[0]=ecc.DjbType` (the 0x05 DJB type marker) + the 32-byte public, then calls `ecc.CalculateSignature(ecc.NewDjbECPrivateKey(*kp.Priv), …)` returning a **`*[64]byte`** signature (`go.mau.fi/libsignal/ecc`, `go.mod:12 → go.mau.fi/libsignal v0.2.2`). Keygen clamps exactly like the bundle — `priv[0] &= 248; priv[31] &= 127; priv[31] |= 64` (`keypair.go:35-37`). Verification is `ecc.VerifySignature(ecc.NewDjbECPublicKey(...), message, *[64]byte)` (`prekeys.go:222-226`, `pair.go:269-278`).
       - *Baileys (TS)* — `research/external/Baileys/src/Utils/crypto.ts:2,26-35`: `import * as curve from 'libsignal/src/curve'`; `Curve.sign = curve.calculateSignature(privateKey, buf)` and `Curve.verify = curve.verifySignature(generateSignalPubKey(pubKey), …)`, where `generateSignalPubKey` prepends `KEY_BUNDLE_TYPE` (0x05) to make the 33-byte form. Same libsignal `calculateSignature`/`verifySignature` pair.
     So the scheme is **native-confirmed XEdDSA** (doc 96 §1), now further triangulated across the JS bundle plus two independent open implementations — no longer inference of any kind.
   - **Native DLL implementation flavor — CANNOT RESOLVE STATICALLY (the only remaining sub-point; static linking hides the lineage, and it is moot for the port).** The class is confirmed implemented natively [native-binary] — `strings -n 6 x64/WhatsAppNative.dll` (re-run this pass) exposes only the decorated WinRT symbols `WhatsAppNative::Curve25519::Sign` / `::GenKeyPair`, the activation factory `__Curve25519ActivationFactory@WhatsAppNative`, and the projection/class type strings (`.?AVCurve25519@WhatsAppNative@@`, `.?AU__ICurve25519PublicNonVirtuals@WhatsAppNative@@`), and `objdump -T` shows **0 C-exported functions** (the class is reached only via the WinRT activation factory, so the `Sign` body is internal, not a flat export).
     **Round-3 native correction — the round-1 "Windows CNG `bcrypt.dll`" *crypto* backing was an overstatement [native-binary, re-read this pass].** The full PE import table (`objdump -p x64/WhatsAppNative.dll`) shows `bcrypt.dll` contributes **exactly three** symbols and they are all RNG: `BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider`. There is **no** `BCryptEncrypt`/`BCryptDecrypt`/`BCryptHashData`/`BCryptDeriveKeyPBKDF2`/`BCryptCreateHash`, and **no** `ncrypt.dll` / `crypt32.dll` / `advapi32` crypto import anywhere in the table. So bcrypt is used for **randomness only**; the AES/HMAC/SHA-256/KDF **and** the Curve25519/XEdDSA field arithmetic are **statically linked** into the 12 MB DLL — consistent with **BoringSSL pulled in from the embedded WebRTC stack** (the import table also carries `MFPlat.DLL`, `MFReadWrite.dll`, `d3d11`/`d2d1`/`dxgi`, `MMDevAPI`, `WS2_32` — a WebRTC/Media-Foundation fingerprint). The sibling `WhatsAppRust.dll` (wamedia) likewise imports only `ProcessPrng` from `bcryptprimitives.dll` (RNG-only), so it is not the curve provider either. This *narrows* the likely lineage toward BoringSSL's curve25519 (which is `donna`-derived / `fiat`-style), but does **not** confirm it: `strings` still finds **no** `xeddsa` / `ed25519` / `donna` / `ref10` / `fe25519` / `x25519` / `sodium` / `boringssl` / `nacl` marker (re-confirmed this pass against the 12 MB DLL), and the static-linking means there are no library symbols to read, so the **internal implementation flavor (donna vs ref10 vs fe25519, and how it lays out the XEdDSA math) still cannot be read statically**. The open WA clients (whatsmeow uses `go.mau.fi/libsignal`, Baileys uses the `libsignal` npm `curve` module) reveal the *protocol* scheme but NOT Meta's native arithmetic lineage — they are reimplementations, not the shipped binary. A later radare2 pass (doc 96 §1) did recover the constants/symbols that **native-confirm the X25519+XEdDSA scheme** (`a24=121665`, SHA-512 `K[0]`, the four class methods) — so the scheme question is closed — but radare2's constant/symbol scan still does not fingerprint the *field-arithmetic lineage*. **What would resolve this narrow remaining sub-point:** a full function-body disassembly of the `Sign` body (e.g. radare2 `aaa`+`pdf`, or PyGhidra/IDA) to fingerprint the arithmetic against donna/ref10/fiat, or test-vector probing. **Note (live-appdata):** per docs 94/95 a renderer-hosted Electron port never needs this native `Sign` — the authoritative Signal state (identity/prekeys/sessions/senderkeys) lives plaintext in the WebView IndexedDB `signal-storage` and the JS bundle does all the signing; the native curve is only consumed for ADV-verify/Noise/cert-verify (§3.5), so this residual is **moot for the port**. Since the native client must interoperate with the XEdDSA scheme above, the native `Sign` is XEdDSA *by interop*; only its source lineage remains unread.
2. **[RESOLVED] — `<identity>`=32 bytes vs Signal's 33-byte (0x05-prefixed) public key.** *Question:* `SetRequestIdentity.cs:14` validates exactly 32 bytes, so the wire `<identity>` is the raw 32-byte X coordinate — does the JS add/strip the 0x05 prefix? *Finding:* **The JS adds the prefix on serialize and strips it on parse.** In `SjCAw3…js` the add-prefix helper `function h(e){if(e.byteLength!==32)throw r("err")("Invalid key type");var t=new Uint8Array(33);return t[0]=_,t.set(new Uint8Array(e),1),t.buffer}` requires a 32-byte input and emits 33 bytes with `byte[0]=_` (the DJB key-type constant 5); the strip-prefix helper `function b(e){if(e.byteLength!==33)throw r("err")("Invalid key type");var t=new Uint8Array(32);return t.set(new Uint8Array(e).subarray(1)),t.buffer}` requires 33 bytes and drops `byte[0]`. The native curve is always fed the de-prefixed 32-byte key, which is why every C# `ValidateBinary(32,32)` sees 32 bytes. (Now folded into §3.1.)
3. **[RESOLVED] — `SignedPreKeyId` width / field ordering.** *Question:* `PendingPreKey.SignedPreKeyId` is `int?` serialized as a varint at tag 24 (field 3) while `PreKeyId` is tag 8 (field 1) — is the `.proto` ordering really standard-libsignal? *Finding:* Both directions are now line-read and the ordering **matches upstream libsignal exactly** (`pre_key_id=1`, `signed_pre_key_id=3`, `base_key=2`). Serialize writes tag 8 `WriteUInt32(PreKeyId)` (`SessionStructure.cs:987-988`), tag 24 `WriteUInt64((ulong)SignedPreKeyId)` (`:992-993`), tag 18 `WriteBytes(BaseKey)` (`:997-998`); deserialize mirrors them at case 8 `ReadUInt32` (`:959`), case 24 `(int)ReadUInt64` (`:962`), case 18 `ReadBytes` (`:965`). Property types: `uint? PreKeyId` (`:843`), `int? SignedPreKeyId` (`:845`), `byte[] BaseKey` (`:847`). The field-3-before-field-2 layout and the `int?`/`UInt64` width mismatch are upstream-libsignal-faithful, not a decompiler artifact. (Now folded into §3.2.)
4. **[RESOLVED] — Exact JS message-body cipher.** *Question:* §3.2 infers AES-CBC+HMAC (encrypt-then-MAC) from the `{CipherKey,MacKey,Iv}` triple; what does the JS actually invoke? *Finding:* Read directly from `SjCAw3…js`: per-message keys come from `hkdf(new Uint8Array(e),null,"WhisperMessageKeys",80).then(function(e){return o("WASignalSessions").splitMsgKey(t,e)})` — HKDF-SHA256, salt `null`, info `"WhisperMessageKeys"`, **80 output bytes** split into 32 (AES-256 key) ‖ 32 (HMAC-SHA256 key) ‖ 16 (AES-CBC IV). The cipher object is `{name:"AES-CBC",iv:<iv>}` fed to `WACryptoDependencies.getCrypto().subtle` with `importKey("raw",…,"AES-CBC",!1,["encrypt"|"decrypt"])`, and the MAC is WebCrypto `{name:"HMAC",hash:"SHA-256"}` — exactly upstream libsignal encrypt-then-MAC. (The IV binder is a minified local that varies by call site — `iv:r`, `iv:t`, etc. — so the form appears as `{name:"AES-CBC",iv:r}` at one site and `{name:"AES-CBC",iv:t}` at another; same object shape either way.) (Already folded into §3.2.)
5. **[RESOLVED] — PreKeys.Incoming parsing.** *Question:* The `SetResponse*`/`IQError*` family under `…PreKeys.Incoming/` was enumerated but not line-read; is the success/error ack schema field-precise? *Finding:* Line-read. `SetHandler.HandleResponse` (`SetHandler.cs:11-52`) tries the four `Create` parsers in fixed order — `SetResponseSuccess` → `SetResponsePreKeySuccessVnameFailure` → `SetResponseRequestError` → `SetResponseServerError` — returning the first `Either.IsLeft` match, and `FailuresService.Investigate`-logs all four error messages if none parse (`:50`, with the leaked FBSOURCE path `…\WhatsApp.Networking\Smax\Generated\PreKeys\Incoming\Set\SetHandler.cs`). Success is a payload-less `IQResultResponseMixin` that pins `type="result"`, cross-references the response `id` against the request `id` (`isReference:true`, `IQResultResponseMixin.cs:30-31`) and the response `from` against the request `to` as a `DomainJid` (`:35-36`). Error variants reuse the 406 / 4xx / 503 / 5xx classification in §3.4. (Already folded into §3.4.)
6. **[RESOLVED] — Group sender-key distribution wire (`skmsg`/`senderKeyDistributionMessage`).** *Question:* Confirmed present in JS by string match only; what is the exact SKDM proto body and the `<enc type>` mapping? *Finding:* Both recovered from the bundle. The **4-field SenderKeyDistributionMessage proto body** is read directly in `TSxMupG…js`: `{id:[1,e.TYPES.UINT32],iteration:[2,e.TYPES.UINT32],chainKey:[3,e.TYPES.BYTES],signingKey:[4,e.TYPES.BYTES]}` — i.e. `id` (varint), `iteration` (varint), `chainKey` (bytes), `signingKey` (bytes), matching upstream libsignal `SenderKeyDistributionMessage`. The `<enc type>` attribute is a **named string enum**, not an integer table: `CiphertextType` is `$InternalEnum({Skmsg:"skmsg",Pkmsg:"pkmsg",Msg:"msg",Msmsg:"msmsg"})` (`TSxMupG…js`), and the runtime guard `decryptEnc: Can not do skmsg for non group` (`SjCAw3…js`) proves `skmsg` is the group ciphertext type. The enclosing container carries it as proto field `senderKeyDistributionMessage`. (Now folded into §3.3.)
