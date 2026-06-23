# 32. Local Storage: SQLite & Key Store

> Target: Meta native WhatsApp for Windows (`WhatsApp.Root.exe`, WinUI 3 / Windows App SDK 1.6, v2.2607.106.0).
> All paths in §2/§3 are relative to `decompiled_source/`. Line citations (`file.cs:NN`) were read directly from the decompiled C#.
> READ-ONLY analysis of `decompiled_source/**`. Confirmed-from-code vs inference is called out explicitly.

## 1. Purpose & Scope

This document covers **how the native Windows shell persists data on disk**: the SQLite engine, the encryption of every database, the JS↔native SQL execution bridge, the account key store (ClientKey / ServerEncKeySalt), the per-session settings stores, the typed object-relational stores, and on-disk layout / multi-account isolation.

Two distinct SQLite surfaces exist, and they must not be conflated:

1. **`genericStorage.db`** — the large WhatsApp-Web data model (chats, messages, contacts as the JS sees them). The **WebView2 JS bundle drives all schema and queries**; native C# is a *dumb SQL executor* reached over the `SQLiteBridge` host object (`decompiled/WhatsApp.Root/WhatsApp.Bridge/SqliteBridge.cs`).
2. **Native-owned typed stores** — `session.db`, `nativeSettings.db`, `contacts.db`, `contactsState.db`, `abprops.db`, `mediaDownloads.db`. These have **native-defined schemas** managed by C# (`SqliteData` / `SqliteDataContext` ORM in `WhatsApp.VoIP`).

Both surfaces run on the **same native SQLite engine** (`WhatsAppNative.dll`, projected as `WhatsAppNative.Sqlite`), an encrypted build keyed with a per-DB `byte[] secret`. The at-rest cipher is a **custom AES+HMAC page codec compiled into the SQLite build — NOT stock SQLCipher** (no `cipher_version`/`kdf_iter`/`PRAGMA key` markers anywhere; doc 96 §3): 4096-byte pages + a 16-byte per-DB salt prefix + the raw 32-byte key used directly, with `Sqlite::Open` (`0x1807326d9`) delegating to internal codec callees (doc 94 §2 / doc 96 §3).

The **key store** is the account master key (`ClientKey`) plus `ServerEncKeySalt`, persisted in the encrypted `session.db`. The ClientKey both names the on-disk session folder (`sessions/{SHA1(ClientKey)}/`) and derives the `nativeSettings.db` secret.

Out of scope: Signal/Noise key material (doc 30/31), media files content (doc on media), the JS-side IndexedDB/data model.

## 2. Where It Lives

### JS↔native SQL bridge (`genericStorage.db`)
- `decompiled/WhatsApp.Root/WhatsApp.Bridge/SqliteBridge.cs` — host-object entry point (`ISQLiteBridgeToNative`).
- `decompiled/WhatsApp.VoIP/WhatsApp.Sqlite2/SqliteDb.cs` — opens/re-keys `genericStorage.db`, executes batches.
- `decompiled/WhatsApp.VoIP/WhatsApp.Sqlite2/SqliteResult.cs` — JSON DTO returned to JS.
- `decompiled/WhatsApp.VoIP/WhatsApp.Sqlite2/SqliteQueryUtil.cs` — leading-keyword classifier.
- `decompiled/WhatsApp.VoIP/WhatsApp.Sqlite2/DbConfig.cs` — `{FilePath, Secret, Flags}` open config.
- Host-object registration: `decompiled/WhatsApp.Root/WhatsApp/AppModel.cs:144`–`227`.

### SQLite engine (managed wrappers over native)
- `decompiled/WhatsApp.VoIP/WhatsApp/Sqlite.cs` — the rich managed `Sqlite` facade (PRAGMAs, transactions, checkpoint, integrity-check, error codes, auto-recovery). **This is the class every store actually uses.**
- `decompiled/WhatsAppNativeProjection/WhatsAppNative/Sqlite.cs` — CsWinRT RCW over native `WhatsAppNative.Sqlite` (activated via `ActivationFactory.Get("WhatsAppNative.Sqlite")`).
- `decompiled/WhatsAppNativeProjection/WhatsAppNative/SqlitePreparedStatement.cs` — native prepared-statement RCW.
- `decompiled/WhatsAppNativeProjection/WhatsAppNative/SqliteOpenFlags.cs`, `SqliteCheckpointType.cs` — enums.
- Registered native class: `x64/AppxManifest.xml` (`WhatsAppNative.Sqlite` in-process server — see §4).

### Native-defined ORM / typed stores
- `decompiled/WhatsApp.VoIP/WhatsApp/SqliteData.cs` — abstract base: lazy open, `metadata(version)` schema versioning, create/migrate/delete hooks.
- `decompiled/WhatsApp.VoIP/WhatsApp/SqliteDataContext.cs` — full reflection-based `[Table]`/`[Column]` ORM (change tracking, insert/update/delete, object cache).
- `decompiled/WhatsApp.VoIP/WhatsApp/SqliteMediaFilesStorage.cs` — `mediaDownloads.db` (schema v2).
- `decompiled/WhatsApp.VoIP/WhatsApp/SqliteAbProps.cs` — `abprops.db` (schema v1).
- `decompiled/WhatsApp.VoIP/WhatsApp/SqliteContactsContext.cs` — `contacts.db` (schema v23).
- `decompiled/WhatsApp.VoIP/WhatsApp.Data/ContactsContext.cs` — the `contacts.db` singleton + its concurrency/access model (`Access`/`ReadOnlyAccess`/`AccessToken` inner classes) and `ContactsContext.Events` Rx subjects. See §3.9.
- `decompiled/WhatsApp.VoIP/WhatsApp/SqliteContactsStateDatabase.cs` — `contactsState.db` (schema v1; `Settings`+`Invalidated`). See §3.10.3.
- `decompiled/WhatsApp.DataModels/WhatsApp/TableAttribute.cs` — `[Table]` attribute (POCO entities live in `WhatsApp.DataModels/WhatsApp.Data/*`).

### Native contacts store & address-book sync (§3.10)
- `decompiled/WhatsApp.Root/WhatsApp/ContactsManager.cs` — `IContactsBridgeToNative` impl: `Contact` DTO, `ContactState` map, `Start` poll loop, `IsInitiallySynced`, `StoreContacts`→`contacts.db`.
- `decompiled/WhatsApp.Root/WinRTAdapter/IContactsBridgeToNative.cs`, `IContactsBridgeToWeb.cs`, `ContactsBridge.cs` — the bidirectional bridge interfaces + RCW (host-object names `ContactsBridge`/`PopulatedContactsBridge`).
- `decompiled/WhatsApp.VoIP/WhatsApp/ContactsManagerStateSetting.cs` — `InitialState=1` enum; `IGenericSettingsDatabase.cs` — KV indexer contract.
- `decompiled/WhatsApp.Root/ContactSyncService.cs` — periodic *outbound* OS sync timer (10 min due / 1 h period).
- `decompiled/WhatsApp.Root/WhatsApp.SystemIntegrations/ShareContactManager.cs`, `WhatsApp.Root/WhatsApp/JumpListContactManager.cs` — push WhatsApp contacts to the Windows People app + taskbar jump list.
- `decompiled/WhatsApp.VoIP/WhatsApp/ContactNotificationHashProcessor.cs` — `GetNotificationHash` (stub in this build).
- `decompiled/WhatsApp.DataModels/WhatsApp.Data/UserStatus.cs` — the `UserStatuses` POCO (`[Column]`/`[Index]` schema; full column map in §3.10.6).

### Key store (ClientKey / ServerEncKeySalt) + settings
- `decompiled/WhatsApp.VoIP/WhatsApp.LoginSession/LoginSessionManager.cs` — owns `session.db` + `nativeSettings.db`, login/logout, secret derivation.
- `decompiled/WhatsApp.VoIP/WhatsApp.LoginSession/SessionData.cs` — `{ClientKey, ServerEncKeySalt}` struct.
- `decompiled/WhatsApp.VoIP/WhatsApp.LoginSession/SessionDataPathUtils.cs` — `sessions/{SHA1(ClientKey)}/` path logic.
- `decompiled/WhatsApp.Root/WhatsApp.Bridge/ClientKeyController.cs` — `ClientKeyBridge` host object.
- `decompiled/WhatsApp.Root/WhatsApp.Bridge/ServerEncKeySaltController.cs` — `ServerEncKeySaltBridge` host object.
- `decompiled/WhatsApp.VoIP/WhatsApp.NativeSettings/SqliteSettingsStorage.cs` — `settings(key,value)` KV store impl.
- `decompiled/WhatsApp.VoIP/WhatsApp.NativeSettings/Settings.cs`, `SettingsKey.cs`, `ISettingsStorage.cs` — settings facade + key enum.

### At-rest crypto primitives
- `decompiled/WhatsApp.VoIP/WhatsApp.Encryption/EncryptionUtils.cs` — PBKDF2-SHA256 + AES-CBC-PKCS7 wrap (`EncryptBytes`/`DecryptBytes`), CSPRNG.
- `decompiled/WhatsApp.VoIP/WhatsApp.Encryption/ProtectionUtils.cs` — DPAPI (`DataProtectionProvider("LOCAL=user")`).
- `decompiled/WhatsApp.Root/WhatsApp.SeamlessMigration/WhatsAppCryptoHelper.cs` — migration at-rest crypto (separate static key + AES-CBC variants).
- `decompiled/WhatsApp.VoIP/WhatsApp/SqliteSecretManager.cs` — encryption-toggle stub (disabled in non-ALPHA).
- `decompiled/WhatsApp.VoIP/WhatsApp/Constants.cs` — `IsoStorePath` root + misc constants.

## 3. How It Works

### 3.1 The native SQLite engine projection

The actual SQLite implementation is native (C++/Rust in `WhatsAppNative.dll`). The C# RCW exposes it (`WhatsAppNativeProjection/WhatsAppNative/Sqlite.cs`). The activatable class is fetched once and cached:

```csharp
return ___objRef_global__WhatsAppNative_Sqlite = ActivationFactory.Get("WhatsAppNative.Sqlite");
```
— `WhatsAppNativeProjection/WhatsAppNative/Sqlite.cs:55`

The projected surface (`Sqlite.cs:134`–`207`): `Open(filename, flags, vfs, byte[] secret)`, `SetBusyTimeout(ms)`, `PrepareStatement`, `GetError`, `Interrupt`, `RegisterTokenizer`/`IsTokenizerRegistered` (FTS), `GetChangeCount`/`GetTotalChangeCount`, `GetLastRowId`, `Checkpoint(SqliteCheckpointType)`, `IsInTransaction`, **`ChangeDbSecret(byte[] newDbSecret)`** (re-key), `GetMemoryDetails`, `GetLastUpdateTimeUnixMs`.

The presence of a `byte[] secret` on `Open` and a `ChangeDbSecret` re-key method confirms an **encrypted SQLite build with a custom AES+HMAC page codec (NOT stock SQLCipher)**. The codec is byte-evidenced via radare2: `Sqlite::Open` is located in `WhatsAppNative.dll` at `0x1807326d9` and delegates key/codec setup to internal callees (`0x1808c29e0` et al.), with AES + HMAC (SHA-1/256/512) statically present and **no** stock-SQLCipher markers (doc 96 §3). The structure (4096-byte pages + 16-byte per-DB salt + raw 32-byte key, no passphrase PBKDF2) is confirmed on disk (doc 94 §2). Only the codec's *exact* internal AES mode (CTR vs CBC) and HMAC variant are still undetermined — and are **moot for a renderer-hosted port** (see §4/§6).

`SqliteOpenFlags` (`WhatsAppNative/SqliteOpenFlags.cs`) maps to standard SQLite open-flag bits; `Defaults = 6` = `READWRITE | CREATE` (`SqliteOpenFlags.cs:9`–`12`), and `WAL = 524288` (`:29`). `SqliteCheckpointType` = `{Passive, Full, Restart, Truncate}` (`SqliteCheckpointType.cs:9`–`12`).

### 3.2 The managed `Sqlite` facade (the real workhorse)

`WhatsApp.VoIP/WhatsApp/Sqlite.cs` wraps the projection and is what every store opens. Key behaviors:

**Open + PRAGMAs** (`Sqlite.cs:1237`–`1291`, `Init`):
```csharp
_native = NativeInterfaces.CreateInstance<WhatsAppNative.Sqlite>();
_native.Open(GetFilePath(filename), flags, vfs ?? string.Empty, secret);
_native.SetBusyTimeout(busyTimeout ?? 3000);                 // default 3s busy timeout
if (READWRITE) {
    if (wal) list.Add("PRAGMA journal_mode=WAL");
    // syncMode default = Full (ShouldRelaxWrites is hardcoded false, :774)
    list.Add("PRAGMA synchronous=" + syncMode.ToUpperInvariant());
    list.Add("PRAGMA secure_delete=ON");                     // :1262 — overwrite deleted content
}
```
So every writable DB is opened **WAL + synchronous=FULL + secure_delete=ON** by default. `GetFilePath` = `Path.Combine(Constants.IsoStorePath, filename)` (`:1314`), and `Constants.IsoStorePath = ApplicationData.Current.LocalFolder.Path` (`Constants.cs:202`).

**Auto-recovery on corrupt DB** (`Sqlite.cs:776`–`819`, ctor). On first-open failure (`autoRecoverOnInitFailure` defaults true), the HRESULT is triaged at `:789`–`801`:
- **non-`SQLITE_NOTADB` (`hResult != HRForError(26)`)** → if `GetSqliteErrorName(hResult) == null` (an *unrecognized* error code) it reports the failure via `FailuresService.Investigate("...error code {hr} on first attempt"...)` (`:792`–`794`); either way it **returns without deleting/retrying** (`:796`). So an unknown-code first-attempt failure is logged but the DB file is left intact.
- **`SQLITE_NOTADB` (error 26)** → if `!SqliteSecretManager.IsSecretGeneratedDuringCurrentAppSession` it reports `"...SQLITE_NOTADB code on first attempt"` (`:798`–`801`), then falls through to **delete the database file and retry open once** (`:803`–`811`: `Dispose()`, `DeleteDatabaseFile(isClosed:true, filename)`, then `Init(...)`).

A second-attempt failure is escalated to `FailuresService.Investigate` (message distinguishes NOTADB vs other code) and rethrown (`:813`–`818`). `HRForError(error) = 0xA0010000 | error` (`:821`–`824`).

**Full SQLite error-code table** is embedded as constants `SQLITE_OK=0` … `SQLITE_NOTADB=26` … `SQLITE_ROW=100`/`SQLITE_DONE=101` plus extended codes (`Sqlite.cs:560`–`768`). `SQLITE_CORRUPT=11` (`:582`); a step returning corrupt sets `Settings.Instance.CorruptDb = true` (`:350`–`352`).

**Transactions** are literal SQL: `BeginTransaction`→`"BEGIN TRANSACTION"`, `CommitTransaction`→`"COMMIT TRANSACTION"`, `RollbackTransaction`→`"ROLLBACK TRANSACTION"` (`:1079`–`1151`). Commit failure with `SQLITE_ERROR` triggers a `PRAGMA integrity_check` diagnostic (`:1097`–`1110`).

**Background DB-admin** with throttling intervals (`Sqlite.cs:528`–`536`):
- Checkpoint: passive every ≥2h, escalates to `Truncate` every ≥12h, only if DB idle ≥2min (`CheckpointDbModifyIdleTimeRequirement`); logs WAL size before/after (`:860`–`888`).
- `PerformIntegrityCheck`: `PRAGMA integrity_check`, min interval 168h (7 days); parses `index <name>` failures for repair vs non-index errors (`:890`–`941`).
- `PerformOptimize`: `PRAGMA analysis_limit=400; ANALYZE;`, min interval 24h (`:943`–`968`).
- `Vacuum()` → `"VACUUM"` (`:1160`); `GetSize()` via `pragma_page_count()/pragma_page_size()` (`:1153`).

**`PreparedStatement`** (`Sqlite.cs:174`–`522`) wraps the native statement: `BindType` enum `{Null,Int,Long,Double,String,ByteArray}` (`:15`–`23`), positional `Bind(idx, BindValue)` dispatching by runtime type (`:358`–`379`), lazy column materialization with optional type hints (`Int64`/`Double`/`Object`), and batch column fill (`FillColumns`). `Step()` maps native exceptions to `SqliteException` and, on `SQLITE_CORRUPT`, flips `Settings.Instance.CorruptDb` (`:326`–`356`).

**`DeleteDatabaseFile`** also removes the `-wal` and `-shm` sidecars (`:1205`–`1206`).

### 3.3 `genericStorage.db` — the JS-driven generic store

This is the only DB whose **schema and queries are owned entirely by the WebView2 JS bundle**. The JS calls the `SQLiteBridge` host object.

**Bridge entry** (`WhatsApp.Root/WhatsApp.Bridge/SqliteBridge.cs`):
```csharp
public async Task<string> ExecuteSqlite(string queries) {
    await dispatcher.ContinueIn(...);                       // hop to worker thread
    string[][] array = JsonSerializer.Deserialize<string[][]>(queries);
    if (array == null) return "";
    return JsonSerializer.Serialize(sqliteDb.Execute(array));
}
```
— `SqliteBridge.cs:23`–`32`. The wire format is a **JSON `string[][]`**: each inner array = `[sqlText, param1, param2, ...]` (all params are strings). The result is a JSON-serialized `SqliteResult[]`.

**Host-object name**: registered as `"SQLiteBridge"` (`AppModel.cs:227`: `webView.AddWinRTBridge("SQLiteBridge", new SQLiteBridge(_sqliteBridge), dispatchAdapter)`), so JS reaches it as `window.chrome.webview.hostObjects.SQLiteBridge`. A legacy comma-delimited string-IPC path also exists (`AppModel.cs:277` reflects method names onto `SqliteBridge`).

**Execution** (`SqliteDb.Execute`, `WhatsApp.Sqlite2/SqliteDb.cs:69`–`189`): per inner array, the leading SQL keyword is classified by `SqliteQueryUtil` (`IsSelect/IsInsert/IsBegin/IsEnd/IsCommit/IsRollback/IsDelete/IsUpdate`, trimmed + case-insensitive — `SqliteQueryUtil.cs:7`–`50`):
- `SELECT` → prepare, bind params positionally (`AddQueryParams` binds each as a string, `:191`–`197`), step, collect `Rows` (`object[][]`) + `ColumnNames` (`:115`–`131`).
- `BEGIN`/`END`/`COMMIT`/`ROLLBACK` → call the corresponding `db.*Transaction()` (`:133`–`150`).
- `INSERT` → step, then `RowsAffected = GetChangeCount()`, and if >0, `LastInsertedRowId = GetLastRowId()` (`:153`–`165`).
- `DELETE`/`UPDATE` → step, `RowsAffected = GetChangeCount()` (`:166`–`173`).
- anything else → step, `SqliteResult.Empty` (`:174`–`178`).
Any exception is captured into `SqliteResult.Error = ex.Message` (`:180`–`186`) so the batch never throws across the bridge.

**`SqliteResult`** (`SqliteResult.cs`) is a struct with nullable, null-omitted JSON props: `Error`, `Rows` (`object[][]`), `ColumnNames` (`string[]`), `RowsAffected` (`int?`), `LastInsertedRowId` (`long?`).

**Open + per-login re-key** (`SqliteDb.cs:34`–`67`):
```csharp
private void SetUpStorage() {                               // on every OnLogin
    byte[] bytes = EncryptionUtils.SecureRandomBytes(32);   // fresh 32-byte DB key
    _settings.Write(SettingsKey.GenericStorageDbPassword, bytes);  // persisted in nativeSettings.db
    _db = null;                                             // force reopen
}
// lazy open:
byte[] array = _settings.Read(SettingsKey.GenericStorageDbPassword);
return new Sqlite(sessionLocalPath, SqliteOpenFlags.Defaults, null, null, wal:true, null, secret:array);
```
The `genericStorage.db` secret is a **random 32-byte key generated on each login** and stored in `nativeSettings.db` under `SettingsKey.GenericStorageDbPassword` (value `1`). The DB path is `loginSession.GetSessionLocalPath("genericStorage.db")` (`:62`) i.e. `sessions/{SHA1(ClientKey)}/genericStorage.db`. If `ClientKey == null` (logged out), `GetDb()` returns null and `Execute` throws `InvalidOperationException("db not initialized")` (`:72`–`74`). Wired at `AppModel.cs:144`: `new SqliteDb(_loginSessionManager, "genericStorage.db")`.

**The JS-owned schema is confirmed present in the waweb bundle** (it is *not* native). The bundle drives the bridge exactly as documented above — a `string[][]` DDL batch through the `SQLiteBridge` host object. The **full beautified bundle now resolves the complete schema** (cross-reference: beautified WA-Web bundle `research/waweb-unmin/TSxMup…js:204130`–`204136`, the `initExternalStorage` method). It is **only** the message full-text-search store — one base table, two indexes, one FTS5 virtual table, and three sync triggers:

```sql
CREATE TABLE IF NOT EXISTS message (rowid INTEGER PRIMARY KEY, id TEXT, chatId TEXT, timestamp TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS idx_message_id ON message(id);
CREATE INDEX IF NOT EXISTS idx_message_chatId_id ON message(chatId, id);
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(text, content='', prefix=2, tokenize='unicode61');
CREATE TRIGGER t1_message      AFTER INSERT ON message BEGIN INSERT INTO message_fts(rowid,text) VALUES (new.rowid,new.text); END;
CREATE TRIGGER t1_message_del  AFTER DELETE ON message BEGIN INSERT INTO message_fts(message_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
CREATE TRIGGER t1_message_up   AFTER UPDATE ON message BEGIN INSERT INTO message_fts(message_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO message_fts(rowid,text) VALUES (new.rowid,new.text); END;
```

The owning JS module is the message-search external store: `initExternalStorage` creates the above; `destroyExternalStorage`/`reInit` wipe it (`DELETE FROM message; INSERT INTO message_fts(message_fts) VALUES('delete-all')`); `search(query)` runs `SELECT t.rowid,t.id,t.chatId,t.timestamp,t.text,rank FROM message t JOIN message_fts f ON t.rowid=f.rowid WHERE message_fts MATCH ? [AND chatId = ?] ORDER BY rank` (`TSxMup…js:204109`–`204161`). **A grep of the entire ~1.1M-line beautified bundle for `CREATE TABLE`/`CREATE VIRTUAL TABLE` returns *only* `message` and `message_fts`** (cross-reference: `research/waweb-unmin/*.js`), so this is the *complete* `genericStorage.db` schema, not a snapshot of a larger model: the full chat/contact/message data model lives in the JS-side **IndexedDB**, and `genericStorage.db` is purely the denormalized SQLite FTS sidecar that backs message search (which must be SQLite because IndexedDB has no full-text index — hence the native `fts5`/`RegisterTokenizer` plumbing, §3.1/§4). The host-object name and method shape are also confirmed in the bundle: `e.hostObjects.SQLiteBridge` (32 binding sites across 2 webpack-duplicated modules, `research/waweb-unmin/U2j2EhR17gV.js:1548` et al.) and the IPC descriptor `ExecuteSqlite:["queries"]` / legacy `RequestExecuteSqlite`. The `fts5(... tokenize='unicode61')` is why the native engine exposes `RegisterTokenizer`/`IsTokenizerRegistered` (§3.1/§4).

### 3.4 The native ORM (`SqliteData` + `SqliteDataContext`)

Two base classes back native typed stores.

**`SqliteData`** (`SqliteData.cs`) — simple keyed store. Lazy open (`OpenDatabase`, `:84`), and a **schema-versioning protocol** keyed on a `metadata(version)` table (`:220`–`234`):
```csharp
int num = GetSchemaVersion();                  // -1 if no metadata table
if (num == LatestSchemaVersion) return;
if (num == -1 || num > LatestSchemaVersion) {  // missing OR newer-than-code → wipe+recreate
    if (num != -1) DeleteTables(num);
    num = CreateTables();
}
if (num < LatestSchemaVersion) SchemaUpdate(num);   // forward migration
```
— `SqliteData.cs:98`–`116`. `IsDatabaseInitialised` probes `sqlite_master` for the `metadata` table (`:259`–`269`). Subclasses implement `CreateTables`/`SchemaUpdate`/`DeleteTables`. `ChangeDbSecret`, `Checkpoint`, `PerformIntegrityCheck` are exposed under the DB lock (`:151`–`173`).

> **Note on the versioning protocol's scope.** The `metadata(version)` wipe/migrate protocol above lives in `SqliteData.OpenDatabase` (`SqliteData.cs:84`, version logic `:98`–`116`) and only governs the `SqliteData` subclasses (`contactsState.db`, `abprops.db`, `mediaDownloads.db`). The `SqliteDataContext` ORM (below) does **not** derive from `SqliteData` and does **not** route through `OpenDatabase`; `contacts.db` runs a **separate, in-constructor migration** (see §3.5).

**`SqliteDataContext`** (`SqliteDataContext.cs`) — a full reflection-based ORM driving `contacts.db`. It discovers `Table<T>` properties on the subclass (`:449`–`468`), and for each entity reads `[Column]`/`[Table]`/`[Index]`/`[Sensitive]` attributes via `ParseColumnState` (`:210`–`246`). It supports:
- `CreateDatabase()` emitting `CREATE TABLE`/`CREATE INDEX` from attributes (`:587`–`658`); type mapping `int/long/bool/enum/DateTime→INTEGER`, `byte[]→BLOB`, `string/DeviceJid→TEXT`, `double→REAL` (`GetDbType`, `:1814`–`1835`).
- Change tracking via `INotifyPropertyChanging`: dirty columns recorded on property change (`OnPropertyChanging`, `:78`–`91`), batched into INSERT/UPDATE/DELETE in `SubmitChanges` (`:948`–`1178`), with cached prepared statements per table (`InsertOnlyStmt`/`InsertOrReplaceStmt`/`DeleteStmt`, etc.). Rollback compensation actions are accumulated and reversed on failure (`:1145`–`1163`).
- An object identity cache (`_objects` keyed on primary key, weak+strong refs) so the same PK returns the same in-memory object (`AttachObject`/`AttachOrGetObject`, `:258`–`282`; `ParseTableImpl`, `:1483`).
- `DateTime` columns stored as `FileTimeUtc` int64 (`GetValue`→`ToFileTimeUtcSafe` `:1782`, `SetValue`→`DateTime.FromFileTimeUtc` `:1752`).

`[Table]` attribute (`WhatsApp.DataModels/WhatsApp/TableAttribute.cs`): `{Name, PrependAllowed, PurgeCache}`. POCO entities live in `WhatsApp.DataModels/WhatsApp.Data/*` (e.g. `UserStatus`, `ChatPicture`, `WaScheduledTask`).

### 3.5 The native typed stores (schemas)

All native stores take their encryption key from `SettingsKey.LegacyDbSecret` (the per-session 32-byte key — §3.7) via a `Func<byte[]>` secret provider.

**Re-key model (confirmed for all three `SqliteData` stores + `contacts.db`): reopen, not in-place `ChangeDbSecret`.** Each store subscribes to the login observable and, on every `OnLogin`, *constructs a brand-new store object* whose secret closure reads the *current* `SettingsKey.LegacyDbSecret`. So when `Login` regenerates `LegacyDbSecret` (§3.6), the next access opens the DB fresh under the new secret rather than re-keying an open handle. Confirmed call sites: `abprops.db` — `AbPropsRoot` ctor `loginSessionDataProvider.OnLogin…Subscribe(Initialize)` then `Initialize` does `_database = new SqliteAbProps(sessionLocalPath, () => _settings.Read(SettingsKey.LegacyDbSecret))` (`WhatsApp.Root/WhatsApp.Bridge/AbPropsRoot.cs:44`, `:60`–`61`); `mediaDownloads.db` — `MediaFilesService` ctor `loginSession.OnLogin…Subscribe(Initialize)` then `Initialize` does `_downloadsDb = new SqliteMediaFilesStorage(sessionLocalPath, () => _settings.Read(SettingsKey.LegacyDbSecret))` (`WhatsApp.Root/WhatsApp.SystemIntegrations/MediaFilesService.cs:69`, `:86`–`87`); `contacts.db` — `ContactsContext` reopen via `Reset(force:true)` (§3.9.4). In all three, `ClientKey == null` on logout short-circuits `Initialize` so the store is left closed.

**`contacts.db`** — `SqliteContactsContext : SqliteDataContext` (`SqliteContactsContext.cs:19`), `LatestSchemaVersion = 23` (set in the ctor at `SqliteContactsContext.cs:117` — it is assigned to the settable base property, not an expression-bodied override), `DbName = "contacts.db"` (`:76`; ctor passes `Path.Combine(dbFolder, "contacts.db")` to base at `:115`). Tables exposed as `Table<UserStatus> UserStatuses`, `Table<ChatPicture> ChatPictures`, `Table<WaScheduledTask> WaScheduledTasks` (`:96`–`100`). Schema columns are **`[Column]`-attribute-defined on the POCO entities** in `WhatsApp.DataModels/WhatsApp.Data/*` (e.g. `UserStatus`); the `CachedStatement` queries at `:84`–`92` are all `SELECT *` and do **not** enumerate column names. The only column names directly visible in SQL are `DbLid`/`Jid`, in the v23 LID migration at `:515`: `"UPDATE UserStatuses SET DbLid = Jid, Jid = null WHERE Jid LIKE '%@lid'"` (a `PhoneNumbers` table with a `RawPhoneNumber` column is likewise implied by the `SELECT * FROM PhoneNumbers WHERE RawPhoneNumber = ?` statement at `:92`).

  **Two migration entry points** (this store does *not* use the `SqliteData.OpenDatabase` protocol of §3.4): (a) the constructor runs an in-ctor migration — `if (DatabaseExists()) { num = GetSchemaVersion(); if (num >= LatestSchemaVersion) return; BeginTransaction(); UpdateSchema(num, ref shouldSubmit); SetSchemaVersion(LatestSchemaVersion); SubmitChanges(); CommitTransaction(); }` (`:114`–`154`); (b) on a fresh DB, `ContactsContext.GetInstance` calls `CreateDatabase()` (the `SqliteDataContext` attribute-driven `CREATE TABLE`/`CREATE INDEX`, §3.4) when `!DatabaseExists()` (`WhatsApp.Data/ContactsContext.cs:239`–`242`).

  **Construction & secret.** `contacts.db` is the singleton `ContactsContext : SqliteContactsContext` (`WhatsApp.Data/ContactsContext.cs:18`), built lazily in `ContactsContext.GetInstance` (`:236`–`244`): `new ContactsContext(loginSession.GetSessionLocalPath(), () => LoginSessionDataProvider?.SessionLocalSettings.Read(SettingsKey.LegacyDbSecret))` (`:238`) — i.e. the secret provider reads `SettingsKey.LegacyDbSecret`, the same provider pattern as the other typed stores. (Note: the `secretProvider = () => _settings.Read(SettingsKey.LegacyDbSecret)` at `WhatsApp.Root/WhatsApp/ContactsManager.cs:104` belongs to **`contactsState.db`** — `new SqliteContactsStateDatabase(...)` at `:105` — not `contacts.db`.)

**`contactsState.db`** — `SqliteContactsStateDatabase : SqliteData`, `LatestSchemaVersion = 1` (`SqliteContactsStateDatabase.cs:32`). Tables: `Settings(Key INT PRIMARY KEY, Value TEXT)` and `Invalidated(ContactId TEXT UNIQUE PRIMARY KEY)` (`:118`–`139`). Stores contact-sync invalidation set + KV settings.

**`abprops.db`** — `SqliteAbProps : SqliteData`, `LatestSchemaVersion = 1` (`SqliteAbProps.cs:17`). Tables (`:33`–`56`):
```sql
metadata (version INTEGER)
ConfigCodes (Code INT PRIMARY KEY, Value TEXT, ExpoKey TEXT)
ConfigSettings (currentSetHash TEXT)
ExposureKeys (RowId INTEGER PRIMARY KEY AUTOINCREMENT, ExpoKey TEXT, Acked INTEGER)
UNIQUE INDEX ExposureKeys_ExpoKey ON ExposureKeys (ExpoKey)
```
Holds server A/B config codes + exposure-logging keys. `Save` batches `INSERT OR REPLACE INTO ConfigCodes` in groups of 266 (`:101`–`116`). Constructed in `AbPropsRoot.Initialize` for `sessions/{...}/abprops.db` (`WhatsApp.Bridge/AbPropsRoot.cs:60`–`61`).

**`mediaDownloads.db`** — `SqliteMediaFilesStorage : SqliteData`, `LatestSchemaVersion = 2` (`SqliteMediaFilesStorage.cs:13`). Table (`:29`–`30`):
```sql
CompletedDownloads2 (FileHash TEXT NOT NULL, FilePath TEXT NOT NULL, Extension TEXT NOT NULL,
                     PRIMARY KEY (FileHash, Extension))
INDEX idx_CompletedDownloads2_FileHash ON CompletedDownloads2 (FileHash)
```
v1→v2 migration copies the old `CompletedDownloads` rows, deriving `Extension` from the file path, then drops the old table (`:45`–`84`). Opened with `SqliteSynchronizeOptions.Normal` (`:16`). Constructed in `MediaFilesService.Initialize` for `sessions/{...}/mediaDownloads.db` with `secretProvider = () => _settings.Read(SettingsKey.LegacyDbSecret)` (`WhatsApp.SystemIntegrations/MediaFilesService.cs:85`–`87`).

### 3.6 The key store: ClientKey & ServerEncKeySalt (`session.db`)

`LoginSessionManager` (`WhatsApp.LoginSession/LoginSessionManager.cs`) owns the account key store. It uses an inner KV SQLite DB via `SqliteSettingsStorage`.

**`session.db` schema** (`SqliteSettingsStorage.Initialize`, `SqliteSettingsStorage.cs:21`):
```sql
CREATE TABLE IF NOT EXISTS settings ( key int UNIQUE, value TINYBLOB );
```
Writes are `INSERT ... ON CONFLICT(key) DO UPDATE SET value = ?` (`:32`); reads `SELECT key,value WHERE key=?` returning the `byte[]` (`:39`–`52`).

**Key slots** — `LoginSessionManager.SessionDataKey` enum: `ClientKey = 2`, `ServerEncKeySalt = 3` (`LoginSessionManager.cs:16`–`20`). (Note the integer keys 2 and 3 are used directly in `SetSessionData(2,...)`/`SetSessionData(3,...)`, `:184`–`204`.)

**`session.db` encryption secret** (`Initialize`, `:63`–`83`):
```csharp
byte[] secret = EnsureFixedSecretSize(await ProtectionUtils.ProtectBytes(StaticKeyBytes));
_sessionDataStorage.Initialize(new DbConfig { FilePath = "session.db", Secret = secret });
```
i.e. the `session.db` secret = **DPAPI-wrapped (`ProtectBytes`, `LOCAL=user`) of a hardcoded 16-byte `StaticKeyBytes`**, padded/truncated to 32 bytes (`StaticKeyBytes` literal at `:28`–`32`: `{35,167,241,156,17,229,189,120,66,53,201,111,133,210,73,19}`). `session.db` lives directly in `LocalFolder` (it is *not* under `sessions/...` — `Logout` deletes `Path.Combine(ApplicationData.Current.LocalFolder.Path, "session.db")` `:148`).

**Login flow** (`Login(byte[] clientKey)`, `:86`–`100`):
1. `SetClientKey(clientKey)` → write slot 2 in `session.db` (or clear if null).
2. `EnsureActiveSessionFolder` → `Directory.CreateDirectory(sessions/{SHA1(ClientKey)}/)`.
3. Open `nativeSettings.db` for that session via `GetNativeSettingsDbConfig`.
4. **Generate a fresh 32-byte `LegacyDbSecret`** and write it into `nativeSettings.db`: `_nativeSettings.Write(SettingsKey.LegacyDbSecret, EncryptionUtils.SecureRandomBytes(32))` (`:97`–`98`).
5. `_onLogin.OnNext(sessionData)` → fires the `OnLogin` observable that re-keys `genericStorage.db` (§3.3) and (re)initializes the typed stores (§3.5).

**`nativeSettings.db` encryption secret** (`GetNativeSettingsDbConfig`, `:165`–`177`):
```csharp
byte[] secret = clientKey != null ? EncryptionUtils.EncryptBytes(clientKey, StaticKeyBytes) : null;
return new DbConfig { FilePath = "sessions/{...}/nativeSettings.db", Secret = EnsureFixedSecretSize(secret), ... };
```
So `nativeSettings.db` is keyed by **PBKDF2-AES-CBC of the account ClientKey wrapped with `StaticKeyBytes`** (see §3.7) — meaning `nativeSettings.db` (which holds `LegacyDbSecret` and `GenericStorageDbPassword`) can only be opened by someone holding the ClientKey, and the ClientKey itself sits in DPAPI-protected `session.db`.

**Bridges** (host objects exposed to JS):
- `ClientKeyController` (`ClientKeyBridge`): `SetClientKey(string base64)` → `Convert.FromBase64String` → `loginSessionManager.Login` (`ClientKeyController.cs:21`–`25`); `GetClientKey()` returns base64; `ClearClientKey()` → `Logout()` then **`App.Instance.Restart(ControlledRestartTypes.UserLogout, ...)`** (`:32`–`46`) — logout forces a full app restart.
- `ServerEncKeySaltController` (`ServerEncKeySaltBridge`): same base64 in/out, writing slot 3 (`ServerEncKeySaltController.cs:18`–`47`).
Both registered in `AppModel.SetWebView` (`AppModel.cs:225`, `:241`); declared as activatable classes in `x64/AppxManifest.xml:156`,`:161`.

### 3.7 At-rest crypto primitives

**DPAPI** (`ProtectionUtils.cs`): `ProtectBytes`/`UnprotectBytes` via `new DataProtectionProvider("LOCAL=user")` (`:18`, `:29`) — binds the blob to the current Windows user. Used for the `session.db` secret.

**PBKDF2 + AES-CBC wrap** (`EncryptionUtils.cs`):
- Constants: `IterationCount = 10000`, `IvLength = 16`, `KeyLength = 32` (`:12`–`16`).
- `GeneratePbkdf2KeyWithInitializationVector` (`:39`–`49`): PBKDF2-SHA256 (`Pbkdf2Sha256`), **salt = `SystemIdentification.GetSystemIdForPublisher().Id`** (the per-install/per-publisher system id, `GetPublisherKey` `:51`–`54`), 10000 iterations, over the supplied `staticKey` as password material; derives 32-byte key material then a 16-byte IV; cipher = `AesCbcPkcs7`.
- `EncryptBytes(key, secret)`/`DecryptBytes(...)` (`:23`–`37`) — used to wrap the ClientKey into the `nativeSettings.db` secret.
- `SecureRandomBytes(n)` → `Axolotl.GenerateRandomBytes(n)` (CSPRNG via `CryptographicBuffer.GenerateRandom`) (`:18`–`21`).

**`SettingsKey` enum** (`WhatsApp.NativeSettings/SettingsKey.cs`): `Unknown=-1, None=0, GenericStorageDbPassword=1, LegacyDbSecret=2, LastTimePushNotificationShownUtc=3`. (These are the slot keys inside `nativeSettings.db`, distinct from the `session.db` slots 2/3.) `Settings` (`Settings.cs`) wraps the storage with a `ReaderWriterLock` (5s timeout, `:7`).

**Migration crypto** (`WhatsApp.SeamlessMigration/WhatsAppCryptoHelper.cs`) — separate at-rest scheme for importing legacy local data: a *different* hardcoded 16-byte static key (`:47`–`52`: `{83,3,177,76,9,132,233,177,63,231,87,112,205,37,170,247}`), same PBKDF2-SHA256(10000, salt=publisher id) derivation (`:78`–`87`). `DecryptNonDbFile` uses `AesCbcPkcs7` (`:25`); `DecryptDbSecret(staticPrivateKey, ...)` uses **`AesCbc` with `PaddingMode.None`** (`:37`, `:66`) keyed by a supplied private key. First un-DPAPIs (`UnprotectAsync`, `LOCAL=user`, `:71`–`76`) then AES-decrypts.

**Live on-disk confirmation of the page-cipher structure and key chain** [live-appdata — doc 94 §1/§2]. A real `appdata_dump` of the running client was decoded this session; it confirms the at-rest design end-to-end:
- **Page structure** — all seven native DBs are page-encrypted: none begins with `SQLite format 3\0`, every file is an exact multiple of **4096 bytes**, and each starts with a random high-entropy 16-byte prefix → **4096-byte pages + per-DB 16-byte salt** under a **custom AES+HMAC page codec (not stock SQLCipher)**, with the raw 32-byte secret used directly as the page key (no passphrase PBKDF2; doc 96 §3). Directly observed e.g. `LocalState/session.db` = 4096 B, header `2f d7 b7 4e be a0 35 bc 17 ad 02 60 ca 83 8b de …`; `contacts.db` = 4026368 B (= 983×4096), `genericStorage.db` = 2355200 B (= 575×4096), etc.
- **Key chain** confirmed matching §3.6/§3.7: `session.db` ← `EnsureFixedSecretSize(DPAPI.ProtectBytes(StaticKeyBytes))` (`LoginSessionManager.cs:66`, `ProtectionUtils.cs:18`, user-bound); `nativeSettings.db` ← `EnsureFixedSecretSize(EncryptionUtils.EncryptBytes(ClientKey, StaticKeyBytes))` = AES-CBC-PKCS7 with key `PBKDF2-SHA256(pw=ClientKey, salt=GetSystemIdForPublisher(), 10000, 32B)` (`:169`–`170`, machine-bound); the five data DBs (`contacts`/`contactsState`/`abprops`/`genericStorage`/`mediaDownloads`) ← `LegacyDbSecret = SecureRandomBytes(32)` stored in `nativeSettings.db` (`:97`–`98`). **Consequence:** the chain roots in two machine/user-bound secrets (DPAPI `LOCAL=user` master key + the per-device `GetSystemIdForPublisher` hardware id), **neither of which is present in an app-folder dump**, so the native DBs are **not offline-decryptable** from a copied app folder — the at-rest scheme is a custom AES+HMAC page codec (not stock SQLCipher; doc 96 §3) defended primarily by *machine binding*, not by a recoverable in-package key.
- **The native page codec's crypto is statically linked, not CNG** [native-binary — doc 96]: `WhatsAppNative.dll` imports from `bcrypt.dll` only `BCryptGenRandom`/`Open`/`CloseAlgorithmProvider` (RNG); the AES/HMAC/SHA of the codec are inside the binary (SHA-1/256/512 statically present per doc 96; likely BoringSSL-from-WebRTC). See §4.
- **The keys this protects are themselves plaintext elsewhere** [live-appdata — doc 95]: the WebView2 IndexedDB (`LocalCache/EBWebView/.../https_web.whatsapp.com_0.indexeddb.leveldb`) is unencrypted Chromium LevelDB and is the authoritative Signal/app-state store (`signal-storage`, `model-storage`, `wawc_db_enc`). The native encrypted DBs (custom AES+HMAC page codec, not stock SQLCipher) are a cache/mirror; a renderer-hosted port inherits the IndexedDB store and need not replicate the page-codec/DPAPI scheme (doc 94 §4).

**`SqliteSecretManager`** (`SqliteSecretManager.cs`) is effectively a no-op stub: `ToggleEncryption` is `[Conditional("ALPHA")]` and empty; `GetSecret()` returns `Array.Empty<byte>()`; `IsSecretGeneratedDuringCurrentAppSession` defaults false (used by `Sqlite.cs:798` to decide whether a `SQLITE_NOTADB` on first attempt is worth reporting). Inference: encryption keys come from the controllers above, not this manager, in production builds.

### 3.8 On-disk layout & multi-account isolation

Root: `ApplicationData.Current.LocalFolder.Path` (`Constants.IsoStorePath`, `Constants.cs:202`).

```
LocalFolder/
├── session.db                                  (DPAPI(StaticKeyBytes)-keyed; ClientKey slot 2, ServerEncKeySalt slot 3)
└── sessions/
    └── {SHA1(ClientKey) | "00000" if logged out}/
        ├── nativeSettings.db                    (key = PBKDF2-AES-CBC(ClientKey, StaticKeyBytes))
        │     └─ slot 1 GenericStorageDbPassword (random 32B), slot 2 LegacyDbSecret (random 32B)
        ├── genericStorage.db                    (key = GenericStorageDbPassword; JS-owned schema)
        ├── contacts.db                          (key = LegacyDbSecret; schema v23)
        ├── contactsState.db                     (key = LegacyDbSecret; schema v1)
        ├── abprops.db                           (key = LegacyDbSecret; schema v1)
        ├── mediaDownloads.db                    (key = LegacyDbSecret; schema v2)
        └── transfers/                           (downloaded media files)
```
- Session folder name = `ClientKey?.GetSHA1HashString() ?? "00000"` (`SessionDataPathUtils.cs:15`); full path = `LocalFolder/sessions/{hash}/...` (`:24`–`28`).
- **Single account on disk**: on login, `WipeInactiveSessionFolders` enumerates `sessions/*` and `Directory.Delete(..., recursive:true)` every folder except the active one (`LoginSessionManager.cs:113`–`136`). So only one account's data persists at a time.
- WAL means `*.db-wal` and `*.db-shm` sidecars accompany each open DB (handled by `DeleteDatabaseFile`, `Sqlite.cs:1205`).

**Key-derivation dependency chain** (confirmed from code):
`StaticKeyBytes` (hardcoded) → DPAPI(LOCAL=user) → `session.db` secret → holds `ClientKey` → PBKDF2-AES-CBC(ClientKey, StaticKeyBytes) → `nativeSettings.db` secret → holds `LegacyDbSecret` (random) + `GenericStorageDbPassword` (random) → keys for all typed stores + `genericStorage.db`.

### 3.9 `contacts.db` runtime concurrency, token-gated access & reactive change events

§3.5 documented the `contacts.db` *schema and migration*. This section documents the **runtime contention/locking model** and the **Rx event surface** layered on top by the concrete singleton `ContactsContext : SqliteContactsContext` (`WhatsApp.Data/ContactsContext.cs:18`). `contacts.db` is the most contended native store (read from UI threads, written from contact-sync), so unlike the other typed stores it is guarded by an explicit token-gated read/write lock with priority arbitration.

The class also implements the two `UserCache` contracts directly — `ContactsContext : SqliteContactsContext, UserCache.IFullAccessDb, UserCache.IReadonlyAccessDb` (`ContactsContext.cs:18`) — so the rest of the app consumes it through those interfaces (`UserCache.IReadonlyAccessDb.GetUserStatus` → `GetUserStatus(jid, createIfNotFound:false)` `:272`–`275`; `UserCache.IFullAccessDb.GetOrCreateUserStatus` → `GetUserStatus(jid, createIfNotFound:true)` `:267`–`270`).

#### 3.9.1 The access-provider / access-token layer

Access to the singleton is **never** by calling its methods directly; callers must first obtain a token from one of two static providers, which acquires the lock for the right mode:

- `ContactsContext.Statics` (`get => new Access()`, `:71`) — a `Access : IDbAccessProvider<LockPriority, ContactsContext>` whose `GetToken` calls `CreateDbAccessToken(LockType.Write, …)` (`:20`–`26`).
- `ContactsContext.ReadonlyStatics` (`get => new ReadOnlyAccess()`, `:73`) — a `ReadOnlyAccess` provider whose `GetToken` calls `CreateDbAccessToken(LockType.ReadOnly, …)` (`:28`–`34`).

Two public factory entry points expose these as `IAccess<…>` handles for the generic `AccessExtensions.Run` helpers (`WhatsApp.Core/WhatsApp.Data/AccessExtensions.cs:33`–`43`, which do `using token = capture.GetToken(); func(token.GetResource())`). `AsAccess` here is the extension `AsAccess<TArg,TDbAccess>(this IDbAccessProvider<TArg,TDbAccess>, TArg arg, …)` that binds the `LockPriority` into an `IAccess` adapter (`WhatsApp.VoIP/WhatsApp.Data/DbAccessProviderExtensions.cs:227`–`230`):

```csharp
public static IAccess<ContactsContext> CreateReadonlyAccess(LockPriority lockPriority = LockPriority.Default, …)
    => ReadonlyStatics.AsAccess(lockPriority, desc);                 // ContactsContext.cs:75-78
public static IAccess<ContactsContext> CreateAccess(LockPriority lockPriority = LockPriority.Default, …)
    => new AccessToken(lockPriority, desc);                          // :80-83
```

The interfaces involved (all in `WhatsApp.Core/WhatsApp.Data` + `WhatsApp.VoIP/WhatsApp.Data`):
- `IDbAccessProvider<in TArg, out TAccess>.GetToken(TArg context, …)` (`IDbAccessProvider.cs:5`–`8`) — `TArg` here is `LockPriority`.
- `IDbAccessToken<out T> : IAccessToken<T>, IDisposable` with `T GetAccess(…)` (`IDbAccessToken.cs:6`–`9`); concrete `DbAccessToken<T>` holds `{access, CancellationToken, IDisposable resource}` and disposes the lock-release `resource` on `Dispose` (`DbAccessToken.cs:7`–`41`; `GetResource()` → `GetAccess` `:27`–`30`, plus an implicit `operator T` `:37`–`40`).
- `IAccess<out T>.GetToken() : IAccessToken<T>` (`IAccess.cs:3`–`6`); `IAccessToken<out T> : IDisposable` exposes `CancellationToken Cancellation` + `T GetResource()` (`IAccessToken.cs:6`–`11`).

There is also a convenience path that wraps a `func` in the lock: `ContactsContext.Instance<T>(Func<ContactsContext,T>)` (`:85`–`101`) / the void `Instance(Action<…>)` (`:121`–`128`) / `LegacyInstance<T>` (`:103`–`119`) — all of which call `Statics.Run(func, desc)` i.e. **acquire the write lock, run, release** (note even the read-shaped `Instance` overloads take the *write* provider). When invoked on the UI dispatcher they wrap the call in `AppTracker.Track(AppTrackerTypes.ContactsDbFromUi)` (`:88`–`96`) to flag main-thread DB access.

#### 3.9.2 `CreateDbAccessToken` — the lock acquisition core (`ContactsContext.cs:130`–`176`)

Every token funnels through `CreateDbAccessToken(LockType lockType, LockPriority priority, …)`:

1. **Re-entrancy warning**: if `IsThreadOwner(lockType)` already holds the matching lock it logs `Log.Warn("Recursion", …)` (`:147`–`150`) — the lock is `LockRecursionPolicy.NoRecursion` (see below), so recursive acquisition is a bug.
2. **Acquire** under a performance timer: `token = LockObj.WaitOne(priority, isReadonly: lockType == LockType.ReadOnly, PriorityLock)` (`:152`). `LockObj` is `static readonly ReaderWriterLockSlim LockObj = new(LockRecursionPolicy.NoRecursion)` (`:63`); `PriorityLock` is `static readonly LockWithPriorities PriorityLock = new()` (`:65`). The `ReaderWriterLockSlim.WaitOne(priority, isReadonly, priorityLock)` extension (`WhatsApp.Core/WhatsApp/LockWithPrioritiesExtensions.cs:28`–`58`) first waits on the priority gate, then enters a **read** lock (`EnterReadLock`) when `isReadonly` else a **write** lock (`EnterWriteLock`); on cancellation it releases and retries. So **ReadOnly tokens share a read lock; Write tokens are exclusive** — standard single-writer/multi-reader.
3. **Lazy-create** the singleton: `if (instance == null) instance = GetInstance();` (`:156`–`159`). `GetInstance()` (`:236`–`244`) builds `new ContactsContext(loginSession.GetSessionLocalPath(), () => LoginSessionDataProvider?.SessionLocalSettings.Read(SettingsKey.LegacyDbSecret))` and, on a fresh file, calls `CreateDatabase()` (`:239`–`242`).
4. **Stamp the access session**: a `DbAccessSession value = new DbAccessSession(hasWriteAccess: lockType == LockType.Write, desc)` is pushed onto `instance.Db.AccessSession.Value` (a `ThreadLocal<DbAccessSession>` on the underlying `Sqlite`, `Sqlite.cs:770`), saving the previous one to restore on dispose (`:160`–`162`). `DbAccessSession` (`DbAccessSession.cs`) carries `{Description, HasWriteAccess, WriteOperationsCount}` — this is the per-call audit/intent record threaded down to the SQLite layer.
5. **Return** a `DbAccessToken<ContactsContext>(instance, CancellationToken.None, new DisposableAction(OnDispose))` (`:163`).
6. **`OnDispose`** (`:165`–`175`): logs if the lock was held too long (`PerformanceTimer.LogIfExcessive(…, "Took too long holding contacts lock.")`), runs `instance.PostProcessing("Post Contact database processing")`, restores the previous `AccessSession.Value`, then `token.Dispose()` releases the RW lock + priority gate. `PostProcessing` (inherited, `SqliteDataContext.cs:856`–`875`) purges any table whose `[Table(PurgeCache=true)]` flag is set.

`IsThreadOwner(LockType)` (`:192`–`209`) maps `ReadOnly → IsReadLockHeld|IsWriteLockHeld|IsUpgradeableReadLockHeld`, `Write → IsWriteLockHeld`, `UpgradeableRead → IsUpgradeableReadLockHeld`.

> **Caveat (read from code):** the third inner provider, `AccessToken : IAccess<ContactsContext>` returned by `CreateAccess` (`:36`–`52`), has its `GetToken()` hardcoded to `CreateDbAccessToken(LockType.Write, …)` (`:48`–`51`) — i.e. `CreateAccess` always yields a **write** token regardless of intent, whereas `CreateReadonlyAccess` correctly yields a read token via `ReadOnlyAccess`. So in practice only `CreateReadonlyAccess` / `GetUserCacheReadonlyAccess` take the shared read path; `CreateAccess` / `Instance*` are all exclusive writers.

#### 3.9.3 `LockPriority` priority arbitration (`LockWithPriorities`)

The `ReaderWriterLockSlim` is fronted by a `LockWithPriorities` priority gate (`WhatsApp.Core/WhatsApp/LockWithPriorities.cs`) so a higher-priority waiter can pre-empt lower-priority waiters queued for the same DB. `LockPriority = {Low, Default, High}` (`WhatsApp.Core/WhatsApp/LockPriority.cs:3`–`8`); most call sites use `LockPriority.Default`, and `ContactsContext.Delete()` takes it at `High` (`:222`). Internally `LockWithPriorities` holds one `State` (a `CancellationTokenSource` + waiter count) per priority level (`:56`–`66`); `AddWaitRequest` **cancels all lower-priority states** when a new higher waiter arrives (`:79`–`91`), and `RemoveWaitRequest` re-`Allow()`s them once the high-priority queue drains (`:93`–`111`). The `LockToken` returned carries that `CancellationToken` (`LockToken.cs`), which is what the `…Extensions.WaitOne` retry loop watches to drop and re-acquire when pre-empted.

#### 3.9.4 The dispatcher that owns the lock for a whole work item

`ContactsContextDispatcher : ConcurrentQueueDispatcher, ICapturingThreadDispatcher<ContactsContext>` (`WhatsApp.VoIP/WhatsApp/ContactsContextDispatcher.cs:6`) is the thread pump most subsystems post contacts work onto. It holds **one token for the duration of a batch of queue items**: `InvokeQueueItems` does `using (_token = _access.GetToken()) { base.InvokeQueueItems(state); }` (`:64`–`71`), and its post-condition runs `_token.GetResource().PostProcessing("ContactsContextDispatcher")` (`:73`–`76`). There are two singletons:
- `Instance` — built on `ContactsContext.CreateAccess(Default)` i.e. the **write** dispatcher (`:26`–`29`).
- `ReadonlyInstance` — `Instance` itself when `ConcurrentRead <= 1`, else a `LimitedCapturingThreadPool` of `ConcurrentRead` readonly dispatchers (`:31`–`46`). `ConcurrentRead` = **1 in production, 4 only in Alpha** (`:14`–`24`), so **production serializes all contacts access to a single dispatcher thread** (`UserCache` wires `ByJid`/`ByJidOnlyExisting` to these dispatchers, `UserCache.cs:156`–`158`).

`ContactsContext.InitializeStatics` subscribes to login: on every `OnLogin` it does `Reset(force:true)` (`:183`–`190`), disposing+nulling the singleton (`:211`–`218`) so the next access reopens against the new session's `LegacyDbSecret` (resolving the §6 "re-key vs reopen" question for *this* store: `contacts.db` is **reopened**, not re-keyed in place, because the secret provider closure reads the current `SettingsKey.LegacyDbSecret`).

#### 3.9.5 `ContactsContext.Events` — the reactive change surface (`ContactsContext.cs:54`–`61`)

A static nested `Events` class exposes three Rx `Subject<T>` streams that the rest of the app subscribes to for contact/block-list change notifications:

```csharp
public static class Events {
    public static Subject<DbDataUpdate>            UserStatusUpdatedSubject  = new();  // :56
    public static Subject<ChangeNumberAction>      ChangeNumberActionSubject = new();  // :58
    public static Subject<IReadOnlyList<UserJid>>  BlockListUpdateSubject    = new();  // :60
}
```

- **`UserStatusUpdatedSubject : Subject<DbDataUpdate>`** — per-`UserStatus` row changes. `DbDataUpdate` (`WhatsApp/DbDataUpdate.cs`) is `{ Types UpdateType (None/Added/Deleted/Modified), object UpdatedObj, string[] ModifiedColumns }`, where `ModifiedColumns` is only populated for `Modified` (`:19`–`31`) — i.e. consumers get the changed entity plus the dirty-column set produced by the ORM change tracker (§3.4).
- **`ChangeNumberActionSubject : Subject<ChangeNumberAction>`** — phone-number change events. `ChangeNumberAction` (nested in `SqliteContactsContext.cs:36`–`56`) is `{ UserJid OldJid, UserJid NewJid, Type ActionType (Added|Removed) }`.
- **`BlockListUpdateSubject : Subject<IReadOnlyList<UserJid>>`** — emits the new block list when it changes (the context caches it in `_blockListSet`, `SqliteContactsContext.cs:94`).

These are plain `Subject<T>` (hot, no replay), so subscribers only receive events emitted after they subscribe.

> **Unverified — publishers not in the dump.** The three subjects are *declared* here, and `UserCache`/`ContactsContextDispatcher` are the documented consumers of the context, but **no `.OnNext(...)` publish call sites or `.Subscribe(...)` references to `ContactsContext.Events.*` appear anywhere in the decompiled C#** (`grep -rn "UserStatusUpdatedSubject\|ChangeNumberActionSubject\|BlockListUpdateSubject"` over `decompiled/**` returns only the three declarations). The emit sites (contact-sync / block-list / change-number handlers) and the UI subscribers were apparently inlined or dropped by the decompiler, so the exact trigger points and threading of these notifications are **inferred from the types**, not confirmed from call sites. A port should treat the three subjects as the contract and (re)derive the emit points from where the schema is mutated.

#### 3.9.6 Port mapping (access model + events)

| Windows piece | Electron/Node equivalent | Notes |
|---|---|---|
| `ReaderWriterLockSlim` + `LockWithPriorities` token gate around `contacts.db` | A small async read/write mutex (e.g. `async-rwlock`, or a hand-rolled queue) keyed per-DB; priority levels can usually be dropped (production runs everything on one serialized dispatcher anyway) | The priority arbitration only matters under contention; with `ConcurrentRead=1` in prod it degenerates to a single mutex. **Low risk.** |
| `IDbAccessProvider`/`IDbAccessToken` + `AccessExtensions.Run` | A `withContactsDb(mode, fn)` helper that acquires the lock, runs `fn`, releases | The `GetResource`/implicit-`operator T` ceremony is C# convenience; collapse it. |
| `ContactsContextDispatcher` single-thread pump | A single worker (Node worker thread or just a serialized async queue) owning the better-sqlite3 handle | Matches the prod `ConcurrentRead=1` model directly. |
| `ContactsContext.Events.*` `Subject<T>` | A typed `EventEmitter` (or RxJS `Subject`) emitting `{type, entity, modifiedColumns}` / change-number / block-list payloads | Re-derive emit points where you mutate `UserStatuses`/block list/number. Field names (`UpdateType`, `ModifiedColumns`, `OldJid/NewJid/ActionType`) are the load-bearing contract for any JS subscriber. |
| `DbAccessSession` thread-local intent record | Optional; only used for logging/audit and `PurgeCache` post-processing | Can be omitted in a port. |

### 3.10 The native contacts store, the `ContactsBridge` JS protocol & address-book sync

§3.5/§3.9 covered the `contacts.db` *schema/migration* and its *concurrency model*. This section covers the **native-side contact store and its two distinct sync surfaces** that the earlier sections only named: (a) the `ContactsManager` host object that drives the JS↔native contact-data exchange and the `contactsState.db` invalidation set, and (b) the `ContactSyncService` + `ShareContactManager`/`JumpListContactManager` path that **pushes** WhatsApp contacts *out* to the Windows address book and Start-menu jump list. These are two different "syncs" and must not be conflated.

#### 3.10.1 `ContactsManager` — the native contacts coordinator (`WhatsApp.Root/WhatsApp/ContactsManager.cs`)

`ContactsManager : IContactsBridgeToNative` (`ContactsManager.cs:19`) is the native object exposed to JS as the `ContactsBridge`/`PopulatedContactsBridge` host object. It does **not** itself own `contacts.db`; it is the *bridge + orchestration layer* that (1) maintains an in-memory per-contact `ContactState` map, (2) persists the invalidation set into `contactsState.db`, and (3) writes the actual contact rows into `contacts.db` via the `ContactsContext` singleton (§3.9). Note the C# class carries `[WinRTRuntimeClassName("WinRTAdapter.IContactsBridgeToNative")]` (`:17`) — i.e. it is the managed adaptee projected through the `WinRTAdapter.ContactsBridge` activatable class (`x64/AppxManifest.xml:164`, the only contacts entry in the manifest).

**The `Contact` DTO (JS wire model)** (`ContactsManager.cs:40`–`73`) — a `[JsonPropertyName]`-annotated POCO deserialized from the JS-supplied JSON array:

| JSON field | C# prop | Type | Notes |
|---|---|---|---|
| `id` | `Id` | `string` | contact id; for username/LID contacts ends with `"lid"` (`:277`) |
| `phoneNumber` | `PhoneNumber` | `string?` | JS form uses `…@c.us`; rewritten to `…@s.whatsapp.net` before JID parse (`:259`) |
| `name` | `Name` | `string?` | → `UserStatus.FirstName` **and** `UserStatus.ContactName` (`:263`–`264`) |
| `pushname` | `PushName` | `string?` | → `UserStatus.PushName` |
| `isAddressBookContact` | `IsAddressBookContact` | `int` | `== 1` → `UserStatus.IsInDeviceContactList` (`:265`) |
| `type` | `Type` | `string?` | carried in DTO/`ToString` only; not mapped to a column |
| `username` | `UserName` | `string?` | LID branch only, stored as `"@"+username` (`:283`) |
| `usernameCountryCode` | `UsernameCountryCode` | `string?` | → `UserStatus.UsernameCountryCode` |
| `isHosted` | `IsHosted` | `bool?` | → `UserStatus.IsHosted` |

**`ContactState`** is a private enum `{Invalid, Requesting, Storing, Valid}` (`:32`–`38`) tracked in `Dictionary<string,ContactState> _states` (`:77`), guarded by `lock(_states)`. The semantics: `Invalid` = the row is stale and JS must re-send it; `Requesting` = native has asked JS to update it; `Storing` = a write into `contacts.db` is in flight; `Valid` = up-to-date (removed from the map and from the persistent invalid set).

**`IsInitiallySynced` and the populated-vs-empty bridge selection.** On `Initialize(sessionData)` (`:97`–`112`, fired off the login observable on a `ConcurrentQueueDispatcher`, `:94`) the manager opens `contactsState.db` (`new SqliteContactsStateDatabase(sessionData.GetSessionLocalPath("contactsState.db"), () => _settings.Read(SettingsKey.LegacyDbSecret))`, `:103`–`105`), seeds `_states` with every persisted invalid id as `ContactState.Invalid` (`:106`–`111`), and sets `IsInitiallySynced = (_statesDatabase.Settings[ContactsManagerStateSetting.InitialState] != null)` (`:107`). That flag drives the **bridge name** registered to JS (`AppModel.SetWebView`, `:238`–`239`):

```csharp
string name = (_contactsManager.IsInitiallySynced ? "PopulatedContactsBridge" : "ContactsBridge");
webView.AddWinRTBridge(name, new ContactsBridge(_contactsManager), dispatchAdapter);
```

So the *same* `ContactsManager` object is always wrapped in a `WinRTAdapter.ContactsBridge` RCW (`WinRTAdapter/ContactsBridge.cs:154`), but it is **exposed under one of two host-object names** depending on whether an initial address-book sync ever completed: `window.chrome.webview.hostObjects.ContactsBridge` (first run, store empty) vs `…PopulatedContactsBridge` (subsequent runs). The JS bundle keys off which name is present to decide whether it must perform a full initial contact upload or only incremental updates. `ContactsManagerStateSetting` is a one-value enum (`InitialState = 1`, `ContactsManagerStateSetting.cs`), and the only value ever written is the literal `"synced"` (`ContactsManager.cs:150`).

#### 3.10.2 The `IContactsBridgeToNative` / `IContactsBridgeToWeb` protocol

The bridge is **bidirectional**: JS→native via `IContactsBridgeToNative` (`WinRTAdapter/IContactsBridgeToNative.cs:11`–`22`, GUID `C5AF3B30-7E4F-5408-8B29-95E447982B96`) and native→JS via the `IContactsBridgeToWeb` callback interface JS registers (`WinRTAdapter/IContactsBridgeToWeb.cs:10`–`15`, GUID `1A1A5BBC-…`).

JS→native methods (impl in `ContactsManager.cs`):
- **`Subscribe(IContactsBridgeToWeb web)`** (`:137`–`141`) — JS hands native its callback object; stored in `_web`.
- **`InvalidateContacts(string[] ids)`** (`:132`–`135`) → `StoreState(ids, Invalid)` — mark ids stale so the poll loop re-requests them.
- **`UpdateContacts(string[] removedIds, string jsonArray)`** → `IAsyncAction` (`:164`–`167`, `:201`–`219`) — the main data-in path: deserialize `Contact[]`, mark all touched ids `Storing`, `RemoveContacts(removedIds)` (currently a **no-op**, `:293`–`295`), `StoreContacts(parsed)`, then mark them `Valid`.
- **`AcknowledgeInitialSync()`** (`:143`–`152`) — JS signals the first full upload is done: persists the current invalid set, sets `IsInitiallySynced = true`, writes `Settings[InitialState] = "synced"` into `contactsState.db`. (Takes effect for bridge-name selection only on the *next* app launch, since the host object was already registered at `SetWebView`.)
- **`ReceiveFrequentContacts(string jsonArray)`** → `IAsyncAction` (`:169`–`183`) — JS returns the frequent-contact JID list; stored in `_frequentContactJids` and completes the pending `TaskCompletionSource`.

native→JS methods (called on `_web`):
- **`RequestUpdate(string ids)`** (`IContactsBridgeToWeb.cs:12`) — native asks JS to (re)send the JSON for a batch of invalid ids.
- **`RequestFrequentContacts(int count, bool includeVoipCallableOnly)`** (`:14`) — native asks JS for the N most-frequent contacts.

**The reconciliation poll loop** (`ContactsManager.Start`, `:114`–`130`, kicked off from `AppModel.Warmup` `:181`): after hopping to the dispatcher it loops forever with `await Task.Delay(1000)` (1 s), and when `IsInitiallySynced && _web != null` it takes up to **100** ids still in `ContactState.Invalid` (`GetInvalidKeys(100)`, `:122`/`:154`–`162`), flips them to `Requesting`, and calls `_web.RequestUpdate(JsonSerializer.Serialize(invalidKeys))` (`:126`). JS responds by calling `UpdateContacts(...)`, closing the loop. So **the JS bundle is the source of truth for contact identity/names; native pulls deltas in batches of ≤100/sec and persists them.**

**`StoreContacts` — writing into `contacts.db`** (`:252`–`291`) runs two passes inside `ContactsContext.Instance(db => …)` (i.e. under the §3.9 write lock):
1. **Phone-number pass** — for each `Contact` with a parseable `phoneNumber` (`…@c.us`→`…@s.whatsapp.net`, `JidFactory.TryCreateUserJid`), `db.GetUserStatus(userJid, createIfNotFound:true)` then set `PushName`, `FirstName`, `ContactName`, `IsInDeviceContactList = (IsAddressBookContact==1)`, `UsernameCountryCode`, `IsHosted`; `db.SubmitChanges()` (`:259`–`270`).
2. **LID pass** — for each `Contact` whose `Id` ends with `"lid"`, same mapping plus `UserName = "@"+username` (`:277`–`289`).

So the native `contacts.db` `UserStatuses` table is effectively a **native cache of the JS contact model** keyed by JID/LID, used by native subsystems (VoIP caller display, contact sharing, jump list) that cannot reach the JS data model directly. `StoreState` mirrors the same ids into `contactsState.db`'s `Invalidated` table only while `IsInitiallySynced` (`:221`–`250`): `Invalid`→`AddInvalid`, `Valid`→`RemoveInvalid` (only for ids currently `Storing`).

#### 3.10.3 `contactsState.db` revisited as the sync-state store

`SqliteContactsStateDatabase : SqliteData` (schema v1, §3.5) is the durable backing for the invalidation set. Concretely (`SqliteContactsStateDatabase.cs`):
- `Settings(Key INT PRIMARY KEY, Value TEXT)` — KV via `IGenericSettingsDatabase<ContactsManagerStateSetting>` indexer (`:20`–`30`, `GetSetting`/`SetSetting` `:39`–`55`); the only key used is `InitialState=1` → `"synced"`.
- `Invalidated(ContactId TEXT UNIQUE PRIMARY KEY)` — the persistent set of stale contact ids. `AddInvalid` = batched `INSERT OR IGNORE` inside a transaction (`:57`–`79`); `RemoveInvalid` = batched `DELETE … WHERE ContactId = ?` (`:81`–`103`); `ReadInvalid` = `SELECT ContactId FROM Invalidated` (`:105`–`116`).

This is why a fresh install (no `Invalidated` rows yet, no `InitialState`) exposes the empty **`ContactsBridge`** and prompts JS for a full upload, whereas a returning user (with `InitialState="synced"`) exposes **`PopulatedContactsBridge`** and only the persisted invalid ids get re-requested by the poll loop.

#### 3.10.4 `ContactSyncService` — periodic *outbound* address-book / jump-list sync

`ContactSyncService` (`WhatsApp.Root/ContactSyncService.cs`) is a **separate** mechanism from the bridge above: it pushes WhatsApp contacts *out* to the Windows OS so they appear in the system People app and the taskbar jump list. Wired in `AppModel`: constructed at `:139`, `StartPeriodicSync()` called from `Initialize` (`:173`).

- **`StartPeriodicSync()`** (`:11`–`20`) creates a single `System.Threading.Timer` firing `SyncContacts()` with **dueTime = 10 min, period = 1 h** (`TimeSpan.FromMinutes(10)`, `TimeSpan.FromHours(1)`). `StopPeriodicSync()` disposes it.
- **`SyncContacts()`** (`:22`–`35`, swallows all exceptions): `await ShareContactManager.Instance.ShareRecentContactsAsync()`, and if `AbProps.Props.EnableWindowsJumplistHybrid` then `JumpListContactManager.Instance.ShareContactsAsync()`.

**`ShareContactManager`** (`WhatsApp.SystemIntegrations/ShareContactManager.cs`) integrates with the Windows contacts platform (`Windows.ApplicationModel.Contacts`/`UserDataAccounts`). Gated by OS build ≥ `10.0.22621.4602` and `AbProps.Props.Enable3PContactsShareHybrid` (`:59`–`66`). On first use it lazily creates a `UserDataAccount("com.microsoft.peoplecontract")`, a `ContactStore` `ContactList("WhatsApp")` with `OtherAppReadAccess = None`, and a `ContactAnnotationList` (`:83`–`106`). `ShareRecentContactsAsync` (`:109`–`133`, serialized by a `SemaphoreSlim(1,1)`) builds the share set: either `GenerateFrequentContacts()` or, when `AbProps.Props.ShareAllContactsToWindows`, `GenerateAllContacts()` (`:117`). The contact source is the **native `ContactsManager`** (`_model.ContactsManager`) via `ContactsSource.CreateFrequentContacts(contactsManager, …, voipCallableOnly:true, …)` (`:153`–`156`) — i.e. it drives `RequestFrequentContacts`/`ReceiveFrequentContacts`/`GetFrequentContactJids` on the manager (§3.10.2). Each shared `Windows.…Contacts.Contact` carries `RemoteId = userJid.ToVoipString()`, `FirstName = title`, and a circular-cropped avatar (`ConvertUserVmToContactAsync`, `:195`–`217`), and is saved with a `ContactAnnotation{SupportedOperations = Share, ProviderProperties["Rank"]}` ordered by frequency (`UpdateSharedContactsAsync`, `:269`–`300`). Self is inserted at rank 0 (`CreateContactListWithSelf`, `:180`–`193`). `ClearSharedContactsAsync` (`:302`–`308`) deletes the WhatsApp contact list.

**`JumpListContactManager`** (`WhatsApp.Root/WhatsApp/JumpListContactManager.cs`) takes `ShareContactManager.Instance.JumpListContacts` (the top-5 frequent contacts computed at `ShareContactManager.cs:116`) and rebuilds the Windows taskbar `JumpList`: it removes the prior `JumplistTopContacts` group, wipes the `LocalFolder/ContactPictures` cache, then adds one `JumpListItem.CreateWithArguments("jid=" + contact.RemoteId, firstName)` per contact with a circular PNG logo written to `ms-appdata:///local/ContactPictures/…` (`:42`–`143`). Clicking a jump-list entry relaunches the app with the `jid=…` argument.

#### 3.10.5 `ContactNotificationHashProcessor` (notification-hash columns)

`UserStatuses` carries `JidNotificationHash`/`LidNotificationHash` indexed columns (POCO `[Index]`s at `WhatsApp.DataModels/WhatsApp.Data/UserStatus.cs:11`–`12`; populated by `SqliteContactsContext.PopulateJidNotificationHash` `:494`–`511` / `CreateFromJid` `:631`–`655` via `userJid.GetNotificationHash()`), used to find a contact by an opaque server-supplied hash without storing the raw number (`GetUsersMatchingJidHashNotInDevice`, `SqliteContactsContext.cs:327`–`360`). **In this build the hash is a stub**: `ContactNotificationHashProcessor.GetNotificationHash` returns the literal `"NOTIFICATION_HASH_" + userJid.ToString()` (`WhatsApp.VoIP/WhatsApp/ContactNotificationHashProcessor.cs:5`–`8`) — i.e. the real (presumably keyed/truncated) hashing is **not** present in the decompiled C#; treat the column contract as confirmed but the hash algorithm as **unconfirmed** (likely native or stripped).

#### 3.10.6 The full contacts-data column map (`UserStatuses`)

The `contacts.db` `UserStatuses` table schema is defined by `[Column]` attributes on `UserStatus` (`WhatsApp.DataModels/WhatsApp.Data/UserStatus.cs`), emitted by the attribute-driven `CreateDatabase` (§3.4). Resolving the §6 open question on the `UserStatus` column list, the persisted columns are (DB column name ← property; type per `GetDbType` §3.4):

`StatusID` (INTEGER PRIMARY KEY AUTOINCREMENT, `:145`–`146`), `Jid` (TEXT, ← `DbJid`, `:175`), `Wid` (TEXT, ← `UnsafeWid`, `:215`), `JidNotificationHash`/`LidNotificationHash` (TEXT, `:233`/`:253`), `PhotoPath` (TEXT), `PhotoHash` (BLOB), `Status` (TEXT), `StatusExpiryInSec` (INTEGER), `DateTimeSet` (INTEGER FileTimeUtc), `ContactName` (TEXT, `[Sensitive]` `:376`), `FirstName`, `PushName`, `UserName`, `UsernameCountryCode` (all TEXT), `IsHosted` (INTEGER nullable bool), `DisplayNameFromServer` (TEXT), `DbLid` (TEXT, ← `Lid`), `IsInDeviceContactList`/`IsSidelistSynced`/`IsInDevicePhonebook`/`IsWaUser` (INTEGER bool), `PhoneNumberKind`/`VerifiedName`/`VerifiedLevel` (INTEGER enums), `VerifiedNameCertificateDetailsSerialized` (BLOB), `HostStorage`/`ActualActors` (INTEGER enums), `PrivacyModeTs` (INTEGER), `InternalPropertiesProtobuf` (BLOB), `ShouldSync`/`ShouldSaveOnPrimaryAb`/`HasPnBeenShared`/`WasRecentlyRemovedFromAddressbook` (INTEGER bool), `DefaultEphemeralMessagesDurationSecs` (INTEGER), `DefaultEphemeralMessagesDurationLastChangedTime`/`LastUsyncTime` (INTEGER FileTimeUtc). Indexes (POCO `[Index]`, `:9`–`14`): unique `UserStatus_Jid(Jid)`, unique `UserStatus_Lid(DbLid)`, plus non-unique `UserStatus_ShouldSync`, `UserStatus_JidNotificationHash`, `UserStatus_LidNotificationHash`, `UserStatus_WasRecentlyRemovedFromAddressbook`. (Most columns use `UpdateCheck = UpdateCheck.Never`, i.e. they are not part of optimistic-concurrency `WHERE` clauses on UPDATE.)

The other two tables in the same `contacts.db` — `ChatPictures` and `WaScheduledTasks` — are unrelated to contact data but their `[Column]` maps are now fully read:

- **`ChatPictures`** (`WhatsApp.DataModels/WhatsApp.Data/ChatPicture.cs`): `ChatPictureId` (INTEGER PRIMARY KEY AUTOINCREMENT, `:68`–`69`), `Jid` (TEXT ← `DbJid`, `:72`–`73`), `WaPhotoId` (TEXT ← `LocalPreviewId`, `:107`–`108`), `LocalPhotoId` (TEXT, `:125`–`126`), `IsSmallPhotoInvalid`/`IsLargePhotoInvalid` (INTEGER bool, `[Obsolete]`, `:39`/`:54`), `NotAvailable` (INTEGER bool, `:147`), `ServerPhotoId` (TEXT, `:164`), `LastPictureCheck`/`BlockPictureRequestUntil` (INTEGER FileTimeUtc, `:182`/`:205`), `PictureData`/`ThumbnailData` (BLOB, `[Sensitive]`, `DbType="image"`, `:227`–`229`/`:246`–`248`). Unique index `ChatPicture_Jid(Jid)` (`:7`). Note `ValidatedPhotoId`/`RequestCheckPhotoId` (`:143`/`:145`) carry **no `[Column]`** → not persisted.
- **`WaScheduledTasks`** (`WhatsApp.DataModels/WhatsApp.Data/WaScheduledTask.cs`): `TaskID` (INTEGER PRIMARY KEY AUTOINCREMENT, `:46`–`47`), `TaskType` (INTEGER, `:49`), `LookupKey` (TEXT, `:66`), `DbJid` (TEXT ← `Jid`, `:99`–`101`), `BinaryData` (BLOB, `:130`–`131`), `Attempts` (INTEGER, `:147`), `AttemptsLimit` (INTEGER nullable, `:164`), `ExpirationUtc` (INTEGER FileTimeUtc nullable, `:181`), `Restriction` (INTEGER, `:198`). Non-unique index `WaScheduledTask_TaskType_LookupKey(TaskType,LookupKey)` (`:6`). The `Types` enum (`:15`–`28`) enumerates the scheduled-task kinds: `ClearMessages=1, DeleteChatPic=2, SaveChatPic=3, RateCall=4, IndexMessages=5, PurgeStatuses=6, PendingRevoke=7, ClearAllMessages=8, GenerateTransitBizSystemMessage=1001, PostContactRemoved=1002`. Non-`[Column]` members (`Jid`, `IsDeleted`, `IsExpired`, `IsAttemptsLimitReached`) are computed/non-persisted.

#### 3.10.7 Port mapping (contacts store & sync)

| Windows piece | Electron/Node equivalent | Notes |
|---|---|---|
| `ContactsManager` host object (`ContactsBridge`/`PopulatedContactsBridge`) | An IPC object exposed via `contextBridge` under **both** names, switching on a persisted "initially synced" flag | The JS bundle keys off *which* host-object name exists. Reproduce: expose `ContactsBridge` if not yet synced, else `PopulatedContactsBridge`. Method set (`Subscribe`, `InvalidateContacts`, `UpdateContacts(removedIds, jsonArray)`, `AcknowledgeInitialSync`, `ReceiveFrequentContacts`) + callbacks (`RequestUpdate`, `RequestFrequentContacts`) is the load-bearing contract. |
| `Contact` JSON DTO field names | Keep identical (`id`,`phoneNumber`,`name`,`pushname`,`isAddressBookContact`,`type`,`username`,`usernameCountryCode`,`isHosted`) | The waweb bundle serializes exactly these. `phoneNumber` arrives as `…@c.us`; rewrite to `…@s.whatsapp.net` before JID parsing. |
| `contactsState.db` (`Settings`+`Invalidated`) | A tiny SQLite/JSON store of `{initialState, invalidatedIds[]}` | Schema is trivial; one KV row + a string set. |
| `ContactState` map + 1 Hz `RequestUpdate(≤100)` poll loop | A serialized async loop pulling ≤100 invalid ids/sec and calling back into JS | Straightforward; matches prod throttle. |
| `ContactSyncService` (10 min due, 1 h period) → `ShareContactManager`/`JumpListContactManager` | **Largely Windows-specific.** Linux has no `Windows.ApplicationModel.Contacts`/`JumpList` equivalent | The *outbound* OS address-book + taskbar-jump-list integration is a Windows shell feature with no portable analogue; safe to **drop** on Linux/Electron (or substitute a desktop-specific integration). The inbound `ContactsBridge` data path is the part that must be ported. **Low priority.** |

## 4. Native Dependencies

| Piece | Native component | Status |
|---|---|---|
| SQLite engine | `WhatsAppNative.Sqlite` (C++/Rust in `WhatsAppNative.dll`), activated via `ActivationFactory.Get("WhatsAppNative.Sqlite")` | **Confirmed** the projection exists (`WhatsAppNativeProjection/WhatsAppNative/Sqlite.cs:55`) and exposes `Open(...,byte[] secret)`, `ChangeDbSecret`, WAL `Checkpoint`, `RegisterTokenizer`. Registered as in-process WinRT server in `x64/AppxManifest.xml`. |
| DB page encryption | **custom AES+HMAC page codec** inside the native engine, keyed by the `byte[] secret` passed to `Open` (**NOT stock SQLCipher**) | **Confirmed page structure** from live on-disk files (doc 94 §2): every native DB is an exact multiple of **4096 bytes** with a random high-entropy 16-byte salt prefix (no `SQLite format 3\0` header) → 4096-byte pages + per-DB 16-byte salt + raw 32-byte key used directly [live-appdata]. radare2 confirms **no** `cipher_version`/`kdf_iter`/`sqlcipher`/`PRAGMA key` markers, and `Sqlite::Open` (`0x1807326d9`) delegates to internal codec callees (`0x1808c29e0` et al.) (doc 96 §3). Only the exact page **cipher mode/HMAC variant** is still residual inside the statically-linked codec. |
| FTS tokenizer | `RegisterTokenizer`/`IsTokenizerRegistered` on native `Sqlite` (`Sqlite.cs:976`–`986`) | **Confirmed signature**; tokenizer logic is native. `CreateUserStatusesFtsTable` is empty in this build (`SqliteContactsContext.cs:519`). |
| DPAPI | `Windows.Security.Cryptography.DataProtection.DataProtectionProvider` (OS) | **Confirmed** (`ProtectionUtils.cs`). |
| PBKDF2 / AES-CBC | `Windows.Security.Cryptography.Core` (WinRT/OS) | **Confirmed** (`EncryptionUtils.cs`, `WhatsAppCryptoHelper.cs`). |
| CSPRNG | `Axolotl.GenerateRandomBytes` → `CryptographicBuffer.GenerateRandom` | **Confirmed** path (`EncryptionUtils.cs:20`); RNG itself is WinRT. |
| Publisher system id (PBKDF2 salt) | `Windows.System.Profile.SystemIdentification.GetSystemIdForPublisher().Id` | **Confirmed** (`EncryptionUtils.cs:53`). |

> **SQLite is statically linked into `WhatsAppNative.dll`, but no page-cipher banner exists.** `strings -n 6 x64/WhatsAppNative.dll` reveals SQLite's own internals — `sqlite_master`, `sqlite_sequence`, `wal_checkpoint`, `journal_mode`, `secure_delete`, `PRAGMA %Q.data_version`, and the VACUUM scaffolding (`INSERT INTO vacuum_db.sqlite_master SELECT*FROM "%w".sqlite_master …`) — confirming a bundled SQLite engine. However the same scan finds **no `sqlcipher` / `sqlite3_key` / `codec` / `kdf_iter` / `cipher_page` / `PRAGMA key` / boringssl markers whatsoever**, so the at-rest page cipher/KDF cannot be identified from strings (the only `AES_…HMAC_SHA1_…`/`codec_*` hits are VoIP SRTP/audio-video codec params, unrelated to DB-at-rest).
> **Correction to a round-1 claim: the page cipher is *not* CNG-backed.** Re-checked the import table directly [native-binary]: `objdump -p x64/WhatsAppNative.dll` shows the DLL imports from `bcrypt.dll` **only** `BCryptGenRandom`, `BCryptOpenAlgorithmProvider`, `BCryptCloseAlgorithmProvider` — i.e. **RNG only**. There is **no `BCryptEncrypt`/`BCryptDecrypt`/`BCryptDeriveKey…`/`BCryptHashData`/`BCryptKeyDerivation`** import. So the AES/HMAC/SHA used by the SQLite page codec (and by Signal/Noise) are **statically linked** inside the binary (SHA-1/256/512 all confirmed present via radare2, doc 96; BoringSSL-from-WebRTC is the likely provenance, no public symbol survives), *not* dynamically resolved against Windows CNG. (The page codec uses the raw 32-byte secret directly as the key — no passphrase PBKDF2 inside the codec; doc 96 §3.) The earlier "native crypto is backed by Windows CNG (`bcrypt.dll`)" wording overstated bcrypt's role — bcrypt supplies only entropy here. Other dynamic deps observed: `WhatsAppRust.dll` (wamedia, dynamic), `MFPlat.DLL`/`MFReadWrite.dll` (Media Foundation), `WS2_32.dll` (native Winsock), `d2d1`/`d3d11`/`dxgi`/`MMDevAPI` (render/audio).
> **Native codec located via radare2 (doc 96), not Ghidra.** The `ghidra-output/` exports are empty/unavailable (`WhatsAppNative-functions.txt` is 0 bytes; `WhatsAppRust-functions.txt` only has a PyGhidra error), but that is no longer the blocking tool: doc 96 mined `WhatsAppNative.dll` with `radare2`/`rabin2` and **statically located the SQLite codec**. `Sqlite::Open` is at `0x1807326d9` (found via the `.WAobs` name section) and delegates key/codec setup to internal callees (`0x1808c29e0` via the table at `0x1808d2340`); AES + HMAC (SHA-1/256/512) are statically present; **no** stock-SQLCipher markers exist, confirming a custom page codec (doc 96 §3). What remains unread is only the *instruction-level* page encrypt/decrypt callback (exact AES mode CTR-vs-CBC, HMAC variant, per-page IV/MAC layout) two-to-four callee levels deep — a deliberate stop, since a renderer-hosted port never replicates this codec (the Signal/app-state source of truth is the plaintext WebView IndexedDB, doc 94 §4 / doc 95).

## 5. Linux/Electron Port Mapping

| Windows piece | Electron/Node equivalent | Notes / risk |
|---|---|---|
| `WhatsAppNative.Sqlite` (encrypted SQLite engine) | **`better-sqlite3` built against SQLCipher**, or `@journeyapps/sqlcipher`, or `sql.js` (no encryption) | The on-disk DBs use a **custom AES+HMAC page codec (NOT stock SQLCipher)**: **4096-byte pages + per-DB 16-byte salt prefix + raw 32-byte key used directly** (live-confirmed, doc 94 §1/§2; `Sqlite::Open` codec located via radare2, doc 96 §3), keyed by the machine/user-bound chain of §3.7. Even with the structure known, reading *existing* Windows DBs offline is **infeasible** — the key chain roots in DPAPI (`LOCAL=user`) + `GetSystemIdForPublisher`, neither present in a copied app folder — and the exact page cipher mode/HMAC remain inside the statically-linked codec. For a clean reimplementation, pick any encrypted SQLite and define your own key schedule. **Better: don't port this layer at all** — a renderer-hosted WA-Web bundle keeps the real Signal/app-state in the plaintext WebView IndexedDB (doc 94 §4 / doc 95), so the native DBs are just a cache/mirror. **Risk: high** only if interop with existing on-disk native files is required (which it should not be). |
| WAL + `synchronous=FULL` + `secure_delete=ON` PRAGMAs | Same PRAGMAs on better-sqlite3 | Trivial; `Sqlite.cs:1253`–`1262` lists them verbatim. |
| `SQLiteBridge.ExecuteSqlite(JSON string[][])` | Keep the **same contract**: an Electron `ipcMain.handle('execute-sqlite', ...)` taking `string[][]`, returning `SqliteResult[]` | The waweb JS bundle expects exactly this host object (`window.chrome.webview.hostObjects.SQLiteBridge`). On Electron you must shim `hostObjects.SQLiteBridge.ExecuteSqlite` in the preload/contextBridge to forward to a better-sqlite3 worker. **Reuse the JS schema entirely** — it lives in the bundle, not native. |
| `SqliteDb.Execute` keyword classifier + result shape | Port `SqliteQueryUtil` (8 keyword checks) + `SqliteResult` JSON exactly | `LastInsertedRowId`/`RowsAffected`/`Rows`/`ColumnNames`/`Error` field names are load-bearing for the JS side. |
| `SqliteData`/`SqliteDataContext` ORM (typed stores) | Hand-written SQL or a light mapper (`drizzle`, `kysely`); the reflection ORM need not be ported faithfully | Only the **table schemas** matter (contacts v23, abprops v1, mediaDownloads v2, contactsState v1, session.db, settings KV). Re-create those `CREATE TABLE`s; the change-tracking machinery is a C# convenience. |
| DPAPI (`LOCAL=user`) | **`safeStorage`** (Electron, uses libsecret/kwallet/keychain) or `keytar` | DPAPI binds to the OS user; `safeStorage.encryptString/decryptString` is the closest Linux analogue (backed by the desktop keyring). **Gap**: no exact DPAPI equivalent; the static-key+DPAPI design becomes static-key+`safeStorage`. |
| PBKDF2-SHA256(10000) + AES-CBC | Node `crypto.pbkdf2`/`createCipheriv('aes-256-cbc')`, or `@noble/hashes` + `@noble/ciphers` | Direct. Salt source (`SystemIdForPublisher`) has **no Linux analogue** — substitute a stable per-install id (e.g. a random id stored in `safeStorage`, or `/etc/machine-id` + app salt). **Risk: medium** — changing the salt source breaks reading old DBs. |
| `SystemIdentification.GetSystemIdForPublisher()` | `machine-id` (`/etc/machine-id` / `/var/lib/dbus/machine-id`) or a generated app-scoped id | Not identical semantics; pick a stable, app-private value. |
| `sessions/{SHA1(ClientKey)}/` layout + wipe-inactive | `app.getPath('userData')/sessions/{sha1}/` with same single-account wipe | Use Node `fs`/`crypto.createHash('sha1')`. Straightforward. |
| Logout → `App.Restart(UserLogout)` | `app.relaunch(); app.exit()` | Direct. |
| Background checkpoint/integrity/optimize throttles | Node timers + better-sqlite3 `pragma('wal_checkpoint(TRUNCATE)')`, `pragma('integrity_check')`, `ANALYZE` | Port the intervals (passive 2h, truncate 12h, integrity 7d, optimize 24h) as desired. |
| `transfers/` media dir handle posted to WebView2 | Electron: expose a path or use a custom `protocol`/`file://` handler | The JS bundle expects a directory handle message (`PostWebMessageWithDirectory`); emulate via contextBridge. |

**Reusable from the waweb bundle**: the entire `genericStorage.db` schema, all queries, and the data model are JS — they can be reused unchanged provided the `SQLiteBridge.ExecuteSqlite` contract is reproduced. The native typed stores (contacts/abprops/media-downloads/session) are the only schemas that must be re-implemented natively.

**Key gaps/risks**:
1. The native SQLite cipher's page structure (4096 B pages + 16 B salt) and key chain are now known (doc 94), but its exact `kdf_iter`/HMAC stay opaque **and** the key chain is machine/user-bound (DPAPI + `GetSystemIdForPublisher`) → reading existing on-disk Windows DBs from Linux is infeasible regardless; a fresh-install reimplementation (or simply hosting the bundle so the plaintext IndexedDB is the store) is the safe path.
2. DPAPI and `SystemIdForPublisher` have no exact Linux equivalents → the whole key-derivation chain must be re-anchored on `safeStorage`/`machine-id`, which means old encrypted DBs become unreadable (acceptable for a new client).
3. The single-account-on-disk wipe is destructive; replicate carefully.

## 6. Open Questions / Unverified

Each item below was **re-investigated this session** against the decompiled C#, the native binaries (`strings`/`objdump` on `x64/WhatsAppNative.dll`), and the `waweb-source-bundle/` JS, and is now tagged with an explicit verdict; the original question text is preserved so the reader sees what was asked.

- **[PARTIAL] Native cipher mode inside `WhatsAppNative.Sqlite`** (was CANNOT; upgraded — page structure, full key chain, codec location, **and "custom-vs-stock-SQLCipher" all now resolved**; only the codec's exact internal AES mode/HMAC variant residual): *the codec was inferred only from the `byte[] secret` + `ChangeDbSecret` surface; the page-encryption algorithm, KDF, iteration count, and HMAC were not read.* **What is now RESOLVED (this session + doc 96 radare2 pass):** (1) **Page structure** [live-appdata — doc 94 §1/§2, re-verified on disk this session]: all seven native DBs are page-encrypted, every file an exact multiple of **4096 bytes** with a random high-entropy 16-byte salt prefix (no `SQLite format 3\0` header) → **4096-byte pages + per-DB 16-byte salt + raw 32-byte key used directly** (e.g. `session.db` = 4096 B, header `2f d7 b7 4e be a0 35 bc 17 ad 02 60 ca 83 8b de …`; `contacts.db` = 983×4096; `genericStorage.db` = 575×4096). (2) **Custom codec, NOT stock SQLCipher** [native-binary — doc 96 §3, radare2]: a scan for stock markers (`cipher_version`, `cipher_provider`, `kdf_iter`, `cipher_page_size`, `PRAGMA key`, `sqlcipher`) returns **nothing**, and `Sqlite::Open` is located at `0x1807326d9` (via the `.WAobs` name section) delegating key/codec setup to internal callees (`0x1808c29e0` via the table at `0x1808d2340`) — so the at-rest cipher is a **custom AES+HMAC page codec compiled into the SQLite build**, with the page key being the raw 32-byte secret used directly (no passphrase PBKDF2, since it is already random). (3) **The full key-derivation chain** for the secret each DB is opened with — DPAPI-wrapped `StaticKeyBytes` for `session.db`, PBKDF2-SHA256(ClientKey, salt=`GetSystemIdForPublisher`, 10000, 32B)-derived AES-CBC wrap for `nativeSettings.db`, and a random `SecureRandomBytes(32)` `LegacyDbSecret` for the five data DBs (`LoginSessionManager.cs:66/169-170/97-98`; folded into §3.7) — machine/user-bound, so the on-disk DBs are **not offline-decryptable** from an app-folder copy. (4) **Provider correction** [native-binary, re-verified via `objdump -p` + doc 96]: `WhatsAppNative.dll` imports from `bcrypt.dll` **only** `BCryptGenRandom`/`BCryptOpenAlgorithmProvider`/`BCryptCloseAlgorithmProvider` (RNG only) — **no** `BCryptEncrypt`/`BCryptDecrypt`/`BCryptDeriveKey…`/`BCryptHashData` — so the page-codec AES/HMAC/SHA (SHA-1/256/512 all statically present per doc 96) are **statically linked** (BoringSSL-from-WebRTC likely), *not* CNG (this corrects the round-1 §4 "CNG-backed" claim). `strings -n 6 x64/WhatsAppNative.dll` still shows SQLite internals (`sqlite_master`, `wal_checkpoint`, `secure_delete`, the VACUUM scaffolding — §4) and **no** SQLCipher banner (the `AES_CM_…HMAC_SHA1_…`/`codec_*` hits are VoIP SRTP/A-V codec params, unrelated to DB-at-rest; doc 96 §3 confirms the `AES-256 integer counter mode` string is libsrtp, **not** the DB codec). **What stays open (the reason this is PARTIAL not RESOLVED):** only the codec's *exact internal AES mode* (CTR vs CBC) and *HMAC variant / per-page IV-MAC layout* are unread — they sit 2–4 callee levels deep behind `0x1808c29e0` and require an `aaa` + multi-level trace through the stripped binary (doc 96 §5). **Cross-reference (DB-encryption family only — does NOT close the mode):** `research/external/whatsapp-msgstore-viewer` (ElDavoo's crypt14/15 decrypter) documents the WhatsApp **Android backup** crypto — whole-file AES-256-GCM (`decrypt14_15.py:397/466/528`) with an HMAC-SHA256 key loop over `"backup encryption"` (`:310`–`312`) — a **different** scheme from the Windows page-level live store; it only corroborates that WA's DB-at-rest crypto is AES-256 + HMAC-SHA256-flavoured. **Resolving artifact:** continue the doc 96 trace — `af @ 0x1808c29e0` then follow the per-page encrypt/decrypt callback that consumes the 16-byte salt + 32-byte key — to recover the exact AES mode/HMAC. *(Moot for a renderer-hosted port: the Signal/app-state source of truth is the plaintext WebView IndexedDB — doc 94 §4 / doc 95 — so a port need not reproduce this page cipher at all.)*

- **[RESOLVED] `genericStorage.db` schema** (was PARTIAL; upgraded via the beautified bundle, round 2): *owned by the JS bundle; not enumerated here.* The earlier PARTIAL hedge — "production data model is larger… not statically enumerable" — is now **disproven**. The beautified WA-Web bundle (`research/waweb-unmin/TSxMup…js`, the js-beautify expansion of the same `waweb-source-bundle` file) exposes the **complete** schema and a grep of the *entire ~1.1M-line bundle* for `CREATE TABLE`/`CREATE VIRTUAL TABLE` returns **only** `message` and `message_fts` (cross-reference: `research/waweb-unmin/*.js`). So `genericStorage.db` is **solely the message full-text-search sidecar**: one `message(rowid,id,chatId,timestamp,text)` base table, two indexes, the `message_fts` fts5 virtual table (`tokenize='unicode61'`, `prefix=2`), and three insert/delete/update sync triggers — created by the JS `initExternalStorage` method, wiped by `destroyExternalStorage`, and queried by `search()` via `message_fts MATCH ? … ORDER BY rank` (cross-reference: `research/waweb-unmin/TSxMup…js:204109`–`204161`). The full chat/contact/message data model is **not** in this DB at all — it lives in the JS-side IndexedDB; `genericStorage.db` exists only because IndexedDB has no full-text index, which is also why the native engine carries the `RegisterTokenizer`/`fts5` plumbing (§3.1/§4). The host-object contract is likewise confirmed: `e.hostObjects.SQLiteBridge` (32 binding sites, `research/waweb-unmin/U2j2EhR17gV.js:1548` et al.) with `ExecuteSqlite:["queries"]` / legacy `RequestExecuteSqlite`. Full schema folded into §3.3. (Label: open-bundle read, not native-binary — but the native client *hosts this exact bundle* in WebView2, so the schema it drives is authoritative for the Windows client.)

- **[RESOLVED] `UserStatus` / `ChatPicture` / `WaScheduledTask` column lists**: *`UserStatus` enumerated in §3.10.6; the other two `contacts.db` tables only partially cited.* Both remaining entity files were read this session and their full `[Column]`/`[Index]` maps folded into §3.10.6: `ChatPictures` (`WhatsApp.DataModels/WhatsApp.Data/ChatPicture.cs:6`–`263`: `ChatPictureId` PK, `Jid`, `WaPhotoId`, `LocalPhotoId`, `NotAvailable`, `ServerPhotoId`, `LastPictureCheck`, `BlockPictureRequestUntil`, `PictureData`/`ThumbnailData` BLOB `[Sensitive]`, two obsolete bool cols; unique `ChatPicture_Jid`) and `WaScheduledTasks` (`WaScheduledTask.cs:5`–`213`: `TaskID` PK, `TaskType`, `LookupKey`, `DbJid`, `BinaryData`, `Attempts`, `AttemptsLimit`, `ExpirationUtc`, `Restriction`; index `WaScheduledTask_TaskType_LookupKey`; `Types` enum 1–8/1001–1002). Non-`[Column]` members in both are now identified as non-persisted.

- **[CANNOT RESOLVE STATICALLY] Contact notification-hash algorithm**: *the `JidNotificationHash`/`LidNotificationHash` columns and lookup query are confirmed, but `GetNotificationHash` is a literal-prefix stub.* Re-read in full: `ContactNotificationHashProcessor.GetNotificationHash` returns exactly `"NOTIFICATION_HASH_" + userJid.ToString()` (`WhatsApp.VoIP/WhatsApp/ContactNotificationHashProcessor.cs:5`–`8`) — confirmed it is the *only* implementation in the C# dump. Searched the waweb bundle: the `…NotificationHash` hits there are unrelated (`handleVerifiedBusinessNameNotificationHash` / `handleBusinessRemovalNotificationHash` business-name flows), not the per-contact JID/LID hash. **Round-2 re-check (beautified bundle + open impls):** the beautified bundle has the same single business-only hit (`research/waweb-unmin/xTiXmyjNEd_.js:130023` `handleBusinessRemovalNotificationHash`), and a grep of **both** open WA-protocol implementations — whatsmeow (`research/external/whatsmeow/`) and Baileys (`research/external/Baileys/src/`) — finds **no contact JID/LID notification-hash construction at all**. This corroborates the read that the per-contact notification-hash is a **server-keyed usync construct** computed server-side and matched on the client only via the opaque value (the `GetUsersMatchingJidHashNotInDevice` lookup, §3.10.5); no open client re-derives it, and the native build ships only the `"NOTIFICATION_HASH_" + jid` stub. So the real keyed hash is genuinely absent from every available client-side artifact. **Final-pass live-data check (does NOT resolve, but tightens the conclusion):** the decoded WebView2 IndexedDB (doc 95, `model-storage` 103 stores) carries the LID/identity stores (`lid-pn-mapping`, `lid-display-name-mapping`, `contact`, `device-list`, `verified-business-name`) but **no store that holds a client-derived per-contact JID/LID notification-hash** — consistent with the hash being a transient server-side usync match value that is never persisted or re-derived on the client. Re-confirmed this session that `GetNotificationHash` is byte-for-byte the `"NOTIFICATION_HASH_" + userJid.ToString()` stub and the **only** implementation in the C# dump (`ContactNotificationHashProcessor.cs:5`–`8`) [decompiled-C#]. Stays CANNOT (body-confirmed stub + cross-ref open impls lack it + live IndexedDB has no client-side hash store). **Resolving artifact:** the production (non-debug) build of `WhatsApp.VoIP`, or native disassembly if the real hash moved into `WhatsAppNative`, or a live capture of a `usync` notification-hash stanza.

- **[RESOLVED] `ContactsManager.RemoveContacts`**: *deletion path wired through `UpdateContacts` but body empty — does deletion happen elsewhere?* Confirmed: the method body is **genuinely empty** (`WhatsApp.Root/WhatsApp/ContactsManager.cs:293`–`295` — `private void RemoveContacts(string[] removed) { }`), called from one site only (`:209`, inside `UpdateContacts`), and a repo-wide `grep -rn "RemoveContacts"` over `decompiled/` returns exactly those two lines (declaration + call) and nothing else. So in this build the `removedIds` are accepted and dropped: removed contacts are **not** deleted from `contacts.db` by the bridge, and no alternate deletion site exists in the dump. (`StoreState` still mirrors id state into `contactsState.db`, but the `UserStatuses` row is not purged.) This is a real no-op in the shipped code, not a decompiler artifact — folded as a confirmed fact; a port should decide whether to implement the deletion that this build omits.

- **[RESOLVED] `EnsureFixedSecretSize` short-secret branch**: *`secret.CopyTo(secret, 0)` looks like a bug; behavior on a <32-byte secret unverified.* Read in full (`WhatsApp.LoginSession/LoginSessionManager.cs:206`–`223`): the `< 32` branch allocates `byte[] result = new byte[32]` then executes `secret.CopyTo(secret, 0)` — i.e. it copies `secret` **onto itself** and never writes into `result`, so `result` is returned as **all-zero**. This is a confirmed bug. In production it is unreachable because DPAPI `ProtectBytes` output and the 32-byte random `EncryptBytes` output are always ≥32 bytes, so the `>= 32` `SubArray(0,32)` branch always runs. Verdict is RESOLVED on the *code behavior* (the bug exists and the zero-fill result is what a <32-byte input would produce); it remains a latent defect, not an open question. A port should simply pad-or-truncate correctly (`result` = right-padded copy).

- **[PARTIAL] `SqliteSecretManager` ALPHA behavior**: *a stub in this non-ALPHA build; do ALPHA builds add an encryption toggle that changes key handling?* Read in full (`WhatsApp.VoIP/WhatsApp/SqliteSecretManager.cs`): `ToggleEncryption()` is both `[Conditional("ALPHA")]` **and has an empty body**, `GetSecret()` returns `Array.Empty<byte>()`, `IsSecretGeneratedDuringCurrentAppSession` is a private-set bool defaulting false. So even *with* the `ALPHA` symbol defined, the compiled method does nothing in *this* source — there is no encryption-toggle logic present to change key handling. PARTIAL (not RESOLVED) only because whether a *different* ALPHA source tree fills that body cannot be determined from this dump; in the shipped assembly it is inert and the real keys come from the controllers in §3.6/§3.7. **Round-2 re-check:** this is a native C# build-configuration artifact with no protocol analogue — the open implementations (whatsmeow, Baileys) and the WA-Web bundle have **no `SecretManager`/`ToggleEncryption`/`IsSecretGenerated` symbol** (grep over all three re-run this session returns nothing), as expected, so no cross-reference resource can speak to ALPHA-only key handling. **Final-pass live-appdata confirmation of the *shipping* behaviour** [live-appdata — doc 94 §2]: the real on-disk dump proves the ALPHA path is **inert in the build that wrote it** — `SqliteSecretManager.GetSecret()` returns `Array.Empty<byte>()` and `ToggleEncryption()` is `[Conditional("ALPHA")]`, while the live DBs are all keyed by the §3.6/§3.7 chain (DPAPI-`session.db` → ClientKey-wrapped `nativeSettings.db` → random `LegacyDbSecret` for the data DBs). So for the production channel this is settled: no alternate secret-manager key path is in effect. It stays **PARTIAL** strictly because the original question — *whether a separate ALPHA source tree fills `ToggleEncryption`'s body and changes key handling* — still cannot be answered from this (non-ALPHA) dump; the live evidence speaks only to the shipping build. **Resolving artifact:** an ALPHA-channel build of `WhatsApp.VoIP`.

- **[RESOLVED] Re-key timing of typed stores**: *`LegacyDbSecret` regenerated on each `Login`; do already-open typed stores call `ChangeDbSecret` or reopen? (traced only for `contacts.db`.)* Now traced end-to-end for **all** typed stores: the pattern is uniformly **reopen, not in-place re-key**, because each store subscribes to `OnLogin` and *constructs a new store object* with a secret closure that reads the current `SettingsKey.LegacyDbSecret`. Confirmed sites: `abprops.db` (`AbPropsRoot.cs:44` `OnLogin…Subscribe(Initialize)` → `:60`–`61` `_database = new SqliteAbProps(…, () => _settings.Read(SettingsKey.LegacyDbSecret))`), `mediaDownloads.db` (`MediaFilesService.cs:69` `OnLogin…Subscribe(Initialize)` → `:86`–`87` `_downloadsDb = new SqliteMediaFilesStorage(…, () => _settings.Read(SettingsKey.LegacyDbSecret))`), and `contacts.db` (`ContactsContext` `OnLogin → Reset(force:true)` then `GetInstance()`, §3.9.4). `ChangeDbSecret` is exposed (§3.1/§3.4) but is **not** used on the login path for any of these stores. Folded into §3.5.

- **[PARTIAL] `ContactsContext.Events` publishers/subscribers**: *three Rx subjects declared but no `.OnNext`/`.Subscribe` call sites survive in the decompiled C#.* Re-confirmed: `grep -rn "UserStatusUpdatedSubject\|ChangeNumberActionSubject\|BlockListUpdateSubject"` over `decompiled/**` still returns **only the three declarations** (`WhatsApp.Data/ContactsContext.cs:54`–`61`) — zero publish or subscribe sites. The payload types are fully read (`DbDataUpdate{UpdateType, UpdatedObj, ModifiedColumns}`, `ChangeNumberAction{OldJid,NewJid,ActionType}`, block-list `IReadOnlyList<UserJid>` — §3.9.5), so the *contract* is RESOLVED but the *emit points / subscriber threading* are not, hence PARTIAL. The emit sites (contact-sync / block-list / change-number handlers) and UI subscribers were inlined or dropped by the decompiler. **Round-2 re-check:** this is a native-side Rx wiring detail with no cross-reference value — the open implementations model contact/state changes with their own event architectures (Go `Client.dispatchEvent`, Baileys `ev.emit`) that bear no byte-for-byte relation to these three named `Subject<T>` streams, so they cannot recover the *native* emit points. **Final-pass re-confirmation:** re-grepped this session — `UserStatusUpdatedSubject`/`ChangeNumberActionSubject`/`BlockListUpdateSubject` still match **only** the three declarations at `WhatsApp.Data/ContactsContext.cs:56/58/60` with **zero** `.OnNext`/`.Subscribe` sites anywhere in `decompiled/**` (other `*Subject.OnNext` hits in the dump belong to unrelated streams — `NotificationsManager._notificationActionSubject`, `Conversation.DraftUpdatedSubject` — not these three) [decompiled-C#]. The live appdata/IndexedDB has nothing to say about native in-process Rx wiring, so no final-pass artifact bears on it. The payload contract (§3.9.5) remains the load-bearing fact for a port; the trigger sites do not. Stays PARTIAL. **Resolving artifact:** a less-aggressively-optimized decompile (or the original source) of `WhatsApp.VoIP`/the UI assemblies to locate the `.OnNext`/`.Subscribe` sites.
