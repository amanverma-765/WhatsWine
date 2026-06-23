// Engine preload — runs ONLY in the hidden, logged-out engine window. Hosts
// WhatsApp's WASM voip stack as a headless media/FSM core and bridges it to the
// hybrid window's VoipBridge over IPC. (The hybrid window uses src/preload.ts.)
//
// Integration model (see analysis/docs/98-voip-wasm-engine-relay.md, from real source):
//   - The stack loads logged-out via the dispatcher WAWebVoipStackInterface
//     (getVoipStackInterface) which pulls the concrete Web chunk; the factory takes
//     NO delegate.
//   - Engine→JS events flow through window.WhatsAppVoipWasm[WorkerCompatible]Callbacks
//     .onCallEvent({eventType, eventDataJson}); we wrap it and relay to the hybrid,
//     which replays handleWAWebVoipNativeCallEvent → the call rings.
//   - Inbound handleIncomingSignaling{Offer,Message,Ack} require a NODE WRAPPER first
//     arg (`e.node()`), not base64 — we decode via WAWap.decodeStanza first.
//   - Outbound is emitted by WAWebVoipSendSignalingXmpp (patched here).
//
// IPC:
//   main → engine: wa-engine:push-offer | push-signaling | push-ack | control {method,args}
//   engine → main: wa-engine:ready | wa-engine:engine-out {method,args} (→ hybrid ToWeb sink)
//                  wa-engine:native-call-event {eventType,eventDataJson} (→ hybrid handleWAWebVoipNativeCallEvent)

import { contextBridge, ipcRenderer } from 'electron';

const prim = {
  ready:   (info: unknown) => ipcRenderer.send('wa-engine:ready', info),
  // engine → main: a method the hybrid VoipBridge ToWeb sink should receive
  out:     (method: string, args: unknown[]) => ipcRenderer.send('wa-engine:engine-out', method, args),
  // engine → main: a native call event to replay in the hybrid via handleWAWebVoipNativeCallEvent
  nativeEvent: (eventType: unknown, eventDataJson: unknown) => ipcRenderer.send('wa-engine:native-call-event', eventType, eventDataJson),
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
    type RL = (mods: string[], cb: (...m: unknown[]) => void) => void;
    const getRequireLazy = (): RL | null =>
      (window as unknown as { requireLazy?: RL }).requireLazy ?? null;

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

    // Read back the voip gating flags. If isVoipDownloadEnabled is false the bundle won't
    // register the voip chunk → requireLazy hangs forever.
    const readGating = (rl: RL) => {
      rl(['WAWebVoipGatingUtils'], (mod) => {
        const g = mod as Record<string, () => unknown> | null;
        if (!g) { p.log('GATING: WAWebVoipGatingUtils resolved null'); return; }
        const safe = (fn: string) => { try { return typeof g[fn] === 'function' ? g[fn]() : 'n/a'; } catch (e) { return 'threw:' + String(e); } };
        p.log('GATING ' + JSON.stringify({
          isCallingEnabled: safe('isCallingEnabled'),
          isVoipDownloadEnabled: safe('isVoipDownloadEnabled'),
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

    // The engine's outbound signaling node → the bridge ToWeb `handleSignalingXmpp` shape.
    // The engine outputs the PLAINTEXT inner node; the hybrid wraps + Signal-encrypts with the
    // logged-in keys. shouldEncrypt defaults true (offer/enc_rekey); revisit if rekey/ack need false.
    const relaySignaling = (rawArg: unknown) => {
      const a = (rawArg && typeof rawArg === 'object') ? rawArg as Record<string, unknown> : {};
      p.out('handleSignalingXmpp', [{
        peerJid: a.peerJid,
        callId: a.callId,
        xmlPayloadBase64: toB64(a.xmlPayload ?? a.xmlPayloadBase64),
        shouldEncrypt: a.shouldEncrypt ?? true,
        raw: a,
      }]);
    };

    // Patch WAWebVoipSendSignalingXmpp — every outbound emission relays to the hybrid.
    let signalingPatched = false;
    const patchOutboundSignaling = (rl: RL) => {
      rl(['WAWebVoipSendSignalingXmpp'], (mod) => {
        const m = mod as Record<string, unknown> | null;
        if (!m || signalingPatched) return;
        signalingPatched = true;
        for (const fn of Object.keys(m).filter(k => typeof m[k] === 'function')) {
          const orig = m[fn] as (...a: unknown[]) => unknown;
          m[fn] = (...args: unknown[]) => {
            try { relaySignaling(args[0]); } catch (e) { p.log('relaySignaling err ' + String(e)); }
            return orig.apply(m, args);
          };
        }
        p.log('outbound signaling patched: ' + Object.keys(m).join(','));
      });
    };

    // ── Inbound node-wrap ────────────────────────────────────────────────────────
    // The WASM handleIncomingSignaling{Offer,Message,Ack} do `var p = e.node(); encodeStanza(p)` —
    // the first arg must be a node WRAPPER, not base64. WAWap.decodeStanza(bytes, inflate) → Promise<node>.
    // The voip layer itself uses a passthrough inflate (a5gdgRhdCri.js: decodeStanza(c, e=>Promise.resolve(e))),
    // so voip stanzas aren't gzipped.
    type Wap = { decodeStanza: (bytes: unknown, inflate: (e: unknown) => Promise<unknown>) => Promise<unknown> };
    type B64 = { decodeB64: (s: string) => unknown };
    let wap: Wap | null = null, b64: B64 | null = null;
    const loadWapModules = (rl: RL) => {
      rl(['WAWap', 'WABase64'], (w, b) => {
        wap = w as Wap; b64 = b as B64;
        p.log('WAWap/WABase64 ready: ' + (typeof wap?.decodeStanza) + '/' + (typeof b64?.decodeB64));
      });
    };
    const passthroughInflate = (e: unknown) => Promise.resolve(e);
    const toU8 = (v: unknown): Uint8Array => {
      if (v instanceof Uint8Array) return v;
      if (v instanceof ArrayBuffer) return new Uint8Array(v);
      if (ArrayBuffer.isView(v)) { const a = v as ArrayBufferView; return new Uint8Array(a.buffer, a.byteOffset, a.byteLength); }
      if (Array.isArray(v)) return Uint8Array.from(v as number[]);
      throw new Error('decodeB64 returned unexpected type ' + Object.prototype.toString.call(v));
    };
    // base64 string → { node: () => parsedNode }. Async because decodeStanza is async.
    // The ?windows=1 producer (WAWebSerializeVoipWapNode.serializeVoipWapNode) encodes the node via
    // WAWap.encodeStanza then STRIPS the leading framing/compression flag byte (readUint8) before
    // base64. decodeStanza expects that flag, so re-prepend 0 (uncompressed) before decoding.
    const wrapNode = async (b64Str: string): Promise<{ node: () => unknown }> => {
      if (!wap || !b64) throw new Error('WAWap/WABase64 not loaded yet');
      const body = toU8(b64.decodeB64(b64Str));
      const framed = new Uint8Array(body.length + 1);
      framed[0] = 0;
      framed.set(body, 1);
      const node = await wap.decodeStanza(framed, passthroughInflate);
      return { node: () => node };
    };

    let stack: Stack | null = null;
    let initTries = 0;
    // Anything (offers, JID answers) can arrive before the stack is ready. Queue and flush on ready.
    const pendingControl: [string, unknown[]][] = [];

    // ── onCallEvent interception (engine → hybrid) ───────────────────────────────
    // The WASM emits every call event through window.WhatsAppVoipWasm*Callbacks.onCallEvent
    // ({eventType, eventDataJson}). Wrap it on BOTH tables (the real dispatcher lives on the
    // worker-compatible one): relay the raw primitives to the hybrid, then run the original so the
    // engine's own media handlers (P2P transport, etc.) still execute here.
    let callEventsHooked = false;
    const hookCallEvents = () => {
      if (callEventsHooked) return;
      const w = window as unknown as Record<string, { onCallEvent?: (t: { eventType: unknown; eventDataJson: unknown }) => unknown; __waHooked?: boolean }>;
      let hooked = 0;
      for (const tbl of ['WhatsAppVoipWasmWorkerCompatibleCallbacks', 'WhatsAppVoipWasmCallbacks']) {
        const cbs = w[tbl];
        if (cbs && typeof cbs.onCallEvent === 'function' && !cbs.__waHooked) {
          cbs.__waHooked = true;
          const orig = cbs.onCallEvent.bind(cbs);
          cbs.onCallEvent = (t) => {
            p.log('onCallEvent fired: type=' + String(t?.eventType));
            try { p.nativeEvent(t?.eventType, t?.eventDataJson); } catch (e) { p.log('nativeEvent relay err ' + String(e)); }
            return orig(t);
          };
          hooked++;
        }
      }
      if (hooked) { callEventsHooked = true; p.log('onCallEvent hooked on ' + hooked + ' table(s)'); }
    };

    // The reliable funnel: WAWebVoipHandleNativeCallEvent.handleWAWebVoipNativeCallEvent(eventType,
    // eventDataJson) — both onCallEvent paths converge here and it runs in the frontend (its handlers
    // call frontendFireAndForget). Wrap the module export to relay every event to the hybrid.
    let nceHooked = false;
    const hookNativeCallEvent = (rl: RL) => {
      rl(['WAWebVoipHandleNativeCallEvent'], (mod) => {
        const H = mod as Record<string, unknown> | null;
        if (!H || typeof H.handleWAWebVoipNativeCallEvent !== 'function' || nceHooked) return;
        nceHooked = true;
        const orig = H.handleWAWebVoipNativeCallEvent as (...a: unknown[]) => unknown;
        H.handleWAWebVoipNativeCallEvent = (eventType: unknown, eventDataJson: unknown, ...rest: unknown[]) => {
          p.log('handleNativeCallEvent fired: type=' + String(eventType) + ' (' + typeof eventType + ')');
          try { p.nativeEvent(eventType, eventDataJson); } catch (e) { p.log('nce relay err ' + String(e)); }
          return orig(eventType, eventDataJson, ...rest);
        };
        p.log('handleWAWebVoipNativeCallEvent hooked');
      });
    };

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
      // Hook the WASM event tables now that createWAWebVoipStackInterface() has populated the globals.
      hookCallEvents();
      // The engine owns its own init: voipInit() with NO args (proven). The hybrid's forwarded voipInit
      // is ignored (its native-callback args don't survive IPC).
      try { (stack.voipInit as (() => unknown) | undefined)?.(); p.log('voipInit() called (no args)'); }
      catch (e) { p.log('voipInit threw: ' + String(e)); }
      for (const [mm, a] of pendingControl.splice(0)) { if (mm === 'voipInit') continue; call(mm, a); }
    };

    // Instantiate via the dispatcher singleton. createWAWebVoipStackInterface takes no delegate; the
    // singleton it builds is the one whose global onCallEvent we hook. getVoipStackInterface may return
    // the stack sync or as a promise.
    const instantiate = (mod: unknown) => {
      const m = mod as Record<string, unknown> | null;
      if (!m || typeof m.getVoipStackInterface !== 'function') {
        p.log('dispatcher missing getVoipStackInterface; keys=' + JSON.stringify(Object.keys(m ?? {})));
        return;
      }
      let r: unknown;
      try { r = (m.getVoipStackInterface as () => unknown)(); }
      catch (e) { p.log('getVoipStackInterface failed: ' + String(e)); return; }
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        (r as Promise<unknown>).then((s) => { stack = s as Stack; p.log('dispatcher stack resolved (async)'); finishInstantiate(); })
          .catch((e) => p.log('dispatcher promise rejected: ' + String(e)));
      } else { stack = r as Stack; finishInstantiate(); }
    };

    // Force web-calling AB props ON so the voip download gate (isVoipDownloadEnabled) is true —
    // a logged-out session has no server flag.
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

    // Load the voip stack via the dispatcher. The concrete WAWebVoipStackInterfaceWeb name won't
    // resolve until the dispatcher pulls its chunk, so load the dispatcher and retry until it fires.
    let voipLoaded = false;
    let voipTries = 0;
    const loadVoip = (rl: RL) => {
      if (voipLoaded) return;
      if (++voipTries > 10) { p.log('voip dispatcher never loaded after 10 tries (~50s)'); readGating(rl); return; }
      rl(['WAWebVoipStackInterface'], (disp) => {
        if (voipLoaded) return;
        voipLoaded = true;
        p.log('dispatcher loaded (try ' + voipTries + ')');
        instantiate(disp);
      });
      setTimeout(() => { if (!voipLoaded) loadVoip(rl); }, 5000);
    };

    const init = () => {
      const rl = getRequireLazy();
      if (!rl) { if (++initTries % 5 === 0) p.log('waiting for requireLazy... ' + initTries + 's'); setTimeout(init, 1000); return; }
      const wd = window as unknown as { crossOriginIsolated?: boolean };
      p.log('requireLazy ready; coI=' + String(wd.crossOriginIsolated) + ' SAB=' + (typeof SharedArrayBuffer));
      patchOutboundSignaling(rl);
      forceCalling(rl);
      loadWapModules(rl);
      hookNativeCallEvent(rl);
      setTimeout(() => { readGating(rl); loadVoip(rl); }, 1200);
    };

    const call = (method: string, args: unknown[]) => {
      // The engine self-inits in finishInstantiate; ignore the hybrid's forwarded voipInit.
      if (method === 'voipInit') { p.log('ignoring forwarded voipInit (engine self-inits)'); return; }
      if (!stack) { pendingControl.push([method, args]); p.log('queued (stack not ready): ' + method); return; }
      const fn = stack[method];
      if (typeof fn !== 'function') { p.log('control: not a fn: ' + method); return; }
      try { (fn as (...a: unknown[]) => unknown).apply(stack, args); }
      catch (e) { p.log('control ' + method + ' threw: ' + String(e)); }
    };

    // Inbound signaling: decode base64 → node wrapper, THEN call the stack (async decode).
    const callWithWrappedNode = async (method: string, b64Str: string, rest: unknown[]) => {
      try {
        const wrapped = await wrapNode(b64Str);
        let tag: unknown = '?';
        try { const nn = wrapped.node() as { tag?: unknown }; tag = nn?.tag ?? Object.keys(nn ?? {}); } catch { /* ignore */ }
        p.log(method + ': decoded ok (tag=' + JSON.stringify(tag) + '), applying to stack=' + (!!stack));
        call(method, [wrapped, ...rest]);
      }
      catch (e) { p.log(method + ' wrap/decode failed: ' + String(e)); }
    };

    p.onOffer((pl) => {
      const o = pl as { xmlNodeBase64: string; msgPlatform: string; msgVersion: string; msgE: string; msgT: string; msgOffline: boolean; isOfferNotContact: boolean; peerJid: string; tcToken?: unknown };
      callWithWrappedNode('handleIncomingSignalingOffer', o.xmlNodeBase64,
        [o.msgPlatform, o.msgVersion, o.msgE, o.msgT, o.msgOffline, o.isOfferNotContact, o.peerJid, o.tcToken]);
    });
    p.onSignaling((pl) => { const o = pl as { xmlNodeBase64: string; extraArgs: unknown[] }; callWithWrappedNode('handleIncomingSignalingMessage', o.xmlNodeBase64, o.extraArgs); });
    p.onAck((pl) => { const o = pl as { xmlNodeBase64: string; ackInfoError: unknown; ackInfoType: unknown; peerJid: string }; callWithWrappedNode('handleIncomingSignalingAck', o.xmlNodeBase64, [o.ackInfoError, o.ackInfoType, o.peerJid]); });
    p.onControl((method, args) => call(method, args));

    setTimeout(init, 3000);   // give the bundle time to boot its module registry
  },
  args: [prim],
});
