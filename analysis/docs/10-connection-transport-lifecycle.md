# 10. Connection & Transport Lifecycle

> Target: Meta **native** WhatsApp for Windows (`WhatsApp.Root.exe`, WinUI 3 / Windows App SDK 1.6, v2.2607.106.0).
> All paths in this document are **relative to `decompiled_source/`**. Line citations are of the form `path.cs:LINE` and were read directly from the decompiled C#. Where behavior is implemented in native C++/Rust or in the WebView2 JS bundle, it is labeled as **inferred** unless a managed caller pins it down.

---

## 1. Purpose & Scope

This document covers the **chat-connection transport stack** of the native Windows client: everything from "we have an account on disk" to "we have a logged-in, AES-GCM-encrypted FunXMPP stream to `s.whatsapp.net` and we keep it alive / rebuild it when it drops." Concretely:

- The connection **state machine** and attempt-cancellation model (`ConnectionManager`).
- **Port cycling** (443 → 5222 → 80) and the HTTP-chunked tunnel fallback (`FunRunner`, `ChunkedHttpSocket`).
- The **socket transport** abstraction over WinRT `StreamSocket` (`SystemSocket`), including read/connect timeouts.
- **Host → IP resolution** (`IpProvider`, `HostSelection`, `ChainResolver`, `SystemResolver`, `HardcodedResolver`).
- The **Noise handshake** glue that turns a raw socket into an encrypted stream (`HandshakeHandler`, `HandshakeCipher`, `HandshakeHash`), including the `ClientPayload` login envelope and **server-certificate verification**.
- The **frame layer** (3-byte length prefix) and the **encrypted stanza read/write loop** (`FramesReader`/`FramesWriter`, `StanzaWriter`, `EncryptedBytesReceiver`, `WAProtocol`).
- **Login success/failure** parsing, **ban handling**, **reconnection backoff** (Fibonacci + jitter), and **keepalive/liveness** (read-timeout-driven, with the ping IQ itself emitted by JS).

**Out of scope** (covered by other docs): the FunXMPP binary token format internals (`BinTreeNodeWriter`/`BinTreeNodeReader`), the Smax stanza families, Signal/double-ratchet, media transport over `mmg.whatsapp.net`, and VoIP signaling. They are referenced here only where the transport touches them.

A critical architectural fact established below: the native layer is a **thin authenticated pipe**. Post-login it natively handles only `iq`/`success`/`failure`; `message`/`receipt`/`notification`/`presence`/`chatstate` are routed to the WebView2 JS bundle. The keepalive ping stanza is *built* by generated native code but is *sent* from JS.

---

## 2. Where It Lives

| Concern | File(s) (relative to `decompiled_source/`) | Namespace |
|---|---|---|
| Connection state machine | `decompiled/WhatsApp.Root/WhatsAppCommon/ConnectionManager.cs` | `WhatsAppCommon` |
| Socket-state enum + port table | `decompiled/WhatsApp.Root/WhatsApp/FunRunner.cs` | `WhatsApp` |
| Network session contract | `decompiled/WhatsApp.Root/WhatsAppCommon/INetworkSession.cs` | `WhatsAppCommon` |
| Frame target + handshake/protocol wiring | `decompiled/WhatsApp.Root/WhatsAppCommon/SocketAdapter.cs` | `WhatsAppCommon` |
| Transport contract | `decompiled/WhatsApp.Networking/WhatsApp/ISocket.cs` | `WhatsApp` |
| TCP transport (WinRT StreamSocket) | `decompiled/WhatsApp.Root/WhatsApp/SystemSocket.cs` | `WhatsApp` |
| HTTP-chunked transport (port 80) | `decompiled/WhatsApp.Networking/WhatsApp/ChunkedHttpSocket.cs` | `WhatsApp` |
| Frame writer / reader (length prefix) | `decompiled/WhatsApp.Networking/WhatsApp/FramesWriter.cs`, `.../FramesReader.cs` | `WhatsApp` |
| Noise handshake orchestration | `decompiled/WhatsApp.Root/WhatsApp/HandshakeHandler.cs` | `WhatsApp` |
| Noise symmetric state | `decompiled/WhatsApp.Root/WhatsApp/HandshakeCipher.cs`, `.../HandshakeHash.cs` | `WhatsApp` |
| Handshake/transport AEAD | `decompiled/WhatsApp.Root/WhatsApp/AesGcmProvider.cs` | `WhatsApp` |
| HKDF for Noise key split | `decompiled/WhatsApp.VoIP/WhatsApp/HkdfSha256.cs`, `.../Hkdf.cs` | `WhatsApp` |
| Server cert verification | `decompiled/WhatsApp.Root/WhatsApp/WACertificateVerificationUtils.cs` | `WhatsApp` |
| Curve25519 native bridge | `decompiled/WhatsApp.VoIP/WhatsApp/Curve22519Extensions.cs` | `WhatsApp` |
| Encrypted send path | `decompiled/WhatsApp.Root/WhatsApp/StanzaWriter.cs` | `WhatsApp` |
| Encrypted receive path | `decompiled/WhatsApp.Root/WhatsApp/EncryptedBytesReceiver.cs` | `WhatsApp` |
| Protocol dispatch / auth state | `decompiled/WhatsApp.Root/WhatsApp/WAProtocol.cs` | `WhatsApp` |
| Token dictionary + version byte | `decompiled/WhatsApp.Networking/WhatsApp/TokenDictionary.cs`, `decompiled/WhatsApp.Root/WhatsApp/FunXMPP.cs` | `WhatsApp` |
| IQ request/response correlation | `decompiled/WhatsApp.Networking/WhatsApp/IqRequestsTracker.cs` | `WhatsApp` |
| Connection facade | `decompiled/WhatsApp.Networking/WhatsApp/Connection.cs` + `.../WhatsApp.Networking.XMPP/IConnection.cs`, `.../IConnectionOutput.cs` | `WhatsApp`, `WhatsApp.Networking.XMPP` |
| Reconnect backoff | `decompiled/WhatsApp.Networking/WhatsApp/ConnectionBackoffModel.cs`, `.../FibonacciFunction.cs` | `WhatsApp` |
| Host selection | `decompiled/WhatsApp.Networking/WhatsApp/HostSelection.cs`, `decompiled/WhatsApp.Root/WhatsApp/IpProvider.cs` | `WhatsApp` |
| DNS resolvers | `decompiled/WhatsApp.Networking/WhatsApp.Resolvers/{IResolver,ChainResolver,ResolverExtensions,ResolveResult}.cs`, `decompiled/WhatsApp.Root/WhatsApp.Resolvers/{SystemResolver,HardcodedResolver}.cs` | `WhatsApp.Resolvers` |
| Network reachability | `decompiled/WhatsApp.VoIP/WhatsApp/NetworkStateMonitor.cs`, `.../NetworkStateChange.cs` | `WhatsApp` |
| Server-time / clock skew | `decompiled/WhatsApp.Root/WhatsAppCommon.Time/ClocksMonitor.cs` | `WhatsAppCommon.Time` |
| Timeouts + constants | `decompiled/WhatsApp.VoIP/WhatsApp/Constants.cs` | `WhatsApp` |
| Login failure model | `decompiled/WhatsApp.Networking/WhatsApp/LoginFailedReason.cs`, `.../LoginFailureException.cs` | `WhatsApp` |
| Stream-end / corrupt-stream signals | `decompiled/WhatsApp.Networking/WhatsApp/StreamEndException.cs`, `.../CorruptStreamException.cs` | `WhatsApp` |
| Keepalive ping stanza (codegen) | `decompiled/WhatsApp.Networking/WhatsApp.Smax.Generated.Pings.Outgoing/ClientRequest.cs`, `.../Pings.Incoming/ClientResponseServerResponse.cs` | `WhatsApp.Smax.Generated.Pings.*` |

> Note: many of these files carry an original-source path comment of the form `D:\full-fbsource\whatsapp\windows\Samples\WinUI\WebView2\WhatsApp.Root\SeamlessMigration\FunXMPP\...` (e.g. `ConnectionManager.cs:76`, `SystemSocket.cs:63`, `EncryptedBytesReceiver.cs:29`). The whole FunXMPP transport lived under a `SeamlessMigration\FunXMPP` source tree in the original repo.

---

## 3. How It Works

### 3.0 End-to-end sequence (the 30-second tour)

```
ConnectionManager.Start()
  └─ subscribe NetworkStateMonitor (throttle 2s) + DispatchConnect()           CM:47-67
DispatchConnect → serial dispatcher → RenewState(attempt)                      CM:70-96,105
RenewState:
  close old socket; WhenConnectionChanged.OnNext(null)                         CM:110-112
  if cancelled / no data → return
  await backoff (Fibonacci × jitter, 0 first time)                             CM:117
  FunRunner.CyclePort(); port = 443|5222|80                                    CM:122-123 / FR:19,59
  socket = SystemSocket(port)  (+ ChunkedHttpSocket if 80)                     CM:217-227
  socket.SetTimeout(LoginTimeout=30s)                                          CM:224
  HandshakeHandler(...) wires FramesWriter(socket)                             CM:225
  ip = await IpProvider.GetNext()                                             CM:134 / IpProvider:97
  subscribe LoggedIn / LoginFailed / WhenStateChanged(Disconnected→reconnect)  CM:145-160
  socket.Start(ip):                                                            SA:92-100
     handshake.WriteInitialStanza()  → ClientHello (or ClientResume)          HH:147-166
     state = Connecting; socket.Connect(ip)
StreamSocket connects → flush early buffer → StateChanged(true) → state=LoggingIn  SS:61-95 / SA:44-48
inbound frames → FramesReader → SocketAdapter.ProcessFrame                     SA:51
  pre-keys: handshake.TryHandshake(frame)                                      SA:71
     on success: GenerateKeys() → (writeKey, readKey)                          SA:73 / HC:93-101
     build StanzaWriter(writeKey), WAProtocol, EncryptedBytesReceiver(readKey) SA:74-82
EncryptedBytesReceiver decrypts → ParseTreeNode → WAProtocol.ProcessStanza     EBR:24-47
  'success' → _isLoggedIn=true, save server time, fire LoggedIn               WAP:84-92
SocketAdapter LoggedIn handler:                                                SA:76-81
  state = Connected; socket.SetTimeout(ForegroundPingTimeout=100s); raise LoggedIn(writer)
ConnectionManager.OnLoggedIn:                                                  CM:174-182
  mark IP connected; reset backoff; persist LastGoodPortIndex;
  WhenConnectionChanged.OnNext(new Connection(writer, _requests))
```

The rest of §3 walks each box in detail.

---

### 3.1 `ConnectionManager`: the top-level state machine

`ConnectionManager` is constructed with the account's static keypair, username, LID-migration flag, optional edge-routing blob, push name, and device id (`ConnectionManager.cs:16`). It owns one `IqRequestsTracker`, one `IpProvider`, one `ConnectionBackoffModel`, the `ClocksMonitor` singleton, and a **serial** dispatcher dedicated to connection work (`ConnectionManager.cs:23-39`):

```csharp
private readonly IThreadDispatcher _dispatcher = Dispatchers.CreateSerial(Log.DispatcherId.Connection);   // CM:39
```

**Attempt model.** Every connect cycle is tagged with a monotonically increasing `_attempt` (`CM:33`). `DispatchConnect()` does `Interlocked.Increment(ref _attempt)` then dispatches `RenewState(attempt)` onto the serial queue (`CM:70-77`). Delayed reconnects use the `DispatchConnect(int parentAttempt)` overload, which only proceeds if the attempt hasn't moved on:

```csharp
int attempt = parentAttempt + 1;
int num = Interlocked.CompareExchange(ref _attempt, attempt, parentAttempt);
if (parentAttempt == num) { _dispatcher.Dispatch(() => RenewState(attempt), ...); }   // CM:81-89
```

This is how a newer connect cancels a stale one: `IsCanceled(attempt)` returns true whenever `Interlocked.CompareExchange(ref _attempt, attempt, attempt) != attempt`, i.e. the global attempt counter has advanced past this cycle (`CM:184-198`). `IsCanceled` *also* short-circuits to `true` if the server has hard-rejected us (`IsRejectedByServer()`), or if `_isCanceled` is set by `Dispose()` (`CM:186-197`, `CM:98-103`).

**`Start()`** subscribes to `NetworkStateMonitor.Instance.WhenNetworkStateChanged`, collapses each change to one of `{IPv4Connected, IPv6Connected, None}`, applies `DistinctUntilChanged()` and a **2-second `Throttle`**, and on each settled change calls `DispatchConnect()`. It also fires one immediate `DispatchConnect()` (`CM:47-67`). The throttle debounces flapping interfaces (e.g. Wi-Fi → Ethernet) so we don't thrash the socket.

**`RenewState(attempt)`** is the core of the machine (`CM:105-172`):

1. `_socket?.TryClose(); _socket = null; WhenConnectionChanged.OnNext(null)` — tears down any previous session and tells the app the connection is gone (`CM:110-112`).
2. Bail if cancelled, or if `NetworkStateMonitor.Instance.State.IsDataConnected` is false (`CM:113-116`).
3. `await Task.Delay(_backoff.GetBackoffTime(isBackground: false))` — wait out the current backoff window (zero on the first attempt; see §3.9) (`CM:117`).
4. `FunRunner.CyclePort(); currentPort = FunRunner.GetCurrentPort()` (`CM:122-123`).
5. `_socket = CreateSocket(attempt, currentPort, connectInPullMode: true)` (`CM:124`). If `CreateSocket` returns null, retry in 5 s (`CM:129-133`).
6. `IPAddress item = (await _ipProvider.GetNext()).Item1` — resolve the next host's IP (`CM:134`). If null, retry in 1 s (`CM:135-138`).
7. Subscribe to the new socket's events (`CM:145-160`):
   - `LoggedIn` → `OnLoggedIn(writer)`.
   - `LoginFailed` → `OnLoginException(ex, attempt)`.
   - `WhenStateChanged` → when it reports `Disconnected`, **null out the server-time** (`_clocksMonitor.SaveServerTime(null)`) and `DispatchConnect(attempt, 1s)`.
8. `_socket.Start(item)` (`CM:161`).

Any exception in the whole block triggers `DispatchConnect(attempt, 1s)` (`CM:164-167`).

**`CreateSocket`** (`CM:217-227`) is the transport factory:

```csharp
ISocket socket = new SystemSocket(port);
if (port == 80) socket = new ChunkedHttpSocket(socket);
socket.SetTimeout((int)Constants.LoginTimeout.TotalMilliseconds, cumulative: true);   // 30 000 ms
HandshakeHandler hh = new HandshakeHandler(clientStaticPrivate, clientStaticPublic, null,
        username, new FramesWriter(socket), isLidDbMigrated, edgeRoutingInfo, pushName, myDeviceId);
return new SocketAdapter(_requests, socket, attempt, connectInPullMode, hh);
```

Note the third arg to `HandshakeHandler` (`serverStaticPublic`) is **null** here, so `ConnectionManager` always drives a fresh XX handshake, not a cached-IK resume (see §3.6).

**`OnLoggedIn`** (`CM:174-182`): mark IP/resolver as good (`IpProvider.MarkIPAddressAsConnected`), reset backoff (`_backoff.HandleLogin()`), persist the working port index (`SeamlessMigrationAppSessionStorage.Instance.LastGoodPortIndex = FunRunner.GetCurrentPortIndex()`), and publish a new `Connection(writer, _requests)` over `WhenConnectionChanged`. That `Connection` is what the rest of the app (and the JS bridge) uses to send stanzas.

**`OnLoginException`** (`CM:229-241`): record `_lastFailureReason`. If the reason is `ServerBackoffRequest`, call `_backoff.HandleBackoffRequest()` and reconnect after `GetBackoffTime(AppState.IsInBackground)`; otherwise reconnect after 1 s.

---

### 3.2 `FunRunner`: socket-state enum and port cycling

`FunRunner` holds the global notion of "which port are we on" and the 4-state socket enum (`FunRunner.cs:11-17`):

```csharp
public enum SocketStates { Disconnected, Connecting, LoggingIn, Connected }
private static readonly int[] Ports = new int[3] { 443, 5222, 80 };   // FR:19
```

- `CurrentPortIndex` lazily seeds from `SeamlessMigrationAppSessionStorage.Instance.LastGoodPortIndex` (`FR:31-45`), so a restart resumes on the last port that worked.
- `GetCurrentPort()` = `Ports[CurrentPortIndex % 3]` (`FR:49-57`).
- `CyclePort()` has a one-shot guard: the very first call only flips `CyclePorts = true` without advancing; subsequent calls do `CurrentPortIndex++` (`FR:59-69`). Net effect: the first connect after start stays on the saved/last-good port; only **after a failure** does the index advance to the next port. `DisableCyclePortOnNextConnect()` resets that guard (`FR:71-74`).

So the port progression on repeated failures is `443 → 5222 → 80 → 443 → …` (mod 3), pinned to whatever last worked on restart.

`FunRunner.CurrentServerTimeUtc` just forwards `ClocksMonitor.Instance.CurrentServerTimeUtc` (`FR:47`) — this is what ban-expiry math in `WAProtocol` uses (§3.8).

---

### 3.3 `ISocket` / `SystemSocket`: the TCP transport

`ISocket` is the transport contract: `Connect(IPAddress)`, `Send(byte[], int)`, `SetTimeout(int ms, bool cumulative)`, plus `StateChanged(bool)` and `BytesAvailable` events; it extends `ICancelable`/`IDisposable` (`ISocket.cs:7-18`).

`SystemSocket` wraps a WinRT `Windows.Networking.Sockets.StreamSocket` (`SystemSocket.cs:12-16`). Key behaviors:

- **Early-send buffering.** In the ctor it grabs the socket's output stream into `_earlySendBuffer` *before connect* (`SS:35`). `Send()` writes into that buffer until connect completes; afterward it writes straight to the live output stream and flushes (`SS:38-59`). This is what lets `SocketAdapter.Start()` call `WriteInitialStanza()` (the WA header + ClientHello) **before** `Connect()` returns (§3.5) — the handshake bytes are queued and flushed the instant the TCP connection is up.
- **Connect** runs on a private `ConcurrentQueueDispatcher` (`SS:14`, `SS:61-63`). It links a `CancellationTokenSource` to `_dispose`, calls `cancel.CancelAfter(_timeout)`, builds a `HostName` from the IP, and `await _socket.ConnectAsync(host, port)` (`SS:70-74`). On success it flushes+clears `_earlySendBuffer`, raises `StateChanged(true)`, then enters `ReadData()` (`SS:76-84`). The `finally` always `Dispose()`s and raises `StateChanged(false)` (`SS:90-94`) — so any connect error or stream end deterministically surfaces a disconnect.
- **Read loop** (`SS:121-149`): a single reusable 10 240-byte buffer; before each `ReadAsync` it re-arms `cancel.CancelAfter(_timeout)`. A read returning `> 0` raises `BytesAvailable(buffer, 0, num)`; a read returning `0` (EOF) breaks the loop → `finally` disposes → disconnect. **This read timeout is the entire keepalive mechanism** (see §3.10): if no bytes arrive within `_timeout`, the linked CTS cancels the `ReadAsync`, the loop throws, and the socket dies.
- **`SetTimeout(int ms, bool cumulative)`** just stores `_timeout = TimeSpan.FromMilliseconds(ms)` (`SS:97-100`). The `cumulative` flag is **ignored** in `SystemSocket` (the value is the same per-operation deadline either way).
- **Dispose** is idempotent under a `lock(_dispose)` and cancels the CTS + disposes the StreamSocket (`SS:102-119`).

---

### 3.4 `ChunkedHttpSocket`: the port-80 HTTP tunnel

When the selected port is 80, `CreateSocket` wraps the `SystemSocket` in a `ChunkedHttpSocket` decorator (`CM:220-222`). This tunnels the binary WA protocol inside an HTTP/1.1 **chunked-transfer** request so it survives transparent HTTP proxies.

On construction it immediately writes the request preamble (`ChunkedHttpSocket.cs:214-216, 250-261`):

```
POST /chat HTTP/1.1
Host: c.whatsapp.net
User-Agent: Mozilla/5.0 (compatible; WAChat/1.2; +http://www.whatsapp.com/contact)
Transfer-Encoding: chunked
```

- **Send** wraps each outbound buffer as one HTTP chunk: `hex(len)\r\n` + payload + `\r\n` (`CHS:278-291`). The hex length uses `bytesToSend.ToString("X")`.
- **Dispose** writes the terminating zero-chunk `0\r\n\r\n` then disposes the base socket (`CHS:263-271, 218`).
- **Receive** (`ChunkedHttpSocketHandler.SocketBytesIn`, `CHS:52-141`) is a hand-rolled HTTP chunked parser. It reads the status line, then headers; it requires a `Transfer-Encoding: chunked` header — if the header section ends without it (`!_sawChunkedHeader`), it **disposes the connection** (`CHS:85-92`). A non-`chunked` `Transfer-Encoding` value also disposes (`CHS:101-107`). After headers it repeatedly parses `hex-length\r\n<bytes>\r\n`, forwarding each chunk's payload via `OnClientBytesIn` → `BytesAvailable` to the same `FramesReader` the raw path uses. A zero-length chunk (`_bytesToRead == crlfLength`) disposes (end of stream) (`CHS:115-120`).

So from `SocketAdapter`'s perspective, port 80 looks identical to ports 443/5222 — same `BytesAvailable`/`StateChanged` events, same frame layer on top — the chunk framing is invisibly stripped.

> **Inference:** despite the literal header strings (`Host: c.whatsapp.net`, `User-Agent: WAChat/1.2`), these are legacy/cosmetic — the actual destination is the resolved chat-host IP that `Connect(ip)` dialed; the `Host` header is not used for routing on a raw TCP-to-IP socket. The strings are baked-in constants (`CHS:214`), not derived from the live host.

> **Live-network status (round-2, this session): the port-80 path is dead server-side.** `c.whatsapp.net` now resolves to a **parked Fastly anycast IP `15.197.206.217`** (`getent hosts c.whatsapp.net`). A raw TCP connect to `:80` *completes* at the Fastly edge, but replaying the exact legacy preamble above plus a `0\r\n\r\n` terminator yields **no response** — the edge never speaks the WA chunked-chat protocol — and `:443` on that name serves a **mismatched parked cert** (`CN=TYZtMNRLBycKfIR.net`, not WhatsApp's pinned chain). The real chat host `g.whatsapp.net` by contrast resolves to a genuine Meta `chat.cdn.whatsapp.net` IP. The open WA-Web stacks corroborate that nothing modern uses port 80: whatsmeow and Baileys connect only over `wss://web.whatsapp.com/ws/chat` (whatsmeow `socket/constants.go:21-23`). **A Linux/Electron port should drop the `ChunkedHttpSocket` port-80 fallback** — it cannot reach a live WA chat server — and rely on ports 443/5222 (or the WebSocket transport) instead. (See §6 item 5.)

---

### 3.5 Frame layer: `FramesWriter` / `FramesReader`

Both directions use a **3-byte big-endian length prefix** ("medium"/24-bit). `FramesReader.FrameHeaderSize = 3` (`FramesReader.cs:12`).

**Writing** (`FramesWriter.cs`): `WriteFrameInternal(frame)` prepends `MediumToByteArray(frame.Length)` then the frame, sends the combined buffer through `ISocket.Send`, and resets its scratch `WaMemoryStream` (`FW:21-29`). `MediumToByteArray` packs the 24-bit length MSB-first (`FW:31-38`). `WriteBinaryArray(bytes)` sends raw bytes with no prefix (used for the WA/edge headers, §3.6) (`FW:16-19`).

**Reading** (`FramesReader.cs`): `SocketBytesIn` buffers across socket reads. Fast path when nothing is buffered: parse directly out of the input buffer, then stash only the unconsumed tail (`FR:27-39`). Otherwise append to `_memory` and parse from the running offset, compacting when fully drained (`FR:40-49`). `OnBytesAvailable` is the parser (`FR:66-85`):

```csharp
while (length > 0 && length >= 3) {
    int num5 = (buffer[num] << 16) + (buffer[num+1] << 8) + buffer[num+2];   // 24-bit length
    length -= 3;
    if (length < num5) break;                 // incomplete frame → wait for more bytes
    _target.ProcessFrame(buffer, num + 3, num5);
    length -= num5; num += 3 + num5;
}
```

It dispatches only complete frames and handles fragmentation across TCP reads. The `ITarget` is the `SocketAdapter` (`FramesReader.ITarget`, `FR:7-10`; `SocketAdapter.cs:11,42-43`).

---

### 3.6 `HandshakeHandler`: the Noise handshake glue

`SocketAdapter.Start()` is what kicks the handshake (`SocketAdapter.cs:92-100`):

```csharp
_handshake.WriteInitialStanza();
_stateSubject.OnNext(FunRunner.SocketStates.Connecting);
_adaptee.Connect(ipAddress);
```

Because of `SystemSocket`'s early-send buffer (§3.3), the header+ClientHello bytes are queued, then flushed the moment TCP connects.

**Wire prologue** (`HandshakeHandler.WriteInitialStanza`, `HH:147-166`):

1. If `_edgeRoutingInfo` is present: write the **edge header** `ED\0\x01` = `new byte[]{69,68,0,1}` (`HH:50`), then a 3-byte length of the routing blob, then the blob itself (`HH:149-156`). The blob is **read from the settings SQLite DB at key 163** (`settingsDb.TryGetSetting<byte[]>(163L, out edgeRoutingInfo)`, `SeamlessMigrationManager.cs:519`) and threaded through `ConnectionManager`'s ctor (`SeamlessMigrationManager.cs:563` → `ConnectionManager.cs:16` → `HandshakeHandler` at `CM:225`). The native C# only *consumes* key 163. The **JS writer is now confirmed in the bundle** [bundle]: the server sends an info-bulletin `<ib>` stanza carrying an `<edge_routing>` child whose `<routing_info>` element's `contentBytes()` is the blob (`waweb-unmin/b1yokgAMCB8V63CR_FA-OVE0xyAFeA8F3SvySJLzxwIigwK2MI-Vq34Oq07nzPieyNlZFruYjDNhl3RM.js:45838-45843`); the bundle then calls `handleRoutingInfo({domain, edgeRouting})` → `WAWebUserPrefsMultiDevice.setRoutingInfo(...)` to persist it (`b1yokgAMCB8V...js:45764-45771`, `setRoutingInfo`/`getRoutingInfo`/`WARoutingInfo` plumbing at `n6o0-NaJTww.js:13946,19670-19731,27104`), base64-encoded under `edgeRouting` (`WABase64.encodeB64`, `n6o0-NaJTww.js:19731`). The on-wire FunXMPP tokens `edge_routing`/`routing_info` are confirmed in the native token dictionary (`WAPDefaultTokenDictionary.cs:10-11`) and the bundle token table (`n6o0-NaJTww.js:3732`). Baileys mirrors this exactly [protocol-cross-ref]: its `CB:ib,,edge_routing` handler reads `edge_routing > routing_info`'s content into `creds.routingInfo` (`Baileys/src/Socket/socket.ts:1015-1021`) and replays it on the next connect as the `ED` query param / Noise intro-header prefix (`socket.ts:122-123`, `Utils/noise-handler.ts:80-88`). So the round-trip is fully pinned: **server `<ib><edge_routing><routing_info>` → JS persists to the shared settings DB (key 163) → native reads key 163 and writes the `ED\0\x01`+blob prologue on the next handshake.**
2. Always write the **WA header** = `{87,65,6,0}` → ASCII `"WA"`, protocol version `6`, then byte index 3 overwritten with `FunXMPP.Dictionary.GetDictionaryVersion()` (`HH:47-49`). So the on-wire header is `W A 0x06 0x03`. `WaProtocolVersion = 6` is a named constant (`HH:11`). `dictVer` comes from `TokenDictionary.GetDictionaryVersion()` (`TokenDictionary.cs:107`), which returns `dict.DictionaryVersion` (`TokenDictionary.cs:31`); the concrete value is **`3`** — `WAPDefaultTokenDictionary.DictionaryVersion => 3` (`WAPDefaultTokenDictionary.cs:163`). So the full 4-byte header is `0x57 0x41 0x06 0x03`.
3. Then either `SendClientHello()` (fresh) or `SendClientResume(serverStaticPublic)` (cached) — gated on `_isCompanionRegistration || _serverStaticPublic == null` (`HH:158-165`). Since `ConnectionManager` passes `serverStaticPublic = null` (`CM:225`), the normal login always sends a fresh ClientHello.

**Noise protocol names** (the three modes), as raw ASCII in `HandshakeCipher` (`HandshakeCipher.cs:8-30`):

| Mode | Constant | ASCII string |
|---|---|---|
| Fresh login | `FULL_HANDSHAKE` | `Noise_XX_25519_AESGCM_SHA256` |
| Resume w/ cached server key | `RESUME_HANDSHAKE` | `Noise_IK_25519_AESGCM_SHA256` |
| XX-fallback | `FALLBACK_HANDSHAKE` | `Noise_XXfallback_25519_AESGCM_SHA256` |

(The XX/IK variants are zero-padded to 32 bytes; XXfallback is 36 bytes.)

**Fresh XX flow:**

- `SendClientHello()` (`HH:66-74`): `_cipher = new HandshakeCipher(FULL_HANDSHAKE, _header)`; build `ClientHello{ Ephemeral = encryptEphemeralKey(clientEphemeralPublic) }`; serialize the `HandshakeMessage` protobuf and `WriteFrameInternal`. `encryptEphemeralKey` does **not** encrypt — it just mixes the ephemeral public into the transcript hash and returns it verbatim (`HandshakeCipher.cs:57-61`).
- `ReceiveServerHandshake` / `ReceiveServerHello` (`HH:137-210`) handle `server.hello`:
  1. `decryptEphemeralKey(server.Ephemeral)` (hash-mix, returns as-is) → `setKey(Derive(serverEph, clientEphemeralPriv))` — first DH (`HH:177-179`).
  2. `decryptStaticKey(server.Static)` = AES-GCM-decrypt the server's static key (now that a cipher key exists) (`HH:180`). On null → `FailuresService.Investigate` and return false (`HH:181-185`).
  3. `setKey(Derive(serverStatic, clientEphemeralPriv))` — second DH (`HH:186-187`).
  4. `decryptPayload(server.Payload)` → the server certificate blob (`HH:188`).
  5. **`WACertificateVerificationUtils.ValidateCertificate(payload, serverStatic, DateTime.Now, 6)`** — if it fails, `throw new InvalidOperationException("Untrusted server cert")` (`HH:194-197`). See §3.7.
  6. Persist `SeamlessMigrationAppSessionStorage.Instance.ServerStaticPublicKey = serverStatic` (so a future IK resume *could* be attempted) (`HH:198`).
  7. Send `ClientFinish{ Static = encryptStaticKey(clientStaticPublic), Payload = encryptPayload(BuildClientPayload()) }` after a third DH `setKey(Derive(serverEph, clientStaticPriv))` (`HH:199-208`).

**IK resume flow** (`SendClientResume` / `ReceiveServerResume`, `HH:76-135`) mirrors the above but starts from the cached `serverStaticPublic`, pre-deriving keys against it. `ReceiveServerResume` detects an **XX-fallback**: if the server's hello contains a `Static`, it calls `ReceiveServerFallback`, which re-initializes the cipher with `FALLBACK_HANDSHAKE` and re-runs `ReceiveServerHello` (`HH:115-173`). This path is **not exercised by `ConnectionManager`** (which never passes a cached key) but is present.

**`ClientPayload` login envelope** (`BuildClientPayload`, `HH:226-264`) — the encrypted `Payload` of ClientFinish/ClientResume. Notable fields read from code:

- `Username = ulong.Parse(_username)` (the phone number), `Passive = true`, `PushName`, `Device = _myDeviceId`.
- `connect_type = CurrentConnectionType()` — derived from `NetworkStateMonitor` radio type (`HH:212-224`).
- `Pull = _connectInPullMode` (true), `connect_reason = USER_ACTIVATED`, `LidDbMigrated = _isLidDbMigrated`. `Pull` is a distinct protobuf field — `ClientPayload.Pull` is a `bool?` at **field number 33** (varint, `ClientPayload.cs:1886`, `case 33u` at `ClientPayload.cs:2083-2087`) — separate from `Passive` (its own field, `ClientPayload.cs:1844`). The bundle and cross-ref impls confirm field 33 = `pull` BOOL across all stacks [bundle/protocol-cross-ref]: WA-Web's proto spec lists `pull: [33, e.TYPES.BOOL]` (`waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:114969`); whatsmeow declares `Pull *bool ...varint,33` (`whatsmeow/proto/waWa6/WAWebProtobufsWa6.pb.go:1083`). **`Passive` and `Pull` are independent flags, not a strict pair** — the matrix differs across clients: the **native** client sets `Passive=true, Pull=true` (`HandshakeHandler.cs:234,238`) [decompiled-C#]; **Baileys** `generateLoginNode` sets both true and `generateRegistrationNode` sets both false (`Baileys/src/Utils/validate-connection.ts:78-79,142-143`) [protocol-cross-ref]; but the **WA-Web bundle's mainline socket-connect login builds the `ClientPayload` with `{passive:false, pull:true}`** — `passive` and `pull` are read from the same options object as adjacent fields, both defaulting to `false` (`waweb-unmin/TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js:145721-145723`), and the connect callers pass `{passive:false, pull:true}` (`TSxMupG…js:146063-146065,146504-146506`) while a separate path passes `{passive:false, pull:false}` (`TSxMupG…js:146599-146600`). So `Pull=true` is the common "this is a real client login" signal, but it is set **orthogonally to `Passive`** — the native/Baileys `Passive=true` is a Windows/Baileys choice, not an invariant of `Pull`. Active message delivery is gated by a *separate* post-connect `<iq><passive/>` toggle, not the login flag — whatsmeow auto-issues `SetPassive(false)` after connecting to leave passive mode (`whatsmeow/connectionevents.go:196-215`) [protocol-cross-ref]. The server-side delivery semantics of `Pull` itself are not documented in any client code (see §6 item 7).
- `UserAgent`: `platform = WINDOWS`; `AppVersion` parsed from `PackageInfo.Version` (`a.b.c.d` → Primary/Secondary/Tertiary/Quaternary); `Mcc="000"`, `Mnc="000"`; `OsVersion = "{Major}.{Minor}.{Build}"`; `Manufacturer`/`Device` from `DeviceStatusEas`; locale via `CultureInfo.CurrentUICulture.GetLangAndLocale`; `release_channel = Constants.ReleaseChannel` (= `RELEASE`, `Constants.cs:178`).

After a successful handshake, `SocketAdapter` derives the transport keys via `GenerateKeys()` → `HandshakeCipher.getNoiseCipher()` (§3.7), then builds the post-login pipe (§3.8).

---

### 3.7 `HandshakeCipher` / `HandshakeHash` / AEAD / HKDF

**`HandshakeHash`** maintains the running transcript hash `h` (`HandshakeHash.cs`): ctor takes the protocol-name bytes as the seed `h` (or SHA-256 of it if `> 32` bytes — true for XXfallback) (`HH-hash:10-20`); `Update(buffer)` recomputes `h = SHA256(h || buffer)` using WinRT `CryptographicHash` (`HH-hash:22-28`).

**`HandshakeCipher`** is the Noise symmetric state (`HandshakeCipher.cs`):

- Ctor: `_hash = new HandshakeHash(name)`, `_chainKey = _hash.Hash`, then `_hash.Update(version)` mixes the `WA 6 dictVer` header into the transcript (`HC:40-45`).
- `encryptPayload(p)`: if no cipher key yet, returns `p` and just hash-mixes it; otherwise AES-GCM-encrypts with **AAD = current transcript hash `h`** and a 12-byte big-endian nonce `_nonce++`, then hash-mixes the ciphertext (`HC:69-74`). `decryptPayload` is the inverse (`HC:76-81`). The nonce is rendered via `WAProtocol.LongToByteArray(_nonce++, 12)` — a 12-byte big-endian counter (`WAProtocol.cs:53-66`).
- `setKey(agreement)`: HKDF the DH output into a new chain key + cipher key, resetting the nonce (`HC:83-91`):
  ```csharp
  byte[] okm = HkdfSha256.Perform(64, agreement, _chainKey);   // salt = current chainKey, ikm = DH result
  _nonce = 0; _chainKey = okm[0..32]; _cipherKey = okm[32..64];
  ```
- `getNoiseCipher()`: at handshake end, `HkdfSha256.Perform(64, Array.Empty<byte>(), _chainKey)` is split into a `Pair<byte[],byte[]>` = **(writeKey, readKey)**, each 32 bytes (`HC:93-101`). `SocketAdapter` uses `pair.First` for the `StanzaWriter` and `pair.Second` for the `EncryptedBytesReceiver` (`SocketAdapter.cs:73-82`).

**HKDF** is RFC-5869 over HMAC-SHA256 (`HkdfSha256.cs`, `Hkdf.cs`): `Extract` = `HMAC(salt || zeros, ikm)` (salt defaults to 32 zero bytes); `Expand` iterates `T(n) = HMAC(prk, T(n-1) || info || counter)` with a single-byte counter starting at 1 (`Hkdf.cs:15-44`). `HkdfSha256.Perform` plugs in `HMACSHA256` with a 32-byte hash length (`HkdfSha256.cs:7-16`).

**AEAD** (`AesGcmProvider.cs`) wraps WinRT `SymmetricKeyAlgorithmProvider` AES-GCM, **tag size 16** (`AGP:11`). `AesGcmEncrypt` appends the 16-byte tag after the ciphertext (`AGP:27-33`); `AesGcmDecrypt` splits the trailing 16-byte tag, calls `DecryptAndAuthenticate`, and **returns null on any auth failure** (the exception is swallowed) (`AGP:36-69`). It supports an optional `offset/length` to encrypt/decrypt a slice — used by the stanza writer (§3.8).

**Server-cert verification** (`WACertificateVerificationUtils.cs`): for WA version 6, `ValidateCertificate` parses a `CertChain` protobuf and validates `Intermediate` then `Leaf` against a pinned root (`WACVU:67-86, 117-150`). The pinned root is the constant `WhatsAppLongTerm1`, serial `0`, with a hardcoded 32-byte Curve25519 public key (`WACVU:51-65`). Each level checks issuer-serial match, optional NotBefore/NotAfter (the WA6 path passes `now = null`, so time is **not** checked — `VerifyTimeForWA6 = false`, `WACVU:55, 85`), and a Curve25519 signature via `Curve22519Extensions.Verify` (`WACVU:152-186`). Finally the leaf's key must `SequenceEqual` the handshake `server.hello.static` — this binds the cert chain to the actual Noise peer (`WACVU:144-148`). A bad chain makes `HandshakeHandler` throw "Untrusted server cert" and abort the connection.

---

### 3.8 Encrypted stanza loop: `StanzaWriter`, `EncryptedBytesReceiver`, `WAProtocol`

Once `TryHandshake` succeeds, `SocketAdapter.ProcessFrame` builds the post-login pipe (`SocketAdapter.cs:71-83`):

```csharp
Pair<byte[],byte[]> pair = _handshake.GenerateKeys();
StanzaWriter writer = new StanzaWriter(_adaptee, pair.First);       // write key
WAProtocol p = new WAProtocol(false, _attempt, _requestsTracker, writer, this, _connectInPullMode);
p.LoggedIn += () => {
    _stateSubject.OnNext(Connected);
    _adaptee.SetTimeout((int)Constants.ForegroundPingTimeout.TotalMilliseconds, false);  // 100s
    LoggedIn?.Invoke(this, writer);
};
_reader = new EncryptedBytesReceiver(pair.Second, p);              // read key
```

From then on, `ProcessFrame` routes every frame to `_reader.ReceiveFrame`; a `LoginFailureException` thrown out of it is surfaced via the `LoginFailed` event (`SocketAdapter.cs:58-69`).

**Send path** (`StanzaWriter.cs`). `StanzaWriter` implements both `IConnectionOutput` (the app's "write a node" surface) and `BinTreeNodeWriter.ITarget` (`SW:8`). `Write(node, compress)` delegates to `BinTreeNodeWriter.Write` (FunXMPP token serialization), which calls back into `WriteStanza(stanzaStream, useCompression)` (`SW:25-35`):

- If compression is requested and the stanza fits, it Deflates into a buffer **prefixed with byte `2`** (`SW:46-49`); if the compressed form isn't smaller, it falls back to the uncompressed buffer **prefixed with byte `0`** (`SW:61-66`). So the leading flag byte: `0x02` = compressed, `0x00` = plain (matches `WAProtocol.FlagCompressed = 2`, `WAProtocol.cs:11`).
- Guards `num >= 33554432` (32 MiB) → `IOException("Buffer too large")` (`SW:67-69`).
- `WriteEncrypted` AES-GCM-encrypts the framed buffer with `_writeKey`, a 12-byte big-endian **incrementing nonce** `_writeNonce++`, and **no AAD**, then hands it to `FramesWriter.WriteFrameInternal` (`SW:74-78`):
  ```csharp
  frame = AesGcmProvider.AesGcmEncrypt(_writeKey, WAProtocol.LongToByteArray(_writeNonce++, 12), null, frame, 0, streamLength);
  ```

> Contrast with the **handshake** payload crypto (§3.7), which *does* use the transcript hash as AAD. Transport frames use **null AAD** and rely purely on the per-frame nonce counter.

**Receive path** (`EncryptedBytesReceiver.cs`). `ReceiveFrame(input, offset, length)` (`EBR:24-47`):

1. `AesGcmDecrypt(_readKey, LongToByteArray(_readNonce++, 12), null, input, offset, length)`. Null → `FailuresService.Investigate("Failed to decrypt AES GCM frame")` and return (`EBR:26-31`).
2. Inflate if `(array[0] & 2) != 0` (zlib via `InflaterInputStream`), else treat `array[1..]` as the raw stanza (`EBR:32-45`). The first byte is the same compression flag the writer set.
3. `ParseTreeNode` → `ProtocolTreeNode`, then `_protocol.ProcessStanza(node, size)` (`EBR:46-47`).

**Write/read nonces are independent counters** starting at 0, one per direction, and never reset post-handshake.

**Protocol dispatch** (`WAProtocol.cs`). `ProcessStanza` is a 3-way router on connection state (`WAP:34-51`):

```
_isCompanionRegistration → ProcessMultiDeviceRegistrationNode  (throws NotImplementedException — WAP:189-192)
_isLoggedIn              → ProcessLoginStateStanza
else                     → ProcessAuthenticationNode
```

- **`ProcessAuthenticationNode`** (`WAP:84-140`): on `success` it reads attr `t` as server time, sets `_isLoggedIn = true`, `ClocksMonitor.Instance.SaveServerTime(t)`, fires `LoggedIn` (`WAP:86-92`). On `failure` it parses `reason`/`code`/`expire`/`retry` into a `LoginFailureException` and throws it (`WAP:95-138`). See §3.9.
- **`ProcessLoginStateStanza`** (`WAP:142-156`): if the node is `iq` → `ProcessIq`; **anything else** (`message`/`receipt`/`notification`/`presence`/`chatstate`) is logged as `"Unrecognized top-level stanza [<tag>]"` and dropped. A null node throws `StreamEndException("Got stream end")`. **This is the key boundary: the native transport natively handles only `iq` post-login; all rich stanza types are handled by the WebView2 JS bundle** (which receives raw decoded WAP via the bridge, not through this method).
- **`ProcessIq`** (`WAP:158-187`): read `id`/`type`/`from`. Missing `type` → `CorruptStreamException`. `type == "result"` → `PopIqHandler(id)?.Parse(node, from)`; `type == "error"` → `PopIqHandler(id)?.ErrorNode(node)`; unknown type logged.

**IQ correlation** (`IqRequestsTracker.cs`). `MakeId(prefix)` returns a thread-safe `Interlocked`-incremented ticket as uppercase hex (`num.ToString("X")`), or `prefix+num` when `IsVerboseId` (`IqRT:35-43`). Handlers live in a lock-guarded `Dictionary<string, IqResultHandler>`; `PopIqHandler` removes-and-returns (one-shot correlation), so duplicate/unmatched results are silently ignored (`IqRT:27-55`).

**`Connection` facade** (`Connection.cs`): `IConnection` wraps the `IConnectionOutput` (the `StanzaWriter`) plus the `IqRequestsTracker`, exposing `Write`/`WriteTreeNodesEnd`/`AddIqHandler`/`MakeId` (`Connection.cs:6-37`; interfaces at `IConnection.cs`, `IConnectionOutput.cs`). This is the object `ConnectionManager` publishes on `WhenConnectionChanged` after login.

---

### 3.9 Login success / failure / ban handling

`WAProtocol.ProcessAuthenticationNode` failure parsing (`WAP:95-138`):

1. Read `expire`, `code`, `reason`. Parse `reason` as int; if it's a defined `LoginFailedReason`, use it; else if `> 500`, treat as `ServerBackoffRequest` (`WAP:106-116`).
2. Build `LoginFailureException(reason)`.
3. If `TempBanned`: require both a `code` and a positive `expire`; set `BanReason = code`, `FailedLoginReason = reason`, `BanExpirationUtc = FunRunner.CurrentServerTimeUtc.AddSeconds(expire)`, `BanTotalSeconds = expire`, and optional `RetryUtc` from `retry` seconds (`WAP:118-132`). If the ban fields are malformed, downgrade `Type` to `GenericFailure` (`WAP:133-136`).
4. `throw ex`.

`LoginFailedReason` enum maps to HTTP-ish codes (`LoginFailedReason.cs`): `GenericFailure=400, NotAuthorized=401, TempBanned=402, Locked=403, ClientTooOld=405, Banned=406, BadUserAgent=409, ServerError=500, Experimental=501, ServerBackoffRequest=503`.

The exception propagates: `EncryptedBytesReceiver.ReceiveFrame` → `SocketAdapter.ProcessFrame` catches `LoginFailureException` and raises `LoginFailed` → `ConnectionManager.OnLoginException` (`SocketAdapter.cs:65-68`, `CM:229-241`). `ConnectionManager.IsRejectedByServer()` makes the next `IsCanceled()` return true for `{NotAuthorized, TempBanned, Locked, ClientTooOld, Banned, BadUserAgent}` — i.e. these hard rejections **stop the reconnect loop** rather than retrying forever (`CM:201-215`).

---

### 3.10 Reconnection backoff, host selection, keepalive

**Backoff** (`ConnectionBackoffModel.cs` + `FibonacciFunction.cs`). State is a single `WaitCounter` in `IStorage` (`ConnectionManager.BackoffStorage`, `CM:18-21`). `Increment()` computes `wait = min(Fibonacci(++WaitCounter + 1), 3600) × jitter`, where `jitter = rand()/2 + 0.75` ∈ [0.75, 1.25), and starts a timer (`CBM:87-94`). `GetBackoffTime(isBackground)` returns the timer's *remaining* time; **in background it's clamped to 4 s** (`CBM:66-80`). `HandleLogin()` resets `WaitCounter = 0` and clears the timer (`CBM:96-100`); `HandleBackoffRequest()`/`Handle5xxError()` just `Increment` (`CBM:61-85`). The Fibonacci table is precomputed (47 entries, `1,1,2,3,5,8,…`), saturating at the last value for large iterations (`FibonacciFunction.cs:7-27`). On the **first** connect, `_currentBackoff` is null so `GetBackoffTime` returns `default(TimeSpan)` = 0 (no wait) (`CBM:66-72`).

**Host selection.** `ConnectionManager` uses `IpProvider` (`CM:25, 134`), not `HostSelection`. `HostSelection` is an alternate `IIpProvider` present in `WhatsApp.Networking` (ctor at `HostSelection.cs:23`) but it is **dead/unwired code in this build**: a whole-tree grep for `new HostSelection(` returns zero call sites in any assembly (chat, VoIP, or media); the only other `HostSelection` substrings are the unrelated MMS AB-prop bitmask `Mms4Config.IsHostSelectionFlagSet` / `WinMmsHostSelectionMethod`, not this class. So the chat path resolves through `IpProvider` exclusively. `IpProvider` builds a fixed list of (resolver, isIp6, hostType) adapters (`IpProvider.cs:82-95`):

```
SystemResolver  → g.whatsapp.net            (IPv6, IPv4)
SystemResolver  → g-fallback.whatsapp.net   (IPv6, IPv4)
HardcodedResolver → "HardcodedList" = g.whatsapp.net   (IPv6, IPv4)
HardcodedResolver → "ExWhatsappNet" = e{1..16}.whatsapp.net   (IPv6, IPv4)
SystemResolver  → "ExWhatsappNet" = e{1..16}.whatsapp.net     (IPv6, IPv4)
```

The host for each type is computed in `Adapter.GetHost()` (`IpProvider.cs:52-73`): `GWhatsappNet → "g.whatsapp.net"`, `GFallbackWhatsappNet → "g-fallback.whatsapp.net"`, `HardcodedList → "g.whatsapp.net"`, `ExWhatsappNet → "e{Random(1..16)}.whatsapp.net"`.

> **Anchor correction:** the chat-connection bootstrap host is **`g.whatsapp.net`** (plus `g-fallback` and `e1..e16.whatsapp.net`), *not* `s.whatsapp.net`. `s.whatsapp.net` is the protocol **JID domain** used in stanzas (e.g. the ping IQ's `to`, `ClientRequest.cs:17`; primary dictionary token 3) — it is the logical server identity, while `g.whatsapp.net` is the DNS name the socket actually dials. This is confirmed: `ConnectionManager` resolves via `IpProvider`, which only ever returns `g.*`/`e*.whatsapp.net` IPs.

`IpProvider.GetNext()` round-robins the adapter list, *pinning* the last successfully-connected adapter (`_connectedResolver`) so the next connect re-tries the known-good host first; it recurses until an adapter yields a non-null IP (`IpProvider.cs:97-116`). `MarkIPAddressAsConnected()` sets `_connectedResolver = _lastResolver` and is called from `ConnectionManager.OnLoggedIn` (`IpProvider.cs:118-121`, `CM:176`).

**Resolver chain.** Each `SystemResolver` does `Dns.GetHostAddressesAsync` (`SystemResolver.cs:9-24`); `HardcodedResolver` reads `IpList.Instance.GetHostsByName(host)` (a baked-in IP list) (`HardcodedResolver.cs:10-15`). `ChainResolver` short-circuits literal IPs to a single `Hardcoded` result and otherwise tries sources in order, swallowing per-source exceptions (`ChainResolver.cs:17-42`). `ResolverExtensions.SelectIp` **shuffles** the candidate list then picks one IPv4 + one IPv6 for happy-eyeballs-style dialing (`ResolverExtensions.cs:23-41`); `TryResolve` returns `Array.Empty` on failure (`ResolverExtensions.cs:11-21`). `ResolveResult` carries `IpAddress`, `LoginDnsResolverType`, `LoginHostType`, `Ttl` (`ResolveResult.cs`).

**Network reachability.** `NetworkStateMonitor` (singleton) subscribes to `NetworkInformation.NetworkStatusChanged` and recomputes a `NetworkState` (Wi-Fi/cellular/2G/3G+, IPv4/IPv6 connected, SSID/MNC change) (`NetworkStateMonitor.cs:191-204, 286-379`). It exposes `WhenNetworkStateChanged` (DistinctUntilChanged) consumed by `ConnectionManager.Start()` and `State.IsDataConnected` checked in `RenewState` (`NetworkStateMonitor.cs:175-189`). A `Watchdog` periodically reconciles cached vs. live connectivity and force-updates the cached state on a mismatch (`NetworkStateMonitor.cs:25-153`). The `NetworkStateChange` flags enum: `DataNetworkChanged=1, WifiNetworkChanged=2, CellularInternetConnected=4, WifiInternetConnected=8, IPv4Connected=0x10, IPv6Connected=0x20` (`NetworkStateChange.cs`).

**Keepalive / liveness.** There is **no explicit native heartbeat timer**. Liveness is enforced purely by **socket read timeouts** (`SystemSocket.ReadData`, §3.3):

- During handshake/login: `LoginTimeout = 30 s`, set in `CreateSocket` (`CM:224`, `Constants.cs:198`).
- After login: `SocketAdapter`'s `LoggedIn` handler re-arms `ForegroundPingTimeout = 100 s` (`SocketAdapter.cs:79`, `Constants.cs:200`).

If no bytes arrive within the active timeout, the linked CTS cancels the in-flight `ReadAsync`, the read loop throws, `SystemSocket` disposes and raises `StateChanged(false)` → `SocketAdapter` reports `Disconnected` → `ConnectionManager` reconnects in 1 s (`CM:153-159`). The actual **ping IQ** that produces server traffic to satisfy this timeout is the Smax-generated `Pings.Outgoing.ClientRequest` — `<iq id=.. type="get" xmlns="w:p" to="s.whatsapp.net"/>` (`ClientRequest.cs:13-18`) — with response parsed by `Pings.Incoming.ClientResponseServerResponse` (correlating `id` against the request and reading server time `t`, `ClientResponseServerResponse.cs:30-57`). **These two generated classes are referenced nowhere else in the C# assemblies** (grep confirms only self-references), which means the ping IQ is **scheduled/sent from the WebView2 JS bundle**, not from native C#. The native side only provides the builder/parser and the read-timeout enforcement. *(This is the documented native↔JS split for `w:p`.)*

The JS ping scheduler is now confirmed in the bundle (`waweb-source-bundle/n6o0-NaJTww.js`): a `WAShiftTimer` `healthCheckTimer` fires `sendPing()`, re-armed by `maybeScheduleHealthCheck()` only when there is no in-flight ping/ack/IQ; the delay is `Math.ceil(config.healthCheckInterval * 1000 * (1 + Math.random()))` ms. The default `healthCheckInterval` is **15 s** (`bundle TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js`), so each ping is scheduled ~15–30 s out — comfortably under the native 100 s read timeout. The interval is also **server-tunable**: a `WFPingResponseSuccess` carries `pingIntervalElementValue`, which `updatePingInterval` persists into `WAWebAccountLinkingSchema` (`bundle SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js`). After a ping is sent, a separate `deadSocketTimer` arms `config.deadSocketTime = 20000 ms` (`bundle TSxMupG…js`) as the response deadline.

**Server-time / clock skew.** `ClocksMonitor` stores the local↔server time delta on each `success` (attr `t`) and ping response (`ClocksMonitor.cs:37-53`); `CurrentServerTimeUtc = UtcNow - LastLocalServerTimeDiff` (`ClocksMonitor.cs:13`). On `Disconnected`, `ConnectionManager` calls `SaveServerTime(null)`, clearing `CurrentTimeSkew` (`CM:157`, `ClocksMonitor.cs:37-44`). Ban-expiry math (§3.9) uses this skew-corrected server clock.

---

## 4. Native Dependencies

| Capability | Native surface | Confirmed? |
|---|---|---|
| Curve25519 keygen / X25519 ECDH / XEdDSA sign+verify | `WhatsAppNative.Curve25519` via `Curve22519Extensions` (`Curve22519Extensions.cs:6-49`). `GenKeyPair(pub,priv)` sizes both buffers to `Instance.GetKeyLength()`; `Derive(pub,priv)` is the DH used in every handshake `setKey`; `Sign`/`Verify` back ADV device-identity and cert-chain validation. | **Confirmed** that the managed handshake calls these; the math itself is in `WhatsAppNative.dll` (C++/Rust). **Scheme native-confirmed via radare2** (doc 96): the X25519 Montgomery-ladder constant `a24 = 121665` (`0x0001DB41`) and SHA-512 (`K[0]=0x428a2f98d728ae22`) are statically present, and the binary exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}` — so X25519 ECDH + XEdDSA signing is byte-evidenced, not merely inferred by interop. Sizes (32-byte key / 64-byte sig) corroborate (cross-reference: whatsmeow `util/keys/keypair.go:48-55` + `pair.go:265,278,284`; Baileys `Utils/crypto.ts:27,30`; both use the libsignal `DjbType=0x05` Curve25519 primitive, so `@signalapp/libsignal-client` is bit-compatible). Only the instruction-level `Sign` body (clamping / XEdDSA nonce) is unread, and that residual is **MOOT for the port**. |
| AES-GCM (handshake payload + transport frames) | WinRT `Windows.Security.Cryptography.Core.SymmetricKeyAlgorithmProvider` (AesGcm) via `AesGcmProvider` (`AesGcmProvider.cs:15, 40`). | **Confirmed** — OS WinRT crypto, not WhatsAppNative. |
| SHA-256 transcript hash | WinRT `CryptographicHash` via `Utils.CreateSha256Hash` (`HandshakeHash.cs:24`). | **Confirmed** — OS WinRT. |
| HMAC-SHA256 / HKDF | .NET BCL `System.Security.Cryptography.HMACSHA256` (`HkdfSha256.cs:14`); HKDF hand-rolled in managed `Hkdf` (`Hkdf.cs`). | **Confirmed** — managed. |
| TCP socket | WinRT `Windows.Networking.Sockets.StreamSocket` (`SystemSocket.cs:16`). | **Confirmed** — OS WinRT. |
| DNS | .NET `System.Net.Dns.GetHostAddressesAsync` (`SystemResolver.cs:11`) + baked-in `IpList` for hardcoded fallback. | **Confirmed** — managed/OS. |
| Network reachability | WinRT `Windows.Networking.Connectivity.NetworkInformation` (`NetworkStateMonitor.cs:197, 584`). | **Confirmed** — OS WinRT. |
| Deflate/Inflate | `ICSharpCode.SharpZipLib` (`StanzaWriter.cs:2`, `EncryptedBytesReceiver.cs:2`). | **Confirmed** — managed library. |
| Cert-chain / ClientPayload / HandshakeMessage protobufs | `WhatsApp.Protobuf` (`HandshakeMessage.cs`, `CertChain`, `ClientPayload`). | **Confirmed** present; SilentOrbit-style generated parsers. |
| Persistent session state (server static key, last-good port, server-time diff) | `SeamlessMigrationAppSessionStorage.Instance` (`HH:198`, `CM:179`, `ClocksMonitor.cs:48-50`). | **Confirmed** referenced; storage internals out of scope. |

**Ghidra status:** `ghidra-output/WhatsAppNative-functions.txt` is empty and `WhatsAppRust-functions.txt` only contains a PyGhidra error, so the *instruction-level* C++/Rust bodies of Curve25519 etc. were not read via Ghidra. This is **no longer the binding blocker for the scheme**: a separate radare2 pass (doc 96) statically byte-evidenced the X25519 + XEdDSA scheme — the Montgomery-ladder constant `a24 = 121665` (`0x0001DB41`) and SHA-512 (`K[0]=0x428a2f98d728ae22`) are present and the class exposes `Curve25519::{Derive,Sign,Verify,GenKeyPair}` (doc 96). So the signature **scheme** is **native-confirmed as Curve25519 (X25519 ECDH + XEdDSA), 64-byte**, not merely RESOLVED-via-interop. The *contracts* are fully pinned by the managed callers above, and the Noise protocol name `..._25519_AESGCM_SHA256` plus the 32-byte key / 64-byte signature sizes further corroborate. Only the *exact native byte layout* (clamping, XEdDSA nonce/hash-to-point) of the `Sign` body remains unread (it lives behind the WinRT activation-factory vtable, so r2 autoanalysis cannot name it), and that residual is **MOOT for the port** — `@signalapp/libsignal-client` is bit-compatible.

**Native-binary re-examination of `WhatsAppNative.dll` this session** [native-binary] adds three concrete facts that *locate* the curve code without yet reading its inner loop:
- The methods are confirmed as named symbols `WhatsAppNative::Curve25519::Sign` and `WhatsAppNative::Curve25519::GenKeyPair`, alongside the WinRT class metadata `Curve25519@WhatsAppNative`, `__Curve25519ActivationFactory`, `__ICurve25519PublicNonVirtuals` (`strings WhatsAppNative.dll`). The PE export table exposes **only the two standard in-proc-server entries `DllCanUnloadNow` + `DllGetActivationFactory`** (`objdump -p` / `rabin2 -E`, independently re-confirmed this session) — the six Curve25519 ops (`GenKeyPair`/`Derive`/`Sign`/`Verify`/`GetKeyLength`/`GetSignLength`, per the `__ICurve25519PublicNonVirtuals` vtable in `WhatsAppNativeProjection/WhatsAppNative/__ICurve25519PublicNonVirtuals.cs:12-22`) are NOT exported and are reachable only through the COM/WinRT activation-factory vtable — which is why r2 autoanalysis cannot auto-name the `Sign` body. The empty Ghidra dump blocks only the *inner-loop byte layout*, not the scheme: radare2 already statically byte-evidenced the X25519 + XEdDSA scheme via the `a24=121665` ladder constant and SHA-512 (doc 96), and that inner-loop residual is MOOT for the port.
- A **native Curve25519 implementation is statically compiled in**: the Montgomery-ladder constant **a24 = 121665** (`0x1DB41`) is present at file offset `0x7b0628` as the little-endian bytes `41 DB 01 00` (the X25519 scalar-mult constant; re-confirmed this session by byte-offset search), and the binary embeds the WebRTC C++ tree (**125 mangled `…@webrtc@@` symbols, 426 total `webrtc` string hits**). There is **no BoringSSL/fiat/libsignal/`xeddsa`/`ed25519`/`x25519` string marker** anywhere in the binary, consistent with a stripped, statically-linked field-arithmetic implementation (limb-packed constants, so the raw 32-byte field prime / group order / Ed25519 basepoint do not appear as contiguous little-endian bytes — searched, all absent).
- `bcrypt.dll` imports are **RNG-only** (`BCryptGenRandom`, `BCryptOpen/CloseAlgorithmProvider`; no `BCryptEncrypt`/`BCryptHashData`/`BCryptDeriveKeyPBKDF2`), so the curve math is *not* delegated to Windows CNG — it is in the statically-linked native code. (`WhatsAppRust.dll` is the wamedia codec library — mp4/jpeg/webp/h264 — and contains no curve crypto; it imports only `ProcessPrng` for RNG.)

So the curve code is *pinpointed to statically-linked native arithmetic in `WhatsAppNative.dll`*, with the **X25519 + XEdDSA scheme native-confirmed** by the `a24=121665` ladder constant and SHA-512 (doc 96); only the byte-level `Sign` inner loop remains unread here, and that residual is MOOT for the port.

---

## 5. Linux / Electron Port Mapping

The native transport stack maps cleanly onto Node — almost everything here is "buffers, sockets, and crypto," with no UWP-specific business logic except the WinRT plumbing classes. Recommended mapping:

| Windows piece | Linux/Electron/Node equivalent | Notes / risk |
|---|---|---|
| `ConnectionManager` state machine, attempt/cancel model | Port as a TS class; replace `Interlocked` with a plain monotonic counter (Node is single-threaded) and `CompositeDisposable` with explicit unsubscribe/AbortController. | Low risk; the logic is straightforward. RxJS can replace the `System.Reactive` `Subject`/`Throttle`/`DistinctUntilChanged` 1:1. |
| `SystemSocket` (WinRT StreamSocket) | `node:net` `Socket` (or `node:tls` if you choose to also TLS-wrap, which WA does **not**). | Use `socket.setTimeout(ms)` for the read-idle timeout to replicate the `CancelAfter` semantics; `'timeout'` → destroy → reconnect. The early-send buffer is just a queue you flush on `'connect'`. |
| `ChunkedHttpSocket` (port-80 tunnel) | Hand-roll the same chunked framing over a `net.Socket`, or skip initially (443 covers ~all networks). | Medium effort; only needed for restrictive proxies. The wire format is fully specified in §3.4 and is trivial to reproduce. |
| `IpProvider` / resolvers / `ChainResolver` / happy-eyeballs `SelectIp` | `node:dns` `resolve4`/`resolve6` (or `dns.lookup`), plus a static fallback IP list. Node 20+ `net.connect` has `autoSelectFamily` (built-in happy-eyeballs). | Reuse hostnames `g.whatsapp.net`, `g-fallback.whatsapp.net`, `e1..e16.whatsapp.net`. The shuffle+one-v4/one-v6 pick is easy to port. |
| Frame layer (`FramesReader`/`FramesWriter`, 3-byte BE length) | A tiny length-prefix framer over the socket stream (e.g. a transform that accumulates until `(b0<<16)|(b1<<8)|b2` bytes are present). | Trivial; identical wire format. |
| Noise XX/IK/XXfallback (`HandshakeHandler`/`HandshakeCipher`/`HandshakeHash`) | `@noble/curves` (`x25519`) + `@noble/hashes` (`sha256`, `hkdf`, `hmac`) + Node `crypto.createCipheriv('aes-256-gcm')`. Or a Noise lib (`noise-c.wasm`, `@chainsafe/libp2p-noise` patterns) — but WA's variant has custom transcript/AAD rules, so a from-scratch port following §3.6–3.7 is safer. | **Highest-care area.** Replicate exactly: transcript `h = SHA256(h‖data)` seeded with the protocol-name bytes; mix the `WA 0x06 dictVer` header; AAD = transcript hash for handshake payloads but **null** for transport frames; 12-byte **big-endian** nonces; HKDF split `okm[0..32]=chainKey`, `okm[32..64]=cipherKey`; final `getNoiseCipher` = HKDF(empty, chainKey) → (writeKey, readKey). Off-by-one on nonce direction or AAD = silent decrypt failures. |
| AES-GCM tag handling | Node GCM: tag is separate (`cipher.getAuthTag()`), not appended — but WA **appends** the 16-byte tag to ciphertext. So on encrypt, concatenate `ct‖tag`; on decrypt, slice the last 16 bytes as the tag before `decipher.setAuthTag`. | Easy but must match the append/split convention (§3.7). |
| XEdDSA cert-chain verify (`WACertificateVerificationUtils`) | `@noble/curves` Curve25519 verify against the **pinned root key** (32 bytes, §3.7). Parse `CertChain` protobuf with `protobufjs`/`ts-proto`. | Port the pinned key `14 23 75 57 …` verbatim. Note WA6 skips time validity (`now=null`) and binds leaf-key == handshake static. |
| Curve25519 keygen/ECDH | `@noble/curves` `x25519.utils.randomPrivateKey()` / `x25519.getSharedSecret()`. | Direct replacement for `WhatsAppNative.Curve25519`. |
| `ClientPayload` / `HandshakeMessage` protobufs | `protobufjs` or `ts-proto` against the WA `.proto` (reconstructable from `WhatsApp.Protobuf`). | Fill `UserAgent.platform`, version, locale, device fields. Server may reject implausible UA values, so mirror real Windows values or a sanctioned platform. |
| Backoff (`ConnectionBackoffModel`/`FibonacciFunction`) | Plain TS: same Fibonacci table, `min(fib(n+1), 3600) × (0.75 + rand()*0.5)`. | Trivial, keep identical so server-side rate limits aren't tripped. |
| `NetworkStateMonitor` reachability | Electron `net.isOnline()` / `powerMonitor` / `navigator.onLine` in renderer, or D-Bus NetworkManager (`org.freedesktop.NetworkManager`) for richer state. | Medium; you mainly need an "is data connected" boolean and a change event to drive the 2 s-throttled reconnect. |
| `ClocksMonitor` server-time skew | Plain TS storing `localMinusServer`; persist alongside session. | Trivial. |
| `WAProtocol` dispatch + `IqRequestsTracker` | Plain TS map of `id → handler`, hex ticket ids. | Trivial. |
| FunXMPP token dictionary / BinTree | Port `WAPDefaultTokenDictionary` + reader/writer (separate doc). | Required for both directions; the dictionary version byte goes in the WA header. |

**Reuse from the waweb JS bundle.** The `decompiled_source/waweb-source-bundle/` already contains a full WhatsApp-Web Noise + FunXMPP implementation (it talks the same `web.whatsapp.com` protocol). For a Linux port the **lowest-risk path is to reuse the bundle's transport** (it already does Noise XX, FunXMPP framing, ping scheduling, and all the rich-stanza handling that this native layer *delegates* to JS) and supply Node-native shims only where the bundle expects host objects (SQLite, media, etc.). The native C# transport documented here is essentially a re-implementation of what the JS bundle does for plain WhatsApp Web; on Linux you likely do **not** re-implement it in Node at all — you let the bundle's own transport run and only replace the WinRT bridges. The from-scratch Node port above is the fallback if you want a headless (no-WebView) client.

**Gaps / risks:**

- **Ping scheduling lives in JS**, not in the native transport — a headless Node port must add its own `w:p` ping loop (build `<iq xmlns="w:p" to="s.whatsapp.net" type="get">` every <100 s) or the read-timeout will kill the socket.
- **Rich stanzas** (`message`/`receipt`/`notification`/`presence`) are *not* handled by this native layer at all — they go to JS. A headless port must implement them (this is the bulk of the work and lives outside this transport doc).
- **Hardcoded fallback IPs** (`IpList`) weren't read; a port should ship its own current fallback IP set or rely on DNS only.
- **Edge-routing header** (`ED\0\x01` + blob) is optional but server-influenced; safe to omit unless the server hands you `edgeRoutingInfo`.

---

## 6. Open Questions / Unverified

> Each item below was re-investigated this pass against the decompiled C# (`decompiled/`), the WhatsApp-Web JS bundle (`waweb-source-bundle/`), and the shipped native binaries (`x64/*.dll` via `strings`/`objdump`). Every item now carries a bold verdict tag — **[RESOLVED]** / **[PARTIAL]** / **[CANNOT RESOLVE STATICALLY]** — followed by the concrete finding and its citation. The original question text is preserved.

1. **WA header dictionary-version byte.** *Original Q:* `HandshakeHandler` writes `FunXMPP.Dictionary.GetDictionaryVersion()` as header byte 3 (`HH:48-49`, `TokenDictionary.cs:107-110`), but the concrete integer comes from `WAPDefaultTokenDictionary.DictionaryVersion`, which was not read here. **Unverified numeric value.**
   **[RESOLVED]** The value is **`3`**. `TokenDictionary.GetDictionaryVersion()` returns `_dictionaryVersion`, set from `dict.DictionaryVersion` in the ctor (`TokenDictionary.cs:31`), and `WAPDefaultTokenDictionary.DictionaryVersion => 3` (`WAPDefaultTokenDictionary.cs:163`). So the full 4-byte on-wire WA header is `0x57 0x41 0x06 0x03` (`"WA"`, proto v6, dict v3). Folded into §3.6.

2. **`HostSelection` vs `IpProvider`.** *Original Q:* `ConnectionManager` uses `IpProvider` (`CM:25`); `HostSelection` is an alternate `IIpProvider` in `WhatsApp.Networking` with the same shape. Whether anything in the native app wires `HostSelection` into a different connection path (e.g. VoIP or media) was **not confirmed**.
   **[RESOLVED]** `HostSelection` is **dead/unwired code** in this build. A whole-tree grep for `new HostSelection(` returns **only its own ctor definition** (`HostSelection.cs:23`) — zero call sites in any assembly (chat, VoIP, or media). The `HostSelection` substring elsewhere (`Mms4Config.cs:27`, `AbPropsValues.cs:3704` `WinMmsHostSelectionMethod`) is an unrelated MMS AB-prop integer-flag bitmask, not this class. The chat path uses `IpProvider` exclusively (`CM:25,134`); nothing instantiates the `HostSelection` `IIpProvider`.

3. **`edgeRoutingInfo` provenance.** *Original Q:* Where the `ED\0\x01`-framed edge-routing blob originates (a prior login response? a server hint persisted to storage?) was not traced; `ConnectionManager` receives it as a ctor arg from an un-read caller.
   **[RESOLVED]** (both read and write sides now pinned). **Read side** [decompiled-C#]: `SeamlessMigrationManager.GetUserCredentialsForConnection` **reads the blob from the settings SQLite DB at key 163** — `settingsDb.TryGetSetting<byte[]>(163L, out edgeRoutingInfo)` (`SeamlessMigrationManager.cs:519`) — and passes it to `new ConnectionManager(..., edgeRoutingInfo, ...)` (`SeamlessMigrationManager.cs:563`), which forwards it to `HandshakeHandler` (`ConnectionManager.cs:16,225`). The native C# only *consumes* key 163. **Write side now confirmed in the JS bundle** [bundle]: the server emits an info-bulletin `<ib>` stanza with an `<edge_routing>` child; the bundle's info-bulletin parser extracts `a.child("routing_info").contentBytes()` (and an optional `dns_domain`) (`waweb-unmin/b1yokgAMCB8V63CR_FA-OVE0xyAFeA8F3SvySJLzxwIigwK2MI-Vq34Oq07nzPieyNlZFruYjDNhl3RM.js:45838-45843`), then `handleRoutingInfo` persists it via `WAWebUserPrefsMultiDevice.setRoutingInfo({domain, edgeRouting})` (`b1yokgAMCB8V...js:45764-45771`); the `setRoutingInfo`/`getRoutingInfo`/`WARoutingInfo` store and base64 (`edgeRouting`) (de)serialization are in `n6o0-NaJTww.js:13946,19670-19731,27104`. The settings-DB user-prefs store that JS writes is the same shared DB the native side reads at key 163. **Cross-reference confirms the exact same round-trip** [protocol-cross-ref]: Baileys' `CB:ib,,edge_routing` handler reads `edge_routing > routing_info` content into `creds.routingInfo` (`Baileys/src/Socket/socket.ts:1015-1021`) and replays it as the `ED`-prefixed Noise intro header on the next connect (`socket.ts:122-123`, `Utils/noise-handler.ts:80-88`) — byte-for-byte the same `ED\0\x01`+`len`+blob prologue the native `HandshakeHandler.WriteInitialStanza` emits. The `edge_routing`/`routing_info` FunXMPP tokens are present in both the native dictionary (`WAPDefaultTokenDictionary.cs:10-11`) and the bundle token table (`n6o0-NaJTww.js:3732`). Full provenance: **server `<ib><edge_routing><routing_info>` → JS `setRoutingInfo` persists to shared settings DB (key 163) → native reads key 163 → native writes the edge-header prologue.** Folded into §3.6.

4. **Exact ping cadence and which JS module sends `w:p`.** *Original Q:* Confirmed the native C# never *sends* the ping (the generated `Pings` classes are self-referential only), so it is **inferred** to be JS-scheduled; the precise interval (must be < the 100 s read timeout) lives in the waweb bundle and was not read.
   **[RESOLVED]** The JS scheduler is `waweb-source-bundle/n6o0-NaJTww.js`: a `WAShiftTimer` `healthCheckTimer` invokes `sendPing()`, re-armed by `maybeScheduleHealthCheck()` only when no ping/ack/IQ is in flight, with delay `Math.ceil(config.healthCheckInterval * 1000 * (1 + Math.random()))` ms. Default `healthCheckInterval` = **15 s** (`bundle TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js`), giving a ~15–30 s jittered cadence — well under the 100 s native read timeout. The interval is **server-tunable**: a `WFPingResponseSuccess.pingIntervalElementValue` is persisted by `updatePingInterval` into `WAWebAccountLinkingSchema` (`bundle SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js`). A `deadSocketTimer` of `deadSocketTime = 20000 ms` (`bundle TSxMupG…js`) bounds the ping response. Folded into §3.10. (Bundle is minified, so the precise stanza-emit byte path is read as string/identifier shape, not full control flow — but the cadence constant and scheduler module are pinned.)

5. **`ChunkedHttpSocket` `Host`/`User-Agent` constants.** *Original Q:* The literal `Host: c.whatsapp.net` and `WAChat/1.2` UA (`CHS:214`) are baked-in and likely legacy; whether the port-80 path still works against current servers (and whether `c.whatsapp.net` resolves) is **unverified**.
   **[RESOLVED]** The "baked-in/legacy" half is confirmed: the entire request preamble is a single `static readonly string connectHeader = "POST /chat HTTP/1.1\r\nHost: c.whatsapp.net\r\nUser-Agent: Mozilla/5.0 (compatible; WAChat/1.2; ...)\r\nTransfer-Encoding: chunked\r\n\r\n"` (`ChunkedHttpSocket.cs:214`) — a constant, never recomputed from the live host. The hostname `c.whatsapp.net` appears **nowhere else**: not in `WhatsAppNative.dll`/`WhatsAppRust.dll` strings, and not in the JS bundle (the bundle's `*.whatsapp.net` hits are `static.whatsapp.net`, a substring false-positive). Since the socket dials a resolved chat-host IP and the `Host` header isn't used for TCP-to-IP routing, the string is cosmetic.
   **The live half is now resolved (round-2, live network this session):** `c.whatsapp.net` resolves to the **parked Fastly anycast IP `15.197.206.217`** (`getent hosts c.whatsapp.net`); a TCP connect to `15.197.206.217:80` *succeeds* at the Fastly edge, but sending the exact legacy `POST /chat … Transfer-Encoding: chunked` preamble followed by the `0\r\n\r\n` terminator returns **no response body at all** (the edge reads the request and closes without ever speaking the WA chunked-chat protocol). Port 443 on the same name serves a **mismatched parked certificate** (`subject=CN=TYZtMNRLBycKfIR.net`, `issuer=CN=CfvVnRYM7ESrW1o5d` — a junk Fastly cert, not WhatsApp's pinned chain). Contrast: the real chat bootstrap host `g.whatsapp.net` resolves to a genuine `*.whatsapp.net`/`chat.cdn.whatsapp.net` Meta IP. **Conclusion: the legacy port-80 `c.whatsapp.net` chat path is functionally dead server-side** — the name now points at a parked CDN that does not host the WA chat service. (This refines the round-1 "CANNOT/live-fact" residual and the round-2 brief's "TIMED OUT": the TCP handshake actually *completes* to the parked edge, but no WA service answers.) A port can **safely omit the port-80 `ChunkedHttpSocket` fallback entirely**; ports 443/5222 carry the live traffic, and the open WA-Web implementations (whatsmeow `socket/constants.go:21-23` `wss://web.whatsapp.com/ws/chat`; Baileys) do not implement any port-80 chunked path at all (cross-reference: whatsmeow/Baileys use only the WebSocket transport). Folded into §3.4.

6. **Native Curve25519 signature scheme.** *Original Q:* Assumed XEdDSA over Curve25519 (consistent with Signal and the Noise protocol name), but the `WhatsAppNative.dll` body is unreadable (empty Ghidra dumps), so the exact signature encoding is **inferred**.
   **[RESOLVED — native-confirmed]** (scheme) / **[PARTIAL — MOOT for port]** (exact native byte-impl/clamping). The **signature scheme is Curve25519 (X25519 ECDH + XEdDSA) producing a 64-byte signature** — and this is now **byte-evidenced in the native binary**, not merely inferred by interop. A radare2 pass (doc 96) found the X25519 Montgomery-ladder constant `a24 = 121665` (`0x0001DB41`) and SHA-512 (`K[0]=0x428a2f98d728ae22`) statically present, with the class exposing `Curve25519::{Derive,Sign,Verify,GenKeyPair}`. The open implementations corroborate the encoding, and `@signalapp/libsignal-client` is bit-compatible:
   - whatsmeow (cross-reference: `util/keys/keypair.go:48-55`, `pair.go:264-284`): peer/device/account signatures are computed with `ecc.CalculateSignature(ecc.NewDjbECPrivateKey(...), msg)` and verified with `ecc.VerifySignature(ecc.NewDjbECPublicKey(...), msg, sig)` from `go.mau.fi/libsignal/ecc` — i.e. **libsignal XEdDSA over a Curve25519 (`DjbType` = `0x05`) key**. `verifyAccountSignature` hard-asserts `len(AccountSignatureKey) == 32 && len(AccountSignature) == 64` (`pair.go:265`), pinning the **64-byte** signature and 32-byte key. Private keys are clamped the standard X25519 way: `priv[0] &= 248; priv[31] &= 127; priv[31] |= 64` (`keypair.go:34-36`).
   - Baileys (cross-reference: `Utils/crypto.ts:2,27,30`): `Curve.sign`/`Curve.verify` delegate to `libsignal/src/curve` `calculateSignature`/`verifySignature` over 33-byte version-prefixed (`0x05 ‖ pub32`) keys — the identical libsignal Curve25519 XEdDSA primitive.
   Since the native Windows client must interoperate with the **same servers and peers** (it shares the WA header, the `Noise_XX_25519_AESGCM_SHA256` name, and the `device-identity`/`signature` ADV stanza family — FunXMPP tokens present in both the bundle dict at `n6o0-NaJTww.js:3732` and whatsmeow `binary/token/token.go:9`), its `Curve25519.Sign`/`Verify` **must** be the same XEdDSA-over-Curve25519, 64-byte scheme. The interop necessity corroborates what the radare2 native evidence (doc 96) already byte-confirms, so the *scheme* is RESOLVED (native-confirmed), not merely interop-inferred.
   **Residual [PARTIAL] (native byte-impl only) — strengthened with fresh native evidence this session** [native-binary]: re-examination of `WhatsAppNative.dll` now pinpoints the curve code:
   - Named symbols `WhatsAppNative::Curve25519::Sign` and `::GenKeyPair` are present, plus the WinRT metadata `Curve25519@WhatsAppNative` / `__Curve25519ActivationFactory` / `__ICurve25519PublicNonVirtuals` (`strings WhatsAppNative.dll`, re-confirmed this session). The managed wrapper queries `GetSignLength()`/`GetKeyLength()` at runtime (`Curve22519Extensions.cs:16,18,22-23`) rather than hardcoding 64/32 — so the size constants live native-side.
   - A **native Curve25519 is statically linked in**: the X25519 Montgomery-ladder constant **a24 = 121665** (`0x0001DB41`) is present at file offset `0x7b0628`, and a separate radare2 pass also confirms SHA-512 (`K[0]=0x428a2f98d728ae22`) statically present (doc 96) — together these byte-evidence the **X25519 ECDH + XEdDSA scheme directly in the binary**. The binary statically embeds WebRTC (pervasive `…@webrtc@@` symbols). There is **no `xeddsa`/`ed25519`/`x25519`/`libsignal`/`boringssl`/`fiat` string** in the binary, and the raw 32-byte field prime (2^255-19), libsignal group order, and Ed25519 basepoint are all **absent as contiguous little-endian constants** (limb-packed field arithmetic, as expected for a stripped static build).
   - `bcrypt.dll` imports are **RNG-only** — re-confirmed this session via `objdump -p` to be exactly **`BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider`** and nothing else (no `BCryptEncrypt`/`BCryptHashData`/`BCryptDeriveKeyPBKDF2`), confirming the curve math is the statically-linked native code, not Windows CNG. `bcrypt.dll` is the only crypto DLL in the import table; the other dynamic deps are `WhatsAppRust.dll` (the wamedia codec lib, no curve crypto), `MFPlat.DLL`/`MFReadWrite.dll` (Media Foundation) and `WS2_32.dll` (native sockets present) (all `objdump -p WhatsAppNative.dll`).
   The radare2 evidence (doc 96) pins the **scheme**; what remains unread is only the *inner loop*. Proving the *exact native clamping (`priv[0]&=248; priv[31]&=127|=64`) and the XEdDSA nonce/hash-to-point byte layout match libsignal byte-for-byte* (vs. a re-implemented Ed25519) would still need PyGhidra/Capstone disassembly of the `Curve25519::Sign` body (reachable only via the WinRT vtable — the PE export table holds just the two in-proc-server entries `DllCanUnloadNow`/`DllGetActivationFactory`, re-confirmed this session) or test vectors against a live native signature. **Verdict stays [PARTIAL] for the byte-impl residual, but that residual is MOOT for the port** — `@signalapp/libsignal-client` is bit-compatible, so a Linux port reproduces the signatures regardless of the exact native inner loop. Folded into §4. (Scheme: native-confirmed; see doc 96.)

7. **`connectInPullMode` / `Pull` semantics.** *Original Q:* Set true throughout (`CM:124`, `HH:238`); the server-side meaning of the `Pull` ClientPayload flag (passive/pull-mode delivery) is **inferred**, not confirmed from code.
   **[PARTIAL]** `Pull` is pinned as a distinct protobuf field across all stacks: `ClientPayload.Pull` is a `bool?` at **field number 33** (varint) (`ClientPayload.cs:1886,2083-2087`) [decompiled-C#], separate from `Passive` (its own field, `ClientPayload.cs:1844`); the bundle proto spec lists `pull: [33, e.TYPES.BOOL]` (`waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:114969`) [bundle] and whatsmeow declares `Pull *bool ...varint,33` (`whatsmeow/proto/waWa6/WAWebProtobufsWa6.pb.go:1083`) [protocol-cross-ref].
   **This pass CORRECTS the round-2 "move as a pair" claim with direct bundle evidence.** The two flags are **independent**, and the per-client matrix is:
   - **Native** (`HandshakeHandler.BuildClientPayload`): `Passive=true, Pull=true` (`HandshakeHandler.cs:234,238`) [decompiled-C#].
   - **Baileys**: `generateLoginNode` sets `passive:true, pull:true`; `generateRegistrationNode` sets `passive:false, pull:false` (`Baileys/src/Utils/validate-connection.ts:78-79,142-143`) [protocol-cross-ref].
   - **WA-Web bundle (mainline login)**: builds the `ClientPayload` with `{passive:false, pull:true}` — `passive` and `pull` are adjacent fields read from one options object, both defaulting to `false` (`waweb-unmin/TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js:145721-145723`), and the connect callers pass `{passive:false, pull:true}` (`TSxMupG…js:146063-146065,146504-146506`), with one path passing `{passive:false, pull:false}` (`TSxMupG…js:146599-146600`) [bundle].
   So `Pull=true` is the common "real interactive client login" signal, but it is set **orthogonally to `Passive`**: the bundle's own login pairs `pull:true` with `passive:false`, disproving the earlier "both true together" generalization. `Passive` is then driven independently by a post-connect `<iq><passive/>` toggle — whatsmeow auto-issues `SetPassive(false)` after connecting (`whatsmeow/connectionevents.go:196-215`) [protocol-cross-ref]. (Note: the `passive: !0` occurrences in the bundle at e.g. `TSxMupG…js:82713` are an unrelated DOM `addEventListener` `{capture, passive}` options object, not the WA flag — verified before citing.)
   **Residual (still [PARTIAL]):** the precise **server-side delivery semantics** of `Pull` itself (what pull-mode changes on the server, and how it differs from `Passive`) are still nowhere in any client code — native, Baileys, whatsmeow, and the bundle only set/forward the bit; none document its server effect. **Re-searched this pass across the full corpus** — whatsmeow (`grep -ni pull` over all `.go`), Baileys (`src/**`), the legacy/multi-device reveng repos, and the beautified bundle — and found **no comment, doc, or branch that ties the `Pull` bit to an observable server behavior**; every hit is just the field declaration or a `passive`/`pull` payload assignment [protocol-cross-ref][bundle]. The brief's fresh native/live-appdata evidence (LTHash, tc-token, at-rest ciphers, Signal/app-state stores) does not touch this field either. Closing this needs a **live A/B wire capture** (connect with `pull:true` vs `pull:false` and diff message-delivery behavior) or a leaked **server-side reference**; no static artifact in the corpus can pin it. Folded into §3.6.
