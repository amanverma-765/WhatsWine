import { BrowserWindow } from 'electron';

// Raise the live WA window to the foreground. Shared by the tray, single-instance
// handler, activate, and notification clicks so they all restore the same way.
// ponytail: re-show even if "visible" — Wayland's hide() unmaps the surface, so a
// plain focus() after close-to-tray has nothing to raise.
export function showMainWindow(): void {
  const w = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed());
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  w.moveTop();
}
