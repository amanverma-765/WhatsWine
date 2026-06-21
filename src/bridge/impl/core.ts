// Core bridges: IPC negotiation + the legacy comma-IPC sink + thin always-on
// bridges that have no native state. JS-projected method names are camelCase.
// `addEventListener` is intentionally NOT provided — the bundle probes for it and
// the real client returns member-not-found (the real channel is `subscribe(web)`).

import type { BridgeFactory } from '../types';
import { toWeb } from '../eventtarget';

export const bridges: Record<string, BridgeFactory> = {
  // The bundle negotiates which IPC channels exist. Advertise only the modern
  // host-object channel so it never prefers the obsolete comma-IPC path.
  __legacy__: () => ({
    postMessage: () => undefined,
    compatibilityGetSupportedNativeIpcs: () => ['hostobjects'],
  }),

  // DebugFeaturesBridge — dev/diagnostic toggles; report everything off.
  DebugFeaturesBridge: () => {
    const tw = toWeb();
    return {
      subscribe: tw.subscribe,
      isDebugBuild: () => false,
      getFeatureFlag: () => false,
      getFeatureFlagAsync: async () => false,
      requestNativeLogs: async () => '',
      // Native hang/liveness diagnostics — no-ops on Linux. ponytail.
      startHangsMonitor: () => undefined,
      stopHangsMonitor: () => undefined,
      ping: () => undefined,
    };
  },

  // TouchpadFix — Windows precision-touchpad gesture shim; no Linux equivalent.
  // ponytail: no-op keeps the bundle's init call happy.
  TouchpadFix: () => ({
    interruptManipulations: () => undefined,
  }),
};
