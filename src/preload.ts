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
let bridgeEventHandler: ((name: string, eventName: string, payload: unknown) => void) | null = null;
ipcRenderer.on('wa-bridge:toweb', (_e, id: number, method: string | null, args: unknown[]) => {
  toWebHandler?.(id, method, args);
});
ipcRenderer.on('wa-bridge:resolve', (_e, id: number, ok: boolean, payload: unknown) => {
  resolveHandler?.(id, ok, payload);
});
// Host-object EventTarget dispatch (e.g. VoipBridge "handleVoipCallEvent"): native fires a named
// event on a bridge; the main world routes it to the bundle's addEventListener handlers.
ipcRenderer.on('wa-bridge:event', (_e, name: string, eventName: string, payload: unknown) => {
  bridgeEventHandler?.(name, eventName, payload);
});

const prim = {
  sync: (name: string, method: string, args: unknown[]) => ipcRenderer.sendSync('wa-bridge:sync', name, method, args),
  invoke: (name: string, method: string, args: unknown[]) => ipcRenderer.invoke('wa-bridge:async', name, method, args),
  onToWeb: (h: (id: number, method: string | null, args: unknown[]) => void) => { toWebHandler = h; },
  onResolve: (h: (id: number, ok: boolean, payload: unknown) => void) => { resolveHandler = h; },
  onBridgeEvent: (h: (name: string, eventName: string, payload: unknown) => void) => { bridgeEventHandler = h; },
};

contextBridge.exposeInMainWorld('__waBridge', prim);

contextBridge.executeInMainWorld({
  func: (p: typeof prim) => {
    const ASYNC = /(Async|AsyncWithSpeller)$/;

    // The bundle's logger renders Error objects as "[object Object]" in console output, hiding the
    // cause of swallowed ErrorUtils failures (e.g. onCallEvent throwing on our synthesized event).
    // Expand Error-like args so the real message/stack reaches the captured console.
    const origErr = console.error.bind(console);
    console.error = (...a: unknown[]) => origErr(...a.map((x) => {
      const e = x as { stack?: string; message?: string } | null;
      return (e && (e.stack || e.message)) ? `ERR(${e.message}) ${String(e.stack || '').slice(0, 400)}` : x;
    }));

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

    // Host objects double as EventTargets: the bundle calls e.g.
    // VoipBridge.addEventListener("handleVoipCallEvent", h) + subscribe(null), and native fires the
    // named event. Keep these registrations in the main world; dispatch on wa-bridge:event from main.
    const bridgeListeners = new Map<string, Map<string, Set<(e: unknown) => void>>>();
    const addBridgeListener = (name: string, eventName: string, h: (e: unknown) => void) => {
      let m = bridgeListeners.get(name); if (!m) { m = new Map(); bridgeListeners.set(name, m); }
      let s = m.get(eventName); if (!s) { s = new Set(); m.set(eventName, s); }
      s.add(h);
      console.log('[wabridge] addEventListener', name, eventName);
    };
    const removeBridgeListener = (name: string, eventName: string, h: (e: unknown) => void) =>
      bridgeListeners.get(name)?.get(eventName)?.delete(h);
    p.onBridgeEvent((name, eventName, payload) => {
      const s = bridgeListeners.get(name)?.get(eventName);
      console.log('[wabridge] event', name, eventName, 'listeners=' + (s ? s.size : 0));
      if (s) for (const h of [...s]) { try { h(payload); } catch (e) { console.log('[wabridge] handler threw: ' + String((e as Error)?.stack || e).slice(0, 400)); } }
    });

    const makeBridge = (name: string, forceSync: boolean) =>
      new Proxy(Object.create(null), {
        get(_t, method) {
          if (typeof method !== 'string' || method === 'then') return undefined;
          if (method === 'addEventListener') return (eventName: string, h: (e: unknown) => void) => addBridgeListener(name, eventName, h);
          if (method === 'removeEventListener') return (eventName: string, h: (e: unknown) => void) => removeBridgeListener(name, eventName, h);
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

    // Diagnostic: in ?windows=1 the native call-event funnel handleWAWebVoipNativeCallEvent runs in
    // THIS frontend. Hook it to confirm our synthesized handleVoipCallEvent reaches it (vs. being
    // dropped at $3==null because handleVoipReady never wired the handlers).
    const hookHybridDispatch = (tries = 0) => {
      const rl = w.requireLazy;
      if (!rl) { if (tries < 60) setTimeout(() => hookHybridDispatch(tries + 1), 500); return; }
      rl(['WAWebVoipHandleNativeCallEvent'], (mod) => {
        const H = mod as Record<string, unknown> | null;
        if (!H || typeof H.handleWAWebVoipNativeCallEvent !== 'function') return;
        const orig = H.handleWAWebVoipNativeCallEvent as (...a: unknown[]) => unknown;
        H.handleWAWebVoipNativeCallEvent = (et: unknown, json: unknown, ...rest: unknown[]) => {
          console.log('[wabridge] handleWAWebVoipNativeCallEvent reached: type=' + String(et));
          try { const r = orig(et, json, ...rest); if (r && (r as Promise<unknown>).catch) (r as Promise<unknown>).catch((e) => console.log('[wabridge] dispatch async threw: ' + String((e as Error)?.stack || e).slice(0, 400))); return r; }
          catch (e) { console.log('[wabridge] dispatch sync threw: ' + String((e as Error)?.stack || e).slice(0, 400)); throw e; }
        };
        console.log('[wabridge] hybrid handleWAWebVoipNativeCallEvent hooked');
      });
      // Also tap frontendFireAndForget to see whether Y reaches setCallState and with what callInfo
      // (this is what actually drives the ring). Filter to call-related messages.
      rl(['WAWebBackendApi'], (B) => {
        const api = B as Record<string, unknown> | null;
        const orig = api?.frontendFireAndForget as ((n: string, p: unknown) => unknown) | undefined;
        if (!api || typeof orig !== 'function') return;
        api.frontendFireAndForget = (name: string, payload: unknown) => {
          if (/call/i.test(name)) console.log('[wabridge] FFAF ' + name + ' ' + JSON.stringify(payload).slice(0, 300));
          return orig.call(api, name, payload);
        };
        console.log('[wabridge] frontendFireAndForget hooked');
      });
    };
    hookHybridDispatch();

    // Legacy comma-IPC shim (bridgeError=1, doc 31 §5.2) — no-throw; modern bundle
    // uses hostObjects. ponytail: native->JS legacy events unused.
    const legacy = new Set<(e: { data: unknown }) => void>();
    w.chrome.webview.postMessage = (m: unknown) => handleSync(p.sync('__legacy__', 'postMessage', [m]) as { value?: unknown });
    w.chrome.webview.addEventListener = (_t: string, cb: (e: { data: unknown }) => void) => legacy.add(cb);
    w.chrome.webview.removeEventListener = (_t: string, cb: (e: { data: unknown }) => void) => legacy.delete(cb);
  },
  args: [prim],
});
