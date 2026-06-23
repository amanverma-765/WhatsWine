# 21. Authentication & Companion Device Pairing

> Target: Meta native **WhatsApp for Windows** (WhatsApp.Root.exe, WinUI 3 / Windows App SDK, hybrid WebView2 + native).
> All paths below are relative to `decompiled_source/` unless noted. Line citations are `path:LINE` and were read directly. Claims I could not anchor in code are explicitly marked **(inference)**.

---

## 1. Purpose & Scope

This document covers how the native Windows client **authenticates an already-registered companion device to the WhatsApp servers** and how it participates in **multi-device (MD) companion registration / pairing** (QR-code pairing and phone-number "link with code" pairing).

The single most important architectural fact, confirmed in code, is:

> **WhatsApp for Windows is a *registered companion device*, never a primary.** The phone (primary) holds the WhatsApp account; the desktop is one of its linked devices. The entire *pairing* protocol (QR generation, ADV identity construction, account-/device-signature math, X3DH session setup) lives in the **WebView2 JavaScript bundle** (`waweb-source-bundle/`). The native C# layer contributes only three narrow things:
> 1. The **Noise handshake + login `ClientPayload`** that re-connects an already-linked device (`HandshakeHandler.cs`).
> 2. A **Curve25519 signature-verify** primitive exposed to JS as the `AdvBridge` host object (`AdvBridgeAdapter.cs`).
> 3. **Persistence of the account login key material** (`ClientKey`, `ServerEncKeySalt`) across the JS↔native boundary, plus per-account on-disk session isolation (`ClientKeyController.cs`, `LoginSessionManager.cs`).

Concretely, the native `WAProtocol.ProcessMultiDeviceRegistrationNode` is a stub:

```csharp
// WAProtocol.cs:189
private void ProcessMultiDeviceRegistrationNode(ProtocolTreeNode node)
{
    throw new NotImplementedException();
}
```

So the native transport never *drives* registration; it only carries the registration/pairing stanzas to and from JS over the encrypted FunXMPP channel. This doc therefore traces both sides: the native authentication/login path (deep, line-by-line) and the JS pairing protocol (from the bundle, sufficient to port).

Out of scope: the Noise framing/crypto internals (see the networking-core doc), the Signal double-ratchet session math (see crypto-signal doc), and SQLite storage internals (storage-data doc). Those are referenced where pairing depends on them.

---

## 2. Where It Lives

### Native C# (decompiled/)

| Concern | File |
|---|---|
| ADV signature-verify bridge adaptee | `decompiled/WhatsApp.Root/WhatsApp.Bridge/AdvBridgeAdapter.cs` |
| ADV bridge WinRT projection / interface | `decompiled/WhatsApp.Root/WinRTAdapter/AdvBridge.cs`, `.../IAdvBridgeToNative.cs` |
| Login key (ClientKey) controller | `decompiled/WhatsApp.Root/WhatsApp.Bridge/ClientKeyController.cs` |
| ClientKey bridge projection / interface | `decompiled/WhatsApp.Root/WinRTAdapter/ClientKeyBridge.cs`, `.../IClientKeyBridgeToNative.cs` |
| ServerEncKeySalt controller | `decompiled/WhatsApp.Root/WhatsApp.Bridge/ServerEncKeySaltController.cs` |
| ServerEncKeySalt bridge projection / interface | `decompiled/WhatsApp.Root/WinRTAdapter/ServerEncKeySaltBridge.cs`, `.../IServerEncKeySaltBridgeToNative.cs` |
| Login-session persistence + per-account isolation | `decompiled/WhatsApp.VoIP/WhatsApp.LoginSession/LoginSessionManager.cs`, `SessionData.cs`, `SessionDataPathUtils.cs`, `ILoginSessionDataProvider.cs` |
| Noise handshake + login `ClientPayload` builder | `decompiled/WhatsApp.Root/WhatsApp/HandshakeHandler.cs` |
| Handshake handler construction (per connect attempt) | `decompiled/WhatsApp.Root/WhatsAppCommon/ConnectionManager.cs` |
| Auth-state stanza router (`success`/`failure`/`iq`) | `decompiled/WhatsApp.Root/WhatsApp/WAProtocol.cs` |
| Curve25519 verify/sign/derive wrapper | `decompiled/WhatsApp.VoIP/WhatsApp/Curve22519Extensions.cs` |
| Trusted-contact (tc) token bridge adaptee | `decompiled/WhatsApp.Root/WhatsApp.Bridge/TcTokenController.cs` |
| Trusted-contact token in-memory cache | `decompiled/WhatsApp.VoIP/WhatsApp/TrustedContactManager.cs` |
| tc-token bridge WinRT projection / interfaces | `decompiled/WhatsApp.Root/WinRTAdapter/TcTokenBridge.cs`, `.../ITcTokenBridgeToNative.cs`, `.../ITcTokenBridgeToWeb.cs` |
| tc-token consumer (VoIP JID builder) | `decompiled/WhatsApp.VoIP/WhatsAppCommon/VoipBridgeJidFactory.cs` |
| Bridge registration (host objects → JS) | `decompiled/WhatsApp.Root/WhatsApp/AppModel.cs` (`SetWebView`), `decompiled/WhatsApp.Root/WhatsApp/App.cs` (pre-login bridges) |

### Pairing protobuf wire types (decompiled/)

| Type | File |
|---|---|
| `ClientPayload` (login payload) | `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/ClientPayload.cs` |
| `CompanionEphemeralIdentity` | `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/CompanionEphemeralIdentity.cs` |
| `EncryptedPairingRequest` | `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/EncryptedPairingRequest.cs` |
| `DeviceProps` (PlatformType enum, OS metadata) | `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/DeviceProps.cs` |
| `DeviceListMetadata` / `DeviceCapabilities` | `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/DeviceListMetadata.cs`, `DeviceCapabilities.cs` |

### JS bundle (waweb-source-bundle/) — the actual pairing engine

| Module | File (hashed) |
|---|---|
| `WAWebAdvSignatureApi` (account/device signature verify + generate) | `waweb-source-bundle/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:197` |
| `WAWebAdvSignatureConstants` (signature prefixes) | `waweb-source-bundle/TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js:1165` |
| `WAWebProtobufsAdv.pb` (ADV protobuf specs) | bundle module `WAWebProtobufsAdv.pb` (see §3.6) |
| `WAWebAdvHandlerApi` (device-sync / notification handling) | `waweb-source-bundle/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:184` |
| Pairing stanza smax builders/parsers (`companion_hello`, `pair-device`, `pair-success`, `pair-device-sign`, `link_code_companion_reg`, `companion_reg_refresh`/`pair-device-rotate-qr`) | various smax modules in the bundle (grep anchors in §3.4) |

### Android cross-reference (android/jadx_output/)

ADV protobuf + `pair-device`/`pair-success`/`companion_hello` symbols appear in obfuscated Java at e.g. `android/jadx_output/sources/p000X/C25040xN.java`, `DA9.java`, `C0CS.java`, `C1WL.java`, `C34041Vk.java` (confirmed by grep; the obfuscation makes line-precise citation low-value, but it confirms the protocol is shared with Android).

---

## 3. How It Works

### 3.0 Two distinct flows

There are two separate things people call "authentication":

* **A. Login (reconnect of an already-linked device).** Native-driven. Runs on every connect. Carries a `ClientPayload` with the device's `Username` (phone number as uint64) + `Device` id inside the Noise `XX`/`IK`/`XXfallback` handshake. This is what makes the desktop appear "online".
* **B. Companion registration / pairing (first-time link).** JS-driven. Runs once when a brand-new device is linked via QR scan or phone-number code. Produces the `ClientKey` (the device's Signal identity / login secret) which JS then hands down to native via `ClientKeyBridge.SetClientKey` so subsequent **A** logins can happen.

The hand-off point between B and A is `ClientKeyController.SetClientKey` (§3.3).

---

### 3.1 Login authentication — the Noise `ClientPayload` (native)

When `ConnectionManager` opens a socket it builds a `HandshakeHandler` per attempt:

```csharp
// ConnectionManager.cs:225
HandshakeHandler handshakeHandler = new HandshakeHandler(
    clientStaticPrivate, clientStaticPublic, null /*serverStaticPublic*/, username,
    new FramesWriter(socket), isLidDbMigrated, edgeRoutingInfo, pushName, myDeviceId);
```

The handshake (`HandshakeHandler.cs`) runs Noise in one of three modes, selected by `WriteInitialStanza` (`HandshakeHandler.cs:147-166`) based on whether a cached server static key (`_serverStaticPublic`) exists:

* **`XX` (fresh):** no cached server static ⇒ `SendClientHello()` (`HandshakeHandler.cs:66`) opens with `HandshakeCipher.FULL_HANDSHAKE` (`:68`). The server reply is routed through `ReceiveServerHandshake` → `ReceiveServerHello` (`:137,175`).
* **`IK` (resume):** cached server static present ⇒ `SendClientResume(_serverStaticPublic)` (`:76`) with `HandshakeCipher.RESUME_HANDSHAKE` (`:78`); the reply is handled by the dedicated `ReceiveServerResume` (`:115-135`), which decrypts the server payload and **pins the server certificate** via `WACertificateVerificationUtils.ValidateCertificate(array, serverStaticPublic, DateTime.Now, 6)` (`:130`), throwing `InvalidOperationException("Untrusted server cert")` on failure.
* **`XXfallback`:** if a resume attempt is in flight but the server's `ServerHello` carries a `Static` (it did not recognize the resume), `ReceiveServerResume` delegates to the dedicated `ReceiveServerFallback` (`:122-124,168-173`), which re-initializes the cipher with `HandshakeCipher.FALLBACK_HANDSHAKE` (`:170`) and falls through to the full `ReceiveServerHello`.

`TryHandshake` (`:101-108`) picks `ReceiveServerResume` when `_serverStaticPublic != null` (and not companion registration), else `ReceiveServerHandshake`. Both the fresh-`XX` and fallback paths terminate in `ReceiveServerHello` (`:175`), which **also** pins the cert via `ValidateCertificate(array2, array, DateTime.Now, 6)` (`:194`) and then caches the verified server static into `SeamlessMigrationAppSessionStorage.ServerStaticPublicKey` (`:198`) to enable `IK` resume next connect. The `dictVersion` argument `6` to `ValidateCertificate` matches `WaProtocolVersion = 6`.

After the ephemeral/static key exchange, the client's authenticated payload is the **login identity**:

```csharp
// HandshakeHandler.cs:226 BuildClientPayload()
return ClientPayload.SerializeToBytes(new ClientPayload
{
    Username  = string.IsNullOrEmpty(_username) ? null : ulong.Parse(_username), // field 1
    Passive   = true,                                                            // field 3
    PushName  = _pushName,                                                       // field 7
    Device    = _myDeviceId,                                                     // device/agent id
    connect_type = CurrentConnectionType(),
    Pull      = _connectInPullMode,
    UserAgentField = new ClientPayload.UserAgent
    {
        platform = ClientPayload.UserAgent.Platform.WINDOWS,                     // = 13
        AppVersionField = { Primary, Secondary, Tertiary, Quaternary },         // from PackageInfo.Version
        Mcc = "000", Mnc = "000",
        OsVersion = $"{Major}.{Minor}.{Build}",
        Manufacturer = DeviceStatusEas.Instance.Manufacturer,
        Device = $"{Name} H{HardwareVersion}",
        OsBuildNumber = Build.ToString(),
        LocaleLanguageIso6391 = lang,
        LocaleCountryIso31661Alpha2 = locale,
        release_channel = Constants.ReleaseChannel
    },
    connect_reason = ClientPayload.ConnectReason.USER_ACTIVATED,
    LidDbMigrated = _isLidDbMigrated
});
```

Confirmed protobuf field tags (from `ClientPayload.cs` Serialize):
* `Username` → wire tag **8** (field 1, `uint64`) — `ClientPayload.cs` Serialize writes `WriteByte(8); WriteUInt64(Username)`; the deserialize twin reads it at `ClientPayload.cs:1949`. The username is the **phone number** parsed from a string (`HandshakeHandler.cs:233 ulong.Parse(_username)`).
* `Passive` → wire tag **24** (field 3, `bool`) — `ClientPayload.cs:1951`. Set `true` for companion login.
* `PushName` → wire tag **58** (field 7, `bytes/UTF8`) — `ClientPayload.cs:2592` (Serialize); read twin at `:2182`.
* `Pull` → `bool` (field 8) — `ClientPayload.cs:1886,2291`.
* `Device` (top-level) → `uint32` — `ClientPayload.cs:1866,2019`.

`Platform.WINDOWS` is enum value **13** (enum base is `ANDROID = 0`, full sequence confirmed at `ClientPayload.cs:61-96`: `ANDROID(0), IOS(1), WINDOWS_PHONE(2), BLACKBERRY(3), BLACKBERRYX(4), S40(5), S60(6), PYTHON_CLIENT(7), TIZEN(8), ENTERPRISE(9), SMB_ANDROID(10), KAIOS(11), SMB_IOS(12), WINDOWS(13), WEB(14), …`; WINDOWS is the **14th** member ⇒ value **13**). `connect_type` is derived from the radio type (`HandshakeHandler.cs:212 CurrentConnectionType`).

The protocol header that precedes the handshake is `WA` `0x06` `<dictVersion>`:

```csharp
// HandshakeHandler.cs:47
byte[] obj = new byte[4] { 87, 65, 6, 0 };   // 'W','A', 6, (dictVer placeholder)
obj[3] = (byte)FunXMPP.Dictionary.GetDictionaryVersion();
```

`WaProtocolVersion = 6` (`HandshakeHandler.cs:11`). An optional edge-routing prefix `ED\0\x01` (`{69,68,0,1}`, `HandshakeHandler.cs:50`) is written first when `edgeRoutingInfo` is present (`WriteInitialStanza`, `HandshakeHandler.cs:147`).

**Server response → auth state machine** (`WAProtocol.cs:84 ProcessAuthenticationNode`):
* `<success t=…>` → `_isLoggedIn = true`, saves server time from attr `t`, fires `LoggedIn` (`WAProtocol.cs:86-92`).
* `<failure>` → parses `reason` into `LoginFailedReason`; `reason > 500` ⇒ `ServerBackoffRequest`; `TempBanned` consumes `expire`/`code`/`retry` to compute `BanExpirationUtc`/`RetryUtc` (`WAProtocol.cs:94-138`). Throws `LoginFailureException`.

> Note: the native handshake's `clientStaticPrivate/Public` (the **Noise** static keypair) is *not* the same as the Signal identity key; it is extracted by `SeamlessMigrationManager.ExtractClientKeys()` (`SeamlessMigration/SeamlessMigrationManager.cs:601-627`) from `NonDbSettingsId.StaticPrivateKey/StaticPublicKey`. The cached server static key persists at `SeamlessMigrationAppSessionStorage.ServerStaticPublicKey` (`HandshakeHandler.cs:198`) to enable the faster `IK` resume next time.

---

### 3.2 The ADV bridge — native's only pairing-crypto contribution

The entire `AdvBridge` host object exposes exactly **one** method (`IAdvBridgeToNative.cs:13`):

```csharp
IAsyncOperation<bool> Verify(string messageBase64, string signatureBase64, string signKeyBase64);
```

Implementation (`AdvBridgeAdapter.cs:21`):

```csharp
private async Task<bool> Verify(string messageBase64, string signatureBase64, string signKeyBase64)
{
    await _dispatcher.ContinueIn("Verify", ...);          // serial ConcurrentQueueDispatcher (line 14)
    byte[] message   = Convert.FromBase64String(messageBase64);
    byte[] signature = Convert.FromBase64String(signatureBase64);
    byte[] signKey   = Convert.FromBase64String(signKeyBase64);
    return Curve22519Extensions.Instance.Verify(message, signature, signKey);  // line 29
}
```

`Curve22519Extensions.Verify` delegates to the native `WhatsAppNative.Curve25519` WinRT class and swallows exceptions to `false` (`Curve22519Extensions.cs:37-48`). So native ADV = "verify a Curve25519 (XEdDSA-style) signature over an arbitrary message with an arbitrary public key", nothing pairing-specific. Everything pairing-specific (which message, which prefix, which key) is decided in JS and passed as three base64 strings.

The `WhatsAppNative.Curve25519` C# side is itself only a **WinRT/COM projection stub**, not the implementation: its `Sign`/`Verify`/`Derive`/`GenKeyPair` each forward across the ABI boundary via `__ICurve25519PublicNonVirtualsMethods.<name>(_objRef_global__WhatsAppNative___ICurve25519PublicNonVirtuals, …)` ([decompiled-C#] `WhatsAppNativeProjection/WhatsAppNative/Curve25519.cs:129-157`). The real curve math lives inside `WhatsAppNative.dll`'s statically-linked native code; the projection only marshals byte buffers into it (this is why the byte-level signature impl is not visible from the managed dump — see §6 item 4).

It is registered as a host object named **`AdvBridge`** *after login* (model bridges):

```csharp
// AppModel.cs:237
webView.AddWinRTBridge("AdvBridge", new AdvBridge(new AdvBridgeAdapter()), dispatchAdapter);
```

so JS reaches it as `window.chrome.webview.hostObjects.AdvBridge.Verify(...)`. Notably, `AdvBridgeAdapter` is constructed inline with **no dependencies** — it is a pure stateless crypto shim.

> Interesting asymmetry: native exposes only `Verify`, not `Sign`. **Confirmed wiring (§6 item 6):** the bundle reaches native verify through the `WAWebWindowsHybridBridgeAdv` wrapper, with `$1 = hostObjects.AdvBridge`. The actual minified body (`waweb-source-bundle/U2j2EhR17gV.js`) is `verifySignatureAsync = function*(e,t,n){ return yield this.$1.verify(encodeB64(t), encodeB64(n), encodeB64(e)); }` — i.e. the JS params `(e,t,n)` are `(signKey, message, signature)`, so the call passes `verify(encodeB64(message), encodeB64(signature), encodeB64(signKey))`. That lines up positionally with the native contract `Verify(messageBase64, signatureBase64, signKeyBase64)` → `Curve.Verify(message, signature, signKey)` (`AdvBridgeAdapter.cs:16,21,29`, `IAdvBridgeToNative.cs:13`). Signature **generation** is JS-only: `WAWebCryptoCurve25519CalculateSignature` → `WAWebCryptoLibraryUtilsApi.signMsg(pubKey, privKey, msg)` (`waweb-source-bundle/SjCAw3j6…WiG.js`); it does **not** round-trip signing through native. The bundle also has its own verifier `WASignalSignatures.verifyMsgSignalVariant(pubKey, msg, ensureSize(sig,64))` — note the **64-byte** Signal-variant signature — so it can verify without native. Note also that `Curve22519Extensions` *does* contain a `Sign` (`Curve22519Extensions.cs:32-35`), but it is **not** wired to any ADV host-object method, so no native ADV-signing path exists. Native `Verify` is thus a real (used) trusted-compute path on Windows, while the bundle remains self-sufficient for both sign and verify.

---

### 3.3 Login key material across the boundary — `ClientKey` & `ServerEncKeySalt`

After a successful pairing (flow B), the JS Signal layer produces the device's master login secret and pushes it to native.

> **What `ClientKey` actually is (confirmed from the bundle, §6 item 2):** it is the **base64-encoded Noise *static private key***, not the Signal identity key. The bundle's `WAWebStartBackend.startBackendRegistered` (`waweb-source-bundle/xTiXmyjNEd_.js:473`), gated on the `WINDOWS_PENDING_CLIENT_KEY_SETUP` flag, runs `s = WAWebUserPrefsMultiDevice.getNoiseInfo().staticKeyPair.privKey; getClientKeyBridge().setClientKey(WABase64.encodeB64(s))`. Native stores it and, on every reconnect, `SeamlessMigrationManager.ExtractClientKeys()` reads it back as `NonDbSettingsId.StaticPrivateKey(=16)`/`StaticPublicKey(=17)` (`SeamlessMigrationManager.cs:601-627`) and feeds it as `clientStaticPrivate/Public` into the flow-A Noise handshake (`SeamlessMigrationManager.cs:563` → `ConnectionManager.cs:225` → `HandshakeHandler`). So the persisted `ClientKey` *is* the `clientStaticPrivate` of §3.1 — clearing it (logout) drops the device's Noise transport identity.

`ClientKeyController` (`ClientKeyController.cs`) implements `IClientKeyBridgeToNative` (`SetClientKey`/`ClearClientKey`/`GetClientKey`, `IClientKeyBridgeToNative.cs:13-17`):

```csharp
// ClientKeyController.cs:21
private async Task SetClientKeyImpl(string clientKey)
{
    byte[] clientKey2 = clientKey.IsNullOrEmpty() ? null : Convert.FromBase64String(clientKey);
    await loginSessionManager.Login(clientKey2);     // → §3.7
}

// ClientKeyController.cs:32  ClearClientKey ⇒ logout
await loginSessionManager.Logout();
...
App.Instance?.Restart(ControlledRestartTypes.UserLogout, "Logging out", restartToTray:false); // line 44
```

So **clearing the ClientKey (logout) forces a full app restart.** `GetClientKey` returns the persisted key base64 or `""` (`ClientKeyController.cs:48`).

`ServerEncKeySaltController` (`ServerEncKeySaltController.cs`) is the twin for `ServerEncKeySalt`: `SetServerEncKeySalt`/`ClearServerEncKeySalt`/`GetServerEncKeySalt` → `LoginSessionManager.SetServerEncKeySalt`/`ClearServerEncKeySalt` (`ServerEncKeySaltController.cs:18-47`). **Its purpose is now confirmed (§6 item 3): it is the salt for the local database encryption keys, not server backup.** The bundle reads it back via `serverEncKeySaltBridge.getServerEncKeySalt()`, base64-decodes it, and feeds it to `WAWebDbEncryptionKey.DbEncKeyStore.generateFinalDbEncryptionAndFtsKey(b)` + `WAWebCryptoEncKeyHelper.generateFinalDbEncryptionAndFtsKeyForInvoker(b)` (`waweb-source-bundle/xTiXmyjNEd_.js:473`, the `WINDOWS_OFFLINE` branch) — i.e. it derives the **final DB message-encryption key and the FTS (full-text-search index) key** for the WhatsApp-Web at-rest store. Native only persists/round-trips it.

Both are registered as host objects (`AppModel.cs:225,241`):

```csharp
webView.AddWinRTBridge("ClientKeyBridge",        new ClientKeyBridge(_clientKeyController),        dispatchAdapter);
webView.AddWinRTBridge("ServerEncKeySaltBridge", new ServerEncKeySaltBridge(_serverEncKeySaltController), dispatchAdapter);
```

The WinRT IIDs (stable contract identifiers) are:
* `IAdvBridgeToNative` GUID `BF792BBF-45F9-505E-9F38-3354198005FA` (`IAdvBridgeToNative.cs:9`)
* `IClientKeyBridgeToNative` GUID `EF263A8F-E156-5407-A883-85FA9BBE11DE` (`IClientKeyBridgeToNative.cs:9`)
* `IServerEncKeySaltBridgeToNative` GUID `A51F7515-2926-576A-961D-347711C511EE` (`IServerEncKeySaltBridgeToNative.cs:9`)

---

### 3.4 Companion registration / pairing protocol (JS bundle)

The native side never builds these stanzas. The registration code path *exists* but is **provably dead in this build** (§6 item 7): `WAProtocol.ProcessStanza` routes to `ProcessMultiDeviceRegistrationNode` only when `_isCompanionRegistration` is true (`WAProtocol.cs:38-40`), and that method throws `NotImplementedException` (`WAProtocol.cs:189-191`); but the only `WAProtocol` construction site hardcodes `isCompanionRegistration: false` (`SocketAdapter.cs:75`) and `HandshakeHandler._isCompanionRegistration` is a constant `false` (`HandshakeHandler.cs:52`). So registration is constructed/parsed exclusively in the bundle via the `smax` schema framework. Confirmed stanza shapes from the bundle:

**QR pairing (scan the QR with the phone):**
* The desktop generates an **ADV secret key** (32 random bytes) and a **companion ephemeral keypair**; the QR encodes a `ref` plus the companion public keys. The bundle module `WAWebAdvSignatureApi` generates the secret:
  ```js
  // generateADVSecretKey: 32 random bytes, base64, stored in UserPrefsMultiDevice
  var e=new Uint8Array(32); self.crypto.getRandomValues(e);
  var t=o("WABase64").encodeB64(e);
  yield o("WAWebUserPrefsMultiDevice").setADVSecretKey(t);
  ```
  (`…WiG.js:197`, function `R`/`generateADVSecretKey`).
* Server delivers a `<notification type="companion_reg_refresh">` containing `<pair-device-rotate-qr>` (QR re-rotation) and/or a `<pair-device>` inside an `<iq>` carrying the next QR `ref`(s):
  ```
  iq → flattenedChildWithTag "pair-device" ; from = s.whatsapp.net   (smax parser)
  notification type=companion_reg_refresh → child pair-device-rotate-qr | companion_reg_refresh
  ```
  (grep-confirmed smax parse code in the bundle).

**`pair-success` — the phone approved the link:** server sends an `<iq>` whose child is `<pair-success>` containing `<device-identity>`, `<device>`, `<platform>`, optional `<biz>`:
```
flattenedChildWithTag(iq,"pair-success")
  → device-identity   (ADVSignedDeviceIdentity bytes, see §3.6)
  → device            (the assigned device JID, i.e. user:device@s.whatsapp.net)
  → platform          (primary's platform)
  → biz (optional)
```
The desktop then **counter-signs**: it builds the device signature over the device identity (prefix `[6,1]`, §3.5), and replies with `<pair-device-sign>`:
```
pair-device-sign → device-identity key-index=<INT> <signed-identity-bytes>
```
(smax builder `makeReg…` produces `smax("pair-device-sign", null, smax("device-identity", {"key-index": INT(a)}, i), …)`, grep-confirmed).

**Phone-number "link with code" pairing (`link_code_companion_reg`):** an `<iq>` carries `<link_code_companion_reg>` with children:
* `link_code_pairing_wrapped_primary_ephemeral_pub`
* `primary_identity_pub`
* (companion side sends `link_code_pairing_wrapped_companion_ephemeral_pub`, `companion_server_auth_…`)
and the `companion_hello` stage:
```
iq stage=companion_hello
  → link_code_pairing_wrapped_companion_ephemeral_pub
  → companion_server_auth…
```
(grep-confirmed in bundle). This is the alternative to QR where the user types a code shown on the desktop into the phone; the shared secret is derived from the wrapped ephemeral keys.

**Link-code key wrapping (fully resolved, §6 item 5 — RESOLVED):** the bundle chain in `waweb-source-bundle/SjCAw3j6…WiG.js` is now reconstructed field-by-field, corroborated byte-for-byte by two independent open implementations of the same protocol (cross-reference: whatsmeow `pair-code.go:59-247`, Baileys `Socket/messages-recv.ts:1139-1292`):
1. **Link code → AES-CTR-256 key:** `PBKDF2(SHA-256, password=base32(linkCode), salt=<32-byte salt>, iterations=2<<16 /*=131072*/) → 32-byte AES-CTR key` (bundle WebCrypto `deriveKey({name:"PBKDF2", hash:"SHA-256", …}, linkCode, {name:"AES-CTR", length:256})`; whatsmeow `pair-code.go:65`, Baileys `derivePairingCodeKey`).
2. **Wrap the companion ephemeral:** a companion ADV ephemeral keypair is generated and its 32-byte public key AES-CTR-wrapped under that key. The wire blob is **`salt(32) ‖ iv(16) ‖ encryptedPub(32)` = 80 bytes**, sent as `link_code_pairing_wrapped_companion_ephemeral_pub` in `companion_hello` alongside `companion_server_auth_key_pub` (= the Noise static pub) (whatsmeow `pair-code.go:59-74,117-118`).
3. **ECDH mixing (was the open residual):** decrypt the primary's wrapped ephemeral pub with the **same** PBKDF2/AES-CTR; then `ephemeralSharedSecret = X25519(companionEphemeralPriv, primaryEphemeralPub)` and `identitySharedKey = X25519(companionIdentityPriv, primaryIdentityPub)` (whatsmeow `pair-code.go:191-201,221`).
4. **Key-bundle encryption key:** `keyBundleEncryptionKey = HKDF-SHA256(ikm = ephemeralSharedSecret, salt = keyBundleSalt(random 32), info = "link_code_pairing_key_bundle_encryption_key", L = 32)`; AEAD is **AES-256-GCM** over `companionIdentityPub ‖ primaryIdentityPub ‖ advSecretRandom(32)` with a random 12-byte nonce; wire `link_code_pairing_wrapped_key_bundle = keyBundleSalt(32) ‖ nonce(12) ‖ ciphertext` (whatsmeow `pair-code.go:207-218`, Baileys `messages-recv.ts:1146-1157`).
5. **ADV secret:** `advSecret = HKDF-SHA256(ikm = ephemeralSharedSecret ‖ identitySharedKey ‖ advSecretRandom, salt = nil, info = "adv_secret", L = 32)` → stored as the device's `AdvSecretKey`, which authenticates the later `pair-success` (whatsmeow `pair-code.go:225-227`, Baileys `messages-recv.ts:1158-1160`).

The C# `EncryptedPairingRequest{EncryptedPayload:1, Iv:2}` (`EncryptedPairingRequest.cs:55-59`) is the wire transport for the encrypted payload. (Cross-reference labels: whatsmeow/Baileys are open WA-Web protocol impls the native client interoperates with; bundle strings `link_code_pairing_key_bundle_encryption_key` / `adv_secret` / `PBKDF2,hash:SHA-256` corroborate. The C# layer never builds these — registration is JS-driven, native stub at `WAProtocol.cs:189`.)

---

### 3.5 ADV signature prefixes (exact constants)

From `WAWebAdvSignatureConstants` (`…NiDGbhIdl5… → TSxMupG87E6…js:1165`), verbatim:

```js
var e = new Uint8Array([6,5]),  // ADV_HOSTED_PREFIX_DEVICE_IDENTITY_ACCOUNT_SIGNATURE
    l = new Uint8Array([6,6]),  // ADV_HOSTED_PREFIX_DEVICE_IDENTITY_DEVICE_SIGNATURE
    s = new Uint8Array([6,0]),  // ADV_PREFIX_DEVICE_IDENTITY_ACCOUNT_SIGNATURE
    u = new Uint8Array([6,1]),  // ADV_PREFIX_DEVICE_IDENTITY_DEVICE_SIGNATURE
    c = new Uint8Array([6,2]);  // ADV_PREFIX_KEY_INDEX_LIST_ACCOUNT_SIGNATURE
```

How they are used (from `WAWebAdvSignatureApi`):
* **Account signature** (proves the primary account authorized this device): verify over `Binary.build([6,0], details, devicePubKey)` against `accountSignatureKey` using `verifySignature` (function `$`/`x` in `…WiG.js:197`). Prefix is `[6,5]` instead when the device is a *hosted* business device (`bizHostedDevicesEnabled` + `deviceType==HOSTED`).
* **Device signature** (proves the device accepted the identity): build over `Binary.build([6,1], details, accountSignatureKey)` and verify against the device pub key; generation is `calculateSignature(deviceKeyPair, Binary.build([6,1], details, pubKey))` (functions `M`/`A`/`N`). Hosted → `[6,6]`.
* **Key-index-list account signature**: prefix `[6,2]` (`verifyKeyIndexListSignature`, function `W`).

The verification entry point `validateADVwithIdentityKey` (function `C`/`b`) checks **both** the account signature and the device signature, then decodes `ADVDeviceIdentity` from `details` and calls `WAWebAdvHandlerApi.handleADVDeviceUpdateForMessage` to persist the new device into the device list. If either signature fails it logs `"validateADVIdentity: invalid account signature"` / `"… invalid device signature"` and returns `false`.

---

### 3.6 ADV protobuf wire types (exact field tags)

From `WAWebProtobufsAdv.pb` (bundle), verbatim spec (field numbers are authoritative):

```
ADVEncryptionType (enum): E2EE = 0, HOSTED = 1

ADVKeyIndexList {
  rawId:1 uint32; timestamp:2 uint64; currentIndex:3 uint32;
  validIndexes:4 repeated packed uint32; accountType:5 enum ADVEncryptionType (default E2EE)
}
ADVSignedKeyIndexList {
  details:1 bytes; accountSignature:2 bytes; accountSignatureKey:3 bytes
}
ADVDeviceIdentity {
  rawId:1 uint32; timestamp:2 uint64; keyIndex:3 uint32;
  accountType:4 enum (default E2EE); deviceType:5 enum (default E2EE)
}
ADVSignedDeviceIdentity {
  details:1 bytes;            // an ADVDeviceIdentity, serialized
  accountSignatureKey:2 bytes;
  accountSignature:3 bytes;
  deviceSignature:4 bytes
}
ADVSignedDeviceIdentityHMAC {
  details:1 bytes; hmac:2 bytes; accountType:3 enum (default E2EE)
}
```

The C# `WhatsApp.Protobuf` assembly has the *pairing-transport* twins (used for the QR/companion ephemeral exchange and the encrypted link-code request) but **not** the ADV identity types (those live only in JS, consistent with §3.4):

* `CompanionEphemeralIdentity` (`CompanionEphemeralIdentity.cs`): `PublicKey:1 bytes` (tag 10), `DeviceType:2 DeviceProps.PlatformType` (tag 16), `Ref:3 string` (tag 26) — `CompanionEphemeralIdentity.cs:58-65`. This is what the QR/`ref` encodes.
* `EncryptedPairingRequest` (`EncryptedPairingRequest.cs`): `EncryptedPayload:1 bytes` (tag 10), `Iv:2 bytes` (tag 18) — `EncryptedPairingRequest.cs:55-59`. Used for the AES-encrypted link-code pairing payload.
* `DeviceProps.PlatformType` enum (`DeviceProps.cs:9-35`): `UNKNOWN=0, CHROME, FIREFOX, IE, OPERA, SAFARI, EDGE, DESKTOP, IPAD, ANDROID_TABLET, OHANA, ALOHA, CATALINA, TCL_TV, IOS_PHONE, IOS_CATALYST, ANDROID_PHONE, ANDROID_AMBIGUOUS, WEAR_OS, AR_WRIST(19), AR_DEVICE(20), **UWP=21**, VR(22), CLOUD_API(23)`. The native Windows companion advertises `UWP=21`. **The assignment is now located in the bundle** (§6, item 1): `WAWebProtobufsAdv`'s device-platform builder is `function d(){ if (r("WAWebEnvironment").isWindows) return s.UWP; … }` with the enum `…AR_WRIST:19,AR_DEVICE:20,UWP:21,VR:22,…` (`waweb-source-bundle/SjCAw3j6…WiG.js`, grep `UWP;var e=r("WAWebMiscBrowserUtils")` / `UWP:21`). So `UWP` is selected unconditionally whenever `WAWebEnvironment.isWindows` is true; the C# enum is only the wire definition, the field is filled in JS.

---

### 3.7 Persistence & per-account isolation (native)

`ClientKeyController.SetClientKey` → `LoginSessionManager.Login(byte[] clientKey)` (`LoginSessionManager.cs:86`):

```csharp
SetClientKey(clientKey);                                    // writes settings row key=2
SessionData sessionData = new SessionData { ClientKey = clientKey };
EnsureActiveSessionFolder(sessionData);                     // mkdir sessions\{SHA1(ClientKey)}\
DbConfig cfg = GetNativeSettingsDbConfig(sessionData);
_nativeSettingsStorage.Initialize(cfg);                     // nativeSettings.db (per-session)
byte[] value = EncryptionUtils.SecureRandomBytes(32);
_nativeSettings.Write(SettingsKey.LegacyDbSecret, value);   // fresh 32-byte per-session DB secret
_onLogin.OnNext(sessionData);                               // re-keys genericStorage.db etc.
```

Key facts:
* **Session data DB** `session.db` holds `ClientKey` (`SessionDataKey.ClientKey = 2`) and `ServerEncKeySalt` (`= 3`) as TINYBLOB rows (`LoginSessionManager.cs:16-20, 181, 203`).
* `session.db` is itself encrypted with a secret derived by DPAPI-protecting a hardcoded 16-byte static key: `ProtectionUtils.ProtectBytes(StaticKeyBytes)` then padded/truncated to 32 (`LoginSessionManager.cs:66`, `StaticKeyBytes = {35,167,241,156,17,229,189,120,66,53,201,111,133,210,73,19}` at `:28`).
* The **per-account `nativeSettings.db` secret** is `EncryptionUtils.EncryptBytes(clientKey, StaticKeyBytes)` (AES-CBC-PKCS7 via PBKDF2 wrap), truncated to 32 (`LoginSessionManager.cs:165-176`).
* **On-disk isolation:** every account's DBs live under `…\LocalFolder\sessions\{SHA1(ClientKey)}\` (`SessionDataPathUtils.cs:15`, default hash `"00000"` when logged out, `:9`). The *active* folder is `mkdir`'d on both startup and login (`EnsureActiveSessionFolder`, called from `Initialize()` `:76` and from `Login()` `:94`), but the wipe of **all other `sessions\*` folders** (`WipeInactiveSessionFolders`, `LoginSessionManager.cs:113-136`) runs **only during `Initialize()` at app startup** (`:77`) — it is *not* invoked from `Login(byte[] clientKey)` (`:86-100`, which does `SetClientKey` → `EnsureActiveSessionFolder` → `GetNativeSettingsDbConfig`/`Initialize` → write `LegacyDbSecret` → `_onLogin.OnNext`, with no wipe). Net effect is still single-account-on-disk, but the inactive-folder reaping is a startup-time housekeeping step, not part of the `SetClientKey`→`Login` hand-off.
* `Logout()` (`LoginSessionManager.cs:138-150`) on the **happy path** clears only the ClientKey row via `SetClientKey(null)` (`:143` → `SetSessionData(2, null)` → `_sessionDataStorage.Clear(2)`). Only if that throws does the `catch` delete `session.db` outright (`:148`). `ServerEncKeySalt` (session row 3) is **not** cleared by `Logout()`; it is cleared via the separate `ClearServerEncKeySalt` path (`:152-163`).

---

### 3.8 End-to-end pairing sequence (assembled)

```
PRIMARY (phone)                       SERVER (s.whatsapp.net)        COMPANION (Windows: JS in WebView2 + native shell)
                                                                     ── native opens Noise channel (unauthenticated, no Username) ──
                                                                     JS: generateADVSecretKey() → 32B; gen companion ephemeral keypair
                                                                     JS: render QR( ref, companionPub, advSecretPub )  [CompanionEphemeralIdentity]
   scan QR / type link code  ───────────────────────────────────▶
                                       (primary signs device-identity with account key)
                                       <iq><pair-success><device-identity ADVSignedDeviceIdentity>
                                            <device user:dev@s.whatsapp.net><platform>…  ────────▶ JS
                                                                     JS: validateADVwithIdentityKey()  (account sig [6,0], device sig [6,1])
                                                                     JS: generateDeviceSignature() → counter-sign
                                                                     JS: <pair-device-sign><device-identity key-index=N …>  ───▶ server
                                                                     JS: derive Signal identity ⇒ ClientKey (base64)
                                                                     JS → native: ClientKeyBridge.SetClientKey(clientKey)
                                                                     JS → native: ServerEncKeySaltBridge.SetServerEncKeySalt(salt)
                                                                     native: LoginSessionManager.Login() ⇒ EnsureActiveSessionFolder + LegacyDbSecret (no inactive-folder wipe here; that runs at startup in Initialize())
   ── thereafter, every reconnect is flow A: Noise handshake with ClientPayload{Username=phone#, Device=N, Passive=true} ──
                                       <success t=…>  ───────────────────────────────────────────▶ native _isLoggedIn=true
```

Account-/device-signature verification, the device JID assignment, the QR `ref` rotation (`companion_reg_refresh` / `pair-device-rotate-qr`), and `link_code_companion_reg` are all confirmed from the bundle (§3.4–3.6). The native contribution is limited to the boxed flow-A line plus `AdvBridge.Verify` and key persistence.

---

### 3.9 Trusted-contact (tc) token native provider — `TcTokenBridge` / `TrustedContactManager`

Separate from pairing/login, the native shell hosts a small **per-conversation privacy-token cache** that calling and presence consume. WhatsApp's "trusted contact" (tc) tokens are short opaque blobs the server issues per conversation; they are attached to outgoing call signaling and presence-subscribe stanzas so the recipient can verify the sender is an authorized/known contact (the wire shape `TCTokenMixin` is documented in `17-stanza-families-catalog.md:83,131-132`, and the call-stanza `tcTokenB64` arguments in `41-voip-calling.md:96-99,141,250-255`). The *token bytes* are owned by the JS bundle (it parses them off `<tctoken>` stanzas); native's job is to **cache the latest token per JID** so the synchronous native VoIP JID builder can stamp it onto a `VoipBridgeJid` without re-querying JS.

**Issuance & lifetime protocol (cross-reference: whatsmeow `tctoken.go`; bundle config in `research/waweb-unmin`).** Because native is a pure forwarder, the issuance protocol is recovered from the open WA-Web implementations, which interoperate with the same server: a tc token is requested with an `<iq type=set xmlns=privacy>` to `s.whatsapp.net` carrying `<tokens><token jid=<recipient> t=<unix> type="trusted_contact"/></tokens>` (whatsmeow `tctoken.go:182-200`; the `trusted_contact` type string is grep-confirmed verbatim in the bundle). The cadence is a **rolling-bucket** scheme: bucket length **604800 s = 7 days**, **4 buckets** (~28-day total validity window), re-issued only when the current 7-day bucket index advances past the last issuance bucket, and gated to default/hidden user servers (skipped for PSA/bots) (whatsmeow `tctoken.go:18-55,119-135`). These constants **match the bundle's own server-overridable defaults exactly** — `tctoken_duration:[…,604800,604800]`, `tctoken_duration_sender:[…,604800,604800]`, `tctoken_num_buckets:[…,4,4]`, `tctoken_num_buckets_sender:[…,4,4]` (grep-confirmed in `research/waweb-unmin/*.js`; see §6 item 9). The **opaque internal bytes** of an issued `trusted_contact` token remain server-minted and unreadable from any client (unlike the sibling `cstoken`/NCT token, which the *client* derives as `HMAC-SHA256(NCTSalt, recipientLID)` — whatsmeow `cstoken.go:24-69`).

**The host object.** `TcTokenBridge` is registered **after login** (model bridges) as host object **`TcTokenBridge`** (`AppModel.cs:232`):

```csharp
// AppModel.cs:143  (controller is also constructed here, over the singleton manager)
_tcTokenController = new TcTokenController(TrustedContactManager.Instance);
// AppModel.cs:232
webView.AddWinRTBridge("TcTokenBridge", new TcTokenBridge(_tcTokenController), dispatchAdapter);
```

so JS reaches it as `window.chrome.webview.hostObjects.TcTokenBridge`. Its activatable class id is registered in the package manifest: `<ActivatableClass ActivatableClassId="WinRTAdapter.TcTokenBridge" ThreadingModel="both" />` (`x64/AppxManifest.xml:190`).

**The bridge is bidirectional**, split across two WinRT interfaces:

* **`ITcTokenBridgeToNative`** (GUID `649C16AA-622F-59D5-997A-E95A61DAD009`, `ITcTokenBridgeToNative.cs:8-15`) — what **JS calls on native**:
  ```csharp
  void UpdateTcTokens(string[] jids, string[] tcTokens);   // JS pushes fresh tokens down
  void Subscribe(ITcTokenBridgeToWeb web);                  // JS hands native a callback channel
  ```
* **`ITcTokenBridgeToWeb`** (GUID `FD3BBE46-F1D2-59E3-8307-FB7B19B32AD6`, `ITcTokenBridgeToWeb.cs:8-13`) — what **native calls back up into JS**:
  ```csharp
  void RequestUpdate(string ids);                           // native asks JS to fetch/refresh a token
  ```
  On the projected `TcTokenBridge` RCW this surfaces as the `RequestUpdateEvent` (`EventHandler_String`) the WebView2 side subscribes to (`WinRTAdapter/TcTokenBridge.cs:110-120`; ABI marshaller `ABI.WinRTAdapter/ITcTokenBridgeToWebMethods.cs:25 RequestUpdate`). So the "to-web" direction is delivered as a WinRT **event** carrying the JID string, not a direct call.

**The cache.** `TrustedContactManager` (`TrustedContactManager.cs`) is a process-wide singleton (`Instance`, `:10`) wrapping a single `ConcurrentDictionary<ConvoJid, byte[]>` (`:8`):

```csharp
public void   SetTcToken(ConvoJid jid, byte[] token) { _tokens[jid] = token; }      // :12-15
public byte[] GetTcToken(ConvoJid convoJid) =>                                        // :17-24
    _tokens.TryGetValue(convoJid, out var v) ? v : Array.Empty<byte>();              // miss ⇒ empty array, never null
```

Crucially, the dictionary key is a `ConvoJid`, but `Jid` equality and `GetHashCode` are **purely over the raw JID string** (`Jid.cs:62 (_rawString == _rawString)`, `:70-77 Equals`, `:88-91 GetHashCode`). `ConvoJid` is the abstract base of `UserJid`/`GroupJid`/`BroadcastJid`/`NewsletterJid` (`ConvoJid.cs:6`, `UserJid.cs:7`, `GroupJid.cs:7`, etc.). So a token stored under a `ConvoJid` built by `JidFactory.CreateNewConvoJid` (see below) is retrievable by a `UserJid` with the same string — the concrete subtype is irrelevant, only the string matters. **(porting note: model this as a plain `Map<string, Uint8Array>` keyed by the JID string.)**

**Controller round-trips.** `TcTokenController` (`TcTokenController.cs`) implements `ITcTokenBridgeToNative` and also exposes synchronous/async getters and a `RequestTcToken` used by native callers. It is itself a singleton (`Instance`, `:16`, also over `TrustedContactManager.Instance`).

* **Write path — JS → native (`UpdateTcTokens`)** (`TcTokenController.cs:53-68`): zips the two parallel arrays `jids[]` and `tcTokens[]`, and for each pair parses the JID via `JidFactory.CreateNewConvoJid(jidString)` (`JidFactory.cs:122-134`, which returns `null` for non-convo JIDs), base64-decodes the token, and writes it into the manager via `SetTcToken`. Per-pair failures are swallowed to a `FailuresService.Count(...)` telemetry call ("Failed to parse TC token response from JS") so one malformed entry does not abort the batch.
* **Synchronous read — native → cache (`GetTcToken`)** (`:18-21`): a thin pass-through to `TrustedContactManager.GetTcToken`. This is the hot path used by the VoIP JID builder (below), which must run synchronously.
* **Async read with on-demand fetch (`GetTcTokenAsync`)** (`:23-41`): the interesting one. It first checks the cache; on a hit it returns immediately. On a **miss** it:
  1. sets up an `IObservable<string>` filtered on the `_tokensUpdatedSubject` for exactly this JID (`key == convoJid.ToVoipString()`),
  2. calls `_web?.RequestUpdate(convoJid.ToVoipString())` to **ask JS to fetch the token**,
  3. `await`s the subject with `.Timeout(TimeSpan.FromSeconds(5.0)).FirstOrDefaultAsync()`,
  4. on `TimeoutException` logs `FailuresService.Count("Failed to query trusted contact token within timeout", ...)` and falls through,
  5. returns `trustedContactManager.GetTcToken(convoJid) ?? Array.Empty<byte>()` — i.e. whatever landed in the cache (possibly still empty).

  > **Note a latent wiring gap:** `GetTcTokenAsync` waits on `_tokensUpdatedSubject`, but in this dump **nothing ever calls `_tokensUpdatedSubject.OnNext(...)`** (the only writer would be `UpdateTcTokens`, which writes the cache but does *not* pump the subject). So as decompiled, the await only ever completes via the 5 s timeout, after which it re-reads the cache. The mechanism still works end-to-end (the cache is populated by `UpdateTcTokens` in the meantime), but the "wake up early" signalling appears unconnected. **(inference — flagged; verify against a non-stripped build before relying on early completion.)**
* **`RequestTcToken(UserJid jid)`** (`:43-46`): fire-and-forget — just `_web?.RequestUpdate(jid.ToVoipString())`, no await, used to prime the cache ahead of time.
* **`Subscribe(ITcTokenBridgeToWeb web)`** (`:48-51`): stores the JS-supplied callback channel into `_web`. Until JS calls `Subscribe`, every `RequestUpdate`/`RequestTcToken` is a no-op (`_web?.` is null-conditional). This is the handshake that lets native call *up* into JS.

`ToVoipString()` is the JID's VoIP-form serialization (`Jid.cs:32-35`, default = raw string; subtypes may override) and is the canonical key string used on the to-web channel.

**The consumer.** The native VoIP layer stamps the cached token onto every peer `VoipBridgeJid` it builds for the native VoIP engine. `VoipBridgeJidFactory.ToVoipBridgeJid(this UserJid jid)` (`VoipBridgeJidFactory.cs:53-67`) reads the cache **synchronously**:

```csharp
// VoipBridgeJidFactory.cs:57
byte[] tcToken = TrustedContactManager.Instance.GetTcToken(jid);
return new VoipBridgeJid { str = text, type = type, primaryIdentifier = …, agentId = 0, tcToken = tcToken };
```

`VoipBridgeJid.tcToken` is a `byte[]` field on the native projection struct (`WhatsAppNativeProjection/WhatsAppNative/VoipBridgeJid.cs:115-124`, `get_tcToken`/`set_tcToken`), so the token crosses into the C++/Rust VoIP engine as raw bytes. This is the path used when native builds JIDs itself (e.g. presence/derived JIDs). The complementary path is when **JS already supplies the token inline**: `VoipWebCore.CreateVoipBridgeJid(jidStr, tcTokenB64)` / `CreateVoipBridgeDeviceJid(...)` base64-decode the `tcTokenB64` argument straight into `VoipBridgeJid.tcToken` (`VoipWebCore.cs:438-451, 490-503`), bypassing the cache entirely. So there are **two token sources**: (a) inline `tcTokenB64` from JS on the signaling call (`41-voip-calling.md`), and (b) the `TrustedContactManager` cache populated via `UpdateTcTokens`. Both end up in the same `VoipBridgeJid.tcToken` byte field.

**Lifecycle / persistence.** The native cache is **purely in-memory** (`ConcurrentDictionary`, no DB) and lives on the process-wide `TrustedContactManager.Instance` singleton, so it is **lost on restart** and re-primed lazily by JS via `UpdateTcTokens`/`RequestUpdate`. It is *not* part of the `LoginSessionManager` / `session.db` persistence (§3.7) and is not cleared on logout in this dump (the singleton simply dies with the process). The **durable** copy lives one layer up in the WebView2 bundle: the live IndexedDB carries an **`orphan-tc-token`** object store under `model-storage` ([live-appdata] doc 95 §3; `research/idb_schema.txt` entry 41) — the JS layer persists received tokens there and feeds them back down to native via `UpdateTcTokens`. Both layers only ever **store** the opaque server-minted bytes; neither derives them (§6 item 9). **(inference: tc tokens are treated as ephemeral, server-refreshable material — consistent with them being short-lived privacy tokens.)**

**Round-trip summary.**

```
JS (WebView2 bundle)                         NATIVE (TcTokenController over TrustedContactManager.Instance)         VoIP engine (C++/Rust)
  Subscribe(toWebCallback)  ───────────────▶ _web = callback
  (parses <tctoken> stanzas)
  UpdateTcTokens(jids[], tcTokens[]) ──────▶ for each pair: CreateNewConvoJid + FromBase64 → SetTcToken(jid, bytes)
                                             [cache: ConcurrentDictionary<rawJidString, byte[]>]
                              ◀───────────── RequestUpdate(jid)  (native wants a token it doesn't have yet)
  (fetches token, calls UpdateTcTokens) ───▶ cache filled
                                             GetTcToken(jid) / GetTcTokenAsync(jid, 5s timeout)  ──── tcToken bytes ──▶ VoipBridgeJid.tcToken
```

---

## 4. Native Dependencies

| Dependency | What it provides to auth/pairing | Confirmed? |
|---|---|---|
| `WhatsAppNative.Curve25519` (statically-linked crypto in WhatsAppNative.dll) | `GenKeyPair`, `Derive` (X25519 ECDH for Noise + X3DH), `Sign`, `Verify` (**Curve25519 = X25519 ECDH + XEdDSA signing, 64-byte signatures**) — backs both the Noise handshake and `AdvBridge.Verify` | C# callers confirmed (`Curve22519Extensions.cs:14-48`); **scheme NATIVE-CONFIRMED via radare2** (`96-native-crypto-radare2.md`): the X25519 Montgomery-ladder constant `a24=121665` (`0x0001DB41`, LE `41 db 01 00` ×3), base-point `09`+31×`00` ×2, and the SHA-512 constants (`K[0]=0x428a2f98d728ae22`; SHA-512 IV table BE at `0xa1c000`) are statically present, and the class exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}`. So the SCHEME is byte-evidenced (not merely by-interop); `@signalapp/libsignal-client` is bit-compatible. **Crypto is statically linked into `WhatsAppNative.dll`** — its `bcrypt.dll` imports are RNG-only (`BCryptGenRandom`/`Open`/`Close`AlgorithmProvider; **no** Encrypt/HashData/DeriveKey) and `whatsapprust.dll` is the Meta "wamedia" media library (binrw/hashbrown/memchr/spin — zero crypto) [native-binary `rabin2 -i`]; so AES/HMAC/SHA-512/curve all live in static code. The only un-read residual is the instruction-level `Sign` body (clamping/nonce), which is **MOOT for the port**; see §6 item 4 |
| `WhatsAppNative` activation factory | `NativeInterfaces.CreateInstance<Curve25519>()` bootstraps the native crypto class | Confirmed (`Curve22519Extensions.cs:14`) |
| WinRTAdapter projection layer (`AdvBridge`, `ClientKeyBridge`, `ServerEncKeySaltBridge` + `ABI.WinRTAdapter.*`) | Marshals the C# adaptees across the WinRT ABI so they can be vended as WebView2 host objects | Confirmed (`AdvBridge.cs`, `ClientKeyBridge.cs`, `ServerEncKeySaltBridge.cs`) |
| `WhatsAppNative.Sqlite` (**custom AES+HMAC page codec, NOT stock SQLCipher**) | Encrypted `session.db` / `nativeSettings.db` that store ClientKey/ServerEncKeySalt/LegacyDbSecret | Confirmed indirectly (`LoginSessionManager` uses `SqliteSettingsStorage` + `DbConfig.Secret`); the at-rest codec is a custom 4096-byte-page AES+HMAC scheme (16-byte per-DB salt + raw 32-byte key, no `cipher_version`/`kdf_iter`/PRAGMA-key markers), **not** stock SQLCipher (`96-native-crypto-radare2.md`; `Sqlite::Open` delegates to internal codec callees per `94-live-appdata-forensics.md`) |
| Windows `DataProtectionProvider` (DPAPI, `LOCAL=user`) | Wraps the static key that protects `session.db` | Confirmed (`ProtectionUtils.ProtectBytes` call, `LoginSessionManager.cs:66`) |
| WebView2 `CoreWebView2.AddHostObjectToScript` (via `AddWinRTBridge`) | The transport that lets JS call `AdvBridge`/`ClientKeyBridge`/`ServerEncKeySaltBridge` | Confirmed (`AppModel.cs:225,237,241`) |
| WebView2 JS bundle (`waweb-source-bundle/`) | **The actual pairing engine**: ADV signature math, QR/code generation, X3DH, ClientKey derivation; also the **owner of tc-token bytes** (parses `<tctoken>` stanzas, calls `TcTokenBridge.UpdateTcTokens`) | Confirmed (§3.4–3.6, §3.9) |
| `WhatsAppNative.VoipBridgeJid` (C++/Rust projection) | Carries the cached/inline tc token into the native VoIP engine as the `tcToken` byte field (`VoipBridgeJid.cs:115-124`) | Confirmed (§3.9) |
| `TrustedContactManager.Instance` (in-process singleton) | In-memory `ConcurrentDictionary<ConvoJid, byte[]>` cache of per-conversation tc tokens; no persistence | Confirmed (`TrustedContactManager.cs`, §3.9) |

> **Native-binary status (radare2-confirmed):** the Curve25519 scheme is **byte-evidenced**, not inferred — `96-native-crypto-radare2.md` statically confirms, inside `WhatsAppNative.dll`, the X25519 Montgomery constant `a24=121665` (`0x0001DB41`) + base-point and the SHA-512 constants (`K[0]=0x428a2f98d728ae22`; SHA-512 IV table BE at `0xa1c000`), and the class methods `Curve25519::{Derive,Sign,Verify,GenKeyPair}`. So **Derive=X25519 ECDH** and **Sign/Verify=XEdDSA (64-byte Signal variant)** are confirmed at the byte/constant level; `@signalapp/libsignal-client` is bit-compatible. The curve is **not** in `whatsapprust.dll` (that DLL is the Meta "wamedia" media library — [native-binary]) and **not** from `bcrypt.dll` (RNG-only imports — [native-binary]); it is **statically linked into `WhatsAppNative.dll`**. The only thing not read is the instruction-level `Sign` body (exact clamping/nonce), which is **MOOT for the port** — porters can treat the curve as standard X25519/XEdDSA (64-byte Signal variant) and validate against test vectors.

---

## 5. Linux/Electron Port Mapping

The huge simplifier: **pairing already lives in portable JS.** If the port keeps loading the same `web.whatsapp.com` bundle inside Electron's `<webview>`/`BrowserView`, the QR/code pairing, ADV signatures, and ClientKey derivation come for free. The port's job is to re-implement the *native host objects* the bundle expects.

| Windows piece | Electron/Node equivalent | Notes / risk |
|---|---|---|
| `AdvBridge.Verify` (Curve25519 verify) | `@noble/curves` (ed25519/x25519) or `libsignal`'s curve; expose via `contextBridge` | Must match WhatsApp's XEdDSA verify exactly. Lowest-risk option: **drop the native verify entirely** and let the bundle use its own `WAWebCryptoCurve25519VerifySignature` (the bundle is self-sufficient — §3.2). Then `AdvBridge` can be a thin verify or even a no-op-equivalent that JS already covers. Validate before removing. |
| `ClientKeyBridge` (Set/Clear/Get ClientKey) | `contextBridge`-exposed object writing to an encrypted store (`better-sqlite3` + SQLCipher, or `safeStorage` + a key file) | `ClearClientKey` must trigger an app relaunch (Electron `app.relaunch()` + `app.exit()`) to mirror `App.Restart(UserLogout)`. |
| `ServerEncKeySaltBridge` | same store, second key | Trivial twin of ClientKey. |
| `LoginSessionManager` (`session.db`, per-account `sessions\{SHA1(ClientKey)}\`, wipe-inactive) | Node `crypto.createHash('sha1')` + `fs` under `app.getPath('userData')/sessions/<sha1>` | Reproduce the single-account-on-disk wipe and the `LegacyDbSecret` (32 random bytes) regeneration on login. |
| DPAPI protection of `session.db` static key | Electron `safeStorage.encryptString` (libsecret/KWallet on Linux) **or** OS keyring via `keytar` | Linux has no DPAPI; `safeStorage` backs onto the Secret Service API. Risk: headless/no-keyring environments fall back to weaker protection — document it. |
| Noise handshake + `ClientPayload` (flow A) | `@noble/curves` x25519 + `@noble/ciphers` AES-GCM + a Noise XX/IK state machine (e.g. `noise-c` bindings or a hand-rolled impl), protobuf via `protobufjs` | This is the heaviest native re-implementation. The `ClientPayload` field layout in §3.1 is the contract: `Username` (field 1, phone# as uint64), `Passive=true` (field 3), `PushName` (field 7), `Platform` — **keep `WINDOWS=13`** (or pick an appropriate platform; server behavior may differ) and provide a sane UserAgent. |
| WebView2 host-object transport (`AddHostObjectToScript`) | Electron `contextBridge.exposeInMainWorld` in a preload, mirroring method names (`Verify`, `SetClientKey`, …) the bundle calls on `window.chrome.webview.hostObjects.<Name>` | The bundle calls `window.chrome.webview.hostObjects.AdvBridge` etc. A shim that maps `window.chrome.webview.hostObjects.*` to `contextBridge` objects is the cleanest reuse path. |
| `ADV*` protobuf specs (§3.6) | only needed if you *don't* reuse the bundle; encode with `protobufjs` from the field tables above | Field numbers are stable across Android/Web/Windows (confirmed cross-platform). |
| `TcTokenBridge` / `TrustedContactManager` (per-conversation tc-token cache, §3.9) | A `contextBridge` object exposing `UpdateTcTokens(jids, tcTokens)` + `Subscribe(cb)`, backed by a plain in-memory `Map<string, Uint8Array>` keyed by JID string; native callers read it synchronously when building call JIDs | Pure in-memory, no DB — easiest bridge to port. `RequestUpdate` becomes a callback/event the renderer listens to; `GetTcTokenAsync`'s 5 s fetch-with-timeout maps to an `await Promise.race([fetched, timeout(5000)])`. If your port reuses the bundle's own networking, you may not need this bridge at all — the bundle can stamp `tcTokenB64` inline on the call (the `CreateVoipBridgeJid(jidStr, tcTokenB64)` path, §3.9). |

**Reuse-from-bundle recommendation:** Port = Electron shell that loads the WhatsApp Web bundle + a preload that vends `AdvBridge`/`ClientKeyBridge`/`ServerEncKeySaltBridge` (and the ~25 other bridges). Pairing then needs **zero** new crypto. The only place you *must* write native-equivalent crypto is the **flow-A Noise login** *if* you also replace the bundle's networking — but the bundle already does its own networking over WebSocket when run as plain web.whatsapp.com, so a faithful "shell-only" port may not need the native Noise stack at all. **(inference: the native Noise/`ClientPayload` path exists because the Windows app proxies the socket natively for background/push reasons; a pure web-shell port can lean on the bundle's own WebSocket transport.)**

**Gaps / risks:**
* The `ClientKey` is the account's portable login secret — storing it as plaintext on Linux without a keyring is a real downgrade from DPAPI. Gate on `safeStorage.isEncryptionAvailable()`.
* If you re-implement flow A, the Noise static keypair and cached server static key (`SeamlessMigrationAppSessionStorage.ServerStaticPublicKey`) must be persisted to keep `IK` resume working; otherwise you always pay full `XX`.
* `UWP`/`WINDOWS` platform identifiers may cause the server to apply Windows-specific feature gating; a Linux port impersonating Windows is a fingerprinting risk and may break on server changes.

---

## 6. Open Questions / Unverified

> Every item below was **re-investigated this session** against the C# dump (`decompiled/`), the WebView2 JS bundle (`waweb-source-bundle/`), and the native binaries (`x64/WhatsAppNative.dll` via `strings`/`objdump`/constant-scan). Each item is prefixed with its verdict — **[RESOLVED]** (answer found + cited), **[PARTIAL]** (advanced but not byte/line-exact), or **[CANNOT RESOLVE STATICALLY]** (states the artifact that would close it). The original question text is preserved.

1. **[RESOLVED]** **Where exactly is `UWP`/`PlatformType` written?** *(Was: assignment happens in JS, not observed.)* It is written in the bundle's `WAWebProtobufsAdv` device-props builder: the platform enum maps `isWindows → UWP`, verbatim `function d(){if(r("WAWebEnvironment").isWindows)return s.UWP; …}` with `l.DEVICE_PLATFORM=c` (`SjCAw3j6…WiG.js`, grep `UWP;var e=r("WAWebMiscBrowserUtils")`). The same module defines the full enum `…AR_WRIST:19,AR_DEVICE:20,UWP:21,VR:22,CLOUD_API:23,SMARTGLASSES:24` (grep `UWP:21`), matching the C# `DeviceProps.PlatformType.UWP=21` (`DeviceProps.cs:9-35`). So the Windows companion advertises `UWP=21` unconditionally whenever `WAWebEnvironment.isWindows` is true; the C# enum is only the wire definition, the assignment is JS — now located. (`UserAgent.Platform.WINDOWS=13` in the separate `ClientPayload` UserAgent is the native flow-A value, `ClientPayload.cs:61-96`.)
2. **[RESOLVED]** **ClientKey internal structure.** *(Was: opaque base64 blob, content decided in JS, not visible.)* The bundle shows exactly what it pushes: in `WAWebStartBackend` (`xTiXmyjNEd_.js:473`, function `startBackendRegistered`), gated on the `WINDOWS_PENDING_CLIENT_KEY_SETUP` localStorage flag, it runs `var l=WAWebUserPrefsMultiDevice.getNoiseInfo(), s=l.staticKeyPair.privKey, u=WABase64.encodeB64(s); …getClientKeyBridge().setClientKey(u)`. So **`ClientKey` = the base64-encoded Noise *static private key*** (`getNoiseInfo().staticKeyPair.privKey`), i.e. the device's transport login secret — **not** the Signal identity key. This closes the loop with native: `SeamlessMigrationManager.ExtractClientKeys()` reads `NonDbSettingsId.StaticPrivateKey(=16)`/`StaticPublicKey(=17)` (`SeamlessMigrationManager.cs:601-627`) and feeds them as `clientStaticPrivateKey/Public` into the `ConnectionManager`→`HandshakeHandler` Noise handshake (`SeamlessMigrationManager.cs:563`, `ConnectionManager.cs:225`). So the ClientKey the JS persists *is* the `clientStaticPrivate` flow-A consumes.
3. **[RESOLVED]** **`ServerEncKeySalt` semantics.** *(Was: use asserted from naming, not observed crypto.)* The bundle's `WAWebStartBackend` reads it back from native and uses it for **local database encryption-key derivation**, not server backup: `…serverEncKeySaltBridge.getServerEncKeySalt()` → `b = TextDecoder.decode(WABase64.decodeB64(h))` → `WAWebDbEncryptionKey.DbEncKeyStore.generateFinalDbEncryptionAndFtsKey(b)` and `WAWebCryptoEncKeyHelper.generateFinalDbEncryptionAndFtsKeyForInvoker(b)` (`xTiXmyjNEd_.js:473`, the `WINDOWS_OFFLINE` branch). So `ServerEncKeySalt` is the salt that derives the **final DB message-encryption key and the FTS (full-text-search index) key** for the WhatsApp-Web at-rest store. It is round-tripped through native session row 3 only for persistence; the crypto consuming it lives in `WAWebDbEncryptionKey`/`WAWebCryptoEncKeyHelper`.
4. **[RESOLVED]** **Native Curve25519 exact scheme.** *(Was: [CANNOT RESOLVE STATICALLY] — bodies unavailable, empty Ghidra exports; then briefly [PARTIAL].)* **The scheme is NATIVE-CONFIRMED via radare2 (`96-native-crypto-radare2.md`): Curve25519 = X25519 ECDH (`Derive`) + XEdDSA signing (`Sign`/`Verify`, 64-byte Signal variant).** This is byte-evidenced, not merely by-interop. The native class is confirmed present — `Curve25519@WhatsAppNative`, `__Curve25519ActivationFactory`, `__ICurve25519PublicNonVirtuals`, plus the class methods **`Curve25519::{Derive,Sign,Verify,GenKeyPair}`** (`96-native-crypto-radare2.md`; [native-binary] `strings -n6`/radare2, this session). The C# wrapper also queries `Instance.GetSignLength()` ([decompiled-C#] `Curve22519Extensions.cs:18`), so the native class advertises a fixed signature length (the 64-byte Signal variant). A constant-scan of the DLL finds the **Montgomery `a24=121665`** constant (`0x0001DB41`, LE-stored `41 db 01 00`, 3×) and the X25519 base-point byte pattern (`09`+31 zero bytes, 2×) — the Montgomery-ladder X25519 for ECDH (`Derive`). The **SHA-512 initial-hash-value (IV) table is present as data, stored big-endian**, at offset **`0xa1c000`**: a contiguous 64-byte run of all eight H-words `6a09e667f3bcc908 bb67ae8584caa73b 3c6ef372fe94f82b a54ff53a5f1d36f1 510e527fade682d1 9b05688c2b3e6c1f 1f83d9abfb41bd6b 5be0cd19137e2179` (1× each), and the SHA-512 round-constant `K[0]=0x428a2f98d728ae22` is likewise present (`96-native-crypto-radare2.md`). Note the byte order explicitly: the BE constant for H0 is `6a09e667f3bcc908` (present, 1× at `0xa1c000`), whereas its LE-stored form `08c9bcf367e6096a` appears **0×** — an earlier scan searched only the LE form and wrongly concluded the IV was absent. So the **SHA-512 IV+K tables positively surface as data**, byte-confirming a statically-linked SHA-512 (the hash used by XEdDSA signing) inside `WhatsAppNative.dll`. The **only** thing still unread is the instruction-level `Sign` body (exact clamping/nonce derivation), which is **MOOT for the port** and does not gate this verdict; `@signalapp/libsignal-client` is bit-compatible.

   **Native crypto-provider correction (was over-stated):** the earlier note that "SHA-512 would come from CNG/`bcrypt.dll`" is **wrong** and is corrected here. The `WhatsAppNative.dll` import table imports from `bcrypt.dll` **only** `BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider` — i.e. **RNG only**; there is **no** `BCryptEncrypt`/`BCryptDecrypt`/`BCryptHashData`/`BCryptCreateHash`/`BCryptDeriveKey*` import ([native-binary] `rabin2 -i WhatsAppNative.dll`, this session). So **all hashing/AES/HMAC/KDF and the curve math (SHA-512 for XEdDSA included) are statically linked into `WhatsAppNative.dll`** (BoringSSL-from-WebRTC the likely provider). This is positively corroborated by the constant tables that the static crypto carries as data: the **SHA-512 IV table sits big-endian at `0xa1c000`** (`6a09e667f3bcc908 bb67ae8584caa73b 3c6ef372fe94f82b …`) and the **X25519 `a24=121665`/base-point constants** are present (see item 4 above) — exactly the read-only constants a statically-linked BoringSSL SHA-512 + X25519 would embed; the curve `Sign`/`Verify` and SHA-512 code bodies referencing them are what remain un-symbolized. The sibling **`WhatsAppRust.dll` is a *media* library only** (wamedia: JPEG/PNG/WebP/MP4/H264/AAC parse-and-repair strings dominate it; its sole RNG import is `bcryptprimitives.dll!ProcessPrng`; **no** curve/Signal/Noise/SHA-512 markers — [native-binary] `strings`/`rabin2 -i WhatsAppRust.dll`, this session), so the Signal/Noise/ADV crypto is **not** in `whatsapprust.dll`; it lives in `WhatsAppNative.dll`'s statically-linked crypto.

   **What the round-2 open implementations settle (cross-reference, not native-binary):** the WA peer/ADV signature scheme is **Curve25519 XEdDSA, 64-byte**, and the native client *must* use it because it interoperates with the same servers/peers that the open clients sign for.
   * whatsmeow signs through libsignal-Go: `ecc.CalculateSignature(ecc.NewDjbECPrivateKey(priv), msg)` returns a `[64]byte` and verifies with `ecc.VerifySignature(...)` (cross-reference: `whatsmeow/util/keys/keypair.go:48-54`, `whatsmeow/pair.go:264-285`). The signing private key is X25519-**clamped** `priv[0]&=248; priv[31]&=127; priv[31]|=64` (`keypair.go:35-37`), and the pubkey is `DjbType` (0x05) prefixed to 33 bytes before signing (`keypair.go:49-51`). `go.mau.fi/libsignal/ecc.CalculateSignature` is the **xed25519 / curve25519-sign (XEdDSA)** primitive.
   * Baileys signs through libsignal-JS: `Curve.sign = curve.calculateSignature(privateKey, buf)`, `Curve.verify = curve.verifySignature(...)` over 33-byte 0x05-prefixed pubkeys (cross-reference: `Baileys/src/Utils/crypto.ts:11-36`). Same libsignal `Curve25519` XEdDSA.
   * The native bundle's own verifier is `WASignalSignatures.verifyMsgSignalVariant(pubKey, msg, ensureSize(sig,64))` (string `verifyMsgSignalVariant` + `signMsg` grep-confirmed in `research/waweb-unmin/*.js`) — the **same 64-byte Signal-variant (XEdDSA)** the open clients use, and the bundle is the exact JS the native client hosts in WebView2. The ADV signature **prefix bytes** also match exactly: whatsmeow `AdvAccountSignaturePrefix={6,0}`, `AdvDeviceSignaturePrefix={6,1}`, `AdvHostedAccountSignaturePrefix={6,5}`, `AdvHostedDeviceSignaturePrefix={6,6}` (`whatsmeow/pair.go:31-35`) ≡ the bundle constants `[6,0]/[6,1]/[6,5]/[6,6]` in §3.5.

   Net: **ECDH=X25519 (native-binary constant-confirmed)**; **signature scheme = Curve25519 XEdDSA, 64-byte (NATIVE-CONFIRMED via radare2, `96-native-crypto-radare2.md`; also corroborated by interop — whatsmeow keypair.go/pair.go + Baileys crypto.ts + bundle `verifyMsgSignalVariant`)**; **crypto provider = statically-linked-into-`WhatsAppNative.dll`, not bcrypt/CNG and not `whatsapprust.dll` (native-binary import-table confirmed, this session)**. The **only residual** is the native byte-level impl detail (exact clamping/cofactor handling and whether `Curve25519::Sign` matches xed25519 bit-for-bit), which is **MOOT for the port** (the scheme is already byte-evidenced and `@signalapp/libsignal-client` is bit-compatible). **Constant evidence (this final pass):** (a) `a24=121665` LE-stored (`41 db 01 00`) ×3, X25519 base-point (`09`+31×`00`) ×2, and the **SHA-512 IV table present big-endian at `0xa1c000`** (BE H0 `6a09e667f3bcc908` ×1; its LE-stored form `08c9bcf367e6096a` ×0) plus `K[0]=0x428a2f98d728ae22` ([native-binary] radare2/python byte-scan; `96-native-crypto-radare2.md`) — these constants byte-confirm the static crypto and the SCHEME; (b) `rabin2 -i` confirms the **bcrypt import table is RNG-only** — `BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider` and nothing else ([native-binary], this session); (c) the class exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}`, reached through the WinRT/COM ABI shim (`Curve25519.cs:139-147` forwards to `__ICurve25519PublicNonVirtualsMethods.Sign`); the un-symbolized `Sign` *instruction body* is the only piece not read, and it does not gate the verdict. Reading it would need a PyGhidra/objdump pass over the un-symbolized body or live test-vector probing, but that is impl-detail only — not required for the port.
5. **[RESOLVED]** **`link_code_companion_reg` key wrapping.** *(Was: [PARTIAL] — KDF/AES wrapping not traced; the exact ECDH mixing into HKDF `ikm`/`salt` and the AEAD over the key bundle were not assembled field-by-field.)* The bundle chain traced earlier (a) **link code → AES-CTR-256 key** via WebCrypto `deriveKey({name:"PBKDF2", hash:"SHA-256", salt:<ref bytes>, iterations: 2<<16 /*=131072*/}, linkCode, {name:"AES-CTR", length:256})` (grep `PBKDF2",hash:"SHA-256"` in `research/waweb-unmin`); (b) a **companion ADV ephemeral keypair** AES-CTR-wrapped with that key → `link_code_pairing_wrapped_companion_ephemeral_pub` (sent in `companion_hello` with `companion_server_auth_key_pub`); (c) `link_code_pairing_key_bundle_encryption_key` HKDF + `link_code_pairing_nonce` is now **fully reconstructed field-by-field** by two independent open implementations of the same protocol that agree exactly:

   **whatsmeow `pair-code.go` (cross-reference, authoritative open impl):**
   * **Companion side / `companion_hello` (`generateCompanionEphemeralKey`, `pair-code.go:59-74`):** `salt=random(32); iv=random(16); linkingCode=base32(random(5))`; `linkCodeKey = PBKDF2(encodedLinkingCode, salt, 2<<16 /*=131072*/, 32, SHA-256)`; AES-CTR(`linkCodeKey`,`iv`) over the 32-byte ephemeral pubkey; the wire blob `ephemeralKey` = **`salt[0:32] ‖ iv[32:48] ‖ encryptedPubkey[48:80]`** (80 bytes), sent as `link_code_pairing_wrapped_companion_ephemeral_pub`, with `companion_server_auth_key_pub = NoiseKey.Pub` (`pair-code.go:96,104-124`).
   * **Companion-finish (`handleCodePairNotification`, `pair-code.go:152-247`) — the previously-missing ECDH/HKDF mixing:**
     1. Decrypt the primary's wrapped ephemeral pub with the **same** `PBKDF2(linkingCode, primarySalt, 131072, 32, SHA-256)` → AES-CTR (the `[salt|iv|ct]` 80-byte split) (`:191-200`).
     2. **`ephemeralSharedSecret = X25519(companionEphemeralPriv, primaryDecryptedEphemeralPub)`** (`:201`).
     3. **`keyBundleEncryptionKey = HKDF-SHA256(ikm=ephemeralSharedSecret, salt=keyBundleSalt(random 32), info="link_code_pairing_key_bundle_encryption_key", L=32)`** (`:207`). ⇐ this is the exact `ikm`/`salt` that was open.
     4. AEAD = **AES-256-GCM**: `plaintextKeyBundle = companionIdentityPub ‖ primaryIdentityPub ‖ advSecretRandom(32)`; `encryptedKeyBundle = GCM.Seal(nil, keyBundleNonce(random 12), plaintext)`; wire `link_code_pairing_wrapped_key_bundle = keyBundleSalt(32) ‖ keyBundleNonce(12) ‖ encryptedKeyBundle` (`:216-218,240`).
     5. **`identitySharedKey = X25519(companionIdentityPriv, primaryIdentityPub)`** (`:221`); **`advSecret = HKDF-SHA256(ikm = ephemeralSharedSecret ‖ identitySharedKey ‖ advSecretRandom, salt=nil, info="adv_secret", L=32)`** → `Store.AdvSecretKey` (`:225-227`). This is the ADV secret that later authenticates `pair-success`.
   * **Baileys `Socket/messages-recv.ts` corroborates byte-for-byte** (cross-reference): `decipherLinkPublicKey` does the same `salt[0:32]/iv[32:48]/payload[48:80]` split + `derivePairingCodeKey` + AES-CTR (`:1285-1292`); then `companionSharedKey = Curve.sharedKey(pairingEphemeralPriv, codePairingPub)`; `hkdf(companionSharedKey, 32, {salt: linkCodeSalt, info:"link_code_pairing_key_bundle_encryption_key"})`; `encrypt = aesEncryptGCM(signedIdentityKey.public ‖ primaryIdentityPublicKey ‖ random, key, iv12)`; wire `linkCodeSalt ‖ iv ‖ encrypted`; `advSecretKey = base64(hkdf(companionSharedKey ‖ identitySharedKey ‖ random, 32, {info:"adv_secret"}))` (`messages-recv.ts:1139-1160`).

   The C# `EncryptedPairingRequest{EncryptedPayload:1, Iv:2}` (`EncryptedPairingRequest.cs:55-59`) is the wire transport for the encrypted payload. So the full link-code crypto is now resolved (cross-reference: whatsmeow `pair-code.go:59-247` + Baileys `messages-recv.ts:1139-1292`; bundle strings `link_code_pairing_key_bundle_encryption_key`/`PBKDF2,hash:SHA-256` corroborate). The C# layer never builds these (§3.4 — registration is JS-driven, native stub at `WAProtocol.cs:189`); native only forwards the transport protobuf.
6. **[RESOLVED]** **Does the native shell ever call `AdvBridge.Verify`'s native curve for *generation*?** *(Was: signing appears JS-only; unconfirmed whether other native path signs.)* Confirmed JS-only signing, and the native `Verify` *is* actually used. The bundle's `WindowsHybridBridgeAdv.verifySignatureAsync` calls straight into native; the real minified body is `verifySignatureAsync = function*(e,t,n){ return yield this.$1.verify(encodeB64(t), encodeB64(n), encodeB64(e)); }` with `$1 = hostObjects.AdvBridge` (`U2j2EhR17gV.js`, module `WAWebWindowsHybridBridgeAdv`). The JS params `(e,t,n)` are `(signKey, message, signature)`, so the call resolves to `verify(encodeB64(message), encodeB64(signature), encodeB64(signKey))`, matching the native arg order `Verify(messageBase64, signatureBase64, signKeyBase64)` → `Curve.Verify(message, signature, signKey)` (`AdvBridgeAdapter.cs:16,21,29`, `IAdvBridgeToNative.cs:13`). Signature **generation** never touches native: `WAWebCryptoCurve25519CalculateSignature` → `WAWebCryptoLibraryUtilsApi.signMsg(pubKey, privKey, msg)` (pure JS, `SjCAw3j6…WiG.js`), and the bundle's own verify is `WASignalSignatures.verifyMsgSignalVariant(pubKey, msg, ensureSize(sig,64))` — a **64-byte** Signal-variant signature. The native surface only exposes `Verify` (`IAdvBridgeToNative.cs:13`, `AdvBridgeAdapter.cs:21,29`); `Curve22519Extensions` *has* a `Sign` (`Curve22519Extensions.cs:32-35`) but it is **not** wired to any ADV host-object method — no native ADV signing path exists.
7. **[RESOLVED]** **Multi-device registration native stub.** *(Was: stub throws; open whether an older/other path ever registered natively.)* The registration branch is fully wired but permanently disabled in this build. `ProcessStanza` routes to `ProcessMultiDeviceRegistrationNode` only when `_isCompanionRegistration` is true (`WAProtocol.cs:38-40`), and that method throws `NotImplementedException` (`WAProtocol.cs:189-191`). `WAProtocol` does take an `isCompanionRegistration` ctor arg (`:27`), **but the only construction site hardcodes `isCompanionRegistration: false`** (`SocketAdapter.cs:75`), and `HandshakeHandler._isCompanionRegistration` is a constant `false` (`HandshakeHandler.cs:52`) that gates `TryHandshake`/`WriteInitialStanza` (`:103,158`). The `connectInPullMode` flag is **unrelated** to registration — it is always `true` (`HandshakeHandler.cs:53`, `ConnectionManager.cs:124`, `SocketAdapter.cs:75`) and only sets `ClientPayload.Pull` (`HandshakeHandler.cs:238`). So: native registration is dead code in shipping builds; pairing runs exclusively in JS (§3.4). Whether a *historical* build ever flipped the flag is not answerable from this dump (would need an older binary), but in this one it is provably never reached.
8. **[PARTIAL]** **`GetTcTokenAsync` early-completion wiring (§3.9).** *(Was: no `OnNext` on `_tokensUpdatedSubject`; open whether a non-stripped build wires it.)* **Re-verified again this final pass** ([decompiled-C#] `grep -rn '_tokensUpdatedSubject'`/`'tokensUpdated'` over the entire `decompiled/` tree): the subject appears **only** at its declaration (`TcTokenController.cs:14`) and in the `Where(...)` filter inside `GetTcTokenAsync` (`TcTokenController.cs:32`) — there is **no `.OnNext(` call anywhere in the whole dump**. `UpdateTcTokens` writes the cache but does not pump the subject. So **as decompiled the await provably only completes via the 5 s `Timeout`**, then re-reads the now-populated cache. This half (the behaviour of *this* binary) is RESOLVED; the genuinely-open half — whether a non-stripped/newer build wires `UpdateTcTokens`→`OnNext` for sub-5 s wake-up, vs. the subject being dead code — **cannot be resolved statically**. **Provenance note:** this is a *native-C# Rx-plumbing* question internal to WhatsApp's Windows shell, **not a protocol fact**; none of the new corpus can touch it — the open impls (whatsmeow/Baileys/bundle) mirror the *wire protocol*, and the live appdata/IndexedDB (docs 94/95) capture *stored state*, neither of which exposes this Windows-only host-bridge Rx subject. The exact artifact that would close it remains a **non-stripped/newer `WhatsAppNative` build or a runtime trace** of `TcTokenController`. (Verdict unchanged — stays PARTIAL.)
9. **[PARTIAL]** **tc-token semantics & lifetime.** *(Was: opaque to native; construction/validity/carrier-stanzas decided server-side or in bundle.)* Round-2 narrowed this substantially. It now splits into **four** parts: **validity window — RESOLVED** (bundle config); **carrier stanzas & issuance mechanism — RESOLVED-via-cross-reference** (whatsmeow `tctoken.go`, matching bundle config); **related `cstoken` byte construction — RESOLVED-via-cross-reference** (whatsmeow `cstoken.go`); and only the **opaque server-minted `trusted_contact` token-byte internals — CANNOT** (server secret, opaque to all clients). Item stays PARTIAL solely because of that last server-side residual.
   * **Validity window — [RESOLVED] from the bundle config.** The default TTL is a static client-config default, not a runtime-only value: `tctoken_duration:[865,"int",604800,604800]` and `tctoken_duration_sender:[996,"int",604800,604800]` in `waweb-source-bundle/n6o0-NaJTww.js` (grep-confirmed) — both default to **604800 s = exactly 7 days**. The sibling bucketing config is `tctoken_num_buckets:[909,"int",4,4]` / `tctoken_num_buckets_sender:[997,"int",4,4]` (4 buckets). The `[id,"int",default,default]` shape is the WAWebConfig server-overridable-config defaults table, so 7 days is the *default* TTL/refresh window; the server may push a different value at runtime, but the static default is readable here. So the earlier "needs live wire capture … none present here" was wrong for the TTL — a one-line bundle grep answers it.
   * **Carrier stanzas & issuance mechanism — [RESOLVED-via-cross-reference] from whatsmeow + bundle config.** The native side is purely a forwarder (`TrustedContactManager` is a single `ConcurrentDictionary<ConvoJid, byte[]>`, `TrustedContactManager.cs:8-24`), so the *protocol* lives in the open implementations. whatsmeow `tctoken.go` (cross-reference) makes the issuance/carrier mechanics concrete:
     - **Issuance** is an `<iq type=set xmlns=privacy>` to `s.whatsapp.net` carrying `<tokens><token jid=… t=<unix> type="trusted_contact"/></tokens>` (`whatsmeow/tctoken.go:182-200`). The token `type` string is **`trusted_contact`** — grep-confirmed verbatim in the bundle (`research/waweb-unmin/*.js`, string `trusted_contact`).
     - **Bucketing / TTL** is a rolling-bucket scheme with `tcTokenBucketDuration = 604800` (7 days) and `tcTokenNumBuckets = 4` (~28-day total window), gated to default/hidden user servers and skipped for PSA/bots (`whatsmeow/tctoken.go:18-55,119-135`). These constants **exactly match the bundle config** read in the lifetime half (`tctoken_duration:[…,604800,604800]`, `tctoken_num_buckets:[…,4,4]`, `tctoken_duration_sender`/`_sender` siblings in `research/waweb-unmin`) — independent corroboration that the 7-day/4-bucket window is the protocol default. `shouldSendNewTCToken` re-issues only when the current bucket index exceeds the last issuance bucket (`tctoken.go:42-48`).
   * **Related `cstoken` byte construction — [RESOLVED-via-cross-reference] from whatsmeow `cstoken.go`.** The sibling "cstoken"/NCT token *is* an open keyed construction: `generateCsToken(jid) = HMAC-SHA256(key = NCTSalt, msg = recipientLID.ToNonAD().String())`, gated to default/hidden user servers and skipped for PSA/bots, with the PN→LID resolution applied first (`whatsmeow/cstoken.go:24-69`). The native `ServerEncKeySalt`/NCT-salt family is the HMAC key; the token is keyed on the recipient LID string. (Cross-reference: `whatsmeow/cstoken.go`.)
   * **Opaque `trusted_contact` token-byte internals — [CANNOT RESOLVE STATICALLY].** The *actual bytes inside* a server-issued `<tctoken>` for `type=trusted_contact` are **server-minted and opaque to every client**. This is now corroborated three ways: (a) native forwards raw bytes ([decompiled-C#] `TrustedContactManager` is a bare `ConcurrentDictionary<ConvoJid, byte[]>`, never parses them); (b) whatsmeow stores the token as an opaque `[]byte` field and only ever GETs/PUTs/attaches it, never constructs it — [protocol-cross-ref] `tctoken.go:120-135` (`existing.Token []byte`), in pointed contrast to the *sibling* `generateCsToken = HMAC-SHA256(NCTSalt, recipientLID.String())` which the client **does** derive ([protocol-cross-ref] `cstoken.go:24-69`); and (c) the live WhatsApp-Web layer likewise just *stores* them — the IndexedDB carries an **`orphan-tc-token`** object store under `model-storage` ([live-appdata] doc 95 §3 line 44; `research/idb_schema.txt` **entry 41**, re-confirmed this pass), sitting in the same tokens-family neighbourhood as the sibling **`acs-tokens`** (`research/idb_schema.txt` entry 77) and **`direct-connection-keys`** stores — all plain at-rest caches of received material with **no derivation logic**, none of which the on-disk schema gives any keying for. So this last residual is not a static-analysis gap but a server-side secret: closing it needs **server documentation or a live capture correlated with the server's keying material** — unobtainable from any client artifact (native dump, bundle, open impls, or the on-disk IndexedDB). The cross-doc anchors (`TCTokenMixin` `17-stanza-families-catalog.md:83,131-132`; call `tcTokenB64` args `41-voip-calling.md:96-99,141,250-255`) describe attachment, not internal format.
