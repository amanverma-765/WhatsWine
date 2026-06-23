// Shared WhatsApp Web constants and tiny helpers used by both the hybrid main
// window (main.ts) and the plain-web call window (callWindow.ts).  Lives in its
// own file to avoid a circular import: main.ts → bridge → voip.ts → callWindow.ts.

import { app } from 'electron';

// The remote origin WhatsApp Web is loaded from. All permission grants, navigation
// guards, and request-header injections are keyed to this origin.
export const WA_ORIGIN = 'https://web.whatsapp.com/';
export const WA_HOST_ORIGIN = new URL(WA_ORIGIN).origin; // 'https://web.whatsapp.com'

// WhatsApp Web rejects/deprecates unknown user agents; drop the `Electron` token
// and the app-name token (e.g. "WhatsWine/1.0.0") so it sees a vanilla Chrome
// (keeping the real Chromium version). Built from app.getName() so a productName
// rename can't reintroduce the "update your browser" page.
export const cleanUserAgent = (ua: string): string =>
  ua.replace(/ Electron\/[^ ]+/, '').replace(new RegExp(` ${app.getName()}/[^ ]+`), '');
