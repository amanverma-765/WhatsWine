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

    const instantiate = (mod: unknown) => {
      const m = mod as Record<string, unknown> | null;
      if (!m || typeof m.createWAWebVoipStackInterface !== 'function') { p.log('voip module loaded but factory missing'); return; }
      try { stack = (m.createWAWebVoipStackInterface as (d: unknown) => unknown)(delegate) as Stack; }
      catch { try { stack = (m.createWAWebVoipStackInterface as () => unknown)() as Stack; } catch (e) { p.log('factory failed: ' + String(e)); return; } }
      p.ready({ type: stack.type ?? 'unknown', hasOffer: typeof stack.handleIncomingSignalingOffer === 'function' });
      // Flush everything queued before the stack was ready, in arrival order.
      for (const [mm, a] of pendingControl.splice(0)) call(mm, a);
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
    let voipLoaded = false;
    let voipTries = 0;
    const loadVoip = (rl: RL) => {
      if (voipLoaded) return;
      if (++voipTries > 10) { p.log('voip module never loaded after 10 tries (~50s)'); return; }
      rl(['WAWebVoipStackInterfaceWeb'], (mod) => {
        if (voipLoaded) return;
        voipLoaded = true;
        p.log('WAWebVoipStackInterfaceWeb loaded (try ' + voipTries + ')');
        instantiate(mod);
      });
      setTimeout(() => { if (!voipLoaded) loadVoip(rl); }, 5000);
    };

    const init = () => {
      const rl = getRequireLazy();
      if (!rl) { if (++initTries % 5 === 0) p.log('waiting for requireLazy... ' + initTries + 's'); setTimeout(init, 1000); return; }
      const w = window as unknown as { crossOriginIsolated?: boolean };
      p.log('requireLazy ready; coI=' + String(w.crossOriginIsolated) + ' SAB=' + (typeof SharedArrayBuffer));
      patchOutboundSignaling(rl);
      forceCalling(rl);
      setTimeout(() => loadVoip(rl), 1200);   // let the force settle before the first load attempt
    };

    const call = (method: string, args: unknown[]) => {
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
