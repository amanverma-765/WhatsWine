// Main-process side of the host-object bridge. Reproduces the WebView2
// `AddHostObjectToScript` dispatch (doc 31 §3.9) over Electron IPC:
//   - sync  call  -> ipcMain.on('wa-bridge:sync')  (renderer blocks, like the
//                    WebView2 default sync proxy)
//   - async call  -> ipcMain.handle('wa-bridge:async')  (the /Async$/ surface)
//   - fn args     -> revived into callbacks that webContents.send back to the
//                    renderer (the native->JS `*BridgeToWeb` / Subscribe surface)
//
// Bridge implementations live in impl/*.ts; each exports `bridges`
// (Record<jsName, factory>). They are auto-collected via Vite glob so parallel
// authors never touch a shared registry file.

import { ipcMain, WebContents } from 'electron';
import type { BridgeContext, BridgeFactory, BridgeMethods } from './types';
import { buildContext } from './services';

const NOT_FOUND = { __wa_err__: true, notFound: true } as const;

let installed = false;

export function installBridges(): void {
  if (installed) return;
  installed = true;

  const ctx: BridgeContext = buildContext();

  // Collect every impl/*.ts module. eager so it's resolved at build time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mods = (import.meta as any).glob('./impl/*.ts', { eager: true }) as Record<string, { bridges?: Record<string, BridgeFactory> }>;

  const bridges = new Map<string, BridgeMethods>();
  for (const [file, mod] of Object.entries(mods)) {
    if (!mod.bridges) continue;
    for (const [name, factory] of Object.entries(mod.bridges)) {
      if (bridges.has(name)) console.warn(`[bridge] duplicate bridge ${name} (in ${file})`);
      try {
        bridges.set(name, factory(ctx));
      } catch (e) {
        console.error(`[bridge] failed to construct ${name} from ${file}:`, e);
      }
    }
  }
  ctx.log(`registered ${bridges.size} host-object bridges:`, [...bridges.keys()].join(', '));

  // A `{__wa_sink__:id}` arg is a renderer callback kept in the page's main world:
  //  - kind 'fn'  -> a function that posts back to that callback.
  //  - kind 'obj' -> a proxy whose `web.<method>(...)` posts back; the main world
  //    dispatches to the real subscribed object (the `*BridgeToWeb` surface).
  const revive = (wc: WebContents, args: unknown[]): unknown[] =>
    args.map((a) => {
      if (!a || typeof a !== 'object' || !('__wa_sink__' in (a as object))) return a;
      const { __wa_sink__: id, kind } = a as { __wa_sink__: number; kind: string };
      const send = (method: string | null, cbArgs: unknown[]) => {
        if (!wc.isDestroyed()) wc.send('wa-bridge:toweb', id, method, cbArgs);
      };
      if (kind === 'fn') return (...cbArgs: unknown[]) => send(null, cbArgs);
      return new Proxy({}, {
        get: (_t, method) => (typeof method === 'string'
          ? (...cbArgs: unknown[]) => send(method, cbArgs)
          : undefined),
      });
    });

  // Diagnostics: WA_BRIDGE_DEBUG=1 logs every call; missing bridges/methods are
  // ALWAYS warned (a not-found on a load-bearing bridge is what silently stalls
  // the bundle, e.g. the QR/registration path — doc 31 §5.4).
  const DEBUG = !!process.env.WA_BRIDGE_DEBUG;
  const missing = new Set<string>();
  const trace = (kind: string, name: string, method: string, found: boolean) => {
    if (DEBUG) ctx.log(`${kind} ${name}.${method} ${found ? 'ok' : 'NOT-FOUND'}`);
    if (!found) {
      const key = `${name}.${method}`;
      if (!missing.has(key)) { missing.add(key); console.warn(`[bridge] MISSING ${kind} ${key}`); }
    }
  };

  const resolve = (name: string, method: string): ((...a: unknown[]) => unknown) | null => {
    const b = bridges.get(name);
    const fn = b && (b as BridgeMethods)[method];
    return typeof fn === 'function' ? fn : null;
  };

  // WebView2's "sync proxy" still returns a Promise when the host method returns
  // IAsyncOperation/IAsyncAction. We mirror that: if a bridge method returns a
  // thenable, hand back a `{promise:id}` marker synchronously and resolve it later
  // over 'wa-bridge:resolve'. So the sync channel safely carries BOTH plain values
  // and promises — no per-method async classification needed.
  let nextPromise = 1;
  ipcMain.on('wa-bridge:sync', (e, name: string, method: string, args: unknown[]) => {
    const fn = resolve(name, method);
    trace('sync', name, method, !!fn);
    if (!fn) { e.returnValue = NOT_FOUND; return; }            // ignoreMemberNotFoundError -> undefined
    try {
      const r = fn(...revive(e.sender, args)) as unknown;
      if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
        const id = nextPromise++;
        const wc = e.sender;
        Promise.resolve(r).then(
          (v) => { if (!wc.isDestroyed()) wc.send('wa-bridge:resolve', id, true, v); },
          (err) => { if (!wc.isDestroyed()) wc.send('wa-bridge:resolve', id, false, String((err as Error)?.message ?? err)); },
        );
        e.returnValue = { promise: id };
      } else {
        e.returnValue = { value: r };
      }
    } catch (err) {
      e.returnValue = { __wa_err__: true, error: String((err as Error)?.message ?? err) };
    }
  });

  ipcMain.handle('wa-bridge:async', async (e, name: string, method: string, args: unknown[]) => {
    const fn = resolve(name, method);
    trace('async', name, method, !!fn);
    if (!fn) return undefined;
    return await fn(...revive(e.sender, args));
  });
}
