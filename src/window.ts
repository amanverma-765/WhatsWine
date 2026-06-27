import { BrowserWindow, WebContents } from 'electron';

// The hybrid main window reference, registered by main.ts after createWindow().
// Kept here so voip.ts (and any other bridge impl) can call showMainWindow() without
// importing from main.ts, which would create a circular chain via the bridge glob.
let _mainWindow: BrowserWindow | null = null;

// The hybrid chat view's webContents — the primary web.whatsapp.com surface. Registered
// by main.ts so notification clicks (call + message) can open a chat HERE rather than in
// the call layer (which would leak the standalone web UI). Same circular-import reasoning.
let _hybridWc: WebContents | null = null;

export function registerMainWindow(w: BrowserWindow): void {
  _mainWindow = w;
}

export function registerHybridView(wc: WebContents): void {
  _hybridWc = wc;
}

// Open a chat by jid/wid in the primary hybrid window. Reuses WhatsApp's own open-chat
// action (WAWebVoipActionRequestOpenChat.requestOpenChat → findOrCreateLatestChat →
// Cmd.openChatBottom), which opens ANY chat, not just call chats. Opens immediately if the
// WA modules are ready, else a SINGLE retry loop (shared across rapid clicks via a window
// flag) picks up the latest requested jid once they boot — so two quick clicks can't spawn
// two racing intervals that open chats in a non-deterministic order.
// ponytail: version-coupled to these WA module names — same drift risk as callView.ts's
// call automation; if it drifts the chat just doesn't switch (no crash, no web-UI leak).
// Upgrade path: replace with a dedicated open-chat bridge/IPC if WA exposes one.
export function openChatInHybrid(jid: string): void {
  if (!_hybridWc || _hybridWc.isDestroyed() || !jid) {
    console.warn('[wwine] openChatInHybrid: no hybrid view / empty jid:', jid);
    return;
  }
  const js = `(() => {
    const w = window;
    w.__wwineOpenChatTarget = ${JSON.stringify(jid)};   // latest request wins
    const run = () => {
      const req = w.require; if (!req) return false;
      let W, A; try { W = req('WAWebWidFactory'); A = req('WAWebVoipActionRequestOpenChat'); } catch (e) { return false; }
      if (!W || !A) return false;
      try { A.requestOpenChat(W.createWid(w.__wwineOpenChatTarget)); }
      catch (e) { console.warn('[wwine] openChat threw: ' + e); }
      return true;
    };
    if (run()) return;                    // modules ready → open now
    if (w.__wwineOpenChatTimer) return;   // a retry loop is already running; it'll use the new target
    let n = 0;
    w.__wwineOpenChatTimer = setInterval(() => {
      if (run() || ++n > 40) { clearInterval(w.__wwineOpenChatTimer); w.__wwineOpenChatTimer = null; }
    }, 250);
  })()`;
  _hybridWc.executeJavaScript(js, true).catch(() => undefined);
}

// Raise the live WA window to the foreground. Shared by the tray, single-instance
// handler, activate, and notification clicks so they all restore the same way.
// Falls back to any live window if registerMainWindow() hasn't been called yet.
// ponytail: re-show even if "visible" — Wayland's hide() unmaps the surface, so a
// plain focus() after close-to-tray has nothing to raise.
export function showMainWindow(): void {
  const w = (_mainWindow && !_mainWindow.isDestroyed())
    ? _mainWindow
    : BrowserWindow.getAllWindows().find((b) => !b.isDestroyed());
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  w.moveTop();
}
