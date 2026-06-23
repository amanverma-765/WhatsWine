# 12. Binary Node Encoding & Token Dictionary

> Target: Meta native WhatsApp for Windows (WhatsApp.Root.exe, WinUI 3 hybrid). This document covers WhatsApp's **FunXMPP binary wire format** — the serialization that turns the in-memory `ProtocolTreeNode` XMPP-like stanza tree into the compact byte stream that travels (AES-GCM-encrypted) over the Noise transport, and back. All evidence is cited as `path:LINE` with paths relative to `decompiled_source/`.

## 1. Purpose & Scope

WhatsApp does **not** send XML on the wire. It sends a custom length-prefixed binary token format historically called **FunXMPP**. A stanza such as `<iq to="s.whatsapp.net" type="get" id="A3" xmlns="w:p"><ping/></iq>` is encoded as a tree of *lists*, where every recurring protocol string (tags, attribute names, common attribute values, server domains) is replaced by a 1- or 2-byte **dictionary token**, JIDs are packed into a compact type/device/user triple, and numeric/hex strings are nibble-packed.

This document covers exactly four things and their glue:

1. **`ProtocolTreeNode`** — the in-memory stanza element model (tag / attributes / children / data) and its typed accessors and builder.
2. **`BinTreeNodeWriter`** — the serializer (tree → FunXMPP bytes), including list framing, string token substitution, byte-string encoding (binary / nibble / hex), and JID packing.
3. **`BinTreeNodeReader`** — the deserializer (FunXMPP bytes → tree), the exact inverse.
4. **`WAPDefaultTokenDictionary` + `TokenDictionary`** — the hard-coded 236-entry primary token table plus four 256-entry secondary sub-dictionaries, and the bidirectional lookup wrappers.

Scope boundary: this is the layer that sits **between** the stanza-builder layer (`Smax.Generated.*`, `StanzaBuilders`) above and the **frame/crypto** layer (`FramesWriter`/`FramesReader`, `StanzaWriter`/`EncryptedBytesReceiver`, AES-GCM) below. We touch the frame layer only enough to show where the encoded bytes hand off (the per-frame 3-byte length prefix and the compression flag byte live just outside FunXMPP proper). Noise handshake, AES-GCM key derivation, and the stanza *dispatch* state machine are documented elsewhere.

## 2. Where It Lives

All paths relative to `decompiled_source/`.

Core encoding (assembly `WhatsApp.Networking`, namespace `WhatsApp`):

| File | Role |
|------|------|
| `decompiled/WhatsApp.Networking/WhatsApp/BinTreeNodeWriter.cs` | Tree → FunXMPP bytes (serializer) |
| `decompiled/WhatsApp.Networking/WhatsApp/BinTreeNodeReader.cs` | FunXMPP bytes → tree (deserializer) |
| `decompiled/WhatsApp.Networking/WhatsApp/BinTag.cs` | Named byte-tag constants (`LIST_8`, `JID_U`, `NIBBLE_8`, …) |
| `decompiled/WhatsApp.Networking/WhatsApp/WAPDefaultTokenDictionary.cs` | Hard-coded primary + 4 secondary string tables; `DictionaryVersion = 3` |
| `decompiled/WhatsApp.Networking/WhatsApp/TokenDictionary.cs` | Forward (string→token) + reverse (token→string) lookup wrapper |
| `decompiled/WhatsApp.Networking/WhatsApp/ITokenDictionary.cs` | Interface the dictionary tables expose |
| `decompiled/WhatsApp.Networking/WhatsApp/FunXMPPConstants.cs` | Unrelated string constants (attr names like `"category"`, `"hsm"`) — **not** the token table |

Node model (assembly `WhatsApp.Networking`, namespace `WhatsApp.Networking.Nodes`):

| File | Role |
|------|------|
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolTreeNode.cs` | Sealed in-memory stanza element + typed attribute getters |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolKeyValue.cs` | One attribute (`key`, `value`, `KVType` JID-type flags) |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolTreeNodeBuilder.cs` | Fluent builder (`AddStringAttribute`/`AddChild`/`Merge`/`Build`) |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolKeyValueExtensions.cs` | `DistinctByKey` attribute dedup helper — its comparator keys on **both** `key` equality **and** runtime type (`x.GetType() != y.GetType()` check, `:24-28`), so it only dedups same-type same-key entries |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolNodeExtensions.cs` | `TagEquals` / `TagEqualsAny` |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolNodeValueParser.cs` | Timestamp attribute parsing |

JID type support (assembly `WhatsApp.Core`, namespace `WhatsApp`):

| File | Role |
|------|------|
| `decompiled/WhatsApp.Core/WhatsApp/UserJidType.cs` | `enum UserJidType { Unknown=-1, Jid=0, Lid=1, Bot=2 }` |
| `decompiled/WhatsApp.Core/WhatsApp/UserJidTypeExtension.cs` | `ParseJidType(byte)` — decodes the JID_U flags byte |
| `decompiled/WhatsApp.Core/WhatsApp/JidConstants.cs` | Domain strings + `JidDeviceSeparator=':'`, `JidAgentSeparator='.'` |

Wiring / consumers (assembly `WhatsApp.Root`, namespace `WhatsApp`):

| File | Role |
|------|------|
| `decompiled/WhatsApp.Root/WhatsApp/FunXMPP.cs` | `public static TokenDictionary Dictionary = new TokenDictionary();` — the single shared instance |
| `decompiled/WhatsApp.Root/WhatsApp/StanzaWriter.cs` | Owns a `BinTreeNodeWriter(FunXMPP.Dictionary)`; applies compression + AES-GCM |
| `decompiled/WhatsApp.Root/WhatsApp/EncryptedBytesReceiver.cs` | Owns a `BinTreeNodeReader(FunXMPP.Dictionary)`; AES-GCM-decrypts + inflates |
| `decompiled/WhatsApp.Networking/WhatsApp/FramesWriter.cs` | 3-byte big-endian length prefix (outbound) |
| `decompiled/WhatsApp.Networking/WhatsApp/FramesReader.cs` | 3-byte length reassembly (inbound) |
| `decompiled/WhatsApp.Root/WhatsApp/HandshakeHandler.cs` | Emits the `WA\x06\x03` stream header carrying `DictionaryVersion` |

The same `BinTreeNodeWriter`/`BinTreeNodeReader` are also instantiated by the VoIP signaling layer (`decompiled/WhatsApp.VoIP/WhatsApp/VoipSignaling.cs`, `decompiled/WhatsApp.Root/WhatsApp.Voip/VoipWebCore.cs`) to (de)serialize call stanzas to base64 for the JS bridge — confirmed by `grep "new BinTreeNodeWriter|new BinTreeNodeReader"`.

## 3. How It Works

### 3.1 The in-memory model: `ProtocolTreeNode`

A stanza element is a sealed object with exactly four public fields (`ProtocolTreeNode.cs:13-19`):

```csharp
public string tag;
public ProtocolKeyValue[] attributes;
public ProtocolTreeNode[] children;
public byte[] data;
```

Invariant enforced by construction: a node has **either** `children` **or** `data`, never both. The constructors are mutually exclusive — one takes `ProtocolTreeNode[] children` (`ProtocolTreeNode.cs:21`), one takes `byte[] data` (`ProtocolTreeNode.cs:31`), one takes `string data` (UTF-8 encoded with line-ending normalization, `ProtocolTreeNode.cs:36-39`), and one takes neither (`ProtocolTreeNode.cs:41`). `Init` sets `attributes` to `Array.Empty<ProtocolKeyValue>()` when null but leaves `children`/`data` as passed (`ProtocolTreeNode.cs:288-294`). The builder explicitly refuses to mix the two: `AddChild` fails if `data != null` (`ProtocolTreeNodeBuilder.cs:73-76`) and `AddData` fails if `children` is non-empty (`ProtocolTreeNodeBuilder.cs:120-123`).

Each attribute is a `ProtocolKeyValue` (`ProtocolKeyValue.cs:7-43`): immutable `key`, `value`, and a `KVType` enum. `KVType` is a **flag** enum where bit 1 (`Jid = 2`) means "this value is a JID" and the higher bits encode *which* JID variants are legal (`ProtocolKeyValue.cs:9-33`):

```csharp
Unspecified=0, NotAJid=1, Jid=2, UserJid=6, GroupJid=10,
UserJidOrGroupJid=14, DeviceJid=34, UserJidOrDeviceJid=38, ...
```

The crucial helper for the encoder is:

```csharp
public static bool IsJidType(KVType kvType) => (kvType & KVType.Jid) == KVType.Jid;   // ProtocolKeyValue.cs:109-112
```

i.e. any type with the `0x2` bit set is treated as a JID and gets compact JID packing on the wire. `ProtocolKeyValue` also *validates* the string against the declared variant at construction via `IsValidForType` (`ProtocolKeyValue.cs:119-143`), but note this only logs/constructs an exception object on mismatch — it does not throw (`ProtocolKeyValue.cs:67-69`).

Typed read-side accessors (`GetAttributeInt`, `GetAttributeLong`, `GetAttributeBool`, `GetAttributeJid<T>`, `GetAttributeDeviceJid`, `GetAttributeDateTime`, …) all funnel through `GetAttributeValue` → linear scan of `attributes` (`ProtocolTreeNode.cs:70-214`). Child access is also a linear scan: `GetChild(string)` returns the **last** matching child (`ProtocolTreeNode.cs:243-258`); `GetAllChildren` filters by tag (`ProtocolTreeNode.cs:269-272`).

There is also a post-construction mutation path the builder does not own: `ProtocolTreeNode.AddAttribute(attrKey, attrVal)` (`ProtocolTreeNode.cs:55-68`) appends a new `ProtocolKeyValue` by allocating a fresh array (`Concat(...).ToArray()`), but **silently ignores** the call when `attrKey`/`attrVal` is null **or** when a same-key attribute already exists (`!array.Any(p => p.key == attrKey)` guard, `:60`). So duplicate keys are deduped here too — first-write-wins, no exception. This complements the builder's `DistinctByKey` dedup described below; the two paths use different mechanisms (linear `Any` scan vs. a `Distinct` comparator).

### 3.2 Byte-tag constants (`BinTag.cs`)

The entire format is keyed off a small set of reserved leading bytes (`BinTag.cs:5-29`):

| Const | Value | Meaning |
|-------|------:|---------|
| `STREAM_START` | `1` | (stream open marker; not used by node body) |
| `STREAM_END` | `2` | end-of-stream sentinel node |
| `LIST_EMPTY` | `0` | zero-length list / null string |
| `JID_FB` | `246` | "FB" JID (Meta-account JID) — **rejected by reader** |
| `JID_U` | `247` | ad-JID: type byte + device byte + user string |
| `LIST_8` | `248` | list whose length fits in 1 byte |
| `LIST_16` | `249` | list whose length needs 2 bytes |
| `JID_PAIR` | `250` | legacy `user@server` JID |
| `HEX_8` | `251` | hex-nibble-packed string, 1-byte length |
| `BINARY_8` | `252` | raw bytes, 1-byte length |
| `BINARY_20` | `253` | raw bytes, 20-bit length |
| `BINARY_32` | `254` | raw bytes, 31-bit length |
| `NIBBLE_8` | `255` | decimal-nibble-packed string, 1-byte length |

Tokens `3..235` (primary dictionary) and `236..239` (secondary sub-dictionary selectors) occupy the gap below `246`. Token `0` is overloaded as both `LIST_EMPTY` and the null/absent string. `STREAM_START (1)` is a **dead constant in this build's node body**: no `BinTreeNodeWriter` path ever emits a bare `1` (the only literal control byte written by the writer is `2`/`STREAM_END` in `WriteTreeNodesEnd`, `BinTreeNodeWriter.cs:39`), and the reader has **no** branch for token `1` — neither `ReadString` (`:102-184`), `ReadListSize` (`:81-90`) nor `IsListTag` (`:49-56`) tests for it, so a stray `1` node-token falls straight to the `default: CorruptStreamException` (`:181-182`). The stream is opened solely by the `WA\x06\x03` header (§3.9), not by an in-body `STREAM_START` (see §6 item 2).

### 3.3 The token dictionary

`WAPDefaultTokenDictionary` hard-codes two structures (`WAPDefaultTokenDictionary.cs`):

- **`primaryStrings`**: a `string[236]` (`:5-31`). Index `0` is `null` (so token `0` never resolves to a string — it stays the list/null sentinel). Examples confirmed from the array: index `1="xmlstreamstart"`, `2="xmlstreamend"`, `3="s.whatsapp.net"`, `4="type"`, `6="from"`, `8="id"`, `9="notification"`, `17="to"`, `19="message"`, `22="xmlns"`, `25="iq"`, `27="ack"`, `29="enc"`. These are the single-byte tokens.
- **`secondaryStrings`**: a `string[4][256]` (`:33-151`) — four sub-dictionaries of 256 entries each. Reached with a **two-byte** token: a selector byte in `236..239` (`secondaryStringsStart = primaryStrings.Length = 236`, `:153`) followed by an index byte `0..255`. Examples: subdict 0 index 0 = `"read-self"` (`:36`), subdict 1 index 0 = `"reject"` (`:65`), subdict 2 index 0 = `"64"` (`:94`), subdict 3 index 0 = `"1724"` (`:123`).

`DictionaryVersion` is the constant `3` (`WAPDefaultTokenDictionary.cs:155,163`). This version is the byte the handshake advertises (see §3.9), so the writer's compression of strings is keyed to the version the server agreed to.

This entire table has been **cross-verified byte-for-byte against an independent decompilation**: the WhatsApp Web bundle ships the same dictionary in module `WAWapDict` (`waweb-source-bundle/n6o0-NaJTww.js`) as `var e=3,l=[…]` (primary) plus four 256-entry arrays, exported `DICT_VERSION=3`, `SINGLE_BYTE_TOKEN`, `DICTIONARY_0..3_TOKEN`. An element-by-element diff confirms the primary array is identical (C# `primaryStrings[1..235]` == JS `l[0..234]`; the C# index-0 `null` is just the sentinel offset, so the on-wire token byte matches) and **all four secondary sub-dictionaries are identical** (256 entries each). Both advertise version `3`. See §6 item 1.

`TokenDictionary` (`TokenDictionary.cs`) wraps the raw tables into two `Dictionary` indexes built once in the constructor:

- forward: `_primaryStringDict` (string→index) for primary, `_secondaryStringDict` (string→`Pair<subdictSelector, index>`) for secondary (`:32-55`).
- reverse: direct array indexing in `GetToken`.

`PrimaryTokenMax` is computed as `_primaryStrings.Length + _secondaryStrings.Length = 236 + 4 = 240` (`TokenDictionary.cs:56`). The reader uses this as the upper bound for "this byte is a dictionary token" (see §3.6).

**Forward lookup** (writer side), `TryGetToken` (`TokenDictionary.cs:59-72`):

```csharp
if (_primaryStringDict.TryGetValue(str, out token)) return true;            // subdict stays -1
if (_secondaryStringDict.TryGetValue(str, out value)) {
    subdict = value.First;   // 236..239
    token   = value.Second;  // 0..255
    return true;
}
return false;
```

**Reverse lookup** (reader side), `GetToken(token, ref subdict, ref str)` (`TokenDictionary.cs:74-105`): if `subdict >= 0` it indexes `_secondaryStrings[subdict]`; else if the token itself is in `236..239` it records `subdict = token - 236` and leaves `str` unresolved (signalling the caller to read the next index byte); else it indexes `_primaryStrings`. A `null` slot (e.g. primary index 0) throws `CorruptStreamException` (`:100-103`).

### 3.4 Writer: list framing and the node recursion

`BinTreeNodeWriter` holds a `TokenDictionary tokenMap` and a reusable `MemoryStream _out` of initial size `2048` (`BinTreeNodeWriter.cs:16,22,26,31`). All public entry points lock `_lockObject` (single-writer discipline) and, on any exception, reset `_out` to empty and rethrow (`:60-66`).

`Write` either writes a single `0` byte for a null node or calls `WriteInternal`, then `FlushBuffer` hands the buffer to the `ITarget` (the `StanzaWriter`) with the `useCompression` flag (`:44-67`). `WriteTreeNodesEnd` writes a 1-element list then a `2` (`STREAM_END`) byte and flushes (`:34-42`) — the graceful stream-close stanza.

**Node layout** — `WriteInternal` (`BinTreeNodeWriter.cs:80-97`):

```csharp
WriteListStart(1
    + (attributes != null ? attributes.Length * 2 : 0)   // each attr = key + value
    + (children   != null ? 1 : 0)                        // child-list counts as ONE list element
    + (data       != null ? 1 : 0));                      // data counts as ONE list element
WriteString(node.tag);
WriteAttributes(node.attributes);
if (data != null)     WriteBytes(node.data);
if (children != null) { WriteListStart(children.Length); for each child WriteInternal(child); }
```

So the **list size** of a node equals `1 (tag) + 2*attrCount [+1 for data OR children]`. The child block is itself a nested list (its own `LIST_8`/`LIST_16` header), but from the parent node's list it counts as a single trailing element. This is the exact relationship the reader inverts (§3.6).

`WriteListStart(i)` (`:420-436`):
- `i == 0` → write byte `0` (`LIST_EMPTY`).
- `i < 256` → write `248` (`LIST_8`) then 1 length byte.
- else → write `249` (`LIST_16`) then 2 big-endian length bytes.

`WriteToken(int)` simply writes the low byte when `< 256` (`:256-262`).

### 3.5 Writer: strings, bytes, nibble/hex packing

**Tag and attribute-key strings** go through `WriteString` (`:153-173`): try `tokenMap.TryGetToken`; if found, emit the subdict selector byte (when `subdict >= 0`) then the token byte and return. Otherwise emit the UTF-8 bytes via `WriteBytes`. (There is a JID sanity check that only logs a throttled investigation in non-production builds, `:166-171`.)

**Attribute values** go through `WriteValueString(key, value, kvType)` (`:111-151`). The branch order is:
1. If `IsJidType(kvType)` → split on `'@'` and call `WriteJid(user, server)` (or `WriteJid(null, value)` if no `@`). Returns immediately — **JID values are never dictionary-token-substituted.**
2. Else try `TryGetToken` → emit token(s).
3. Else if there is no `@` at position ≥ 1 → emit raw UTF-8 via `WriteBytes`.
4. Else (looks like a JID but wasn't typed as one) → `WriteJid(user, server)` anyway, after a throttled "unexpected jid" investigation.

**`WriteBytes`** (`:264-387`) is the heart of string compression. Given `num = bytes.Length`:
- `num >= 1048576` (1 MiB) → `254` (`BINARY_32`) + 31-bit length (`WriteInt31`).
- `num >= 256` → `253` (`BINARY_20`) + 20-bit length (`WriteInt20`).
- `num < 256` → try **nibble packing** first, then **hex packing**, else raw `252` (`BINARY_8`):
  - **Nibble (decimal) pack** — only attempted when `num < 128` (`:282`). Each byte must be ASCII `'0'..'9'` (→ nibble `0..9`), `'-'` (→ `10`) or `'.'` (→ `11`); a 4-bit nibble is packed two-per-byte, high nibble first (`:315`). Any other byte aborts nibble packing (`array2 = null`, `:308`). On success: emit `255` (`NIBBLE_8`); the length byte is `(num % 2 << 7) | packedLen`, i.e. **bit 7 is the odd-length flag** and the low 7 bits are the packed byte count (`:365-367`). Odd strings pad the final low nibble with `0xF` (`:360-363`).
  - **Hex pack** — attempted if nibble failed (`:317-356`). Each byte must be `'0'..'9'` or `'A'..'F'` (uppercase only; → `0..15`). On success: emit `251` (`HEX_8`); same `(odd<<7)|len` length byte, same `0xF` odd-pad (`:369-379`).
  - **Raw** — neither worked: emit `252` (`BINARY_8`) + 1-byte length (`:381-384`).
- Finally the packed/raw `array` is written (`:386`).

Integer length helpers: `WriteInt8` = low byte (`:389-392`); `WriteInt16` = 2 bytes big-endian (`:399-403`); `WriteInt20` = 3 bytes big-endian masked to `0xFFFFFF` (`:405-410`); `WriteInt31` = 4 bytes big-endian with the top byte masked `& 0x7F` (`:412-418`).

### 3.6 Reader: the inverse, node by node

`BinTreeNodeReader.ParseTreeNode(stream)` (`BinTreeNodeReader.cs:17-47`):

```csharp
int token = stream.ReadByte();
int num   = ReadListSize(token, stream);   // node's list size
token = stream.ReadByte();
if (token == 2) return null;               // STREAM_END sentinel
string tag = ReadStringAsString(token, stream);
if (num == 0 || tag == null) throw CorruptStreamException("nextTree sees 0 list or null tag");
int attribCount = (num - 2 + num % 2) / 2; // <-- inverse of the writer's size formula
ProtocolKeyValue[] attrs = ReadAttributes(attribCount, stream);
if (num % 2 == 1) return new ProtocolTreeNode(tag, attrs);            // odd => no data, no children
token = stream.ReadByte();
if (IsListTag(token)) return new ProtocolTreeNode(tag, attrs, ReadList(token, stream));  // children
object obj = ReadString(token, stream);    // else => data
byte[] data = obj is string s ? Encoding.UTF8.GetBytes(s) : (byte[])obj;
return new ProtocolTreeNode(tag, attrs, data);
```

The pivotal arithmetic: writer list size = `1 + 2*attrCount [+1]`. So `attribCount = (num - 2 + num%2) / 2`, and **odd `num` ⇒ the node has neither data nor children** (the trailing `+1` was absent), while **even `num` ⇒ one trailing element** that is either a child-list (if the next byte is a list tag) or a data blob (`:31-46`). `IsListTag` accepts `248` (`LIST_8`), `249` (`LIST_16`) and `0` (`LIST_EMPTY`) (`:49-56`). `ReadListSize` maps `0→0`, `248→ReadInt8`, `249→ReadInt16`, anything else throws (`:81-90`).

The child-list itself is decoded by `ReadList(token, stream)` (`BinTreeNodeReader.cs:70-79`), which reads its own `LIST_8`/`LIST_16` size header and then **recurses** — it calls `ParseTreeNode(stream)` once per element (`:76`). This is the recursion that mirrors the writer's nested `WriteInternal` loop (§3.4): nested child lists at any depth re-enter `ParseTreeNode` through `ReadList`, so the whole stanza tree is reconstructed top-down in a single pass.

`ReadAttributes` reads `attribCount` *pairs* of strings (`:58-68`); each pair becomes a `new ProtocolKeyValue(k, v)` — note the reader uses the 2-arg ctor, so all inbound attributes have `KVType = Unspecified (0)` and JID typing is **not** reconstructed on receive.

### 3.7 Reader: `ReadString` token decode

`ReadString(token, stanza)` (`BinTreeNodeReader.cs:102-184`) is the dual of the writer's string emission:

- `token == -1` (EOF) → `CorruptStreamException`.
- `2 < token < PrimaryTokenMax` (i.e. `3..239`) → a **dictionary token** (`:108-119`). It calls `GetToken(token, ref subdict, ref str)`. If `str` comes back `null`, the token was a **secondary selector** (`236..239`): read the next byte as the index and call `GetToken` again (`:113-117`). Returns the resolved string.
- `token == 0` → `null` (`:122-123`).
- `token == 252` (`BINARY_8`) → read 1-byte length, fill array (`:124-129`).
- `token == 253` (`BINARY_20`) → read 20-bit length, fill (`:130-135`).
- `token == 254` (`BINARY_32`) → read 31-bit length, fill (`:136-141`).
- `token == 255` (`NIBBLE_8`) → `ReadNibble8` (`:142-143`).
- `token == 251` (`HEX_8`) → `ReadHex8` (`:144-145`).
- `token == 250` (`JID_PAIR`) → read two strings, rebuild `user@server` (or just `server` if user is null, else throw) (`:146-159`).
- `token == 247` (`JID_U`) → decode the ad-JID (see §3.8) (`:160-178`).
- `token == 246` (`JID_FB`) → `CorruptStreamException("jid_fb not supported")` (`:179-180`). **FB-JIDs are explicitly rejected by this native build.**
- default → `CorruptStreamException` (`:181-182`).

`ReadNibble8` / `ReadHex8` (`:250-328`): read the length byte, take `flag = (b & 0x80)` (odd) and `len = b & 0x7F` (packed bytes), fill `len` bytes, then expand `len*2 - (odd?1:0)` nibbles. Nibble `0..9 → '0'..'9'`; `10..11 → '-'`/`'.'` for nibble decode (`:277-280`); `10..15 → 'A'..'F'` for hex decode (`:315-321`). Out-of-range nibbles throw. `FillArray` loops until the requested byte count is fully read (`:209-219`), tolerating short socket reads. Integer readers `ReadInt8/16/20/31` are plain big-endian, with `ReadInt31` masking the top byte `& 0x7F` (`:221-248`).

### 3.8 JID packing — the most format-specific part

WhatsApp packs JIDs three ways. The writer's `WriteJid(user, server)` (`BinTreeNodeWriter.cs:186-254`):

1. `ParseUserJidSuffix(server)` maps the domain string to `UserJidType` (`:175-184`):
   - `"s.whatsapp.net" → Jid (0)`
   - `"lid" → Lid (1)`
   - `"bot" → Bot (2)`
   - anything else → `Unknown (-1)`
2. For `Jid`/`Lid` (`(uint)userJidType <= 1u`, `:191`): reject an agent separator `'.'` in the user (`CorruptStreamException("Agent is not supported")`, `:193-196`); then find the device separator `':'` and parse the trailing device id into `result` (`:197-208`).
3. **Bot** (`:210-228`): strip a `:0` device suffix (a non-zero bot device id throws `CorruptStreamException("Bot with non 0 deviceId")`, `:221-222`), then encode as a **legacy `JID_PAIR` (250)**: `250, WriteString(user), WriteString(server)`.
4. **Jid/Lid with a real device id** (`result > 0`, `:229-236`) → encode as **`JID_U` (247)**:
   ```
   247, (byte)userJidType, (byte)(deviceId & 0xFF), WriteString(userWithoutDevice)
   ```
   The server domain is *not* written — it is implied by the type byte.
5. **Otherwise** (`:237-253`) → **`JID_PAIR` (250)**: `250`, then `WriteString(user)` (or `WriteToken(0)` if user is null), then `WriteString(server)`.

The reader's `JID_U (247)` decode (`BinTreeNodeReader.cs:160-178`): `ParseJidType(flagsByte)` returns `Lid` if bit 0 set, else `Jid` (`UserJidTypeExtension.cs:7-14` — note it can only yield Jid/Lid, never Bot, since Bot is always serialized as `JID_PAIR`). Read device byte, read user string, then rebuild: `user` + (`":" + device` if device ≠ 0) + suffix, where `ToUserJidSuffix` maps `Jid→"@s.whatsapp.net"`, `Lid→"@lid"` (`:330-338`). `JID_PAIR (250)` decode just rejoins `user + "@" + server` (`:146-159`).

Key asymmetry to remember when porting: the **device separator is `:`** and the **agent separator is `.`** (`JidConstants.cs:65-67`); agent-JIDs are explicitly unsupported in `JID_U` write (`BinTreeNodeWriter.cs:195`). The `JID_U` type byte is a *flags* byte (bit 0 = LID), not a plain enum value, even though the writer writes `(byte)userJidType` (which for Jid=0 / Lid=1 happens to coincide with the flag).

**`JID_FB (246)` and `JID_INTEROP (245)` — emitted by the web bundle, not by this native client.** This native build only ever *writes* `JID_U (247)` or `JID_PAIR (250)` and *rejects* `246` on read (`BinTreeNodeReader.cs:179-180`). The WhatsApp Web encoder, however, carries dedicated branches (`waweb-source-bundle/n6o0-NaJTww.js`, function `re()`, tag constants `R=245,L=246,E=247,…`): an FB-JID is `246, <user string>, uint16(device), <server string>` where the server is `WAJids.MSGR_USER_DOMAIN` (Messenger-interop domain) — richer than the native `JID_PAIR` fallback because it carries a 16-bit device and explicit server; an interop-JID is `245, <user>, uint16(device), uint16(integrator)`. A from-scratch decoder that may talk to the same servers should handle `246` (and likely `245`) on receive rather than assuming they are unreachable. See §6 item 3.

### 3.9 Where the encoded bytes hand off (frame + compression + crypto)

The encoder produces a raw node-body byte stream. Three things wrap it before it leaves the process, in order from inner to outer:

1. **Compression flag byte (prefix).** `StanzaWriter.WriteStanza` (`StanzaWriter.cs:35-72`) is the `BinTreeNodeWriter.ITarget`. If `useCompression` and the stanza is `< 4 GiB`, it deflates the node bytes behind a leading byte `2` (`:46-47`); if the deflated result is actually smaller it keeps it (`flag=true`), otherwise it falls back to a leading byte `0` + uncompressed bytes (`:50-66`). So **the first byte of the plaintext frame is the compression flag: bit `0x2` set ⇒ zlib/Deflate.** A frame larger than `33554432` (32 MiB) throws (`:67-69`). The `useCompression` flag threads up through `Connection.Write(node, compress=false)` (`Connection.cs:18-21`) and `StanzaWriter.Write(node, compress=false)` (`StanzaWriter.cs:25-28`), both of which **default the parameter to `false`**. Every caller of `connection.Write(...)` in the decompiled C# (e.g. `ConnectionExtensions.cs:21`, `ClearDirtyStanzaBuilder.cs:15,21,47`) uses the single-argument form, i.e. relies on that default — **no code path in this build ever passes `compress: true`.** So in practice this native client transmits stanzas uncompressed (leading flag byte `0`); the compression machinery exists and is wired but is dormant policy-wise. (Confirmed by `grep` for any two-argument `Write(node, true)` — none exists.)
2. **AES-GCM.** `WriteEncrypted` encrypts the (flag-prefixed) frame with the write transport key and a 12-byte big-endian incrementing nonce, **no AAD** (`StanzaWriter.cs:74-78`). The receive side mirrors this: `EncryptedBytesReceiver.ReceiveFrame` decrypts, then checks `(array[0] & 2) != 0` to decide whether to `InflaterInputStream`-inflate before `ParseTreeNode` (`EncryptedBytesReceiver.cs:24-47`).
3. **3-byte length prefix (frame framing).** `FramesWriter.WriteFrameInternal` prepends `MediumToByteArray(len)` — a 24-bit big-endian length (`FramesWriter.cs:21-38`). On the read side the work is split across two methods: the public socket entry point `FramesReader.SocketBytesIn` (`FramesReader.cs:27-49`, via `OnReaderBytesIn` `:51-64`) owns the **cross-read buffering** — it accumulates partial frames into an internal `WaMemoryStream` when a read does not contain a whole frame, and replays the buffer once more bytes arrive. It then delegates the actual **frame-boundary parsing** to `OnBytesAvailable` (`:66-85`), which reads the 3-byte header `num5 = (b0<<16)+(b1<<8)+b2` (`:74`), breaks (returning the consumed-byte count) if fewer than `num5` bytes are available so the remainder is re-buffered by `SocketBytesIn`, and otherwise dispatches `ProcessFrame` (`:80`) and advances past the frame. So `SocketBytesIn` handles fragmentation; `OnBytesAvailable` handles the length-decode and dispatch.

Separately, the **stream header** that precedes all frames carries the dictionary version. `HandshakeHandler` builds `byte[4] { 87, 65, 6, 0 }` = ASCII `"WA"`, protocol version `6` (`WaProtocolVersion`, `HandshakeHandler.cs:11`), and overwrites the 4th byte with `FunXMPP.Dictionary.GetDictionaryVersion()` = `3` (`HandshakeHandler.cs:47-48`). The edge-routing header is `byte[4] { 69, 68, 0, 1 }` = ASCII `"ED"`, `0`, `1` (`:50`). Thus the very first bytes on the socket are `45 44 00 01` (optional edge header) then `57 41 06 03` (`"WA"`,6,3).

The edge header is **conditional**: `HandshakeHandler.WriteInitialStanza` (`HandshakeHandler.cs:147-166`) prepends it only `if (_edgeRoutingInfo != null && _edgeRoutingInfo.Length != 0)` (`:149-150`). When present, the sequence written is `_edgeHeader` (`ED 00 01`), then a 3-byte big-endian length of the routing blob via `FramesWriter.MediumToByteArray(_edgeRoutingInfo.Length)`, then the `_edgeRoutingInfo` bytes themselves (`:152-155`). The `WA\x06\x03` stream header is written unconditionally next (`:157`), followed by the Noise client-hello. So the edge header is a self-describing length-prefixed prelude emitted purely when the client was given `edgeRoutingInfo` to replay (a server-supplied routing hint), and omitted otherwise.

Both `StanzaWriter` and `EncryptedBytesReceiver` use the **single shared dictionary** `FunXMPP.Dictionary` (`FunXMPP.cs:8`; `StanzaWriter.cs:22`; `EncryptedBytesReceiver.cs:21`), so encode and decode are guaranteed table-consistent.

### 3.10 Worked example (byte-level)

Take `<iq id="A3" type="get" xmlns="w:p" to="s.whatsapp.net"><ping/></iq>` (a foreground ping IQ; tag, `type`, `xmlns`, `to`, `ping` are all dictionary words). Encoding per the rules above:

- Node `iq` has 4 attributes + 1 child ⇒ list size `= 1 + 2*4 + 1 = 10`. Write `248` (`LIST_8`), `10`.
- tag `"iq"` → primary token `25` ⇒ byte `25`.
- attr `id`→`"A3"`: key `id` = token `8`; value `"A3"` is not a token and not nibble-decimal (`'A'` is not a digit/`-`/`.`), but both chars are valid uppercase hex (`'A'`, `'3'`), so it **hex-packs**: `251` (`HEX_8`), length byte `(2 % 2 << 7) | 1 = 0x01`, packed byte `0xA3`. The length byte's bit-7 odd flag is **0** here because `"A3"` has an even length (2 chars); only an odd-length id (e.g. a 3-char `"A3F"`) would set it, giving `(1 << 7) | 2 = 0x82`. The packed byte count in the low 7 bits is `array.Length = ⌈2/2⌉ = 1`. The length-byte formula is `(num % 2 << 7) | array.Length` (`BinTreeNodeWriter.cs:377`). (If the id contained a lowercase letter it would fall to `BINARY_8`.)
- attr `type`→`"get"`: key `type` = token `4`; value `"get"` = token `41` ⇒ bytes `4`, `41`.
- attr `xmlns`→`"w:p"`: key `xmlns` = token `22`; value `"w:p"` = token `87` ⇒ bytes `22`, `87`.
- attr `to`→`"s.whatsapp.net"` typed as `Jid`: key `to` = token `17`. The value has no `'@'`, so `WriteValueString` calls `WriteJid(null, "s.whatsapp.net")` (`BinTreeNodeWriter.cs:117-121`). With a null user and no device, `WriteJid` takes the final `else` branch (`:237-253`): emit `250` (`JID_PAIR`), then `WriteToken(0)` for the null user (`:250`), then `WriteString("s.whatsapp.net")` = token `3`. Net bytes: `250, 0, 3`. (Token numbers `8/4/41/22/87/17/3` are confirmed from `WAPDefaultTokenDictionary.cs:7-31,39`.)
- child block: `WriteListStart(1)` ⇒ `248`,`1`; then child `<ping/>`: list size `1` ⇒ `248`,`1`, tag `ping` = token `86` ⇒ byte `86`.

This illustrates the dominant property: a fully "known" stanza collapses to roughly one byte per structural element. Numeric ids/timestamps nibble-pack to half size; only genuinely novel strings (message text, base64 keys, media hashes) hit `BINARY_8/20/32`.

## 4. Native Dependencies

The binary node encoding is **pure managed C#** — there is **no** native (C++/Rust) dependency for FunXMPP serialization itself. Confirmed: `BinTreeNodeWriter.cs`, `BinTreeNodeReader.cs`, `WAPDefaultTokenDictionary.cs`, `TokenDictionary.cs`, `ProtocolTreeNode.cs` contain no `WhatsAppNative`/WinRT projection calls; the only external library is `ICSharpCode.SharpZipLib` (managed zlib) used at the *frame* layer for Deflate/Inflate (`StanzaWriter.cs:2`, `EncryptedBytesReceiver.cs:2`).

Adjacent native dependencies (one layer out, not part of encoding):

- **AES-GCM frame crypto** is native via `AesGcmProvider` over the WinRT `SymmetricKeyAlgorithmProvider` (`StanzaWriter.cs:76`, `EncryptedBytesReceiver.cs:26`). The AEAD primitive is in the platform, not in WhatsAppNative. The **exact AEAD parameters are now fixed and read directly from the provider body** [decompiled-C#] (`AesGcmProvider.cs`): AES-GCM via `SymmetricKeyAlgorithmProvider.OpenAlgorithm(SymmetricAlgorithmNames.AesGcm).CreateSymmetricKey(cipherKey)` (`:15,40`) and `CryptographicEngine.EncryptAndAuthenticate` / `DecryptAndAuthenticate` (`:27,59`); the tag length is the literal `public const int TagSize = 16;` (`AesGcmProvider.cs:11`) — so the **16-byte tag is now confirmed from native-build C#, not only by interop**. The provider **appends** the 16-byte tag to the ciphertext on encrypt (`:28-33`) and **splits the trailing 16 bytes** back off on decrypt (`:45-46`), and passes a true-null AAD when the caller's `aad` is null/empty via `(aad == null || aad.Length < 1) ? null : aad.AsBuffer()` (`:27,59`) — so the `null` AAD argument from `StanzaWriter`/`EncryptedBytesReceiver` reaches CNG as a genuine empty-AAD GCM op. Key length = AES-**256** (the per-direction Noise transport key is 32 bytes). The nonce is a **12-byte big-endian incrementing per-direction frame counter** (`WAProtocol.LongToByteArray(_writeNonce++, 12)` / `_readNonce++`, `StanzaWriter.cs:12,76` / `EncryptedBytesReceiver.cs:9,26`). These match the open clients byte-for-byte (cross-reference: Baileys `Utils/crypto.ts:47,53-72` Node `aes-256-gcm`, `GCM_TAG_LENGTH = 128>>3 = 16`, tag suffixed to ciphertext, `Utils/noise-handler.ts:30-49` 12-byte IV + `EMPTY_BUFFER` AAD; whatsmeow `util/gcmutil/gcm.go:15-19` `aes.NewCipher`+`cipher.NewGCM` (default 12-byte nonce/16-byte tag), `Seal`/`Open` `:25-40`, `socket/noisesocket.go:22-23`). The native *provenance*: `WhatsAppNative.dll`'s PE import table (`objdump -p x64/WhatsAppNative.dll` → `DLL Name: bcrypt.dll`) pulls Windows **CNG (Cryptography-Next-Generation)** — but only `BCryptGenRandom` / `BCryptOpenAlgorithmProvider` / `BCryptCloseAlgorithmProvider` are imported by `WhatsAppNative.dll` itself [native-binary, re-confirmed this pass] (no `BCryptEncrypt`/`BCryptDecrypt`; the only `x64/` DLL importing those is `msquic.dll`). **Positive confirmation the GCM body is not in the WhatsApp dump:** a `strings` scan of `WhatsAppNative.dll` finds **no GCM/GHASH/`aes_256_gcm`/`bcryptprimitives` symbol at all** — the *only* AES in the native binary is the **VoIP sframe/SRTP counter-mode** path (`WASframeAESCipher`, `aud_stream_apply_sframe_settings`, `AES_CM_128_HMAC_SHA1_80`, `srtp_protect_aead`, `xplat\wa-voip\wacall\foundation\src\e2ee\cipher\wa_sframe_cipher_aes_impl.cc`), which is AES-CM for media, not the stanza-transport GCM. So the AES-GCM under `AesGcmProvider` reaches CNG through the managed WinRT `Windows.Security.Cryptography` projection, **not** a bundled TLS/crypto library, and not through `WhatsAppNative.dll`'s own code or import surface. The sibling **`WhatsAppRust.dll` is the `wamedia` media library** [native-binary] (its strings are entirely mp4/jpeg/webp/opus parsing + `mp4operations`/`libwamediastreams-rs` forensics under `xplat\whatsapp\wamedia\rust\...`) — it carries **no** Noise/GCM/Signal transport crypto, so it is not the stanza AEAD either. The Ghidra dumps remain unusable for cross-checking native *bodies*: `ghidra-output/WhatsAppNative-functions.txt` is **0 bytes**, and `ghidra-output/WhatsAppRust-functions.txt` is **242 bytes containing a PyGhidra error** (`"Ghidra was not started with PyGhidra. Python is not available"`), not function bodies — so the byte-level GCM internals (GHASH constants, S-box, tag finalization) were not disassembled, but those are standard NIST GCM inside CNG, not WhatsApp code (see §6 item 6). For FunXMPP this is irrelevant since the format is fully visible in C#.
- **Curve25519** keypair generation in the handshake header path (`HandshakeHandler.cs:57`) is native (`Curve22519Extensions` → `WhatsAppNative.Curve25519`), but that is the Noise layer, not node encoding.

Net: for a port, the entire binary-node layer can be reimplemented from the C# alone with zero native bindings. (Confirmed-from-code.)

## 5. Linux/Electron Port Mapping

This layer is the **single most reusable, lowest-risk** part of the whole client to port: it is deterministic, side-effect-free, fully specified in managed code, and already has battle-tested open-source equivalents.

### 5.1 The pragmatic path: reuse the waweb JS bundle's encoder

The Electron target loads the **same WhatsApp Web JS bundle** (`decompiled_source/waweb-source-bundle/`) inside a renderer/`BrowserWindow`. That bundle already contains a full FunXMPP encoder/decoder and the token dictionary (WhatsApp Web speaks the identical wire format over WebSocket). **If** the port keeps the JS bundle driving the protocol (as the native Windows app does — recall the native side only handles `iq`/`success`/`failure`; message/receipt/etc. are encoded in JS), then **no reimplementation is needed**: the binary node layer is provided by the bundle. This is the recommended path and mirrors the Windows architecture. Risk: the bundle's token table must stay version-matched to the server (`DictionaryVersion = 3` today); the bundle ships its own table so this is self-consistent.

### 5.2 The native-reimplementation path (Node/TS)

If you instead terminate the protocol in Node (no WebView for networking), reimplement these ~600 lines in TypeScript. There is a direct, well-known mapping:

| Windows piece | Node/Electron equivalent | Notes |
|---|---|---|
| `ProtocolTreeNode` | Plain TS class/interface `{ tag, attrs, content: Node[] \| Uint8Array }` | Trivial. Mirror the "children XOR data" invariant. |
| `BinTreeNodeWriter` / `BinTreeNodeReader` | Reimplement, or reuse **Baileys** `encodeBinaryNode` / `decodeBinaryNode` | Baileys (`@whiskeysockets/baileys`) implements byte-for-byte this exact format incl. nibble/hex packing and JID_PAIR/JID_U — the closest off-the-shelf match. |
| `WAPDefaultTokenDictionary` (236 + 4×256) | Port the arrays verbatim | These constants are the contract; copy them exactly from `WAPDefaultTokenDictionary.cs`. Baileys ships an equivalent `SINGLE_BYTE_TOKENS` / `DOUBLE_BYTE_TOKENS` table — **diff it against this build's table**, versions can drift. |
| `TokenDictionary` forward/reverse maps | Two `Map<string,number>` + arrays | Build once at startup. |
| Nibble/hex packing | `Buffer`/`Uint8Array` bit ops | Same `(odd<<7)\|len` length byte, `0xF` odd-pad, big-endian ints. |
| `FramesWriter`/`FramesReader` 3-byte length | Manual `Buffer` framing over the socket | `noise-handshake`/custom; 24-bit BE prefix. |
| Compression flag `0x2` + Deflate | Node `zlib.deflateSync`/`inflateSync` | Same raw-zlib stream the SharpZipLib code uses. |
| AES-GCM frame crypto (adjacent) | `crypto.createCipheriv('aes-256-gcm')` / `@noble/ciphers` | 12-byte BE incrementing nonce, no AAD for post-handshake frames. |
| `WA\x06\x03` header / `DictionaryVersion` | Emit literal bytes `57 41 06 03` | Keep version in sync with the table you ship. |

### 5.3 Gaps / risks

- **Token-table version drift.** The table is `DictionaryVersion = 3` *for this build (v2.2607.106.0)*. The server tolerates older dictionaries but the client must advertise the version it actually uses in the `WA` header. If you reuse Baileys' table without diffing, an entry mismatch silently corrupts decode for any stanza using a drifted secondary token. **Mitigation: copy `WAPDefaultTokenDictionary.cs` verbatim and pin the version.** (Reassurance: the WhatsApp Web bundle's `WAWapDict` table was diffed against this build's `WAPDefaultTokenDictionary.cs` and is identical — same `DICT_VERSION=3`, same primary and all four secondary arrays — so the two sources are genuinely interchangeable today; see §6 item 1.)
- **`JID_FB (246)` is rejected** by this native client (`BinTreeNodeReader.cs:179-180`) but **is actively emitted by the WhatsApp Web bundle** as `246, <user>, uint16(device), <MSGR server domain>` (`n6o0-NaJTww.js`, `re()`), and the web encoder also emits a **`JID_INTEROP (245)`** subtype (`245, <user>, uint16(device), uint16(integrator)`) that this native `BinTag` does not even list. A from-scratch decoder should implement (not just reject) both `246` and `245` on receive — do not assume they are unreachable. See §3.8 / §6 item 3.
- **Bot JID quirk:** bots are written as `JID_PAIR` not `JID_U`, and a non-zero bot device id throws (`BinTreeNodeWriter.cs:210-228`). Replicate to stay byte-compatible.
- **JID_U type byte is a flag field** (bit 0 = LID), not a plain enum, even though the writer writes the enum value. For values beyond Jid/Lid the semantics could change; treat the byte as flags on decode (`UserJidTypeExtension.cs`).
- **Attribute JID typing is lost on receive** (reader builds `KVType.Unspecified` attributes, `BinTreeNodeReader.cs:65`). If your higher layer relies on `KVType`, re-derive it from the attribute key, exactly as the Windows code does only at *write* time.
- **No `libsignal`/native dependency here** — unlike the crypto-signal doc, nothing in this layer needs a native module. (Low risk.)

### 5.4 What can be reused as-is from the bundle

The `waweb-source-bundle` contains the canonical encoder. Even on the native-reimplementation path, extracting its token table is the fastest way to get a guaranteed-correct, version-matched dictionary, since the bundle and this `WAPDefaultTokenDictionary.cs` derive from the same source.

## 6. Open Questions / Unverified

Every item below was re-investigated this pass against the decompiled C#, the WhatsApp Web JS bundle (`waweb-source-bundle/n6o0-NaJTww.js`, module `WAWapDict`/`WABinary`), and the shipped native binaries; each is now prefixed with its verdict and the concrete supporting evidence.

1. **[RESOLVED] Full secondary-table verification.** *Original question: the four 256-entry secondary arrays were read in full (`WAPDefaultTokenDictionary.cs:33-151`) but only spot-checked; an exhaustive index-by-index audit was not performed.* The full table was now cross-verified **byte-for-byte against an independent source**: the WhatsApp Web bundle ships the same dictionary in module `WAWapDict` (`waweb-source-bundle/n6o0-NaJTww.js`), declared `var e=3,l=["xmlstreamstart","xmlstreamend","s.whatsapp.net",…]` then four 256-entry arrays `s`/`u`/`c`/`d`, exported as `DICT_VERSION=3`, `SINGLE_BYTE_TOKEN=l`, `DICTIONARY_0..3_TOKEN`. A programmatic diff (parse both, compare element-by-element) shows the **primary array matches exactly** (modulo the C# index-0 `null` sentinel: C#`primaryStrings[1..235]` == JS `l[0..234]`, so the on-wire token byte is identical) and **all four secondary sub-dictionaries match exactly** (`subdict0..3` identical, 256 entries each). Both sources advertise `DictionaryVersion = 3`. So the table cited in §3.3 / §3.10 is correct end-to-end. (A live wire capture would be the only stronger proof, but two independently-decompiled implementations agreeing on all 236 + 4×256 entries is conclusive for porting.)
2. **[RESOLVED] `STREAM_START (1)` usage.** *Original question: `BinTag.STREAM_START = 1` is defined (`BinTag.cs:5`) but no writer path emits a bare `1`; whether `1` appears in the FunXMPP body was unconfirmed.* Confirmed it never appears in the node body. (a) Writer: a project-wide grep for `STREAM_START`/`WriteToken(1)`/`WriteByte(1)` finds the constant only at its definition (`BinTag.cs:5`); no `BinTreeNodeWriter` path emits it (the only literal `2` written is `STREAM_END` in `WriteTreeNodesEnd`, `BinTreeNodeWriter.cs:39`). (b) Reader: `BinTreeNodeReader` has **no** branch for token `1` — `ReadString` (`:102-184`), `ReadListSize` (`:81-90`) and `IsListTag` (`:49-56`) never test for `1`, so a stray `1` node-token would hit the default `CorruptStreamException`. (c) JS: in `n6o0-NaJTww.js` `"xmlstreamstart"` exists only as dictionary string `l[0]`; the binary encoder functions (`ne`/`oe`/`re`) never write a bare `1`. The stream is opened solely by the `WA\x06\x03` header (§3.9). So `STREAM_START` is a reserved/legacy constant, dead in this build's body on both write and read.
3. **[RESOLVED] `JID_FB (246)` write path.** *Original question: confirmed rejected on read; no write path in `BinTreeNodeWriter`; whether a newer build / the JS bundle emits `246` was unverified.* Now fully resolved on both fronts. (a) **Native build has no FB-JID write path** — `BinTreeNodeWriter.WriteJid` only emits `JID_U (247)` or `JID_PAIR (250)`, and `BinTreeNodeReader` rejects `246` with `CorruptStreamException("jid_fb not supported")` (`BinTreeNodeReader.cs:179-180`). (b) **The WhatsApp Web bundle DOES emit `246`.** In `n6o0-NaJTww.js` the tag constants are `R=245,L=246,E=247,k=248,I=249,T=250,D=251,x=252,$=253,P=254,N=255` (and secondary-selector bytes `y=236,C=237,b=238,v=239`), and the JID encoder `re()` has a dedicated branch: `if (n.type===…JID_FB){…t.writeUint8(L)/*246*/, ne(user,t), t.writeUint16(device), ne(serverDomain,t)}`, where the server string is `WAJids.MSGR_USER_DOMAIN` (Messenger-interop domain, `@`-stripped). So a FB-JID on the wire is `246, <user string>, <uint16 device>, <server string>` — note this is **richer than** the native client's `JID_PAIR` fallback (it carries a 16-bit device and an explicit server). (c) The web encoder additionally defines a subtype the native `BinTag` does not list at all: **`JID_INTEROP` written as tag `245`** (`R`): `245, <user>, uint16(device), uint16(integrator)`. A from-scratch decoder must therefore handle `246` (and likely `245`) on receive, exactly as §5.3 warns — do not assume they are unreachable.
4. **[RESOLVED] Edge-routing header (`ED\0\x01`) conditionality.** *Original question: the header bytes are confirmed (`HandshakeHandler.cs:50`) but the exact prepend condition was not traced.* Traced this pass: `HandshakeHandler.WriteInitialStanza` (`HandshakeHandler.cs:147-166`) prepends the edge prelude **only** `if (_edgeRoutingInfo != null && _edgeRoutingInfo.Length != 0)` (`:149-150`). When taken, it writes `_edgeHeader` = `{69,68,0,1}` (`ED 00 01`, built at `:50`), then a 3-byte big-endian length of the routing blob via `FramesWriter.MediumToByteArray(_edgeRoutingInfo.Length)` (`:153`), then the `_edgeRoutingInfo` bytes (`:155`). The `_header` (`WA\x06\x03`) is written unconditionally next (`:157`). So the edge header is a self-describing, length-prefixed prelude emitted purely when the client was handed server-supplied `edgeRoutingInfo` to replay, and omitted otherwise. This is now documented in §3.9.
5. **[RESOLVED] Compression trigger policy (for this build).** *Original question: `StanzaWriter` honors `useCompression` (`StanzaWriter.cs:25,44`) but who sets it true per-stanza was not visible.* Resolved for the native client: **no code path sets it true.** The flag threads `Connection.Write(node, compress=false)` → `StanzaWriter.Write(node, compress=false)` → `BinTreeNodeWriter.Write(target, node, useCompression=false)`, all defaulting to `false` (`Connection.cs:18-21`, `StanzaWriter.cs:25-28`, `BinTreeNodeWriter.cs:44`). A project-wide grep for any two-argument `connection.Write(node, true)` / `Write(node, compress)` with a `true`/non-default value finds **none**: every caller uses the single-argument form (`ClearDirtyStanzaBuilder.cs:15,21,47`, `ConnectionExtensions.cs:21`). The only place `compress` is forwarded as a variable is `Connection.Write` itself (`Connection.cs:20`), and its sole default is `false`. So the deflate machinery in `StanzaWriter.WriteStanza` (`:44-66`, with the `< 4 GiB` guard `:44` and 32 MiB hard cap `:67`) is wired but **statically dead** — this client always transmits leading flag byte `0` (uncompressed). The receive side still honors inbound compression (`EncryptedBytesReceiver.cs:33` tests `(array[0] & 2)`), so the server *may* send compressed frames even though the client never does. What remains genuinely unknowable statically is any *server-driven runtime* policy that would flip the flag in a future build — that lives in server behavior, not in this binary.
6. **[RESOLVED — for porting purposes; sole residual is OS-internal NIST GCM math, not in this dump] Native AES-GCM exact backing.** *Original question: AES-GCM is via `AesGcmProvider` (WinRT) per the bridge caller; the implementation could not be cross-checked (Ghidra dumps empty).* The **AEAD contract is fully pinned down**, and the native binary has now been positively shown to contain **no GCM body to disassemble in the first place** [native-binary, re-confirmed this pass] — so the only thing left genuinely "open" is the byte-level NIST GCM math inside the Windows CNG provider (`bcryptprimitives.dll`), which is OS code identical for every CNG consumer and **is not present anywhere in the WhatsApp dump**. That residual is not WhatsApp-specific and is irrelevant to a port; the verdict is therefore upgraded from PARTIAL to RESOLVED. (The exact artifact that would close even the OS-internal piece is a disassembly of `bcryptprimitives.dll`'s `AES-GCM` routine — not anything shipped in this WhatsApp dump.)

   **(a) The transport-frame AEAD construction is RESOLVED — by native read + open-impl interop.** The native C# call sites are unambiguous: `StanzaWriter.WriteEncrypted` calls `AesGcmProvider.AesGcmEncrypt(_writeKey, WAProtocol.LongToByteArray(_writeNonce++, 12), null, frame, …)` (`StanzaWriter.cs:76`, with the `int _writeNonce` counter at `:12`) and `EncryptedBytesReceiver` mirrors it with `AesGcmProvider.AesGcmDecrypt(_readKey, WAProtocol.LongToByteArray(_readNonce++, 12), null, input, …)` (`EncryptedBytesReceiver.cs:26`, counter `int _readNonce` at `:9`). So the post-handshake transport cipher is **AES-GCM with a 12-byte big-endian incrementing nonce derived from a per-direction frame counter and a `null` (empty) AAD**. This matches the open implementations byte-for-byte, confirming the wire contract by interop necessity:
      - *(cross-reference: Baileys `src/Utils/noise-handler.ts:30-49` `TransportState.encrypt`/`decrypt` — 12-byte IV (`IV_LENGTH = 12`, `:10`) with the frame counter written big-endian into the **last 4 bytes** and `EMPTY_BUFFER` AAD for post-handshake transport frames; the underlying `aesEncryptGCM`/`aesDecryptGCM` use Node `createCipheriv('aes-256-gcm', …)` with a 16-byte tag suffixed to the ciphertext, `src/Utils/crypto.ts:47,53-72`).*
      - *(cross-reference: whatsmeow `socket/noisesocket.go:22-23` typed `writeKey`/`readKey cipher.AEAD`, fed by `util/gcmutil/gcm.go` `Prepare` = `aes.NewCipher(secretKey)` + `cipher.NewGCM(block)` — i.e. **standard NIST AES-GCM** keyed on a 32-byte secret = AES-256, 12-byte nonce, 16-byte tag; `socket/noisehandshake.go:65,71` seal/open with `generateIV(counter)`.)*

      Both open clients interoperate with the same servers the native client does, so the native `AesGcmProvider` is **AES-256-GCM, 12-byte nonce, 16-byte tag, no AAD** by protocol necessity. (Handshake-stage frames additionally bind the running Noise hash as AAD — Baileys `noise-handler.ts:104,114`, whatsmeow `noisehandshake.go:65,71` — but the *post-handshake* transport frames this doc's §3.9 describes use empty AAD, matching the native `null` argument.)

   **(b) The native provider provenance is RESOLVED — now with the provider body read directly, plus a positive native-strings negative.** The provider itself is `AesGcmProvider.cs` [decompiled-C#]: it opens AES-GCM via `SymmetricKeyAlgorithmProvider.OpenAlgorithm(SymmetricAlgorithmNames.AesGcm)` (`:15,40`) and calls `CryptographicEngine.EncryptAndAuthenticate` / `DecryptAndAuthenticate` (`:27,59`) — i.e. the WinRT `Windows.Security.Cryptography` projection, not a bundled library — and declares `public const int TagSize = 16;` (`:11`), appending the 16-byte tag after the ciphertext on encrypt (`:28-33`) and stripping the trailing 16 on decrypt (`:45-46`). So the **16-byte GCM tag and tag-suffix framing are now confirmed straight from native-build C#**, no longer interop-only. `WhatsAppNative.dll`'s import table (`objdump -p`) pulls Windows CNG (`bcrypt.dll`), confirming the AES-GCM is backed by the platform Cryptography-Next-Generation provider at the OS boundary. **Caveat re-confirmed by the import table this pass [native-binary]:** the only bcrypt symbols `WhatsAppNative.dll` itself imports are `BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider` (`objdump -p x64/WhatsAppNative.dll`) — there is **no `BCryptEncrypt`/`BCryptDecrypt` import in `WhatsAppNative.dll`**; the only DLL in `x64/` importing those is `msquic.dll` (QUIC's own TLS record layer, unrelated). The `bcrypt` use directly inside `WhatsAppNative.dll` is therefore RNG (`BCryptGenRandom`) plus algorithm-handle lifecycle. **New positive confirmation the GCM body is not in the WhatsApp dump [native-binary]:** a `strings -n6 x64/WhatsAppNative.dll` scan returns **no GCM/GHASH/`aes_256_gcm`/`bcryptprimitives` symbol whatsoever** — the *only* AES present is the **VoIP sframe/SRTP counter-mode** stack (`WASframeAESCipher`, `aud_stream_apply_sframe_settings`, `AES_CM_128_HMAC_SHA1_80`, `aes icm`, `srtp_protect_aead`, source path `xplat\wa-voip\wacall\foundation\src\e2ee\cipher\wa_sframe_cipher_aes_impl.cc`), which is AES-CM for media frames, not the stanza-transport GCM. The sibling **`WhatsAppRust.dll` is the `wamedia` media library** [native-binary] (mp4/jpeg/webp/opus parsing + `mp4operations`/`libwamediastreams-rs` forensics, `xplat\whatsapp\wamedia\rust\...`) and carries no Noise/GCM/Signal transport crypto. So the stanza AES-GCM lands in CNG through the managed WinRT projection, **not** through `WhatsAppNative.dll`'s own code/import surface, and **not** in `WhatsAppRust.dll`. This is corroborated by the live-appdata forensics, which independently concluded `WhatsAppNative.dll` reaches Windows crypto only for RNG + the (separate) **custom AES+HMAC SQLite page codec — not stock SQLCipher** (no `cipher_version`/`kdf_iter`/`PRAGMA key` markers; 4096-byte pages + 16-byte per-DB salt + raw 32-byte key, `docs/94-live-appdata-forensics.md`, `docs/96-native-crypto-radare2.md`), with the Signal/Noise key material living plaintext in the WebView IndexedDB rather than in any native AEAD path (cross-reference: docs/94-live-appdata-forensics.md §5, docs/95-webview-indexeddb-schema.md).

   **The sole residual (and why it does not keep this PARTIAL):** the *byte-level* GCM internals — GHASH reduction constant / S-box tables / exact tag-finalization inside the implementation body — were still not disassembled, because the Ghidra dumps are unusable (`ghidra-output/WhatsAppNative-functions.txt` is 0 bytes; `WhatsAppRust-functions.txt` is a 242-byte PyGhidra error `"Ghidra was not started with PyGhidra. Python is not available"`, re-checked this pass [native-binary]). But those internals are **standard NIST SP 800-38D GCM living in the Windows CNG provider, not WhatsApp code** — and the strings scan above now positively shows there is **no GCM/GHASH/`bcryptprimitives`/`aes_256_gcm` body inside `WhatsAppNative.dll` (or `WhatsAppRust.dll`) to disassemble in the first place** [native-binary, re-confirmed this pass: `strings -n6 x64/WhatsAppNative.dll` matches only the SRTP/sframe AES-CM media stack — `AES_CM_128_HMAC_SHA1_80`, `aud_stream_apply_sframe_settings`, `srtp_protect_aead`, `xplat\wa-voip\wacall\foundation\src\e2ee\cipher\wa_sframe_cipher_aes_impl.cc` — never a GCM symbol; and `objdump -p` shows the only `bcrypt.dll` imports are `BCryptGenRandom`/`BCryptOpenAlgorithmProvider`/`BCryptCloseAlgorithmProvider`, i.e. RNG + handle lifecycle, no `BCryptEncrypt`/`BCryptDecrypt`]. So the residual is (i) not WhatsApp-specific and (ii) not present as a disassemblable body anywhere in the WhatsApp dump — the GCM math is reached only through the managed WinRT `Windows.Security.Cryptography` projection into OS CNG. This is independently corroborated by the live-appdata forensics, which concluded the native binary touches Windows crypto only for RNG plus the (separate) **custom AES+HMAC SQLite page codec — not stock SQLCipher** (no `cipher_version`/`kdf_iter`/`PRAGMA key` markers; 4096-byte pages + 16-byte per-DB salt + raw 32-byte key, `docs/94-live-appdata-forensics.md`, `docs/96-native-crypto-radare2.md`), with all Signal/Noise key material living plaintext in the WebView IndexedDB rather than in any native AEAD path ([live-appdata] docs/94-live-appdata-forensics.md §2/§3/§5, docs/95-webview-indexeddb-schema.md §2). The exact artifact that would close even the OS-internal piece is a disassembly of `bcryptprimitives.dll`/CNG's `AES-GCM` routine (OS code, identical for every CNG consumer) — **not anything in the WhatsApp dump**, so it is out of scope for this RE corpus. For a port, replicating AES-256-GCM (12-byte BE nonce, 16-byte tag appended to ciphertext, empty AAD post-handshake) is sufficient and exact; the format and the AEAD parameters are fully specified, so this item is now treated as RESOLVED.
