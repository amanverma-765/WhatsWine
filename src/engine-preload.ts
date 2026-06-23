// Call-window preload (dual-window approach — see analysis/docs/99). The call window is a plain
// logged-in WhatsApp Web client that handles calls in its own native UI, so there is no voip
// bridge here — this preload only surfaces the page's boot/runtime errors for debugging (Electron
// renders WA's Error objects as "[object Object]" otherwise).

import { contextBridge, ipcRenderer } from 'electron';

const log = (msg: string) => ipcRenderer.send('wa-engine:log', msg);

contextBridge.executeInMainWorld({
  func: (p: { log: (m: string) => void }) => {
    const seen = new Set<string>();
    const report = (tag: string, e: unknown) => {
      const err = e as { stack?: string; message?: string } | undefined;
      const s = (err?.stack || err?.message || String(e) || '').slice(0, 600);
      if (seen.has(s)) return; seen.add(s);
      p.log(tag + ': ' + s);
    };
    window.addEventListener('error', (ev) => report('PAGE-ERROR', (ev as ErrorEvent).error ?? (ev as ErrorEvent).message));
    window.addEventListener('unhandledrejection', (ev) => report('PAGE-REJECT', (ev as PromiseRejectionEvent).reason));
  },
  args: [{ log }],
});
