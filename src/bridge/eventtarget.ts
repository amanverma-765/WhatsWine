// Native->JS callback surface (the `*BridgeToWeb` Subscribe pattern, doc 31 §4).
// The bundle calls `<Bridge>.subscribe(web)` passing an object whose methods
// (camelCased) native invokes — e.g. ConnectionBridge calls web.connect(),
// NativeAppStateBridge calls web.appStateChanged(state). The `web` object is a
// renderer-side proxy (its methods post back over IPC; see preload), so calling
// any method is safe — unknown methods are dropped main-world-side.

type Web = Record<string, (...a: unknown[]) => void>;

export interface ToWeb {
  /** Register a subscribed web sink. */
  subscribe: (web?: unknown) => void;
  /** Invoke `web.<method>(...args)` on every subscriber. */
  call: (method: string, ...args: unknown[]) => void;
}

export function toWeb(): ToWeb {
  const subs: Web[] = [];
  return {
    subscribe(web) { if (web && typeof web === 'object') subs.push(web as Web); },
    call(method, ...args) {
      for (const w of subs) {
        const f = w[method];
        if (typeof f === 'function') { try { f(...args); } catch { /* renderer gone */ } }
      }
    },
  };
}
