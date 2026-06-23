# 99 — VoIP calling: approaches tried, and the chosen one

Status of in-app WhatsApp **calling** on Linux. The hybrid window runs `?windows=1` and **cannot
load the voip stack** (the WASM web voip chunk is not shipped to a windows-identity session — see
below), so calling needs a second context that hosts WhatsApp's real WASM voip. Three approaches
were tried; the third is the one we keep.

## Background (what's fixed and why)

- The hybrid (`?windows=1`) is a logged-in *windows* device. Its voip stub
  (`WAWebVoipStackInterfaceWindows`) forwards to `getWindowsBridge().voip` — i.e. native — and has
  **no real `acceptCall`/media**. The actual WASM voip stack (`WAWebVoipStackInterfaceWeb`,
  `type:"web"`, real `acceptCall` + PJSIP/Opus media) only loads in a **plain-web** session.
- `getVoipStackInterface()` → `WAWebVoipStackInterfaceImpl` → `cr:22885` picks
  `WAWebVoipStackInterfaceWeb` vs `...Windows`. There is **no client-side gatekeeper to flip**
  (`gk 22885` isn't even registered; `gkx` has no runtime overwrite). The choice follows the
  **bundle the server ships**, which is keyed off the **device identity** of the session.

## Approach 1 — shared session (one login). FAILED.

Point the engine window at the hybrid's `session.defaultSession` so it joins the already-logged-in
backend SharedWorker → one login, no second QR.

Result (proven live): the engine attaches to the backend (`setApi` error gone), **but** it inherits
the hybrid's **windows identity** → the server ships the windows bundle → `DIAG gk4112=true`, the
web voip WASM chunk is **absent** (`JSResourceForInteraction('WAWebVoipStackInterfaceWeb').load()`
times out), and the dispatcher returns the windows stub (`type:"windows"`, no `acceptCall`). Also
hit the single-tab socket lock (`castStanza before startComms`).

**Conclusion:** a windows-identity session can never get the web voip stack. One login is
impossible. Dead end.

## Approach 2 — hidden engine + hybrid "puppet" UI bridge. FAILED (abandoned).

Engine = its **own** logged-in web device (own persistent session/QR → `DIAG gk4112=false`,
`type:"web"`, real `acceptCall` + PJSIP/Opus media — this part works perfectly, verified with a
real two-way call). Keep the engine hidden and drive the **hybrid's** call UI as a puppet:

- hybrid receives the offer → relayed to the engine → engine decodes it → synthesizes a
  windows-format `CallStateChanged` event → relayed back → hybrid call UI rings (worked);
- hybrid Accept/Decline/Mute/End buttons intercepted → `VoipBridge.*` → `engineControl(...)` →
  engine acts on its own call (accept worked — the engine connected the call).

Why it failed / was abandoned (too much glue, fragile):

1. **Two devices, two call deliveries.** Hybrid (windows device) and engine (web device) both ring;
   reconciling "accepted on another device" vs a real hangup needs heuristics.
2. **Puppet state desync.** The engine's *real* call events run in its sealed worker; the hybrid UI
   only moves when we synthesize states. Accept → hybrid stuck on **"Connecting"** because we had no
   reliable "CallActive(6)" / "ended" signal (we added a `handleWAWebVoipNativeCallEvent` hook to
   recover them, but the format/relay plumbing kept growing). Mute/End on the hybrid didn't take.
3. **Hidden-window media.** Hiding the engine reliably on Linux (X11 clamps off-screen positions;
   `minimize()` suspends the renderer so calls stop arriving) fought Chromium's occlusion handling.

The engine-as-real-device part is solid; bridging its call into the *windows* hybrid UI is the part
that doesn't pay off. **Marked failed.**

## Approach 3 — dual window (two device logins, two windows). CHOSEN.

Don't bridge the call into the hybrid at all. Run **two windows**:

- **Main window** — the `?windows=1` hybrid: chats, native bridges, everything except calls.
- **Call window** — the engine: a **visible**, **own-login** plain-web WhatsApp device that handles
  calls in **WhatsApp's own native web call UI** (ring, accept, mute, video, end — all real, no
  puppet). It pairs once (its own QR); login persists (`persist:wa-engine`).

Cost: a second one-time QR scan (two device slots). Benefit: calling **just works** with zero UI
glue — it's a real WhatsApp Web client. This is the same path that answered a real call flawlessly
in the `WA_ENGINE_ONLY` test.

What this means in code (current state):
- `engine-window.ts` — the engine window is shown, unmuted, persistent own session; it is the call
  client. (No hide/mute/puppet.)
- `main.ts` — `WA_HYBRID_CALLS=1` opens both windows; it does **not** wire the engine→hybrid puppet
  relays.
- `bridge/impl/voip.ts` — keeps the incoming-call toast as a heads-up; does **not** relay offers to
  drive a hybrid call UI.
- The Approach-2 plumbing (offer relay, ring/state synthesis, button interception, native-event
  hook) is left in the tree but **inert** (not wired), kept only as the documented failed record.

### Open follow-ups for Approach 3
- Auto-raise the call window on an incoming call (so the user doesn't miss it); optionally hide it
  between calls once a reliable, non-suspending hide is found.
- One account vs two: Approach 3 needs the call window paired as its own device. If WhatsApp ever
  ships the web voip stack to the windows identity, Approach 1 (one login) becomes possible.
