import { BrowserWindow } from 'electron';

// The hybrid main window reference, registered by main.ts after createWindow().
// Kept here so voip.ts (and any other bridge impl) can call showMainWindow() without
// importing from main.ts, which would create a circular chain via the bridge glob.
let _mainWindow: BrowserWindow | null = null;

export function registerMainWindow(w: BrowserWindow): void {
  _mainWindow = w;
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
