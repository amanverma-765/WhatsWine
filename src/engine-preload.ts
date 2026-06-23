// Engine preload — runs ONLY in the hidden, logged-out engine window. Hosts
// WhatsApp's WASM voip stack as a headless media/FSM core and bridges it to the
// hybrid window's VoipBridge over IPC. (The hybrid window uses src/preload.ts.)
//
// Proven by the path-b/round-trip spikes (NOTES-PATHB.md):
//   - requireLazy(['WAWebVoipStackInterfaceWeb']) loads in plain-web, logged-out.
//   - createWAWebVoipStackInterface(delegate) returns the concrete stack (voipInit,
//     handleIncomingSignalingOffer, acceptCall, endCall, startCall, setCallMute, …).
//   - The engine emits outbound signaling by CALLING WAWebVoipSendSignalingXmpp
//     (not via subscribe()); other engine→app callbacks arrive on the factory delegate.
//
// IPC:
//   main → engine: wa-engine:push-offer | push-signaling | push-ack | control {method,args}
//   engine → main: wa-engine:ready | wa-engine:engine-out {method,args}   (relayed to hybrid sink)

import { contextBridge, ipcRenderer } from 'electron';

const prim = {
  ready:   (info: unknown) => ipcRenderer.send('wa-engine:ready', info),
  // engine → main: a method the hybrid VoipBridge ToWeb sink should receive
  out:     (method: string, args: unknown[]) => ipcRenderer.send('wa-engine:engine-out', method, args),
  log:     (msg: string) => ipcRenderer.send('wa-engine:log', msg),
  onOffer:     (h: (pl: unknown) => void) => ipcRenderer.on('wa-engine:push-offer', (_e, pl) => h(pl)),
  onSignaling: (h: (pl: unknown) => void) => ipcRenderer.on('wa-engine:push-signaling', (_e, pl) => h(pl)),
  onAck:       (h: (pl: unknown) => void) => ipcRenderer.on('wa-engine:push-ack', (_e, pl) => h(pl)),
  onControl:   (h: (method: string, args: unknown[]) => void) =>
    ipcRenderer.on('wa-engine:control', (_e, method, args) => h(method, args)),
};

contextBridge.executeInMainWorld({
  func: (p: typeof prim) => {
    type Stack = Record<string, unknown>;
    const getRequireLazy = (): ((mods: string[], cb: (m: unknown) => void) => void) | null =>
      (window as unknown as { requireLazy?: (m: string[], cb: (x: unknown) => void) => void }).requireLazy ?? null;

    // Surface the bundle's real boot errors — Electron's console-message renders WA's Error
    // objects as "[object Object]", hiding the cause of a stalled voip-module registration.
    const errSeen = new Set<string>();
    const reportErr = (tag: string, e: unknown) => {
      const err = e as { stack?: string; message?: string } | undefined;
      const s = (err?.stack || err?.message || String(e) || '').slice(0, 600);
      if (errSeen.has(s)) return; errSeen.add(s);
      p.log(tag + ': ' + s);
    };
    window.addEventListener('error', (ev) => reportErr('PAGE-ERROR', (ev as ErrorEvent).error ?? (ev as ErrorEvent).message));
    window.addEventListener('unhandledrejection', (ev) => reportErr('PAGE-REJECT', (ev as PromiseRejectionEvent).reason));

    // Read back the voip gating flags (matches the proven pathb-smoke GATING probe). If
    // isVoipDownloadEnabled is false here, the bundle won't register the voip chunk → requireLazy
    // hangs forever. This tells us whether the AB-prop force actually took effect in time.
    const readGating = (rl: RL) => {
      rl(['WAWebVoipGatingUtils'], (mod) => {
        const g = mod as Record<string, () => unknown> | null;
        if (!g) { p.log('GATING: WAWebVoipGatingUtils resolved null'); return; }
        const safe = (fn: string) => { try { return typeof g[fn] === 'function' ? g[fn]() : 'n/a'; } catch (e) { return 'threw:' + String(e); } };
        p.log('GATING ' + JSON.stringify({
          isCallingEnabled: safe('isCallingEnabled'),
          isVoipDownloadEnabled: safe('isVoipDownloadEnabled'),
          isVoipInitEnabled: safe('isVoipInitEnabled'),
          unsupportedReason: safe('unsupportedReason'),
        }));
      });
    };

    // Convert a serialized byte-map {0:n,1:n,…} (or array/Uint8Array) → base64 string.
    const toB64 = (v: unknown): unknown => {
      if (v == null) return v;
      let bytes: number[] | null = null;
      if (Array.isArray(v)) bytes = v as number[];
      else if (v instanceof Uint8Array) bytes = Array.from(v);
      else if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o);
        if (keys.length && keys.every(k => /^\d+$/.test(k))) {
          bytes = keys.map(Number).sort((a, b) => a - b).map(k => Number(o[String(k)]));
        }
      }
      if (!bytes) return v;
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b & 0xff);
      try { return btoa(s); } catch { return v; }
    };

    // The engine's outbound signaling node → the bridge ToWeb `handleSignalingXmpp` shape
    // {peerJid, callId, xmlPayloadBase64, shouldEncrypt}. shouldEncrypt is true for the
    // offer/enc_rekey node types (doc 41 §3.7 step 5); we can't cheaply read the tag here,
    // so default true (the hybrid side wraps + Signal-encrypts with the logged-in keys).
    const relaySignaling = (rawArg: unknown) => {
      const a = (rawArg && typeof rawArg === 'object') ? rawArg as Record<string, unknown> : {};
      p.out('handleSignalingXmpp', [{
        peerJid: a.peerJid,
        callId: a.callId,
        xmlPayloadBase64: toB64(a.xmlPayload ?? a.xmlPayloadBase64),
        shouldEncrypt: a.shouldEncrypt ?? true,
        raw: a,            // keep the original for debugging / shape iteration
      }]);
    };

    // Patch WAWebVoipSendSignalingXmpp — every outbound emission relays to the hybrid.
    let signalingPatched = false;
    const patchOutboundSignaling = (rl: (m: string[], cb: (x: unknown) => void) => void) => {
      rl(['WAWebVoipSendSignalingXmpp'], (mod) => {
        const m = mod as Record<string, unknown> | null;
        if (!m || signalingPatched) return;
        signalingPatched = true;
        for (const fn of Object.keys(m).filter(k => typeof m[k] === 'function')) {
          const orig = m[fn] as (...a: unknown[]) => unknown;
          m[fn] = (...args: unknown[]) => {
            try { relaySignaling(args[0]); } catch (e) { p.log('relaySignaling err ' + String(e)); }
            return orig.apply(m, args);   // let the engine's own (dead) socket path run harmlessly
          };
        }
        p.log('outbound signaling patched: ' + Object.keys(m).join(','));
      });
    };

    // Factory delegate — receives the engine's non-signaling ToWeb callbacks
    // (handleVoipCall, requestDeviceJidList, requestPhoneNumberJid, requestLidJid,
    // handleVoipReady, handleCallAgain, handleLidCallerDisplayInfo, requestOpenChat).
    const delegate = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => (...args: unknown[]) => {
        const name = String(prop);
        if (name === 'then') return undefined;   // not a thenable
        try { p.out(name, args); } catch { /* ignore */ }
      },
    });

    let stack: Stack | null = null;
    let initTries = 0;
    // Anything (voipInit, offers, JID answers) can arrive from the hybrid before the stack is
    // instantiated (~3s after load). Queue and flush in order on ready — dropping voipInit would
    // leave the engine uninitialized and offers would fail.
    const pendingControl: [string, unknown[]][] = [];

    type RL = (mods: string[], cb: (m: unknown) => void) => void;

    // Walk the prototype chain to list a class instance's method names (class stacks keep
    // their methods on the prototype, so Object.keys(stack) is empty).
    const methodNames = (obj: unknown): string[] => {
      const out = new Set<string>();
      let o = obj as object | null;
      while (o && o !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(o)) { try { if (typeof (obj as Record<string, unknown>)[k] === 'function') out.add(k); } catch { /* getter threw */ } }
        o = Object.getPrototypeOf(o);
      }
      return [...out];
    };

    const finishInstantiate = () => {
      if (!stack) return;
      p.log('stack methods: ' + JSON.stringify(methodNames(stack).slice(0, 60)));
      p.ready({ type: stack.type ?? 'unknown', hasOffer: typeof stack.handleIncomingSignalingOffer === 'function' });
      // The engine owns its own init: call voipInit() with NO args (proven in the spike). The hybrid
      // also forwards voipInit, but its args carry native callback interfaces that IPC serialization
      // strips → the stack throws "e.node is not a function". The delegate is already wired via
      // getVoipStackInterface(delegate), so a bare voipInit() is all that's needed.
      try { (stack.voipInit as (() => unknown) | undefined)?.(); p.log('voipInit() called (no args)'); }
      catch (e) { p.log('voipInit threw: ' + String(e)); }
      // Flush everything queued before ready, dropping the hybrid's broken voipInit.
      for (const [mm, a] of pendingControl.splice(0)) { if (mm === 'voipInit') continue; call(mm, a); }
    };

    // The bundle no longer resolves WAWebVoipStackInterfaceWeb directly; load via the dispatcher
    // (WAWebVoipStackInterface.getVoipStackInterface), the supported entry point, which pulls the
    // concrete Web impl with the bundle's own gating. getVoipStackInterface may return the stack
    // directly or a promise, and may or may not accept the delegate — handle all shapes.
    const instantiate = (mod: unknown) => {
      const m = mod as Record<string, unknown> | null;
      if (!m) { p.log('voip module loaded but null'); return; }

      // Path 1 — concrete factory (older bundles).
      if (typeof m.createWAWebVoipStackInterface === 'function') {
        try { stack = (m.createWAWebVoipStackInterface as (d: unknown) => unknown)(delegate) as Stack; }
        catch { try { stack = (m.createWAWebVoipStackInterface as () => unknown)() as Stack; } catch (e) { p.log('factory failed: ' + String(e)); return; } }
        finishInstantiate();
        return;
      }

      // Path 2 — dispatcher (current bundle).
      if (typeof m.getVoipStackInterface === 'function') {
        let r: unknown;
        try { r = (m.getVoipStackInterface as (d?: unknown) => unknown)(delegate); }
        catch { try { r = (m.getVoipStackInterface as () => unknown)(); } catch (e) { p.log('getVoipStackInterface failed: ' + String(e)); return; } }
        if (r && typeof (r as { then?: unknown }).then === 'function') {
          (r as Promise<unknown>).then((s) => { stack = s as Stack; p.log('dispatcher stack resolved (async)'); finishInstantiate(); })
            .catch((e) => p.log('dispatcher promise rejected: ' + String(e)));
        } else { stack = r as Stack; finishInstantiate(); }
        return;
      }

      p.log('voip module loaded but no factory/dispatcher; keys=' + JSON.stringify(Object.keys(m)));
    };

    // Force web-calling AB props ON so the voip download gate (isVoipDownloadEnabled) is true —
    // a logged-out session has no server flag. Widened to the download/init keys too (doc 43 §2.6).
    const forceCalling = (rl: RL) => {
      rl(['WAWebABProps'], (abMod) => {
        const AB = abMod as Record<string, unknown> | null;
        if (!AB || typeof AB.setGetABPropConfigValueImpl !== 'function') { p.log('WAWebABProps seam missing'); return; }
        const FORCE: Record<string, boolean> = {
          enable_web_calling: true, enable_web_group_calling: true,
          web_calling_download_voip: true, web_calling_init_voip: true,
        };
        const origAb = typeof AB.getABPropConfigValue === 'function' ? (AB.getABPropConfigValue as (k: string) => unknown).bind(AB) : null;
        let inHook = false;
        (AB.setGetABPropConfigValueImpl as (fn: (k: string) => unknown) => void)((key) => {
          if (key in FORCE) return FORCE[key];
          if (inHook || !origAb) return undefined;
          inHook = true; try { return origAb(key); } finally { inHook = false; }
        });
        p.log('forced web-calling AB props ON');
      });
    };

    // Retry the voip-module load: the first requireLazy can hang if the download gate hasn't flipped
    // yet, and it never retries itself — re-issue until it resolves (~50s budget).
    // Two-step load. The concrete WAWebVoipStackInterfaceWeb (whose createWAWebVoipStackInterface(delegate)
    // accepts OUR delegate, so ToWeb callbacks like handleVoipCall reach us) doesn't resolve until the
    // dispatcher (WAWebVoipStackInterface) has pulled its chunk. So: load the dispatcher to trigger the
    // download, THEN instantiate via the concrete factory with our delegate. The dispatcher's
    // getVoipStackInterface() returns a singleton wired to the bundle's own (dead, QR-screen) UI, so it's
    // only the fallback if the concrete factory never appears.
    let voipLoaded = false;
    let voipTries = 0;
    const useConcreteOrFallback = (rl: RL, disp: unknown) => {
      rl(['WAWebVoipStackInterfaceWeb'], (web) => {
        if (voipLoaded) return;
        const wm = web as Record<string, unknown> | null;
        if (wm && typeof wm.createWAWebVoipStackInterface === 'function') {
          voipLoaded = true; p.log('instantiating via concrete createWAWebVoipStackInterface(delegate)');
          instantiate(web); return;
        }
        if (voipLoaded) return;
        voipLoaded = true; p.log('concrete factory missing; dispatcher fallback'); instantiate(disp);
      });
      // If the concrete name still won't resolve, fall back to the dispatcher singleton.
      setTimeout(() => { if (!voipLoaded) { voipLoaded = true; p.log('concrete load timeout; dispatcher fallback'); instantiate(disp); } }, 4000);
    };
    const loadVoip = (rl: RL) => {
      if (voipLoaded) return;
      if (++voipTries > 10) { p.log('voip module never loaded after 10 tries (~50s)'); readGating(rl); return; }
      rl(['WAWebVoipStackInterface'], (disp) => {
        if (voipLoaded) return;
        p.log('dispatcher loaded (try ' + voipTries + '); resolving concrete impl');
        useConcreteOrFallback(rl, disp);
      });
      setTimeout(() => { if (!voipLoaded) loadVoip(rl); }, 6000);
    };

    // One-shot diagnostic: which voip module-resolution paths actually resolve in THIS session?
    // pathb-smoke loaded via U1a(WAWebVoipStackInterfaceWeb); the dispatcher (WAWebVoipStackInterface)
    // and the raw cr:22885 alias are alternates. Tells us if a name other than *Web works here.
    const probeAltPaths = (rl: RL) => {
      let firedWeb = false, firedDisp = false;
      rl(['WAWebVoipStackInterfaceWeb'], (m) => { firedWeb = true; p.log('ALT WAWebVoipStackInterfaceWeb resolved keys=' + JSON.stringify(Object.keys((m as object) ?? {}))); });
      rl(['WAWebVoipStackInterface'], (m) => {
        firedDisp = true;
        const d = m as Record<string, unknown> | null;
        p.log('ALT WAWebVoipStackInterface(dispatcher) resolved keys=' + JSON.stringify(Object.keys(d ?? {})) + ' hasGet=' + (typeof d?.getVoipStackInterface));
      });
      try {
        const req = (window as unknown as { require?: (id: string) => unknown }).require;
        p.log('ALT cr:22885 sync require=' + (req ? typeof req('cr:22885') : 'no window.require'));
      } catch (e) { p.log('ALT cr:22885 threw: ' + String(e)); }
      setTimeout(() => p.log('ALT result: Web=' + firedWeb + ' dispatcher=' + firedDisp), 8000);
    };

    const init = () => {
      const rl = getRequireLazy();
      if (!rl) { if (++initTries % 5 === 0) p.log('waiting for requireLazy... ' + initTries + 's'); setTimeout(init, 1000); return; }
      const w = window as unknown as { crossOriginIsolated?: boolean };
      p.log('requireLazy ready; coI=' + String(w.crossOriginIsolated) + ' SAB=' + (typeof SharedArrayBuffer));
      patchOutboundSignaling(rl);
      forceCalling(rl);
      setTimeout(() => { readGating(rl); probeAltPaths(rl); loadVoip(rl); }, 1200);   // read gating, probe paths, then load
    };

    const call = (method: string, args: unknown[]) => {
      // The engine self-inits in finishInstantiate; ignore the hybrid's forwarded voipInit (its
      // native-callback args don't survive IPC and crash the stack).
      if (method === 'voipInit') { p.log('ignoring forwarded voipInit (engine self-inits)'); return; }
      if (!stack) { pendingControl.push([method, args]); p.log('queued (stack not ready): ' + method); return; }
      const fn = stack[method];
      if (typeof fn !== 'function') { p.log('control: not a fn: ' + method); return; }
      try { (fn as (...a: unknown[]) => unknown).apply(stack, args); }
      catch (e) { p.log('control ' + method + ' threw: ' + String(e)); }
    };

    p.onOffer((pl) => {
      const o = pl as { xmlNodeBase64: string; msgPlatform: string; msgVersion: string; msgE: string; msgT: string; msgOffline: boolean; isOfferNotContact: boolean; peerJid: string };
      call('handleIncomingSignalingOffer', [o.xmlNodeBase64, o.msgPlatform, o.msgVersion, o.msgE, o.msgT, o.msgOffline, o.isOfferNotContact, o.peerJid]);
    });
    p.onSignaling((pl) => { const o = pl as { xmlNodeBase64: string; extraArgs: unknown[] }; call('handleIncomingSignalingMessage', [o.xmlNodeBase64, ...o.extraArgs]); });
    p.onAck((pl) => { const o = pl as { xmlNodeBase64: string; ackInfoError: unknown; ackInfoType: unknown; peerJid: string }; call('handleIncomingSignalingAck', [o.xmlNodeBase64, o.ackInfoError, o.ackInfoType, o.peerJid]); });
    p.onControl((method, args) => call(method, args));

    setTimeout(init, 3000);   // give the bundle time to boot its module registry
  },
  args: [prim],
});
