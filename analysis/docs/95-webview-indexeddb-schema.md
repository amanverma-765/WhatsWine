# 95. WhatsApp Web IndexedDB Schema (live, decoded)

> Authoritative data model of the WhatsApp Web layer the native client hosts, decoded from the live `appdata_dump` with `dfindexeddb` (Chromium IndexedDB parser). This is the persistence layer a Linux/Electron port inherits **for free** when it loads the WA-Web bundle in the renderer. Full machine-readable dump: `research/idb_schema.txt`.

## 1. Databases (13)

| id | database | purpose |
|----|----------|---------|
| 1 | **`wawc`** | app core: `logs`, `wam`/`wam_meta`/`core_wam`/`core_wam_meta`/`worker_wam_events` (WAM analytics), `l10n`, `user`, `ps_meta`/`ps_tokens` |
| 2 | `pb_detect` | (probe/detection) |
| 3 | **`model-storage`** | the domain model — 103 object stores (§3) |
| 4 | `fts-storage` | full-text search: `manifest`, `fts-purge-range-queue`, `fts-v3-index` |
| 5 | `jobs-storage` | `jobs-store` (background job queue) |
| 6 | `lru-media-storage-idb` | media cache: `lru-media-array-buffer`, `lru-media-meta-info` |
| 7 | `offd-storage` | offline delivery: `dangling-receipt`, `peer-read-receipt`, `pending-device-sync` |
| 8 | **`signal-storage`** | libsignal store (§2) |
| 9 | `status-storage` | `status` (Status/stories) |
| 10 | `sw` | service-worker scratch |
| 11 | **`wawc_db_enc`** | `keys`, `fts_hmac_keys` — the **web-layer DB-encryption keys** (derived from `ServerEncKeySalt`, doc 21) |
| 12 | `worker-storage` | `local_storage`, `deferred_messages` |
| 13 | `guest-events-storage` | guest/unauth events |

## 2. `signal-storage` — the E2E key store (resolves doc 20)

| store | holds |
|-------|-------|
| `identity-store` | the device identity keypair + peers' identity keys |
| `signal-meta-store` | registration id, next prekey ids, misc signal metadata |
| `prekey-store` | one-time prekeys |
| `signed-prekey-store` | signed prekeys (+ signature) |
| `session-store` | per-address Double-Ratchet sessions |
| `senderkey-store` | group sender keys (for `skmsg`) |
| `baseKey-store` | base keys (session bootstrap) |

This is exactly the libsignal store set (cf. Baileys `signal-storage`, whatsmeow `store`). A port reuses it verbatim via the bundle; a headless Node port maps each to a table.

## 3. `model-storage` — 103 stores (resolves docs 21, 33; data model for 31/32)

Grouped (full list in `research/idb_schema.txt`):

- **Messaging:** `chat`, `message`, `message-info`, `message-association`, `message-history`, `message-orphans`, `peer-message`, `participant`, `reactions`, `comments`, `pinned-messages`, `addons-unified`, `self-addon-message-type`, `poll-votes`, `event-responses`, `premium-message`, `scheduled-msg-reveal-key`, `scheduled-msg-orphan-reveal-key`.
- **App-state / SyncD (doc 33):** `pending-mutations`, `collection-version`, `sync-actions`, `sync-keys`, `encrypted-mutations`, `syncd-logs`, `missing-keys`, `active-message-ranges`, `user-prefs`. *(The five collections `critical_block` / `critical_unblock_low` / `regular` / `regular_high` / `regular_low` are the `collection-version` keys — live-confirmed.)*
- **Contacts / identity / LID (doc 21):** `contact`, `out-contact`, `blocklist`, `profile-pic-thumb`, `device-list`, `verified-business-name`, `business-profile`, `bot-profile`, `agent`, `member-label`, `optoutlist`, **`lid-pn-mapping`**, **`lid-display-name-mapping`**, **`lid-chat-state`**.
- **Tokens / keys:** `acs-tokens`, **`direct-connection-keys`**, `reporting-token`, `ghs-reporting-token-info`, `reporting-info`, `webtp-shared-session`, `account-linking`, `data-sharing-3pd-lid`(`-v2`), `download-3pd-signals`, **`orphan-tc-token`** (the tc-token store, doc 21).
- **Receipts / delivery:** `orphan-receipt`, `inactive-receipt`, `orphan-payment-notification`, `orphan-revoke`, `history-sync-notification`, `non-message-data-request`.
- **Groups / newsletters / broadcast:** `group-metadata`, `group-invite-v4`, `unjoined-subgroup-metadata`, `subgroup-suggestion`(`-v2`), `group-member-changes`, `group-history-participant`, `pending-membership-approval-request`, `newsletter-metadata`, `newsletter-reactions`, `newsletter-my-votes`, `newsletter-polls-votes`, `pending-business-broadcast`(`-message`), `business-broadcast-campaigns`, `biz-broadcast-campaigns`, `biz-broadcast-insights`, `broadcast-metadata`, `status-crossposting`.
- **Media / stickers:** `recent-stickers`, `favorite-stickers`, `sticker-download`, `media-playback-event`.
- **Business / commerce / labels:** `label`, `label-association`, `quick-reply`, `cart`, `customerData2`, `subscription`, `subscriptionFeatureFlag`, `quarantine-data`.
- **Config / UI / misc:** `abpropConfigs`, `abpropGroupConfigs`, `abprop-event-sampling-configs`, `in-app-banner`, `quick-promotions`, `ctwa-suggestion`, `chat-assignment`, `chat-thread-logging-pending-events`, `tasks-scheduled-time`, `fts-indexing-queue`, `note`, `favorite`, `thread-metadata`, `privacy-disallowed-list`.

## 4. Linux/Electron port mapping

- A renderer-hosted WA-Web bundle **creates and uses all of the above automatically** — the port needs zero schema work for the happy path; Chromium's IndexedDB in Electron is the store.
- For a **headless / Node-side mirror** (background connection, native notifications), replicate at minimum: `signal-storage.*` (Signal state), `model-storage.{collection-version,sync-keys,pending-mutations,sync-actions,encrypted-mutations}` (app-state), `model-storage.{chat,message,contact,participant,group-metadata,lid-pn-mapping}` (UI data), and `wawc_db_enc.keys` (at-rest key). Baileys/whatsmeow already implement equivalent stores.
- **LID is first-class**: `lid-pn-mapping` + `lid-display-name-mapping` + `lid-chat-state` confirm the port must carry the phone↔LID map and render LID identities.
- **At rest** these IndexedDB files are **plaintext** on disk (see doc 94 §3) — the port should protect the Electron `userData` dir (and optionally encrypt via `safeStorage`), because anyone with file read access has the keys.

## 5. Cross-references
Resolves/confirms: doc 20 (signal store set), doc 21 (LID stores, tc-token store, ClientKey), doc 33 (SyncD collections + stores), doc 31/32 (web-layer storage & `wawc_db_enc` keys). Companion: doc 94 (at-rest encryption + forensics). Evidence: `research/idb_full.jsonl`, `research/idb_schema.txt`.
