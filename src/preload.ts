// Preload: reconstruct the WebView2 host-object surface the WA Web bundle expects
// when loaded with `?windows=1` (doc 31 §3.9, §5.2). The bundle reads
// `window.chrome.webview.hostObjects.<Name>.<Method>(...)`.
//
// The Proxy is built in the page's MAIN world (where the bundle runs) via
// executeInMainWorld — a Proxy can't cross the isolated/main boundary, but the
// raw transport primitives can. Callback objects passed to `subscribe(web)` are
// kept in the main world (a "sink" registry); only a serializable marker crosses
// IPC, and native->JS events are dispatched back to the real object here. This
// avoids trying to structured-clone functions (which fails for prototype methods).

import { contextBridge, ipcRenderer } from 'electron';

// Isolated world: raw transport + forwarders for native->JS callbacks and for
// deferred resolution of promise-returning sync methods.
let toWebHandler: ((id: number, method: string | null, args: unknown[]) => void) | null = null;
let resolveHandler: ((id: number, ok: boolean, payload: unknown) => void) | null = null;
let nativeCallEventHandler: ((eventType: unknown, eventDataJson: unknown) => void) | null = null;
ipcRenderer.on('wa-bridge:toweb', (_e, id: number, method: string | null, args: unknown[]) => {
  toWebHandler?.(id, method, args);
});
ipcRenderer.on('wa-bridge:resolve', (_e, id: number, ok: boolean, payload: unknown) => {
  resolveHandler?.(id, ok, payload);
});
// Native call events relayed from the hidden voip engine window (via main) → replay into the bundle.
ipcRenderer.on('wa-hybrid:native-call-event', (_e, eventType: unknown, eventDataJson: unknown) => {
  nativeCallEventHandler?.(eventType, eventDataJson);
});

const prim = {
  sync: (name: string, method: string, args: unknown[]) => ipcRenderer.sendSync('wa-bridge:sync', name, method, args),
  invoke: (name: string, method: string, args: unknown[]) => ipcRenderer.invoke('wa-bridge:async', name, method, args),
  onToWeb: (h: (id: number, method: string | null, args: unknown[]) => void) => { toWebHandler = h; },
  onResolve: (h: (id: number, ok: boolean, payload: unknown) => void) => { resolveHandler = h; },
  onNativeCallEvent: (h: (eventType: unknown, eventDataJson: unknown) => void) => { nativeCallEventHandler = h; },
};

contextBridge.exposeInMainWorld('__waBridge', prim);

contextBridge.executeInMainWorld({
  func: (p: typeof prim) => {
    const ASYNC = /(Async|AsyncWithSpeller)$/;

    // Main-world callback sinks: id -> fn (top-level callback) | object (subscribe web).
    const sinks = new Map<number, unknown>();
    let sinkId = 1;
    p.onToWeb((id, method, args) => {
      const s = sinks.get(id);
      if (!s) return;
      try {
        if (method == null && typeof s === 'function') (s as (...a: unknown[]) => void)(...args);
        else if (s && typeof (s as Record<string, unknown>)[method as string] === 'function') {
          (s as Record<string, (...a: unknown[]) => void>)[method as string](...args);
        }
      } catch { /* swallow renderer cb errors */ }
    });

    const pack = (method: string, args: unknown[]) =>
      (args || []).map((a) => {
        if (typeof a === 'function') { const id = sinkId++; sinks.set(id, a); return { __wa_sink__: id, kind: 'fn' }; }
        // subscribe(web) — keep the callback object in the main world.
        if (a && typeof a === 'object' && !Array.isArray(a) && /subscribe/i.test(method)) {
          const id = sinkId++; sinks.set(id, a); return { __wa_sink__: id, kind: 'obj' };
        }
        return a;
      });

    // Deferred resolution of promise-returning sync methods (the host-object
    // IAsyncOperation case): main posts a {promise:id} marker now, resolves later.
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    p.onResolve((id, ok, payload) => {
      const d = pending.get(id);
      if (!d) return;
      pending.delete(id);
      ok ? d.resolve(payload) : d.reject(new Error(String(payload)));
    });

    const handleSync = (r: { value?: unknown; promise?: number; __wa_err__?: boolean; notFound?: boolean; error?: string }) => {
      if (r && r.__wa_err__) { if (r.notFound) return undefined; throw new Error(r.error ?? 'bridge error'); }
      if (r && r.promise != null) return new Promise((resolve, reject) => pending.set(r.promise as number, { resolve, reject }));
      return r ? r.value : undefined;
    };

    const makeBridge = (name: string, forceSync: boolean) =>
      new Proxy(Object.create(null), {
        get(_t, method) {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return (...args: unknown[]) => {
            const packed = pack(method, args);
            return !forceSync && ASYNC.test(method)
              ? p.invoke(name, method, packed)
              : handleSync(p.sync(name, method, packed) as { value?: unknown });
          };
        },
      });

    const syncRoot = new Proxy(Object.create(null), {
      get: (_t, n) => (typeof n === 'string' ? makeBridge(n, true) : undefined),
    });
    const hostObjects = new Proxy(Object.create(null), {
      get(_t, name) {
        if (name === 'sync') return syncRoot;
        if (name === 'options') return {};
        if (typeof name !== 'string') return undefined;
        return makeBridge(name, false);
      },
    });

    const w = window as unknown as { chrome?: { webview?: Record<string, unknown> }; requireLazy?: (mods: string[], cb: (...m: unknown[]) => void) => void };
    w.chrome = w.chrome || {};
    w.chrome.webview = w.chrome.webview || {};
    w.chrome.webview.hostObjects = hostObjects;

    // ── Native call-event replay ──────────────────────────────────────────────
    // The hidden voip engine window emits onCallEvent {eventType, eventDataJson}; main relays them
    // here. Replay through the bundle's own dispatcher so the `?windows=1` call UI rings — the same
    // entry the native voip path drives (analysis/docs/98). Queue until requireLazy + modules load.
    type CallEventModules = { H: { handleWAWebVoipNativeCallEvent: (t: unknown, json: unknown) => unknown }; E: { CallEvent: { cast: (t: unknown) => unknown } } };
    const pendingEvents: [unknown, unknown][] = [];
    let eventModules: CallEventModules | null = null;
    const dispatchCallEvent = (eventType: unknown, eventDataJson: unknown) => {
      if (!eventModules) { pendingEvents.push([eventType, eventDataJson]); return; }
      try { eventModules.H.handleWAWebVoipNativeCallEvent(eventModules.E.CallEvent.cast(eventType), eventDataJson); }
      catch { /* swallow — bundle may not be in a state to handle it */ }
    };
    const loadCallEventModules = (tries = 0) => {
      const rl = w.requireLazy;
      if (!rl) { if (tries < 60) setTimeout(() => loadCallEventModules(tries + 1), 500); return; }
      rl(['WAWebVoipHandleNativeCallEvent', 'WAWebVoipWaCallEnums'], (H, E) => {
        eventModules = { H: H as CallEventModules['H'], E: E as CallEventModules['E'] };
        for (const [t, j] of pendingEvents.splice(0)) dispatchCallEvent(t, j);
      });
    };
    p.onNativeCallEvent(dispatchCallEvent);
    loadCallEventModules();

    // Legacy comma-IPC shim (bridgeError=1, doc 31 §5.2) — no-throw; modern bundle
    // uses hostObjects. ponytail: native->JS legacy events unused.
    const legacy = new Set<(e: { data: unknown }) => void>();
    w.chrome.webview.postMessage = (m: unknown) => handleSync(p.sync('__legacy__', 'postMessage', [m]) as { value?: unknown });
    w.chrome.webview.addEventListener = (_t: string, cb: (e: { data: unknown }) => void) => legacy.add(cb);
    w.chrome.webview.removeEventListener = (_t: string, cb: (e: { data: unknown }) => void) => legacy.delete(cb);
  },
  args: [prim],
});
