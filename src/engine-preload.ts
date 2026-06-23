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
  sendReady:    (info: unknown) =>
    ipcRenderer.send('wa-engine:ready', info),
  sendProbe:    (result: unknown) =>
    ipcRenderer.send('wa-engine:probe-result', result),
  sendOutbound: (method: string, args: unknown[]) =>
    ipcRenderer.send('wa-engine:outbound-signaling', method, args),

  // main → engine (register listeners; called once during setup)
  onPushOffer:     (h: (pl: unknown) => void) =>
    ipcRenderer.on('wa-engine:push-offer',     (_e, pl) => h(pl)),
  onPushSignaling: (h: (pl: unknown) => void) =>
    ipcRenderer.on('wa-engine:push-signaling', (_e, pl) => h(pl)),
  onPushAck:       (h: (pl: unknown) => void) =>
    ipcRenderer.on('wa-engine:push-ack',       (_e, pl) => h(pl)),
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

    // Kick off the probe after the bundle has had time to boot its module registry.
    // 4 s is generous; the bundle typically initializes requireLazy within 1–2 s.
    setTimeout(probe, 4000);
  },
  args: [prim],
});
