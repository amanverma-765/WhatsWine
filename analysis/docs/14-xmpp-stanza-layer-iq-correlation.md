# 14. XMPP Stanza Layer & IQ Correlation

> Target: Meta native WhatsApp for Windows (`WhatsApp.Root.exe`, WinUI 3 / Windows App SDK 1.6, v2.2607.106.0).
> All citations are `relative/path:LINE`, with paths relative to `decompiled_source/`. Lines were read directly from the decompiled C#. Native bodies (C++/Rust) are inferred from their managed callers for instruction-level detail; however, the native crypto *scheme* is no longer merely inferred — `WhatsAppNative.dll` was successfully analysed with radare2 (the legacy Ghidra `ghidra-output/WhatsAppNative-functions.txt` being 0 bytes is a tooling artifact, not the ceiling), confirming the AES/HMAC/SHA primitives and Curve25519 class are statically present (doc 96).

## 1. Purpose & Scope

This document covers the **XMPP-shaped application layer** that sits on top of the Noise transport: the in-memory stanza model (`ProtocolTreeNode`), how decrypted frames become routed stanzas (`WAProtocol.ProcessStanza`), the request/response correlation engine for `iq` stanzas (`IqRequestsTracker` + `IqResultHandler` + `Connection`), how stanzas are constructed for sending (`ConnectionExtensions`, `StanzaBuilders`, SMAX `*.Outgoing`) and validated on receive (SMAX `*.Incoming`), and the DNS/IP resolution chain (`WhatsApp.Resolvers`) that picks the endpoint the whole stanza layer runs over.

**Critical architectural fact, confirmed in code:** the native C# layer is *not* a full XMPP client. After login it natively handles only three top-level tags — `iq`, `success`, `failure`. Every other top-level stanza (`message`, `receipt`, `notification`, `presence`, `chatstate`, `ib`, `ack`, …) is logged as `"Unrecognized top-level stanza"` and dropped (`WhatsApp.Root/WhatsApp/WAProtocol.cs:80`, `:154`). Those stanza families live in the WhatsApp Web JS bundle running in WebView2. The native side is essentially: (a) the Noise/FunXMPP codec, (b) login state machine, (c) an `iq` correlation router for the handful of IQs the native shell itself issues (e.g. `removecompanion`, `clean`/dirty-bits, native pings). The bulk of `iq` traffic (chat queries, key fetches, group metadata) is built and parsed in JS and only transits this layer as opaque `ProtocolTreeNode`s via the bridge.

Out of scope (covered elsewhere): Noise handshake internals, AES-GCM frame crypto, the FunXMPP binary token tables, Signal/double-ratchet, VoIP signaling.

## 2. Where It Lives

Stanza model (`WhatsApp.Networking.dll`):
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolTreeNode.cs` — the in-memory stanza element.
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolKeyValue.cs` — one attribute (key/value + JID-type flag).
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolTreeNodeBuilder.cs` — fluent builder + `Merge`.
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolNodeExtensions.cs` — `TagEquals` / `TagEqualsAny`.
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolNodeValueParser.cs` — timestamp parsing for `t` attrs.

IQ correlation & connection facade:
- `decompiled/WhatsApp.Networking/WhatsApp/IqRequestsTracker.cs` — id generation + pending-handler map.
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.XMPP/IqResultHandler.cs` — the one-shot result/error callback pair.
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.XMPP/IConnection.cs` + `IConnectionOutput.cs` — the send/correlate contract.
- `decompiled/WhatsApp.Networking/WhatsApp/Connection.cs` — `IConnection` facade wrapping output + tracker.
- `decompiled/WhatsApp.Root/WhatsApp/ConnectionExtensions.cs` — higher-level `md`-namespace IQ helpers.

Protocol state machine / dispatch (`WhatsApp.Root.dll`):
- `decompiled/WhatsApp.Root/WhatsApp/WAProtocol.cs` — `ProcessStanza`, auth-node, `ProcessIq`.
- `decompiled/WhatsApp.Root/WhatsApp/EncryptedBytesReceiver.cs` — decrypt → inflate → parse → `ProcessStanza`.
- `decompiled/WhatsApp.Root/WhatsApp/StanzaWriter.cs` — serialize → compress → encrypt → frame.
- `decompiled/WhatsApp.Root/WhatsAppCommon/SocketAdapter.cs` — handshake→protocol wiring; constructs the `WAProtocol`/`EncryptedBytesReceiver`/`StanzaWriter` and owns the foreground-ping timeout.
- `decompiled/WhatsApp.Root/WhatsAppCommon/ConnectionManager.cs` — owns the single long-lived `IqRequestsTracker`.

Errors / enums:
- `decompiled/WhatsApp.Networking/WhatsApp/StreamEndException.cs`, `CorruptStreamException.cs`, `LoginFailureException.cs`, `LoginFailedReason.cs`.

Stanza factories / SMAX:
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.StanzaBuilders/AckStanzaBuilder.cs`, `ClearDirtyStanzaBuilder.cs`.
- `decompiled/WhatsApp.Networking/WhatsApp.Smax.Generated.Pings.Outgoing/ClientRequest.cs` (representative outgoing IQ).
- `decompiled/WhatsApp.Networking/WhatsApp.Smax.Generated.Pings.Incoming/ClientResponseServerResponse.cs` (representative incoming IQ + reference correlation).
- `decompiled/WhatsApp.Networking/WhatsApp.Networking.Smax/SmaxStandardLibrary.cs` — runtime validation helpers.

DNS/IP resolution (`WhatsApp.Resolvers`):
- `decompiled/WhatsApp.Networking/WhatsApp.Resolvers/IResolver.cs`, `ChainResolver.cs`, `ResolveResult.cs`, `ResolverExtensions.cs`.

## 3. How It Works

### 3.1 The stanza element: `ProtocolTreeNode`

A stanza is a tree of `ProtocolTreeNode`. Each node is **sealed** and holds exactly four fields (`ProtocolTreeNode.cs:13-19`):

```csharp
public string tag;
public ProtocolKeyValue[] attributes;
public ProtocolTreeNode[] children;
public byte[] data;
```

Invariant — a node has **either** `children` **or** `data`, never both. The constructors enforce it by routing through `Init(tag, attrs, childNodes=null, dataBytes=null)` (`:288-294`): the `(tag, attrs, byte[])` and `(tag, attrs, string)` ctors set `data` and leave `children` null (`:31-39`); the child ctors set `children` and leave `data` null. `attributes` defaults to `Array.Empty<ProtocolKeyValue>()` when null (`:291`). String data is UTF-8 with line-ending normalization (`Encoding.UTF8.GetBytes(data.ConvertLineEndings())`, `:38`).

Typed attribute accessors all funnel through `GetAttribute(key)` → linear scan of `attributes` (`:70-85`) → `GetAttributeValue` returns `.value` or null (`:87-90`). On top of that:
- `GetAttributeInt/UInt/Long/Ulong/Bool` — `TryParse`, null on miss (`:99-189`).
- `GetMandatoryAttributeLong` — same but logs `FailuresService.Investigate("missing mandatory attribute ...")` when absent (`:151-159`).
- `GetAttributeDateTime` — parses a unix-seconds string via `ProtocolNodeValueParser.TryParseTimestamp` (`:92-97`). That parser is `unixEpoch.AddSeconds(l)` (`ProtocolNodeValueParser.cs:19-38`); this is exactly how the login `t` attribute becomes server time (see §3.4).
- `GetAttributeJid<T>` / `GetAttributeDeviceJid` — build `Jid` objects via `JidFactory` (`:191-214`); note the guard that warns if you ask for `DeviceJid` through the generic method instead of `GetAttributeDeviceJid` (`:194-196`).

Child access: `GetChild(tag)` returns the **last** matching child (the loop keeps overwriting `result`, `:243-258`), `GetChild(int)` indexes, `GetAllChildren(tag)` filters via `TagEquals` (`:269-272`). `TagEquals` is a null-safe `node.tag.Equals(tag)` (`ProtocolNodeExtensions.cs:7-14`). `Require(node, tag)` throws `CorruptStreamException` on tag mismatch (`:274-281`).

`AddAttribute` is idempotent-on-key: it only appends if no attribute with that key exists, and silently ignores null key/value (`:55-68`).

`ToLogStanza()` returns empty string in this build (`:296-299`); the real XML-ish renderer (`LogStanza`) is `[Conditional("DEBUG")]` (`:301`), so stanza contents are not logged in release.

#### `ProtocolKeyValue` — attribute + JID typing

`ProtocolKeyValue` carries `key`, `value`, and a `KVType` flag (`ProtocolKeyValue.cs:39-43`). `KVType` is a **bit-flag** enum (`:9-33`): `Jid=2`, `NotAJid=1`, and composite values like `UserJidOrDeviceJid=38`, `GroupCallJidOrUserJidOrDeviceJid=166`, `StatusJidOrBroadcastlistJidOrGroupJidOrDeviceJidOrNewsletterJid=634`. `IsJidType` tests `(kvType & Jid) == Jid` (`:109-112`). The typed ctor validates the value against the flag via `IsValidForType` (a big `switch` over `JidChecker.IsValid*JidString`, `:119-143`) and constructs an `InvalidJidException` on mismatch (`:64-72`). Two interned constants are reused everywhere outbound: `ToServer = ("to","s.whatsapp.net",Jid)` and `ToGroup = ("to","g.us",Jid)` (`:35-37`). The `KVType` is what later drives compact JID encoding on the wire (JID_PAIR / JID_AD), but the reader reconstructs plain `ProtocolKeyValue(k,v)` with default `kvType=Unspecified` (`BinTreeNodeReader.cs:65`) — i.e. **inbound attributes lose JID typing**; typing only matters on the outbound path.

#### Builder & `Merge`

`ProtocolTreeNodeBuilder` accumulates `tag`, a `Dictionary<string,ProtocolKeyValue>` of attributes (last-write-wins per key, `:113`), a `List<ProtocolTreeNode>` of children, and optional `data`, asserting the children-XOR-data invariant on `AddChild`/`AddData` via `SmaxAssert.DebugFail` (`ProtocolTreeNodeBuilder.cs:71-83`, `:118-138`). `AddStringAttribute`/`AddIntAttribute` tag the value `NotAJid` (`:85-95`). `Build()` collapses empty attribute/children collections to null and chooses the data-ctor or children-ctor accordingly (`:157-174`). `Merge` (used heavily by SMAX response assembly) checks tag compatibility — treating `"smax:any"` as a wildcard (`:176-186`) — then merges attributes (conflicting values → `DebugFail`, `:188-207`), merges children by tag-grouping with count compatibility checks (`:218-268`), and merges data (`:270-286`).

### 3.2 The connection facade & IQ contract

The send/correlate surface is two interfaces:

```csharp
// IConnectionOutput.cs
void Write(ProtocolTreeNode node, bool compress = false);
void WriteTreeNodesEnd();
// IConnection.cs (extends IConnectionOutput)
void AddIqHandler(string id, IqResultHandler handler);
string MakeId(string prefix);
```

`Connection` (`Connection.cs`) is a thin facade: it holds an `IConnectionOutput _output` (the `StanzaWriter`) and an `IqRequestsTracker _iqRequestsTracker`, forwarding `Write`/`WriteTreeNodesEnd` to the writer and `AddIqHandler`/`MakeId` to the tracker (`Connection.cs:18-37`). This is the object the rest of the app (and, via the bridge, the JS layer's native-issued IQs) talks to.

> Note: `EncryptedBytesReceiver`/`SocketAdapter` construct a `WAProtocol` directly with the `StanzaWriter` as its `IConnectionOutput` and the shared `IqRequestsTracker` (see §3.6); `Connection` is the higher-level wrapper handed to callers that need both write + correlate in one object.

### 3.3 IQ id generation & the pending-request map (`IqRequestsTracker`)

This is the heart of request/response correlation. One `IqRequestsTracker` instance is created per `ConnectionManager` and **survives across reconnect attempts** — `ConnectionManager.cs:23` declares `private readonly IqRequestsTracker _requests = new IqRequestsTracker();` and `CreateSocket` passes that same `_requests` into every `SocketAdapter` (`ConnectionManager.cs:226`), which in turn hands it to each new `WAProtocol` (`SocketAdapter.cs:75`). So pending IQ handlers and the id counter are stable across socket churn (though a dropped socket means in-flight IQs will simply never get a result — handlers are one-shot and never time out at this layer; see Open Questions).

An exhaustive grep confirms the full set of consumers: the tracker is referenced **only** by `ConnectionManager` (owns the single instance), `SocketAdapter`/`WAProtocol` (call `PopIqHandler` on receive), and `Connection` (forwards `AddIqHandler`/`MakeId`). There is **no code path anywhere that clears `_pendingServerRequests` or arms a timer over it** — confirmed by the absence of any `.Clear()` / removal call on that map outside the one-shot `PopIqHandler` (`IqRequestsTracker.cs:45-55`); the only mutations of the map are `Add` (`:31`) and the one-shot `Remove` inside `PopIqHandler` (`:51`). The `ConnectionManager` disconnect handler does **not** touch the tracker either — on `SocketStates.Disconnected` it only calls `_clocksMonitor.SaveServerTime(null)` and schedules a reconnect via `DispatchConnect` (`ConnectionManager.cs:153-160`). Consequently, on a socket drop the orphaned handlers simply persist in the long-lived tracker until either a matching (possibly hex-colliding) id arrives on the new socket or the whole `ConnectionManager` is disposed. (This native non-cleanup is tolerable because the native shell tracks only the handful of IQs it itself originates; the bulk of IQ traffic lives in JS, where `WAComms` *does* clean up — on socket teardown it iterates pending handlers and calls `removeHandler(e, "disconnect")` for every `type==="iq"||type==="smax"` entry, backed by a `deadSocketTimer`/`ShiftTimer` health check — grep hits in `waweb-source-bundle/`.) `IsVerboseId` has no subclass override in this build (no `: IqRequestsTracker` derivation exists, and the property is the only reference besides its own use, `IqRequestsTracker.cs:25,38`), so it is always `false` → ids are always uppercase hex.

**Id generation** (`IqRequestsTracker.cs:35-43`):

```csharp
public string MakeId(string prefix) {
    int num = _counter.NextTicket();
    if (IsVerboseId) return prefix + num;
    return num.ToString("X");   // uppercase hex
}
```

`TicketCounter` starts at `-1` and uses `Interlocked.Increment` (`:9-17`), so the **first id is `0`** (hex `"0"`), then `"1"`, …, `"A"`, …. `MakeId` is thread-safe via the interlocked counter. `IsVerboseId` is a protected, default-false flag (`:25`); when true, ids are human-readable `prefix+decimal` (e.g. `removecompanion_5`), otherwise compact uppercase hex. The hex form means ids are **not** globally unique across sessions and collide trivially with server-initiated ids in other namespaces — uniqueness is only relied upon within the pending map.

**Pending map** (`:21-55`):

```csharp
private readonly object _iqHandlerLock = new object();
private readonly Dictionary<string, IqResultHandler> _pendingServerRequests = new();

public void AddIqHandler(string id, IqResultHandler handler) {
    lock (_iqHandlerLock) { _pendingServerRequests.Add(id, handler); }
}
public IqResultHandler? PopIqHandler(string id) {
    lock (_iqHandlerLock) {
        if (_pendingServerRequests.TryGetValue(id, out var value))
            _pendingServerRequests.Remove(id);
        return value;
    }
}
```

Key behaviors:
- `AddIqHandler` uses `Dictionary.Add`, which **throws** on a duplicate id (it does not overwrite). Since ids come from the monotonic counter, duplicates shouldn't normally occur, but a server-echoed/attacker-chosen id is irrelevant here because *we* generate the id before adding.
- `PopIqHandler` is **one-shot**: it removes on lookup, so a second `result` for the same id finds nothing and is silently ignored. Unmatched ids (server pushed an `iq result` we never tracked) → null → ignored.
- All access is mutex-guarded; correlation is safe across the socket read thread vs. the threads issuing sends.

### 3.4 `IqResultHandler` — the result/error callback pair

`IqResultHandler` (`IqResultHandler.cs`) is a sealed pair of optional delegates:
- `Parse : Action<ProtocolTreeNode, string>` — invoked on `type="result"`, receiving the full `iq` node and the `from` attribute (`:14-26`).
- `ErrorNode : Action<ProtocolTreeNode>` — invoked on `type="error"` (`:28-40`).

Both getters coalesce to a no-op delegate when unset (`:18-20`, `:32-34`), so it's always safe to invoke either. Three ctors:
1. `(Action<ProtocolTreeNode,string>? parse)` — result-only; error path is a no-op (`:42-45`). This is the pattern used for fire-and-forget IQs (e.g. `ClearDirtyStanzaBuilder` registers `new IqResultHandler(null)` — even the result is ignored, the handler exists only to satisfy the "must be tracked" contract, `ClearDirtyStanzaBuilder.cs:53`).
2. `(parse, Action<int>? onErrorCode)` — convenience: builds an `ErrorNode` that iterates every child `<error>` node, reads its `code` attribute and calls `onErrorCode(int.Parse(code))` (`:47-63`). This is the canonical "give me the error code" shape.
3. `(parse, Action<ProtocolTreeNode> parseError)` — full control over the raw error node (`:65-69`).

### 3.5 `ProcessStanza` — the FunXMPP state machine

Decrypted, inflated, parsed frames arrive at `WAProtocol.ProcessStanza(node, size)` (`WAProtocol.cs:34-51`). It is a **3-way router keyed on two booleans**:

```csharp
if (node != null) {
    if (_isCompanionRegistration)  ProcessMultiDeviceRegistrationNode(node); // throws NotImplementedException (:189-192)
    else if (_isLoggedIn)          ProcessLoginStateStanza(node, size);
    else                           ProcessAuthenticationNode(node);
}
```

A **null node is dropped silently here** (the `if (node != null)` guard, `:36`) — but note `ParseTreeNode` returns null only for an explicit stream-end token (`BinTreeNodeReader.cs:22-25`), and the *other* entry point `ProcessNode` (`:68-82`) throws `StreamEndException("Got stream end")` on null. `ProcessLoginStateStanza` also throws `StreamEndException` on null (`:144-147`). (`ProcessStanza` is the live path from `EncryptedBytesReceiver` — `EncryptedBytesReceiver.cs:47` is its only caller; `ProcessNode` is **confirmed dead code** in this build — a grep for `.ProcessNode(` invocations across the decompiled C# finds none, only its definition at `WAProtocol.cs:68`.)

#### Pre-login: `ProcessAuthenticationNode` (`:84-140`)

Handles exactly two tags:

**`success`** (`:86-92`):
```csharp
DateTime? t = node.GetAttributeDateTime("t");
_isLoggedIn = true;
ClocksMonitor.Instance.SaveServerTime(t);
this.LoggedIn?.Invoke(this, EventArgs.Empty);
```
So the login transition is: read server time from the `t` attribute, flip `_isLoggedIn`, persist server time (used for ban-window math and elsewhere), and fire `LoggedIn`. `SocketAdapter` subscribes to that event to transition the socket to `Connected` and arm the ping timeout (§3.6).

**`failure`** (`:95-138`): reads `expire`, `code`, `reason` attributes (`:100-102`). `reason` is parsed as an int and mapped to `LoginFailedReason` if defined; a `reason > 500` that isn't a defined enum value becomes `ServerBackoffRequest` (`:106-116`). The enum (`LoginFailedReason.cs`):

| value | reason |
|------|--------|
| 400 | GenericFailure |
| 401 | NotAuthorized |
| 402 | TempBanned |
| 403 | Locked |
| 405 | ClientTooOld |
| 406 | Banned |
| 409 | BadUserAgent |
| 500 | ServerError |
| 501 | Experimental |
| 503 | ServerBackoffRequest |

A `LoginFailureException` is built (`:117`). For `TempBanned` specifically, if `expire` parses to a positive long it fills the ban window: `BanReason=code`, `FailedLoginReason=reason`, `BanExpirationUtc = FunRunner.CurrentServerTimeUtc.AddSeconds(expire)`, `BanTotalSeconds=expire`, and an optional `retry` attribute → `RetryUtc` (`:118-132`). If the ban fields are missing/invalid, the type is downgraded to `GenericFailure` (`:133-136`). The exception is then **thrown** (`:138`), propagating up to `SocketAdapter.ProcessFrame`, which catches `LoginFailureException` and raises the `LoginFailed` event (`SocketAdapter.cs:65-69`) — that is the only place this layer reports auth failure. `LoginFailureException` carries `Type`, `BanTotalSeconds`, `BanExpirationUtc`, `RetryUtc`, `BanReason`, `FailedLoginReason` (`LoginFailureException.cs:5-22`).

`ConnectionManager.IsRejectedByServer()` later classifies `NotAuthorized/TempBanned/Locked/ClientTooOld/Banned/BadUserAgent` as hard rejections (`ConnectionManager.cs:201-215`); `ServerBackoffRequest` triggers `_backoff.HandleBackoffRequest()` instead of immediate retry (`:229-240`).

#### Post-login: `ProcessLoginStateStanza` → `ProcessIq` (`:142-187`)

After login, the router accepts **only `iq`**:
```csharp
if (treeNode.TagEquals("iq"))  ProcessIq(treeNode);
else  Log.Warn("Unrecognized top-level stanza [" + treeNode?.tag + "]", ...);  // :154
```
This is the load-bearing limitation: `message`, `receipt`, `notification`, `presence`, `chatstate`, `ib`, etc. all hit the `else` and are dropped at native level — they are handled in the JS bundle (which receives raw frames/stanzas through its own path). The native shell only natively round-trips `iq`.

`ProcessIq` (`:158-187`) is the correlation sink:
```csharp
string id   = node.GetAttributeValue("id");
string type = node.GetAttributeValue("type");
string from = node.GetAttributeValue("from");
if (type == null) throw new CorruptStreamException("missing 'type' attribute in iq stanza");
if (type.Equals("result")) {
    if ((h = _requestsTracker.PopIqHandler(id)) != null) h.Parse(node, from);
} else if (type.Equals("error")) {
    if ((h = _requestsTracker.PopIqHandler(id)) != null) h.ErrorNode(node);
} else {
    Log.Warn("unknown iq type attribute: " + type, ...);
}
```

Correlation semantics, precisely:
- Missing `type` → `CorruptStreamException` (`:163-166`) → propagates out of the read loop → stream treated as corrupt (reconnect).
- `result`/`error` → pop-by-id → invoke the matching half of the handler. No handler (unknown/duplicate/late id) → **silently dropped** (the `!= null` guard).
- Any other `type` (e.g. `get`/`set` — i.e. a **server-initiated IQ requiring a response**) → only `Log.Warn`, **no response is generated** (`:183-186`). The native layer does not answer server-initiated `iq get/set`; that is the JS layer's job, and the JS bundle does in fact implement it: the waweb bundle contains an explicit responder that, on an inbound `<iq>` whose child `xmlns==="urn:xmpp:ping"`, replies `WAWap.wap("iq",{type:"result",to:t.from})` (now read literally in the de-minified bundle: `/home/ark/Dev/projects/Webstorm/whatsapp/research/waweb-unmin/xTiXmyjNEd_.js:11622-11625`). The same handler has an `xmlns==="md"` branch that `switch`es on the first child tag and dispatches multi-device pushes — `case "pair-device": return WAWebHandlePairDevice(e)` and `case "pair-success": return WAWebHandlePairSuccess(e)` (de-minified bundle `xTiXmyjNEd_.js:11626-11634`) — confirming that companion/pairing stanzas (which the native `ProcessMultiDeviceRegistrationNode` leaves as `NotImplementedException`, see §6) are also handled entirely in JS. So server-initiated IQs (server pings, `md` pushes) are answered — just in JS over the JS bundle's own wire stack, never by this native C# router. This is consistent with native owning only the IQs it itself originates.

#### The `md`/companion-registration (pairing) stanza shapes

Although the native `ProcessMultiDeviceRegistrationNode` is compiled out (see §6), the exact wire shapes of the `xmlns="md"` pairing exchange are **fully recovered from the open WA-Web protocol implementations** that interoperate with the same servers, and **corroborated by literal strings in the de-minified bundle** (`research/waweb-unmin/xTiXmyjNEd_.js` — `pair-device` @11630, `pair-success` @11632, `device-identity` @29408+, `pair-device-sign`, plus the `WAWebCompanionReg`/`companion_reg` registration module @10447,10937,11481+). The companion-registration QR-pairing flow is a 3-stanza server-initiated `md` exchange:

1. **Server → client `<iq type="get" xmlns="md">` with a `<pair-device>` child** carrying one or more `<ref>` children (each `<ref>`'s text is a QR-rotation reference token). Client immediately ACKs with an empty `<iq type="result" to=<from> id=<id>>` and then renders each ref as a QR payload `ref,base64(noiseKeyPub),base64(identityKeyPub),base64(advSecretKey),clientType` (cross-reference: `whatsmeow/pair.go:51-80` `handlePairDevice` + `:114-118` `makeQRData`).
2. **Server → client `<iq type="set" xmlns="md">` with a `<pair-success>` child** after the phone scans, containing `<device-identity>` (a protobuf `ADVSignedDeviceIdentityHMAC`), `<device jid=.. lid=..>`, optional `<biz name=..>`, and `<platform name=..>` children (cross-reference: `whatsmeow/pair.go:121-144` `handlePairSuccess`; Baileys `src/Utils/validate-connection.ts:169-184`).
3. **Client → server confirmation `<iq type="result" to="s.whatsapp.net" id=<reqId>>` with a `<pair-device-sign>` child wrapping `<device-identity key-index=.. >` whose body is the re-signed `ADVSignedDeviceIdentity` protobuf** (cross-reference: `whatsmeow/pair.go:226-243`; Baileys `validate-connection.ts:221-241`). On signature/identity failure the client instead sends `<iq type="error" ...>` with an `<error code=.. text=..>` child (`whatsmeow/pair.go:288-303`).

The ADV crypto bound into stanza (2)/(3): the account signature is verified over `AdvAccountSignaturePrefix(={6,0}) ‖ deviceDetails ‖ identityKeyPub`, the device signature the client adds is over `AdvDeviceSignaturePrefix(={6,1}) ‖ deviceDetails ‖ identityKeyPub ‖ accountSignatureKey`, and hosted-account variants swap in `AdvHostedAccountSignaturePrefix(={6,5})`; signatures are **Curve25519 XEdDSA, 64-byte** (cross-reference: `whatsmeow/pair.go:31-34,264-286`; Baileys `validate-connection.ts:201-216` via `Curve.sign`/`Curve.verify`). The Curve25519 scheme here is not merely interop-inferred: the native binary statically exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}` with the X25519 ladder constant `a24=121665` and SHA-512 constants present (radare2, doc 96), so a port can use `@signalapp/libsignal-client` bit-compatibly. The outbound registration **request** node (`companion_reg`/`WAWebCompanionReg`) carries a `DeviceProps` protobuf and `eRegid = encodeBigEndian(registrationId)` (Baileys `validate-connection.ts:110-147`). These shapes are protocol-level facts the native client MUST share to interoperate; the only thing absent from *this* DLL set is the native C# byte-builder for them. **Where the working builder actually lives (confirmed this pass):** the de-minified WA-Web bundle carries it — `pair-device-sign` plus the `ADVSignedDeviceIdentity`/`key-index`/`eRegid`/`DeviceProps` constructors co-locate in `research/waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js` and `research/waweb-unmin/n6o0-NaJTww.js` [bundle]; `companion_reg`@10937, `pair-device`@11630, `pair-success`@11632, `device-identity`@29408+ in `xTiXmyjNEd_.js`. The pairing **output** then persists into the live WebView IndexedDB — `signal-storage.identity-store` (device identity keypair), `model-storage.device-list`, `account-linking`, `direct-connection-keys` — so a renderer-hosted port inherits both the builder and the persisted pairing state for free ([live-appdata]; docs 94/95). Conversely, `strings WhatsAppNative.dll` surfaces **none** of these pairing literals [native-binary, this pass], so the builder is not recoverable from the native binary either; it is purely a JS-layer artifact in this hybrid client. **The managed build does ship the pairing *payload* DTOs, just not the stanza builder** [decompiled-C#, this pass]: the protobuf message classes `ADVSignedDeviceIdentity`, `ADVSignedDeviceIdentityHMAC` (`WhatsApp.Protobuf/Whatsapp/`), and the encrypted-pairing wrapper `EncryptedPairingRequest` (`WhatsApp.Protobuf/WhatsApp.ProtoBuf/EncryptedPairingRequest.cs` — two fields only: `EncryptedPayload` @tag 10, `Iv` @tag 18, `:8,10,55-59,139-148`) are present as serialize/deserialize-only codecs. They carry no `ProtocolTreeNode` construction — so the build retains the *data shapes* for the ADV/pairing protobufs while the `md` *stanza* builder that would wrap them onto the wire is the part compiled out of this managed build (see §6). A second confirmation that companion registration is fully disabled in native: `HandshakeHandler.cs:27,52` carries its own `_isCompanionRegistration` field, also hard-set to `false`, so even the Noise-handshake-for-pairing variant is dead.
- `from` is passed to `Parse` but never used for correlation — correlation is purely id-based. There is no check that the `from` of the response matches the `to` of the request at this layer (the SMAX `*.Incoming` parsers do their own stronger checks; see §3.7).

### 3.6 Wiring: handshake → encrypted stanza path (`SocketAdapter`)

`SocketAdapter` is the `FramesReader.ITarget`; every complete frame lands in `ProcessFrame(input, offset, length)` (`SocketAdapter.cs:51-90`):
- If `_reader` (an `EncryptedBytesReceiver`) exists, the frame is encrypted post-login: `_reader.ReceiveFrame(...)`; `LoginFailureException` thrown inside is caught and surfaced as the `LoginFailed` event (`:58-70`).
- Otherwise we're still in Noise handshake: feed the frame to `_handshake.TryHandshake(...)`. On success, derive the transport key pair, build the `StanzaWriter` (write key = `pair.First`), construct the `WAProtocol` with the **shared** `_requestsTracker`, subscribe its `LoggedIn` to: set state `Connected`, set the socket timeout to `Constants.ForegroundPingTimeout`, raise `LoggedIn(writer)`; then install the `EncryptedBytesReceiver` (read key = `pair.Second`) as `_reader` (`:71-83`).

The two timeouts are **socket-read** timeouts, not IQ-level timeouts, and their values are concrete: `Constants.LoginTimeout = 30s` (cumulative, armed during handshake in `ConnectionManager.cs:224`) and `Constants.ForegroundPingTimeout = 100s` (non-cumulative, armed on login in `SocketAdapter.cs:79`) — both in `Constants.cs:198,200`. When the socket idles past that window it transitions to `Disconnected`; `ConnectionManager` observes that (`ConnectionManager.cs:153-160`) and schedules a reconnect. Crucially, that disconnect→reconnect path **does not** clear the IQ pending map (see §3.3 and Open Questions): the same `IqRequestsTracker` is reused across every reconnect within one `ConnectionManager` lifetime.

So the post-login receive pipeline is exactly:
`socket bytes → FramesReader (3-byte length reassembly) → SocketAdapter.ProcessFrame → EncryptedBytesReceiver.ReceiveFrame → AES-GCM decrypt (read key, incrementing 12-byte nonce) → optional zlib inflate (flag bit 0x2) → BinTreeNodeReader.ParseTreeNode → WAProtocol.ProcessStanza → ProcessIq → IqResultHandler` (`EncryptedBytesReceiver.cs:24-48`).

`EncryptedBytesReceiver.ReceiveFrame` detail (`:24-48`): decrypts with `AesGcmProvider.AesGcmDecrypt(_readKey, LongToByteArray(_readNonce++,12), null, ...)` — **no AAD**, nonce is a 12-byte big-endian counter (`WAProtocol.LongToByteArray`, `WAProtocol.cs:53-66`). Decrypt failure → `FailuresService.Investigate("Failed to decrypt AES GCM frame")` and the frame is dropped (`:27-31`) — note this does **not** advance/rewind anything but the nonce already incremented, so a single GCM failure desyncs the nonce stream (in practice a GCM failure means the stream is unusable anyway). Compression bit: `(array[0] & 2) != 0` → inflate the body after the 1-byte flag (`:33-41`); else the body is `array[1..]` (`:44`).

The outbound mirror, `StanzaWriter` (`StanzaWriter.cs`): `Write(node, compress)` → `BinTreeNodeWriter.Write` → `WriteStanza(stanzaStream, useCompression)` (`:35-72`). If compression is requested and helps (deflated length < raw length) it prepends flag byte `2` and uses the deflated bytes; otherwise prepends flag byte `0` and uses raw (`:44-66`). Frames ≥ `33554432` (32 MiB) throw `IOException` (`:67-70`). Then `WriteEncrypted` AES-GCM-encrypts with the **write** key, nonce `LongToByteArray(_writeNonce++,12)`, no AAD, and hands the result to `FramesWriter` (`:74-78`). Read and write nonces are independent counters starting at 0.

**Compression on send is effectively never used by the native layer.** `compress` defaults to `false` (`Write(node, bool compress = false)`, `StanzaWriter.cs:25`, `Connection.cs:18`, `IConnectionOutput.cs:7`), and an exhaustive grep of the decompiled C# finds **no caller that passes `compress: true`** — every native `connection.Write(node)` / `output.Write(node)` call site relies on the default. The deflate branch in `WriteStanza` is dead code from this assembly's perspective; the flag byte emitted by native is always `0`. (Inbound *decompression* is still live — the server may set bit `0x2` on frames it sends; see `EncryptedBytesReceiver` below.)

`WriteTreeNodesEnd` emits the FunXMPP **end-of-stream marker**: `BinTreeNodeWriter.WriteTreeNodesEnd` writes `WriteListStart(1)` (list-of-1 prefix) followed by the literal byte `2`, then flushes under the writer lock (`BinTreeNodeWriter.cs:34-42`). Byte-exact, this is the three bytes **`F8 01 02`**: `WriteListStart(1)` emits the short-list opcode `248` (`0xF8`) then the 1-byte count `1` (`BinTreeNodeWriter.cs:420-435`), then the literal stream-end token `2`. The wrapper chain `Connection.WriteTreeNodesEnd → StanzaWriter.WriteTreeNodesEnd → BinTreeNodeWriter.WriteTreeNodesEnd` exists (`Connection.cs:23-26`, `StanzaWriter.cs:30-33`), but **no application caller in the decompiled C# invokes it** — only those forwarding wrappers reference it — so it is an unused part of the `IConnectionOutput` contract in this build (the native shell never deliberately closes the stream cleanly; it relies on socket teardown + reconnect).

### 3.7 Building & parsing IQs (helpers, SMAX, builders)

**Hand-written native IQ — `removecompanion`** (`ConnectionExtensions.cs`): `SendCompanionIq` shows the canonical send+correlate sequence (`:10-22`):
```csharp
string id = connection.MakeId(prefix);
var node = new ProtocolTreeNode("iq", new[]{ to, ("type","set"), ("id",id), ("xmlns","md") }, innerNodes);
connection.AddIqHandler(id, handler);   // register BEFORE write — avoids race with fast reply
connection.Write(node);
```
The id is minted, the handler registered **before** the node is written (so a fast server reply can't arrive before the handler exists), then the node is sent. `SendRemoveCompanion` (`:24-56`) builds a result handler that inspects the response for a child `<error>` (→ `onError(code)`) else `onComplete()`, plus an `onErrorCode` for the `type="error"` path, and wraps a `<remove-companion-device jid=.. [reason=..]>` child.

**Fire-and-forget IQ — `clean`/dirty-bits** (`ClearDirtyStanzaBuilder.cs`): `MakeIdAndAddHandler` mints an id, registers `new IqResultHandler(null)` (a pure no-op result handler — the response is acknowledged-as-consumed but discarded) and returns the id (`:50-55`). Then it writes an `<iq id type=set to=s.whatsapp.net xmlns=urn:xmpp:whatsapp:dirty>` with `<clean type=.. [timestamp=..]>` children (`:30-48`). This is the pattern for "must send and the server will reply, but we don't care about the body."

**SMAX outgoing — `Pings.Outgoing.ClientRequest`** (`ClientRequest.cs`): a generated factory that hard-codes the spec attributes and takes only the id from the caller (`:10-24`):
```csharp
var b = new ProtocolTreeNodeBuilder("iq");
b.AddStringAttribute("id", idAttr);
b.AddAttribute(("type","get"));
b.AddAttribute(("xmlns","w:p"));
b.AddAttribute(("to", (DomainJid)JidFactory.CreateNewJid("s.whatsapp.net"), KVType.Jid));
Node = b.Build();
```
The caller is responsible for `MakeId`/`AddIqHandler`; the generated class only produces `.Node`.

**SMAX incoming — `Pings.Incoming.ClientResponseServerResponse`** (`ClientResponseServerResponse.cs:30-67`) shows the strongly-typed validation+correlation pattern that returns `Either<T, SmaxError>`:
1. `TryCheckNodeTag(node, "iq")` (`:36`).
2. `TryGetRequiredJidEnum(node, [CastJid<DomainJid>, CastJid<UserJid>], ["from"], out from)` (`:40`) — `from` must be a domain or user JID.
3. `TryGetRequiredStringAttributeValue(node, ["type"], isReference:false, "result", ...)` (`:44`) — `type` must literally equal `"result"`.
4. **Reference correlation against the originating request** (`:48-52`): read the request's `id` (`smaxStandardLibrary.TryGetRequiredStringAttributeValue(node2=request.Node, ["id"], ..., out result3)`), then read the response's `id` with **`isReference:true`** and `expectedValue=result3` — i.e. SMAX asserts `response.id == request.id` at the schema level, in addition to the dictionary pop in `ProcessIq`.
5. `TryGetRequiredLongAttributeValue(node, ["t"], range −9007199254740991..9007199254740991, out t)` (`:53`).
On any failure it returns `new SmaxError(smaxStandardLibrary.ParseError)`; `CorruptStreamException` is caught and (optionally) logged (`:59-66`). The `isReference` mechanism is general (`SmaxStandardLibrary.cs:143-345` for string/byte/long variants) — it is how generated parsers verify "this attribute must match a value pulled from elsewhere (usually the request)."

> Important distinction: the SMAX `*.Incoming` parsers are **invoked from the handler's `Parse` callback** (the caller passes `request` and the received `node`), not by `ProcessIq` itself. `ProcessIq` does the id→handler dispatch; the handler then optionally runs the SMAX parser for typed validation. The two correlation checks are layered: (a) dictionary id-pop in `ProcessIq`, (b) reference-equality `response.id == request.id` inside the SMAX parser.

**Acks** (`AckStanzaBuilder.cs`): native builds **notification** acks only. `CreateNotificationOkAckFromNotificationNode` copies `type/from/to/participant/id` from an inbound `<notification>` and emits `<ack to=from class="notification" id=.. type=..>` with optional `<sync contacts="in|out">` child for contact-sync acks (`:16-56`). The `class="notification"` is fixed (`:52`). Per the inventory and the `ProcessStanza` limitation, **per-message delivery receipts (`class="message"`) are produced in JS**, not here — native only acks notifications/IQs it processes.

### 3.8 Endpoint resolution (`WhatsApp.Resolvers`)

Before any stanza flows, the chat host `s.whatsapp.net` must resolve to an IP for `SocketAdapter.Start(IPAddress)`. `IResolver.Resolve(host, hostType)` returns `Task<IEnumerable<ResolveResult?>?>` (`IResolver.cs:6-9`). `ResolveResult` carries `IPAddress`, `LoginDnsResolverType`, `LoginHostType`, `Ttl` (`ResolveResult.cs:5-22`).

`ChainResolver` (`ChainResolver.cs:17-42`):
1. **Literal-IP short circuit:** if `IPAddress.TryParse(host)` succeeds, return a single `ResolveResult(addr, Hardcoded, hostType, ttl:0)` — no DNS (`:19-25`).
2. Otherwise iterate `_sources` in order, returning the **first non-null** result; per-source exceptions are swallowed so a failing resolver falls through to the next (`:26-41`).
3. All sources exhausted → return `null` (`:41`).

`ResolverExtensions`:
- `TryResolve` wraps `Resolve` and returns `Array.Empty<ResolveResult>()` on exception (`ResolverExtensions.cs:11-21`) — never throws.
- `SelectIp(results)` implements happy-eyeballs-style dialing: shuffle the candidate array, then pick the **first IPv4** (`AddressFamily.InterNetwork`) and **first IPv6** (`InterNetworkV6`) and return the pair (`:23-41`). Returns `(null,null)` on empty/exception. The caller can then race the v4/v6 candidates.

These feed the IP into `SocketAdapter.Start(ipAddress)` (`SocketAdapter.cs:92-100`), which writes the initial Noise stanza and connects.

**The concrete production resolver chain** is wired in `IpProvider` (the `IIpProvider` actually used by `ConnectionManager.cs:25`, not the alternate `HostSelection`). `IpProvider`'s ctor builds an ordered list of `(resolver, hostType)` adapters, each duplicated for IPv6 and IPv4 (`IpProvider.cs:82-95`):
1. `SystemResolver` → `g.whatsapp.net` (`GWhatsappNet`)
2. `SystemResolver` → `g-fallback.whatsapp.net` (`GFallbackWhatsappNet`)
3. `HardcodedResolver` → `g.whatsapp.net` (`HardcodedList`)
4. `HardcodedResolver` → `e{1..16}.whatsapp.net` (`ExWhatsappNet`; the `e{n}` host is chosen at random, `IpProvider.cs:65-69`)
5. `SystemResolver` → `e{1..16}.whatsapp.net` (`ExWhatsappNet`)

`SystemResolver` is a thin wrapper over `Dns.GetHostAddressesAsync` tagging each result `LoginDnsResolverType.System` (`SystemResolver.cs:9-24`). `HardcodedResolver` returns literal fallback IPs from the embedded `IpList` table (`HardcodedResolver.cs:10-15`), tagged `Hardcoded` with `Ttl=0`. The `IpList` constants are checked into the binary (`IpList.cs:7-91`): the `g.whatsapp.net`/`v.whatsapp.net` rows carry 28 Meta IPs each (14 IPv4 + 14 IPv6 in `2a03:2880:…face:b00c` ranges), and every `e1..e16.whatsapp.net` row shares the same four edge IPs (`15.197.206.217`, `3.33.252.61`, `15.197.210.208`, `3.33.221.48` — AWS Global Accelerator addresses). `IpProvider.GetNext()` round-robins these adapters until one yields a non-null IP, sticking to the last-connected adapter via `MarkIPAddressAsConnected` (`IpProvider.cs:97-121`). Note the custom UDP `DnsResolver` (a full hand-rolled DNS-over-UDP client with A/AAAA/CNAME parsing, `DnsResolver.cs`) is marked `[Obsolete("please note that this type seems to be broken and not in use")]` (`DnsResolver.cs:143`) and is **not** in this chain; `CacheResolver` (TTL-bounded, network-change-flushed, `CacheResolver.cs`) is also not wired into `IpProvider`. So the live resolution is just **system DNS + a hardcoded IP fallback**, no DoH.

## 4. Native Dependencies

This layer is **almost entirely managed C#**. The native (`WhatsAppNative.dll` C++/Rust) dependencies it transitively relies on are inferred from managed callers (the legacy Ghidra dump being 0 bytes is a tooling artifact; the native binary was since read with radare2 — doc 96 — confirming the crypto primitives are statically linked, see line 330):

- **AES-GCM frame crypto** — `AesGcmProvider.AesGcmEncrypt/Decrypt` (called at `StanzaWriter.cs:76`, `EncryptedBytesReceiver.cs:26`). Per the crypto inventory this wraps the WinRT `SymmetricKeyAlgorithmProvider` (AesGcm), not custom native code. *Confirmed managed caller; primitive is WinRT, not WhatsAppNative.*
- **zlib inflate/deflate** — `ICSharpCode.SharpZipLib` (`InflaterInputStream`/`DeflaterOutputStream`, `EncryptedBytesReceiver.cs:2,37`, `StanzaWriter.cs:2,46`). *Confirmed: managed library, not native.*
- **JID parsing/validation** — `JidFactory.CreateNewJid/CreateNewDeviceJid`, `JidChecker.IsValid*JidString` (`ProtocolTreeNode.cs:201,211`; `ProtocolKeyValue.cs:123-140`). Managed; no native dependency observed in these files.
- **Server time / ban math** — `ClocksMonitor.Instance.SaveServerTime` and `FunRunner.CurrentServerTimeUtc` (`WAProtocol.cs:90,124,130`). Managed.
- **The FunXMPP binary codec** — `BinTreeNodeReader`/`BinTreeNodeWriter` + token dictionary. Fully managed (`BinTreeNodeReader.cs`).

**Net:** the stanza/IQ layer has **no direct WhatsAppNative (C++/Rust) call**. Its only cross-boundary coupling is *upward* to the WebView2 JS bundle: the JS Signal/UI layer issues most `iq` traffic and consumes inbound stanzas. The native shell exposes the `Connection`/bridge so JS can send stanzas and register correlation, but the stanza model, IQ tracker, and SMAX parsers are pure managed code. *(Inference, from absence of any `WhatsAppNative.*` reference in the files read; the WinRT bridge classes that vend these to JS are in `WinRTAdapter/`, out of scope here.)*

**Native-binary cross-check (this pass).** A direct `strings WhatsAppNative.dll` confirms the layer's protocol surface is *not* hidden inside the native binary: there are **zero** stanza/pairing literals (`pair-device`, `pair-success`, `pair-device-sign`, `companion_reg`, `device-identity`, `xmlns`, `ADVSigned`) [native-binary]. This is consistent with doc 92/94 — `WhatsAppNative.dll`'s only `bcrypt.dll` imports are `BCryptGenRandom`/`BCryptOpen`/`CloseAlgorithmProvider` (RNG only; no `BCryptEncrypt`/PBKDF2/HashData), so AES/HMAC/SHA/KDF for the SQLite codec and Signal/Noise are **statically linked** (BoringSSL-from-WebRTC likely) with no exported symbols, and `whatsapprust.dll` (Meta "wamedia" media libraries — binrw/hashbrown/memchr/spin, zero crypto) + Media Foundation + `ws2_32` are the dynamic deps. (radare2 nonetheless recovers those statically-linked primitives — the X25519 constant `a24=121665`, SHA-512 constants, and the `Curve25519::{Derive,Sign,Verify,GenKeyPair}` class — see doc 96; the SQLite at-rest codec is a **custom AES+HMAC page codec, not stock SQLCipher**, doc 94/96.) Net for this doc: the FunXMPP codec, IQ correlation, and SMAX parsing are all managed C#, and the one stanza family the managed build *doesn't* implement (the `md` pairing builder, §3.5/§6) is **absent from the native binary too** — it lives only in the JS bundle. Note the asymmetry the cross-check makes explicit [decompiled-C#, this pass]: the managed assemblies *do* ship the pairing **payload protobuf DTOs** (`ADVSignedDeviceIdentity`/`ADVSignedDeviceIdentityHMAC` in `WhatsApp.Protobuf/Whatsapp/`, `EncryptedPairingRequest` in `WhatsApp.Protobuf/WhatsApp.ProtoBuf/`) — serialize-only codecs with no stanza construction — so it is specifically the `md` *stanza builder*, not the ADV data model, that is compiled out; and the FunXMPP token dictionary even reserves the relevant tags (`device-identity`, `key-index`, `pair-device` in `WAPDefaultTokenDictionary.cs`) so the codec could encode such a stanza if a builder existed.

## 5. Linux/Electron Port Mapping

The whole layer is straightforwardly portable to Node/TypeScript — it's data-structure + state-machine code with no OS coupling. Recommended mapping:

| Windows piece | Port target |
|---|---|
| `ProtocolTreeNode` / `ProtocolKeyValue` / builder | Plain TS classes/interfaces. Keep the children-XOR-data invariant. `attributes` as `Array<{key,value,kvType}>` (or `Map`) — a `Map<string,string>` is enough for parsing; keep the ordered array + `kvType` for **outbound** JID encoding. |
| `KVType` flag enum + `JidChecker` validation | TS const enum + regex/validators per JID class. The flag-bit composites (38, 166, 634…) map to bitwise checks identically. |
| `BinTreeNodeReader`/`Writer` (FunXMPP) | Port directly (covered in the binary-node doc). The IQ layer just consumes the parsed tree. |
| `IqRequestsTracker` (id counter + `Map<string,handler>` + mutex) | `class IqRequestsTracker { #next=-1; #pending=new Map<string,{resolve,reject}>(); }`. Node is single-threaded so the C# `lock`/`Interlocked` are unnecessary — a plain counter and `Map` suffice. **Replace the one-shot fire-and-forget callback model with `Promise`s**: `sendIq(node)` returns a `Promise` resolved by `result` / rejected by `error`. |
| `IqResultHandler` (Parse/ErrorNode pair) | `{ resolve(node), reject(errorNode) }` stored in the pending map; or expose `(node)=>void` callbacks for the rare streaming cases. |
| `MakeId` → `num.ToString("X")` | `(this.#next++).toString(16).toUpperCase()` to stay wire-compatible with the server's expectations (any unique string works; match the hex convention to be safe). **Add a timeout** the original lacks (see below). |
| `WAProtocol.ProcessStanza` 3-state router | A small switch on `loggedIn`/`companionRegistration`, dispatching `success`/`failure`/`iq`. **Decide deliberately** whether the Node port also drops non-`iq` post-login stanzas (the Windows app does, because JS handles them) or whether your port handles `message`/`receipt`/`notification` natively. If you reuse the waweb JS bundle, mirror the drop; if you reimplement the client, you must add those families. |
| `ProcessIq` correlation | Same id-pop-and-dispatch. In TS: `const p = pending.get(id); if (p) { pending.delete(id); type==='result'? p.resolve(node): p.reject(node); }`. |
| Login `failure` parsing + `LoginFailureException` | TS error class carrying `type`, `banExpiration`, `retry`. Port the `LoginFailedReason` numeric map verbatim. |
| `AckStanzaBuilder` / `ClearDirtyStanzaBuilder` / SMAX `*.Outgoing` | Plain builder functions returning a node. SMAX `*.Incoming` validators → small parse functions returning a discriminated union `{ok:true,value} | {ok:false,error}` (the `Either<T,SmaxError>` shape). |
| SMAX `isReference` request↔response id check | Optional but cheap to keep: assert `response.id === request.id` in the typed parser, layered on top of the Map pop. |
| `WhatsApp.Resolvers` (`ChainResolver`, `SelectIp` happy-eyeballs) | Node `dns.promises.resolve4/resolve6` behind a chain; `SelectIp` = shuffle + first v4 + first v6, then race two `net.Socket`/TLS dials (Node 20+ `net.connect` supports `autoSelectFamily` which already does happy-eyeballs — you can lean on it). Keep the literal-IP short-circuit. |
| `StanzaWriter`/`EncryptedBytesReceiver` framing+nonce | Independent `writeNonce`/`readNonce` 12-byte BE counters; AES-GCM via Node `crypto.createCipheriv('aes-256-gcm', ...)` (tag appended, no AAD). zlib via Node `zlib.inflateSync`/`deflateSync` with the 1-byte flag prefix (`bit 0x2`). 3-byte BE length framing in a small reassembly buffer. |

**Reuse from the waweb JS bundle:** if the Electron port loads the same WhatsApp Web bundle in a `BrowserWindow`/`webview` (mirroring the Windows hybrid design), then *most* of the IQ traffic (chat/query/key IQs, `message`/`receipt`/`notification` handling) is already implemented in that bundle — you only need to port this thin native transport+correlation shim and expose a `Connection`-equivalent to JS via Electron `contextBridge`/IPC, exactly as the Windows app does via the WinRT bridge. The `IqRequestsTracker`/`ProcessIq` logic is small enough (~100 lines) to reimplement faithfully.

**Gaps / risks:**
- **No request timeout** at this layer (see Open Questions). A Promise-based port should add per-IQ timeouts and reject pending IQs on socket close — otherwise IQ promises leak across reconnects (the Windows tracker survives reconnect but in-flight handlers are simply orphaned).
- **Nonce desync on a single GCM failure** (`EncryptedBytesReceiver` increments before checking) — in a port, treat any GCM auth failure as fatal-to-the-stream and reconnect, rather than continuing.
- **Inbound attributes lose JID typing** — fine for parsing, but if your port round-trips inbound nodes back out, re-derive `kvType` before re-encoding.
- The `AddIqHandler` uses `Dictionary.Add` (throws on dup); a Node `Map.set` overwrites. If you ever reuse ids you'll silently clobber instead of throwing — keep ids monotonic.

## 6. Open Questions / Unverified

> Every item below was **re-investigated this pass** against the decompiled C# (`decompiled/`), the WhatsApp Web JS bundle (`waweb-source-bundle/`), and the shipped native DLLs (`x64/`). Each is now prefixed with a verdict tag and concrete, cited evidence; genuinely-open items are classified honestly with the artifact that would close them.

- **No IQ timeout at this layer.** *Question: `IqRequestsTracker` has no timer; if the server never replies the handler lingers in `_pendingServerRequests` indefinitely — does a higher layer (`ConnectionManager`/the JS client) impose IQ timeouts?* **[RESOLVED]** At the native C# layer there is genuinely no timer: `IqRequestsTracker.cs` contains only the counter, the lock, the `Dictionary`, `AddIqHandler`, `MakeId`, `PopIqHandler` — no `Timer`/`Stopwatch`/expiry (`IqRequestsTracker.cs:7-56`), and `ConnectionManager` adds no IQ-level timeout (its only timers are the socket-read `LoginTimeout`/`ForegroundPingTimeout`, `ConnectionManager.cs:224`, `SocketAdapter.cs:79`). The higher layer that *does* impose IQ timeouts is the **JS comms layer**: `WAComms._sendIq` wraps each IQ in a `Promise` and arms `var _=setTimeout(m,a*1e3)` when the caller passes a positive timeout `a` (seconds), where the timeout callback `m` rejects and calls `removeHandler` (`_sendIq unexisting stanza to be cancelled` path) — grep hits in `waweb-source-bundle/` (`_sendIq`, `setTimeout(m,a*1e3)`, `removeHandler`). So IQ timeouts live in JS, per-call, not in this native tracker — which is exactly why the §5 port note recommends adding them.
- **Pending-map lifecycle across reconnect.** *Question: the single `IqRequestsTracker` survives reconnects (`ConnectionManager.cs:23,226`); is there any code that clears `_pendingServerRequests` on disconnect, or are stale handlers left to be matched by a colliding hex id on the new socket?* **[RESOLVED]** Confirmed by exhaustive grep: the **only** mutations of `_pendingServerRequests` are `Add` (`IqRequestsTracker.cs:31`) and the one-shot `Remove` inside `PopIqHandler` (`:51`) — there is no `.Clear()`, no enumeration, no timer touching it anywhere in the decompiled C#. The `ConnectionManager` disconnect handler only calls `_clocksMonitor.SaveServerTime(null)` and `DispatchConnect(...)` to reconnect; it does **not** touch `_requests` (`ConnectionManager.cs:153-160`). So at the native layer stale handlers genuinely persist across reconnect and *could* be matched by a colliding uppercase-hex id on the new socket — it is **not** mitigated natively. It is mitigated in the **JS layer**, which on socket teardown iterates its pending handlers and calls `removeHandler(e)` with reason `"disconnect"` for every `type==="iq"||type==="smax"` entry (`waweb-source-bundle/`: `removeHandler=function(t,r){if(r===void 0&&(r="disconnect"))...`, plus `forEach(...removeHandler(e))` and a `deadSocketTimer`/`ShiftTimer` health-check). The native tracker simply doesn't carry enough in-flight native IQs for this to matter (it only tracks the handful of IQs the native shell itself originates).
- **Server-initiated `iq get/set`.** *Question: `ProcessIq` only logs unknown `type`s and never responds (`WAProtocol.cs:183-186`) — does the JS bundle receive and answer server-initiated IQs through a separate path, or do such IQs simply not occur?* **[RESOLVED]** The JS bundle **does** answer them. The inbound-`<iq>` handler in `waweb-source-bundle/` branches on the child `xmlns`: `if(t.xmlns==="urn:xmpp:ping")return o("WAWap").wap("iq",{type:"result",to:t.from});` (server XMPP ping → `result`), and `if(t.xmlns==="md"){...switch(a){case"pair-device":return r("WAWebHandlePairDevice")(e)...}` (server multi-device pushes). So server-initiated IQs do occur and are answered — in JS, over the JS bundle's own wire stack — never by this native C# router, consistent with native owning only the IQs it itself originates. (Already folded into §3.5.)
- **`ProcessNode` vs `ProcessStanza`.** *Question: `ProcessNode` (`:68-82`) throws `StreamEndException` on null and only handles `iq`, but the live path uses `ProcessStanza`; who calls `ProcessNode`?* **[RESOLVED]** `ProcessNode` is **dead code in this assembly**. An exhaustive grep for invocations finds exactly one caller of the receive entry point and it is `ProcessStanza`: `EncryptedBytesReceiver.cs:47` (`_protocol.ProcessStanza(node, memoryStream.Length)`). There is **no** `.ProcessNode(` call site anywhere in the decompiled C# (only its definition at `WAProtocol.cs:68`). It is leftover/legacy — the live receive path is exclusively `EncryptedBytesReceiver.ReceiveFrame → ProcessStanza → (ProcessLoginStateStanza|ProcessAuthenticationNode) → ProcessIq`.
- **`WriteTreeNodesEnd` / stream-close semantics.** *Question: what end-of-stream marker do `IConnectionOutput.WriteTreeNodesEnd()` / `BinTreeNodeWriter.WriteTreeNodesEnd` emit, and when do callers invoke them?* **[RESOLVED]** The marker is byte-exact: `BinTreeNodeWriter.WriteTreeNodesEnd` does `WriteListStart(1)` then `_out.WriteByte(2)` then flush, under the writer lock (`BinTreeNodeWriter.cs:34-42`). `WriteListStart(1)` emits the short-list opcode `248` (`0xF8`) followed by the 1-byte count `1` (`:420-435`), so the on-wire end-of-stream marker is the three bytes **`F8 01 02`** (list-of-1 prefix + the FunXMPP stream-end token `2`). As for callers: the wrapper chain `Connection.WriteTreeNodesEnd → StanzaWriter.WriteTreeNodesEnd → BinTreeNodeWriter.WriteTreeNodesEnd` exists (`Connection.cs:23-26`, `StanzaWriter.cs:30-33`) but grep for invocations finds **only** those forwarding wrappers — **no application caller** invokes `WriteTreeNodesEnd()` in the decompiled C#. So the native shell never deliberately emits a clean stream-close; it relies on socket teardown + reconnect. (Marker now folded into §3.6.)
- **Compression policy on send.** *Question: which callers pass `compress:true`, and what is the server's expectation?* **[RESOLVED]** **No native caller passes `compress:true`.** A targeted grep for `.Write(...,true)` / `compress: true` / `useCompression: true` across the decompiled C# returns nothing but the parameter declarations themselves; every `Write` call relies on the `bool compress = false` default (`Connection.cs:18`, `StanzaWriter.cs:25`, `IConnectionOutput.cs`, `BinTreeNodeWriter.cs:44`). So on the *native* outbound path the deflate branch is dead code and the emitted flag byte is always `0`; the "decide by size" logic (`StanzaWriter.cs:44-66`) is reachable only if some caller ever requests compression, which none does here. The server still *may* compress inbound frames (bit `0x2`), and inbound inflate is live (`EncryptedBytesReceiver.cs:33-41`). (Already stated in §3.6; the trigger-policy question is closed: native never triggers it.)
- **`_isCompanionRegistration` path** is `NotImplementedException` (`WAProtocol.cs:189-192`). **[RESOLVED as dead-in-this-build]** The companion/multi-device-registration receive branch is not merely unimplemented — it is **never entered**: the single `WAProtocol` constructor call site hard-codes `isCompanionRegistration: false` (`SocketAdapter.cs:75`), and that ctor arg is the only thing that sets the field (`WAProtocol.cs:29`). So `ProcessMultiDeviceRegistrationNode` is unreachable from native code; pairing is handled in **JS**: the bundle's `xmlns==="md"` branch dispatches `case"pair-device": return r("WAWebHandlePairDevice")(e)` (de-minified bundle `/home/ark/Dev/projects/Webstorm/whatsapp/research/waweb-unmin/xTiXmyjNEd_.js:11626-11634`).
  - *Residual — the registration stanza shapes themselves — now* **[RESOLVED via cross-reference + interop]** *(was [CANNOT RESOLVE STATICALLY]).* The `xmlns="md"` QR-pairing exchange is fully recovered from the open WA-Web protocol implementations that interoperate with the same servers, and corroborated by literal strings in the de-minified bundle. The flow is the 3-stanza exchange now documented in §3.5: (1) server `<iq type="get" xmlns="md"><pair-device><ref>…</ref></pair-device></iq>` → client ACK `<iq type="result" to=<from> id=<id>/>` then QR-render (cross-reference: `whatsmeow/pair.go:51-80,114-118`); (2) server `<iq type="set" xmlns="md"><pair-success>` with `<device-identity>`(=`ADVSignedDeviceIdentityHMAC` protobuf)`, <device jid lid>, <biz name>, <platform name></pair-success></iq>` (cross-reference: `whatsmeow/pair.go:121-144`; Baileys `src/Utils/validate-connection.ts:169-184`); (3) client confirmation `<iq type="result" to="s.whatsapp.net" id=<reqId>><pair-device-sign><device-identity key-index=..>`=re-signed `ADVSignedDeviceIdentity``</device-identity></pair-device-sign></iq>` (cross-reference: `whatsmeow/pair.go:226-243`; Baileys `validate-connection.ts:221-241`), with an `<iq type="error"><error code text/></iq>` failure form (`whatsmeow/pair.go:288-303`). ADV signature prefixes are `{6,0}` account / `{6,1}` device / `{6,5}` hosted-account, signed as Curve25519 XEdDSA 64-byte (cross-reference: `whatsmeow/pair.go:31-34,264-286`; Baileys `validate-connection.ts:201-216`). Bundle string corroboration: `research/waweb-unmin/xTiXmyjNEd_.js` — `pair-device`@11630, `pair-success`@11632, `device-identity`@29408+, `companion_reg`@10937; and the **actual JS-side builder** lives in the bundle — `pair-device-sign` + `ADVSignedDeviceIdentity`/`key-index`/`eRegid`/`DeviceProps` symbols co-locate in `research/waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js` and `research/waweb-unmin/n6o0-NaJTww.js` [bundle, this pass]. The pairing *output* is also now confirmed to land in the live WebView IndexedDB — `signal-storage.identity-store` (the device identity keypair), `model-storage.device-list` (store 12), `account-linking` (store 81), `direct-connection-keys` (store 35) — so a renderer-hosted port inherits pairing state for free ([live-appdata]; docs 94/95, `research/idb_schema.txt`). **Honesty label:** these are *protocol-level facts the native client must share to interoperate*, recovered from Baileys/whatsmeow + the JS bundle — **not** disassembled from `WhatsAppNative.dll`/`WhatsApp.Root.dll`.
  - *Residual — the **native C# stanza-builder source** for these shapes — stays* **[CANNOT RESOLVE STATICALLY]**, *but the closing artifact is now narrowed, the negative evidence strengthened, and a new positive finding (the payload DTOs ship while the builder does not) added this pass.* (a) [decompiled-C#, this pass] re-confirmed unchanged: `ProcessMultiDeviceRegistrationNode` is still `throw new NotImplementedException();` (`WAProtocol.cs:189,191`) and the only ctor call-site hard-codes `isCompanionRegistration:false` (`SocketAdapter.cs:75`; field set at `WAProtocol.cs:29`); a **second** dead pairing path was found this pass — `HandshakeHandler.cs:27,52` carries its own `_isCompanionRegistration` field also hard-set to `false` (so even the Noise-handshake variant for companion registration is compiled out). An exhaustive `rg '"md"'` over the decompiled C# shows the **only** `xmlns="md"` emitter is the `removecompanion` IQ (`ConnectionExtensions.cs:18`, already in §3.7) — there is no `pair-device`/`pair-success`/`pair-device-sign` builder, and no SMAX-generated `Pair*`/`CompanionReg` outgoing class, anywhere in the managed build. (a′) [decompiled-C#, this pass — NEW positive] the managed build *does* ship the pairing **payload protobuf DTOs**, just not a stanza builder that wraps them: `WhatsApp.Protobuf/Whatsapp/ADVSignedDeviceIdentity.cs`, `.../ADVSignedDeviceIdentityHMAC.cs` (and `AdvReflection.cs`), plus `WhatsApp.Protobuf/WhatsApp.ProtoBuf/EncryptedPairingRequest.cs` (a serialize/deserialize-only message with exactly two fields — `EncryptedPayload` @field 1 / wire-tag 10 and `Iv` @field 2 / wire-tag 18, `EncryptedPairingRequest.cs:8,10,55-59,139-148`) — i.e. the encrypted-pairing wrapper DTO. These are pure protobuf codecs (`Serialize`/`Deserialize`, no `ProtocolTreeNode` construction), so they confirm the build retains the *data shapes* for pairing while the *`md` stanza builder* that would marshal them onto the wire is the part that is compiled out. (b) [native-binary, this pass] `strings WhatsAppNative.dll` (12.5 MB) yields **zero** pairing symbols — no `pair-device`, `pair-success`, `pair-device-sign`, `companion_reg`, `device-identity`, `ADVSigned`, or `xmlns` literals — consistent with doc 92/94's finding that the native crypto/protocol code is statically linked with stripped symbols (bcrypt imports are RNG-only; no `BCryptEncrypt`/KDF). So the native binary, even disassembled, would not surface a readable `md` builder. (c) [bundle, this pass] the working builder location is re-confirmed: the `pair-device-sign` confirmation stanza (3) is built in `research/waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:33169` via `WASmaxJsx.smax("pair-device-sign", null, WASmaxJsx.smax("device-identity", {…}))`, and `device-identity` nodes are emitted via `WAWap.wap("device-identity", null, …)` at `research/waweb-unmin/xTiXmyjNEd_.js:29408,29813,30898,31128,31681`; the `pair-device`/`pair-success` server-push dispatch is `xTiXmyjNEd_.js:11630,11632`. The *only* artifact that would now close this for the native C# is a build of `WhatsApp.Root.dll` where `ProcessMultiDeviceRegistrationNode` is actually implemented (none exists in the dump); the *wire shapes* are fully resolved (above), and the *working builder location* is resolved to the JS bundle. For a Linux/Electron port this residual is **moot** — the renderer-hosted WA-Web bundle supplies the builder and persists pairing state to IndexedDB, so the native C# builder need not be recovered or reimplemented.
- **The resolver chain `_sources` contents.** *Question: `ChainResolver` is generic over its sources; what is the concrete resolver list (system DNS, hardcoded fallback IPs, DoH)?* **[RESOLVED]** Two concrete chains exist and both are now pinned. (1) The **live** chain actually used by `ConnectionManager` is `IpProvider` (`ConnectionManager.cs:25` — `private readonly IpProvider _ipProvider = new IpProvider();`, consumed at `:134` via `await _ipProvider.GetNext()`), whose ctor registers, in order and each duplicated for IPv6+IPv4: `SystemResolver→g.whatsapp.net`, `SystemResolver→g-fallback.whatsapp.net`, `HardcodedResolver→g.whatsapp.net`, `HardcodedResolver→e{1..16}.whatsapp.net` (random `e{n}`), `SystemResolver→e{1..16}.whatsapp.net` (`IpProvider.cs:82-95`, `:65-69`). (2) The alternate `ChainResolver` is wired in `Resolver.cs:8` as `new CacheResolver(new ChainResolver(new SystemResolver(), new HardcodedResolver()))` — i.e. **system DNS first, hardcoded IP fallback second**, wrapped in a TTL cache. Both chains are **system DNS + hardcoded fallback IPs only — no DoH** (the obsolete hand-rolled UDP `DnsResolver` is not wired into either; `DnsResolver.cs:143`). The live `ConnectionManager` path uses `IpProvider`, **not** `Resolver.Instance`/`CacheResolver`. (Already documented in §3.8; this closes the "which sources" question with the `Resolver.cs` literal added.)
