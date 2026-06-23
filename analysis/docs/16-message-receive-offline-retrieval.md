# 16. Message Receive & Offline Retrieval

> Target: Meta native **WhatsApp for Windows** (`WhatsApp.Root.exe`, WinUI 3 / Windows App SDK 1.6, hybrid native-C# + WebView2-JS). All citations are `path:LINE` relative to `decompiled_source/` unless noted. Anything not directly observed in code is explicitly labelled **(inference)**.

---

## 1. Purpose & Scope

This document covers the **inbound** data path for chat traffic: how raw socket bytes become a parsed stanza, how that stanza is decrypted/decompressed/parsed into the in-memory node tree, how it is routed, and how the **offline message queue** (the backlog the server flushes to a freshly-connected client) is drained and acknowledged.

The single most important architectural fact, confirmed below, governs the whole document:

> **The native C# networking stack only natively handles three top-level inbound stanza tags: `iq`, `success`, and `failure`.** Every other top-level tag (`message`, `receipt`, `notification`, `presence`, `chatstate`, `ib`) is logged as *"Unrecognized top-level stanza"* and **dropped** by the native layer (`WhatsApp.Root/WhatsApp/WAProtocol.cs:80`, `:154`).

The reason is that this app is a **hybrid**: the WhatsApp Web JS bundle running inside WebView2 maintains its **own independent WebSocket + Noise + FunXMPP stack** (confirmed: `WANoiseSocket` / `NoiseHandshake` / `new WebSocket(...).binaryType="arraybuffer"` in the bundle, §3.6). Message receive, receipt sending, and offline-queue drain therefore happen **almost entirely in JS**, over a connection the native C# code does not own. The native FunXMPP receive path documented in §3.1–§3.5 is a **separate, parallel native connection** used for native-side concerns (login orchestration, IQ correlation, VoIP-signaling routing). Both implement the *same wire format*, so the native path is the most faithful, fully-readable reference for the protocol — but the actual user-visible "message received" event is produced in JS.

Scope therefore splits into two halves:
- **Native receive path** (fully readable C#): socket → frame → AES-GCM decrypt → inflate → FunXMPP parse → `ProcessStanza` dispatch → IQ correlation. §3.1–§3.5.
- **JS receive/offline path** (minified bundle, partially readable): the `<ib>` info-broadcast offline-drain protocol, per-message `offline` markers, offline counts, and receipt emission. §3.6–§3.8.

---

## 2. Where It Lives

### Native C# (fully readable)
| Concern | File (under `decompiled_source/`) |
|---|---|
| Frame reassembly (3-byte length prefix) | `decompiled/WhatsApp.Networking/WhatsApp/FramesReader.cs` |
| Frame buffer | `decompiled/WhatsApp.Core/WhatsApp/WaMemoryStream.cs` |
| Frame target / handshake→encrypted switch | `decompiled/WhatsApp.Root/WhatsAppCommon/SocketAdapter.cs` |
| AES-GCM decrypt + inflate + parse | `decompiled/WhatsApp.Root/WhatsApp/EncryptedBytesReceiver.cs` |
| AEAD primitive | `decompiled/WhatsApp.Root/WhatsApp/AesGcmProvider.cs` |
| FunXMPP binary parser | `decompiled/WhatsApp.Networking/WhatsApp/BinTreeNodeReader.cs` |
| Token table (string↔token) | `decompiled/WhatsApp.Networking/WhatsApp/WAPDefaultTokenDictionary.cs` |
| Top-level dispatch / state machine | `decompiled/WhatsApp.Root/WhatsApp/WAProtocol.cs` |
| In-memory stanza model | `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolTreeNode.cs` |
| IQ request/response correlation | `decompiled/WhatsApp.Networking/WhatsApp/IqRequestsTracker.cs` |
| IQ result handler | `decompiled/WhatsApp.Networking/WhatsApp.Networking.XMPP/IqResultHandler.cs` |
| Notification/IQ ack builder | `decompiled/WhatsApp.Networking/WhatsApp.Networking.StanzaBuilders/AckStanzaBuilder.cs` |
| Outbound write path (for ack send) | `decompiled/WhatsApp.Root/WhatsApp/StanzaWriter.cs` |

### Native C# Smax — Offline domain (the *only* native offline classes that exist)
Namespace `WhatsApp.Smax.Generated.Offline.Incoming`, dir `decompiled/WhatsApp.Networking/WhatsApp.Smax.Generated.Offline.Incoming/`:
- `ThreadMetadataServerRequest.cs` — parses an `<ib from=…><thread_metadata>…` info-broadcast.
- `ThreadMetadataServerRequestThreadMetadata.cs`, `…ThreadMetadataItem.cs`
- `ThreadMetadataDelayedMixin.cs`, `…StatusMsgs.cs`, `…StatusMsgsItem.cs`, `…Notifications.cs`

> Note: there is **no** native `Offline.Outgoing` directory, and **no** native handler for the `<ib type="offline">` / `offline_preview` / `priority_offline_complete` drain. Those live in JS (§3.6–§3.8). The native Offline namespace only models the `<thread_metadata>` info-broadcast sub-protocol.

### JS bundle (`decompiled_source/waweb-source-bundle/`, minified, hashed filenames)
| Concern | Hashed file | Anchor token in file |
|---|---|---|
| Own WebSocket + Noise socket | `SjCAw3j6Bfsc…WiG.js` | `new WebSocket`, `WANoiseSocket`, `NoiseHandshake` |
| `<ib>` info-broadcast type enum (incl. offline) | `b1yokgAMCB8V…hl3RM.js` | `OFFLINE:"offline",OFFLINE_PREVIEW:"offline_preview"…` |
| Per-message `offline` attribute parse | `SjCAw3j6Bfsc…WiG.js` | `t.offline=e.attrInt("offline")` |
| Offline-count attr range parse (`offline` 0–1024) | `UBSny1JW6Io8…JTk.js`, `SjCAw…WiG.js` | `attrIntRange,e,"offline",0,1024` |
| Receipt send job | `TSxMup…VSn.js`, `c7Ubf6OQTBc.js` | `WAWebSendReceiptJobCommon`, `sendReceipt` |

---

## 3. How It Works

### 3.1 Socket bytes → frames (3-byte big-endian length prefix)

Inbound socket bytes are handed to `FramesReader.SocketBytesIn`. WhatsApp's wire framing is a **3-byte (24-bit) big-endian length prefix** followed by that many body bytes (`FramesReader.cs:12` `FrameHeaderSize = 3`).

`OnBytesAvailable` is the reassembly core (`FramesReader.cs:66`):

```csharp
while (length > 0 && length >= 3) {
    byte num2 = buffer[num]; int num3 = buffer[num+1]; int num4 = buffer[num+2];
    int num5 = (num2 << 16) + (num3 << 8) + num4;   // 24-bit length
    length -= 3;
    if (length < num5) break;                        // incomplete frame -> wait
    _target.ProcessFrame(buffer, num + 3, num5);     // dispatch full frame body
    length -= num5; num += 3 + num5;
}
```

Partial frames spanning multiple socket reads are buffered. The first read uses a fast path that only allocates into `_memory` (a `WaMemoryStream`) when a partial frame remains (`FramesReader.cs:29-48`). `WaMemoryStream` is a stripped append-only buffer that throws on any random-access `Position`/`SetLength` use (`WaMemoryStream.cs:31-69`) — it only supports the append-then-drain pattern the reader needs.

The `ITarget` is the **`SocketAdapter`** (`SocketAdapter.cs:11` `: INetworkSession, FramesReader.ITarget`), wired in its constructor: `adaptee.BytesAvailable += framesReader.SocketBytesIn;` (`SocketAdapter.cs:43`).

### 3.2 Handshake-vs-encrypted switch (the `_reader` gate)

`SocketAdapter.ProcessFrame` (`SocketAdapter.cs:51`) decides per-frame whether the connection is still in the Noise handshake or has transitioned to the encrypted-stanza phase, keyed on whether `_reader` (an `EncryptedBytesReceiver`) has been constructed yet:

```csharp
if (_reader != null) {
    try { _reader.ReceiveFrame(input, offset, length); return; }
    catch (LoginFailureException e) { this.LoginFailed?.Invoke(this, e); return; }
}
if (_handshake.TryHandshake(GetBytesFrame())) {           // Noise XX/IK still running
    Pair<byte[],byte[]> pair = _handshake.GenerateKeys();  // (writeKey, readKey)
    StanzaWriter writer = new StanzaWriter(_adaptee, pair.First);
    WAProtocol wAProtocol = new WAProtocol(false, _attempt, _requestsTracker, writer, this, _connectInPullMode);
    wAProtocol.LoggedIn += delegate {
        _stateSubject.OnNext(FunRunner.SocketStates.Connected);
        _adaptee.SetTimeout((int)Constants.ForegroundPingTimeout.TotalMilliseconds, false);
        this.LoggedIn?.Invoke(this, writer);
    };
    _reader = new EncryptedBytesReceiver(pair.Second, wAProtocol);  // read key
}
```

So once the Noise handshake completes, `GenerateKeys()` yields a `(write, read)` key pair; the **read key** (`pair.Second`) seeds the `EncryptedBytesReceiver`, and every subsequent frame flows through it. A `LoginFailureException` thrown deep in the receive path (from `WAProtocol`, §3.4) is caught here and surfaced as the `LoginFailed` event.

### 3.3 Decrypt → decompress → parse (`EncryptedBytesReceiver.ReceiveFrame`)

`EncryptedBytesReceiver.cs:24` is the heart of the native receive path:

```csharp
public void ReceiveFrame(byte[] input, int offset, int length) {
    byte[] array = AesGcmProvider.AesGcmDecrypt(_readKey,
                       WAProtocol.LongToByteArray(_readNonce++, 12), null, input, offset, length);
    if (array == null) { FailuresService.Investigate("Failed to decrypt AES GCM frame", …); return; }
    MemoryStream memoryStream = new MemoryStream();
    if ((array[0] & 2) != 0) {                       // FlagCompressed bit
        using (MemoryStream baseInputStream = new MemoryStream(array, 1, array.Length-1, false))
        using (InflaterInputStream inflaterInputStream = new InflaterInputStream(baseInputStream))
            inflaterInputStream.CopyTo(memoryStream);
        memoryStream.Position = 0L;
    } else {
        memoryStream = new MemoryStream(array, 1, array.Length-1, false);  // skip flag byte
    }
    ProtocolTreeNode node = _reader.ParseTreeNode(memoryStream);
    _protocol.ProcessStanza(node, memoryStream.Length);
}
```

Key facts established line-by-line:

1. **Nonce.** A monotonically-incrementing per-direction counter `_readNonce++` (`EncryptedBytesReceiver.cs:9, :26`) is rendered into a **12-byte big-endian** nonce by `WAProtocol.LongToByteArray(value, 12)` (`WAProtocol.cs:53-66`; writes the 8-byte big-endian value into the last 8 bytes, leaving the first 4 zero). The receive nonce stream is **independent** of the send nonce (`StanzaWriter._writeNonce`, `StanzaWriter.cs:12,:76`); both start at 0 right after `GenerateKeys()`.
2. **AAD = null.** Post-handshake stanza frames use **no additional authenticated data** (`EncryptedBytesReceiver.cs:26`, third arg `null`). (Contrast: the Noise handshake frames use the transcript hash as AAD — that is the handshake layer, not here.)
3. **AEAD = AES-GCM, 16-byte tag appended at end.** `AesGcmProvider.AesGcmDecrypt` (`AesGcmProvider.cs:36-70`) splits the trailing **16 bytes** as the tag (`TagSize = 16`, `AesGcmProvider.cs:11`), runs WinRT `CryptographicEngine.DecryptAndAuthenticate`, and **returns `null` on auth failure** (the catch at `:66-68` swallows the exception). A `null` here means "drop the frame and log" — it does **not** tear down the connection (`EncryptedBytesReceiver.cs:27-31`).
4. **Compression flag is bit 1 (value `2`) of the first plaintext byte.** `(array[0] & 2) != 0` (`EncryptedBytesReceiver.cs:33`); matches `WAProtocol.FlagCompressed = 2` (`WAProtocol.cs:11`). The flag byte itself is always stripped (`array, 1, …` in both branches). zlib inflate via SharpZipLib `InflaterInputStream` (`EncryptedBytesReceiver.cs:2,:37`).
5. The resulting plaintext `MemoryStream` is parsed by **`BinTreeNodeReader.ParseTreeNode`** (§3.3.1) and the node passed to **`WAProtocol.ProcessStanza`** (§3.4).

> **Frame plaintext layout (post-decrypt, pre-strip):**
> `[1-byte flag][ FunXMPP body, optionally zlib-deflated ]`
> flag bit `0x2` = compressed. (The full bit-2 fragment flag `FlagMoreFragments = 1` / `MaxFragmentSize = 786432` constants exist at `WAProtocol.cs:13-15` but are **not referenced** anywhere in the native receive path — fragmentation of inbound frames is not implemented natively. **(inference)**)

#### 3.3.1 FunXMPP binary parse (`BinTreeNodeReader.ParseTreeNode`)

`BinTreeNodeReader.cs:17` decodes one node:

```
token       = ReadByte()                 // list-size token
listSize    = ReadListSize(token)        // 0->0, 248->int8, 249->int16
token       = ReadByte()
if token==2 -> return null               // stream end marker
tag         = ReadStringAsString(token)
attribCount = (listSize - 2 + listSize%2) / 2
attrs       = ReadAttributes(attribCount)        // each = (key,value) string pair
if listSize is odd -> node has NO data/children  -> ProtocolTreeNode(tag, attrs)
else:
    token = ReadByte()
    if IsListTag(token) -> children = ReadList(...)  -> ProtocolTreeNode(tag, attrs, children)
    else                -> data = ReadString(...)    -> ProtocolTreeNode(tag, attrs, byte[]/utf8)
```

Confirmed constants and token semantics (`BinTreeNodeReader.cs`):
- **List size tokens:** `248`=int8 length, `249`=int16 length, `0`=empty (`:81-90`). `IsListTag` also accepts `0` (`:49-56`).
- **Stream-end marker:** a second-token value of `2` returns `null` (`:22-25`), which `WAProtocol` converts to a `StreamEndException` (§3.4).
- **String tokens** (`ReadString`, `:102-184`): dictionary tokens `3..PrimaryTokenMax` (with a two-byte sub-dictionary form when the primary lookup is null, `:108-119`); `252`=byte[] with int8 length, `253`=byte[] int20, `254`=byte[] int31, `255`=packed **nibble** (digits `0-9`,`-`,`.`), `251`=packed **hex**, `250`=legacy `user@server` JID, `247`=ad-JID `user[.device]@{s.whatsapp.net|lid}`, `246`=`jid_fb` **unsupported → throws** (`:179-180`).
- **ad-JID reconstruction** (`:160-178`): type byte → `UserJidType` (`Jid`→`@s.whatsapp.net`, `Lid`→`@lid`, `ToUserJidSuffix` `:330-338`); device byte appended as `.{device}` only when non-zero.
- Integer readers are big-endian: `ReadInt16` `(b0<<8)|b1` (`:226`), `ReadInt20` (`:233`), `ReadInt31` masks the top bit (`:241-248`).

The result is a **`ProtocolTreeNode`**: `string tag` + `ProtocolKeyValue[] attributes` + (`ProtocolTreeNode[] children` **xor** `byte[] data`) (`ProtocolTreeNode.cs:13`, typed accessors `GetAttributeValue/Int/Long/Bool/DateTime/Jid`, `GetChild`, `GetAllChildren`, `TagEquals` at `ProtocolTreeNode.cs:70-269`).

#### 3.3.2 Relevant wire tokens for receive (from `WAPDefaultTokenDictionary.primaryStrings`)

Single-byte primary tokens (0-based index = token value), all from `WAPDefaultTokenDictionary.cs:7-14`:

| Token | String | Token | String |
|---|---|---|---|
| 3 | `s.whatsapp.net` | 18 | **`offline`** |
| 4 | `type` | 19 | **`message`** |
| 5 | `participant` | 20 | `result` |
| 6 | `from` | 25 | `iq` |
| 7 | **`receipt`** | 27 | **`ack`** |
| 8 | `id` | 29 | `enc` |
| 9 | **`notification`** | 31 | `presence` |
| 11 | `status` | 50 | `skmsg` (sender-key msg) |
| 17 | `to` | 77 | `msg` |
| 24 | `notify` | 78 | **`offline_preview`** |

Multi-byte (sub-dictionary, two-byte token) examples relevant here: `offline_batch` and (further) `decrypt-fail` (`WAPDefaultTokenDictionary.cs:66,:20`). So `message`, `receipt`, `notification`, `offline`, `offline_preview` all compress to a **single byte** on the wire.

### 3.4 Top-level dispatch (`WAProtocol.ProcessStanza`) — the native drop point

`WAProtocol.ProcessStanza` (`WAProtocol.cs:34`) is a 3-way router keyed on connection state:

```csharp
if (node != null) {
    if (_isCompanionRegistration) ProcessMultiDeviceRegistrationNode(node);   // throws NotImplementedException
    else if (_isLoggedIn)         ProcessLoginStateStanza(node, size);
    else                          ProcessAuthenticationNode(node);
}
```

**Pre-login (`ProcessAuthenticationNode`, `WAProtocol.cs:84`):**
- `success` → set `_isLoggedIn = true`, read server clock from attr `t` via `GetAttributeDateTime("t")`, save it (`ClocksMonitor.Instance.SaveServerTime`), fire `LoggedIn` (`:86-92`). This is what flips `SocketAdapter` to Connected (§3.2).
- `failure` → parse `reason`/`code`/`expire`/`retry` into a `LoginFailureException` (`:95-138`). `reason` int maps to `LoginFailedReason`; values `>500` → `ServerBackoffRequest`. `TempBanned` computes `BanExpirationUtc = FunRunner.CurrentServerTimeUtc.AddSeconds(expire)` and optional `RetryUtc` (`:118-137`). The exception is **thrown** and caught in `SocketAdapter.ProcessFrame` (§3.2) → `LoginFailed`.

**Post-login (`ProcessLoginStateStanza`, `WAProtocol.cs:142`):**

```csharp
if (treeNode == null) throw new StreamEndException("Got stream end");
if (treeNode.TagEquals("iq")) ProcessIq(treeNode);
else Log.Warn("Unrecognized top-level stanza [" + treeNode?.tag + "]", …, "ProcessLoginStateStanza");
```

> **This is the documented drop.** After login the native layer **only** processes `iq`. `message`, `receipt`, `notification`, `presence`, `chatstate`, and `ib` all hit the `else` branch and are logged + discarded (`WAProtocol.cs:152-155`). The equivalent pre-`ProcessStanza` method `ProcessNode` (`:68-82`, apparently a vestigial/alternate entry) does the same: only `iq`, else "Unrecognized top-level stanza". A `null` node → `StreamEndException` (`:71-73, :144-146`), surfaced to trigger reconnect.

### 3.5 IQ correlation (`ProcessIq` + `IqRequestsTracker`)

The one stanza type the native layer fully handles inbound. `ProcessIq` (`WAProtocol.cs:158`):

```csharp
string id = node.GetAttributeValue("id");
string type = node.GetAttributeValue("type");
string from = node.GetAttributeValue("from");
if (type == null) throw new CorruptStreamException("missing 'type' attribute in iq stanza");
if (type.Equals("result")) { var h = _requestsTracker.PopIqHandler(id); if (h != null) h.Parse(node, from); }
else if (type.Equals("error")) { var h = _requestsTracker.PopIqHandler(id); if (h != null) h.ErrorNode(node); }
else Log.Warn("unknown iq type attribute: " + type, …);
```

- **Correlation is one-shot.** `IqRequestsTracker.PopIqHandler` looks up and **removes** the handler under `_iqHandlerLock` (`IqRequestsTracker.cs:45-55`); a duplicate/late `result` for an already-popped id is silently ignored (handler is `null`).
- **IDs.** `MakeId` returns an `Interlocked.Increment`-ed counter rendered as uppercase hex `num.ToString("X")` (or `prefix+num` if `IsVerboseId`) (`IqRequestsTracker.cs:35-43`). Handlers are stored in a `Dictionary<string, IqResultHandler>` (`:23`).
- **Error parse.** Default `IqResultHandler` error path iterates child `<error>` nodes and surfaces the int `code` attribute (`IqResultHandler.cs:54-62`).
- A missing `type` throws `CorruptStreamException` (`WAProtocol.cs:165`) → reconnect.

> Practical consequence for the port: the native IQ machinery exists primarily to support **native-initiated** request/response (e.g. `removecompanion`, dirty-bit clearing, ToS acks) and **native parsing of the `<thread_metadata>` info-broadcast**. The bulk message/receipt/offline traffic does **not** traverse this code.

### 3.6 The JS half owns the real message connection

Direct evidence the JS bundle runs its own end-to-end FunXMPP-over-Noise WebSocket connection (not merely a UI over the native socket):

- **Its own WebSocket:** `new WebSocket(e); i.binaryType="arraybuffer";` to `web.whatsapp.com` (`SjCAw3j6Bfsc…WiG.js`). Module dependency list includes `WANoiseSocket`, `WACryptoSha256`, and a `NoiseHandshake` class with `start`/reject-`UNINITIALIZED HANDSHAKE` lifecycle (`SjCAw3j6Bfsc…WiG.js`). So the JS performs its **own** Noise_XX/IK handshake and frame crypto, independent of the native `HandshakeHandler`.
- **Its own crypto, in-renderer (browser WebCrypto, not bridged):** the JS Noise/transport crypto calls `self.crypto.subtle` directly — AES-GCM (`importKey("raw",…,"AES-GCM"…)` + `decrypt({name:"AES-GCM",iv,additionalData},…)`), HKDF (`importKey("raw",…,"HKDF") → deriveKey({name:"HKDF",hash:"SHA-256",salt,info})`), and SHA-1/SHA-256 (`crypto.subtle.digest`), with a thin `WACryptoDependencies.getCrypto().subtle` wrapper that still resolves to WebCrypto (`SjCAw3j6Bfsc…WiG.js`). There is **no** host-object hop to a native primitive (see §3.6.1).
- **Its own token dictionary:** the same primary token strings (`…"to","offline","message","result","class","xmlns",…,"iq","t","ack",…,"enc","urn:xmpp:whatsapp:push","presence",…`) are embedded verbatim in `n6o0-NaJTww.js`, confirming a JS FunXMPP encoder/decoder mirroring `WAPDefaultTokenDictionary`.
- **Its own stanza decoders** (`decodeStanza`/`readNode`/`WABinaryDecoder`-style modules present across `a5gdgRhdCri.js`, `mEvs85pxZT4.js`, etc.).

Therefore the inbound message/receipt/notification/offline flow below is **JS-resident**. The native shell's contribution to *this* path is essentially: host the WebView, vend the bridges (SQLiteBridge for persistence, etc. — see doc on storage), and run the parallel native FunXMPP stack for login/IQ/VoIP.

#### 3.6.1 The native→JS bridge surface carries no socket/stanza frames

The two FunXMPP connections are **independent**: the native socket never forwards decrypted `message`/`receipt` frames into the WebView. This is provable by enumerating the *entire* bridge surface. C# registers exactly **27 host-object bridges** via `webView.AddWinRTBridge(name, …)` — **4** in `WhatsApp.Root/WhatsApp/App.cs:315-318` and **23** in `WhatsApp.Root/WhatsApp/AppModel.cs:218-241` (the 23rd is the Contacts bridge at `AppModel.cs:239`, registered under a runtime-chosen *variable* name: `"PopulatedContactsBridge"` if contacts are already synced, else `"ContactsBridge"`, `AppModel.cs:238`). The JS references the identical set as `chrome.webview.hostObjects.*Bridge`:

> `AbProps, Adv, AppActivation, BrowserExtensions, ClientKey, Connection, Contacts (a.k.a. PopulatedContacts), DebugFeatures, LinksPreview, MediaFiles, MediaTranscoding, NativeAppState, Pictures, Preferences, RateApp, ScalingControl, SeamlessMigration, ServerEncKeySalt, Sharesheet, SQLite, SystemIntegrations, TcToken, TouchpadFix, Voip, VoipSignaling, Wam, WebUpdate`

**None** of these is a socket/stanza/message/chat/noise/funxmpp conduit (grepping those terms over both the C# `AddWinRTBridge("…")` list and the JS `hostObjects.*` names is empty). `ConnectionBridge` is a `LifecycleBridge(_webLifecycle)` — connection *lifecycle* (online/offline + foreground), not a frame pipe (`App.cs:315`). The Contacts bridge is a contact-sync host-object (`new ContactsBridge(_contactsManager)`, `AppModel.cs:239`), not a frame pipe either. The chat socket is opened by JS itself (`new WebSocket → web.whatsapp.com`, §3.6). So the native and JS receive paths share only the *wire format*, never live bytes.

### 3.7 Offline-queue drain protocol (`<ib>` info-broadcast)

When a client (re)connects, the server flushes the **offline queue**: the messages/receipts/notifications that accrued while the client was disconnected. The drain is framed by **`<ib>` (info-broadcast)** control stanzas. The JS bundle defines the full `<ib>` child-type enum (`b1yokgAMCB8V…hl3RM.js`):

```js
Object.freeze({
  DIRTY:"dirty",
  ROUTING:"edge_routing",
  OFFLINE:"offline",
  OFFLINE_PREVIEW:"offline_preview",
  TOS:"tos",
  THREAD_META:"thread_metadata",
  CLIENT_EXPIRATION:"client_expiration",
  OFFLINE_PRIORITY_COMPLETE:"priority_offline_complete"
})
```

Mapping these to the drain lifecycle. The `<ib>` dispatch is now **traced**: a single `handleInfoBulletin` parses the `<ib>` child via a `hasChild` chain and `switch(n.type)`-es in fixed order `DIRTY → ROUTING → OFFLINE → OFFLINE_PREVIEW → TOS → THREAD_META → CLIENT_EXPIRATION` (`b1yokgAMCB8V…hl3RM.js`); every offline `<ib>` returns `"NO_ACK"` (these control stanzas are not themselves acked). The session order is:

1. **`<ib><offline_preview …>`** (open) — server announces the queue size *before* draining. Token `offline_preview` = primary token **78** (`WAPDefaultTokenDictionary.cs:14`). The preview node carries **per-class counts**: `offline_preview.attrInt("count")` plus separate `message`, `receipt`, `notification`, and `call` attrs (`b1yokgAMCB8V…hl3RM.js`), and a count is also parsed as attribute `offline` clamped to `[0,1024]` (`attrIntRange,e,"offline",0,1024`, `UBSny1JW6Io8…JTk.js`, `SjCAw…WiG.js`). It dispatches to `OfflineMessageHandler.processOfflinePreviewIb(count)`, which starts the `OFFLINE_RESUME` QPL marker + `AppTracker.start(OfflineResume)` and initializes `this.offlineResumeManager` (inspecting the preview `message` count to choose *resume-in-place* vs *restart client due to exceed the LIMIT* → `WAWebOfflineResumeUtils.refreshWindow()`) (`SjCAw3j6Bfsc…WiG.js`). This drives the "syncing N messages" UI.
2. **`<ib><offline …>`** (close, token `offline` = **18**) — the queue-complete marker. It dispatches to `OfflineMessageHandler.processOfflineIb(count) → offlineResumeManager.processOfflineSessionComplete(count)` and `AppTracker.stop(OfflineResume)` (`SjCAw3j6Bfsc…WiG.js`), also calling `reportOfflineNotifications()` and `maybeClearPendingMessages(count)`. (Two-byte token `offline_batch` also exists, `WAPDefaultTokenDictionary.cs:66`, for batched drains.) The backlog `message`/`receipt`/`notification` stanzas stream **between** the preview (open) and offline (close) markers.
3. Each drained **`message`/`receipt`/`notification`** stanza carries an **`offline="1"` attribute** so the client knows it came from the backlog rather than live. Confirmed: every inbound stanza parse attempts `t.offline = e.attrInt("offline")` (`SjCAw3j6Bfsc…WiG.js`). The `offline` flag suppresses notification toasts and lets the client batch/aggregate receipts and emit **pre-acks** during the drain (`sendOfflinePreAck`/`sendAndClearDanglingReceipts`, §3.8).
4. **`<ib><priority_offline_complete>`** (`OFFLINE_PRIORITY_COMPLETE`) — server signals the high-priority portion of the backlog is delivered. It **is** detected by the `<ib>` parser (`hasChild(INFO_TYPE.OFFLINE_PRIORITY_COMPLETE)` returns `{type: OFFLINE_PRIORITY_COMPLETE}`, `WAWebHandleInfoBulletin` at beautified `b1yok…hl3RM.js:45850-45852`) but has **no case** in `handleInfoBulletin`'s `switch` (the explicit cases are `DIRTY/ROUTING/OFFLINE/OFFLINE_PREVIEW/TOS/THREAD_META/CLIENT_EXPIRATION` at `b1yok…hl3RM.js:45905-45926`; `OFFLINE_PRIORITY_COMPLETE` falls to `default:return` → `undefined`). **Resolved this pass via exhaustive trace:** an exhaustive grep of the entire beautified bundle finds `priority_offline_complete`/`OFFLINE_PRIORITY_COMPLETE` in **exactly three places**, all inside `b1yok…hl3RM.js` — the enum definition (`:45718`) and the two parser-detection lines (`:45850-45851`). **There is no consumer of the parsed `{type: OFFLINE_PRIORITY_COMPLETE}` anywhere in the bundle**: the `<ib>` handler's return value is consumed by `WAWebCommsHandleLoggedInStanza` (`case "ib": return r("WAWebHandleInfoBulletin")(e)`, `UBSny…JTk.js:68845-68846`) **solely to decide acking** (`"NO_ACK"` / nack / `undefined`), and the offline state machine (`OfflineMessageHandler`/`offlineResumeManager`, `SjCAw…WiG.js:11337-11478`) exposes no priority-complete entry point — its only `<ib>`-driven hooks are `processOfflinePreviewIb` and `processOfflineIb`. So in **this** build the priority-complete marker is **parsed-but-inert**: the parser recognizes the token (so it is not logged as an "unrecognized info bulletin" and is not nacked), but it triggers **no** UI/state transition. The earlier hypothesis of a "different subscriber" is therefore disproven for this build. (See §6.5.)

> The native C# side does **not** implement any of steps 1–4 for `offline`/`offline_preview`/`priority_offline_complete`. The **only** `<ib>` sub-type with a native parser is **`thread_metadata`** (§3.7.1). All offline-drain `<ib>` handling is JS.

#### 3.7.1 Native `<ib><thread_metadata>` parser (the one offline-adjacent native path)

The native Smax-generated `ThreadMetadataServerRequest` parses a `<ib>` info-broadcast whose payload is `<thread_metadata>` — the server pushing per-thread "last activity" metadata (used to order/preview chats after an offline gap).

`ThreadMetadataServerRequest.Create` (`…Offline.Incoming/ThreadMetadataServerRequest.cs:22-49`):
- Asserts tag `"ib"` (`TryCheckNodeTag(node, "ib")`, `:27`).
- Requires attr `from`, **defaulting to `s.whatsapp.net`** (`TryGetRequiredJidAttributeValue(node, ["from"], false, JidFactory.CreateNewJid("s.whatsapp.net"), …)`, `:31`).
- Requires child `<thread_metadata>` parsed by `ThreadMetadataServerRequestThreadMetadata.Create` (`:35`).

`ThreadMetadataServerRequestThreadMetadata.Create` (`…ThreadMetadata.cs:24-43`):
- `TryGetChildren(node, ["item"], …Item.Create, min=0, max=50, …)` → **up to 50 `<item>` children** (`:29`).
- Optional **delayed mixin** (`TryGetOptionalMixin(node, ThreadMetadataDelayedMixin.Create, …)`, `:33`).

Each `<item>` (`…ThreadMetadataItem.cs:23-42`):
- Required `from` JID, accepted as `GroupJid` **or** `UserJid` (4-way enum cast, `:28`).
- Required `t` (long, range `[0, 9007199254740991]` = JS `Number.MAX_SAFE_INTEGER`, `:32`) — the thread's last-activity timestamp.

The **delayed mixin** (`ThreadMetadataDelayedMixin.cs:22-41`) optionally carries `<status_msgs>` and `<notifications>` children — i.e. status updates and notifications the server wants to delay-deliver alongside the metadata. Sub-parsers: `…StatusMsgs.cs`, `…StatusMsgsItem.cs`, `…Notifications.cs`.

This whole sub-protocol is parsed against a generated schema via `SmaxStandardLibrary` (path-array traversal + typed/required attribute extraction; failures return `Either<T, SmaxError>` with a human-readable `ParseError`). On a `CorruptStreamException` the parser logs via `FailuresService.Investigate` and returns a `SmaxError` rather than throwing (`ThreadMetadataServerRequest.cs:41-48`).

### 3.8 Receipts (acknowledging received messages)

There are **two distinct ack families**, split across the native/JS boundary:

**(a) Native notification/IQ acks** — built by `AckStanzaBuilder` (`AckStanzaBuilder.cs`). `CreateNotificationOkAckFromNotificationNode` echoes `from→to`, `participant`, `id`, `type` from an inbound `<notification>` and emits `<ack class="notification" …>`, optionally with a `<sync contacts="in|out"/>` child for contact-sync acks (`AckStanzaBuilder.cs:16-56`). JID typing is explicit via `ProtocolKeyValue.KVType` (`to`=`Jid`, `participant`=`PsaJidOrUserJidOrDeviceJid`, `:43-51`). These are written via `StanzaWriter` (§3.8.1).

> But recall: per §3.4 the native layer **drops** inbound `notification` stanzas after login. So in the *native FunXMPP connection* this builder is exercised only where the native stack itself owns a notification flow (e.g. contact-sync IQ acks). **Per-message delivery/read receipts (`class="message"`) are produced in JS, not here.**

**(b) JS message receipts** — the user-visible delivery (`<receipt>`) and read receipts are emitted by the JS receipt job. Confirmed module `WAWebSendReceiptJobCommon` with a `sendAggregateReceipts` entry and `sendReceipt` flags (`TSxMup…VSn.js`, `c7Ubf6OQTBc.js`). Offline-drained messages are receipt-aggregated: the `offline` marker (§3.7 step 3) lets JS batch many backlog receipts into aggregate `<receipt>` stanzas instead of one-per-message, reducing chatter on reconnect. `sendReadStatus(…, {sendReceipt})` wires read-receipt emission to the same job (`c7Ubf6OQTBc.js`).

The **aggregate-stanza shape is now reconstructed** (`SjCAw3j6Bfsc…WiG.js`). `sendAggregateReceipts({to, type, t, groupedReceipt, threadId, recipient})` takes `groupedReceipt` = `Map<participant, messageId[]>`. Per participant the id list is **batched in slices of 256** (`_.splice(0,m)`, `m=256`); each batch becomes one node:

```
<receipt to=<JID> type=<type|drop-if-delivery> id=<firstId> t=<t> participant=… peer_participant_pn=… recipient=…>
    <list>                         <!-- present only when batch has >1 id -->
        <item id=<id2>/>
        … up to 255 more …
    </list>
</receipt>
```

i.e. the **first** id rides the `<receipt id>` attribute and the **remaining** ids (`e.slice(1)`) go into a single `<list>` of `<item id=…/>` children, capped at **256 ids per stanza**. `type=DELIVERY` is dropped to default (`DROP_ATTR`); `READ`/`PLAYED`/`READ_SELF`/`PLAYED_SELF`/`HISTORY_SYNC_COMPLETION` are sent explicitly (`WAWap.wap("receipt",{…})` build, same file). During an offline drain these are emitted as **pre-acks** (`sendOfflinePreAck`, `sendAndClearDanglingReceipts`).

#### 3.8.1 Outbound write path (how any ack/receipt leaves the native side)

For completeness, the native send path that `AckStanzaBuilder` output flows through is `StanzaWriter.Write` (`StanzaWriter.cs:25`):
1. `BinTreeNodeWriter.Write` serializes the node to FunXMPP bytes.
2. `WriteStanza` (`:35-72`) prepends a **1-byte flag**: tries Deflate (flag `2`) and keeps it only if smaller, else flag `0` + raw (`:44-66`); guards `>= 33554432` (32 MiB) as fatal.
3. `WriteEncrypted` (`:74-78`) AES-GCM-encrypts with the **write key** and a separate incrementing 12-byte nonce `_writeNonce++` (`:76`), **no AAD**, then `FramesWriter.WriteFrameInternal` prepends the 3-byte length and sends. This is the exact mirror of the receive path in §3.3.

---

## 4. Native Dependencies

| Piece | Native dependency | Confirmed? |
|---|---|---|
| AES-GCM frame decrypt | WinRT `Windows.Security.Cryptography.Core.SymmetricKeyAlgorithmProvider` / `CryptographicEngine.DecryptAndAuthenticate` (`AesGcmProvider.cs:40,:59`) | **Confirmed** (managed WinRT call, not C++) |
| zlib inflate | `ICSharpCode.SharpZipLib` `InflaterInputStream` (`EncryptedBytesReceiver.cs:2`) | **Confirmed** (managed lib) |
| Noise handshake / transport keys | `HandshakeHandler` / `HandshakeCipher` (managed C#); curve25519 ECDH delegated to native `WhatsAppNative.Curve25519` | **Confirmed managed glue; native Curve25519 native-confirmed** — radare2 shows the X25519 Montgomery-ladder constant `a24=121665` (`0x0001DB41`) + SHA-512 statically present and the class exposing `Curve25519::{Derive,Sign,Verify,GenKeyPair}` (X25519 ECDH + XEdDSA signing); `@signalapp/libsignal-client` is bit-compatible (doc 96 §1) |
| FunXMPP parse | Pure managed C# (`BinTreeNodeReader`) | **Confirmed** (no native dep) |
| **JS message/offline/receipt path** | JS-internal `WANoiseSocket`/`NoiseHandshake`/FunXMPP decoder + **browser WebCrypto** `self.crypto.subtle` (AES-GCM/HKDF/SHA-256, via `WACryptoDependencies.getCrypto().subtle`) (`SjCAw…WiG.js`) | **Confirmed JS-resident + in-renderer WebCrypto** — no host-object hop to a native primitive (§3.6, §3.6.1) |
| Native chat-receive C++/Rust engine | **None exists.** `strings WhatsAppNative.dll` finds no `BinTreeNode`/`EncryptedBytesReceiver`/`WAProtocol`/`FramesReader`/`ProcessStanza`; the only native FunXMPP is VoIP (`wa_call_xmpp_stanza_*`, `…\wa-voip\wacall\…\wa_call_xmpp_stanza.cc`) | **Confirmed via `objdump`/`strings`** — chat receive path is purely managed C#; Ghidra dumps are empty but native re-analysis is available and shows nothing to recover. The DLL is **fully disassemblable** (`objdump -d` → 2.53M instruction lines) but **stripped** (`objdump -t`/`nm` = "no symbols"; only 2 PE exports `DllCanUnloadNow`/`DllGetActivationFactory`), so functions are address-enumerable via `.pdata` but carry no names — §6.6 |
| `WhatsAppNative.dll` import table (round-3, **[native-binary]** `objdump -p`) | Dynamic deps: `bcrypt.dll` (**RNG only** — exports exactly `BCryptGenRandom`/`BCryptOpenAlgorithmProvider`/`BCryptCloseAlgorithmProvider`, **no** `BCryptEncrypt`/`BCryptDeriveKeyPBKDF2`/`BCryptHashData`), `WhatsAppRust.dll`, `MFPlat.DLL`+`MFReadWrite.dll` (Media Foundation), `WS2_32.dll` (native Winsock), `d2d1`/`d3d11`/`dxgi`/`MMDevAPI` (GPU/audio) | **Confirmed [native-binary]** — corrects doc 92's "CNG/bcrypt for AES/HMAC": the SQLite codec, Signal, and Noise AES/HMAC/SHA/KDF are **statically linked** (BoringSSL-from-WebRTC; in-binary strings `hkdf_sha256`, `HMAC-SHA256`, "derive hkdf for cert fingerprint hmac"), not done via CNG. Bcrypt is used only for entropy. |

**Net:** the native *receive* path (§3.1–§3.5) has **no hard native-C++ dependency** beyond WinRT AES-GCM; it is almost entirely managed C# + SharpZipLib. The *JS* receive/offline path (§3.6–§3.8) is self-contained in the bundle and uses browser crypto. The native `WS2_32.dll` Winsock imports (`WSASocketW`/`WSAIoctl`/`WSAAddressToStringW`) belong to the **VoIP PJSIP/PJLIB ICE stack** (`xplat\wa-voip\third_party\pj\pjlib\src\pj\sock_bsd.c`, `os_core_win32.c`), **not** the chat-receive socket — so even the one native-socket facility in the binary is VoIP, reinforcing that there is no native chat-receive transport. **(round-3 [native-binary])**

---

## 5. Linux/Electron Port Mapping

The strategic decision the port faces: **reuse the waweb JS bundle's receive/offline/receipt machinery, or reimplement it natively in Node.** The decompiled evidence strongly favors **reuse** — because the real message/offline/receipt logic is *already* JS and *already* runs over a WebView2-equivalent WebSocket.

| Windows piece | Electron/Node equivalent | Notes / risk |
|---|---|---|
| WebView2 hosting the JS bundle | Electron `BrowserWindow` / `<webview>` loading `web.whatsapp.com` (or the bundled JS) | The JS already owns its WebSocket+Noise+FunXMPP+offline+receipts. If you load WhatsApp Web in Electron, **most of this document's behavior comes for free** — no native receive path needed. This is the lowest-risk path. |
| Native FunXMPP receive stack (§3.1–§3.5) | Only needed if you build a **headless/native** client instead of hosting JS. Then: a Node TCP/TLS socket + a 24-bit length de-framer (trivial port of `FramesReader`) | The de-framer (`OnBytesAvailable`) is ~20 lines; port verbatim. |
| AES-GCM decrypt (`AesGcmProvider`) | Node `crypto.createDecipheriv('aes-256-gcm', key, iv)` with `setAuthTag(last16)`; or `@noble/ciphers` `gcm` | 12-byte big-endian counter nonce, **no AAD** for stanza frames, 16-byte tag appended. Independent send/recv counters from 0 post-handshake. |
| zlib inflate | Node built-in `zlib.inflateSync` / `createInflate` | flag bit `0x2` of first plaintext byte; strip flag byte either way. |
| FunXMPP parser (`BinTreeNodeReader`) | Port to TS, or reuse a maintained lib (the Baileys project's `WABinary` decoder is the same format). Embed the 236-entry primary + 4×256 secondary token tables from `WAPDefaultTokenDictionary` | Token tables must match the server's dictionary version (`WA\x06<dictVer>` header). Risk: dictionary drift across versions. |
| Noise XX/IK handshake | `@noble/curves` x25519 + `@noble/ciphers` AES-GCM + `@noble/hashes` sha256/hkdf; or `noise-c` bindings | Out of this doc's scope (see networking-core doc), but a prerequisite if going headless. |
| IQ correlation (`IqRequestsTracker`) | A `Map<string, {resolve,reject}>` keyed by uppercase-hex incrementing id; pop-on-result | One-shot semantics; mirror `PopIqHandler`. |
| **Offline drain (`<ib>` offline/offline_preview/priority_offline_complete)** | **Reuse JS bundle.** If headless: implement the `<ib>` type dispatch (enum in §3.7), read `offline_preview`'s `offline` count (0–1024), treat `offline="1"` on `message`/`receipt`/`notification` as backlog, finish on `priority_offline_complete` | Highest-value reuse target. Reimplementing the *semantics* (toast suppression, receipt aggregation, sync-state UI) from the minified bundle is substantial; prefer hosting JS. |
| `<ib><thread_metadata>` parser (native) | Port the Smax schema if headless (3.7.1); else JS handles it | Bounded: ≤50 `<item>`, `t` ≤ `Number.MAX_SAFE_INTEGER`, optional delayed `status_msgs`/`notifications`. |
| Receipt send (`WAWebSendReceiptJobCommon` / `AckStanzaBuilder`) | Reuse JS; or build `<ack class="notification">` / `<receipt>` via the FunXMPP encoder | Aggregate-receipt batching on offline drain is important for not hammering the server on reconnect. |
| `StreamEndException`/null-node → reconnect | Detect FunXMPP stream-end token (`2`) → close+reconnect with backoff | See networking-core doc for the Fibonacci backoff. |

**Gaps / risks called out:**
- The exact **aggregate-receipt** and **priority_offline_complete** state-machine semantics are in minified JS and only partially reconstructed (§3.8b). Hosting the JS bundle avoids needing them.
- The **token-dictionary version** must track the server; a mismatch corrupts parsing. Native code reads it as a runtime dictionary (`FunXMPP.Dictionary`) — the port must do the same and update with bundle revisions.
- Native inbound **fragmentation** (`FlagMoreFragments`/`MaxFragmentSize`) appears **unused** in the native receive path (§3.3) — likely the server never fragments inbound frames to this client, but a robust port should still handle a `more-fragments` flag defensively. **(inference)**

---

## 6. Open Questions / Unverified

Every item below was **re-investigated this pass** against the minified JS bundle (`waweb-source-bundle/`), the readable C# dump (`decompiled/`), and the shipped native binaries (`x64/`, via `strings`/`objdump`). Each is now prefixed with a bold verdict tag and the concrete finding + citation; the original question is preserved so the reader sees what was asked.

1. **[RESOLVED] Exact offline-drain sequencing in JS.** *Asked: the precise ordering of preview → batches → complete and the state transitions were inferred, not traced through the minified control flow.* The full `<ib>` info-bulletin dispatch is now traced. A single handler parses the `<ib>` child via a `hasChild` chain and then `switch(n.type)`-es in this fixed order: `DIRTY` → `ROUTING` (`edge_routing`) → `OFFLINE` → `OFFLINE_PREVIEW` → `TOS` → `THREAD_META` → `CLIENT_EXPIRATION` (`b1yokgAMCB8V…hl3RM.js`, function `handleInfoBulletin`). Sequencing across the session: **(a)** `<ib><offline_preview>` arrives first and calls `OfflineMessageHandler.processOfflinePreviewIb(count)`, which starts the `OFFLINE_RESUME` QPL marker, fires `AppTracker.start(OfflineResume)`, and initializes `this.offlineResumeManager` (it inspects the preview `message` count to decide *resume-in-place* vs *restart client due to exceed the LIMIT* via `WAWebOfflineResumeUtils.refreshWindow()`) (`SjCAw3j6Bfsc…WiG.js`, `processOfflinePreviewIb`). **(b)** The backlog `message`/`receipt`/`notification` stanzas are then streamed, each carrying `offline="1"`; the client emits aggregated **pre-acks** during the drain (`sendOfflinePreAck`, `sendAndClearDanglingReceipts`, same file). **(c)** `<ib><offline>` arrives last and calls `processOfflineIb(count)` → `offlineResumeManager.processOfflineSessionComplete(count)` and `AppTracker.stop(OfflineResume)`, ending the session. The returned `"NO_ACK"` for every offline `<ib>` confirms these control stanzas are not themselves acked. So the order is **preview (open) → drained stanzas + pre-acks → offline (close)**, matching the table in §3.7, now from traced control flow rather than inference.
2. **[RESOLVED] Does the native socket ever forward raw message frames to JS?** *Asked: a hidden bridge path forwarding decrypted `message`/`receipt` frames into the WebView could not be 100% excluded.* It is now excluded by enumerating the **complete** native→JS bridge surface. C# registers exactly **27** host-object bridges via `webView.AddWinRTBridge(…)`, split across two files: **4** in `WhatsApp.Root/WhatsApp/App.cs:315-318` (`ConnectionBridge, TouchpadFix, NativeAppStateBridge, WebUpdateBridge`) and **23** in `WhatsApp.Root/WhatsApp/AppModel.cs:218-241` (`VoipBridge, VoipSignalingBridge, WamBridge, AbPropsBridge, PreferencesBridge, RateAppBridge, ScalingControlBridge, ClientKeyBridge, PicturesBridge, SQLiteBridge, MediaFilesBridge, MediaTranscodingBridge, SharesheetBridge, AppActivationBridge, TcTokenBridge, SeamlessMigrationBridge, SystemIntegrationsBridge, LinksPreviewBridge, BrowserExtensionsBridge, AdvBridge, ` the **Contacts bridge** registered under a runtime *variable* name at `AppModel.cs:239` — `"PopulatedContactsBridge"` if contacts are already synced else `"ContactsBridge"`, chosen at `AppModel.cs:238`, `DebugFeaturesBridge, ServerEncKeySaltBridge`). The JS side references the identical set under `chrome.webview.hostObjects.*Bridge`. **None** is a socket/stanza/message/chat/noise/funxmpp conduit (grep for those terms over both the C# `AddWinRTBridge(...)` list and the JS `hostObjects.*` names returns empty). `ConnectionBridge` is a `LifecycleBridge(_webLifecycle)` (online/offline + foreground lifecycle, `App.cs:315`), not a frame pipe; the Contacts bridge is a contact-sync host-object (`new ContactsBridge(_contactsManager)`, `AppModel.cs:239`), not a frame pipe either. Meanwhile the JS opens **its own** socket: `new WebSocket(e); i.binaryType="arraybuffer"` to `web.whatsapp.com` (`SjCAw3j6Bfsc…WiG.js`). The two FunXMPP connections are therefore independent; the native socket does not forward message/receipt frames to JS.
3. **[RESOLVED] JS frame crypto backing.** *Asked: whether the JS Noise/AES-GCM uses browser `crypto.subtle` or a bridged native primitive was not confirmed.* It is **browser WebCrypto**, called directly. The Noise/transport crypto in `SjCAw3j6Bfsc…WiG.js` uses `self.crypto.subtle` for every primitive: AES-GCM decrypt `self.crypto.subtle.importKey("raw",o,"AES-GCM",…); self.crypto.subtle.decrypt({name:"AES-GCM",iv,additionalData:n},…)`, HKDF `self.crypto.subtle.importKey("raw",t,"HKDF",…); deriveKey({name:"HKDF",hash:"SHA-256",salt,info},…)`, and SHA-1/SHA-256 `self.crypto.subtle.digest`. A thin indirection `WACryptoDependencies.getCrypto().subtle.encrypt/decrypt({name:"AES-GCM",iv,additionalData},…)` wraps it but still resolves to WebCrypto (no host-object hop). This matches Q2: there is no native crypto bridge, so the JS crypto is in-renderer WebCrypto, not a bridged native primitive.
4. **[RESOLVED] Aggregate-receipt wire shape.** *Asked: the exact `<receipt>` aggregate stanza structure (item lists, `t` ranges) was not reconstructed.* `WAWebSendReceiptJobCommon.sendAggregateReceipts({to, type, t, groupedReceipt, threadId, recipient})` is now reconstructed (`SjCAw3j6Bfsc…WiG.js`). `groupedReceipt` is a `Map<participant, messageId[]>`. For each participant the id list is **batched in slices of 256** (`var e=_.splice(0,m)` with `m=256`). Each batch builds one node `WAWap.wap("receipt", {to: JID(R), type, id: CUSTOM_STRING(e[0]), t, participant, peer_participant_pn, recipient, …})`: the **first** id becomes the `id` attribute, and if the batch has more than one id the **remainder** (`e.slice(1)`) is emitted as a single `<list>` child of `<item id="…"/>` elements (`wap("list",null,e.slice(1).map(e=>wap("item",{id:CUSTOM_STRING(e)})))`). `type=DELIVERY` is dropped to the default (`DROP_ATTR`); read/played/read_self/played_self/history_sync_completion are sent explicitly. So the aggregate shape is `<receipt to=… type=… id=<first> t=… …><list><item id=…/>…(≤255)…</list></receipt>`, ≤256 ids per stanza. (Folded into §3.8b.)
5. **[RESOLVED] `priority_offline_complete` client effect** *(via exhaustive bundle trace on the beautified bundle).* *Asked: its precise effect on the "syncing" UI / connection state is inferred.* **Now nailed: in this build the marker is parsed-but-inert — it has no client effect.** An exhaustive grep of the entire beautified bundle (`research/waweb-unmin/*.js`) finds `priority_offline_complete`/`OFFLINE_PRIORITY_COMPLETE` in **exactly three places**, all inside `WAWebHandleInfoBulletinTypes.flow` / `WAWebHandleInfoBulletin` (`b1yok…hl3RM.js`): the enum definition (`:45718`) and the two parser-detection lines (`:45850-45851`, returning `{type: OFFLINE_PRIORITY_COMPLETE}`). **No other module reads that type.** In `handleInfoBulletin` the `switch(n.type)` has explicit cases only for `DIRTY/ROUTING/OFFLINE/OFFLINE_PREVIEW/TOS/THREAD_META/CLIENT_EXPIRATION` (`b1yok…hl3RM.js:45905-45926`); `OFFLINE_PRIORITY_COMPLETE` falls to `default:return` (`undefined`). The single caller is `WAWebCommsHandleLoggedInStanza` (`case "ib": return r("WAWebHandleInfoBulletin")(e)`, `UBSny…JTk.js:68845-68846`), which uses the return value **only** for the ack decision (`"NO_ACK"`/nack/`undefined`) — and because the parser *recognized* the token (returned a success object, not a parse error), it is neither nacked nor logged as "unrecognized". The offline state machine `OfflineMessageHandler`/`offlineResumeManager` (`SjCAw…WiG.js:11337-11478`) exposes **no** priority-complete entry point: its only `<ib>`-driven hooks are `processOfflinePreviewIb` (`:11358`) and `processOfflineIb` (`:11393`); the "syncing" progress / resume-screen state (`getOfflineDeliveryProgress`, `getResumeUIProgressBarType`, `shouldUseOfflineResumeScreen`) is driven by per-stanza decrypt accounting and the final `processOfflineSessionComplete(count)` on the `<ib><offline>` close, **not** by the priority marker. So the earlier hypothesis of a "different subscriber (offlineResumeManager/QPL progress)" is **disproven** for this build: `priority_offline_complete` is recognized so the server sees a well-formed (NO_ACK) client, but it drives no UI/state transition. *(Cross-reference: neither whatsmeow nor Baileys model `priority_offline_complete` at all — grep of `research/external/whatsmeow` and `research/external/Baileys/src` returns empty — consistent with it being a no-op marker on the client side.)* (Folded into §3.7 step 4.) **Residual:** whether a *future* bundle build wires a subscriber, or whether an A/B-gated codepath (not present in this snapshot) consumes it, would require a different bundle revision; for the snapshot in `research/waweb-unmin` the answer is definitive.
6. **[PARTIAL] Native C++/Rust receive internals.** *Asked: both Ghidra dumps are empty/erroring, so no native-binary confirmation of any low-level socket/crypto detail was possible.* **Verdict held at PARTIAL** because a byte-level disassembly of a *named routine* still has not been produced — and this pass establishes the structural reason it can't be from static tooling alone: `WhatsAppNative.dll` is **stripped** (`objdump -t` and `nm` both report **"no symbols"** — i.e. zero symbol-table entries; the export table has exactly **2** functions, `DllCanUnloadNow` + `DllGetActivationFactory`, the bare WinRT activation stubs — confirmed this session [native-binary] `objdump -t`/`nm`/`objdump -p`). There are **no internal function symbols to name**, so disassembly yields raw-address ranges (e.g. `180001000: 81 f9 7f 3e 00 00  cmp $0x3e7f,%ecx`), and naming any routine requires RE, not extraction. The substantive concern — "is there native chat-receive code to recover?" — is now answered **NO** from multiple independent angles (a–d below), and the round-3 import-table evidence positively reattributes the binary's *only* native socket/crypto facilities to VoIP, so nothing in §3.1–§3.5 has a native body to recover.
   - **Round-2 corpus is categorically inapplicable to a native-binary residual** (the beautified bundle, whatsmeow, and Baileys are JS/Go/TS *protocol* implementations — they recover *algorithms*, not the byte-level body of `WhatsAppNative.dll`; per the honesty rules they cannot close a disassembly question). Confirmed unchanged.
   - **Ghidra dumps remain unusable** (re-verified [native-binary]: `ghidra-output/WhatsAppNative-functions.txt` = **0 bytes**; `WhatsAppRust-functions.txt` = 242 bytes, the "Ghidra was not started with PyGhidra" error). But `objdump`/`nm`/`strings` re-analysis **is** available: `objdump -f x64/WhatsAppNative.dll` → `pei-x86-64`; `objdump -d` yields **~2.53M** disassembled instruction lines, so the binary *is* fully disassemblable.
   - **(a) No native chat-receive engine** [native-binary]: `strings -n 6 WhatsAppNative.dll` finds **zero** of `BinTreeNode`/`EncryptedBytesReceiver`/`WAProtocol`/`FramesReader`/`ProcessStanza` — the native *chat* receive path is purely the managed C# layer of §3.1–§3.5, not a hidden native module.
   - **(b) Only native FunXMPP is VoIP** [native-binary]: `wa_call_xmpp_stanza_element_*` from `xplat\wa-voip\wacall\system\src\protocol\xmpp\wa_call_xmpp_stanza.cc` — call-signaling, not chat.
   - **(c) round-3 import-table audit** [native-binary, `objdump -p`, re-verified this session]: `WhatsAppNative.dll` dynamically imports `bcrypt.dll` for **RNG only** — exactly `BCryptGenRandom` + `BCryptOpenAlgorithmProvider` + `BCryptCloseAlgorithmProvider` (confirmed verbatim this pass), with **no** `BCryptEncrypt`/`BCryptDeriveKeyPBKDF2`/`BCryptHashData`. So all AES/HMAC/SHA/KDF for the at-rest SQLite codec and for Signal/Noise are **statically linked** (BoringSSL-from-WebRTC; in-binary strings confirmed this session: `hkdf_sha256`, `Failed to generate HMAC-SHA256 status = %d`, `Failed to derive hkdf for cert fingerprint hmac, error %d`, `data-channel cert fingerprint hmac`), **correcting doc 92's round-1 "CNG/bcrypt" overstatement**. The binary's only native sockets are `WS2_32.dll` `WSASocketW`/`WSAIoctl`/`WSAAddressToStringW` (confirmed this pass), and the surrounding strings place them in the **VoIP PJSIP/PJLIB ICE** stack (`xplat\wa-voip\third_party\pj\pjlib\src\pj\...` confirmed this session, e.g. `wa_voip_err_detector.c` and the `buck-out\...\wa_voip\third_party\pj\pjlib` build paths) — i.e. even native Winsock here is VoIP, not the chat-receive transport (chat receive is managed C# `SocketAdapter`, §3.1–3.2, + the JS WebSocket, §3.6). Other dynamic deps: `WhatsAppRust.dll` (wamedia), `MFPlat.DLL`/`MFReadWrite.dll` (Media Foundation), `d2d1`/`d3d11`/`dxgi`/`MMDevAPI` (GPU/audio). (Folded into §4 and cross-referenced to docs 94/95 on the at-rest key chain.)
   - **(d) NEW this-pass disassemblability + stripped-binary confirmation** [native-binary, `objdump -d`/`-t`/`-p`]: `objdump -d WhatsAppNative.dll` now yields **2,529,889** instruction lines — the `.text` disassembles cleanly and completely, so the binary *is* fully disassemblable in principle. But it is **stripped**: `objdump -t` and `nm` both report **"no symbols"** (zero symbol-table entries) and the PE export table holds just `DllCanUnloadNow`/`DllGetActivationFactory`. Functions are still *enumerable by address* via the `.pdata` Function Table (each entry gives `BeginAddress`/`EndAddress`/`UnwindData`, e.g. `Begin 0x180001050 End 0x180001139`), so a *targeted* disassembly of an address range is possible — but there is no symbol to map an address back to a *named* routine without manual RE. Re-confirmed alongside this: `strings -n 6` finds **zero** of `BinTreeNode`/`EncryptedBytesReceiver`/`WAProtocol`/`FramesReader`/`ProcessStanza` (no chat-receive engine), and the only FunXMPP strings are the VoIP `wa_call_xmpp_stanza_*` set from `xplat\wa-voip\wacall\system\src\protocol\xmpp\wa_call_xmpp_stanza.cc`.
   - **Residual (why this stays PARTIAL):** a byte-level disassembly of a *specific named routine* has still not been produced, and this pass shows *why it cannot be from static tooling alone* — the binary is stripped (2 exports; `objdump -t`/`nm` report "no symbols"), so addresses don't carry routine names; producing one requires manual RE to attribute an address (enumerable via `.pdata`) to a function. For *this* doc's receive path that residual is **moot** (the path is managed C#; the native crypto/socket that exists is VoIP, now confirmed from five independent angles: absent chat symbols, VoIP-only FunXMPP, VoIP-only Winsock, RNG-only bcrypt, statically-linked BoringSSL crypto strings). **Would close a deeper native question:** a PyGhidra-enabled re-export (Ghidra dumps remain unusable — `WhatsAppNative-functions.txt` = 0 bytes), or a manual `objdump -d --start-address=…/--stop-address=…` / `capstone` disassembly of a `.pdata`-enumerated address plus RE to name it — feasible now (the `.text` disassembles cleanly) but unnecessary for the chat receive path. Round-2 protocol corpus does not and cannot move this residual; round-3 + this-pass [native-binary] evidence shrinks it to "no chat-receive body exists to disassemble, and the binary is stripped so no named native routine can be extracted, only RE'd."
