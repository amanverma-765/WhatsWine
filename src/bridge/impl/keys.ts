// Keystore + companion-pairing crypto bridges (docs 20 §5, 21 §3.2/§5, catalog).
// Under the hybrid model the JS bundle owns the Signal engine and ADV/ClientKey
// derivation; native only vends:
//   - ClientKeyBridge        — getClientKey()->"", setClientKey(b64), clearClientKey()->relaunch
//   - ServerEncKeySaltBridge — get/set/clear the DB-encryption salt
//   - AdvBridge.verify(messageB64, signatureB64, signKeyB64) — Curve25519 XEdDSA
//     check via libsignal (bit-compatible, doc 20 §5 / doc 96); swallow->false.
// Secrets sit in the safeStorage-backed store (DPAPI substitute). Methods are
// camelCase; several are async-by-return-type but sync-computable here, so the
// bundle's `await` passes straight through.

import { app } from 'electron';
import type { BridgeFactory, BridgeContext } from '../types';
import { logoutCallLayer } from '../../callView';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toBuf(v: unknown): Buffer {
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v as number[]);
  return Buffer.alloc(0);
}

// AdvBridge.Verify(message, signature, signKey) -> Curve.Verify(message, signature, signKey).
function advVerify(message: unknown, signature: unknown, signKey: unknown): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PublicKey } = require('@signalapp/libsignal-client') as typeof import('@signalapp/libsignal-client');
    let pub = toBuf(signKey);
    if (pub.length === 32) pub = Buffer.concat([Buffer.from([0x05]), pub]); // DJB type byte
    return PublicKey.deserialize(pub).verify(toBuf(message), toBuf(signature));
  } catch {
    return false; // doc 20 §3.6 / doc 21 §5: swallow-exception -> false
  }
}

function keyStore(
  ctx: BridgeContext,
  secretName: string,
  getName: string,
  setName: string,
  clearName: string,
  relaunchOnClear: boolean,
): ReturnType<BridgeFactory> {
  return {
    [getName]: () => ctx.secretGet(secretName) ?? '',            // base64 or "" (never null/undefined)
    [setName]: (value: unknown) => {
      ctx.secretSet(secretName, typeof value === 'string' ? value : toBuf(value).toString('base64'));
    },
    [clearName]: () => {
      ctx.secretDel(secretName);
      // ClientKey clear == hybrid logout -> full relaunch (App.Restart(UserLogout), doc 21 §5).
      // This is the ONLY reliable hybrid-logout signal: the native logout tears the app down via
      // app.exit here, so web-side detection (polling #pane-side, post_logout nav) never fires.
      // Before relaunching, unlink the SEPARATE call-layer device too (await its
      // remove-companion-device IQ) — else app.exit kills it before the unpair reaches the server,
      // leaving calling linked behind a logged-out app. Capped so a stuck unpair can't block exit.
      // Defer so the IPC reply flushes before the process exits.
      if (relaunchOnClear) setImmediate(async () => {
        try { await Promise.race([logoutCallLayer(), delay(8000)]); } catch { /* best-effort */ }
        app.relaunch(); app.exit(0);
      });
    },
  };
}

export const bridges: Record<string, BridgeFactory> = {
  ClientKeyBridge: (ctx) => keyStore(ctx, 'clientKey', 'getClientKey', 'setClientKey', 'clearClientKey', true),
  ServerEncKeySaltBridge: (ctx) =>
    keyStore(ctx, 'serverEncKeySalt', 'getServerEncKeySalt', 'setServerEncKeySalt', 'clearServerEncKeySalt', false),
  AdvBridge: () => ({
    verify: (message: unknown, signature: unknown, signKey: unknown) => advVerify(message, signature, signKey),
  }),
};
