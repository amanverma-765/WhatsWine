// Data bridges: contacts ledger, WAM telemetry, A/B feature props, TC token.
// Method names follow CsWinRT camelCase lowercasing (PascalCase first letter → lower).
// Async-classification: methods ending /Async$|AsyncWithSpeller$/ are forced to
// Promises by the proxy; UpdateContacts and ReceiveFrequentContacts are Promises by
// C# IAsyncAction return type (plain names) — implemented as async here so the
// host-object shim can detect and await them (doc 31 §3.9 / catalog §sync-vs-async).

import type { BridgeFactory, BridgeContext } from '../types';
import { toWeb } from '../eventtarget';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Normalise legacy @c.us JIDs → @s.whatsapp.net (catalog DTO quirk note). */
function normaliseJid(jid: string): string {
  return jid.endsWith('@c.us') ? jid.slice(0, -4) + 's.whatsapp.net' : jid;
}

// ── ContactsBridge / PopulatedContactsBridge ──────────────────────────────────
// Same C# object (`ContactsManager`) registered under one of two names chosen by
// `IsInitiallySynced` at launch (`AppModel.cs:238`).  Both names share this factory.
//
// ponytail: no Evolution Data Server (EDS) or libsecret OS address-book integration
//   on Linux — the sqlite store IS the contact list here.  Upgrade path: query EDS
//   via DBus (org.gnome.evolution.dataserver.AddressBook1) and upsert into the same
//   contacts table, then fire requestUpdate with the fresh JID list.
function contactsBridgeImpl(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();

  const db = () => {
    const d = ctx.nativeDb();
    d.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        jid   TEXT PRIMARY KEY,
        json  TEXT NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS frequent_contacts (
        jid TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS contacts_meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )
    `);
    return d;
  };

  return {
    subscribe: tw.subscribe,

    // Flips the durable IsInitiallySynced flag → next launch registers as
    // PopulatedContactsBridge (catalog §ContactsBridge/PopulatedContactsBridge).
    acknowledgeInitialSync: () => {
      db()
        .prepare(
          "INSERT INTO contacts_meta(k,v) VALUES('initialSynced','1')" +
          " ON CONFLICT(k) DO UPDATE SET v='1'",
        )
        .run();
    },

    // JS marks the listed JIDs dirty; native would re-request them on next sync.
    invalidateContacts: (ids: unknown) => {
      const jids = Array.isArray(ids) ? (ids as string[]) : [];
      const d = db();
      const stmt = d.prepare('UPDATE contacts SET dirty=1 WHERE jid=?');
      d.transaction(() => {
        for (const id of jids) stmt.run(normaliseJid(String(id)));
      })();
    },

    // Async by C# IAsyncAction return type, plain name (catalog §sync-vs-async).
    // removedIds is a structural no-op per catalog ("RemoveContacts empty no-op, upsert-only").
    updateContacts: async (_removedIds: unknown, jsonArray: unknown): Promise<void> => {
      let contacts: Array<Record<string, unknown>> = [];
      try { contacts = JSON.parse(String(jsonArray ?? '[]')); } catch { /* malformed */ }
      const d = db();
      const upsert = d.prepare(
        'INSERT INTO contacts(jid,json,dirty) VALUES(?,?,0)' +
        ' ON CONFLICT(jid) DO UPDATE SET json=excluded.json, dirty=0',
      );
      d.transaction(() => {
        for (const c of contacts) {
          const raw = String((c['id'] ?? c['jid'] ?? '') as string);
          if (!raw) continue;
          upsert.run(normaliseJid(raw), JSON.stringify(c));
        }
      })();
      ctx.log('contacts: upserted', contacts.length);
    },

    // Async by C# IAsyncAction return type, plain name (catalog §sync-vs-async).
    // jsonArray = JSON-encoded string[] of JIDs (frequent contacts list from JS).
    receiveFrequentContacts: async (jsonArray: unknown): Promise<void> => {
      let jids: string[] = [];
      try { jids = JSON.parse(String(jsonArray ?? '[]')); } catch { /* malformed */ }
      const d = db();
      d.exec('DELETE FROM frequent_contacts');
      const ins = d.prepare('INSERT OR IGNORE INTO frequent_contacts(jid) VALUES(?)');
      d.transaction(() => {
        for (const jid of jids) ins.run(normaliseJid(String(jid)));
      })();
      ctx.log('contacts: frequent', jids.length);
    },
  };
}

// ── WamBridge ─────────────────────────────────────────────────────────────────
// Telemetry channel.  Native buffers WAM (Fieldstats) events and pushes them to
// JS via notifyEventsSaved; JS uploads to Meta's endpoint.
// On subscribe, native replays the full queued backlog (WamController.cs:76-85).
//
// ponytail: no native WamWriter/WamGlobalBuffer on Linux — events only originate
//   from JS subsystems or won't exist at all.  The sqlite table is a durable log so
//   nothing is silently dropped if a subscriber hasn't attached yet; on the first
//   real subscribe the table will typically be empty.  To inject events from main-
//   process native subsystems (if added later), write rows into `wam_events` and
//   call tw.call('notifyEventsSaved', json) directly.
function wamBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();

  const db = () => {
    const d = ctx.nativeDb();
    d.exec(
      'CREATE TABLE IF NOT EXISTS wam_events' +
      ' (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0)',
    );
    return d;
  };

  return {
    subscribe: (web: unknown) => {
      tw.subscribe(web);
      // Replay queued event backlog to the new subscriber.
      const rows = db()
        .prepare('SELECT payload FROM wam_events ORDER BY id')
        .all() as { payload: string }[];
      if (rows.length === 0) return;
      const batch = rows
        .map(r => { try { return JSON.parse(r.payload) as unknown; } catch { return null; } })
        .filter((x): x is unknown => x !== null);
      ctx.log('wam: replaying', batch.length, 'queued events');
      tw.call('notifyEventsSaved', JSON.stringify(batch));
    },
  };
}

// ── AbPropsBridge ─────────────────────────────────────────────────────────────
// A/B feature-flag typed cache + durable exposure ledger.
// JS is the value source (pushes via setConfigs); native is the cache + exposure log.
// On subscribe, un-acked exposures are replayed (AbPropsRoot.cs Subscribe behaviour).
// Unknown props implicitly return undefined / falsy (ignoreMemberNotFoundError=true
// means the bundle never throws on missing keys — we never need to fabricate defaults).
function abPropsBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();
  let currentVersion = '';

  const db = () => {
    const d = ctx.nativeDb();
    d.exec(`
      CREATE TABLE IF NOT EXISTS abprops (
        config_code  INTEGER PRIMARY KEY,
        config_value TEXT,
        expo_key     TEXT
      );
      CREATE TABLE IF NOT EXISTS abprops_exposure (
        expo_key TEXT PRIMARY KEY,
        acked    INTEGER NOT NULL DEFAULT 0
      )
    `);
    return d;
  };

  return {
    // On subscribe, replay every un-acked exposure key (AbPropsRoot.cs §Subscribe).
    subscribe: (web: unknown) => {
      tw.subscribe(web);
      const rows = db()
        .prepare('SELECT expo_key FROM abprops_exposure WHERE acked=0')
        .all() as { expo_key: string }[];
      for (const row of rows) tw.call('notifyExposureLogged', row.expo_key);
    },

    // Returns the config-hash version string last set by JS.
    getVersion: () => currentVersion,

    // Payload: JSON array of { configCode: int, configValue?: any, configExpoKey?: string }.
    // Stores the typed cache and logs any exposure keys via notifyExposureLogged.
    setConfigs: (ver: unknown, jsonConfigs: unknown) => {
      currentVersion = String(ver ?? '');
      let configs: Array<{ configCode?: number; configValue?: unknown; configExpoKey?: string }> = [];
      try { configs = JSON.parse(String(jsonConfigs ?? '[]')); } catch { /* malformed */ }

      const d = db();
      const upsertProp = d.prepare(
        'INSERT INTO abprops(config_code,config_value,expo_key) VALUES(?,?,?)' +
        ' ON CONFLICT(config_code) DO UPDATE SET config_value=excluded.config_value, expo_key=excluded.expo_key',
      );
      const logExpo = d.prepare(
        'INSERT OR IGNORE INTO abprops_exposure(expo_key,acked) VALUES(?,0)',
      );

      d.transaction(() => {
        for (const cfg of configs) {
          const code = Number(cfg.configCode ?? 0);
          const val  = cfg.configValue !== undefined ? JSON.stringify(cfg.configValue) : null;
          const expo = cfg.configExpoKey ?? null;
          upsertProp.run(code, val, expo);
          if (expo) {
            logExpo.run(expo);
            tw.call('notifyExposureLogged', expo);
          }
        }
      })();
      ctx.log('abprops: set', configs.length, 'configs, version', currentVersion);
    },

    // JS acknowledges receipt of an exposure notification → mark acked in ledger.
    acknowledgeExposure: (key: unknown) => {
      db()
        .prepare(
          'INSERT INTO abprops_exposure(expo_key,acked) VALUES(?,1)' +
          ' ON CONFLICT(expo_key) DO UPDATE SET acked=1',
        )
        .run(String(key ?? ''));
    },
  };
}

// ── TcTokenBridge ─────────────────────────────────────────────────────────────
// Trusted-contact token cache for native VoIP/presence path.
//
// ponytail: DORMANT — this bundle version never grabs hostObjects.TcTokenBridge
//   (catalog §TcTokenBridge, AppModel.cs:232).  Minimal stub satisfying the full
//   surface.  The requestUpdate ToWeb callback asks JS for TC tokens for given JIDs;
//   we wire the subscribe but never fire it since we have no VoIP consumer.
//   Upgrade path when VoIP lands: replace the in-memory Map with a safeStorage-backed
//   persistent KV and invoke tw.call('requestUpdate', jids.join(',')) from the VoIP
//   engine whenever it needs tokens not yet cached.
function tcTokenBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();
  // In-memory token store (jid → base64 TC token blob); not persisted — dormant.
  const tokens = new Map<string, string>();

  return {
    subscribe: tw.subscribe,

    // JS→native reply: zip jids/tcTokens arrays and cache by JID.
    // Base64 blobs are stored as-is (TcTokenController.cs:53-68).
    updateTcTokens: (jids: unknown, tcTokens: unknown) => {
      const jidArr = Array.isArray(jids)     ? (jids     as string[]) : [];
      const tokArr = Array.isArray(tcTokens) ? (tcTokens as string[]) : [];
      for (let i = 0; i < jidArr.length; i++) {
        if (tokArr[i] != null) tokens.set(String(jidArr[i]), String(tokArr[i]));
      }
      ctx.log('tctoken: cached', jidArr.length, 'tokens (dormant bridge)');
    },
  };
}

// ── exports ───────────────────────────────────────────────────────────────────

export const bridges: Record<string, BridgeFactory> = {
  ContactsBridge:          (ctx) => contactsBridgeImpl(ctx),
  PopulatedContactsBridge: (ctx) => contactsBridgeImpl(ctx),
  WamBridge:               (ctx) => wamBridge(ctx),
  AbPropsBridge:           (ctx) => abPropsBridge(ctx),
  TcTokenBridge:           (ctx) => tcTokenBridge(ctx),
};
