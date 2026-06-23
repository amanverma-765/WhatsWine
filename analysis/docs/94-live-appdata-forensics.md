# 94. Live AppData Forensics — On-Disk State of the Native Windows Client

> Source: a live `appdata_dump.zip` (the packaged app's AppData tree, `5319275A.WhatsAppDesktop_cv1g1gvanyjgm/`) captured from a running install. This doc records what the real on-disk state proves about storage and at-rest encryption, and resolves the residual SQLite-cipher questions from docs 32/33/21/92.
>
> **Privacy:** real account identifiers and key bytes are intentionally redacted here (`<msisdn>`, `<lid>`, `bytes[N]`). This documents *mechanism*, not personal data.

## 1. Storage layout (confirmed on disk)

```
5319275A.WhatsAppDesktop_cv1g1gvanyjgm/
├─ LocalState/
│  ├─ session.db                      ← keystore: ClientKey(=Noise static priv), ServerEncKeySalt
│  └─ sessions/<sessionHash>/
│     ├─ nativeSettings.db            ← holds LegacyDbSecret (+ native settings)
│     ├─ abprops.db                   ← live A/B (AbProps) values
│     ├─ contacts.db / contactsState.db
│     ├─ genericStorage.db            ← native generic KV
│     └─ mediaDownloads.db
├─ Settings/settings.dat              ← UWP LocalSettings registry hive
└─ LocalCache/EBWebView/Default/
   ├─ IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/   ← THE web app's real state (plaintext)
   └─ Local Storage/leveldb/                                  ← localStorage (config flags)
```

This confirms the per-session-folder model from doc 32 (`<sessionHash>` = the active login; `WipeInactiveSessionFolders` deletes the rest — `LoginSessionManager.cs:113-135`).

## 2. Native at-rest encryption — FULLY RESOLVED key chain

**All seven native DBs are page-encrypted** (none begins with `SQLite format 3\0`; headers are high-entropy). Every file is an exact multiple of **4096 bytes** with a random 16-byte prefix → a **custom AES+HMAC page codec: 4096-byte pages + per-DB 16-byte salt** — *not* stock SQLCipher. There is no `cipher_version`/`kdf_iter`/`PRAGMA key` marker anywhere in the files or in `WhatsAppNative.dll`; `Sqlite::Open` (`0x1807326d9`) delegates to internal codec callees that take the raw 32-byte key directly, with no SQLCipher KDF preamble (doc 96). The exact AES mode and HMAC variant inside the codec remain unread — see §5 (moot for the port).

The secret each DB is opened with is now traced end-to-end in C# (`WhatsApp.VoIP/WhatsApp.LoginSession/LoginSessionManager.cs`):

| DB | Page-cipher secret | Binding |
|----|--------------------|---------|
| `session.db` | `EnsureFixedSecretSize(ProtectionUtils.ProtectBytes(StaticKeyBytes))` (`:66`) | **Windows DPAPI** `DataProtectionProvider("LOCAL=user")` (`ProtectionUtils.cs:18`) over a hardcoded 16-byte `StaticKeyBytes` (`:28-32` = `23 a7 f1 9c 11 e5 bd 78 42 35 c9 6f 85 d2 49 13`). User-bound. |
| `nativeSettings.db` | `EnsureFixedSecretSize(EncryptionUtils.EncryptBytes(ClientKey, StaticKeyBytes))` (`:169-170`) | **Machine-bound**: `EncryptBytes` = AES-CBC-PKCS7 with key = `PBKDF2-SHA256(password=ClientKey, salt=SystemIdentification.GetSystemIdForPublisher(), 10000 iters, 32 B)`, IV PBKDF2-derived (`EncryptionUtils.cs`). |
| `contacts.db`, `contactsState.db`, `abprops.db`, `genericStorage.db`, `mediaDownloads.db` | `LegacyDbSecret` | **`EncryptionUtils.SecureRandomBytes(32)`** generated at `Login` and written into `nativeSettings.db` (`:97-98`); read back via `_settings.Read(SettingsKey.LegacyDbSecret)` (e.g. `AbPropsRoot.cs:61`, `ContactsContext.cs:238`). |

**Consequence for offline analysis:** the chain roots in two machine/user-bound secrets — DPAPI `LOCAL=user` (needs the user's Windows DPAPI master key) and `GetSystemIdForPublisher()` (a per-device hardware ID). **Neither is present in an app-folder dump, so the native DBs cannot be decrypted offline from this artifact alone.** This matches and refines doc 32: the at-rest scheme is a custom AES+HMAC page codec (not stock SQLCipher; doc 96), defended primarily by *machine binding*, not by a recoverable in-package key.

`SqliteSecretManager.GetSecret()` returns `Array.Empty<byte>()` and `ToggleEncryption()` is `[Conditional("ALPHA")]` — the alternate/ALPHA encryption path is inert in shipping builds; the live path is the table above.

## 3. The WebView2 IndexedDB — the real state, in PLAINTEXT

`LocalCache/EBWebView/Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/` is ~29 MB of **Chromium LevelDB, unencrypted at rest**. It is the authoritative WhatsApp-Web state the bundle persists. Object stores / key patterns observed directly in the dump:

- **`signal-storage`** — the libsignal store: `identity`, `prekey`/`signed-prekey`, `session-*`. (Identity keypair, registration id, one-time + signed prekeys, per-address sessions.)
- **`noise`** — the Noise static keypair. The private half **is the `ClientKey`** the native side persists (doc 21): JS does `getClientKeyBridge().setClientKey(b64(getNoiseInfo().staticKeyPair.privKey))`.
- **`senderKey`** — group sender-key state (sender-key distribution for `skmsg`).
- **`model-storage`** — chats/contacts keyed by JID, both legacy `<msisdn>@c.us` **and** `<id>@lid`. The dump shows heavy **LID** usage (the privacy identifier), confirming the phone↔LID duality from doc 21/32 (`PhoneNumberToLIDMapping`, `JidNotificationHash`/`LidNotificationHash`).
- **App-state (SyncD) collections live on disk** — all five canonical collections present: **`critical_block`, `critical_unblock_low`, `regular`, `regular_high`, `regular_low`** (matches whatsmeow `appstate` constants; corroborates doc 33's SyncD/LTHash analysis with real data).
- `companion`, `wawc`, `app_state` markers also present.

**Security implication (and the key insight for the port):** the native page-encrypted DBs are a *cache/mirror*; the cryptographic source of truth (identity keys, prekeys, sessions, sender keys, Noise key, app-state) lives **in plaintext** in the WebView2 IndexedDB, exactly as in browser WhatsApp Web. So the machine-bound custom page codec adds little confidentiality beyond OS file ACLs — anyone with read access to `LocalCache/EBWebView` already has the keys.

## 4. Linux/Electron port mapping

- **Do NOT replicate the native custom-codec chain.** It exists only because the native shell mirrors data outside the web sandbox. An Electron port that hosts the WA-Web bundle in the renderer gets the *same* IndexedDB-backed Signal store for free — the renderer's Chromium IndexedDB is the store. No `WhatsAppNative.Sqlite`, no DPAPI, no `SystemIdForPublisher` needed.
- If you want a native mirror (for a Node-side headless connection), use plain **`better-sqlite3`** (optionally `@journeyapps/sqlcipher` if you want at-rest encryption) with an app-managed key in the OS keychain (libsecret/`safeStorage`). The Windows machine-binding scheme is not portable and not worth porting.
- **App-state**: implement the five collections + LTHash exactly as doc 33 (whatsmeow `appstate`/`lthash`, Baileys `Utils/lt-hash.ts`).
- **LID**: the port must handle `@lid` as a first-class JID alongside `@c.us`/`@s.whatsapp.net` and maintain the phone↔LID map (live data confirms LID is now dominant).

## 5. Residual / not closed by this artifact

- **Exact native page-codec internals** (AES mode, HMAC algorithm, how the 16-byte salt is consumed) — page size (4096) and the salt-prefix layout are confirmed from the files, and the codec is confirmed *custom* (raw 32-byte key, no SQLCipher KDF preamble; doc 96). The instruction-level AES/HMAC body inside `WhatsAppNative.dll` is still unread. *(Moot for a port per §4.)*
- **Decrypting the native DBs** (`abprops.db` live A/B values, native `contacts.db`) is blocked offline by the machine-bound chain (§2). It would require running on the original Windows machine (where DPAPI + `GetSystemIdForPublisher` resolve), or also capturing the user's DPAPI master key. The same information is otherwise available in plaintext from the IndexedDB (§3).

## 6. Cross-references

Resolves/upgrades: doc 32 (SQLite cipher + key chain), doc 33 (SyncD collections — now live-confirmed), doc 21 (ClientKey = Noise static priv; LID; ServerEncKeySalt), doc 31 (WebView2 storage), doc 92 (native cipher). Evidence files: `research/appdata/` (extracted), `research/idb_records.txt` / strings scans. Source citations: `WhatsApp.VoIP/WhatsApp.LoginSession/LoginSessionManager.cs`, `WhatsApp.VoIP/WhatsApp.Encryption/{ProtectionUtils,EncryptionUtils}.cs`.
