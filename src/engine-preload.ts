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
  // engine → main: the engine's WA login state, so main shows the window for QR pairing when
  // logged-out and hides it off-screen once logged in.
  loginState: (loggedIn: boolean) => ipcRenderer.send('wa-engine:login-state', { loggedIn }),
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
    const toBytes = (v: unknown): number[] | null => {
      if (v == null) return null;
      if (Array.isArray(v)) return v as number[];
      if (v instanceof Uint8Array) return Array.from(v);
      if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o);
        if (keys.length && keys.every(k => /^\d+$/.test(k))) return keys.map(Number).sort((a, b) => a - b).map(k => Number(o[String(k)]));
      }
      return null;
    };
    const bytesToB64 = (bytes: number[]): string => {
      let s = ''; for (const b of bytes) s += String.fromCharCode(b & 0xff);
      return btoa(s);
    };

    // The engine's outbound signaling node → the bridge ToWeb `handleSignalingXmpp` shape.
    // The engine outputs the PLAINTEXT inner node; the hybrid wraps + Signal-encrypts with the
    // logged-in keys. shouldEncrypt defaults true (offer/enc_rekey); revisit if rekey/ack need false.
    const relaySignaling = (rawArg: unknown) => {
      const a = (rawArg && typeof rawArg === 'object') ? rawArg as Record<string, unknown> : {};
      const bytes = toBytes(a.xmlPayload ?? a.xmlPayloadBase64);
      let payload: unknown = a.xmlPayload ?? a.xmlPayloadBase64;
      if (bytes) { try { payload = bytesToB64(bytes.slice(1)); } catch { /* keep raw */ } }
      p.out('handleSignalingXmpp', [{
        peerJid: a.peerJid,
        callId: a.callId,
        payload,
        shouldEncryptBeforeSending: a.shouldEncrypt ?? true,
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

    // ── Synthesize the incoming-call ring (engine → hybrid) ──────────────────────
    // The WASM's onCallEvent runs in the WA backend worker and can't be hooked from this main world.
    // We don't need it: we already decode the offer node, so we BUILD the windows-format
    // CallStateChanged(16)/CallState=ReceivedCall(3) eventDataJson ourselves and relay it. The hybrid
    // delivers it as a VoipBridge "handleVoipCallEvent" → onCallEvent → rings (doc 98 §ring schema).
    const attrStr = (v: unknown): string => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      // call-id and jids may arrive as byte buffers — render printable bytes as a string.
      const u = (v instanceof Uint8Array) ? v : (Array.isArray(v) ? Uint8Array.from(v as number[]) : null);
      if (u) { let s = ''; for (const b of u) s += String.fromCharCode(b & 0xff); return s; }
      if (typeof v === 'object' && 'toString' in (v as object)) return String(v);
      return String(v);
    };
    const synthesizeRing = (node: unknown, peerJid: string) => {
      const n = node as { tag?: string; attrs?: Record<string, unknown>; content?: unknown } | null;
      const attrs = n?.attrs ?? {};
      const children = Array.isArray(n?.content) ? (n?.content as { tag?: string }[]) : null;
      p.log('offer node tag=' + String(n?.tag) + ' attrKeys=' + JSON.stringify(Object.keys(attrs))
        + ' children=' + JSON.stringify(children ? children.map(c => c?.tag) : typeof n?.content));
      const callId = attrStr(attrs['call-id'] ?? attrs['callId'] ?? attrs['id']);
      const creator = attrStr(attrs['call-creator'] ?? attrs['from']) || peerJid;
      const hasVideo = !!children && children.some(c => c?.tag === 'video');
      const ring = {
        CallState: 3, CallId: callId,
        CreatorJid: { str: creator }, PeerJid: peerJid, InitialPeerJid: peerJid,
        VideoEnabled: hasVideo, IsGroupCall: false, IsJoinableCall: false, IsLightweight: false,
      };
      activeRing = ring;
      p.log('synthesized ring: ' + JSON.stringify(ring));
      p.nativeEvent(16, JSON.stringify(ring));
    };
    // Track the active call so we can synthesize state transitions (the engine's onCallEvent is
    // worker-sealed). Re-emit CallStateChanged with a new CallState using the same call_info fields.
    let activeRing: { CallState: number } & Record<string, unknown> | null = null;
    // Set once the user accepts in the hybrid: the engine (a separate device) now owns the live
    // call, so the "accepted-on-another-device" teardown the hybrid receives must NOT dismiss our
    // puppet UI. ponytail: a remote hangup after accept won't auto-dismiss — user clicks End;
    // proper fix is polling the engine stack's getCallInfo() for call-ended.
    let acceptedLocally = false;
    const synthesizeCallState = (state: number, why: string) => {
      if (!activeRing) return;
      const ev = { ...activeRing, CallState: state };
      p.log('synthesized callState=' + state + ' (' + why + ')');
      p.nativeEvent(16, JSON.stringify(ev));
      if (state === 0) activeRing = null;   // None → call cleared
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
      // The engine's own WA app drives voipInit with its real device identity — we don't init it.
      for (const [mm, a] of pendingControl.splice(0)) call(mm, a);
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

    // Diagnostics: the live gatekeeper/environment state that decides which voip stack loads.
    // cr:22885 (gk 22885) picks WAWebVoipStackInterfaceWeb (type:"web", has acceptCall) vs
    // ...Windows (type:"windows", the stub). gkx has no runtime overwrite, so we read, not flip.
    const dumpDiag = (rl: RL) => {
      rl(['gkx', 'WAWebEnvironment', 'WAWebVoipGatingUtils'], (gkxMod, envMod, gateMod) => {
        const gkx = gkxMod as ((id: string) => unknown) | null;
        const env = envMod as Record<string, unknown> | null;
        const gate = gateMod as Record<string, () => unknown> | null;
        const g = (id: string) => { try { return gkx ? gkx(id) : 'no-gkx'; } catch { return 'threw'; } };
        const ge = (fn: string) => { try { return gate && typeof gate[fn] === 'function' ? gate[fn]() : 'n/a'; } catch (e) { return 'threw:' + String(e); } };
        let sub: unknown = 'n/a';
        try { sub = env && typeof env.getSubPlatform === 'function' ? (env.getSubPlatform as () => unknown)() : 'n/a'; } catch { /* getter threw */ }
        p.log('DIAG gk4112=' + JSON.stringify(g('4112')) + ' gk22885=' + JSON.stringify(g('22885'))
          + ' isWindows=' + String(env?.isWindows) + ' subPlatform=' + JSON.stringify(sub)
          + ' isCallingEnabled=' + JSON.stringify(ge('isCallingEnabled')) + ' isVoipDownloadEnabled=' + JSON.stringify(ge('isVoipDownloadEnabled')));
      });
    };

    // Make the engine a consistent web client for any code that reads the isWindows PROPERTY.
    // getSubPlatform reads a closure var we can't un-cache, so we replace the property fn too.
    const forceWebEnvironment = (rl: RL) => {
      rl(['WAWebEnvironment'], (envMod) => {
        const env = envMod as Record<string, unknown> | null;
        if (!env) { p.log('WAWebEnvironment missing'); return; }
        if (env.isWindows === true) {
          try { env.isWindows = false; env.isWeb = true; env.getSubPlatform = () => 'web'; p.log('forced WAWebEnvironment → web (was windows)'); }
          catch (e) { p.log('env override threw: ' + String(e)); }
        } else { p.log('WAWebEnvironment.isWindows=' + String(env.isWindows)); }
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

    // Hook the engine's REAL call-event funnel. The engine is a full web client, so its WASM fires
    // handleWAWebVoipNativeCallEvent(eventType, eventDataJson) for every real state change
    // (ReceivedCall→AcceptSent→CallActive(6)→None) as the engine's own UI updates. We can't relay
    // the raw web-format event to the hybrid (its windows parser would choke), so we read the real
    // CallState and re-drive the hybrid puppet through synthesizeCallState (clean windows format).
    // This advances the hybrid past "Connecting" to in-call, and dismisses it on the real call end.
    let nativeHooked = false;
    let nativeHookTries = 0;
    const hookEngineNativeEvents = (rl: RL) => {
      if (nativeHooked) return;
      rl(['WAWebVoipHandleNativeCallEvent'], (mod) => {
        const H = mod as Record<string, unknown> | null;
        if (!H || typeof H.handleWAWebVoipNativeCallEvent !== 'function') {
          if (++nativeHookTries < 20) setTimeout(() => hookEngineNativeEvents(rl), 1500);
          return;
        }
        if (nativeHooked) return;
        nativeHooked = true;
        const orig = H.handleWAWebVoipNativeCallEvent as (...a: unknown[]) => unknown;
        H.handleWAWebVoipNativeCallEvent = (et: unknown, json: unknown, ...rest: unknown[]) => {
          try {
            let data: Record<string, unknown> | null = null;
            try { data = typeof json === 'string' ? JSON.parse(json) : (json as Record<string, unknown>); } catch { /* not json */ }
            const cs = data ? (data.CallState ?? data.callState ?? data.state) : undefined;
            p.log('REAL native-event et=' + String(et) + ' callState=' + JSON.stringify(cs) + ' data=' + (typeof json === 'string' ? json : JSON.stringify(json ?? '')).slice(0, 280));
            // Drive the hybrid puppet to the engine's REAL state (6=CallActive/in-call, 0=ended).
            if (typeof cs === 'number' && activeRing) synthesizeCallState(cs, 'real-event');
          } catch (e) { p.log('engine native-event hook err: ' + String(e)); }
          return orig(et, json, ...rest);
        };
        p.log('engine handleWAWebVoipNativeCallEvent hooked');
      });
    };

    // Poll WA's logged-in user so main can show the engine for QR pairing (logged-out) or hide it
    // once paired (logged-in). getMaybeMe{Pn,Lid}User return the self user only when logged in.
    const watchLoginState = (rl: RL) => {
      let last: boolean | null = null;
      const tick = () => {
        rl(['WAWebUserPrefsMeUser'], (mod) => {
          const m = mod as Record<string, () => unknown> | null;
          let loggedIn = false;
          try { loggedIn = !!((m?.getMaybeMePnUser?.()) || (m?.getMaybeMeLidUser?.())); } catch { loggedIn = false; }
          if (loggedIn !== last) { last = loggedIn; p.loginState(loggedIn); p.log('login-state: ' + loggedIn); }
        });
        setTimeout(tick, 1500);
      };
      tick();
    };

    const init = () => {
      const rl = getRequireLazy();
      if (!rl) { if (++initTries % 5 === 0) p.log('waiting for requireLazy... ' + initTries + 's'); setTimeout(init, 1000); return; }
      const wd = window as unknown as { crossOriginIsolated?: boolean };
      p.log('requireLazy ready; coI=' + String(wd.crossOriginIsolated) + ' SAB=' + (typeof SharedArrayBuffer));
      patchOutboundSignaling(rl);
      forceCalling(rl);
      forceWebEnvironment(rl);
      watchLoginState(rl);
      loadWapModules(rl);
      setTimeout(() => { dumpDiag(rl); readGating(rl); loadVoip(rl); hookEngineNativeEvents(rl); }, 1200);
    };

    // The engine is its OWN logged-in device: its WA app inits voip with the engine's real device
    // identity and processes its own offers/signaling natively. Only the hybrid's call-control
    // BUTTONS act on the engine's active call — forwarded voipInit/identity/offers carry the
    // HYBRID device's state and would corrupt the engine, so ignore everything else.
    const ENGINE_CONTROLS = new Set(['acceptCall', 'rejectCall', 'endCall', 'setCallMute', 'rejectCallWithoutCallContext']);
    const call = (method: string, args: unknown[]) => {
      if (!ENGINE_CONTROLS.has(method)) { p.log('control ignored (engine self-driven): ' + method); return; }
      if (!stack) { pendingControl.push([method, args]); p.log('queued (stack not ready): ' + method); return; }
      const fn = stack[method];
      if (typeof fn !== 'function') { p.log('control: not a fn: ' + method); return; }
      // Diagnostic: does the engine actually have its own incoming call to act on? (It's a separate
      // device — acceptCall is a no-op if the call never fanned out to it.)
      try { const ci = (stack.getCallInfo as ((...a: unknown[]) => unknown) | undefined)?.(); p.log(method + ' getCallInfo=' + JSON.stringify(ci)); } catch (e) { p.log(method + ' getCallInfo threw: ' + String(e)); }
      try { const r = (fn as (...a: unknown[]) => unknown).apply(stack, args); p.log('control ' + method + ' applied -> ' + JSON.stringify(r)); }
      catch (e) { p.log('control ' + method + ' threw: ' + String(e)); }
      // Drive the hybrid's puppet call UI (the engine's real call events are worker-sealed):
      // accept → Connecting/in-call (and own the call so accepted-elsewhere can't dismiss it);
      // local reject/end → None (dismiss).
      if (method === 'acceptCall') { acceptedLocally = true; synthesizeCallState(4, 'accepted'); }
      else if (method === 'rejectCall' || method === 'endCall' || method === 'rejectCallWithoutCallContext') { acceptedLocally = false; synthesizeCallState(0, 'local end'); }
    };

    // Inbound signaling: decode base64 → node wrapper, THEN call the stack (async decode).
    // ringPeerJid (offer only) → also synthesize the incoming-call ring for the hybrid.
    const callWithWrappedNode = async (method: string, b64Str: string, rest: unknown[], ringPeerJid?: string) => {
      try {
        const wrapped = await wrapNode(b64Str);
        let tag: unknown = '?';
        try { const nn = wrapped.node() as { tag?: unknown }; tag = nn?.tag ?? Object.keys(nn ?? {}); } catch { /* ignore */ }
        p.log(method + ': decoded ok (tag=' + JSON.stringify(tag) + '), applying to stack=' + (!!stack));
        if (ringPeerJid) { try { synthesizeRing(wrapped.node(), ringPeerJid); } catch (e) { p.log('ring synth failed: ' + String(e)); } }
        // Teardown: a terminate/reject node for the active call → dismiss the hybrid call UI (CallState=None).
        else if (typeof tag === 'string' && /^(terminate|reject)$/.test(tag)) {
          if (acceptedLocally) { p.log('teardown ' + tag + ' ignored (engine owns the accepted call)'); }
          else { try { synthesizeCallState(0, tag); } catch (e) { p.log('teardown synth failed: ' + String(e)); } }
        }
        call(method, [wrapped, ...rest]);
      }
      catch (e) { p.log(method + ' wrap/decode failed: ' + String(e)); }
    };

    p.onOffer((pl) => {
      const o = pl as { xmlNodeBase64: string; msgPlatform: string; msgVersion: string; msgE: string; msgT: string; msgOffline: boolean; isOfferNotContact: boolean; peerJid: string; tcToken?: unknown };
      callWithWrappedNode('handleIncomingSignalingOffer', o.xmlNodeBase64,
        [o.msgPlatform, o.msgVersion, o.msgE, o.msgT, o.msgOffline, o.isOfferNotContact, o.peerJid, o.tcToken], o.peerJid);
    });
    p.onSignaling((pl) => { const o = pl as { xmlNodeBase64: string; extraArgs: unknown[] }; callWithWrappedNode('handleIncomingSignalingMessage', o.xmlNodeBase64, o.extraArgs); });
    p.onAck((pl) => { const o = pl as { xmlNodeBase64: string; ackInfoError: unknown; ackInfoType: unknown; peerJid: string }; callWithWrappedNode('handleIncomingSignalingAck', o.xmlNodeBase64, [o.ackInfoError, o.ackInfoType, o.peerJid]); });
    p.onControl((method, args) => call(method, args));

    setTimeout(init, 3000);   // give the bundle time to boot its module registry
  },
  args: [prim],
});
