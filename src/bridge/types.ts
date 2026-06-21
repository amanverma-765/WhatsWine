// Shared types for the WhatsApp-Windows-hybrid native host-object bridges.
// Mirrors the `window.chrome.webview.hostObjects.<Name>` surface the WA Web
// bundle calls when loaded with `?windows=1` (docs 31 §3.9, 90 §M0).

import type DatabaseT from 'better-sqlite3';

// A bridge is just a bag of methods. Methods ending in `Async`/`AsyncWithSpeller`
// are exposed as promises on the JS side; everything else is a blocking sync call
// (doc 31 §5.2 — `forceAsyncMethodMatches=[/Async$/,/AsyncWithSpeller$/]`,
// `defaultSyncProxy=true`). A method arg that is a function is a native→JS
// callback (the `*BridgeToWeb` / `Subscribe` surface) — the registry revives it
// into a real function that posts back to the renderer.
export type BridgeMethods = Record<string, (...args: any[]) => any>;

export interface BridgeContext {
  /** Electron userData dir (the WebView2 LocalCacheFolder analogue, doc 30 §5). */
  userDataDir: string;
  /** Per-account dir: userData/sessions/{sha1(clientKey)}/ (doc 32 §5). */
  sessionsDir: string;
  /** Lazily-opened native-owned sqlite (contacts/wam/prefs/abprops…), WAL+FULL+secure_delete. */
  nativeDb: () => DatabaseT.Database;
  /** safeStorage-backed KV for the login-secret material (ClientKey, salts; doc 32 §5). */
  secretSet: (key: string, value: string) => void;
  secretGet: (key: string) => string | null;
  secretDel: (key: string) => void;
  /** Push an event to the renderer's main world (rare — most callbacks ride method fn-args). */
  emit: (event: string, ...payload: unknown[]) => void;
  log: (...a: unknown[]) => void;
}

export type BridgeFactory = (ctx: BridgeContext) => BridgeMethods;

// Every bridge module under impl/ exports `bridges` (one file may host a group).
export interface BridgeModule {
  bridges: Record<string, BridgeFactory>;
}
