# Protobuf Type Catalog

> Target: Meta native WhatsApp for Windows (`WhatsApp.Root.exe`, WinUI 3 hybrid, v2.2607.106.0). All paths in §2–§4 are **relative to `decompiled_source/`** unless noted. Line cites are `path:LINE` and were read directly. Where a fact is not directly visible in the C# it is explicitly marked **inferred**.

---

## 1. Purpose & Scope

This document is the **catalog of every Protocol-Buffer type compiled into the native Windows client**, all living in one assembly: **`WhatsApp.Protobuf.dll`** (project `decompiled/WhatsApp.Protobuf/WhatsApp.Protobuf.csproj`). It covers:

- **What proto families exist** (message content / Signal key state / app-state SyncD / companion-pairing ADV / connection login / history sync / data-export "Positron"), where each lives, and which `.proto` source each was generated from.
- **The two completely different serializer runtimes** that coexist in this single DLL — a hand-rolled **SilentOrbit** stream codec and the official **Google.Protobuf** `CodedInputStream`/reflection codec — and exactly which message types use which.
- The **wire layout** these types serialize to (varint tags, wire types, field-number maps) and the **wire-vs-storage** role of each family.

**The single most important architectural finding (confirmed):**

> The `WhatsApp.Protobuf` assembly is almost entirely **passive data-transfer objects**. Two namespaces share the **same logical proto schema** (`WhatsApp.ProtoBuf`, the protobuf *package* name) but are emitted by **two different code generators** into **two different C# namespaces**: `WhatsApp.ProtoBuf` (SilentOrbit, hand-rolled `Stream` codec — 92 files) and `WhatsApp.GProtoBuf` (Google.Protobuf reflection codec — 33 files). The big end-to-end message tree (`Message` with 50+ content types) exists **twice** — once as SilentOrbit `WhatsApp.ProtoBuf.Message` (`Message.cs`, 21 506 lines) and once as Google.Protobuf `WhatsApp.GProtoBuf.Message` (`Message.cs`, 31 928 lines). The native C# shell *uses* only a handful of these (notably `ClientPayload` for the Noise login payload and `HandshakeMessage` for the Noise wrapper); the rest are marshalling structs whose live producers/consumers are the **WhatsApp Web JS bundle** (`waweb-source-bundle/`) or a SQLite migration path. See §3.7.

**Out of scope:** the Noise handshake state machine (doc 11), the FunXMPP binary node format (doc 12 — a *different* wire format from protobuf), Signal ratchet math (doc 20), SyncD merge logic (doc 32 / DataModels). This doc catalogs the protobuf *types* and their wire encoding only.

---

## 2. Where It Lives

Single assembly, five C# namespaces, two runtimes. Counts are file counts in each directory.

| Namespace (C#) | Dir (under `decompiled/WhatsApp.Protobuf/`) | Files | Codec runtime | Proto package |
|---|---|---|---|---|
| `WhatsApp.ProtoBuf` | `WhatsApp.ProtoBuf/` | 92 | **mixed** (78 SilentOrbit, 14 Google) | `WhatsApp.ProtoBuf` |
| `WhatsApp.GProtoBuf` | `WhatsApp.GProtoBuf/` | 33 | Google.Protobuf | `WhatsApp.ProtoBuf` (csharp_namespace=`WhatsApp.GProtoBuf`) |
| `Whatsapp` (ADV) | `Whatsapp/` | 6 | Google.Protobuf | `proto` (`adv.proto`) |
| `WhatsApp` (Positron) | `WhatsApp/` | 16 | SilentOrbit | (no proto file; hand-written) |
| `SilentOrbit.ProtocolBuffers` | `SilentOrbit.ProtocolBuffers/` | 9 | — (the SilentOrbit runtime itself) | — |

**The two runtimes:**

1. **SilentOrbit hand-rolled codec** — `SilentOrbit.ProtocolBuffers/ProtocolParser.cs` (401 lines). Static read/write helpers over a raw `System.IO.Stream`: `ReadKey`/`WriteKey` (`ProtocolParser.cs:129`), varint `ReadUInt32`/`ReadUInt64` (`:279`,`:342`), zig-zag `ReadZInt32`/`ReadZInt64` (`:268`,`:331`), `ReadBytes`/`WriteBytes` length-delimited (`:17`,`:51`), `ReadString` UTF-8 (`:11`). Wire types are `SilentOrbit.ProtocolBuffers/Wire.cs:3` — `Varint=0, Fixed64=1, LengthDelimited=2, Fixed32=5` (standard protobuf wire types). A `Key` is `{Field, WireType}` packed as `(field<<3)|wire` (`ProtocolParser.cs:144`). Generated SilentOrbit classes are **plain POCOs** with nullable value props and static `Deserialize`/`Serialize`/`SerializeToBytes`/`*LengthDelimited` methods.

2. **Google.Protobuf codec** — references `Google.Protobuf.dll` (`WhatsApp.Protobuf.csproj:16`, `HintPath ../../x64/Google.Protobuf.dll`). Generated classes implement `IMessage<T>`/`IDeepCloneable<T>`/`IEquatable<T>`, expose `Parser`, `Descriptor`, `MergeFrom(CodedInputStream)`, `WriteTo(CodedOutputStream)`, `CalculateSize()`, `Clone()`, `Has*`/`Clear*` per field, and carry an `UnknownFieldSet`. Their `Descriptor` is resolved from an embedded base64 `FileDescriptor` in a `*Reflection.cs` companion.

**`*Reflection.cs` files and the `.proto` they embed** (proto filenames decoded from the base64 `FileDescriptor.FromGeneratedCode(...)` blobs):

| Reflection file | `.proto` | Imports | Generates (csharp_namespace) |
|---|---|---|---|
| `WhatsApp.GProtoBuf/E2EReflection.cs:14` | `e2e.proto` (package `WhatsApp.ProtoBuf`) | `protocol.proto`, `mms_retry.proto` | the full `Message` content tree → `WhatsApp.GProtoBuf` |
| `WhatsApp.GProtoBuf/ProtocolReflection.cs` | `protocol.proto` | — | `WhatsApp.GProtoBuf` |
| `WhatsApp.GProtoBuf/MmsRetryReflection.cs` | `mms_retry.proto` | — | `MediaRetryNotification` → `WhatsApp.GProtoBuf` |
| `WhatsApp.GProtoBuf/SyncActionReflection.cs` | `sync_action.proto` | `chat_lock_settings.proto`, `device_capabilities.proto`, `protocol.proto` | `SyncActionValue`/`SyncActionData` → `WhatsApp.GProtoBuf` |
| `WhatsApp.GProtoBuf/ChatLockSettingsReflection.cs:14` | `chat_lock_settings.proto` | `user_password.proto` | `ChatLockSettings` |
| `WhatsApp.GProtoBuf/UserPasswordReflection.cs` | `user_password.proto` | — | `UserPassword` |
| `WhatsApp.ProtoBuf/ServersyncReflection.cs` | `serversync.proto` (package `WhatsApp.ProtoBuf`) | — | `Syncd*` family (in `WhatsApp.ProtoBuf` namespace, Google codec) |
| `WhatsApp.ProtoBuf/CertReflection.cs` | `cert.proto` (package `WhatsApp.ProtoBuf`) | — | `CertChain`/`NoiseCertificate` |
| `WhatsApp.ProtoBuf/DeviceCapabilitiesReflection.cs` | `device_capabilities.proto` | — | `DeviceCapabilities` |
| `Whatsapp/AdvReflection.cs` | `adv.proto` (package `proto`) | — | ADV family → `Whatsapp` |

> **Note on the package vs namespace overlap:** all of `e2e/protocol/mms_retry/sync_action/...` declare protobuf package `WhatsApp.ProtoBuf` but `csharp_namespace = WhatsApp.GProtoBuf` (visible in the decoded descriptor strings, e.g. `MmsRetryReflection` → `com.whatsapp.proto … WhatsApp.GProtoBuf`). That is why the Google-codec copies land in `WhatsApp.GProtoBuf` while the older SilentOrbit copies of the *same schema* sit in `WhatsApp.ProtoBuf`.

---

## 3. How It Works

### 3.1 The two codecs, byte-for-byte

**SilentOrbit deserialize loop** (representative — `WhatsApp.ProtoBuf/IdentityKeyPairStructure.cs:48`):

```csharp
public static IdentityKeyPairStructure Deserialize(Stream stream, IdentityKeyPairStructure instance) {
    while (true) {
        int num = stream.ReadByte();
        switch (num) {
        case 10:  instance.PublicKey  = ProtocolParser.ReadBytes(stream); continue;  // field 1, wire 2 → tag 0x0A
        case 18:  instance.PrivateKey = ProtocolParser.ReadBytes(stream); continue;  // field 2, wire 2 → tag 0x12
        case -1:  return instance;                                                    // EOF
        }
        Key key = ProtocolParser.ReadKey((byte)num, stream);
        if (key.Field == 0) throw new ProtocolBufferException("Invalid field id: 0, ...");
        ProtocolParser.SkipKey(stream, key);                                          // unknown → skip
    }
}
```

The `case` integers are **literal first tag bytes** = `(field_number << 3) | wire_type`. So `case 10` = field 1 / `LengthDelimited`; `case 18` = field 2 / `LengthDelimited`; a varint scalar at field 1 would be `case 8` (e.g. `HistorySync.SyncType` is `case 8` at `HistorySync.cs:128`). Unknown fields are decoded with `ReadKey` and skipped (`ProtocolParser.SkipKey` — `ProtocolParser.cs:150`, seeks/skips by wire type). Three deserialize entry shapes exist on every SilentOrbit type: `Deserialize` (read to EOF), `DeserializeLengthDelimited` (read a varint length prefix first — `IdentityKeyPairStructure.cs:73`), `DeserializeLength(len)` (bounded — `:105`). Serialize writes the raw tag byte then the value (`Serialize` — `IdentityKeyPairStructure.cs:136`: `stream.WriteByte(10); ProtocolParser.WriteBytes(...)`).

**Google deserialize loop** (representative — `WhatsApp.ProtoBuf/SyncdMutation.cs:230`):

```csharp
public void MergeFrom(CodedInputStream input) {
    uint num;
    while ((num = input.ReadTag()) != 0) {
        switch (num) {
        default:  _unknownFields = UnknownFieldSet.MergeFieldFrom(_unknownFields, input); break;
        case 8u:  Operation = (Types.SyncdOperation)input.ReadEnum(); break;   // field 1 varint
        case 18u: if (!HasRecord) Record = new SyncdRecord(); input.ReadMessage(Record); break;  // field 2 msg
        }
    }
}
```

Same tag arithmetic, but driven by `CodedInputStream.ReadTag()`/`ReadEnum()`/`ReadMessage()` and presence tracked via `_hasBits0` bitflags (`SyncdMutation.cs:26`,`:52`) or non-null reference checks (`HasRecord` — `:82`). `WriteTo` uses `output.WriteRawTag(8)` etc. (`SyncdMutation.cs:171`).

Both codecs therefore emit **identical bytes** for the same schema; the choice is purely a code-generation artifact. **Inferred:** the SilentOrbit set is the older generator (matching the open-source `whatsapp-web` / Baileys lineage), retained for the structs the native shell or migration code touches directly, while the Google set is the modern regeneration used where reflection/JSON-diagnostics are wanted.

### 3.2 Family A — End-to-end message content (`e2e.proto` → `Message`)

The headline type. Field-number map of the **root `Message`** (the content oneof-equivalent; presence-based, not a real `oneof`) — from `WhatsApp.GProtoBuf/Message.cs`:

| # | Field | # | Field |
|---|---|---|---|
| 1 | Conversation (plain text `string`) | 31 | DeviceSentMessage |
| 2 | SenderKeyDistributionMessage | 32 | DeviceSyncMessage |
| 3 | ImageMessage | 35 | MessageContextInfo |
| 4 | ContactMessage | 37 | ViewOnceMessage |
| 5 | LocationMessage | 40 | EphemeralMessage |
| 6 | ExtendedTextMessage | 46 | ReactionMessage |
| 7 | DocumentMessage | 49/60/64 | PollCreationMessage / V2 / V3 |
| 8 | AudioMessage | 50 | PollUpdateMessage |
| 9 | VideoMessage | 51 | KeepInChatMessage |
| 10 | Call | 53 | DocumentWithCaptionMessage |
| 11 | Chat | 55/59 | ViewOnceMessageV2 / V2Extension |
| 12 | ProtocolMessage | 56 | EncReactionMessage |
| 13 | ContactsArrayMessage | 58 | EditedMessage |
| 14 | HighlyStructuredMessage | 61/65 | ScheduledCallCreation / EditMessage |
| 15 | FastRatchetKeySenderKeyDistributionMessage | 62 | GroupMentionedMessage |
| 16/22 | SendPayment / RequestPaymentMessage | 63 | PinInChatMessage |
| 18 | LiveLocationMessage | 66 | PtvMessage (push-to-video) |
| 23/24 | Decline / CancelPaymentRequestMessage | 67 | BotInvokeMessage |
| 25 | TemplateMessage | 69 | CallLogMesssage *(sic)* |
| 26 | StickerMessage | 71/77 | EncComment / CommentMessage |
| 28 | GroupInviteMessage | 74 | LottieStickerMessage |
| 29 | TemplateButtonReplyMessage | 75/76 | Event / EncEventResponseMessage |
| 30 | ProductMessage | 80 | PlaceholderMessage |
| | | 82 | SecretEncryptedMessage |
| | | 83 | AlbumMessage |

Source: root field constants `Message.cs` (`ConversationFieldNumber=1` … `AlbumMessageFieldNumber=83`, verified). The SilentOrbit `MessageTypes` enum (`WhatsApp.ProtoBuf/MessageTypes.cs:3`) is a **parallel, hand-curated discriminator** with slightly different numbering (e.g. `conversation=1, image_message=3, … album_message=43`) used by `IProtoBufMessage.MessageType` (`IProtoBufMessage.cs:5`) — it is *not* the proto field number; it is an app-level message-type id. **How the two numberings relate (verified):** there is **no lookup table** that converts a `MessageTypes` id to a proto field number; instead each content sub-class in the SilentOrbit `WhatsApp.ProtoBuf/Message.cs` **hard-codes its own discriminator** as a read-only expression — e.g. `public MessageTypes MessageType => MessageTypes.image_message;` (`Message.cs:230`), `… => MessageTypes.protocol_message;` (`Message.cs:4200`). So the class simultaneously *is* a proto field (its position in the parent `Message`) and *reports* its app-level id; the (field-number ↔ MessageTypes) correspondence is therefore distributed across the per-class `MessageType` getters rather than centralized. A grep for any `switch`/`case MessageTypes.*` converter across the whole C# dump returns nothing (the runtime that actually keys off these ids — e.g. to pick a renderer — is the JS bundle).

Notable nested content types and their enums (all in `WhatsApp.GProtoBuf/Message.cs`):
- `SenderKeyDistributionMessage` (`:26`): `groupId` (1), `axolotlSenderKeyDistributionMessage` bytes (2) — the libsignal SKDM wrapper.
- `ImageMessage`/`VideoMessage`/`AudioMessage`/`DocumentMessage`/`StickerMessage`: the media descriptors carrying `url`, `mimetype`, `fileSha256`, `fileEncSha256`, `mediaKey`, `directPath`, `fileLength`, dimensions, `jpegThumbnail`, plus `ContextInfo` at field 17. `VideoMessage.Types.Attribution` enum (`:5682`); `ExtendedTextMessage.Types.{FontType,PreviewType}` (`:2708`,`:2734`).
- `ProtocolMessage` (`:7895`) with `Types.Type` enum (`:7900`) — the control-plane sub-message: REVOKE, EPHEMERAL_SETTING, history-sync notification, app-state-sync key share/request/fingerprint, peer-data-operation, etc. Nested: `HistorySyncNotification` (`:8985`, with `Types.HistorySyncType` `:8990` = INITIAL_BOOTSTRAP/INITIAL_STATUS_V3/FULL/RECENT/PUSH_NAME/NON_BLOCKING_DATA/ON_DEMAND), `AppStateSyncKeyShare`/`Id`/`Data`/`Fingerprint`/`Request` (`:10549`,`:9837`,`:10004`,`:10293`,`:10922`), `PeerDataOperationRequestMessage` (`:11429`) and its response (`:12178`).
- Payment family (`SendPaymentMessage` `:15718`, `RequestPaymentMessage` `:15952`, decline/cancel), `TemplateMessage` (`:18341` — `FourRowTemplate`, `HydratedFourRowTemplate`), `HighlyStructuredMessage` (`:13692` — HSM localizable params, `HSMCurrency`, `HSMDateTime`).
- Newer types: `PollCreationMessage`+`Option` (`:22482`,`:22487`), `PollUpdateMessage`/`PollEncValue`/`PollVoteMessage` (`:23016`,`:23479`,`:23700`), `EventMessage` (`:25759`), `CallLogMessage`+`CallParticipant` (`:27351`,`:27386`, enums `CallType`/`CallOutcome`), `SecretEncryptedMessage` (`:24609`, `Types.SecretEncType` `:24614`), `AlbumMessage` (`:28170`).

`Message.cs` contains **416 `FieldNumber` constants** across its nested tree (verified count) — this is the densest type in the assembly. **Role: wire (E2E payload).** This is the plaintext that the JS Signal layer encrypts; the C# shell does not construct it (the live producer is the JS bundle).

### 3.3 Family B — Context & shared sub-types

`WhatsApp.ProtoBuf/ContextInfo.cs` (899 lines, SilentOrbit). Root fields (`ContextInfo.cs:239`+): `StanzaId` (quoted-message id), `Participant`, `QuotedMessage` (`Message`), `RemoteJid`, `MentionedJid` (`List<string>`), `ConversionSource`/`ConversionData`/`ConversionDelaySeconds` (click-to-WhatsApp ad attribution), `ForwardingScore`/`IsForwarded`, `QuotedAd` (`AdReplyInfo`, nested class `:10`), `PlaceholderKey` (`MessageKey`), `Expiration`/`EphemeralSettingTimestamp`/`EphemeralSharedSecret`, `DisappearingMode`, `GroupMentions`. Embedded in nearly every content message at field 17.

`WhatsApp.ProtoBuf/MessageKey.cs:7` (SilentOrbit) — the universal message identity: `RemoteJid`, `FromMe` (`bool?`), `Id`, `Participant`. Used across `WebMessageInfo`, `ProtocolMessage`, reactions, polls.

Other shared sub-types (SilentOrbit, in `WhatsApp.ProtoBuf/`): `Location.cs`, `Point.cs`, `DisappearingMode.cs`, `GroupMention.cs`, `GroupParticipant.cs`, `InteractiveAnnotation.cs`, `PaymentInfo.cs`, `TemplateButton.cs`/`HydratedTemplateButton.cs`, `StickerMetadata.cs`, `Pushname.cs`, `MediaRetryNotification.cs`, `EditAddon.cs`, `PinInChat.cs`/`KeepInChat.cs`, `PollUpdate.cs`/`PollAdditionalMetadata.cs`, `EventResponse.cs`/`EventAdditionalMetadata.cs`, `CommentMetadata.cs`, `MessageSecretMessage.cs`, `MessageContextInfo.cs`/`MessageAddOnContextInfo.cs`.

### 3.4 Family C — History sync envelope (`HistorySync`)

`WhatsApp.ProtoBuf/HistorySync.cs:8` (SilentOrbit, 566 lines). The decrypted payload of a `HistorySyncNotification` blob. Root fields (`:27`+):

```
SyncType : HistorySyncType {INITIAL_BOOTSTRAP, INITIAL_STATUS_V3, FULL, RECENT, PUSH_NAME, NON_BLOCKING_DATA, ON_DEMAND}  (field 1, case 8)
Conversations          : List<Conversation>
StatusV3Messages       : List<WebMessageInfo>
ChunkOrder, Progress   : uint?
Pushnames              : List<Pushname>
GlobalSettings         : GlobalSettings
ThreadIdUserSecret     : byte[]
ThreadDsTimeframeOffset: uint?
RecentStickers         : List<StickerMetadata>
PastParticipants       : List<PastParticipants>
CallLogRecords         : List<CallLogRecord>
AiWaitListState        : BotAIWaitListState? {IN_WAITLIST, AI_AVAILABLE}
PhoneNumberToLidMappings: List<PhoneNumberToLIDMapping>
CompanionMetaNonce     : string
```

`HistorySync.cs:21` defines `BotAIWaitListState`. Supporting: `HistorySyncMsg.cs` (per-message wrapper), `Conversation.cs` (1289 lines — the per-chat record: messages + chat metadata), `WebMessageInfo.cs` (1589 lines — the canonical stored-message envelope, §3.5). **Role: storage / bootstrap** (a full account snapshot streamed at link time, then written to SQLite). Consumed by the JS bundle and the SyncD/DataModels layer (doc 32); `SeamlessMigrationManager.cs` references these for cleanup.

### 3.5 Family D — Stored-message envelope (`WebMessageInfo`)

`WhatsApp.ProtoBuf/WebMessageInfo.cs` (1589 lines, SilentOrbit). The "row" form of a message as persisted/synced. Root fields (`:181`+): `Key` (`MessageKey`), `Message` (the content `Message`), `MessageTimestamp` (`ulong?`), `status` (`Status` enum `:11` = ERROR/PENDING/SERVER_ACK/DELIVERY_ACK/READ/PLAYED), `Participant`, `Ignore`/`Starred`/`Broadcast`/`Multicast`, `PushName`, `MediaCiphertextSha256`, `MessageStubType` (`StubType` enum `:21`) + `MessageStubParameters` (system/notification messages), `Labels`, `PaymentInfo`/`QuotedPaymentInfo`, `FinalLiveLocation`, ephemeral timestamps/duration, `BizPrivacyStatus` (`:173`), `VerifiedBizName`, `UserReceipt` (`List<UserReceipt>`), `Reactions`, `PollUpdates`/`PollAdditionalMetadata`, `KeepInChat`/`PinInChat`, `CommentMetadata`, `EventResponses`/`EventAdditionalMetadata`, `IsMentionedInStatus`. **Role: storage** (the durable message model). The DataModels `Message`/`Conversation`/`UserStatus` entities (doc 32) wrap this.

### 3.6 Family E — App-state SyncD (`Syncd*`, Google codec)

The 14 Google-codec types inside `WhatsApp.ProtoBuf/` are the LTHash app-state sync mechanism (the cross-device settings/labels/contacts collections). Descriptors come from `ServersyncReflection.cs`.

| Type | File | Fields |
|---|---|---|
| `SyncdMutation` | `SyncdMutation.cs:8` | `Operation`:{Set=0,Remove=1} (1), `Record`:SyncdRecord (2) |
| `SyncdRecord` | `SyncdRecord.cs:8` | `Index`:SyncdIndex (1), `Value`:SyncdValue (2), `KeyId`:KeyId (3) |
| `SyncdIndex` | `SyncdIndex.cs` | `Blob`:bytes (1) |
| `SyncdValue` | `SyncdValue.cs` | `Blob`:bytes (1) — the AES-encrypted, MAC'd `SyncActionData` |
| `SyncdMutations` | `SyncdMutations.cs` | `Mutations`:repeated SyncdMutation (1) |
| `SyncdPatch` | `SyncdPatch.cs` | `Version` (1), `Mutations` (2), `ExternalMutations`:ExternalBlobReference (3), `SnapshotMac` (4), `PatchMac` (5), `KeyId` (6), `ExitCode` (7), `DeviceIndex` (8) |
| `SyncdSnapshot` | `SyncdSnapshot.cs` | `Version` (1), `Records`:repeated (2), `Mac` (3), `KeyId` (4) |
| `SyncdVersion` | `SyncdVersion.cs` | `Version`:uint64 (1) |
| `KeyId` | `KeyId.cs` | the app-state-sync key id |
| `ExternalBlobReference` | `ExternalBlobReference.cs` | mmg blob handle for large patches |
| `ExitCode` | `ExitCode.cs` | patch error |

The **decrypted** mutation payload is `WhatsApp.GProtoBuf/SyncActionData.cs:8`: `Index`:bytes (1), `Value`:SyncActionValue (2), `Padding`:bytes (3), `Version`:int32 (4). `WhatsApp.GProtoBuf/SyncActionValue.cs` is the giant union of **53 action/setting sub-messages** (verified count of top-level fields), each a real protobuf field on `SyncActionValue` with `Timestamp` at field 1. Representative field map (`SyncActionValue.cs:12205`+):

```
1  Timestamp                2  StarAction              3  ContactAction          4  MuteAction
5  PinAction                6  SecurityNotificationSetting   7  PushNameSetting   8  QuickReplyAction
11 RecentEmojiWeightsAction 14 LabelEditAction         15 LabelAssociationAction 16 LocaleSetting
17 ArchiveChatAction        18 DeleteMessageForMeAction 19 KeyExpiration          20 MarkChatAsReadAction
21 ClearChatAction          22 DeleteChatAction        23 UnarchiveChatsSetting  24 PrimaryFeature
26 AndroidUnsupportedActions 27 AgentAction            28 SubscriptionAction     29 UserStatusMuteAction
30 TimeFormatAction         31 NuxAction               32 PrimaryVersionAction   33 StickerAction
34 RemoveRecentStickerAction 35 ChatAssignment        36 ChatAssignmentOpenedStatus  37 PnForLidChatAction
38 MarketingMessageAction   39 MarketingMessageBroadcastAction  40 ExternalWebBetaAction
41 PrivacySettingRelayAllCalls 42 CallLogAction       44 StatusPrivacy          45 BotWelcomeRequestAction
46 DeleteIndividualCallLog  47 LabelReorderingAction   48 PaymentInfoAction      49 CustomPaymentMethodsAction
50 LockChatAction           51 ChatLockSettings        52 WamoUserIdentifierAction
53 PrivacySettingDisableLinkPreviewsAction  54 DeviceCapabilities  55 NoteEditAction  56 FavoritesAction
57 MerchantPaymentPartnerAction  58 WaffleAccountLinkStateAction  59 UsernameChatStartMode
```

(Gaps in numbering = deprecated/reserved fields.) **Role: storage + wire** (mutations travel over IQ stanzas as encrypted blobs, then merge into local SQLite collections — doc 32). `WhatsApp.GProtoBuf/SyncActionReflection.cs` imports `chat_lock_settings.proto` and `device_capabilities.proto`, hence `ChatLockSettings` (field 51) and `DeviceCapabilities` (field 54) are themselves separate protos referenced here.

**`DeviceCapabilities` full field set (verified, Google codec):** the proto is **single-field** — `ChatLockSupportLevel` at field 1 (`WhatsApp.ProtoBuf/DeviceCapabilities.cs:30 ChatLockSupportLevelFieldNumber = 1`), an enum `Types.ChatLockSupportLevel { NONE=0, MINIMAL=1, FULL=2 }` (`DeviceCapabilities.cs:13`-`21`). So in this client version, advertising "device capabilities" over app-state sync conveys exactly one thing: the device's chat-lock support tier. (The descriptor backing it is `device_capabilities.proto`, decoded from `DeviceCapabilitiesReflection.cs`.)

### 3.6a App-State Sync **runtime layer** — the SyncD collection/mutation domain model (managed, native-side)

§3.6 catalogs the *wire* protobuf types (`SyncdPatch`/`SyncdMutation`/`SyncdRecord`/…). This section documents the **runtime domain model** the native C# shell layers on top of them — the priority-classified collection taxonomy, the stored-mutation lifecycle, and the messages-vs-contacts DB routing that decide *where and in what order* a decoded mutation is persisted. These live in **`WhatsApp.DataModels.dll`**, namespace `WhatsApp.Sync.SyncD.Domain` (+ `.Services`), entirely separate from the `WhatsApp.Protobuf` assembly. They are **plain managed entities** — no WinRT projection, no native P/Invoke references any of them (verified: the only `decompiled/**` files that name these types are the SyncD domain/services sources themselves plus `WhatsApp.Core/WhatsApp/Wam.cs` telemetry; `grep -rln SyncD` over the WinRT/Bridge/Projection layer returns nothing). The source file paths embedded in the decompiled error strings — e.g. `WhatsApp.DataModels/SyncD/SyncDStoredMutation.cs` (`SyncDStoredMutation.cs:82`) — confirm the original tree layout `Samples/WinUI/WebView2/WhatsApp.DataModels/SyncD/`.

**(a) The 5 priority-classed collections — `SyncDCollection`.** `WhatsApp.Sync.SyncD.Domain/SyncDCollection.cs:3` is a 5-value enum (1-based): `Regular=1, Regular_Low=2, Regular_High=3, Critical_Block=4, Critical_Unblock_Low=5`. These are WhatsApp's app-state "collection" priority classes — the same five names that travel on the wire as the IQ `<collection name="…">` attribute. The native telemetry enum mirrors them exactly with the on-wire string forms: `WhatsApp.Core/WhatsApp/Wam.cs:6318 enum Collection` → `[Display(Name="regular")] Regular=1`, `regular_low`, `regular_high`, `critical_block`, `critical_unblock_low` (`Wam.cs:6320`-`6330`). A second telemetry enum `Wam.cs:6332 CollectionReceiveAppState` (`background`/`foreground`/`chat_open`) records the *app foreground state* under which a collection's app-state was received — i.e. delivery is scheduled differently by collection priority **and** by whether the user is backgrounded, foregrounded, or has a chat open. **Inferred** (naming, not traced to a scheduler in C#): `Critical_Block` is the highest-urgency class (push-name / locale — identity-shaping settings that must apply before the UI settles), `Critical_Unblock_Low` is a critical-but-deferrable class (contacts), and `Regular_High`/`Regular`/`Regular_Low` are descending-urgency batches for everything else.

**(b) The type→collection routing table — `SyncDType` + `SyncDTypeExt.GetCollection`.** `WhatsApp.Sync.SyncD.Domain/SyncDType.cs:3` is the **33-value app-state action taxonomy** (the native-side analogue of the `SyncActionValue` field set from §3.6), numbered non-contiguously: `Star=1, Pin_V1=2, Mute=3, Contact=4, Setting_PushName=6, Unknown=7, ExpiredKeyEpoch=8, Archive=9, Setting_Locale=10, MarkChatAsRead=11, DeleteMessageForMe=12, ClearChat=13, DeleteChat=14, Setting_UnarchiveChats=15, Primary_Feature=16, RemoveRecentSticker=17, FavoriteSticker=18, Label_Edit=19, Label_Jid=20, Label_Message=21, Call_Log=22, Quick_Reply=23, PnForLidChat=24, ShareOwnPn=25, UserStatusMute=26, Status_Privacy=27, Setting_RelayAllCalls=28, Setting_DisableLinkPreviews=29, Favorites=30, Device_Capabilities=31, Setting_ChatLock=32, Lock=33` (note: no `5` — value 5 is reserved/skipped; `Unknown=7` is a real sentinel used for forward-compat, see (e)).

`WhatsApp.Sync.SyncD.Domain/SyncDTypeExt.cs:9 GetCollection(this SyncDType)` is the **authoritative static routing switch** mapping each action type to its priority collection (this is the data that decides which `<collection>` a mutation rides in):

| `SyncDCollection` | `SyncDType` members (`SyncDTypeExt.cs`) |
|---|---|
| `Critical_Block` (`:46`) | `Setting_PushName`, `Setting_Locale` |
| `Critical_Unblock_Low` (`:44`) | `Contact` |
| `Regular_High` (`:33`) | `Star`, `Mute`, `ExpiredKeyEpoch`, `DeleteMessageForMe`, `ClearChat`, `DeleteChat`, `Call_Log`, `UserStatusMute`, `Status_Privacy`, `Favorites` |
| `Regular_Low` (`:23`) | `Pin_V1`, `Archive`, `MarkChatAsRead`, `Setting_UnarchiveChats`, `RemoveRecentSticker`, `FavoriteSticker`, `Device_Capabilities`, `Setting_ChatLock`, `Lock` |
| `Regular` (`:13`) | `Primary_Feature`, `Label_Edit`, `Label_Jid`, `Label_Message`, `Quick_Reply`, `PnForLidChat`, `ShareOwnPn`, `Setting_RelayAllCalls`, `Setting_DisableLinkPreviews` |

The switch is **total** — any `SyncDType` not listed (including `Unknown=7`) falls through to `throw new ArgumentOutOfRangeException` (`SyncDTypeExt.cs:50`), so `GetCollection` is only ever called on a recognized type. Two further extension methods refine *application order*: `GetOrder` (`:63`) forces `Setting_UnarchiveChats`→0 and `Label_Edit`→1 (everything else →100), i.e. unarchive-chats and label-definition edits are applied **before** the bulk of a batch (an unarchive must precede any chat mutation it gates; a label must exist before a `Label_Jid`/`Label_Message` association references it). `ToProtocolString` (`:73`) converts the enum name to the wire form by lower-casing the first letter of each `_`-split segment (`Setting_PushName` → `setting_PushName`); this is the `SyncDType` member of the `IProtocolStringConvertible` contract (`WhatsApp.Core/WhatsApp/IProtocolStringConvertible.cs`) and is what `SyncDMutation.BuildSyncDIndex` writes as the index head (see (d)).

**(c) The messages-vs-contacts DB-context routing — `SyncDDbContextType` + `GetContext`.** `WhatsApp.Sync.SyncD.Services/SyncDDbContextType.cs:3` is a 2-value enum `Messages=1, Contacts=2`. `SyncDTypeExt.cs:54 GetContext(this SyncDType)` routes the mutation to a physical database: **`Contact`→`SyncDDbContextType.Contacts`; everything else→`SyncDDbContextType.Messages`** (`SyncDTypeExt.cs:56`-`60`). This is a one-line but load-bearing fact: the client keeps **two separate SQLite stores** and the single `Contact` action type (the address-book sync) is the *only* SyncD action persisted into the Contacts DB; all 32 other action types land in the Messages DB. The two physical contexts are visible elsewhere in the dump as distinct classes — Messages side: `WhatsApp.VoIP/WhatsApp/IMessagesContext.cs` / `SqliteDataContext.cs`; Contacts side: `WhatsApp.VoIP/WhatsApp.Data/ContactsContext.cs` / `WhatsApp.VoIP/WhatsApp/SqliteContactsContext.cs`. The Messages DB physically holds a `SyncDMutations` table — proven by the literal SQL in `WhatsApp.VoIP/WhatsApp/SqliteDataContext.cs:1885`: `"SELECT COUNT(*) FROM SyncDMutations"` (exposed as `GetSyncDMutationCount()` at `:1883`). Note the **Critical/Regular collection priority and the Messages/Contacts DB context are orthogonal axes**: `Contact` is `Critical_Unblock_Low` *and* the only `Contacts`-DB type, while `Setting_PushName`/`Setting_Locale` are the other critical class but live in the Messages DB.

**(d) The persisted mutation row — `SyncDMutation` (a SQLite entity).** `WhatsApp.Sync.SyncD.Domain/SyncDMutation.cs:13` is a `DataContextEntity` (the INotifyPropertyChanging SQLite row base — `WhatsApp.DataModels/WhatsApp.Data/DataContextEntity.cs:8`) decorated `[Table(PurgeCache=true)]` with a unique index `DbIndexParams,Type` (`SyncDMutation.cs:11`-`12`). It is the **stored, decrypted-and-indexed** form of one `SyncdMutation` (§3.6), holding both the raw blob and lazily-materialized projections:

- `RecordId` (`:21`, db-generated PK), `DbIndexParams`:string (JSON-serialized index-param array), `IndexParams`:`string[]` (`:27`, lazily `JsonConvert.DeserializeObject` of `DbIndexParams`).
- `SyncDIndex`:string (`:30`) — lazily built by `BuildSyncDIndex()` (`:121`): `JsonConvert.SerializeObject(new[]{ Type.ToProtocolString() }.Concat(IndexParams))` — i.e. the full app-state **index** is `[<protocol-type-string>, …indexParams]` as a JSON array. This is the local mirror of the wire `SyncdIndex.Blob` (§3.6) in human/queryable JSON form.
- `DbValue`:`byte[]` (`:43`, the raw bytes) and `Value`:`SyncActionValue?` (`:45`, lazily `SyncActionValue.Parser.ParseFrom(DbValue)` — the **only** place the runtime layer touches the Google-codec protobuf from §3.6, via `WhatsApp.GProtoBuf`/`WhatsApp.ProtoBuf` `using`s at `:6`-`7`).
- `Operation`:`SyncdMutation.Types.SyncdOperation` (`:48`, the `{Set=0,Remove=1}` from the wire type — **reused directly** from `WhatsApp.ProtoBuf`, confirming the domain model imports the protobuf enum rather than redefining it), `Type`:`SyncDType` (`:51`), `DbType`:string (`:54`, holds the raw type string only when `Type==Unknown`), `KeyId`/`Mac`:`byte[]` (`:57`,`:60`, the app-state-sync key id and value-MAC), `FeatureVersion`:int (`:63`), `Collection`:int (`:66`, the numeric `SyncDCollection`).

The from-wire constructor `SyncDMutation(string indexJson, byte[] value, …)` (`:82`) shows the **decode path**: it parses the index JSON array, takes `array[0]` as the type via `array[0].ToEnumSafe(SyncDType.Unknown)` (`:90`, `WhatsApp.Core/WhatsApp/EnumExtensions.cs:35` — `Enum.TryParse`, falling back to `Unknown` on an unrecognized future type), keeps the remaining elements as `IndexParams`, and stashes the original string in `DbType` only when the type didn't resolve (`:91`-`98`) — the forward-compat carry-through for action types this client version doesn't know.

**(e) The stored-mutation lifecycle — `SyncDStoredMutation` + `SyncDMutationStatus`.** `WhatsApp.Sync.SyncD.Domain/SyncDStoredMutation.cs:12` subclasses `SyncDMutation`, adding the **application state machine** and epoch bookkeeping. Its status field is `SyncDMutationStatus` (`WhatsApp.Sync.SyncD.Domain/SyncDMutationStatus.cs:3`), a 5-value enum: `Orphaned=0, Applied=1, Invalid=2, UnsupportedVersion=3, Active=4`. Interpreted from the type set and decode logic: **`Applied`** = merged into the target DB table; **`Active`** = current authoritative value for its index; **`Orphaned`** = a mutation whose referenced entity isn't present yet (see the `OrphanEntityId` index below); **`Invalid`** = failed MAC/parse; **`UnsupportedVersion`** = a `Type==Unknown`/future-version mutation retained but not applied (the `DbType` carry-through from (d)). `SyncDStoredMutation` adds:
- `Status`:`SyncDMutationStatus` (`:17`, raises `NotifyPropertyChanging` on change), `Epoch`:int (`:34`), `DeviceId`:int (`:37`), `OrphanEntityId`:string? (`:40`).
- The ctor `SyncDStoredMutation(SyncDMutation mutation, SyncDMutationStatus status)` (`:46`) **derives `DeviceId`/`Epoch` from the `KeyId` bytes**: `DeviceId = ByteUtil.BigEndianBytesToShort(KeyId,0)` (the first big-endian uint16) and `Epoch = ByteUtil.BigEndianBytesToInt(KeyId,2)` (the next big-endian int32) — `SyncDStoredMutation.cs:52`-`53`, helpers at `WhatsApp.Core/WhatsApp/ByteUtil.cs:148`,`:138`. So the app-state-sync **`KeyId` is structurally `[deviceId:u16-BE][epoch:i32-BE][…]`**, and the client indexes stored mutations by `(Collection, Epoch)` for key-rotation/expiry handling (the `ExpiredKeyEpoch` action type at `SyncDType.cs:11` is the explicit epoch-expiry signal).
- `GetOrphanEntityId` (`:58`) computes a stable orphan key for the two label-association types only: `Label_Message` → `[IndexParams[1..4]]` (4 components) and `Label_Jid` → `[IndexParams[1]]`; all other types → null. This lets a label association that arrives **before** its target message/jid be stored as `Orphaned` and later resolved by `OrphanEntityId` lookup — hence the dedicated index.

> **Where the status transitions are decided (NOT in C#; recovered from the web engine).** The native dump only *stores* `SyncDMutationStatus`; no method assigns any enum value (whole-tree grep → 0 assignments; the symbol appears in only 2 files). The state machine runs in the **WebView2-hosted Kotlin-MP SyncD engine**, and — correcting an earlier read — it **does persist a per-row status column**, the close analogue of the native enum [bundle]. The web engine defines `SyncActionState = Mirrored(["Success", "Malformed", "Orphan", "Unsupported", "Skipped", "Failed"])` in the `WASyncdConst` module (`research/waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:224`; same module also defines `SyncModelType = Mirrored(["Msg","Chat","Agent","ChatAssignment","UserStatusMute","Account","FavoriteSticker","Thread"])` `:225`). Each row in the IndexedDB `SyncActionStore` carries this `actionState` field, written via `WAWebSyncdDb.updateSyncActionRows([{ index, actionState, modelType, modelId }])` (`xTiXmyjNEd_.js:21092`) and queried back by state via `getSyncActionsByActionStatesInTransaction([…])` / `getByActionStates([…])` (`xTiXmyjNEd_.js:35228`,`:35255`,`:35450`,`:36939`). **The lifecycle (and therefore the native enum's transition semantics) reads off as:** `applyMutations` returns a per-mutation `{actionState}` — a cleanly merged SET → `Success` (= native `Applied`); a value the client version cannot handle → `Unsupported` (= native `UnsupportedVersion`); a decode/index failure → `Malformed`/`Failed` (= native `Invalid`); a row whose dependency/target is absent → `Orphan` (= native `Orphaned`) (`xTiXmyjNEd_.js:37766`-`37790`,`:37607`). The **orphan rule** is explicit: the request-builder *drops* an orphaned REMOVE — `"syncd: dropping orphaned REMOVE mutation (no corresponding SET in SyncActionStore)"` returning `false` (`WAWebSyncdRequestBuilderBuild`, `xTiXmyjNEd_.js:88802`); incoming SETs with a missing target get `updateSyncActionRows(... actionState: Orphan ...)` (`:21092`). **Purge/retry** is `applyAllOrphansAndUnsupported()` (`WAWebSyncdOrphan`, `xTiXmyjNEd_.js:36938`-`36940`,`:37006`), which on app-resume re-queries rows in `{Orphan, Unsupported}` and re-runs `WAWebSyncdCollectionHandler.applyIndividualMutations(...)` (`:41396`) — i.e. orphaned/unsupported rows are *retained and retried*, not immediately purged. The native client's single `SyncDMutations` table keyed by the `SyncDMutationStatus` discriminator is thus the **native mirror of this web `SyncActionState` column**; the one residual difference is the native-only `Active` state (= "current authoritative value for its index", with no distinct web member — the web layer treats the live SET as simply present-and-`Success`). The orchestration classes (`KmpSyncdIncomingMutationHandlerImpl`/`KmpSyncdCollectionMutationStoreImpl`/`KmpSyncdCyclicMutationDependencyError` — bundle `xTiXmyjNEd_.js:65777`+) drive these assignments and additionally surface fatal/retriable conditions through the typed error tree (`KmpSyncdFatalError`/`KmpSyncdRetriableError`/`KmpSyncdFailedError`/`KmpSyncdStoreError`). See §6 Q7.
- Indexing (`SyncDStoredMutation.cs:6`-`11`): `[Table(PurgeCache=true)]`; non-unique `Type`; **unique** `DbIndexParams,Type,DbType` (the dedup key — one row per logical app-state index); non-unique `Collection,Epoch` (priority+key-epoch scans); **unique** `SyncDIndex` (named `SyncDMutation_SyncDIndex`); non-unique `OrphanEntityId`. The `[Table]`/`[Index]`/`[Column]` attributes are the project's own lightweight ORM (`WhatsApp.DataModels/WhatsApp/TableAttribute.cs`, `IndexAttribute.cs`, `ColumnAttribute.cs`) — code-generated SQLite DDL, not EF Core.

**(f) Where the actual patch-application loop runs.** The C# side provides the **typed storage substrate and the routing/priority/lifecycle metadata** above, but no C# method in the dump performs the LTHash patch-merge (decrypt `SyncdValue.Blob` → verify `SnapshotMac`/`PatchMac` → fold into the running LTHash → upsert `SyncDStoredMutation` rows). Consistent with the doc-wide finding (§3.2 / §5 / doc 32), that orchestration runs in the **WhatsApp Web JS bundle** (`waweb-source-bundle/`); the JS calls down through the SQLite bridge to read/write the `SyncDMutations` table whose schema these entities define. **Confirmed-from-code:** the domain types, their routing tables, and the `SyncDMutations` SQL table; **not located in C#:** the merge loop itself (see Open Questions §6).

**What the C# *does* prove about the (JS-side) LTHash algorithm — the `PatchDebugData` diagnostics proto.** Although no C# method folds the LTHash, the assembly carries a **diagnostics message that names the exact algorithm inputs**, which independently corroborates that the merge is an additive LTHash over per-mutation MACs. `WhatsApp.GProtoBuf/PatchDebugData.cs` (Google codec, descriptor at `SyncActionReflection.cs:109`-`114`) has 11 fields: `CurrentLthash`, `NewLthash`, `PatchVersion`, `CollectionName`, `FirstFourBytesFromAHashOfSnapshotMacKey`, `NewLthashSubtract`, `NumberAdd`, `NumberRemove`, `NumberOverride`, `SenderPlatform`, `IsSenderPrimary` (+ a `Types.Platform` enum). The presence of paired `NewLthash`/`NewLthashSubtract` and `NumberAdd`/`NumberRemove`/`NumberOverride` counters confirms the LTHash is an **additive/subtractive homomorphic hash** (add on Set, subtract on Remove), and `FirstFourBytesFromAHashOfSnapshotMacKey` confirms the snapshot MAC is keyed by a hash of the app-state-sync key — exactly the SyncD/LTHash design. The corresponding **telemetry** (`WhatsApp.Core/WhatsApp/Wam.cs`) names the failure modes the JS reports back: `lthash_inconsistency_on_snapshot_mac_mismatch` (`Wam.cs:14574`), `MacFatalCurrentLthashMismatch`/`MacFatalNewLthashMismatch` (`Wam.cs:57725`,`:57735`), `IsWebLthashConsistent` (`:57721`) — i.e. the *Web* layer computes and verifies the LTHash and reports consistency to native WAM, reinforcing that the merge runs in JS.

**(g) The recovered LTHash merge algorithm (cross-reference — open impls + the WebView2-hosted bundle, NOT disassembled from `WhatsAppNative.dll`).** The native dump proves the *inputs* (the `PatchDebugData` field names above) but not the loop; the loop is fully recovered from the open WA-protocol implementations and corroborated against the **exact bundle this native client hosts in WebView2** (`research/waweb-unmin/xTiXmyjNEd_.js`). The full mechanism (cross-reference: `whatsmeow/appstate/lthash/lthash.go`, `appstate/hash.go`, `appstate/decode.go`; bundle module `WACryptoLtHash`):

- **LTHash state & fold.** The running app-state hash is a **128-byte** buffer treated as 64 little-endian `uint16` lanes. A patch's new hash is `LTHash' = LTHash − Σ(removed valueMACs) + Σ(added valueMACs)`, where each operand is the mutation's **32-byte value-MAC HKDF-SHA256-expanded to 128 bytes** keyed/info'd with the literal ASCII string **`"WhatsApp Patch Integrity"`**, and `±` is **pointwise uint16 add/subtract with wraparound**. Set ⇒ add; Remove (and the prior value of an overwritten index) ⇒ subtract. Bundle proof: `WACryptoLtHash` defines `KEY_LENGTH_BYTES=128`, step `2`, `EMPTY_LT_HASH=new ArrayBuffer(128)`, `LtHash16.subtractThenAdd`, and `performPointwiseWithOverflow` writing `setUint16(…, !0)` (little-endian), with `m = new d("WhatsApp Patch Integrity")` exported as `LT_HASH_ANTI_TAMPERING` (`xTiXmyjNEd_.js:207`-`281`). whatsmeow mirror: `WAPatchIntegrity = LTHash{"WhatsApp Patch Integrity", 128}` + `SubtractThenAddInPlace` + `performPointwiseWithOverflow` over `binary.LittleEndian.Uint16` (`lthash.go:25`-`57`), driven by `HashState.updateHash` (`hash.go:38`-`66`). This is exactly the additive/subtractive homomorphic hash the native `PatchDebugData.NewLthash`/`NewLthashSubtract`/`NumberAdd`/`NumberRemove` fields imply.
- **Per-mutation decode + value-MAC verify.** For each `SyncdMutation`: split `SyncdValue.Blob` into `content‖valueMAC(32)`; recompute `valueMAC = HMAC-SHA512(valueMacKey, [op+1]‖keyId‖content‖u64BE(len(keyId)+1))[:32]` and compare; then AES-256-CBC-decrypt `content` (`iv = content[:16]`) with `valueEncryptionKey` to get the `SyncActionData` plaintext; verify `indexMAC = HMAC-SHA256(indexKey, syncAction.Index)` against the record's index blob (cross-reference: `whatsmeow/appstate/decode.go decodeMutation` `:128`-`190`; same ops in the bundle's `wa-kmp-syncd-engine-crypto` at `xTiXmyjNEd_.js:9261`-`9332`).
- **Collection-level MAC chain.** `snapshotMAC = HMAC-SHA256(snapshotMacKey, LTHash‖u64BE(version)‖collectionName)`; `patchMAC = HMAC-SHA256(patchMacKey, snapshotMAC‖{each added valueMAC}‖u64BE(version)‖collectionName)` (cross-reference: `whatsmeow/appstate/hash.go generateSnapshotMAC`/`generatePatchMAC` `:96`-`106`; bundle `generateSnapshotMac`/`generatePatchMac` at `xTiXmyjNEd_.js:9302`,`:9316`,`:9684`-`9685`). A snapshot-MAC mismatch is the `lthash_inconsistency_on_snapshot_mac_mismatch` WAM event; the `FirstFourBytesFromAHashOfSnapshotMacKey` debug field is a 4-byte fingerprint of `snapshotMacKey`.
- **The 5 derived keys.** All of the above keys come from **one HKDF expansion of the app-state-sync key**, sliced in order `indexKey ‖ valueEncryptionKey ‖ valueMacKey ‖ snapshotMacKey ‖ patchMacKey` (bundle `WAWebSyncdCryptoHelper.generateEncryptionKeys` slices these exact five in this order, `xTiXmyjNEd_.js:9537`-`9548`; whatsmeow `ExpandedAppStateKeys`). These five names line up 1:1 with the native `PatchDebugData`/WAM vocabulary, anchoring the recovered algorithm to this build. **Port note:** a Linux/Electron port that relays SyncD bytes through the renderer inherits this for free (the bundle's `WACryptoLtHash`/`wa-kmp-syncd-engine-*` run unchanged); only a *native* app-state implementation needs to re-author the four bullets above.

### 3.7 Family F — Connection login payload (`ClientPayload`) — the one the native shell actually builds

`WhatsApp.ProtoBuf/ClientPayload.cs:9` (SilentOrbit, 2764 lines). This is the **authenticated handshake payload** sent inside the Noise `ClientHello`/`ClientFinish`. Proven by `WhatsApp.Root/WhatsApp/HandshakeHandler.cs:226 BuildClientPayload()`:

```csharp
return ClientPayload.SerializeToBytes(new ClientPayload {
    Username     = ulong.Parse(_username),         // phone-number JID user part
    Passive      = true,
    PushName     = _pushName,
    Device       = _myDeviceId,
    connect_type = CurrentConnectionType(),         // ClientPayload.ConnectType (WIFI_UNKNOWN / CELLULAR_*)
    Pull         = _connectInPullMode,
    UserAgentField = new ClientPayload.UserAgent {
        platform        = ClientPayload.UserAgent.Platform.WINDOWS,   // <-- this client identifies as WINDOWS
        AppVersionField = new ClientPayload.UserAgent.AppVersion { Primary, Secondary, Tertiary, Quaternary },
        Mcc = "000", Mnc = "000",
        OsVersion = "{Major}.{Minor}.{Build}",
        Manufacturer, Device = "{Name} H{HardwareVersion}", OsBuildNumber,
        LocaleLanguageIso6391 = lang, LocaleCountryIso31661Alpha2 = locale,
        release_channel = Constants.ReleaseChannel },
    WebInfoField = null,
    connect_reason = ClientPayload.ConnectReason.USER_ACTIVATED,
    LidDbMigrated  = _isLidDbMigrated });
```

The encrypted result is handed to `_cipher.encryptPayload(...)` and placed in `HandshakeMessage.ClientHello.Payload`/`ClientFinish.Payload` (`HandshakeHandler.cs:91`,`:202`). Key nested enums in `ClientPayload.cs`: `UserAgent.Platform` (`:61`, 33 values incl. `WINDOWS=13`, `MACOS`, `WEB`, `ANDROID`, `IOS`…), `UserAgent.ReleaseChannel` (`:98` RELEASE/BETA/ALPHA/DEBUG), `UserAgent.AppVersion` (`:106` Primary..Quinary), `ConnectReason` (`:18`), `ConnectType` (`:28`, cellular radio taxonomy 100–112), `Product` (`:47` WHATSAPP/MESSENGER), `TrafficAnonymization` (`:53`), `IOSAppExtension` (`:11`). **Role: wire (login).** This is the **single most load-bearing protobuf in the C# shell.**

`WhatsApp.ProtoBuf/HandshakeMessage.cs:6` (SilentOrbit) is the Noise wrapper: `ClientHello{Ephemeral,Static,Payload}` (`:8`), `ServerHello{Ephemeral,Static,Payload}` (`:185`), `ClientFinish{Static,Payload}` (`:362`), with root oneof-style fields `ClientHelloField`/`ServerHelloField`/`ClientFinishField` (`:523`). Consumed by the Noise handshake (doc 11). Related login/cert protos in `WhatsApp.ProtoBuf/`: `NoiseCertificate.cs`/`CertChain.cs` (server cert validated at `WACertificateVerificationUtils.cs`), `VerifiedNameCertificate.cs`, `WebFeatures.cs`, `DeviceProps.cs`, `WebNotificationsInfo.cs`.

### 3.8 Family G — Companion-device pairing ADV (`adv.proto` → `Whatsapp` namespace)

`Whatsapp/` (6 files, Google codec, package `proto`, from `AdvReflection.cs`). These are the multi-device account-signature chain:

| Type | File | Fields |
|---|---|---|
| `ADVSignedDeviceIdentity` | `ADVSignedDeviceIdentity.cs:8` | `Details` (1), `AccountSignatureKey` (2), `AccountSignature` (3), `DeviceSignature` (4) — all bytes |
| `ADVSignedDeviceIdentityHMAC` | `ADVSignedDeviceIdentityHMAC.cs` | `Details` (1), `Hmac` (2) |
| `ADVDeviceIdentity` | `ADVDeviceIdentity.cs` | `RawId` (1), `Timestamp` (2), `KeyIndex` (3) |
| `ADVKeyIndexList` | `ADVKeyIndexList.cs` | `RawId` (1), `Timestamp` (2), `CurrentIndex` (3), `ValidIndexes` (4) |
| `ADVSignedKeyIndexList` | `ADVSignedKeyIndexList.cs` | `Details` (1), `AccountSignature` (2) |

`ADVSignedDeviceIdentity.WriteTo` (`:227`) confirms tags 10/18/26/34. **Role: pairing (wire + storage).** The native shell only verifies the curve25519 signatures of these (`AdvBridge.Verify`, doc 21); the QR/ref handshake and identity generation run in JS. Companion-side pairing protos `CompanionEphemeralIdentity.cs`, `PrimaryEphemeralIdentity.cs`, `EncryptedPairingRequest.cs` live in `WhatsApp.ProtoBuf/` (SilentOrbit). `EncryptedPairingRequest` carries the AES-encrypted payload + IV; `CompanionEphemeralIdentity` carries the companion public key + `DeviceProps.PlatformType` + QR `Ref`.

### 3.9 Family H — Signal key-state structs (SilentOrbit) — persisted, not wire

These are the **on-disk** libsignal records (doc 20 covers the crypto). All SilentOrbit, all in `WhatsApp.ProtoBuf/`:
- `IdentityKeyPairStructure.cs` (`PublicKey`,`PrivateKey`), `PreKeyRecordStructure.cs` (`Id`,`PublicKey`,`PrivateKey`), `SignedPreKeyRecordStructure.cs` (+`Signature`,`Timestamp`), `KeyId.cs`.
- `RecordStructure.cs` (CurrentSession + PreviousSessions), `SessionStructure.cs` (root key, sender/receiver chains, message keys, pending key exchange / pending prekey).
- `SenderKeyRecordStructure.cs`, `SenderKeyStateStructure.cs` (group sender-key chain + signing key).
- `CombinedFingerprint.cs`/`FingerprintData.cs` (the safety-number QR/numeric fingerprint), `MessageSecretMessage.cs`.

**Role: storage** (serialized into the encrypted SQLite stores; the ratchet math is JS/native, not C#).

### 3.10 Family I — Bot / settings / misc

SilentOrbit types in `WhatsApp.ProtoBuf/` backing newer surfaces: `BotMetadata.cs`/`BotAvatarMetadata.cs`/`BotPluginMetadata.cs`/`BotSuggestedPromptMetadata.cs`, `AvatarUserSettings.cs`, `AutoDownloadSettings.cs`, `GlobalSettings.cs`, `NotificationSettings.cs`/`NotificationMessageInfo.cs`, `ChatLockSettings.cs`, `EphemeralSetting.cs`, `MediaVisibility.cs`, `WallpaperSettings.cs`, `CallLogRecord.cs`, `PhoneNumberToLIDMapping.cs` (phone↔LID identity mapping), `PastParticipant.cs`/`PastParticipants.cs`, `ServerErrorReceipt.cs`, `UserReceipt.cs`. Google-codec extras in `WhatsApp.GProtoBuf/`: `UserPassword.cs` (chat-lock password KDF spec with `Encoding`/`Transformer`/`TransformerArg` enums), `RecentEmojiWeight.cs`, `PatchDebugData.cs`, `TemplateButton.cs`.

### 3.11 Family J — Positron data-export POCOs (`WhatsApp` namespace)

`WhatsApp/` (16 files, SilentOrbit, **no `.proto` source** — hand-written DTOs). Root `WhatsApp/PositronData.cs:7`:

```
DataSource      : PositronDataSource?
Messages        : List<PositronMessage>
Chats           : List<PositronChat>
Contacts        : List<PositronContact>
GroupMetadata   : List<PositronGroupMetadata>
GroupParticipants: List<PositronGroupParticipants>
Reactions       : List<PositronReaction>
```

`PositronMessage`/`PositronChat` implement `WhatsApp/IWebData.cs:3`, a web-data marker exposing `{ Key, Revision }` (not all `Positron*` types implement it — e.g. `PositronContact` does not). Large companion `WhatsApp/MessageProperties.cs` (9445 lines) and `WhatsApp/ConversationProperties.cs`/`UserStatusProperties.cs`/`PendingMsgProperties.cs` hold the flattened property bags. `WhatsApp/WinMessages.cs:7` and `WhatsApp/BizAutomatedType.cs` round out the namespace.

**Role: storage / data-import.** The only C# consumer outside `WhatsApp.Protobuf` is `WhatsApp.VoIP/WhatsApp.Positron.Sqlite/MessagesContext.cs` — a SQLite `DataContext` over a fixed DB file **`messages.db`** (`MessagesContext.cs:12 DbName = "messages.db"`) exposing `Table<Message>/<Conversation>/<UserStatus>/<JidInfo>` (`MessagesContext.cs:20`-`26`); it is the local message store reader, *not* a wire path. `MessagesContext` carries **no schema-version table or migration gate** — only `DatabaseExists()`/`CreateDatabase()` (`MessagesContext.cs:31`,`:52`-`55`).

**Live-on-disk status of the Positron store (forensic, this build) [live-appdata, doc 94 §1].** A real appdata dump of the running current WebView2-hosted build contains **7 native session DBs — `session.db`, `nativeSettings.db`, `abprops.db`, `contacts.db`, `contactsState.db`, `genericStorage.db`, `mediaDownloads.db` — and `messages.db` (the Positron store) is NOT present** (nor are the other legacy stores `axolotl.db`/`syncd.db`/`calls.db`/`settings.db`/`concur.db`/`emojidict.db`, which appear *only* in the SeamlessMigration clean-slate delete list `SeamlessMigrationManager.cs:862`). So the current build **neither creates nor carries a Positron `messages.db`**; it persists message data in the plaintext WebView IndexedDB instead (`model-storage.message` et al. — doc 95). This live-confirms the §3.11 inference: Positron is a **legacy native local store the current client only reads/migrates-from and then deletes**, superseded by IndexedDB. **Verified provenance facts:** (a) **nothing in the C# dump ever *writes/serializes* `PositronData`** — a whole-tree grep for `PositronData` outside `WhatsApp.Protobuf/WhatsApp/` returns zero hits, so these DTOs are read/consumed only, never produced by this client; (b) `PositronDataSource` is just the 6-way collection tag `{MESSAGES=1, CHATS, CONTACTS, GROUP_METADATA, GROUP_PARTICIPANTS, REACTIONS}` (`WhatsApp/PositronDataSource.cs:3`), i.e. an export/import bundle descriptor, not a version stamp; (c) the same `messages.db` file is the one the **`SeamlessMigrationManager`** opens (`WhatsApp.Root/WhatsApp.SeamlessMigration/SeamlessMigrationManager.cs:272`) and can delete alongside `axolotl.db`/`syncd.db`/`contacts.db`/`calls.db` during a clean-slate migration (`SeamlessMigrationManager.cs:862`). **Inferred (still):** "Positron" is the legacy/native local-store data model consumed when importing an older Windows store; it is *not* sent on the wire. The exact originating Windows version that *wrote* Positron blobs is still not identifiable from the dump (no writer/version gate present) — see §6.

---

## 4. Native Dependencies

- **`Google.Protobuf.dll`** — bundled in `x64/` (`WhatsApp.Protobuf.csproj:16`). The `WhatsApp.GProtoBuf`, `Whatsapp` (ADV), and the 14 `Syncd*`/cert/devicecaps types in `WhatsApp.ProtoBuf` depend on it at runtime (reflection, `CodedInputStream`, `JsonFormatter.ToDiagnosticString`). **Confirmed.**
- **`SilentOrbit.ProtocolBuffers`** — the hand-rolled codec is **vendored in-assembly** (`SilentOrbit.ProtocolBuffers/*.cs`, 9 files). No external dependency. **Confirmed.**
- **No native C++/Rust dependency.** Protobuf marshalling is pure managed C#. The native `WhatsAppNative` curve25519/AES touch only the *contents* of these blobs (e.g. signing `ADVSignedDeviceIdentity.Details`, encrypting `SyncdValue.Blob`, deriving from `ClientPayload`'s session) — not the protobuf framing. **Confirmed** (no P/Invoke or WinRT projection in any `WhatsApp.Protobuf` file).
- **Cross-assembly producers/consumers:** `WhatsApp.Root/WhatsApp/HandshakeHandler.cs` (builds `ClientPayload`/`HandshakeMessage`); `WhatsApp.Root/WhatsApp/WACertificateVerificationUtils.cs` (`NoiseCertificate`/`CertChain`); `WhatsApp.DataModels` (wraps `WebMessageInfo`/`Conversation`/`SyncActionValue` — doc 32); `WhatsApp.VoIP/WhatsApp.Positron.Sqlite/MessagesContext.cs` (Positron). **Confirmed.**

---

## 5. Linux/Electron Port Mapping

The high-leverage insight: **you almost never need to author these protos in the port.** The live producer/consumer for the message tree, history sync, SyncD, and pairing is the **WhatsApp Web JS bundle** (`waweb-source-bundle/`), which already carries its own protobuf definitions and runs unchanged inside Electron's renderer. The native shell only needs to mirror the **few** protos it builds itself.

| Windows piece | Port equivalent | Notes / risk |
|---|---|---|
| **`ClientPayload` (login)** + **`HandshakeMessage`** | `protobufjs` (or `ts-proto`) with a `.proto` reconstructed from §3.7. Pair with a Noise impl (`@noble/curves` x25519 + AES-GCM, or `noise-c`). | **Must reimplement natively** — this is the auth payload the Node connection layer sends. `platform` must be set appropriately; the Windows client uses `WINDOWS=13`. Reconstruct field numbers from `ClientPayload.cs`/`HandshakeMessage.cs`. **Highest-priority port artifact.** |
| **`Message` E2E tree** (e2e.proto) | Reuse the JS bundle's own protobuf (it already encodes/decodes content) **or** `protobufjs` + the public `whatsapp` `.proto` (matches field numbers in §3.2). | Low risk: if the JS Signal layer stays in the renderer, the port never touches this. Only needed if you move message encryption out of JS. |
| **`HistorySync` / `WebMessageInfo` / `Conversation`** | Same — consumed inside JS; persist via `better-sqlite3`. | Storage concern, not wire. Map to the SQLite schema (doc 32). |
| **`Syncd*` + `SyncActionData`/`SyncActionValue`** | `protobufjs`; LTHash merge logic lives in JS. | Wire blobs flow through IQ; the port just relays bytes. Reauthor only if doing app-state sync natively. |
| **ADV pairing (`adv.proto`)** | `protobufjs` + `@noble/curves` for the curve25519 account/device signatures. | The native responsibility is *signature verify/sign* (doc 21); proto framing is trivial. |
| **Signal key structs** (`*Structure.cs`) | If using `libsignal` (Node bindings) it owns its own serialization — you likely **discard these structs entirely** and let libsignal persist sessions. | Risk: WhatsApp's stored format may differ from upstream libsignal; if importing an existing session you must match these structs. Otherwise greenfield via libsignal. |
| **SilentOrbit + Google dual codec** | Single `protobufjs`/`ts-proto` per `.proto`. | The Windows duplication is a build artifact; the port needs **one** generator. |
| **Positron DTOs** | Skip unless importing a legacy Windows local store. | No wire role; only relevant for a Windows→Linux data migration tool. |

**Gaps / risks:**
- The `.proto` sources are **not in the dump** (only compiled descriptors). For the Google-codec types you can **recover exact `.proto` text** by base64-decoding the `FileDescriptor` blobs in each `*Reflection.cs` and running `protoc --decode=google.protobuf.FileDescriptorProto` — this is the most reliable way to regenerate `e2e.proto`, `sync_action.proto`, `protocol.proto`, `adv.proto`, etc. For the SilentOrbit-only types (e.g. `ClientPayload`, `HistorySync`) there is **no descriptor**; field numbers must be read off the `case`/tag-byte constants in the `.cs` (the catalog in §3 gives them).
- **What can be reused from the waweb JS bundle:** its embedded protobuf schema is the source of truth for the message tree, history sync, SyncD, and most settings protos — preferring it avoids hand-transcription errors. The native port should only own `ClientPayload`/`HandshakeMessage` and the ADV signature flow.

---

## 6. Open Questions / Unverified

Each item below was **re-investigated this session** against the readable C# dump, the decoded Google `FileDescriptor` blobs, and the `waweb-source-bundle/` JS; every item now carries a verdict tag, the concrete finding, and a citation. Original question text is preserved.

1. **[RESOLVED via cross-reference]** *Exact `.proto` field text for SilentOrbit-only types (`ClientPayload`, `HistorySync`, `WebMessageInfo`, `Conversation`, `ContextInfo`) — default values, packed-repeated flags, and `oneof` groupings not directly visible in the hand-rolled codec.* The C#-side observations still hold: the SilentOrbit codec is **presence-based** — serialize methods gate every field on a nullable/null check (`ClientPayload.cs:272`-`292` `if (instance.Primary.HasValue)…`, `:588`-`622`), and the `Message` content "union" is presence-based, independently confirmed by the bundle's all-fields-null guard (`conversation==null && e.extendedTextMessage==null && … && e.albumMessage==null`). **Round-2 closes the byte-exact residual:** whatsmeow ships the **actual `.proto` source** for every one of these types — `ClientPayload`→`proto/waWa6/WAWebProtobufsWa6.proto:53`, `HistorySync`→`proto/waHistorySync/WAWebProtobufsHistorySync.proto`, `WebMessageInfo`+`Conversation`→`proto/waWeb/WAWebProtobufsWeb.proto`, `ContextInfo`→`proto/waE2E/WAWebProtobufsE2E.proto:1216`. From those (cross-reference: whatsmeow proto sources):
   - **Syntax = `proto2`** for all four files (`WAWebProtobufsWa6.proto:1`, `WAWebProtobufsHistorySync.proto:1`, `WAWebProtobufsWeb.proto:1`, `WAWebProtobufsE2E.proto:1`). This is *why* the SilentOrbit C# is nullable/presence-based: proto2 has explicit per-field presence and emits **no implicit scalar defaults on the wire**.
   - **Defaults:** there are **no `[default = …]` value overrides** anywhere in these schemas (a grep for `default =` finds only a field literally *named* `default` at `WAWebProtobufsE2E.proto:667`), so every scalar takes the standard proto2 zero/empty default — confirming the SilentOrbit codec's "writes no explicit default" behaviour is correct, not lossy.
   - **Packed flags:** proto2 `repeated` scalars are **unpacked by default**, and that default holds for these types — e.g. `ClientPayload.shards` (`repeated int32 … = 14`) and `pairedPeripherals` (`repeated string … = 47`) carry **no** `[packed=true]` (`WAWebProtobufsWa6.proto:271`,`:296`). Where WA *does* want packing it is explicit, e.g. `e2e.proto`'s `deviceIndexes`/`senderKeyIndexes`/`recipientKeyIndexes` are `repeated uint32 … [packed=true]` (`WAWebProtobufsE2E.proto:2195`,`:2392`,`:2397`). The SilentOrbit reader's accept-both-encodings tolerance is therefore harmless: the canonical wire form is recoverable field-by-field from the proto.
   - **`oneof` groupings:** the root `Message` "union" is genuinely **not** a `oneof` (presence-based, as above), but real `oneof`s *do* exist on nested E2E types and are now readable — e.g. `ContextInfo`'s neighbours and interactive-message subtrees use `oneof response/header/media/...` (`WAWebProtobufsE2E.proto:234`,`:276`,`:412`,`:440`,`:651`,`:662`). **Honesty label:** these `.proto` texts are **not** in the native dump (SilentOrbit emits no descriptor); they are the open-impl reconstruction whatsmeow tracks against the live servers — the native client interoperates with the same wire format, so the field numbers/types/packing are shared by protocol necessity, but the exact *file* is cross-reference, not disassembled. *Residual:* none material for a port — the only thing the proto can't tell you is whether this specific Windows build silently drops an unknown field, which is a runtime behaviour, not a schema fact.

2. **[RESOLVED]** *Which copy "wins" at runtime for the dual `Message` (SilentOrbit `WhatsApp.ProtoBuf.Message` vs Google `WhatsApp.GProtoBuf.Message`).* **Confirmed dead-in-C#:** a whole-dump grep finds **no construction or parse** of either `Message` copy outside the `WhatsApp.Protobuf` assembly itself (`grep -rn "new Message(" / "GProtoBuf.Message"` over all other assemblies → zero hits). The C# shell builds only `ClientPayload`/`HandshakeMessage` (§3.7); the content `Message` tree is produced and consumed entirely in the JS bundle (which carries its own copy — the all-fields-null guard above proves JS owns the union). So neither C# copy "wins" at runtime — **both are passive marshalling structs**, retained as a code-gen artifact (§3.1). This is now stated as fact in §3.2.

3. **[RESOLVED]** *`MessageTypes` enum vs proto field numbers — find the mapping table that converts one to the other.* **There is no table.** Each content sub-class in `WhatsApp.ProtoBuf/Message.cs` **self-reports** its app-level id via a hard-coded getter — `public MessageTypes MessageType => MessageTypes.image_message;` (`Message.cs:230`), `… protocol_message;` (`Message.cs:4200`), etc. — satisfying `IProtoBufMessage.MessageType` (`IProtoBufMessage.cs:5`). The (proto field number ↔ `MessageTypes` id) correspondence is thus distributed across the per-class getters, not centralized; a grep for any `switch`/`case MessageTypes.*` converter across the entire dump returns nothing. The id consumer that keys off these values (e.g. renderer/router) lives in JS. Folded into §3.2.

4. **[PARTIAL]** *Positron provenance — the originating Windows version/format that writes Positron blobs.* **Advanced:** the consumer is a SQLite `DataContext` over `messages.db` exposing `Table<Message>/<Conversation>/<UserStatus>/<JidInfo>` (`WhatsApp.VoIP/WhatsApp.Positron.Sqlite/MessagesContext.cs:12`,`:20`-`26`); **nothing in the dump writes/serializes `PositronData`** (grep for `PositronData` outside `WhatsApp.Protobuf/WhatsApp/` → zero hits); `PositronDataSource` is a 6-way export-collection tag `{MESSAGES, CHATS, CONTACTS, GROUP_METADATA, GROUP_PARTICIPANTS, REACTIONS}` (`WhatsApp/PositronDataSource.cs:3`), not a version stamp; and `SeamlessMigrationManager` opens/deletes the same `messages.db` (`SeamlessMigrationManager.cs:272`,`:862`). So "legacy local-store import model, never on the wire" is now corroborated from code (§3.11). **Round-2 — schema + provenance category now confirmed (still no version):** whatsmeow ships the Positron schema as a dedicated **`WAWinUIApi.proto`** (package `WAWinUIApi`, `proto2` — `research/external/whatsmeow/proto/waWinUIApi/WAWinUIApi.proto:1`-`5`), naming it as part of the **WinUI (Windows-native) API surface**, with the exact field map our §3.11 read off the SilentOrbit C#: `enum PositronDataSource { MESSAGES=1 … REACTIONS=6 }` and `message PositronData { dataSource=1, messages=2, chats=3, contacts=4, groupMetadata=5, groupParticipants=6, reactions=7 }` (`WAWinUIApi.proto:5`-`77`), plus nested `PositronMessage.MsgKey`/`WID`. This (cross-reference: whatsmeow `waWinUIApi`) independently validates the field numbers **and** pins the provenance *category* — Positron is the **Windows-WinUI-client local-store/export DTO family**, absent from the WA-Web bundle and from whatsmeow/Baileys' wire path (grep for `positron` across `waweb-unmin/` and `Baileys/` → zero hits). **Final pass — LIVE on-disk negative evidence (decisive corroboration of category; literal version still open):** the live appdata dump from a *running* current build (doc 94) contains **exactly 7 native session DBs — `session.db`, `nativeSettings.db`, `abprops.db`, `contacts.db`, `contactsState.db`, `genericStorage.db`, `mediaDownloads.db`** — and **`messages.db` (the Positron store) is NOT present**, nor are the other legacy stores `axolotl.db`/`syncd.db`/`calls.db`/`settings.db`/`concur.db`/`emojidict.db` that appear *only* in the SeamlessMigration clean-slate delete list (`SeamlessMigrationManager.cs:862`) [live-appdata, doc 94 §1; verified `find …/research/appdata -iname '*.db'`]. So the current WebView2-hosted build **neither creates nor carries** a Positron `messages.db`; it persists message data in the plaintext WebView IndexedDB instead (`model-storage.message` et al., doc 95). This upgrades the provenance *category* from inferred to **live-confirmed**: Positron is a **legacy native local store that the current build only knows how to read/migrate-from and then delete** — its tables are superseded by IndexedDB. `MessagesContext` itself has **no schema-version table or migration gate** — only `DatabaseExists()`/`CreateDatabase()` (`MessagesContext.cs:31`,`:52`-`55`), and whatsmeow's `WAWinUIApi.proto` carries **no version field** either (grep `version|schema` → empty). **Still missing (why this stays PARTIAL):** the literal question — the *originating* Windows build/version number that authored the blobs — is unanswerable from any artifact in hand: no writer or version gate exists in the dump, this account's live dump has no legacy `messages.db` to read a schema row from, and neither the open `.proto` nor IndexedDB stamps a producer version. *What would resolve it:* an **older Windows client build** containing the Positron writer, or a sample legacy Positron `messages.db` whose `sqlite_master`/pragma user_version exposes the schema generation. Folded into §3.11.

5. **[RESOLVED]** *Full `DeviceCapabilities` field set (only known to be field 54 of `SyncActionValue`).* The proto is **single-field**: `ChatLockSupportLevel` at field 1 (`WhatsApp.ProtoBuf/DeviceCapabilities.cs:30`), enum `Types.ChatLockSupportLevel { NONE=0, MINIMAL=1, FULL=2 }` (`DeviceCapabilities.cs:13`-`21`), serialized as `WriteRawTag(8); WriteEnum(...)` (`:142`). Backed by `device_capabilities.proto` (`DeviceCapabilitiesReflection.cs`). Folded into §3.6.

6. **[RESOLVED]** *Reflection base64 blobs (`ServersyncReflection`, `CertReflection`) did not emit readable `.proto` filenames in a quick decode; proto names were inferred.* **Now decoded.** Base64-decoding the `FileDescriptor.FromGeneratedCode(...)` blob in `ServersyncReflection.cs:14` yields filename **`serversync.proto`** (package `WhatsApp.ProtoBuf`) with all 11 message types and field names (`SyncdVersion.version`, `SyncdIndex.blob`, `SyncdValue.blob`, `KeyId.id`, `SyncdRecord{index,value,key_id}`, `ExternalBlobReference{media_key,direct_path,handle,file_size_bytes,file_sha256,file_enc_sha256}`, `SyncdSnapshot{version,records,mac,key_id}`, `SyncdMutations.mutations`, `SyncdMutation{operation:{SET=0,REMOVE=1},record}`, `SyncdPatch{version,mutations,external_mutations,snapshot_mac,patch_mac,key_id,exit_code,device_index}`). `CertReflection.cs:14` yields **`cert.proto`** (`NoiseCertificate{details,signature, Details{serial,issuer,expires,subject,key}}`, `CertChain{leaf,intermediate, NoiseCertificate{…, Details{serial,issuer_serial,key,not_before,not_after}}}`). The earlier "no readable filename" was a quick-decode artifact, not a real gap — both fully decode. Filenames folded into the §2 reflection table.

7. **[PARTIAL]** *SyncD `SyncDMutationStatus` transition semantics (§3.6a-e) — who sets `Active` vs `Applied`, when a row is purged.* **Native C# absence re-confirmed:** `SyncDMutationStatus` appears in **only two files in the entire decompiled tree** — its own enum and the storage entity (`SyncDStoredMutation.cs:14`,`:17`,`:46`); a tree-wide grep for any `SyncDMutationStatus.{Orphaned|Applied|Invalid|UnsupportedVersion|Active}` assignment returns **zero hits** [decompiled-C#]. The native layer only *stores* the status; it never computes a transition. The open Go/TS impls don't model it either — whatsmeow and Baileys apply a `SyncdPatch`'s mutations with no `Orphaned/Applied/Active/Invalid/UnsupportedVersion` lifecycle (`grep -rniE 'orphan|unsupportedversion|mutationstatus' whatsmeow/appstate/ Baileys/src/Utils/` → empty), so the enum is **not a shared wire concept**. **UPGRADE — the transition semantics are now recovered from the WebView2-hosted web engine [bundle], correcting a prior-pass error.** The earlier read ("the web engine exports no status enum / has no per-row status column") was **wrong**: the engine *does* carry a 6-member status enum and persists it per-row. (i) **The enum:** `SyncActionState = Mirrored(["Success", "Malformed", "Orphan", "Unsupported", "Skipped", "Failed"])`, defined in the `WASyncdConst` Kotlin-MP module (`research/waweb-unmin/SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:224`; same module defines the priority collections, `SyncModelType` `:225`, the patch-apply outcome enum `Mirrored(["Success","SuccessHasMore","Conflict","ConflictHasMore","ErrorRetry","ErrorFatal","Blocked"])` `:222`, and the collection-sync state `Mirrored(["UpToDate","Dirty","FailingFiniteRetry","Fatal","Blocked"])` `:223`). (ii) **It is a persisted per-row column** on the IndexedDB `SyncActionStore`: written via `WAWebSyncdDb.updateSyncActionRows([{ index, actionState, modelType, modelId }])` (`xTiXmyjNEd_.js:21092`) and read back by state via `getSyncActionsByActionStatesInTransaction([…])` / `getByActionStates([…])` (`xTiXmyjNEd_.js:35228`,`:35255`,`:35450`,`:36939`) — i.e. exactly the discriminator the native `SyncDMutations` table flattens. (iii) **Who sets what:** `applyMutations` returns a per-mutation `{actionState}` — clean SET merge → `Success` (≙ native **`Applied`**); version-unhandled value → `Unsupported` (≙ native **`UnsupportedVersion`**); decode/index failure → `Malformed`/`Failed` (≙ native **`Invalid`**); missing target/dependency → `Orphan` (≙ native **`Orphaned`**) (`xTiXmyjNEd_.js:37766`-`37790`,`:37607`,`:21092`). The orphan rule is literal in the request-builder: `"syncd: dropping orphaned REMOVE mutation (no corresponding SET in SyncActionStore)"` → returns `false` (`WAWebSyncdRequestBuilderBuild`, `xTiXmyjNEd_.js:88802`). (iv) **When a row is purged/retried:** `applyAllOrphansAndUnsupported()` (`WAWebSyncdOrphan`, `xTiXmyjNEd_.js:36938`-`36940`,`:37006`) re-queries `{Orphan, Unsupported}` rows on app-resume and re-runs `WAWebSyncdCollectionHandler.applyIndividualMutations(...)` (`:41396`) — so orphaned/unsupported rows are **retained and retried on resume, not eagerly purged**; an orphaned outbound REMOVE is dropped at build time (above). **Why still PARTIAL (not RESOLVED):** the native enum's `Active=4` member has **no distinct web counterpart** — the web layer represents the live authoritative SET as simply present-and-`Success`, so the `Active` vs `Applied` split is a native-only persistence nuance whose assignment site is not in any readable artifact; and the native `{enum→integer}` byte values (`Orphaned=0…Active=4`) and the native handler's own assignment code remain **un-disassembled from `WhatsAppNative.dll`** (the native store is a machine-bound **custom AES+HMAC page codec — NOT stock SQLCipher**, doc 96 §3 / doc 94 — so the live native rows are not offline-readable). The web `SyncActionState` member *ordering* (`Success/Malformed/Orphan/Unsupported/Skipped/Failed`) also does not match the native integer ordering, so the precise native byte map is interop-inferred, not confirmed. *What would fully resolve it:* a **live capture of native `SyncDMutations` rows across a patch cycle** (to read the actual `Status` integers incl. `Active`), or disassembly of the native SyncD apply path. **Recovered-by-interop (web engine `SyncActionState`) — transition semantics now cited and concrete; exact native byte map + the `Active` distinction remain open.**

8. **[RESOLVED via cross-reference]** *The LTHash patch-merge / MAC-verify loop is not in the C# dump (§3.6a-f).* The **native C# absence is still true** (no C# method performs the `SyncdPatch`→`SyncDStoredMutation` merge — grep finds **no `new SyncDStoredMutation` outside its own file**, and the `SnapshotMac`/`PatchMac` symbols are only protobuf field accessors on `SyncdPatch.cs` `:102`,`:118`, never a verify call), but the **algorithm itself is now fully recovered** from the open protocol implementations and corroborated by the very JS bundle this native client hosts in WebView2. **The merge is an additive/subtractive 16-bit-pointwise homomorphic LTHash** (cross-reference: `whatsmeow/appstate/lthash/lthash.go` + `appstate/hash.go` + `appstate/decode.go`; corroborated by the **bundle's own `WACryptoLtHash` module**, `research/waweb-unmin/xTiXmyjNEd_.js:207`-`281`). Concretely:
   - **State + step:** a **128-byte** running hash (`EMPTY_LT_HASH = new ArrayBuffer(128)`, `KEY_LENGTH_BYTES u = 128`, step `s = 2` → bundle `:209`-`211`,`:280`; whatsmeow `HashState.Hash [128]byte`, `hash.go:35`), folded **pointwise as little-endian uint16** (`performPointwiseWithOverflow` sets `Uint16(..., !0)` = LE, `xTiXmyjNEd_.js:274`-`276`; whatsmeow `performPointwiseWithOverflow` `binary.LittleEndian.Uint16`, `lthash.go:46`-`57`).
   - **Per-mutation expansion:** each fold operand is the mutation's **32-byte value-MAC HKDF-SHA256-expanded to 128 bytes** with HKDF-info/salt = the literal string **`"WhatsApp Patch Integrity"`** (bundle `m = new d("WhatsApp Patch Integrity")` exported as `LT_HASH_ANTI_TAMPERING`, `xTiXmyjNEd_.js:279`-`280`, expansion via `WACryptoHkdf.extractAndExpand(mac, salt, 128)` `:252`,`:264`; whatsmeow `WAPatchIntegrity = {"WhatsApp Patch Integrity", 128}`, `lthash.go:25`, `hkdfutil.SHA256(item, nil, info, 128)` `:42`).
   - **Set vs Remove:** `subtractThenAdd(base, add[], subtract[])` — **add** value-MACs for `SET`, **subtract** the previous value-MAC for `REMOVE`/overwrite (bundle `subtractThenAdd`/`$1`(+)/`$2`(−) `:237`-`273`; whatsmeow `SubtractThenAddInPlace` + `updateHash` add/removed accumulation `hash.go:38`-`66`).
   - **MAC verification chain (cross-reference whatsmeow `hash.go:84`-`106`, mirrored in bundle SyncD crypto `:9296`-`9316`):** value-MAC = `HMAC-SHA512(valueMacKey, [op+1]‖keyId‖content‖len(keyId)+1)[:32]`; index-MAC = `HMAC-SHA256(indexKey, syncAction.Index)`; **snapshot-MAC** = `HMAC-SHA256(snapshotMacKey, LTHash‖u64BE(version)‖name)`; **patch-MAC** = `HMAC-SHA256(patchMacKey, snapshotMac‖{valueMACs…}‖u64BE(version)‖name)`. The five keys (`indexKey, valueEncryptionKey, valueMacKey, snapshotMacKey, patchMacKey`) are HKDF-expanded from the app-state-sync key and **sliced in this exact order** in the bundle (`WAWebSyncdCryptoHelper` `xTiXmyjNEd_.js:9537`-`9548`) — matching whatsmeow's `ExpandedAppStateKeys` and the native `PatchDebugData` field names. The native `PatchDebugData` diagnostics proto (11 fields incl. `CurrentLthash`, `NewLthash`, `NewLthashSubtract`, `NumberAdd`/`NumberRemove`/`NumberOverride`, `FirstFourBytesFromAHashOfSnapshotMacKey`; descriptor `SyncActionReflection.cs:109`-`114`) and WAM telemetry (`lthash_inconsistency_on_snapshot_mac_mismatch` `Wam.cs:14574`; `MacFatalCurrentLthashMismatch`/`MacFatalNewLthashMismatch` `:57725`,`:57735`; `IsWebLthashConsistent` `:57721`) name exactly these inputs, independently anchoring the algorithm to this native build. **Honesty label:** the merge *loop body* is **not disassembled from `WhatsAppNative.dll`** — it runs in the WebView2-hosted JS (`WACryptoLtHash`/`wa-kmp-syncd-engine-*`); RESOLVED here is via open-impl + bundle-string corroboration, not native-binary read. Folded into §3.6a-(f).
