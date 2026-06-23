// Engine preload: IPC bridge between the main process and the hidden plain-web
// engine window hosting WhatsApp's WASM voip stack.
//
// Loaded ONLY by the engine window (BrowserWindow with partition: persist:wa-engine).
// Not used by the hybrid main window (which uses src/preload.ts).
//
// ─── IPC contract (engine side) ───────────────────────────────────────────────
//   Receives from main:
//     'wa-engine:push-offer'      EngineOfferPayload  (incoming call offer)
//     'wa-engine:push-signaling'  EngineSignalingPayload (mid-call signaling)
//     'wa-engine:push-ack'        EngineAckPayload       (accept / nack)
//   Sends to main:
//     'wa-engine:ready'           {hooked: string[], total: number}
//     'wa-engine:probe-result'    {ok: boolean, methods?: string[], why?: string}
//     'wa-engine:outbound-signaling'  (method: string, args: unknown[])
//
// ─── What this does ───────────────────────────────────────────────────────────
//   1. After the plain-web bundle loads, runs a module probe: tries to load
//      WAWebVoipStackInterfaceWeb via requireLazy. In plain-web mode this SHOULD
//      succeed (the module is in the bundle's manifest). Under ?windows=1 it fails —
//      that's the impossibility that requires this two-window design.
//   2. Intercepts the WASM stack's named outbound-signaling methods and forwards
//      them to main, which relays them to the hybrid window's sharedTw bus.
//   3. On push-offer from main, feeds the (already Signal-decrypted) offer payload
//      into the WASM engine's handleIncomingSignalingOffer entry point.
//
// ─── Known limitation ─────────────────────────────────────────────────────────
//   The named-callback interception here (handleSignalingXmpp etc.) captures the
//   engine's high-level signaling output. However, the WASM engine also sends
//   signaling directly via its own WebSocket (a separate device session). That
//   transport-level path is NOT intercepted here — only the named callback surface.
//   This means the engine's actual signaling will travel on the ENGINE's socket,
//   not the hybrid window's socket. Full unification requires patching the bundle's
//   transport layer. See NOTES.md §Blockers.

import { contextBridge, ipcRenderer } from 'electron';

// ─── Isolated-world transport primitives ──────────────────────────────────────
// These cross the context-isolation boundary via the contextBridge API.
// Functions are serialized by Electron's contextBridge (not structured-clone);
// they call ipcRenderer inside the isolated world but are invokable from main-world
// code passed as args to executeInMainWorld.

const prim = {
  // engine → main
  sendReady:       (info: unknown) =>
    ipcRenderer.send('wa-engine:ready', info),
  sendProbe:       (result: unknown) =>
    ipcRenderer.send('wa-engine:probe-result', result),
  sendOutbound:    (method: string, args: unknown[]) =>
    ipcRenderer.send('wa-engine:outbound-signaling', method, args),
  sendPathBResult: (result: unknown) =>
    ipcRenderer.send('wa-engine:pathb-result', result),

  // main → engine (register listeners; called once during setup)
  onPushOffer:     (h: (pl: unknown) => void) =>
    ipcRenderer.on('wa-engine:push-offer',     (_e, pl) => h(pl)),
  onPushSignaling: (h: (pl: unknown) => void) =>
    ipcRenderer.on('wa-engine:push-signaling', (_e, pl) => h(pl)),
  onPushAck:       (h: (pl: unknown) => void) =>
    ipcRenderer.on('wa-engine:push-ack',       (_e, pl) => h(pl)),
  onRunPathB:      (h: () => void) =>
    ipcRenderer.on('wa-engine:run-pathb',      () => h()),

  // round-trip test channels
  sendRoundtripEvent:   (method: string, args: unknown[]) =>
    ipcRenderer.send('wa-engine:roundtrip-outbound', method, args),
  sendRoundtripVerdict: (data: unknown) =>
    ipcRenderer.send('wa-engine:roundtrip-verdict', data),
  onRunRoundtrip: (h: (payload: unknown) => void) =>
    ipcRenderer.on('wa-engine:run-roundtrip', (_e, payload) => h(payload)),
};

// Expose to page JS so ENGINE_DIAGNOSTIC_JS in engine-window.ts can call
// sendProbe (the diagnostic is injected via executeJavaScript, main world).
contextBridge.exposeInMainWorld('__waEngineIpc', prim);

// ─── Main-world hook ──────────────────────────────────────────────────────────
// Runs inside the page's JS context (same world as requireLazy / the WA bundle).
// Receives `prim` via the args transfer; prim's functions cross the boundary
// because contextBridge wraps them — they call ipcRenderer under the hood.

contextBridge.executeInMainWorld({
  func: (p: typeof prim) => {
    // Helper: safely get requireLazy from the page
    const getRequireLazy = (): ((mods: string[], cb: (m: unknown) => void) => void) | null =>
      (window as unknown as { requireLazy?: (mods: string[], cb: (m: unknown) => void) => void })
        .requireLazy ?? null;

    // ── Round-trip shared state ───────────────────────────────────────────────
    // Set by p.onRunRoundtrip after the WASM stack factory is called.
    // Read/written by p.onPushOffer to feed offers and schedule acceptCall.
    let rtStack: Record<string, unknown> | null = null;
    const rtFiredCallbacks: string[] = [];
    let rtLastPeerJid: string | null = null;   // peerJid from most-recent real offer
    let rtOfferFed = false;                     // true once offer was fed to stack
    let rtEngineReacted = false;                // true once engine emits any event after offer
    const rtEvidence: string[] = [];            // event names captured after offer

    // ── 1. Module probe ────────────────────────────────────────────────────────
    // Runs after a short delay to give the bundle time to initialize its module
    // registry. Confirms that WAWebVoipStackInterfaceWeb is accessible in plain-web
    // mode — expected: ok=true with a method list. This is the key diagnostic for
    // proving the two-window approach is viable at the module-load level.
    const probe = () => {
      let tries = 0;
      const attempt = () => {
        const req = getRequireLazy();
        if (!req) {
          if (++tries < 40) { setTimeout(attempt, 1000); return; }
          p.sendProbe({ ok: false, why: 'requireLazy not available after 40s' });
          return;
        }
        try {
          req(['WAWebVoipStackInterfaceWeb'], (mod) => {
            if (!mod) {
              p.sendProbe({ ok: false, why: 'module resolved to null/undefined' });
              return;
            }
            const keys = Object.keys(mod as object);
            const methods = keys.filter(k => typeof (mod as Record<string, unknown>)[k] === 'function');
            p.sendProbe({ ok: true, methods: methods.slice(0, 30), totalKeys: keys.length });
            // Hook the engine while we have a reference to it
            hookEngine(mod as Record<string, unknown>);
          });
        } catch (e) {
          if (++tries < 20) { setTimeout(attempt, 500); return; }
          p.sendProbe({ ok: false, why: String((e as Error)?.message ?? e) });
        }
      };
      attempt();
    };

    // ── 2. Outbound intercept ──────────────────────────────────────────────────
    // Patch the WASM engine's named callback surface so outbound signaling events
    // are forwarded to main → hybrid sharedTw, rather than only going to the engine's
    // own subscribers. This intercept is best-effort and bundle-version-coupled.
    //
    // NOTE: This does NOT intercept the engine's transport-layer socket sends.
    // The engine will ALSO send signaling on its own WA WebSocket (the engine's
    // linked-device session). The named-callback relay here is ADDITIONAL, not a
    // replacement for that transport. Full socket unification is a separate
    // problem. See NOTES.md §Blockers.
    const OUTBOUND_METHODS = [
      'handleSignalingXmpp',
      'handleVoipCall',
      'handleVoipReady',
      'handleCallAgain',
      'handleLidCallerDisplayInfo',
      'requestOpenChat',
      'requestDeviceJidList',
      'requestPhoneNumberJid',
      'requestLidJid',
    ];
    let hooked = false;
    const hookEngine = (voipStack: Record<string, unknown>) => {
      if (hooked) return;
      hooked = true;
      const wired: string[] = [];
      for (const method of OUTBOUND_METHODS) {
        if (typeof voipStack[method] === 'function') {
          const orig = voipStack[method] as (...args: unknown[]) => unknown;
          voipStack[method] = (...args: unknown[]) => {
            p.sendOutbound(method, args);
            return orig.apply(voipStack, args);
          };
          wired.push(method);
        }
      }
      p.sendReady({ hooked: wired, total: OUTBOUND_METHODS.length });
    };

    // ── 3. Incoming: push-offer → WASM engine ─────────────────────────────────
    // The hybrid VoipBridge.handleIncomingSignalingOffer forwards the already
    // Signal-decrypted offer here. We feed it to the WASM engine's own
    // handleIncomingSignalingOffer entry point so the engine can drive its call FSM.
    //
    // The engine's FSM will then emit outbound signaling (via the hooked surface
    // above) and manage media (via its own WebRTC/WASM stack).
    p.onPushOffer((payload) => {
      const pl = payload as {
        xmlNodeBase64: string;
        msgPlatform: string;
        msgVersion: string;
        msgE: string;
        msgT: string;
        msgOffline: boolean;
        isOfferNotContact: boolean;
        peerJid: string;
      };
      console.log('[wa-engine-preload] push-offer for', pl.peerJid);

      // ROUNDTRIP mode: use the pre-initialized factory instance (rtStack) directly.
      // rtStack is set by p.onRunRoundtrip after subscribe+voipInit succeed.
      // Using the instance avoids re-loading the module on every offer AND ensures we
      // call handleIncomingSignalingOffer on the concrete stack object (not the module).
      if (rtStack) {
        const stack = rtStack;
        rtLastPeerJid = pl.peerJid;
        if (typeof stack.handleIncomingSignalingOffer === 'function') {
          let offerErr: string | null = null;
          try {
            (stack.handleIncomingSignalingOffer as (...a: unknown[]) => void)(
              pl.xmlNodeBase64, pl.msgPlatform, pl.msgVersion,
              pl.msgE, pl.msgT, pl.msgOffline, pl.isOfferNotContact, pl.peerJid,
            );
            rtOfferFed = true;
            console.log('[roundtrip] OFFER-FED ' + JSON.stringify({ peerJid: pl.peerJid }));
          } catch (e) {
            offerErr = String((e as Error)?.message ?? e);
            if (/enc|decrypt|key|cipher|signal/i.test(offerErr)) {
              console.log('[roundtrip] OFFER-ENC-ISSUE ' + JSON.stringify({ error: offerErr }));
            } else {
              console.error('[roundtrip] OFFER-ERROR ' + offerErr);
            }
          }
          // Try acceptCall 2 s after offer regardless of engine reaction — the engine
          // moves to ReceivedCall(3) and waits; acceptCall is needed to elicit outbound.
          if (!offerErr) {
            setTimeout(() => {
              const st = rtStack;
              if (!st) return;
              const jid = rtLastPeerJid ?? pl.peerJid;
              console.log('[roundtrip] ACCEPT-CALLING ' + JSON.stringify({ peerJid: jid, engineReacted: rtEngineReacted }));
              if (typeof st.acceptCall === 'function') {
                try {
                  (st.acceptCall as (...a: unknown[]) => void)(jid, false);
                  console.log('[roundtrip] ACCEPT-CALLED ' + JSON.stringify({ threw: false, peerJid: jid }));
                } catch (e) {
                  const errStr = String((e as Error)?.message ?? e);
                  console.log('[roundtrip] ACCEPT-CALLED ' + JSON.stringify({ threw: true, error: errStr }));
                }
              } else {
                console.warn('[roundtrip] ACCEPT-CALLED skipped — acceptCall not a fn');
              }
            }, 2000);
          }
        } else {
          console.warn('[roundtrip] handleIncomingSignalingOffer not a fn on rtStack');
        }
        return; // don't fall through to the module-reload path
      }

      // ENGINE_MODE (no round-trip): re-load the module per call (best-effort).
      // ponytail: this path calls handleIncomingSignalingOffer on the MODULE, which is
      // wrong (it's on the factory instance). It works only if the module itself exposes
      // the method directly — use WA_ROUNDTRIP=1 for a correct instance-based flow.
      const req = getRequireLazy();
      if (!req) {
        console.warn('[wa-engine-preload] requireLazy not available for push-offer');
        return;
      }
      try {
        req(['WAWebVoipStackInterfaceWeb'], (mod) => {
          if (!mod) {
            console.warn('[wa-engine-preload] WAWebVoipStackInterfaceWeb not found for push-offer');
            return;
          }
          hookEngine(mod as Record<string, unknown>);
          const vs = mod as Record<string, unknown>;
          if (typeof vs.handleIncomingSignalingOffer === 'function') {
            (vs.handleIncomingSignalingOffer as (...a: unknown[]) => void)(
              pl.xmlNodeBase64, pl.msgPlatform, pl.msgVersion,
              pl.msgE, pl.msgT, pl.msgOffline, pl.isOfferNotContact, pl.peerJid,
            );
          } else {
            console.warn(
              '[wa-engine-preload] handleIncomingSignalingOffer not on module;',
              'available keys:', Object.keys(vs).slice(0, 20),
            );
          }
        });
      } catch (e) {
        console.error('[wa-engine-preload] push-offer error:', e);
      }
    });

    // ── 4. Incoming: push-signaling → WASM engine ─────────────────────────────
    p.onPushSignaling((payload) => {
      const pl = payload as { xmlNodeBase64: string; extraArgs: unknown[] };
      const req = getRequireLazy();
      if (!req) return;
      try {
        req(['WAWebVoipStackInterfaceWeb'], (mod) => {
          if (!mod) return;
          const vs = mod as Record<string, unknown>;
          if (typeof vs.handleIncomingSignalingMessage === 'function') {
            (vs.handleIncomingSignalingMessage as (...a: unknown[]) => void)(
              pl.xmlNodeBase64, ...pl.extraArgs,
            );
          }
        });
      } catch (e) {
        console.error('[wa-engine-preload] push-signaling error:', e);
      }
    });

    // ── 5. Incoming: push-ack → WASM engine ───────────────────────────────────
    p.onPushAck((payload) => {
      const pl = payload as {
        xmlNodeBase64: string;
        ackInfoError: unknown;
        ackInfoType: unknown;
        peerJid: string;
      };
      const req = getRequireLazy();
      if (!req) return;
      try {
        req(['WAWebVoipStackInterfaceWeb'], (mod) => {
          if (!mod) return;
          const vs = mod as Record<string, unknown>;
          if (typeof vs.handleIncomingSignalingAck === 'function') {
            (vs.handleIncomingSignalingAck as (...a: unknown[]) => void)(
              pl.xmlNodeBase64, pl.ackInfoError, pl.ackInfoType, pl.peerJid,
            );
          }
        });
      } catch (e) {
        console.error('[wa-engine-preload] push-ack error:', e);
      }
    });

    // ── Path B feasibility probe ─────────────────────────────────────────────
    // Triggered by wa-engine:run-pathb IPC from main when WA_PATHB=1.
    // Runs in a LOGGED-OUT throwaway plain-web session (no QR needed).
    //
    // Investigates two unknowns (U1 + U2) and logs every step with a [path-b]
    // prefix so the user can paste the terminal output directly.
    //
    //  U1 — can WAWebVoipStackInterfaceWeb be LOADED in plain-web (pre-login)?
    //       Three load paths are tried in parallel: U1a, U1b, U1c.
    //  U2 — once obtained, what does the interface's API surface look like, and
    //       what does it demand when fed a synthetic offer?
    p.onRunPathB(() => {
      const pb = (tag: string, data: unknown) =>
        console.log('[path-b] ' + tag + ' ' + JSON.stringify(data));

      pb('PROBE-START', { note: 'path-b feasibility spike — logged-out plain-web session' });

      // ── Browser capability snapshot (synchronous, no requireLazy needed) ────
      const win  = window as unknown as Record<string, unknown>;
      pb('CAPS', {
        crossOriginIsolated: win.crossOriginIsolated,
        SharedArrayBuffer:   typeof SharedArrayBuffer,
        RTCPeerConnection:   typeof RTCPeerConnection,
        WebTransport:        typeof WebTransport,
        Atomics:             typeof Atomics,
      });

      const rl   = win.requireLazy as ((mods: string[], cb: (m: unknown) => void) => void) | undefined;
      const sreq = win.require    as ((modId: string) => unknown) | undefined;

      let stackRef: Record<string, unknown> | null = null;
      let stackVia = 'none';

      // ── U1c — synchronous require('cr:22885') ───────────────────────────────
      // cr:22885 is the cross-resource alias resolved at bundle-manifest level.
      // In ?windows=1 mode → native stub; in plain-web mode → WASM createWAWebVoipStackInterface.
      // (doc 43 §2.1 — 'a5gdgRhdCri.js:4820 → require("cr:22885").createWAWebVoipStackInterface()')
      try {
        if (!sreq) {
          pb('U1c', { method: 'require(cr:22885)', ok: false, why: 'window.require absent' });
        } else {
          const m = sreq('cr:22885') as Record<string, unknown> | null;
          if (!m) {
            pb('U1c', { method: 'require(cr:22885)', ok: false, why: 'null' });
          } else if (typeof m.createWAWebVoipStackInterface !== 'function') {
            pb('U1c', {
              method: 'require(cr:22885)', ok: false,
              why: 'createWAWebVoipStackInterface not a fn',
              keys: Object.keys(m).slice(0, 12),
            });
          } else {
            const iface = (m.createWAWebVoipStackInterface as () => unknown)() as Record<string, unknown> | null;
            if (iface) {
              pb('U1c', {
                method: 'require(cr:22885)', ok: true,
                type: iface.type,
                keys: Object.keys(iface).slice(0, 20),
              });
              stackRef = iface;
              stackVia = 'U1c';
            } else {
              pb('U1c', { method: 'require(cr:22885)', ok: false, why: 'factory returned null' });
            }
          }
        }
      } catch (e) {
        pb('U1c', { method: 'require(cr:22885)', ok: false, error: String((e as Error)?.message ?? e) });
      }

      // ── Gating flags probe (async, best-effort, runs in background) ─────────
      // Expected logged-out: callingEnabled:false (no server flag), unsupportedReason:null
      // With CALL_SHIMS injected: voipDownloadEnabled should become true.
      if (rl) {
        setTimeout(() => {
          try {
            rl(['WAWebVoipGatingUtils'], (m) => {
              const g = m as Record<string, unknown> | null;
              if (!g) { pb('GATING', { error: 'WAWebVoipGatingUtils resolved null' }); return; }
              pb('GATING', {
                isCallingEnabled:    typeof g.isCallingEnabled    === 'function' ? (g.isCallingEnabled    as () => unknown)() : 'n/a',
                isVoipDownloadEnabled: typeof g.isVoipDownloadEnabled === 'function' ? (g.isVoipDownloadEnabled as () => unknown)() : 'n/a',
                isVoipInitEnabled:   typeof g.isVoipInitEnabled   === 'function' ? (g.isVoipInitEnabled   as () => unknown)() : 'n/a',
                unsupportedReason:   typeof g.getUnsupportedBrowserReason === 'function' ? (g.getUnsupportedBrowserReason as () => unknown)() : 'n/a',
              });
            });
          } catch (e) { pb('GATING', { error: String((e as Error)?.message ?? e) }); }
        }, 1500);
      }

      // ── afterAsync: called when both U1a and U1b settle (fire or timeout) ───
      const afterAsync = (u1aR: unknown, u1bR: unknown) => {
        pb('U1a', u1aR);
        pb('U1b', u1bR);
        pb('STACK-OBTAINED', { via: stackVia });

        // Finishes the probe and reports to main
        const finish = (u2: unknown) => {
          pb('PROBE-DONE', { u1Loadable: stackVia !== 'none', via: stackVia, u2 });
          p.sendPathBResult({ u1Loadable: stackVia !== 'none', via: stackVia, u2 });
        };

        if (!stackRef) {
          // No stack obtained from any path — U2 is impossible
          finish({ skipped: 'no stack obtained from U1a/U1b/U1c' });
          return;
        }

        // Non-nullable alias — TypeScript can't narrow `stackRef` across closure
        // boundaries (it's a `let`, so any async callback could reassign it).
        const stack = stackRef;

        // ── API surface enumeration — walk prototype chain ──────────────────
        // Class instances (like WAWebVoipStackInterfaceWeb) keep their methods
        // on the prototype, not as own properties. Object.keys() returns [] for
        // such instances. Walk getPrototypeOf() to collect everything.
        const allMethods: { name: string; arity: number | string }[] = [];
        const seen = new Set<string>();
        let proto: object | null = stack;
        while (proto && proto !== Object.prototype) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (seen.has(name) || name === 'constructor') continue;
            seen.add(name);
            try {
              const desc = Object.getOwnPropertyDescriptor(proto, name);
              if (desc && typeof desc.value === 'function') {
                allMethods.push({ name, arity: (desc.value as { length?: number }).length ?? '?' });
              }
            } catch { /* live accessor that throws — skip */ }
          }
          proto = Object.getPrototypeOf(proto) as object | null;
        }
        const ownKeys = Object.keys(stack);
        pb('API-SURFACE', {
          ownKeys: ownKeys.length,
          protoMethods: allMethods.length,
          methods: allMethods.slice(0, 60),
          ownNonFns: ownKeys.filter(k => typeof stack[k] !== 'function').slice(0, 20),
        });

        // ── Wire callback observers for U2 ───────────────────────────────────
        // We intercept the outbound-signaling surface so we can observe which
        // ToWeb callbacks fire in response to the synthetic offer.
        const u2FiredCbs: string[] = [];
        const WATCH = [
          'handleSignalingXmpp', 'handleVoipCall', 'handleVoipReady',
          'handleCallAgain', 'requestOpenChat', 'requestDeviceJidList',
          'requestPhoneNumberJid', 'requestLidJid',
        ];
        for (const cb of WATCH) {
          if (typeof stack[cb] === 'function') {
            const orig = stack[cb] as (...a: unknown[]) => unknown;
            ((name: string) => {
              stack[name] = (...args: unknown[]) => {
                u2FiredCbs.push(name);
                pb('U2-CALLBACK-FIRED', { method: name, argPreview: JSON.stringify(args).slice(0, 400) });
                return orig.apply(stack, args);
              };
            })(cb);
          }
        }

        // ── U2 — init attempt ────────────────────────────────────────────────
        // Some WASM stacks require explicit init before they accept offers.
        // voipInit (or similar) is the likely entry point. Log what it demands.
        let initResult: unknown = { skipped: 'voipInit not a fn on stack' };
        if (typeof stack.voipInit === 'function') {
          try {
            (stack.voipInit as () => void)();
            initResult = { ok: true };
            pb('U2-INIT', { method: 'voipInit', ok: true });
          } catch (e) {
            initResult = { ok: false, error: String((e as Error)?.message ?? e) };
            pb('U2-INIT', { method: 'voipInit', ok: false, error: String((e as Error)?.message ?? e) });
          }
        } else {
          pb('U2-INIT', initResult);
        }

        // ── U2 — synthetic offer ─────────────────────────────────────────────
        // Real flow (doc 41 §3.4 / doc 43 §2.3): JS Signal-decrypts <enc>,
        // serialises the offer as a WAP binary tree node (base64), then calls
        // stack.handleIncomingSignalingOffer(xmlNodeBase64, platform, ver, e, t,
        //   offline, isNotContact, peerJid).
        // We pass 3-byte WAP garbage to observe what the engine asserts / requests.
        // Goal: learn dependencies, NOT complete a call.
        if (typeof stack.handleIncomingSignalingOffer !== 'function') {
          pb('U2-OFFER', { skipped: 'handleIncomingSignalingOffer not a fn on stack' });
          finish({ init: initResult, offer: 'no-fn', callbacksFired: [] });
          return;
        }

        // btoa of 3-byte garbage — an intentionally invalid WAP node.
        // Observe: does the engine throw immediately? does it attempt key derivation?
        // does it request a device list (RequestDeviceJidList callback)? does it
        // try to emit outbound signaling (handleSignalingXmpp callback)?
        const SYNTH_B64 = btoa('\x01\x05\x00');
        let offerResult: Record<string, unknown>;
        try {
          (stack.handleIncomingSignalingOffer as (...a: unknown[]) => void)(
            SYNTH_B64,                          // xmlNodeBase64 (WAP-encoded decrypted offer)
            '0',                                // msgPlatform (Android = 0)
            '0',                                // msgVersion
            '',                                 // msgE
            String(Date.now()),                 // msgT (Unix timestamp ms)
            false,                              // msgOffline
            false,                              // isOfferNotContact
            '19195550001@s.whatsapp.net',       // peerJid (placeholder)
          );
          offerResult = { threw: false };
          pb('U2-OFFER', { called: true, threw: false });
        } catch (e) {
          offerResult = { threw: true, error: String((e as Error)?.message ?? e) };
          pb('U2-OFFER', { called: true, threw: true, error: String((e as Error)?.message ?? e) });
        }

        // Wait 2 s for async callbacks the offer may have triggered
        setTimeout(() => {
          pb('U2-CALLBACKS-SUMMARY', { fired: u2FiredCbs });
          finish({ init: initResult, offer: offerResult, callbacksFired: u2FiredCbs });
        }, 2000);
      }; // end afterAsync

      // ── U1a and U1b: async requireLazy probes ────────────────────────────────
      if (!rl) {
        pb('WARN', { msg: 'window.requireLazy absent — U1a and U1b skipped; only U1c ran' });
        afterAsync(
          { method: 'requireLazy(WAWebVoipStackInterfaceWeb)', skipped: true, why: 'no requireLazy' },
          { method: 'requireLazy(WAWebVoipStackInterface)', skipped: true, why: 'no requireLazy' },
        );
        return;
      }

      let pending = 2;
      let u1aR: unknown = null;
      let u1bR: unknown = null;
      const decr = () => { if (--pending <= 0) afterAsync(u1aR, u1bR); };

      // U1a — requireLazy(['WAWebVoipStackInterfaceWeb'], cb)
      // This is the direct module export (doc 43 §2.1: DXbR99V6DKN.js:3925).
      // In plain-web mode the manifest should include this; under ?windows=1 it is absent.
      // Timeout: 12 s (generous — lazy chunk fetches over network take 1–4 s).
      let u1aSettled = false;
      setTimeout(() => {
        if (!u1aSettled) {
          u1aSettled = true;
          u1aR = { method: 'requireLazy(WAWebVoipStackInterfaceWeb)', fired: false, result: 'TIMEOUT-12s' };
          decr();
        }
      }, 12000);
      try {
        rl(['WAWebVoipStackInterfaceWeb'], (mod) => {
          if (u1aSettled) return;
          u1aSettled = true;
          const m = mod as Record<string, unknown> | null;
          if (!m || typeof m.createWAWebVoipStackInterface !== 'function') {
            u1aR = {
              method: 'requireLazy(WAWebVoipStackInterfaceWeb)',
              fired: true, ok: false,
              why: !m ? 'null mod' : 'no createWAWebVoipStackInterface fn',
              moduleKeys: m ? Object.keys(m).slice(0, 20) : null,
            };
            decr(); return;
          }
          // IMPORTANT: the module exports only the factory. Call it to get the
          // concrete stack instance (the object with handleIncomingSignalingOffer etc.).
          // Try arg-less first (doc 43 §2.1 shows it called with no args); if it
          // throws (e.g. isVoipDownloadEnabled guard), retry with {} and log the error.
          let inst: Record<string, unknown> | null = null;
          let factoryErr: string | null = null;
          try {
            inst = (m.createWAWebVoipStackInterface as () => unknown)() as Record<string, unknown> | null;
          } catch (e1) {
            factoryErr = String((e1 as Error)?.message ?? e1);
            try {
              inst = (m.createWAWebVoipStackInterface as (c: unknown) => unknown)({}) as Record<string, unknown> | null;
              factoryErr = null; // retry with {} succeeded
            } catch (e2) {
              factoryErr += ' | with-{}: ' + String((e2 as Error)?.message ?? e2);
            }
          }
          u1aR = {
            method: 'requireLazy(WAWebVoipStackInterfaceWeb)',
            fired: true, ok: !!inst,
            moduleKeys: Object.keys(m).slice(0, 10),
            factory: inst ? 'ok' : 'failed',
            factoryErr,
          };
          // Prefer factory instance over any previously-set U1b/U1c result —
          // this is the concrete WAWebVoipStackInterfaceWeb implementation.
          if (inst) { stackRef = inst; stackVia = 'U1a'; }
          decr();
        });
      } catch (e) {
        if (!u1aSettled) {
          u1aSettled = true;
          u1aR = { method: 'requireLazy(WAWebVoipStackInterfaceWeb)', fired: false, error: String((e as Error)?.message ?? e) };
          decr();
        }
      }

      // U1b — requireLazy(['WAWebVoipStackInterface'], m => m.getVoipStackInterface())
      // The higher-level selector (doc 43 §2.1): branches on a.type — 'web' → WASM,
      // 'windows' → native. Should return type:'web' in plain-web mode.
      let u1bSettled = false;
      setTimeout(() => {
        if (!u1bSettled) {
          u1bSettled = true;
          u1bR = { method: 'requireLazy(WAWebVoipStackInterface).getVoipStackInterface', fired: false, result: 'TIMEOUT-12s' };
          decr();
        }
      }, 12000);
      try {
        rl(['WAWebVoipStackInterface'], (mod) => {
          if (u1bSettled) return;
          u1bSettled = true;
          const sm = mod as { getVoipStackInterface?: () => unknown } | null;
          if (!sm || typeof sm.getVoipStackInterface !== 'function') {
            u1bR = {
              method: 'requireLazy(WAWebVoipStackInterface).getVoipStackInterface',
              fired: true, ok: false,
              why: !sm ? 'null mod' : 'no getVoipStackInterface fn',
            };
            decr(); return;
          }
          try {
            const iface = sm.getVoipStackInterface() as Record<string, unknown> | null;
            const ok = !!iface;
            u1bR = {
              method: 'requireLazy(WAWebVoipStackInterface).getVoipStackInterface',
              fired: true, ok,
              type: iface ? iface.type : null,
              keys: iface ? Object.keys(iface).slice(0, 20) : null,
            };
            if (ok && iface && !stackRef) { stackRef = iface; stackVia = 'U1b'; }
          } catch (e2) {
            u1bR = {
              method: 'requireLazy(WAWebVoipStackInterface).getVoipStackInterface',
              fired: true, ok: false, error: String((e2 as Error)?.message ?? e2),
            };
          }
          decr();
        });
      } catch (e) {
        if (!u1bSettled) {
          u1bSettled = true;
          u1bR = { method: 'requireLazy(WAWebVoipStackInterface).getVoipStackInterface', fired: false, error: String((e as Error)?.message ?? e) };
          decr();
        }
      }
    }); // end p.onRunPathB

    // ── Round-trip test (WA_ROUNDTRIP=1) ─────────────────────────────────────
    // Triggered by wa-engine:run-roundtrip IPC ~4 s after page load.
    //
    // Four outbound-channel approaches tried in parallel (doc 43 §2.3):
    //  A. Patch WAWebVoipSendSignalingXmpp — the module the WASM engine calls
    //     directly for outbound signaling (primary path, bundle-documented).
    //  B. Pass capturing-Proxy as factory arg — the native variant wraps its host
    //     bridge this way; the WASM variant may do the same.
    //  C. Assign capturing fns to settable own-key callback slots (the 58 ownKeys
    //     may include null/fn-typed assignable callback properties).
    //  D. Try known setter method names on the prototype (setCallbacks, setDelegate…)
    //
    // All four are attempted regardless; OUTBOUND-CHANNEL logs which worked.
    // VERDICT fires as soon as ANY mechanism captures a signaling emission.
    p.onRunRoundtrip((payload) => {
      const pl = payload as { startCallJid?: string | null };
      const startCallJid: string | null = pl.startCallJid ?? null;
      const rt = (tag: string, data: unknown) =>
        console.log('[roundtrip] ' + tag + ' ' + JSON.stringify(data));

      rt('INIT-START', { startCallJid });

      const rl = getRequireLazy();
      if (!rl) { rt('INIT-FAIL', { why: 'requireLazy absent' }); return; }

      // Verdict — three-way, defined early so all approaches can call sendVerdict.
      let verdictSent = false;
      const sendVerdict = () => {
        if (verdictSent) return;
        verdictSent = true;
        const keyCbs = rtFiredCallbacks.filter(n => /key|cipher|ssrc|hkdf|hmac|derive/i.test(n));
        const emittedSignalingAfterAccept = rtFiredCallbacks.some(n => /WAWebVoipSendSignalingXmpp/i.test(n));
        const verdict = {
          offerAcceptedByEngine: rtEngineReacted,
          emittedSignalingAfterAccept,
          keyCallbacks: keyCbs,
          evidence: [...rtEvidence],
        };
        rt('VERDICT', verdict);
        p.sendRoundtripVerdict(verdict);
      };

      // Universal capturing proxy — used as factory delegate arg AND for setter methods.
      const capProxy = new Proxy({} as Record<string, unknown>, {
        get: (_t, prop) => (...args: unknown[]) => {
          const name = String(prop);
          rtFiredCallbacks.push(name);
          const argsPreview = JSON.stringify(args).slice(0, 400);
          rt('ENGINE-OUTBOUND', { method: name, argsPreview });
          if (/key|cipher|ssrc|hkdf|hmac|derive/i.test(name + argsPreview)) {
            rt('KEY-CALLBACK', { name, argsPreview });
          }
          p.sendRoundtripEvent(name, args);
          if (/signaling|xmpp|voipCall|voipReady/i.test(name)) {
            setTimeout(sendVerdict, 2000);
          }
        },
      });

      // ── Approach A: patch WAWebVoipSendSignalingXmpp (doc 43 §2.3) ──────────
      // The WASM engine calls functions in this module for outbound signaling — it
      // does NOT call back via subscribe(). Patching here captures every emission.
      rl(['WAWebVoipSendSignalingXmpp'], (sigMod) => {
        const sm = sigMod as Record<string, unknown> | null;
        if (!sm) {
          rt('APPROACH-A', { ok: false, why: 'WAWebVoipSendSignalingXmpp null' });
          return;
        }
        const allKeys = Object.keys(sm);
        const fns = allKeys.filter(k => typeof sm[k] === 'function');
        rt('APPROACH-A', { ok: true, totalKeys: allKeys.length, patchedFns: fns });
        for (const fnName of fns) {
          const orig = sm[fnName] as (...a: unknown[]) => unknown;
          sm[fnName] = (...args: unknown[]) => {
            const name = 'WAWebVoipSendSignalingXmpp.' + fnName;
            rtFiredCallbacks.push(name);
            rt('ENGINE-OUTBOUND', { method: name, argsPreview: JSON.stringify(args).slice(0, 400) });
            p.sendRoundtripEvent(name, args);
            setTimeout(sendVerdict, 2000); // any signaling fn = positive signal
            return orig.apply(sm, args);
          };
        }
      });

      // ── Approach E: patch WADynamicRouterAsync (doc 43 §2.2) ────────────────
      // The engine delivers state changes (CallState transitions, VoipEvent) via
      // frontendSendAndReceive inside WADynamicRouterAsync — a separate channel from
      // the outbound-stanza path. Patching here captures ReceivedCall(3) and any
      // other in-process events the engine fires after processing the offer.
      rl(['WADynamicRouterAsync'], (routerMod) => {
        const router = routerMod as Record<string, unknown> | null;
        if (!router) {
          rt('APPROACH-E', { ok: false, why: 'WADynamicRouterAsync null' });
          return;
        }
        const fns = Object.keys(router).filter(k => typeof router[k] === 'function');
        rt('APPROACH-E', { ok: true, patchedFns: fns });
        for (const fnName of fns) {
          const orig = router[fnName] as (...a: unknown[]) => unknown;
          router[fnName] = (...args: unknown[]) => {
            const name = 'WADynamicRouterAsync.' + fnName;
            const argsPreview = JSON.stringify(args).slice(0, 400);
            rtFiredCallbacks.push(name);
            rt('ENGINE-EVENT', { name, argsPreview });
            p.sendRoundtripEvent(name, args);
            // Any event after offer fed = engine accepted/reacted to the offer
            if (rtOfferFed) {
              rtEngineReacted = true;
              rtEvidence.push(fnName + ':' + argsPreview.slice(0, 80));
              rt('OFFER-ACCEPTED-BY-ENGINE', { evidence: rtEvidence });
            }
            return orig.apply(router, args);
          };
        }
      });

      // Also load WAWebVoipWaCallEnums so we can decode CallState numbers in events.
      rl(['WAWebVoipWaCallEnums'], (enumMod) => {
        const e = enumMod as Record<string, unknown> | null;
        if (!e) { rt('CALL-ENUMS', { ok: false }); return; }
        // Log CallState values so event args can be decoded from the log.
        const cs = e.CallState as Record<string, unknown> | null;
        rt('CALL-ENUMS', { ok: true, CallState: cs ? Object.entries(cs).slice(0, 20) : null });
      });

      // ── Approach B/C/D: factory arg + surface inspection ────────────────────
      rl(['WAWebVoipStackInterfaceWeb'], (mod) => {
        const m = mod as Record<string, unknown> | null;
        if (!m || typeof m.createWAWebVoipStackInterface !== 'function') {
          rt('INIT-FAIL', { why: 'module absent or no factory', modNull: !m });
          return;
        }

        // Approach B: factory(capProxy) — mirrors native variant which wraps its host bridge.
        let inst: Record<string, unknown> | null = null;
        let factoryChannel = 'arg-less';
        try {
          inst = (m.createWAWebVoipStackInterface as (d: unknown) => unknown)(capProxy) as Record<string, unknown>;
          factoryChannel = 'delegate-proxy';
          rt('APPROACH-B', { ok: true });
        } catch {
          try {
            inst = (m.createWAWebVoipStackInterface as () => unknown)() as Record<string, unknown>;
            rt('APPROACH-B', { ok: false, note: 'delegate threw; arg-less ok' });
          } catch (e2) {
            rt('INIT-FAIL', { why: 'factory threw both ways', e2: String((e2 as Error)?.message ?? e2) });
            return;
          }
        }
        if (!inst) { rt('INIT-FAIL', { why: 'factory returned null' }); return; }

        const stack = inst;
        rtStack = stack;
        rt('STACK-OK', { type: stack.type ?? 'unknown', factoryChannel });

        // Full surface dump — untruncated (all ownKeys + all proto methods)
        const ownKeys = Object.getOwnPropertyNames(stack);
        rt('OWN-KEYS-FULL', { count: ownKeys.length, keys: ownKeys });

        const protoMethods: { name: string; arity: number | string }[] = [];
        const protoSeen = new Set<string>();
        let proto: object | null = stack;
        while (proto && proto !== Object.prototype) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (protoSeen.has(name) || name === 'constructor') continue;
            protoSeen.add(name);
            try {
              const desc = Object.getOwnPropertyDescriptor(proto, name);
              if (desc && typeof desc.value === 'function') {
                protoMethods.push({ name, arity: (desc.value as { length?: number }).length ?? '?' });
              }
            } catch { /* live accessor */ }
          }
          proto = Object.getPrototypeOf(proto) as object | null;
        }
        rt('PROTO-METHODS-FULL', { count: protoMethods.length, methods: protoMethods });

        // Approach C: settable own-key callback slots.
        // Assign capturing fn to null/undefined slots + fn-typed slots with callback names.
        const settable: string[] = [];
        for (const key of ownKeys) {
          const val = (stack as Record<string, unknown>)[key];
          const looksLikeCb = val === null || val === undefined
            || (typeof val === 'function' && /^(handle|on[A-Z]|request|cb)/i.test(key));
          if (looksLikeCb) {
            try {
              (stack as Record<string, unknown>)[key] = (...args: unknown[]) => {
                const name = 'slot:' + key;
                rtFiredCallbacks.push(name);
                const argsPreview = JSON.stringify(args).slice(0, 400);
                rt('ENGINE-OUTBOUND', { method: name, argsPreview });
                p.sendRoundtripEvent(name, args);
                if (/signaling|xmpp|voip|call|key|cipher/i.test(key)) setTimeout(sendVerdict, 2000);
              };
              settable.push(key);
            } catch { /* read-only */ }
          }
        }
        rt('APPROACH-C', { settable });

        // Approach D: proto setter methods.
        const SETTER_NAMES = [
          'setCallbacks', 'setDelegate', 'setEventHandler', 'setObserver',
          'registerCallbacks', 'on', 'addListener', 'addEventListener', 'setListeners',
          'setToWebBridge', 'setVoipBridgeToWeb', 'setWebDelegate',
        ];
        let setterUsed: string | null = null;
        for (const method of SETTER_NAMES) {
          if (typeof (stack as Record<string, unknown>)[method] === 'function') {
            try {
              ((stack as Record<string, unknown>)[method] as (d: unknown) => void)(capProxy);
              setterUsed = method;
              rt('APPROACH-D', { ok: true, method });
              break;
            } catch (e) {
              rt('APPROACH-D', { ok: false, method, threw: String((e as Error)?.message ?? e) });
            }
          }
        }

        // subscribe() — expected absent on web stack; log for completeness.
        if (typeof stack.subscribe === 'function') {
          try { (stack.subscribe as (s: unknown) => void)(capProxy); rt('SUBSCRIBE', { ok: true }); }
          catch (e) { rt('SUBSCRIBE', { ok: false, error: String((e as Error)?.message ?? e) }); }
        } else {
          rt('SUBSCRIBE', { ok: false, why: 'not a fn — expected; web stack uses module-level outbound' });
        }

        rt('OUTBOUND-CHANNEL', {
          found: [
            'A:WAWebVoipSendSignalingXmpp-patch',
            'E:WADynamicRouterAsync-event-tap',
            ...(factoryChannel === 'delegate-proxy' ? ['B:factory-delegate'] : []),
            ...(settable.length ? ['C:own-slots:' + settable.slice(0, 8).join(',')] : []),
            ...(setterUsed ? ['D:setter:' + setterUsed] : []),
          ],
        });

        // voipInit(myDeviceJid, myUserJid, selfLidDeviceJid)
        if (typeof stack.voipInit === 'function') {
          try {
            (stack.voipInit as (...a: unknown[]) => void)('0:0@lid', '0@s.whatsapp.net', '0:0@lid');
            rt('VOIP-INIT', { ok: true });
          } catch (e) {
            rt('VOIP-INIT', { ok: false, error: String((e as Error)?.message ?? e) });
          }
        } else {
          rt('VOIP-INIT', { ok: false, why: 'not a fn' });
        }

        // Optional startCall
        if (startCallJid && typeof stack.startCall === 'function') {
          setTimeout(() => {
            try {
              (stack.startCall as (...a: unknown[]) => void)(
                startCallJid, [startCallJid], 'CAFEBABE00000001CAFEBABE00000001',
                false, startCallJid, false, true,
              );
              rt('START-CALL', { called: true, peerJid: startCallJid });
            } catch (e) {
              rt('START-CALL', { called: false, error: String((e as Error)?.message ?? e) });
            }
          }, 1000);
        }

        setTimeout(sendVerdict, 30000);
      });
    }); // end p.onRunRoundtrip

    // Kick off the Method-3 probe after the bundle has had time to boot its module registry.
    // 4 s is generous; the bundle typically initializes requireLazy within 1–2 s.
    setTimeout(probe, 4000);
  },
  args: [prim],
});
