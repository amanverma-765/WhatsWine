# 13. The Smax Stanza Framework & Code Generation

> Target: Meta native WhatsApp for Windows (WhatsApp.Root.exe, WinUI 3 / Windows App SDK, v2.2607.106.0).
> All paths in this document are **relative to `decompiled_source/`** unless noted otherwise.
> Citations are `path:LINE` for code actually read. Anything not directly observable in the C# is explicitly labelled **(inference)**.

---

## 1. Purpose & Scope

"Smax" is WhatsApp's **schema-driven stanza framework**: a small hand-written runtime support library plus a *very large* body of machine-generated C# that turns a declarative stanza spec into strongly-typed builders (outgoing) and parser/validators (incoming) over the FunXMPP `ProtocolTreeNode` model.

Concretely the framework has three layers:

1. **The node model** — `ProtocolTreeNode` / `ProtocolKeyValue` / `ProtocolTreeNodeBuilder` (`WhatsApp.Networking.Nodes`): the in-memory representation of one WhatsApp XMPP element and the fluent builder used to assemble one. This is the data type every Smax class produces or consumes.
2. **The Smax runtime library** — `SmaxStandardLibrary`, `SmaxError`, `SmaxAssert`, `BiDictionary<K,V>` (`WhatsApp.Networking.Smax`): the validation/extraction primitives that generated parser code calls (`TryGetRequired*`, `TryGetChildren`, `CopyKeyValue`, `Validate*`, JID casting), plus the error/enum support types.
3. **The generated stanza families** — `WhatsApp.Smax.Generated.<Domain>.{Outgoing,Incoming}` (510 generated `.cs` files across 11 domains): one C# class per stanza/sub-element/mixin defined in the upstream Smax spec.

In addition there are two **hand-written** stanza factories that live alongside Smax and produce the same `ProtocolTreeNode` type for stanzas the spec doesn't cover: `AckStanzaBuilder` and `ClearDirtyStanzaBuilder` (`WhatsApp.Networking.StanzaBuilders`).

**Scope boundary (important).** Smax is a *self-contained library inside `WhatsApp.Networking.dll`*. A grep across all decompiled assemblies shows the only code referencing `WhatsApp.Smax.Generated.*` is `WhatsApp.Networking` itself (the single non-generated consumer is `WhatsApp.Networking.StanzaBuilders/ClearDirtyStanzaBuilder.cs`); there are **no callers in `WhatsApp.Root` or `WhatsApp.VoIP`** — confirmed by a cross-assembly search for every generated request type name (zero hits outside the generated namespaces and `ClearDirtyStanzaBuilder`). In fact the generated families are **compiled-but-dormant in this build**: no generated `*Handler.HandleResponse` is invoked anywhere, and even the lone in-tree consumer's entry points (`IConnection.SendClearDirty`/`SendClearDirtyForSyncdAppState`) have no callers in the dump (see §3.8, §6 item 2). This is consistent with the native side only processing `iq`/`success`/`failure` top-level stanzas (see `WhatsApp.Root/WhatsApp/WAProtocol.cs`, §3.9) while `message`/`receipt`/`notification`/`presence`/`chatstate` business logic lives in the WebView2 JS bundle. Notably the **same upstream Smax spec also generates that JS bundle's stanza layer**: the bundle ships parallel `WASmax*` modules (e.g. `WASmaxGroupsGetGroupInfoRPC`, `WASmaxChatstateClientNotificationRPC`, and one-of `…MixinGroup` modules) emitted by a `.smax(...)` JSX builder (`WASmaxJsx`) — so these dormant C# families and the live JS families are two emitter outputs of one declarative spec (§3.10, §6 item 1). The generated families are therefore best understood as the **typed schema surface the native networking layer *could* use** — and as a near-complete, free, machine-readable inventory of WhatsApp's IQ stanza grammar that a port can mine directly.

---

## 2. Where It Lives

### 2.1 Node model — `namespace WhatsApp.Networking.Nodes`
| File | Role |
|---|---|
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolTreeNode.cs` | Sealed in-memory stanza element (`tag`/`attributes`/`children`/`data`) + typed accessors. |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolKeyValue.cs` | One attribute (`key`,`value`,`KVType`) with JID-type validation. |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolTreeNodeBuilder.cs` | Fluent builder + `Merge` (the mixin engine). |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolNodeValueParser.cs` | Unix-timestamp parsing helper. |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolKeyValueExtensions.cs` | `DistinctByKey` attribute de-dup. |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Nodes/ProtocolNodeExtensions.cs` | `TagEquals` / `TagEqualsAny`. |

### 2.2 Smax runtime — `namespace WhatsApp.Networking.Smax`
| File | Role |
|---|---|
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Smax/SmaxStandardLibrary.cs` | 846-line validation/extraction runtime called by every generated parser. |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Smax/SmaxError.cs` | Error wrapper (the `Right` side of `Either<T,SmaxError>`). |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Smax/SmaxAssert.cs` | Debug-assert hook (`DebugFail`, no-op in release). |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.Smax/BiDictionary.cs` | Two-way enum↔wire-string map used by `…EnumExtension` classes. |

### 2.3 Functional support (consumed by Smax) — `namespace WhatsApp.Core.Utils.Functional`
| File | Role |
|---|---|
| `decompiled/WhatsApp.Core/WhatsApp.Core.Utils.Functional/Either.cs` | `Either<TLeft,TRight>` result type; `Left`=parsed value, `Right`=`SmaxError`. Provides `IsLeft`, `TryGetLeft/Right`, `Select`, `SelectLeft`, `Match`. |

### 2.4 Hand-written stanza factories — `namespace WhatsApp.Networking.StanzaBuilders`
| File | Role |
|---|---|
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.StanzaBuilders/AckStanzaBuilder.cs` | Builds `<ack class="notification">` echoing an inbound notification. |
| `decompiled/WhatsApp.Networking/WhatsApp.Networking.StanzaBuilders/ClearDirtyStanzaBuilder.cs` | Builds `<iq xmlns="urn:xmpp:whatsapp:dirty">`; the one place a generated Smax family (`DirtyBits.Outgoing`) is used in-tree. |

### 2.5 Generated families — `namespace WhatsApp.Smax.Generated.<Domain>.{Outgoing,Incoming}`
510 `.cs` files (counted via `find WhatsApp.Smax.Generated.* -name '*.cs' | wc -l`). Per-family file counts (directory listing under `decompiled/WhatsApp.Networking/`):

| Domain | Outgoing | Incoming |
|---|---:|---:|
| Blocklists | 23 | 48 |
| Bot | 4 | 36 |
| Chatstate | 9 | — |
| DirtyBits | 7 | 12 |
| Groups | 50 | 212 |
| Offline | — | 7 |
| Pings | 1 | 1 |
| PreKeys | 14 | 27 |
| Presence | 6 | 9 |
| Tos | 13 | 29 |
| UnifiedSession | 2 | — |

(Asymmetry is real: e.g. `Chatstate`/`UnifiedSession` are write-only from the client; `Offline` is read-only.)

### 2.6 Provenance of the generated code
Every generated parser embeds the original Windows build path in its `FailuresService.Investigate(...)` call, revealing the source tree layout, e.g.:
`"D:\\full-fbsource\\whatsapp\\windows\\Samples\\WinUI\\WebView2\\WhatsApp.Networking\\Smax\\Generated\\Groups\\Incoming\\GetGroupInfo\\GetGroupInfoResponseSuccess.cs"`
(`WhatsApp.Smax.Generated.Groups.Incoming/GetGroupInfoResponseSuccess.cs:63`). So upstream the codegen output is organised `Smax/Generated/<Domain>/<Direction>/<StanzaName>/<Class>.cs`; the decompiler flattened it into one directory per `<Domain>.<Direction>` namespace.

---

## 3. How It Works

### 3.1 The node model: `ProtocolTreeNode`

A stanza element is a sealed class with four public fields (`ProtocolTreeNode.cs:13-19`):

```csharp
public string tag;
public ProtocolKeyValue[] attributes;
public ProtocolTreeNode[] children;
public byte[] data;
```

Invariant: **a node has either `children` or `data`, never both.** The five constructors enforce this by routing through `Init(tag, attrs, childNodes=null, dataBytes=null)` (`ProtocolTreeNode.cs:288-294`); the string-data ctor UTF-8-encodes after `ConvertLineEndings()` (`ProtocolTreeNode.cs:36-39`); `attributes` defaults to `Array.Empty<ProtocolKeyValue>()` (`:291`). The builder side re-asserts the invariant: `AddChild`/`AddChildren` `DebugFail` if `data != null` (`ProtocolTreeNodeBuilder.cs:53-56,73-76`) and `AddData` `DebugFail`s if children exist (`:120-123,131-134`).

**Typed accessors** (used both by application code and by `SmaxStandardLibrary`):
- `GetDataString()` → UTF-8 decode of `data` or null (`:46-53`).
- `GetAttribute(key)` linear scan (`:70-85`); `GetAttributeValue` (`:87-90`).
- numeric getters `GetAttributeInt/UInt/Long/Ulong/Bool` parse the string value, returning nullable on parse failure (`:99-189`).
- `GetMandatoryAttributeLong` logs via `FailuresService.Investigate` when absent (`:151-159`).
- `GetAttributeJid<T>(key)` → `JidFactory.CreateNewJid(value) as T`; explicitly warns to use `GetAttributeDeviceJid` for `DeviceJid` because the generic path would create a `UserJid` for the primary device (`:191-214`).
- `GetChild(tag)` returns the **last** matching child (loop overwrites `result`, `:243-258`), `GetChild(int i)` indexed (`:260-267`), `GetAllChildren(tagName)` filters via `TagEquals` (`:269-272`).
- `Merge(other)` delegates to `new ProtocolTreeNodeBuilder(this).Merge(other).Build()` (`:283-286`).

Note `ToLogStanza()` returns `""` in this build (`:296-299`) and `LogStanza` is `[Conditional("DEBUG")]` (`:301`) — stanza contents are not logged in release.

### 3.2 Attributes & JID typing: `ProtocolKeyValue`

`ProtocolKeyValue` is `(string key, string value, KVType kvType)` (`ProtocolKeyValue.cs:39-43`). `KVType` is a **flag enum** whose numeric values encode *which JID variants are acceptable* for the attribute (`:9-33`), e.g. `Jid=2`, `UserJid=6`, `GroupJid=10`, `DeviceJid=34`, `NewsletterJid=66`, composite values like `UserJidOrDeviceJid=38`, `StatusJidOrBroadcastlistJidOrGroupJidOrDeviceJidOrNewsletterJid=634`. The low bit distinguishes JID vs not-a-JID:
```csharp
public static bool IsJidType(KVType k)    => (k & KVType.Jid)    == KVType.Jid;     // bit 1  (:109-112)
public static bool IsNotAJidType(KVType k)=> (k & KVType.NotAJid)== KVType.NotAJid; // bit 0  (:114-117)
```
The 3-arg ctor validates the value string against the declared type via `IsValidForType` (a switch dispatching to `JidChecker.IsValid*JidString`, `:119-143`); failure constructs an `InvalidJidException` but **never throws it** (`:64-72`, allocation at `:69`). This is a real source behavior, not a decompiler artifact: the same constructor chain throws normally where intended — the 2-arg base ctor does `throw new NullReferenceException(...)` (`:58`) — and `BinTreeNodeWriter` allocates the identical `InvalidJidException` purely as a telemetry payload for `MaybeSendClb` without throwing (`BinTreeNodeWriter.cs:145-146,169-170`). So a typed-attribute validation failure is **advisory**: the malformed value is accepted, matching the lenient outbound posture described in §3.4/§5. Convenience ctors exist for each JID class (`:74-107`) and two cached singletons `ToServer = ("to","s.whatsapp.net",Jid)` / `ToGroup = ("to","g.us",Jid)` (`:35-37`). This is what later drives compact JID encoding in `BinTreeNodeWriter` (the writer can emit `JID_PAIR`/`JID_U` tokens because the attribute is typed). The linkage is verified in code: `WriteAttributes` forwards `attributes[i].kvType` into `WriteValueString` (`BinTreeNodeWriter.cs:106`), whose **first branch** is `if (ProtocolKeyValue.IsJidType(keyValueType))` → split the value on `'@'` and emit via `WriteJid(user, server)` (`:111-126`); non-JID values fall through to the token dictionary (`tokenMap.TryGetToken`, `:128-135`) or raw UTF-8 (`:140`). Note the dispatch keys only on the low-bit `IsJidType` test — the individual composite variants (`UserJidOrDeviceJid`, `GroupCallJidOrUserJid`, …) all collapse to the same `WriteJid` path; they are not separately tokenized at write time.

### 3.3 The builder & the merge engine: `ProtocolTreeNodeBuilder`

The builder holds a `tag`, `List<ProtocolTreeNode> children`, a `Dictionary<string,ProtocolKeyValue> attributes` (keyed by attr name → **last writer wins / de-dup by key**), and optional `data` (`ProtocolTreeNodeBuilder.cs:10-16`). Fluent API: `AddChild(ren)`, `AddStringAttribute` (wraps `NotAJid`, `:85-89`), `AddIntAttribute` (`value.ToString()` as `NotAJid`, `:91-95`), `AddAttribute(ProtocolKeyValue)`, `AddData(byte[]|string|long)`. `Build()` collapses empty attr/child collections to null and picks the data-ctor vs children-ctor (`:157-174`).

**`Merge` is the core of the mixin mechanism** (`:145-155`). It is what lets a parent stanza pull a *mixin* fragment's tag/attrs/children/data into itself:
- `CheckTag` (`:176-186`): if the builder's tag is the sentinel `"smax:any"` it **adopts** the incoming node's tag; otherwise a tag mismatch (and the other isn't `"smax:any"`) is a `DebugFail`. This is why outgoing **attribute mixins** are built with tag `"smax:any"` (see §3.6) — they have no tag of their own and inherit the host's.
- `MergeAttributes` (`:188-207`): adds attributes that aren't already present; a conflicting *value* for an existing key is `DebugFail`.
- `MergeChildren` (`:218-268`): groups children by tag on both sides, checks per-tag counts are compatible (`childCountsAreCompatible`, `:288-298`), then recursively `Merge`s matching children pairwise and appends the rest. This recursive descent means mixins can themselves merge nested structure.
- `MergeData` (`:270-286`): refuses to mix data with children; conflicting data bytes are `DebugFail`.

### 3.4 The Smax runtime library: `SmaxStandardLibrary`

A fresh `SmaxStandardLibrary` is instantiated per parse/build (`new SmaxStandardLibrary()` appears at the top of essentially every generated `Create`). It holds a single mutable `string? ParseError` (`SmaxStandardLibrary.cs:14`); every `TryGet*` returns `bool` and, on `false`, leaves a human-readable diagnostic in `ParseError` which the generated caller wraps as `new SmaxError(smax.ParseError)`.

**Path arrays.** Almost every primitive takes a `string[] pathArray`. The convention is: all but the last element are **child tags to descend through**, and the last element is the **attribute name** — unless it begins with `'#'`, in which case it means "the element's text/`data` value" rather than a named attribute. This `'#'` convention is implemented identically across the string/byte/long getters:
```csharp
string text  = pathArray.Last();
string[] pathArray2 = pathArray.Take(len-1).ToArray();
TryGetRequiredChildNode(node, pathArray2, out child);
var v = (text[0] == '#') ? child.GetDataString() : child.GetAttributeValue(text);   // :169-176, :309-316
```
`TryGetRequiredChildNode` walks `pathArray` via `GetChild`, setting `ParseError = "Required child <X/> missing for tag <Y/> in the path 'a.b.c'"` on the first miss (`:27-43`). `joinPath` renders `tag.a.b.c` for diagnostics (`:824-832`).

**Attribute getters** — each has `Required`/`Optional` variants and a uniform parameter set `(node, pathArray, bool isReference, expected, lowerBound, upperBound, out result)`:
- `…StringAttributeValue` (`:143-208`): optional returns null if absent; bounds are **string length** checks; `isReference:true` means "this attribute must equal `expected`" (used to bind a response's `id` back to the request's `id` — see §3.5); `expected` non-null without `isReference` is also an equality check.
- `…ByteArrayAttributeValue` (`:210-281`): binary may only come from an element value (`text[0]=='#'`), else `"Cannot have binary not contained in an element value"`; bounds are byte-length.
- `…LongAttributeValue` (`:283-358`): parses with `long.TryParse` (non-numeric → error), bounds are numeric range. Note the recurring spec bound `±9007199254740991` = 2^53−1 (JS `Number.MAX_SAFE_INTEGER`), e.g. `Pings.Incoming/ClientResponseServerResponse.cs:53`, `Groups.Incoming/GroupInfoAttributesMixin.cs:70` — a direct fingerprint that the spec/codegen targets JS interop.
- `…JidAttributeValue<T>` (`:360-428`): reads via `GetAttributeJid<Jid>` then `CastJid<T>`; supports reference/equality semantics including the XOR null-check `(val==null) ^ (expected==null)`.

**Enums.**
- `TryGet{Optional,Required}StringEnumValue(node, string[] cases, …)`: string attribute must be one of `cases` (`:505-523,545-560`).
- `TryGet{Optional,Required}LongEnum<T>`: numeric attribute mapped to a `[Flags]`-style `Enum` via `Enum.IsDefined`/`Enum.ToObject` (`:525-578`).
- `TryGet{Optional,Required}JidEnum(node, IEnumerable<Func<Jid,Jid?>> castFunctions, …)`: tries each cast function until one returns non-null, else `"Unexpected JID type"` (`:580-630`).

**Children.**
- `TryGetChildren<T>(node, pathArray, createFunction, out List<T>)` (`:45-84`): descends `pathArray[0..n-2]`, then for the last tag selects **all** matching children and runs the per-child `createFunction` (an `Either<T,SmaxError>`-returning factory — i.e. the child class's own `Create`); any child error aborts the whole list. The `min/max` overload adds count bounds (`:96-116`).
- `TryGetRequiredChild`/`TryGetOptionalChild` are `min/max = (1,1)` / `(0,1)` wrappers (`:118-141`).

**Mixins** (the parser-side counterpart to builder `Merge`):
- `TryGetRequiredMixin`/`TryGetOptionalMixin` (`:430-461`): run a single mixin `createFunction` **against the same node** (path usually `Array.Empty<string>()`), folding its attributes/children into the parent's typed result. (Optional mixin swallows the error: absence is allowed.)
- `TryGetRequiredMixinGroup`/`TryGetOptionalMixinGroup` (`:463-503`): try a *list* of mixin factories and take the **first that succeeds** — this is the discriminated-union ("one-of") primitive. The required form concatenates all per-alternative error messages on total failure.

**Copy helpers** (used by ack/echo builders):
- `CopyKeyValue(node, pathArray, newName, required)` (`:632-673`): reads an attribute (or `#` element value) and returns a **new** `ProtocolKeyValue(newName, value, originalKvType)` — preserving JID typing. Missing+required → `_assert.DebugFail`. This is how `Tos.Outgoing/AcceptanceChangeNotificationResponseAck.cs:14-17` rebuilds an ack from the request: `from→to`, copy `id`/`type`.
- `CopyElementValue` (`:675-708`): same idea returning raw `byte[]`.

**Build-time validators** (no node, just assertions over already-extracted values, called by outgoing builders to enforce spec bounds): `ValidateString`, `ValidateLong`, `ValidateBinary`, `ValidateChildren`, `ValidateNullability`, `ValidateJidEnum` (`:710-805`). e.g. `PreKeys.Outgoing/SetRequestListKeyValue.cs:14` calls `ValidateBinary(elementValue, 32L, 32L)` — a prekey public value is exactly 32 bytes.

**`CastJid<T>`** (`:807-822`) encodes the UserJid↔DeviceJid duality: a `DeviceJid` with `DeviceId==0` casts down to its `UserJid`; a `UserJid` casts up to `DeviceJid(user,0)`. This makes `from`/`participant` attributes interchangeably matchable as user or primary-device JIDs.

`SmaxAssert.DebugFail` is an empty virtual (`SmaxAssert.cs:5-7`) — in release builds, build-time validation failures are **silent** (the generic `DebugFail<T>` just returns null, `:9-13`). So outgoing-side spec violations do not throw; they degrade to a possibly-malformed node.

### 3.5 Generated **Incoming** parser shape (the universal pattern)

Every incoming class is `sealed`, exposes readonly typed properties + a `ProtocolTreeNode Node`, has a `private` ctor, and a `public static Either<TSelf,SmaxError> Create(ProtocolTreeNode node, <Request> request=…, bool logFailure=true)`. The body is a fixed template (see `Pings.Incoming/ClientResponseServerResponse.cs:30-67` and `Groups.Incoming/GetGroupInfoResponseSuccess.cs:29-67`):

1. `var smax = new SmaxStandardLibrary();` and (for responses) `var requestNode = request.Node;`.
2. `if (!smax.TryCheckNodeTag(node, "iq")) return new SmaxError(smax.ParseError);` (`TryCheckNodeTag`, `SmaxStandardLibrary.cs:86-94`).
3. A linear sequence of `TryGet*` calls, **each guarded** `if (!…) return new SmaxError(smax.ParseError);`. Order: attributes, then children, then mixins.
4. **Request/response correlation** is encoded structurally, not by a tracker: the parser first reads the *request's* `id` (`TryGetRequiredStringAttributeValue(requestNode, ["id"], isReference:false, …, out reqId)`), then asserts the *response's* `id` matches it via `isReference:true, expected:reqId` (`ClientResponseServerResponse.cs:48-49`; `GetGroupInfoResponseSuccess.cs:48-49`). Likewise a group response's `from` is reference-checked against the request's `to` (`GetGroupInfoResponseSuccess.cs:39-43`). The response `type` is pinned to `"result"` (`:44`).
5. Construct `new TSelf(node, …extracted…)`; on `CorruptStreamException` return `new SmaxError(ex.Message)` and, when `logFailure`, call `FailuresService.Investigate(ex, "Error parsing incoming stanza", "Create", "<upstream-path>")` (`ClientResponseServerResponse.cs:59-66`).

**Handlers / response dispatch.** A `<Stanza>Handler.HandleResponse(responseNode, request, Action<Success>, Action<ClientError>, Action<ServerError>, …)` tries each candidate `Create` in priority order with `logFailure:false`, invokes the matching `Action` and returns `true` on the first `IsLeft`; if all fail it aggregates every `SmaxError.GetMessage()` into one `FailuresService.Investigate` and returns `false` (`Groups.Incoming/GetGroupInfoHandler.cs:11-43`; 4-way variant `JoinInviteLinkHandler.cs:11-52`). This is the generated equivalent of a typed `switch` over success vs the two error shapes.

**Mixins as composition.** A parser class pulls in cross-cutting attribute/child sets by `TryGetRequiredMixin`/`TryGetOptionalMixin`. `GetGroupInfoResponseSuccessGroup.cs:35-39` composes a required `GroupInfoMixin` + optional `DedupAttrsMixin` over the same `<group>` node. `GroupInfoMixin.Create` (`Groups.Incoming/GroupInfoMixin.cs:90-197`) is the heavyweight example: 1 optional attr, a `0..19999` `participant` child list, **20** optional single children (`description`, `locked`, `announcement`, `parent`, `ephemeral`, …), a required `GroupInfoAttributesMixin`, and an optional `GroupMemberAddModeMixin` — each a guarded `TryGet*`.

**One-of via mixin groups.** A `<Name>MixinGroup` is generated as a plain `interface` carrying `ProtocolTreeNode Node` (+ any shared attrs), e.g. `JoinInviteLinkIQErrorMixinGroup` declares `Node`, `string TextAttr`, `long CodeAttr` (`Groups.Incoming/JoinInviteLinkIQErrorMixinGroup.cs:5-12`). Concrete error mixins **implement many such interfaces at once** — `IQErrorItemNotFoundMixin : CancelGroupMembershipRequestsIQError1MixinGroup, GetGroupInfoIQErrorMixinGroup, GetMembershipApprovalRequestsIQErrorMixinGroup, JoinInviteLinkIQErrorMixinGroup, MembershipRequestsActionIQErrorMixinGroup, SetPropertyIQErrorMixinGroup` (`IQErrorItemNotFoundMixin.cs:7`) — so the same `item-not-found` (text pinned to `"item-not-found"`, code pinned to `404`, `:27-34`) is reusable across every group operation. A generated `…MixinGroupExtensions.Match(this group, Action<each concrete>…)` provides exhaustive pattern matching via `is`-type tests, throwing `InvalidOperationException("Unexpected type in match function.")` if none match (`JoinInviteLinkIQErrorMixinGroupExtensions.cs:7-141`). The `TryGetRequiredMixinGroup` first-success semantics (`SmaxStandardLibrary.cs:463-484`) + `Either.SelectLeft` up-cast (`GroupInfoAttributesMixin.cs:98-102`, casting `NamedSubjectMixin`/`UnnamedSubjectFallbackMixin` to the shared `BatchGetGroupInfo2MixinGroup`) implement the union resolution.

### 3.6 Generated **Outgoing** builder shape

Every outgoing class is `sealed`, exposes `ProtocolTreeNode Node { get; }`, a `private` ctor that builds it, and `public static <Self> Create(…)`. The ctor template (`Pings.Outgoing/ClientRequest.cs:10-19`; `Groups.Outgoing/GetGroupInfoRequest.cs:10-20`; `PreKeys.Outgoing/SetRequest.cs:10-25`):

1. `new SmaxStandardLibrary();` (instantiated even when only `ValidateString`/`ValidateBinary` are needed; for many builders it is created and discarded, e.g. `ClientRequest.cs:12`).
2. `var b = new ProtocolTreeNodeBuilder("<tag>");`.
3. Hard-code the **spec-fixed** attributes — this is where the wire grammar is captured verbatim. Examples:
   - Ping: `type="get"`, `xmlns="w:p"`, `to=s.whatsapp.net` (`ClientRequest.cs:14-17`).
   - GetGroupInfo: `xmlns="w:g2"`, `type="get"`, `to=<GroupJid>` (`GetGroupInfoRequest.cs:14-17`).
   - PreKeys SetRequest: `type="set"`, `xmlns="encrypt"`, `to=s.whatsapp.net` (`SetRequest.cs:14-17`).
   - Presence availability: tag `"presence"`, optional `type`/`name` (`Presence.Outgoing/AvailabilityRequest.cs:19-28`).
4. Conditionally add caller-supplied attributes, running `Validate*` first when the spec has bounds (`GetGroupInfoRequestQuery.cs:14-18` validates `phash` length `[10,10]`; `SetRequestListKeyValue.cs:14` validates a 32-byte value).
5. Add children via `b.AddChild(child?.Node)` and fold mixins via `b.Merge(mixin?.Node)` (`SetRequest.cs:18-23` adds 5 children + merges `VerifiedNameMixin`; `GetGroupInfoRequestQuery.cs:19-20` adds `addRequest` child + merges `RequestTypeMixin`).
6. `Node = b.Build();`.

**Attribute mixins** are built on the sentinel tag and merged into the host: `GetGroupInfoRequestTypeAttributeMixin` builds `new ProtocolTreeNodeBuilder("smax:any")` and only sets `request=<enum-string>` (`GetGroupInfoRequestTypeAttributeMixin.cs:27-29`); a wrapper `GetGroupInfoRequestTypeMixin` then `Merge`s it onto a `"query"` node (`GetGroupInfoRequestTypeMixin.cs:13-15`), and the top-level `query` builder merges *that* (`GetGroupInfoRequestQuery.cs:20`). The `"smax:any"` adoption rule in `ProtocolTreeNodeBuilder.CheckTag` (`:178-182`) is what makes this tag-agnostic merge legal.

### 3.7 Enum codegen: `<Enum>Extension` + `BiDictionary`

Spec enums become a nested C# `enum` on the owning class plus a static `…EnumExtension` holding a `BiDictionary<EnumT,string>` of enum↔wire-string and two extension methods:
```csharp
public static string GetValue(this Request key)        // enum → wire string  (:51-55)
public static Request? GetEnum(string? value)          // wire string → enum  (:57-65)
```
(`Groups.Outgoing/GetGroupInfoRequestTypeAttributeMixinRequestEnumExtension.cs:7-65`). The wire strings are the snake-case protocol literals (`"accept_invite_conflict_recovery"`, `"lid_migration"`, `"phash"`, `"prefetch"`, …). `BiDictionary.Add` throws on duplicate key *or* value, guaranteeing the mapping is bijective (`BiDictionary.cs:13-21`). Outgoing builders call `.GetValue()` (`GetGroupInfoRequestTypeAttributeMixin.cs:28`; `AvailabilityRequest.cs:22`); incoming parsers use the `string[] cases` / `LongEnum` library paths.

### 3.8 Hand-written builders alongside Smax

- **`AckStanzaBuilder`** (`AckStanzaBuilder.cs`): not generated. `CreateNotificationOkAckFromNotificationNode(notifyNode, NotificationAck)` reads `type/from/to/participant/id` off the inbound notification (`:18-23`) and builds `<ack to=<from> class="notification" id=… type=…>` with `from`/`participant` re-typed as JIDs (`:38-56`), optionally adding `<sync contacts="in"|"out"/>` for `ContactSyncIn/Out` (`:25-35`). Functionally identical to the **generated** `Tos.Outgoing/AcceptanceChangeNotificationResponseAck` which does the same via `CopyKeyValue` — illustrating the two coding styles converging on one wire shape.
- **`ClearDirtyStanzaBuilder`** (`ClearDirtyStanzaBuilder.cs`): the one in-tree consumer of a generated family. The typed path builds `CleanRequest.Create(MakeIdAndAddHandler(conn), CleanRequestClean.Create(CleanTypeMixin.Create(category, timestamp)))` and `conn.Write(req.Node)` (`:12-22`). It also keeps a legacy hand-rolled path (`[Obsolete("Use SMAX typed …")]`, `:24-48`) that assembles `<iq type="set" to=s.whatsapp.net xmlns="urn:xmpp:whatsapp:dirty"><clean type=… timestamp=…/></iq>` directly, and registers an empty `IqResultHandler` for the id (`MakeIdAndAddHandler`, `:50-55`). This is the concrete bridge: **Smax node → `IConnection.Write` → `StanzaWriter`**.

### 3.9 End-to-end data flow

Outgoing:
```
<Domain>.Outgoing.<X>.Create(args)            // typed, spec-checked
   → ProtocolTreeNodeBuilder (+ Merge mixins) // §3.3/§3.6
   → ProtocolTreeNode (.Node)
   → IConnection.Write(node)                   // e.g. ClearDirtyStanzaBuilder.cs:15
   → StanzaWriter.Write(node, compress)        // WhatsApp.Root/WhatsApp/StanzaWriter.cs:25
   → BinTreeNodeWriter.Write(target, node, useCompression)  // WhatsApp.Networking/WhatsApp/BinTreeNodeWriter.cs:44
   → FunXMPP bytes → AES-GCM frame → socket
```
Incoming:
```
socket frame → AES-GCM decrypt → BinTreeNodeReader.ParseTreeNode → ProtocolTreeNode
   → (for IQ) <Domain>.Incoming.<X>Handler.HandleResponse(node, request, …)
        → <X>ResponseSuccess.Create / …ClientError.Create / …ServerError.Create   // Either<T,SmaxError>
        → SmaxStandardLibrary.TryGet* validation against the spec
        → typed Action<T> callback   or   aggregated SmaxError → FailuresService.Investigate
```
The `BinTreeNodeWriter.Write` / `…Reader.ParseTreeNode` boundary is where `ProtocolKeyValue.KVType` is consumed to choose compact JID tokens (covered in the binary-encoding doc; here only the linkage is asserted: `BinTreeNodeWriter.cs:44`, `StanzaWriter.cs:25`).

### 3.10 What the codegen reveals about the upstream toolchain (inference)

From the uniformity of the output the original Smax compiler is highly regular and almost certainly emits one file per spec construct:
- `<Stanza>Request` / `<Stanza>Response{Success,ClientError,ServerError}` per IQ definition.
- `<Stanza>Handler` per response set.
- `<Name>Mixin` (composition), `<Name>AttributeMixin` (`smax:any` attribute fragment), `<Name>MixinGroup` (interface = one-of) + `<Name>MixinGroupExtensions` (`Match`).
- `<Owner><Field>EnumExtension` (BiDictionary) per enum.
- Sub-element classes named by **path concatenation** — e.g. `GetGroupInfoRequest` → `GetGroupInfoRequestQuery` → `GetGroupInfoRequestQueryAddRequest`; `SetRequest` → `SetRequestList` → `SetRequestListKey` → `SetRequestListKeyId/Value`. The class name *is* the spec path, which is why the file count balloons (212 files for `Groups.Incoming` alone).
The `±2^53−1` long bounds (`Pings.Incoming/ClientResponseServerResponse.cs:53`) and the pervasive `Either` result type are strong evidence the spec is shared with / modelled on the JS client's stanza schema. This is now **directly corroborated** (not merely inferred): the waweb JS bundle ships the *other* emitter output of the same spec — a `.smax("…")` JSX-style builder plus `WASmaxJsx`/`WASmaxMixins`/`WASmaxAttrs`/`WASmaxChildren` runtime helpers and per-stanza `WASmax*` modules that reuse the identical vocabulary (In/Out direction split, the same `<Domain>` names, `Mixin`, and one-of `MixinGroup`), including exact twins of these C# families — `WASmaxGroupsGetGroupInfoRPC`, `WASmaxBlocklistsGetBlockListRPC`, `WASmaxBotBotListRPC`, `WASmaxChatstateClientNotificationRPC`, and one-ofs like `WASmaxInGroupsGroupInfoOrTruncatedGroupInfoOrGroupForbiddenOrGroupNotExistMixinGroup` (grep over `decompiled_source/waweb-source-bundle/*.js`; see §6 item 1). **Still inferred:** the literal `.smax` DSL grammar/keywords and the generator tool — neither source artifact is in the dump, only its two emitted outputs (C# classes, JS `WASmax*` modules).

**Round-2 (beautified bundle): the JS emitter runtime is now fully readable and maps construct-for-construct onto the C# runtime** (cross-reference: `research/waweb-unmin/n6o0-NaJTww.js`; not read from the native binary). What was previously inferred from minified names is now confirmed from source-shaped JS:
- `WASmaxJsx.smax === WAWap.wap` (`n6o0-NaJTww.js:4330-4333`) — the `.smax(tag, attrs, …children)` builder is just the FunXMPP node factory; the JS twin of `ProtocolTreeNodeBuilder` + fluent `AddChild`/`AddAttribute`.
- The host-tag-adoption sentinel is the literal **`"smax$any"`** (`n6o0-NaJTww.js:4336`; 46 uses bundle-wide), the analog of the C# `"smax:any"` (`ProtocolTreeNodeBuilder.cs:178`) — only the `$`/`:` separator differs.
- `WASmaxMixins.mergeStanzas` (`n6o0-NaJTww.js:4338-4422`) is a line-by-line twin of C# `ProtocolTreeNodeBuilder.Merge` (`ProtocolTreeNodeBuilder.cs:145-286`): tag adopt/mismatch (`c()` ↔ `CheckTag`), attribute merge with value-conflict check (`d()`/`m()` ↔ `MergeAttributes`), data/children mutual exclusion (`p()` ↔ `MergeData`), and per-tag child-count-compatibility merge (`_()`/`f()`/`g()` ↔ `MergeChildren`/`childCountsAreCompatible`). `optionalMerge` (`u()`) ↔ `TryGet…OptionalMixin`.
- The DSL **cardinality vocabulary** is exported by `WASmaxChildren` as named primitives — `OPTIONAL_CHILD`, `HAS_OPTIONAL_CHILD`, `HOMOGENEOUS_CHILD(_COUNT)`, `REPEATED_CHILD(min,max)`, `REPEATED_CHILD_COUNT(min,max)` (`n6o0-NaJTww.js:5883-5932`) — the JS counterparts of C# `TryGetChildren(min,max)`/`TryGetRequiredChild`/`TryGetOptionalChild`. The **optionality vocabulary** is `WASmaxAttrs.OPTIONAL`/`OPTIONAL_LITERAL` with a `WAWap.DROP_ATTR` sentinel (`:5871-5882`).
- The parser ("In") side uses `WASmaxParseUtils` (`n6o0-NaJTww.js:3299`): `assertTag`, `literal(attrString|attrInt, node, key, value)` (pinned-literal equality), `errorMixinDisjunction` (first-success one-of resolver) — JS twins of C# `TryCheckNodeTag`, `expected`-equality, and `TryGetRequiredMixinGroup`. Pinned error literals match the C# exactly (`bad-request`/400, `rate-overlimit`/429, `feature-not-implemented`/501 at `:5933-5990`; cf. C# `item-not-found`/404, §3.5).

This confirms the precise *construct set* the upstream `.smax` DSL declares (required/optional/repeated-with-bounds/homogeneous children; attribute-mixin via the any-tag sentinel; named mixin; one-of mixin-group; pinned literals; JID typing). What remains genuinely absent: the literal `.smax` source-file grammar text and the codegen binary (neither emitter ships its own source; no `@generated`/`SignedSource` smax provenance in the C# beyond the `D:\full-fbsource\…\Smax\Generated\…` build-path strings). Cross-check: the open impls do **not** help — neither Baileys nor whatsmeow uses smax (they hand-write nodes); `smax` surfaces there only as the `smax_id` wire token and the `479` `smax-invalid` server-error code.

**Round-3 (Android client — a *third* emitter output + the first on-disk smax DSL artifact)** [decompiled-Android, jadx]. The extracted WhatsApp Android APK confirms the same shared spec drives a third codegen target, and — unlike the Windows C# and the waweb JS — it ships an actual `smax`-namespaced spec file on disk:
- **Same codegen layout, third client.** The jadx output has generated managers under `com.whatsapp.infra.smax.generated.<domain>.<direction>` — `com/whatsapp/infra/smax/generated/biz/outgoing/BizRPCManager.java` and `com/whatsapp/infra/smax/generated/dmainterop/outgoing/DmaInteropRPCManager.java` (`package` lines `:1`). This mirrors the C# `WhatsApp.Smax.Generated.<Domain>.<Direction>` namespacing and the embedded Windows build path `…/Smax/Generated/<Domain>/<Direction>/…` (§2.6) — the *same* `generated/<domain>/<direction>` tree on Java, C#, and (as `WASmaxIn*`/`WASmaxOut*`) JS. The Android client also routes message stanzas through a `MessageClientSmaxWrapper` (`com/whatsapp/infra/xmpp/messaging/MessageClientSmaxWrapper.java`), i.e. on Android even the *message* path is smax-driven (it is JS-side on the Windows shell, §5).
- **The sentinel is identical on Android.** The smax runtime classes carry the literal `"smax:any"` string — the **exact** C# adoption sentinel (`ProtocolTreeNodeBuilder.cs:178`), not the JS `"smax$any"` — in obfuscated runtime classes (`p000X/C0WF.java`, `p000X/C200298pU.java`, `p000X/AbstractC200498po.java`). So the `:` form is the canonical native sentinel on two native clients (Windows, Android); the bundle's `$` is a JS-only escaping of the same token.
- **First real `.smax`-DSL artifact found anywhere in the dump.** `decompiled_source/android/jadx_output/resources/assets/smax/messagecapping/smax_get_quota.xml` is a smax-namespaced spec/mock file using the two DSL namespaces **`xmlns:smax="http://whatsapp.net/smax"`** and **`xmlns:optional="http://whatsapp.net/smax/optional"`** (`:1`). It declares a `<mock name="GetQuota">` with one `<request>` and five named `<response name="…">` shapes over `xmlns="w:mex"` (the GraphQL-over-MEX transport), and exposes the DSL's templating vocabulary directly: placeholder bindings `:stanzaID`, `:domainJID:s.whatsapp.net`, `:string` (typed slots), interpolation `${MESSAGE_CAPPING_QUERY_ID}` / `${iq.to}` / `${iq.id}` (request→response back-references — the declarative form of the C# `isReference`/`expected` correlation, §3.5), and a `<smax:json>` element wrapping a JSON-over-XMPP body. This is a *mock/fixtures* file (a smax test artifact), not the grammar of the stanza-class spec itself, but it is the only place the `http://whatsapp.net/smax` namespace and the `:slot`/`${...}`/`smax:json`/`optional:` DSL surface appear as authored text rather than emitter output.
- **`smax` is a live wire-level stanza type, not only a codegen label** [bundle]. The waweb socket layer treats `"smax"` as a first-class stanza `type` parallel to `"iq"`, with its own pending-request queue `pendingSmaxStanzas` distinct from `pendingIqs` (`n6o0-NaJTww.js:4798-4800,4930,5046`); `smax_id` is the correlation token for that channel (the `smax_id`/`479 smax-invalid` tokens the open impls carry are this wire channel). So "Smax" names both the codegen framework *and* a runtime stanza envelope.

What this still does **not** recover: the `.smax` source-file grammar that declares the *stanza classes* (the `mixin` / `mixin group` / `reference` / cardinality declarations the codegen consumes) and the generator tool. The Android `smax_get_quota.xml` is a mock-response fixture in the smax namespace, not the class spec; and `"smax:any"` plus the namespace URIs are the only authored DSL tokens recovered. The class-spec grammar and codegen binary live upstream (`D:\full-fbsource\whatsapp\…\Smax\`) and are absent from all three client dumps.

---

## 4. Native Dependencies

Smax is **pure managed C#**. It has *no* P/Invoke, no WinRT projection, and no native crypto/IO of its own:
- It depends only on other managed code: `WhatsApp.Networking.Nodes`, `WhatsApp.Core.Utils.Functional.Either/Maybe`, `JidFactory`/`JidChecker`/`Jid` hierarchy (managed), and `FailuresService` (managed logging).
- It touches the native world only **transitively, downstream of `.Node`**: the produced `ProtocolTreeNode` is later serialized by `BinTreeNodeWriter` (managed) and the resulting frame is AES-GCM-encrypted via `AesGcmProvider` (which wraps the WinRT `SymmetricKeyAlgorithmProvider`) before hitting the socket. None of that is part of Smax.
- `BinTreeNodeWriter.Write(ITarget, ProtocolTreeNode, bool)` (`WhatsApp.Networking/WhatsApp/BinTreeNodeWriter.cs:44`) and `StanzaWriter.Write(ProtocolTreeNode, bool)` (`WhatsApp.Root/WhatsApp/StanzaWriter.cs:25`) are the confirmed consumers of Smax output; the JID-token compaction they perform reads `ProtocolKeyValue.KVType`. **Confirmed from code** (signatures only; encoding body covered in the binary-format doc).

There is **nothing to find for Smax in the native binaries**, because Smax has no native component: it is pure managed C# (above). The two Ghidra exports that cover those binaries are unusable in this dump (`ghidra-output/WhatsAppNative-functions.txt` is empty; `ghidra-output/WhatsAppRust-functions.txt` carries only a PyGhidra error) — but that limitation is orthogonal to Smax, and it does **not** mean those DLLs are unanalyzed: their provenance was since recovered without Ghidra via `strings`/`objdump`/`radare2` (`WhatsAppNative.dll` static crypto, `WhatsAppRust.dll` = Meta **wamedia** media-parsing/MP4-ops libraries — neither touches the stanza layer; docs 92 §6 item 1, 96). Smax sits entirely above the native boundary regardless.

---

## 5. Linux/Electron Port Mapping

The port question is unusual for this subsystem because **two reuse paths exist** and one is nearly free:

**Path A — reuse the waweb JS bundle's stanza layer (recommended default).** Since the native shell already delegates `message`/`receipt`/`notification`/`presence`/`chatstate` to the WebView2 bundle, and the generated Smax families have *no callers* in `WhatsApp.Root`/`WhatsApp.VoIP`, an Electron port that likewise hosts `web.whatsapp.com` inherits the entire stanza grammar from JS for free. The only stanzas the native layer must build/parse itself are the connection-level ones (`iq`/`success`/`failure`) plus whatever IQ helpers the shell drives (dirty-bits clear, prekey upload, ping). Map those few to a tiny hand-written builder set in TS over a `ProtocolTreeNode` equivalent.

**Path B — reimplement the binary protocol natively in Node (if going bundle-free).** Then Smax is the canonical schema source and should be mirrored:
- `ProtocolTreeNode` → a plain TS interface `{ tag: string; attrs: Record<string,string>; content?: TreeNode[] | Uint8Array }`. This is exactly the shape used by the open-source **Baileys** library (`@whiskeysockets/baileys`) and **whatsmeow** (Go), both of which already implement the FunXMPP binary node format, the token dictionaries, JID encoding, and Noise transport. Reuse one of those rather than re-deriving from the C#.
- `ProtocolKeyValue.KVType` JID typing → Baileys/whatsmeow already encode JID attributes compactly; the `KVType` flag table (`ProtocolKeyValue.cs:9-33`) is still a useful *reference* for which attributes accept which JID classes.
- `SmaxStandardLibrary` validation primitives → a thin TS validation helper (`getRequiredAttr`, `getChildren(min,max)`, `getEnum(biMap)`, `referenceEquals(reqId)`), or a schema lib (zod) keyed off the same bounds. The `'#'`-prefix "element value" convention and the `id`-reference correlation are the two non-obvious rules to port (`SmaxStandardLibrary.cs:169-176`, `:48-49` in generated parsers).
- `BiDictionary` enum maps → trivial bidirectional `Map` in TS; the **wire strings themselves** (e.g. `"w:g2"`, `"encrypt"`, `"urn:xmpp:whatsapp:dirty"`, the `request` enum literals) are the load-bearing constants — **mine them directly from the generated `…EnumExtension` files and the outgoing ctors**, they are the spec.
- `Either<T,SmaxError>` → `neverthrow`'s `Result<T,E>` or a hand-rolled discriminated union; `Handler.HandleResponse` first-success dispatch → a `match()` over candidate parsers.
- IQ correlation: in this codebase correlation is *structural* in the parser (response `id` reference-checked vs request) **and** tracked at the connection layer by `IqRequestsTracker` (one-shot id→handler map). A Node port should keep the connection-level tracker (Baileys' `query`/`waitForMessage` pattern) and treat the Smax reference-checks as optional belt-and-suspenders.

**High-value artifact for either path:** the 510 generated files are a machine-readable dump of WhatsApp's IQ grammar (tags, `xmlns`, attribute names, enum literals, length/range bounds, child cardinalities, error `code`/`text` pairs like `item-not-found`/`404`). A small script can extract this into a JSON schema to validate a TS implementation against the exact same constraints the Windows client enforces. **No native module is required for any of this** — Smax maps to ordinary TypeScript.

**Gaps / risks:**
- The `.smax` source specs are not in the dump (only generated output), so any reverse-spec is inferred from the emitted C#; coverage is whatever the 11 domains include (notably **`message` is absent** — message stanzas are JS-side).
- Release builds make `SmaxAssert.DebugFail` a no-op, so the Windows client does **not** hard-fail on outgoing spec violations; a port that throws on the same violations may behave differently. Match the lenient behavior for outbound, strict for inbound.
- The `±2^53−1` bounds presume JS-safe integers; in Node this aligns naturally, but watch 64-bit ids/timestamps that exceed it (use strings/BigInt as the C# does — it parses with `long` but the bound caps at 2^53−1).

---

## 6. Open Questions / Unverified

*Each item below was re-investigated this pass against the C# dump, the waweb JS bundle, and the native receive path; the verdict tag + concrete finding/citation precedes the original question.*

1. **[PARTIAL] The `.smax` spec DSL itself is not present** — only generated C#. *Original question: the exact spec syntax, how `mixin`/`mixin group`/`reference`/`smax:any` are declared, and the codegen tool are inferred from output (§3.10).* Re-investigation found strong cross-client corroboration that a **single shared upstream Smax spec** drives codegen for *both* clients, even though the DSL source text is still absent. The waweb JS bundle ships a parallel emitter: a `.smax(tag, attrs, …children)` JSX-style builder (`WASmaxJsx`) plus `WASmaxMixins`/`WASmaxAttrs`/`WASmaxChildren` runtime helpers (the JS analog of `SmaxStandardLibrary`), and per-stanza modules using the **identical** vocabulary — direction split `In`/`Out`, the same `<Domain>` names, `Mixin`, and the one-of `MixinGroup` construct. Concrete twins of the C# families: `WASmaxGroupsGetGroupInfoRPC`, `WASmaxBlocklistsGetBlockListRPC`, `WASmaxBotBotListRPC`, `WASmaxChatstateClientNotificationRPC`, and one-ofs like `WASmaxInGroupsGroupInfoOrTruncatedGroupInfoOrGroupForbiddenOrGroupNotExistMixinGroup` (evidence: `grep -o '"WASmax[A-Za-z0-9]*"'` and `grep '\.smax("…"'` over `decompiled_source/waweb-source-bundle/*.js`, e.g. `SjCAw3j6…js`, `c7Ubf6OQTBc.js`, `mEvs85pxZT4.js`). The decompiled C# additionally pins the upstream codegen output layout `…/WhatsApp.Networking/Smax/Generated/<Domain>/<Direction>/<StanzaName>/<Class>.cs` via the embedded build paths (`WhatsApp.Smax.Generated.Pings.Incoming/ClientResponseServerResponse.cs:63`; `…Groups.Incoming/GetGroupInfoResponseSuccess.cs:63`).

   **Round-2 tightening (beautified bundle — the JS emitter *runtime contract* is now fully readable, was previously only inferred from minified names).** The js-beautified bundle exposes the complete JS-side runtime that the codegen targets, and it maps construct-for-construct onto the C# Smax runtime (cross-reference: `research/waweb-unmin/n6o0-NaJTww.js`, module defs at `:4330`–`:5932`):
   - `WASmaxJsx.smax` is literally `WAWap.wap` — i.e. the `.smax(tag, attrs, …children)` "JSX" builder is just the FunXMPP node factory (`n6o0-NaJTww.js:4330-4333`, `WAWap` def at `:3804`). This is the JS twin of the C# `ProtocolTreeNodeBuilder("<tag>")` + `AddChild`/`AddAttribute` chain.
   - The sentinel is the literal string **`"smax$any"`** in JS (46 occurrences across the bundle) — the exact analog of the C# `"smax:any"` adoption tag (only the separator differs, `$` vs `:`). It is defined once in `WASmaxMixins` (`n6o0-NaJTww.js:4336`) and used wherever an attribute-only mixin must inherit the host tag (e.g. `ZOphpnKoB2f.js:172`, `SjCAw3j6…js:33169` for `pair-device-sign`).
   - `WASmaxMixins.mergeStanzas` (`n6o0-NaJTww.js:4338-4422`) is the **line-by-line twin of C# `ProtocolTreeNodeBuilder.Merge`** (`ProtocolTreeNodeBuilder.cs:145-286`): tag-adoption / mismatch-throw `c()` ↔ `CheckTag` (`:176-186`); attribute-merge-with-conflict-check `d()`/`m()` ↔ `MergeAttributes` (`:188-207`); element-value vs children mutual-exclusion `p()` ↔ `MergeData` (`:270-286`); child merge with per-tag count-compatibility `_()`/`f()`/`g()` ↔ `MergeChildren`/`childCountsAreCompatible` (`:218-298`). `WASmaxMixins.optionalMerge(fn, node, …)` (`u()`, `:4342`) is the JS `TryGet…OptionalMixin` equivalent.
   - `WASmaxChildren` names the spec's **cardinality vocabulary** as exported primitives: `OPTIONAL_CHILD`, `HAS_OPTIONAL_CHILD`, `HOMOGENEOUS_CHILD`, `HOMOGENEOUS_CHILD_COUNT`, `REPEATED_CHILD(min,max)`, `REPEATED_CHILD_COUNT(min,max)` (`n6o0-NaJTww.js:5883-5932`) — the JS counterpart of the C# `TryGetChildren(min,max)`/`TryGetRequiredChild`/`TryGetOptionalChild` family; e.g. `REPEATED_CHILD(e,n,1,1000)` for a 1..1000 list (`xTiXmyjNEd_.js:2447`).
   - `WASmaxAttrs` names the optionality vocabulary: `OPTIONAL`/`OPTIONAL_LITERAL` returning a `WAWap.DROP_ATTR` sentinel when absent (`n6o0-NaJTww.js:5871-5882`) — the JS counterpart of the C# `…Optional*AttributeValue` paths.
   - The parser side ("In" modules) uses `WASmaxParseUtils` (`n6o0-NaJTww.js:3299`): `assertTag(node,"error")`, `literal(attrString|attrInt, node, key, expectedValue)` (pinned-literal check — the JS analog of C# `expected`-equality), and `errorMixinDisjunction(node, [names…], [results…])` (the one-of resolver, JS twin of `TryGetRequiredMixinGroup`'s first-success-or-aggregate-errors). The pinned error literals match the C# exactly, e.g. `text="bad-request"/code=400`, `text="rate-overlimit"/code=429`, `text="feature-not-implemented"/code=501` (`n6o0-NaJTww.js:5933-5990`) — the same shape as the C# `item-not-found`/`404` pins (§3.5).

   So the **construct set** the `.smax` DSL must declare (tag/attrs/children, optional vs required, repeated with min/max, homogeneous, attribute-mixin via `smax$any`, named mixin, one-of `MixinGroup`, pinned literals, JID typing) is now corroborated from *both* emitter outputs rather than inferred from one. Cross-checked against the open implementations: **neither Baileys nor whatsmeow carries the smax DSL** (they hand-write nodes); `smax` appears in them only as the unrelated `smax_id` wire token (`whatsmeow/binary/token/token.go:12`; `Baileys/src/WABinary/constants.ts:294`) and the `smax-invalid` server error code `479` (`whatsmeow/client.go:298`; `Baileys/src/Utils/decode-wa-message.ts:94`) — so the open impls cannot close this residual.

   **Round-3 (Android client — a *third* emitter output and the first on-disk smax DSL artifact; [decompiled-Android, jadx]).** The extracted WhatsApp Android APK adds a third independent corroboration of one shared spec and, for the first time in this dump, an authored file in the `smax` namespace (full write-up folded into §3.10):
   - **Same `generated/<domain>/<direction>` codegen layout on a third client.** jadx output carries `com.whatsapp.infra.smax.generated.biz.outgoing.BizRPCManager` and `com.whatsapp.infra.smax.generated.dmainterop.outgoing.DmaInteropRPCManager` (`package` line `:1` of each), mirroring the C# `WhatsApp.Smax.Generated.<Domain>.<Direction>` namespaces and the embedded Windows build path `…/Smax/Generated/<Domain>/<Direction>/…` (§2.6). Plus `com/whatsapp/infra/xmpp/messaging/MessageClientSmaxWrapper.java` (Android runs even the message path through smax, unlike the JS-delegating Windows shell).
   - **Same `"smax:any"` sentinel on Android** — the obfuscated smax runtime classes `p000X/C0WF.java`, `p000X/C200298pU.java`, `p000X/AbstractC200498po.java` all carry the literal `"smax:any"` string, identical to C# (`ProtocolTreeNodeBuilder.cs:178`); the JS `"smax$any"` is the lone separator variant. Two native clients agree on `:`.
   - **First authored smax-DSL artifact anywhere:** `decompiled_source/android/jadx_output/resources/assets/smax/messagecapping/smax_get_quota.xml` declares `xmlns:smax="http://whatsapp.net/smax"` + `xmlns:optional="http://whatsapp.net/smax/optional"` (`:1`) and a `<mock name="GetQuota">` with one `<request>` + five `<response name="…">` over `xmlns="w:mex"`, exposing the DSL's templating surface as authored text: typed slots `:stanzaID`/`:domainJID:s.whatsapp.net`/`:string`, request→response back-reference interpolation `${iq.to}`/`${iq.id}`/`${MESSAGE_CAPPING_QUERY_ID}` (declarative form of the C# `isReference`/`expected` correlation, §3.5), and a `<smax:json>` JSON-over-XMPP body wrapper.
   - **`smax` is also a live wire stanza type** [bundle]: the socket layer queues `type === "smax"` stanzas in `pendingSmaxStanzas` parallel to `pendingIqs` (`n6o0-NaJTww.js:4798-4800,4930,5046`), with `smax_id` as the correlation token — so the `smax_id`/`479 smax-invalid` tokens the open impls carry are this channel, and "Smax" names both the codegen framework and a runtime envelope.

   **Still missing (residual, keeps this PARTIAL):** the literal `.smax` *stanza-class* spec grammar (the `mixin`/`mixin group`/`reference`/cardinality declarations the codegen consumes) and the generator/codegen binary itself. The Android `smax_get_quota.xml` is a mock-response **fixture** in the smax namespace, not the class-spec grammar; `"smax:any"` and the two namespace URIs are the only authored DSL tokens recovered. No emitter ships its own source — the C# carries no `@generated`/`SignedSource` smax provenance beyond the build-path strings, the bundle ships only emitted `WASmax*` JS modules, and the Android `generated/*` managers are likewise emitter output. **Exact artifact that would close it:** an upstream `.smax` *class-spec* file (or the `Smax` codegen tool) from `D:\full-fbsource\whatsapp\windows\…\Smax\` (or the equivalent `fbsource` smax path) — not present in any of the three client dumps.
2. **[RESOLVED] No runtime caller of the generated families outside `ClearDirtyStanzaBuilder` — and even that consumer is itself uncalled in this dump; the entire generated *incoming* layer is dead code here.** *Original question: whether any generated family besides `DirtyBits.Outgoing` is exercised at runtime, or whether they are compiled-but-dormant schema.* Re-investigation: (a) the only non-generated `.cs` carrying `using WhatsApp.Smax.Generated.*` is `WhatsApp.Networking.StanzaBuilders/ClearDirtyStanzaBuilder.cs` (it uses `DirtyBits.Outgoing.CleanRequest`, `CleanRequestClean`, `CleanTypeMixin`, **and** `CleanTypeWithTimestampMixin`); (b) a cross-assembly search for every generated request type name (`CleanRequest`, `ClientRequest`, `GetGroupInfoRequest`, `SetRequest`, `AvailabilityRequest`, `SubscribeRequest`, `UpdateBlockListRequest`, `GetBlockListRequest`) found **zero** references in `WhatsApp.Root`/`WhatsApp.VoIP`/`WhatsApp.Core`; (c) there are **zero callers of any generated `*Handler.HandleResponse`** anywhere in the dump — the incoming parser/handler families are never invoked; (d) the native IQ-result path (`WAProtocol.ProcessIq`, `WAProtocol.cs:158-187`) pops the per-id handler (`_requestsTracker.PopIqHandler(id)`, `:170,178`) and calls `iqResultHandler.Parse(node, from)` / `.ErrorNode(node)` — `IqResultHandler` is a plain wrapper over `Action<ProtocolTreeNode,string>` (result) + `Action<ProtocolTreeNode>` (error) (`IqResultHandler.cs:8-12,42-47`) that does **not** route into any generated family; (e) even the two outgoing entry points `IConnection.SendClearDirty`/`SendClearDirtyForSyncdAppState` (`ClearDirtyStanzaBuilder.cs:11-22`) have **no callers** in the decompiled tree. So the families are confirmed **compiled-but-dormant** in this WinUI shell build; the JS bundle owns live stanza traffic.
3. **[RESOLVED] `InvalidJidException` in the `ProtocolKeyValue` 3-arg ctor is constructed but never thrown** (`ProtocolKeyValue.cs:64-72`, allocation at `:69`). *Original question: whether the decompiler dropped a `throw` or the original truly only allocates-and-discards.* Re-investigation shows the decompiler reliably preserves `throw` elsewhere in the **same constructor chain** — the 2-arg base ctor does `throw new NullReferenceException(text)` (`ProtocolKeyValue.cs:58`), and `BinTreeNodeWriter` builds-and-discards an `InvalidJidException` the same way (constructs it, hands it to `MaybeSendClb` for telemetry, never throws — `BinTreeNodeWriter.cs:145-146,169-170`). That pattern (allocate the exception object as a telemetry/diagnostic payload rather than to throw) recurs across the codebase, so this is a **real source behavior**, not a decompiler artifact: validation failure on a typed attribute does not raise; the malformed value is accepted and the type-check is treated as advisory (consistent with the lenient outbound posture in §3.4/§5).
4. **[RESOLVED] `ToLogStanza()` returns empty and `LogStanza` is DEBUG-only — release client never serializes stanza contents (not even to the debugger).** *Original question: confirm the release client does not serialize stanza contents to logs.* Verified: `ToLogStanza()` returns `new StringBuilder().ToString()` i.e. the empty string (`ProtocolTreeNode.cs:296-299`); `LogStanza(...)` is `[Conditional("DEBUG")]` so it is compiled out of release (`:301-302`); and the class-level `[DebuggerDisplay("{ToLogStanza(),nq}")]` (`:10`) means even an attached debugger shows an empty stanza view in a release build. Anyone expecting wire traces from this client must capture at the socket/`BinTreeNode*` layer, not from `ProtocolTreeNode` logging.
5. **[RESOLVED] `BinTreeNodeWriter` consumes `KVType` directly to pick the JID-token path vs the token-dictionary/UTF-8 path.** *Original question: which token each composite JID type maps to (asserted here only as a linkage).* Re-investigation reads the body: `WriteAttributes` passes `attributes[i].kvType` into `WriteValueString` (`BinTreeNodeWriter.cs:106`); `WriteValueString` (the whole method spans `:111-151`) opens with `if (ProtocolKeyValue.IsJidType(keyValueType))` → split the value on `'@'` into `user`/`server` and emit via `WriteJid(user, server)` (the JID branch is `:115-127`); non-JID values fall through to the token dictionary (`tokenMap.TryGetToken`, `:128-136`) or raw UTF-8 (`:137-141`), with a defensive `MaybeSendClb` telemetry call if an untyped attribute *looks* like a JID (`:143-150`). `WriteJid` (`:186+`) then resolves agent/device separators and writes the compact JID structure. So the load-bearing rule is binary: `IsJidType(KVType)` (the low-bit test, `ProtocolKeyValue.cs:109-112`) selects the JID encoding; the *individual* composite `KVType` variants (`UserJidOrDeviceJid`, etc.) are **not** separately tokenized at write time — they all collapse to the one `IsJidType`→`WriteJid` path. (Byte-level token IDs remain the binary-encoding doc's scope, but the C#-side linkage is now verified, not just asserted.)
6. **[RESOLVED] Incoming non-IQ Smax families (`Presence.Incoming`, `Offline.Incoming`, `Bot.Incoming`, `Chatstate`) are unreachable from the native receive path.** *Original question: whether some entry point feeds these incoming families nodes.* Re-investigation of `WAProtocol` confirms the native receive path only ever processes three top-level tags: post-login `ProcessNode`/`ProcessLoginStateStanza` dispatch **only** `iq` to `ProcessIq`; any other top-level tag is dropped with `Log.Warn("Unrecognized top-level stanza [...]")` (`WAProtocol.cs:68-82,142-156`); pre-login `ProcessAuthenticationNode` handles **only** `success`/`failure` during the handshake (`:84-139`); and `ProcessIq` routes `result`/`error` IQ solely to the `IqRequestsTracker` → `IqResultHandler` delegate map (`:158-187`) — it never constructs a generated incoming family. There is no observed path (offline-sync IQ child payloads or otherwise) that hands a node to `Presence.Incoming`/`Offline.Incoming`/`Bot.Incoming`/`Chatstate` parsers in this build, matching item 2: these families are dormant schema, and all `message`/`receipt`/`notification`/`presence`/`chatstate` traffic is handled by the WebView2 JS bundle (whose own `WASmaxIn*`/`WASmaxChatstate*RPC` modules — see item 1 — are the live equivalents).
