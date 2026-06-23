# 91 — Protocol Constants Reference

> Synthesis appendix. Every constant below is transcribed verbatim from the decompiled C# / native sources, with a `relative/path.cs:LINE` citation (paths relative to `decompiled_source/`). Numbers are copied exactly, not paraphrased. Where a value is *derived* (computed from code rather than a literal) or *inferred*, it is labelled as such.

## 1. Purpose & Scope

This document is the single hard-constants reference for the native Windows WhatsApp client (`WhatsApp.Root.exe`, package version `2.2607.106.0`). It consolidates the magic numbers, names, host lists, and token tables that the per-mechanism docs (`10`–`42`) reference, so a Linux/Electron port has one authoritative table to cross-check against the wire.

Scope: connection hosts/ports, app version & edition, the Noise protocol names and handshake framing magic, AES-GCM / HKDF parameters, the binary-node byte tags, the full `WAPDefaultTokenDictionary` token tables (transcribed), JID server suffixes, the `ClientPayload` enum wire values, the compression flag, and the pinned root certificate key.

It does **not** re-explain mechanisms (see docs 10–21); it only tabulates the constants and cites where each lives.

## 2. Where It Lives

| Constant group | File (relative to `decompiled_source/`) |
| --- | --- |
| Binary node byte tags | `decompiled/WhatsApp.Networking/WhatsApp/BinTag.cs` |
| Token dictionary (primary + 4 secondary tables) | `decompiled/WhatsApp.Networking/WhatsApp/WAPDefaultTokenDictionary.cs` |
| Token dictionary runtime bounds | `decompiled/WhatsApp.Networking/WhatsApp/TokenDictionary.cs` |
| Node reader (tag dispatch) | `decompiled/WhatsApp.Networking/WhatsApp/BinTreeNodeReader.cs` |
| Node writer (tag emit + compression flag) | `decompiled/WhatsApp.Networking/WhatsApp/BinTreeNodeWriter.cs` |
| Frame length prefix (3-byte) | `decompiled/WhatsApp.Networking/WhatsApp/FramesReader.cs`, `.../FramesWriter.cs` |
| Noise handshake names | `decompiled/WhatsApp.Root/WhatsApp/HandshakeCipher.cs` |
| Handshake hash / SHA-256 mixing | `decompiled/WhatsApp.Root/WhatsApp/HandshakeHash.cs` |
| Stream header `WA` magic, edge header `ED`, protocol version 6, ClientPayload build | `decompiled/WhatsApp.Root/WhatsApp/HandshakeHandler.cs` |
| Frame AES-GCM + compression `0x02` (send) | `decompiled/WhatsApp.Root/WhatsApp/StanzaWriter.cs` |
| Frame AES-GCM + decompression (recv) | `decompiled/WhatsApp.Root/WhatsApp/EncryptedBytesReceiver.cs` |
| AES-GCM tag size, nonce builder | `decompiled/WhatsApp.Root/WhatsApp/AesGcmProvider.cs`, `.../WAProtocol.cs` |
| Hosts, edge IPs, ports | `decompiled/WhatsApp.Root/WhatsApp/IpList.cs`, `.../IpProvider.cs`, `.../FunRunner.cs` |
| Pinned root cert key + serial | `decompiled/WhatsApp.Root/WhatsApp/WACertificateVerificationUtils.cs` |
| JID domains / suffixes / separators | `decompiled/WhatsApp.Core/WhatsApp/JidConstants.cs`, `.../UserJidType.cs` |
| ClientPayload wire enums | `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/ClientPayload.cs` |
| Release channel | `decompiled/WhatsApp.VoIP/WhatsApp/Constants.cs`, `decompiled/WhatsApp.Core/WhatsApp/BuildDetails.cs` |
| Package identity / version | `x64/AppxManifest.xml` |

## 3. How It Works

### 3.1 App identity & version

```
Identity Name="5319275A.WhatsAppDesktop"  Version="2.2607.106.0"  ProcessorArchitecture="x64"
```
— `x64/AppxManifest.xml` `<Identity .../>`. `PhoneProductId="606be18e-7eed-4c2c-b480-6211dd1826d6"`, publisher CN `24803D75-212C-471A-BC57-9EF86AB91435`, display name `WhatsApp`.

Runtime deps (same file): `Microsoft.WindowsAppRuntime.1.6` (MinVersion `6000.318.2304.0`), `Microsoft.WebView2`, `Microsoft.VCLibs.140.00` / `.UWPDesktop`. Target device families `Windows.Universal` and `Windows.Desktop`, `MinVersion 10.0.19041.0`.

The version that goes **on the wire** is read at runtime from `PackageInfo.Version.ToString().Split('.')` and split into 4 fields — `HandshakeHandler.cs:228, 244-247`:

```
Primary    = array[0]   // 2
Secondary  = array[1]   // 2607
Tertiary   = array[2]   // 106
Quaternary = array[3]   // 0
```
(Values shown are from the `2.2607.106.0` package; the code reads them dynamically, it does not hard-code them.)

**Edition / release channel** is `Production`:
- `BuildDetails.CurrentReleaseChannel => ReleaseChannel.Production` — `WhatsApp.Core/WhatsApp/BuildDetails.cs:9`.
- The value sent in `ClientPayload.UserAgent.release_channel` is `Constants.ReleaseChannel = ClientPayload.UserAgent.ReleaseChannel.RELEASE` — `WhatsApp.VoIP/WhatsApp/Constants.cs:178`.

### 3.2 Hosts & ports

**Connection ports** (cycled in this order) — `FunRunner.cs:19`:
```csharp
private static readonly int[] Ports = new int[3] { 443, 5222, 80 };
```
Index = `CurrentPortIndex % 3` (`FunRunner.cs:51`).

**Login hostnames** — `IpProvider.cs:59-69`:
| LoginHostType | Host |
| --- | --- |
| `GWhatsappNet` | `g.whatsapp.net` |
| `GFallbackWhatsappNet` | `g-fallback.whatsapp.net` |
| `HardcodedList` | `g.whatsapp.net` |
| `ExWhatsappNet` | `e{N}.whatsapp.net`, `N = Random().Next(16) + 1` → e1..e16 |

**Hardcoded fallback IP list** — `IpList.cs`. Edge hosts `e1..e16.whatsapp.net` all map to the same 4 IPv4 addresses (`IpList.cs:11` etc.):
```
15.197.206.217, 3.33.252.61, 15.197.210.208, 3.33.221.48
```
`g.whatsapp.net` (`IpList.cs:74-81`) — 14 IPv4 + 14 IPv6:
```
31.13.65.50, 31.13.88.61, 157.240.19.54, 31.13.93.54, 31.13.66.51,
157.240.229.61, 31.13.70.50, 157.240.11.54, 31.13.71.50, 157.240.241.61,
31.13.67.53, 157.240.14.53, 157.240.3.55, 157.240.22.54,
2a03:2880:f211:c6:face:b00c:0:7260, 2a03:2880:f211:1ca:face:b00c:0:7260, … (IPv6 …:0:7260)
```
`v.whatsapp.net` (`IpList.cs:83-90`) — same network, IPv6 suffix `…:0:167`.

**Chat host (XMPP domain in stanzas):** `s.whatsapp.net` — token #3 (`WAPDefaultTokenDictionary.cs:7`) and `JidConstants.UserDomain` (`JidConstants.cs:5`).

**Media hosts:** `mmg.whatsapp.net` and `mmg-fallback.whatsapp.net` are present as dictionary tokens (primary indices 139 and 134). They are **not** hard-coded as a host array in the connection layer; the live media hosts/auth come from the `media_conn` IQ at runtime. **Confirmed**: the `media_conn` response carries `hostname`, `fallback_hostname`, `auth`, `auth_ttl`, `ttl`, `max_buckets`, `download_buckets`, `primary`, `secondary` attributes — all present as adjacent dictionary tokens parsed from the runtime IQ (`waweb-source-bundle/n6o0-NaJTww.js`, grep `media_conn` → attribute set), with no static media-host array anywhere near `IpList.cs`. The matching token indices exist precisely so the server-returned media-host strings encode compactly: `media_conn`=58, `hostname`=70, `auth_ttl`=124, `max_buckets`=99, `download_buckets`=49, `fallback_hostname`=44 (primary table §3.9). A Linux port must issue the `media_conn` IQ and read these hosts dynamically; do not pin `mmg*` statically.

### 3.3 Frame layer (length prefix)

Every transport frame is prefixed by a **3-byte big-endian length** — `FramesWriter.MediumToByteArray` (`FramesWriter.cs:31-38`) and the reader (`FramesReader.cs:66-85`):
```
length = (b0 << 16) | (b1 << 8) | b2        // FramesReader.cs:74
```
`FramesReader.FrameHeaderSize = 3` (`FramesReader.cs:12`). Max post-encode stanza payload before send is `33554432` (32 MiB) — `StanzaWriter.cs:67`.

### 3.4 Stream/handshake prologue magic

Sent once before the Noise ClientHello — `HandshakeHandler.cs:47-50`:
```csharp
byte[] _header   = new byte[4] { 87, 65, 6, 0 };     // "WA", 0x06, <dictVersion>
_header[3]       = (byte)FunXMPP.Dictionary.GetDictionaryVersion();  // = 3
byte[] _edgeHeader = new byte[4] { 69, 68, 0, 1 };   // "ED", 0x00, 0x01
```
- Bytes `87,65` = ASCII `"WA"`.
- Byte 2 = `0x06` = `HandshakeHandler.WaProtocolVersion = 6` (`HandshakeHandler.cs:11`).
- Byte 3 = dictionary version = `3` (`WAPDefaultTokenDictionary.DictionaryVersion => 3`, `WAPDefaultTokenDictionary.cs:163`; `dictionaryVersion = 3` const at `:155`).
- Edge bytes `69,68` = ASCII `"ED"`, then `00 01`.

Edge routing is written first **only when** `edgeRoutingInfo` is non-empty: `_edgeHeader` (4B) + 3-byte length + routing bytes, then the `WA` header — `HandshakeHandler.WriteInitialStanza` (`HandshakeHandler.cs:147-166`).

### 3.5 Noise protocol names, key agreement, AES-GCM/HKDF

Three 32/36-byte Noise protocol-name buffers — `HandshakeCipher.cs:8-30` (ASCII decode shown):
| Const | Bytes (ASCII) | Used for |
| --- | --- | --- |
| `FULL_HANDSHAKE` (32B) | `Noise_XX_25519_AESGCM_SHA256` + `00 00 00 00` pad | first registration / full XX (`HandshakeCipher.cs:8`) |
| `RESUME_HANDSHAKE` (32B) | `Noise_IK_25519_AESGCM_SHA256` + `00 00 00 00` pad | resumed login (IK) (`HandshakeCipher.cs:16`) |
| `FALLBACK_HANDSHAKE` (36B) | `Noise_XXfallback_25519_AESGCM_SHA256` (no pad) | XX-fallback (`HandshakeCipher.cs:24`) |

Selected at: FULL on `SendClientHello` (`HandshakeHandler.cs:68`), RESUME on `SendClientResume` (`:78`), FALLBACK on `ReceiveServerFallback` (`:170`).

- **Curve:** X25519 (`Curve22519Extensions.GenKeyPair` / `.Derive` — `HandshakeHandler.cs:57,86,89,127,128`).
- **AEAD:** AES-256-GCM. Tag size `16` bytes — `AesGcmProvider.TagSize = 16` (`AesGcmProvider.cs:11`); tag is appended/split as the trailing 16 bytes (`AesGcmProvider.cs:45-54`). The exact WinRT algorithm id is `SymmetricAlgorithmNames.AesGcm`, opened via `SymmetricKeyAlgorithmProvider.OpenAlgorithm(...).CreateSymmetricKey(cipherKey)` and run through `CryptographicEngine.EncryptAndAuthenticate` / `DecryptAndAuthenticate`, with the GCM tag taken from `EncryptedAndAuthenticatedData.AuthenticationTag` (`AesGcmProvider.cs:15,27-28,40,59`). The 12-byte IV and AAD are passed as the `iv`/`aad` buffers; AAD is omitted (passed `null`) when empty (`AesGcmProvider.cs:27,59`). The AEAD runs through the OS WinRT crypto stack (`Windows.Security.Cryptography.Core`), **not** through `WhatsAppNative.dll`'s own crypto — that DLL's `bcrypt.dll` imports are **RNG-only** (`BCryptGenRandom` + `BCryptOpen/CloseAlgorithmProvider`; no `BCryptEncrypt`/`BCryptDeriveKey*`/`BCryptHashData`), so its native Signal/Noise + SQLite-codec symmetric crypto is statically linked rather than CNG-backed (see §4, [native-binary]).
- **Nonce:** 12 bytes; the 64-bit message counter is written **big-endian, right-aligned** into a 12-byte array (4 leading zero bytes) — `WAProtocol.LongToByteArray(value, 12)` (`WAProtocol.cs:53-66`). Handshake nonce starts at 0 and increments per `encryptPayload`/`decryptPayload` (`HandshakeCipher.cs:71,78,86`); post-handshake frame nonces use separate read/write counters starting at 0 (`StanzaWriter.cs:76`, `EncryptedBytesReceiver.cs:26`).
- **Hash:** SHA-256. `HandshakeHash` keeps a running 32-byte hash, `Update(x) = SHA256(hash ‖ x)` (`HandshakeHash.cs:22-28`); buffers >32B are pre-hashed (`HandshakeHash.cs:12-18`).
- **KDF:** HKDF-SHA256 producing 64 bytes, split into 32-byte chainKey + 32-byte cipherKey — `HandshakeCipher.setKey` (`HandshakeCipher.cs:83-91`) and `getNoiseCipher` (`:93-101`), both `HkdfSha256.Perform(64, …)`. The KDF body is **standard RFC 5869 Extract-then-Expand**: `HkdfSha256.Perform(keyLen, key, salt, info)` calls `Hkdf.Perform(key, salt, info, keyLen, 32, PerformHmac)` (`HkdfSha256.cs:7-10`) with `hashLen=32` and `HMACSHA256` as the PRF (`HkdfSha256.cs:12-16`). `Extract`: if `salt==null` it is replaced by 32 zero bytes, then `PRK = HMAC(salt, key)` (`Hkdf.cs:15-22`). `Expand`: `T(n) = HMAC(PRK, T(n-1) ‖ info ‖ byte(n))` for `n = 1,2,…` concatenated and truncated to `keyLen` (`Hkdf.cs:24-44`) — the single-byte counter starts at 1, exactly RFC 5869. Linux maps cleanly to Node `crypto.hkdfSync('sha256', key, salt, info, 64)`.

**Pinned root key** (`WhatsAppLongTerm1`, serial `0`) used to validate the server cert chain for WA protocol v6 — `WACertificateVerificationUtils.cs:51,53,57-63`:
```
CertificateIssuer = "WhatsAppLongTerm1"   RootSerial = 0
CertificatePublicKey (32B) =
  20, 35, 117, 87, 77, 10, 88, 113, 102, 170, 231, 30, 190, 81, 100, 55,
  196, 162, 139, 115, 227, 105, 92, 108, 225, 247, 249, 84, 93, 168, 238, 107
```
`VerifyTimeForWA6 = false` (`:55`) — cert NotBefore/NotAfter are not time-checked on the v6 chain path.

### 3.6 Post-handshake frame compression flag

After the Noise handshake, each plaintext stanza buffer is prefixed by **one flag byte** before AES-GCM:
- **Send** (`StanzaWriter.WriteStanza`, `StanzaWriter.cs:35-72`): if compression requested and it shrinks the payload, prepend `0x02` and DEFLATE the body (`memoryStream.WriteByte(2)`, `:47`, via `DeflaterOutputStream`); otherwise prepend `0x00` and copy raw (`:63`).
- **Receive** (`EncryptedBytesReceiver.ReceiveFrame`, `:33-45`): `if ((array[0] & 2) != 0)` → INFLATE the remainder; else treat bytes `[1..]` as raw node stream.

So: **`0x02` = zlib/DEFLATE-compressed body, `0x00` = uncompressed.** (Compression is the low bit `0x02` of the leading flag byte.)

`WriteTreeNodesEnd` emits the stream-end node: list-start(1) then byte `2` (`BinTreeNodeWriter.cs:38-39`); the reader treats a tag byte of `2` at node position as stream end / null (`BinTreeNodeReader.cs:22-25`).

### 3.7 Binary-node byte tags

`BinTag.cs` (all values exact):
| Name | Value (dec / hex) |
| --- | --- |
| `LIST_EMPTY` | 0 / 0x00 |
| `STREAM_START` | 1 / 0x01 |
| `STREAM_END` | 2 / 0x02 |
| `JID_FB` | 246 / 0xF6 |
| `JID_U` | 247 / 0xF7 |
| `LIST_8` | 248 / 0xF8 |
| `LIST_16` | 249 / 0xF9 |
| `JID_PAIR` | 250 / 0xFA |
| `HEX_8` | 251 / 0xFB |
| `BINARY_8` | 252 / 0xFC |
| `BINARY_20` | 253 / 0xFD |
| `BINARY_32` | 254 / 0xFE |
| `NIBBLE_8` | 255 / 0xFF (`byte.MaxValue`) |

Reader dispatch confirms semantics (`BinTreeNodeReader.cs`):
- List size: `0→0`, `248→int8`, `249→int16` (`:81-90`); `IsListTag` = {0,248,249} (`:49-56`).
- `252` BINARY_8 = int8 length; `253` BINARY_20 = 20-bit length (`ReadInt20`); `254` BINARY_32 = 31-bit length (`ReadInt31`) (`:124-141`).
- `255` NIBBLE_8 packed nibbles, `251` HEX_8 packed hex (`:142-145`); top bit `0x80` of the count byte = odd-length flag (`:253-257`).
- `250` JID_PAIR → `user@server` (`:146-159`); `247` JID_U → `user[:device]@suffix` (`:160-178`); `246` JID_FB → not supported (`:179-180`).

### 3.8 Token dictionary model

`TokenDictionary.cs`:
- `_secondaryStringsStart = 236` (`:12`) — single-byte tokens **3..235** index `primaryStrings`; tokens **236,237,238,239** select secondary sub-dictionary `0..3`, and the **next byte** indexes within that 256-entry table (`GetToken`, `:85-99`; reader double-read at `BinTreeNodeReader.cs:108-118`).
- `DictionaryVersion = 3` (`WAPDefaultTokenDictionary.cs:155,163`).
- `PrimaryStrings` length = **236** (`new string[236]`, `WAPDefaultTokenDictionary.cs:5`); 4 secondary tables of **256** each (`new string[4][]`, `:33`; each `new string[256]`).
- `PrimaryTokenMax` recomputed = `236 + 4 = 240` in the ctor (`TokenDictionary.cs:56`); the `=245` initializer (`:16`) is overwritten.
- Index 0 is `null` (literal `LIST_EMPTY`/no-token); index 1 = `"xmlstreamstart"`, 2 = `"xmlstreamend"`.

### 3.9 Token tables — primary (index → string)

Transcribed verbatim from `WAPDefaultTokenDictionary.cs:5-31`. Index = single-byte token value. (`0` = null.)

```
  0 <null>            1 xmlstreamstart   2 xmlstreamend     3 s.whatsapp.net
  4 type             5 participant      6 from             7 receipt
  8 id               9 notification    10 disappearing_mode 11 status
 12 jid             13 broadcast       14 user            15 devices
 16 device_hash     17 to              18 offline         19 message
 20 result          21 class           22 xmlns           23 duration
 24 notify          25 iq              26 t               27 ack
 28 g.us            29 enc             30 urn:xmpp:whatsapp:push  31 presence
 32 config_value    33 picture         34 verified_name   35 config_code
 36 key-index-list  37 contact         38 mediatype       39 routing_info
 40 edge_routing    41 get             42 read            43 urn:xmpp:ping
 44 fallback_hostname 45 0             46 chatstate       47 business_hours_config
 48 unavailable     49 download_buckets 50 skmsg          51 verified_level
 52 composing       53 handshake       54 device-list     55 media
 56 text            57 fallback_ip4    58 media_conn      59 device
 60 creation        61 location        62 config          63 item
 64 fallback_ip6    65 count           66 w:profile:picture 67 image
 68 business        69 2               70 hostname        71 call-creator
 72 display_name    73 relaylatency    74 platform        75 abprops
 76 success         77 msg             78 offline_preview 79 prop
 80 key-index       81 v               82 day_of_week     83 pkmsg
 84 version         85 1               86 ping            87 w:p
 88 download        89 video           90 set             91 specific_hours
 92 props           93 primary         94 unknown         95 hash
 96 commerce_experience 97 last        98 subscribe       99 max_buckets
100 call           101 profile        102 member_since_text 103 close_time
104 call-id        105 sticker        106 mode           107 participants
108 value          109 query          110 profile_options 111 open_time
112 code           113 list           114 host           115 ts
116 contacts       117 upload         118 lid            119 preview
120 update         121 usync          122 w:stats        123 delivery
124 auth_ttl       125 context        126 fail           127 cart_enabled
128 appdata        129 category       130 atn            131 direct_connection
132 decrypt-fail   133 relay_id       134 mmg-fallback.whatsapp.net  135 target
136 available      137 name           138 last_id        139 mmg.whatsapp.net
140 categories     141 401            142 is_new         143 index
144 tctoken        145 ip4            146 token_id       147 latency
148 recipient      149 edit           150 ip6            151 add
152 thumbnail-document 153 26         154 paused         155 true
156 identity       157 stream:error   158 key            159 sidelist
160 background     161 audio          162 3              163 thumbnail-image
164 biz-cover-photo 165 cat           166 gcm            167 thumbnail-video
168 error          169 auth           170 deny           171 serial
172 in             173 registration   174 thumbnail-link 175 remove
176 00             177 gif            178 thumbnail-gif  179 tag
180 capability     181 multicast      182 item-not-found 183 description
184 business_hours 185 config_expo_key 186 md-app-state  187 expiration
188 fallback       189 ttl            190 300            191 md-msg-hist
192 device_orientation 193 out        194 w:m            195 open_24h
196 side_list      197 token          198 inactive       199 01
200 document       201 te2            202 played         203 encrypt
204 msgr           205 hide           206 direct_path    207 12
208 state          209 not-authorized 210 url            211 terminate
212 signature      213 status-revoke-delay 214 02         215 te
216 linked_accounts 217 trusted_contact 218 timezone     219 ptt
220 kyc-id         221 privacy_token  222 readreceipts   223 appointment_only
224 address        225 expected_ts    226 privacy        227 7
228 android        229 interactive    230 device-identity 231 enabled
232 attribute_padding 233 1080        234 03            235 screen_height
```

Notable hosts/flags inside the primary table: `s.whatsapp.net`=3, `mmg-fallback.whatsapp.net`=134, `mmg.whatsapp.net`=139, `atn`=130, `g.us`=28, `lid`=118, `edge_routing`=40, `routing_info`=39, `media_conn`=58.

### 3.10 Token tables — secondary (sub-dictionary 0..3)

Each is a 256-entry table; on the wire the token is `(236 + subdict)` followed by the index byte. Transcribed verbatim from `WAPDefaultTokenDictionary.cs`.

**Sub-dictionary 0** — selected by token byte **236** (`WAPDefaultTokenDictionary.cs:35-63`), indices 0..255:
```
  0 read-self        1 active          2 fbns            3 protocol
  4 reaction         5 screen_width    6 heartbeat       7 deviceid
  8 2:47DEQpj8        9 uploadfieldstat 10 voip_settings  11 retry
 12 priority        13 longitude       14 conflict        15 false
 16 ig_professional 17 replaced        18 preaccept       19 cover_photo
 20 uncompressed    21 encopt          22 ppic            23 04
 24 passive         25 status-revoke-drop 26 keygen        27 540
 28 offer           29 rate            30 opus            31 latitude
 32 w:gp2           33 ver             34 4               35 business_profile
 36 medium          37 sender          38 prev_v_id       39 email
 40 website         41 invited         42 sign_credential 43 05
 44 transport       45 skey            46 reason          47 peer_abtest_bucket
 48 America/Sao_Paulo 49 appid         50 refresh         51 100
 52 06              53 404             54 101             55 104
 56 107             57 102             58 109             59 103
 60 member_add_mode 61 105            62 transaction-id   63 110
 64 106             65 outgoing       66 108             67 111
 68 tokens          69 followers      70 ig_handle        71 self_pid
 72 tue             73 dec            74 thu              75 joinable
 76 peer_pid        77 mon            78 features         79 wed
 80 peer_device_presence 81 pn        82 delete           83 07
 84 fri             85 audio_duration 86 admin            87 connected
 88 delta           89 rcat           90 disable          91 collection
 92 08              93 480            94 sat              95 phash
 96 all             97 invite         98 accept           99 critical_unblock_low
100 group_update   101 signed_credential 102 blinded_credential 103 eph_setting
104 net            105 09            106 background_location 107 refresh_id
108 Asia/Kolkata   109 privacy_mode_ts 110 account_sync   111 voip_payload_type
112 service_areas  113 acs_public_key 114 v_id            115 0a
116 fallback_class 117 relay         118 actual_actors    119 metadata
120 w:biz          121 5             122 connected-limit  123 notice
124 0b             125 host_storage  126 fb_page          127 subject
128 privatestats   129 invis         130 groupadd         131 010
132 note.m4r       133 uuid          134 0c               135 8000
136 sun            137 372           138 1020             139 stage
140 1200           141 720           142 canonical        143 fb
144 011            145 video_duration 146 0d              147 1140
148 superadmin     149 012           150 Opening.m4r      151 keystore_attestation
152 dleq_proof     153 013           154 timestamp        155 ab_key
156 w:sync:app:state 157 0e          158 vertical         159 600
160 p_v_id         161 6             162 likes            163 014
164 500            165 1260          166 creator          167 0f
168 rte            169 destination   170 group            171 group_info
172 syncd_anti_tampering_fatal_exception_enabled 173 015 174 dl_bw  175 Asia/Jakarta
176 vp8/h.264      177 online        178 1320             179 fb:multiway
180 10             181 timeout       182 016              183 nse_retry
184 urn:xmpp:whatsapp:dirty 185 017  186 a_v_id          187 web_shops_chat_header_button_enabled
188 nse_call       189 inactive-upgrade 190 none          191 web
192 groups         193 2250          194 mms_hot_content_timespan_in_seconds 195 contact_blacklist
196 nse_read       197 suspended_group_deletion_notification 198 binary_version 199 018
200 https://www.whatsapp.com/otp/copy/ 201 reg_push 202 shops_hide_catalog_attachment_entrypoint 203 server_sync
204 .              205 ephemeral_messages_allowed_values 206 019 207 mms_vcache_aggregation_enabled
208 iphone         209 America/Argentina/Buenos_Aires 210 01a 211 mms_vcard_autodownload_size_kb
212 nse_ver        213 shops_header_dropdown_menu_item 214 dhash 215 catalog_status
216 communities_mvp_new_iqs_serverprop 217 blocklist 218 default 219 11
220 ephemeral_messages_enabled 221 01b 222 original_dimensions 223 8
224 mms4_media_retry_notification_encryption_enabled 225 mms4_server_error_receipt_encryption_enabled 226 original_image_url 227 sync
228 multiway       229 420          230 companion_enc_static 231 shops_profile_drawer_entrypoint
232 01c            233 vcard_as_document_size_kb 234 status_video_max_duration 235 request_image_url
236 01d            237 regular_high  238 s_t              239 abt
240 share_ext_min_preliminary_image_quality 241 01e 242 32 243 syncd_key_rotation_enabled
244 data_namespace 245 md_downgrade_read_receipts2 246 patch 247 polltype
248 ephemeral_messages_setting 249 userrate 250 15 251 partial_pjpeg_bw_threshold
252 played-self    253 catalog_exists 254 01f            255 mute_v2
```

**Sub-dictionary 1** — selected by token byte **237** (`WAPDefaultTokenDictionary.cs:64-92`), indices 0..255:
```
  0 reject           1 dirty          2 announcement     3 020
  4 13               5 9             6 status_video_max_bitrate 7 fb:thrift_iq
  8 offline_batch     9 022          10 full             11 ctwa_first_business_reply_logging
 12 h.264           13 smax_id       14 group_description_length 15 https://www.whatsapp.com/otp/code
 16 status_image_max_edge 17 smb_upsell_business_profile_enabled 18 021 19 web_upgrade_to_md_modal
 20 14              21 023          22 s_o              23 smaller_video_thumbs_status_enabled
 24 media_max_autodownload 25 960   26 blocking_status  27 peer_msg
 28 joinable_group_call_client_version 29 group_call_video_maximization_enabled 30 return_snapshot 31 high
 32 America/Mexico_City 33 entry_point_block_logging_enabled 34 pop 35 024
 36 1050            37 16           38 1380             39 one_tap_calling_in_group_chat_size
 40 regular_low     41 inline_joinable_education_enabled 42 hq_image_max_edge 43 locked
 44 America/Bogota  45 smb_biztools_deeplink_enabled 46 status_image_quality 47 1088
 48 025             49 payments_upi_intent_transaction_limit 50 voip 51 w:g2
 52 027             53 md_pin_chat_enabled 54 026       55 multi_scan_pjpeg_download_enabled
 56 shops_product_grid 57 transaction_id 58 ctwa_context_enabled 59 20
 60 fna             61 hq_image_quality 62 alt_jpeg_doc_detection_quality 63 group_call_max_participants
 64 pkey            65 America/Belem 66 image_max_kbytes 67 web_cart_v1_1_order_message_changes_enabled
 68 ctwa_context_enterprise_enabled 69 urn:xmpp:whatsapp:account 70 840 71 Asia/Kuala_Lumpur
 72 max_participants 73 video_remux_after_repair_enabled 74 stella_addressbook_restriction_type 75 660
 76 900             77 780          78 context_menu_ios13_enabled 79 mute-state
 80 ref             81 payments_request_messages 82 029 83 frskmsg
 84 vcard_max_size_kb 85 sample_buffer_gif_player_enabled 86 match_last_seen 87 510
 88 4983            89 video_max_bitrate 90 028          91 w:comms:chat
 92 17              93 frequently_forwarded_max 94 groups_privacy_blacklist 95 Asia/Karachi
 96 02a             97 web_download_document_thumb_mms_enabled 98 02b 99 hist_sync
100 biz_block_reasons_version 101 1024 102 18           103 web_is_direct_connection_for_plm_transparent
104 view_once_write 105 file_max_size 106 paid_convo_id 107 online_privacy_setting
108 video_max_edge  109 view_once_read 110 enhanced_storage_management 111 multi_scan_pjpeg_encoding_enabled
112 ctwa_context_forward_enabled 113 video_transcode_downgrade_enable 114 template_doc_mime_types 115 hq_image_bw_threshold
116 30              117 body         118 u_aud_limit_sil_restarts_ctrl 119 other
120 participating   121 w:biz:directory 122 1110        123 vp8
124 4018            125 meta         126 doc_detection_image_max_edge 127 image_quality
128 1170            129 02c          130 smb_upsell_chat_banner_enabled 131 key_expiry_time_second
132 pid             133 stella_interop_enabled 134 19   135 linked_device_max_count
136 md_device_sync_enabled 137 02d  138 02e            139 360
140 enhanced_block_enabled 141 ephemeral_icon_in_forwarding 142 paid_convo_status 143 gif_provider
144 project_name    145 server-error 146 canonical_url_validation_enabled 147 wallpapers_v2
148 syncd_clear_chat_delete_chat_enabled 149 medianotify 150 02f 151 shops_required_tos_version
152 vote            153 reset_skey_on_id_change 154 030 155 image_max_edge
156 multicast_limit_global 157 ul_bw 158 21            159 25
160 5000            161 poll         162 570            163 22
164 031             165 1280         166 WhatsApp       167 032
168 bloks_shops_enabled 169 50       170 upload_host_switching_enabled 171 web_ctwa_context_compose_enabled
172 ptt_forwarded_features_enabled 173 unblocked 174 partial_pjpeg_enabled 175 fbid:devices
176 height          177 ephemeral_group_query_ts 178 group_join_permissions 179 order
180 033             181 alt_jpeg_status_quality 182 migrate 183 popular-bank
184 win_uwp_deprecation_killswitch_enabled 185 web_download_status_thumb_mms_enabled 186 blocking 187 url_text
188 035             189 web_forwarding_limit_to_groups 190 1600 191 val
192 1000            193 syncd_msg_date_enabled 194 bank-ref-id 195 max_subject
196 payments_web_enabled 197 web_upload_document_thumb_mms_enabled 198 size 199 request
200 ephemeral       201 24          202 receipt_agg    203 ptt_remember_play_position
204 sampling_weight 205 enc_rekey    206 mute_always    207 037
208 034             209 23          210 036            211 action
212 click_to_chat_qr_enabled 213 width 214 disabled    215 038
216 md_blocklist_v2 217 played_self_enabled 218 web_buttons_message_enabled 219 flow_id
220 clear           221 450         222 fbid:thread    223 bloks_session_state
224 America/Lima    225 attachment_picker_refresh 226 download_host_switching_enabled 227 1792
228 u_aud_limit_sil_restarts_test2 229 custom_urls 230 device_fanout 231 optimistic_upload
232 2000            233 key_cipher_suite 234 web_smb_upsell_in_biz_profile_enabled 235 e
236 039             237 siri_post_status_shortcut 238 pair-device 239 lg
240 lc              241 stream_attribution_url 242 model 243 mspjpeg_phash_gen
244 catalog_send_all 245 new_multi_vcards_ui 246 share_biz_vcard_enabled 247 -
248 clean           249 200         250 md_blocklist_v2_server 251 03b
252 03a             253 web_md_migration_experience 254 ptt_conversation_waveform 255 u_aud_limit_sil_restarts_test1
```

**Sub-dictionary 2** — selected by token byte **238** (`WAPDefaultTokenDictionary.cs:93-121`), indices 0..255:
```
  0 64               1 ptt_playback_speed_enabled 2 web_product_list_message_enabled 3 paid_convo_ts
  4 27               5 manufacturer  6 psp-routing      7 grp_uii_cleanup
  8 ptt_draft_enabled 9 03c          10 business_initiated 11 web_catalog_products_onoff
 12 web_upload_link_thumb_mms_enabled 13 03e 14 mediaretry 15 35
 16 hfm_string_changes 17 28         18 America/Fortaleza 19 max_keys
 20 md_mhfs_days    21 streaming_upload_chunk_size 22 5541 23 040
 24 03d             25 2675         26 03f             27 ...
 28 512             29 mute         30 48              31 041
 32 alt_jpeg_quality 33 60          34 042            35 md_smb_quick_reply
 36 5183            37 c            38 1343           39 40
 40 1230            41 043          42 044            43 mms_cat_v1_forward_hot_override_enabled
 44 user_notice     45 ptt_waveform_send 46 047       47 Asia/Calcutta
 48 250             49 md_privacy_v2 50 31            51 29
 52 128             53 md_messaging_enabled 54 046    55 crypto
 56 690             57 045          58 enc_iv         59 75
 60 failure         61 ptt_oot_playback 62 AIzaSyDR5yfaG7OG8sMTUj8kfQEb8T9pN8BM6Lk 63 w
 64 048             65 2201         66 web_large_files_ui 67 Asia/Makassar
 68 812             69 status_collapse_muted 70 1334  71 257
 72 2HP4dm          73 049          74 patches        75 1290
 76 43cY6T          77 America/Caracas 78 web_sticker_maker 79 campaign
 80 ptt_pausable_enabled 81 33      82 42             83 attestation
 84 biz             85 04b          86 query_linked   87 s
 88 125             89 04a          90 810            91 availability
 92 1411            93 responsiveness_v2_m1 94 catalog_not_created 95 34
 96 America/Santiago 97 1465        98 enc_p          99 04d
100 status_info    101 04f          102 key_version   103 ..
104 04c            105 04e          106 md_group_notification 107 1598
108 1215           109 web_cart_enabled 110 37        111 630
112 1920           113 2394         114 -1            115 vcard
116 38             117 elapsed      118 36            119 828
120 peer           121 pricing_category 122 1245      123 invalid
124 stella_ios_enabled 125 2687     126 45            127 1528
128 39             129 u_is_redial_audio_1104_ctrl 130 1025 131 1455
132 58             133 2524         134 2603          135 054
136 bsp_system_message_enabled 137 web_pip_redesign 138 051 139 verify_apps
140 1974           141 1272         142 1322          143 1755
144 052            145 70           146 050           147 1063
148 1135           149 1361         150 80            151 1096
152 1828           153 1851        154 1251           155 1921
156 key_config_id  157 1254         158 1566          159 1252
160 2525           161 critical_block 162 1669        163 max_available
164 w:auth:backup:token 165 product 166 2530         167 870
168 1022           169 participant_uuid 170 web_cart_on_off 171 1255
172 1432           173 1867         174 41            175 1415
176 1440           177 240          178 1204          179 1608
180 1690           181 1846         182 1483          183 1687
184 1749           185 69           186 url_number    187 053
188 1325           189 1040         190 365           191 59
192 Asia/Riyadh    193 1177         194 test_recommended 195 057
196 1612           197 43           198 1061          199 1518
200 1635           201 055          202 1034          203 1375
204 750            205 1430         206 event_code    207 1682
208 503            209 55           210 865           211 78
212 1309           213 1365         214 44            215 America/Guayaquil
216 535            217 LIMITED      218 1377          219 1613
220 1420           221 1599         222 1822          223 05a
224 1681           225 password     226 1111          227 1214
228 1376           229 1478         230 47            231 1082
232 4282           233 Europe/Istanbul 234 1307       235 46
236 058            237 1124         238 256           239 rate-overlimit
240 retail         241 u_a_socket_err_fix_succ_test 242 1292 243 1370
244 1388           245 520          246 861           247 psa
248 regular        249 1181        250 1766           251 05b
252 1183           253 1213         254 1304          255 1537
```

**Sub-dictionary 3** — selected by token byte **239** (`WAPDefaultTokenDictionary.cs:122-150`), indices 0..255:
```
  0 1724             1 profile_picture 2 1071           3 1314
  4 1605             5 407          6 990             7 1710
  8 746              9 pricing_model 10 056           11 059
 12 061             13 1119         14 6027           15 65
 16 877             17 1607         18 05d            19 917
 20 seen            21 1516         22 49             23 470
 24 973             25 1037         26 1350           27 1394
 28 1480            29 1796         30 keys            31 794
 32 1536            33 1594         34 2378           35 1333
 36 1524            37 1825         38 116            39 309
 40 52              41 808          42 827            43 909
 44 495             45 1660         46 361            47 957
 48 google          49 1357         50 1565           51 1967
 52 996             53 1775         54 586            55 736
 56 1052            57 1670         58 bank           59 177
 60 1416            61 2194         62 2222           63 1454
 64 1839            65 1275         66 53             67 997
 68 1629            69 6028         70 smba           71 1378
 72 1410            73 05c          74 1849           75 727
 76 create          77 1559         78 536            79 1106
 80 1310            81 1944         82 670            83 1297
 84 1316            85 1762         86 en             87 1148
 88 1295            89 1551         90 1853           91 1890
 92 1208            93 1784         94 7200           95 05f
 96 178             97 1283         98 1332           99 381
100 643            101 1056         102 1238          103 2024
104 2387           105 179          106 981           107 1547
108 1705           109 05e          110 290           111 903
112 1069           113 1285         114 2436          115 062
116 251            117 560          118 582           119 719
120 56             121 1700         122 2321          123 325
124 448            125 613          126 777           127 791
128 51             129 488          130 902           131 Asia/Almaty
132 is_hidden      133 1398         134 1527          135 1893
136 1999           137 2367         138 2642          139 237
140 busy           141 065          142 067           143 233
144 590            145 993          146 1511          147 54
148 723            149 860          150 363           151 487
152 522            153 605          154 995           155 1321
156 1691           157 1865         158 2447          159 2462
160 NON_TRANSACTIONAL 161 433       162 871           163 432
164 1004           165 1207         166 2032          167 2050
168 2379           169 2446         170 279           171 636
172 703            173 904          174 248           175 370
176 691            177 700          178 1068          179 1655
180 2334           181 060          182 063           183 364
184 533            185 534          186 567           187 1191
188 1210           189 1473         190 1827          191 069
192 701            193 2531         194 514           195 prev_dhash
196 064            197 496          198 790           199 1046
200 1139           201 1505         202 1521          203 1108
204 207            205 544          206 637           207 final
208 1173           209 1293         210 1694          211 1939
212 1951           213 1993         214 2353          215 2515
216 504            217 601          218 857           219 modify
220 spam_request   221 p_121_aa_1101_test4 222 866    223 1427
224 1502           225 1638         226 1744          227 2153
228 068            229 382          230 725           231 1704
232 1864           233 1990         234 2003          235 Asia/Dubai
236 508            237 531          238 1387          239 1474
240 1632           241 2307         242 2386          243 819
244 2014           245 066          246 387           247 1468
248 1706           249 2186         250 2261          251 471
252 728            253 1147         254 1372          255 1961
```

### 3.11 JID domains, suffixes & separators

`JidConstants.cs` (all `const`/`static`):
| Const | Value |
| --- | --- |
| `UserDomain` / `UserSuffix` | `s.whatsapp.net` / `@s.whatsapp.net` |
| `UserShortDomain` / `UserShortSuffix` | `c.us` / `@c.us` |
| `LidDomain` / `LidSuffix` | `lid` / `@lid` |
| `BotDomain` / `BotSuffix` | `bot` / `@bot` |
| `GroupDomain` / `GroupJidSuffix` | `g.us` / `@g.us` |
| `JidBroadcastDomain` / `BroadcastJidSuffix` | `broadcast` / `@broadcast` |
| `JidNewsletterDomain` / `NewsletterJidSuffix` | `newsletter` / `@newsletter` |
| `JidBusinessDomain` | `business` |
| `JidMultiAgentDomain` | `b.us` |
| `JidCallDomain` / `CallJidSuffix` | `call` / `@call` |
| `StatusDomain` / `StatusSuffix` | `s.us` / `@s.us` |
| `StatusV3JidStr` | `status@broadcast` |
| `LocationJidStr` | `location@broadcast` |
| `PsaJidStr` | `0@s.whatsapp.net` |
| `BotJidStr` | `13135550002@s.whatsapp.net` |
| `JidAgentSeparator` | `'.'` |
| `JidDeviceSeparator` | `':'` |
| `JidDomainSeparator` | `'@'` |
| `JidGroupTimestampSeparator` / `JidMultiAgentUserSeparator` | `'-'` |
| `DefaultAgentId` / `DefaultDeviceId` | `0` / `0` |

`UserJidType` (`UserJidType.cs`): `Unknown = -1, Jid = 0, Lid = 1, Bot = 2`. JID_U (tag 247) on the wire carries a 1-byte jidType + 1-byte device + user string; suffix mapping on read: `Jid → @s.whatsapp.net`, `Lid → @lid` (`BinTreeNodeReader.cs:334-335`).

### 3.12 ClientPayload wire enums (`ClientPayload.cs`)

Proto3 enums — first member = 0 unless an explicit value is given.
- **`UserAgent.Platform`** (`:61-96`): `ANDROID=0, IOS=1, WINDOWS_PHONE=2, BLACKBERRY=3, BLACKBERRYX=4, S40=5, S60=6, PYTHON_CLIENT=7, TIZEN=8, ENTERPRISE=9, SMB_ANDROID=10, KAIOS=11, SMB_IOS=12, WINDOWS=13, WEB=14, PORTAL=15, …, MACOS=24, …, BLUE_WEB=32`. The native client sends `WINDOWS = 13` (`HandshakeHandler.cs:241`) on **every** connect path: there is exactly one `platform = …` construction site in the whole decompiled tree (the other `instance.platform = …` occurrences at `ClientPayload.cs:385,454,525` are protobuf *deserialization*, not emission), and the single payload builder `BuildClientPayload()` (`HandshakeHandler.cs:226-264`) is invoked identically by the full-XX path (`ReceiveServerHello`, `:202`), the resume/IK path (`SendClientResume`, `:91`), and the XX-fallback path (which routes through `ReceiveServerHello`). So full, resume, and fallback all send `WINDOWS=13` with the same fixed fields; no path overrides the platform.
- **`UserAgent.ReleaseChannel`** (`:98-104`): `RELEASE=0, BETA=1, ALPHA=2, DEBUG=3`. Sent value = `RELEASE` (`Constants.cs:178`).
- **`ConnectReason`** (`:18-26`): `PUSH=0, USER_ACTIVATED=1, SCHEDULED=2, ERROR_RECONNECT=3, NETWORK_SWITCH=4, PING_RECONNECT=5`. Sent value = `USER_ACTIVATED` (`HandshakeHandler.cs:261`).
- **`ConnectType`** (`:28-45`, explicit): `CELLULAR_UNKNOWN=0, WIFI_UNKNOWN=1, CELLULAR_EDGE=100, CELLULAR_IDEN=101, CELLULAR_UMTS=102, CELLULAR_EVDO=103, CELLULAR_GPRS=104, CELLULAR_HSDPA=105, CELLULAR_HSUPA=106, CELLULAR_HSPA=107, CELLULAR_CDMA=108, CELLULAR_1XRTT=109, CELLULAR_EHRPD=110, CELLULAR_LTE=111, CELLULAR_HSPAP=112`.
- **`Product`** (`:47-51`): `WHATSAPP=0, MESSENGER=1`.
- **`IOSAppExtension`** (`:11-16`), **`TrafficAnonymization`** (`:53-57`: `OFF=0, STANDARD=1`).

Fixed `UserAgent` fields the native client always sends (`HandshakeHandler.cs:249-258`): `Mcc="000"`, `Mnc="000"`, `Passive = true` (`:234`), `Pull = true` (`_connectInPullMode` `:53,238`).

## 4. Native Dependencies

- **X25519 / Curve25519** — `Curve22519Extensions.GenKeyPair/Derive/Sign/Verify` are thin managed wrappers (`Curve22519Extensions.cs:14-48` — pure dispatch to `NativeInterfaces.CreateInstance<Curve25519>()`, key/sig lengths queried at runtime via `GetKeyLength`/`GetSignLength`, no basepoint/scalar-mult/`9` literal in managed code); the actual scalar-mult and signature routine live in the native `WhatsAppNative` module. **[native-binary]** the WinRT projection target is real and present in `x64/WhatsAppNative.dll`: `strings` shows `.?AVCurve25519@WhatsAppNative@@`, `.?AV__Curve25519ActivationFactory@WhatsAppNative@@`, `.?AU__ICurve25519PublicNonVirtuals@WhatsAppNative@@`, and the class exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}`. The scheme is now **native-confirmed via radare2** (doc 96): the X25519 Montgomery-ladder constant **`a24 = 121665` (`0x0001DB41`, `/x 41db0100` → 3 hits, two adjacent at `0x180a38b60`/`…b68` in the field-constant table)** is statically present, fingerprinting **X25519 ECDH**; and **SHA-512** (`K[0]=0x428a2f98d728ae22` at `0x1808b969c`) plus the fact that `Sign`/`Verify` sit on the *same* class that does X25519 `Derive` fingerprint **XEdDSA-over-Curve25519** (Signal's scheme — XEdDSA signs with the Montgomery key and hashes with SHA-512), **not** a separate Ed25519. So the **signature scheme is byte-evidenced as Curve25519 XEdDSA, 64-byte**, not merely inferred-by-interop (doc 96 §2). The interop cross-refs corroborate the same primitive and length: whatsmeow via `ecc.VerifySignature`/`CalculateSignature` on `go.mau.fi/libsignal v0.2.2` (`go.mod:12`) with hard 64-byte length checks (`whatsmeow/handshake.go:156-168`, `whatsmeow/pair.go:265-270`), Baileys via `curve.calculateSignature`/`verifySignature` from `libsignal/src/curve` (`Baileys/src/Utils/crypto.ts:2,27,30`), and the WA-Web bundle via `WAWebCryptoLibraryUtilsApi.signMsg` (`waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:5317`). A Linux port can use `@signalapp/libsignal-client` (XEdDSA) and be bit-compatible (doc 96 §2). Only the instruction-level `Sign` body (exact basepoint encoding, scalar clamping, nonce derivation) is unread — and that is **moot for the port** given the confirmed scheme + bit-compatible library.
- **AES-GCM** — `AesGcmProvider` is implemented over WinRT `Windows.Security.Cryptography.Core` symmetric AEAD (the encrypt/decrypt + `AuthenticationTag` API at `AesGcmProvider.cs:28`). `HandshakeHash` uses WinRT `CryptographicHash` SHA-256 (`HandshakeHash.cs:1-2,24`). On Linux these map to Node `crypto` `aes-256-gcm` / `createHash('sha256')`. **[native-binary] correction:** `WhatsAppNative.dll`'s `bcrypt.dll` import set is **RNG-only** — `BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider`, with **no** `BCryptEncrypt`/`BCryptDeriveKey*`/`BCryptHashData`. So the WinRT AES-GCM/SHA path is serviced by the OS WinRT crypto stack (above this DLL), while the symmetric and curve primitives this DLL needs natively (Signal/Noise, the SQLite page codec) are **statically linked** — radare2 confirms the building blocks are present in the binary: the X25519 ladder constant `a24=121665` (`0x0001DB41`), SHA-1/256/512 round-constant tables, and the `Curve25519::{Derive,Sign,Verify,GenKeyPair}` class (doc 96 §2). The exact backing library is not name-stamped (a `strings` scan for `boringssl`/`fiat`/`openssl`/`curve25519.c`/`montgomery`/`ref10` returns nothing), but that is **immaterial for the port**: the scheme is byte-confirmed (X25519 ECDH + XEdDSA/SHA-512) and `@signalapp/libsignal-client` is bit-compatible. The DLL also embeds a statically-linked **WebRTC media build** via the Buck build path `buck-out\v2\art\wa_voip\__wafbsource__webrtc_latest__\…` (`strings WhatsAppNative.dll`, 3 occurrences resolving to `rtc_base/checks.h`/`buffer.h`/`numerics/safe_conversions.h`); the only WebRTC-related crypto strings present are sframe/SRTP media-key crypto (`.?AVWASframeKeyCrypto@crypto@sframe@wa@@`, `generate_sframe_keys_for_participant`, an `hkdf_sha256` callback) — call-media encryption, a separate stack from the Signal/Noise signing path. The sibling `WhatsAppRust.dll` (wamedia) carries no curve-provenance strings and imports only `ProcessPrng` from `bcryptprimitives.dll` (RNG-only), i.e. it too statically links its crypto. Other dynamic deps: `MFPlat.DLL`/`MFReadWrite.dll` (Media Foundation), `WS2_32.dll` (native Winsock). This corrects the earlier "natively backed by CNG/bcrypt" claim in §3.5.
- **DEFLATE** — `ICSharpCode.SharpZipLib` `DeflaterOutputStream` / `InflaterInputStream` (`StanzaWriter.cs:2,46`, `EncryptedBytesReceiver.cs:2,37`); zlib-equivalent. **Confirmed** managed dependency (no native dep).
- **HKDF-SHA256** — `HkdfSha256.Perform` (managed; lives in `WhatsApp.VoIP/WhatsApp/HkdfSha256.cs` per CLAUDE.md anchor). **Confirmed** name; body not re-read here.

## 5. Linux/Electron Port Mapping

| Windows constant/source | Linux/Electron equivalent | Notes / risk |
| --- | --- | --- |
| Ports `{443,5222,80}`, hosts `g.whatsapp.net` / `e{1..16}` | plain TCP `net.Socket` to same host:port | Hosts/ports are stable values; copy verbatim. Port 443 is primary. |
| Hardcoded fallback IPs (`IpList.cs`) | optional DNS-failure fallback table | These IPs **will drift**; treat as a stale hint, prefer DNS. |
| 3-byte big-endian frame length | manual `Buffer` read/write (`(b0<<16)|(b1<<8)|b2`) | Trivial; cap at `33554432`. |
| `WA` `06 03` + `ED 00 01` headers | byte literals `Buffer.from([0x57,0x41,0x06,0x03])` / `[0x45,0x44,0x00,0x01]` | Dict version byte must stay `3` while using this token table. |
| Noise `XX`/`IK`/`XXfallback _25519_AESGCM_SHA256` | `@noble/curves` x25519 + `@noble/ciphers` aes-256-gcm + Node `sha256`, or `noise-c` binding | Re-implement the exact name buffers (incl. `00` padding for XX/IK 32B). |
| AES-GCM 16-byte tag, 12-byte big-endian-counter nonce | Node `crypto` `aes-256-gcm`, build nonce with counter big-endian right-aligned in 12B | Match `WAProtocol.LongToByteArray(n,12)` exactly. |
| HKDF-SHA256 → 64B split 32/32 | Node `crypto.hkdf('sha256', …, 64)` | Order: chainKey first, cipherKey second. |
| Compression flag `0x02` / `0x00` | Node `zlib.deflateSync` / `inflateSync`; prepend flag byte | Only compress if it shrinks (matches `StanzaWriter`); read with `(b[0] & 2)`. |
| Pinned root key (`WACertificateVerificationUtils.cs:57-63`) | hardcode the 32-byte key; verify Ed-style sig via native curve | Required for server-cert validation in XX/fallback; `VerifyTimeForWA6=false`. |
| `BinTag` + `WAPDefaultTokenDictionary` | port the tag constants + the 3 tables verbatim into TS | This doc is the source of truth; the waweb JS bundle also embeds an equivalent dictionary that can be cross-checked. |
| JID suffixes/separators | string constants | Copy verbatim from §3.11. |
| `ClientPayload` enums | protobufjs with the same enum values | `Platform.WINDOWS=13`, `release_channel=RELEASE=0`, etc. |

**Reuse from waweb bundle:** the minified WhatsApp Web JS in `waweb-source-bundle/` carries its own binary-node token dictionary and Noise framing; it is the highest-fidelity cross-check for the token tables here, but the *dictionary version* and a few platform-specific tokens differ from the native v3 table, so verify version byte before trusting it for the native edition.

## 6. Open Questions / Unverified

Every item below was re-investigated this pass against the decompiled C#, the `waweb-source-bundle` JS, and the shipped `x64/*.dll` native binaries; each now carries a bold verdict tag, the concrete finding, and a citation. The original question text is preserved.

1. **[RESOLVED] Live media hosts.** *Original Q: `mmg.whatsapp.net` / `mmg-fallback.whatsapp.net` are only present as dictionary tokens; the actual upload/download host+auth is fetched via the `media_conn` IQ at runtime. Not statically pinned.* — Confirmed not static and the runtime shape is now known. The `media_conn` IQ response carries `hostname`, `fallback_hostname`, `auth`, `auth_ttl`, `ttl`, `max_buckets`, `download_buckets`, `primary`, `secondary` (grep `media_conn` and the adjacent attribute tokens in `waweb-source-bundle/n6o0-NaJTww.js`). No static media-host array exists near `IpList.cs`; the `mmg*` strings are only dictionary entries (primary 139/134) so the dynamic host strings encode compactly. Folded into §3.2. The exact live host *values* remain runtime/server-issued by design (they rotate) — that part is correctly non-constant.

2. **[RESOLVED] X25519 ECDH + XEdDSA signatures — native-confirmed via radare2 (doc 96); only the instruction-level `Sign` body is unread, and that is moot for the port.** *Original Q: the literal `9` basepoint and the signature-verify routine are in native `WhatsAppNative`/`WhatsAppRust`, not surfaced in C#.* — Confirmed the C# layer holds NO curve internals: `Curve22519Extensions` (`Curve22519Extensions.cs:14-48`) is a pure thin wrapper that calls native `WhatsAppNative.Curve25519` for `GenKeyPair`, `Derive`, `Sign` (`:32-35`), `Verify` (`:37-48`), with key/sig lengths queried at runtime (`GetKeyLength`/`GetSignLength`) — no basepoint, no scalar-mult, no `9` literal in managed code. The native class is real: `strings WhatsAppNative.dll` shows `Curve25519@WhatsAppNative`, `__Curve25519ActivationFactory`, and the class exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}`. **Signature scheme — now NATIVE-CONFIRMED (Curve25519 XEdDSA, 64-byte), byte-evidenced in `x64/WhatsAppNative.dll` via radare2 (doc 96 §2):** the X25519 Montgomery-ladder constant **`a24 = 121665` (`0x0001DB41`, `/x 41db0100` → 3 hits, two adjacent at `0x180a38b60`/`…b68` in the field-constant table)** is statically present (the X25519 ECDH fingerprint); **SHA-512** (`K[0]=0x428a2f98d728ae22` at `0x1808b969c`) is statically present and, with `Sign`/`Verify` living on the *same* class that does X25519 `Derive`, fingerprints **XEdDSA-over-Curve25519** (XEdDSA signs with the Montgomery key and hashes with SHA-512 — not a distinct Ed25519/Edwards-key type). This matches libsignal `xed25519_sign`/`curve25519_sign`; a Linux port can use `@signalapp/libsignal-client` and be bit-compatible (doc 96 §2). The interop cross-refs (below) independently corroborate the same primitive and the hard 64-byte length, but the scheme no longer rests on them — it is read from the binary:
   - *cross-reference: whatsmeow* — depends on `go.mau.fi/libsignal v0.2.2` (`go.mod:12`); signs/verifies via `ecc.CalculateSignature`/`ecc.VerifySignature` over `NewDjbECPrivateKey`/`NewDjbECPublicKey` (Curve25519). Length is hard-checked at 64 bytes: noise cert-chain verify rejects `len(...Signature) != 64` (`whatsmeow/handshake.go:156-168`), and ADV pairing rejects `len(AccountSignature) != 64` / `AccountSignatureKey != 32` (`whatsmeow/pair.go:265-278`, `:281-285`).
   - *cross-reference: Baileys* — `sign = (priv, buf) => curve.calculateSignature(priv, buf)` from `libsignal/src/curve` (`Baileys/src/Utils/crypto.ts:2,27,30`); `verify` via `curve.verifySignature` over the version-prefixed 33-byte pubkey.
   - *cross-reference: waweb bundle* — the WA-Web client's own `calculateSignature` routes through `WAWebCryptoLibraryUtilsApi.signMsg(pubKey, privKey, msg)` (`waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:5317`, with 230 `calculateSignature` references) — the same libsignal curve API the native `WhatsAppNative.Curve25519::Sign` must mirror to interoperate.

   So the *scheme* the native `Curve25519::Sign` implements is **Curve25519 XEdDSA producing a 64-byte signature**, and this is now **byte-evidenced** in `x64/WhatsAppNative.dll` (the `a24=121665` and SHA-512 constants above, doc 96 §2) — no longer resting on interop inference. The only residual is the **instruction-level `Sign` body** (exact basepoint encoding, scalar clamping, XEdDSA nonce/hash-to-point steps), which lives in un-symbolised native code — and it is **moot for the port**, because the confirmed scheme + a bit-compatible library (`@signalapp/libsignal-client`) fully determine wire behaviour. Supporting [native-binary] evidence from `x64/WhatsAppNative.dll` (PE32+, x86-64, MSVC; `rabin2 -I`):
   - *[native-binary] symbol surface:* the only WinRT type markers are `.?AVCurve25519@WhatsAppNative@@`, `.?AV__Curve25519ActivationFactory@WhatsAppNative@@`, `.?AU__ICurve25519PublicNonVirtuals@WhatsAppNative@@` (`strings WhatsAppNative.dll`). The DLL exports only `DllCanUnloadNow` + `DllGetActivationFactory` (`rabin2 -E`) and has **no exported FUNC entries** (zero per-routine symbols), so `Curve25519::Sign` is reachable only by walking the activation-factory vtable; there is no named `Sign`/`Verify`/`ge_*`/`fe_*` symbol to land on. (This is why the constants — not the symbols — carry the identification.)
   - *[native-binary] static linkage, not name-stamped:* a `strings` scan for `ed25519`/`xeddsa`/`libsignal`/`ref10`/`curve25519-donna`/`sodium`/`boringssl`/`fiat`/`openssl` returns nothing in either `WhatsAppNative.dll` or `WhatsAppRust.dll` — the curve/symmetric crypto is statically linked with no provenance string. That is **immaterial for the port**: the scheme is fixed by the round-constant fingerprints (doc 96), and the basepoint/field constants need not appear in canonical 32-byte LE form because a static curve library (e.g. BoringSSL/fiat-crypto) stores them in packed-limb radix, not greppable little-endian. The DLL embeds a statically-linked WebRTC media build (build path `buck-out\v2\art\wa_voip\__wafbsource__webrtc_latest__\…`, 3 occurrences resolving to `rtc_base/checks.h`/`buffer.h`/`numerics/safe_conversions.h`); its WebRTC crypto strings are sframe/SRTP media-key crypto only (`.?AVWASframeKeyCrypto@crypto@sframe@wa@@`, `generate_sframe_keys_for_participant`, an `hkdf_sha256` callback) — call-media encryption, a separate stack from the Signal/Noise signing path. `rabin2 -i` / `objdump -p` confirm the `bcrypt.dll` import set is RNG-only (`BCryptGenRandom`/`BCryptOpenAlgorithmProvider`/`BCryptCloseAlgorithmProvider` — no `BCryptEncrypt`/`BCryptDeriveKeyPBKDF2`/`BCryptHashData`); the sibling `WhatsAppRust.dll` (Meta "wamedia" media libraries) likewise imports only `ProcessPrng` from `bcryptprimitives.dll` (RNG-only) and carries no curve-provenance strings.
   - *interop corroboration (now secondary):* the [protocol-cross-ref] evidence — whatsmeow `go.mau.fi/libsignal v0.2.2` with hard `!= 64` signature / `!= 32` key checks (`pair.go:265`, `handshake.go:156-168`); Baileys `curve.calculateSignature` (`crypto.ts:2,27`); the waweb `WAWebCryptoLibraryUtilsApi.signMsg` — independently confirms the same XEdDSA primitive and 64-byte length. It is consistent with, and now confirmatory of, the binary-read scheme rather than its sole basis.

3. **[RESOLVED] Wire value of `Platform` on the *resume* path.** *Original Q: only the full ClientPayload build was read; whether any other path overrides `WINDOWS` was not exhaustively checked.* — Exhaustively checked. `BuildClientPayload()` (`HandshakeHandler.cs:226-264`) is the **only** payload constructor and is the single place a `platform` is set (`:241` → `Platform.WINDOWS`). A tree-wide grep for `platform =` / construction finds no other emit site; the three `instance.platform = (Platform)ProtocolParser.ReadUInt64(...)` hits (`ClientPayload.cs:385,454,525`) are deserialization. The same `BuildClientPayload()` is called by the resume/IK path (`SendClientResume`, `:91`), the full-XX path and the XX-fallback path (both via `ReceiveServerHello`, `:202`). Therefore every handshake variant sends `WINDOWS=13`. Folded into §3.12.

4. **[RESOLVED] `edition`/`abprops` defaults.** *Original Q: `binary_version` exists as a token but the exact transmitted edition string was not located as a single literal.* — There is no separate "edition string" on the wire; the question rested on a false premise. (a) `binary_version` is purely a **token-dictionary entry** (sub-dict 0 index 199), not an edition value — confirmed both in the native table (§3.10) and in the waweb bundle where `"binary_version","018"` sits inside the embedded dictionary array between `suspended_group_deletion_notification` and `https://www.whatsapp.com/otp/copy/` (`waweb-source-bundle/n6o0-NaJTww.js`). (b) `abprops` is a **local SQLite DB name** (`AbPropsRoot.cs:28` `DbName = "abprops"`, opened as `abprops.db` at `:60`) caching server-pushed A/B property values — runtime data, not a static constant. (c) The only edition-like identity actually transmitted is the `UserAgent`: `platform=WINDOWS` (`HandshakeHandler.cs:241`), `release_channel=RELEASE` (`Constants.cs:178`), `AppVersion 2.2607.106.0` (read dynamically, §3.1) — there is no additional edition literal to find. The `Production` release channel comes from `BuildDetails.CurrentReleaseChannel` (`BuildDetails.cs:9`) and is distinct from the wire `release_channel`.

5. **[RESOLVED] `HkdfSha256.Perform` body and `AesGcmProvider` WinRT algorithm id.** *Original Q: confirmed by call sites/signatures (tag=16, nonce=12) but internal implementations were not line-read.* — Both bodies are now line-read. HKDF is textbook **RFC 5869**: `HkdfSha256.Perform` → `Hkdf.Perform(key, salt, info, keyLen, 32, HMACSHA256)` (`HkdfSha256.cs:7-16`); `Extract` substitutes 32 zero bytes for null salt then `PRK = HMAC(salt, key)` (`Hkdf.cs:15-22`); `Expand` builds `T(n)=HMAC(PRK, T(n-1)‖info‖byte(n))` with the counter starting at 1, truncated to `keyLen` (`Hkdf.cs:24-44`). AES-GCM uses WinRT algorithm id `SymmetricAlgorithmNames.AesGcm` via `CryptographicEngine.EncryptAndAuthenticate`/`DecryptAndAuthenticate`, tag from `AuthenticationTag`, AAD passed `null` when empty (`AesGcmProvider.cs:15,27-28,40,45-59`), serviced by the OS WinRT crypto stack (`Windows.Security.Cryptography.Core`). Both folded into §3.5. (Correction this pass: the earlier "natively backed by CNG `bcrypt.dll`" wording was an overstatement — `WhatsAppNative.dll`'s `bcrypt.dll` imports are RNG-only; see §3.5/§4 [native-binary].)

6. **[RESOLVED] `fallback_ip4`/`fallback_ip6` and edge-routing are server-pushed, not constants.** *Original Q: these tokens (primary 57/64) imply server-pushed fallback IPs during handshake; concrete values are dynamic.* — Confirmed dynamic and the mechanism is now traced. The values are parsed at runtime from a routing stanza: `ip4: e.maybeAttrString("fallback_ip4")`, `ip6: e.maybeAttrString("fallback_ip6")`, alongside `fallback_class` (`waweb-source-bundle/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js`). On the native client the persisted edge-routing blob (settings DB key `163L`, an opaque `byte[]` — `SeamlessMigrationManager.cs:519`) is passed straight into the handshake as `edgeRoutingInfo` and emitted in the `ED 00 01` edge prologue before the `WA` header (`HandshakeHandler.cs:147-157`, see §3.4). So both `fallback_ip4/6` and `edge_routing`/`routing_info` are server-issued, per-session values — correctly non-constant. The concrete IPs would only be visible in a live wire capture.
